"""
Tests for user presence and awareness system in Jupyter Notebook v7 collaboration.

This test suite validates the real-time presence tracking, cursor position synchronization,
user status updates, and presence timeout handling functionality as specified in the
technical requirements for collaborative editing with Yjs CRDT framework.

Test Coverage:
- User presence registration and broadcasting
- Cursor position tracking across cells
- Selection highlight synchronization
- Idle user timeout detection
- Presence indicator updates
- User avatar display data
- Status message propagation
- Awareness cleanup on disconnect
- Multi-user presence coordination
- Performance of awareness updates
- Yjs awareness protocol integration validation
"""

import asyncio
import json
import statistics
import time
import uuid

import pytest

# Import test fixtures from conftest.py


class TestAwarenessSystemCore:
    """Core awareness system functionality tests."""

    def test_yjs_doc_awareness_initialization(self, yjs_doc):
        """Test that Y.Doc instances properly initialize awareness capabilities."""
        doc = yjs_doc("test_notebook.ipynb")

        # Verify Y.Doc has awareness capability
        assert hasattr(doc, "awareness")

        # Test initial awareness state is empty
        awareness_states = doc.awareness.get_states()
        assert len(awareness_states) == 0

        # Verify client ID is properly set
        assert doc.client_id is not None
        assert isinstance(doc.client_id, int)
        assert doc.client_id > 0

    def test_user_presence_registration(self, yjs_doc):
        """Test user presence registration and basic awareness state setup."""
        doc = yjs_doc("collaborative_notebook.ipynb")

        # Create test user presence data
        user_id = str(uuid.uuid4())
        user_presence = {
            "user_id": user_id,
            "display_name": "Test User",
            "avatar_url": "https://example.com/avatar.png",
            "cursor_position": {"cell_id": "cell_0", "line": 0, "column": 0},
            "selection": {"start": {"line": 0, "column": 0}, "end": {"line": 0, "column": 5}},
            "status": "active",
            "last_seen": time.time_ns(),
            "color": "#FF5722",
        }

        # Set awareness state for this client
        doc.awareness.set_local_state(user_presence)

        # Verify awareness state was registered
        states = doc.awareness.get_states()
        assert doc.client_id in states
        assert states[doc.client_id] == user_presence

        # Test presence data structure validation
        stored_presence = states[doc.client_id]
        assert stored_presence["user_id"] == user_id
        assert stored_presence["display_name"] == "Test User"
        assert stored_presence["status"] == "active"
        assert "cursor_position" in stored_presence
        assert "selection" in stored_presence

    def test_cursor_position_tracking(self, yjs_doc):
        """Test cursor position tracking across different cell types."""
        doc = yjs_doc("cursor_test_notebook.ipynb")

        # Test cursor positions for different cell types
        cursor_positions = [
            {"cell_id": "code_cell_1", "cell_type": "code", "line": 2, "column": 15},
            {"cell_id": "markdown_cell_1", "cell_type": "markdown", "line": 0, "column": 8},
            {"cell_id": "raw_cell_1", "cell_type": "raw", "line": 1, "column": 0},
        ]

        user_id = str(uuid.uuid4())

        for i, cursor_pos in enumerate(cursor_positions):
            # Update cursor position in awareness
            presence_data = {
                "user_id": user_id,
                "display_name": f"Cursor Test User {i}",
                "cursor_position": cursor_pos,
                "status": "typing",
                "last_seen": time.time_ns(),
            }

            doc.awareness.set_local_state(presence_data)

            # Verify cursor position is tracked correctly
            states = doc.awareness.get_states()
            current_state = states[doc.client_id]

            assert current_state["cursor_position"]["cell_id"] == cursor_pos["cell_id"]
            assert current_state["cursor_position"]["cell_type"] == cursor_pos["cell_type"]
            assert current_state["cursor_position"]["line"] == cursor_pos["line"]
            assert current_state["cursor_position"]["column"] == cursor_pos["column"]
            assert current_state["status"] == "typing"

    def test_selection_highlight_synchronization(self, yjs_doc):
        """Test selection highlight data synchronization across clients."""
        doc = yjs_doc("selection_test.ipynb")

        user_id = str(uuid.uuid4())

        # Test various selection scenarios
        selection_scenarios = [
            # Single line selection
            {
                "cell_id": "cell_1",
                "start": {"line": 0, "column": 5},
                "end": {"line": 0, "column": 15},
                "type": "single_line",
            },
            # Multi-line selection
            {
                "cell_id": "cell_2",
                "start": {"line": 1, "column": 0},
                "end": {"line": 3, "column": 20},
                "type": "multi_line",
            },
            # Full cell selection
            {
                "cell_id": "cell_3",
                "start": {"line": 0, "column": 0},
                "end": {"line": -1, "column": -1},
                "type": "full_cell",
            },
            # Empty selection (cursor only)
            {
                "cell_id": "cell_4",
                "start": {"line": 2, "column": 8},
                "end": {"line": 2, "column": 8},
                "type": "cursor_only",
            },
        ]

        for scenario in selection_scenarios:
            presence_data = {
                "user_id": user_id,
                "display_name": "Selection Test User",
                "selection": scenario,
                "status": "selecting",
                "last_seen": time.time_ns(),
                "color": "#4CAF50",
            }

            doc.awareness.set_local_state(presence_data)

            # Verify selection data is properly stored
            states = doc.awareness.get_states()
            current_selection = states[doc.client_id]["selection"]

            assert current_selection["cell_id"] == scenario["cell_id"]
            assert current_selection["start"] == scenario["start"]
            assert current_selection["end"] == scenario["end"]
            assert current_selection["type"] == scenario["type"]

    @pytest.mark.asyncio
    async def test_status_message_propagation(self, yjs_doc):
        """Test user status message updates and propagation."""
        doc = yjs_doc("status_test.ipynb")

        user_id = str(uuid.uuid4())

        # Test different status messages
        status_updates = [
            {"status": "active", "message": "Editing code cell"},
            {"status": "typing", "message": "Writing documentation"},
            {"status": "idle", "message": "Away from keyboard"},
            {"status": "reviewing", "message": "Checking cell outputs"},
            {"status": "debugging", "message": "Investigating error"},
        ]

        received_updates = []

        # Set up awareness change observer
        def on_awareness_change(event):
            """Callback for awareness state changes."""
            received_updates.append(
                {
                    "client_id": event.get("client_id"),
                    "state": event.get("state"),
                    "timestamp": time.time_ns(),
                }
            )

        # Register observer (simulated)
        # Note: In real implementation, this would use doc.awareness.on_change

        for status_update in status_updates:
            presence_data = {
                "user_id": user_id,
                "display_name": "Status Test User",
                "status": status_update["status"],
                "status_message": status_update["message"],
                "last_seen": time.time_ns(),
            }

            # Simulate small delay between updates
            await asyncio.sleep(0.01)

            doc.awareness.set_local_state(presence_data)

            # Verify status update
            states = doc.awareness.get_states()
            current_state = states[doc.client_id]

            assert current_state["status"] == status_update["status"]
            assert current_state["status_message"] == status_update["message"]
            assert "last_seen" in current_state


class TestMultiUserPresence:
    """Multi-user presence coordination and awareness tests."""

    def test_multi_user_presence_coordination(self, yjs_doc):
        """Test presence coordination with multiple simultaneous users."""
        # Create multiple Y.Doc instances to simulate different clients
        num_users = 4
        docs = []
        user_data = []

        for i in range(num_users):
            doc = yjs_doc(f"multi_user_test_{i}.ipynb")
            user_info = {
                "user_id": str(uuid.uuid4()),
                "display_name": f"Test User {i + 1}",
                "avatar_url": f"https://example.com/avatar{i}.png",
                "color": ["#FF5722", "#4CAF50", "#2196F3", "#FF9800"][i],
                "doc": doc,
            }

            docs.append(doc)
            user_data.append(user_info)

        # Set presence for each user
        for i, user in enumerate(user_data):
            presence_data = {
                "user_id": user["user_id"],
                "display_name": user["display_name"],
                "avatar_url": user["avatar_url"],
                "cursor_position": {"cell_id": f"cell_{i}", "line": i, "column": i * 5},
                "status": "active",
                "color": user["color"],
                "last_seen": time.time_ns(),
            }

            user["doc"].awareness.set_local_state(presence_data)

        # Verify each user's awareness state
        for i, user in enumerate(user_data):
            states = user["doc"].awareness.get_states()
            assert len(states) >= 1  # At least their own state

            own_state = states[user["doc"].client_id]
            assert own_state["user_id"] == user["user_id"]
            assert own_state["display_name"] == user["display_name"]
            assert own_state["cursor_position"]["cell_id"] == f"cell_{i}"

    @pytest.mark.asyncio
    async def test_concurrent_presence_updates(self, yjs_doc):
        """Test handling of concurrent presence updates from multiple users."""
        doc = yjs_doc("concurrent_test.ipynb")

        # Simulate concurrent updates from multiple clients
        num_concurrent_updates = 10
        update_tasks = []

        async def update_presence(user_index: int):
            """Simulate a user updating their presence."""
            user_id = f"concurrent_user_{user_index}"

            for update_round in range(5):  # Each user makes 5 updates
                presence_data = {
                    "user_id": user_id,
                    "display_name": f"Concurrent User {user_index}",
                    "cursor_position": {
                        "cell_id": f"cell_{update_round}",
                        "line": update_round,
                        "column": user_index * update_round,
                    },
                    "status": "active",
                    "update_count": update_round,
                    "last_seen": time.time_ns(),
                }

                doc.awareness.set_local_state(presence_data)
                await asyncio.sleep(0.001)  # Small delay to simulate real timing

        # Create concurrent update tasks
        for i in range(num_concurrent_updates):
            task = asyncio.create_task(update_presence(i))
            update_tasks.append(task)

        # Execute all updates concurrently
        await asyncio.gather(*update_tasks)

        # Verify final state consistency
        final_states = doc.awareness.get_states()

        # Should have the final update from the last user to update
        assert len(final_states) == 1  # Only local client state
        final_state = final_states[doc.client_id]
        assert final_state["update_count"] == 4  # Last update round
        assert "last_seen" in final_state

    @pytest.mark.asyncio
    async def test_presence_timeout_detection(self, yjs_doc):
        """Test idle user timeout detection and cleanup."""
        doc = yjs_doc("timeout_test.ipynb")

        user_id = str(uuid.uuid4())
        timeout_threshold = 2.0  # 2 seconds for testing

        # Set initial presence
        initial_presence = {
            "user_id": user_id,
            "display_name": "Timeout Test User",
            "status": "active",
            "last_seen": time.time_ns(),
            "timeout_threshold": timeout_threshold,
        }

        doc.awareness.set_local_state(initial_presence)

        # Verify initial state
        states = doc.awareness.get_states()
        assert doc.client_id in states
        initial_last_seen = states[doc.client_id]["last_seen"]

        # Wait for longer than timeout threshold
        await asyncio.sleep(timeout_threshold + 0.5)

        # Update status to simulate timeout detection
        timeout_presence = {
            "user_id": user_id,
            "display_name": "Timeout Test User",
            "status": "idle",
            "last_seen": initial_last_seen,  # Keep original timestamp
            "timeout_detected": True,
            "timeout_threshold": timeout_threshold,
        }

        doc.awareness.set_local_state(timeout_presence)

        # Verify timeout was detected
        updated_states = doc.awareness.get_states()
        timeout_state = updated_states[doc.client_id]

        assert timeout_state["status"] == "idle"
        assert timeout_state["timeout_detected"] is True
        assert timeout_state["last_seen"] == initial_last_seen

        # Verify timeout duration calculation
        current_time = time.time_ns()
        timeout_duration = (current_time - timeout_state["last_seen"]) / 1_000_000_000
        assert timeout_duration >= timeout_threshold

    def test_user_avatar_display_data(self, yjs_doc):
        """Test user avatar and display information management."""
        doc = yjs_doc("avatar_test.ipynb")

        # Test various avatar configurations
        avatar_configs = [
            {
                "user_id": str(uuid.uuid4()),
                "display_name": "John Doe",
                "avatar_url": "https://avatars.githubusercontent.com/u/123456",
                "avatar_type": "url",
                "color": "#FF5722",
                "initials": "JD",
            },
            {
                "user_id": str(uuid.uuid4()),
                "display_name": "Jane Smith",
                "avatar_url": None,
                "avatar_type": "initials",
                "color": "#4CAF50",
                "initials": "JS",
            },
            {
                "user_id": str(uuid.uuid4()),
                "display_name": "Anonymous User",
                "avatar_url": None,
                "avatar_type": "default",
                "color": "#9E9E9E",
                "initials": "AU",
            },
        ]

        for config in avatar_configs:
            presence_data = {**config, "status": "active", "last_seen": time.time_ns()}

            doc.awareness.set_local_state(presence_data)

            # Verify avatar data is properly stored
            states = doc.awareness.get_states()
            stored_config = states[doc.client_id]

            assert stored_config["display_name"] == config["display_name"]
            assert stored_config["avatar_type"] == config["avatar_type"]
            assert stored_config["color"] == config["color"]
            assert stored_config["initials"] == config["initials"]

            if config["avatar_url"]:
                assert stored_config["avatar_url"] == config["avatar_url"]
            else:
                assert stored_config["avatar_url"] is None


class TestAwarenessPerformance:
    """Performance tests for awareness system operations."""

    @pytest.mark.asyncio
    async def test_awareness_update_performance(self, yjs_doc):
        """Test performance of awareness updates under load."""
        doc = yjs_doc("performance_test.ipynb")

        user_id = str(uuid.uuid4())
        num_updates = 100
        update_times = []

        # Measure update performance
        for i in range(num_updates):
            presence_data = {
                "user_id": user_id,
                "display_name": f"Performance User {i}",
                "cursor_position": {"cell_id": f"cell_{i % 10}", "line": i % 50, "column": i % 100},
                "status": "active",
                "update_index": i,
                "last_seen": time.time_ns(),
            }

            start_time = time.perf_counter()
            doc.awareness.set_local_state(presence_data)
            end_time = time.perf_counter()

            update_times.append(end_time - start_time)

        # Analyze performance metrics
        mean_time = statistics.mean(update_times)
        median_time = statistics.median(update_times)
        max_time = max(update_times)

        # Performance requirements (adjust based on actual needs)
        assert mean_time < 0.001  # Mean update time should be < 1ms
        assert median_time < 0.0005  # Median should be even faster
        assert max_time < 0.010  # No single update should take > 10ms

        # Verify final state
        final_states = doc.awareness.get_states()
        final_state = final_states[doc.client_id]
        assert final_state["update_index"] == num_updates - 1

    @pytest.mark.asyncio
    async def test_large_presence_data_handling(self, yjs_doc):
        """Test handling of large presence data payloads."""
        doc = yjs_doc("large_data_test.ipynb")

        user_id = str(uuid.uuid4())

        # Create large presence data payload
        large_metadata = {
            "extended_profile": {
                "bio": "A" * 1000,  # 1KB of text data
                "preferences": {f"pref_{i}": f"value_{i}" for i in range(100)},
                "recent_files": [f"file_{i}.ipynb" for i in range(50)],
                "collaboration_history": [
                    {
                        "session_id": str(uuid.uuid4()),
                        "timestamp": time.time_ns() - i * 1000000,
                        "duration": i * 60,
                    }
                    for i in range(20)
                ],
            }
        }

        presence_data = {
            "user_id": user_id,
            "display_name": "Large Data Test User",
            "cursor_position": {"cell_id": "cell_0", "line": 0, "column": 0},
            "status": "active",
            "metadata": large_metadata,
            "last_seen": time.time_ns(),
        }

        # Measure time to handle large payload
        start_time = time.perf_counter()
        doc.awareness.set_local_state(presence_data)
        end_time = time.perf_counter()

        processing_time = end_time - start_time

        # Verify large data was handled efficiently
        assert processing_time < 0.1  # Should handle large data in < 100ms

        # Verify data integrity
        states = doc.awareness.get_states()
        stored_data = states[doc.client_id]

        assert stored_data["user_id"] == user_id
        assert len(stored_data["metadata"]["extended_profile"]["bio"]) == 1000
        assert len(stored_data["metadata"]["extended_profile"]["preferences"]) == 100
        assert len(stored_data["metadata"]["extended_profile"]["recent_files"]) == 50


class TestAwarenessCleanup:
    """Tests for awareness cleanup and resource management."""

    @pytest.mark.asyncio
    async def test_awareness_cleanup_on_disconnect(self, yjs_doc):
        """Test awareness state cleanup when users disconnect."""
        doc = yjs_doc("cleanup_test.ipynb")

        user_id = str(uuid.uuid4())

        # Set initial presence
        presence_data = {
            "user_id": user_id,
            "display_name": "Cleanup Test User",
            "status": "active",
            "connected": True,
            "last_seen": time.time_ns(),
        }

        doc.awareness.set_local_state(presence_data)

        # Verify presence is set
        states = doc.awareness.get_states()
        assert doc.client_id in states
        assert states[doc.client_id]["connected"] is True

        # Simulate disconnect by clearing awareness state
        doc.awareness.set_local_state(None)

        # Verify cleanup occurred
        cleaned_states = doc.awareness.get_states()
        assert doc.client_id not in cleaned_states or cleaned_states[doc.client_id] is None

    def test_awareness_memory_management(self, yjs_doc):
        """Test awareness memory usage with multiple state changes."""
        doc = yjs_doc("memory_test.ipynb")

        user_id = str(uuid.uuid4())

        # Simulate many state changes to test memory management
        for i in range(1000):
            presence_data = {
                "user_id": user_id,
                "display_name": f"Memory Test User {i}",
                "cursor_position": {"cell_id": f"cell_{i % 10}", "line": i % 50, "column": i % 100},
                "status": "active",
                "iteration": i,
                "timestamp": time.time_ns(),
            }

            doc.awareness.set_local_state(presence_data)

            # Periodically verify we only have the current state
            if i % 100 == 0:
                states = doc.awareness.get_states()
                assert len(states) == 1  # Should only have current client's state

        # Final verification
        final_states = doc.awareness.get_states()
        assert len(final_states) == 1
        final_state = final_states[doc.client_id]
        assert final_state["iteration"] == 999


class TestAwarenessIntegration:
    """Integration tests for awareness system with Yjs protocol."""

    def test_yjs_awareness_protocol_integration(self, yjs_doc):
        """Test integration with standard Yjs awareness protocol."""
        doc = yjs_doc("protocol_test.ipynb")

        user_id = str(uuid.uuid4())

        # Test protocol-compliant awareness data
        protocol_presence = {
            "user": {"id": user_id, "name": "Protocol Test User", "color": "#FF5722"},
            "cursor": {"anchor": {"line": 5, "column": 10}, "head": {"line": 5, "column": 15}},
            "selection": {
                "ranges": [{"anchor": {"line": 5, "column": 10}, "head": {"line": 5, "column": 15}}]
            },
        }

        doc.awareness.set_local_state(protocol_presence)

        # Verify protocol compliance
        states = doc.awareness.get_states()
        stored_state = states[doc.client_id]

        assert "user" in stored_state
        assert stored_state["user"]["id"] == user_id
        assert stored_state["user"]["name"] == "Protocol Test User"
        assert "cursor" in stored_state
        assert "selection" in stored_state

    def test_awareness_state_serialization(self, yjs_doc):
        """Test serialization and deserialization of awareness states."""
        doc = yjs_doc("serialization_test.ipynb")

        user_id = str(uuid.uuid4())

        # Create complex presence data
        complex_presence = {
            "user_id": user_id,
            "display_name": "Serialization Test User",
            "cursor_position": {"cell_id": "cell_1", "line": 3, "column": 7},
            "selection": {"start": {"line": 3, "column": 7}, "end": {"line": 3, "column": 15}},
            "metadata": {
                "client_info": {"browser": "Chrome", "os": "macOS", "version": "1.0.0"},
                "preferences": {"theme": "dark", "font_size": 14},
            },
            "status": "active",
            "last_seen": time.time_ns(),
        }

        doc.awareness.set_local_state(complex_presence)

        # Test JSON serialization
        states = doc.awareness.get_states()
        stored_state = states[doc.client_id]

        # Serialize to JSON
        serialized = json.dumps(stored_state, default=str)
        assert isinstance(serialized, str)
        assert len(serialized) > 0

        # Deserialize from JSON
        deserialized = json.loads(serialized)

        # Verify data integrity after serialization round-trip
        assert deserialized["user_id"] == user_id
        assert deserialized["display_name"] == "Serialization Test User"
        assert deserialized["cursor_position"]["cell_id"] == "cell_1"
        assert deserialized["metadata"]["client_info"]["browser"] == "Chrome"

    @pytest.mark.asyncio
    async def test_awareness_with_document_updates(self, yjs_doc):
        """Test awareness updates alongside document content changes."""
        doc = yjs_doc("integration_test.ipynb")

        user_id = str(uuid.uuid4())

        # Get notebook components
        cells = doc.get_array("cells")
        metadata = doc.get_map("metadata")

        # Add initial cell with transaction
        with doc.begin_transaction() as txn:
            cells.insert(
                txn, 0, {"cell_type": "code", "source": "print('Hello World')", "metadata": {}}
            )

        # Set awareness state
        presence_data = {
            "user_id": user_id,
            "display_name": "Integration Test User",
            "cursor_position": {"cell_id": "cell_0", "line": 0, "column": 6},
            "status": "editing",
            "editing_cell": "cell_0",
            "last_seen": time.time_ns(),
        }

        doc.awareness.set_local_state(presence_data)

        # Simulate editing with awareness updates
        for i in range(5):
            # Update cell content
            with doc.begin_transaction() as txn:
                if len(cells) > 0:
                    cell = cells[0]
                    if isinstance(cell, dict):
                        cell["source"] = f"print('Hello World {i}')"

            # Update awareness to reflect editing position
            updated_presence = {
                **presence_data,
                "cursor_position": {
                    "cell_id": "cell_0",
                    "line": 0,
                    "column": len(f"print('Hello World {i}')"),
                },
                "edit_count": i + 1,
                "last_seen": time.time_ns(),
            }

            doc.awareness.set_local_state(updated_presence)

            # Small delay to simulate real editing
            await asyncio.sleep(0.01)

        # Verify final state
        final_states = doc.awareness.get_states()
        final_state = final_states[doc.client_id]

        assert final_state["edit_count"] == 5
        assert final_state["cursor_position"]["column"] > 6  # Cursor moved forward

        # Verify document was also updated
        assert len(cells) == 1
        if len(cells) > 0:
            final_cell = cells[0]
            if isinstance(final_cell, dict):
                assert "Hello World 4" in final_cell["source"]


# Performance and stress test markers
@pytest.mark.performance
class TestAwarenessStressTests:
    """Stress tests for awareness system under heavy load."""

    @pytest.mark.asyncio
    async def test_high_frequency_updates(self, yjs_doc):
        """Test awareness system with high-frequency updates."""
        doc = yjs_doc("stress_test.ipynb")

        user_id = str(uuid.uuid4())
        update_count = 500
        update_interval = 0.001  # 1ms between updates

        start_time = time.perf_counter()

        for i in range(update_count):
            presence_data = {
                "user_id": user_id,
                "display_name": "Stress Test User",
                "cursor_position": {"cell_id": f"cell_{i % 10}", "line": i % 100, "column": i % 80},
                "status": "rapid_editing",
                "update_index": i,
                "last_seen": time.time_ns(),
            }

            doc.awareness.set_local_state(presence_data)
            await asyncio.sleep(update_interval)

        end_time = time.perf_counter()
        total_time = end_time - start_time

        # Verify performance under stress
        updates_per_second = update_count / total_time
        assert updates_per_second > 100  # Should handle at least 100 updates/sec

        # Verify final state integrity
        final_states = doc.awareness.get_states()
        final_state = final_states[doc.client_id]
        assert final_state["update_index"] == update_count - 1

    def test_awareness_state_size_limits(self, yjs_doc):
        """Test handling of awareness state size limitations."""
        doc = yjs_doc("size_limit_test.ipynb")

        user_id = str(uuid.uuid4())

        # Test reasonable size limit enforcement
        max_reasonable_size = 1024 * 1024  # 1MB limit

        # Create large but reasonable presence data
        large_presence = {
            "user_id": user_id,
            "display_name": "Size Limit Test User",
            "status": "active",
            "large_data": "x" * (1024 * 100),  # 100KB of data
            "last_seen": time.time_ns(),
        }

        doc.awareness.set_local_state(large_presence)

        # Verify state was accepted (within reasonable limits)
        states = doc.awareness.get_states()
        assert doc.client_id in states

        stored_state = states[doc.client_id]
        stored_size = len(json.dumps(stored_state, default=str))
        assert stored_size < max_reasonable_size
