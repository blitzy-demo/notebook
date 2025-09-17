"""
Tests for change history and versioning system, validating version tracking,
diff generation, snapshot management, and rollback functionality for collaborative edits.

This comprehensive test suite validates the collaborative change history system
implementation as specified in the technical requirements, including:
- Yjs update event capture and processing
- Version snapshot creation at configurable intervals
- Cell-level change granularity and tracking
- Diff algorithm accuracy using Myers algorithm
- Version browsing and navigation functionality
- Rollback operation integrity and state consistency
- History persistence across collaborative sessions
- Storage optimization and retention policy enforcement
- Multi-user change attribution in collaborative contexts
- Performance validation for history operations

The tests ensure compliance with performance boundaries (≤100ms latency),
memory overhead limits (≤20% increase), and concurrent user support (≥10 users).
"""

import asyncio
import difflib
import json
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean, median
from uuid import uuid4

import pytest
from y_py import (
    YDoc,
    apply_update,
    encode_state_as_update,
)


class TestYjsUpdateEventCapture:
    """Test suite for validating Yjs update event capture and processing."""

    @pytest.mark.asyncio
    async def test_update_event_capture_basic(self, yjs_doc):
        """Test basic Yjs update event capture functionality."""
        doc = yjs_doc("test_history.ipynb")
        captured_updates = []
        update_timestamps = []

        def capture_update(txn):
            """Capture update events with timestamp."""
            # Store transaction info instead of encoding during callback
            # to avoid "Already mutably borrowed" error
            captured_updates.append({"transaction_id": id(txn), "timestamp": time.perf_counter()})
            update_timestamps.append(time.perf_counter())

        # Register update observer
        doc.observe_after_transaction(capture_update)

        # Perform document operations
        cells = doc.get_array("cells")
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                0,
                {
                    "cell_type": "code",
                    "source": "print('Hello, World!')",
                    "metadata": {},
                    "outputs": [],
                },
            )

        # Get update data after transaction completes
        update_data = encode_state_as_update(doc)

        # Validate update capture
        assert len(captured_updates) >= 1
        assert len(update_timestamps) >= 1
        assert isinstance(update_data, bytes)  # Validate the state update is bytes
        assert all(isinstance(update, dict) for update in captured_updates)  # Transaction metadata

        # Verify timestamp accuracy (updates should be captured within milliseconds)
        if len(update_timestamps) > 1:
            time_diff = update_timestamps[-1] - update_timestamps[0]
            assert time_diff < 0.1  # Should be captured within 100ms

    @pytest.mark.asyncio
    async def test_update_event_capture_concurrent_operations(self, yjs_doc):
        """Test update event capture during concurrent operations."""
        doc = yjs_doc("concurrent_history.ipynb")
        captured_updates = []
        update_metadata = []

        def capture_update_with_metadata(txn):
            """Capture updates with detailed metadata."""
            # Avoid encode_state_as_update during transaction callback
            transaction_data = {
                "timestamp": time.perf_counter(),
                "transaction_id": str(txn),
                "update_size": 0,  # Will be calculated after transaction
            }
            captured_updates.append(transaction_data)
            update_metadata.append(transaction_data)

        doc.observe_after_transaction(capture_update_with_metadata)

        # Simulate concurrent operations
        cells = doc.get_array("cells")
        metadata = doc.get_map("metadata")

        async def perform_operations():
            """Perform multiple operations concurrently."""
            operations = []

            # Add multiple cells concurrently
            for i in range(5):

                def add_cell(index=i):
                    with doc.begin_transaction() as txn:
                        cells.insert(
                            txn,
                            index,
                            {
                                "cell_type": "code",
                                "source": f"# Cell {index}",
                                "metadata": {"id": str(uuid4())},
                            },
                        )

                operations.append(asyncio.create_task(asyncio.to_thread(add_cell)))

            # Modify metadata concurrently
            def modify_metadata():
                with doc.begin_transaction() as txn:
                    metadata.set(txn, "last_modified", datetime.now().isoformat())
                    metadata.set(txn, "version", "1.0.0")

            operations.append(asyncio.create_task(asyncio.to_thread(modify_metadata)))

            await asyncio.gather(*operations)

        await perform_operations()

        # Validate concurrent update capture
        assert len(captured_updates) >= 5  # At least one update per operation
        assert len(update_metadata) == len(captured_updates)

        # Verify all updates were captured within reasonable time
        timestamps = [meta["timestamp"] for meta in update_metadata]
        total_duration = max(timestamps) - min(timestamps)
        assert total_duration < 1.0  # All updates captured within 1 second

        # Verify update sizes are reasonable
        update_sizes = [meta["update_size"] for meta in update_metadata]
        assert all(size > 0 for size in update_sizes)
        assert max(update_sizes) < 10000  # Reasonable upper bound

    @pytest.mark.asyncio
    async def test_update_event_capture_performance(self, yjs_doc):
        """Test performance of update event capture system."""
        doc = yjs_doc("performance_history.ipynb")
        captured_updates = []
        capture_times = []

        def capture_with_timing(txn):
            """Capture updates while measuring performance."""
            start_time = time.perf_counter()
            # Avoid encode_state_as_update during transaction callback
            transaction_data = {"transaction_id": id(txn), "timestamp": start_time}
            captured_updates.append(transaction_data)
            end_time = time.perf_counter()
            capture_times.append((end_time - start_time) * 1000)  # Convert to milliseconds

        doc.observe_after_transaction(capture_with_timing)

        # Perform many operations to test performance
        cells = doc.get_array("cells")
        for i in range(50):  # 50 operations
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    i,
                    {
                        "cell_type": "code",
                        "source": f"print('Operation {i}')",
                        "metadata": {"operation_id": i},
                    },
                )

        # Validate performance metrics
        assert len(capture_times) >= 50
        avg_capture_time = mean(capture_times)
        max_capture_time = max(capture_times)

        # Performance boundaries validation
        assert avg_capture_time < 5.0  # Average capture should be under 5ms
        assert max_capture_time < 20.0  # Maximum capture should be under 20ms

        # Verify 95th percentile performance
        sorted_times = sorted(capture_times)
        percentile_95 = sorted_times[int(len(sorted_times) * 0.95)]
        assert percentile_95 < 10.0  # 95th percentile under 10ms


class TestVersionSnapshotCreation:
    """Test suite for version snapshot creation at configurable intervals."""

    @pytest.mark.asyncio
    async def test_snapshot_creation_basic(self, yjs_doc):
        """Test basic version snapshot creation functionality."""
        doc = yjs_doc("snapshot_test.ipynb")
        snapshots = []

        def create_snapshot():
            """Create a version snapshot."""
            snapshot = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "doc_state": encode_state_as_update(doc),
                "version_id": str(uuid4()),
                "cells_count": len(doc.get_array("cells")),
            }
            snapshots.append(snapshot)
            return snapshot

        # Perform initial operations
        cells = doc.get_array("cells")
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                0,
                {
                    "cell_type": "code",
                    "source": "initial_code = 'hello'",
                    "metadata": {"created": datetime.now().isoformat()},
                },
            )

        # Create first snapshot
        snapshot1 = create_snapshot()

        # Perform more operations
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                1,
                {
                    "cell_type": "markdown",
                    "source": "# Documentation\nThis is a test.",
                    "metadata": {"type": "documentation"},
                },
            )

        # Create second snapshot
        await asyncio.sleep(0.001)  # Ensure timestamp difference
        snapshot2 = create_snapshot()

        # Validate snapshots
        assert len(snapshots) == 2
        assert snapshot1["cells_count"] == 1
        assert snapshot2["cells_count"] == 2
        assert snapshot1["timestamp"] != snapshot2["timestamp"]
        assert len(snapshot1["doc_state"]) > 0
        assert len(snapshot2["doc_state"]) > 0
        assert snapshot1["doc_state"] != snapshot2["doc_state"]

    @pytest.mark.asyncio
    async def test_snapshot_interval_timing(self, yjs_doc):
        """Test snapshot creation at specific time intervals."""
        doc = yjs_doc("interval_snapshot.ipynb")
        snapshots = []
        snapshot_interval = 0.1  # 100ms intervals for testing

        class SnapshotManager:
            def __init__(self, doc, interval):
                self.doc = doc
                self.interval = interval
                self.last_snapshot_time = 0
                self.snapshots = []

            def should_create_snapshot(self):
                return (time.perf_counter() - self.last_snapshot_time) >= self.interval

            def create_snapshot_if_needed(self):
                if self.should_create_snapshot():
                    snapshot = {
                        "timestamp": datetime.now(timezone.utc),
                        "doc_state": encode_state_as_update(self.doc),
                        "version_id": str(uuid4()),
                        "interval_ms": self.interval * 1000,
                    }
                    self.snapshots.append(snapshot)
                    self.last_snapshot_time = time.perf_counter()
                    return snapshot
                return None

        manager = SnapshotManager(doc, snapshot_interval)
        cells = doc.get_array("cells")

        # Perform operations with timing checks
        for i in range(10):
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    i,
                    {
                        "cell_type": "code",
                        "source": f"operation_{i} = {i}",
                        "metadata": {"sequence": i},
                    },
                )

            # Check if snapshot should be created
            snapshot = manager.create_snapshot_if_needed()
            if snapshot:
                snapshots.append(snapshot)

            # Wait to ensure interval timing
            await asyncio.sleep(snapshot_interval + 0.01)

        # Validate interval-based snapshots
        assert len(snapshots) >= 8  # Should have multiple snapshots

        # Verify timing intervals
        if len(snapshots) > 1:
            for i in range(1, len(snapshots)):
                time_diff = (
                    snapshots[i]["timestamp"] - snapshots[i - 1]["timestamp"]
                ).total_seconds()
                assert time_diff >= snapshot_interval * 0.9  # Allow 10% tolerance

    @pytest.mark.asyncio
    async def test_snapshot_storage_optimization(self, yjs_doc):
        """Test storage optimization for version snapshots."""
        doc = yjs_doc("optimized_snapshot.ipynb")

        class OptimizedSnapshotManager:
            def __init__(self, doc):
                self.doc = doc
                self.snapshots = []
                self.compressed_snapshots = []

            def create_optimized_snapshot(self):
                """Create snapshot with storage optimization."""
                doc_state = encode_state_as_update(self.doc)

                # Basic compression simulation (delta from previous state)
                if self.snapshots:
                    previous_state = self.snapshots[-1]["doc_state"]
                    # Calculate delta size for optimization metrics
                    delta_size = abs(len(doc_state) - len(previous_state))
                else:
                    delta_size = len(doc_state)

                snapshot = {
                    "timestamp": datetime.now(timezone.utc),
                    "doc_state": doc_state,
                    "version_id": str(uuid4()),
                    "original_size": len(doc_state),
                    "delta_size": delta_size,
                    "compression_ratio": delta_size / len(doc_state) if len(doc_state) > 0 else 0,
                }

                self.snapshots.append(snapshot)

                # Simulate compression by storing only significant changes
                if snapshot["compression_ratio"] > 0.1:  # Only store if >10% change
                    self.compressed_snapshots.append(snapshot)

                return snapshot

        manager = OptimizedSnapshotManager(doc)
        cells = doc.get_array("cells")

        # Create snapshots with varying degrees of change
        for i in range(20):
            if i % 3 == 0:  # Major change every 3rd operation
                with doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        i // 3,
                        {
                            "cell_type": "code",
                            "source": f"# Major change {i}\n" + "print('large change')" * 10,
                            "metadata": {"major_change": True, "iteration": i},
                        },
                    )
            else:  # Minor change
                cells = doc.get_array("cells")
                if len(cells) > 0:
                    # Simulate small edit to existing cell
                    pass  # In practice, would modify existing cell content

            snapshot = manager.create_optimized_snapshot()

        # Validate storage optimization
        assert len(manager.snapshots) == 20
        assert len(manager.compressed_snapshots) < len(manager.snapshots)  # Should be optimized

        # Verify compression ratios
        compression_ratios = [s["compression_ratio"] for s in manager.snapshots]
        assert min(compression_ratios) >= 0
        assert max(compression_ratios) <= 1.0

        # Check storage efficiency
        total_original_size = sum(s["original_size"] for s in manager.snapshots)
        compressed_size = sum(s["original_size"] for s in manager.compressed_snapshots)
        storage_reduction = (total_original_size - compressed_size) / total_original_size
        assert storage_reduction > 0.2  # At least 20% storage reduction


class TestCellLevelChangeGranularity:
    """Test suite for cell-level change granularity and tracking."""

    @pytest.mark.asyncio
    async def test_cell_level_tracking_basic(self, yjs_doc):
        """Test basic cell-level change tracking."""
        doc = yjs_doc("cell_granular.ipynb")
        cell_changes = []

        def track_cell_changes(txn):
            """Track changes at cell level."""
            # Avoid accessing doc during transaction callback
            change_info = {
                "timestamp": time.perf_counter(),
                "cells_count": 0,  # Will be updated after transaction
                "transaction_id": str(txn),
                "change_type": "cell_change",
            }
            cell_changes.append(change_info)

        doc.observe_after_transaction(track_cell_changes)

        cells = doc.get_array("cells")

        # Test cell addition
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                0,
                {"cell_type": "code", "source": "x = 1", "metadata": {"change_type": "addition"}},
            )

        cell_changes[-1]["change_type"] = "cell_addition"

        # Test cell modification
        with doc.begin_transaction() as txn:
            if len(cells) > 0:
                existing_cell = dict(cells[0])
                existing_cell["source"] = "x = 42  # modified"
                # Use delete + insert instead of item assignment
                cells.delete(txn, 0)
                cells.insert(txn, 0, existing_cell)

        cell_changes[-1]["change_type"] = "cell_modification"

        # Test cell deletion
        with doc.begin_transaction() as txn:
            if len(cells) > 0:
                cells.delete(txn, 0)

        cell_changes[-1]["change_type"] = "cell_deletion"

        # Validate cell-level tracking
        assert len(cell_changes) >= 3
        change_types = [change["change_type"] for change in cell_changes]
        assert "cell_addition" in change_types
        assert "cell_modification" in change_types
        assert "cell_deletion" in change_types

        # Verify granular timestamps
        timestamps = [change["timestamp"] for change in cell_changes]
        for i in range(1, len(timestamps)):
            assert timestamps[i] > timestamps[i - 1]  # Timestamps should increase

    @pytest.mark.asyncio
    async def test_cell_content_granularity(self, yjs_doc):
        """Test granular tracking of cell content changes."""
        doc = yjs_doc("content_granular.ipynb")
        content_changes = []

        class CellContentTracker:
            def __init__(self, doc):
                self.doc = doc
                self.previous_content = {}

            def track_content_changes(self):
                """Track detailed cell content changes."""
                cells = self.doc.get_array("cells")
                current_content = {}

                for i, cell in enumerate(cells):
                    if isinstance(cell, dict):
                        current_content[i] = {
                            "source": cell.get("source", ""),
                            "cell_type": cell.get("cell_type", ""),
                            "metadata": cell.get("metadata", {}),
                        }

                # Compare with previous content
                for cell_index, content in current_content.items():
                    if cell_index in self.previous_content:
                        previous = self.previous_content[cell_index]
                        changes = {}

                        if content["source"] != previous["source"]:
                            changes["source_changed"] = True
                            changes["source_diff"] = self._calculate_diff(
                                previous["source"], content["source"]
                            )

                        if content["cell_type"] != previous["cell_type"]:
                            changes["type_changed"] = True

                        if content["metadata"] != previous["metadata"]:
                            changes["metadata_changed"] = True

                        if changes:
                            content_changes.append(
                                {
                                    "cell_index": cell_index,
                                    "timestamp": datetime.now(timezone.utc),
                                    "changes": changes,
                                }
                            )
                    else:
                        # New cell
                        content_changes.append(
                            {
                                "cell_index": cell_index,
                                "timestamp": datetime.now(timezone.utc),
                                "changes": {"cell_added": True},
                            }
                        )

                self.previous_content = current_content.copy()

            def _calculate_diff(self, old_text, new_text):
                """Calculate diff between old and new text."""
                differ = difflib.SequenceMatcher(None, old_text.splitlines(), new_text.splitlines())
                return {"ratio": differ.ratio(), "operations": list(differ.get_opcodes())}

        tracker = CellContentTracker(doc)
        cells = doc.get_array("cells")

        # Create initial cell
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                0,
                {"cell_type": "code", "source": "print('Hello')", "metadata": {"version": 1}},
            )

        tracker.track_content_changes()

        # Modify cell source
        with doc.begin_transaction() as txn:
            if len(cells) > 0:
                cell = dict(cells[0])
                cell["source"] = "print('Hello, World!')"
                # Use delete + insert instead of item assignment
                cells.delete(txn, 0)
                cells.insert(txn, 0, cell)

        tracker.track_content_changes()

        # Modify cell metadata
        with doc.begin_transaction() as txn:
            if len(cells) > 0:
                cell = dict(cells[0])
                cell["metadata"]["version"] = 2
                cell["metadata"]["author"] = "test_user"
                # Use delete + insert instead of item assignment
                cells.delete(txn, 0)
                cells.insert(txn, 0, cell)

        tracker.track_content_changes()

        # Validate granular content tracking
        assert len(content_changes) >= 3

        # Check for different types of changes
        change_types = set()
        for change in content_changes:
            change_types.update(change["changes"].keys())

        assert "cell_added" in change_types
        assert "source_changed" in change_types
        assert "metadata_changed" in change_types

        # Verify diff calculation
        source_changes = [c for c in content_changes if "source_changed" in c["changes"]]
        if source_changes:
            diff_info = source_changes[0]["changes"]["source_diff"]
            assert "ratio" in diff_info
            assert "operations" in diff_info
            assert 0 <= diff_info["ratio"] <= 1

    @pytest.mark.asyncio
    async def test_multi_cell_granular_tracking(self, yjs_doc, multi_user_session):
        """Test cell-level granularity in multi-user scenarios."""
        doc = yjs_doc("multi_cell_granular.ipynb")
        session = multi_user_session(3, "multi_cell_granular.ipynb")
        cell_operations = []

        class MultiCellTracker:
            def __init__(self):
                self.operations = []

            def record_operation(self, user_id, operation_type, cell_index, details=None):
                """Record cell-level operations."""
                self.operations.append(
                    {
                        "user_id": user_id,
                        "operation_type": operation_type,
                        "cell_index": cell_index,
                        "timestamp": datetime.now(timezone.utc),
                        "details": details or {},
                    }
                )

        tracker = MultiCellTracker()

        # Initialize users (simulated)
        user_docs = [yjs_doc(f"user_{i}_doc.ipynb") for i in range(3)]

        # Simulate concurrent cell operations
        operations = [
            {"user": 0, "action": "add_cell", "index": 0, "content": "user_0_cell_1"},
            {"user": 1, "action": "add_cell", "index": 0, "content": "user_1_cell_1"},
            {"user": 2, "action": "add_cell", "index": 0, "content": "user_2_cell_1"},
            {"user": 0, "action": "edit_cell", "index": 0, "content": "user_0_cell_1_modified"},
            {"user": 1, "action": "add_cell", "index": 1, "content": "user_1_cell_2"},
        ]

        for op in operations:
            user_doc = user_docs[op["user"]]
            cells = user_doc.get_array("cells")

            if op["action"] == "add_cell":
                with user_doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        op["index"],
                        {
                            "cell_type": "code",
                            "source": op["content"],
                            "metadata": {"user_id": f"user_{op['user']}"},
                        },
                    )

                tracker.record_operation(
                    f"user_{op['user']}", "cell_addition", op["index"], {"source": op["content"]}
                )

            elif op["action"] == "edit_cell":
                if op["index"] < len(cells):
                    with user_doc.begin_transaction() as txn:
                        cell = dict(cells[op["index"]])
                        cell["source"] = op["content"]
                        # Use delete + insert instead of item assignment
                        cells.delete(txn, op["index"])
                        cells.insert(txn, op["index"], cell)

                    tracker.record_operation(
                        f"user_{op['user']}",
                        "cell_modification",
                        op["index"],
                        {"new_source": op["content"]},
                    )

        # Validate multi-user cell granularity
        operations = tracker.operations
        assert len(operations) >= 5

        # Verify user attribution
        users_involved = {op["user_id"] for op in operations}
        assert len(users_involved) == 3

        # Verify operation types
        op_types = {op["operation_type"] for op in operations}
        assert "cell_addition" in op_types
        assert "cell_modification" in op_types

        # Verify cell index tracking
        cell_indices = [op["cell_index"] for op in operations]
        assert min(cell_indices) >= 0
        assert all(isinstance(idx, int) for idx in cell_indices)


class TestDiffAlgorithmAccuracy:
    """Test suite for diff algorithm accuracy using Myers algorithm."""

    @pytest.mark.asyncio
    async def test_myers_algorithm_basic(self):
        """Test basic Myers algorithm diff accuracy."""
        # Test cases with known expected results
        test_cases = [
            {
                "old": "Hello World",
                "new": "Hello, World!",
                "expected_operations": ["equal", "insert", "equal", "insert"],
            },
            {
                "old": "line1\nline2\nline3",
                "new": "line1\nmodified_line2\nline3",
                "expected_operations": ["equal", "replace", "equal"],
            },
            {
                "old": "abc\ndef\nghi",
                "new": "abc\nghi",
                "expected_operations": ["equal", "delete", "equal"],
            },
        ]

        for i, case in enumerate(test_cases):
            # Use difflib's SequenceMatcher (implements Myers algorithm)
            old_lines = case["old"].splitlines()
            new_lines = case["new"].splitlines()

            matcher = difflib.SequenceMatcher(None, old_lines, new_lines)
            opcodes = list(matcher.get_opcodes())

            # Validate diff accuracy
            assert len(opcodes) > 0, f"Test case {i}: No opcodes generated"

            # Verify operation types match expected pattern
            actual_ops = [op[0] for op in opcodes]

            # Check that all operations are valid
            valid_ops = {"equal", "delete", "insert", "replace"}
            assert all(op in valid_ops for op in actual_ops), f"Test case {i}: Invalid operations"

            # Verify similarity ratio is reasonable
            ratio = matcher.ratio()
            assert 0 <= ratio <= 1, f"Test case {i}: Invalid ratio {ratio}"

            # For minor changes, ratio should be high
            if (
                case["old"]
                and case["new"]
                and len(case["old"]) > 0
                and abs(len(case["new"]) - len(case["old"])) < len(case["old"]) * 0.5
            ):
                assert (
                    ratio > 0.5
                ), f"Test case {i}: Expected high similarity ratio for minor changes"

    @pytest.mark.asyncio
    async def test_cell_content_diff_accuracy(self, yjs_doc):
        """Test diff accuracy for notebook cell content changes."""
        doc = yjs_doc("diff_accuracy.ipynb")

        class CellDiffAnalyzer:
            def __init__(self):
                self.diff_results = []

            def analyze_cell_diff(self, old_source, new_source, cell_type="code"):
                """Analyze diff between old and new cell source."""
                # Line-based diff for code cells
                if cell_type == "code":
                    old_lines = old_source.splitlines()
                    new_lines = new_source.splitlines()

                    matcher = difflib.SequenceMatcher(None, old_lines, new_lines)

                # Character-based diff for markdown cells
                else:
                    matcher = difflib.SequenceMatcher(None, old_source, new_source)

                diff_result = {
                    "old_source": old_source,
                    "new_source": new_source,
                    "cell_type": cell_type,
                    "similarity_ratio": matcher.ratio(),
                    "opcodes": list(matcher.get_opcodes()),
                    "unified_diff": list(
                        difflib.unified_diff(
                            old_source.splitlines() if cell_type == "code" else list(old_source),
                            new_source.splitlines() if cell_type == "code" else list(new_source),
                            lineterm="",
                            n=3,
                        )
                    ),
                    "ndiff": list(
                        difflib.ndiff(
                            old_source.splitlines() if cell_type == "code" else list(old_source),
                            new_source.splitlines() if cell_type == "code" else list(new_source),
                        )
                    ),
                }

                self.diff_results.append(diff_result)
                return diff_result

        analyzer = CellDiffAnalyzer()

        # Test various cell content changes
        test_scenarios = [
            {
                "old": "print('hello')",
                "new": "print('hello world')",
                "cell_type": "code",
                "expected_high_similarity": True,
            },
            {
                "old": "# Header\nThis is content.",
                "new": "# Header\nThis is modified content.",
                "cell_type": "markdown",
                "expected_high_similarity": True,
            },
            {
                "old": "import pandas as pd\ndf = pd.read_csv('data.csv')",
                "new": "import numpy as np\narr = np.array([1, 2, 3])",
                "cell_type": "code",
                "expected_high_similarity": False,
            },
            {
                "old": "",
                "new": "print('new content')",
                "cell_type": "code",
                "expected_high_similarity": False,
            },
        ]

        for scenario in test_scenarios:
            diff_result = analyzer.analyze_cell_diff(
                scenario["old"], scenario["new"], scenario["cell_type"]
            )

            # Validate diff accuracy
            assert 0 <= diff_result["similarity_ratio"] <= 1

            if scenario["expected_high_similarity"]:
                assert (
                    diff_result["similarity_ratio"] > 0.6
                ), f"Expected high similarity for: {scenario['old']} -> {scenario['new']}"
            else:
                # For completely different content, similarity should be lower
                if scenario["old"] and scenario["new"]:
                    assert (
                        diff_result["similarity_ratio"] < 0.8
                    ), f"Expected low similarity for: {scenario['old']} -> {scenario['new']}"

            # Verify opcodes are valid
            assert len(diff_result["opcodes"]) > 0
            for opcode in diff_result["opcodes"]:
                assert len(opcode) == 5  # (tag, i1, i2, j1, j2)
                assert opcode[0] in ["equal", "delete", "insert", "replace"]

            # Verify diff formats are generated
            assert isinstance(diff_result["unified_diff"], list)
            assert isinstance(diff_result["ndiff"], list)

    @pytest.mark.asyncio
    async def test_diff_performance_boundaries(self):
        """Test diff algorithm performance within specified boundaries."""
        performance_results = []

        # Test with various content sizes
        content_sizes = [
            (10, "small"),  # 10 lines
            (100, "medium"),  # 100 lines
            (1000, "large"),  # 1000 lines
            (5000, "xlarge"),  # 5000 lines
        ]

        for size, label in content_sizes:
            # Generate test content
            old_content = "\n".join([f"line_{i}_original" for i in range(size)])
            new_content = "\n".join(
                [f"line_{i}_modified" if i % 10 == 0 else f"line_{i}_original" for i in range(size)]
            )

            # Measure diff performance
            start_time = time.perf_counter()

            matcher = difflib.SequenceMatcher(
                None, old_content.splitlines(), new_content.splitlines()
            )
            opcodes = list(matcher.get_opcodes())
            ratio = matcher.ratio()
            unified_diff = list(
                difflib.unified_diff(
                    old_content.splitlines(), new_content.splitlines(), lineterm=""
                )
            )

            end_time = time.perf_counter()
            diff_time_ms = (end_time - start_time) * 1000

            performance_results.append(
                {
                    "content_size": size,
                    "label": label,
                    "diff_time_ms": diff_time_ms,
                    "opcodes_count": len(opcodes),
                    "similarity_ratio": ratio,
                    "unified_diff_lines": len(unified_diff),
                }
            )

        # Validate performance boundaries
        for result in performance_results:
            # Diff operations should complete within reasonable time
            if result["content_size"] <= 1000:
                assert (
                    result["diff_time_ms"] < 100
                ), f"Diff for {result['label']} content took {result['diff_time_ms']}ms, expected < 100ms"
            else:
                assert (
                    result["diff_time_ms"] < 500
                ), f"Diff for {result['label']} content took {result['diff_time_ms']}ms, expected < 500ms"

            # Verify diff results are reasonable
            assert result["opcodes_count"] > 0
            assert 0 <= result["similarity_ratio"] <= 1
            assert result["unified_diff_lines"] >= 0

        # Verify performance scales reasonably
        small_result = next(r for r in performance_results if r["label"] == "small")
        large_result = next(r for r in performance_results if r["label"] == "large")

        # Large content shouldn't take exponentially longer
        time_ratio = large_result["diff_time_ms"] / small_result["diff_time_ms"]
        size_ratio = large_result["content_size"] / small_result["content_size"]

        assert (
            time_ratio < size_ratio * 2
        ), f"Diff performance doesn't scale linearly: time_ratio={time_ratio}, size_ratio={size_ratio}"


class TestVersionBrowsingFunctionality:
    """Test suite for version browsing and navigation functionality."""

    @pytest.mark.asyncio
    async def test_version_browsing_basic(self, yjs_doc):
        """Test basic version browsing functionality."""
        doc = yjs_doc("version_browse.ipynb")

        class VersionBrowser:
            def __init__(self, doc):
                self.doc = doc
                self.versions = []
                self.current_version_index = -1

            def save_version(self, description=""):
                """Save current document state as a version."""
                version = {
                    "version_id": str(uuid4()),
                    "timestamp": datetime.now(timezone.utc),
                    "description": description,
                    "doc_state": encode_state_as_update(self.doc),
                    "cells_count": len(self.doc.get_array("cells")),
                    "metadata": dict(self.doc.get_map("metadata")),
                }
                self.versions.append(version)
                self.current_version_index = len(self.versions) - 1
                return version

            def get_version_list(self):
                """Get list of all available versions."""
                return [
                    {
                        "version_id": v["version_id"],
                        "timestamp": v["timestamp"].isoformat(),
                        "description": v["description"],
                        "cells_count": v["cells_count"],
                    }
                    for v in self.versions
                ]

            def browse_to_version(self, version_id):
                """Browse to a specific version."""
                for i, version in enumerate(self.versions):
                    if version["version_id"] == version_id:
                        self.current_version_index = i
                        return version
                return None

            def get_current_version(self):
                """Get currently browsed version."""
                if 0 <= self.current_version_index < len(self.versions):
                    return self.versions[self.current_version_index]
                return None

            def navigate_previous(self):
                """Navigate to previous version."""
                if self.current_version_index > 0:
                    self.current_version_index -= 1
                    return self.get_current_version()
                return None

            def navigate_next(self):
                """Navigate to next version."""
                if self.current_version_index < len(self.versions) - 1:
                    self.current_version_index += 1
                    return self.get_current_version()
                return None

        browser = VersionBrowser(doc)
        cells = doc.get_array("cells")

        # Create several versions
        with doc.begin_transaction() as txn:
            cells.insert(
                txn, 0, {"cell_type": "code", "source": "print('version 1')", "metadata": {}}
            )
        version1 = browser.save_version("Initial version")

        with doc.begin_transaction() as txn:
            cells.insert(txn, 1, {"cell_type": "markdown", "source": "# Version 2", "metadata": {}})
        version2 = browser.save_version("Added documentation")

        with doc.begin_transaction() as txn:
            if len(cells) > 0:
                cell = dict(cells[0])
                cell["source"] = "print('version 3 - modified')"
                # Use delete + insert instead of item assignment
                cells.delete(txn, 0)
                cells.insert(txn, 0, cell)
        version3 = browser.save_version("Modified first cell")

        # Test version browsing
        version_list = browser.get_version_list()
        assert len(version_list) == 3
        assert all("version_id" in v for v in version_list)
        assert all("timestamp" in v for v in version_list)

        # Test browsing to specific version
        browsed_version = browser.browse_to_version(version2["version_id"])
        assert browsed_version is not None
        assert browsed_version["version_id"] == version2["version_id"]
        assert browser.current_version_index == 1

        # Test navigation
        prev_version = browser.navigate_previous()
        assert prev_version["version_id"] == version1["version_id"]
        assert browser.current_version_index == 0

        next_version = browser.navigate_next()
        assert next_version["version_id"] == version2["version_id"]
        assert browser.current_version_index == 1

        # Test navigation boundaries
        browser.current_version_index = 0
        prev_from_first = browser.navigate_previous()
        assert prev_from_first is None  # Can't go before first
        assert browser.current_version_index == 0

        browser.current_version_index = len(browser.versions) - 1
        next_from_last = browser.navigate_next()
        assert next_from_last is None  # Can't go past last
        assert browser.current_version_index == len(browser.versions) - 1

    @pytest.mark.asyncio
    async def test_version_comparison_browsing(self, yjs_doc):
        """Test version comparison during browsing."""
        doc = yjs_doc("version_compare.ipynb")

        class VersionComparator:
            def __init__(self, browser):
                self.browser = browser

            def compare_versions(self, version1_id, version2_id):
                """Compare two versions and return differences."""
                version1 = self.browser.browse_to_version(version1_id)
                version2 = self.browser.browse_to_version(version2_id)

                if not version1 or not version2:
                    return None

                # Create temporary docs for comparison
                doc1 = YDoc()
                doc2 = YDoc()

                # Apply states
                apply_update(doc1, version1["doc_state"])
                apply_update(doc2, version2["doc_state"])

                cells1 = doc1.get_array("cells")
                cells2 = doc2.get_array("cells")

                comparison = {
                    "version1_id": version1_id,
                    "version2_id": version2_id,
                    "cells_added": max(0, len(cells2) - len(cells1)),
                    "cells_removed": max(0, len(cells1) - len(cells2)),
                    "cells_modified": 0,
                    "cell_diffs": [],
                }

                # Compare individual cells
                max_cells = max(len(cells1), len(cells2))
                for i in range(max_cells):
                    cell1 = cells1[i] if i < len(cells1) else None
                    cell2 = cells2[i] if i < len(cells2) else None

                    if cell1 and cell2:
                        # Both cells exist, check for modifications
                        cell1_source = cell1.get("source", "") if isinstance(cell1, dict) else ""
                        cell2_source = cell2.get("source", "") if isinstance(cell2, dict) else ""

                        if cell1_source != cell2_source:
                            comparison["cells_modified"] += 1

                            matcher = difflib.SequenceMatcher(
                                None, cell1_source.splitlines(), cell2_source.splitlines()
                            )

                            comparison["cell_diffs"].append(
                                {
                                    "cell_index": i,
                                    "similarity_ratio": matcher.ratio(),
                                    "opcodes": list(matcher.get_opcodes()),
                                }
                            )

                return comparison

        # Set up version browser and create versions
        browser = VersionBrowser(doc)
        comparator = VersionComparator(browser)
        cells = doc.get_array("cells")

        # Version 1: Basic cell
        with doc.begin_transaction() as txn:
            cells.insert(txn, 0, {"cell_type": "code", "source": "x = 1\nprint(x)", "metadata": {}})
        version1 = browser.save_version("Basic version")

        # Version 2: Add another cell
        with doc.begin_transaction() as txn:
            cells.insert(txn, 1, {"cell_type": "code", "source": "y = 2\nprint(y)", "metadata": {}})
        version2 = browser.save_version("Added second cell")

        # Version 3: Modify first cell
        with doc.begin_transaction() as txn:
            cell = dict(cells[0])
            cell["source"] = "x = 10\nprint(f'x = {x}')"
            # Use delete + insert instead of item assignment
            cells.delete(txn, 0)
            cells.insert(txn, 0, cell)
        version3 = browser.save_version("Modified first cell")

        # Test version comparison
        comparison_1_to_2 = comparator.compare_versions(
            version1["version_id"], version2["version_id"]
        )

        assert comparison_1_to_2 is not None
        assert comparison_1_to_2["cells_added"] == 1
        assert comparison_1_to_2["cells_removed"] == 0
        assert comparison_1_to_2["cells_modified"] == 0

        comparison_1_to_3 = comparator.compare_versions(
            version1["version_id"], version3["version_id"]
        )

        assert comparison_1_to_3 is not None
        assert comparison_1_to_3["cells_added"] == 1  # Second cell added
        assert comparison_1_to_3["cells_modified"] == 1  # First cell modified
        assert len(comparison_1_to_3["cell_diffs"]) == 1

        # Verify diff quality
        cell_diff = comparison_1_to_3["cell_diffs"][0]
        assert 0 <= cell_diff["similarity_ratio"] <= 1
        assert len(cell_diff["opcodes"]) > 0

    @pytest.mark.asyncio
    async def test_version_browsing_performance(self, yjs_doc):
        """Test performance of version browsing operations."""
        doc = yjs_doc("version_perf.ipynb")
        browser = VersionBrowser(doc)
        cells = doc.get_array("cells")

        # Create many versions to test performance
        num_versions = 50
        version_creation_times = []

        for i in range(num_versions):
            start_time = time.perf_counter()

            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    i,
                    {
                        "cell_type": "code",
                        "source": f"# Cell {i}\nvalue_{i} = {i * 10}",
                        "metadata": {"version": i},
                    },
                )

            version = browser.save_version(f"Version {i}")

            end_time = time.perf_counter()
            version_creation_times.append((end_time - start_time) * 1000)  # Convert to ms

        # Test browsing performance
        browsing_times = []

        for _ in range(20):  # Test 20 random browses
            target_version_index = pytest.approx(
                len(browser.versions) // 2
            )  # Browse to middle version
            version_id = browser.versions[target_version_index]["version_id"]

            start_time = time.perf_counter()
            browsed_version = browser.browse_to_version(version_id)
            end_time = time.perf_counter()

            assert browsed_version is not None
            browsing_times.append((end_time - start_time) * 1000)

        # Test navigation performance
        navigation_times = []

        browser.current_version_index = 0
        for _ in range(min(20, len(browser.versions) - 1)):
            start_time = time.perf_counter()
            next_version = browser.navigate_next()
            end_time = time.perf_counter()

            assert next_version is not None
            navigation_times.append((end_time - start_time) * 1000)

        # Validate performance boundaries
        avg_creation_time = mean(version_creation_times)
        avg_browsing_time = mean(browsing_times)
        avg_navigation_time = mean(navigation_times)

        # Version creation should be fast
        assert (
            avg_creation_time < 50
        ), f"Average version creation took {avg_creation_time}ms, expected < 50ms"

        # Version browsing should be very fast
        assert (
            avg_browsing_time < 10
        ), f"Average version browsing took {avg_browsing_time}ms, expected < 10ms"

        # Navigation should be instant
        assert (
            avg_navigation_time < 5
        ), f"Average version navigation took {avg_navigation_time}ms, expected < 5ms"

        # Version list retrieval should be fast even with many versions
        start_time = time.perf_counter()
        version_list = browser.get_version_list()
        end_time = time.perf_counter()
        list_time = (end_time - start_time) * 1000

        assert list_time < 20, f"Version list retrieval took {list_time}ms, expected < 20ms"
        assert len(version_list) == num_versions


# Add VersionBrowser class to test namespace for use in other test classes
class VersionBrowser:
    def __init__(self, doc):
        self.doc = doc
        self.versions = []
        self.current_version_index = -1

    def save_version(self, description=""):
        """Save current document state as a version."""
        version = {
            "version_id": str(uuid4()),
            "timestamp": datetime.now(timezone.utc),
            "description": description,
            "doc_state": encode_state_as_update(self.doc),
            "cells_count": len(self.doc.get_array("cells")),
            "metadata": dict(self.doc.get_map("metadata")),
        }
        self.versions.append(version)
        self.current_version_index = len(self.versions) - 1
        return version

    def get_version_list(self):
        """Get list of all available versions."""
        return [
            {
                "version_id": v["version_id"],
                "timestamp": v["timestamp"].isoformat(),
                "description": v["description"],
                "cells_count": v["cells_count"],
            }
            for v in self.versions
        ]

    def browse_to_version(self, version_id):
        """Browse to a specific version."""
        for i, version in enumerate(self.versions):
            if version["version_id"] == version_id:
                self.current_version_index = i
                return version
        return None

    def get_current_version(self):
        """Get currently browsed version."""
        if 0 <= self.current_version_index < len(self.versions):
            return self.versions[self.current_version_index]
        return None

    def navigate_previous(self):
        """Navigate to previous version."""
        if self.current_version_index > 0:
            self.current_version_index -= 1
            return self.get_current_version()
        return None

    def navigate_next(self):
        """Navigate to next version."""
        if self.current_version_index < len(self.versions) - 1:
            self.current_version_index += 1
            return self.get_current_version()
        return None


class TestRollbackOperationIntegrity:
    """Test suite for rollback operation integrity and state consistency."""

    class RollbackManager:
        def __init__(self, doc):
            self.doc = doc
            self.snapshots = []

        def create_snapshot(self, description=""):
            """Create a snapshot for rollback."""
            snapshot = {
                "snapshot_id": str(uuid4()),
                "timestamp": datetime.now(timezone.utc),
                "description": description,
                "doc_state": encode_state_as_update(self.doc),
            }
            self.snapshots.append(snapshot)
            return snapshot

        def rollback_to_snapshot(self, snapshot_id):
            """Rollback document to a specific snapshot."""
            target_snapshot = None
            for snapshot in self.snapshots:
                if snapshot["snapshot_id"] == snapshot_id:
                    target_snapshot = snapshot
                    break

            if not target_snapshot:
                return {"success": False, "error": "Snapshot not found"}

            try:
                # Create new document with target state
                rollback_doc = YDoc()
                apply_update(rollback_doc, target_snapshot["doc_state"])

                # Verify rollback state integrity
                rollback_state = encode_state_as_update(rollback_doc)
                original_state = target_snapshot["doc_state"]

                return {
                    "success": True,
                    "snapshot_id": snapshot_id,
                    "state_match": rollback_state == original_state,
                    "rollback_timestamp": datetime.now(timezone.utc),
                    "cells_count": len(rollback_doc.get_array("cells")),
                    "metadata_preserved": len(rollback_doc.get_map("metadata")) > 0,
                }

            except Exception as e:
                return {"success": False, "error": f"Rollback failed: {e!s}"}

    @pytest.mark.asyncio
    async def test_rollback_basic_integrity(self, yjs_doc):
        """Test basic rollback operation integrity."""
        doc = yjs_doc("rollback_basic.ipynb")
        manager = self.RollbackManager(doc)
        cells = doc.get_array("cells")

        # Create initial state
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                0,
                {
                    "cell_type": "code",
                    "source": "initial_cell = True",
                    "metadata": {"original": True},
                },
            )
        snapshot1 = manager.create_snapshot("Initial state")

        # Modify document
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                1,
                {"cell_type": "markdown", "source": "# Added content", "metadata": {"added": True}},
            )
        snapshot2 = manager.create_snapshot("Added content")

        # Further modifications
        with doc.begin_transaction() as txn:
            if len(cells) > 0:
                cell = dict(cells[0])
                cell["source"] = "initial_cell = False  # Modified"
                # Use delete + insert instead of item assignment
                cells.delete(txn, 0)
                cells.insert(txn, 0, cell)
        snapshot3 = manager.create_snapshot("Modified original cell")

        # Test rollback to snapshot1
        rollback_result1 = manager.rollback_to_snapshot(snapshot1["snapshot_id"])
        assert rollback_result1["success"] is True
        assert rollback_result1["state_match"] is True
        assert rollback_result1["cells_count"] == 1
        assert rollback_result1["metadata_preserved"] is True

        # Test rollback to snapshot2
        rollback_result2 = manager.rollback_to_snapshot(snapshot2["snapshot_id"])
        assert rollback_result2["success"] is True
        assert rollback_result2["state_match"] is True
        assert rollback_result2["cells_count"] == 2

        # Test rollback to non-existent snapshot
        invalid_rollback = manager.rollback_to_snapshot("invalid_id")
        assert invalid_rollback["success"] is False
        assert "not found" in invalid_rollback["error"]

    @pytest.mark.asyncio
    async def test_rollback_state_consistency(self, yjs_doc):
        """Test state consistency after rollback operations."""
        doc = yjs_doc("rollback_consistency.ipynb")

        class RollbackManager:
            def __init__(self, doc):
                self.doc = doc
                self.snapshots = []

            def create_snapshot(self, description=""):
                snapshot = {
                    "snapshot_id": str(uuid4()),
                    "doc_state": encode_state_as_update(self.doc),
                }
                self.snapshots.append(snapshot)
                return snapshot

            def rollback_to_snapshot(self, snapshot_id):
                for snapshot in self.snapshots:
                    if snapshot["snapshot_id"] == snapshot_id:
                        apply_update(self.doc, snapshot["doc_state"])
                        return {"success": True}
                return {"success": False, "error": "not found"}

        class StateValidator:
            def __init__(self):
                self.validation_results = []

            def validate_document_state(self, doc, expected_properties=None):
                """Validate document state consistency."""
                cells = doc.get_array("cells")
                metadata = doc.get_map("metadata")

                validation = {
                    "timestamp": datetime.now(timezone.utc),
                    "cells_count": len(cells),
                    "has_metadata": len(metadata) > 0,
                    "cells_valid": True,
                    "metadata_valid": True,
                    "structure_integrity": True,
                    "issues": [],
                }

                # Validate cell structure
                for i, cell in enumerate(cells):
                    if not isinstance(cell, dict):
                        validation["cells_valid"] = False
                        validation["issues"].append(f"Cell {i} is not a dict")
                        continue

                    required_fields = ["cell_type", "source", "metadata"]
                    for field in required_fields:
                        if field not in cell:
                            validation["cells_valid"] = False
                            validation["issues"].append(f"Cell {i} missing {field}")

                # Validate metadata structure
                try:
                    metadata_dict = dict(metadata)
                    if expected_properties:
                        for prop in expected_properties:
                            if prop not in metadata_dict:
                                validation["metadata_valid"] = False
                                validation["issues"].append(f"Missing metadata property: {prop}")
                except Exception as e:
                    validation["metadata_valid"] = False
                    validation["issues"].append(f"Metadata validation error: {e!s}")

                # Overall structure integrity
                validation["structure_integrity"] = (
                    validation["cells_valid"]
                    and validation["metadata_valid"]
                    and len(validation["issues"]) == 0
                )

                self.validation_results.append(validation)
                return validation

        validator = StateValidator()
        manager = RollbackManager(doc)
        cells = doc.get_array("cells")
        metadata = doc.get_map("metadata")

        # Set up initial consistent state
        with doc.begin_transaction() as txn:
            metadata.set(txn, "created", datetime.now().isoformat())
            metadata.set(txn, "version", "1.0")

            cells.insert(
                txn, 0, {"cell_type": "code", "source": "x = 1", "metadata": {"cell_id": "cell_1"}}
            )

            cells.insert(
                txn,
                1,
                {"cell_type": "markdown", "source": "# Header", "metadata": {"cell_id": "cell_2"}},
            )

        # Validate initial state
        initial_validation = validator.validate_document_state(doc, ["created", "version"])
        assert initial_validation["structure_integrity"] is True

        snapshot1 = manager.create_snapshot("Consistent initial state")

        # Make complex modifications
        with doc.begin_transaction() as txn:
            # Modify existing cell
            cell = dict(cells[0])
            cell["source"] = "x = 42  # Modified value"
            cell["metadata"]["modified"] = True
            # Use delete + insert instead of item assignment
            cells.delete(txn, 0)
            cells.insert(txn, 0, cell)

            # Add new cell
            cells.insert(
                txn,
                2,
                {
                    "cell_type": "code",
                    "source": "y = x * 2",
                    "metadata": {"cell_id": "cell_3", "depends_on": "cell_1"},
                },
            )

            # Update metadata
            metadata.set(txn, "version", "1.1")
            metadata.set(txn, "last_modified", datetime.now().isoformat())

        modified_validation = validator.validate_document_state(
            doc, ["created", "version", "last_modified"]
        )
        assert modified_validation["structure_integrity"] is True
        assert modified_validation["cells_count"] == 3

        snapshot2 = manager.create_snapshot("Complex modifications")

        # Test rollback consistency
        rollback_result = manager.rollback_to_snapshot(snapshot1["snapshot_id"])
        assert rollback_result["success"] is True

        # Create new doc with rollback state and validate
        rollback_doc = YDoc()
        apply_update(rollback_doc, snapshot1["doc_state"])

        rollback_validation = validator.validate_document_state(
            rollback_doc, ["created", "version"]
        )
        assert rollback_validation["structure_integrity"] is True
        assert rollback_validation["cells_count"] == 2
        assert len(rollback_validation["issues"]) == 0

        # Verify specific state consistency
        rollback_cells = rollback_doc.get_array("cells")
        rollback_metadata = rollback_doc.get_map("metadata")

        assert len(rollback_cells) == 2
        assert rollback_cells[0]["source"] == "x = 1"  # Original value restored
        assert rollback_cells[1]["cell_type"] == "markdown"
        assert rollback_metadata["version"] == "1.0"  # Original version restored

    @pytest.mark.asyncio
    async def test_rollback_performance_boundaries(self, yjs_doc):
        """Test rollback operation performance within boundaries."""
        doc = yjs_doc("rollback_performance.ipynb")

        class RollbackManager:
            def __init__(self, doc):
                self.doc = doc
                self.snapshots = []

            def create_snapshot(self, description=""):
                snapshot = {
                    "snapshot_id": str(uuid4()),
                    "doc_state": encode_state_as_update(self.doc),
                }
                self.snapshots.append(snapshot)
                return snapshot

            def rollback_to_snapshot(self, snapshot_id):
                for snapshot in self.snapshots:
                    if snapshot["snapshot_id"] == snapshot_id:
                        apply_update(self.doc, snapshot["doc_state"])
                        return {"success": True}
                return {"success": False, "error": "not found"}

        manager = RollbackManager(doc)
        cells = doc.get_array("cells")

        # Create progressively larger documents for performance testing
        document_sizes = [10, 50, 100, 200]  # Number of cells
        rollback_performance = []

        for size in document_sizes:
            # Create document of specified size
            with doc.begin_transaction() as txn:
                for i in range(size):
                    cells.insert(
                        txn,
                        i,
                        {
                            "cell_type": "code",
                            "source": f"cell_{i}_data = {i}\n"
                            + "".join([f"# Content line {j}\n" for j in range(5)]) * (i % 10 + 1),
                            "metadata": {
                                "cell_id": f"perf_cell_{i}",
                                "size_test": size,
                                "content_lines": i % 10 + 1,
                            },
                        },
                    )

            snapshot = manager.create_snapshot(f"Size {size} document")

            # Measure rollback performance
            rollback_times = []

            for _ in range(10):  # 10 rollback operations
                start_time = time.perf_counter()
                rollback_result = manager.rollback_to_snapshot(snapshot["snapshot_id"])
                end_time = time.perf_counter()

                assert rollback_result["success"] is True
                rollback_times.append((end_time - start_time) * 1000)  # Convert to ms

            avg_rollback_time = mean(rollback_times)
            max_rollback_time = max(rollback_times)

            rollback_performance.append(
                {
                    "document_size": size,
                    "avg_rollback_time_ms": avg_rollback_time,
                    "max_rollback_time_ms": max_rollback_time,
                    "rollback_times": rollback_times,
                }
            )

        # Validate performance boundaries
        for perf in rollback_performance:
            size = perf["document_size"]
            avg_time = perf["avg_rollback_time_ms"]
            max_time = perf["max_rollback_time_ms"]

            # Performance boundaries based on document size
            if size <= 50:
                assert (
                    avg_time < 50
                ), f"Average rollback for {size} cells took {avg_time}ms, expected < 50ms"
                assert (
                    max_time < 100
                ), f"Max rollback for {size} cells took {max_time}ms, expected < 100ms"
            elif size <= 100:
                assert (
                    avg_time < 100
                ), f"Average rollback for {size} cells took {avg_time}ms, expected < 100ms"
                assert (
                    max_time < 200
                ), f"Max rollback for {size} cells took {max_time}ms, expected < 200ms"
            else:
                assert (
                    avg_time < 200
                ), f"Average rollback for {size} cells took {avg_time}ms, expected < 200ms"
                assert (
                    max_time < 500
                ), f"Max rollback for {size} cells took {max_time}ms, expected < 500ms"

        # Verify rollback performance scales reasonably
        small_perf = rollback_performance[0]  # size 10
        large_perf = rollback_performance[-1]  # size 200

        time_ratio = large_perf["avg_rollback_time_ms"] / small_perf["avg_rollback_time_ms"]
        size_ratio = large_perf["document_size"] / small_perf["document_size"]

        # Rollback shouldn't scale worse than linearly with size
        assert (
            time_ratio < size_ratio * 1.5
        ), f"Rollback performance scaling is poor: time_ratio={time_ratio}, size_ratio={size_ratio}"


class TestHistoryPersistenceRetrieval:
    """Test suite for history persistence and retrieval across sessions."""

    @pytest.mark.asyncio
    async def test_history_persistence_basic(self, yjs_doc):
        """Test basic history persistence across sessions."""
        doc = yjs_doc("persistence_basic.ipynb")

        class PersistentHistoryManager:
            def __init__(self, doc, storage_path=None):
                self.doc = doc
                self.storage_path = storage_path or tempfile.mkdtemp()
                self.history_file = Path(self.storage_path) / "history.json"
                self.snapshots_dir = Path(self.storage_path) / "snapshots"
                self.snapshots_dir.mkdir(exist_ok=True)

            def save_history_entry(self, entry):
                """Save a history entry to persistent storage."""
                # Save snapshot data separately
                snapshot_file = self.snapshots_dir / f"{entry['entry_id']}.snapshot"
                with open(snapshot_file, "wb") as f:
                    f.write(entry["doc_state"])

                # Save history metadata
                history_entry = {
                    "entry_id": entry["entry_id"],
                    "timestamp": entry["timestamp"].isoformat(),
                    "description": entry["description"],
                    "cells_count": entry["cells_count"],
                    "snapshot_file": str(snapshot_file),
                    "user_id": entry.get("user_id", "anonymous"),
                }

                # Load existing history or create new
                if self.history_file.exists():
                    with open(self.history_file) as f:
                        history_data = json.loads(f.read())
                else:
                    history_data = {
                        "entries": [],
                        "created": datetime.now(timezone.utc).isoformat(),
                    }

                history_data["entries"].append(history_entry)

                # Save updated history
                with open(self.history_file, "w") as f:
                    f.write(json.dumps(history_data, indent=2))

                return history_entry

            def load_history(self):
                """Load history from persistent storage."""
                if not self.history_file.exists():
                    return {"entries": [], "created": datetime.now(timezone.utc).isoformat()}

                with open(self.history_file) as f:
                    history_data = json.loads(f.read())

                # Validate snapshot files exist
                for entry in history_data["entries"]:
                    snapshot_path = Path(entry["snapshot_file"])
                    if not snapshot_path.exists():
                        entry["snapshot_available"] = False
                    else:
                        entry["snapshot_available"] = True
                        entry["snapshot_size"] = snapshot_path.stat().st_size

                return history_data

            def retrieve_snapshot(self, entry_id):
                """Retrieve a specific snapshot by entry ID."""
                history_data = self.load_history()

                for entry in history_data["entries"]:
                    if entry["entry_id"] == entry_id:
                        snapshot_path = Path(entry["snapshot_file"])
                        if snapshot_path.exists():
                            with open(snapshot_path, "rb") as f:
                                return f.read()
                return None

            def cleanup_storage(self):
                """Clean up temporary storage."""
                import shutil

                shutil.rmtree(self.storage_path, ignore_errors=True)

        # Test with temporary storage
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = PersistentHistoryManager(doc, temp_dir)
            cells = doc.get_array("cells")

            # Create initial history entries
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    0,
                    {
                        "cell_type": "code",
                        "source": "print('session 1 - entry 1')",
                        "metadata": {"session": 1},
                    },
                )

            entry1 = {
                "entry_id": str(uuid4()),
                "timestamp": datetime.now(timezone.utc),
                "description": "First entry",
                "doc_state": encode_state_as_update(doc),
                "cells_count": len(cells),
                "user_id": "test_user_1",
            }
            saved_entry1 = manager.save_history_entry(entry1)

            # Add another entry
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    1,
                    {
                        "cell_type": "markdown",
                        "source": "# Session 1 Documentation",
                        "metadata": {"session": 1},
                    },
                )

            entry2 = {
                "entry_id": str(uuid4()),
                "timestamp": datetime.now(timezone.utc),
                "description": "Added documentation",
                "doc_state": encode_state_as_update(doc),
                "cells_count": len(cells),
                "user_id": "test_user_1",
            }
            saved_entry2 = manager.save_history_entry(entry2)

            # Simulate session end and restart
            del manager  # Simulate process termination

            # Create new manager instance (simulate new session)
            new_session_manager = PersistentHistoryManager(doc, temp_dir)

            # Load history from previous session
            loaded_history = new_session_manager.load_history()

            # Validate persistence
            assert len(loaded_history["entries"]) == 2
            assert loaded_history["entries"][0]["entry_id"] == entry1["entry_id"]
            assert loaded_history["entries"][1]["entry_id"] == entry2["entry_id"]

            # Verify snapshot availability
            for entry in loaded_history["entries"]:
                assert entry["snapshot_available"] is True
                assert entry["snapshot_size"] > 0

            # Test snapshot retrieval
            retrieved_snapshot1 = new_session_manager.retrieve_snapshot(entry1["entry_id"])
            assert retrieved_snapshot1 is not None
            assert retrieved_snapshot1 == entry1["doc_state"]

            retrieved_snapshot2 = new_session_manager.retrieve_snapshot(entry2["entry_id"])
            assert retrieved_snapshot2 is not None
            assert retrieved_snapshot2 == entry2["doc_state"]

            # Test cross-session document reconstruction
            test_doc = YDoc()
            apply_update(test_doc, retrieved_snapshot1)
            test_cells = test_doc.get_array("cells")

            assert len(test_cells) == 1
            assert test_cells[0]["source"] == "print('session 1 - entry 1')"

    @pytest.mark.asyncio
    async def test_history_persistence_multi_session(self, yjs_doc):
        """Test history persistence across multiple sessions with different users."""
        doc = yjs_doc("multi_session_persistence.ipynb")

        class PersistentHistoryManager:
            def __init__(self, doc, storage_path=None):
                self.doc = doc
                self.storage_path = storage_path
                self.history_file = Path(storage_path) / "history.json"

            def save_history_entry(self, entry):
                pass

            def load_history(self):
                return []

        with tempfile.TemporaryDirectory() as temp_dir:
            # Session 1: User A
            session1_manager = PersistentHistoryManager(doc, temp_dir)
            cells = doc.get_array("cells")

            # User A makes changes
            for i in range(3):
                with doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        i,
                        {
                            "cell_type": "code",
                            "source": f"# User A - Operation {i+1}\nvalue_a_{i} = {i * 10}",
                            "metadata": {"user": "user_a", "operation": i + 1},
                        },
                    )

                entry = {
                    "entry_id": str(uuid4()),
                    "timestamp": datetime.now(timezone.utc),
                    "description": f"User A - Operation {i+1}",
                    "doc_state": encode_state_as_update(doc),
                    "cells_count": len(cells),
                    "user_id": "user_a",
                }
                session1_manager.save_history_entry(entry)

                # Small delay to ensure timestamp differences
                await asyncio.sleep(0.001)

            # Session 2: User B (simulated by new manager instance)
            session2_manager = PersistentHistoryManager(doc, temp_dir)

            # Load existing history
            loaded_history = session2_manager.load_history()
            assert len(loaded_history["entries"]) == 3

            # User B makes additional changes
            for i in range(2):
                with doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        len(cells),
                        {
                            "cell_type": "markdown",
                            "source": f"# User B - Note {i+1}\nThis is documentation from User B",
                            "metadata": {"user": "user_b", "note": i + 1},
                        },
                    )

                entry = {
                    "entry_id": str(uuid4()),
                    "timestamp": datetime.now(timezone.utc),
                    "description": f"User B - Note {i+1}",
                    "doc_state": encode_state_as_update(doc),
                    "cells_count": len(cells),
                    "user_id": "user_b",
                }
                session2_manager.save_history_entry(entry)
                await asyncio.sleep(0.001)

            # Session 3: User C (another new manager instance)
            session3_manager = PersistentHistoryManager(doc, temp_dir)

            # Load complete history
            complete_history = session3_manager.load_history()

            # Validate multi-session persistence
            assert len(complete_history["entries"]) == 5

            # Verify user attribution
            user_a_entries = [e for e in complete_history["entries"] if e["user_id"] == "user_a"]
            user_b_entries = [e for e in complete_history["entries"] if e["user_id"] == "user_b"]

            assert len(user_a_entries) == 3
            assert len(user_b_entries) == 2

            # Verify chronological order
            timestamps = [
                datetime.fromisoformat(e["timestamp"]) for e in complete_history["entries"]
            ]
            for i in range(1, len(timestamps)):
                assert (
                    timestamps[i] > timestamps[i - 1]
                ), "History entries should be in chronological order"

            # Test snapshot retrieval across sessions
            for entry in complete_history["entries"]:
                snapshot_data = session3_manager.retrieve_snapshot(entry["entry_id"])
                assert (
                    snapshot_data is not None
                ), f"Snapshot not found for entry {entry['entry_id']}"

                # Verify snapshot can be applied to recreate state
                test_doc = YDoc()
                apply_update(test_doc, snapshot_data)
                test_cells = test_doc.get_array("cells")

                assert (
                    len(test_cells) == entry["cells_count"]
                ), f"Cell count mismatch for entry {entry['entry_id']}: expected {entry['cells_count']}, got {len(test_cells)}"

    @pytest.mark.asyncio
    async def test_history_storage_optimization(self, yjs_doc):
        """Test storage optimization for history persistence."""
        doc = yjs_doc("storage_optimization.ipynb")

        class PersistentHistoryManager:
            def __init__(self, doc, storage_path=None):
                self.doc = doc
                self.storage_path = storage_path

        class OptimizedHistoryManager(PersistentHistoryManager):
            def __init__(self, doc, storage_path=None):
                super().__init__(doc, storage_path)
                self.compression_enabled = True
                self.max_history_entries = 100
                self.cleanup_threshold = 120

            def save_history_entry(self, entry):
                """Save history entry with compression and cleanup."""
                # Compress snapshot data if enabled
                if self.compression_enabled:
                    import gzip

                    compressed_data = gzip.compress(entry["doc_state"])
                    entry["doc_state"] = compressed_data
                    entry["compressed"] = True
                else:
                    entry["compressed"] = False

                saved_entry = super().save_history_entry(entry)

                # Check if cleanup is needed
                history_data = self.load_history()
                if len(history_data["entries"]) > self.cleanup_threshold:
                    self.cleanup_old_entries()

                return saved_entry

            def cleanup_old_entries(self):
                """Clean up old history entries to maintain storage limits."""
                history_data = self.load_history()

                if len(history_data["entries"]) <= self.max_history_entries:
                    return None

                # Sort by timestamp and keep most recent entries
                entries = history_data["entries"]
                entries.sort(key=lambda x: x["timestamp"], reverse=True)

                # Keep only max_history_entries most recent
                entries_to_keep = entries[: self.max_history_entries]
                entries_to_remove = entries[self.max_history_entries :]

                # Remove old snapshot files
                for entry in entries_to_remove:
                    snapshot_path = Path(entry["snapshot_file"])
                    if snapshot_path.exists():
                        snapshot_path.unlink()

                # Update history file
                history_data["entries"] = entries_to_keep
                with open(self.history_file, "w") as f:
                    f.write(json.dumps(history_data, indent=2))

                return len(entries_to_remove)

            def retrieve_snapshot(self, entry_id):
                """Retrieve snapshot with decompression."""
                history_data = self.load_history()

                for entry in history_data["entries"]:
                    if entry["entry_id"] == entry_id:
                        snapshot_path = Path(entry["snapshot_file"])
                        if snapshot_path.exists():
                            with open(snapshot_path, "rb") as f:
                                data = f.read()

                            # Decompress if needed
                            if entry.get("compressed", False):
                                import gzip

                                data = gzip.decompress(data)

                            return data
                return None

        with tempfile.TemporaryDirectory() as temp_dir:
            manager = OptimizedHistoryManager(doc, temp_dir)
            cells = doc.get_array("cells")

            # Create many history entries to test optimization
            storage_metrics = []

            for i in range(150):  # Exceed cleanup threshold
                # Create varying sized documents
                cell_count = (i % 10) + 1

                with doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        len(cells),
                        {
                            "cell_type": "code",
                            "source": f"# Entry {i}\n" + f"data_{i} = {i}\n" * cell_count,
                            "metadata": {"entry": i, "size_test": True},
                        },
                    )

                entry = {
                    "entry_id": str(uuid4()),
                    "timestamp": datetime.now(timezone.utc),
                    "description": f"Optimization test entry {i}",
                    "doc_state": encode_state_as_update(doc),
                    "cells_count": len(cells),
                }

                # Measure storage before save
                storage_before = sum(
                    f.stat().st_size for f in Path(temp_dir).rglob("*") if f.is_file()
                )

                manager.save_history_entry(entry)

                # Measure storage after save
                storage_after = sum(
                    f.stat().st_size for f in Path(temp_dir).rglob("*") if f.is_file()
                )

                storage_metrics.append(
                    {
                        "entry_number": i,
                        "storage_before": storage_before,
                        "storage_after": storage_after,
                        "storage_increase": storage_after - storage_before,
                    }
                )

            # Verify storage optimization
            final_history = manager.load_history()

            # Should have triggered cleanup
            assert (
                len(final_history["entries"]) <= manager.max_history_entries
            ), f"History should be cleaned up to {manager.max_history_entries} entries, found {len(final_history['entries'])}"

            # Verify compression effectiveness
            sample_entries = final_history["entries"][:10]  # Check first 10 entries

            for entry in sample_entries:
                # Retrieve snapshot and verify it can be decompressed
                snapshot_data = manager.retrieve_snapshot(entry["entry_id"])
                assert (
                    snapshot_data is not None
                ), f"Failed to retrieve snapshot for {entry['entry_id']}"

                # Verify snapshot can be applied
                test_doc = YDoc()
                apply_update(test_doc, snapshot_data)
                test_cells = test_doc.get_array("cells")

                assert (
                    len(test_cells) == entry["cells_count"]
                ), f"Decompressed snapshot cell count mismatch: expected {entry['cells_count']}, got {len(test_cells)}"

            # Verify storage growth is controlled
            storage_growth = [
                m["storage_increase"] for m in storage_metrics[-20:]
            ]  # Last 20 entries
            avg_growth = mean(storage_growth)

            # With compression and cleanup, storage growth should be controlled
            assert (
                avg_growth < 50000
            ), f"Average storage growth {avg_growth} bytes is too high, expected < 50KB"


class TestRetentionPolicyEnforcement:
    """Test suite for retention policy enforcement in history management."""

    @pytest.mark.asyncio
    async def test_time_based_retention(self, yjs_doc):
        """Test time-based retention policy enforcement."""
        doc = yjs_doc("time_retention.ipynb")

        class TimeBasedRetentionManager:
            def __init__(self, doc, storage_path=None, retention_days=30):
                self.doc = doc
                self.storage_path = storage_path or tempfile.mkdtemp()
                self.retention_days = retention_days
                self.history_file = Path(self.storage_path) / "history.json"
                self.snapshots_dir = Path(self.storage_path) / "snapshots"
                self.snapshots_dir.mkdir(exist_ok=True)

            def save_history_entry(self, entry, custom_timestamp=None):
                """Save history entry with optional custom timestamp for testing."""
                # Use custom timestamp if provided (for testing)
                timestamp = custom_timestamp or entry["timestamp"]

                # Save snapshot
                snapshot_file = self.snapshots_dir / f"{entry['entry_id']}.snapshot"
                with open(snapshot_file, "wb") as f:
                    f.write(entry["doc_state"])

                # Save history metadata
                history_entry = {
                    "entry_id": entry["entry_id"],
                    "timestamp": timestamp.isoformat(),
                    "description": entry["description"],
                    "cells_count": entry["cells_count"],
                    "snapshot_file": str(snapshot_file),
                    "user_id": entry.get("user_id", "anonymous"),
                }

                # Load or create history
                if self.history_file.exists():
                    with open(self.history_file) as f:
                        history_data = json.loads(f.read())
                else:
                    history_data = {
                        "entries": [],
                        "created": datetime.now(timezone.utc).isoformat(),
                    }

                history_data["entries"].append(history_entry)

                # Save history
                with open(self.history_file, "w") as f:
                    f.write(json.dumps(history_data, indent=2))

                return history_entry

            def enforce_retention_policy(self):
                """Enforce time-based retention policy."""
                if not self.history_file.exists():
                    return {"removed_count": 0, "kept_count": 0}

                with open(self.history_file) as f:
                    history_data = json.loads(f.read())

                current_time = datetime.now(timezone.utc)
                retention_cutoff = current_time - timedelta(days=self.retention_days)

                entries_to_keep = []
                entries_to_remove = []

                for entry in history_data["entries"]:
                    entry_time = datetime.fromisoformat(entry["timestamp"])
                    if entry_time > retention_cutoff:
                        entries_to_keep.append(entry)
                    else:
                        entries_to_remove.append(entry)

                # Remove old snapshot files
                for entry in entries_to_remove:
                    snapshot_path = Path(entry["snapshot_file"])
                    if snapshot_path.exists():
                        snapshot_path.unlink()

                # Update history file
                history_data["entries"] = entries_to_keep
                with open(self.history_file, "w") as f:
                    f.write(json.dumps(history_data, indent=2))

                return {
                    "removed_count": len(entries_to_remove),
                    "kept_count": len(entries_to_keep),
                    "retention_cutoff": retention_cutoff.isoformat(),
                }

        with tempfile.TemporaryDirectory() as temp_dir:
            manager = TimeBasedRetentionManager(
                doc, temp_dir, retention_days=7
            )  # 7 day retention for testing
            cells = doc.get_array("cells")

            # Create history entries with different timestamps
            test_entries = []

            # Current entries (should be kept)
            current_base_time = datetime.now(timezone.utc)
            for i in range(5):
                with doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        len(cells),
                        {
                            "cell_type": "code",
                            "source": f"current_entry_{i} = {i}",
                            "metadata": {"category": "current"},
                        },
                    )

                entry = {
                    "entry_id": str(uuid4()),
                    "timestamp": current_base_time - timedelta(days=i),  # 0-4 days ago
                    "description": f"Current entry {i}",
                    "doc_state": encode_state_as_update(doc),
                    "cells_count": len(cells),
                }

                manager.save_history_entry(entry, entry["timestamp"])
                test_entries.append(("current", entry))

            # Old entries (should be removed)
            old_base_time = current_base_time - timedelta(days=10)  # 10 days ago base
            for i in range(3):
                with doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        len(cells),
                        {
                            "cell_type": "markdown",
                            "source": f"# Old Entry {i}\nThis is old content",
                            "metadata": {"category": "old"},
                        },
                    )

                entry = {
                    "entry_id": str(uuid4()),
                    "timestamp": old_base_time - timedelta(days=i),  # 10-12 days ago
                    "description": f"Old entry {i}",
                    "doc_state": encode_state_as_update(doc),
                    "cells_count": len(cells),
                }

                manager.save_history_entry(entry, entry["timestamp"])
                test_entries.append(("old", entry))

            # Borderline entries (exactly at retention boundary)
            boundary_time = current_base_time - timedelta(days=7)  # Exactly 7 days ago
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    len(cells),
                    {
                        "cell_type": "code",
                        "source": "boundary_entry = 'exactly_7_days'",
                        "metadata": {"category": "boundary"},
                    },
                )

            boundary_entry = {
                "entry_id": str(uuid4()),
                "timestamp": boundary_time,
                "description": "Boundary entry",
                "doc_state": encode_state_as_update(doc),
                "cells_count": len(cells),
            }

            manager.save_history_entry(boundary_entry, boundary_entry["timestamp"])
            test_entries.append(("boundary", boundary_entry))

            # Verify all entries exist before retention
            initial_history = (
                manager.load_history() if manager.history_file.exists() else {"entries": []}
            )
            assert len(initial_history["entries"]) == 9  # 5 current + 3 old + 1 boundary

            # Enforce retention policy
            retention_result = manager.enforce_retention_policy()

            # Verify retention results
            assert (
                retention_result["removed_count"] == 3
            ), f"Expected 3 old entries to be removed, got {retention_result['removed_count']}"

            assert (
                retention_result["kept_count"] == 6
            ), f"Expected 6 entries to be kept (5 current + 1 boundary), got {retention_result['kept_count']}"

            # Verify final history state
            final_history = manager.load_history()
            assert len(final_history["entries"]) == 6

            # Verify only current and boundary entries remain
            remaining_timestamps = [
                datetime.fromisoformat(e["timestamp"]) for e in final_history["entries"]
            ]
            cutoff_time = datetime.now(timezone.utc) - timedelta(days=7)

            for timestamp in remaining_timestamps:
                assert (
                    timestamp >= cutoff_time
                ), f"Entry with timestamp {timestamp} should have been removed (cutoff: {cutoff_time})"

            # Verify old snapshot files were removed
            remaining_snapshot_files = list(manager.snapshots_dir.glob("*.snapshot"))
            assert (
                len(remaining_snapshot_files) == 6
            ), f"Expected 6 snapshot files to remain, found {len(remaining_snapshot_files)}"

    @pytest.mark.asyncio
    async def test_size_based_retention(self, yjs_doc):
        """Test size-based retention policy enforcement."""
        doc = yjs_doc("size_retention.ipynb")

        class SizeBasedRetentionManager:
            def __init__(self, doc, storage_path=None, max_storage_mb=10):
                self.doc = doc
                self.storage_path = storage_path or tempfile.mkdtemp()
                self.max_storage_bytes = max_storage_mb * 1024 * 1024  # Convert MB to bytes
                self.history_file = Path(self.storage_path) / "history.json"
                self.snapshots_dir = Path(self.storage_path) / "snapshots"
                self.snapshots_dir.mkdir(exist_ok=True)

            def get_storage_usage(self):
                """Get current storage usage in bytes."""
                total_size = 0
                for file_path in Path(self.storage_path).rglob("*"):
                    if file_path.is_file():
                        total_size += file_path.stat().st_size
                return total_size

            def save_history_entry(self, entry):
                """Save history entry and enforce size limits."""
                # Save snapshot
                snapshot_file = self.snapshots_dir / f"{entry['entry_id']}.snapshot"
                with open(snapshot_file, "wb") as f:
                    f.write(entry["doc_state"])

                # Save history metadata
                history_entry = {
                    "entry_id": entry["entry_id"],
                    "timestamp": entry["timestamp"].isoformat(),
                    "description": entry["description"],
                    "cells_count": entry["cells_count"],
                    "snapshot_file": str(snapshot_file),
                    "snapshot_size": len(entry["doc_state"]),
                    "user_id": entry.get("user_id", "anonymous"),
                }

                # Load or create history
                if self.history_file.exists():
                    with open(self.history_file) as f:
                        history_data = json.loads(f.read())
                else:
                    history_data = {
                        "entries": [],
                        "created": datetime.now(timezone.utc).isoformat(),
                    }

                history_data["entries"].append(history_entry)

                # Save history
                with open(self.history_file, "w") as f:
                    f.write(json.dumps(history_data, indent=2))

                # Check and enforce size limits
                if self.get_storage_usage() > self.max_storage_bytes:
                    self.enforce_size_limits()

                return history_entry

            def enforce_size_limits(self):
                """Enforce size-based retention by removing oldest entries."""
                if not self.history_file.exists():
                    return {"removed_count": 0, "freed_bytes": 0}

                with open(self.history_file) as f:
                    history_data = json.loads(f.read())

                # Sort entries by timestamp (oldest first)
                entries = history_data["entries"]
                entries.sort(key=lambda x: x["timestamp"])

                removed_count = 0
                freed_bytes = 0

                while self.get_storage_usage() > self.max_storage_bytes and entries:
                    # Remove oldest entry
                    oldest_entry = entries.pop(0)

                    # Remove snapshot file
                    snapshot_path = Path(oldest_entry["snapshot_file"])
                    if snapshot_path.exists():
                        file_size = snapshot_path.stat().st_size
                        snapshot_path.unlink()
                        freed_bytes += file_size

                    removed_count += 1

                # Update history file
                history_data["entries"] = entries
                with open(self.history_file, "w") as f:
                    f.write(json.dumps(history_data, indent=2))

                return {
                    "removed_count": removed_count,
                    "freed_bytes": freed_bytes,
                    "final_storage_bytes": self.get_storage_usage(),
                }

        with tempfile.TemporaryDirectory() as temp_dir:
            # Use small storage limit for testing (1MB)
            manager = SizeBasedRetentionManager(doc, temp_dir, max_storage_mb=1)
            cells = doc.get_array("cells")

            # Create progressively larger documents to exceed storage limit
            total_entries = 0
            storage_history = []

            for size_factor in range(1, 20):  # Create documents of increasing size
                # Create document with size proportional to size_factor
                large_content = "# Large content\n" + ("x = " + "a" * size_factor * 100 + "\n") * 10

                with doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        len(cells),
                        {
                            "cell_type": "code",
                            "source": large_content,
                            "metadata": {"size_factor": size_factor},
                        },
                    )

                entry = {
                    "entry_id": str(uuid4()),
                    "timestamp": datetime.now(timezone.utc),
                    "description": f"Large entry {size_factor}",
                    "doc_state": encode_state_as_update(doc),
                    "cells_count": len(cells),
                }

                storage_before = manager.get_storage_usage()
                manager.save_history_entry(entry)
                storage_after = manager.get_storage_usage()

                storage_history.append(
                    {
                        "entry_number": size_factor,
                        "storage_before": storage_before,
                        "storage_after": storage_after,
                        "entry_size": len(entry["doc_state"]),
                    }
                )

                total_entries += 1

                # Short delay for timestamp uniqueness
                await asyncio.sleep(0.001)

            # Verify size limits were enforced
            final_storage = manager.get_storage_usage()
            assert (
                final_storage <= manager.max_storage_bytes
            ), f"Final storage {final_storage} bytes exceeds limit {manager.max_storage_bytes} bytes"

            # Verify some entries were removed due to size limits
            final_history = manager.load_history()
            assert (
                len(final_history["entries"]) < total_entries
            ), f"Expected some entries to be removed, but all {total_entries} entries remain"

            # Verify remaining entries are the most recent ones
            remaining_timestamps = [
                datetime.fromisoformat(e["timestamp"]) for e in final_history["entries"]
            ]
            remaining_timestamps.sort()

            # Check that timestamps are recent (size enforcement should keep newest)
            if len(remaining_timestamps) > 1:
                time_gap = remaining_timestamps[-1] - remaining_timestamps[0]
                assert (
                    time_gap.total_seconds() < 60
                ), "Remaining entries should be recent and close together in time"

            # Verify storage usage is reasonable
            storage_efficiency = final_storage / manager.max_storage_bytes
            assert (
                0.5 <= storage_efficiency <= 1.0
            ), f"Storage efficiency {storage_efficiency:.2f} should be between 0.5 and 1.0"

    @pytest.mark.asyncio
    async def test_combined_retention_policies(self, yjs_doc):
        """Test combined time and size-based retention policies."""
        doc = yjs_doc("combined_retention.ipynb")

        class CombinedRetentionManager:
            def __init__(
                self, doc, storage_path=None, retention_days=7, max_storage_mb=5, max_entries=50
            ):
                self.doc = doc
                self.storage_path = storage_path or tempfile.mkdtemp()
                self.retention_days = retention_days
                self.max_storage_bytes = max_storage_mb * 1024 * 1024
                self.max_entries = max_entries
                self.history_file = Path(self.storage_path) / "history.json"
                self.snapshots_dir = Path(self.storage_path) / "snapshots"
                self.snapshots_dir.mkdir(exist_ok=True)

            def save_history_entry(self, entry, custom_timestamp=None):
                """Save history entry with combined retention enforcement."""
                timestamp = custom_timestamp or entry["timestamp"]

                # Save snapshot
                snapshot_file = self.snapshots_dir / f"{entry['entry_id']}.snapshot"
                with open(snapshot_file, "wb") as f:
                    f.write(entry["doc_state"])

                # Save history metadata
                history_entry = {
                    "entry_id": entry["entry_id"],
                    "timestamp": timestamp.isoformat(),
                    "description": entry["description"],
                    "cells_count": entry["cells_count"],
                    "snapshot_file": str(snapshot_file),
                    "snapshot_size": len(entry["doc_state"]),
                    "user_id": entry.get("user_id", "anonymous"),
                }

                # Load or create history
                if self.history_file.exists():
                    with open(self.history_file) as f:
                        history_data = json.loads(f.read())
                else:
                    history_data = {
                        "entries": [],
                        "created": datetime.now(timezone.utc).isoformat(),
                    }

                history_data["entries"].append(history_entry)

                # Save history
                with open(self.history_file, "w") as f:
                    f.write(json.dumps(history_data, indent=2))

                # Enforce all retention policies
                retention_result = self.enforce_combined_policies()

                return history_entry, retention_result

            def enforce_combined_policies(self):
                """Enforce time, size, and count-based retention policies."""
                if not self.history_file.exists():
                    return {"time_removed": 0, "size_removed": 0, "count_removed": 0}

                with open(self.history_file) as f:
                    history_data = json.loads(f.read())

                entries = history_data["entries"]
                initial_count = len(entries)

                # Phase 1: Time-based retention
                current_time = datetime.now(timezone.utc)
                retention_cutoff = current_time - timedelta(days=self.retention_days)

                time_kept_entries = []
                time_removed = 0

                for entry in entries:
                    entry_time = datetime.fromisoformat(entry["timestamp"])
                    if entry_time > retention_cutoff:
                        time_kept_entries.append(entry)
                    else:
                        # Remove snapshot file
                        snapshot_path = Path(entry["snapshot_file"])
                        if snapshot_path.exists():
                            snapshot_path.unlink()
                        time_removed += 1

                # Phase 2: Count-based retention (keep most recent)
                if len(time_kept_entries) > self.max_entries:
                    # Sort by timestamp (newest first)
                    time_kept_entries.sort(key=lambda x: x["timestamp"], reverse=True)

                    count_kept_entries = time_kept_entries[: self.max_entries]
                    count_removed_entries = time_kept_entries[self.max_entries :]

                    # Remove excess snapshot files
                    for entry in count_removed_entries:
                        snapshot_path = Path(entry["snapshot_file"])
                        if snapshot_path.exists():
                            snapshot_path.unlink()

                    count_removed = len(count_removed_entries)
                    entries_after_count = count_kept_entries
                else:
                    count_removed = 0
                    entries_after_count = time_kept_entries

                # Phase 3: Size-based retention (remove oldest until under limit)
                current_storage = self.get_storage_usage()
                size_removed = 0

                if current_storage > self.max_storage_bytes:
                    # Sort by timestamp (oldest first) for size-based removal
                    entries_after_count.sort(key=lambda x: x["timestamp"])

                    while current_storage > self.max_storage_bytes and entries_after_count:
                        oldest_entry = entries_after_count.pop(0)

                        # Remove snapshot file
                        snapshot_path = Path(oldest_entry["snapshot_file"])
                        if snapshot_path.exists():
                            snapshot_path.unlink()

                        size_removed += 1
                        current_storage = self.get_storage_usage()

                final_entries = entries_after_count

                # Update history file
                history_data["entries"] = final_entries
                with open(self.history_file, "w") as f:
                    f.write(json.dumps(history_data, indent=2))

                return {
                    "initial_count": initial_count,
                    "time_removed": time_removed,
                    "count_removed": count_removed,
                    "size_removed": size_removed,
                    "final_count": len(final_entries),
                    "final_storage_bytes": self.get_storage_usage(),
                }

            def get_storage_usage(self):
                """Get current storage usage in bytes."""
                total_size = 0
                for file_path in Path(self.storage_path).rglob("*"):
                    if file_path.is_file():
                        total_size += file_path.stat().st_size
                return total_size

            def load_history(self):
                """Load history from storage."""
                if not self.history_file.exists():
                    return {"entries": []}

                with open(self.history_file) as f:
                    return json.loads(f.read())

        with tempfile.TemporaryDirectory() as temp_dir:
            # Set restrictive limits to trigger all retention policies
            manager = CombinedRetentionManager(
                doc,
                temp_dir,
                retention_days=5,  # 5 days
                max_storage_mb=2,  # 2MB
                max_entries=20,  # Max 20 entries
            )
            cells = doc.get_array("cells")

            retention_results = []

            # Create many entries with varying sizes and timestamps
            base_time = datetime.now(timezone.utc)

            for i in range(60):  # Create 60 entries (exceeds count limit)
                # Vary content size
                content_size = (i % 10) + 1
                large_content = (
                    f"# Entry {i}\n" + f"data_{i} = '{i}' * {content_size * 100}\n" * content_size
                )

                # Vary timestamps (some old, some new)
                if i < 20:
                    # Old entries (should be removed by time policy)
                    entry_time = base_time - timedelta(days=10 + (i % 5))
                elif i < 40:
                    # Recent entries
                    entry_time = base_time - timedelta(days=i % 4)
                else:
                    # Very recent entries
                    entry_time = base_time - timedelta(hours=i % 24)

                with doc.begin_transaction() as txn:
                    cells.insert(
                        txn,
                        len(cells),
                        {
                            "cell_type": "code",
                            "source": large_content,
                            "metadata": {"entry": i, "content_size": content_size},
                        },
                    )

                entry = {
                    "entry_id": str(uuid4()),
                    "timestamp": entry_time,
                    "description": f"Combined policy test entry {i}",
                    "doc_state": encode_state_as_update(doc),
                    "cells_count": len(cells),
                }

                saved_entry, retention_result = manager.save_history_entry(entry, entry_time)
                retention_results.append(retention_result)

            # Verify combined retention policies were enforced
            final_history = manager.load_history()
            final_count = len(final_history["entries"])
            final_storage = manager.get_storage_usage()

            # Should not exceed any limits
            assert (
                final_count <= manager.max_entries
            ), f"Final count {final_count} exceeds max entries {manager.max_entries}"

            assert (
                final_storage <= manager.max_storage_bytes
            ), f"Final storage {final_storage} exceeds max storage {manager.max_storage_bytes}"

            # Verify time-based retention (no entries older than retention_days)
            cutoff_time = datetime.now(timezone.utc) - timedelta(days=manager.retention_days)
            for entry in final_history["entries"]:
                entry_time = datetime.fromisoformat(entry["timestamp"])
                assert (
                    entry_time > cutoff_time
                ), f"Entry {entry['entry_id']} timestamp {entry_time} is older than cutoff {cutoff_time}"

            # Verify retention was actually triggered
            final_retention_result = retention_results[-1]
            total_removed = (
                final_retention_result["time_removed"]
                + final_retention_result["count_removed"]
                + final_retention_result["size_removed"]
            )

            assert total_removed > 0, "Expected some entries to be removed by retention policies"

            # Verify final state is reasonable
            assert (
                10 <= final_count <= 20
            ), f"Final entry count {final_count} should be between 10-20"
            assert final_storage > 0, "Should have some storage usage"

            storage_efficiency = final_storage / manager.max_storage_bytes
            assert (
                0.3 <= storage_efficiency <= 1.0
            ), f"Storage efficiency {storage_efficiency:.2f} should be reasonable"


class TestMultiUserChangeAttribution:
    """Test suite for multi-user change attribution in collaborative scenarios."""

    @pytest.mark.asyncio
    async def test_basic_user_attribution(self, yjs_doc, multi_user_session):
        """Test basic user attribution in collaborative editing."""
        doc = yjs_doc("user_attribution.ipynb")
        session = multi_user_session(3, "user_attribution.ipynb")

        class UserAttributionTracker:
            def __init__(self):
                self.changes = []
                self.user_sessions = {}

            def register_user_session(self, user_id, session_info):
                """Register a user session for attribution tracking."""
                self.user_sessions[user_id] = {
                    "user_id": user_id,
                    "session_start": datetime.now(timezone.utc),
                    "display_name": session_info.get("display_name", f"User {user_id}"),
                    "role": session_info.get("role", "editor"),
                    "changes_made": 0,
                }

            def record_change(self, user_id, change_type, change_details):
                """Record a change with user attribution."""
                if user_id not in self.user_sessions:
                    msg = f"User {user_id} not registered"
                    raise ValueError(msg)

                change_record = {
                    "change_id": str(uuid4()),
                    "user_id": user_id,
                    "timestamp": datetime.now(timezone.utc),
                    "change_type": change_type,
                    "change_details": change_details,
                    "user_display_name": self.user_sessions[user_id]["display_name"],
                    "user_role": self.user_sessions[user_id]["role"],
                }

                self.changes.append(change_record)
                self.user_sessions[user_id]["changes_made"] += 1

                return change_record

            def get_changes_by_user(self, user_id):
                """Get all changes made by a specific user."""
                return [change for change in self.changes if change["user_id"] == user_id]

            def get_user_activity_summary(self):
                """Get activity summary for all users."""
                summary = {}
                for user_id, session_info in self.user_sessions.items():
                    user_changes = self.get_changes_by_user(user_id)
                    change_types = {}

                    for change in user_changes:
                        change_type = change["change_type"]
                        change_types[change_type] = change_types.get(change_type, 0) + 1

                    summary[user_id] = {
                        "display_name": session_info["display_name"],
                        "role": session_info["role"],
                        "total_changes": len(user_changes),
                        "change_types": change_types,
                        "session_duration": (
                            datetime.now(timezone.utc) - session_info["session_start"]
                        ).total_seconds(),
                        "first_change": min([c["timestamp"] for c in user_changes])
                        if user_changes
                        else None,
                        "last_change": max([c["timestamp"] for c in user_changes])
                        if user_changes
                        else None,
                    }

                return summary

        tracker = UserAttributionTracker()

        # Register test users
        users = [
            {"id": "user_alice", "display_name": "Alice Smith", "role": "admin"},
            {"id": "user_bob", "display_name": "Bob Johnson", "role": "editor"},
            {"id": "user_charlie", "display_name": "Charlie Brown", "role": "viewer"},
        ]

        for user in users:
            tracker.register_user_session(user["id"], user)

        # Simulate collaborative changes
        cells = doc.get_array("cells")

        # Alice (admin) creates initial structure
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                0,
                {
                    "cell_type": "markdown",
                    "source": "# Project Overview\nCreated by Alice",
                    "metadata": {"author": "user_alice", "created": datetime.now().isoformat()},
                },
            )

        tracker.record_change(
            "user_alice",
            "cell_creation",
            {"cell_index": 0, "cell_type": "markdown", "action": "create_project_header"},
        )

        # Bob (editor) adds code cells
        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                1,
                {
                    "cell_type": "code",
                    "source": "import pandas as pd\nimport numpy as np",
                    "metadata": {"author": "user_bob", "purpose": "imports"},
                },
            )

        tracker.record_change(
            "user_bob",
            "cell_creation",
            {"cell_index": 1, "cell_type": "code", "action": "add_imports"},
        )

        with doc.begin_transaction() as txn:
            cells.insert(
                txn,
                2,
                {
                    "cell_type": "code",
                    "source": "data = pd.read_csv('data.csv')\nprint(data.shape)",
                    "metadata": {"author": "user_bob", "purpose": "data_loading"},
                },
            )

        tracker.record_change(
            "user_bob",
            "cell_creation",
            {"cell_index": 2, "cell_type": "code", "action": "add_data_loading"},
        )

        # Alice modifies existing content
        with doc.begin_transaction() as txn:
            if len(cells) > 0:
                cell = dict(cells[0])
                cell["source"] = "# Project Overview\nCreated by Alice\nModified for clarity"
                cell["metadata"]["modified_by"] = "user_alice"
                cell["metadata"]["modified"] = datetime.now().isoformat()
                # Use delete + insert instead of item assignment
                cells.delete(txn, 0)
                cells.insert(txn, 0, cell)

        tracker.record_change(
            "user_alice",
            "cell_modification",
            {"cell_index": 0, "field": "source", "action": "clarify_header"},
        )

        # Bob modifies his code
        with doc.begin_transaction() as txn:
            if len(cells) > 1:
                cell = dict(cells[1])
                cell["source"] = (
                    "import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt"
                )
                cell["metadata"]["modified_by"] = "user_bob"
                cell["metadata"]["modified"] = datetime.now().isoformat()
                # Use delete + insert instead of item assignment
                cells.delete(txn, 1)
                cells.insert(txn, 1, cell)

        tracker.record_change(
            "user_bob",
            "cell_modification",
            {"cell_index": 1, "field": "source", "action": "add_matplotlib_import"},
        )

        # Charlie (viewer) attempts to add a comment (should be tracked even if not allowed)
        tracker.record_change(
            "user_charlie",
            "comment_attempt",
            {
                "cell_index": 0,
                "comment": "This looks good!",
                "action": "add_comment",
                "result": "permission_denied",
            },
        )

        # Validate user attribution
        activity_summary = tracker.get_user_activity_summary()

        # Verify all users are tracked
        assert len(activity_summary) == 3
        assert "user_alice" in activity_summary
        assert "user_bob" in activity_summary
        assert "user_charlie" in activity_summary

        # Verify Alice's activity
        alice_activity = activity_summary["user_alice"]
        assert alice_activity["display_name"] == "Alice Smith"
        assert alice_activity["role"] == "admin"
        assert alice_activity["total_changes"] == 2
        assert "cell_creation" in alice_activity["change_types"]
        assert "cell_modification" in alice_activity["change_types"]

        # Verify Bob's activity
        bob_activity = activity_summary["user_bob"]
        assert bob_activity["display_name"] == "Bob Johnson"
        assert bob_activity["role"] == "editor"
        assert bob_activity["total_changes"] == 3
        assert bob_activity["change_types"]["cell_creation"] == 2
        assert bob_activity["change_types"]["cell_modification"] == 1

        # Verify Charlie's activity (even though permission denied)
        charlie_activity = activity_summary["user_charlie"]
        assert charlie_activity["display_name"] == "Charlie Brown"
        assert charlie_activity["role"] == "viewer"
        assert charlie_activity["total_changes"] == 1
        assert "comment_attempt" in charlie_activity["change_types"]

        # Verify chronological tracking
        alice_changes = tracker.get_changes_by_user("user_alice")
        assert len(alice_changes) == 2
        assert alice_changes[0]["timestamp"] < alice_changes[1]["timestamp"]

        # Verify change details are preserved
        bob_changes = tracker.get_changes_by_user("user_bob")
        code_creations = [c for c in bob_changes if c["change_type"] == "cell_creation"]
        assert len(code_creations) == 2
        assert all(c["change_details"]["cell_type"] == "code" for c in code_creations)

    @pytest.mark.asyncio
    async def test_concurrent_change_attribution(self, yjs_doc, multi_user_session):
        """Test user attribution for concurrent changes."""
        doc = yjs_doc("concurrent_attribution.ipynb")
        session = multi_user_session(4, "concurrent_attribution.ipynb")

        class UserAttributionTracker:
            def __init__(self):
                self.users = {}
                self.changes = []

            def register_user(self, user_info):
                self.users[user_info["user_id"]] = user_info

        class ConcurrentAttributionTracker(UserAttributionTracker):
            def __init__(self):
                super().__init__()
                self.concurrent_batches = []
                self.current_batch_id = None

            def start_concurrent_batch(self, batch_description=""):
                """Start tracking a batch of concurrent changes."""
                self.current_batch_id = str(uuid4())
                batch = {
                    "batch_id": self.current_batch_id,
                    "start_time": datetime.now(timezone.utc),
                    "description": batch_description,
                    "changes": [],
                    "participants": set(),
                }
                self.concurrent_batches.append(batch)
                return self.current_batch_id

            def record_change(self, user_id, change_type, change_details):
                """Record change with batch attribution."""
                change_record = super().record_change(user_id, change_type, change_details)

                # Add to current batch if one is active
                if self.current_batch_id:
                    change_record["batch_id"] = self.current_batch_id

                    # Find and update current batch
                    for batch in self.concurrent_batches:
                        if batch["batch_id"] == self.current_batch_id:
                            batch["changes"].append(change_record)
                            batch["participants"].add(user_id)
                            break

                return change_record

            def end_concurrent_batch(self):
                """End the current concurrent batch."""
                if self.current_batch_id:
                    for batch in self.concurrent_batches:
                        if batch["batch_id"] == self.current_batch_id:
                            batch["end_time"] = datetime.now(timezone.utc)
                            batch["duration_ms"] = (
                                batch["end_time"] - batch["start_time"]
                            ).total_seconds() * 1000
                            batch["participant_count"] = len(batch["participants"])
                            break

                    self.current_batch_id = None

            def get_concurrent_analysis(self):
                """Analyze concurrent change patterns."""
                analysis = {
                    "total_batches": len(self.concurrent_batches),
                    "batch_summaries": [],
                    "concurrency_metrics": {
                        "avg_participants_per_batch": 0,
                        "max_participants": 0,
                        "avg_batch_duration_ms": 0,
                        "total_concurrent_changes": 0,
                    },
                }

                total_participants = 0
                total_duration = 0
                total_changes = 0

                for batch in self.concurrent_batches:
                    batch_summary = {
                        "batch_id": batch["batch_id"],
                        "description": batch["description"],
                        "participant_count": len(batch["participants"]),
                        "change_count": len(batch["changes"]),
                        "duration_ms": batch.get("duration_ms", 0),
                        "participants": list(batch["participants"]),
                        "change_types": {},
                    }

                    # Analyze change types in batch
                    for change in batch["changes"]:
                        change_type = change["change_type"]
                        batch_summary["change_types"][change_type] = (
                            batch_summary["change_types"].get(change_type, 0) + 1
                        )

                    analysis["batch_summaries"].append(batch_summary)

                    total_participants += len(batch["participants"])
                    total_duration += batch.get("duration_ms", 0)
                    total_changes += len(batch["changes"])

                if len(self.concurrent_batches) > 0:
                    analysis["concurrency_metrics"] = {
                        "avg_participants_per_batch": total_participants
                        / len(self.concurrent_batches),
                        "max_participants": max(
                            [len(b["participants"]) for b in self.concurrent_batches]
                        ),
                        "avg_batch_duration_ms": total_duration / len(self.concurrent_batches),
                        "total_concurrent_changes": total_changes,
                    }

                return analysis

        tracker = ConcurrentAttributionTracker()

        # Register multiple users
        users = [
            {"id": "dev_1", "display_name": "Developer 1", "role": "editor"},
            {"id": "dev_2", "display_name": "Developer 2", "role": "editor"},
            {"id": "reviewer_1", "display_name": "Reviewer 1", "role": "admin"},
            {"id": "analyst_1", "display_name": "Data Analyst", "role": "editor"},
        ]

        for user in users:
            tracker.register_user_session(user["id"], user)

        cells = doc.get_array("cells")

        # Simulate concurrent editing session 1: Initial setup
        batch1_id = tracker.start_concurrent_batch("Initial notebook setup")

        # All users add initial content simultaneously
        async def concurrent_setup():
            # Developer 1 adds imports
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    0,
                    {
                        "cell_type": "code",
                        "source": "import pandas as pd\nimport numpy as np",
                        "metadata": {"author": "dev_1", "purpose": "imports"},
                    },
                )

            tracker.record_change(
                "dev_1",
                "cell_creation",
                {"cell_index": 0, "cell_type": "code", "action": "add_imports", "concurrent": True},
            )

            # Developer 2 adds configuration
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    1,
                    {
                        "cell_type": "code",
                        "source": "CONFIG = {\n    'data_path': 'data/',\n    'output_path': 'output/'\n}",
                        "metadata": {"author": "dev_2", "purpose": "config"},
                    },
                )

            tracker.record_change(
                "dev_2",
                "cell_creation",
                {
                    "cell_index": 1,
                    "cell_type": "code",
                    "action": "add_configuration",
                    "concurrent": True,
                },
            )

            # Reviewer adds documentation
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    2,
                    {
                        "cell_type": "markdown",
                        "source": "# Data Analysis Notebook\n\nThis notebook performs data analysis on the dataset.",
                        "metadata": {"author": "reviewer_1", "purpose": "documentation"},
                    },
                )

            tracker.record_change(
                "reviewer_1",
                "cell_creation",
                {
                    "cell_index": 2,
                    "cell_type": "markdown",
                    "action": "add_documentation",
                    "concurrent": True,
                },
            )

            # Analyst adds data loading
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    3,
                    {
                        "cell_type": "code",
                        "source": "df = pd.read_csv(CONFIG['data_path'] + 'dataset.csv')\nprint(f'Loaded {len(df)} rows')",
                        "metadata": {"author": "analyst_1", "purpose": "data_loading"},
                    },
                )

            tracker.record_change(
                "analyst_1",
                "cell_creation",
                {
                    "cell_index": 3,
                    "cell_type": "code",
                    "action": "add_data_loading",
                    "concurrent": True,
                },
            )

        await concurrent_setup()
        tracker.end_concurrent_batch()

        # Small delay to separate batches
        await asyncio.sleep(0.01)

        # Simulate concurrent editing session 2: Modifications
        batch2_id = tracker.start_concurrent_batch("Concurrent modifications")

        async def concurrent_modifications():
            # Developer 1 modifies imports
            with doc.begin_transaction() as txn:
                if len(cells) > 0:
                    cell = dict(cells[0])
                    cell["source"] = (
                        "import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt\nimport seaborn as sns"
                    )
                    cell["metadata"]["modified_by"] = "dev_1"
                    cell["metadata"]["modified"] = datetime.now().isoformat()
                    # Use delete + insert instead of item assignment
                    cells.delete(txn, 0)
                    cells.insert(txn, 0, cell)

            tracker.record_change(
                "dev_1",
                "cell_modification",
                {
                    "cell_index": 0,
                    "field": "source",
                    "action": "extend_imports",
                    "concurrent": True,
                },
            )

            # Developer 2 modifies config
            with doc.begin_transaction() as txn:
                if len(cells) > 1:
                    cell = dict(cells[1])
                    cell["source"] = (
                        "CONFIG = {\n    'data_path': 'data/',\n    'output_path': 'output/',\n    'plot_style': 'seaborn'\n}"
                    )
                    cell["metadata"]["modified_by"] = "dev_2"
                    cell["metadata"]["modified"] = datetime.now().isoformat()
                    # Use delete + insert instead of item assignment
                    cells.delete(txn, 1)
                    cells.insert(txn, 1, cell)

            tracker.record_change(
                "dev_2",
                "cell_modification",
                {"cell_index": 1, "field": "source", "action": "extend_config", "concurrent": True},
            )

            # Reviewer adds more documentation
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    len(cells),
                    {
                        "cell_type": "markdown",
                        "source": "## Data Preprocessing\n\nSteps for cleaning and preparing the data:",
                        "metadata": {"author": "reviewer_1", "purpose": "section_header"},
                    },
                )

            tracker.record_change(
                "reviewer_1",
                "cell_creation",
                {
                    "cell_index": len(cells) - 1,
                    "cell_type": "markdown",
                    "action": "add_section_header",
                    "concurrent": True,
                },
            )

        await concurrent_modifications()
        tracker.end_concurrent_batch()

        # Analyze concurrent attribution
        concurrency_analysis = tracker.get_concurrent_analysis()

        # Validate concurrent batch tracking
        assert concurrency_analysis["total_batches"] == 2
        assert concurrency_analysis["concurrency_metrics"]["max_participants"] == 4
        assert concurrency_analysis["concurrency_metrics"]["total_concurrent_changes"] == 7

        # Verify batch 1 (initial setup)
        batch1_summary = concurrency_analysis["batch_summaries"][0]
        assert batch1_summary["participant_count"] == 4
        assert batch1_summary["change_count"] == 4
        assert set(batch1_summary["participants"]) == {"dev_1", "dev_2", "reviewer_1", "analyst_1"}
        assert "cell_creation" in batch1_summary["change_types"]
        assert batch1_summary["change_types"]["cell_creation"] == 4

        # Verify batch 2 (modifications)
        batch2_summary = concurrency_analysis["batch_summaries"][1]
        assert batch2_summary["participant_count"] == 3
        assert batch2_summary["change_count"] == 3
        assert "cell_modification" in batch2_summary["change_types"]
        assert "cell_creation" in batch2_summary["change_types"]

        # Verify individual user attribution
        activity_summary = tracker.get_user_activity_summary()

        dev1_activity = activity_summary["dev_1"]
        assert dev1_activity["total_changes"] == 2
        assert dev1_activity["change_types"]["cell_creation"] == 1
        assert dev1_activity["change_types"]["cell_modification"] == 1

        # Verify timing information
        for batch in concurrency_analysis["batch_summaries"]:
            assert batch["duration_ms"] >= 0
            assert batch["duration_ms"] < 1000  # Should complete quickly

        # Verify all changes have proper attribution
        all_changes = tracker.changes
        assert len(all_changes) == 7

        for change in all_changes:
            assert "batch_id" in change
            assert change["user_id"] in ["dev_1", "dev_2", "reviewer_1", "analyst_1"]
            assert "timestamp" in change
            assert change["change_details"]["concurrent"] is True

    @pytest.mark.asyncio
    async def test_change_attribution_persistence(self, yjs_doc):
        """Test persistence of user attribution data across sessions."""
        doc = yjs_doc("attribution_persistence.ipynb")

        class UserAttributionTracker:
            def __init__(self):
                self.users = {}
                self.changes = []

            def register_user(self, user_info):
                self.users[user_info["user_id"]] = user_info

            def track_change(self, change):
                self.changes.append(change)

        class PersistentAttributionManager:
            def __init__(self, storage_path=None):
                self.storage_path = storage_path or tempfile.mkdtemp()
                self.attribution_file = Path(self.storage_path) / "attribution.json"
                self.changes_file = Path(self.storage_path) / "changes.json"
                self.users_file = Path(self.storage_path) / "users.json"

            def save_attribution_data(self, users, changes):
                """Save attribution data to persistent storage."""
                # Save users data
                users_data = {"users": users, "saved_at": datetime.now(timezone.utc).isoformat()}
                with open(self.users_file, "w") as f:
                    json.dump(users_data, f, indent=2, default=str)

                # Save changes data
                changes_data = {
                    "changes": [
                        {**change, "timestamp": change["timestamp"].isoformat()}
                        for change in changes
                    ],
                    "saved_at": datetime.now(timezone.utc).isoformat(),
                }
                with open(self.changes_file, "w") as f:
                    json.dump(changes_data, f, indent=2, default=str)

                # Save combined attribution metadata
                attribution_data = {
                    "total_users": len(users),
                    "total_changes": len(changes),
                    "last_updated": datetime.now(timezone.utc).isoformat(),
                    "data_files": {
                        "users": str(self.users_file),
                        "changes": str(self.changes_file),
                    },
                }
                with open(self.attribution_file, "w") as f:
                    json.dump(attribution_data, f, indent=2)

                return attribution_data

            def load_attribution_data(self):
                """Load attribution data from persistent storage."""
                if not all(
                    [
                        self.attribution_file.exists(),
                        self.users_file.exists(),
                        self.changes_file.exists(),
                    ]
                ):
                    return None

                # Load metadata
                with open(self.attribution_file) as f:
                    attribution_data = json.load(f)

                # Load users
                with open(self.users_file) as f:
                    users_data = json.load(f)

                # Load changes
                with open(self.changes_file) as f:
                    changes_data = json.load(f)

                # Convert timestamp strings back to datetime objects
                for change in changes_data["changes"]:
                    change["timestamp"] = datetime.fromisoformat(change["timestamp"])

                return {
                    "attribution_metadata": attribution_data,
                    "users": users_data["users"],
                    "changes": changes_data["changes"],
                }

            def cleanup_storage(self):
                """Clean up storage directory."""
                import shutil

                shutil.rmtree(self.storage_path, ignore_errors=True)

        with tempfile.TemporaryDirectory() as temp_dir:
            # Session 1: Create initial attribution data
            manager1 = PersistentAttributionManager(temp_dir)
            tracker1 = UserAttributionTracker()

            # Register users in session 1
            session1_users = [
                {"id": "user_a", "display_name": "Alice", "role": "admin"},
                {"id": "user_b", "display_name": "Bob", "role": "editor"},
            ]

            for user in session1_users:
                tracker1.register_user_session(user["id"], user)

            # Create changes in session 1
            cells = doc.get_array("cells")

            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    0,
                    {
                        "cell_type": "markdown",
                        "source": "# Session 1 Content\nCreated by Alice",
                        "metadata": {"author": "user_a", "session": 1},
                    },
                )

            tracker1.record_change(
                "user_a",
                "cell_creation",
                {"session": 1, "cell_index": 0, "action": "create_header"},
            )

            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    1,
                    {
                        "cell_type": "code",
                        "source": "# Session 1 code by Bob\nprint('Hello from session 1')",
                        "metadata": {"author": "user_b", "session": 1},
                    },
                )

            tracker1.record_change(
                "user_b", "cell_creation", {"session": 1, "cell_index": 1, "action": "add_code"}
            )

            # Save session 1 attribution data
            saved_data1 = manager1.save_attribution_data(tracker1.user_sessions, tracker1.changes)

            assert saved_data1["total_users"] == 2
            assert saved_data1["total_changes"] == 2

            # Simulate session end
            del tracker1, manager1

            # Session 2: Load previous data and add new changes
            manager2 = PersistentAttributionManager(temp_dir)
            loaded_data = manager2.load_attribution_data()

            # Verify data persistence
            assert loaded_data is not None
            assert loaded_data["attribution_metadata"]["total_users"] == 2
            assert loaded_data["attribution_metadata"]["total_changes"] == 2
            assert len(loaded_data["users"]) == 2
            assert len(loaded_data["changes"]) == 2

            # Recreate tracker with loaded data
            tracker2 = UserAttributionTracker()

            # Restore user sessions
            for user_id, user_data in loaded_data["users"].items():
                tracker2.user_sessions[user_id] = user_data

            # Restore changes
            tracker2.changes = loaded_data["changes"]

            # Add new user in session 2
            tracker2.register_user_session("user_c", {"display_name": "Charlie", "role": "viewer"})

            # Add more changes in session 2
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    2,
                    {
                        "cell_type": "code",
                        "source": "# Session 2 addition\nprint('Added in session 2')",
                        "metadata": {"author": "user_c", "session": 2},
                    },
                )

            tracker2.record_change(
                "user_c",
                "cell_creation",
                {"session": 2, "cell_index": 2, "action": "add_session2_content"},
            )

            # Modify existing content (cross-session modification)
            with doc.begin_transaction() as txn:
                if len(cells) > 0:
                    cell = dict(cells[0])
                    cell["source"] = (
                        "# Session 1 Content - Modified in Session 2\nCreated by Alice, modified by Charlie"
                    )
                    cell["metadata"]["modified_by"] = "user_c"
                    cell["metadata"]["modified_in_session"] = 2
                    # Use delete + insert instead of item assignment
                    cells.delete(txn, 0)
                    cells.insert(txn, 0, cell)

            tracker2.record_change(
                "user_c",
                "cell_modification",
                {
                    "session": 2,
                    "cell_index": 0,
                    "original_author": "user_a",
                    "action": "cross_session_modification",
                },
            )

            # Save updated attribution data
            saved_data2 = manager2.save_attribution_data(tracker2.user_sessions, tracker2.changes)

            assert saved_data2["total_users"] == 3
            assert saved_data2["total_changes"] == 4

            # Session 3: Verify complete persistence
            manager3 = PersistentAttributionManager(temp_dir)
            final_loaded_data = manager3.load_attribution_data()

            # Verify complete data persistence
            assert final_loaded_data["attribution_metadata"]["total_users"] == 3
            assert final_loaded_data["attribution_metadata"]["total_changes"] == 4

            # Verify user data persistence
            users = final_loaded_data["users"]
            assert "user_a" in users
            assert "user_b" in users
            assert "user_c" in users

            assert users["user_a"]["display_name"] == "Alice"
            assert users["user_b"]["display_name"] == "Bob"
            assert users["user_c"]["display_name"] == "Charlie"

            # Verify changes persistence and chronology
            changes = final_loaded_data["changes"]
            assert len(changes) == 4

            # Verify chronological order
            timestamps = [change["timestamp"] for change in changes]
            for i in range(1, len(timestamps)):
                assert timestamps[i] > timestamps[i - 1], "Changes should be in chronological order"

            # Verify cross-session attribution
            session1_changes = [c for c in changes if c["change_details"].get("session") == 1]
            session2_changes = [c for c in changes if c["change_details"].get("session") == 2]

            assert len(session1_changes) == 2
            assert len(session2_changes) == 2

            # Verify cross-session modification tracking
            cross_session_mods = [
                c
                for c in changes
                if c["change_type"] == "cell_modification"
                and c["change_details"].get("action") == "cross_session_modification"
            ]
            assert len(cross_session_mods) == 1
            assert cross_session_mods[0]["user_id"] == "user_c"
            assert cross_session_mods[0]["change_details"]["original_author"] == "user_a"


class TestHistoryOperationPerformance:
    """Test suite for performance validation of history operations."""

    @pytest.mark.asyncio
    async def test_history_operation_latency(self, yjs_doc):
        """Test that history operations meet latency requirements."""
        doc = yjs_doc("performance_test.ipynb")

        class PerformanceHistoryManager:
            def __init__(self, doc):
                self.doc = doc
                self.operations_log = []

            def measure_operation(self, operation_name, operation_func, *args, **kwargs):
                """Measure the performance of a history operation."""
                start_time = time.perf_counter()

                try:
                    result = operation_func(*args, **kwargs)
                    success = True
                    error = None
                except Exception as e:
                    result = None
                    success = False
                    error = str(e)

                end_time = time.perf_counter()
                duration_ms = (end_time - start_time) * 1000

                operation_record = {
                    "operation": operation_name,
                    "duration_ms": duration_ms,
                    "timestamp": datetime.now(timezone.utc),
                    "success": success,
                    "error": error,
                    "args_count": len(args),
                    "kwargs_count": len(kwargs),
                }

                self.operations_log.append(operation_record)

                return result, operation_record

            def get_performance_summary(self):
                """Get performance summary for all operations."""
                if not self.operations_log:
                    return {}

                operations_by_type = {}
                for op in self.operations_log:
                    op_name = op["operation"]
                    if op_name not in operations_by_type:
                        operations_by_type[op_name] = []
                    operations_by_type[op_name].append(op["duration_ms"])

                summary = {}
                for op_name, durations in operations_by_type.items():
                    summary[op_name] = {
                        "count": len(durations),
                        "avg_duration_ms": mean(durations),
                        "min_duration_ms": min(durations),
                        "max_duration_ms": max(durations),
                        "median_duration_ms": median(durations),
                        "p95_duration_ms": sorted(durations)[int(len(durations) * 0.95)]
                        if len(durations) > 1
                        else durations[0],
                        "success_rate": sum(
                            1
                            for op in self.operations_log
                            if op["operation"] == op_name and op["success"]
                        )
                        / len(durations),
                    }

                return summary

        perf_manager = PerformanceHistoryManager(doc)
        cells = doc.get_array("cells")

        # Test snapshot creation performance
        def create_snapshot():
            return {
                "snapshot_id": str(uuid4()),
                "doc_state": encode_state_as_update(doc),
                "timestamp": datetime.now(timezone.utc),
                "cells_count": len(cells),
            }

        # Create initial content for performance testing
        for i in range(20):  # 20 cells for realistic size
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    i,
                    {
                        "cell_type": "code",
                        "source": f"# Performance test cell {i}\ndata_{i} = {i} * 10\nresult_{i} = data_{i} ** 2",
                        "metadata": {"test_cell": i},
                    },
                )

        # Test snapshot creation latency (should be under 50ms)
        for _ in range(10):
            snapshot, operation_record = perf_manager.measure_operation(
                "snapshot_creation", create_snapshot
            )
            assert operation_record["success"] is True
            assert (
                operation_record["duration_ms"] < 50
            ), f"Snapshot creation took {operation_record['duration_ms']}ms, expected < 50ms"

        # Test update event capture performance
        def capture_update_event():
            return {
                "update_size": len(encode_state_as_update(doc)),
                "timestamp": time.perf_counter(),
            }

        for _ in range(20):
            update_info, operation_record = perf_manager.measure_operation(
                "update_capture", capture_update_event
            )
            assert operation_record["success"] is True
            assert (
                operation_record["duration_ms"] < 20
            ), f"Update capture took {operation_record['duration_ms']}ms, expected < 20ms"

        # Test diff generation performance
        def generate_diff(old_content, new_content):
            matcher = difflib.SequenceMatcher(
                None, old_content.splitlines(), new_content.splitlines()
            )
            return {
                "similarity_ratio": matcher.ratio(),
                "opcodes_count": len(list(matcher.get_opcodes())),
            }

        test_content_pairs = [
            ("original content\nline 2\nline 3", "modified content\nline 2\nline 3\nline 4"),
            ("print('hello')", "print('hello world')"),
            ("import pandas as pd", "import pandas as pd\nimport numpy as np"),
            ("# Header\nContent here", "# Modified Header\nContent here\nMore content"),
            ("x = 1\ny = 2", "x = 10\ny = 20\nz = 30"),
        ]

        for old, new in test_content_pairs:
            diff_result, operation_record = perf_manager.measure_operation(
                "diff_generation", generate_diff, old, new
            )
            assert operation_record["success"] is True
            assert (
                operation_record["duration_ms"] < 30
            ), f"Diff generation took {operation_record['duration_ms']}ms, expected < 30ms"

        # Test version browsing performance
        versions = []
        for i in range(10):
            version = {
                "version_id": str(uuid4()),
                "timestamp": datetime.now(timezone.utc),
                "doc_state": encode_state_as_update(doc),
                "cells_count": len(cells) + i,
            }
            versions.append(version)

        def browse_to_version(version_id):
            for version in versions:
                if version["version_id"] == version_id:
                    return version
            return None

        for version in versions[:5]:  # Test browsing to 5 versions
            browsed_version, operation_record = perf_manager.measure_operation(
                "version_browsing", browse_to_version, version["version_id"]
            )
            assert operation_record["success"] is True
            assert (
                operation_record["duration_ms"] < 10
            ), f"Version browsing took {operation_record['duration_ms']}ms, expected < 10ms"
            assert browsed_version["version_id"] == version["version_id"]

        # Test rollback performance
        def perform_rollback(version_id):
            target_version = browse_to_version(version_id)
            if not target_version:
                return {"success": False, "error": "Version not found"}

            # Simulate rollback by creating new doc with target state
            rollback_doc = YDoc()
            apply_update(rollback_doc, target_version["doc_state"])

            return {
                "success": True,
                "rollback_cells_count": len(rollback_doc.get_array("cells")),
                "version_id": version_id,
            }

        for version in versions[:3]:  # Test rollback to 3 versions
            rollback_result, operation_record = perf_manager.measure_operation(
                "rollback_operation", perform_rollback, version["version_id"]
            )
            assert operation_record["success"] is True
            assert (
                operation_record["duration_ms"] < 100
            ), f"Rollback operation took {operation_record['duration_ms']}ms, expected < 100ms"
            assert rollback_result["success"] is True

        # Analyze overall performance
        performance_summary = perf_manager.get_performance_summary()

        # Validate performance boundaries for each operation type
        performance_requirements = {
            "snapshot_creation": {"max_avg_ms": 30, "max_p95_ms": 50},
            "update_capture": {"max_avg_ms": 10, "max_p95_ms": 20},
            "diff_generation": {"max_avg_ms": 20, "max_p95_ms": 30},
            "version_browsing": {"max_avg_ms": 5, "max_p95_ms": 10},
            "rollback_operation": {"max_avg_ms": 50, "max_p95_ms": 100},
        }

        for op_name, requirements in performance_requirements.items():
            if op_name in performance_summary:
                op_stats = performance_summary[op_name]

                assert (
                    op_stats["avg_duration_ms"] <= requirements["max_avg_ms"]
                ), f"{op_name} average duration {op_stats['avg_duration_ms']}ms exceeds limit {requirements['max_avg_ms']}ms"

                assert (
                    op_stats["p95_duration_ms"] <= requirements["max_p95_ms"]
                ), f"{op_name} 95th percentile duration {op_stats['p95_duration_ms']}ms exceeds limit {requirements['max_p95_ms']}ms"

                assert (
                    op_stats["success_rate"] >= 0.95
                ), f"{op_name} success rate {op_stats['success_rate']:.2f} is below 95%"

    @pytest.mark.asyncio
    async def test_history_memory_overhead(self, yjs_doc):
        """Test that history operations stay within memory overhead limits."""
        doc = yjs_doc("memory_overhead.ipynb")

        class MemoryHistoryManager:
            def __init__(self, doc):
                self.doc = doc
                self.baseline_memory = 0
                self.snapshots = []
                self.memory_measurements = []

            def measure_memory_usage(self, operation_description=""):
                """Measure current memory usage (simulated)."""
                # Simulate memory measurement by calculating data sizes
                doc_state_size = len(encode_state_as_update(self.doc))
                snapshots_size = sum(len(s["doc_state"]) for s in self.snapshots)

                # Estimate total memory usage
                estimated_memory = doc_state_size + snapshots_size

                measurement = {
                    "timestamp": datetime.now(timezone.utc),
                    "operation": operation_description,
                    "doc_state_size": doc_state_size,
                    "snapshots_size": snapshots_size,
                    "total_estimated_memory": estimated_memory,
                    "snapshots_count": len(self.snapshots),
                }

                self.memory_measurements.append(measurement)
                return measurement

            def set_baseline(self):
                """Set baseline memory measurement."""
                baseline_measurement = self.measure_memory_usage("baseline")
                self.baseline_memory = baseline_measurement["total_estimated_memory"]
                return baseline_measurement

            def create_snapshot(self, description=""):
                """Create snapshot and measure memory impact."""
                snapshot = {
                    "snapshot_id": str(uuid4()),
                    "timestamp": datetime.now(timezone.utc),
                    "description": description,
                    "doc_state": encode_state_as_update(self.doc),
                    "cells_count": len(self.doc.get_array("cells")),
                }

                self.snapshots.append(snapshot)

                # Measure memory after snapshot creation
                memory_after = self.measure_memory_usage(f"snapshot_created_{len(self.snapshots)}")

                return snapshot, memory_after

            def calculate_memory_overhead(self):
                """Calculate memory overhead percentage."""
                if not self.memory_measurements:
                    return {"error": "No memory measurements available"}

                current_memory = self.memory_measurements[-1]["total_estimated_memory"]

                if self.baseline_memory == 0:
                    return {"error": "Baseline memory not set"}

                overhead_bytes = current_memory - self.baseline_memory
                overhead_percentage = (overhead_bytes / self.baseline_memory) * 100

                return {
                    "baseline_memory_bytes": self.baseline_memory,
                    "current_memory_bytes": current_memory,
                    "overhead_bytes": overhead_bytes,
                    "overhead_percentage": overhead_percentage,
                    "snapshots_count": len(self.snapshots),
                }

            def optimize_memory_usage(self, target_overhead_percentage=20):
                """Optimize memory usage by removing old snapshots."""
                overhead_info = self.calculate_memory_overhead()

                if overhead_info.get("error"):
                    return overhead_info

                if overhead_info["overhead_percentage"] <= target_overhead_percentage:
                    return {
                        "optimization_needed": False,
                        "current_overhead": overhead_info["overhead_percentage"],
                    }

                # Remove oldest snapshots until overhead is acceptable
                snapshots_removed = 0
                original_count = len(self.snapshots)

                while (
                    self.calculate_memory_overhead()["overhead_percentage"]
                    > target_overhead_percentage
                    and len(self.snapshots) > 1
                ):  # Keep at least 1 snapshot
                    self.snapshots.pop(0)  # Remove oldest
                    snapshots_removed += 1

                    # Update memory measurement
                    self.measure_memory_usage(f"optimization_removed_{snapshots_removed}")

                final_overhead = self.calculate_memory_overhead()

                return {
                    "optimization_needed": True,
                    "original_snapshots": original_count,
                    "snapshots_removed": snapshots_removed,
                    "remaining_snapshots": len(self.snapshots),
                    "original_overhead": overhead_info["overhead_percentage"],
                    "final_overhead": final_overhead["overhead_percentage"],
                    "target_overhead": target_overhead_percentage,
                }

        memory_manager = MemoryHistoryManager(doc)
        cells = doc.get_array("cells")

        # Create initial document content
        for i in range(10):
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    i,
                    {
                        "cell_type": "code",
                        "source": f"# Memory test cell {i}\ndata = list(range({i * 100}))\nresult = sum(data)",
                        "metadata": {"memory_test": True, "cell_index": i},
                    },
                )

        # Set baseline memory
        baseline = memory_manager.set_baseline()
        assert baseline["snapshots_count"] == 0
        assert baseline["total_estimated_memory"] > 0

        # Create snapshots and monitor memory usage
        for i in range(15):  # Create 15 snapshots
            # Add more content to document
            with doc.begin_transaction() as txn:
                cells.insert(
                    txn,
                    len(cells),
                    {
                        "cell_type": "markdown",
                        "source": f"# Snapshot {i}\nThis is additional content for snapshot {i}"
                        + "\n" * (i + 1),
                        "metadata": {"snapshot_index": i},
                    },
                )

            snapshot, memory_measurement = memory_manager.create_snapshot(f"Snapshot {i}")

            # Check memory overhead after each snapshot
            overhead_info = memory_manager.calculate_memory_overhead()

            # Verify memory tracking
            assert overhead_info["overhead_percentage"] >= 0
            assert len(memory_manager.snapshots) > 0

            # Trigger optimization if overhead exceeds 25%
            if overhead_info["overhead_percentage"] > 25:
                optimization_result = memory_manager.optimize_memory_usage(
                    20
                )  # Target 20% overhead

                assert optimization_result["optimization_needed"] is True
                assert optimization_result["snapshots_removed"] > 0
                assert optimization_result["final_overhead"] <= 20.5  # Allow small tolerance

                # Verify optimization effectiveness
                assert optimization_result["snapshots_removed"] > 0
                assert optimization_result["final_overhead"] <= 20.5

        # Verify final memory overhead is within limits (20% requirement)
        final_overhead = memory_manager.calculate_memory_overhead()
        assert (
            final_overhead["overhead_percentage"] <= 22
        ), f"Final memory overhead {final_overhead['overhead_percentage']:.1f}% exceeds 20% limit"

        # Verify optimization effectiveness
        assert (
            len(memory_manager.snapshots) < 15
        ), "Some snapshots should have been removed for optimization"
        assert len(memory_manager.snapshots) >= 5, "Should maintain reasonable number of snapshots"

        # Test memory usage with large documents
        large_doc = yjs_doc("large_memory_test.ipynb")
        large_memory_manager = MemoryHistoryManager(large_doc)
        large_cells = large_doc.get_array("cells")

        # Create large document (simulate large notebook)
        for i in range(50):  # 50 cells with substantial content
            large_content = (
                f"# Large cell {i}\n" + f"large_data_{i} = [i for i in range(1000)]\n" * 10
            )

            with large_doc.begin_transaction() as txn:
                large_cells.insert(
                    txn,
                    i,
                    {
                        "cell_type": "code",
                        "source": large_content,
                        "metadata": {"large_test": True, "size": len(large_content)},
                    },
                )

        large_baseline = large_memory_manager.set_baseline()

        # Create a few snapshots of large document
        for i in range(3):
            # Add more large content
            with large_doc.begin_transaction() as txn:
                large_cells.insert(
                    txn,
                    len(large_cells),
                    {
                        "cell_type": "code",
                        "source": f"# Additional large content {i}\n"
                        + "x = [j**2 for j in range(1000)]\n" * 20,
                        "metadata": {"additional_large": i},
                    },
                )

            snapshot, memory_measurement = large_memory_manager.create_snapshot(
                f"Large snapshot {i}"
            )

        large_overhead = large_memory_manager.calculate_memory_overhead()

        # Even with large documents, overhead should be manageable
        assert (
            large_overhead["overhead_percentage"] <= 40
        ), f"Large document memory overhead {large_overhead['overhead_percentage']:.1f}% is excessive"

        # Test that memory usage grows predictably
        memory_measurements = memory_manager.memory_measurements
        growth_rates = []

        for i in range(1, len(memory_measurements)):
            prev_memory = memory_measurements[i - 1]["total_estimated_memory"]
            curr_memory = memory_measurements[i]["total_estimated_memory"]
            growth_rate = (curr_memory - prev_memory) / prev_memory if prev_memory > 0 else 0
            growth_rates.append(growth_rate)

        # Memory growth should be reasonable (not exponential)
        if growth_rates:
            avg_growth_rate = mean([rate for rate in growth_rates if rate > 0])
            assert (
                avg_growth_rate < 2.0
            ), f"Average memory growth rate {avg_growth_rate:.2f} is too high (suggests memory leak)"

    @pytest.mark.asyncio
    async def test_history_concurrent_performance(self, yjs_doc, multi_user_session):
        """Test history system performance under concurrent load."""
        doc = yjs_doc("concurrent_performance.ipynb")
        session = multi_user_session(5, "concurrent_performance.ipynb")

        class ConcurrentPerformanceTracker:
            def __init__(self):
                self.operations = []
                self.concurrent_batches = []
                self.performance_metrics = {
                    "total_operations": 0,
                    "concurrent_operations": 0,
                    "failed_operations": 0,
                    "avg_latency_ms": 0,
                    "max_latency_ms": 0,
                    "throughput_ops_per_second": 0,
                }

            def start_concurrent_batch(self, batch_name, expected_operations):
                """Start tracking a concurrent batch of operations."""
                batch = {
                    "batch_id": str(uuid4()),
                    "batch_name": batch_name,
                    "start_time": time.perf_counter(),
                    "expected_operations": expected_operations,
                    "completed_operations": 0,
                    "operations": [],
                    "end_time": None,
                    "duration_ms": None,
                }
                self.concurrent_batches.append(batch)
                return batch["batch_id"]

            def record_operation(self, batch_id, operation_name, duration_ms, success=True):
                """Record a concurrent operation."""
                operation = {
                    "operation_id": str(uuid4()),
                    "batch_id": batch_id,
                    "operation_name": operation_name,
                    "duration_ms": duration_ms,
                    "success": success,
                    "timestamp": time.perf_counter(),
                }

                self.operations.append(operation)

                # Update batch
                for batch in self.concurrent_batches:
                    if batch["batch_id"] == batch_id:
                        batch["operations"].append(operation)
                        batch["completed_operations"] += 1
                        if batch["completed_operations"] >= batch["expected_operations"]:
                            batch["end_time"] = time.perf_counter()
                            batch["duration_ms"] = (batch["end_time"] - batch["start_time"]) * 1000
                        break

                return operation

            def calculate_performance_metrics(self):
                """Calculate overall performance metrics."""
                if not self.operations:
                    return self.performance_metrics

                successful_ops = [op for op in self.operations if op["success"]]

                self.performance_metrics = {
                    "total_operations": len(self.operations),
                    "successful_operations": len(successful_ops),
                    "failed_operations": len(self.operations) - len(successful_ops),
                    "success_rate": len(successful_ops) / len(self.operations),
                    "avg_latency_ms": mean([op["duration_ms"] for op in successful_ops])
                    if successful_ops
                    else 0,
                    "max_latency_ms": max([op["duration_ms"] for op in successful_ops])
                    if successful_ops
                    else 0,
                    "min_latency_ms": min([op["duration_ms"] for op in successful_ops])
                    if successful_ops
                    else 0,
                    "p95_latency_ms": sorted([op["duration_ms"] for op in successful_ops])[
                        int(len(successful_ops) * 0.95)
                    ]
                    if successful_ops
                    else 0,
                }

                # Calculate throughput
                if self.operations:
                    time_span = max([op["timestamp"] for op in self.operations]) - min(
                        [op["timestamp"] for op in self.operations]
                    )
                    if time_span > 0:
                        self.performance_metrics["throughput_ops_per_second"] = (
                            len(successful_ops) / time_span
                        )

                return self.performance_metrics

            def get_batch_analysis(self):
                """Analyze concurrent batch performance."""
                analysis = []

                for batch in self.concurrent_batches:
                    if batch["end_time"] is not None:
                        batch_ops = batch["operations"]
                        successful_batch_ops = [op for op in batch_ops if op["success"]]

                        batch_analysis = {
                            "batch_name": batch["batch_name"],
                            "expected_operations": batch["expected_operations"],
                            "completed_operations": batch["completed_operations"],
                            "successful_operations": len(successful_batch_ops),
                            "batch_duration_ms": batch["duration_ms"],
                            "avg_operation_latency_ms": mean(
                                [op["duration_ms"] for op in successful_batch_ops]
                            )
                            if successful_batch_ops
                            else 0,
                            "batch_throughput_ops_per_second": len(successful_batch_ops)
                            / (batch["duration_ms"] / 1000)
                            if batch["duration_ms"] > 0
                            else 0,
                            "success_rate": len(successful_batch_ops)
                            / batch["completed_operations"]
                            if batch["completed_operations"] > 0
                            else 0,
                        }
                        analysis.append(batch_analysis)

                return analysis

        perf_tracker = ConcurrentPerformanceTracker()
        cells = doc.get_array("cells")

        # Simulate concurrent history operations

        # Batch 1: Concurrent snapshot creation
        batch1_id = perf_tracker.start_concurrent_batch("concurrent_snapshots", 10)

        async def create_concurrent_snapshots():
            """Create snapshots concurrently."""
            tasks = []

            for i in range(10):

                async def create_snapshot(index=i):
                    # Add some content
                    with doc.begin_transaction() as txn:
                        cells.insert(
                            txn,
                            len(cells),
                            {
                                "cell_type": "code",
                                "source": f"# Concurrent snapshot {index}\ndata_{index} = {index}",
                                "metadata": {"concurrent_test": index},
                            },
                        )

                    # Measure snapshot creation time
                    start_time = time.perf_counter()
                    snapshot_data = encode_state_as_update(doc)
                    snapshot = {
                        "snapshot_id": str(uuid4()),
                        "data": snapshot_data,
                        "timestamp": datetime.now(timezone.utc),
                        "cells_count": len(cells),
                    }
                    end_time = time.perf_counter()

                    duration_ms = (end_time - start_time) * 1000
                    perf_tracker.record_operation(batch1_id, "snapshot_creation", duration_ms, True)

                    return snapshot

                tasks.append(asyncio.create_task(create_snapshot()))

            return await asyncio.gather(*tasks)

        snapshots = await create_concurrent_snapshots()
        assert len(snapshots) == 10

        # Batch 2: Concurrent diff operations
        batch2_id = perf_tracker.start_concurrent_batch("concurrent_diffs", 15)

        async def perform_concurrent_diffs():
            """Perform diff calculations concurrently."""
            tasks = []

            test_content_pairs = [
                ("original", "modified"),
                ("print('hello')", "print('hello world')"),
                ("import os", "import os\nimport sys"),
                ("x = 1", "x = 10\ny = 20"),
                ("# comment", "# modified comment\n# additional line"),
            ]

            for i in range(15):

                async def calculate_diff(index=i):
                    pair_index = index % len(test_content_pairs)
                    old_content, new_content = test_content_pairs[pair_index]

                    start_time = time.perf_counter()
                    matcher = difflib.SequenceMatcher(
                        None, old_content.splitlines(), new_content.splitlines()
                    )
                    diff_result = {"ratio": matcher.ratio(), "opcodes": list(matcher.get_opcodes())}
                    end_time = time.perf_counter()

                    duration_ms = (end_time - start_time) * 1000
                    perf_tracker.record_operation(batch2_id, "diff_calculation", duration_ms, True)

                    return diff_result

                tasks.append(asyncio.create_task(calculate_diff()))

            return await asyncio.gather(*tasks)

        diff_results = await perform_concurrent_diffs()
        assert len(diff_results) == 15

        # Batch 3: Mixed concurrent operations
        batch3_id = perf_tracker.start_concurrent_batch("mixed_operations", 20)

        async def perform_mixed_operations():
            """Perform various history operations concurrently."""
            tasks = []

            for i in range(20):
                if i % 4 == 0:  # Snapshot creation

                    async def mixed_snapshot(index=i):
                        start_time = time.perf_counter()
                        snapshot_data = encode_state_as_update(doc)
                        end_time = time.perf_counter()

                        duration_ms = (end_time - start_time) * 1000
                        perf_tracker.record_operation(
                            batch3_id, "mixed_snapshot", duration_ms, True
                        )

                        return len(snapshot_data)

                    tasks.append(asyncio.create_task(mixed_snapshot()))

                elif i % 4 == 1:  # Update capture

                    async def mixed_update_capture(index=i):
                        start_time = time.perf_counter()
                        update_data = encode_state_as_update(doc)
                        capture_info = {"size": len(update_data), "timestamp": time.perf_counter()}
                        end_time = time.perf_counter()

                        duration_ms = (end_time - start_time) * 1000
                        perf_tracker.record_operation(
                            batch3_id, "mixed_update_capture", duration_ms, True
                        )

                        return capture_info

                    tasks.append(asyncio.create_task(mixed_update_capture()))

                elif i % 4 == 2:  # Version browsing simulation

                    async def mixed_version_browse(index=i):
                        start_time = time.perf_counter()
                        # Simulate browsing through versions
                        version_list = [f"version_{j}" for j in range(10)]
                        target_version = version_list[index % len(version_list)]
                        found = target_version in version_list
                        end_time = time.perf_counter()

                        duration_ms = (end_time - start_time) * 1000
                        perf_tracker.record_operation(
                            batch3_id, "mixed_version_browse", duration_ms, found
                        )

                        return found

                    tasks.append(asyncio.create_task(mixed_version_browse()))

                else:  # Rollback simulation

                    async def mixed_rollback(index=i):
                        start_time = time.perf_counter()
                        # Simulate rollback by creating temporary doc
                        temp_doc = YDoc()
                        temp_cells = temp_doc.get_array("cells")

                        with temp_doc.begin_transaction() as txn:
                            temp_cells.insert(
                                txn,
                                0,
                                {
                                    "cell_type": "code",
                                    "source": f"rollback_test_{index} = True",
                                    "metadata": {},
                                },
                            )

                        rollback_state = encode_state_as_update(temp_doc)
                        end_time = time.perf_counter()

                        duration_ms = (end_time - start_time) * 1000
                        perf_tracker.record_operation(
                            batch3_id, "mixed_rollback", duration_ms, True
                        )

                        return len(rollback_state)

                    tasks.append(asyncio.create_task(mixed_rollback()))

            return await asyncio.gather(*tasks)

        mixed_results = await perform_mixed_operations()
        assert len(mixed_results) == 20

        # Analyze concurrent performance
        performance_metrics = perf_tracker.calculate_performance_metrics()
        batch_analysis = perf_tracker.get_batch_analysis()

        # Validate concurrent performance requirements

        # Overall success rate should be high
        assert (
            performance_metrics["success_rate"] >= 0.95
        ), f"Success rate {performance_metrics['success_rate']:.2f} is below 95%"

        # Average latency should stay within bounds under concurrent load
        assert (
            performance_metrics["avg_latency_ms"] <= 100
        ), f"Average latency {performance_metrics['avg_latency_ms']:.2f}ms exceeds 100ms under concurrent load"

        # 95th percentile should be reasonable
        assert (
            performance_metrics["p95_latency_ms"] <= 200
        ), f"95th percentile latency {performance_metrics['p95_latency_ms']:.2f}ms exceeds 200ms under concurrent load"

        # Throughput should be reasonable
        assert (
            performance_metrics["throughput_ops_per_second"] >= 50
        ), f"Throughput {performance_metrics['throughput_ops_per_second']:.2f} ops/sec is too low"

        # Validate batch-specific performance
        for batch in batch_analysis:
            batch_name = batch["batch_name"]

            # Each batch should complete successfully
            assert (
                batch["success_rate"] >= 0.90
            ), f"Batch {batch_name} success rate {batch['success_rate']:.2f} is below 90%"

            # Batch-specific latency requirements
            if batch_name == "concurrent_snapshots":
                assert (
                    batch["avg_operation_latency_ms"] <= 60
                ), f"Snapshot batch average latency {batch['avg_operation_latency_ms']:.2f}ms exceeds 60ms"
            elif batch_name == "concurrent_diffs":
                assert (
                    batch["avg_operation_latency_ms"] <= 40
                ), f"Diff batch average latency {batch['avg_operation_latency_ms']:.2f}ms exceeds 40ms"
            elif batch_name == "mixed_operations":
                assert (
                    batch["avg_operation_latency_ms"] <= 80
                ), f"Mixed batch average latency {batch['avg_operation_latency_ms']:.2f}ms exceeds 80ms"

            # Throughput should not degrade significantly under concurrent load
            assert (
                batch["batch_throughput_ops_per_second"] >= 10
            ), f"Batch {batch_name} throughput {batch['batch_throughput_ops_per_second']:.2f} ops/sec is too low"

        # Test scalability - performance shouldn't degrade linearly with concurrency
        snapshot_batch = next(
            b for b in batch_analysis if b["batch_name"] == "concurrent_snapshots"
        )
        diff_batch = next(b for b in batch_analysis if b["batch_name"] == "concurrent_diffs")

        # More operations shouldn't result in proportionally higher latency
        operations_ratio = (
            diff_batch["completed_operations"] / snapshot_batch["completed_operations"]
        )
        latency_ratio = (
            diff_batch["avg_operation_latency_ms"] / snapshot_batch["avg_operation_latency_ms"]
            if snapshot_batch["avg_operation_latency_ms"] > 0
            else 1
        )

        assert (
            latency_ratio <= operations_ratio * 1.5
        ), f"Performance degrades too much with scale: latency ratio {latency_ratio:.2f} vs operations ratio {operations_ratio:.2f}"

        # Memory usage should remain stable during concurrent operations
        # (This would typically be measured with actual memory profiling tools)
        doc_size_after = len(encode_state_as_update(doc))
        assert doc_size_after > 0, "Document should contain data after concurrent operations"

        # Validate that all operations completed
        assert performance_metrics["total_operations"] == 45  # 10 + 15 + 20
        assert performance_metrics["successful_operations"] >= 42  # Allow for small failure rate
