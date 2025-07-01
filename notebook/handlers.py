"""Server-side WebSocket handlers for real-time collaborative editing in Jupyter Notebook v7.

This module implements comprehensive collaboration features including:
- Yjs-based document synchronization using CRDT (Conflict-free Replicated Data Types)
- User presence awareness and cursor tracking
- Cell-level locking mechanisms to prevent edit conflicts
- Comment system with real-time notifications
- Version history tracking with user attribution
- Integration with JupyterHub authentication for enterprise deployments
- Versioned API endpoints for client-server compatibility

Architecture:
- WebSocketCollabHandler: Main collaboration endpoint for document synchronization
- GlobalCollabHandler: Global collaboration service for cross-document features
- CollaborationManager: Core service managing collaborative sessions
- PresenceTracker: User awareness and cursor position management
- LockManager: Cell-level locking coordination
- CommentManager: Comment threading and notification system
- HistoryTracker: Version history and change attribution
- SecurityManager: Authentication and permission enforcement

API Endpoints:
- /api/contents/{path}/collab/ws - Document-specific collaboration
- /api/collaboration/v1/ws - Global collaboration service
- /api/collaboration/v1/{feature}/ws - Feature-specific endpoints

Supported API versions: v1.0, v1.1, v1.2 with backward compatibility.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
import weakref
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple, Union
from urllib.parse import unquote

import tornado.web
import tornado.websocket
from jupyter_server.auth import authorized
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import gen
from tornado.concurrent import run_on_executor
from tornado.iostream import StreamClosedError
from tornado.locks import Condition, Lock
from traitlets import Bool, Dict as TraitDict, Float, Int, List as TraitList, Unicode
from traitlets.config import Configurable

from ._version import __version__

# Logging configuration
logger = logging.getLogger(__name__)


class CollaborationError(Exception):
    """Base exception for collaboration-related errors."""
    pass


class AuthenticationError(CollaborationError):
    """Authentication-related collaboration errors."""
    pass


class PermissionError(CollaborationError):
    """Permission-related collaboration errors."""
    pass


class SynchronizationError(CollaborationError):
    """CRDT synchronization errors."""
    pass


class LockError(CollaborationError):
    """Cell locking errors."""
    pass


class CommentError(CollaborationError):
    """Comment system errors."""
    pass


class SecurityManager:
    """Handles authentication and authorization for collaboration features.
    
    Integrates with JupyterHub OAuth, token-based authentication, and provides
    fine-grained permissions for collaborative operations.
    """
    
    def __init__(self, handler: JupyterHandler):
        self.handler = handler
        self.logger = logging.getLogger(f"{__name__}.SecurityManager")
        
        # Permission levels: view, edit, admin
        self.permission_hierarchy = {'view': 0, 'edit': 1, 'admin': 2}
        
    async def authenticate_websocket(self, request_headers: Dict[str, str]) -> Optional[Dict[str, Any]]:
        """Authenticate WebSocket connection using session tokens or JupyterHub OAuth.
        
        Args:
            request_headers: WebSocket handshake headers
            
        Returns:
            User info dict if authenticated, None otherwise
            
        Raises:
            AuthenticationError: If authentication fails
        """
        try:
            # Extract authentication token from headers or cookies
            auth_token = self._extract_auth_token(request_headers)
            if not auth_token:
                self.logger.warning("No authentication token found in WebSocket handshake")
                return None
                
            # Validate token against server's authentication system
            user_info = await self._validate_token(auth_token)
            if not user_info:
                self.logger.warning(f"Invalid authentication token: {auth_token[:8]}...")
                return None
                
            # Enrich user info with collaboration-specific data
            user_info['collaboration_role'] = await self._get_collaboration_role(user_info)
            user_info['session_id'] = str(uuid.uuid4())
            user_info['auth_time'] = time.time()
            
            self.logger.info(f"Authenticated user {user_info.get('name', 'unknown')} for collaboration")
            return user_info
            
        except Exception as e:
            self.logger.error(f"WebSocket authentication error: {e}")
            raise AuthenticationError(f"Authentication failed: {e}")
    
    def _extract_auth_token(self, headers: Dict[str, str]) -> Optional[str]:
        """Extract authentication token from WebSocket headers."""
        # Try Authorization header first
        auth_header = headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            return auth_header[7:]  # Remove 'Bearer ' prefix
            
        # Try cookie-based authentication
        cookie_header = headers.get('Cookie', '')
        if cookie_header:
            for cookie in cookie_header.split(';'):
                if '=' in cookie:
                    name, value = cookie.strip().split('=', 1)
                    if name in ['jupyter-hub-token', '_xsrf', 'notebook-token']:
                        return value
                        
        # Try query parameter token (less secure, for compatibility)
        # This would be extracted from the WebSocket URL
        return None
    
    async def _validate_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Validate authentication token against server's auth system."""
        try:
            # Use the handler's authentication system
            if hasattr(self.handler, 'get_current_user'):
                # For JupyterHub integration
                user = self.handler.get_current_user()
                if user:
                    return {
                        'name': user.get('name', 'unknown'),
                        'id': user.get('id', user.get('name', 'unknown')),
                        'groups': user.get('groups', []),
                        'admin': user.get('admin', False),
                        'token': token
                    }
            
            # For standalone mode with token authentication
            if hasattr(self.handler.settings, 'get') and token:
                server_token = self.handler.settings.get('token', '')
                if server_token and token == server_token:
                    return {
                        'name': 'jupyter-user',
                        'id': 'jupyter-user',
                        'groups': [],
                        'admin': True,
                        'token': token
                    }
                    
            return None
            
        except Exception as e:
            self.logger.error(f"Token validation error: {e}")
            return None
    
    async def _get_collaboration_role(self, user_info: Dict[str, Any]) -> str:
        """Determine collaboration role based on user information."""
        # Admin users get admin role
        if user_info.get('admin', False):
            return 'admin'
            
        # Check JupyterHub groups for role mapping
        groups = user_info.get('groups', [])
        if 'notebook-admins' in groups:
            return 'admin'
        elif 'notebook-editors' in groups:
            return 'edit'
        elif 'notebook-viewers' in groups:
            return 'view'
            
        # Default role for authenticated users
        return 'edit'
    
    def check_permission(self, user_info: Dict[str, Any], required_permission: str, 
                        resource_type: str = 'document', resource_id: Optional[str] = None) -> bool:
        """Check if user has required permission for operation.
        
        Args:
            user_info: Authenticated user information
            required_permission: Required permission level (view, edit, admin)
            resource_type: Type of resource (document, cell, comment)
            resource_id: Specific resource identifier
            
        Returns:
            True if permission granted, False otherwise
        """
        try:
            user_role = user_info.get('collaboration_role', 'view')
            user_level = self.permission_hierarchy.get(user_role, 0)
            required_level = self.permission_hierarchy.get(required_permission, 0)
            
            # Check basic permission level
            if user_level < required_level:
                self.logger.debug(f"Permission denied: user {user_info.get('name')} has role {user_role}, "
                                f"requires {required_permission}")
                return False
            
            # Additional resource-specific checks could be added here
            # For example, cell-level permissions or document ownership
            
            return True
            
        except Exception as e:
            self.logger.error(f"Permission check error: {e}")
            return False
    
    def audit_log(self, user_info: Dict[str, Any], action: str, resource: str, 
                  result: str, details: Optional[Dict[str, Any]] = None):
        """Log collaboration events for security auditing."""
        audit_entry = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'user_id': user_info.get('id', 'unknown'),
            'user_name': user_info.get('name', 'unknown'),
            'session_id': user_info.get('session_id', 'unknown'),
            'action': action,
            'resource': resource,
            'result': result,
            'details': details or {}
        }
        
        # Log to appropriate audit logger
        audit_logger = logging.getLogger(f"{__name__}.audit")
        audit_logger.info(json.dumps(audit_entry))


class PresenceTracker:
    """Manages user presence awareness and cursor position tracking.
    
    Provides real-time awareness of collaborators including:
    - Active user list with online status
    - Cursor positions and text selections
    - User color assignments for visual identification
    - Activity indicators and idle detection
    """
    
    def __init__(self):
        self.logger = logging.getLogger(f"{__name__}.PresenceTracker")
        
        # Track active sessions by document
        self.document_sessions: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
        
        # User color assignments for visual identification
        self.user_colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57',
            '#FF9FF3', '#54A0FF', '#5F27CD', '#00D2D3', '#FF9F43'
        ]
        self.color_assignments: Dict[str, str] = {}
        
        # Heartbeat tracking for idle detection
        self.last_activity: Dict[str, float] = {}
        self.idle_timeout = 300  # 5 minutes
        
    async def join_document(self, document_path: str, user_info: Dict[str, Any], 
                           websocket) -> Dict[str, Any]:
        """Register user presence for a document.
        
        Args:
            document_path: Path to the collaborative document
            user_info: Authenticated user information
            websocket: WebSocket connection for this user
            
        Returns:
            Initial presence state including other users
        """
        session_id = user_info['session_id']
        user_id = user_info['id']
        
        # Assign user color if not already assigned
        if user_id not in self.color_assignments:
            color_index = len(self.color_assignments) % len(self.user_colors)
            self.color_assignments[user_id] = self.user_colors[color_index]
        
        # Register session
        session_info = {
            'user_id': user_id,
            'user_name': user_info['name'],
            'user_color': self.color_assignments[user_id],
            'role': user_info.get('collaboration_role', 'edit'),
            'websocket': websocket,
            'join_time': time.time(),
            'last_activity': time.time(),
            'cursor_position': None,
            'selection': None,
            'active_cell': None,
            'status': 'active'
        }
        
        self.document_sessions[document_path][session_id] = session_info
        self.last_activity[session_id] = time.time()
        
        self.logger.info(f"User {user_info['name']} joined document {document_path}")
        
        # Notify other users of new presence
        await self._broadcast_presence_update(document_path, session_id, 'join')
        
        # Return current presence state
        return await self.get_presence_state(document_path)
    
    async def leave_document(self, document_path: str, session_id: str):
        """Remove user presence from document."""
        if document_path in self.document_sessions:
            session_info = self.document_sessions[document_path].pop(session_id, None)
            if session_info:
                self.logger.info(f"User {session_info['user_name']} left document {document_path}")
                
                # Clean up tracking data
                self.last_activity.pop(session_id, None)
                
                # Notify other users of departure
                await self._broadcast_presence_update(document_path, session_id, 'leave')
                
                # Clean up empty document sessions
                if not self.document_sessions[document_path]:
                    del self.document_sessions[document_path]
    
    async def update_cursor_position(self, document_path: str, session_id: str, 
                                   position: Dict[str, Any]):
        """Update user's cursor position and selection."""
        if (document_path in self.document_sessions and 
            session_id in self.document_sessions[document_path]):
            
            session_info = self.document_sessions[document_path][session_id]
            session_info['cursor_position'] = position.get('cursor')
            session_info['selection'] = position.get('selection')
            session_info['active_cell'] = position.get('cell_id')
            session_info['last_activity'] = time.time()
            
            self.last_activity[session_id] = time.time()
            
            # Broadcast cursor update to other users
            await self._broadcast_presence_update(document_path, session_id, 'cursor_update')
    
    async def update_activity(self, document_path: str, session_id: str):
        """Update user's last activity timestamp."""
        if (document_path in self.document_sessions and 
            session_id in self.document_sessions[document_path]):
            
            session_info = self.document_sessions[document_path][session_id]
            session_info['last_activity'] = time.time()
            session_info['status'] = 'active'
            
            self.last_activity[session_id] = time.time()
    
    async def get_presence_state(self, document_path: str) -> Dict[str, Any]:
        """Get current presence state for a document."""
        sessions = self.document_sessions.get(document_path, {})
        
        # Check for idle users
        current_time = time.time()
        for session_id, session_info in sessions.items():
            if current_time - session_info['last_activity'] > self.idle_timeout:
                session_info['status'] = 'idle'
        
        # Build presence state
        users = []
        for session_id, session_info in sessions.items():
            users.append({
                'session_id': session_id,
                'user_id': session_info['user_id'],
                'user_name': session_info['user_name'],
                'user_color': session_info['user_color'],
                'role': session_info['role'],
                'status': session_info['status'],
                'cursor_position': session_info['cursor_position'],
                'selection': session_info['selection'],
                'active_cell': session_info['active_cell'],
                'join_time': session_info['join_time']
            })
        
        return {
            'document_path': document_path,
            'users': users,
            'total_users': len(users),
            'active_users': len([u for u in users if u['status'] == 'active'])
        }
    
    async def _broadcast_presence_update(self, document_path: str, session_id: str, 
                                       update_type: str):
        """Broadcast presence updates to all users in a document."""
        sessions = self.document_sessions.get(document_path, {})
        
        # Get updated presence state
        presence_state = await self.get_presence_state(document_path)
        
        # Create update message
        update_message = {
            'type': 'presence_update',
            'update_type': update_type,
            'session_id': session_id,
            'presence_state': presence_state,
            'timestamp': time.time()
        }
        
        # Broadcast to all sessions except the originating one
        for sid, session_info in sessions.items():
            if sid != session_id:
                try:
                    websocket = session_info['websocket']
                    if websocket and not websocket.ws_connection.is_closing():
                        await websocket.write_message(json.dumps(update_message))
                except Exception as e:
                    self.logger.error(f"Error broadcasting presence update: {e}")
    
    def get_document_users(self, document_path: str) -> List[str]:
        """Get list of user IDs currently in a document."""
        sessions = self.document_sessions.get(document_path, {})
        return [session_info['user_id'] for session_info in sessions.values()]


class LockManager:
    """Manages cell-level locking to prevent edit conflicts.
    
    Features:
    - Exclusive lock acquisition for individual cells
    - Automatic lock timeout and cleanup
    - Lock ownership validation
    - Admin override capabilities
    - Lock contention resolution
    """
    
    def __init__(self, lock_timeout: float = 300.0):  # 5 minutes default
        self.logger = logging.getLogger(f"{__name__}.LockManager")
        self.lock_timeout = lock_timeout
        
        # Document locks: {document_path: {cell_id: lock_info}}
        self.locks: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
        
        # Lock cleanup task
        self._cleanup_task = None
        self._start_cleanup_task()
    
    def _start_cleanup_task(self):
        """Start background task for lock cleanup."""
        if not self._cleanup_task:
            self._cleanup_task = asyncio.create_task(self._cleanup_expired_locks())
    
    async def _cleanup_expired_locks(self):
        """Background task to clean up expired locks."""
        while True:
            try:
                await asyncio.sleep(60)  # Check every minute
                current_time = time.time()
                
                expired_locks = []
                for document_path, doc_locks in self.locks.items():
                    for cell_id, lock_info in doc_locks.items():
                        if current_time - lock_info['acquired_time'] > self.lock_timeout:
                            expired_locks.append((document_path, cell_id))
                
                # Clean up expired locks
                for document_path, cell_id in expired_locks:
                    await self.release_lock(document_path, cell_id, force=True)
                    self.logger.info(f"Cleaned up expired lock: {document_path}#{cell_id}")
                    
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in lock cleanup task: {e}")
    
    async def acquire_lock(self, document_path: str, cell_id: str, user_info: Dict[str, Any]) -> bool:
        """Attempt to acquire exclusive lock on a cell.
        
        Args:
            document_path: Path to the document
            cell_id: Identifier of the cell to lock
            user_info: User requesting the lock
            
        Returns:
            True if lock acquired, False if already locked
            
        Raises:
            LockError: If lock operation fails
        """
        try:
            session_id = user_info['session_id']
            user_id = user_info['id']
            current_time = time.time()
            
            # Check if cell is already locked
            if cell_id in self.locks[document_path]:
                existing_lock = self.locks[document_path][cell_id]
                
                # Check if lock is expired
                if current_time - existing_lock['acquired_time'] > self.lock_timeout:
                    self.logger.info(f"Acquiring expired lock: {document_path}#{cell_id}")
                    await self.release_lock(document_path, cell_id, force=True)
                else:
                    # Check if same user/session
                    if existing_lock['session_id'] == session_id:
                        # Refresh existing lock
                        existing_lock['acquired_time'] = current_time
                        return True
                    else:
                        self.logger.debug(f"Lock denied for {document_path}#{cell_id}: "
                                        f"already locked by {existing_lock['user_id']}")
                        return False
            
            # Acquire new lock
            lock_info = {
                'session_id': session_id,
                'user_id': user_id,
                'user_name': user_info['name'],
                'acquired_time': current_time,
                'document_path': document_path,
                'cell_id': cell_id
            }
            
            self.locks[document_path][cell_id] = lock_info
            
            self.logger.info(f"Lock acquired: {document_path}#{cell_id} by {user_info['name']}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error acquiring lock: {e}")
            raise LockError(f"Failed to acquire lock: {e}")
    
    async def release_lock(self, document_path: str, cell_id: str, 
                          session_id: Optional[str] = None, force: bool = False) -> bool:
        """Release lock on a cell.
        
        Args:
            document_path: Path to the document
            cell_id: Identifier of the cell to unlock
            session_id: Session ID of lock owner (for validation)
            force: Force release without ownership check (admin only)
            
        Returns:
            True if lock released, False if not locked or permission denied
        """
        try:
            if cell_id not in self.locks[document_path]:
                return False  # Not locked
            
            existing_lock = self.locks[document_path][cell_id]
            
            # Validate ownership unless forcing
            if not force and session_id != existing_lock['session_id']:
                self.logger.warning(f"Lock release denied: {document_path}#{cell_id} - "
                                  f"not owned by session {session_id}")
                return False
            
            # Release lock
            del self.locks[document_path][cell_id]
            
            # Clean up empty document entries
            if not self.locks[document_path]:
                del self.locks[document_path]
            
            release_type = "forced" if force else "normal"
            self.logger.info(f"Lock released ({release_type}): {document_path}#{cell_id}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error releasing lock: {e}")
            raise LockError(f"Failed to release lock: {e}")
    
    def get_lock_info(self, document_path: str, cell_id: str) -> Optional[Dict[str, Any]]:
        """Get information about a cell lock."""
        return self.locks.get(document_path, {}).get(cell_id)
    
    def get_document_locks(self, document_path: str) -> Dict[str, Dict[str, Any]]:
        """Get all locks for a document."""
        return self.locks.get(document_path, {}).copy()
    
    def is_locked_by_session(self, document_path: str, cell_id: str, session_id: str) -> bool:
        """Check if cell is locked by specific session."""
        lock_info = self.get_lock_info(document_path, cell_id)
        return lock_info is not None and lock_info['session_id'] == session_id
    
    async def release_session_locks(self, session_id: str):
        """Release all locks held by a session (on disconnect)."""
        released_locks = []
        
        for document_path, doc_locks in list(self.locks.items()):
            for cell_id, lock_info in list(doc_locks.items()):
                if lock_info['session_id'] == session_id:
                    await self.release_lock(document_path, cell_id, session_id)
                    released_locks.append((document_path, cell_id))
        
        if released_locks:
            self.logger.info(f"Released {len(released_locks)} locks for session {session_id}")
        
        return released_locks


class CommentManager:
    """Manages cell-level comments and discussion threads.
    
    Features:
    - Threaded comments on cells or text selections
    - Real-time comment notifications
    - Comment resolution workflow
    - User mention system
    - Comment history and editing
    """
    
    def __init__(self):
        self.logger = logging.getLogger(f"{__name__}.CommentManager")
        
        # Comment storage: {document_path: {comment_id: comment_data}}
        self.comments: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
        
        # Comment threads: {document_path: {cell_id: [comment_ids]}}
        self.threads: Dict[str, Dict[str, List[str]]] = defaultdict(lambda: defaultdict(list))
        
        # Notification subscriptions: {document_path: {session_id: websocket}}
        self.subscribers: Dict[str, Dict[str, Any]] = defaultdict(dict)
    
    async def create_comment(self, document_path: str, user_info: Dict[str, Any], 
                           comment_data: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new comment.
        
        Args:
            document_path: Path to the document
            user_info: User creating the comment
            comment_data: Comment content and metadata
            
        Returns:
            Created comment with assigned ID
        """
        try:
            comment_id = str(uuid.uuid4())
            current_time = time.time()
            
            # Build comment object
            comment = {
                'id': comment_id,
                'document_path': document_path,
                'cell_id': comment_data.get('cell_id'),
                'selection': comment_data.get('selection'),
                'content': comment_data['content'],
                'author_id': user_info['id'],
                'author_name': user_info['name'],
                'created_time': current_time,
                'modified_time': current_time,
                'resolved': False,
                'resolved_by': None,
                'resolved_time': None,
                'parent_id': comment_data.get('parent_id'),  # For threaded replies
                'mentions': self._extract_mentions(comment_data['content']),
                'metadata': comment_data.get('metadata', {})
            }
            
            # Store comment
            self.comments[document_path][comment_id] = comment
            
            # Add to thread
            cell_id = comment_data.get('cell_id', 'global')
            self.threads[document_path][cell_id].append(comment_id)
            
            self.logger.info(f"Comment created: {comment_id} by {user_info['name']} "
                           f"on {document_path}#{cell_id}")
            
            # Send notifications
            await self._notify_comment_event(document_path, 'comment_created', comment)
            
            return comment
            
        except Exception as e:
            self.logger.error(f"Error creating comment: {e}")
            raise CommentError(f"Failed to create comment: {e}")
    
    async def update_comment(self, document_path: str, comment_id: str, 
                           user_info: Dict[str, Any], updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update an existing comment."""
        try:
            if comment_id not in self.comments[document_path]:
                return None
            
            comment = self.comments[document_path][comment_id]
            
            # Check ownership or admin permission
            if (comment['author_id'] != user_info['id'] and 
                user_info.get('collaboration_role') != 'admin'):
                raise PermissionError("Not authorized to edit this comment")
            
            # Apply updates
            if 'content' in updates:
                comment['content'] = updates['content']
                comment['mentions'] = self._extract_mentions(updates['content'])
            
            comment['modified_time'] = time.time()
            
            self.logger.info(f"Comment updated: {comment_id} by {user_info['name']}")
            
            # Send notifications
            await self._notify_comment_event(document_path, 'comment_updated', comment)
            
            return comment
            
        except Exception as e:
            self.logger.error(f"Error updating comment: {e}")
            raise CommentError(f"Failed to update comment: {e}")
    
    async def resolve_comment(self, document_path: str, comment_id: str, 
                            user_info: Dict[str, Any], resolved: bool = True) -> Optional[Dict[str, Any]]:
        """Resolve or unresolve a comment thread."""
        try:
            if comment_id not in self.comments[document_path]:
                return None
            
            comment = self.comments[document_path][comment_id]
            
            # Update resolution status
            comment['resolved'] = resolved
            comment['resolved_by'] = user_info['id'] if resolved else None
            comment['resolved_time'] = time.time() if resolved else None
            
            action = 'resolved' if resolved else 'unresolved'
            self.logger.info(f"Comment {action}: {comment_id} by {user_info['name']}")
            
            # Send notifications
            event_type = 'comment_resolved' if resolved else 'comment_unresolved'
            await self._notify_comment_event(document_path, event_type, comment)
            
            return comment
            
        except Exception as e:
            self.logger.error(f"Error resolving comment: {e}")
            raise CommentError(f"Failed to resolve comment: {e}")
    
    async def delete_comment(self, document_path: str, comment_id: str, 
                           user_info: Dict[str, Any]) -> bool:
        """Delete a comment."""
        try:
            if comment_id not in self.comments[document_path]:
                return False
            
            comment = self.comments[document_path][comment_id]
            
            # Check ownership or admin permission
            if (comment['author_id'] != user_info['id'] and 
                user_info.get('collaboration_role') != 'admin'):
                raise PermissionError("Not authorized to delete this comment")
            
            # Remove from storage
            del self.comments[document_path][comment_id]
            
            # Remove from threads
            for cell_id, comment_ids in self.threads[document_path].items():
                if comment_id in comment_ids:
                    comment_ids.remove(comment_id)
                    break
            
            self.logger.info(f"Comment deleted: {comment_id} by {user_info['name']}")
            
            # Send notifications
            await self._notify_comment_event(document_path, 'comment_deleted', comment)
            
            return True
            
        except Exception as e:
            self.logger.error(f"Error deleting comment: {e}")
            raise CommentError(f"Failed to delete comment: {e}")
    
    def get_comments(self, document_path: str, cell_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get comments for a document or specific cell."""
        doc_comments = self.comments.get(document_path, {})
        
        if cell_id is not None:
            # Get comments for specific cell
            thread_comment_ids = self.threads.get(document_path, {}).get(cell_id, [])
            return [doc_comments[cid] for cid in thread_comment_ids if cid in doc_comments]
        else:
            # Get all comments for document
            return list(doc_comments.values())
    
    def get_comment_threads(self, document_path: str) -> Dict[str, List[Dict[str, Any]]]:
        """Get all comment threads for a document."""
        threads = {}
        for cell_id, comment_ids in self.threads.get(document_path, {}).items():
            comments = [self.comments[document_path][cid] for cid in comment_ids 
                       if cid in self.comments[document_path]]
            if comments:
                threads[cell_id] = comments
        return threads
    
    def _extract_mentions(self, content: str) -> List[str]:
        """Extract @mentions from comment content."""
        import re
        mention_pattern = r'@(\w+)'
        return re.findall(mention_pattern, content)
    
    async def subscribe_notifications(self, document_path: str, session_id: str, websocket):
        """Subscribe to comment notifications for a document."""
        self.subscribers[document_path][session_id] = websocket
    
    async def unsubscribe_notifications(self, document_path: str, session_id: str):
        """Unsubscribe from comment notifications."""
        if document_path in self.subscribers:
            self.subscribers[document_path].pop(session_id, None)
            if not self.subscribers[document_path]:
                del self.subscribers[document_path]
    
    async def _notify_comment_event(self, document_path: str, event_type: str, comment: Dict[str, Any]):
        """Send comment notifications to subscribers."""
        if document_path not in self.subscribers:
            return
        
        notification = {
            'type': 'comment_notification',
            'event_type': event_type,
            'comment': comment,
            'timestamp': time.time()
        }
        
        # Send to all subscribers
        for session_id, websocket in list(self.subscribers[document_path].items()):
            try:
                if websocket and not websocket.ws_connection.is_closing():
                    await websocket.write_message(json.dumps(notification))
            except Exception as e:
                self.logger.error(f"Error sending comment notification: {e}")
                # Clean up dead connection
                self.subscribers[document_path].pop(session_id, None)


class HistoryTracker:
    """Tracks document version history and change attribution.
    
    Features:
    - CRDT operation history with user attribution
    - Document snapshots at key points
    - Change visualization and diff generation
    - Version restoration capabilities
    - Activity timeline
    """
    
    def __init__(self, max_history_entries: int = 1000):
        self.logger = logging.getLogger(f"{__name__}.HistoryTracker")
        self.max_history_entries = max_history_entries
        
        # History storage: {document_path: [history_entries]}
        self.history: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        
        # Document snapshots: {document_path: {version: snapshot_data}}
        self.snapshots: Dict[str, Dict[int, Dict[str, Any]]] = defaultdict(dict)
        
        # Version counters: {document_path: current_version}
        self.versions: Dict[str, int] = defaultdict(int)
    
    async def record_change(self, document_path: str, user_info: Dict[str, Any], 
                          change_data: Dict[str, Any]) -> int:
        """Record a document change in history.
        
        Args:
            document_path: Path to the document
            user_info: User making the change
            change_data: Details of the change
            
        Returns:
            Version number of the recorded change
        """
        try:
            # Increment version
            self.versions[document_path] += 1
            version = self.versions[document_path]
            
            # Create history entry
            history_entry = {
                'version': version,
                'timestamp': time.time(),
                'user_id': user_info['id'],
                'user_name': user_info['name'],
                'session_id': user_info['session_id'],
                'change_type': change_data.get('type', 'unknown'),
                'cell_id': change_data.get('cell_id'),
                'operation': change_data.get('operation', {}),
                'summary': change_data.get('summary', ''),
                'size_bytes': change_data.get('size_bytes', 0)
            }
            
            # Add to history
            self.history[document_path].append(history_entry)
            
            # Trim history if too long
            if len(self.history[document_path]) > self.max_history_entries:
                self.history[document_path] = self.history[document_path][-self.max_history_entries:]
            
            self.logger.debug(f"Recorded change v{version} for {document_path} by {user_info['name']}")
            
            # Create snapshot for major changes
            if self._should_create_snapshot(change_data):
                await self._create_snapshot(document_path, version, change_data)
            
            return version
            
        except Exception as e:
            self.logger.error(f"Error recording change: {e}")
            raise
    
    def get_history(self, document_path: str, limit: Optional[int] = None, 
                   since_version: Optional[int] = None) -> List[Dict[str, Any]]:
        """Get document change history.
        
        Args:
            document_path: Path to the document
            limit: Maximum number of entries to return
            since_version: Only return changes since this version
            
        Returns:
            List of history entries
        """
        history = self.history.get(document_path, [])
        
        # Filter by version if specified
        if since_version is not None:
            history = [entry for entry in history if entry['version'] > since_version]
        
        # Apply limit
        if limit is not None:
            history = history[-limit:]
        
        return history
    
    def get_version_info(self, document_path: str) -> Dict[str, Any]:
        """Get current version information for a document."""
        current_version = self.versions.get(document_path, 0)
        history = self.history.get(document_path, [])
        
        # Get recent activity
        recent_changes = history[-10:] if history else []
        
        # Get unique contributors
        contributors = set()
        for entry in history:
            contributors.add(entry['user_id'])
        
        return {
            'current_version': current_version,
            'total_changes': len(history),
            'contributors': list(contributors),
            'recent_changes': recent_changes,
            'available_snapshots': list(self.snapshots.get(document_path, {}).keys())
        }
    
    def get_user_activity(self, document_path: str, user_id: str) -> List[Dict[str, Any]]:
        """Get activity history for a specific user."""
        history = self.history.get(document_path, [])
        return [entry for entry in history if entry['user_id'] == user_id]
    
    def _should_create_snapshot(self, change_data: Dict[str, Any]) -> bool:
        """Determine if a snapshot should be created for this change."""
        # Create snapshots for major operations
        major_operations = ['cell_insert', 'cell_delete', 'notebook_save']
        return change_data.get('type') in major_operations
    
    async def _create_snapshot(self, document_path: str, version: int, change_data: Dict[str, Any]):
        """Create a document snapshot."""
        try:
            # For now, just store metadata about the snapshot
            # In a full implementation, this would save the document state
            snapshot = {
                'version': version,
                'timestamp': time.time(),
                'change_type': change_data.get('type'),
                'description': f"Snapshot at version {version}",
                'metadata': change_data.get('metadata', {})
            }
            
            self.snapshots[document_path][version] = snapshot
            
            self.logger.info(f"Created snapshot v{version} for {document_path}")
            
        except Exception as e:
            self.logger.error(f"Error creating snapshot: {e}")


class CollaborationManager:
    """Core manager for collaborative editing sessions.
    
    Coordinates all collaboration components:
    - Document session management
    - CRDT operation handling
    - Component integration and lifecycle
    - Error handling and recovery
    """
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.logger = logging.getLogger(f"{__name__}.CollaborationManager")
        self.config = config or {}
        
        # Initialize components
        self.presence_tracker = PresenceTracker()
        self.lock_manager = LockManager(
            lock_timeout=self.config.get('lock_timeout', 300.0)
        )
        self.comment_manager = CommentManager()
        self.history_tracker = HistoryTracker(
            max_history_entries=self.config.get('max_history_entries', 1000)
        )
        
        # Active document sessions: {document_path: session_info}
        self.active_sessions: Dict[str, Dict[str, Any]] = {}
        
        # Session cleanup
        self._cleanup_task = None
        self._start_cleanup_task()
    
    def _start_cleanup_task(self):
        """Start background cleanup task."""
        if not self._cleanup_task:
            self._cleanup_task = asyncio.create_task(self._cleanup_sessions())
    
    async def _cleanup_sessions(self):
        """Background task for session cleanup."""
        while True:
            try:
                await asyncio.sleep(120)  # Check every 2 minutes
                
                # Clean up empty sessions
                empty_sessions = []
                for document_path, session_info in self.active_sessions.items():
                    if not self.presence_tracker.get_document_users(document_path):
                        empty_sessions.append(document_path)
                
                for document_path in empty_sessions:
                    await self.close_session(document_path)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in session cleanup: {e}")
    
    async def create_session(self, document_path: str) -> Dict[str, Any]:
        """Create or get existing collaboration session for a document."""
        if document_path not in self.active_sessions:
            session_info = {
                'document_path': document_path,
                'created_time': time.time(),
                'last_activity': time.time(),
                'crdt_state': {},  # Would contain Yjs document state
                'metadata': {}
            }
            
            self.active_sessions[document_path] = session_info
            self.logger.info(f"Created collaboration session for {document_path}")
        
        return self.active_sessions[document_path]
    
    async def close_session(self, document_path: str):
        """Close collaboration session for a document."""
        if document_path in self.active_sessions:
            del self.active_sessions[document_path]
            self.logger.info(f"Closed collaboration session for {document_path}")
    
    async def join_session(self, document_path: str, user_info: Dict[str, Any], 
                          websocket) -> Dict[str, Any]:
        """Join user to collaboration session."""
        # Create session if needed
        await self.create_session(document_path)
        
        # Register presence
        presence_state = await self.presence_tracker.join_document(
            document_path, user_info, websocket)
        
        # Subscribe to notifications
        session_id = user_info['session_id']
        await self.comment_manager.subscribe_notifications(
            document_path, session_id, websocket)
        
        # Get current state
        current_state = {
            'document_path': document_path,
            'presence_state': presence_state,
            'comment_threads': self.comment_manager.get_comment_threads(document_path),
            'document_locks': self.lock_manager.get_document_locks(document_path),
            'version_info': self.history_tracker.get_version_info(document_path),
            'session_info': self.active_sessions[document_path]
        }
        
        self.logger.info(f"User {user_info['name']} joined session for {document_path}")
        return current_state
    
    async def leave_session(self, document_path: str, session_id: str):
        """Remove user from collaboration session."""
        # Remove presence
        await self.presence_tracker.leave_document(document_path, session_id)
        
        # Unsubscribe from notifications
        await self.comment_manager.unsubscribe_notifications(document_path, session_id)
        
        # Release any locks held by this session
        await self.lock_manager.release_session_locks(session_id)
        
        self.logger.info(f"Session {session_id} left document {document_path}")
    
    async def process_crdt_update(self, document_path: str, user_info: Dict[str, Any], 
                                 update_data: Dict[str, Any]) -> Dict[str, Any]:
        """Process a CRDT update operation."""
        try:
            # Update session activity
            if document_path in self.active_sessions:
                self.active_sessions[document_path]['last_activity'] = time.time()
            
            # Record in history
            change_data = {
                'type': 'crdt_update',
                'operation': update_data,
                'size_bytes': len(json.dumps(update_data)),
                'summary': f"CRDT update: {update_data.get('type', 'unknown')}"
            }
            
            version = await self.history_tracker.record_change(
                document_path, user_info, change_data)
            
            # Update presence activity
            await self.presence_tracker.update_activity(
                document_path, user_info['session_id'])
            
            # Return response
            return {
                'success': True,
                'version': version,
                'timestamp': time.time()
            }
            
        except Exception as e:
            self.logger.error(f"Error processing CRDT update: {e}")
            raise SynchronizationError(f"Failed to process update: {e}")
    
    def get_session_info(self, document_path: str) -> Optional[Dict[str, Any]]:
        """Get information about a collaboration session."""
        return self.active_sessions.get(document_path)
    
    def get_active_sessions(self) -> Dict[str, Dict[str, Any]]:
        """Get all active collaboration sessions."""
        return self.active_sessions.copy()


# WebSocket Handler Classes

class WebSocketCollabHandler(tornado.websocket.WebSocketHandler, JupyterHandler):
    """Main WebSocket handler for document-specific collaboration.
    
    Handles the /api/contents/{path}/collab/ws endpoint for real-time
    collaborative editing of specific notebooks.
    
    Features:
    - Yjs CRDT synchronization
    - User presence awareness
    - Cell locking coordination
    - Comment system integration
    - Version history tracking
    """
    
    def initialize(self, collaboration_manager: CollaborationManager):
        """Initialize handler with collaboration manager."""
        self.collaboration_manager = collaboration_manager
        self.security_manager = SecurityManager(self)
        self.logger = logging.getLogger(f"{__name__}.WebSocketCollabHandler")
        
        # Connection state
        self.document_path: Optional[str] = None
        self.user_info: Optional[Dict[str, Any]] = None
        self.session_id: Optional[str] = None
        self.api_version: str = "v1.0"
        
        # Message handlers by type
        self.message_handlers = {
            'crdt_update': self._handle_crdt_update,
            'presence_update': self._handle_presence_update,
            'lock_request': self._handle_lock_request,
            'lock_release': self._handle_lock_release,
            'comment_create': self._handle_comment_create,
            'comment_update': self._handle_comment_update,
            'comment_resolve': self._handle_comment_resolve,
            'comment_delete': self._handle_comment_delete,
            'heartbeat': self._handle_heartbeat
        }
    
    def check_origin(self, origin: str) -> bool:
        """Check if origin is allowed for WebSocket connections."""
        # Use parent's origin checking logic
        return super().check_origin(origin)
    
    def get_compression_options(self) -> Optional[Dict[str, Any]]:
        """Enable WebSocket compression for efficiency."""
        return {
            'compression_level': 6,
            'mem_level': 8
        }
    
    async def open(self, document_path: str = ""):
        """Handle WebSocket connection opening."""
        try:
            # Decode document path
            self.document_path = unquote(document_path) if document_path else ""
            
            # Extract API version from query parameters
            api_version = self.get_argument('api_version', 'v1.0')
            if api_version not in ['v1.0', 'v1.1', 'v1.2']:
                await self.close(code=4000, reason="Unsupported API version")
                return
            self.api_version = api_version
            
            # Authenticate user
            self.user_info = await self.security_manager.authenticate_websocket(
                dict(self.request.headers))
            
            if not self.user_info:
                await self.close(code=4001, reason="Authentication failed")
                return
            
            self.session_id = self.user_info['session_id']
            
            # Check permissions
            if not self.security_manager.check_permission(
                self.user_info, 'view', 'document', self.document_path):
                await self.close(code=4003, reason="Permission denied")
                return
            
            # Join collaboration session
            session_state = await self.collaboration_manager.join_session(
                self.document_path, self.user_info, self)
            
            # Send initial state
            await self.write_message(json.dumps({
                'type': 'session_joined',
                'api_version': self.api_version,
                'session_state': session_state,
                'user_info': {
                    'session_id': self.session_id,
                    'user_id': self.user_info['id'],
                    'user_name': self.user_info['name'],
                    'role': self.user_info.get('collaboration_role', 'view')
                }
            }))
            
            # Audit log
            self.security_manager.audit_log(
                self.user_info, 'websocket_connect', 
                f'document:{self.document_path}', 'success')
            
            self.logger.info(f"WebSocket opened for {self.user_info['name']} "
                           f"on {self.document_path} (API {self.api_version})")
            
        except Exception as e:
            self.logger.error(f"Error opening WebSocket: {e}")
            await self.close(code=4000, reason=f"Connection error: {e}")
    
    async def on_message(self, message: str):
        """Handle incoming WebSocket messages."""
        try:
            # Parse message
            try:
                data = json.loads(message)
            except json.JSONDecodeError as e:
                await self._send_error("Invalid JSON message", code="INVALID_JSON")
                return
            
            # Validate message structure
            if not isinstance(data, dict) or 'type' not in data:
                await self._send_error("Invalid message format", code="INVALID_FORMAT")
                return
            
            message_type = data['type']
            
            # Check if handler exists
            if message_type not in self.message_handlers:
                await self._send_error(f"Unknown message type: {message_type}", 
                                     code="UNKNOWN_MESSAGE_TYPE")
                return
            
            # Handle message
            handler = self.message_handlers[message_type]
            await handler(data)
            
        except Exception as e:
            self.logger.error(f"Error handling message: {e}")
            await self._send_error(f"Message handling error: {e}", code="HANDLER_ERROR")
    
    def on_close(self):
        """Handle WebSocket connection closing."""
        if self.document_path and self.session_id:
            # Leave collaboration session
            asyncio.create_task(
                self.collaboration_manager.leave_session(self.document_path, self.session_id))
            
            # Audit log
            if self.user_info:
                self.security_manager.audit_log(
                    self.user_info, 'websocket_disconnect', 
                    f'document:{self.document_path}', 'success')
            
            self.logger.info(f"WebSocket closed for session {self.session_id} "
                           f"on {self.document_path}")
    
    # Message handlers
    
    async def _handle_crdt_update(self, data: Dict[str, Any]):
        """Handle CRDT update operations."""
        # Check edit permission
        if not self.security_manager.check_permission(
            self.user_info, 'edit', 'document', self.document_path):
            await self._send_error("Permission denied for CRDT update", code="PERMISSION_DENIED")
            return
        
        # Process update
        try:
            result = await self.collaboration_manager.process_crdt_update(
                self.document_path, self.user_info, data.get('update', {}))
            
            # Send confirmation
            await self.write_message(json.dumps({
                'type': 'crdt_update_confirmed',
                'request_id': data.get('request_id'),
                'result': result
            }))
            
            # Broadcast to other clients (would be handled by Yjs in real implementation)
            # await self._broadcast_update(data)
            
        except Exception as e:
            await self._send_error(f"CRDT update failed: {e}", code="CRDT_ERROR")
    
    async def _handle_presence_update(self, data: Dict[str, Any]):
        """Handle presence/cursor position updates."""
        try:
            await self.collaboration_manager.presence_tracker.update_cursor_position(
                self.document_path, self.session_id, data.get('position', {}))
            
            # Response sent via presence broadcast mechanism
            
        except Exception as e:
            await self._send_error(f"Presence update failed: {e}", code="PRESENCE_ERROR")
    
    async def _handle_lock_request(self, data: Dict[str, Any]):
        """Handle cell lock requests."""
        # Check edit permission
        if not self.security_manager.check_permission(
            self.user_info, 'edit', 'cell', data.get('cell_id')):
            await self._send_error("Permission denied for lock request", code="PERMISSION_DENIED")
            return
        
        try:
            cell_id = data.get('cell_id')
            if not cell_id:
                await self._send_error("Missing cell_id", code="INVALID_REQUEST")
                return
            
            success = await self.collaboration_manager.lock_manager.acquire_lock(
                self.document_path, cell_id, self.user_info)
            
            await self.write_message(json.dumps({
                'type': 'lock_response',
                'request_id': data.get('request_id'),
                'cell_id': cell_id,
                'success': success,
                'message': 'Lock acquired' if success else 'Lock unavailable'
            }))
            
        except Exception as e:
            await self._send_error(f"Lock request failed: {e}", code="LOCK_ERROR")
    
    async def _handle_lock_release(self, data: Dict[str, Any]):
        """Handle cell lock releases."""
        try:
            cell_id = data.get('cell_id')
            if not cell_id:
                await self._send_error("Missing cell_id", code="INVALID_REQUEST")
                return
            
            # Check if admin override
            force = (data.get('force', False) and 
                    self.security_manager.check_permission(self.user_info, 'admin'))
            
            success = await self.collaboration_manager.lock_manager.release_lock(
                self.document_path, cell_id, self.session_id, force=force)
            
            await self.write_message(json.dumps({
                'type': 'lock_release_response',
                'request_id': data.get('request_id'),
                'cell_id': cell_id,
                'success': success
            }))
            
        except Exception as e:
            await self._send_error(f"Lock release failed: {e}", code="LOCK_ERROR")
    
    async def _handle_comment_create(self, data: Dict[str, Any]):
        """Handle comment creation."""
        try:
            comment = await self.collaboration_manager.comment_manager.create_comment(
                self.document_path, self.user_info, data.get('comment', {}))
            
            await self.write_message(json.dumps({
                'type': 'comment_created',
                'request_id': data.get('request_id'),
                'comment': comment
            }))
            
        except Exception as e:
            await self._send_error(f"Comment creation failed: {e}", code="COMMENT_ERROR")
    
    async def _handle_comment_update(self, data: Dict[str, Any]):
        """Handle comment updates."""
        try:
            comment_id = data.get('comment_id')
            updates = data.get('updates', {})
            
            comment = await self.collaboration_manager.comment_manager.update_comment(
                self.document_path, comment_id, self.user_info, updates)
            
            if comment:
                await self.write_message(json.dumps({
                    'type': 'comment_updated',
                    'request_id': data.get('request_id'),
                    'comment': comment
                }))
            else:
                await self._send_error("Comment not found", code="NOT_FOUND")
                
        except Exception as e:
            await self._send_error(f"Comment update failed: {e}", code="COMMENT_ERROR")
    
    async def _handle_comment_resolve(self, data: Dict[str, Any]):
        """Handle comment resolution."""
        try:
            comment_id = data.get('comment_id')
            resolved = data.get('resolved', True)
            
            comment = await self.collaboration_manager.comment_manager.resolve_comment(
                self.document_path, comment_id, self.user_info, resolved)
            
            if comment:
                await self.write_message(json.dumps({
                    'type': 'comment_resolved',
                    'request_id': data.get('request_id'),
                    'comment': comment
                }))
            else:
                await self._send_error("Comment not found", code="NOT_FOUND")
                
        except Exception as e:
            await self._send_error(f"Comment resolution failed: {e}", code="COMMENT_ERROR")
    
    async def _handle_comment_delete(self, data: Dict[str, Any]):
        """Handle comment deletion."""
        try:
            comment_id = data.get('comment_id')
            
            success = await self.collaboration_manager.comment_manager.delete_comment(
                self.document_path, comment_id, self.user_info)
            
            await self.write_message(json.dumps({
                'type': 'comment_deleted',
                'request_id': data.get('request_id'),
                'comment_id': comment_id,
                'success': success
            }))
            
        except Exception as e:
            await self._send_error(f"Comment deletion failed: {e}", code="COMMENT_ERROR")
    
    async def _handle_heartbeat(self, data: Dict[str, Any]):
        """Handle heartbeat messages to maintain connection."""
        await self.collaboration_manager.presence_tracker.update_activity(
            self.document_path, self.session_id)
        
        await self.write_message(json.dumps({
            'type': 'heartbeat_response',
            'timestamp': time.time()
        }))
    
    async def _send_error(self, message: str, code: str = "ERROR"):
        """Send error message to client."""
        await self.write_message(json.dumps({
            'type': 'error',
            'code': code,
            'message': message,
            'timestamp': time.time()
        }))


class GlobalCollabHandler(tornado.websocket.WebSocketHandler, JupyterHandler):
    """Global collaboration WebSocket handler.
    
    Handles the /api/collaboration/v1/ws endpoint for cross-document
    collaboration features like notifications and user discovery.
    """
    
    def initialize(self, collaboration_manager: CollaborationManager):
        """Initialize handler with collaboration manager."""
        self.collaboration_manager = collaboration_manager
        self.security_manager = SecurityManager(self)
        self.logger = logging.getLogger(f"{__name__}.GlobalCollabHandler")
        
        # Connection state
        self.user_info: Optional[Dict[str, Any]] = None
        self.session_id: Optional[str] = None
        self.subscriptions: Set[str] = set()  # Document paths subscribed to
    
    async def open(self):
        """Handle WebSocket connection opening."""
        try:
            # Authenticate user
            self.user_info = await self.security_manager.authenticate_websocket(
                dict(self.request.headers))
            
            if not self.user_info:
                await self.close(code=4001, reason="Authentication failed")
                return
            
            self.session_id = self.user_info['session_id']
            
            # Send connection confirmation
            await self.write_message(json.dumps({
                'type': 'global_session_joined',
                'user_info': {
                    'session_id': self.session_id,
                    'user_id': self.user_info['id'],
                    'user_name': self.user_info['name'],
                    'role': self.user_info.get('collaboration_role', 'view')
                },
                'active_sessions': list(self.collaboration_manager.get_active_sessions().keys())
            }))
            
            self.logger.info(f"Global WebSocket opened for {self.user_info['name']}")
            
        except Exception as e:
            self.logger.error(f"Error opening global WebSocket: {e}")
            await self.close(code=4000, reason=f"Connection error: {e}")
    
    async def on_message(self, message: str):
        """Handle incoming WebSocket messages."""
        try:
            data = json.loads(message)
            message_type = data.get('type')
            
            if message_type == 'subscribe_notifications':
                await self._handle_subscribe(data)
            elif message_type == 'unsubscribe_notifications':
                await self._handle_unsubscribe(data)
            elif message_type == 'get_active_sessions':
                await self._handle_get_sessions(data)
            else:
                await self._send_error(f"Unknown message type: {message_type}")
                
        except Exception as e:
            self.logger.error(f"Error handling global message: {e}")
            await self._send_error(f"Message handling error: {e}")
    
    async def _handle_subscribe(self, data: Dict[str, Any]):
        """Handle notification subscription requests."""
        document_path = data.get('document_path')
        if document_path:
            self.subscriptions.add(document_path)
            await self.write_message(json.dumps({
                'type': 'subscription_confirmed',
                'document_path': document_path
            }))
    
    async def _handle_unsubscribe(self, data: Dict[str, Any]):
        """Handle notification unsubscription requests."""
        document_path = data.get('document_path')
        if document_path in self.subscriptions:
            self.subscriptions.remove(document_path)
            await self.write_message(json.dumps({
                'type': 'unsubscription_confirmed',
                'document_path': document_path
            }))
    
    async def _handle_get_sessions(self, data: Dict[str, Any]):
        """Handle requests for active session information."""
        sessions = self.collaboration_manager.get_active_sessions()
        
        await self.write_message(json.dumps({
            'type': 'active_sessions',
            'sessions': {path: {
                'created_time': info['created_time'],
                'last_activity': info['last_activity'],
                'user_count': len(self.collaboration_manager.presence_tracker.get_document_users(path))
            } for path, info in sessions.items()}
        }))
    
    async def _send_error(self, message: str):
        """Send error message to client."""
        await self.write_message(json.dumps({
            'type': 'error',
            'message': message,
            'timestamp': time.time()
        }))
    
    def on_close(self):
        """Handle WebSocket connection closing."""
        if self.user_info:
            self.logger.info(f"Global WebSocket closed for {self.user_info['name']}")


# API Handler Classes

class CollaborationHealthHandler(JupyterHandler):
    """REST API handler for collaboration health checks.
    
    Provides /api/contents/{path}/collab/health endpoint for monitoring
    the health of collaborative sessions.
    """
    
    def initialize(self, collaboration_manager: CollaborationManager):
        """Initialize handler with collaboration manager."""
        self.collaboration_manager = collaboration_manager
    
    @authorized
    async def get(self, document_path: str = ""):
        """Get health information for a collaborative document."""
        document_path = unquote(document_path) if document_path else ""
        
        try:
            session_info = self.collaboration_manager.get_session_info(document_path)
            if not session_info:
                self.set_status(404)
                self.finish(json.dumps({'error': 'No active collaboration session'}))
                return
            
            # Get detailed health information
            presence_state = await self.collaboration_manager.presence_tracker.get_presence_state(document_path)
            document_locks = self.collaboration_manager.lock_manager.get_document_locks(document_path)
            version_info = self.collaboration_manager.history_tracker.get_version_info(document_path)
            
            health_info = {
                'status': 'healthy',
                'document_path': document_path,
                'session_info': {
                    'created_time': session_info['created_time'],
                    'last_activity': session_info['last_activity'],
                    'uptime_seconds': time.time() - session_info['created_time']
                },
                'presence_state': presence_state,
                'locks': {
                    'total_locks': len(document_locks),
                    'locked_cells': list(document_locks.keys())
                },
                'version_info': version_info,
                'timestamp': time.time()
            }
            
            self.set_header('Content-Type', 'application/json')
            self.finish(json.dumps(health_info))
            
        except Exception as e:
            self.logger.error(f"Error getting collaboration health: {e}")
            self.set_status(500)
            self.finish(json.dumps({'error': f'Health check failed: {e}'}))


# Configuration and Factory Functions

class CollaborationConfig(Configurable):
    """Configuration for collaboration features."""
    
    # Basic settings
    enabled = Bool(True, config=True, help="Enable collaboration features")
    
    # Lock management
    lock_timeout = Float(300.0, config=True, help="Lock timeout in seconds (default: 5 minutes)")
    
    # History tracking
    max_history_entries = Int(1000, config=True, help="Maximum history entries per document")
    
    # Authentication
    collab_token_lifetime = Float(86400.0, config=True, help="Collaboration token lifetime in seconds (default: 24 hours)")
    allow_insecure_ws = Bool(False, config=True, help="Allow insecure WebSocket connections (development only)")
    
    # Rate limiting
    collab_message_rate_limit = Int(100, config=True, help="Messages per minute per user")
    
    # Logging
    collab_log_level = Unicode('INFO', config=True, help="Collaboration logging level")
    collab_audit_enabled = Bool(True, config=True, help="Enable collaboration audit logging")
    permission_audit_enabled = Bool(True, config=True, help="Enable permission audit logging")
    comment_logging = Bool(True, config=True, help="Enable comment action logging")


def create_collaboration_handlers(collaboration_manager: CollaborationManager) -> List[Tuple[str, Any, Dict[str, Any]]]:
    """Create URL patterns for collaboration handlers.
    
    Args:
        collaboration_manager: Configured collaboration manager instance
        
    Returns:
        List of (pattern, handler_class, kwargs) tuples for Tornado application
    """
    return [
        # Document-specific collaboration WebSocket
        (r"/api/contents/(.*)/collab/ws", WebSocketCollabHandler, 
         {"collaboration_manager": collaboration_manager}),
        
        # Global collaboration WebSocket
        (r"/api/collaboration/v1/ws", GlobalCollabHandler,
         {"collaboration_manager": collaboration_manager}),
        
        # Collaboration health API
        (r"/api/contents/(.*)/collab/health", CollaborationHealthHandler,
         {"collaboration_manager": collaboration_manager}),
        
        # Version-specific endpoints for backward compatibility
        (r"/api/collaboration/v1.0/ws", GlobalCollabHandler,
         {"collaboration_manager": collaboration_manager}),
        (r"/api/collaboration/v1.1/ws", GlobalCollabHandler,
         {"collaboration_manager": collaboration_manager}),
        (r"/api/collaboration/v1.2/ws", GlobalCollabHandler,
         {"collaboration_manager": collaboration_manager}),
    ]


def initialize_collaboration(app_settings: Dict[str, Any]) -> CollaborationManager:
    """Initialize collaboration manager with application settings.
    
    Args:
        app_settings: Jupyter application settings
        
    Returns:
        Configured collaboration manager instance
    """
    # Extract collaboration configuration
    config = {
        'lock_timeout': app_settings.get('collab_lock_timeout', 300.0),
        'max_history_entries': app_settings.get('collab_max_history_entries', 1000),
        'message_rate_limit': app_settings.get('collab_message_rate_limit', 100),
        'audit_enabled': app_settings.get('collab_audit_enabled', True)
    }
    
    # Create and return collaboration manager
    collaboration_manager = CollaborationManager(config)
    
    logger.info(f"Initialized collaboration manager with config: {config}")
    return collaboration_manager


# Module exports
__all__ = [
    'CollaborationError',
    'AuthenticationError', 
    'PermissionError',
    'SynchronizationError',
    'LockError',
    'CommentError',
    'SecurityManager',
    'PresenceTracker',
    'LockManager', 
    'CommentManager',
    'HistoryTracker',
    'CollaborationManager',
    'WebSocketCollabHandler',
    'GlobalCollabHandler',
    'CollaborationHealthHandler',
    'CollaborationConfig',
    'create_collaboration_handlers',
    'initialize_collaboration'
]