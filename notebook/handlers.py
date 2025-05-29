"""Collaborative WebSocket handlers for real-time notebook editing and collaboration features.

This module provides comprehensive server-side collaboration functionality including:
- Real-time Yjs CRDT document synchronization via WebSocket
- Role-based access control with fine-grained permissions
- User presence and awareness broadcasting
- Cell-level locking mechanisms with conflict resolution
- Comment system with threading and resolution workflows
- Change history and versioning capabilities
- Integration with JupyterHub for enterprise authentication
- Comprehensive audit logging and security controls

The collaboration features can be completely disabled via configuration without
affecting single-user workflows or core notebook functionality.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Union
from urllib.parse import parse_qs, urlparse
import weakref

from jupyter_server.auth import authorized
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from tornado import web, websocket
from tornado.escape import json_decode, json_encode
from tornado.ioloop import IOLoop
from traitlets import Unicode, Integer, Float, List as TraitletsList, Dict as TraitletsDictionary

# Rate limiting imports
from collections import deque
import hashlib
import hmac

# Version and utilities
from ._version import __version__

# Logger setup
logger = logging.getLogger(__name__)
collab_logger = logging.getLogger("jupyter_notebook.collaboration")
audit_logger = logging.getLogger("jupyter_notebook.collaboration.audit")


class CollaborationError(Exception):
    """Base exception for collaboration-related errors."""
    pass


class PermissionDeniedError(CollaborationError):
    """Exception raised when user lacks required permissions."""
    pass


class RateLimitExceededError(CollaborationError):
    """Exception raised when rate limits are exceeded."""
    pass


class DocumentNotFoundError(CollaborationError):
    """Exception raised when requested document is not found."""
    pass


class LockConflictError(CollaborationError):
    """Exception raised when lock conflicts occur."""
    pass


class RateLimiter:
    """Simple rate limiting implementation with sliding window."""
    
    def __init__(self, max_requests: float, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests: Dict[str, deque] = defaultdict(deque)
    
    def is_allowed(self, identifier: str) -> bool:
        """Check if request is within rate limits."""
        now = time.time()
        window_start = now - self.window_seconds
        
        # Clean old requests
        user_requests = self.requests[identifier]
        while user_requests and user_requests[0] < window_start:
            user_requests.popleft()
        
        # Check if under limit
        if len(user_requests) < self.max_requests:
            user_requests.append(now)
            return True
        
        return False


class CollaborationRole:
    """Defines collaboration roles and their capabilities."""
    
    VIEW = "view"
    COMMENT = "comment"
    EDIT = "edit"
    LOCK = "lock"
    ADMIN = "admin"
    
    # Role hierarchy - higher roles inherit lower role capabilities
    ROLE_HIERARCHY = {
        VIEW: 0,
        COMMENT: 1,
        EDIT: 2,
        LOCK: 3,
        ADMIN: 4
    }
    
    # Capabilities for each role
    ROLE_CAPABILITIES = {
        VIEW: ["read_content", "view_comments", "view_presence"],
        COMMENT: ["create_comment", "reply_comment", "resolve_own_comment"],
        EDIT: ["modify_content", "save_notebook", "execute_cells"],
        LOCK: ["acquire_lock", "release_lock", "force_unlock_own"],
        ADMIN: ["manage_permissions", "force_unlock_any", "manage_comments", "access_history"]
    }
    
    @classmethod
    def has_capability(cls, role: str, capability: str) -> bool:
        """Check if role has specific capability."""
        role_level = cls.ROLE_HIERARCHY.get(role, -1)
        
        for check_role, level in cls.ROLE_HIERARCHY.items():
            if level <= role_level and capability in cls.ROLE_CAPABILITIES.get(check_role, []):
                return True
        
        return False
    
    @classmethod
    def get_effective_capabilities(cls, role: str) -> Set[str]:
        """Get all capabilities for a role including inherited ones."""
        capabilities = set()
        role_level = cls.ROLE_HIERARCHY.get(role, -1)
        
        for check_role, level in cls.ROLE_HIERARCHY.items():
            if level <= role_level:
                capabilities.update(cls.ROLE_CAPABILITIES.get(check_role, []))
        
        return capabilities


class CollaborationPermissions:
    """Manages permissions for collaborative editing sessions."""
    
    def __init__(self):
        # notebook_id -> {user_id: role}
        self.notebook_permissions: Dict[str, Dict[str, str]] = {}
        # (notebook_id, cell_id) -> {user_id: role}  
        self.cell_permissions: Dict[tuple, Dict[str, str]] = {}
        self.default_role = CollaborationRole.EDIT
    
    def set_notebook_permission(self, notebook_id: str, user_id: str, role: str) -> None:
        """Set user role for notebook."""
        if notebook_id not in self.notebook_permissions:
            self.notebook_permissions[notebook_id] = {}
        self.notebook_permissions[notebook_id][user_id] = role
        
        audit_logger.info(
            "Permission changed",
            extra={
                "event_type": "permission_change",
                "user_id": user_id,
                "notebook_id": notebook_id,
                "role": role,
                "level": "notebook"
            }
        )
    
    def set_cell_permission(self, notebook_id: str, cell_id: str, user_id: str, role: str) -> None:
        """Set user role for specific cell."""
        key = (notebook_id, cell_id)
        if key not in self.cell_permissions:
            self.cell_permissions[key] = {}
        self.cell_permissions[key][user_id] = role
        
        audit_logger.info(
            "Cell permission changed",
            extra={
                "event_type": "permission_change",
                "user_id": user_id,
                "notebook_id": notebook_id,
                "cell_id": cell_id,
                "role": role,
                "level": "cell"
            }
        )
    
    def get_user_role(self, notebook_id: str, user_id: str, cell_id: Optional[str] = None) -> str:
        """Get effective user role for notebook or cell."""
        # Check cell-specific permissions first
        if cell_id:
            cell_key = (notebook_id, cell_id)
            if cell_key in self.cell_permissions and user_id in self.cell_permissions[cell_key]:
                return self.cell_permissions[cell_key][user_id]
        
        # Fall back to notebook-level permissions
        if notebook_id in self.notebook_permissions and user_id in self.notebook_permissions[notebook_id]:
            return self.notebook_permissions[notebook_id][user_id]
        
        # Default role
        return self.default_role
    
    def check_permission(self, notebook_id: str, user_id: str, capability: str, 
                        cell_id: Optional[str] = None) -> bool:
        """Check if user has required capability."""
        role = self.get_user_role(notebook_id, user_id, cell_id)
        return CollaborationRole.has_capability(role, capability)


class CollaborationLocks:
    """Manages cell-level locking for collaborative editing."""
    
    def __init__(self, lock_timeout: int = 300):
        self.lock_timeout = lock_timeout
        # (notebook_id, cell_id) -> {user_id, timestamp, type}
        self.locks: Dict[tuple, Dict[str, Any]] = {}
    
    def acquire_lock(self, notebook_id: str, cell_id: str, user_id: str, 
                    lock_type: str = "edit") -> bool:
        """Attempt to acquire lock on cell."""
        key = (notebook_id, cell_id)
        now = time.time()
        
        # Check for existing lock
        if key in self.locks:
            existing_lock = self.locks[key]
            
            # Check if lock is expired
            if now - existing_lock["timestamp"] > self.lock_timeout:
                # Lock expired, remove it
                del self.locks[key]
                audit_logger.info(
                    "Lock expired and removed",
                    extra={
                        "event_type": "lock_expired",
                        "notebook_id": notebook_id,
                        "cell_id": cell_id,
                        "previous_owner": existing_lock["user_id"]
                    }
                )
            elif existing_lock["user_id"] == user_id:
                # User already holds the lock, refresh timestamp
                existing_lock["timestamp"] = now
                return True
            else:
                # Lock held by another user
                audit_logger.warning(
                    "Lock acquisition failed - already locked",
                    extra={
                        "event_type": "lock_conflict",
                        "notebook_id": notebook_id,
                        "cell_id": cell_id,
                        "requesting_user": user_id,
                        "lock_owner": existing_lock["user_id"]
                    }
                )
                return False
        
        # Acquire new lock
        self.locks[key] = {
            "user_id": user_id,
            "timestamp": now,
            "type": lock_type
        }
        
        audit_logger.info(
            "Lock acquired",
            extra={
                "event_type": "lock_acquired",
                "user_id": user_id,
                "notebook_id": notebook_id,
                "cell_id": cell_id,
                "lock_type": lock_type
            }
        )
        
        return True
    
    def release_lock(self, notebook_id: str, cell_id: str, user_id: str, 
                    force: bool = False) -> bool:
        """Release lock on cell."""
        key = (notebook_id, cell_id)
        
        if key not in self.locks:
            return True  # No lock to release
        
        existing_lock = self.locks[key]
        
        # Check ownership unless forced
        if not force and existing_lock["user_id"] != user_id:
            audit_logger.warning(
                "Lock release failed - not owner",
                extra={
                    "event_type": "lock_release_denied",
                    "notebook_id": notebook_id,
                    "cell_id": cell_id,
                    "requesting_user": user_id,
                    "lock_owner": existing_lock["user_id"]
                }
            )
            return False
        
        del self.locks[key]
        
        audit_logger.info(
            "Lock released",
            extra={
                "event_type": "lock_released",
                "user_id": user_id,
                "notebook_id": notebook_id,
                "cell_id": cell_id,
                "forced": force
            }
        )
        
        return True
    
    def get_lock_info(self, notebook_id: str, cell_id: str) -> Optional[Dict[str, Any]]:
        """Get information about cell lock."""
        key = (notebook_id, cell_id)
        return self.locks.get(key)
    
    def cleanup_expired_locks(self) -> None:
        """Remove expired locks."""
        now = time.time()
        expired_keys = []
        
        for key, lock in self.locks.items():
            if now - lock["timestamp"] > self.lock_timeout:
                expired_keys.append(key)
        
        for key in expired_keys:
            del self.locks[key]
            audit_logger.info(
                "Expired lock cleaned up",
                extra={
                    "event_type": "lock_cleanup",
                    "notebook_id": key[0],
                    "cell_id": key[1]
                }
            )


class CollaborationComments:
    """Manages comment system for collaborative editing."""
    
    def __init__(self):
        # notebook_id -> [comments]
        self.comments: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        self.comment_counter = 0
    
    def create_comment(self, notebook_id: str, user_id: str, content: str,
                      cell_id: Optional[str] = None, thread_id: Optional[str] = None,
                      metadata: Optional[Dict[str, Any]] = None) -> str:
        """Create a new comment or reply."""
        self.comment_counter += 1
        comment_id = f"comment_{self.comment_counter}_{int(time.time())}"
        
        # If no thread_id provided, this starts a new thread
        if not thread_id:
            thread_id = f"thread_{self.comment_counter}_{int(time.time())}"
        
        comment = {
            "id": comment_id,
            "thread_id": thread_id,
            "user_id": user_id,
            "content": content,
            "cell_id": cell_id,
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
            "resolved": False,
            "metadata": metadata or {}
        }
        
        self.comments[notebook_id].append(comment)
        
        audit_logger.info(
            "Comment created",
            extra={
                "event_type": "comment_created",
                "user_id": user_id,
                "notebook_id": notebook_id,
                "comment_id": comment_id,
                "thread_id": thread_id,
                "cell_id": cell_id
            }
        )
        
        return comment_id
    
    def get_comments(self, notebook_id: str, cell_id: Optional[str] = None,
                    thread_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get comments with optional filtering."""
        comments = self.comments.get(notebook_id, [])
        
        if cell_id:
            comments = [c for c in comments if c.get("cell_id") == cell_id]
        
        if thread_id:
            comments = [c for c in comments if c.get("thread_id") == thread_id]
        
        return sorted(comments, key=lambda x: x["created_at"])
    
    def update_comment(self, notebook_id: str, comment_id: str, user_id: str,
                      content: str) -> bool:
        """Update existing comment content."""
        for comment in self.comments.get(notebook_id, []):
            if comment["id"] == comment_id:
                if comment["user_id"] != user_id:
                    return False  # Not the author
                
                comment["content"] = content
                comment["updated_at"] = datetime.utcnow().isoformat()
                
                audit_logger.info(
                    "Comment updated",
                    extra={
                        "event_type": "comment_updated",
                        "user_id": user_id,
                        "notebook_id": notebook_id,
                        "comment_id": comment_id
                    }
                )
                
                return True
        
        return False
    
    def resolve_thread(self, notebook_id: str, thread_id: str, user_id: str,
                      resolved: bool = True) -> bool:
        """Mark thread as resolved or unresolved."""
        updated = False
        
        for comment in self.comments.get(notebook_id, []):
            if comment["thread_id"] == thread_id:
                comment["resolved"] = resolved
                comment["updated_at"] = datetime.utcnow().isoformat()
                updated = True
        
        if updated:
            audit_logger.info(
                "Thread resolution changed",
                extra={
                    "event_type": "thread_resolved" if resolved else "thread_reopened",
                    "user_id": user_id,
                    "notebook_id": notebook_id,
                    "thread_id": thread_id,
                    "resolved": resolved
                }
            )
        
        return updated
    
    def delete_comment(self, notebook_id: str, comment_id: str, user_id: str,
                      is_admin: bool = False) -> bool:
        """Delete comment (author or admin only)."""
        comments = self.comments.get(notebook_id, [])
        
        for i, comment in enumerate(comments):
            if comment["id"] == comment_id:
                if not is_admin and comment["user_id"] != user_id:
                    return False  # Not authorized
                
                del comments[i]
                
                audit_logger.info(
                    "Comment deleted",
                    extra={
                        "event_type": "comment_deleted",
                        "user_id": user_id,
                        "notebook_id": notebook_id,
                        "comment_id": comment_id,
                        "admin_action": is_admin
                    }
                )
                
                return True
        
        return False


class BaseCollaborationHandler(APIHandler):
    """Base handler for collaboration endpoints with shared functionality."""
    
    def initialize(self, extensionapp=None):
        """Initialize the handler with extension app."""
        super().initialize()
        self.extensionapp = extensionapp
        self.collaboration_enabled = getattr(extensionapp, 'collaboration_enabled', False)
        
        # Initialize shared collaboration components
        if not hasattr(self.__class__, '_shared_permissions'):
            self.__class__._shared_permissions = CollaborationPermissions()
            self.__class__._shared_locks = CollaborationLocks(
                lock_timeout=getattr(extensionapp, 'collaboration_lock_timeout', 300)
            )
            self.__class__._shared_comments = CollaborationComments()
            
            # Initialize rate limiters
            ws_rate_limit = getattr(extensionapp, 'collaboration_ws_rate_limit', 100.0)
            comment_rate_limit = getattr(extensionapp, 'collaboration_comment_rate_limit', 10.0)
            
            self.__class__._ws_rate_limiter = RateLimiter(ws_rate_limit, 60)
            self.__class__._comment_rate_limiter = RateLimiter(comment_rate_limit, 60)
    
    @property
    def permissions(self) -> CollaborationPermissions:
        """Get shared permissions manager."""
        return self.__class__._shared_permissions
    
    @property
    def locks(self) -> CollaborationLocks:
        """Get shared locks manager."""
        return self.__class__._shared_locks
    
    @property
    def comments(self) -> CollaborationComments:
        """Get shared comments manager."""
        return self.__class__._shared_comments
    
    def prepare(self):
        """Prepare handler - check if collaboration is enabled."""
        super().prepare()
        
        if not self.collaboration_enabled:
            collab_logger.debug("Collaboration endpoint accessed when disabled")
            raise web.HTTPError(404, "Collaboration features are disabled")
    
    def get_current_user_id(self) -> str:
        """Get current user ID from authentication context."""
        # Try JupyterHub user first
        if hasattr(self, 'current_user') and self.current_user:
            if isinstance(self.current_user, dict):
                return self.current_user.get('name', 'anonymous')
            return str(self.current_user)
        
        # Fall back to session-based identification
        user_id = self.get_secure_cookie('user_id')
        if user_id:
            return user_id.decode('utf-8')
        
        # Generate session-based user ID for standalone mode
        session_id = self.get_secure_cookie('_xsrf')
        if session_id:
            return f"user_{hashlib.md5(session_id).hexdigest()[:8]}"
        
        return "anonymous"
    
    def check_collaboration_permission(self, notebook_id: str, capability: str,
                                     cell_id: Optional[str] = None) -> bool:
        """Check if current user has required collaboration capability."""
        user_id = self.get_current_user_id()
        return self.permissions.check_permission(notebook_id, user_id, capability, cell_id)
    
    def require_collaboration_permission(self, notebook_id: str, capability: str,
                                       cell_id: Optional[str] = None) -> None:
        """Require collaboration permission or raise 403."""
        if not self.check_collaboration_permission(notebook_id, capability, cell_id):
            user_id = self.get_current_user_id()
            role = self.permissions.get_user_role(notebook_id, user_id, cell_id)
            
            audit_logger.warning(
                "Permission denied",
                extra={
                    "event_type": "permission_denied",
                    "user_id": user_id,
                    "notebook_id": notebook_id,
                    "cell_id": cell_id,
                    "required_capability": capability,
                    "user_role": role
                }
            )
            
            raise web.HTTPError(403, f"Insufficient permissions. Required: {capability}")
    
    def check_rate_limit(self, limiter: RateLimiter, identifier: Optional[str] = None) -> None:
        """Check rate limit and raise 429 if exceeded."""
        if not identifier:
            identifier = self.get_current_user_id()
        
        if not limiter.is_allowed(identifier):
            audit_logger.warning(
                "Rate limit exceeded",
                extra={
                    "event_type": "rate_limit_exceeded",
                    "user_id": identifier,
                    "limiter_type": type(limiter).__name__
                }
            )
            raise web.HTTPError(429, "Rate limit exceeded")
    
    def write_error(self, status_code: int, **kwargs) -> None:
        """Write JSON error response."""
        self.set_header("Content-Type", "application/json")
        
        error_data = {
            "error": {
                "code": status_code,
                "message": self._reason,
                "timestamp": datetime.utcnow().isoformat()
            }
        }
        
        # Add specific error details for collaboration errors
        if "exc_info" in kwargs:
            exc_type, exc_value, exc_traceback = kwargs["exc_info"]
            if isinstance(exc_value, CollaborationError):
                error_data["error"]["type"] = exc_type.__name__
                error_data["error"]["details"] = str(exc_value)
        
        self.write(error_data)


class CollaborationWebSocketHandler(websocket.WebSocketHandler):
    """WebSocket handler for real-time Yjs CRDT synchronization and collaborative events."""
    
    # Class-level storage for connected clients
    clients: Dict[str, Set[websocket.WebSocketHandler]] = defaultdict(set)
    client_info: Dict[websocket.WebSocketHandler, Dict[str, Any]] = {}
    
    def initialize(self, extensionapp=None):
        """Initialize WebSocket handler."""
        self.extensionapp = extensionapp
        self.collaboration_enabled = getattr(extensionapp, 'collaboration_enabled', False)
        self.document_id: Optional[str] = None
        self.user_id: Optional[str] = None
        self.authenticated = False
        
        # Initialize shared components if needed
        if not hasattr(self.__class__, '_shared_permissions'):
            self.__class__._shared_permissions = CollaborationPermissions()
            self.__class__._shared_locks = CollaborationLocks(
                lock_timeout=getattr(extensionapp, 'collaboration_lock_timeout', 300)
            )
            self.__class__._shared_comments = CollaborationComments()
            
            ws_rate_limit = getattr(extensionapp, 'collaboration_ws_rate_limit', 100.0)
            self.__class__._ws_rate_limiter = RateLimiter(ws_rate_limit, 60)
    
    @property
    def permissions(self) -> CollaborationPermissions:
        """Get shared permissions manager."""
        return self.__class__._shared_permissions
    
    @property
    def locks(self) -> CollaborationLocks:
        """Get shared locks manager."""
        return self.__class__._shared_locks
    
    @property
    def comments(self) -> CollaborationComments:
        """Get shared comments manager."""
        return self.__class__._shared_comments
    
    def check_origin(self, origin: str) -> bool:
        """Check WebSocket origin."""
        # Allow same-origin requests
        return True
    
    def get_current_user_id(self) -> str:
        """Get current user ID from WebSocket context."""
        # Try to get user from JupyterHub authentication
        if hasattr(self, 'current_user') and self.current_user:
            if isinstance(self.current_user, dict):
                return self.current_user.get('name', 'anonymous')
            return str(self.current_user)
        
        # Fall back to session-based identification
        user_cookie = self.get_secure_cookie('user_id')
        if user_cookie:
            return user_cookie.decode('utf-8')
        
        # Generate session-based user ID
        session_cookie = self.get_secure_cookie('_xsrf')
        if session_cookie:
            return f"user_{hashlib.md5(session_cookie).hexdigest()[:8]}"
        
        return "anonymous"
    
    async def open(self, *args, **kwargs):
        """Handle WebSocket connection open."""
        if not self.collaboration_enabled:
            collab_logger.warning("WebSocket connection attempted when collaboration disabled")
            self.close(code=1000, reason="Collaboration features are disabled")
            return
        
        # Parse query parameters for document ID
        query_args = parse_qs(urlparse(self.request.uri).query)
        document_id = query_args.get('document_id', [None])[0]
        
        if not document_id:
            collab_logger.error("WebSocket connection without document_id")
            self.close(code=1002, reason="Missing document_id parameter")
            return
        
        self.document_id = document_id
        self.user_id = self.get_current_user_id()
        
        # Check authentication and permissions
        if not self.user_id or self.user_id == "anonymous":
            collab_logger.warning(f"Unauthenticated WebSocket connection attempt for {document_id}")
            self.close(code=1008, reason="Authentication required")
            return
        
        # Check if user has at least view permission
        if not self.permissions.check_permission(document_id, self.user_id, "read_content"):
            audit_logger.warning(
                "WebSocket access denied - insufficient permissions",
                extra={
                    "event_type": "websocket_access_denied",
                    "user_id": self.user_id,
                    "document_id": document_id
                }
            )
            self.close(code=1008, reason="Insufficient permissions")
            return
        
        # Check rate limiting
        if not self.__class__._ws_rate_limiter.is_allowed(self.user_id):
            audit_logger.warning(
                "WebSocket connection rate limited",
                extra={
                    "event_type": "websocket_rate_limited",
                    "user_id": self.user_id,
                    "document_id": document_id
                }
            )
            self.close(code=1013, reason="Rate limit exceeded")
            return
        
        self.authenticated = True
        
        # Add to clients and broadcast presence
        self.__class__.clients[document_id].add(self)
        self.__class__.client_info[self] = {
            "user_id": self.user_id,
            "document_id": document_id,
            "connected_at": time.time(),
            "client_id": str(uuid.uuid4())
        }
        
        # Send initial connection confirmation
        await self.send_message({
            "type": "connection_established",
            "user_id": self.user_id,
            "document_id": document_id,
            "client_id": self.__class__.client_info[self]["client_id"],
            "timestamp": time.time()
        })
        
        # Send current document state (if any)
        # This would be implemented with actual Yjs document state
        await self.send_message({
            "type": "document_state",
            "document_id": document_id,
            "state": {}  # Placeholder for Yjs state
        })
        
        # Broadcast user joined to other clients
        await self.broadcast_to_document({
            "type": "user_presence",
            "action": "joined",
            "user_id": self.user_id,
            "document_id": document_id,
            "timestamp": time.time()
        }, exclude_self=True)
        
        collab_logger.info(f"WebSocket connection established: {self.user_id} -> {document_id}")
        audit_logger.info(
            "WebSocket connection established",
            extra={
                "event_type": "websocket_connected",
                "user_id": self.user_id,
                "document_id": document_id,
                "client_count": len(self.__class__.clients[document_id])
            }
        )
    
    async def on_message(self, message):
        """Handle incoming WebSocket messages."""
        if not self.authenticated:
            return
        
        try:
            # Parse message
            if isinstance(message, bytes):
                # Handle binary Yjs update messages
                await self.handle_yjs_update(message)
            else:
                # Handle JSON messages
                try:
                    data = json_decode(message)
                    await self.handle_json_message(data)
                except (json.JSONDecodeError, ValueError) as e:
                    collab_logger.error(f"Invalid JSON message from {self.user_id}: {e}")
                    await self.send_error("Invalid message format")
        
        except Exception as e:
            collab_logger.error(f"Error handling message from {self.user_id}: {e}")
            await self.send_error("Message processing failed")
    
    async def handle_yjs_update(self, update_data: bytes):
        """Handle binary Yjs CRDT update."""
        if not self.permissions.check_permission(self.document_id, self.user_id, "modify_content"):
            audit_logger.warning(
                "Yjs update rejected - insufficient permissions",
                extra={
                    "event_type": "yjs_update_rejected",
                    "user_id": self.user_id,
                    "document_id": self.document_id
                }
            )
            return
        
        # Check rate limiting for updates
        if not self.__class__._ws_rate_limiter.is_allowed(f"{self.user_id}_update"):
            return
        
        # Broadcast update to other clients
        await self.broadcast_to_document({
            "type": "yjs_update",
            "user_id": self.user_id,
            "document_id": self.document_id,
            "update": update_data.hex(),  # Convert to hex for JSON transport
            "timestamp": time.time()
        }, exclude_self=True)
        
        # Log CRDT update for audit
        if self.extensionapp.collaboration_audit_enabled:
            audit_logger.info(
                "CRDT update applied",
                extra={
                    "event_type": "crdt_update",
                    "user_id": self.user_id,
                    "document_id": self.document_id,
                    "update_size": len(update_data)
                }
            )
    
    async def handle_json_message(self, data: Dict[str, Any]):
        """Handle JSON WebSocket messages."""
        message_type = data.get("type")
        
        if message_type == "awareness_update":
            await self.handle_awareness_update(data)
        elif message_type == "lock_request":
            await self.handle_lock_request(data)
        elif message_type == "unlock_request":
            await self.handle_unlock_request(data)
        elif message_type == "comment_event":
            await self.handle_comment_event(data)
        elif message_type == "cursor_position":
            await self.handle_cursor_position(data)
        else:
            collab_logger.warning(f"Unknown message type from {self.user_id}: {message_type}")
    
    async def handle_awareness_update(self, data: Dict[str, Any]):
        """Handle user awareness/presence updates."""
        # Broadcast awareness to other clients in the document
        await self.broadcast_to_document({
            "type": "awareness_update",
            "user_id": self.user_id,
            "document_id": self.document_id,
            "awareness_state": data.get("state", {}),
            "timestamp": time.time()
        }, exclude_self=True)
    
    async def handle_cursor_position(self, data: Dict[str, Any]):
        """Handle cursor position updates."""
        # Broadcast cursor position to other clients
        await self.broadcast_to_document({
            "type": "cursor_position",
            "user_id": self.user_id,
            "document_id": self.document_id,
            "position": data.get("position", {}),
            "timestamp": time.time()
        }, exclude_self=True)
    
    async def handle_lock_request(self, data: Dict[str, Any]):
        """Handle cell lock requests."""
        cell_id = data.get("cell_id")
        if not cell_id:
            await self.send_error("Missing cell_id for lock request")
            return
        
        # Check lock permission
        if not self.permissions.check_permission(self.document_id, self.user_id, "acquire_lock", cell_id):
            await self.send_message({
                "type": "lock_response",
                "success": False,
                "error": "Insufficient permissions for locking",
                "cell_id": cell_id
            })
            return
        
        # Attempt to acquire lock
        success = self.locks.acquire_lock(self.document_id, cell_id, self.user_id)
        
        # Send response to requester
        await self.send_message({
            "type": "lock_response",
            "success": success,
            "cell_id": cell_id,
            "timestamp": time.time()
        })
        
        if success:
            # Broadcast lock acquisition to other clients
            await self.broadcast_to_document({
                "type": "cell_locked",
                "user_id": self.user_id,
                "document_id": self.document_id,
                "cell_id": cell_id,
                "timestamp": time.time()
            }, exclude_self=True)
    
    async def handle_unlock_request(self, data: Dict[str, Any]):
        """Handle cell unlock requests."""
        cell_id = data.get("cell_id")
        force = data.get("force", False)
        
        if not cell_id:
            await self.send_error("Missing cell_id for unlock request")
            return
        
        # Check if user can force unlock (admin only)
        if force and not self.permissions.check_permission(self.document_id, self.user_id, "force_unlock_any"):
            await self.send_message({
                "type": "unlock_response",
                "success": False,
                "error": "Insufficient permissions for force unlock",
                "cell_id": cell_id
            })
            return
        
        # Attempt to release lock
        success = self.locks.release_lock(self.document_id, cell_id, self.user_id, force=force)
        
        # Send response to requester
        await self.send_message({
            "type": "unlock_response",
            "success": success,
            "cell_id": cell_id,
            "forced": force,
            "timestamp": time.time()
        })
        
        if success:
            # Broadcast unlock to other clients
            await self.broadcast_to_document({
                "type": "cell_unlocked",
                "user_id": self.user_id,
                "document_id": self.document_id,
                "cell_id": cell_id,
                "forced": force,
                "timestamp": time.time()
            }, exclude_self=True)
    
    async def handle_comment_event(self, data: Dict[str, Any]):
        """Handle comment-related events."""
        comment_action = data.get("action")
        
        if comment_action == "created":
            # Broadcast new comment to other clients
            await self.broadcast_to_document({
                "type": "comment_created",
                "user_id": self.user_id,
                "document_id": self.document_id,
                "comment_data": data.get("comment", {}),
                "timestamp": time.time()
            }, exclude_self=True)
        
        elif comment_action == "resolved":
            # Broadcast comment resolution
            await self.broadcast_to_document({
                "type": "comment_resolved",
                "user_id": self.user_id,
                "document_id": self.document_id,
                "thread_id": data.get("thread_id"),
                "resolved": data.get("resolved", True),
                "timestamp": time.time()
            }, exclude_self=True)
    
    async def send_message(self, message: Dict[str, Any]):
        """Send message to this WebSocket client."""
        try:
            await self.write_message(json_encode(message))
        except websocket.WebSocketClosedError:
            collab_logger.debug(f"Attempted to send to closed WebSocket: {self.user_id}")
    
    async def send_error(self, error_message: str):
        """Send error message to client."""
        await self.send_message({
            "type": "error",
            "message": error_message,
            "timestamp": time.time()
        })
    
    async def broadcast_to_document(self, message: Dict[str, Any], exclude_self: bool = False):
        """Broadcast message to all clients connected to the same document."""
        if not self.document_id:
            return
        
        clients = self.__class__.clients.get(self.document_id, set())
        
        for client in clients.copy():  # Copy to avoid modification during iteration
            if exclude_self and client == self:
                continue
            
            try:
                await client.write_message(json_encode(message))
            except websocket.WebSocketClosedError:
                # Clean up closed connection
                clients.discard(client)
                if client in self.__class__.client_info:
                    del self.__class__.client_info[client]
    
    def on_close(self):
        """Handle WebSocket connection close."""
        if not self.authenticated:
            return
        
        # Remove from clients
        if self.document_id and self in self.__class__.clients[self.document_id]:
            self.__class__.clients[self.document_id].discard(self)
            
            # Clean up empty document client sets
            if not self.__class__.clients[self.document_id]:
                del self.__class__.clients[self.document_id]
        
        # Remove client info
        if self in self.__class__.client_info:
            del self.__class__.client_info[self]
        
        # Release any locks held by this user
        if hasattr(self, 'user_id') and hasattr(self, 'document_id'):
            # Find and release all locks for this user in this document
            locks_to_release = []
            for (doc_id, cell_id), lock_info in self.locks.locks.items():
                if doc_id == self.document_id and lock_info["user_id"] == self.user_id:
                    locks_to_release.append((doc_id, cell_id))
            
            for doc_id, cell_id in locks_to_release:
                self.locks.release_lock(doc_id, cell_id, self.user_id, force=True)
            
            # Broadcast user left to remaining clients
            IOLoop.current().add_callback(
                self.broadcast_to_document,
                {
                    "type": "user_presence",
                    "action": "left",
                    "user_id": self.user_id,
                    "document_id": self.document_id,
                    "timestamp": time.time()
                },
                exclude_self=True
            )
        
        collab_logger.info(f"WebSocket connection closed: {getattr(self, 'user_id', 'unknown')}")
        
        if hasattr(self, 'user_id') and hasattr(self, 'document_id'):
            audit_logger.info(
                "WebSocket connection closed",
                extra={
                    "event_type": "websocket_disconnected",
                    "user_id": self.user_id,
                    "document_id": self.document_id,
                    "remaining_clients": len(self.__class__.clients.get(self.document_id, set()))
                }
            )


class CollaborationSessionsHandler(BaseCollaborationHandler):
    """REST API handler for managing collaboration sessions."""
    
    @web.authenticated
    @authorized
    async def get(self, session_id: str = None):
        """Get collaboration session(s) information."""
        user_id = self.get_current_user_id()
        
        if session_id:
            # Get specific session info
            session_info = self._get_session_info(session_id, user_id)
            if not session_info:
                raise web.HTTPError(404, "Session not found")
            
            self.write({"session": session_info})
        else:
            # List all accessible sessions for user
            sessions = self._get_user_sessions(user_id)
            self.write({"sessions": sessions})
    
    @web.authenticated
    @authorized
    async def post(self, session_id: str = None):
        """Create new collaboration session."""
        try:
            body = json_decode(self.request.body) if self.request.body else {}
        except (json.JSONDecodeError, ValueError):
            raise web.HTTPError(400, "Invalid JSON body")
        
        notebook_path = body.get("notebook_path")
        if not notebook_path:
            raise web.HTTPError(400, "Missing notebook_path")
        
        user_id = self.get_current_user_id()
        
        # Create new session
        session_info = await self._create_session(notebook_path, user_id, body)
        
        audit_logger.info(
            "Collaboration session created",
            extra={
                "event_type": "session_created",
                "user_id": user_id,
                "notebook_path": notebook_path,
                "session_id": session_info["id"]
            }
        )
        
        self.write({"session": session_info})
    
    @web.authenticated
    @authorized
    async def delete(self, session_id: str):
        """End collaboration session."""
        if not session_id:
            raise web.HTTPError(400, "Missing session_id")
        
        user_id = self.get_current_user_id()
        
        # Check if user can delete this session
        session_info = self._get_session_info(session_id, user_id)
        if not session_info:
            raise web.HTTPError(404, "Session not found")
        
        if not self._can_manage_session(session_id, user_id):
            raise web.HTTPError(403, "Insufficient permissions to delete session")
        
        # End session
        await self._end_session(session_id, user_id)
        
        audit_logger.info(
            "Collaboration session ended",
            extra={
                "event_type": "session_ended",
                "user_id": user_id,
                "session_id": session_id
            }
        )
        
        self.write({"message": "Session ended successfully"})
    
    def _get_session_info(self, session_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Get session information if user has access."""
        # This would integrate with actual session storage
        # For now, return mock data based on active WebSocket connections
        
        for doc_id, clients in CollaborationWebSocketHandler.clients.items():
            if doc_id == session_id:  # Assuming session_id == document_id for simplicity
                client_users = []
                for client in clients:
                    if client in CollaborationWebSocketHandler.client_info:
                        info = CollaborationWebSocketHandler.client_info[client]
                        client_users.append({
                            "user_id": info["user_id"],
                            "connected_at": info["connected_at"],
                            "client_id": info["client_id"]
                        })
                
                return {
                    "id": session_id,
                    "document_id": doc_id,
                    "active_users": client_users,
                    "created_at": min(c["connected_at"] for c in client_users) if client_users else time.time(),
                    "user_count": len(client_users)
                }
        
        return None
    
    def _get_user_sessions(self, user_id: str) -> List[Dict[str, Any]]:
        """Get all sessions accessible to user."""
        sessions = []
        
        for doc_id, clients in CollaborationWebSocketHandler.clients.items():
            # Check if user has any connection to this document
            user_in_session = any(
                CollaborationWebSocketHandler.client_info.get(client, {}).get("user_id") == user_id
                for client in clients
            )
            
            # Or check if user has permissions
            if user_in_session or self.permissions.check_permission(doc_id, user_id, "read_content"):
                session_info = self._get_session_info(doc_id, user_id)
                if session_info:
                    sessions.append(session_info)
        
        return sessions
    
    async def _create_session(self, notebook_path: str, user_id: str, 
                            options: Dict[str, Any]) -> Dict[str, Any]:
        """Create new collaboration session."""
        session_id = f"session_{int(time.time())}_{user_id}"
        document_id = notebook_path.replace("/", "_").replace(".", "_")
        
        # Set user as admin for notebooks they create sessions for
        self.permissions.set_notebook_permission(document_id, user_id, CollaborationRole.ADMIN)
        
        return {
            "id": session_id,
            "document_id": document_id,
            "notebook_path": notebook_path,
            "created_by": user_id,
            "created_at": time.time(),
            "status": "active",
            "options": options
        }
    
    def _can_manage_session(self, session_id: str, user_id: str) -> bool:
        """Check if user can manage (delete) session."""
        # Users with admin role can manage sessions
        return self.permissions.check_permission(session_id, user_id, "manage_permissions")
    
    async def _end_session(self, session_id: str, user_id: str):
        """End collaboration session and clean up."""
        # Close all WebSocket connections for this session
        if session_id in CollaborationWebSocketHandler.clients:
            clients = CollaborationWebSocketHandler.clients[session_id].copy()
            for client in clients:
                client.close(code=1000, reason="Session ended by administrator")
            
            # Clean up
            del CollaborationWebSocketHandler.clients[session_id]


class CollaborationPermissionsHandler(BaseCollaborationHandler):
    """REST API handler for managing collaboration permissions."""
    
    @web.authenticated
    @authorized
    async def get(self, notebook_id: str = None, cell_id: str = None):
        """Get permission information."""
        user_id = self.get_current_user_id()
        
        if notebook_id and cell_id:
            # Get cell-specific permissions
            self.require_collaboration_permission(notebook_id, "read_content", cell_id)
            
            permissions_data = {
                "notebook_id": notebook_id,
                "cell_id": cell_id,
                "user_role": self.permissions.get_user_role(notebook_id, user_id, cell_id),
                "capabilities": list(CollaborationRole.get_effective_capabilities(
                    self.permissions.get_user_role(notebook_id, user_id, cell_id)
                ))
            }
            
        elif notebook_id:
            # Get notebook-level permissions
            self.require_collaboration_permission(notebook_id, "read_content")
            
            permissions_data = {
                "notebook_id": notebook_id,
                "user_role": self.permissions.get_user_role(notebook_id, user_id),
                "capabilities": list(CollaborationRole.get_effective_capabilities(
                    self.permissions.get_user_role(notebook_id, user_id)
                )),
                "all_users": self.permissions.notebook_permissions.get(notebook_id, {})
            }
            
        else:
            # Get user's general permissions across all notebooks
            user_notebooks = {}
            for notebook, users in self.permissions.notebook_permissions.items():
                if user_id in users:
                    user_notebooks[notebook] = {
                        "role": users[user_id],
                        "capabilities": list(CollaborationRole.get_effective_capabilities(users[user_id]))
                    }
            
            permissions_data = {
                "user_id": user_id,
                "notebooks": user_notebooks
            }
        
        self.write({"permissions": permissions_data})
    
    @web.authenticated
    @authorized
    async def post(self, notebook_id: str = None, cell_id: str = None):
        """Modify permissions."""
        if not notebook_id:
            raise web.HTTPError(400, "Missing notebook_id")
        
        try:
            body = json_decode(self.request.body) if self.request.body else {}
        except (json.JSONDecodeError, ValueError):
            raise web.HTTPError(400, "Invalid JSON body")
        
        current_user_id = self.get_current_user_id()
        
        # Check if current user can manage permissions
        self.require_collaboration_permission(notebook_id, "manage_permissions")
        
        target_user_id = body.get("user_id")
        new_role = body.get("role")
        
        if not target_user_id or not new_role:
            raise web.HTTPError(400, "Missing user_id or role")
        
        if new_role not in CollaborationRole.ROLE_HIERARCHY:
            raise web.HTTPError(400, f"Invalid role: {new_role}")
        
        # Apply permission change
        if cell_id:
            self.permissions.set_cell_permission(notebook_id, cell_id, target_user_id, new_role)
            level = "cell"
        else:
            self.permissions.set_notebook_permission(notebook_id, target_user_id, new_role)
            level = "notebook"
        
        audit_logger.info(
            "Permissions modified",
            extra={
                "event_type": "permissions_modified",
                "modifier_user_id": current_user_id,
                "target_user_id": target_user_id,
                "notebook_id": notebook_id,
                "cell_id": cell_id,
                "new_role": new_role,
                "level": level
            }
        )
        
        self.write({
            "message": "Permissions updated successfully",
            "user_id": target_user_id,
            "notebook_id": notebook_id,
            "cell_id": cell_id,
            "new_role": new_role,
            "level": level
        })


class CollaborationCommentsHandler(BaseCollaborationHandler):
    """REST API handler for managing collaboration comments."""
    
    @web.authenticated
    @authorized
    async def get(self, notebook_id: str, thread_id: str = None):
        """Get comments for notebook or specific thread."""
        self.require_collaboration_permission(notebook_id, "view_comments")
        
        # Parse query parameters
        cell_id = self.get_argument("cell_id", None)
        resolved = self.get_argument("resolved", None)
        
        # Get comments with filtering
        comments = self.comments.get_comments(notebook_id, cell_id, thread_id)
        
        # Filter by resolution status if specified
        if resolved is not None:
            resolved_bool = resolved.lower() in ('true', '1', 'yes')
            comments = [c for c in comments if c["resolved"] == resolved_bool]
        
        # Group by threads if not getting specific thread
        if not thread_id:
            threads = defaultdict(list)
            for comment in comments:
                threads[comment["thread_id"]].append(comment)
            
            response_data = {
                "notebook_id": notebook_id,
                "threads": dict(threads),
                "total_comments": len(comments)
            }
        else:
            response_data = {
                "notebook_id": notebook_id,
                "thread_id": thread_id,
                "comments": comments
            }
        
        self.write(response_data)
    
    @web.authenticated
    @authorized  
    async def post(self, notebook_id: str, thread_id: str = None):
        """Create new comment or reply to thread."""
        self.require_collaboration_permission(notebook_id, "create_comment")
        self.check_rate_limit(self.__class__._comment_rate_limiter)
        
        try:
            body = json_decode(self.request.body) if self.request.body else {}
        except (json.JSONDecodeError, ValueError):
            raise web.HTTPError(400, "Invalid JSON body")
        
        content = body.get("content", "").strip()
        if not content:
            raise web.HTTPError(400, "Comment content cannot be empty")
        
        user_id = self.get_current_user_id()
        cell_id = body.get("cell_id")
        metadata = body.get("metadata", {})
        
        # Create comment or reply
        comment_id = self.comments.create_comment(
            notebook_id=notebook_id,
            user_id=user_id,
            content=content,
            cell_id=cell_id,
            thread_id=thread_id,
            metadata=metadata
        )
        
        # Get the created comment for response
        all_comments = self.comments.get_comments(notebook_id)
        created_comment = next((c for c in all_comments if c["id"] == comment_id), None)
        
        self.write({
            "message": "Comment created successfully",
            "comment": created_comment
        })
    
    @web.authenticated
    @authorized
    async def put(self, notebook_id: str, thread_id: str):
        """Update thread status (resolve/unresolve) or comment content."""
        path_parts = self.request.path.split('/')
        
        if path_parts[-1] == "status":
            # Update thread resolution status
            await self._update_thread_status(notebook_id, thread_id)
        elif "replies" in path_parts:
            # This is a reply to thread - handle via POST
            await self.post(notebook_id, thread_id)
        else:
            # Update comment content
            await self._update_comment_content(notebook_id, thread_id)
    
    async def _update_thread_status(self, notebook_id: str, thread_id: str):
        """Update thread resolution status."""
        self.require_collaboration_permission(notebook_id, "resolve_own_comment")
        
        try:
            body = json_decode(self.request.body) if self.request.body else {}
        except (json.JSONDecodeError, ValueError):
            raise web.HTTPError(400, "Invalid JSON body")
        
        resolved = body.get("resolved", True)
        user_id = self.get_current_user_id()
        
        success = self.comments.resolve_thread(notebook_id, thread_id, user_id, resolved)
        
        if not success:
            raise web.HTTPError(404, "Thread not found")
        
        self.write({
            "message": f"Thread {'resolved' if resolved else 'reopened'} successfully",
            "thread_id": thread_id,
            "resolved": resolved
        })
    
    async def _update_comment_content(self, notebook_id: str, comment_id: str):
        """Update comment content."""
        self.require_collaboration_permission(notebook_id, "view_comments")
        
        try:
            body = json_decode(self.request.body) if self.request.body else {}
        except (json.JSONDecodeError, ValueError):
            raise web.HTTPError(400, "Invalid JSON body")
        
        content = body.get("content", "").strip()
        if not content:
            raise web.HTTPError(400, "Comment content cannot be empty")
        
        user_id = self.get_current_user_id()
        
        success = self.comments.update_comment(notebook_id, comment_id, user_id, content)
        
        if not success:
            raise web.HTTPError(403, "Cannot update comment - not the author or comment not found")
        
        self.write({
            "message": "Comment updated successfully",
            "comment_id": comment_id
        })
    
    @web.authenticated
    @authorized
    async def delete(self, notebook_id: str, comment_id: str):
        """Delete comment."""
        user_id = self.get_current_user_id()
        is_admin = self.check_collaboration_permission(notebook_id, "manage_comments")
        
        # Must be comment author or admin
        if not is_admin:
            self.require_collaboration_permission(notebook_id, "create_comment")  # Basic permission check
        
        success = self.comments.delete_comment(notebook_id, comment_id, user_id, is_admin)
        
        if not success:
            raise web.HTTPError(403, "Cannot delete comment - not authorized or comment not found")
        
        self.write({
            "message": "Comment deleted successfully",
            "comment_id": comment_id
        })


class CollaborationHistoryHandler(BaseCollaborationHandler):
    """REST API handler for collaboration history and versioning."""
    
    @web.authenticated
    @authorized
    async def get(self, notebook_id: str = None):
        """Get collaboration history."""
        if notebook_id:
            self.require_collaboration_permission(notebook_id, "read_content")
            history = await self._get_notebook_history(notebook_id)
        else:
            # Get user's accessible history across notebooks
            history = await self._get_user_history()
        
        self.write({"history": history})
    
    async def _get_notebook_history(self, notebook_id: str) -> List[Dict[str, Any]]:
        """Get history for specific notebook."""
        # This would integrate with actual version storage
        # For now, return mock data based on audit logs and activity
        
        # Get recent audit events for this notebook
        mock_history = [
            {
                "id": f"hist_{int(time.time())}_1",
                "notebook_id": notebook_id,
                "event_type": "document_updated",
                "user_id": "user_1",
                "timestamp": time.time() - 3600,
                "description": "Cell content modified",
                "changes_summary": {
                    "cells_modified": 1,
                    "lines_added": 5,
                    "lines_removed": 2
                }
            },
            {
                "id": f"hist_{int(time.time())}_2", 
                "notebook_id": notebook_id,
                "event_type": "comment_added",
                "user_id": "user_2",
                "timestamp": time.time() - 1800,
                "description": "Comment added to cell",
                "changes_summary": {
                    "comments_added": 1
                }
            }
        ]
        
        return mock_history
    
    async def _get_user_history(self) -> List[Dict[str, Any]]:
        """Get history for user across all accessible notebooks."""
        user_id = self.get_current_user_id()
        
        # Get notebooks user has access to
        accessible_notebooks = []
        for notebook_id in self.permissions.notebook_permissions:
            if self.permissions.check_permission(notebook_id, user_id, "read_content"):
                accessible_notebooks.append(notebook_id)
        
        # Collect history from accessible notebooks
        all_history = []
        for notebook_id in accessible_notebooks:
            notebook_history = await self._get_notebook_history(notebook_id)
            all_history.extend(notebook_history)
        
        # Sort by timestamp descending
        all_history.sort(key=lambda x: x["timestamp"], reverse=True)
        
        return all_history


class CollaborationHealthHandler(BaseCollaborationHandler):
    """Health check endpoint for collaboration services."""
    
    async def get(self):
        """Get collaboration service health status."""
        health_data = {
            "status": "healthy",
            "timestamp": time.time(),
            "version": __version__,
            "collaboration_enabled": self.collaboration_enabled,
            "statistics": {
                "active_documents": len(CollaborationWebSocketHandler.clients),
                "total_connections": sum(len(clients) for clients in CollaborationWebSocketHandler.clients.values()),
                "active_locks": len(self.locks.locks),
                "total_comments": sum(len(comments) for comments in self.comments.comments.values())
            }
        }
        
        # Add detailed status if requested
        if self.get_argument("detailed", "false").lower() == "true":
            health_data["details"] = {
                "documents": {
                    doc_id: {
                        "client_count": len(clients),
                        "users": [
                            CollaborationWebSocketHandler.client_info.get(client, {}).get("user_id", "unknown")
                            for client in clients
                        ]
                    }
                    for doc_id, clients in CollaborationWebSocketHandler.clients.items()
                },
                "rate_limiters": {
                    "ws_connections": len(self.__class__._ws_rate_limiter.requests),
                    "comment_requests": len(self.__class__._comment_rate_limiter.requests)
                }
            }
        
        # Check for any issues
        issues = []
        
        # Check for stale locks
        self.locks.cleanup_expired_locks()
        
        # Check WebSocket connection health
        total_connections = sum(len(clients) for clients in CollaborationWebSocketHandler.clients.values())
        max_connections = self.extensionapp.collaboration_max_users * len(CollaborationWebSocketHandler.clients)
        
        if total_connections > max_connections * 0.8:
            issues.append("High connection usage")
        
        if issues:
            health_data["status"] = "warning"
            health_data["issues"] = issues
        
        self.write(health_data)


# Background task for cleanup
def cleanup_collaboration_state():
    """Periodic cleanup of collaboration state."""
    try:
        # Clean up expired locks
        if hasattr(BaseCollaborationHandler, '_shared_locks'):
            BaseCollaborationHandler._shared_locks.cleanup_expired_locks()
        
        # Clean up closed WebSocket connections
        for doc_id, clients in list(CollaborationWebSocketHandler.clients.items()):
            active_clients = set()
            for client in clients:
                try:
                    if hasattr(client, 'ws_connection') and client.ws_connection:
                        active_clients.add(client)
                    else:
                        # Remove from client_info if it exists
                        if client in CollaborationWebSocketHandler.client_info:
                            del CollaborationWebSocketHandler.client_info[client]
                except Exception:
                    pass
            
            if active_clients:
                CollaborationWebSocketHandler.clients[doc_id] = active_clients
            else:
                del CollaborationWebSocketHandler.clients[doc_id]
        
        collab_logger.debug("Collaboration state cleanup completed")
        
    except Exception as e:
        collab_logger.error(f"Error during collaboration cleanup: {e}")


# Schedule periodic cleanup
def start_cleanup_scheduler():
    """Start periodic cleanup scheduler."""
    def schedule_cleanup():
        cleanup_collaboration_state()
        # Schedule next cleanup in 5 minutes
        IOLoop.current().call_later(300, schedule_cleanup)
    
    # Start first cleanup in 60 seconds
    IOLoop.current().call_later(60, schedule_cleanup)


# Initialize cleanup scheduler when module is imported
IOLoop.current().add_callback(start_cleanup_scheduler)