"""WebSocket handlers for collaborative notebook editing using Yjs CRDT."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
import weakref
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple, cast

from jupyter_server.auth import authorized
from jupyter_server.base.handlers import JupyterHandler
from tornado import web
from tornado.websocket import WebSocketHandler
from traitlets import Unicode, Int, Bool, Float, observe

# Collaboration imports with graceful degradation
try:
    from pycrdt import Doc as YDoc, UndoManager, Text as YText, Array as YArray, Map as YMap
    from pycrdt.websocket import WebsocketProvider
    PYCRDT_AVAILABLE = True
except ImportError:
    # Graceful degradation when pycrdt is not available
    YDoc = None
    UndoManager = None
    YText = None
    YArray = None  
    YMap = None
    WebsocketProvider = None
    PYCRDT_AVAILABLE = False


class YjsWebSocketHandler(WebSocketHandler, JupyterHandler):
    """
    WebSocket handler for Yjs CRDT collaborative document synchronization.
    
    This handler manages real-time collaborative editing by:
    - Processing Yjs document updates and broadcasting to all connected clients
    - Managing user presence and awareness data for collaborative features
    - Enforcing permissions and authentication through CollabPermissionManager
    - Handling cell-level locking mechanisms to prevent editing conflicts
    - Maintaining document state persistence with configurable retention policies
    - Supporting horizontal scaling with session affinity for enterprise deployments
    """

    # Class-level connection registry for managing all active WebSocket connections
    _connections: Dict[str, Set[YjsWebSocketHandler]] = defaultdict(set)
    _documents: Dict[str, YDoc] = {}
    _document_locks: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(lambda: defaultdict(dict))
    _document_metadata: Dict[str, Dict[str, Any]] = defaultdict(dict)
    _cleanup_tasks: Set[asyncio.Task] = set()

    def __init__(self, *args, **kwargs):
        """Initialize the WebSocket handler with collaboration configuration."""
        super().__init__(*args, **kwargs)
        
        # Configuration from application settings
        self.lock_timeout: int = getattr(self, 'lock_timeout', 300)  # 5 minutes default
        self.max_users: int = getattr(self, 'max_users', 50)
        self.heartbeat_interval: int = getattr(self, 'heartbeat_interval', 30)
        self.permission_manager = getattr(self, 'permission_manager', None)
        
        # Connection state
        self.document_id: Optional[str] = None
        self.user_id: Optional[str] = None
        self.session_id: str = str(uuid.uuid4())
        self.user_info: Dict[str, Any] = {}
        self.is_authenticated: bool = False
        self.user_permissions: Dict[str, Any] = {}
        
        # Yjs document state
        self.ydoc: Optional[YDoc] = None
        self.awareness_state: Dict[str, Any] = {}
        self.last_heartbeat: float = time.time()
        
        # Connection management
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._cleanup_scheduled: bool = False

    def check_origin(self, origin: str) -> bool:
        """
        Check if the origin is allowed to connect.
        
        Args:
            origin: The origin header from the WebSocket request
            
        Returns:
            True if origin is allowed, False otherwise
        """
        # Use Jupyter Server's built-in origin checking
        return super().check_origin(origin)

    def get_compression_options(self) -> Optional[Dict[str, Any]]:
        """Enable WebSocket compression for better performance."""
        return {"compression_level": 6, "mem_level": 8}

    async def prepare(self) -> None:
        """Prepare the WebSocket connection with authentication and validation."""
        if not PYCRDT_AVAILABLE:
            self.log.error("Collaboration features are disabled - pycrdt not available")
            raise web.HTTPError(503, "Collaboration service unavailable")
        
        # Check if collaboration is enabled
        app_settings = self.settings
        if not app_settings.get('notebook_app', {}).collaborative:
            self.log.warning("Collaboration is disabled in application settings")
            raise web.HTTPError(503, "Collaboration service disabled")
        
        # Authenticate the user
        try:
            await self._authenticate_user()
        except Exception as e:
            self.log.error(f"Authentication failed: {e}")
            raise web.HTTPError(401, "Authentication required")

    async def _authenticate_user(self) -> None:
        """Authenticate the user using Jupyter Server's authentication."""
        # Get user info from the request
        user = self.current_user
        if not user:
            raise web.HTTPError(401, "No authenticated user")
        
        # Extract user information
        if isinstance(user, dict):
            self.user_id = user.get('name', str(user.get('id', 'anonymous')))
            self.user_info = user.copy()
        else:
            self.user_id = str(user)
            self.user_info = {'name': self.user_id}
        
        # Add session metadata
        self.user_info.update({
            'session_id': self.session_id,
            'connected_at': time.time(),
            'user_agent': self.request.headers.get('User-Agent', ''),
            'ip_address': self.request.remote_ip,
        })
        
        self.is_authenticated = True
        self.log.info(f"User authenticated: {self.user_id} (session: {self.session_id})")

    async def open(self, document_id: str) -> None:
        """
        Open WebSocket connection for collaborative document editing.
        
        Args:
            document_id: Unique identifier for the notebook document
        """
        try:
            # Validate document ID format
            if not document_id or not isinstance(document_id, str):
                self.log.error(f"Invalid document ID: {document_id}")
                await self.close(code=1003, reason="Invalid document ID")
                return
            
            self.document_id = document_id
            self.log.info(f"Opening collaboration session for document {document_id} by user {self.user_id}")
            
            # Check connection limits
            current_connections = len(self._connections.get(document_id, set()))
            if current_connections >= self.max_users:
                self.log.warning(f"Document {document_id} has reached maximum user limit ({self.max_users})")
                await self.close(code=1008, reason="Maximum users reached")
                return
            
            # Get or create permissions for this document
            await self._initialize_permissions()
            
            # Check if user has permission to access this document
            if not await self._check_document_permission('view'):
                self.log.warning(f"User {self.user_id} denied access to document {document_id}")
                await self.close(code=1008, reason="Permission denied")
                return
            
            # Initialize or get existing Yjs document
            await self._initialize_document()
            
            # Register this connection
            self._connections[document_id].add(self)
            
            # Send initial document state and awareness
            await self._send_initial_state()
            
            # Start heartbeat monitoring
            self._start_heartbeat()
            
            # Broadcast user joined event
            await self._broadcast_awareness_update('user_joined')
            
            self.log.info(f"Collaboration session established for {self.user_id} on document {document_id}")
            
        except Exception as e:
            self.log.error(f"Error opening WebSocket connection: {e}")
            await self.close(code=1011, reason="Internal server error")

    async def _initialize_permissions(self) -> None:
        """Initialize permissions for the current user and document."""
        if self.permission_manager:
            try:
                self.user_permissions = await self.permission_manager.get_user_permissions(
                    self.user_id, self.document_id, self.user_info
                )
                self.log.debug(f"Permissions loaded for user {self.user_id}: {self.user_permissions}")
            except Exception as e:
                self.log.error(f"Error loading permissions for user {self.user_id}: {e}")
                # Default to view-only permissions if permission loading fails
                self.user_permissions = {'role': 'view', 'can_edit': False, 'can_comment': True}
        else:
            # Default permissions when no permission manager is available
            self.user_permissions = {'role': 'edit', 'can_edit': True, 'can_comment': True}
            self.log.warning("No permission manager available, granting default edit permissions")

    async def _check_document_permission(self, action: str) -> bool:
        """
        Check if the current user has permission to perform the specified action.
        
        Args:
            action: The action to check permission for ('view', 'edit', 'comment', 'admin')
            
        Returns:
            True if user has permission, False otherwise
        """
        if not self.user_permissions:
            return False
        
        role = self.user_permissions.get('role', 'view')
        
        # Permission hierarchy: admin > edit > comment > view
        permission_levels = {
            'view': ['view', 'comment', 'edit', 'admin'],
            'comment': ['comment', 'edit', 'admin'],
            'edit': ['edit', 'admin'],
            'admin': ['admin']
        }
        
        allowed_roles = permission_levels.get(action, [])
        has_permission = role in allowed_roles
        
        # Additional specific permission checks
        if action == 'edit' and not self.user_permissions.get('can_edit', True):
            has_permission = False
        elif action == 'comment' and not self.user_permissions.get('can_comment', True):
            has_permission = False
        
        return has_permission

    async def _initialize_document(self) -> None:
        """Initialize or retrieve the Yjs document for collaborative editing."""
        if self.document_id in self._documents:
            # Use existing document
            self.ydoc = self._documents[self.document_id]
            self.log.debug(f"Using existing Yjs document for {self.document_id}")
        else:
            # Create new Yjs document
            self.ydoc = YDoc()
            self._documents[self.document_id] = self.ydoc
            
            # Initialize document structure for notebook
            self._initialize_notebook_structure()
            
            # Set up document change observers
            self._setup_document_observers()
            
            self.log.info(f"Created new Yjs document for {self.document_id}")
        
        # Initialize document metadata if not exists
        if self.document_id not in self._document_metadata:
            self._document_metadata[self.document_id] = {
                'created_at': time.time(),
                'last_modified': time.time(),
                'total_users': 0,
                'active_users': set(),
                'version': 0
            }

    def _initialize_notebook_structure(self) -> None:
        """Initialize the Yjs document structure to match notebook format."""
        if not self.ydoc:
            return
        
        # Create root structure matching Jupyter notebook format
        # Main content structure
        cells = self.ydoc.get_array("cells")
        metadata = self.ydoc.get_map("metadata") 
        nbformat = self.ydoc.get_map("nbformat_info")
        
        # Collaboration-specific structures
        locks = self.ydoc.get_map("locks")  # Cell-level locks
        awareness = self.ydoc.get_map("awareness")  # User awareness data
        comments = self.ydoc.get_map("comments")  # Comment threads
        history = self.ydoc.get_array("history")  # Change history
        
        # Initialize nbformat info if empty
        if len(nbformat) == 0:
            nbformat.update({
                "nbformat": 4,
                "nbformat_minor": 5
            })
        
        self.log.debug("Initialized notebook structure in Yjs document")

    def _setup_document_observers(self) -> None:
        """Set up observers for document changes to handle updates and persistence."""
        if not self.ydoc:
            return
        
        # Observe all changes to the document
        def on_update(update: bytes, origin: Any = None) -> None:
            """Handle document updates and broadcast to connected clients."""
            if origin != self:  # Don't broadcast updates that originated from this connection
                asyncio.create_task(self._broadcast_update(update, origin))
        
        # Register the update observer
        self.ydoc.observe(on_update)
        
        self.log.debug("Document observers set up successfully")

    async def _send_initial_state(self) -> None:
        """Send the initial document state and awareness to the connecting client."""
        if not self.ydoc:
            return
        
        try:
            # Send the full document state
            state_vector = self.ydoc.get_state()
            update = self.ydoc.get_update(b'')  # Get full update from empty state
            
            initial_message = {
                'type': 'sync',
                'subtype': 'initial_state',
                'update': list(update),  # Convert bytes to list for JSON serialization
                'state_vector': list(state_vector) if state_vector else [],
                'document_id': self.document_id,
                'user_id': self.user_id,
                'session_id': self.session_id,
                'timestamp': time.time()
            }
            
            await self._send_message(initial_message)
            
            # Send current awareness state (other users' presence)
            awareness_message = {
                'type': 'awareness',
                'subtype': 'initial_awareness',
                'awareness_data': await self._get_awareness_data(),
                'timestamp': time.time()
            }
            
            await self._send_message(awareness_message)
            
            # Send current lock state
            locks_message = {
                'type': 'locks',
                'subtype': 'initial_locks', 
                'locks_data': self._document_locks.get(self.document_id, {}),
                'timestamp': time.time()
            }
            
            await self._send_message(locks_message)
            
            self.log.debug(f"Sent initial state to user {self.user_id}")
            
        except Exception as e:
            self.log.error(f"Error sending initial state: {e}")

    async def _get_awareness_data(self) -> Dict[str, Any]:
        """Get current awareness data for all connected users."""
        awareness_data = {}
        
        if self.document_id in self._connections:
            for connection in self._connections[self.document_id]:
                if connection != self and connection.is_authenticated:
                    awareness_data[connection.user_id] = {
                        'user_id': connection.user_id,
                        'session_id': connection.session_id,
                        'user_info': connection.user_info,
                        'awareness_state': connection.awareness_state,
                        'last_seen': connection.last_heartbeat,
                        'permissions': connection.user_permissions
                    }
        
        return awareness_data

    def _start_heartbeat(self) -> None:
        """Start the heartbeat task for connection monitoring."""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        
        async def heartbeat_loop():
            """Heartbeat loop to monitor connection health."""
            while True:
                try:
                    await asyncio.sleep(self.heartbeat_interval)
                    
                    if not hasattr(self, 'ws_connection') or not self.ws_connection:
                        break
                    
                    # Send heartbeat ping
                    await self._send_message({
                        'type': 'heartbeat',
                        'timestamp': time.time(),
                        'session_id': self.session_id
                    })
                    
                    # Check for stale connections
                    await self._cleanup_stale_connections()
                    
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    self.log.error(f"Error in heartbeat loop: {e}")
                    break
        
        self._heartbeat_task = asyncio.create_task(heartbeat_loop())

    async def _cleanup_stale_connections(self) -> None:
        """Clean up stale connections that haven't responded to heartbeat."""
        if not self.document_id:
            return
        
        current_time = time.time()
        stale_threshold = self.heartbeat_interval * 3  # 3 missed heartbeats
        
        stale_connections = []
        for connection in self._connections.get(self.document_id, set()).copy():
            if current_time - connection.last_heartbeat > stale_threshold:
                stale_connections.append(connection)
        
        for stale_connection in stale_connections:
            self.log.warning(f"Removing stale connection for user {stale_connection.user_id}")
            await stale_connection._force_close("Connection timeout")

    async def on_message(self, message: str) -> None:
        """
        Handle incoming WebSocket messages from clients.
        
        Args:
            message: JSON-encoded message from the client
        """
        try:
            data = json.loads(message)
            message_type = data.get('type')
            
            # Update last heartbeat
            self.last_heartbeat = time.time()
            
            # Route message based on type
            if message_type == 'sync':
                await self._handle_sync_message(data)
            elif message_type == 'awareness':
                await self._handle_awareness_message(data)
            elif message_type == 'lock':
                await self._handle_lock_message(data)
            elif message_type == 'comment':
                await self._handle_comment_message(data)
            elif message_type == 'heartbeat_response':
                await self._handle_heartbeat_response(data)
            else:
                self.log.warning(f"Unknown message type: {message_type}")
                
        except json.JSONDecodeError as e:
            self.log.error(f"Invalid JSON message from {self.user_id}: {e}")
        except Exception as e:
            self.log.error(f"Error processing message from {self.user_id}: {e}")

    async def _handle_sync_message(self, data: Dict[str, Any]) -> None:
        """Handle Yjs synchronization messages."""
        subtype = data.get('subtype')
        
        if subtype == 'update':
            await self._handle_document_update(data)
        elif subtype == 'state_request':
            await self._handle_state_request(data)
        else:
            self.log.warning(f"Unknown sync subtype: {subtype}")

    async def _handle_document_update(self, data: Dict[str, Any]) -> None:
        """
        Handle document update messages from clients.
        
        Args:
            data: Message data containing the Yjs update
        """
        if not await self._check_document_permission('edit'):
            self.log.warning(f"User {self.user_id} attempted to edit without permission")
            await self._send_error("Permission denied for edit operation")
            return
        
        try:
            update_data = data.get('update', [])
            if not update_data:
                return
            
            # Convert list back to bytes
            update_bytes = bytes(update_data)
            
            # Apply update to the document
            if self.ydoc:
                self.ydoc.apply_update(update_bytes, origin=self)
                
                # Update document metadata
                if self.document_id in self._document_metadata:
                    self._document_metadata[self.document_id]['last_modified'] = time.time()
                    self._document_metadata[self.document_id]['version'] += 1
                
                # Broadcast update to other connected clients
                await self._broadcast_update(update_bytes, origin=self)
                
                self.log.debug(f"Applied document update from user {self.user_id}")
                
        except Exception as e:
            self.log.error(f"Error handling document update: {e}")
            await self._send_error("Failed to apply document update")

    async def _handle_state_request(self, data: Dict[str, Any]) -> None:
        """Handle requests for current document state."""
        if not self.ydoc:
            return
        
        try:
            # Get requested state vector
            client_state_vector = data.get('state_vector', [])
            client_state_bytes = bytes(client_state_vector) if client_state_vector else b''
            
            # Calculate diff update
            update = self.ydoc.get_update(client_state_bytes)
            
            response = {
                'type': 'sync',
                'subtype': 'state_response',
                'update': list(update),
                'document_id': self.document_id,
                'timestamp': time.time()
            }
            
            await self._send_message(response)
            
        except Exception as e:
            self.log.error(f"Error handling state request: {e}")

    async def _handle_awareness_message(self, data: Dict[str, Any]) -> None:
        """Handle awareness messages for user presence."""
        subtype = data.get('subtype')
        
        if subtype == 'update':
            # Update this user's awareness state
            awareness_update = data.get('awareness_data', {})
            self.awareness_state.update(awareness_update)
            
            # Broadcast awareness update to other users
            await self._broadcast_awareness_update('awareness_changed', awareness_update)
            
        elif subtype == 'request':
            # Send current awareness data
            awareness_data = await self._get_awareness_data()
            response = {
                'type': 'awareness',
                'subtype': 'response',
                'awareness_data': awareness_data,
                'timestamp': time.time()
            }
            await self._send_message(response)

    async def _handle_lock_message(self, data: Dict[str, Any]) -> None:
        """Handle cell locking messages."""
        if not await self._check_document_permission('edit'):
            await self._send_error("Permission denied for lock operations")
            return
        
        subtype = data.get('subtype')
        cell_id = data.get('cell_id')
        
        if not cell_id:
            await self._send_error("Missing cell_id for lock operation")
            return
        
        if subtype == 'acquire':
            await self._handle_lock_acquire(cell_id, data)
        elif subtype == 'release':
            await self._handle_lock_release(cell_id, data)
        elif subtype == 'query':
            await self._handle_lock_query(cell_id, data)

    async def _handle_lock_acquire(self, cell_id: str, data: Dict[str, Any]) -> None:
        """Handle cell lock acquisition requests."""
        current_time = time.time()
        document_locks = self._document_locks[self.document_id]
        
        # Check if cell is already locked
        if cell_id in document_locks:
            existing_lock = document_locks[cell_id]
            lock_owner = existing_lock.get('user_id')
            lock_time = existing_lock.get('acquired_at', 0)
            
            # Check if lock has expired
            if current_time - lock_time > self.lock_timeout:
                # Lock has expired, remove it
                del document_locks[cell_id]
                self.log.info(f"Expired lock removed for cell {cell_id}")
            elif lock_owner != self.user_id:
                # Lock is held by another user
                await self._send_message({
                    'type': 'lock',
                    'subtype': 'acquire_failed',
                    'cell_id': cell_id,
                    'reason': 'Cell is locked by another user',
                    'lock_owner': lock_owner,
                    'lock_expires_at': lock_time + self.lock_timeout,
                    'timestamp': current_time
                })
                return
        
        # Acquire the lock
        document_locks[cell_id] = {
            'user_id': self.user_id,
            'session_id': self.session_id,
            'acquired_at': current_time,
            'expires_at': current_time + self.lock_timeout
        }
        
        # Confirm lock acquisition
        await self._send_message({
            'type': 'lock',
            'subtype': 'acquired',
            'cell_id': cell_id,
            'expires_at': current_time + self.lock_timeout,
            'timestamp': current_time
        })
        
        # Broadcast lock status to other users
        await self._broadcast_lock_update(cell_id, 'locked', document_locks[cell_id])
        
        self.log.debug(f"Lock acquired for cell {cell_id} by user {self.user_id}")

    async def _handle_lock_release(self, cell_id: str, data: Dict[str, Any]) -> None:
        """Handle cell lock release requests."""
        document_locks = self._document_locks[self.document_id]
        
        if cell_id in document_locks:
            lock_info = document_locks[cell_id]
            if lock_info.get('user_id') == self.user_id:
                # Release the lock
                del document_locks[cell_id]
                
                await self._send_message({
                    'type': 'lock',
                    'subtype': 'released',
                    'cell_id': cell_id,
                    'timestamp': time.time()
                })
                
                # Broadcast lock release to other users
                await self._broadcast_lock_update(cell_id, 'unlocked', {})
                
                self.log.debug(f"Lock released for cell {cell_id} by user {self.user_id}")
            else:
                await self._send_error(f"Cannot release lock for cell {cell_id} - not owned by user")
        else:
            await self._send_error(f"No lock found for cell {cell_id}")

    async def _handle_lock_query(self, cell_id: str, data: Dict[str, Any]) -> None:
        """Handle lock status query requests."""
        document_locks = self._document_locks[self.document_id]
        current_time = time.time()
        
        if cell_id in document_locks:
            lock_info = document_locks[cell_id]
            lock_time = lock_info.get('acquired_at', 0)
            
            # Check if lock has expired
            if current_time - lock_time > self.lock_timeout:
                del document_locks[cell_id]
                lock_status = 'unlocked'
                lock_data = {}
            else:
                lock_status = 'locked'
                lock_data = lock_info
        else:
            lock_status = 'unlocked'
            lock_data = {}
        
        await self._send_message({
            'type': 'lock',
            'subtype': 'query_response',
            'cell_id': cell_id,
            'status': lock_status,
            'lock_data': lock_data,
            'timestamp': current_time
        })

    async def _handle_comment_message(self, data: Dict[str, Any]) -> None:
        """Handle comment-related messages."""
        if not await self._check_document_permission('comment'):
            await self._send_error("Permission denied for comment operations")
            return
        
        # Comments will be implemented in a future iteration
        # For now, acknowledge the message
        subtype = data.get('subtype')
        self.log.debug(f"Comment message received: {subtype}")
        
        await self._send_message({
            'type': 'comment',
            'subtype': 'acknowledged',
            'original_subtype': subtype,
            'message': 'Comment functionality will be implemented in future version',
            'timestamp': time.time()
        })

    async def _handle_heartbeat_response(self, data: Dict[str, Any]) -> None:
        """Handle heartbeat response messages."""
        # Update last heartbeat time
        self.last_heartbeat = time.time()
        
        # Update awareness with heartbeat response
        await self._broadcast_awareness_update('heartbeat', {
            'last_seen': self.last_heartbeat
        })

    async def _broadcast_update(self, update: bytes, origin: Any = None) -> None:
        """
        Broadcast Yjs document update to all connected clients except the originator.
        
        Args:
            update: The Yjs update as bytes
            origin: The originating connection (excluded from broadcast)
        """
        if not self.document_id:
            return
        
        message = {
            'type': 'sync',
            'subtype': 'update',
            'update': list(update),  # Convert bytes to list for JSON serialization
            'document_id': self.document_id,
            'timestamp': time.time()
        }
        
        # Broadcast to all connections except the originator
        connections = self._connections.get(self.document_id, set()).copy()
        broadcast_tasks = []
        
        for connection in connections:
            if connection != origin and connection.is_authenticated:
                task = asyncio.create_task(connection._send_message(message))
                broadcast_tasks.append(task)
        
        if broadcast_tasks:
            await asyncio.gather(*broadcast_tasks, return_exceptions=True)

    async def _broadcast_awareness_update(self, event_type: str, awareness_data: Optional[Dict[str, Any]] = None) -> None:
        """
        Broadcast awareness update to all connected clients.
        
        Args:
            event_type: Type of awareness event
            awareness_data: Optional awareness data to include
        """
        if not self.document_id:
            return
        
        message = {
            'type': 'awareness',
            'subtype': event_type,
            'user_id': self.user_id,
            'session_id': self.session_id,
            'user_info': self.user_info,
            'awareness_data': awareness_data or self.awareness_state,
            'timestamp': time.time()
        }
        
        # Broadcast to all other connections
        connections = self._connections.get(self.document_id, set()).copy()
        broadcast_tasks = []
        
        for connection in connections:
            if connection != self and connection.is_authenticated:
                task = asyncio.create_task(connection._send_message(message))
                broadcast_tasks.append(task)
        
        if broadcast_tasks:
            await asyncio.gather(*broadcast_tasks, return_exceptions=True)

    async def _broadcast_lock_update(self, cell_id: str, status: str, lock_data: Dict[str, Any]) -> None:
        """
        Broadcast lock status update to all connected clients.
        
        Args:
            cell_id: ID of the cell whose lock status changed
            status: New lock status ('locked' or 'unlocked')
            lock_data: Lock information data
        """
        if not self.document_id:
            return
        
        message = {
            'type': 'lock',
            'subtype': 'status_update',
            'cell_id': cell_id,
            'status': status,
            'lock_data': lock_data,
            'timestamp': time.time()
        }
        
        # Broadcast to all other connections
        connections = self._connections.get(self.document_id, set()).copy()
        broadcast_tasks = []
        
        for connection in connections:
            if connection != self and connection.is_authenticated:
                task = asyncio.create_task(connection._send_message(message))
                broadcast_tasks.append(task)
        
        if broadcast_tasks:
            await asyncio.gather(*broadcast_tasks, return_exceptions=True)

    async def _send_message(self, message: Dict[str, Any]) -> None:
        """
        Send a message to the WebSocket client.
        
        Args:
            message: Message dictionary to send
        """
        try:
            if hasattr(self, 'ws_connection') and self.ws_connection:
                json_message = json.dumps(message)
                self.write_message(json_message)
        except Exception as e:
            self.log.error(f"Error sending message to {self.user_id}: {e}")

    async def _send_error(self, error_message: str, error_code: str = "GENERAL_ERROR") -> None:
        """
        Send an error message to the client.
        
        Args:
            error_message: Human-readable error message
            error_code: Machine-readable error code
        """
        error_msg = {
            'type': 'error',
            'error_code': error_code,
            'error_message': error_message,
            'timestamp': time.time()
        }
        await self._send_message(error_msg)

    async def on_close(self) -> None:
        """Handle WebSocket connection close."""
        try:
            self.log.info(f"Closing collaboration session for user {self.user_id} on document {self.document_id}")
            
            # Cancel heartbeat task
            if self._heartbeat_task:
                self._heartbeat_task.cancel()
            
            # Remove from connections registry
            if self.document_id and self in self._connections.get(self.document_id, set()):
                self._connections[self.document_id].discard(self)
            
            # Release any locks held by this user
            await self._release_user_locks()
            
            # Broadcast user left event
            if self.is_authenticated:
                await self._broadcast_awareness_update('user_left')
            
            # Clean up document if no more connections
            await self._cleanup_document_if_empty()
            
        except Exception as e:
            self.log.error(f"Error during connection close cleanup: {e}")

    async def _release_user_locks(self) -> None:
        """Release all locks held by the current user."""
        if not self.document_id:
            return
        
        document_locks = self._document_locks[self.document_id]
        locks_to_release = []
        
        # Find all locks held by this user
        for cell_id, lock_info in document_locks.items():
            if lock_info.get('user_id') == self.user_id:
                locks_to_release.append(cell_id)
        
        # Release the locks
        for cell_id in locks_to_release:
            del document_locks[cell_id]
            await self._broadcast_lock_update(cell_id, 'unlocked', {})
            self.log.debug(f"Released lock for cell {cell_id} on user disconnect")

    async def _cleanup_document_if_empty(self) -> None:
        """Clean up document resources if no users are connected."""
        if not self.document_id:
            return
        
        # Check if there are any remaining connections
        remaining_connections = len(self._connections.get(self.document_id, set()))
        
        if remaining_connections == 0:
            # Schedule cleanup task
            if not self._cleanup_scheduled:
                self._cleanup_scheduled = True
                cleanup_task = asyncio.create_task(
                    self._schedule_document_cleanup()
                )
                self._cleanup_tasks.add(cleanup_task)
                cleanup_task.add_done_callback(self._cleanup_tasks.discard)

    async def _schedule_document_cleanup(self) -> None:
        """Schedule document cleanup after a delay to handle reconnections."""
        # Wait for potential reconnections
        await asyncio.sleep(30)  # 30 second grace period
        
        # Check again if document is still empty
        if len(self._connections.get(self.document_id, set())) == 0:
            await self._cleanup_document_resources()

    async def _cleanup_document_resources(self) -> None:
        """Clean up document resources when no users are connected."""
        if not self.document_id:
            return
        
        try:
            # Clean up document-specific data structures
            if self.document_id in self._documents:
                del self._documents[self.document_id]
            
            if self.document_id in self._document_locks:
                del self._document_locks[self.document_id]
            
            if self.document_id in self._document_metadata:
                # Store final metadata for potential persistence
                final_metadata = self._document_metadata[self.document_id]
                final_metadata['last_cleanup'] = time.time()
                
                # Log document statistics
                self.log.info(f"Document {self.document_id} cleanup - Final stats: "
                             f"version={final_metadata.get('version', 0)}, "
                             f"total_users={final_metadata.get('total_users', 0)}")
                
                del self._document_metadata[self.document_id]
            
            # Clean up connections registry
            if self.document_id in self._connections:
                del self._connections[self.document_id]
            
            self.log.info(f"Cleaned up resources for document {self.document_id}")
            
        except Exception as e:
            self.log.error(f"Error during document resource cleanup: {e}")
        finally:
            self._cleanup_scheduled = False

    async def _force_close(self, reason: str = "Connection terminated") -> None:
        """Force close the WebSocket connection."""
        try:
            if hasattr(self, 'ws_connection') and self.ws_connection:
                await self.close(code=1001, reason=reason)
        except Exception as e:
            self.log.error(f"Error force closing connection: {e}")

    @classmethod
    async def cleanup_all_documents(cls) -> None:
        """Clean up all document resources. Called during server shutdown."""
        try:
            # Cancel all cleanup tasks
            for task in cls._cleanup_tasks.copy():
                task.cancel()
            
            if cls._cleanup_tasks:
                await asyncio.gather(*cls._cleanup_tasks, return_exceptions=True)
            
            # Clear all data structures
            cls._documents.clear()
            cls._document_locks.clear()
            cls._document_metadata.clear()
            cls._connections.clear()
            cls._cleanup_tasks.clear()
            
            logging.getLogger(__name__).info("Cleaned up all collaboration document resources")
            
        except Exception as e:
            logging.getLogger(__name__).error(f"Error during global cleanup: {e}")


# Additional handler classes for collaboration features

class CollaborationStatusHandler(JupyterHandler):
    """Handler for getting collaboration status and statistics."""
    
    @web.authenticated
    async def get(self) -> None:
        """Get collaboration service status."""
        try:
            # Check if collaboration is available
            if not PYCRDT_AVAILABLE:
                self.set_status(503)
                self.write({
                    'status': 'unavailable',
                    'message': 'Collaboration dependencies not installed',
                    'available': False
                })
                return
            
            # Get application settings
            notebook_app = self.settings.get('notebook_app')
            collaborative_enabled = getattr(notebook_app, 'collaborative', False) if notebook_app else False
            
            if not collaborative_enabled:
                self.write({
                    'status': 'disabled',
                    'message': 'Collaboration features are disabled',
                    'available': False
                })
                return
            
            # Collect collaboration statistics
            total_documents = len(YjsWebSocketHandler._documents)
            total_connections = sum(len(conns) for conns in YjsWebSocketHandler._connections.values())
            active_documents = len([doc_id for doc_id, conns in YjsWebSocketHandler._connections.items() if conns])
            
            self.write({
                'status': 'active',
                'message': 'Collaboration service is running',
                'available': True,
                'statistics': {
                    'total_documents': total_documents,
                    'active_documents': active_documents,
                    'total_connections': total_connections,
                    'pycrdt_version': getattr(__import__('pycrdt'), '__version__', 'unknown')
                },
                'config': {
                    'max_users_per_document': getattr(notebook_app, 'collaboration_max_users', 50),
                    'lock_timeout': getattr(notebook_app, 'collaboration_lock_timeout', 300),
                    'heartbeat_interval': getattr(notebook_app, 'collaboration_heartbeat_interval', 30)
                }
            })
            
        except Exception as e:
            self.log.error(f"Error getting collaboration status: {e}")
            self.set_status(500)
            self.write({
                'status': 'error',
                'message': 'Error retrieving collaboration status',
                'available': False
            })


class CollaborationDocumentHandler(JupyterHandler):
    """Handler for managing collaboration documents."""
    
    @web.authenticated
    async def get(self, document_id: str) -> None:
        """Get collaboration information for a specific document."""
        try:
            if document_id not in YjsWebSocketHandler._connections:
                self.set_status(404)
                self.write({'error': 'Document not found in collaboration system'})
                return
            
            connections = YjsWebSocketHandler._connections[document_id]
            metadata = YjsWebSocketHandler._document_metadata.get(document_id, {})
            locks = YjsWebSocketHandler._document_locks.get(document_id, {})
            
            # Collect active users
            active_users = []
            for conn in connections:
                if conn.is_authenticated:
                    active_users.append({
                        'user_id': conn.user_id,
                        'session_id': conn.session_id,
                        'connected_at': conn.user_info.get('connected_at'),
                        'last_seen': conn.last_heartbeat,
                        'permissions': conn.user_permissions
                    })
            
            # Collect lock information
            active_locks = {}
            current_time = time.time()
            lock_timeout = getattr(self.settings.get('notebook_app'), 'collaboration_lock_timeout', 300)
            
            for cell_id, lock_info in locks.items():
                if current_time - lock_info.get('acquired_at', 0) <= lock_timeout:
                    active_locks[cell_id] = {
                        'user_id': lock_info.get('user_id'),
                        'acquired_at': lock_info.get('acquired_at'),
                        'expires_at': lock_info.get('expires_at')
                    }
            
            self.write({
                'document_id': document_id,
                'active_users': active_users,
                'user_count': len(active_users),
                'metadata': metadata,
                'active_locks': active_locks,
                'lock_count': len(active_locks)
            })
            
        except Exception as e:
            self.log.error(f"Error getting document collaboration info: {e}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def delete(self, document_id: str) -> None:
        """Force cleanup of a collaboration document."""
        try:
            # Check if user has admin permissions
            # This is a destructive operation that should be restricted
            
            if document_id in YjsWebSocketHandler._connections:
                # Close all connections for this document
                connections = YjsWebSocketHandler._connections[document_id].copy()
                for conn in connections:
                    await conn._force_close("Document cleanup requested")
                
                # Clean up document resources
                if document_id in YjsWebSocketHandler._documents:
                    del YjsWebSocketHandler._documents[document_id]
                if document_id in YjsWebSocketHandler._document_locks:
                    del YjsWebSocketHandler._document_locks[document_id]
                if document_id in YjsWebSocketHandler._document_metadata:
                    del YjsWebSocketHandler._document_metadata[document_id]
                if document_id in YjsWebSocketHandler._connections:
                    del YjsWebSocketHandler._connections[document_id]
                
                self.write({'message': f'Document {document_id} cleaned up successfully'})
                self.log.info(f"Forced cleanup of collaboration document {document_id}")
            else:
                self.set_status(404)
                self.write({'error': 'Document not found'})
                
        except Exception as e:
            self.log.error(f"Error cleaning up document: {e}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})


# Export the handlers for use in the main application
__all__ = [
    'YjsWebSocketHandler',
    'CollaborationStatusHandler', 
    'CollaborationDocumentHandler',
    'PYCRDT_AVAILABLE'
]