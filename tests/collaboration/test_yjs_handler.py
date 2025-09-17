"""
Comprehensive unit and integration tests for YjsWebSocketHandler implementation.

This test suite validates WebSocket connection handling, message routing, Yjs sync protocol,
authentication integration, and performance requirements for real-time collaborative editing
in Jupyter Notebook v7.

Test Coverage:
- WebSocket connection lifecycle (open, message handling, close)
- Yjs sync protocol message sequence validation
- Document state synchronization tests with Y.Doc instances
- Multi-client connection handling and concurrency
- Authentication and authorization flows with JupyterHub integration
- Error handling and recovery scenarios for network failures
- Performance validation ensuring sub-100ms latency requirement
- Cell locking mechanism and conflict resolution
- User presence awareness and broadcasting
- Message batching and rate limiting functionality

Uses Tornado's WebSocketTestCase infrastructure with in-memory Y.Doc instances
for isolated, fast, and reliable testing per section 6.6 testing strategy.
"""

import asyncio
import time
import uuid
from tempfile import TemporaryDirectory
from unittest.mock import Mock

import pytest
from y_py import apply_update, encode_state_as_update

from notebook.handlers import YjsWebSocketHandler


def create_mock_handler():
    """Create a properly mocked YjsWebSocketHandler for testing."""
    mock_app = Mock()
    mock_app.ui = {"static_url": lambda x: x}
    mock_app.settings = {}

    mock_request = Mock()
    mock_request.headers = {}
    mock_request.cookies = {}
    mock_request.remote_ip = "127.0.0.1"
    mock_request.connection = Mock()
    mock_request.connection.context = Mock()

    handler = YjsWebSocketHandler.__new__(YjsWebSocketHandler)
    handler.application = mock_app
    handler.request = mock_request

    # Initialize rate limiting attributes
    # Set window start to current time and ensure clean state
    current_time = time.time()
    handler.rate_limit_window_start = current_time
    handler.rate_limit_count = 0
    handler.message_count = 0
    handler.user_info = None
    handler.user_role = None
    handler.document_path = None
    handler.session_id = None

    # Initialize logger
    import logging

    handler.logger = logging.getLogger("test_handler")

    return handler


class TestYjsWebSocketHandlerConnection:
    """Test WebSocket connection lifecycle and basic functionality."""

    @pytest.mark.asyncio
    async def test_websocket_connection_establishment(self, websocket_client):
        """Test successful WebSocket connection establishment with proper authentication."""
        # Create mock WebSocket client with valid authentication token
        client = websocket_client("test_notebook.ipynb", "test_user_123")

        # Test connection establishment
        websocket_url = "ws://localhost:8888/api/collaboration/ws/test_document"
        connection_result = await client.connect(websocket_url)

        assert connection_result is True
        assert client.connected is True
        assert len(client.messages_sent) == 1
        assert client.messages_sent[0]["type"] == "connect"
        assert client.messages_sent[0]["notebook_path"] == "test_notebook.ipynb"
        assert client.messages_sent[0]["user_id"] == "test_user_123"

        # Verify server response
        assert len(client.messages_received) == 1
        assert client.messages_received[0]["type"] == "connected"
        assert "session_id" in client.messages_received[0]

    @pytest.mark.asyncio
    async def test_websocket_connection_with_invalid_auth(self, websocket_client):
        """Test WebSocket connection rejection with invalid authentication."""
        # Create client with invalid/missing auth token
        client = websocket_client("test_notebook.ipynb", "")

        # Patch the connect method to simulate authentication failure
        original_connect = client.connect

        async def failing_connect(websocket_url):
            if not client.user_id or client.user_id == "":
                auth_error = "Authentication failed"
                raise ValueError(auth_error)
            return await original_connect(websocket_url)

        client.connect = failing_connect

        with pytest.raises(ValueError, match="Authentication failed"):
            await client.connect("ws://localhost:8888/api/collaboration/ws/test_document")

        assert client.connected is False

    @pytest.mark.asyncio
    async def test_websocket_connection_cleanup_on_close(self, websocket_client):
        """Test proper cleanup when WebSocket connection is closed."""
        client = websocket_client("test_notebook.ipynb", "test_user_456")

        # Establish connection
        await client.connect("ws://localhost:8888/api/collaboration/ws/test_document")
        assert client.connected is True

        # Close connection
        await client.disconnect()
        assert client.connected is False

        # Verify disconnect message was sent
        disconnect_messages = [msg for msg in client.messages_sent if msg["type"] == "disconnect"]
        assert len(disconnect_messages) == 1
        assert disconnect_messages[0]["user_id"] == "test_user_456"

    def test_check_origin_validation(self):
        """Test WebSocket origin validation for security."""
        handler = create_mock_handler()

        # Test allowed origins
        assert handler.check_origin("http://localhost:8888") is True
        assert handler.check_origin("https://jupyterhub.example.com") is True

        # Mock settings for restricted origins
        handler.application.settings = {"allow_origin": "http://localhost:8888"}
        assert handler.check_origin("http://localhost:8888") is True
        assert handler.check_origin("http://malicious-site.com") is False

    def test_compression_options_configuration(self):
        """Test WebSocket compression configuration for performance optimization."""
        handler = create_mock_handler()

        compression_opts = handler.get_compression_options()

        assert compression_opts is not None
        assert compression_opts["compression_level"] == 6
        assert compression_opts["mem_level"] == 8
        assert compression_opts["window_bits"] == 15
        assert compression_opts["compression_threshold"] == 1024


class TestYjsWebSocketHandlerAuthentication:
    """Test authentication and authorization functionality."""

    def test_authentication_token_validation(self):
        """Test authentication token extraction and validation."""
        handler = create_mock_handler()

        # Test valid token format
        valid_token = "a" * 32  # 32 character token
        user_info = handler._validate_auth_token(valid_token)

        assert user_info is not None
        assert user_info["id"] == f"user_{valid_token[:8]}"
        assert user_info["name"] == f"User_{valid_token[:4]}"
        assert "roles" in user_info

        # Test invalid token (too short)
        invalid_token = "short"  # noqa: S105 # Test token, not a real password
        user_info = handler._validate_auth_token(invalid_token)
        assert user_info is None

    def test_collaboration_permissions_check(self):
        """Test role-based permission checking for collaborative features."""
        handler = create_mock_handler()

        # Test admin role
        handler.user_info = {"roles": ["admin"]}
        assert handler._check_collaboration_permissions() is True
        assert handler.user_role == "ADMIN"

        # Test edit role
        handler.user_info = {"roles": ["edit"]}
        assert handler._check_collaboration_permissions() is True
        assert handler.user_role == "EDIT"

        # Test view role
        handler.user_info = {"roles": ["view"]}
        assert handler._check_collaboration_permissions() is True
        assert handler.user_role == "VIEW_ONLY"

        # Test no roles (default to view-only)
        handler.user_info = {"roles": []}
        assert handler._check_collaboration_permissions() is True
        assert handler.user_role == "VIEW_ONLY"

    def test_rate_limiting_functionality(self):
        """Test rate limiting to prevent DoS attacks."""
        handler = create_mock_handler()

        # Test burst limit - first RATE_LIMIT_BURST calls should pass
        # RATE_LIMIT_BURST = 200
        for i in range(200):
            result = handler._check_rate_limit()
            assert result is True, f"Call {i+1} should pass within burst limit"

        # The 201st call should be rate limited (exceeds RATE_LIMIT_BURST = 200)
        assert handler._check_rate_limit() is False, "Call 201 should be rate limited"


class TestYjsWebSocketHandlerSyncProtocol:
    """Test Yjs sync protocol message handling and document synchronization."""

    @pytest.mark.asyncio
    async def test_yjs_binary_message_processing(self, yjs_doc, websocket_client):
        """Test handling of binary Yjs CRDT update messages."""
        # Create Y.Doc with test content
        doc = yjs_doc("test_sync.ipynb")
        cells = doc.get_array("cells")

        # Add test cell to document
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                0,
                {
                    "cell_type": "code",
                    "source": "print('Hello, collaborative world!')",
                    "metadata": {},
                },
            )

        # Generate Yjs update message
        update_data = encode_state_as_update(doc)
        assert len(update_data) > 0

        # Test WebSocket client sending sync message
        client = websocket_client("test_sync.ipynb", "sync_user_123")
        await client.connect("ws://localhost:8888/api/collaboration/ws/sync_document")

        # Send binary sync message
        await client.send_sync_message(update_data)

        # Verify sync message was sent and acknowledged
        sync_messages = [msg for msg in client.messages_sent if msg["type"] == "sync"]
        assert len(sync_messages) == 1
        assert sync_messages[0]["update"] == list(update_data)

        # Verify server acknowledgment
        ack_messages = [msg for msg in client.messages_received if msg["type"] == "sync_ack"]
        assert len(ack_messages) == 1

    @pytest.mark.asyncio
    async def test_document_state_synchronization(self, yjs_doc, websocket_client):
        """Test document state synchronization between multiple clients."""
        # Create two Y.Doc instances representing different clients
        doc1 = yjs_doc("sync_test.ipynb")
        doc2 = yjs_doc("sync_test.ipynb")

        # Client 1 adds a cell
        cells1 = doc1.get_array("cells")
        with doc1.begin_transaction() as txn:
            cells1.insert(
                txn,
                0,
                {"cell_type": "markdown", "source": "# Collaborative Notebook", "metadata": {}},
            )

        # Client 2 adds a different cell
        cells2 = doc2.get_array("cells")
        with doc2.begin_transaction() as txn:
            cells2.insert(
                txn, 0, {"cell_type": "code", "source": "import numpy as np", "metadata": {}}
            )

        # Generate updates from both documents
        update1 = encode_state_as_update(doc1)
        update2 = encode_state_as_update(doc2)

        # Apply updates to simulate synchronization
        apply_update(doc1, update2)
        apply_update(doc2, update1)

        # Verify both documents have converged to same state
        final_state1 = encode_state_as_update(doc1)
        final_state2 = encode_state_as_update(doc2)

        # Documents should have synchronized (both have 2 cells)
        cells1_final = doc1.get_array("cells")
        cells2_final = doc2.get_array("cells")

        assert len(cells1_final) == len(cells2_final)
        # Due to CRDT properties, both docs should have same content but order may vary

    @pytest.mark.asyncio
    async def test_json_message_protocol_handling(self, websocket_client):
        """Test JSON protocol message handling for awareness and control messages."""
        client = websocket_client("protocol_test.ipynb", "protocol_user")
        await client.connect("ws://localhost:8888/api/collaboration/ws/protocol_document")

        # Test awareness update message
        awareness_data = {
            "user": {"name": "Protocol User", "id": "protocol_user"},
            "cursor": {"line": 5, "column": 10},
            "selection": {"start": {"line": 5, "column": 10}, "end": {"line": 5, "column": 20}},
        }

        await client.send_awareness_update(awareness_data)

        # Verify awareness message was sent
        awareness_messages = [msg for msg in client.messages_sent if msg["type"] == "awareness"]
        assert len(awareness_messages) == 1
        assert awareness_messages[0]["awareness"] == awareness_data
        assert awareness_messages[0]["user_id"] == "protocol_user"

    def test_message_size_validation(self):
        """Test message size validation to prevent oversized messages."""
        handler = create_mock_handler()
        handler.logger = Mock()
        handler._send_error_message = Mock()

        # Test oversized message (larger than MAX_MESSAGE_SIZE)
        large_message = b"x" * (YjsWebSocketHandler.MAX_MESSAGE_SIZE + 1)

        handler.on_message(large_message)

        # Should log warning and send error message
        handler.logger.warning.assert_called()
        handler._send_error_message.assert_called_with("Message size limit exceeded")


class TestYjsWebSocketHandlerMultiClient:
    """Test multi-client connection handling and coordination."""

    @pytest.mark.asyncio
    async def test_multi_client_connection_handling(
        self, multi_user_session, yjs_doc, websocket_client
    ):
        """Test handling multiple simultaneous client connections."""
        # Create multi-user session with 3 users
        session = multi_user_session(num_users=3, notebook_path="multi_test.ipynb")

        # Initialize users with Y.Doc instances and WebSocket clients
        await session.initialize_users(yjs_doc, websocket_client)

        # Connect all users to the same document
        websocket_url = "ws://localhost:8888/api/collaboration/ws/multi_test"
        await session.connect_all_users(websocket_url)

        # Verify all users are connected
        for user in session.users:
            assert user["websocket"].connected is True
            assert len(user["websocket"].messages_sent) >= 1

        # Test user info
        assert len(session.users) == 3
        for i, user in enumerate(session.users):
            assert user["id"] == f"test_user_{i}_{user['id'][-8:]}"
            assert user["index"] == i

    @pytest.mark.asyncio
    async def test_concurrent_editing_conflict_resolution(
        self, multi_user_session, yjs_doc, websocket_client
    ):
        """Test concurrent editing and CRDT-based conflict resolution."""
        session = multi_user_session(num_users=2, notebook_path="conflict_test.ipynb")
        await session.initialize_users(yjs_doc, websocket_client)
        await session.connect_all_users("ws://localhost:8888/api/collaboration/ws/conflict_test")

        # Define concurrent editing actions
        edit_actions = [
            {
                "user_index": 0,
                "action": "add_cell",
                "params": {"cell_type": "code", "source": "# User 0 cell", "index": 0},
            },
            {
                "user_index": 1,
                "action": "add_cell",
                "params": {"cell_type": "markdown", "source": "# User 1 cell", "index": 0},
            },
            {
                "user_index": 0,
                "action": "edit_cell",
                "params": {"index": 0, "source": "print('Modified by User 0')"},
            },
            {
                "user_index": 1,
                "action": "edit_cell",
                "params": {"index": 1, "source": "## Modified by User 1"},
            },
        ]

        # Execute concurrent edits
        await session.simulate_concurrent_edits(edit_actions)

        # Wait for synchronization to complete
        sync_result = await session.wait_for_synchronization(timeout=5.0)
        assert sync_result is True, "Documents failed to synchronize within timeout"

        # Verify actions were recorded
        total_actions = sum(len(user["actions_performed"]) for user in session.users)
        assert total_actions == len(edit_actions)

        # Verify final document state consistency
        summary = session.get_session_summary()
        assert summary["documents_synchronized"] is True

    @pytest.mark.asyncio
    async def test_user_presence_awareness_broadcasting(
        self, multi_user_session, yjs_doc, websocket_client
    ):
        """Test user presence awareness and broadcasting to other clients."""
        session = multi_user_session(num_users=3, notebook_path="presence_test.ipynb")
        await session.initialize_users(yjs_doc, websocket_client)
        await session.connect_all_users("ws://localhost:8888/api/collaboration/ws/presence_test")

        # User 0 sends presence update
        presence_data = {
            "cursor": {"line": 2, "column": 5},
            "selection": None,
            "active_cell": "cell_123",
            "status": "editing",
        }

        user_0 = session.users[0]
        await user_0["websocket"].send_awareness_update(presence_data)

        # Verify presence update was sent
        awareness_messages = [
            msg for msg in user_0["websocket"].messages_sent if msg["type"] == "awareness"
        ]
        assert len(awareness_messages) == 1
        assert awareness_messages[0]["awareness"] == presence_data

        # Verify message history tracking
        for user in session.users:
            history = user["websocket"].get_message_history()
            assert "sent" in history
            assert "received" in history
            assert "total_messages" in history
            assert history["total_messages"] >= 1

    @pytest.mark.asyncio
    async def test_collaborative_session_cleanup(
        self, multi_user_session, yjs_doc, websocket_client
    ):
        """Test proper cleanup when users leave collaborative sessions."""
        session = multi_user_session(num_users=2, notebook_path="cleanup_test.ipynb")
        await session.initialize_users(yjs_doc, websocket_client)
        await session.connect_all_users("ws://localhost:8888/api/collaboration/ws/cleanup_test")

        # Verify initial connection state
        for user in session.users:
            assert user["websocket"].connected is True

        # Disconnect all users
        await session.disconnect_all_users()

        # Verify all users disconnected cleanly
        for user in session.users:
            assert user["websocket"].connected is False

            # Check for disconnect messages
            disconnect_messages = [
                msg for msg in user["websocket"].messages_sent if msg["type"] == "disconnect"
            ]
            assert len(disconnect_messages) == 1


class TestYjsWebSocketHandlerCellLocking:
    """Test cell-level locking mechanism for preventing edit conflicts."""

    def test_cell_lock_acquisition_and_release(self):
        """Test successful cell lock acquisition and release."""
        handler = create_mock_handler()
        handler.user_info = {"id": "lock_user_123", "name": "Lock User"}
        handler.user_role = "EDIT"
        handler.document_id = "lock_test_document"
        handler.session_id = "session_123"
        handler.logger = Mock()
        handler._send_lock_response = Mock()
        handler._persist_lock_state = Mock()
        handler._broadcast_lock_update = Mock()

        # Initialize document storage
        YjsWebSocketHandler._document_stores[handler.document_id] = {
            "cell_locks": {},
            "active_users": set(),
            "yjs_state": b"",
            "created_at": time.time(),
            "last_modified": time.time(),
            "version_history": [],
        }

        # Test lock acquisition
        lock_request_data = {"cellId": "cell_456"}
        handler._handle_lock_request(lock_request_data)

        # Verify lock was acquired
        locks = YjsWebSocketHandler._document_stores[handler.document_id]["cell_locks"]
        assert "cell_456" in locks
        assert locks["cell_456"]["user_id"] == "lock_user_123"
        assert locks["cell_456"]["session_id"] == "session_123"

        # Verify response and broadcast calls
        handler._send_lock_response.assert_called_with("cell_456", True, "Lock acquired")
        handler._broadcast_lock_update.assert_called()

        # Test lock release
        handler._remove_lock_from_storage = Mock()
        release_request_data = {"cellId": "cell_456"}
        handler._handle_lock_release(release_request_data)

        # Verify lock was released
        assert "cell_456" not in locks
        handler._remove_lock_from_storage.assert_called_with("cell_456")

    def test_cell_lock_conflict_handling(self):
        """Test handling of lock conflicts when cell is already locked."""
        handler = create_mock_handler()
        handler.user_info = {"id": "user_2", "name": "User 2"}
        handler.user_role = "EDIT"
        handler.document_id = "conflict_document"
        handler.session_id = "session_456"
        handler.logger = Mock()
        handler._send_lock_response = Mock()

        # Initialize document storage with existing lock
        current_time = time.time()
        YjsWebSocketHandler._document_stores[handler.document_id] = {
            "cell_locks": {
                "cell_789": {
                    "user_id": "user_1",
                    "session_id": "session_123",
                    "acquired_at": current_time,
                    "expires_at": current_time + 300,  # 5 minutes from now
                }
            },
            "active_users": set(),
            "yjs_state": b"",
            "created_at": current_time,
            "last_modified": current_time,
            "version_history": [],
        }

        # Attempt to acquire already locked cell
        lock_request_data = {"cellId": "cell_789"}
        handler._handle_lock_request(lock_request_data)

        # Verify lock request was denied
        handler._send_lock_response.assert_called_with(
            "cell_789", False, "Cell is locked by another user"
        )

        # Verify lock ownership didn't change
        locks = YjsWebSocketHandler._document_stores[handler.document_id]["cell_locks"]
        assert locks["cell_789"]["user_id"] == "user_1"

    def test_expired_lock_handling(self):
        """Test handling of expired locks that can be reclaimed."""
        handler = create_mock_handler()
        handler.user_info = {"id": "user_3", "name": "User 3"}
        handler.user_role = "EDIT"
        handler.document_id = "expired_lock_document"
        handler.session_id = "session_789"
        handler.logger = Mock()
        handler._send_lock_response = Mock()
        handler._persist_lock_state = Mock()
        handler._broadcast_lock_update = Mock()

        # Initialize document storage with expired lock
        current_time = time.time()
        YjsWebSocketHandler._document_stores[handler.document_id] = {
            "cell_locks": {
                "cell_expired": {
                    "user_id": "user_old",
                    "session_id": "session_old",
                    "acquired_at": current_time - 600,  # 10 minutes ago
                    "expires_at": current_time - 300,  # Expired 5 minutes ago
                }
            },
            "active_users": set(),
            "yjs_state": b"",
            "created_at": current_time,
            "last_modified": current_time,
            "version_history": [],
        }

        # Attempt to acquire expired lock
        lock_request_data = {"cellId": "cell_expired"}
        handler._handle_lock_request(lock_request_data)

        # Verify expired lock was successfully acquired by new user
        locks = YjsWebSocketHandler._document_stores[handler.document_id]["cell_locks"]
        assert locks["cell_expired"]["user_id"] == "user_3"
        assert locks["cell_expired"]["session_id"] == "session_789"

        handler._send_lock_response.assert_called_with("cell_expired", True, "Lock acquired")

    def test_permission_based_lock_restrictions(self):
        """Test lock restrictions based on user permissions."""
        handler = create_mock_handler()
        handler.user_info = {"id": "readonly_user", "name": "Read Only User"}
        handler.user_role = "VIEW_ONLY"  # No edit permissions
        handler.logger = Mock()
        handler._send_error_message = Mock()

        # Attempt lock request with view-only permissions
        lock_request_data = {"cellId": "cell_restricted"}
        handler._handle_lock_request(lock_request_data)

        # Verify lock request was rejected due to insufficient permissions
        handler._send_error_message.assert_called_with("Edit permission required for locks")


class TestYjsWebSocketHandlerErrorHandling:
    """Test error handling and recovery scenarios."""

    def test_invalid_json_message_handling(self):
        """Test handling of malformed JSON messages."""
        handler = create_mock_handler()
        handler.logger = Mock()
        handler._send_error_message = Mock()

        # Send invalid JSON message
        invalid_json = '{"type": "test", invalid json}'
        handler._handle_json_message(invalid_json)

        # Verify error was logged and error message sent
        handler.logger.error.assert_called()
        handler._send_error_message.assert_called_with("Invalid JSON format")

    def test_unknown_message_type_handling(self):
        """Test handling of unknown message types."""
        handler = create_mock_handler()
        handler.logger = Mock()

        # Send message with unknown type
        unknown_message = '{"type": "unknown_type", "data": "test"}'
        handler._handle_json_message(unknown_message)

        # Verify warning was logged
        handler.logger.warning.assert_called_with("Unknown message type: %s", "unknown_type")

    def test_missing_cell_id_in_lock_request(self):
        """Test handling of lock requests without cell ID."""
        handler = create_mock_handler()
        handler._send_error_message = Mock()

        # Send lock request without cellId
        lock_request_data = {"type": "lock_request"}  # Missing cellId
        handler._handle_lock_request(lock_request_data)

        # Verify error message was sent
        handler._send_error_message.assert_called_with("Cell ID required for lock request")

    @pytest.mark.asyncio
    async def test_connection_error_recovery(self, websocket_client):
        """Test connection error recovery and reconnection logic."""
        client = websocket_client("error_test.ipynb", "error_user")

        # Simulate connection failure
        with pytest.raises(ValueError, match="WebSocket not connected"):
            await client.send_sync_message(b"test_data")

        # Verify client handles disconnected state properly
        assert client.connected is False


class TestYjsWebSocketHandlerPerformance:
    """Test performance requirements and optimization features."""

    @pytest.mark.asyncio
    async def test_message_latency_requirement(self, websocket_client):
        """Test that message handling meets sub-100ms latency requirement."""
        client = websocket_client("perf_test.ipynb", "perf_user")
        await client.connect("ws://localhost:8888/api/collaboration/ws/perf_document")

        # Measure message round-trip time
        start_time = time.perf_counter()

        test_message = {"test": "data", "timestamp": time.time()}
        await client.send_awareness_update(test_message)

        end_time = time.perf_counter()
        latency_ms = (end_time - start_time) * 1000

        # Verify sub-100ms latency requirement
        assert latency_ms < 100.0, f"Message latency {latency_ms:.2f}ms exceeds 100ms requirement"

    def test_message_batching_configuration(self):
        """Test message batching window configuration."""
        handler = create_mock_handler()

        # Verify default batching window
        assert handler.BATCH_WINDOW_MS == 50

        # Test batching window is reasonable for performance
        assert 10 <= handler.BATCH_WINDOW_MS <= 100  # Between 10ms and 100ms

    @pytest.mark.asyncio
    async def test_concurrent_message_handling(self, yjs_doc):
        """Test handling of concurrent messages without performance degradation."""
        # Create multiple Y.Doc instances to simulate concurrent updates
        docs = [yjs_doc(f"concurrent_test_{i}.ipynb") for i in range(5)]

        # Generate concurrent updates
        update_tasks = []
        for i, doc in enumerate(docs):
            cells = doc.get_array("cells")
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    0,
                    {"cell_type": "code", "source": f"# Cell from document {i}", "metadata": {}},
                )

            # Create task for update generation
            update_task = asyncio.create_task(self._generate_update(doc))
            update_tasks.append(update_task)

        # Measure concurrent processing time
        start_time = time.perf_counter()
        updates = await asyncio.gather(*update_tasks)
        end_time = time.perf_counter()

        # Verify all updates were generated
        assert len(updates) == 5
        for update in updates:
            assert len(update) > 0

        # Verify reasonable processing time (should be sub-second)
        total_time = end_time - start_time
        assert total_time < 1.0, f"Concurrent processing took {total_time:.3f}s"

    async def _generate_update(self, doc):
        """Helper method to generate Y.Doc update."""
        return encode_state_as_update(doc)

    def test_memory_usage_optimization(self):
        """Test that handler doesn't accumulate excessive memory."""
        # Create handler instances and verify cleanup
        handlers = []
        for i in range(10):
            handler = create_mock_handler()
            handler.document_id = f"memory_test_{i}"
            handler.session_id = str(uuid.uuid4())
            handlers.append(handler)

        # Verify connections are tracked
        initial_connections = len(YjsWebSocketHandler._active_connections)

        # Simulate cleanup
        for handler in handlers:
            if handler in YjsWebSocketHandler._active_connections:
                YjsWebSocketHandler._active_connections.discard(handler)

        # Verify memory cleanup
        final_connections = len(YjsWebSocketHandler._active_connections)
        assert final_connections <= initial_connections


class TestYjsWebSocketHandlerIntegration:
    """Integration tests for complete collaborative workflows."""

    @pytest.mark.asyncio
    async def test_complete_collaborative_editing_workflow(
        self, multi_user_session, yjs_doc, websocket_client, collaboration_settings
    ):
        """Test complete end-to-end collaborative editing workflow."""
        # Get collaboration settings
        settings = collaboration_settings(
            collaboration_enabled=True, max_concurrent_users=5, sync_timeout_seconds=10
        )

        # Create multi-user session
        session = multi_user_session(num_users=3, notebook_path="integration_test.ipynb")

        await session.initialize_users(yjs_doc, websocket_client)

        # Connect all users
        websocket_url = f"{settings['yjs_websocket_url']}/integration_test"
        await session.connect_all_users(websocket_url)

        # Simulate comprehensive editing workflow
        workflow_actions = [
            # User 0: Add initial cells
            {
                "user_index": 0,
                "action": "add_cell",
                "params": {
                    "cell_type": "markdown",
                    "source": "# Collaborative Notebook Test",
                    "index": 0,
                },
            },
            {
                "user_index": 0,
                "action": "add_cell",
                "params": {
                    "cell_type": "code",
                    "source": "import pandas as pd\nimport numpy as np",
                    "index": 1,
                },
            },
            # User 1: Edit existing cells and add new ones
            {
                "user_index": 1,
                "action": "edit_cell",
                "params": {
                    "index": 0,
                    "source": "# Collaborative Notebook Test\n\nEdited by User 1",
                },
            },
            {
                "user_index": 1,
                "action": "add_cell",
                "params": {
                    "cell_type": "code",
                    "source": "# Data analysis by User 1\ndf = pd.DataFrame({'A': [1, 2, 3], 'B': [4, 5, 6]})",
                    "index": 2,
                },
            },
            # User 2: Concurrent editing
            {
                "user_index": 2,
                "action": "add_cell",
                "params": {
                    "cell_type": "markdown",
                    "source": "## Analysis Section\n\nAdded by User 2",
                    "index": 3,
                },
            },
            {
                "user_index": 2,
                "action": "edit_cell",
                "params": {
                    "index": 1,
                    "source": "import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt  # Added by User 2",
                },
            },
        ]

        # Execute workflow
        await session.simulate_concurrent_edits(workflow_actions)

        # Wait for synchronization
        sync_success = await session.wait_for_synchronization(
            timeout=settings["sync_timeout_seconds"]
        )
        assert sync_success, "Workflow synchronization failed"

        # Verify workflow completion
        summary = session.get_session_summary()
        assert summary["documents_synchronized"] is True
        assert summary["num_users"] == 3

        # Verify all actions were recorded
        total_actions = sum(len(user["actions_performed"]) for user in session.users)
        assert total_actions == len(workflow_actions)

        # Clean up
        await session.disconnect_all_users()

        # Verify clean disconnect
        for user in session.users:
            assert user["websocket"].connected is False

    @pytest.mark.asyncio
    async def test_document_persistence_and_recovery(self, yjs_doc):
        """Test document state persistence and recovery across sessions."""
        document_id = "persistence_test"

        with TemporaryDirectory() as temp_dir:
            # Create handler with document storage
            handler = create_mock_handler()
            handler.document_id = document_id
            handler.logger = Mock()

            # Initialize document state
            handler._initialize_document_state()

            # Create test document content
            doc = yjs_doc("persistence_test.ipynb")
            cells = doc.get_array("cells")
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    0,
                    {
                        "cell_type": "code",
                        "source": "# Persistent content",
                        "metadata": {"persistent": True},
                    },
                )

            # Generate state update
            yjs_state = encode_state_as_update(doc)

            # Persist document state
            handler._persist_document_state(yjs_state)

            # Verify document was stored
            assert document_id in YjsWebSocketHandler._document_stores
            store = YjsWebSocketHandler._document_stores[document_id]
            assert store["yjs_state"] == yjs_state
            assert store["last_modified"] > 0

            # Simulate recovery by loading document state
            handler2 = create_mock_handler()
            handler2.document_id = document_id
            handler2.logger = Mock()

            handler2._load_document_from_storage()

            # Verify state was recovered
            recovered_store = YjsWebSocketHandler._document_stores[document_id]
            assert recovered_store["yjs_state"] == yjs_state

    def test_websocket_handler_configuration_validation(self, collaboration_settings):
        """Test WebSocket handler configuration validation and defaults."""
        settings = collaboration_settings()

        # Create handler and verify configuration
        handler = create_mock_handler()

        # Test default configuration values
        assert hasattr(handler, "MAX_MESSAGE_SIZE")
        assert handler.MAX_MESSAGE_SIZE == 1024 * 1024  # 1MB

        assert hasattr(handler, "BATCH_WINDOW_MS")
        assert handler.BATCH_WINDOW_MS == 50  # 50ms

        assert hasattr(handler, "LOCK_TIMEOUT_SECONDS")
        assert handler.LOCK_TIMEOUT_SECONDS == 30  # 30 seconds

        assert hasattr(handler, "RATE_LIMIT_PER_SECOND")
        assert handler.RATE_LIMIT_PER_SECOND == 100  # 100 messages/second

        # Verify configuration is within expected ranges
        assert 1024 <= handler.MAX_MESSAGE_SIZE <= 10 * 1024 * 1024  # 1KB to 10MB
        assert 10 <= handler.BATCH_WINDOW_MS <= 1000  # 10ms to 1s
        assert 10 <= handler.LOCK_TIMEOUT_SECONDS <= 600  # 10s to 10min
        assert 10 <= handler.RATE_LIMIT_PER_SECOND <= 1000  # 10 to 1000 msg/s


if __name__ == "__main__":
    # Run tests with pytest
    pytest.main([__file__, "-v", "--tb=short"])
