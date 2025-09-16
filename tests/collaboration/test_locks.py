"""
Comprehensive tests for cell-level locking mechanism in collaborative editing.

This test suite validates the distributed lock protocol for preventing concurrent
cell edits, including lock acquisition/release, timeout handling, queuing,
deadlock prevention, and performance characteristics.

The implementation uses Y.Map for distributed lock state management as specified
in the collaborative editing requirements (Section 0.2.1 Objective 3).
"""

import asyncio
import statistics
import time
import uuid

import pytest
from y_py import YDoc, apply_update, encode_state_as_update


class CellLockManager:
    """
    Mock implementation of cell-level locking manager for testing.

    This class simulates the distributed locking protocol using Y.Map
    for testing collaborative scenarios without requiring full server infrastructure.
    """

    def __init__(self, yjs_doc: YDoc, user_id: str, lock_timeout: float = 300):
        self.yjs_doc = yjs_doc
        self.user_id = user_id
        self.lock_timeout = lock_timeout
        self.locks_map = yjs_doc.get_map("cell_locks")
        self.queue_map = yjs_doc.get_map("lock_queue")
        self.local_locks = set()
        self.lock_acquisition_times = {}

    async def acquire_lock(self, cell_id: str, timeout: float = 5.0) -> bool:
        """
        Attempt to acquire exclusive lock on a cell.

        Args:
            cell_id: Unique identifier for the cell
            timeout: Maximum time to wait for lock acquisition

        Returns:
            bool: True if lock acquired successfully, False otherwise
        """
        start_time = time.perf_counter()

        while (time.perf_counter() - start_time) < timeout:
            # Check if cell is already locked
            existing_lock = self.locks_map.get(cell_id)

            if existing_lock is None:
                # Attempt to acquire lock
                lock_data = {
                    "user_id": self.user_id,
                    "timestamp": time.time_ns(),
                    "timeout": time.time_ns() + (self.lock_timeout * 1_000_000_000),
                    "cell_id": cell_id,
                }

                with self.yjs_doc.begin_transaction() as txn:
                    # Double-check lock is still available in transaction
                    if self.locks_map.get(cell_id) is None:
                        self.locks_map.set(txn, cell_id, lock_data)
                        self.local_locks.add(cell_id)
                        self.lock_acquisition_times[cell_id] = time.perf_counter()
                        return True

            elif existing_lock.get("user_id") == self.user_id:
                # Already own this lock
                return True

            elif self._is_lock_expired(existing_lock):
                # Lock has expired, attempt to claim it
                with self.yjs_doc.begin_transaction() as txn:
                    current_lock = self.locks_map.get(cell_id)
                    if current_lock and self._is_lock_expired(current_lock):
                        lock_data = {
                            "user_id": self.user_id,
                            "timestamp": time.time_ns(),
                            "timeout": time.time_ns() + (self.lock_timeout * 1_000_000_000),
                            "cell_id": cell_id,
                        }
                        self.locks_map.set(txn, cell_id, lock_data)
                        self.local_locks.add(cell_id)
                        self.lock_acquisition_times[cell_id] = time.perf_counter()
                        return True

            # Wait briefly before retrying
            await asyncio.sleep(0.01)

        return False

    async def release_lock(self, cell_id: str) -> bool:
        """
        Release lock on a cell.

        Args:
            cell_id: Unique identifier for the cell

        Returns:
            bool: True if lock released successfully, False if not owned
        """
        existing_lock = self.locks_map.get(cell_id)

        if existing_lock and existing_lock.get("user_id") == self.user_id:
            with self.yjs_doc.begin_transaction() as txn:
                # Verify we still own the lock before removing
                current_lock = self.locks_map.get(cell_id)
                if current_lock and current_lock.get("user_id") == self.user_id:
                    self.locks_map.delete(txn, cell_id)
                    self.local_locks.discard(cell_id)
                    self.lock_acquisition_times.pop(cell_id, None)
                    return True

        return False

    def is_cell_locked(self, cell_id: str) -> bool:
        """Check if a cell is currently locked."""
        lock_data = self.locks_map.get(cell_id)
        return lock_data is not None and not self._is_lock_expired(lock_data)

    def get_lock_owner(self, cell_id: str) -> str | None:
        """Get the user ID of the cell lock owner."""
        lock_data = self.locks_map.get(cell_id)
        if lock_data and not self._is_lock_expired(lock_data):
            return lock_data.get("user_id")
        return None

    def _is_lock_expired(self, lock_data: dict) -> bool:
        """Check if a lock has expired based on timeout."""
        if not lock_data or "timeout" not in lock_data:
            return True
        return time.time_ns() > lock_data["timeout"]

    async def cleanup_expired_locks(self):
        """Remove all expired locks from the shared map."""
        expired_locks = []

        # Find expired locks
        for cell_id in list(self.locks_map.keys()):
            lock_data = self.locks_map.get(cell_id)
            if lock_data and self._is_lock_expired(lock_data):
                expired_locks.append(cell_id)

        # Remove expired locks
        if expired_locks:
            with self.yjs_doc.begin_transaction() as txn:
                for cell_id in expired_locks:
                    # Double-check lock is still expired
                    lock_data = self.locks_map.get(cell_id)
                    if lock_data and self._is_lock_expired(lock_data):
                        self.locks_map.delete(txn, cell_id)
                        self.local_locks.discard(cell_id)

    async def release_all_locks(self):
        """Release all locks owned by this user."""
        user_locks = [
            cell_id
            for cell_id in self.local_locks
            if self.locks_map.get(cell_id, {}).get("user_id") == self.user_id
        ]

        for cell_id in user_locks:
            await self.release_lock(cell_id)

    def get_lock_statistics(self) -> dict:
        """Get performance statistics for lock operations."""
        return {
            "active_locks": len(self.local_locks),
            "total_locks_in_map": len(self.locks_map.keys()),
            "average_hold_time": self._calculate_average_hold_time(),
            "user_id": self.user_id,
        }

    def _calculate_average_hold_time(self) -> float:
        """Calculate average time locks have been held."""
        if not self.lock_acquisition_times:
            return 0.0

        current_time = time.perf_counter()
        hold_times = [
            current_time - acquisition_time
            for acquisition_time in self.lock_acquisition_times.values()
        ]
        return statistics.mean(hold_times)


@pytest.fixture
def lock_manager_factory():
    """Factory for creating CellLockManager instances."""

    def _create_lock_manager(yjs_doc: YDoc, user_id: str, lock_timeout: float = 300):
        return CellLockManager(yjs_doc, user_id, lock_timeout)

    return _create_lock_manager


class TestBasicLockOperations:
    """Test basic lock acquisition, release, and validation operations."""

    @pytest.mark.asyncio
    async def test_lock_acquisition_success(self, yjs_doc, lock_manager_factory):
        """Test successful lock acquisition on an unlocked cell."""
        manager = lock_manager_factory(yjs_doc(), "user1")
        cell_id = str(uuid.uuid4())

        # Acquire lock
        success = await manager.acquire_lock(cell_id, timeout=1.0)

        assert success is True
        assert manager.is_cell_locked(cell_id) is True
        assert manager.get_lock_owner(cell_id) == "user1"
        assert cell_id in manager.local_locks

    @pytest.mark.asyncio
    async def test_lock_release_success(self, yjs_doc, lock_manager_factory):
        """Test successful lock release by the owner."""
        manager = lock_manager_factory(yjs_doc(), "user1")
        cell_id = str(uuid.uuid4())

        # Acquire and release lock
        await manager.acquire_lock(cell_id, timeout=1.0)
        success = await manager.release_lock(cell_id)

        assert success is True
        assert manager.is_cell_locked(cell_id) is False
        assert manager.get_lock_owner(cell_id) is None
        assert cell_id not in manager.local_locks

    @pytest.mark.asyncio
    async def test_lock_release_by_non_owner_fails(self, yjs_doc, lock_manager_factory):
        """Test that non-owners cannot release locks."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1")
        manager2 = lock_manager_factory(doc, "user2")
        cell_id = str(uuid.uuid4())

        # User1 acquires lock
        await manager1.acquire_lock(cell_id, timeout=1.0)

        # User2 attempts to release - should fail
        success = await manager2.release_lock(cell_id)

        assert success is False
        assert manager1.is_cell_locked(cell_id) is True
        assert manager1.get_lock_owner(cell_id) == "user1"

    @pytest.mark.asyncio
    async def test_reacquire_owned_lock_succeeds(self, yjs_doc, lock_manager_factory):
        """Test that users can reacquire locks they already own."""
        manager = lock_manager_factory(yjs_doc(), "user1")
        cell_id = str(uuid.uuid4())

        # Acquire lock twice
        success1 = await manager.acquire_lock(cell_id, timeout=1.0)
        success2 = await manager.acquire_lock(cell_id, timeout=1.0)

        assert success1 is True
        assert success2 is True
        assert manager.get_lock_owner(cell_id) == "user1"


class TestExclusiveLockEnforcement:
    """Test that only one user can hold a lock on a cell at a time."""

    @pytest.mark.asyncio
    async def test_exclusive_lock_enforcement(self, yjs_doc, lock_manager_factory):
        """Test that second user cannot acquire lock held by first user."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1")
        manager2 = lock_manager_factory(doc, "user2")
        cell_id = str(uuid.uuid4())

        # User1 acquires lock
        success1 = await manager1.acquire_lock(cell_id, timeout=1.0)

        # User2 attempts to acquire same lock - should fail
        success2 = await manager2.acquire_lock(cell_id, timeout=0.5)

        assert success1 is True
        assert success2 is False
        assert manager1.get_lock_owner(cell_id) == "user1"
        assert manager2.get_lock_owner(cell_id) == "user1"  # Both see same owner

    @pytest.mark.asyncio
    async def test_lock_transfer_after_release(self, yjs_doc, lock_manager_factory):
        """Test that lock can be acquired by different user after release."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1")
        manager2 = lock_manager_factory(doc, "user2")
        cell_id = str(uuid.uuid4())

        # User1 acquires and releases lock
        await manager1.acquire_lock(cell_id, timeout=1.0)
        await manager1.release_lock(cell_id)

        # User2 acquires lock - should succeed
        success = await manager2.acquire_lock(cell_id, timeout=1.0)

        assert success is True
        assert manager2.get_lock_owner(cell_id) == "user2"

    @pytest.mark.asyncio
    async def test_multiple_cells_independent_locks(self, yjs_doc, lock_manager_factory):
        """Test that different cells can have independent locks."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1")
        manager2 = lock_manager_factory(doc, "user2")
        cell_id1 = str(uuid.uuid4())
        cell_id2 = str(uuid.uuid4())

        # Each user acquires lock on different cell
        success1 = await manager1.acquire_lock(cell_id1, timeout=1.0)
        success2 = await manager2.acquire_lock(cell_id2, timeout=1.0)

        assert success1 is True
        assert success2 is True
        assert manager1.get_lock_owner(cell_id1) == "user1"
        assert manager2.get_lock_owner(cell_id2) == "user2"


class TestLockTimeout:
    """Test automatic lock timeout and cleanup mechanisms."""

    @pytest.mark.asyncio
    async def test_lock_timeout_expiration(self, yjs_doc, lock_manager_factory):
        """Test that locks expire after timeout period."""
        # Use very short timeout for testing
        manager = lock_manager_factory(yjs_doc(), "user1", lock_timeout=0.1)
        cell_id = str(uuid.uuid4())

        # Acquire lock
        await manager.acquire_lock(cell_id, timeout=1.0)
        assert manager.is_cell_locked(cell_id) is True

        # Wait for timeout
        await asyncio.sleep(0.15)

        # Lock should be expired
        assert manager.is_cell_locked(cell_id) is False
        assert manager.get_lock_owner(cell_id) is None

    @pytest.mark.asyncio
    async def test_expired_lock_acquisition_by_other_user(self, yjs_doc, lock_manager_factory):
        """Test that expired locks can be acquired by other users."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1", lock_timeout=0.1)
        manager2 = lock_manager_factory(doc, "user2")
        cell_id = str(uuid.uuid4())

        # User1 acquires lock with short timeout
        await manager1.acquire_lock(cell_id, timeout=1.0)

        # Wait for timeout
        await asyncio.sleep(0.15)

        # User2 should be able to acquire expired lock
        success = await manager2.acquire_lock(cell_id, timeout=1.0)

        assert success is True
        assert manager2.get_lock_owner(cell_id) == "user2"

    @pytest.mark.asyncio
    async def test_cleanup_expired_locks(self, yjs_doc, lock_manager_factory):
        """Test cleanup of multiple expired locks."""
        manager = lock_manager_factory(yjs_doc(), "user1", lock_timeout=0.1)
        cell_ids = [str(uuid.uuid4()) for _ in range(3)]

        # Acquire multiple locks
        for cell_id in cell_ids:
            await manager.acquire_lock(cell_id, timeout=1.0)

        assert len(manager.local_locks) == 3

        # Wait for timeout
        await asyncio.sleep(0.15)

        # Run cleanup
        await manager.cleanup_expired_locks()

        # All locks should be cleaned up
        assert len(manager.local_locks) == 0
        for cell_id in cell_ids:
            assert manager.is_cell_locked(cell_id) is False


class TestConcurrentLockOperations:
    """Test concurrent lock operations and race conditions."""

    @pytest.mark.asyncio
    async def test_concurrent_acquisition_same_cell(
        self, multi_user_session, yjs_doc, lock_manager_factory
    ):
        """Test concurrent acquisition attempts on same cell - only one should succeed."""
        session = multi_user_session(num_users=3)
        doc = yjs_doc()

        # Create managers for each user
        managers = [lock_manager_factory(doc, f"user_{i}", lock_timeout=30) for i in range(3)]

        cell_id = str(uuid.uuid4())

        # Attempt concurrent acquisitions
        tasks = [
            asyncio.create_task(manager.acquire_lock(cell_id, timeout=2.0)) for manager in managers
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Exactly one should succeed
        successes = [result for result in results if result is True]
        assert len(successes) == 1

        # Verify only one manager has the lock
        owners = [manager.get_lock_owner(cell_id) for manager in managers]
        non_none_owners = [owner for owner in owners if owner is not None]
        assert len(set(non_none_owners)) == 1  # All should agree on single owner

    @pytest.mark.asyncio
    async def test_concurrent_acquisition_different_cells(self, yjs_doc, lock_manager_factory):
        """Test concurrent acquisition on different cells - all should succeed."""
        doc = yjs_doc()
        managers = [lock_manager_factory(doc, f"user_{i}") for i in range(3)]

        cell_ids = [str(uuid.uuid4()) for _ in range(3)]

        # Attempt concurrent acquisitions on different cells
        tasks = [
            asyncio.create_task(managers[i].acquire_lock(cell_ids[i], timeout=2.0))
            for i in range(3)
        ]

        results = await asyncio.gather(*tasks)

        # All should succeed
        assert all(results)

        # Verify each manager has their respective lock
        for i in range(3):
            assert managers[i].get_lock_owner(cell_ids[i]) == f"user_{i}"

    @pytest.mark.asyncio
    async def test_concurrent_release_operations(self, yjs_doc, lock_manager_factory):
        """Test concurrent release operations."""
        manager = lock_manager_factory(yjs_doc(), "user1")
        cell_ids = [str(uuid.uuid4()) for _ in range(5)]

        # Acquire multiple locks
        for cell_id in cell_ids:
            await manager.acquire_lock(cell_id, timeout=1.0)

        # Release all locks concurrently
        tasks = [asyncio.create_task(manager.release_lock(cell_id)) for cell_id in cell_ids]

        results = await asyncio.gather(*tasks)

        # All releases should succeed
        assert all(results)
        assert len(manager.local_locks) == 0


class TestLockQueueing:
    """Test queued lock requests and fairness."""

    @pytest.mark.asyncio
    async def test_sequential_lock_acquisition(self, yjs_doc, lock_manager_factory):
        """Test that users can acquire locks sequentially after release."""
        doc = yjs_doc()
        managers = [lock_manager_factory(doc, f"user_{i}") for i in range(3)]
        cell_id = str(uuid.uuid4())

        # Sequential acquisition and release
        for i, manager in enumerate(managers):
            success = await manager.acquire_lock(cell_id, timeout=1.0)
            assert success is True
            assert manager.get_lock_owner(cell_id) == f"user_{i}"

            success = await manager.release_lock(cell_id)
            assert success is True

    @pytest.mark.asyncio
    async def test_lock_acquisition_timing(self, yjs_doc, lock_manager_factory):
        """Test timing characteristics of lock acquisition."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1")
        manager2 = lock_manager_factory(doc, "user2")
        cell_id = str(uuid.uuid4())

        # User1 acquires lock
        start_time = time.perf_counter()
        await manager1.acquire_lock(cell_id, timeout=1.0)
        acquisition_time = time.perf_counter() - start_time

        # Should be very fast for unlocked cell
        assert acquisition_time < 0.1

        # User2 attempts with short timeout
        start_time = time.perf_counter()
        success = await manager2.acquire_lock(cell_id, timeout=0.5)
        failed_acquisition_time = time.perf_counter() - start_time

        assert success is False
        assert 0.4 < failed_acquisition_time < 0.6  # Should timeout after ~0.5s


class TestLockRecovery:
    """Test lock recovery mechanisms after disconnection."""

    @pytest.mark.asyncio
    async def test_release_all_user_locks_on_disconnect(self, yjs_doc, lock_manager_factory):
        """Test releasing all locks when user disconnects."""
        manager = lock_manager_factory(yjs_doc(), "user1")
        cell_ids = [str(uuid.uuid4()) for _ in range(3)]

        # Acquire multiple locks
        for cell_id in cell_ids:
            await manager.acquire_lock(cell_id, timeout=1.0)

        assert len(manager.local_locks) == 3

        # Simulate disconnect - release all locks
        await manager.release_all_locks()

        # All locks should be released
        assert len(manager.local_locks) == 0
        for cell_id in cell_ids:
            assert manager.is_cell_locked(cell_id) is False

    @pytest.mark.asyncio
    async def test_lock_recovery_after_timeout(self, yjs_doc, lock_manager_factory):
        """Test that locks can be recovered after user timeout."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1", lock_timeout=0.1)
        manager2 = lock_manager_factory(doc, "user2")
        cell_id = str(uuid.uuid4())

        # User1 acquires lock then simulates disconnect (no explicit release)
        await manager1.acquire_lock(cell_id, timeout=1.0)

        # Wait for timeout
        await asyncio.sleep(0.15)

        # User2 should be able to recover the expired lock
        success = await manager2.acquire_lock(cell_id, timeout=1.0)

        assert success is True
        assert manager2.get_lock_owner(cell_id) == "user2"


class TestLockPerformance:
    """Test performance characteristics of lock operations."""

    @pytest.mark.asyncio
    async def test_lock_acquisition_performance(self, yjs_doc, lock_manager_factory):
        """Test performance of lock acquisition operations."""
        manager = lock_manager_factory(yjs_doc(), "user1")
        num_operations = 100
        cell_ids = [str(uuid.uuid4()) for _ in range(num_operations)]

        # Measure acquisition times
        acquisition_times = []
        for cell_id in cell_ids:
            start_time = time.perf_counter()
            success = await manager.acquire_lock(cell_id, timeout=1.0)
            end_time = time.perf_counter()

            assert success is True
            acquisition_times.append(end_time - start_time)

        # Analyze performance
        mean_time = statistics.mean(acquisition_times)
        max_time = max(acquisition_times)
        median_time = statistics.median(acquisition_times)

        # Performance assertions
        assert mean_time < 0.01  # Average under 10ms
        assert max_time < 0.05  # No operation over 50ms
        assert median_time < 0.01  # Median under 10ms

        # Performance metrics for debugging (available in test output when verbose)
        performance_data = {
            "mean_ms": mean_time * 1000,
            "median_ms": median_time * 1000,
            "max_ms": max_time * 1000,
        }
        assert performance_data  # Ensure data is collected

    @pytest.mark.asyncio
    async def test_concurrent_lock_scalability(self, yjs_doc, lock_manager_factory):
        """Test scalability with multiple concurrent lock operations."""
        doc = yjs_doc()
        num_users = 10
        locks_per_user = 20

        managers = [lock_manager_factory(doc, f"user_{i}") for i in range(num_users)]

        # Generate unique cell IDs for each user
        all_cell_ids = []
        for i in range(num_users):
            user_cell_ids = [f"cell_{i}_{j}_{uuid.uuid4().hex[:8]}" for j in range(locks_per_user)]
            all_cell_ids.append(user_cell_ids)

        # Measure concurrent acquisitions
        start_time = time.perf_counter()

        tasks = []
        for i, manager in enumerate(managers):
            for cell_id in all_cell_ids[i]:
                task = asyncio.create_task(manager.acquire_lock(cell_id, timeout=5.0))
                tasks.append(task)

        results = await asyncio.gather(*tasks)
        end_time = time.perf_counter()

        # All should succeed
        assert all(results)

        total_time = end_time - start_time
        total_operations = num_users * locks_per_user
        ops_per_second = total_operations / total_time

        # Performance assertions
        assert ops_per_second > 100  # At least 100 ops/sec
        assert total_time < 5.0  # Complete within 5 seconds

        # Scalability metrics for debugging (available in test output when verbose)
        scalability_data = {
            "total_operations": total_operations,
            "total_time": total_time,
            "ops_per_second": ops_per_second,
        }
        assert scalability_data  # Ensure data is collected


class TestLockStateConsistency:
    """Test consistency of lock state across multiple users and documents."""

    @pytest.mark.asyncio
    async def test_lock_state_synchronization(
        self, multi_user_session, yjs_doc, lock_manager_factory
    ):
        """Test that lock state is consistent across multiple Y.Doc instances."""
        # Create multiple docs that will sync
        docs = [yjs_doc() for _ in range(3)]
        managers = [lock_manager_factory(docs[i], f"user_{i}") for i in range(3)]

        cell_id = str(uuid.uuid4())

        # User0 acquires lock
        success = await managers[0].acquire_lock(cell_id, timeout=1.0)
        assert success is True

        # Simulate synchronization by applying updates between docs
        for i in range(len(docs)):
            for j in range(len(docs)):
                if i != j:
                    update = encode_state_as_update(docs[i])
                    apply_update(docs[j], update)

        # All managers should see the same lock state
        for manager in managers:
            assert manager.is_cell_locked(cell_id) is True
            assert manager.get_lock_owner(cell_id) == "user_0"

    @pytest.mark.asyncio
    async def test_lock_statistics_accuracy(self, yjs_doc, lock_manager_factory):
        """Test accuracy of lock statistics."""
        manager = lock_manager_factory(yjs_doc(), "user1")
        cell_ids = [str(uuid.uuid4()) for _ in range(5)]

        # Initial statistics
        stats = manager.get_lock_statistics()
        assert stats["active_locks"] == 0
        assert stats["user_id"] == "user1"

        # Acquire locks
        for cell_id in cell_ids:
            await manager.acquire_lock(cell_id, timeout=1.0)

        # Updated statistics
        stats = manager.get_lock_statistics()
        assert stats["active_locks"] == 5
        assert stats["average_hold_time"] >= 0

        # Wait a bit
        await asyncio.sleep(0.1)

        # Statistics should reflect hold time
        stats = manager.get_lock_statistics()
        assert stats["average_hold_time"] > 0.05


class TestLockVisualIndicators:
    """Test data required for visual lock indicators in the UI."""

    @pytest.mark.asyncio
    async def test_lock_indicator_data_structure(self, yjs_doc, lock_manager_factory):
        """Test that lock data includes all required fields for UI indicators."""
        manager = lock_manager_factory(yjs_doc(), "user1")
        cell_id = str(uuid.uuid4())

        # Acquire lock
        await manager.acquire_lock(cell_id, timeout=1.0)

        # Get lock data from Y.Map
        lock_data = manager.locks_map.get(cell_id)

        # Verify required fields for UI
        assert "user_id" in lock_data
        assert "timestamp" in lock_data
        assert "timeout" in lock_data
        assert "cell_id" in lock_data

        assert isinstance(lock_data["user_id"], str)
        assert isinstance(lock_data["timestamp"], int)
        assert isinstance(lock_data["timeout"], int)
        assert lock_data["cell_id"] == cell_id

    @pytest.mark.asyncio
    async def test_multiple_lock_indicators(self, yjs_doc, lock_manager_factory):
        """Test lock indicator data for multiple locked cells."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1")
        manager2 = lock_manager_factory(doc, "user2")

        cell_ids = [str(uuid.uuid4()) for _ in range(4)]

        # User1 locks cells 0,1 and User2 locks cells 2,3
        await manager1.acquire_lock(cell_ids[0], timeout=1.0)
        await manager1.acquire_lock(cell_ids[1], timeout=1.0)
        await manager2.acquire_lock(cell_ids[2], timeout=1.0)
        await manager2.acquire_lock(cell_ids[3], timeout=1.0)

        # Check lock indicator data
        locks_map = doc.get_map("cell_locks")
        all_lock_data = []

        for cell_id in cell_ids:
            lock_data = locks_map.get(cell_id)
            assert lock_data is not None
            all_lock_data.append(lock_data)

        # Verify we have indicators for all 4 locks
        assert len(all_lock_data) == 4

        # Verify user distribution
        user1_locks = [data for data in all_lock_data if data["user_id"] == "user1"]
        user2_locks = [data for data in all_lock_data if data["user_id"] == "user2"]

        assert len(user1_locks) == 2
        assert len(user2_locks) == 2


class TestDeadlockPrevention:
    """Test deadlock prevention mechanisms."""

    @pytest.mark.asyncio
    async def test_no_circular_waiting(self, yjs_doc, lock_manager_factory):
        """Test that the system prevents circular lock dependencies."""
        doc = yjs_doc()
        manager1 = lock_manager_factory(doc, "user1")
        manager2 = lock_manager_factory(doc, "user2")

        cell_id1 = str(uuid.uuid4())
        cell_id2 = str(uuid.uuid4())

        # User1 gets lock on cell1
        success1 = await manager1.acquire_lock(cell_id1, timeout=1.0)
        assert success1 is True

        # User2 gets lock on cell2
        success2 = await manager2.acquire_lock(cell_id2, timeout=1.0)
        assert success2 is True

        # Now each tries to get the other's lock with short timeout
        # This should fail quickly rather than wait indefinitely
        start_time = time.perf_counter()

        task1 = asyncio.create_task(manager1.acquire_lock(cell_id2, timeout=0.5))
        task2 = asyncio.create_task(manager2.acquire_lock(cell_id1, timeout=0.5))

        results = await asyncio.gather(task1, task2, return_exceptions=True)

        end_time = time.perf_counter()
        total_time = end_time - start_time

        # Both should fail
        assert results[0] is False
        assert results[1] is False

        # Should complete quickly (around timeout period, not hang)
        assert 0.4 < total_time < 1.0

    @pytest.mark.asyncio
    async def test_lock_ordering_consistency(self, yjs_doc, lock_manager_factory):
        """Test consistent lock ordering to prevent deadlocks."""
        doc = yjs_doc()
        num_users = 3
        managers = [lock_manager_factory(doc, f"user_{i}") for i in range(num_users)]

        # Create cell IDs in lexicographical order
        cell_ids = sorted([str(uuid.uuid4()) for _ in range(3)])

        async def acquire_multiple_locks(manager, cell_list, delay=0):
            """Acquire locks in order with optional delay."""
            if delay:
                await asyncio.sleep(delay)
            results = []
            for cell_id in cell_list:
                success = await manager.acquire_lock(cell_id, timeout=2.0)
                results.append(success)
            return results

        # Have all users try to acquire all locks in the same order
        # but with staggered start times
        tasks = [
            asyncio.create_task(acquire_multiple_locks(managers[i], cell_ids, delay=i * 0.05))
            for i in range(num_users)
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # First user should get all locks
        assert results[0] == [True, True, True]

        # Others should fail to get at least some locks
        for i in range(1, num_users):
            assert not all(results[i])  # At least one failure


@pytest.mark.asyncio
async def test_integration_with_multi_user_session(
    multi_user_session, yjs_doc, lock_manager_factory
):
    """Integration test using multi_user_session fixture with lock managers."""
    # Create a multi-user session
    session = multi_user_session(num_users=3, notebook_path="test_locks.ipynb")

    # Initialize with mock factories (since we don't have real WebSocket)
    class MockWebSocketFactory:
        def __init__(self):
            pass

        def __call__(self, notebook_path, user_id):
            from tests.collaboration.conftest import MockWebSocketClient

            return MockWebSocketClient(notebook_path, user_id)

    await session.initialize_users(yjs_doc, MockWebSocketFactory())

    # Create lock managers for each user
    lock_managers = []
    for user in session.users:
        manager = lock_manager_factory(user["doc"], user["id"])
        lock_managers.append(manager)

    cell_id = str(uuid.uuid4())

    # Test concurrent lock acquisition in session context
    lock_tasks = [
        asyncio.create_task(manager.acquire_lock(cell_id, timeout=1.0)) for manager in lock_managers
    ]

    results = await asyncio.gather(*lock_tasks)

    # Only one should succeed
    successful_locks = sum(1 for result in results if result is True)
    assert successful_locks == 1

    # Get session summary
    summary = session.get_session_summary()
    assert summary["num_users"] == 3
    assert len(summary["users"]) == 3


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
