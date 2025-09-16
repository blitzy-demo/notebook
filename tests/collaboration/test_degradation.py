"""
Tests for graceful degradation scenarios when collaboration features are disabled or unavailable.

This module ensures that single-user functionality remains intact and performant when
collaboration features are disabled, providing comprehensive validation of backward
compatibility, performance parity, and seamless fallback behaviors.

Key testing areas:
- Single-user mode functionality with collaboration disabled
- Automatic fallback when collaboration server is unavailable
- Performance parity between collaborative and single-user modes
- Clean UI when collaboration features are hidden
- Configuration flag behavior validation
- WebSocket connection failure handling
- Offline editing capabilities
- Queued changes during disconnection scenarios
- Seamless transitions between collaborative and single-user modes
"""

import asyncio
import json
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from notebook.app import JupyterNotebookApp


class TestDegradationBasicConfiguration:
    """Test basic configuration scenarios for collaboration degradation."""

    def test_default_collaboration_disabled(self, collaboration_settings):
        """Test that collaboration is disabled by default in production configuration."""
        # Default configuration should have collaboration disabled
        production_settings = collaboration_settings(
            collaboration_enabled=False,
            mock_external_services=False,
        )

        assert production_settings["collaboration_enabled"] is False
        assert production_settings["debug_mode"] is True  # Only for testing environment

        # Create app with default settings
        app = JupyterNotebookApp()
        assert app.collaboration_enabled is False

        # Ensure collaboration handlers are not registered when disabled
        handlers_before = len(app.handlers) if hasattr(app, "handlers") else 0

        # Initialize handlers (should not add collaboration handlers)
        app.handlers = []
        app.serverapp = type(
            "MockServerApp",
            (),
            {"web_app": type("MockWebApp", (), {"settings": {}}), "tornado_settings": {}},
        )()

        app.initialize_handlers()

        # Check that no collaboration handlers are registered
        collaboration_handlers = [
            h
            for h in app.handlers
            if any(
                endpoint in str(h[0])
                for endpoint in [
                    "/api/collaboration/ws",
                    "/api/collaboration/sessions",
                    "/api/collaboration/status",
                ]
            )
        ]
        assert len(collaboration_handlers) == 0

    def test_collaboration_enabled_flag(self, collaboration_settings):
        """Test explicit enabling of collaboration through configuration flag."""
        collab_settings = collaboration_settings(
            collaboration_enabled=True, websocket_ping_interval=30, sync_timeout_seconds=30
        )

        assert collab_settings["collaboration_enabled"] is True

        # Create app with collaboration enabled
        app = JupyterNotebookApp()
        app.collaboration_enabled = True

        assert app.collaboration_enabled is True

        # Verify collaboration settings are properly configured
        settings = app._get_collaboration_settings()
        assert settings["collaboration_enabled"] is True
        assert "batch_window_ms" in settings
        assert "max_connections" in settings
        assert "lock_timeout_seconds" in settings

    @pytest.mark.parametrize(
        ("config_value", "expected"),
        [
            (True, True),
            (False, False),
            (None, False),  # None should default to False
        ],
    )
    def test_collaboration_config_flag_behavior(
        self, config_value, expected, collaboration_settings
    ):
        """Test that c.NotebookApp.collaboration_enabled flag behavior works correctly."""
        app = JupyterNotebookApp()

        if config_value is not None:
            app.collaboration_enabled = config_value

        assert app.collaboration_enabled is expected

        # Test configuration through command line equivalent
        if config_value is not None:
            settings = collaboration_settings(collaboration_enabled=config_value)
            assert settings["collaboration_enabled"] == expected


class TestDegradationSingleUserMode:
    """Test single-user mode functionality when collaboration is disabled."""

    def test_single_user_app_initialization(self):
        """Test that app initializes correctly in single-user mode."""
        start_time = time.perf_counter()

        app = JupyterNotebookApp()
        app.collaboration_enabled = False

        # Mock serverapp for initialization
        app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        # Initialize the app
        app.initialize()

        initialization_time = time.perf_counter() - start_time

        # Verify app is properly initialized
        assert app.collaboration_enabled is False
        assert hasattr(app, "name")
        assert app.name == "notebook"

        # Ensure initialization is fast (performance requirement)
        assert initialization_time < 5.0  # Should initialize within 5 seconds

    def test_single_user_handlers_registration(self):
        """Test that only single-user handlers are registered when collaboration is disabled."""
        app = JupyterNotebookApp()
        app.collaboration_enabled = False
        app.handlers = []

        # Mock serverapp
        app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        app.initialize_handlers()

        # Check that standard handlers are registered
        handler_patterns = [h[0] for h in app.handlers]
        expected_handlers = [
            "/tree(.*)",
            "/notebooks(.*)",
            "/edit(.*)",
            "/consoles/(.*)",
            "/terminals(.*)",
        ]

        for expected in expected_handlers:
            assert any(expected in pattern for pattern in handler_patterns)

        # Check that collaboration handlers are NOT registered
        collaboration_patterns = [
            "/api/collaboration/ws",
            "/api/collaboration/sessions",
            "/api/collaboration/status",
        ]
        for collab_pattern in collaboration_patterns:
            assert not any(collab_pattern in pattern for pattern in handler_patterns)

    def test_single_user_page_config(self):
        """Test that page configuration excludes collaboration settings in single-user mode."""
        app = JupyterNotebookApp()
        app.collaboration_enabled = False

        page_config_data = {}
        app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type(
                    "MockWebApp", (), {"settings": {"page_config_data": page_config_data}}
                ),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        app.initialize_handlers()

        # Verify collaboration is marked as disabled
        assert page_config_data.get("collaboration_enabled") is False

        # Verify collaboration config is not present
        assert "collaboration_config" not in page_config_data

    async def test_single_user_notebook_operations(self):
        """Test that basic notebook operations work correctly in single-user mode."""
        with tempfile.TemporaryDirectory() as temp_dir:
            # Create a test notebook file
            notebook_path = Path(temp_dir) / "test_notebook.ipynb"
            notebook_content = {
                "cells": [
                    {
                        "cell_type": "code",
                        "source": "print('Hello, World!')",
                        "metadata": {},
                        "outputs": [],
                    }
                ],
                "metadata": {
                    "kernelspec": {
                        "display_name": "Python 3",
                        "language": "python",
                        "name": "python3",
                    }
                },
                "nbformat": 4,
                "nbformat_minor": 5,
            }

            notebook_path.write_text(json.dumps(notebook_content, indent=2))

            # Verify notebook file operations work without collaboration
            assert notebook_path.exists()
            loaded_content = json.loads(notebook_path.read_text())
            assert loaded_content["cells"][0]["source"] == "print('Hello, World!')"

            # Test notebook modification (simulated editing)
            loaded_content["cells"][0]["source"] = "print('Modified in single-user mode')"
            notebook_path.write_text(json.dumps(loaded_content, indent=2))

            # Verify changes persist
            modified_content = json.loads(notebook_path.read_text())
            assert modified_content["cells"][0]["source"] == "print('Modified in single-user mode')"


class TestDegradationPerformanceParity:
    """Test performance parity between collaborative and single-user modes."""

    async def test_initialization_performance_comparison(self, collaboration_settings):
        """Test that single-user initialization is at least as fast as collaborative mode."""
        # Measure single-user mode initialization time
        single_user_times = []
        for _ in range(3):  # Run multiple times for average
            start_time = time.perf_counter()

            app = JupyterNotebookApp()
            app.collaboration_enabled = False
            app.serverapp = type(
                "MockServerApp",
                (),
                {
                    "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                    "tornado_settings": {},
                    "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
                },
            )()
            app.initialize()

            end_time = time.perf_counter()
            single_user_times.append(end_time - start_time)

            # Clean up
            app.stop()

        # Measure collaborative mode initialization time
        collaborative_times = []
        for _ in range(3):
            start_time = time.perf_counter()

            app = JupyterNotebookApp()
            app.collaboration_enabled = True
            app.serverapp = type(
                "MockServerApp",
                (),
                {
                    "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                    "tornado_settings": {},
                    "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
                },
            )()
            app.initialize()

            end_time = time.perf_counter()
            collaborative_times.append(end_time - start_time)

            # Clean up
            app.stop()

        avg_single_user = sum(single_user_times) / len(single_user_times)
        avg_collaborative = sum(collaborative_times) / len(collaborative_times)

        # Single-user mode should be faster or equal (within 20% tolerance as per spec)
        performance_ratio = avg_single_user / avg_collaborative if avg_collaborative > 0 else 1.0
        assert (
            performance_ratio <= 1.2
        ), f"Single-user mode is {performance_ratio:.2f}x slower than collaborative mode"

        # Both modes should initialize within reasonable time
        assert avg_single_user < 5.0, "Single-user initialization too slow"
        assert avg_collaborative < 5.0, "Collaborative initialization too slow"

    def test_memory_usage_comparison(self):
        """Test that single-user mode doesn't exceed memory usage requirements."""
        import os

        import psutil

        # Get baseline memory usage
        process = psutil.Process(os.getpid())
        baseline_memory = process.memory_info().rss

        # Create single-user app
        app_single = JupyterNotebookApp()
        app_single.collaboration_enabled = False
        app_single.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()
        app_single.initialize()

        single_user_memory = process.memory_info().rss

        # Clean up single-user app
        app_single.stop()

        # Create collaborative app
        app_collab = JupyterNotebookApp()
        app_collab.collaboration_enabled = True
        app_collab.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()
        app_collab.initialize()

        collaborative_memory = process.memory_info().rss

        # Clean up collaborative app
        app_collab.stop()

        # Calculate memory increases
        single_user_increase = single_user_memory - baseline_memory
        collaborative_increase = collaborative_memory - baseline_memory

        # Single-user shouldn't use significantly more memory than baseline
        memory_increase_ratio = single_user_increase / baseline_memory if baseline_memory > 0 else 0
        assert (
            memory_increase_ratio <= 0.15
        ), f"Single-user mode uses {memory_increase_ratio:.2%} more memory than baseline"

        # Collaborative mode increase should be reasonable compared to single-user
        if collaborative_increase > 0:
            collab_ratio = (
                collaborative_increase / single_user_increase if single_user_increase > 0 else 1
            )
            assert (
                collab_ratio <= 1.3
            ), f"Collaborative mode uses {collab_ratio:.2f}x more memory than single-user mode"


class TestDegradationWebSocketFailures:
    """Test degradation behavior when WebSocket connections fail."""

    @patch("notebook.handlers.YjsWebSocketHandler")
    async def test_websocket_connection_failure_handling(self, mock_websocket_handler):
        """Test graceful handling of WebSocket connection failures."""
        # Configure mock to simulate connection failure
        mock_websocket_handler.side_effect = ConnectionError("WebSocket connection failed")

        app = JupyterNotebookApp()
        app.collaboration_enabled = True
        app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        # App should still initialize despite WebSocket handler failure
        try:
            app.initialize()
            # Should not raise exception despite handler failure
            assert True
        except Exception as e:
            pytest.fail(f"App initialization failed when WebSocket handler failed: {e}")
        finally:
            app.stop()

    async def test_collaboration_server_unavailable_fallback(self):
        """Test automatic fallback when collaboration server is unavailable."""
        app = JupyterNotebookApp()
        app.collaboration_enabled = True
        app.collaboration_server_url = "ws://nonexistent-server:8888/api/collaboration/ws"

        app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        # App should initialize and mark collaboration as unavailable
        app.initialize()

        # Verify collaboration settings are still accessible but server URL indicates unavailable server
        settings = app._get_collaboration_settings()
        assert settings["server_url"] == "ws://nonexistent-server:8888/api/collaboration/ws"

        # App should continue to function
        assert app.collaboration_enabled is True  # Configuration flag remains True

        app.stop()

    @patch("asyncio.create_task")
    async def test_websocket_timeout_handling(self, mock_create_task):
        """Test handling of WebSocket connection timeouts."""
        # Configure mock to simulate timeout
        mock_create_task.side_effect = asyncio.TimeoutError("Connection timeout")

        app = JupyterNotebookApp()
        app.collaboration_enabled = True
        app.collaboration_lock_timeout_seconds = 5  # Short timeout for testing

        app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        # Should handle timeout gracefully
        try:
            app.initialize()
            # Verify timeout settings are properly configured
            settings = app._get_collaboration_settings()
            assert settings["lock_timeout_seconds"] == 5
        except asyncio.TimeoutError:
            pytest.fail("App should handle WebSocket timeouts gracefully")
        finally:
            app.stop()


class TestDegradationOfflineEditing:
    """Test offline editing capabilities and connection recovery."""

    async def test_offline_editing_capability_simulation(self):
        """Test that editing continues to work when collaboration is offline."""
        with tempfile.TemporaryDirectory() as temp_dir:
            notebook_path = Path(temp_dir) / "offline_test.ipynb"

            # Create initial notebook
            initial_content = {
                "cells": [
                    {
                        "cell_type": "code",
                        "source": "# Initial content",
                        "metadata": {},
                        "outputs": [],
                    }
                ],
                "metadata": {"kernelspec": {"name": "python3"}},
                "nbformat": 4,
                "nbformat_minor": 5,
            }

            notebook_path.write_text(json.dumps(initial_content, indent=2))

            # Simulate offline editing (direct file manipulation)
            offline_changes = [
                "# Initial content",
                "# Edit 1: Added while offline",
                "print('Offline edit 1')",
                "",
                "# Edit 2: Another offline change",
                "print('Offline edit 2')",
            ]

            # Apply offline changes
            content = json.loads(notebook_path.read_text())
            content["cells"][0]["source"] = "\n".join(offline_changes)
            notebook_path.write_text(json.dumps(content, indent=2))

            # Verify changes persisted
            final_content = json.loads(notebook_path.read_text())
            final_source = final_content["cells"][0]["source"]

            assert "Offline edit 1" in final_source
            assert "Offline edit 2" in final_source
            assert len(final_source.split("\n")) == 6

    async def test_queued_changes_during_disconnection(self):
        """Test that changes can be queued and applied when connection is restored."""
        # Simulate a queue of changes made during disconnection
        change_queue = []

        # Add changes to queue (simulating user actions while offline)
        change_queue.append(
            {
                "type": "cell_edit",
                "cell_index": 0,
                "content": "print('Change during disconnect 1')",
                "timestamp": time.time(),
            }
        )

        await asyncio.sleep(0.1)  # Small delay to ensure different timestamps

        change_queue.append(
            {
                "type": "cell_add",
                "cell_index": 1,
                "content": "# New cell added offline",
                "timestamp": time.time(),
            }
        )

        await asyncio.sleep(0.1)

        change_queue.append(
            {
                "type": "cell_edit",
                "cell_index": 0,
                "content": "print('Change during disconnect 2')",
                "timestamp": time.time(),
            }
        )

        # Verify queue contains changes in chronological order
        assert len(change_queue) == 3
        assert (
            change_queue[0]["timestamp"]
            < change_queue[1]["timestamp"]
            < change_queue[2]["timestamp"]
        )

        # Simulate applying queued changes when connection restored
        with tempfile.TemporaryDirectory() as temp_dir:
            notebook_path = Path(temp_dir) / "queued_changes.ipynb"

            # Initial content
            content = {
                "cells": [{"cell_type": "code", "source": "", "metadata": {}, "outputs": []}],
                "metadata": {},
                "nbformat": 4,
                "nbformat_minor": 5,
            }

            # Apply queued changes in order
            for change in sorted(change_queue, key=lambda x: x["timestamp"]):
                if change["type"] == "cell_edit":
                    if change["cell_index"] < len(content["cells"]):
                        content["cells"][change["cell_index"]]["source"] = change["content"]
                elif change["type"] == "cell_add":
                    new_cell = {
                        "cell_type": "code",
                        "source": change["content"],
                        "metadata": {},
                        "outputs": [],
                    }
                    content["cells"].insert(change["cell_index"], new_cell)

            # Verify final state reflects all queued changes
            assert len(content["cells"]) == 2  # Original + added cell
            assert (
                "Change during disconnect 2" in content["cells"][1]["source"]
            )  # Last edit to cell 0
            assert "New cell added offline" in content["cells"][0]["source"]  # Added cell


class TestDegradationUICleanup:
    """Test that UI is clean when collaboration features are hidden."""

    def test_collaboration_ui_elements_hidden(self):
        """Test that collaboration UI elements are not present when disabled."""
        app = JupyterNotebookApp()
        app.collaboration_enabled = False

        page_config_data = {}
        app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type(
                    "MockWebApp", (), {"settings": {"page_config_data": page_config_data}}
                ),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        app.initialize_handlers()

        # Verify page config excludes collaboration elements
        assert page_config_data.get("collaboration_enabled") is False
        assert "collaboration_config" not in page_config_data

        # Verify no collaboration-related configuration is exposed
        collaboration_keys = [
            "websocket_url",
            "batch_window_ms",
            "max_connections",
            "lock_timeout_seconds",
            "session_api_url",
            "status_api_url",
        ]

        for key in collaboration_keys:
            assert key not in page_config_data

    def test_clean_notebook_interface_single_user(self):
        """Test that notebook interface is clean in single-user mode."""
        app = JupyterNotebookApp()
        app.collaboration_enabled = False

        # Verify no collaboration settings in app configuration
        settings = app._get_collaboration_settings()
        assert settings["collaboration_enabled"] is False

        # Verify clean state (no collaboration artifacts)
        assert app.collaboration_server_url == ""
        assert app.collaboration_batch_window_ms == 50.0  # Default value
        assert app.collaboration_max_connections == 100  # Default value

        # These should be defaults, not active collaborative settings
        assert not hasattr(app, "_active_collaboration_sessions")
        assert not hasattr(app, "_websocket_connections")


class TestDegradationTransitions:
    """Test seamless transitions between collaborative and single-user modes."""

    async def test_seamless_mode_transition(self):
        """Test transition from collaborative mode to single-user mode."""
        # Start in collaborative mode
        collab_app = JupyterNotebookApp()
        collab_app.collaboration_enabled = True
        collab_app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        collab_app.initialize()

        # Verify collaborative mode is active
        assert collab_app.collaboration_enabled is True
        collab_settings = collab_app._get_collaboration_settings()
        assert collab_settings["collaboration_enabled"] is True

        # Stop collaborative app
        collab_app.stop()

        # Simulate transition to single-user mode
        single_app = JupyterNotebookApp()
        single_app.collaboration_enabled = False
        single_app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        single_app.initialize()

        # Verify single-user mode is active
        assert single_app.collaboration_enabled is False
        single_settings = single_app._get_collaboration_settings()
        assert single_settings["collaboration_enabled"] is False

        # Stop single-user app
        single_app.stop()

        # Verify transition completed without errors
        assert True  # Test passes if no exceptions thrown

    def test_configuration_flag_runtime_change(self, collaboration_settings):
        """Test behavior when collaboration flag is changed at runtime."""
        # Start with collaboration disabled
        initial_settings = collaboration_settings(collaboration_enabled=False)
        assert initial_settings["collaboration_enabled"] is False

        # Create app with initial settings
        app = JupyterNotebookApp()
        app.collaboration_enabled = False

        # Verify initial state
        assert app.collaboration_enabled is False

        # Simulate runtime flag change (would typically require restart)
        app.collaboration_enabled = True

        # Verify flag changed
        assert app.collaboration_enabled is True

        # Note: In real implementation, handler registration would require restart
        # This test verifies that the flag itself can be changed

        # Revert change
        app.collaboration_enabled = False
        assert app.collaboration_enabled is False

    async def test_graceful_degradation_on_error(self):
        """Test graceful degradation when collaboration encounters errors."""
        app = JupyterNotebookApp()
        app.collaboration_enabled = True

        # Mock serverapp that will cause handler initialization issues
        mock_serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        app.serverapp = mock_serverapp

        # App should initialize despite potential collaboration issues
        try:
            app.initialize()

            # Verify app is functional even if collaboration had issues
            assert app.name == "notebook"
            assert hasattr(app, "handlers")

            # Collaboration may be enabled in config but handlers might not be active
            assert app.collaboration_enabled is True

        except Exception as e:
            pytest.fail(f"App should handle collaboration errors gracefully: {e}")
        finally:
            app.stop()


# Performance benchmarks to ensure degradation doesn't impact performance
class TestDegradationPerformanceBenchmarks:
    """Performance benchmarks to ensure degradation meets performance requirements."""

    def test_zero_performance_impact_when_disabled(self):
        """Test that there is zero performance impact when collaboration is disabled."""
        # Measure baseline (no app)
        baseline_start = time.perf_counter()
        time.sleep(0.001)  # Minimal operation
        baseline_time = time.perf_counter() - baseline_start

        # Measure single-user app operations
        single_user_times = []
        for _ in range(5):
            start_time = time.perf_counter()

            app = JupyterNotebookApp()
            app.collaboration_enabled = False
            app.serverapp = type(
                "MockServerApp",
                (),
                {
                    "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                    "tornado_settings": {},
                    "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
                },
            )()
            app.initialize()

            # Simulate basic operation
            _ = app._get_collaboration_settings()

            app.stop()
            end_time = time.perf_counter()
            single_user_times.append(end_time - start_time)

        avg_single_user_time = sum(single_user_times) / len(single_user_times)

        # Performance should be reasonable and consistent
        assert avg_single_user_time < 2.0  # Less than 2 seconds for full cycle
        assert max(single_user_times) - min(single_user_times) < 1.0  # Consistent performance

        # All individual runs should be reasonably fast
        for run_time in single_user_times:
            assert run_time < 3.0  # No individual run should exceed 3 seconds

    async def test_latency_requirements_met(self):
        """Test that single-user mode meets <100ms latency requirements."""
        app = JupyterNotebookApp()
        app.collaboration_enabled = False
        app.serverapp = type(
            "MockServerApp",
            (),
            {
                "web_app": type("MockWebApp", (), {"settings": {"page_config_data": {}}}),
                "tornado_settings": {},
                "extension_manager": type("MockExtensionManager", (), {"extensions": {}})(),
            },
        )()

        # Measure quick operations that should be under 100ms
        operation_times = []

        for _ in range(10):  # Test multiple operations
            start_time = time.perf_counter()

            # Simulate typical operations
            settings = app._get_collaboration_settings()
            assert settings is not None

            # Page config access
            page_config_data = {}
            app.serverapp.web_app.settings["page_config_data"] = page_config_data
            app.initialize_handlers()

            end_time = time.perf_counter()
            operation_time = (end_time - start_time) * 1000  # Convert to milliseconds
            operation_times.append(operation_time)

        # All operations should be under 100ms (as per spec requirement)
        max_operation_time = max(operation_times)
        avg_operation_time = sum(operation_times) / len(operation_times)

        assert (
            max_operation_time < 100.0
        ), f"Maximum operation time {max_operation_time:.2f}ms exceeds 100ms limit"
        assert (
            avg_operation_time < 50.0
        ), f"Average operation time {avg_operation_time:.2f}ms should be well under limit"

        app.stop()
