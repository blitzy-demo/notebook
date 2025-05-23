"""Authentication and authorization services for collaborative editing in Jupyter Notebook v7.

This module provides authentication and authorization services for collaborative editing
in Jupyter Notebook v7. It defines HubAuthenticator for verifying user identity through
JupyterHub and CollaborationAuthorizer for enforcing access control for shared notebooks.
"""

from __future__ import annotations

import json
import logging
import os
import time
import typing as t
from enum import Enum
from functools import wraps
from urllib.parse import urljoin

import tornado.web
from jupyter_server.auth import Authorizer
from jupyter_server.auth.security import passwd_check
from jupyter_server.base.handlers import JupyterHandler
from tornado import httpclient
from tornado.web import HTTPError
from traitlets import Bool, Dict, Enum as TEnum, Instance, Integer, Unicode, default
from traitlets.config import LoggingConfigurable

# Set up logging
logger = logging.getLogger('notebook.auth')


class CollaborationRole(str, Enum):
    """Roles for collaborative notebook editing."""
    
    OWNER = "owner"  # Full control, manage permissions, delete notebook
    EDITOR = "editor"  # Modify notebook content, execute cells, manage comments
    COMMENTER = "commenter"  # View content, add/resolve comments, cannot edit cells
    VIEWER = "viewer"  # Read-only access, view others' cursors and comments
    NONE = "none"  # No access to the notebook


class HubAuthenticator(LoggingConfigurable):
    """Authenticator that verifies user identity through JupyterHub.
    
    This authenticator integrates with JupyterHub to verify user identity for
    collaborative editing sessions. It handles token validation, user information
    retrieval, and session management.
    """
    
    # Configuration options
    hub_api_url = Unicode(
        "",
        help="The JupyterHub API URL",
        config=True
    )
    
    hub_api_token = Unicode(
        "",
        help="API token for authenticating with JupyterHub",
        config=True
    )
    
    hub_user_data_cache_ttl = Integer(
        300,  # 5 minutes
        help="Time in seconds to cache user data from Hub",
        config=True
    )
    
    enable_auth = Bool(
        True,
        help="Enable authentication for collaborative sessions",
        config=True
    )
    
    allow_unauthenticated_access = Bool(
        False,
        help="Allow unauthenticated access in single-user mode (development only)",
        config=True
    )
    
    def __init__(self, **kwargs):
        """Initialize the HubAuthenticator."""
        super().__init__(**kwargs)
        self._user_data_cache: Dict[str, t.Dict[str, t.Any]] = {}
        self._user_data_timestamps: Dict[str, float] = {}
        
        # Detect JupyterHub environment
        self._is_under_jupyterhub = 'JUPYTERHUB_API_TOKEN' in os.environ
        
        if self._is_under_jupyterhub:
            if not self.hub_api_url:
                self.hub_api_url = os.environ.get('JUPYTERHUB_API_URL', '')
            if not self.hub_api_token:
                self.hub_api_token = os.environ.get('JUPYTERHUB_API_TOKEN', '')
            
            if not self.hub_api_url or not self.hub_api_token:
                logger.warning("Running under JupyterHub but missing API URL or token. Collaboration authentication will be limited.")
        else:
            logger.info("Not running under JupyterHub. Using local authentication for collaboration.")
    
    async def authenticate_user(self, handler: JupyterHandler) -> t.Optional[t.Dict[str, t.Any]]:
        """Authenticate a user from the request handler.
        
        Args:
            handler: The Jupyter request handler
            
        Returns:
            User information dictionary if authenticated, None otherwise
        """
        if not self.enable_auth:
            # Authentication disabled, return minimal user info
            return {"name": "anonymous", "admin": False}
        
        # If not running under JupyterHub and allowing unauthenticated access
        if not self._is_under_jupyterhub and self.allow_unauthenticated_access:
            # Use the Jupyter server's user identity or a default
            username = getattr(handler, 'current_user', {}) or {}
            username = username.get('name', 'anonymous')
            return {"name": username, "admin": False}
        
        # Get user from handler's current_user (set by Jupyter auth)
        user = handler.current_user
        if not user:
            return None
        
        # If under JupyterHub, enrich user data with Hub information
        if self._is_under_jupyterhub and self.hub_api_url and self.hub_api_token:
            try:
                return await self._get_hub_user_data(user.get('name'))
            except Exception as e:
                logger.warning(f"Failed to get user data from Hub: {e}")
                # Fall back to basic user info
                return {"name": user.get('name'), "admin": user.get('admin', False)}
        
        # Return basic user info from Jupyter auth
        return {"name": user.get('name'), "admin": user.get('admin', False)}
    
    async def _get_hub_user_data(self, username: str) -> t.Dict[str, t.Any]:
        """Get user data from JupyterHub API.
        
        Args:
            username: The username to get data for
            
        Returns:
            User information dictionary from Hub
        """
        # Check cache first
        now = time.time()
        if username in self._user_data_cache:
            cache_time = self._user_data_timestamps.get(username, 0)
            if now - cache_time < self.hub_user_data_cache_ttl:
                return self._user_data_cache[username]
        
        # Fetch from Hub API
        api_url = urljoin(self.hub_api_url, f"/users/{username}")
        headers = {"Authorization": f"token {self.hub_api_token}"}
        
        http_client = httpclient.AsyncHTTPClient()
        try:
            response = await http_client.fetch(
                api_url,
                method="GET",
                headers=headers,
                raise_error=True
            )
            user_data = json.loads(response.body.decode('utf-8'))
            
            # Cache the result
            self._user_data_cache[username] = user_data
            self._user_data_timestamps[username] = now
            
            return user_data
        except Exception as e:
            logger.error(f"Error fetching user data from Hub: {e}")
            raise
    
    async def validate_token(self, token: str) -> t.Optional[t.Dict[str, t.Any]]:
        """Validate a token and return user information.
        
        Args:
            token: The authentication token to validate
            
        Returns:
            User information if token is valid, None otherwise
        """
        if not self.enable_auth:
            return {"name": "anonymous", "admin": False}
        
        if not self._is_under_jupyterhub and self.allow_unauthenticated_access:
            # In development mode without JupyterHub, accept any token
            return {"name": "anonymous", "admin": False}
        
        if not self._is_under_jupyterhub or not self.hub_api_url or not self.hub_api_token:
            # Cannot validate tokens without Hub
            return None
        
        # Validate token with Hub API
        api_url = urljoin(self.hub_api_url, "/authorizations/token")
        headers = {
            "Authorization": f"token {self.hub_api_token}",
            "Content-Type": "application/json"
        }
        data = json.dumps({"token": token})
        
        http_client = httpclient.AsyncHTTPClient()
        try:
            response = await http_client.fetch(
                api_url,
                method="POST",
                headers=headers,
                body=data,
                raise_error=False
            )
            
            if response.code != 200:
                logger.warning(f"Token validation failed: {response.code}")
                return None
            
            auth_data = json.loads(response.body.decode('utf-8'))
            username = auth_data.get('user', {}).get('name')
            if not username:
                return None
            
            # Get full user data
            return await self._get_hub_user_data(username)
        except Exception as e:
            logger.error(f"Error validating token with Hub: {e}")
            return None
    
    async def get_user_role(self, username: str) -> t.Optional[str]:
        """Get the JupyterHub role for a user.
        
        Args:
            username: The username to get the role for
            
        Returns:
            Role string if available, None otherwise
        """
        if not self._is_under_jupyterhub or not self.hub_api_url or not self.hub_api_token:
            return None
        
        try:
            user_data = await self._get_hub_user_data(username)
            # Extract role information from user data
            # This depends on how roles are represented in your JupyterHub setup
            return user_data.get('role', None)
        except Exception as e:
            logger.error(f"Error getting user role: {e}")
            return None


class CollaborationAuthorizer(Authorizer):
    """Authorizer for collaborative notebook editing.
    
    This authorizer enforces access control for shared notebooks based on
    user roles and permissions. It integrates with JupyterHub for user
    authentication and implements role-based access control for collaborative
    features.
    """
    
    # Configuration options
    default_collaboration_role = TEnum(
        CollaborationRole,
        default_value=CollaborationRole.VIEWER,
        help="Default role for users without explicit permissions",
        config=True
    )
    
    admin_collaboration_role = TEnum(
        CollaborationRole,
        default_value=CollaborationRole.OWNER,
        help="Default role for admin users",
        config=True
    )
    
    owner_collaboration_role = TEnum(
        CollaborationRole,
        default_value=CollaborationRole.OWNER,
        help="Default role for notebook owners",
        config=True
    )
    
    enable_permissions = Bool(
        True,
        help="Enable permission checking for collaborative features",
        config=True
    )
    
    permission_cache_ttl = Integer(
        60,  # 1 minute
        help="Time in seconds to cache permission decisions",
        config=True
    )
    
    authenticator = Instance(HubAuthenticator, allow_none=True)
    
    @default('authenticator')
    def _default_authenticator(self):
        return HubAuthenticator(parent=self)
    
    def __init__(self, **kwargs):
        """Initialize the CollaborationAuthorizer."""
        super().__init__(**kwargs)
        self._permission_cache: Dict[str, t.Dict[str, t.Any]] = {}
        self._permission_timestamps: Dict[str, float] = {}
        
        # In-memory permission store for development/testing
        # In production, this would be backed by a database
        self._permissions: Dict[str, Dict[str, str]] = {}
    
    def _get_cache_key(self, username: str, resource_path: str, action: str) -> str:
        """Generate a cache key for permission decisions.
        
        Args:
            username: The username requesting access
            resource_path: The path to the resource
            action: The action being performed
            
        Returns:
            A cache key string
        """
        return f"{username}:{resource_path}:{action}"
    
    async def is_authorized(self, handler: JupyterHandler, user: t.Dict[str, t.Any], 
                           action: str, resource: str) -> bool:
        """Check if a user is authorized to perform an action on a resource.
        
        Args:
            handler: The request handler
            user: The user information dictionary
            action: The action being performed (read, write, execute)
            resource: The resource being accessed
            
        Returns:
            True if authorized, False otherwise
        """
        if not self.enable_permissions:
            return True
        
        # Always allow server admins
        if user.get('admin', False):
            return True
        
        # For non-collaborative resources, defer to parent class
        if not resource.startswith('collab:'):
            return await super().is_authorized(handler, user, action, resource)
        
        # For collaborative resources, check role-based permissions
        username = user.get('name')
        if not username:
            return False
        
        # Extract resource path from collab:path format
        resource_path = resource[7:] if resource.startswith('collab:') else resource
        
        # Check cache first
        cache_key = self._get_cache_key(username, resource_path, action)
        now = time.time()
        if cache_key in self._permission_cache:
            cache_time = self._permission_timestamps.get(cache_key, 0)
            if now - cache_time < self.permission_cache_ttl:
                return self._permission_cache[cache_key].get('authorized', False)
        
        # Get user's role for this resource
        role = await self.get_user_role_for_resource(username, resource_path)
        authorized = self.is_role_authorized(role, action)
        
        # Cache the decision
        self._permission_cache[cache_key] = {'authorized': authorized}
        self._permission_timestamps[cache_key] = now
        
        # Log the authorization decision
        logger.debug(f"Authorization decision: user={username}, resource={resource_path}, action={action}, role={role}, authorized={authorized}")
        
        return authorized
    
    async def get_user_role_for_resource(self, username: str, resource_path: str) -> CollaborationRole:
        """Get a user's role for a specific resource.
        
        Args:
            username: The username
            resource_path: The path to the resource
            
        Returns:
            The user's role for the resource
        """
        # Check if user is the owner of the resource
        # This would typically check the file ownership in the filesystem
        # or a permissions database
        
        # For now, use our in-memory permission store
        resource_permissions = self._permissions.get(resource_path, {})
        role_str = resource_permissions.get(username)
        
        if role_str:
            try:
                return CollaborationRole(role_str)
            except ValueError:
                logger.warning(f"Invalid role '{role_str}' for user {username} on {resource_path}")
        
        # If no specific role, check if user is admin
        try:
            user_data = await self.authenticator._get_hub_user_data(username)
            if user_data.get('admin', False):
                return self.admin_collaboration_role
        except Exception:
            # If we can't get user data, fall back to default role
            pass
        
        # Default role if nothing else applies
        return self.default_collaboration_role
    
    def is_role_authorized(self, role: CollaborationRole, action: str) -> bool:
        """Check if a role is authorized to perform an action.
        
        Args:
            role: The user's role
            action: The action being performed
            
        Returns:
            True if authorized, False otherwise
        """
        # Define permission matrix for different roles and actions
        permission_matrix = {
            CollaborationRole.OWNER: ['read', 'write', 'execute', 'comment', 'resolve', 'lock', 'unlock', 'manage'],
            CollaborationRole.EDITOR: ['read', 'write', 'execute', 'comment', 'resolve', 'lock', 'unlock'],
            CollaborationRole.COMMENTER: ['read', 'comment', 'resolve'],
            CollaborationRole.VIEWER: ['read'],
            CollaborationRole.NONE: []
        }
        
        allowed_actions = permission_matrix.get(role, [])
        return action in allowed_actions
    
    async def set_resource_permission(self, resource_path: str, username: str, role: CollaborationRole) -> bool:
        """Set a user's permission for a resource.
        
        Args:
            resource_path: The path to the resource
            username: The username
            role: The role to assign
            
        Returns:
            True if successful, False otherwise
        """
        if resource_path not in self._permissions:
            self._permissions[resource_path] = {}
        
        self._permissions[resource_path][username] = role.value
        
        # Clear any cached permissions for this user and resource
        for action in ['read', 'write', 'execute', 'comment', 'resolve', 'lock', 'unlock', 'manage']:
            cache_key = self._get_cache_key(username, resource_path, action)
            if cache_key in self._permission_cache:
                del self._permission_cache[cache_key]
                if cache_key in self._permission_timestamps:
                    del self._permission_timestamps[cache_key]
        
        return True
    
    async def get_resource_permissions(self, resource_path: str) -> Dict[str, str]:
        """Get all permissions for a resource.
        
        Args:
            resource_path: The path to the resource
            
        Returns:
            Dictionary mapping usernames to roles
        """
        return self._permissions.get(resource_path, {}).copy()
    
    async def check_collaboration_permission(self, username: str, resource_path: str, action: str) -> bool:
        """Check if a user has permission to perform a collaboration action.
        
        Args:
            username: The username
            resource_path: The path to the resource
            action: The collaboration action (edit, comment, etc.)
            
        Returns:
            True if permitted, False otherwise
        """
        if not self.enable_permissions:
            return True
        
        # Get user's role for this resource
        role = await self.get_user_role_for_resource(username, resource_path)
        return self.is_role_authorized(role, action)


def authenticated_collaboration(method):
    """Decorator for WebSocket handlers that require authentication for collaboration.
    
    This decorator ensures that WebSocket connections for collaborative editing
    are properly authenticated before allowing access.
    """
    @wraps(method)
    async def wrapper(self, *args, **kwargs):
        # Skip authentication if disabled
        if not self.collaboration_authenticator.enable_auth:
            return await method(self, *args, **kwargs)
        
        # Get authentication token from query parameters or headers
        auth_header = self.request.headers.get('Authorization', '')
        if auth_header.startswith('token '):
            token = auth_header[6:]
        else:
            token = self.get_argument('token', None)
        
        if not token:
            # Check for existing authenticated user in the handler
            current_user = getattr(self, 'current_user', None)
            if current_user:
                # User is already authenticated through Jupyter auth
                return await method(self, *args, **kwargs)
            else:
                self.set_status(401)
                self.finish(json.dumps({'error': 'Authentication required for collaboration'}))
                return
        
        # Validate the token
        user = await self.collaboration_authenticator.validate_token(token)
        if not user:
            self.set_status(401)
            self.finish(json.dumps({'error': 'Invalid authentication token'}))
            return
        
        # Store user information in the handler
        self.collaboration_user = user
        
        # Call the original method
        return await method(self, *args, **kwargs)
    
    return wrapper


def authorized_collaboration(action):
    """Decorator for WebSocket handlers that require authorization for collaboration actions.
    
    This decorator ensures that WebSocket connections for collaborative editing
    have the necessary permissions to perform specific actions.
    
    Args:
        action: The action requiring authorization (edit, comment, etc.)
    """
    def decorator(method):
        @wraps(method)
        async def wrapper(self, *args, **kwargs):
            # Skip authorization if disabled
            if not self.collaboration_authorizer.enable_permissions:
                return await method(self, *args, **kwargs)
            
            # Get user and resource information
            user = getattr(self, 'collaboration_user', None)
            if not user:
                # Try to get from current_user (set by Jupyter auth)
                current_user = getattr(self, 'current_user', None)
                if current_user:
                    user = {'name': current_user.get('name'), 'admin': current_user.get('admin', False)}
                else:
                    self.set_status(401)
                    self.finish(json.dumps({'error': 'Authentication required for collaboration'}))
                    return
            
            # Get resource path from the handler
            resource_path = getattr(self, 'resource_path', None)
            if not resource_path:
                # Try to get from request path or arguments
                resource_path = self.get_argument('path', self.request.path)
            
            # Check authorization
            username = user.get('name')
            authorized = await self.collaboration_authorizer.check_collaboration_permission(
                username, resource_path, action
            )
            
            if not authorized:
                self.set_status(403)
                self.finish(json.dumps({
                    'error': f'Not authorized to {action} this resource',
                    'resource': resource_path,
                    'action': action
                }))
                return
            
            # Call the original method
            return await method(self, *args, **kwargs)
        
        return wrapper
    
    return decorator