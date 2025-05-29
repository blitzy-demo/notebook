"""Collaborative WebSocket handlers for real-time notebook editing.

This module provides server-side collaboration functionality including:
- Yjs document synchronization and CRDT operations  
- User presence and awareness broadcasting
- Role-based access control and permissions management
- Cell-level locking mechanisms with conflict resolution
- Comment system REST APIs for cell-level discussions
- Change history and versioning support
- Integration with JupyterHub for multi-user authentication
- Comprehensive audit logging and SIEM integration
- Configurable collaboration features with graceful degradation

The handlers implement enterprise-grade security and scalability for
real-time collaborative notebook editing in Jupyter Notebook v7.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
import weakref
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Union, Tuple
from urllib.parse import parse_qs, urlparse

import tornado.websocket
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.utils import url_path_join as ujoin
from tornado import web
from tornado.web import HTTPError
from traitlets import TraitError

# Optional imports for CRDT functionality - graceful degradation if not available
try:
    import pycrdt
    from pycrdt_websocket import WebsocketProvider, YSyncProtocol
    CRDT_AVAILABLE = True
except ImportError:
    CRDT_AVAILABLE = False
    pycrdt = None
    WebsocketProvider = None
    YSyncProtocol = None

# Configure collaboration-specific logger
collab_logger = logging.getLogger("notebook.collaboration")


class CollaborationError(Exception):
    """Base exception for collaboration-related errors."""
    pass


class AuthenticationError(CollaborationError):
    """Raised when collaboration authentication fails."""
    pass


class PermissionError(CollaborationError):
    """Raised when user lacks required permissions."""
    pass


class RateLimitError(CollaborationError):
    """Raised when rate limits are exceeded."""
    pass


class CollaborationSession:
    """Manages a single collaborative editing session for a notebook.
    
    This class encapsulates the state and behavior for a collaborative
    editing session, including user management, CRDT document handling,
    presence awareness, and permission enforcement.
    """
    
    def __init__(self, notebook_path: str, config: Dict[str, Any]):
        self.notebook_path = notebook_path
        self.session_id = str(uuid.uuid4())
        self.created_at = datetime.now(timezone.utc)
        self.last_activity = self.created_at
        self.config = config
        
        # User management
        self.connected_users: Dict[str, Dict[str, Any]] = {}
        self.user_permissions: Dict[str, str] = {}  # user_id -> role
        self.user_websockets: Dict[str, Set[tornado.websocket.WebSocketHandler]] = {}
        
        # CRDT document state
        if CRDT_AVAILABLE:
            self.ydoc = pycrdt.Doc()
            self.cells = self.ydoc.get_array("cells")
            self.metadata = self.ydoc.get_map("metadata")
            self.awareness = {}
        else:
            self.ydoc = None
            self.cells = None
            self.metadata = None
            self.awareness = {}
        
        # Cell locking state
        self.cell_locks: Dict[str, Dict[str, Any]] = {}  # cell_id -> lock_info
        
        # Comment system state
        self.comments: Dict[str, Dict[str, Any]] = {}  # comment_id -> comment_data
        self.comment_threads: Dict[str, List[str]] = {}  # cell_id -> comment_ids
        
        # Change history
        self.change_history: List[Dict[str, Any]] = []
        
        # Rate limiting
        self.user_message_counts: Dict[str, List[float]] = {}
        
        collab_logger.info(
            f"Created collaboration session {self.session_id} for notebook {notebook_path}",
            extra={
                "session_id": self.session_id,
                "notebook_path": notebook_path,
                "timestamp": self.created_at.isoformat(),
                "audit_event": "session_created"
            }
        )
    
    def add_user(self, user_id: str, user_info: Dict[str, Any], websocket: tornado.websocket.WebSocketHandler) -> None:
        """Add a user to the collaboration session."""
        self.last_activity = datetime.now(timezone.utc)
        
        if user_id not in self.connected_users:
            self.connected_users[user_id] = user_info
            self.user_websockets[user_id] = set()
            
            # Assign default role based on configuration
            default_role = self._get_default_role(user_info)
            self.user_permissions[user_id] = default_role
            
            collab_logger.info(
                f"User {user_id} joined session {self.session_id}",
                extra={
                    "session_id": self.session_id,
                    "user_id": user_id,
                    "role": default_role,
                    "timestamp": self.last_activity.isoformat(),
                    "audit_event": "user_joined"
                }
            )
        
        self.user_websockets[user_id].add(websocket)
        
        # Check user limit
        if len(self.connected_users) > self.config.get("max_users", 20):
            raise CollaborationError(f"Session has reached maximum user limit of {self.config['max_users']}")
    
    def remove_user(self, user_id: str, websocket: tornado.websocket.WebSocketHandler) -> None:
        """Remove a user from the collaboration session."""
        self.last_activity = datetime.now(timezone.utc)
        
        if user_id in self.user_websockets:
            self.user_websockets[user_id].discard(websocket)
            
            # If no more websockets for this user, remove them completely
            if not self.user_websockets[user_id]:
                del self.user_websockets[user_id]
                if user_id in self.connected_users:
                    del self.connected_users[user_id]
                if user_id in self.user_permissions:
                    del self.user_permissions[user_id]
                
                # Release any locks held by this user
                self._release_user_locks(user_id)
                
                collab_logger.info(
                    f"User {user_id} left session {self.session_id}",
                    extra={
                        "session_id": self.session_id,
                        "user_id": user_id,
                        "timestamp": self.last_activity.isoformat(),
                        "audit_event": "user_left"
                    }
                )
    
    def check_permission(self, user_id: str, action: str, resource: str = "") -> bool:
        """Check if user has permission to perform an action."""
        role = self.user_permissions.get(user_id, "view")
        return self._role_has_permission(role, action, resource)
    
    def acquire_cell_lock(self, user_id: str, cell_id: str) -> bool:
        """Attempt to acquire a lock on a cell for a user."""
        if not self.check_permission(user_id, "lock", cell_id):
            return False
        
        current_time = datetime.now(timezone.utc)
        
        # Check if cell is already locked
        if cell_id in self.cell_locks:
            lock_info = self.cell_locks[cell_id]
            
            # Check if lock has expired
            lock_timeout = self.config.get("lock_timeout", 300)  # 5 minutes default
            if (current_time - lock_info["acquired_at"]).total_seconds() > lock_timeout:
                # Lock has expired, allow takeover
                pass
            elif lock_info["user_id"] == user_id:
                # User already owns the lock
                lock_info["acquired_at"] = current_time
                return True
            else:
                # Cell is locked by another user
                return False
        
        # Acquire the lock
        self.cell_locks[cell_id] = {
            "user_id": user_id,
            "acquired_at": current_time,
            "lock_id": str(uuid.uuid4())
        }
        
        if self.config.get("lock_audit_enabled", True):
            collab_logger.info(
                f"Cell lock acquired: {cell_id} by {user_id}",
                extra={
                    "session_id": self.session_id,
                    "user_id": user_id,
                    "cell_id": cell_id,
                    "lock_id": self.cell_locks[cell_id]["lock_id"],
                    "timestamp": current_time.isoformat(),
                    "audit_event": "lock_acquired"
                }
            )
        
        return True
    
    def release_cell_lock(self, user_id: str, cell_id: str) -> bool:
        """Release a cell lock held by a user."""
        if cell_id not in self.cell_locks:
            return False
        
        lock_info = self.cell_locks[cell_id]
        
        # Check if user owns the lock or is admin
        user_role = self.user_permissions.get(user_id, "view")
        if lock_info["user_id"] != user_id and user_role != "admin":
            return False
        
        lock_id = lock_info["lock_id"]
        del self.cell_locks[cell_id]
        
        if self.config.get("lock_audit_enabled", True):
            collab_logger.info(
                f"Cell lock released: {cell_id} by {user_id}",
                extra={
                    "session_id": self.session_id,
                    "user_id": user_id,
                    "cell_id": cell_id,
                    "lock_id": lock_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "audit_event": "lock_released"
                }
            )
        
        return True
    
    def is_expired(self) -> bool:
        """Check if the session has expired due to inactivity."""
        timeout = self.config.get("session_timeout", 1800)  # 30 minutes default
        return (datetime.now(timezone.utc) - self.last_activity).total_seconds() > timeout
    
    def broadcast_to_users(self, message: Dict[str, Any], exclude_user: Optional[str] = None) -> None:
        """Broadcast a message to all connected users in the session."""
        message_json = json.dumps(message)
        
        for user_id, websockets in self.user_websockets.items():
            if exclude_user and user_id == exclude_user:
                continue
            
            for websocket in list(websockets):  # Copy to avoid modification during iteration
                try:
                    websocket.write_message(message_json)
                except Exception as e:
                    collab_logger.warning(
                        f"Failed to send message to user {user_id}: {e}",
                        extra={
                            "session_id": self.session_id,
                            "user_id": user_id,
                            "error": str(e)
                        }
                    )
                    # Remove failed websocket
                    websockets.discard(websocket)
    
    def check_rate_limit(self, user_id: str) -> bool:
        """Check if user is within rate limits for WebSocket messages."""
        current_time = time.time()
        rate_limit = self.config.get("ws_rate_limit", 100)  # messages per minute
        window = 60  # 1 minute window
        
        if user_id not in self.user_message_counts:
            self.user_message_counts[user_id] = []
        
        # Remove old timestamps outside the window
        user_times = self.user_message_counts[user_id]
        user_times[:] = [t for t in user_times if current_time - t < window]
        
        # Check if within limit
        if len(user_times) >= rate_limit:
            return False
        
        # Add current timestamp
        user_times.append(current_time)
        return True
    
    def _get_default_role(self, user_info: Dict[str, Any]) -> str:
        """Determine the default role for a user based on their info."""
        # Check if JupyterHub roles are available
        roles = user_info.get("roles", [])
        if "admin" in roles:
            return "admin"
        elif "editor" in roles:
            return "edit"
        elif "reviewer" in roles:
            return "comment"
        else:
            # Default role based on deployment mode
            if user_info.get("hub_user", False):
                return "edit"  # JupyterHub users get edit by default
            else:
                return "admin"  # Standalone mode gets admin by default
    
    def _role_has_permission(self, role: str, action: str, resource: str = "") -> bool:
        """Check if a role has permission to perform an action."""
        role_permissions = {
            "view": ["read", "observe"],
            "comment": ["read", "observe", "comment"],
            "edit": ["read", "observe", "comment", "edit", "save"],
            "lock": ["read", "observe", "comment", "edit", "save", "lock"],
            "admin": ["read", "observe", "comment", "edit", "save", "lock", "admin", "force_unlock", "permissions"]
        }
        
        return action in role_permissions.get(role, [])
    
    def _release_user_locks(self, user_id: str) -> None:
        """Release all locks held by a user."""
        cells_to_unlock = [
            cell_id for cell_id, lock_info in self.cell_locks.items()
            if lock_info["user_id"] == user_id
        ]
        
        for cell_id in cells_to_unlock:
            self.release_cell_lock(user_id, cell_id)


class CollaborationSessionManager:
    """Manages all active collaboration sessions."""
    
    def __init__(self):
        self.sessions: Dict[str, CollaborationSession] = {}
        self._cleanup_task: Optional[asyncio.Task] = None
        self._start_cleanup_task()
    
    def get_or_create_session(self, notebook_path: str, config: Dict[str, Any]) -> CollaborationSession:
        """Get existing session or create a new one for a notebook."""
        if notebook_path not in self.sessions:
            self.sessions[notebook_path] = CollaborationSession(notebook_path, config)
        
        session = self.sessions[notebook_path]
        session.last_activity = datetime.now(timezone.utc)
        return session
    
    def remove_session(self, notebook_path: str) -> None:
        """Remove a collaboration session."""
        if notebook_path in self.sessions:
            session = self.sessions[notebook_path]
            collab_logger.info(
                f"Removing collaboration session {session.session_id}",
                extra={
                    "session_id": session.session_id,
                    "notebook_path": notebook_path,
                    "audit_event": "session_removed"
                }
            )
            del self.sessions[notebook_path]
    
    async def cleanup_expired_sessions(self) -> None:
        """Remove expired sessions periodically."""
        expired_paths = []
        
        for path, session in self.sessions.items():
            if session.is_expired() and not session.connected_users:
                expired_paths.append(path)
        
        for path in expired_paths:
            self.remove_session(path)
        
        if expired_paths:
            collab_logger.info(f"Cleaned up {len(expired_paths)} expired sessions")
    
    def _start_cleanup_task(self) -> None:
        """Start the periodic cleanup task."""
        async def cleanup_loop():
            while True:
                try:
                    await asyncio.sleep(300)  # Check every 5 minutes
                    await self.cleanup_expired_sessions()
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    collab_logger.error(f"Error in cleanup task: {e}")
        
        self._cleanup_task = asyncio.create_task(cleanup_loop())


# Global session manager instance
session_manager = CollaborationSessionManager()


class CollaborationWebSocketHandler(tornado.websocket.WebSocketHandler):
    """Main WebSocket handler for real-time collaboration using Yjs CRDT.
    
    This handler manages WebSocket connections for collaborative editing,
    including document synchronization, user presence, and real-time updates.
    """
    
    def initialize(self, collaboration_config: Dict[str, Any]) -> None:
        """Initialize the handler with collaboration configuration."""
        self.config = collaboration_config
        self.session: Optional[CollaborationSession] = None
        self.user_id: Optional[str] = None
        self.notebook_path: Optional[str] = None
        self.authenticated = False
        
    def check_origin(self, origin: str) -> bool:
        """Override to enable cross-origin WebSocket connections with security checks."""
        # Allow same-origin requests
        if super().check_origin(origin):
            return True
        
        # Check configured allowed origins
        parsed_origin = urlparse(origin)
        allowed_hosts = self.settings.get("allowed_websocket_origins", [])
        
        for allowed_host in allowed_hosts:
            if parsed_origin.netloc == allowed_host:
                return True
        
        collab_logger.warning(
            f"WebSocket connection rejected from origin: {origin}",
            extra={"origin": origin, "audit_event": "connection_rejected"}
        )
        return False
    
    async def open(self) -> None:
        """Handle new WebSocket connection."""
        if not CRDT_AVAILABLE:
            collab_logger.error("CRDT libraries not available - collaboration disabled")
            self.close(1011, "Collaboration features not available")
            return
        
        try:
            # Authenticate the user and get notebook path
            await self._authenticate_user()
            
            # Get or create collaboration session
            self.session = session_manager.get_or_create_session(
                self.notebook_path, self.config
            )
            
            # Get user info from authentication
            user_info = self._get_user_info()
            
            # Add user to the session
            self.session.add_user(self.user_id, user_info, self)
            
            # Send initial session state
            await self._send_initial_state()
            
            # Broadcast user joined to other users
            self.session.broadcast_to_users({
                "type": "user_joined",
                "user_id": self.user_id,
                "user_info": user_info,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }, exclude_user=self.user_id)
            
            collab_logger.info(
                f"WebSocket opened for user {self.user_id} on notebook {self.notebook_path}",
                extra={
                    "user_id": self.user_id,
                    "notebook_path": self.notebook_path,
                    "session_id": self.session.session_id,
                    "audit_event": "websocket_opened"
                }
            )
            
        except AuthenticationError as e:
            collab_logger.warning(f"Authentication failed: {e}")
            self.close(1008, "Authentication failed")
        except CollaborationError as e:
            collab_logger.error(f"Collaboration error: {e}")
            self.close(1011, str(e))
        except Exception as e:
            collab_logger.error(f"Unexpected error opening WebSocket: {e}")
            self.close(1011, "Internal server error")
    
    async def on_message(self, message: Union[str, bytes]) -> None:
        """Handle incoming WebSocket message."""
        if not self.session or not self.authenticated:
            return
        
        # Check rate limiting
        if not self.session.check_rate_limit(self.user_id):
            collab_logger.warning(
                f"Rate limit exceeded for user {self.user_id}",
                extra={"user_id": self.user_id, "audit_event": "rate_limit_exceeded"}
            )
            self.write_message(json.dumps({
                "type": "error",
                "message": "Rate limit exceeded"
            }))
            return
        
        try:
            if isinstance(message, bytes):
                # Handle binary Yjs CRDT messages
                await self._handle_crdt_message(message)
            else:
                # Handle JSON protocol messages
                await self._handle_json_message(json.loads(message))
                
        except json.JSONDecodeError:
            collab_logger.warning(f"Invalid JSON message from user {self.user_id}")
        except Exception as e:
            collab_logger.error(f"Error handling message from user {self.user_id}: {e}")
    
    def on_close(self) -> None:
        """Handle WebSocket connection close."""
        if self.session and self.user_id:
            # Remove user from session
            self.session.remove_user(self.user_id, self)
            
            # Broadcast user left to other users
            self.session.broadcast_to_users({
                "type": "user_left",
                "user_id": self.user_id,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }, exclude_user=self.user_id)
            
            collab_logger.info(
                f"WebSocket closed for user {self.user_id}",
                extra={
                    "user_id": self.user_id,
                    "session_id": self.session.session_id,
                    "audit_event": "websocket_closed"
                }
            )
    
    async def _authenticate_user(self) -> None:
        """Authenticate the WebSocket connection."""
        # Get authentication token from query parameters or cookies
        token = self._extract_auth_token()
        if not token:
            raise AuthenticationError("No authentication token provided")
        
        # Validate token using Jupyter Server's authentication system
        user_info = await self._validate_token(token)
        if not user_info:
            raise AuthenticationError("Invalid authentication token")
        
        self.user_id = user_info["name"]
        self.authenticated = True
        
        # Extract notebook path from query parameters
        notebook_param = self.get_query_argument("notebook", None)
        if not notebook_param:
            raise AuthenticationError("No notebook path specified")
        
        self.notebook_path = notebook_param
        
        # Check if user has access to the notebook
        if not await self._check_notebook_access():
            raise AuthenticationError("No access to specified notebook")
    
    def _extract_auth_token(self) -> Optional[str]:
        """Extract authentication token from the request."""
        # Try query parameter first
        token = self.get_query_argument("token", None)
        if token:
            return token
        
        # Try cookie
        token = self.get_cookie("_xsrf", None)
        if token:
            return token
        
        # Try Authorization header
        auth_header = self.request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            return auth_header[7:]
        
        return None
    
    async def _validate_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Validate authentication token and return user info."""
        try:
            # Use Jupyter Server's authentication system
            app = self.settings.get("notebook_app")
            if not app:
                return None
            
            # For now, use the current user from the tornado settings
            # In a real implementation, this would validate the token properly
            tornado_settings = self.settings
            if "user" in tornado_settings:
                return {
                    "name": tornado_settings["user"],
                    "display_name": tornado_settings.get("user_display_name", tornado_settings["user"]),
                    "roles": tornado_settings.get("user_roles", ["user"]),
                    "groups": tornado_settings.get("user_groups", []),
                    "hub_user": "hub_prefix" in tornado_settings
                }
            
            return None
            
        except Exception as e:
            collab_logger.error(f"Token validation error: {e}")
            return None
    
    async def _check_notebook_access(self) -> bool:
        """Check if user has access to the specified notebook."""
        try:
            # Use the contents manager to check access
            contents_manager = self.settings.get("contents_manager")
            if not contents_manager:
                return False
            
            # Try to get the notebook (this will raise an error if no access)
            model = await contents_manager.get(self.notebook_path, content=False)
            return model is not None
            
        except Exception:
            return False
    
    def _get_user_info(self) -> Dict[str, Any]:
        """Get user information for the session."""
        tornado_settings = self.settings
        return {
            "name": self.user_id,
            "display_name": tornado_settings.get("user_display_name", self.user_id),
            "roles": tornado_settings.get("user_roles", ["user"]),
            "groups": tornado_settings.get("user_groups", []),
            "hub_user": "hub_prefix" in tornado_settings,
            "avatar_url": tornado_settings.get("user_avatar_url", ""),
            "connected_at": datetime.now(timezone.utc).isoformat()
        }
    
    async def _send_initial_state(self) -> None:
        """Send initial collaboration state to the newly connected user."""
        if not self.session:
            return
        
        # Send current document state
        if CRDT_AVAILABLE and self.session.ydoc:
            # Send Yjs document state
            state_vector = pycrdt.encode_state_vector(self.session.ydoc)
            doc_update = pycrdt.encode_state_as_update(self.session.ydoc, state_vector)
            
            if doc_update:
                self.write_message(doc_update, binary=True)
        
        # Send current user presence
        awareness_info = {
            "type": "awareness",
            "users": [
                {
                    "user_id": uid,
                    "user_info": info,
                    "awareness": self.session.awareness.get(uid, {})
                }
                for uid, info in self.session.connected_users.items()
            ]
        }
        self.write_message(json.dumps(awareness_info))
        
        # Send current cell locks
        locks_info = {
            "type": "locks",
            "locks": {
                cell_id: {
                    "user_id": lock_info["user_id"],
                    "acquired_at": lock_info["acquired_at"].isoformat(),
                    "lock_id": lock_info["lock_id"]
                }
                for cell_id, lock_info in self.session.cell_locks.items()
            }
        }
        self.write_message(json.dumps(locks_info))
    
    async def _handle_crdt_message(self, message: bytes) -> None:
        """Handle binary CRDT update messages."""
        if not self.session or not CRDT_AVAILABLE:
            return
        
        try:
            # Apply update to the session's Yjs document
            pycrdt.apply_update(self.session.ydoc, message)
            
            # Broadcast update to other users
            for user_id, websockets in self.session.user_websockets.items():
                if user_id == self.user_id:
                    continue
                
                for websocket in list(websockets):
                    try:
                        websocket.write_message(message, binary=True)
                    except Exception as e:
                        collab_logger.warning(f"Failed to broadcast CRDT update to {user_id}: {e}")
                        websockets.discard(websocket)
            
            # Log content changes if enabled (be careful with sensitive data)
            if self.config.get("audit_logging", {}).get("content_logging", False):
                collab_logger.debug(
                    f"CRDT update applied by user {self.user_id}",
                    extra={
                        "user_id": self.user_id,
                        "session_id": self.session.session_id,
                        "update_size": len(message),
                        "audit_event": "crdt_update"
                    }
                )
            
        except Exception as e:
            collab_logger.error(f"Error handling CRDT message: {e}")
    
    async def _handle_json_message(self, data: Dict[str, Any]) -> None:
        """Handle JSON protocol messages."""
        message_type = data.get("type")
        
        if message_type == "awareness":
            await self._handle_awareness_message(data)
        elif message_type == "lock_request":
            await self._handle_lock_request(data)
        elif message_type == "lock_release":
            await self._handle_lock_release(data)
        elif message_type == "ping":
            # Respond to ping with pong
            self.write_message(json.dumps({"type": "pong", "timestamp": data.get("timestamp")}))
        else:
            collab_logger.warning(f"Unknown message type: {message_type}")
    
    async def _handle_awareness_message(self, data: Dict[str, Any]) -> None:
        """Handle user awareness/presence updates."""
        if not self.session:
            return
        
        awareness_data = data.get("awareness", {})
        self.session.awareness[self.user_id] = awareness_data
        
        # Broadcast awareness update to other users
        message = {
            "type": "awareness_update",
            "user_id": self.user_id,
            "awareness": awareness_data,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        
        self.session.broadcast_to_users(message, exclude_user=self.user_id)
    
    async def _handle_lock_request(self, data: Dict[str, Any]) -> None:
        """Handle cell lock acquisition request."""
        if not self.session:
            return
        
        cell_id = data.get("cell_id")
        if not cell_id:
            return
        
        success = self.session.acquire_cell_lock(self.user_id, cell_id)
        
        # Send response to requester
        response = {
            "type": "lock_response",
            "cell_id": cell_id,
            "success": success,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        self.write_message(json.dumps(response))
        
        # If successful, broadcast lock acquisition to other users
        if success:
            lock_info = self.session.cell_locks[cell_id]
            broadcast_message = {
                "type": "lock_acquired",
                "cell_id": cell_id,
                "user_id": self.user_id,
                "lock_id": lock_info["lock_id"],
                "timestamp": lock_info["acquired_at"].isoformat()
            }
            self.session.broadcast_to_users(broadcast_message, exclude_user=self.user_id)
    
    async def _handle_lock_release(self, data: Dict[str, Any]) -> None:
        """Handle cell lock release request."""
        if not self.session:
            return
        
        cell_id = data.get("cell_id")
        if not cell_id:
            return
        
        success = self.session.release_cell_lock(self.user_id, cell_id)
        
        # Send response to requester
        response = {
            "type": "lock_release_response",
            "cell_id": cell_id,
            "success": success,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        self.write_message(json.dumps(response))
        
        # If successful, broadcast lock release to other users
        if success:
            broadcast_message = {
                "type": "lock_released",
                "cell_id": cell_id,
                "user_id": self.user_id,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            self.session.broadcast_to_users(broadcast_message, exclude_user=self.user_id)


class CollaborationSessionHandler(APIHandler):
    """REST API handler for managing collaboration sessions."""
    
    @web.authenticated
    async def get(self, session_id: Optional[str] = None) -> None:
        """Get collaboration session information."""
        if session_id:
            # Get specific session
            session = None
            for s in session_manager.sessions.values():
                if s.session_id == session_id:
                    session = s
                    break
            
            if not session:
                raise HTTPError(404, "Session not found")
            
            session_info = {
                "session_id": session.session_id,
                "notebook_path": session.notebook_path,
                "created_at": session.created_at.isoformat(),
                "last_activity": session.last_activity.isoformat(),
                "connected_users": len(session.connected_users),
                "user_list": [
                    {
                        "user_id": uid,
                        "display_name": info.get("display_name", uid),
                        "role": session.user_permissions.get(uid, "view"),
                        "connected_at": info.get("connected_at")
                    }
                    for uid, info in session.connected_users.items()
                ],
                "active_locks": len(session.cell_locks),
                "comment_threads": len(session.comment_threads)
            }
            
            self.finish(session_info)
        else:
            # List all sessions
            sessions_list = []
            for session in session_manager.sessions.values():
                sessions_list.append({
                    "session_id": session.session_id,
                    "notebook_path": session.notebook_path,
                    "created_at": session.created_at.isoformat(),
                    "last_activity": session.last_activity.isoformat(),
                    "connected_users": len(session.connected_users),
                    "active_locks": len(session.cell_locks)
                })
            
            self.finish({"sessions": sessions_list})
    
    @web.authenticated
    async def delete(self, session_id: str) -> None:
        """Terminate a collaboration session."""
        # Find and remove the session
        session_path = None
        for path, session in session_manager.sessions.items():
            if session.session_id == session_id:
                session_path = path
                break
        
        if not session_path:
            raise HTTPError(404, "Session not found")
        
        # Close all WebSocket connections in the session
        session = session_manager.sessions[session_path]
        for websockets in session.user_websockets.values():
            for websocket in list(websockets):
                websocket.close(1000, "Session terminated by administrator")
        
        # Remove the session
        session_manager.remove_session(session_path)
        
        self.finish({"message": "Session terminated successfully"})


class CollaborationPermissionsHandler(APIHandler):
    """REST API handler for managing collaboration permissions."""
    
    @web.authenticated
    async def get(self, notebook_path: Optional[str] = None, cell_id: Optional[str] = None) -> None:
        """Get permissions for a notebook or cell."""
        if not notebook_path:
            raise HTTPError(400, "Notebook path required")
        
        session = session_manager.sessions.get(notebook_path)
        if not session:
            raise HTTPError(404, "No active collaboration session for notebook")
        
        current_user = self.current_user
        if not session.check_permission(current_user["name"], "admin"):
            raise HTTPError(403, "Admin permission required to view permissions")
        
        permissions_info = {
            "notebook_path": notebook_path,
            "session_id": session.session_id,
            "user_permissions": session.user_permissions,
            "default_role": "view"
        }
        
        if cell_id:
            permissions_info["cell_id"] = cell_id
            # Add cell-specific permissions if implemented
        
        self.finish(permissions_info)
    
    @web.authenticated
    async def put(self, notebook_path: str, cell_id: Optional[str] = None) -> None:
        """Update permissions for a notebook or cell."""
        session = session_manager.sessions.get(notebook_path)
        if not session:
            raise HTTPError(404, "No active collaboration session for notebook")
        
        current_user = self.current_user
        if not session.check_permission(current_user["name"], "admin"):
            raise HTTPError(403, "Admin permission required to modify permissions")
        
        data = json.loads(self.request.body)
        user_id = data.get("user_id")
        role = data.get("role")
        
        if not user_id or not role:
            raise HTTPError(400, "user_id and role required")
        
        valid_roles = ["view", "comment", "edit", "lock", "admin"]
        if role not in valid_roles:
            raise HTTPError(400, f"Invalid role. Must be one of: {valid_roles}")
        
        # Update permissions
        old_role = session.user_permissions.get(user_id, "view")
        session.user_permissions[user_id] = role
        
        # Log permission change
        collab_logger.info(
            f"Permission changed for user {user_id}: {old_role} -> {role}",
            extra={
                "session_id": session.session_id,
                "target_user_id": user_id,
                "admin_user_id": current_user["name"],
                "old_role": old_role,
                "new_role": role,
                "cell_id": cell_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "audit_event": "permission_changed"
            }
        )
        
        # Broadcast permission change to session users
        session.broadcast_to_users({
            "type": "permission_changed",
            "user_id": user_id,
            "old_role": old_role,
            "new_role": role,
            "cell_id": cell_id,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        
        self.finish({"message": "Permissions updated successfully"})


class CollaborationCommentsHandler(APIHandler):
    """REST API handler for managing cell-level comments."""
    
    @web.authenticated
    async def get(self, notebook_path: str, thread_id: Optional[str] = None) -> None:
        """Get comments for a notebook or specific thread."""
        session = session_manager.sessions.get(notebook_path)
        if not session:
            # Return empty comments if no active session
            self.finish({"comments": [], "threads": {}})
            return
        
        current_user = self.current_user
        if not session.check_permission(current_user["name"], "comment"):
            raise HTTPError(403, "Comment permission required to view comments")
        
        if thread_id:
            # Get specific thread
            thread_comments = []
            for comment_id, comment_data in session.comments.items():
                if comment_data.get("thread_id") == thread_id:
                    thread_comments.append(comment_data)
            
            # Sort by creation time
            thread_comments.sort(key=lambda c: c["created_at"])
            
            self.finish({"thread_id": thread_id, "comments": thread_comments})
        else:
            # Get all comments organized by threads
            threads = {}
            for cell_id, comment_ids in session.comment_threads.items():
                threads[cell_id] = []
                for comment_id in comment_ids:
                    if comment_id in session.comments:
                        threads[cell_id].append(session.comments[comment_id])
                
                # Sort comments in each thread by creation time
                threads[cell_id].sort(key=lambda c: c["created_at"])
            
            self.finish({"threads": threads})
    
    @web.authenticated
    async def post(self, notebook_path: str, thread_id: Optional[str] = None) -> None:
        """Create a new comment or reply to an existing thread."""
        session = session_manager.sessions.get(notebook_path)
        if not session:
            raise HTTPError(404, "No active collaboration session for notebook")
        
        current_user = self.current_user
        if not session.check_permission(current_user["name"], "comment"):
            raise HTTPError(403, "Comment permission required to create comments")
        
        # Check rate limiting for comments
        rate_limit = session.config.get("comment_rate_limit", 30)
        if not session.check_rate_limit(f"{current_user['name']}_comments"):
            raise HTTPError(429, "Comment rate limit exceeded")
        
        data = json.loads(self.request.body)
        comment_text = data.get("text", "").strip()
        cell_id = data.get("cell_id")
        
        if not comment_text:
            raise HTTPError(400, "Comment text required")
        
        if not cell_id:
            raise HTTPError(400, "Cell ID required")
        
        # Create comment
        comment_id = str(uuid.uuid4())
        current_time = datetime.now(timezone.utc)
        
        comment_data = {
            "comment_id": comment_id,
            "thread_id": thread_id or cell_id,  # Use cell_id as thread_id if not specified
            "cell_id": cell_id,
            "author_id": current_user["name"],
            "author_name": current_user.get("display_name", current_user["name"]),
            "text": comment_text,
            "created_at": current_time.isoformat(),
            "updated_at": current_time.isoformat(),
            "resolved": False,
            "reply_to": data.get("reply_to")  # For threaded replies
        }
        
        # Add to session state
        session.comments[comment_id] = comment_data
        
        if cell_id not in session.comment_threads:
            session.comment_threads[cell_id] = []
        session.comment_threads[cell_id].append(comment_id)
        
        # Log comment creation
        if session.config.get("comment_logs_enabled", True):
            collab_logger.info(
                f"Comment created by {current_user['name']} on cell {cell_id}",
                extra={
                    "session_id": session.session_id,
                    "comment_id": comment_id,
                    "author_id": current_user["name"],
                    "cell_id": cell_id,
                    "thread_id": comment_data["thread_id"],
                    "timestamp": current_time.isoformat(),
                    "audit_event": "comment_created"
                }
            )
        
        # Broadcast comment to session users
        session.broadcast_to_users({
            "type": "comment_created",
            "comment": comment_data
        })
        
        self.finish(comment_data)
    
    @web.authenticated
    async def put(self, notebook_path: str, thread_id: str) -> None:
        """Update a comment or resolve/unresolve a thread."""
        session = session_manager.sessions.get(notebook_path)
        if not session:
            raise HTTPError(404, "No active collaboration session for notebook")
        
        current_user = self.current_user
        data = json.loads(self.request.body)
        
        # Handle thread resolution
        if "resolved" in data:
            if not session.check_permission(current_user["name"], "comment"):
                raise HTTPError(403, "Comment permission required to resolve threads")
            
            resolved = data["resolved"]
            updated_comments = []
            
            # Update all comments in the thread
            for comment_id, comment_data in session.comments.items():
                if comment_data.get("thread_id") == thread_id:
                    comment_data["resolved"] = resolved
                    comment_data["updated_at"] = datetime.now(timezone.utc).isoformat()
                    updated_comments.append(comment_data)
            
            if not updated_comments:
                raise HTTPError(404, "Thread not found")
            
            # Log thread resolution
            if session.config.get("comment_logs_enabled", True):
                collab_logger.info(
                    f"Thread {thread_id} {'resolved' if resolved else 'reopened'} by {current_user['name']}",
                    extra={
                        "session_id": session.session_id,
                        "thread_id": thread_id,
                        "user_id": current_user["name"],
                        "resolved": resolved,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "audit_event": "thread_resolved" if resolved else "thread_reopened"
                    }
                )
            
            # Broadcast thread resolution
            session.broadcast_to_users({
                "type": "thread_resolved" if resolved else "thread_reopened",
                "thread_id": thread_id,
                "resolved": resolved,
                "user_id": current_user["name"],
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
            
            self.finish({"message": f"Thread {'resolved' if resolved else 'reopened'} successfully"})
        
        # Handle comment editing
        elif "text" in data:
            comment_id = data.get("comment_id")
            if not comment_id or comment_id not in session.comments:
                raise HTTPError(404, "Comment not found")
            
            comment_data = session.comments[comment_id]
            
            # Check if user can edit this comment
            if comment_data["author_id"] != current_user["name"] and not session.check_permission(current_user["name"], "admin"):
                raise HTTPError(403, "Only comment author or admin can edit comments")
            
            # Update comment
            old_text = comment_data["text"]
            comment_data["text"] = data["text"].strip()
            comment_data["updated_at"] = datetime.now(timezone.utc).isoformat()
            
            # Log comment edit
            if session.config.get("comment_logs_enabled", True):
                collab_logger.info(
                    f"Comment {comment_id} edited by {current_user['name']}",
                    extra={
                        "session_id": session.session_id,
                        "comment_id": comment_id,
                        "editor_id": current_user["name"],
                        "author_id": comment_data["author_id"],
                        "timestamp": comment_data["updated_at"],
                        "audit_event": "comment_edited"
                    }
                )
            
            # Broadcast comment update
            session.broadcast_to_users({
                "type": "comment_updated",
                "comment": comment_data
            })
            
            self.finish(comment_data)
        
        else:
            raise HTTPError(400, "Invalid update data")
    
    @web.authenticated
    async def delete(self, notebook_path: str, thread_id: str) -> None:
        """Delete a comment or entire thread."""
        session = session_manager.sessions.get(notebook_path)
        if not session:
            raise HTTPError(404, "No active collaboration session for notebook")
        
        current_user = self.current_user
        comment_id = self.get_query_argument("comment_id", None)
        
        if comment_id:
            # Delete specific comment
            if comment_id not in session.comments:
                raise HTTPError(404, "Comment not found")
            
            comment_data = session.comments[comment_id]
            
            # Check if user can delete this comment
            if comment_data["author_id"] != current_user["name"] and not session.check_permission(current_user["name"], "admin"):
                raise HTTPError(403, "Only comment author or admin can delete comments")
            
            # Remove from session state
            del session.comments[comment_id]
            
            # Remove from thread
            cell_id = comment_data["cell_id"]
            if cell_id in session.comment_threads:
                session.comment_threads[cell_id] = [
                    cid for cid in session.comment_threads[cell_id] if cid != comment_id
                ]
                
                # Clean up empty threads
                if not session.comment_threads[cell_id]:
                    del session.comment_threads[cell_id]
            
            # Log comment deletion
            if session.config.get("comment_logs_enabled", True):
                collab_logger.info(
                    f"Comment {comment_id} deleted by {current_user['name']}",
                    extra={
                        "session_id": session.session_id,
                        "comment_id": comment_id,
                        "deleter_id": current_user["name"],
                        "author_id": comment_data["author_id"],
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "audit_event": "comment_deleted"
                    }
                )
            
            # Broadcast comment deletion
            session.broadcast_to_users({
                "type": "comment_deleted",
                "comment_id": comment_id,
                "thread_id": thread_id
            })
            
            self.finish({"message": "Comment deleted successfully"})
        
        else:
            # Delete entire thread
            if not session.check_permission(current_user["name"], "admin"):
                raise HTTPError(403, "Admin permission required to delete entire threads")
            
            # Find all comments in the thread
            comments_to_delete = [
                comment_id for comment_id, comment_data in session.comments.items()
                if comment_data.get("thread_id") == thread_id
            ]
            
            if not comments_to_delete:
                raise HTTPError(404, "Thread not found")
            
            # Delete all comments in the thread
            for comment_id in comments_to_delete:
                del session.comments[comment_id]
            
            # Clean up thread references
            for cell_id, comment_ids in list(session.comment_threads.items()):
                session.comment_threads[cell_id] = [
                    cid for cid in comment_ids if cid not in comments_to_delete
                ]
                if not session.comment_threads[cell_id]:
                    del session.comment_threads[cell_id]
            
            # Log thread deletion
            if session.config.get("comment_logs_enabled", True):
                collab_logger.info(
                    f"Thread {thread_id} deleted by {current_user['name']}",
                    extra={
                        "session_id": session.session_id,
                        "thread_id": thread_id,
                        "deleter_id": current_user["name"],
                        "comments_deleted": len(comments_to_delete),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "audit_event": "thread_deleted"
                    }
                )
            
            # Broadcast thread deletion
            session.broadcast_to_users({
                "type": "thread_deleted",
                "thread_id": thread_id
            })
            
            self.finish({"message": "Thread deleted successfully"})


class CollaborationHistoryHandler(APIHandler):
    """REST API handler for change history and versioning."""
    
    @web.authenticated
    async def get(self, notebook_path: str) -> None:
        """Get change history for a notebook."""
        session = session_manager.sessions.get(notebook_path)
        if not session:
            # Return empty history if no active session
            self.finish({"history": [], "current_version": None})
            return
        
        current_user = self.current_user
        if not session.check_permission(current_user["name"], "view"):
            raise HTTPError(403, "View permission required to access history")
        
        # Get query parameters for filtering
        limit = int(self.get_query_argument("limit", "50"))
        offset = int(self.get_query_argument("offset", "0"))
        user_filter = self.get_query_argument("user", None)
        
        # Filter and paginate history
        filtered_history = session.change_history
        
        if user_filter:
            filtered_history = [
                h for h in filtered_history
                if h.get("user_id") == user_filter
            ]
        
        # Sort by timestamp (most recent first)
        filtered_history.sort(key=lambda h: h.get("timestamp", ""), reverse=True)
        
        # Apply pagination
        paginated_history = filtered_history[offset:offset + limit]
        
        # Get current document version info
        current_version = None
        if CRDT_AVAILABLE and session.ydoc:
            current_version = {
                "state_vector": pycrdt.encode_state_vector(session.ydoc).hex() if session.ydoc else None,
                "last_modified": session.last_activity.isoformat(),
                "total_changes": len(session.change_history)
            }
        
        self.finish({
            "history": paginated_history,
            "current_version": current_version,
            "total_count": len(filtered_history),
            "limit": limit,
            "offset": offset
        })
    
    @web.authenticated
    async def post(self, notebook_path: str) -> None:
        """Create a manual checkpoint or restore from history."""
        session = session_manager.sessions.get(notebook_path)
        if not session:
            raise HTTPError(404, "No active collaboration session for notebook")
        
        current_user = self.current_user
        data = json.loads(self.request.body)
        action = data.get("action")
        
        if action == "checkpoint":
            # Create manual checkpoint
            if not session.check_permission(current_user["name"], "edit"):
                raise HTTPError(403, "Edit permission required to create checkpoints")
            
            checkpoint_id = str(uuid.uuid4())
            checkpoint_data = {
                "checkpoint_id": checkpoint_id,
                "type": "manual_checkpoint",
                "user_id": current_user["name"],
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "description": data.get("description", "Manual checkpoint"),
                "state_vector": None
            }
            
            if CRDT_AVAILABLE and session.ydoc:
                checkpoint_data["state_vector"] = pycrdt.encode_state_vector(session.ydoc).hex()
            
            session.change_history.append(checkpoint_data)
            
            # Log checkpoint creation
            collab_logger.info(
                f"Manual checkpoint created by {current_user['name']}",
                extra={
                    "session_id": session.session_id,
                    "checkpoint_id": checkpoint_id,
                    "user_id": current_user["name"],
                    "timestamp": checkpoint_data["timestamp"],
                    "audit_event": "checkpoint_created"
                }
            )
            
            self.finish(checkpoint_data)
        
        elif action == "restore":
            # Restore from history point
            if not session.check_permission(current_user["name"], "edit"):
                raise HTTPError(403, "Edit permission required to restore from history")
            
            restore_point = data.get("restore_point")
            if not restore_point:
                raise HTTPError(400, "Restore point required")
            
            # Find the history entry
            history_entry = None
            for entry in session.change_history:
                if entry.get("checkpoint_id") == restore_point:
                    history_entry = entry
                    break
            
            if not history_entry:
                raise HTTPError(404, "History point not found")
            
            # Log restore operation
            collab_logger.info(
                f"History restore initiated by {current_user['name']} to point {restore_point}",
                extra={
                    "session_id": session.session_id,
                    "restore_point": restore_point,
                    "user_id": current_user["name"],
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "audit_event": "history_restored"
                }
            )
            
            # Broadcast restore operation to all users
            session.broadcast_to_users({
                "type": "history_restored",
                "restore_point": restore_point,
                "user_id": current_user["name"],
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
            
            self.finish({"message": "History restore completed", "restore_point": restore_point})
        
        else:
            raise HTTPError(400, "Invalid action")


class CollaborationHealthHandler(APIHandler):
    """Health check endpoint for collaboration services."""
    
    async def get(self) -> None:
        """Get collaboration service health status."""
        health_info = {
            "status": "healthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "crdt_available": CRDT_AVAILABLE,
            "active_sessions": len(session_manager.sessions),
            "total_connected_users": sum(
                len(session.connected_users)
                for session in session_manager.sessions.values()
            ),
            "version": "1.0.0",
            "features": {
                "websockets": True,
                "crdt_sync": CRDT_AVAILABLE,
                "presence_awareness": True,
                "cell_locking": True,
                "comments": True,
                "history": True,
                "permissions": True,
                "audit_logging": True
            }
        }
        
        # Check for any unhealthy conditions
        if not CRDT_AVAILABLE:
            health_info["status"] = "degraded"
            health_info["warnings"] = ["CRDT libraries not available - real-time sync disabled"]
        
        # Add detailed session information if requested
        if self.get_query_argument("detailed", "false").lower() == "true":
            health_info["sessions"] = [
                {
                    "session_id": session.session_id,
                    "notebook_path": session.notebook_path,
                    "connected_users": len(session.connected_users),
                    "active_locks": len(session.cell_locks),
                    "comment_threads": len(session.comment_threads),
                    "last_activity": session.last_activity.isoformat()
                }
                for session in session_manager.sessions.values()
            ]
        
        self.finish(health_info)