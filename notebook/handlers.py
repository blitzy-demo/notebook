"""
WebSocket handlers for real-time collaborative notebook editing.

This module implements WebSocket handlers that support the Yjs CRDT protocol
for real-time collaborative editing of Jupyter notebooks. The handlers provide
endpoints for document synchronization, user awareness, and commenting systems
with authentication, permission validation, and efficient binary message handling.

The implementation supports:
- CRDT-based conflict-free collaborative editing using Yjs protocol
- User presence tracking and cursor position sharing
- Cell-level commenting and annotation system
- JWT token-based authentication and authorization
- Rate limiting and connection health monitoring
- Binary message encoding for efficient network transmission
- Automatic reconnection handling and graceful degradation

All handlers integrate with the CollaborativeStorage backend for persistent
state management and provide scalable real-time synchronization for 5-10
simultaneous users per notebook with graceful performance degradation.
"""

import json
import asyncio
import logging
import time
import struct
import uuid
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Union, Any, Callable, Coroutine
from collections import defaultdict, deque, Counter, OrderedDict
from weakref import WeakSet, WeakValueDictionary, ref, proxy
from threading import Lock, RLock, Event, local, Timer

# External dependencies
from tornado import web
from tornado.web import WebSocketHandler, authenticated, HTTPError
from jupyter_server.utils import url_path_join, url_escape, ensure_async
from jupyter_server.base.handlers import JupyterHandler
from ypy import YDoc
import jwt
from jwt import InvalidTokenError, ExpiredSignatureError

# Internal dependencies
from notebook.collab.storage import CollaborativeStorage
from notebook.collab.handlers import CollaborationWebSocketHandler
from notebook.app import JupyterNotebookApp
from notebook._version import __version__

# Configure logging
logger = logging.getLogger(__name__)

# Constants for collaboration protocol
PROTOCOL_VERSION = "1.0"
MAX_MESSAGE_SIZE = 1024 * 1024  # 1MB
MAX_CONNECTIONS_PER_DOCUMENT = 10
MAX_CONNECTIONS_PER_USER = 5
HEARTBEAT_INTERVAL = 30  # seconds
CONNECTION_TIMEOUT = 300  # 5 minutes
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX_REQUESTS = 100

# Message types for Yjs protocol
MESSAGE_TYPE_SYNC = 0
MESSAGE_TYPE_AWARENESS = 1
MESSAGE_TYPE_COMMENTS = 2
MESSAGE_TYPE_HEARTBEAT = 3
MESSAGE_TYPE_ERROR = 4

# Sync message subtypes
SYNC_STEP_1 = 0  # Initial sync request
SYNC_STEP_2 = 1  # Document state response
SYNC_UPDATE = 2  # Document update

# Awareness message subtypes
AWARENESS_UPDATE = 0
AWARENESS_QUERY = 1

# Comment message subtypes
COMMENT_CREATE = 0
COMMENT_UPDATE = 1
COMMENT_DELETE = 2
COMMENT_RESOLVE = 3

# Global connection tracking
_active_connections: Dict[str, WeakSet] = defaultdict(WeakSet)
_connection_lock = RLock()
_user_connections: Dict[str, WeakSet] = defaultdict(WeakSet)
_rate_limiters: Dict[str, 'CollaborationRateLimiter'] = {}


class CollaborationError(Exception):
    """Base exception for collaboration-related errors."""
    pass


class AuthenticationError(CollaborationError):
    """Exception raised when authentication fails."""
    pass


class PermissionError(CollaborationError):
    """Exception raised when permission check fails."""
    pass


class RateLimitError(CollaborationError):
    """Exception raised when rate limit is exceeded."""
    pass


class CollaborationRateLimiter:
    """
    Rate limiter for WebSocket connections to prevent abuse.
    
    Implements a sliding window rate limiter with per-user and per-IP
    tracking to ensure fair usage and prevent denial-of-service attacks.
    """
    
    def __init__(self, max_requests: int = RATE_LIMIT_MAX_REQUESTS, 
                 window_size: int = RATE_LIMIT_WINDOW):
        """
        Initialize rate limiter.
        
        Args:
            max_requests: Maximum requests allowed in the window
            window_size: Time window size in seconds
        """
        self.max_requests = max_requests
        self.window_size = window_size
        self.requests: Dict[str, deque] = defaultdict(deque)
        self.lock = RLock()
        
        # Cleanup old entries periodically
        self._cleanup_timer = Timer(window_size, self._cleanup_old_entries)
        self._cleanup_timer.daemon = True
        self._cleanup_timer.start()
    
    def is_allowed(self, user_id: str) -> bool:
        """
        Check if a request is allowed for the given user.
        
        Args:
            user_id: User identifier
            
        Returns:
            True if request is allowed, False otherwise
        """
        with self.lock:
            current_time = time.time()
            user_requests = self.requests[user_id]
            
            # Remove old requests outside the window
            while user_requests and user_requests[0] < current_time - self.window_size:
                user_requests.popleft()
            
            # Check if under limit
            if len(user_requests) >= self.max_requests:
                return False
            
            # Add current request
            user_requests.append(current_time)
            return True
    
    def update_rate(self, user_id: str) -> None:
        """
        Update rate for a user (called when a request is made).
        
        Args:
            user_id: User identifier
        """
        with self.lock:
            current_time = time.time()
            user_requests = self.requests[user_id]
            user_requests.append(current_time)
    
    def get_user_rate(self, user_id: str) -> int:
        """
        Get current request count for a user.
        
        Args:
            user_id: User identifier
            
        Returns:
            Current request count in the window
        """
        with self.lock:
            current_time = time.time()
            user_requests = self.requests[user_id]
            
            # Remove old requests
            while user_requests and user_requests[0] < current_time - self.window_size:
                user_requests.popleft()
            
            return len(user_requests)
    
    def reset_user_rate(self, user_id: str) -> None:
        """
        Reset rate limit for a user.
        
        Args:
            user_id: User identifier
        """
        with self.lock:
            if user_id in self.requests:
                del self.requests[user_id]
    
    def _cleanup_old_entries(self) -> None:
        """Clean up old entries from the rate limiter."""
        with self.lock:
            current_time = time.time()
            users_to_remove = []
            
            for user_id, user_requests in self.requests.items():
                # Remove old requests
                while user_requests and user_requests[0] < current_time - self.window_size:
                    user_requests.popleft()
                
                # Remove empty entries
                if not user_requests:
                    users_to_remove.append(user_id)
            
            for user_id in users_to_remove:
                del self.requests[user_id]
        
        # Reschedule cleanup
        self._cleanup_timer = Timer(self.window_size, self._cleanup_old_entries)
        self._cleanup_timer.daemon = True
        self._cleanup_timer.start()


class BaseCollaborationHandler(CollaborationWebSocketHandler):
    """
    Base WebSocket handler for collaborative editing.
    
    This handler provides common functionality for all collaboration
    WebSocket endpoints including authentication, permission validation,
    message routing, and connection management.
    """
    
    def initialize(self, storage: CollaborativeStorage, app: JupyterNotebookApp):
        """
        Initialize the WebSocket handler.
        
        Args:
            storage: Collaborative storage instance
            app: Jupyter notebook application instance
        """
        super().initialize(storage, app)
        self.user_id: Optional[str] = None
        self.document_id: Optional[str] = None
        self.permissions: Dict[str, bool] = {}
        self.last_heartbeat = time.time()
        self.connection_id = str(uuid.uuid4())
        self.rate_limiter = _rate_limiters.get('global', CollaborationRateLimiter())
        
        # Setup logging
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        if hasattr(app, 'log'):
            self.logger = app.log.getChild(f'collab.{self.__class__.__name__.lower()}')
    
    def open(self, document_path: str):
        """
        Open WebSocket connection for a document.
        
        Args:
            document_path: Path to the document being edited
        """
        super().open(document_path)
        self.document_id = url_escape(document_path)
        self.logger.info(f"WebSocket connection opened for document: {self.document_id}")
        
        try:
            # Authenticate user and validate permissions
            self.authenticate_websocket()
            self.validate_permissions('read')
            
            # Register connection
            self._register_connection()
            
            # Send initial connection acknowledgment
            self._send_message(MESSAGE_TYPE_HEARTBEAT, {
                'type': 'connection_ack',
                'connection_id': self.connection_id,
                'server_version': __version__,
                'protocol_version': PROTOCOL_VERSION
            })
            
            # Start heartbeat monitoring
            self._start_heartbeat()
            
        except Exception as e:
            self.logger.error(f"Failed to open WebSocket connection: {e}")
            self.close(code=1008, reason=str(e))
    
    def on_message(self, message: Union[str, bytes]):
        """
        Handle incoming WebSocket message.
        
        Args:
            message: Incoming message (string or binary)
        """
        try:
            # Check rate limiting
            if not self.rate_limiter.is_allowed(self.user_id or self.request.remote_ip):
                self.logger.warning(f"Rate limit exceeded for user {self.user_id}")
                self._send_error("Rate limit exceeded")
                return
            
            # Update heartbeat
            self.last_heartbeat = time.time()
            
            # Parse message
            if isinstance(message, bytes):
                message_data = self._parse_binary_message(message)
            else:
                message_data = json.loads(message)
            
            # Route message based on type
            message_type = message_data.get('type', MESSAGE_TYPE_SYNC)
            
            if message_type == MESSAGE_TYPE_SYNC:
                self.handle_sync(message_data)
            elif message_type == MESSAGE_TYPE_AWARENESS:
                self.handle_awareness(message_data)
            elif message_type == MESSAGE_TYPE_COMMENTS:
                self.handle_comments(message_data)
            elif message_type == MESSAGE_TYPE_HEARTBEAT:
                self._handle_heartbeat(message_data)
            else:
                self.logger.warning(f"Unknown message type: {message_type}")
                self._send_error(f"Unknown message type: {message_type}")
        
        except Exception as e:
            self.logger.error(f"Error handling message: {e}")
            self._send_error(f"Message handling error: {e}")
    
    def on_close(self):
        """Handle WebSocket connection close."""
        super().on_close()
        self.logger.info(f"WebSocket connection closed for document: {self.document_id}")
        
        # Unregister connection
        self._unregister_connection()
        
        # Notify other users about disconnection
        if self.user_id:
            self._broadcast_user_disconnection()
    
    def authenticate_websocket(self) -> bool:
        """
        Authenticate the WebSocket connection using JWT token.
        
        Returns:
            True if authentication successful, False otherwise
        
        Raises:
            AuthenticationError: If authentication fails
        """
        try:
            # Get token from query parameters or headers
            token = self.get_argument('token', None)
            if not token:
                auth_header = self.request.headers.get('Authorization', '')
                if auth_header.startswith('Bearer '):
                    token = auth_header[7:]
            
            if not token:
                raise AuthenticationError("No authentication token provided")
            
            # Verify JWT token
            try:
                # Get JWT secret from app settings
                jwt_secret = getattr(self.app, 'jwt_secret', 'default_secret')
                if hasattr(self.app, 'serverapp') and hasattr(self.app.serverapp, 'token'):
                    jwt_secret = self.app.serverapp.token
                
                payload = jwt.decode(token, jwt_secret, algorithms=['HS256'])
                
                self.user_id = payload.get('sub') or payload.get('user_id')
                if not self.user_id:
                    raise AuthenticationError("Invalid token payload")
                
                # Store additional user info
                self.user_info = {
                    'user_id': self.user_id,
                    'username': payload.get('username', self.user_id),
                    'email': payload.get('email'),
                    'groups': payload.get('groups', [])
                }
                
                self.logger.debug(f"User authenticated: {self.user_id}")
                return True
                
            except ExpiredSignatureError:
                raise AuthenticationError("Token has expired")
            except InvalidTokenError as e:
                raise AuthenticationError(f"Invalid token: {e}")
        
        except Exception as e:
            self.logger.error(f"Authentication failed: {e}")
            raise AuthenticationError(f"Authentication failed: {e}")
    
    def validate_permissions(self, permission: str) -> bool:
        """
        Validate user permissions for specific actions.
        
        Args:
            permission: Permission type to check
            
        Returns:
            True if user has permission, False otherwise
        """
        try:
            # Check if user has read permission
            if not self._has_permission(permission):
                raise PermissionError(f"User does not have {permission} permission")
            
            # Check connection limits
            if not self._check_connection_limits():
                raise PermissionError("Maximum connections exceeded")
            
            # Store permissions
            self.permissions = {
                'read': self._has_permission('read'),
                'write': self._has_permission('write'),
                'admin': self._has_permission('admin')
            }
            
            self.logger.debug(f"Permissions validated for user {self.user_id}: {self.permissions}")
            return True
        
        except Exception as e:
            self.logger.error(f"Permission check failed: {e}")
            raise PermissionError(f"Permission check failed: {e}")
    
    def _has_permission(self, permission: str) -> bool:
        """
        Check if user has a specific permission.
        
        Args:
            permission: Permission type ('read', 'write', 'admin')
            
        Returns:
            True if user has permission, False otherwise
        """
        # For now, implement basic permission logic
        # In a real implementation, this would check against JupyterHub or other auth system
        
        if permission == 'read':
            return True  # All authenticated users can read
        elif permission == 'write':
            return True  # All authenticated users can write
        elif permission == 'admin':
            return hasattr(self, 'user_info') and 'admin' in self.user_info.get('groups', [])
        
        return False
    
    def _check_connection_limits(self) -> bool:
        """
        Check if connection limits are exceeded.
        
        Returns:
            True if connection is allowed, False otherwise
        """
        with _connection_lock:
            # Check document connection limit
            doc_connections = len(_active_connections.get(self.document_id, set()))
            if doc_connections >= MAX_CONNECTIONS_PER_DOCUMENT:
                return False
            
            # Check user connection limit
            user_connections = len(_user_connections.get(self.user_id, set()))
            if user_connections >= MAX_CONNECTIONS_PER_USER:
                return False
            
            return True
    
    def _register_connection(self) -> None:
        """Register the WebSocket connection."""
        with _connection_lock:
            _active_connections[self.document_id].add(self)
            _user_connections[self.user_id].add(self)
            
            self.logger.debug(f"Connection registered: {self.connection_id}")
    
    def _unregister_connection(self) -> None:
        """Unregister the WebSocket connection."""
        with _connection_lock:
            _active_connections[self.document_id].discard(self)
            _user_connections[self.user_id].discard(self)
            
            # Clean up empty sets
            if not _active_connections[self.document_id]:
                del _active_connections[self.document_id]
            if not _user_connections[self.user_id]:
                del _user_connections[self.user_id]
            
            self.logger.debug(f"Connection unregistered: {self.connection_id}")
    
    def _start_heartbeat(self) -> None:
        """Start heartbeat monitoring."""
        def check_heartbeat():
            if time.time() - self.last_heartbeat > CONNECTION_TIMEOUT:
                self.logger.warning(f"Connection timeout for {self.user_id}")
                self.close(code=1008, reason="Connection timeout")
            else:
                # Schedule next heartbeat check
                Timer(HEARTBEAT_INTERVAL, check_heartbeat).start()
        
        Timer(HEARTBEAT_INTERVAL, check_heartbeat).start()
    
    def _handle_heartbeat(self, message_data: Dict[str, Any]) -> None:
        """Handle heartbeat message."""
        # Send heartbeat response
        self._send_message(MESSAGE_TYPE_HEARTBEAT, {
            'type': 'heartbeat_response',
            'timestamp': time.time()
        })
    
    def _parse_binary_message(self, message: bytes) -> Dict[str, Any]:
        """
        Parse binary message according to Yjs protocol.
        
        Args:
            message: Binary message
            
        Returns:
            Parsed message data
        """
        try:
            # Yjs binary protocol format: [type][subtype][payload]
            if len(message) < 2:
                raise ValueError("Message too short")
            
            message_type = message[0]
            subtype = message[1]
            payload = message[2:] if len(message) > 2 else b''
            
            return {
                'type': message_type,
                'subtype': subtype,
                'payload': payload,
                'binary': True
            }
        
        except Exception as e:
            self.logger.error(f"Failed to parse binary message: {e}")
            raise ValueError(f"Invalid binary message: {e}")
    
    def _send_message(self, message_type: int, data: Dict[str, Any]) -> None:
        """
        Send message to the WebSocket client.
        
        Args:
            message_type: Message type constant
            data: Message data
        """
        try:
            if data.get('binary'):
                # Send binary message
                self._send_binary_message(message_type, data)
            else:
                # Send JSON message
                message = {
                    'type': message_type,
                    'timestamp': time.time(),
                    **data
                }
                self.write_message(json.dumps(message))
        
        except Exception as e:
            self.logger.error(f"Failed to send message: {e}")
    
    def _send_binary_message(self, message_type: int, data: Dict[str, Any]) -> None:
        """
        Send binary message using Yjs protocol format.
        
        Args:
            message_type: Message type
            data: Message data with binary payload
        """
        try:
            subtype = data.get('subtype', 0)
            payload = data.get('payload', b'')
            
            # Pack message: [type][subtype][payload]
            message = struct.pack('BB', message_type, subtype) + payload
            
            self.write_message(message, binary=True)
        
        except Exception as e:
            self.logger.error(f"Failed to send binary message: {e}")
    
    def _send_error(self, error_message: str) -> None:
        """
        Send error message to client.
        
        Args:
            error_message: Error message text
        """
        self._send_message(MESSAGE_TYPE_ERROR, {
            'error': error_message,
            'connection_id': self.connection_id
        })
    
    def _broadcast_to_document(self, message_type: int, data: Dict[str, Any], 
                              exclude_self: bool = True) -> None:
        """
        Broadcast message to all connections for the document.
        
        Args:
            message_type: Message type
            data: Message data
            exclude_self: Whether to exclude the sender
        """
        with _connection_lock:
            connections = _active_connections.get(self.document_id, set())
            
            for connection in connections.copy():
                if exclude_self and connection == self:
                    continue
                
                try:
                    connection._send_message(message_type, data)
                except Exception as e:
                    self.logger.error(f"Failed to broadcast to connection: {e}")
    
    def _broadcast_user_disconnection(self) -> None:
        """Broadcast user disconnection to other clients."""
        self._broadcast_to_document(MESSAGE_TYPE_AWARENESS, {
            'subtype': AWARENESS_UPDATE,
            'user_id': self.user_id,
            'status': 'disconnected'
        })


class CollaborationSyncHandler(BaseCollaborationHandler):
    """
    WebSocket handler for CRDT document synchronization.
    
    This handler implements the Yjs synchronization protocol for real-time
    collaborative editing, including document state synchronization and
    update propagation between clients.
    """
    
    def initialize(self, storage: CollaborativeStorage, app: JupyterNotebookApp):
        """Initialize the sync handler."""
        super().initialize(storage, app)
        self.ydoc: Optional[YDoc] = None
        self.sync_state: Dict[str, Any] = {}
        self.update_callback_id: Optional[int] = None
    
    def open(self, document_path: str):
        """Open sync connection and initialize Yjs document."""
        super().open(document_path)
        
        try:
            # Initialize Yjs document
            self.ydoc = YDoc()
            
            # Register update callback
            self.update_callback_id = self.ydoc.observe(self._on_document_update)
            
            # Load document state from storage
            asyncio.create_task(self._load_document_state())
            
        except Exception as e:
            self.logger.error(f"Failed to initialize sync handler: {e}")
            self.close(code=1011, reason=str(e))
    
    def on_close(self):
        """Clean up sync handler."""
        if self.ydoc and self.update_callback_id:
            self.ydoc.unobserve(self.update_callback_id)
        
        super().on_close()
    
    def handle_sync(self, message_data: Dict[str, Any]) -> None:
        """
        Handle CRDT synchronization message.
        
        Args:
            message_data: Sync message data
        """
        try:
            if not self.validate_permissions('read'):
                self._send_error("Insufficient permissions for sync")
                return
            
            subtype = message_data.get('subtype', SYNC_STEP_1)
            
            if subtype == SYNC_STEP_1:
                # Client requesting document state
                self.handle_document_sync(message_data)
            elif subtype == SYNC_UPDATE:
                # Client sending document update
                self.handle_crdt_update(message_data)
            else:
                self.logger.warning(f"Unknown sync subtype: {subtype}")
        
        except Exception as e:
            self.logger.error(f"Error in sync handler: {e}")
            self._send_error(f"Sync error: {e}")
    
    def handle_crdt_update(self, message_data: Dict[str, Any]) -> None:
        """
        Handle CRDT update from client.
        
        Args:
            message_data: Update message data
        """
        try:
            if not self.validate_permissions('write'):
                self._send_error("Insufficient permissions for updates")
                return
            
            # Extract update data
            if message_data.get('binary'):
                update_data = message_data.get('payload', b'')
            else:
                update_data = message_data.get('update', b'')
            
            if not update_data:
                self._send_error("No update data provided")
                return
            
            # Apply update to local document
            if self.ydoc:
                self.ydoc.apply_update(update_data)
            
            # Store update in persistent storage
            update_id = str(uuid.uuid4())
            asyncio.create_task(self._store_update(update_id, update_data))
            
            # Broadcast update to other clients
            self._broadcast_to_document(MESSAGE_TYPE_SYNC, {
                'subtype': SYNC_UPDATE,
                'update': update_data,
                'user_id': self.user_id,
                'binary': isinstance(update_data, bytes)
            })
            
        except Exception as e:
            self.logger.error(f"Error handling CRDT update: {e}")
            self._send_error(f"Update error: {e}")
    
    def handle_document_sync(self, message_data: Dict[str, Any]) -> None:
        """
        Handle document synchronization request.
        
        Args:
            message_data: Sync request message data
        """
        try:
            if not self.ydoc:
                self._send_error("Document not initialized")
                return
            
            # Get current document state
            state_vector = self.ydoc.get_state()
            
            # Send state to client
            self._send_message(MESSAGE_TYPE_SYNC, {
                'subtype': SYNC_STEP_2,
                'state': state_vector,
                'binary': True
            })
            
            # Also send recent updates
            asyncio.create_task(self._send_recent_updates())
            
        except Exception as e:
            self.logger.error(f"Error in document sync: {e}")
            self._send_error(f"Sync error: {e}")
    
    async def _load_document_state(self) -> None:
        """Load document state from storage."""
        try:
            if not self.ydoc:
                return
            
            # Get recent updates from storage
            updates = await self.storage.get_updates(self.document_id, limit=100)
            
            # Apply updates to document
            for update_record in updates:
                if isinstance(update_record.update_data, bytes):
                    self.ydoc.apply_update(update_record.update_data)
            
            self.logger.debug(f"Loaded {len(updates)} updates for document {self.document_id}")
            
        except Exception as e:
            self.logger.error(f"Failed to load document state: {e}")
    
    async def _store_update(self, update_id: str, update_data: bytes) -> None:
        """
        Store update in persistent storage.
        
        Args:
            update_id: Unique update identifier
            update_data: Binary update data
        """
        try:
            await self.storage.store_crdt_update(
                self.document_id, 
                update_id, 
                self.user_id, 
                update_data
            )
            
            self.logger.debug(f"Stored update {update_id} for document {self.document_id}")
            
        except Exception as e:
            self.logger.error(f"Failed to store update {update_id}: {e}")
    
    async def _send_recent_updates(self) -> None:
        """Send recent updates to the client."""
        try:
            # Get recent updates (last 10 minutes)
            since_time = datetime.now(timezone.utc) - timedelta(minutes=10)
            updates = await self.storage.get_updates(self.document_id, since_time, limit=50)
            
            for update_record in updates:
                if update_record.user_id != self.user_id:  # Don't send own updates
                    self._send_message(MESSAGE_TYPE_SYNC, {
                        'subtype': SYNC_UPDATE,
                        'update': update_record.update_data,
                        'user_id': update_record.user_id,
                        'timestamp': update_record.timestamp.isoformat(),
                        'binary': isinstance(update_record.update_data, bytes)
                    })
            
        except Exception as e:
            self.logger.error(f"Failed to send recent updates: {e}")
    
    def _on_document_update(self, update_data: bytes) -> None:
        """
        Handle document update from Yjs.
        
        Args:
            update_data: Binary update data
        """
        try:
            # Store update
            update_id = str(uuid.uuid4())
            asyncio.create_task(self._store_update(update_id, update_data))
            
            # Broadcast to other clients
            self._broadcast_to_document(MESSAGE_TYPE_SYNC, {
                'subtype': SYNC_UPDATE,
                'update': update_data,
                'user_id': self.user_id,
                'binary': True
            })
            
        except Exception as e:
            self.logger.error(f"Error handling document update: {e}")
    
    def handle_awareness(self, message_data: Dict[str, Any]) -> None:
        """Handle awareness message - not implemented in sync handler."""
        self._send_error("Awareness not supported in sync handler")
    
    def handle_comments(self, message_data: Dict[str, Any]) -> None:
        """Handle comments message - not implemented in sync handler."""
        self._send_error("Comments not supported in sync handler")


class CollaborationAwarenessHandler(BaseCollaborationHandler):
    """
    WebSocket handler for user awareness and presence tracking.
    
    This handler manages user presence information, cursor positions,
    and real-time awareness updates for collaborative editing sessions.
    """
    
    def initialize(self, storage: CollaborativeStorage, app: JupyterNotebookApp):
        """Initialize the awareness handler."""
        super().initialize(storage, app)
        self.awareness_state: Dict[str, Any] = {}
        self.cursor_position: Dict[str, Any] = {}
        self.presence_timer: Optional[Timer] = None
    
    def open(self, document_path: str):
        """Open awareness connection and start presence tracking."""
        super().open(document_path)
        
        try:
            # Initialize awareness state
            self.awareness_state = {
                'user_id': self.user_id,
                'username': getattr(self, 'user_info', {}).get('username', self.user_id),
                'status': 'online',
                'last_seen': datetime.now(timezone.utc).isoformat()
            }
            
            # Start presence updates
            self._start_presence_updates()
            
            # Broadcast user connection
            self._broadcast_user_connection()
            
        except Exception as e:
            self.logger.error(f"Failed to initialize awareness handler: {e}")
            self.close(code=1011, reason=str(e))
    
    def on_close(self):
        """Clean up awareness handler."""
        if self.presence_timer:
            self.presence_timer.cancel()
        
        super().on_close()
    
    def handle_awareness(self, message_data: Dict[str, Any]) -> None:
        """
        Handle awareness message.
        
        Args:
            message_data: Awareness message data
        """
        try:
            subtype = message_data.get('subtype', AWARENESS_UPDATE)
            
            if subtype == AWARENESS_UPDATE:
                self.handle_presence_update(message_data)
            elif subtype == AWARENESS_QUERY:
                self._send_awareness_state()
            else:
                self.logger.warning(f"Unknown awareness subtype: {subtype}")
        
        except Exception as e:
            self.logger.error(f"Error in awareness handler: {e}")
            self._send_error(f"Awareness error: {e}")
    
    def handle_cursor_update(self, message_data: Dict[str, Any]) -> None:
        """
        Handle cursor position update.
        
        Args:
            message_data: Cursor update message data
        """
        try:
            cursor_data = message_data.get('cursor', {})
            
            # Update local cursor position
            self.cursor_position = {
                'cell_id': cursor_data.get('cell_id'),
                'position': cursor_data.get('position', 0),
                'selection': cursor_data.get('selection', {}),
                'timestamp': datetime.now(timezone.utc).isoformat()
            }
            
            # Broadcast cursor update
            self.broadcast_awareness({
                'type': 'cursor_update',
                'user_id': self.user_id,
                'cursor': self.cursor_position
            })
            
        except Exception as e:
            self.logger.error(f"Error handling cursor update: {e}")
    
    def handle_presence_update(self, message_data: Dict[str, Any]) -> None:
        """
        Handle presence status update.
        
        Args:
            message_data: Presence update message data
        """
        try:
            presence_data = message_data.get('presence', {})
            
            # Update awareness state
            self.awareness_state.update({
                'status': presence_data.get('status', 'online'),
                'activity': presence_data.get('activity', 'editing'),
                'last_seen': datetime.now(timezone.utc).isoformat()
            })
            
            # Broadcast presence update
            self.broadcast_awareness({
                'type': 'presence_update',
                'user_id': self.user_id,
                'presence': self.awareness_state
            })
            
        except Exception as e:
            self.logger.error(f"Error handling presence update: {e}")
    
    def broadcast_awareness(self, awareness_data: Dict[str, Any]) -> None:
        """
        Broadcast awareness update to all clients.
        
        Args:
            awareness_data: Awareness data to broadcast
        """
        self._broadcast_to_document(MESSAGE_TYPE_AWARENESS, {
            'subtype': AWARENESS_UPDATE,
            'data': awareness_data,
            'timestamp': time.time()
        })
    
    def _start_presence_updates(self) -> None:
        """Start periodic presence updates."""
        def send_presence_update():
            try:
                self.awareness_state['last_seen'] = datetime.now(timezone.utc).isoformat()
                self.broadcast_awareness({
                    'type': 'presence_heartbeat',
                    'user_id': self.user_id,
                    'presence': self.awareness_state
                })
                
                # Schedule next update
                self.presence_timer = Timer(30, send_presence_update)
                self.presence_timer.start()
                
            except Exception as e:
                self.logger.error(f"Error in presence update: {e}")
        
        # Start first update
        self.presence_timer = Timer(30, send_presence_update)
        self.presence_timer.start()
    
    def _broadcast_user_connection(self) -> None:
        """Broadcast user connection to other clients."""
        self._broadcast_to_document(MESSAGE_TYPE_AWARENESS, {
            'subtype': AWARENESS_UPDATE,
            'data': {
                'type': 'user_connected',
                'user_id': self.user_id,
                'user_info': getattr(self, 'user_info', {}),
                'presence': self.awareness_state
            }
        })
    
    def _send_awareness_state(self) -> None:
        """Send current awareness state to client."""
        # Get awareness state for all connected users
        with _connection_lock:
            connections = _active_connections.get(self.document_id, set())
            users_state = []
            
            for connection in connections:
                if hasattr(connection, 'awareness_state'):
                    users_state.append({
                        'user_id': connection.user_id,
                        'user_info': getattr(connection, 'user_info', {}),
                        'presence': connection.awareness_state,
                        'cursor': getattr(connection, 'cursor_position', {})
                    })
        
        self._send_message(MESSAGE_TYPE_AWARENESS, {
            'subtype': AWARENESS_UPDATE,
            'data': {
                'type': 'awareness_state',
                'users': users_state
            }
        })
    
    def handle_sync(self, message_data: Dict[str, Any]) -> None:
        """Handle sync message - not implemented in awareness handler."""
        self._send_error("Sync not supported in awareness handler")
    
    def handle_comments(self, message_data: Dict[str, Any]) -> None:
        """Handle comments message - not implemented in awareness handler."""
        self._send_error("Comments not supported in awareness handler")


class CollaborationCommentsHandler(BaseCollaborationHandler):
    """
    WebSocket handler for cell-level comments and annotations.
    
    This handler manages comment creation, updates, resolution, and
    real-time synchronization of discussion threads for collaborative
    notebook editing.
    """
    
    def initialize(self, storage: CollaborativeStorage, app: JupyterNotebookApp):
        """Initialize the comments handler."""
        super().initialize(storage, app)
        self.active_comments: Dict[str, Dict[str, Any]] = {}
    
    def open(self, document_path: str):
        """Open comments connection and load existing comments."""
        super().open(document_path)
        
        try:
            # Load existing comments
            asyncio.create_task(self._load_comments())
            
        except Exception as e:
            self.logger.error(f"Failed to initialize comments handler: {e}")
            self.close(code=1011, reason=str(e))
    
    def handle_comments(self, message_data: Dict[str, Any]) -> None:
        """
        Handle comments message.
        
        Args:
            message_data: Comments message data
        """
        try:
            if not self.validate_permissions('write'):
                self._send_error("Insufficient permissions for comments")
                return
            
            subtype = message_data.get('subtype', COMMENT_CREATE)
            
            if subtype == COMMENT_CREATE:
                self.handle_comment_create(message_data)
            elif subtype == COMMENT_UPDATE:
                self.handle_comment_update(message_data)
            elif subtype == COMMENT_RESOLVE:
                self.handle_comment_resolve(message_data)
            else:
                self.logger.warning(f"Unknown comments subtype: {subtype}")
        
        except Exception as e:
            self.logger.error(f"Error in comments handler: {e}")
            self._send_error(f"Comments error: {e}")
    
    def handle_comment_create(self, message_data: Dict[str, Any]) -> None:
        """
        Handle comment creation.
        
        Args:
            message_data: Comment creation message data
        """
        try:
            comment_data = message_data.get('comment', {})
            
            # Validate required fields
            cell_id = comment_data.get('cell_id')
            content = comment_data.get('content')
            
            if not cell_id or not content:
                self._send_error("Missing required comment fields")
                return
            
            # Create comment
            comment_id = str(uuid.uuid4())
            comment_record = {
                'comment_id': comment_id,
                'cell_id': cell_id,
                'content': content,
                'user_id': self.user_id,
                'username': getattr(self, 'user_info', {}).get('username', self.user_id),
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'parent_id': comment_data.get('parent_id'),
                'resolved': False,
                'metadata': comment_data.get('metadata', {})
            }
            
            # Store comment
            asyncio.create_task(self._store_comment(comment_record))
            
            # Add to active comments
            self.active_comments[comment_id] = comment_record
            
            # Broadcast comment creation
            self._broadcast_to_document(MESSAGE_TYPE_COMMENTS, {
                'subtype': COMMENT_CREATE,
                'comment': comment_record
            })
            
        except Exception as e:
            self.logger.error(f"Error creating comment: {e}")
            self._send_error(f"Comment creation error: {e}")
    
    def handle_comment_update(self, message_data: Dict[str, Any]) -> None:
        """
        Handle comment update.
        
        Args:
            message_data: Comment update message data
        """
        try:
            comment_data = message_data.get('comment', {})
            comment_id = comment_data.get('comment_id')
            
            if not comment_id:
                self._send_error("Missing comment ID")
                return
            
            # Check if comment exists and user has permission
            if comment_id not in self.active_comments:
                self._send_error("Comment not found")
                return
            
            existing_comment = self.active_comments[comment_id]
            if existing_comment['user_id'] != self.user_id and not self.validate_permissions('admin'):
                self._send_error("Insufficient permissions to update comment")
                return
            
            # Update comment
            existing_comment.update({
                'content': comment_data.get('content', existing_comment['content']),
                'modified_timestamp': datetime.now(timezone.utc).isoformat(),
                'metadata': comment_data.get('metadata', existing_comment['metadata'])
            })
            
            # Store updated comment
            asyncio.create_task(self._store_comment(existing_comment))
            
            # Broadcast comment update
            self._broadcast_to_document(MESSAGE_TYPE_COMMENTS, {
                'subtype': COMMENT_UPDATE,
                'comment': existing_comment
            })
            
        except Exception as e:
            self.logger.error(f"Error updating comment: {e}")
            self._send_error(f"Comment update error: {e}")
    
    def handle_comment_resolve(self, message_data: Dict[str, Any]) -> None:
        """
        Handle comment resolution.
        
        Args:
            message_data: Comment resolution message data
        """
        try:
            comment_id = message_data.get('comment_id')
            resolved = message_data.get('resolved', True)
            
            if not comment_id:
                self._send_error("Missing comment ID")
                return
            
            # Check if comment exists
            if comment_id not in self.active_comments:
                self._send_error("Comment not found")
                return
            
            # Update comment resolution status
            comment_record = self.active_comments[comment_id]
            comment_record.update({
                'resolved': resolved,
                'resolved_by': self.user_id,
                'resolved_timestamp': datetime.now(timezone.utc).isoformat()
            })
            
            # Store updated comment
            asyncio.create_task(self._store_comment(comment_record))
            
            # Broadcast comment resolution
            self._broadcast_to_document(MESSAGE_TYPE_COMMENTS, {
                'subtype': COMMENT_RESOLVE,
                'comment_id': comment_id,
                'resolved': resolved,
                'resolved_by': self.user_id
            })
            
        except Exception as e:
            self.logger.error(f"Error resolving comment: {e}")
            self._send_error(f"Comment resolution error: {e}")
    
    async def _load_comments(self) -> None:
        """Load existing comments from storage."""
        try:
            comments = await self.storage.get_comments(self.document_id)
            
            for comment_record in comments:
                comment_data = {
                    'comment_id': comment_record.comment_id,
                    'cell_id': comment_record.cell_id,
                    'user_id': comment_record.user_id,
                    'timestamp': comment_record.timestamp.isoformat(),
                    'parent_id': comment_record.parent_id,
                    **comment_record.comment_data
                }
                
                self.active_comments[comment_record.comment_id] = comment_data
            
            # Send loaded comments to client
            self._send_message(MESSAGE_TYPE_COMMENTS, {
                'subtype': COMMENT_UPDATE,
                'comments': list(self.active_comments.values())
            })
            
            self.logger.debug(f"Loaded {len(comments)} comments for document {self.document_id}")
            
        except Exception as e:
            self.logger.error(f"Failed to load comments: {e}")
    
    async def _store_comment(self, comment_record: Dict[str, Any]) -> None:
        """
        Store comment in persistent storage.
        
        Args:
            comment_record: Comment record to store
        """
        try:
            await self.storage.store_comment(
                self.document_id,
                comment_record['cell_id'],
                comment_record['comment_id'],
                comment_record['user_id'],
                comment_record
            )
            
            self.logger.debug(f"Stored comment {comment_record['comment_id']}")
            
        except Exception as e:
            self.logger.error(f"Failed to store comment: {e}")
    
    def handle_sync(self, message_data: Dict[str, Any]) -> None:
        """Handle sync message - not implemented in comments handler."""
        self._send_error("Sync not supported in comments handler")
    
    def handle_awareness(self, message_data: Dict[str, Any]) -> None:
        """Handle awareness message - not implemented in comments handler."""
        self._send_error("Awareness not supported in comments handler")


def register_collaboration_handlers(app: JupyterNotebookApp) -> None:
    """
    Register collaboration WebSocket handlers with the Jupyter application.
    
    Args:
        app: Jupyter notebook application instance
    """
    try:
        # Initialize collaborative storage
        storage = CollaborativeStorage(app=app)
        
        # Initialize global rate limiter
        global _rate_limiters
        _rate_limiters['global'] = CollaborationRateLimiter()
        
        # Register WebSocket handlers
        handlers = [
            (
                r'/api/collaboration/(.+)/sync',
                CollaborationSyncHandler,
                {'storage': storage, 'app': app}
            ),
            (
                r'/api/collaboration/(.+)/awareness',
                CollaborationAwarenessHandler,
                {'storage': storage, 'app': app}
            ),
            (
                r'/api/collaboration/(.+)/comments',
                CollaborationCommentsHandler,
                {'storage': storage, 'app': app}
            ),
        ]
        
        # Add handlers to the web application
        if hasattr(app, 'web_app') and hasattr(app.web_app, 'add_handlers'):
            app.web_app.add_handlers('.*', handlers)
        elif hasattr(app, 'serverapp') and hasattr(app.serverapp, 'web_app'):
            app.serverapp.web_app.add_handlers('.*', handlers)
        else:
            # Fallback: add to handlers list
            if not hasattr(app, 'handlers'):
                app.handlers = []
            app.handlers.extend(handlers)
        
        # Setup storage
        asyncio.create_task(storage.setup_storage())
        
        # Store storage reference for cleanup
        app._collaboration_storage = storage
        
        logger.info("Collaboration handlers registered successfully")
        
    except Exception as e:
        logger.error(f"Failed to register collaboration handlers: {e}")
        raise


# Cleanup function for graceful shutdown
async def cleanup_collaboration_handlers(app: JupyterNotebookApp) -> None:
    """
    Clean up collaboration handlers and resources.
    
    Args:
        app: Jupyter notebook application instance
    """
    try:
        # Clean up storage
        if hasattr(app, '_collaboration_storage'):
            await app._collaboration_storage.cleanup_storage()
        
        # Clean up rate limiters
        global _rate_limiters
        _rate_limiters.clear()
        
        # Clean up connection tracking
        global _active_connections, _user_connections
        _active_connections.clear()
        _user_connections.clear()
        
        logger.info("Collaboration handlers cleaned up successfully")
        
    except Exception as e:
        logger.error(f"Failed to clean up collaboration handlers: {e}")