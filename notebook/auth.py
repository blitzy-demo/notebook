"""Authentication integration module for collaborative editing.

This module extends Jupyter Server authentication with JupyterHub token validation,
user identity resolution, and role-based access control for real-time collaboration features.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple, Union
from urllib.parse import urljoin

import tornado.web
from jupyter_server.auth import User
from jupyter_server.base.handlers import JupyterHandler
from tornado.httpclient import AsyncHTTPClient, HTTPRequest, HTTPResponse
from tornado.websocket import WebSocketHandler
from traitlets import Bool, Float, Integer, List as TraitletsList, Unicode
from traitlets.config.configurable import Configurable

# Authentication errors
class AuthenticationError(Exception):
    """Base authentication error."""
    pass

class TokenValidationError(AuthenticationError):
    """Token validation failed."""
    pass

class PermissionError(AuthenticationError):
    """Permission denied."""
    pass

class SessionError(AuthenticationError):
    """Session-related error."""
    pass

# Role-based permissions
class CollaborationRole:
    """Collaboration role definitions."""
    
    VIEWER = "viewer"
    EDITOR = "editor"
    ADMIN = "admin"
    
    # Role hierarchy for permission checking
    HIERARCHY = {
        VIEWER: 0,
        EDITOR: 1,
        ADMIN: 2
    }
    
    # Role permissions mapping
    PERMISSIONS = {
        VIEWER: {
            "view_notebook",
            "view_presence",
            "view_comments",
            "view_history"
        },
        EDITOR: {
            "view_notebook",
            "view_presence",
            "view_comments",
            "view_history",
            "edit_notebook",
            "edit_cells",
            "lock_cells",
            "add_comments",
            "edit_own_comments"
        },
        ADMIN: {
            "view_notebook",
            "view_presence",
            "view_comments",
            "view_history",
            "edit_notebook",
            "edit_cells",
            "lock_cells",
            "add_comments",
            "edit_own_comments",
            "edit_all_comments",
            "manage_permissions",
            "manage_session",
            "force_unlock_cells",
            "kick_users"
        }
    }
    
    @classmethod
    def has_permission(cls, role: str, permission: str) -> bool:
        """Check if a role has a specific permission."""
        return role in cls.PERMISSIONS and permission in cls.PERMISSIONS[role]
    
    @classmethod
    def can_access_role(cls, user_role: str, target_role: str) -> bool:
        """Check if user role can access target role level."""
        return cls.HIERARCHY.get(user_role, -1) >= cls.HIERARCHY.get(target_role, 0)


class CollaborationUser:
    """Collaboration user with enhanced metadata."""
    
    def __init__(
        self,
        username: str,
        display_name: Optional[str] = None,
        email: Optional[str] = None,
        avatar_url: Optional[str] = None,
        role: str = CollaborationRole.VIEWER,
        groups: Optional[List[str]] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None,
        **kwargs: Any
    ):
        self.username = username
        self.display_name = display_name or username
        self.email = email
        self.avatar_url = avatar_url
        self.role = role
        self.groups = groups or []
        self.user_id = user_id or str(uuid.uuid4())
        self.session_id = session_id or str(uuid.uuid4())
        self.metadata = kwargs
        self.last_activity = time.time()
        self.connected_at = time.time()
    
    def has_permission(self, permission: str) -> bool:
        """Check if user has specific permission."""
        return CollaborationRole.has_permission(self.role, permission)
    
    def can_access_role(self, target_role: str) -> bool:
        """Check if user can access target role level."""
        return CollaborationRole.can_access_role(self.role, target_role)
    
    def update_activity(self) -> None:
        """Update last activity timestamp."""
        self.last_activity = time.time()
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert user to dictionary for serialization."""
        return {
            "username": self.username,
            "display_name": self.display_name,
            "email": self.email,
            "avatar_url": self.avatar_url,
            "role": self.role,
            "groups": self.groups,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "last_activity": self.last_activity,
            "connected_at": self.connected_at,
            "metadata": self.metadata
        }


class AuthenticationCache:
    """Session-based authentication cache for performance optimization."""
    
    def __init__(self, max_size: int = 1000, ttl: float = 3600):
        self.max_size = max_size
        self.ttl = ttl
        self._cache: Dict[str, Tuple[Any, float]] = {}
        self._access_order: List[str] = []
        self._lock = asyncio.Lock()
    
    async def get(self, key: str) -> Optional[Any]:
        """Get cached value if not expired."""
        async with self._lock:
            if key in self._cache:
                value, timestamp = self._cache[key]
                if time.time() - timestamp < self.ttl:
                    # Move to end (most recently used)
                    self._access_order.remove(key)
                    self._access_order.append(key)
                    return value
                else:
                    # Expired, remove from cache
                    del self._cache[key]
                    if key in self._access_order:
                        self._access_order.remove(key)
            return None
    
    async def set(self, key: str, value: Any) -> None:
        """Set cached value with TTL."""
        async with self._lock:
            # Remove if already exists
            if key in self._cache:
                self._access_order.remove(key)
            
            # Add new entry
            self._cache[key] = (value, time.time())
            self._access_order.append(key)
            
            # Evict least recently used if over capacity
            while len(self._cache) > self.max_size:
                oldest_key = self._access_order.pop(0)
                del self._cache[oldest_key]
    
    async def remove(self, key: str) -> None:
        """Remove cached value."""
        async with self._lock:
            if key in self._cache:
                del self._cache[key]
                self._access_order.remove(key)
    
    async def clear(self) -> None:
        """Clear all cached values."""
        async with self._lock:
            self._cache.clear()
            self._access_order.clear()


class CollaborationAuthenticator(Configurable):
    """Authentication manager for collaborative editing sessions."""
    
    # Configuration traits
    enable_collaboration = Bool(
        True,
        config=True,
        help="Enable collaboration features. Defaults to True."
    )
    
    require_tls = Bool(
        True,
        config=True,
        help="Require TLS for all collaboration endpoints. Defaults to True."
    )
    
    jupyterhub_api_url = Unicode(
        "",
        config=True,
        help="JupyterHub API URL for token validation. Auto-detected if running under JupyterHub."
    )
    
    token_refresh_interval = Float(
        1800,  # 30 minutes
        config=True,
        help="Token refresh interval in seconds. Defaults to 1800 (30 minutes)."
    )
    
    session_timeout = Float(
        7200,  # 2 hours
        config=True,
        help="Session timeout in seconds. Defaults to 7200 (2 hours)."
    )
    
    cache_size = Integer(
        1000,
        config=True,
        help="Maximum number of cached authentication entries. Defaults to 1000."
    )
    
    cache_ttl = Float(
        3600,  # 1 hour
        config=True,
        help="Cache TTL in seconds. Defaults to 3600 (1 hour)."
    )
    
    role_mapping = TraitletsList(
        trait=Unicode(),
        default_value=[],
        config=True,
        help="Role mapping from JupyterHub groups to collaboration roles. "
             "Format: 'group_name:role_name'. Example: ['admin:admin', 'teachers:editor']"
    )
    
    default_role = Unicode(
        CollaborationRole.VIEWER,
        config=True,
        help="Default role for users without explicit role mapping. Defaults to 'viewer'."
    )
    
    max_sessions_per_user = Integer(
        5,
        config=True,
        help="Maximum number of concurrent sessions per user. Defaults to 5."
    )
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.logger = logging.getLogger(__name__)
        self.cache = AuthenticationCache(max_size=self.cache_size, ttl=self.cache_ttl)
        self.http_client = AsyncHTTPClient()
        self.active_sessions: Dict[str, CollaborationUser] = {}
        self.user_sessions: Dict[str, Set[str]] = {}  # username -> set of session_ids
        self.token_refresh_tasks: Dict[str, asyncio.Task] = {}
        self._role_mapping_dict: Dict[str, str] = {}
        self._parse_role_mapping()
    
    def _parse_role_mapping(self) -> None:
        """Parse role mapping configuration."""
        self._role_mapping_dict = {}
        for mapping in self.role_mapping:
            if ":" in mapping:
                group, role = mapping.split(":", 1)
                self._role_mapping_dict[group.strip()] = role.strip()
    
    def _get_role_from_groups(self, groups: List[str]) -> str:
        """Get collaboration role from user groups."""
        # Check for explicit role mapping
        for group in groups:
            if group in self._role_mapping_dict:
                return self._role_mapping_dict[group]
        
        # Check for admin privileges
        if any(group.lower() in ["admin", "administrators"] for group in groups):
            return CollaborationRole.ADMIN
        
        # Check for editor privileges
        if any(group.lower() in ["editor", "teachers", "instructors"] for group in groups):
            return CollaborationRole.EDITOR
        
        return self.default_role
    
    async def validate_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Validate token against JupyterHub API."""
        if not self.enable_collaboration:
            return None
        
        # Check cache first
        cache_key = f"token:{token}"
        cached_user = await self.cache.get(cache_key)
        if cached_user:
            return cached_user
        
        # If no JupyterHub URL configured, try to auto-detect
        if not self.jupyterhub_api_url:
            # Check if running under JupyterHub
            try:
                import os
                hub_api_url = os.environ.get("JUPYTERHUB_API_URL")
                if hub_api_url:
                    self.jupyterhub_api_url = hub_api_url
            except Exception:
                pass
        
        if not self.jupyterhub_api_url:
            self.logger.warning("JupyterHub API URL not configured, token validation disabled")
            return None
        
        try:
            # Validate token with JupyterHub
            headers = {"Authorization": f"Bearer {token}"}
            url = urljoin(self.jupyterhub_api_url, "/hub/api/user")
            
            request = HTTPRequest(
                url=url,
                method="GET",
                headers=headers,
                validate_cert=True,
                request_timeout=10.0
            )
            
            response: HTTPResponse = await self.http_client.fetch(request)
            
            if response.code == 200:
                user_info = json.loads(response.body.decode())
                
                # Cache the validated user info
                await self.cache.set(cache_key, user_info)
                
                return user_info
            else:
                self.logger.warning(f"Token validation failed: {response.code}")
                return None
                
        except Exception as e:
            self.logger.error(f"Token validation error: {e}")
            return None
    
    async def authenticate_user(self, token: str, request_info: Optional[Dict[str, Any]] = None) -> Optional[CollaborationUser]:
        """Authenticate user and create collaboration user object."""
        if not self.enable_collaboration:
            return None
        
        # Validate token
        user_info = await self.validate_token(token)
        if not user_info:
            return None
        
        try:
            # Extract user information
            username = user_info.get("name", "")
            display_name = user_info.get("display_name", username)
            email = user_info.get("email")
            avatar_url = user_info.get("avatar_url")
            groups = user_info.get("groups", [])
            
            # Determine role from groups
            role = self._get_role_from_groups(groups)
            
            # Create collaboration user
            collab_user = CollaborationUser(
                username=username,
                display_name=display_name,
                email=email,
                avatar_url=avatar_url,
                role=role,
                groups=groups,
                user_id=user_info.get("id", str(uuid.uuid4())),
                session_id=str(uuid.uuid4())
            )
            
            # Check session limits
            if username in self.user_sessions:
                if len(self.user_sessions[username]) >= self.max_sessions_per_user:
                    raise SessionError(f"Maximum number of sessions ({self.max_sessions_per_user}) exceeded for user {username}")
            
            # Register session
            self.active_sessions[collab_user.session_id] = collab_user
            if username not in self.user_sessions:
                self.user_sessions[username] = set()
            self.user_sessions[username].add(collab_user.session_id)
            
            # Start token refresh task if needed
            if self.token_refresh_interval > 0:
                self._start_token_refresh_task(collab_user.session_id, token)
            
            self.logger.info(f"User {username} authenticated with role {role}")
            return collab_user
            
        except Exception as e:
            self.logger.error(f"Authentication error: {e}")
            return None
    
    def _start_token_refresh_task(self, session_id: str, token: str) -> None:
        """Start token refresh task for session."""
        async def refresh_token():
            while session_id in self.active_sessions:
                await asyncio.sleep(self.token_refresh_interval)
                
                # Refresh token validation
                user_info = await self.validate_token(token)
                if not user_info:
                    self.logger.warning(f"Token refresh failed for session {session_id}, removing session")
                    await self.end_session(session_id)
                    break
                
                # Update user activity
                if session_id in self.active_sessions:
                    self.active_sessions[session_id].update_activity()
        
        task = asyncio.create_task(refresh_token())
        self.token_refresh_tasks[session_id] = task
    
    async def end_session(self, session_id: str) -> None:
        """End collaboration session."""
        if session_id in self.active_sessions:
            user = self.active_sessions[session_id]
            
            # Remove from active sessions
            del self.active_sessions[session_id]
            
            # Remove from user sessions
            if user.username in self.user_sessions:
                self.user_sessions[user.username].discard(session_id)
                if not self.user_sessions[user.username]:
                    del self.user_sessions[user.username]
            
            # Cancel token refresh task
            if session_id in self.token_refresh_tasks:
                task = self.token_refresh_tasks[session_id]
                task.cancel()
                del self.token_refresh_tasks[session_id]
            
            self.logger.info(f"Session {session_id} ended for user {user.username}")
    
    async def get_session(self, session_id: str) -> Optional[CollaborationUser]:
        """Get collaboration session by ID."""
        return self.active_sessions.get(session_id)
    
    async def get_user_sessions(self, username: str) -> List[CollaborationUser]:
        """Get all active sessions for a user."""
        if username not in self.user_sessions:
            return []
        
        sessions = []
        for session_id in self.user_sessions[username]:
            if session_id in self.active_sessions:
                sessions.append(self.active_sessions[session_id])
        
        return sessions
    
    async def check_permission(self, session_id: str, permission: str) -> bool:
        """Check if session has specific permission."""
        user = await self.get_session(session_id)
        if not user:
            return False
        
        return user.has_permission(permission)
    
    async def cleanup_expired_sessions(self) -> None:
        """Clean up expired sessions."""
        current_time = time.time()
        expired_sessions = []
        
        for session_id, user in self.active_sessions.items():
            if current_time - user.last_activity > self.session_timeout:
                expired_sessions.append(session_id)
        
        for session_id in expired_sessions:
            await self.end_session(session_id)
            self.logger.info(f"Expired session {session_id} cleaned up")


class CollaborationAuthMixin:
    """Mixin for handlers that need collaboration authentication."""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.auth: Optional[CollaborationAuthenticator] = None
    
    def initialize_collaboration_auth(self, auth: CollaborationAuthenticator) -> None:
        """Initialize collaboration authentication."""
        self.auth = auth
    
    async def authenticate_collaboration(self, token: str) -> Optional[CollaborationUser]:
        """Authenticate for collaboration."""
        if not self.auth:
            return None
        
        # Check TLS requirement
        if self.auth.require_tls and not self.request.protocol == "https":
            raise tornado.web.HTTPError(403, "TLS required for collaboration")
        
        return await self.auth.authenticate_user(token)
    
    async def check_collaboration_permission(self, session_id: str, permission: str) -> bool:
        """Check collaboration permission."""
        if not self.auth:
            return False
        
        return await self.auth.check_permission(session_id, permission)
    
    async def get_collaboration_user(self, session_id: str) -> Optional[CollaborationUser]:
        """Get collaboration user by session ID."""
        if not self.auth:
            return None
        
        return await self.auth.get_session(session_id)


class CollaborationWebSocketMixin:
    """Mixin for WebSocket handlers that need collaboration authentication."""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.collaboration_user: Optional[CollaborationUser] = None
        self.auth: Optional[CollaborationAuthenticator] = None
    
    def initialize_collaboration_auth(self, auth: CollaborationAuthenticator) -> None:
        """Initialize collaboration authentication."""
        self.auth = auth
    
    async def authenticate_websocket(self, token: str) -> bool:
        """Authenticate WebSocket connection for collaboration."""
        if not self.auth:
            return False
        
        # Check TLS requirement
        if self.auth.require_tls and not self.request.protocol == "https":
            return False
        
        # Authenticate user
        user = await self.auth.authenticate_user(token)
        if not user:
            return False
        
        self.collaboration_user = user
        return True
    
    async def challenge_response_auth(self, challenge_data: Dict[str, Any]) -> bool:
        """Perform challenge-response authentication."""
        token = challenge_data.get("token")
        if not token:
            return False
        
        return await self.authenticate_websocket(token)
    
    async def check_permission(self, permission: str) -> bool:
        """Check if current user has permission."""
        if not self.collaboration_user:
            return False
        
        return self.collaboration_user.has_permission(permission)
    
    async def end_collaboration_session(self) -> None:
        """End collaboration session."""
        if self.auth and self.collaboration_user:
            await self.auth.end_session(self.collaboration_user.session_id)
            self.collaboration_user = None


# Global authenticator instance
_authenticator: Optional[CollaborationAuthenticator] = None


def get_authenticator() -> Optional[CollaborationAuthenticator]:
    """Get global authenticator instance."""
    return _authenticator


def set_authenticator(auth: CollaborationAuthenticator) -> None:
    """Set global authenticator instance."""
    global _authenticator
    _authenticator = auth


def create_authenticator(**kwargs) -> CollaborationAuthenticator:
    """Create and configure authenticator instance."""
    auth = CollaborationAuthenticator(**kwargs)
    set_authenticator(auth)
    return auth


# Periodic cleanup task
async def cleanup_expired_sessions():
    """Periodic task to clean up expired sessions."""
    auth = get_authenticator()
    if auth:
        await auth.cleanup_expired_sessions()


# Initialize cleanup task
def start_cleanup_task(interval: float = 300) -> asyncio.Task:
    """Start periodic cleanup task."""
    async def cleanup_loop():
        while True:
            await asyncio.sleep(interval)
            await cleanup_expired_sessions()
    
    return asyncio.create_task(cleanup_loop())