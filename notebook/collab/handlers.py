"""
WebSocket handler implementation for real-time collaborative document synchronization.

This module implements the YjsWebSocketHandler that serves as the core component for
collaborative notebook editing. It manages CRDT update broadcasting, user presence 
awareness, and collaborative session state using Yjs protocols while integrating
seamlessly with Jupyter Server authentication and providing sub-100ms latency for
collaborative operations.

Key Components:
- YjsWebSocketHandler: Primary WebSocket handler for collaborative synchronization
- CollaborationSessionManager: Manages active collaborative sessions and user state
- MessageBatcher: Optimizes bandwidth usage through intelligent message batching
- HeartbeatManager: Handles connection health monitoring and automatic reconnection
- UpdateBroadcaster: Efficiently distributes CRDT updates to connected clients
"""

import asyncio
import gzip
import json
import time
import uuid
import weakref
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple, Union, Callable, AsyncGenerator
from urllib.parse import parse_qs, urlparse
import struct
import hashlib
import base64

try:
    import pycrdt
    from pycrdt import Doc as YDoc
    HAS_PYCRDT = True
except ImportError:
    HAS_PYCRDT = False
    YDoc = Any

import tornado.web
import tornado.websocket
from tornado.ioloop import IOLoop
from tornado.concurrent import run_on_executor
from concurrent.futures import ThreadPoolExecutor

from jupyter_server.auth import User
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join

from .provider import YjsNotebookProvider, create_yjs_provider, DocumentState, UpdateInfo
from .permissions import (
    PermissionManager, CollaborativeOperation, PermissionMiddleware,
    get_permission_manager, validate_token_and_permissions, UserRole
)
from .utils import (
    CollaborationConfig, CollaborationLogger, CollaborationMetrics,
    CollaborationError, CollaborationConnectionError, CollaborationPermissionError,
    CollaborationStatus, GracefulDegradationManager, RetryConfig,
    error_context, get_collaboration_config, get_collaboration_logger,
    get_collaboration_metrics, get_degradation_manager, monitor_performance,
    sanitize_user_data, with_retry
)


class MessageType(Enum):
    """Types of WebSocket messages for collaborative editing."""
    # Yjs synchronization messages
    YJS_SYNC_STEP1 = "yjs-sync-step1"
    YJS_SYNC_STEP2 = "yjs-sync-step2" 
    YJS_UPDATE = "yjs-update"
    YJS_AWARENESS = "yjs-awareness"
    
    # Authentication and session management
    AUTH_TOKEN = "auth-token"
    AUTH_SUCCESS = "auth-success"
    AUTH_FAILURE = "auth-failure"
    SESSION_JOIN = "session-join"
    SESSION_LEAVE = "session-leave"
    
    # Document operations
    DOCUMENT_OPEN = "document-open"
    DOCUMENT_CLOSE = "document-close"
    DOCUMENT_SAVE = "document-save"
    DOCUMENT_STATE = "document-state"
    
    # Lock management
    LOCK_ACQUIRE = "lock-acquire"
    LOCK_RELEASE = "lock-release"
    LOCK_STATUS = "lock-status"
    LOCK_CONFLICT = "lock-conflict"
    
    # Presence and awareness
    USER_JOIN = "user-join"
    USER_LEAVE = "user-leave"
    USER_LIST = "user-list"
    CURSOR_UPDATE = "cursor-update"
    SELECTION_UPDATE = "selection-update"
    
    # Error handling and status
    ERROR = "error"
    HEARTBEAT = "heartbeat"
    HEARTBEAT_RESPONSE = "heartbeat-response"
    STATUS_UPDATE = "status-update"
    
    # Message batching
    BATCH_START = "batch-start"
    BATCH_END = "batch-end"
    BATCHED_UPDATES = "batched-updates"


@dataclass
class WebSocketMessage:
    """Structured WebSocket message for collaborative editing."""
    type: MessageType
    payload: Dict[str, Any]
    timestamp: float
    message_id: str
    document_id: Optional[str] = None
    user_id: Optional[str] = None
    origin: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert message to dictionary for transmission."""
        return {
            'type': self.type.value,
            'payload': self.payload,
            'timestamp': self.timestamp,
            'message_id': self.message_id,
            'document_id': self.document_id,
            'user_id': self.user_id,
            'origin': self.origin
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'WebSocketMessage':
        """Create message from dictionary."""
        return cls(
            type=MessageType(data['type']),
            payload=data.get('payload', {}),
            timestamp=data.get('timestamp', time.time()),
            message_id=data.get('message_id', str(uuid.uuid4())),
            document_id=data.get('document_id'),
            user_id=data.get('user_id'),
            origin=data.get('origin')
        )


@dataclass
class CollaborationSession:
    """Represents an active collaboration session."""
    session_id: str
    user_id: str
    document_id: str
    websocket_handler: 'YjsWebSocketHandler'
    user_info: Dict[str, Any]
    role: UserRole
    connected_at: float
    last_activity: float
    permissions: Set[CollaborativeOperation]
    cursor_position: Optional[Dict[str, Any]] = None
    active_cell: Optional[str] = None
    
    def update_activity(self):
        """Update last activity timestamp."""
        self.last_activity = time.time()
    
    def get_presence_info(self) -> Dict[str, Any]:
        """Get presence information for this session."""
        return {
            'user_id': self.user_id,
            'session_id': self.session_id,
            'name': self.user_info.get('name', self.user_id),
            'role': self.role.value,
            'cursor_position': self.cursor_position,
            'active_cell': self.active_cell,
            'connected_at': self.connected_at,
            'last_activity': self.last_activity
        }


class MessageBatcher:
    """Batches WebSocket messages to optimize bandwidth usage."""
    
    def __init__(self, batch_size: int = 50, batch_timeout: float = 0.1):
        self.batch_size = batch_size
        self.batch_timeout = batch_timeout
        self.pending_messages: Dict[str, List[WebSocketMessage]] = defaultdict(list)
        self.batch_tasks: Dict[str, asyncio.Task] = {}
        self.logger = get_collaboration_logger()
    
    async def add_message(self, target_id: str, message: WebSocketMessage,
                         send_callback: Callable[[List[WebSocketMessage]], None]):
        """Add message to batch for target."""
        self.pending_messages[target_id].append(message)
        
        # Send immediately if batch is full
        if len(self.pending_messages[target_id]) >= self.batch_size:
            await self._send_batch(target_id, send_callback)
        else:
            # Schedule timeout-based send if not already scheduled
            if target_id not in self.batch_tasks:
                self.batch_tasks[target_id] = asyncio.create_task(
                    self._delayed_send(target_id, send_callback)
                )
    
    async def _delayed_send(self, target_id: str, send_callback: Callable):
        """Send batch after timeout delay."""
        try:
            await asyncio.sleep(self.batch_timeout)
            await self._send_batch(target_id, send_callback)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.logger.log_error(e, {
                "context": "batch_delayed_send",
                "target_id": target_id
            })
    
    async def _send_batch(self, target_id: str, send_callback: Callable):
        """Send pending messages as batch."""
        if target_id in self.pending_messages and self.pending_messages[target_id]:
            messages = self.pending_messages[target_id].copy()
            self.pending_messages[target_id].clear()
            
            # Cancel pending task if exists
            if target_id in self.batch_tasks:
                task = self.batch_tasks.pop(target_id)
                if not task.done():
                    task.cancel()
            
            try:
                await send_callback(messages)
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "batch_send",
                    "target_id": target_id,
                    "message_count": len(messages)
                })
    
    async def flush_all(self, send_callback: Callable):
        """Flush all pending batches."""
        for target_id in list(self.pending_messages.keys()):
            await self._send_batch(target_id, send_callback)


class HeartbeatManager:
    """Manages heartbeat and connection health monitoring."""
    
    def __init__(self, interval: float = 30.0, timeout: float = 90.0):
        self.interval = interval
        self.timeout = timeout
        self.active_connections: Dict[str, float] = {}
        self.heartbeat_task: Optional[asyncio.Task] = None
        self.logger = get_collaboration_logger()
    
    def start(self):
        """Start heartbeat monitoring."""
        if not self.heartbeat_task:
            self.heartbeat_task = asyncio.create_task(self._heartbeat_loop())
    
    def stop(self):
        """Stop heartbeat monitoring."""
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
            self.heartbeat_task = None
    
    def register_connection(self, connection_id: str):
        """Register a connection for heartbeat monitoring."""
        self.active_connections[connection_id] = time.time()
    
    def update_heartbeat(self, connection_id: str):
        """Update heartbeat timestamp for connection."""
        if connection_id in self.active_connections:
            self.active_connections[connection_id] = time.time()
    
    def unregister_connection(self, connection_id: str):
        """Unregister connection from heartbeat monitoring."""
        self.active_connections.pop(connection_id, None)
    
    def get_stale_connections(self) -> List[str]:
        """Get list of connections that haven't sent heartbeat recently."""
        now = time.time()
        stale = []
        
        for connection_id, last_heartbeat in self.active_connections.items():
            if now - last_heartbeat > self.timeout:
                stale.append(connection_id)
        
        return stale
    
    async def _heartbeat_loop(self):
        """Main heartbeat monitoring loop."""
        while True:
            try:
                await asyncio.sleep(self.interval)
                
                # Check for stale connections
                stale_connections = self.get_stale_connections()
                
                if stale_connections:
                    self.logger.logger.warning(
                        f"Found {len(stale_connections)} stale connections",
                        extra={"stale_connections": stale_connections}
                    )
                
                # Cleanup stale connections
                for connection_id in stale_connections:
                    self.unregister_connection(connection_id)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.log_error(e, {"context": "heartbeat_loop"})


class CollaborationSessionManager:
    """Manages active collaboration sessions across documents."""
    
    def __init__(self, config: CollaborationConfig):
        self.config = config
        self.logger = get_collaboration_logger()
        self.metrics = get_collaboration_metrics()
        
        # Session storage
        self.sessions: Dict[str, CollaborationSession] = {}
        self.document_sessions: Dict[str, Set[str]] = defaultdict(set)
        self.user_sessions: Dict[str, Set[str]] = defaultdict(set)
        
        # Document providers
        self.providers: Dict[str, YjsNotebookProvider] = {}
        
        # Permission manager
        self.permission_manager: Optional[PermissionManager] = None
        
        # Message batcher
        self.message_batcher = MessageBatcher(
            batch_size=self.config.batch_size,
            batch_timeout=self.config.batch_timeout
        )
        
        # Heartbeat manager
        self.heartbeat_manager = HeartbeatManager()
        
        # Background cleanup task
        self.cleanup_task: Optional[asyncio.Task] = None
    
    async def initialize(self):
        """Initialize the session manager."""
        try:
            self.permission_manager = await get_permission_manager()
            self.heartbeat_manager.start()
            self.cleanup_task = asyncio.create_task(self._periodic_cleanup())
            
            self.logger.logger.info("CollaborationSessionManager initialized")
        except Exception as e:
            self.logger.log_error(e, {"context": "session_manager_init"})
            raise
    
    async def shutdown(self):
        """Shutdown the session manager."""
        try:
            # Stop heartbeat monitoring
            self.heartbeat_manager.stop()
            
            # Cancel cleanup task
            if self.cleanup_task:
                self.cleanup_task.cancel()
            
            # Close all sessions
            session_ids = list(self.sessions.keys())
            for session_id in session_ids:
                await self.remove_session(session_id)
            
            # Close all providers
            for provider in self.providers.values():
                await provider.close()
            self.providers.clear()
            
            self.logger.logger.info("CollaborationSessionManager shutdown complete")
        except Exception as e:
            self.logger.log_error(e, {"context": "session_manager_shutdown"})
    
    async def create_session(self, websocket_handler: 'YjsWebSocketHandler',
                           user_info: Dict[str, Any], document_id: str) -> CollaborationSession:
        """Create a new collaboration session."""
        try:
            session_id = str(uuid.uuid4())
            user_id = user_info['username']
            
            # Determine user role and permissions
            role = UserRole(user_info.get('role', 'view'))
            permissions = await self.permission_manager.get_user_permissions(user_id, document_id)
            
            # Create session
            session = CollaborationSession(
                session_id=session_id,
                user_id=user_id,
                document_id=document_id,
                websocket_handler=websocket_handler,
                user_info=sanitize_user_data(user_info),
                role=role,
                connected_at=time.time(),
                last_activity=time.time(),
                permissions=permissions
            )
            
            # Store session
            self.sessions[session_id] = session
            self.document_sessions[document_id].add(session_id)
            self.user_sessions[user_id].add(session_id)
            
            # Register with heartbeat manager
            self.heartbeat_manager.register_connection(session_id)
            
            # Get or create document provider
            provider = await self._get_or_create_provider(document_id)
            provider.add_user_session(user_id, session_id, user_info)
            
            # Update metrics
            self.metrics.record_active_users(document_id, len(self.document_sessions[document_id]))
            self.metrics.record_connection_event("connect", user_id)
            
            self.logger.logger.info(
                f"Created collaboration session {session_id} for user {user_id}",
                extra={
                    "session_id": session_id,
                    "user_id": user_id,
                    "document_id": document_id,
                    "role": role.value
                }
            )
            
            return session
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "create_session",
                "user_id": user_info.get('username'),
                "document_id": document_id
            })
            raise
    
    async def remove_session(self, session_id: str):
        """Remove a collaboration session."""
        try:
            session = self.sessions.get(session_id)
            if not session:
                return
            
            # Remove from storage
            del self.sessions[session_id]
            self.document_sessions[session.document_id].discard(session_id)
            self.user_sessions[session.user_id].discard(session_id)
            
            # Unregister from heartbeat manager
            self.heartbeat_manager.unregister_connection(session_id)
            
            # Remove from provider
            if session.document_id in self.providers:
                provider = self.providers[session.document_id]
                provider.remove_user_session(session.user_id, session_id)
                
                # Clean up provider if no more sessions
                if not self.document_sessions[session.document_id]:
                    await provider.close()
                    del self.providers[session.document_id]
            
            # Update metrics
            self.metrics.record_active_users(
                session.document_id, 
                len(self.document_sessions[session.document_id])
            )
            self.metrics.record_connection_event("disconnect", session.user_id)
            
            self.logger.logger.info(
                f"Removed collaboration session {session_id}",
                extra={
                    "session_id": session_id,
                    "user_id": session.user_id,
                    "document_id": session.document_id
                }
            )
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "remove_session",
                "session_id": session_id
            })
    
    async def get_session(self, session_id: str) -> Optional[CollaborationSession]:
        """Get session by ID."""
        return self.sessions.get(session_id)
    
    async def get_document_sessions(self, document_id: str) -> List[CollaborationSession]:
        """Get all sessions for a document."""
        session_ids = self.document_sessions.get(document_id, set())
        return [self.sessions[sid] for sid in session_ids if sid in self.sessions]
    
    async def get_user_sessions(self, user_id: str) -> List[CollaborationSession]:
        """Get all sessions for a user."""
        session_ids = self.user_sessions.get(user_id, set())
        return [self.sessions[sid] for sid in session_ids if sid in self.sessions]
    
    async def broadcast_to_document(self, document_id: str, message: WebSocketMessage,
                                  exclude_session: Optional[str] = None):
        """Broadcast message to all sessions for a document."""
        sessions = await self.get_document_sessions(document_id)
        
        for session in sessions:
            if exclude_session and session.session_id == exclude_session:
                continue
            
            try:
                await session.websocket_handler.send_message(message)
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "broadcast_to_document",
                    "document_id": document_id,
                    "session_id": session.session_id
                })
    
    async def update_session_heartbeat(self, session_id: str):
        """Update session heartbeat."""
        session = self.sessions.get(session_id)
        if session:
            session.update_activity()
            self.heartbeat_manager.update_heartbeat(session_id)
    
    async def _get_or_create_provider(self, document_id: str) -> YjsNotebookProvider:
        """Get existing or create new document provider."""
        if document_id not in self.providers:
            # TODO: Determine file path from document_id
            # For now, use a simple mapping
            file_path = f"/tmp/notebooks/{document_id}.ipynb"
            
            provider = create_yjs_provider(document_id, file_path, self.config)
            self.providers[document_id] = provider
            
            # Load existing notebook if file exists
            try:
                await provider.load_notebook()
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "provider_load",
                    "document_id": document_id
                })
        
        return self.providers[document_id]
    
    async def _periodic_cleanup(self):
        """Periodic cleanup of stale sessions."""
        while True:
            try:
                await asyncio.sleep(60)  # Run every minute
                
                # Get stale connections from heartbeat manager
                stale_connections = self.heartbeat_manager.get_stale_connections()
                
                # Remove stale sessions
                for connection_id in stale_connections:
                    await self.remove_session(connection_id)
                
                # Clean up empty document session sets
                empty_docs = [doc_id for doc_id, sessions in self.document_sessions.items() 
                            if not sessions]
                for doc_id in empty_docs:
                    del self.document_sessions[doc_id]
                
                # Clean up empty user session sets
                empty_users = [user_id for user_id, sessions in self.user_sessions.items() 
                             if not sessions]
                for user_id in empty_users:
                    del self.user_sessions[user_id]
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.log_error(e, {"context": "periodic_cleanup"})


class YjsWebSocketHandler(tornado.websocket.WebSocketHandler):
    """
    Primary WebSocket handler for collaborative document synchronization.
    
    This handler manages real-time collaborative editing by:
    - Routing CRDT messages using Yjs protocols
    - Managing user authentication and permissions
    - Broadcasting updates to connected clients
    - Implementing heartbeat and reconnection mechanisms
    - Batching messages for optimal bandwidth usage
    - Enforcing sub-100ms latency requirements
    """
    
    # Class-level session manager (shared across all connections)
    session_manager: Optional[CollaborationSessionManager] = None
    executor = ThreadPoolExecutor(max_workers=4)
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.config = get_collaboration_config()
        self.logger = get_collaboration_logger()
        self.metrics = get_collaboration_metrics()
        self.degradation_manager = get_degradation_manager()
        
        # Connection state
        self.session: Optional[CollaborationSession] = None
        self.authenticated = False
        self.connection_id = str(uuid.uuid4())
        self.connected_at = time.time()
        self.last_activity = time.time()
        
        # Message handling
        self.pending_auth = True
        self.message_queue: deque = deque()
        self.permission_middleware: Optional[PermissionMiddleware] = None
        
        # Performance tracking
        self.message_count = 0
        self.bytes_sent = 0
        self.bytes_received = 0
        
    @classmethod
    async def initialize_session_manager(cls):
        """Initialize the global session manager."""
        if cls.session_manager is None:
            config = get_collaboration_config()
            cls.session_manager = CollaborationSessionManager(config)
            await cls.session_manager.initialize()
    
    @classmethod
    async def shutdown_session_manager(cls):
        """Shutdown the global session manager."""
        if cls.session_manager:
            await cls.session_manager.shutdown()
            cls.session_manager = None
    
    def check_origin(self, origin: str) -> bool:
        """Check if origin is allowed for WebSocket connections."""
        try:
            # Parse the origin
            parsed_origin = urlparse(origin)
            origin_host = parsed_origin.netloc.lower()
            
            # Check against allowed origins
            allowed_origins = self.config.allowed_origins
            
            if "*" in allowed_origins:
                return True
            
            for allowed in allowed_origins:
                if allowed.lower() == origin_host:
                    return True
                # Support wildcard matching
                if allowed.startswith("*.") and origin_host.endswith(allowed[2:]):
                    return True
            
            self.logger.logger.warning(
                f"Origin not allowed: {origin}",
                extra={"origin": origin, "allowed_origins": allowed_origins}
            )
            return False
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "origin_check",
                "origin": origin
            })
            return False
    
    async def open(self):
        """Handle WebSocket connection opening."""
        try:
            self.logger.logger.info(
                f"WebSocket connection opened: {self.connection_id}",
                extra={"connection_id": self.connection_id}
            )
            
            # Initialize session manager if needed
            await self.initialize_session_manager()
            
            # Set up permission middleware
            if self.session_manager.permission_manager:
                self.permission_middleware = PermissionMiddleware(
                    self.session_manager.permission_manager
                )
            
            # Send authentication request
            auth_message = WebSocketMessage(
                type=MessageType.AUTH_TOKEN,
                payload={"message": "Authentication required"},
                timestamp=time.time(),
                message_id=str(uuid.uuid4())
            )
            await self.send_message(auth_message)
            
            # Set connection timeout for authentication
            asyncio.create_task(self._authentication_timeout())
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "websocket_open",
                "connection_id": self.connection_id
            })
            await self.close(code=1011, reason="Initialization failed")
    
    async def on_message(self, message_data: Union[str, bytes]):
        """Handle incoming WebSocket messages."""
        start_time = time.time()
        
        try:
            self.last_activity = time.time()
            self.message_count += 1
            
            if isinstance(message_data, bytes):
                self.bytes_received += len(message_data)
                # Handle binary Yjs updates
                await self._handle_binary_message(message_data)
            else:
                self.bytes_received += len(message_data.encode('utf-8'))
                # Handle JSON messages
                await self._handle_text_message(message_data)
            
            # Update session heartbeat
            if self.session:
                await self.session_manager.update_session_heartbeat(self.session.session_id)
            
            # Record latency
            latency = time.time() - start_time
            self.metrics.record_operation("message_handling", 
                                        self.session.document_id if self.session else "unknown", 
                                        True, latency)
            
            # Check latency requirement
            if latency > 0.1:  # 100ms threshold
                self.logger.logger.warning(
                    f"Message handling exceeded 100ms latency: {latency*1000:.1f}ms",
                    extra={
                        "latency": latency,
                        "connection_id": self.connection_id,
                        "message_count": self.message_count
                    }
                )
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "message_handling",
                "connection_id": self.connection_id,
                "message_type": type(message_data).__name__
            })
            
            error_message = WebSocketMessage(
                type=MessageType.ERROR,
                payload={"error": "Message processing failed", "details": str(e)},
                timestamp=time.time(),
                message_id=str(uuid.uuid4())
            )
            await self.send_message(error_message)
    
    async def _handle_text_message(self, message_data: str):
        """Handle text-based WebSocket messages."""
        try:
            data = json.loads(message_data)
            message = WebSocketMessage.from_dict(data)
            
            # Handle authentication messages first
            if message.type == MessageType.AUTH_TOKEN:
                await self._handle_authentication(message)
                return
            
            # Require authentication for all other messages
            if not self.authenticated:
                await self._send_auth_required()
                return
            
            # Validate permissions for collaborative operations
            if self.permission_middleware and message.document_id:
                is_allowed = await self.permission_middleware.validate_message(
                    self.session.user_info, message.to_dict()
                )
                if not is_allowed:
                    await self._send_permission_denied(message.type)
                    return
            
            # Route message based on type
            await self._route_message(message)
            
        except json.JSONDecodeError as e:
            self.logger.log_error(e, {
                "context": "json_decode",
                "connection_id": self.connection_id
            })
            await self._send_error("Invalid JSON message")
        except Exception as e:
            self.logger.log_error(e, {
                "context": "text_message_handling",
                "connection_id": self.connection_id
            })
            await self._send_error(f"Message handling failed: {str(e)}")
    
    async def _handle_binary_message(self, message_data: bytes):
        """Handle binary Yjs update messages."""
        try:
            if not self.authenticated or not self.session:
                await self._send_auth_required()
                return
            
            # Binary messages are typically Yjs updates
            # First byte indicates message type for binary protocol
            if len(message_data) == 0:
                return
            
            message_type = message_data[0]
            
            if message_type == 0:  # Yjs sync step 1
                await self._handle_yjs_sync_step1(message_data[1:])
            elif message_type == 1:  # Yjs sync step 2  
                await self._handle_yjs_sync_step2(message_data[1:])
            elif message_type == 2:  # Yjs update
                await self._handle_yjs_update(message_data[1:])
            else:
                self.logger.logger.warning(
                    f"Unknown binary message type: {message_type}",
                    extra={"connection_id": self.connection_id}
                )
        
        except Exception as e:
            self.logger.log_error(e, {
                "context": "binary_message_handling",
                "connection_id": self.connection_id
            })
    
    async def _handle_authentication(self, message: WebSocketMessage):
        """Handle user authentication."""
        try:
            token = message.payload.get('token')
            document_id = message.payload.get('document_id')
            
            if not token or not document_id:
                await self._send_auth_failure("Token and document_id required")
                return
            
            # Validate token and permissions
            has_permission, user_info = await validate_token_and_permissions(
                token, document_id, CollaborativeOperation.VIEW_DOCUMENT
            )
            
            if not has_permission or not user_info:
                await self._send_auth_failure("Authentication failed")
                return
            
            # Create collaboration session
            self.session = await self.session_manager.create_session(
                self, user_info, document_id
            )
            
            self.authenticated = True
            self.pending_auth = False
            
            # Send authentication success
            auth_success = WebSocketMessage(
                type=MessageType.AUTH_SUCCESS,
                payload={
                    "session_id": self.session.session_id,
                    "user_info": self.session.get_presence_info(),
                    "permissions": [op.value for op in self.session.permissions]
                },
                timestamp=time.time(),
                message_id=str(uuid.uuid4()),
                document_id=document_id,
                user_id=self.session.user_id
            )
            await self.send_message(auth_success)
            
            # Send initial document state
            await self._send_initial_document_state()
            
            # Broadcast user join to other sessions
            await self._broadcast_user_join()
            
            # Process any queued messages
            await self._process_message_queue()
            
            self.logger.logger.info(
                f"User authenticated: {user_info['username']}",
                extra={
                    "user_id": user_info['username'],
                    "document_id": document_id,
                    "session_id": self.session.session_id
                }
            )
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "authentication",
                "connection_id": self.connection_id
            })
            await self._send_auth_failure("Authentication error")
    
    async def _route_message(self, message: WebSocketMessage):
        """Route message to appropriate handler based on type."""
        handlers = {
            MessageType.HEARTBEAT: self._handle_heartbeat,
            MessageType.YJS_SYNC_STEP1: self._handle_yjs_sync_step1_json,
            MessageType.YJS_SYNC_STEP2: self._handle_yjs_sync_step2_json,
            MessageType.YJS_UPDATE: self._handle_yjs_update_json,
            MessageType.YJS_AWARENESS: self._handle_yjs_awareness,
            MessageType.DOCUMENT_OPEN: self._handle_document_open,
            MessageType.DOCUMENT_CLOSE: self._handle_document_close,
            MessageType.DOCUMENT_SAVE: self._handle_document_save,
            MessageType.LOCK_ACQUIRE: self._handle_lock_acquire,
            MessageType.LOCK_RELEASE: self._handle_lock_release,
            MessageType.CURSOR_UPDATE: self._handle_cursor_update,
            MessageType.SELECTION_UPDATE: self._handle_selection_update,
        }
        
        handler = handlers.get(message.type)
        if handler:
            await handler(message)
        else:
            self.logger.logger.warning(
                f"No handler for message type: {message.type.value}",
                extra={"connection_id": self.connection_id}
            )
    
    async def _handle_heartbeat(self, message: WebSocketMessage):
        """Handle heartbeat message."""
        response = WebSocketMessage(
            type=MessageType.HEARTBEAT_RESPONSE,
            payload={"timestamp": time.time()},
            timestamp=time.time(),
            message_id=str(uuid.uuid4()),
            document_id=self.session.document_id,
            user_id=self.session.user_id
        )
        await self.send_message(response)
    
    async def _handle_yjs_sync_step1(self, update_data: bytes):
        """Handle Yjs sync step 1 (request state vector)."""
        if not self.session:
            return
        
        try:
            provider = self.session_manager.providers.get(self.session.document_id)
            if not provider:
                return
            
            # Get state vector from provider
            state_vector = provider.get_state_vector()
            if state_vector:
                # Send sync step 2 response
                response_data = bytes([1]) + state_vector
                await self.write_message(response_data, binary=True)
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "yjs_sync_step1",
                "session_id": self.session.session_id
            })
    
    async def _handle_yjs_sync_step2(self, update_data: bytes):
        """Handle Yjs sync step 2 (apply state vector update)."""
        if not self.session:
            return
        
        try:
            provider = self.session_manager.providers.get(self.session.document_id)
            if not provider:
                return
            
            # Apply update to provider
            await provider.apply_update(update_data, origin=self.session.user_id)
            
            # Broadcast update to other clients
            await self._broadcast_yjs_update(update_data)
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "yjs_sync_step2",
                "session_id": self.session.session_id
            })
    
    async def _handle_yjs_update(self, update_data: bytes):
        """Handle Yjs document update."""
        if not self.session:
            return
        
        try:
            provider = self.session_manager.providers.get(self.session.document_id)
            if not provider:
                return
            
            # Apply update to provider
            await provider.apply_update(update_data, origin=self.session.user_id)
            
            # Broadcast update to other clients
            await self._broadcast_yjs_update(update_data)
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "yjs_update",
                "session_id": self.session.session_id
            })
    
    async def _handle_yjs_sync_step1_json(self, message: WebSocketMessage):
        """Handle JSON-encoded Yjs sync step 1."""
        state_vector_b64 = message.payload.get('state_vector')
        if state_vector_b64:
            state_vector = base64.b64decode(state_vector_b64)
            await self._handle_yjs_sync_step1(state_vector)
    
    async def _handle_yjs_sync_step2_json(self, message: WebSocketMessage):
        """Handle JSON-encoded Yjs sync step 2."""
        update_b64 = message.payload.get('update')
        if update_b64:
            update_data = base64.b64decode(update_b64)
            await self._handle_yjs_sync_step2(update_data)
    
    async def _handle_yjs_update_json(self, message: WebSocketMessage):
        """Handle JSON-encoded Yjs update."""
        update_b64 = message.payload.get('update')
        if update_b64:
            update_data = base64.b64decode(update_b64)
            await self._handle_yjs_update(update_data)
    
    async def _handle_yjs_awareness(self, message: WebSocketMessage):
        """Handle Yjs awareness update."""
        if not self.session:
            return
        
        try:
            # Update session awareness data
            awareness_data = message.payload
            self.session.cursor_position = awareness_data.get('cursor_position')
            self.session.active_cell = awareness_data.get('active_cell')
            self.session.update_activity()
            
            # Broadcast awareness to other sessions
            awareness_message = WebSocketMessage(
                type=MessageType.YJS_AWARENESS,
                payload={
                    "user_id": self.session.user_id,
                    "session_id": self.session.session_id,
                    "presence_info": self.session.get_presence_info(),
                    **awareness_data
                },
                timestamp=time.time(),
                message_id=str(uuid.uuid4()),
                document_id=self.session.document_id,
                user_id=self.session.user_id
            )
            
            await self.session_manager.broadcast_to_document(
                self.session.document_id,
                awareness_message,
                exclude_session=self.session.session_id
            )
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "yjs_awareness",
                "session_id": self.session.session_id
            })
    
    async def _handle_document_open(self, message: WebSocketMessage):
        """Handle document open request."""
        # Document is already opened during authentication
        # Send current document state
        await self._send_initial_document_state()
    
    async def _handle_document_close(self, message: WebSocketMessage):
        """Handle document close request."""
        if self.session:
            await self.session_manager.remove_session(self.session.session_id)
            self.session = None
            self.authenticated = False
    
    async def _handle_document_save(self, message: WebSocketMessage):
        """Handle document save request."""
        if not self.session:
            return
        
        try:
            provider = self.session_manager.providers.get(self.session.document_id)
            if provider:
                notebook_content = await provider.save_notebook()
                
                save_response = WebSocketMessage(
                    type=MessageType.DOCUMENT_STATE,
                    payload={
                        "event": "saved",
                        "timestamp": time.time(),
                        "notebook_info": {
                            "cell_count": len(notebook_content.get('cells', [])),
                            "version": provider._version
                        }
                    },
                    timestamp=time.time(),
                    message_id=str(uuid.uuid4()),
                    document_id=self.session.document_id,
                    user_id=self.session.user_id
                )
                await self.send_message(save_response)
        
        except Exception as e:
            self.logger.log_error(e, {
                "context": "document_save",
                "session_id": self.session.session_id
            })
    
    async def _handle_lock_acquire(self, message: WebSocketMessage):
        """Handle cell lock acquisition request."""
        if not self.session:
            return
        
        try:
            cell_id = message.payload.get('cell_id')
            if not cell_id:
                return
            
            provider = self.session_manager.providers.get(self.session.document_id)
            if not provider or not provider.lock_manager:
                return
            
            # Attempt to acquire lock
            success = await provider.lock_manager.acquire_lock(
                cell_id, self.session.user_id, self.session.session_id
            )
            
            lock_response = WebSocketMessage(
                type=MessageType.LOCK_STATUS,
                payload={
                    "cell_id": cell_id,
                    "locked": success,
                    "owner": self.session.user_id if success else None,
                    "timestamp": time.time()
                },
                timestamp=time.time(),
                message_id=str(uuid.uuid4()),
                document_id=self.session.document_id,
                user_id=self.session.user_id
            )
            
            if success:
                # Broadcast lock status to all sessions
                await self.session_manager.broadcast_to_document(
                    self.session.document_id, lock_response
                )
            else:
                # Send only to requesting user
                await self.send_message(lock_response)
        
        except Exception as e:
            self.logger.log_error(e, {
                "context": "lock_acquire",
                "session_id": self.session.session_id
            })
    
    async def _handle_lock_release(self, message: WebSocketMessage):
        """Handle cell lock release request."""
        if not self.session:
            return
        
        try:
            cell_id = message.payload.get('cell_id')
            if not cell_id:
                return
            
            provider = self.session_manager.providers.get(self.session.document_id)
            if not provider or not provider.lock_manager:
                return
            
            # Release lock
            success = await provider.lock_manager.release_lock(
                cell_id, self.session.user_id
            )
            
            if success:
                lock_response = WebSocketMessage(
                    type=MessageType.LOCK_STATUS,
                    payload={
                        "cell_id": cell_id,
                        "locked": False,
                        "owner": None,
                        "timestamp": time.time()
                    },
                    timestamp=time.time(),
                    message_id=str(uuid.uuid4()),
                    document_id=self.session.document_id,
                    user_id=self.session.user_id
                )
                
                # Broadcast lock release to all sessions
                await self.session_manager.broadcast_to_document(
                    self.session.document_id, lock_response
                )
        
        except Exception as e:
            self.logger.log_error(e, {
                "context": "lock_release",
                "session_id": self.session.session_id
            })
    
    async def _handle_cursor_update(self, message: WebSocketMessage):
        """Handle cursor position update."""
        if not self.session:
            return
        
        self.session.cursor_position = message.payload
        
        # Broadcast to other sessions
        cursor_message = WebSocketMessage(
            type=MessageType.CURSOR_UPDATE,
            payload={
                "user_id": self.session.user_id,
                "session_id": self.session.session_id,
                **message.payload
            },
            timestamp=time.time(),
            message_id=str(uuid.uuid4()),
            document_id=self.session.document_id,
            user_id=self.session.user_id
        )
        
        await self.session_manager.broadcast_to_document(
            self.session.document_id,
            cursor_message,
            exclude_session=self.session.session_id
        )
    
    async def _handle_selection_update(self, message: WebSocketMessage):
        """Handle text selection update."""
        if not self.session:
            return
        
        # Broadcast to other sessions
        selection_message = WebSocketMessage(
            type=MessageType.SELECTION_UPDATE,
            payload={
                "user_id": self.session.user_id,
                "session_id": self.session.session_id,
                **message.payload
            },
            timestamp=time.time(),
            message_id=str(uuid.uuid4()),
            document_id=self.session.document_id,
            user_id=self.session.user_id
        )
        
        await self.session_manager.broadcast_to_document(
            self.session.document_id,
            selection_message,
            exclude_session=self.session.session_id
        )
    
    async def _broadcast_yjs_update(self, update_data: bytes):
        """Broadcast Yjs update to other connected clients."""
        if not self.session:
            return
        
        # Create binary message for efficient transmission
        message_data = bytes([2]) + update_data  # Type 2 = Yjs update
        
        # Get other sessions for this document
        sessions = await self.session_manager.get_document_sessions(
            self.session.document_id
        )
        
        for session in sessions:
            if session.session_id != self.session.session_id:
                try:
                    await session.websocket_handler.write_message(
                        message_data, binary=True
                    )
                except Exception as e:
                    self.logger.log_error(e, {
                        "context": "broadcast_yjs_update",
                        "target_session": session.session_id
                    })
    
    async def _send_initial_document_state(self):
        """Send initial document state to newly connected client."""
        if not self.session:
            return
        
        try:
            provider = self.session_manager.providers.get(self.session.document_id)
            if not provider:
                return
            
            # Send initial Yjs state
            state_vector = provider.get_state_vector()
            if state_vector:
                # Send as sync step 2
                message_data = bytes([1]) + state_vector
                await self.write_message(message_data, binary=True)
            
            # Send user list
            sessions = await self.session_manager.get_document_sessions(
                self.session.document_id
            )
            
            user_list = [session.get_presence_info() for session in sessions]
            
            user_list_message = WebSocketMessage(
                type=MessageType.USER_LIST,
                payload={"users": user_list},
                timestamp=time.time(),
                message_id=str(uuid.uuid4()),
                document_id=self.session.document_id,
                user_id=self.session.user_id
            )
            await self.send_message(user_list_message)
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "send_initial_state",
                "session_id": self.session.session_id
            })
    
    async def _broadcast_user_join(self):
        """Broadcast user join event to other sessions."""
        if not self.session:
            return
        
        join_message = WebSocketMessage(
            type=MessageType.USER_JOIN,
            payload=self.session.get_presence_info(),
            timestamp=time.time(),
            message_id=str(uuid.uuid4()),
            document_id=self.session.document_id,
            user_id=self.session.user_id
        )
        
        await self.session_manager.broadcast_to_document(
            self.session.document_id,
            join_message,
            exclude_session=self.session.session_id
        )
    
    async def _broadcast_user_leave(self):
        """Broadcast user leave event to other sessions."""
        if not self.session:
            return
        
        leave_message = WebSocketMessage(
            type=MessageType.USER_LEAVE,
            payload={
                "user_id": self.session.user_id,
                "session_id": self.session.session_id
            },
            timestamp=time.time(),
            message_id=str(uuid.uuid4()),
            document_id=self.session.document_id,
            user_id=self.session.user_id
        )
        
        await self.session_manager.broadcast_to_document(
            self.session.document_id,
            leave_message,
            exclude_session=self.session.session_id
        )
    
    async def send_message(self, message: WebSocketMessage):
        """Send a WebSocket message to the client."""
        try:
            if self.ws_connection and not self.ws_connection.stream.closed():
                message_dict = message.to_dict()
                message_json = json.dumps(message_dict)
                self.bytes_sent += len(message_json.encode('utf-8'))
                
                await self.write_message(message_json)
                
        except Exception as e:
            self.logger.log_error(e, {
                "context": "send_message",
                "connection_id": self.connection_id,
                "message_type": message.type.value
            })
    
    async def _send_auth_required(self):
        """Send authentication required message."""
        message = WebSocketMessage(
            type=MessageType.AUTH_FAILURE,
            payload={"error": "Authentication required"},
            timestamp=time.time(),
            message_id=str(uuid.uuid4())
        )
        await self.send_message(message)
    
    async def _send_auth_failure(self, reason: str):
        """Send authentication failure message."""
        message = WebSocketMessage(
            type=MessageType.AUTH_FAILURE,
            payload={"error": reason},
            timestamp=time.time(),
            message_id=str(uuid.uuid4())
        )
        await self.send_message(message)
    
    async def _send_permission_denied(self, operation_type: MessageType):
        """Send permission denied message."""
        message = WebSocketMessage(
            type=MessageType.ERROR,
            payload={
                "error": "Permission denied",
                "operation": operation_type.value
            },
            timestamp=time.time(),
            message_id=str(uuid.uuid4()),
            document_id=self.session.document_id if self.session else None,
            user_id=self.session.user_id if self.session else None
        )
        await self.send_message(message)
    
    async def _send_error(self, error_message: str):
        """Send error message to client."""
        message = WebSocketMessage(
            type=MessageType.ERROR,
            payload={"error": error_message},
            timestamp=time.time(),
            message_id=str(uuid.uuid4()),
            document_id=self.session.document_id if self.session else None,
            user_id=self.session.user_id if self.session else None
        )
        await self.send_message(message)
    
    async def _authentication_timeout(self):
        """Handle authentication timeout."""
        await asyncio.sleep(self.config.connection_timeout)
        
        if self.pending_auth:
            self.logger.logger.warning(
                f"Authentication timeout for connection {self.connection_id}"
            )
            await self.close(code=1008, reason="Authentication timeout")
    
    async def _process_message_queue(self):
        """Process queued messages after authentication."""
        while self.message_queue:
            try:
                message_data = self.message_queue.popleft()
                await self.on_message(message_data)
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "process_message_queue",
                    "connection_id": self.connection_id
                })
    
    async def on_close(self):
        """Handle WebSocket connection closing."""
        try:
            # Broadcast user leave if session exists
            if self.session:
                await self._broadcast_user_leave()
                
                # Remove session
                await self.session_manager.remove_session(self.session.session_id)
            
            # Calculate connection stats
            connection_duration = time.time() - self.connected_at
            
            self.logger.logger.info(
                f"WebSocket connection closed: {self.connection_id}",
                extra={
                    "connection_id": self.connection_id,
                    "duration": connection_duration,
                    "messages_processed": self.message_count,
                    "bytes_sent": self.bytes_sent,
                    "bytes_received": self.bytes_received
                }
            )
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "websocket_close",
                "connection_id": self.connection_id
            })


# URL routing helper
def create_collaboration_handlers():
    """Create URL handlers for collaboration WebSocket endpoints."""
    return [
        (r"/api/collaboration/ws", YjsWebSocketHandler),
        (r"/api/collaboration/ws/([^/]+)", YjsWebSocketHandler),  # With document ID
    ]


# Application integration functions
async def initialize_collaboration_handlers():
    """Initialize collaboration handlers and session management."""
    await YjsWebSocketHandler.initialize_session_manager()


async def shutdown_collaboration_handlers():
    """Shutdown collaboration handlers and clean up resources."""
    await YjsWebSocketHandler.shutdown_session_manager()


# Utility functions for handler management
def get_active_sessions_stats() -> Dict[str, Any]:
    """Get statistics about active collaboration sessions."""
    if YjsWebSocketHandler.session_manager:
        return YjsWebSocketHandler.session_manager.session_manager.get_stats()
    return {}


def get_collaboration_health() -> Dict[str, Any]:
    """Get collaboration system health information."""
    health = {
        "status": "healthy",
        "pycrdt_available": HAS_PYCRDT,
        "session_manager_active": YjsWebSocketHandler.session_manager is not None,
        "timestamp": time.time()
    }
    
    if YjsWebSocketHandler.session_manager:
        stats = YjsWebSocketHandler.session_manager.get_stats()
        health.update({
            "active_sessions": stats.get("active_sessions", 0),
            "active_documents": stats.get("document_count", 0)
        })
    
    return health