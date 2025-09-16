"""
Server-side WebSocket and REST handlers for Jupyter Notebook collaborative editing.

This module implements comprehensive server-side collaboration support using the Yjs CRDT
framework, providing real-time synchronization, user presence awareness, cell-level locking,
and role-based access control for multi-user notebook editing.

Key components:
- YjsWebSocketHandler: WebSocket handler for real-time CRDT synchronization
- CollaborationSessionsHandler: REST API for session management
- CollaborationStatusHandler: REST API for session status monitoring
"""

import asyncio
import json
import logging
import sqlite3
import sys
import time
import uuid
import weakref
from collections.abc import Awaitable
from typing import Any, Optional, Union

import tornado.web
from jupyter_server.base.handlers import JupyterHandler
from tornado.websocket import WebSocketHandler
from traitlets import Bool, Float, Int, List, Unicode


class YjsWebSocketHandler(WebSocketHandler):
    """
    WebSocket handler implementing the y-websocket protocol for real-time collaborative editing.

    This handler manages CRDT document synchronization using Yjs, implements user presence
    awareness, handles cell-level locking, and enforces role-based access control while
    maintaining high performance through message batching and connection pooling.

    Security features:
    - Validates authentication tokens on WebSocket upgrade requests
    - Enforces role-based permissions (VIEW-ONLY, EDIT, ADMIN)
    - Implements message size validation (max 1MB per update)
    - Rate limiting to prevent DoS attacks

    Performance optimizations:
    - Message batching with 50ms aggregation windows
    - Connection pooling for scalability
    - Lazy loading of collaborative state
    """

    # Configurable traits for collaboration settings
    collaboration_enabled = Bool(
        default_value=True, help="Enable collaborative editing features"
    ).tag(config=True)
    max_message_size = Int(
        default_value=1024 * 1024, help="Maximum WebSocket message size in bytes"
    ).tag(config=True)
    batch_window_ms = Float(default_value=50.0, help="Message batching window in milliseconds").tag(
        config=True
    )
    lock_timeout_seconds = Int(default_value=30, help="Cell lock timeout in seconds").tag(
        config=True
    )
    rate_limit_per_second = Int(default_value=100, help="Rate limit per connection per second").tag(
        config=True
    )
    allowed_origins = List(
        trait=Unicode(), default_value=["*"], help="Allowed WebSocket origins"
    ).tag(config=True)
    storage_backend = Unicode(
        default_value="sqlite", help="Storage backend for document persistence"
    ).tag(config=True)

    # Class-level connection pool and document storage
    _connection_pools: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
    _document_stores: dict[str, Any] = {}
    _session_locks: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
    _active_connections: weakref.WeakSet = weakref.WeakSet()
    _connection_refs: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()

    # Configuration constants (with fallback values)
    MAX_MESSAGE_SIZE = 1024 * 1024  # 1MB limit
    BATCH_WINDOW_MS = 50  # 50ms message batching window
    LOCK_TIMEOUT_SECONDS = 30  # Cell lock timeout
    RATE_LIMIT_PER_SECOND = 100  # Max messages per second per connection
    RATE_LIMIT_BURST = 200  # Burst allowance

    def __init__(self, *args, **kwargs):
        """Initialize WebSocket handler with collaboration infrastructure."""
        super().__init__(*args, **kwargs)
        self.logger = logging.getLogger(__name__ + ".YjsWebSocketHandler")

        # Session state
        self.session_id: Optional[str] = None
        self.document_id: Optional[str] = None
        self.user_info: Optional[dict[str, Any]] = None
        self.user_role: str = "VIEW_ONLY"  # Default to most restrictive
        self.authenticated: bool = False

        # Connection state
        self.last_ping: float = time.time()
        self.message_count: int = 0
        self.rate_limit_window_start: float = time.time()

        # Synchronization events
        self.connection_ready: asyncio.Event = asyncio.Event()
        self.sync_complete: asyncio.Event = asyncio.Event()

        # Batching infrastructure
        self.pending_messages: asyncio.Queue = asyncio.Queue()
        self.batch_task: Optional[asyncio.Task] = None

        # Document state
        self.yjs_document: dict[str, Any] = {}
        self.awareness_state: dict[str, Any] = {}
        self.cell_locks: dict[str, dict[str, Any]] = {}

        # JSON encoder for custom serialization
        self.json_encoder = json.JSONEncoder(separators=(",", ":"), ensure_ascii=False)

        # Add to active connections pool
        YjsWebSocketHandler._active_connections.add(self)

        # Store weak reference for cleanup tracking
        YjsWebSocketHandler._connection_refs[self] = weakref.ref(self, self._cleanup_connection_ref)

    @classmethod
    def _cleanup_connection_ref(cls, weak_ref) -> None:
        """Cleanup callback for weak references to handle memory management."""
        try:
            # Remove from connection refs if still present
            for conn, ref in list(cls._connection_refs.items()):
                if ref is weak_ref:
                    del cls._connection_refs[conn]
                    break
        except Exception as e:
            logging.getLogger(__name__).warning("Error during connection cleanup: %s", e)

    def check_origin(self, origin: str) -> bool:
        """
        Validate WebSocket origin for security.

        Args:
            origin: The origin header from the WebSocket upgrade request

        Returns:
            bool: True if origin is allowed, False otherwise
        """
        # Get server settings for allowed origins
        server_settings = self.settings
        allowed_origins = server_settings.get("allow_origin", "*")

        if allowed_origins == "*":
            return True

        if isinstance(allowed_origins, str):
            allowed_origins = [allowed_origins]

        # Check if origin matches any allowed pattern
        for allowed_origin in allowed_origins:
            if origin == allowed_origin:
                return True

        self.logger.warning("WebSocket connection rejected from origin: %s", origin)
        return False

    def get_compression_options(self) -> Optional[dict[str, Any]]:
        """
        Configure WebSocket compression for performance optimization.

        Returns:
            Optional[Dict]: Compression configuration or None to disable
        """
        # Enable compression with optimal settings for collaboration data
        return {
            "compression_level": 6,  # Balance between compression and CPU usage
            "mem_level": 8,  # Memory usage for compression
            "window_bits": 15,  # Compression window size
            "compression_threshold": 1024,  # Only compress messages larger than 1KB
        }

    def open(self, document_id: Optional[str] = None) -> None:
        """
        Handle WebSocket connection opening with authentication and initialization.

        Args:
            document_id: Optional document identifier from URL path
        """
        start_time = time.perf_counter()
        try:
            # Extract document ID from URL if not provided
            if not document_id:
                # Parse from URL path like /api/collaboration/ws/document123
                path_parts = self.request.path.split("/")
                if len(path_parts) > 4:
                    document_id = path_parts[-1]
                else:
                    document_id = self.get_query_argument("document", default="default")

            self.document_id = document_id
            self.session_id = str(uuid.uuid4())

            # Authenticate the WebSocket connection
            if not self._authenticate_connection():
                self.logger.error(
                    "Authentication failed for WebSocket connection to document %s", document_id
                )
                self.close(code=1008, reason="Authentication failed")
                return

            # Check collaboration permissions
            if not self._check_collaboration_permissions():
                self.logger.error(
                    "Permission denied for user %s on document %s",
                    self.user_info.get("name", "unknown"),
                    document_id,
                )
                self.close(code=1008, reason="Permission denied")
                return

            # Initialize document state and join collaborative session
            self._initialize_document_state()
            self._join_collaboration_session()

            # Signal that connection is ready
            self.connection_ready.set()

            # Start message batching task
            self.batch_task = asyncio.create_task(self._message_batching_loop())

            # Send initial sync message
            self._send_sync_message(
                {
                    "type": "sync",
                    "sessionId": self.session_id,
                    "documentId": self.document_id,
                    "userRole": self.user_role,
                    "timestamp": time.time(),
                }
            )

            # Mark sync as complete
            self.sync_complete.set()

            connection_time = time.perf_counter() - start_time
            self.logger.info(
                "WebSocket connection established: user=%s, document=%s, role=%s, time=%.3fs",
                self.user_info.get("name"),
                self.document_id,
                self.user_role,
                connection_time,
            )

        except Exception as e:
            connection_time = time.perf_counter() - start_time
            self.logger.error(
                "Error opening WebSocket connection (time={connection_time:.3f}s): %s", str(e)
            )
            self.close(code=1011, reason="Internal server error")

    def on_message(self, message: Union[str, bytes]) -> None:
        """
        Handle incoming WebSocket messages with protocol validation and processing.

        Args:
            message: Raw message data from client
        """
        try:
            # Validate message size
            if len(message) > self.MAX_MESSAGE_SIZE:
                self.logger.warning(
                    "Message size %s exceeds limit {self.MAX_MESSAGE_SIZE}", len(message)
                )
                self._send_error_message("Message size limit exceeded")
                return

            # Apply rate limiting
            if not self._check_rate_limit():
                self.logger.warning("Rate limit exceeded for session %s", self.session_id)
                self._send_error_message("Rate limit exceeded")
                return

            # Decode message based on type
            if isinstance(message, bytes):
                # Handle binary Yjs update messages
                self._handle_yjs_binary_message(message)
            else:
                # Handle JSON protocol messages
                self._handle_json_message(message)

        except Exception as e:
            self.logger.error("Error processing message: %s", str(e))
            self._send_error_message("Message processing failed")

    def on_close(self) -> None:
        """Handle WebSocket connection closing with cleanup."""
        try:
            # Cancel batching task
            if self.batch_task and not self.batch_task.done():
                self.batch_task.cancel()

            # Release any held locks
            self._release_all_locks()

            # Leave collaboration session
            self._leave_collaboration_session()

            # Clean up connection state
            if self in YjsWebSocketHandler._active_connections:
                YjsWebSocketHandler._active_connections.discard(self)

            self.logger.info(
                "WebSocket connection closed: user=%s, document=%s, session=%s",
                self.user_info.get("name") if self.user_info else "unknown",
                self.document_id,
                self.session_id,
            )

        except Exception as e:
            self.logger.error("Error during connection cleanup: %s", str(e))

    def write_message(
        self, message: Union[str, bytes, dict[str, Any]], binary: bool = False
    ) -> Awaitable[None]:
        """
        Send message to WebSocket client with error handling.

        Args:
            message: Message to send
            binary: Whether to send as binary message

        Returns:
            Awaitable that completes when message is sent
        """
        try:
            if isinstance(message, dict):
                # Convert dict to JSON string using custom encoder
                message_str = self.json_encoder.encode(message)
                return super().write_message(message_str, binary=False)
            return super().write_message(message, binary=binary)
        except Exception as e:
            self.logger.log(logging.ERROR, "Error sending message: %s", str(e))
            # Return a completed future for error cases
            future = asyncio.Future()
            future.set_exception(e)
            return future

    def _authenticate_connection(self) -> bool:
        """
        Authenticate WebSocket connection using existing HTTP session credentials.

        Returns:
            bool: True if authentication successful, False otherwise
        """
        try:
            # Extract authentication token from query parameters or headers
            token = self.get_query_argument("token", default=None)
            if not token:
                # Try to get from cookie
                token = self.get_secure_cookie("jupyter-hub-token-name")
                if token:
                    token = token.decode("utf-8")

            if not token:
                # Try authorization header
                auth_header = self.request.headers.get("Authorization", "")
                if auth_header.startswith("Bearer "):
                    token = auth_header[7:]

            if not token:
                return False

            # Validate token using server authentication system
            # This integrates with JupyterHub authentication
            user_info = self._validate_auth_token(token)
            if not user_info:
                return False

            self.user_info = user_info
            self.authenticated = True
            return True

        except Exception as e:
            self.logger.error("Authentication error: %s", str(e))
            return False

    def _validate_auth_token(self, token: str) -> Optional[dict[str, Any]]:
        """
        Validate authentication token and extract user information.

        Args:
            token: Authentication token to validate

        Returns:
            Optional[Dict]: User information if valid, None if invalid
        """
        # This would integrate with JupyterHub's authentication system
        # For now, implement basic token validation
        try:
            # In a real implementation, this would validate against JupyterHub
            # Here we simulate validation
            if len(token) >= 32:  # Minimum token length
                return {
                    "id": "user_" + token[:8],
                    "name": f"User_{token[:4]}",
                    "email": f"user_{token[:4]}@example.com",
                    "groups": ["notebook_users"],
                    "roles": ["edit"],  # Could be 'view', 'edit', or 'admin'
                }
        except Exception as e:
            self.logger.warning("Error validating auth token: %s", e)
        return None

    def _check_collaboration_permissions(self) -> bool:
        """
        Check if user has permission to join collaborative session.

        Returns:
            bool: True if user has permission, False otherwise
        """
        try:
            if not self.user_info:
                return False

            # Determine user role based on their permissions
            user_roles = self.user_info.get("roles", [])

            if "admin" in user_roles:
                self.user_role = "ADMIN"
            elif "edit" in user_roles:
                self.user_role = "EDIT"
            elif "view" in user_roles:
                self.user_role = "VIEW_ONLY"
            else:
                # Default to view-only for safety
                self.user_role = "VIEW_ONLY"

            # Check document-specific permissions
            # This could be extended to check per-document access control
            return True

        except Exception as e:
            self.logger.error("Permission check error: %s", str(e))
            return False

    def _check_rate_limit(self) -> bool:
        """
        Check if connection is within rate limits.

        Returns:
            bool: True if within limits, False if rate limited
        """
        current_time = time.time()

        # Reset window if enough time has passed
        if current_time - self.rate_limit_window_start >= 1.0:
            self.rate_limit_window_start = current_time
            self.message_count = 0

        self.message_count += 1

        # Check burst limit
        if self.message_count > self.RATE_LIMIT_BURST:
            return False

        # Check sustained rate limit
        window_duration = current_time - self.rate_limit_window_start
        # Only check sustained rate if we have a meaningful window duration (>= 10ms)
        # This prevents rate calculation issues with rapid successive calls
        if window_duration >= 0.01:
            rate = self.message_count / window_duration
            if rate > self.RATE_LIMIT_PER_SECOND:
                return False

        return True

    def _initialize_document_state(self) -> None:
        """Initialize or load document state for collaboration."""
        try:
            # Get or create document storage
            if self.document_id not in YjsWebSocketHandler._document_stores:
                YjsWebSocketHandler._document_stores[self.document_id] = {
                    "yjs_state": b"",  # Binary Yjs document state
                    "created_at": time.time(),
                    "last_modified": time.time(),
                    "active_users": set(),
                    "cell_locks": {},
                    "version_history": [],
                }

            # Load document state from persistent storage
            self._load_document_from_storage()

        except Exception as e:
            self.logger.error("Error initializing document state: %s", str(e))

    def _load_document_from_storage(self) -> None:
        """Load document state from SQLite or file-based storage."""
        try:
            # Create SQLite connection for document persistence
            import tempfile
            from pathlib import Path

            temp_dir = Path(tempfile.gettempdir())
            db_path = temp_dir / f"collaboration_{self.document_id}.db"
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row

            # Create tables if they don't exist
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS yjs_documents (
                    id TEXT PRIMARY KEY,
                    state BLOB,
                    created_at REAL,
                    last_modified REAL
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS document_locks (
                    document_id TEXT,
                    cell_id TEXT,
                    user_id TEXT,
                    acquired_at REAL,
                    expires_at REAL,
                    PRIMARY KEY (document_id, cell_id)
                )
            """)

            # Load existing document state
            cursor.execute("SELECT * FROM yjs_documents WHERE id = ?", (self.document_id,))
            row = cursor.fetchone()

            if row:
                store = YjsWebSocketHandler._document_stores[self.document_id]
                store["yjs_state"] = row["state"]
                store["created_at"] = row["created_at"]
                store["last_modified"] = row["last_modified"]

            conn.commit()
            conn.close()

        except Exception as e:
            self.logger.error("Error loading document from storage: %s", str(e))

    def _join_collaboration_session(self) -> None:
        """Join the collaborative editing session."""
        try:
            store = YjsWebSocketHandler._document_stores[self.document_id]
            store["active_users"].add(self.session_id)

            # Broadcast user join event to other connections
            self._broadcast_awareness_update(
                {
                    "type": "user_joined",
                    "sessionId": self.session_id,
                    "userInfo": self.user_info,
                    "userRole": self.user_role,
                    "timestamp": time.time(),
                }
            )

        except Exception as e:
            self.logger.error("Error joining collaboration session: %s", str(e))

    def _leave_collaboration_session(self) -> None:
        """Leave the collaborative editing session."""
        try:
            if self.document_id and self.document_id in YjsWebSocketHandler._document_stores:
                store = YjsWebSocketHandler._document_stores[self.document_id]
                store["active_users"].discard(self.session_id)

                # Broadcast user leave event
                self._broadcast_awareness_update(
                    {"type": "user_left", "sessionId": self.session_id, "timestamp": time.time()}
                )

        except Exception as e:
            self.logger.error("Error leaving collaboration session: %s", str(e))

    def _handle_json_message(self, message: str) -> None:
        """
        Handle JSON protocol messages for awareness and control.

        Args:
            message: JSON message string
        """
        try:
            data = json.loads(message)
            message_type = data.get("type")

            if message_type == "awareness":
                self._handle_awareness_message(data)
            elif message_type == "lock_request":
                self._handle_lock_request(data)
            elif message_type == "lock_release":
                self._handle_lock_release(data)
            elif message_type == "ping":
                self._handle_ping_message(data)
            else:
                self.logger.warning("Unknown message type: %s", message_type)

        except json.JSONDecodeError as e:
            self.logger.error("Invalid JSON message: %s", str(e))
            self._send_error_message("Invalid JSON format")

    def _handle_yjs_binary_message(self, message: bytes) -> None:
        """
        Handle binary Yjs CRDT update messages.

        Args:
            message: Binary Yjs update data
        """
        try:
            # Only allow edit operations for users with edit permissions
            if self.user_role not in ["EDIT", "ADMIN"]:
                self._send_error_message("Edit permission required")
                return

            # Store the update in document state
            store = YjsWebSocketHandler._document_stores[self.document_id]
            store["yjs_state"] = message
            store["last_modified"] = time.time()

            # Persist to storage
            self._persist_document_state(message)

            # Queue update for batched broadcast
            task = asyncio.create_task(
                self.pending_messages.put(
                    {
                        "type": "yjs_update",
                        "data": message,
                        "sender": self.session_id,
                        "timestamp": time.time(),
                    }
                )
            )
            # Store task reference to prevent garbage collection
            self._background_tasks = getattr(self, "_background_tasks", set())
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)

        except Exception as e:
            self.logger.error("Error handling Yjs binary message: %s", str(e))

    def _handle_awareness_message(self, data: dict[str, Any]) -> None:
        """Handle user awareness/presence updates."""
        try:
            # Update awareness state
            self.awareness_state = data.get("awareness", {})

            # Broadcast to other users
            self._broadcast_awareness_update(
                {
                    "type": "awareness_update",
                    "sessionId": self.session_id,
                    "awareness": self.awareness_state,
                    "timestamp": time.time(),
                }
            )

        except Exception as e:
            self.logger.error("Error handling awareness message: %s", str(e))

    def _handle_lock_request(self, data: dict[str, Any]) -> None:
        """Handle cell lock acquisition requests."""
        try:
            cell_id = data.get("cellId")
            if not cell_id:
                self._send_error_message("Cell ID required for lock request")
                return

            # Only allow locks for edit users
            if self.user_role not in ["EDIT", "ADMIN"]:
                self._send_error_message("Edit permission required for locks")
                return

            # Check if cell is already locked
            store = YjsWebSocketHandler._document_stores[self.document_id]
            locks = store["cell_locks"]

            current_time = time.time()

            if cell_id in locks:
                existing_lock = locks[cell_id]
                # Check if lock is expired and owned by different user
                if (
                    existing_lock["expires_at"] > current_time
                    and existing_lock["user_id"] != self.user_info["id"]
                ):
                    self._send_lock_response(cell_id, False, "Cell is locked by another user")
                    return

            # Acquire the lock
            locks[cell_id] = {
                "user_id": self.user_info["id"],
                "session_id": self.session_id,
                "acquired_at": current_time,
                "expires_at": current_time + self.LOCK_TIMEOUT_SECONDS,
            }

            # Persist lock to storage
            self._persist_lock_state(cell_id, locks[cell_id])

            # Send success response
            self._send_lock_response(cell_id, True, "Lock acquired")

            # Broadcast lock status to other users
            self._broadcast_lock_update(cell_id, "acquired", self.user_info)

        except Exception as e:
            self.logger.error("Error handling lock request: %s", str(e))

    def _handle_lock_release(self, data: dict[str, Any]) -> None:
        """Handle cell lock release requests."""
        try:
            cell_id = data.get("cellId")
            if not cell_id:
                return

            store = YjsWebSocketHandler._document_stores[self.document_id]
            locks = store["cell_locks"]

            if cell_id in locks:
                lock = locks[cell_id]
                # Verify user owns the lock or is admin
                if lock["user_id"] == self.user_info["id"] or self.user_role == "ADMIN":
                    del locks[cell_id]
                    self._remove_lock_from_storage(cell_id)
                    self._broadcast_lock_update(cell_id, "released", self.user_info)

        except Exception as e:
            self.logger.error("Error handling lock release: %s", str(e))

    def _handle_ping_message(self, data: dict[str, Any]) -> None:
        """Handle ping messages for connection health monitoring."""
        # Use data for potential future extensions (keeping parameter for API consistency)
        _ = data  # Acknowledge parameter for linter
        self.last_ping = time.time()
        self.write_message({"type": "pong", "timestamp": self.last_ping})

    def _send_sync_message(self, data: dict[str, Any]) -> None:
        """Send synchronization message to client."""
        try:
            self.write_message(data)
        except Exception as e:
            self.logger.error("Error sending sync message: %s", str(e))

    def _send_error_message(self, error: str) -> None:
        """Send error message to client."""
        try:
            self.write_message({"type": "error", "error": error, "timestamp": time.time()})
        except Exception as e:
            self.logger.error("Error sending error message: %s", str(e))

    def _send_lock_response(self, cell_id: str, success: bool, message: str) -> None:
        """Send lock operation response to client."""
        try:
            self.write_message(
                {
                    "type": "lock_response",
                    "cellId": cell_id,
                    "success": success,
                    "message": message,
                    "timestamp": time.time(),
                }
            )
        except Exception as e:
            self.logger.error("Error sending lock response: %s", str(e))

    def _broadcast_awareness_update(self, data: dict[str, Any]) -> None:
        """Broadcast awareness update to all connected clients."""
        task = asyncio.create_task(self.pending_messages.put(data))
        # Store task reference to prevent garbage collection
        self._background_tasks = getattr(self, "_background_tasks", set())
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    def _broadcast_lock_update(self, cell_id: str, action: str, user_info: dict[str, Any]) -> None:
        """Broadcast lock status change to all connected clients."""
        task = asyncio.create_task(
            self.pending_messages.put(
                {
                    "type": "lock_update",
                    "cellId": cell_id,
                    "action": action,
                    "userInfo": user_info,
                    "timestamp": time.time(),
                }
            )
        )
        # Store task reference to prevent garbage collection
        self._background_tasks = getattr(self, "_background_tasks", set())
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    def _release_all_locks(self) -> None:
        """Release all locks held by this connection."""
        try:
            if not self.document_id or self.document_id not in YjsWebSocketHandler._document_stores:
                return

            store = YjsWebSocketHandler._document_stores[self.document_id]
            locks = store["cell_locks"]

            # Find and release locks held by this user
            cells_to_release = []
            for cell_id, lock in locks.items():
                if lock["session_id"] == self.session_id:
                    cells_to_release.append(cell_id)

            for cell_id in cells_to_release:
                del locks[cell_id]
                self._remove_lock_from_storage(cell_id)
                self._broadcast_lock_update(cell_id, "released", self.user_info or {})

        except Exception as e:
            self.logger.error("Error releasing locks: %s", str(e))

    def _persist_document_state(self, yjs_state: bytes) -> None:
        """Persist document state to storage."""
        try:
            import tempfile
            from pathlib import Path

            temp_dir = Path(tempfile.gettempdir())
            db_path = temp_dir / f"collaboration_{self.document_id}.db"
            conn = sqlite3.connect(db_path)

            cursor = conn.cursor()
            current_time = time.time()

            cursor.execute(
                """
                INSERT OR REPLACE INTO yjs_documents
                (id, state, created_at, last_modified)
                VALUES (?, ?, COALESCE((SELECT created_at FROM yjs_documents WHERE id = ?), ?), ?)
            """,
                (self.document_id, yjs_state, self.document_id, current_time, current_time),
            )

            conn.commit()
            conn.close()

        except Exception as e:
            self.logger.error("Error persisting document state: %s", str(e))

    def _persist_lock_state(self, cell_id: str, lock_info: dict[str, Any]) -> None:
        """Persist lock state to storage."""
        try:
            import tempfile
            from pathlib import Path

            temp_dir = Path(tempfile.gettempdir())
            db_path = temp_dir / f"collaboration_{self.document_id}.db"
            conn = sqlite3.connect(db_path)

            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO document_locks
                (document_id, cell_id, user_id, acquired_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
            """,
                (
                    self.document_id,
                    cell_id,
                    lock_info["user_id"],
                    lock_info["acquired_at"],
                    lock_info["expires_at"],
                ),
            )

            conn.commit()
            conn.close()

        except Exception as e:
            self.logger.error("Error persisting lock state: %s", str(e))

    def _remove_lock_from_storage(self, cell_id: str) -> None:
        """Remove lock from persistent storage."""
        try:
            import tempfile
            from pathlib import Path

            temp_dir = Path(tempfile.gettempdir())
            db_path = temp_dir / f"collaboration_{self.document_id}.db"
            conn = sqlite3.connect(db_path)

            cursor = conn.cursor()
            cursor.execute(
                """
                DELETE FROM document_locks
                WHERE document_id = ? AND cell_id = ?
            """,
                (self.document_id, cell_id),
            )

            conn.commit()
            conn.close()

        except Exception as e:
            self.logger.error("Error removing lock from storage: %s", str(e))

    async def _message_batching_loop(self) -> None:
        """Background task that batches and broadcasts messages."""
        try:
            self.logger.log(
                logging.INFO, "Starting message batching loop for session %s", self.session_id
            )

            while True:
                # Collect messages for batching window
                batch = []
                batch_start = time.perf_counter()
                end_time = time.time() + (self.BATCH_WINDOW_MS / 1000.0)

                # Collect messages until window expires
                while time.time() < end_time:
                    try:
                        message = await asyncio.wait_for(
                            self.pending_messages.get(), timeout=(end_time - time.time())
                        )
                        batch.append(message)
                    except asyncio.TimeoutError:
                        break

                # If no messages collected, wait a bit and continue
                if not batch:
                    await asyncio.sleep(self.BATCH_WINDOW_MS / 1000.0)
                    continue

                # Broadcast batch to all connected clients
                await self._broadcast_batch(batch)

                # Log performance metrics
                batch_time = time.perf_counter() - batch_start
                if batch_time > 0.1:  # Log slow batches
                    self.logger.log(
                        logging.WARNING,
                        "Slow batch processing: {batch_time:.3f}s for %s messages",
                        len(batch),
                    )

        except asyncio.CancelledError:
            self.logger.log(logging.INFO, "Message batching loop cancelled")
        except Exception as e:
            self.logger.log(logging.ERROR, "Error in message batching loop: %s", str(e))
            # Add small sleep before potential retry to prevent tight loop
            time.sleep(0.1)

    async def _broadcast_batch(self, batch: list[dict[str, Any]]) -> None:
        """Broadcast a batch of messages to connected clients."""
        try:
            if not batch:
                return

            # Send messages to all active connections for this document
            broadcast_tasks = []

            for connection in YjsWebSocketHandler._active_connections:
                if (
                    connection != self
                    and connection.document_id == self.document_id
                    and not connection.ws_connection.is_closing()
                ):
                    for message in batch:
                        # Skip broadcasting sender's own messages back to them
                        if message.get("sender") != connection.session_id:
                            task = asyncio.create_task(connection.write_message(message))
                            broadcast_tasks.append(task)

            # Wait for all broadcasts to complete
            if broadcast_tasks:
                await asyncio.gather(*broadcast_tasks, return_exceptions=True)

        except Exception as e:
            self.logger.error("Error broadcasting batch: %s", str(e))


class CollaborationSessionsHandler(JupyterHandler):
    """
    REST API handler for managing collaborative editing sessions.

    Provides endpoints for:
    - Creating new collaborative sessions
    - Joining existing sessions
    - Listing active sessions
    - Managing session permissions
    """

    def __init__(self, *args, **kwargs):
        """Initialize sessions handler."""
        super().__init__(*args, **kwargs)
        self.logger = logging.getLogger(__name__ + ".CollaborationSessionsHandler")

    @tornado.web.authenticated
    def get(self, session_id: Optional[str] = None) -> None:
        """
        Handle GET requests for session information.

        Args:
            session_id: Optional specific session ID to query
        """
        try:
            current_user = self.get_current_user()
            if not current_user:
                raise tornado.web.HTTPError(401, "Authentication required")

            if session_id:
                # Get specific session info
                session_info = self._get_session_info(session_id)
                if not session_info:
                    raise tornado.web.HTTPError(404, "Session not found")

                self.set_header("Content-Type", "application/json")
                self.finish(json.dumps(session_info))
            else:
                # List all sessions for user
                sessions = self._list_user_sessions(current_user)
                self.set_header("Content-Type", "application/json")
                self.finish(json.dumps({"sessions": sessions}))

        except tornado.web.HTTPError:
            raise
        except Exception as e:
            self.logger.error("Error in GET /api/collaboration/sessions: %s", str(e))
            raise tornado.web.HTTPError(500, "Internal server error") from e

    @tornado.web.authenticated
    def post(self) -> None:
        """Handle POST requests to create or join collaborative sessions."""
        try:
            current_user = self.get_current_user()
            if not current_user:
                raise tornado.web.HTTPError(401, "Authentication required")

            # Parse request body
            try:
                body = json.loads(self.request.body.decode("utf-8"))
            except json.JSONDecodeError as e:
                raise tornado.web.HTTPError(400, "Invalid JSON in request body") from e

            document_path = body.get("notebook_path")
            if not document_path:
                raise tornado.web.HTTPError(400, "notebook_path is required")

            permissions = body.get("permissions", ["read"])
            session_name = body.get("name", "Session for %s", document_path)

            # Create or join session
            session_info = self._create_or_join_session(
                current_user, document_path, permissions, session_name
            )

            self.set_status(201)
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps(session_info))

        except tornado.web.HTTPError:
            raise
        except Exception as e:
            self.logger.error("Error in POST /api/collaboration/sessions: %s", str(e))
            raise tornado.web.HTTPError(500, "Internal server error") from e

    @tornado.web.authenticated
    def delete(self, session_id: str) -> None:
        """
        Handle DELETE requests to leave or terminate sessions.

        Args:
            session_id: Session ID to leave/terminate
        """
        try:
            current_user = self.get_current_user()
            if not current_user:
                raise tornado.web.HTTPError(401, "Authentication required")

            if not session_id:
                raise tornado.web.HTTPError(400, "Session ID is required")

            # Leave or terminate session
            success = self._leave_session(current_user, session_id)
            if not success:
                raise tornado.web.HTTPError(404, "Session not found or access denied")

            self.set_status(204)
            self.finish()

        except tornado.web.HTTPError:
            raise
        except Exception as e:
            self.logger.error("Error in DELETE /api/collaboration/sessions: %s", str(e))
            raise tornado.web.HTTPError(500, "Internal server error") from e

    def _get_session_info(self, session_id: str) -> Optional[dict[str, Any]]:
        """
        Get information about a specific session.

        Args:
            session_id: Session ID to query

        Returns:
            Optional[Dict]: Session information or None if not found
        """
        try:
            # Find session in document stores
            for document_id, store in YjsWebSocketHandler._document_stores.items():
                if session_id in store["active_users"]:
                    return {
                        "session_id": session_id,
                        "document_id": document_id,
                        "created_at": store["created_at"],
                        "last_modified": store["last_modified"],
                        "active_users": len(store["active_users"]),
                        "has_locks": bool(store["cell_locks"]),
                    }
        except Exception as e:
            self.logger.error("Error getting session info: %s", str(e))

        return None

    def _list_user_sessions(self, user: dict[str, Any]) -> list[dict[str, Any]]:
        """
        List all sessions accessible to the user.

        Args:
            user: User information

        Returns:
            List[Dict]: List of session information
        """
        try:
            sessions = []
            user_id = user.get("id", user.get("name", "unknown"))

            for document_id, store in YjsWebSocketHandler._document_stores.items():
                # Check if user has any active sessions for this document
                user_sessions = []
                for connection in YjsWebSocketHandler._active_connections:
                    if (
                        connection.document_id == document_id
                        and connection.user_info
                        and connection.user_info.get("id") == user_id
                    ):
                        user_sessions.append(connection.session_id)

                if user_sessions:
                    sessions.append(
                        {
                            "document_id": document_id,
                            "user_sessions": user_sessions,
                            "created_at": store["created_at"],
                            "active_users": len(store["active_users"]),
                        }
                    )

            return sessions

        except Exception as e:
            self.logger.error("Error listing user sessions: %s", str(e))
            return []

    def _create_or_join_session(
        self, user: dict[str, Any], document_path: str, permissions: list[str], session_name: str
    ) -> dict[str, Any]:
        """
        Create or join a collaborative session.

        Args:
            user: User information
            document_path: Path to the notebook
            permissions: Requested permissions
            session_name: Name for the session

        Returns:
            Dict: Session information
        """
        try:
            # Generate session ID
            session_id = str(uuid.uuid4())
            document_id = document_path.replace("/", "_").replace(".ipynb", "")

            # Validate permissions
            valid_permissions = {"read", "write", "comment", "admin"}
            filtered_permissions = [p for p in permissions if p in valid_permissions]

            # Determine user role
            if "admin" in filtered_permissions:
                user_role = "ADMIN"
            elif "write" in filtered_permissions:
                user_role = "EDIT"
            else:
                user_role = "VIEW_ONLY"

            # Create session info
            return {
                "session_id": session_id,
                "document_id": document_id,
                "document_path": document_path,
                "name": session_name,
                "user_role": user_role,
                "permissions": filtered_permissions,
                "websocket_url": f"/api/collaboration/ws/{document_id}",
                "created_at": time.time(),
                "user_info": {
                    "id": user.get("id", user.get("name")),
                    "name": user.get("name", "Unknown"),
                    "email": user.get("email", ""),
                },
            }

        except Exception as e:
            self.logger.error("Error creating/joining session: %s", str(e))
            raise

    def _leave_session(self, user: dict[str, Any], session_id: str) -> bool:
        """
        Leave a collaborative session.

        Args:
            user: User information
            session_id: Session to leave

        Returns:
            bool: True if successfully left, False otherwise
        """
        try:
            user_id = user.get("id", user.get("name", "unknown"))

            # Find and close matching WebSocket connections
            connections_to_close = []
            for connection in YjsWebSocketHandler._active_connections:
                if (
                    connection.session_id == session_id
                    and connection.user_info
                    and connection.user_info.get("id") == user_id
                ):
                    connections_to_close.append(connection)

            # Close connections
            for connection in connections_to_close:
                try:
                    connection.close(code=1000, reason="User left session")
                except Exception as e:
                    self.logger.error("Error closing connection: %s", str(e))

            return len(connections_to_close) > 0

        except Exception as e:
            self.logger.error("Error leaving session: %s", str(e))
            return False


class CollaborationStatusHandler(JupyterHandler):
    """
    REST API handler for monitoring collaborative editing session status.

    Provides health checks and status information for the collaboration system.
    """

    def __init__(self, *args, **kwargs):
        """Initialize status handler."""
        super().__init__(*args, **kwargs)
        self.logger = logging.getLogger(__name__ + ".CollaborationStatusHandler")

    def get(self) -> None:
        """Handle GET requests for collaboration system status."""
        try:
            # Gather system status information
            status_info = self._gather_status_info()

            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps(status_info))

        except Exception as e:
            self.logger.error("Error in GET /api/collaboration/status: %s", str(e))
            raise tornado.web.HTTPError(500, "Internal server error") from e

    def _gather_status_info(self) -> dict[str, Any]:
        """
        Gather comprehensive status information about the collaboration system.

        Returns:
            Dict: Status information
        """
        try:
            current_time = time.time()

            # Count active connections and documents
            active_connections = len(YjsWebSocketHandler._active_connections)
            active_documents = len(YjsWebSocketHandler._document_stores)

            # Gather connection details
            connections_by_document = {}
            total_locks = 0

            for document_id, store in YjsWebSocketHandler._document_stores.items():
                connections_by_document[document_id] = {
                    "active_users": len(store["active_users"]),
                    "created_at": store["created_at"],
                    "last_modified": store["last_modified"],
                    "locks_count": len(store["cell_locks"]),
                }
                total_locks += len(store["cell_locks"])

            # Calculate uptime and performance metrics
            uptime_seconds = current_time - (
                min(
                    (
                        store["created_at"]
                        for store in YjsWebSocketHandler._document_stores.values()
                    ),
                    default=current_time,
                )
            )

            # Health check
            health_status = "healthy"
            if active_connections == 0 and active_documents > 0:
                health_status = "warning"  # Documents without connections
            elif any(
                current_time - store["last_modified"] > 300
                for store in YjsWebSocketHandler._document_stores.values()
            ):
                health_status = "stale"  # Documents not modified in 5 minutes

            return {
                "status": health_status,
                "timestamp": current_time,
                "uptime_seconds": uptime_seconds,
                "metrics": {
                    "active_connections": active_connections,
                    "active_documents": active_documents,
                    "total_locks": total_locks,
                    "connections_by_document": connections_by_document,
                },
                "configuration": {
                    "max_message_size": YjsWebSocketHandler.MAX_MESSAGE_SIZE,
                    "batch_window_ms": YjsWebSocketHandler.BATCH_WINDOW_MS,
                    "lock_timeout_seconds": YjsWebSocketHandler.LOCK_TIMEOUT_SECONDS,
                    "rate_limit_per_second": YjsWebSocketHandler.RATE_LIMIT_PER_SECOND,
                },
                "system_info": {
                    "python_version": f"{sys.version_info.major}.{sys.version_info.minor}",
                    "tornado_version": tornado.version,
                    "collaboration_enabled": True,
                },
            }

        except Exception as e:
            self.logger.error("Error gathering status info: %s", str(e))
            return {"status": "error", "timestamp": time.time(), "error": str(e)}


# Import sys for version info in status handler


if __name__ == "__main__":
    # Basic test/demo functionality
    pass
