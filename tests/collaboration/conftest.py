"""
Pytest configuration and shared fixtures for collaboration tests.

This module provides comprehensive test infrastructure for collaborative features,
including WebSocket mocking, Y.Doc instances, collaborative app setup, and
multi-user simulation utilities.
"""

import asyncio
import json
import os

# Import the base conftest patterns
import sys
import time
import uuid
from typing import Optional

import pytest
from fakeredis import FakeRedis
from y_py import YDoc, encode_state_as_update

# Global storage for YDoc test metadata since YDoc doesn't allow arbitrary attributes
_YDOC_TEST_METADATA = {}

# Global storage for document locks to simulate distributed locking
_DOCUMENT_LOCKS = {}  # document_id -> {cell_id -> client_session_id}

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


@pytest.fixture
def collab_app(make_notebook_app, mock_redis):
    """
    Create a collaborative-enabled Jupyter Notebook application instance for testing.

    This fixture extends the base notebook app with collaboration features enabled,
    including WebSocket handlers, Y.Doc integration, and optional Redis clustering.

    Returns:
        JupyterNotebookApp: Configured app instance with collaboration enabled
    """

    def _create_collab_app(**kwargs):
        # Default collaboration settings
        collaboration_config = {
            "collaboration_enabled": True,
            "websocket_url": "ws://localhost:8888/api/collaboration/ws",
            "yjs_document_provider": "memory",
            "redis_client": mock_redis,
            "max_concurrent_users": 10,
            "sync_timeout": 30,
            "lock_timeout": 300,
            "presence_timeout": 60,
            **kwargs,
        }

        # Create base app with collaboration settings
        app = make_notebook_app(**collaboration_config)

        # Initialize collaboration handlers
        app.web_app.add_handlers(
            r".*",  # Match any host
            [
                (r"/api/collaboration/ws", "notebook.handlers.YjsWebSocketHandler"),
                (r"/api/collaboration/sessions", "notebook.handlers.CollaborationSessionHandler"),
                (r"/api/collaboration/permissions", "notebook.handlers.PermissionHandler"),
            ],
        )

        return app

    return _create_collab_app


@pytest.fixture
def yjs_doc():
    """
    Create a fresh Y.Doc instance for CRDT testing with notebook structure.

    Sets up a Y.Doc with the standard notebook document structure including
    cells array, metadata map, and kernel spec. Provides utilities for
    document state validation and update tracking.

    Returns:
        Y.YDoc: Configured Y.Doc instance with notebook structure
    """

    def _create_yjs_doc(notebook_path: str = "test.ipynb"):
        # Create new Y.Doc instance
        doc = YDoc()

        # Set up standard notebook structure
        cells = doc.get_array("cells")
        metadata = doc.get_map("metadata")
        nbformat = doc.get_map("nbformat_node")

        # Initialize with basic notebook metadata using transactions
        with doc.begin_transaction() as txn:
            nbformat.set(txn, "nbformat", 4)
            nbformat.set(txn, "nbformat_minor", 5)

            metadata.set(
                txn,
                "kernelspec",
                {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3",
                },
            )
            metadata.set(
                txn,
                "language_info",
                {
                    "codemirror_mode": {"name": "ipython", "version": 3},
                    "file_extension": ".py",
                    "mimetype": "text/x-python",
                    "name": "python",
                    "nbconvert_exporter": "python",
                    "pygments_lexer": "ipython3",
                    "version": "3.9.0",
                },
            )

        # Store test attributes in global storage since YDoc doesn't allow arbitrary attributes
        doc_id = doc.client_id
        _YDOC_TEST_METADATA[doc_id] = {"notebook_path": notebook_path, "update_history": []}

        def track_updates(txn):
            if doc_id in _YDOC_TEST_METADATA:
                _YDOC_TEST_METADATA[doc_id]["update_history"].append(
                    {"transaction": str(txn), "timestamp": asyncio.get_event_loop().time()}
                )

        doc.observe_after_transaction(track_updates)

        # Add a helper method to access test metadata
        def get_test_metadata():
            return _YDOC_TEST_METADATA.get(doc_id, {})

        # Store the helper function globally so tests can access it
        _YDOC_TEST_METADATA[f"{doc_id}_getter"] = get_test_metadata

        return doc

    return _create_yjs_doc


@pytest.fixture
def mock_redis():
    """
    Create a mock Redis instance for connection pooling and clustering tests.

    Provides a FakeRedis instance that mimics Redis behavior for testing
    collaborative features that depend on Redis for state synchronization
    across multiple server instances.

    Returns:
        FakeRedis: Mock Redis instance for testing
    """
    redis_instance = FakeRedis(decode_responses=True)

    # Add collaboration-specific mock methods
    redis_instance.collaboration_sessions = {}
    redis_instance.user_presence = {}
    redis_instance.document_locks = {}

    def mock_set_session(session_id: str, session_data: dict):
        redis_instance.collaboration_sessions[session_id] = json.dumps(session_data)
        return True

    def mock_get_session(session_id: str):
        if session_id in redis_instance.collaboration_sessions:
            return json.loads(redis_instance.collaboration_sessions[session_id])
        return None

    def mock_set_presence(user_id: str, presence_data: dict):
        redis_instance.user_presence[user_id] = json.dumps(presence_data)
        return True

    def mock_get_presence(user_id: str):
        if user_id in redis_instance.user_presence:
            return json.loads(redis_instance.user_presence[user_id])
        return None

    def mock_set_lock(cell_id: str, lock_data: dict):
        redis_instance.document_locks[cell_id] = json.dumps(lock_data)
        return True

    def mock_get_lock(cell_id: str):
        if cell_id in redis_instance.document_locks:
            return json.loads(redis_instance.document_locks[cell_id])
        return None

    # Attach mock methods
    redis_instance.set_collaboration_session = mock_set_session
    redis_instance.get_collaboration_session = mock_get_session
    redis_instance.set_user_presence = mock_set_presence
    redis_instance.get_user_presence = mock_get_presence
    redis_instance.set_document_lock = mock_set_lock
    redis_instance.get_document_lock = mock_get_lock

    return redis_instance


@pytest.fixture
def websocket_client():
    """
    Create WebSocket test client fixtures for real-time communication testing.

    Provides utilities for creating WebSocket connections to the collaboration
    endpoints, sending/receiving Yjs sync messages, and validating WebSocket
    communication protocols.

    Returns:
        callable: Dual-interface factory function for creating WebSocket test clients
    """

    async def _create_websocket_client(
        url_path: Optional[str] = None, headers: Optional[dict] = None
    ):
        """
        Create a mock WebSocket client that matches the test expectations.

        Args:
            url_path: WebSocket endpoint path (e.g., "/api/collaboration/ws/doc_id")
            headers: Request headers including Authorization

        Returns:
            MockWebSocketClient: Configured client ready for testing
        """
        headers = headers or {}

        # Extract document ID from URL path
        document_id = url_path.split("/")[-1] if "/" in url_path else "test_doc"

        # Check authentication from headers
        auth_header = headers.get("Authorization", "")
        authenticated = "Bearer test_token_" in auth_header

        # Always require authentication for collaboration endpoints
        if not authenticated:
            auth_error = "Authentication failed"
            raise Exception(auth_error)

        class MockWebSocketClient:
            def __init__(self, url_path: str, headers: dict, document_id: str, authenticated: bool):
                self.url_path = url_path
                self.headers = headers
                self.document_id = document_id
                self.authenticated = authenticated
                self.session_id = str(uuid.uuid4()) if authenticated else None

                # Connection state
                self.connection_ready = asyncio.Event()
                self.ws_connection = type(
                    "MockConnection", (), {"closed": False, "close": lambda: None}
                )()

                # Message handling
                self.messages_sent = []
                self.messages_received = []
                self.message_queue = asyncio.Queue()
                self.rate_limited = False  # Track if rate limit has been triggered

                # Simulate initial connection
                if authenticated:
                    self.connection_ready.set()
                    # Queue initial sync message
                    initial_sync = {
                        "type": "sync",
                        "documentId": self.document_id,
                        "sessionId": self.session_id,
                        "userRole": "EDIT",  # Default role
                        "timestamp": time.time(),
                    }
                    initial_sync_task = asyncio.create_task(self._queue_message(initial_sync))  # noqa: RUF006
                    # Task will run in background for async message delivery

            async def _queue_message(self, message):
                """Queue a message for reading by tests."""
                await self.message_queue.put(message)
                self.messages_received.append(message)

            async def read_message(self, timeout: float = 5.0):
                """Read next message from the WebSocket."""
                try:
                    return await asyncio.wait_for(self.message_queue.get(), timeout=timeout)
                except asyncio.TimeoutError:
                    timeout_msg = f"No message received within {timeout}s"
                    raise asyncio.TimeoutError(timeout_msg) from None

            async def write_message(self, data, binary: bool = False):
                """Send a message through WebSocket."""
                if not self.authenticated:
                    auth_error = "Not authenticated"
                    raise Exception(auth_error)

                # Check for oversized messages first (before parsing)
                data_size = len(data) if isinstance(data, (str, bytes)) else len(str(data))
                if data_size > 1024 * 1024:  # 1MB limit
                    error_response = {"type": "error", "error": "Message size limit exceeded"}
                    await self._queue_message(error_response)
                    # Still record the message attempt
                    self.messages_sent.append(
                        {"data": data, "binary": binary, "timestamp": time.time()}
                    )
                    return

                # Check for rate limiting (simplified)
                if len(self.messages_sent) >= 200:  # Rate limit
                    if not self.rate_limited:
                        # Send rate limit error only once
                        self.rate_limited = True
                        error_response = {"type": "error", "error": "Rate limit exceeded"}

                        await self._queue_message(error_response)

                    # Still record the message attempt but don't process further
                    self.messages_sent.append(
                        {"data": data, "binary": binary, "timestamp": time.time()}
                    )

                    return

                # Parse message if it's JSON
                if not binary and isinstance(data, str):
                    try:
                        message = json.loads(data)
                        message_type = message.get("type", "unknown")

                        # Handle different message types with appropriate responses
                        if message_type == "ping":
                            response = {"type": "pong", "timestamp": time.time()}

                            await self._queue_message(response)

                        elif message_type == "lock_request":
                            cell_id = message.get("cellId")

                            # Initialize document locks if needed
                            if self.document_id not in _DOCUMENT_LOCKS:
                                _DOCUMENT_LOCKS[self.document_id] = {}

                            doc_locks = _DOCUMENT_LOCKS[self.document_id]

                            # Check if cell is already locked
                            if cell_id in doc_locks and doc_locks[cell_id] != self.session_id:
                                # Cell is locked by another client
                                response = {
                                    "type": "lock_response",
                                    "cellId": cell_id,
                                    "success": False,
                                    "error": "Cell is already locked by another user",
                                    "timestamp": time.time(),
                                }
                            else:
                                # Acquire lock
                                doc_locks[cell_id] = self.session_id
                                response = {
                                    "type": "lock_response",
                                    "cellId": cell_id,
                                    "success": True,
                                    "timestamp": time.time(),
                                }

                            await self._queue_message(response)

                        elif message_type == "lock_release":
                            cell_id = message.get("cellId")

                            # Release lock if this client holds it
                            if self.document_id in _DOCUMENT_LOCKS:
                                doc_locks = _DOCUMENT_LOCKS[self.document_id]
                                if cell_id in doc_locks and doc_locks[cell_id] == self.session_id:
                                    del doc_locks[cell_id]

                    except json.JSONDecodeError:
                        pass  # Handle as raw message

                self.messages_sent.append(
                    {"data": data, "binary": binary, "timestamp": time.time()}
                )

            async def close(self):
                """Close WebSocket connection."""
                self.ws_connection.closed = True
                self.connection_ready.clear()

                # Release all locks held by this client
                if self.document_id in _DOCUMENT_LOCKS:
                    doc_locks = _DOCUMENT_LOCKS[self.document_id]
                    cells_to_release = [
                        cell_id
                        for cell_id, session_id in doc_locks.items()
                        if session_id == self.session_id
                    ]
                    for cell_id in cells_to_release:
                        del doc_locks[cell_id]

            def get_message_history(self):
                """Get complete message exchange history."""
                return {
                    "sent": self.messages_sent,
                    "received": self.messages_received,
                    "total_messages": len(self.messages_sent) + len(self.messages_received),
                }

        return MockWebSocketClient(url_path, headers, document_id, authenticated)

    def dual_interface_factory(*args, **kwargs):
        """
        Dual interface factory that supports both calling patterns:
        1. websocket_client("notebook.ipynb", "user_id") - direct instantiation for test_yjs_handler.py
        2. await websocket_client(url, headers) - async factory for test_websocket.py
        """
        # Check if this looks like test_yjs_handler.py pattern vs test_websocket.py pattern
        if (
            len(args) == 2
            and isinstance(args[0], str)
            and isinstance(args[1], str)
            and not args[0].startswith("/")
        ):
            # test_yjs_handler.py pattern: websocket_client("notebook.ipynb", "user_id")
            notebook_name = args[0]
            user_id = args[1]

            # Create appropriate headers with auth token
            headers = {
                "Authorization": f"Bearer test_token_{user_id}",
                "User-Agent": "Test-WebSocket-Client",
                "X-User-ID": user_id,
            }

            # Create sync version that matches the old interface expectations
            class DirectWebSocketClient:
                def __init__(self, notebook_name: str, user_id: str, headers: dict):
                    self.notebook_name = notebook_name
                    self.user_id = user_id
                    self.headers = headers
                    self.connected = False
                    self.messages_sent = []
                    self.messages_received = []
                    self._mock_client = None

                async def connect(self, websocket_url: str):
                    """Connect to WebSocket endpoint."""
                    # Create the actual mock client when connecting
                    url_path = websocket_url.replace("ws://localhost:8888", "")
                    self._mock_client = await _create_websocket_client(url_path, self.headers)
                    self.connected = True

                    # Simulate the connection handshake messages that tests expect
                    connect_message = {
                        "type": "connect",
                        "notebook_path": self.notebook_name,
                        "user_id": self.user_id,
                        "timestamp": time.time(),
                    }
                    self.messages_sent.append(connect_message)

                    # Simulate server response
                    connected_response = {
                        "type": "connected",
                        "session_id": str(uuid.uuid4()),
                        "notebook_path": self.notebook_name,
                        "timestamp": time.time(),
                    }
                    self.messages_received.append(connected_response)

                    return True

                async def send_sync_message(self, yjs_data: bytes):
                    """Send Yjs binary sync message."""
                    if not self.connected:
                        connection_error = "WebSocket not connected"
                        raise ValueError(connection_error)
                    if self._mock_client:
                        await self._mock_client.write_message(yjs_data, binary=True)
                        # Track the sent message
                        self.messages_sent.append(
                            {
                                "type": "sync",
                                "update": list(
                                    yjs_data
                                ),  # Convert bytes to list as expected by test
                                "binary": True,
                                "timestamp": time.time(),
                            }
                        )

                        # Simulate receiving a sync acknowledgment from the server
                        sync_ack_response = {
                            "type": "sync_ack",
                            "document_id": self.notebook_name.replace(".ipynb", ""),
                            "user_id": self.user_id,
                            "sync_data": yjs_data.hex(),  # Convert binary to hex for JSON
                            "timestamp": time.time(),
                        }
                        self.messages_received.append(sync_ack_response)

                async def send_awareness_update(self, awareness_data: dict):
                    """Send awareness update message."""
                    if self._mock_client:
                        message = {
                            "type": "awareness",
                            "user_id": self.user_id,
                            "awareness": awareness_data,
                            "timestamp": time.time(),
                        }
                        await self._mock_client.write_message(json.dumps(message))
                        self.messages_sent.append(message)

                async def read_message(self, timeout: float = 5.0):
                    """Read message from WebSocket."""
                    if self._mock_client:
                        message = await self._mock_client.read_message(timeout)
                        self.messages_received.append(message)
                        return message
                    connection_error = "Client not connected"
                    raise Exception(connection_error)

                async def disconnect(self):
                    """Disconnect from WebSocket."""
                    if self._mock_client:
                        self._mock_client.ws_connection.closed = True
                        self.connected = False
                        # Simulate disconnect message
                        disconnect_message = {
                            "type": "disconnect",
                            "user_id": self.user_id,
                            "reason": "client_requested",
                            "timestamp": time.time(),
                        }
                        self.messages_sent.append(disconnect_message)

                def close(self):
                    """Close WebSocket connection."""
                    if self._mock_client:
                        self._mock_client.ws_connection.closed = True
                        self.connected = False

                def get_message_history(self):
                    """Get complete message exchange history."""
                    return {
                        "sent": self.messages_sent,
                        "received": self.messages_received,
                        "total_messages": len(self.messages_sent) + len(self.messages_received),
                    }

            return DirectWebSocketClient(notebook_name, user_id, headers)
        # test_websocket.py pattern: await websocket_client(url, headers) - call async factory
        if len(args) > 0:
            # Called with arguments, call the async function directly
            return _create_websocket_client(*args, **kwargs)
        # Called without arguments, return the async factory function
        return _create_websocket_client

    return dual_interface_factory


@pytest.fixture
def multi_user_session():
    """
    Create multi-user simulation helpers for collaborative testing scenarios.

    Provides utilities for simulating multiple concurrent users, coordinating
    their actions, and validating collaborative behaviors like conflict resolution,
    presence awareness, and document synchronization.

    Returns:
        callable: Factory function for multi-user test sessions
    """

    def _create_multi_user_session(num_users: int = 2, notebook_path: str = "test.ipynb"):
        class MultiUserTestSession:
            def __init__(self, num_users: int, notebook_path: str):
                self.num_users = num_users
                self.notebook_path = notebook_path
                self.users = []
                self.yjs_docs = []
                self.websocket_clients = []
                self.coordination_events = {}

            async def initialize_users(self, yjs_doc_factory, websocket_factory):
                """Initialize all users with Y.Doc and WebSocket clients."""
                for i in range(self.num_users):
                    user_id = f"test_user_{i}_{uuid.uuid4().hex[:8]}"

                    # Create Y.Doc for this user
                    doc = yjs_doc_factory(self.notebook_path)

                    # Create WebSocket client for this user
                    ws_client = websocket_factory(self.notebook_path, user_id)

                    user_info = {
                        "id": user_id,
                        "index": i,
                        "doc": doc,
                        "websocket": ws_client,
                        "actions_performed": [],
                        "updates_received": [],
                    }

                    self.users.append(user_info)
                    self.yjs_docs.append(doc)
                    self.websocket_clients.append(ws_client)

            async def connect_all_users(self, websocket_url: str):
                """Connect all users to the collaboration WebSocket."""
                connection_tasks = []
                for user in self.users:
                    task = asyncio.create_task(user["websocket"].connect(websocket_url))
                    connection_tasks.append(task)

                await asyncio.gather(*connection_tasks)

            async def simulate_concurrent_edits(self, edit_actions: list):
                """
                Simulate concurrent editing actions by multiple users.

                Args:
                    edit_actions: List of dicts with 'user_index', 'action', 'params'
                """
                edit_tasks = []

                for action in edit_actions:
                    user_idx = action["user_index"]
                    action_type = action["action"]
                    params = action.get("params", {})

                    if user_idx >= len(self.users):
                        error_msg = f"Invalid user_index: {user_idx}"
                        raise ValueError(error_msg)

                    user = self.users[user_idx]

                    if action_type == "add_cell":
                        task = self._add_cell_action(user, params)
                    elif action_type == "edit_cell":
                        task = self._edit_cell_action(user, params)
                    elif action_type == "delete_cell":
                        task = self._delete_cell_action(user, params)
                    elif action_type == "move_cell":
                        task = self._move_cell_action(user, params)
                    else:
                        error_msg = f"Unknown action type: {action_type}"
                        raise ValueError(error_msg)

                    edit_tasks.append(task)

                # Execute all actions concurrently
                await asyncio.gather(*edit_tasks)

            async def _add_cell_action(self, user: dict, params: dict):
                """Simulate adding a cell."""
                cells = user["doc"].get_array("cells")
                cell_data = {
                    "cell_type": params.get("cell_type", "code"),
                    "source": params.get("source", ""),
                    "metadata": params.get("metadata", {}),
                }

                insert_index = params.get("index", len(cells))
                with user["doc"].begin_transaction() as txn:
                    cells.insert(txn, insert_index, cell_data)

                user["actions_performed"].append(
                    {
                        "action": "add_cell",
                        "params": params,
                        "timestamp": asyncio.get_event_loop().time(),
                    }
                )

                # Simulate WebSocket sync
                if user["websocket"].connected:
                    update_data = encode_state_as_update(user["doc"])
                    await user["websocket"].send_sync_message(update_data)

            async def _edit_cell_action(self, user: dict, params: dict):
                """Simulate editing a cell."""
                cells = user["doc"].get_array("cells")
                cell_index = params.get("index", 0)

                if cell_index < len(cells):
                    cell = cells[cell_index]
                    if isinstance(cell, dict):
                        cell["source"] = params.get("source", cell.get("source", ""))

                user["actions_performed"].append(
                    {
                        "action": "edit_cell",
                        "params": params,
                        "timestamp": asyncio.get_event_loop().time(),
                    }
                )

                # Simulate WebSocket sync
                if user["websocket"].connected:
                    update_data = encode_state_as_update(user["doc"])
                    await user["websocket"].send_sync_message(update_data)

            async def _delete_cell_action(self, user: dict, params: dict):
                """Simulate deleting a cell."""
                cells = user["doc"].get_array("cells")
                cell_index = params.get("index", 0)

                if cell_index < len(cells):
                    with user["doc"].begin_transaction() as txn:
                        cells.delete(txn, cell_index)

                user["actions_performed"].append(
                    {
                        "action": "delete_cell",
                        "params": params,
                        "timestamp": asyncio.get_event_loop().time(),
                    }
                )

                # Simulate WebSocket sync
                if user["websocket"].connected:
                    update_data = encode_state_as_update(user["doc"])
                    await user["websocket"].send_sync_message(update_data)

            async def _move_cell_action(self, user: dict, params: dict):
                """Simulate moving a cell."""
                cells = user["doc"].get_array("cells")
                from_index = params.get("from_index", 0)
                to_index = params.get("to_index", 1)

                if from_index < len(cells) and to_index <= len(cells):
                    with user["doc"].begin_transaction() as txn:
                        # Get cell data
                        cell_data = cells[from_index]
                        # Delete from original position
                        cells.delete(txn, from_index)
                        # Insert at new position (adjust index if moving forward)
                        insert_index = to_index if to_index < from_index else to_index - 1
                        cells.insert(txn, insert_index, cell_data)

                user["actions_performed"].append(
                    {
                        "action": "move_cell",
                        "params": params,
                        "timestamp": asyncio.get_event_loop().time(),
                    }
                )

                # Simulate WebSocket sync
                if user["websocket"].connected:
                    update_data = encode_state_as_update(user["doc"])
                    await user["websocket"].send_sync_message(update_data)

            async def wait_for_synchronization(self, timeout: float = 10.0):
                """Wait for all users' documents to reach consistent state."""
                start_time = asyncio.get_event_loop().time()

                while (asyncio.get_event_loop().time() - start_time) < timeout:
                    # Compare all document states
                    if self._are_documents_synchronized():
                        return True

                    await asyncio.sleep(0.1)

                return False

            def _are_documents_synchronized(self):
                """Check if all Y.Doc instances have the same state."""
                if len(self.yjs_docs) < 2:
                    return True

                # Get state vectors from all docs
                base_state = encode_state_as_update(self.yjs_docs[0])

                for doc in self.yjs_docs[1:]:
                    doc_state = encode_state_as_update(doc)
                    if base_state != doc_state:
                        return False

                return True

            async def disconnect_all_users(self):
                """Disconnect all WebSocket clients."""
                disconnect_tasks = []
                for user in self.users:
                    if user["websocket"].connected:
                        task = asyncio.create_task(user["websocket"].disconnect())
                        disconnect_tasks.append(task)

                await asyncio.gather(*disconnect_tasks)

            def get_session_summary(self):
                """Get comprehensive summary of the multi-user session."""
                return {
                    "num_users": self.num_users,
                    "notebook_path": self.notebook_path,
                    "users": [
                        {
                            "id": user["id"],
                            "actions_performed": len(user["actions_performed"]),
                            "connected": user["websocket"].connected,
                            "message_history": user["websocket"].get_message_history(),
                        }
                        for user in self.users
                    ],
                    "documents_synchronized": self._are_documents_synchronized(),
                    "total_updates": sum(len(doc._test_update_history) for doc in self.yjs_docs),
                }

        return MultiUserTestSession(num_users, notebook_path)

    return _create_multi_user_session


@pytest.fixture
def collaboration_settings():
    """
    Provide collaboration configuration settings for testing.

    Returns default and customizable settings for collaboration features
    including WebSocket URLs, timeouts, limits, and feature flags.

    Returns:
        dict: Collaboration settings configuration
    """

    def _get_collaboration_settings(**overrides):
        default_settings = {
            # Core collaboration settings
            "collaboration_enabled": True,
            "yjs_websocket_url": "ws://localhost:8888/api/collaboration/ws",
            "collaboration_api_base": "/api/collaboration",
            # WebSocket configuration
            "websocket_ping_interval": 30,
            "websocket_ping_timeout": 10,
            "websocket_close_timeout": 5,
            "websocket_max_message_size": 1024 * 1024,  # 1MB
            # Document synchronization
            "sync_debounce_ms": 50,
            "sync_timeout_seconds": 30,
            "document_cleanup_interval": 300,  # 5 minutes
            "max_history_entries": 100,
            # User presence and awareness
            "presence_timeout_seconds": 60,
            "awareness_update_interval": 1000,  # 1 second
            "max_concurrent_users": 10,
            # Cell locking
            "cell_lock_timeout_seconds": 300,  # 5 minutes
            "lock_acquisition_timeout": 5,
            "auto_release_inactive_locks": True,
            # Performance and scaling
            "redis_enabled": False,
            "redis_host": "localhost",
            "redis_port": 6379,
            "redis_db": 0,
            "connection_pool_size": 10,
            # Security and permissions
            "require_authentication": True,
            "default_permissions": "edit",  # 'view', 'edit', 'admin'
            "permission_inheritance": True,
            "session_timeout_minutes": 60,
            # Testing and development
            "debug_mode": True,
            "verbose_logging": True,
            "enable_performance_metrics": True,
            "mock_external_services": True,
        }

        # Apply any overrides and return combined settings
        return {**default_settings, **overrides}

    return _get_collaboration_settings
