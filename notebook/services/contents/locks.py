"""Cell-level locking service for collaborative editing.

This module provides distributed lock management for Jupyter Notebook cells to prevent
conflicting simultaneous edits during collaborative editing sessions. It implements
lock acquisition, release, timeout handling, and conflict resolution mechanisms using
Yjs shared types for real-time synchronization across clients.

The service integrates with the collaborative editing system to ensure data consistency
and prevent race conditions when multiple users edit the same notebook simultaneously.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple, Union
from enum import Enum
from weakref import WeakValueDictionary

from tornado.locks import Condition


class LockState(Enum):
    """Lock state enumeration."""
    UNLOCKED = "unlocked"
    LOCKED = "locked"
    EXPIRED = "expired"
    PENDING = "pending"
    FORCE_RELEASED = "force_released"


class LockType(Enum):
    """Lock type enumeration."""
    EDIT = "edit"           # Exclusive edit lock
    READ = "read"           # Shared read lock (future use)
    EXECUTE = "execute"     # Cell execution lock


@dataclass
class CellLock:
    """Represents a lock on a notebook cell."""
    
    cell_id: str
    user_id: str
    session_id: str
    lock_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    lock_type: LockType = LockType.EDIT
    state: LockState = LockState.LOCKED
    acquired_at: float = field(default_factory=time.time)
    expires_at: float = field(default=0.0)
    last_heartbeat: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        """Initialize computed fields after dataclass creation."""
        if self.expires_at == 0.0:
            # Default timeout: 5 minutes for edit locks, 30 seconds for execute locks
            default_timeout = 300 if self.lock_type == LockType.EDIT else 30
            self.expires_at = self.acquired_at + default_timeout
    
    def is_expired(self, current_time: Optional[float] = None) -> bool:
        """Check if lock has expired."""
        if current_time is None:
            current_time = time.time()
        return current_time >= self.expires_at
    
    def is_owned_by(self, user_id: str, session_id: Optional[str] = None) -> bool:
        """Check if lock is owned by the specified user/session."""
        if self.user_id != user_id:
            return False
        if session_id is not None and self.session_id != session_id:
            return False
        return True
    
    def extend_timeout(self, extension_seconds: float = 300) -> None:
        """Extend lock timeout."""
        current_time = time.time()
        self.expires_at = max(self.expires_at, current_time) + extension_seconds
        self.last_heartbeat = current_time
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert lock to dictionary for serialization."""
        return {
            "cell_id": self.cell_id,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "lock_id": self.lock_id,
            "lock_type": self.lock_type.value,
            "state": self.state.value,
            "acquired_at": self.acquired_at,
            "expires_at": self.expires_at,
            "last_heartbeat": self.last_heartbeat,
            "metadata": self.metadata
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> CellLock:
        """Create lock from dictionary."""
        return cls(
            cell_id=data["cell_id"],
            user_id=data["user_id"],
            session_id=data["session_id"],
            lock_id=data.get("lock_id", str(uuid.uuid4())),
            lock_type=LockType(data.get("lock_type", LockType.EDIT.value)),
            state=LockState(data.get("state", LockState.LOCKED.value)),
            acquired_at=data.get("acquired_at", time.time()),
            expires_at=data.get("expires_at", 0.0),
            last_heartbeat=data.get("last_heartbeat", time.time()),
            metadata=data.get("metadata", {})
        )


class LockError(Exception):
    """Base class for lock-related errors."""
    pass


class LockAcquisitionError(LockError):
    """Raised when lock acquisition fails."""
    pass


class LockNotFoundError(LockError):
    """Raised when attempting to operate on non-existent lock."""
    pass


class LockPermissionError(LockError):
    """Raised when user lacks permission for lock operation."""
    pass


class DeadlockError(LockError):
    """Raised when a deadlock is detected."""
    pass


class LockRegistry:
    """Thread-safe registry for managing cell locks."""
    
    def __init__(self):
        self._locks: Dict[str, CellLock] = {}  # cell_id -> lock
        self._user_locks: Dict[str, Set[str]] = {}  # user_id -> set of cell_ids
        self._session_locks: Dict[str, Set[str]] = {}  # session_id -> set of cell_ids
        self._pending_locks: Dict[str, List[Tuple[str, str, asyncio.Future]]] = {}  # cell_id -> list of (user_id, session_id, future)
        self._lock = asyncio.Lock()
        self._conditions: Dict[str, Condition] = {}  # cell_id -> condition for waiting
        self.logger = logging.getLogger(__name__)
    
    async def add_lock(self, lock: CellLock) -> None:
        """Add a lock to the registry."""
        async with self._lock:
            self._locks[lock.cell_id] = lock
            
            # Track by user
            if lock.user_id not in self._user_locks:
                self._user_locks[lock.user_id] = set()
            self._user_locks[lock.user_id].add(lock.cell_id)
            
            # Track by session
            if lock.session_id not in self._session_locks:
                self._session_locks[lock.session_id] = set()
            self._session_locks[lock.session_id].add(lock.cell_id)
            
            self.logger.debug(f"Added lock {lock.lock_id} for cell {lock.cell_id} by user {lock.user_id}")
    
    async def remove_lock(self, cell_id: str) -> Optional[CellLock]:
        """Remove a lock from the registry."""
        async with self._lock:
            lock = self._locks.pop(cell_id, None)
            if lock:
                # Remove from user tracking
                if lock.user_id in self._user_locks:
                    self._user_locks[lock.user_id].discard(cell_id)
                    if not self._user_locks[lock.user_id]:
                        del self._user_locks[lock.user_id]
                
                # Remove from session tracking
                if lock.session_id in self._session_locks:
                    self._session_locks[lock.session_id].discard(cell_id)
                    if not self._session_locks[lock.session_id]:
                        del self._session_locks[lock.session_id]
                
                # Notify waiting tasks
                if cell_id in self._conditions:
                    self._conditions[cell_id].notify_all()
                
                self.logger.debug(f"Removed lock {lock.lock_id} for cell {cell_id}")
            
            return lock
    
    async def get_lock(self, cell_id: str) -> Optional[CellLock]:
        """Get lock for a cell."""
        async with self._lock:
            return self._locks.get(cell_id)
    
    async def get_user_locks(self, user_id: str) -> List[CellLock]:
        """Get all locks owned by a user."""
        async with self._lock:
            cell_ids = self._user_locks.get(user_id, set())
            return [self._locks[cell_id] for cell_id in cell_ids if cell_id in self._locks]
    
    async def get_session_locks(self, session_id: str) -> List[CellLock]:
        """Get all locks owned by a session."""
        async with self._lock:
            cell_ids = self._session_locks.get(session_id, set())
            return [self._locks[cell_id] for cell_id in cell_ids if cell_id in self._locks]
    
    async def get_all_locks(self) -> List[CellLock]:
        """Get all active locks."""
        async with self._lock:
            return list(self._locks.values())
    
    async def cleanup_expired_locks(self, current_time: Optional[float] = None) -> List[CellLock]:
        """Remove expired locks and return them."""
        if current_time is None:
            current_time = time.time()
        
        expired_locks = []
        
        # Find expired locks (read-only operation)
        async with self._lock:
            expired_cell_ids = [
                cell_id for cell_id, lock in self._locks.items()
                if lock.is_expired(current_time)
            ]
        
        # Remove expired locks
        for cell_id in expired_cell_ids:
            lock = await self.remove_lock(cell_id)
            if lock:
                lock.state = LockState.EXPIRED
                expired_locks.append(lock)
        
        if expired_locks:
            self.logger.info(f"Cleaned up {len(expired_locks)} expired locks")
        
        return expired_locks
    
    async def add_pending_lock(self, cell_id: str, user_id: str, session_id: str) -> asyncio.Future:
        """Add a pending lock request."""
        async with self._lock:
            if cell_id not in self._pending_locks:
                self._pending_locks[cell_id] = []
            
            future = asyncio.Future()
            self._pending_locks[cell_id].append((user_id, session_id, future))
            
            # Create condition for waiting if not exists
            if cell_id not in self._conditions:
                self._conditions[cell_id] = Condition()
            
            self.logger.debug(f"Added pending lock request for cell {cell_id} by user {user_id}")
            return future
    
    async def process_pending_locks(self, cell_id: str) -> None:
        """Process pending lock requests for a cell."""
        async with self._lock:
            if cell_id not in self._pending_locks:
                return
            
            pending = self._pending_locks.pop(cell_id, [])
            
            # Notify the first pending request if cell is now free
            if pending and cell_id not in self._locks:
                user_id, session_id, future = pending[0]
                if not future.done():
                    future.set_result(True)
                
                # Re-add remaining pending requests
                if len(pending) > 1:
                    self._pending_locks[cell_id] = pending[1:]
                
                self.logger.debug(f"Granted pending lock for cell {cell_id} to user {user_id}")


class CellLockManager:
    """Manages cell-level locking for collaborative editing."""
    
    def __init__(self, 
                 default_timeout: float = 300,  # 5 minutes
                 max_locks_per_user: int = 50,
                 cleanup_interval: float = 60,   # 1 minute
                 deadlock_timeout: float = 30):  # 30 seconds
        """Initialize the lock manager.
        
        Args:
            default_timeout: Default lock timeout in seconds
            max_locks_per_user: Maximum number of locks per user
            cleanup_interval: Cleanup interval in seconds
            deadlock_timeout: Deadlock detection timeout in seconds
        """
        self.default_timeout = default_timeout
        self.max_locks_per_user = max_locks_per_user
        self.cleanup_interval = cleanup_interval
        self.deadlock_timeout = deadlock_timeout
        
        self.registry = LockRegistry()
        self.logger = logging.getLogger(__name__)
        
        # Cleanup task management
        self._cleanup_task: Optional[asyncio.Task] = None
        self._shutdown_event = asyncio.Event()
        
        # Statistics and monitoring
        self._stats = {
            "locks_acquired": 0,
            "locks_released": 0,
            "locks_expired": 0,
            "locks_force_released": 0,
            "deadlocks_detected": 0,
            "conflicts_resolved": 0
        }
        
        # Weak reference to document managers for integration
        self._document_managers: WeakValueDictionary = WeakValueDictionary()
    
    def start_cleanup_task(self) -> None:
        """Start the cleanup task."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            self.logger.info("Started lock cleanup task")
    
    async def stop_cleanup_task(self) -> None:
        """Stop the cleanup task."""
        self._shutdown_event.set()
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        self.logger.info("Stopped lock cleanup task")
    
    async def _cleanup_loop(self) -> None:
        """Main cleanup loop."""
        while not self._shutdown_event.is_set():
            try:
                await asyncio.wait_for(
                    self._shutdown_event.wait(),
                    timeout=self.cleanup_interval
                )
                break  # Shutdown requested
            except asyncio.TimeoutError:
                # Perform cleanup
                await self._cleanup_expired_locks()
    
    async def _cleanup_expired_locks(self) -> None:
        """Clean up expired locks."""
        try:
            expired_locks = await self.registry.cleanup_expired_locks()
            
            if expired_locks:
                self._stats["locks_expired"] += len(expired_locks)
                
                # Process pending locks for released cells
                for lock in expired_locks:
                    await self.registry.process_pending_locks(lock.cell_id)
                    
                    # Notify document managers if available
                    await self._notify_lock_released(lock, expired=True)
                
                self.logger.info(f"Cleaned up {len(expired_locks)} expired locks")
        
        except Exception as e:
            self.logger.error(f"Error during lock cleanup: {e}")
    
    async def acquire_lock(self,
                          cell_id: str,
                          user_id: str,
                          session_id: str,
                          lock_type: LockType = LockType.EDIT,
                          timeout_seconds: Optional[float] = None,
                          wait: bool = True,
                          metadata: Optional[Dict[str, Any]] = None) -> CellLock:
        """Acquire a lock on a cell.
        
        Args:
            cell_id: ID of the cell to lock
            user_id: ID of the user requesting the lock
            session_id: ID of the user's session
            lock_type: Type of lock to acquire
            timeout_seconds: Lock timeout in seconds (uses default if None)
            wait: Whether to wait for lock if cell is already locked
            metadata: Additional metadata to store with the lock
            
        Returns:
            CellLock object representing the acquired lock
            
        Raises:
            LockAcquisitionError: If lock cannot be acquired
            DeadlockError: If deadlock is detected
        """
        if timeout_seconds is None:
            timeout_seconds = self.default_timeout
        
        if metadata is None:
            metadata = {}
        
        # Check user lock limits
        user_locks = await self.registry.get_user_locks(user_id)
        if len(user_locks) >= self.max_locks_per_user:
            raise LockAcquisitionError(
                f"User {user_id} has reached maximum lock limit ({self.max_locks_per_user})"
            )
        
        # Check for deadlock potential
        await self._check_deadlock_potential(cell_id, user_id, session_id)
        
        # Try to acquire lock immediately
        existing_lock = await self.registry.get_lock(cell_id)
        
        if existing_lock is None:
            # Cell is free, acquire lock
            return await self._create_and_register_lock(
                cell_id, user_id, session_id, lock_type, timeout_seconds, metadata
            )
        
        # Check if user already owns the lock
        if existing_lock.is_owned_by(user_id, session_id):
            # Extend existing lock
            existing_lock.extend_timeout(timeout_seconds)
            await self._notify_lock_extended(existing_lock)
            self.logger.debug(f"Extended existing lock {existing_lock.lock_id} for cell {cell_id}")
            return existing_lock
        
        # Cell is locked by another user
        if not wait:
            raise LockAcquisitionError(
                f"Cell {cell_id} is locked by user {existing_lock.user_id}"
            )
        
        # Wait for lock to become available
        return await self._wait_for_lock(
            cell_id, user_id, session_id, lock_type, timeout_seconds, metadata
        )
    
    async def _create_and_register_lock(self,
                                       cell_id: str,
                                       user_id: str,
                                       session_id: str,
                                       lock_type: LockType,
                                       timeout_seconds: float,
                                       metadata: Dict[str, Any]) -> CellLock:
        """Create and register a new lock."""
        lock = CellLock(
            cell_id=cell_id,
            user_id=user_id,
            session_id=session_id,
            lock_type=lock_type,
            state=LockState.LOCKED,
            expires_at=time.time() + timeout_seconds,
            metadata=metadata
        )
        
        await self.registry.add_lock(lock)
        await self._notify_lock_acquired(lock)
        
        self._stats["locks_acquired"] += 1
        self.logger.info(f"Acquired lock {lock.lock_id} for cell {cell_id} by user {user_id}")
        
        return lock
    
    async def _wait_for_lock(self,
                            cell_id: str,
                            user_id: str,
                            session_id: str,
                            lock_type: LockType,
                            timeout_seconds: float,
                            metadata: Dict[str, Any]) -> CellLock:
        """Wait for a lock to become available."""
        # Add to pending locks
        future = await self.registry.add_pending_lock(cell_id, user_id, session_id)
        
        try:
            # Wait for lock with deadlock timeout
            await asyncio.wait_for(future, timeout=self.deadlock_timeout)
            
            # Try to acquire lock again
            return await self._create_and_register_lock(
                cell_id, user_id, session_id, lock_type, timeout_seconds, metadata
            )
        
        except asyncio.TimeoutError:
            raise DeadlockError(
                f"Deadlock detected: timeout waiting for lock on cell {cell_id}"
            )
    
    async def release_lock(self,
                          cell_id: str,
                          user_id: str,
                          session_id: Optional[str] = None,
                          force: bool = False) -> bool:
        """Release a lock on a cell.
        
        Args:
            cell_id: ID of the cell to unlock
            user_id: ID of the user releasing the lock
            session_id: ID of the user's session (optional for admin force release)
            force: Whether to force release (admin only)
            
        Returns:
            True if lock was released, False if no lock existed
            
        Raises:
            LockPermissionError: If user doesn't own the lock and force=False
        """
        lock = await self.registry.get_lock(cell_id)
        
        if lock is None:
            return False
        
        # Check permissions
        if not force and not lock.is_owned_by(user_id, session_id):
            raise LockPermissionError(
                f"User {user_id} does not own lock on cell {cell_id}"
            )
        
        # Remove lock
        removed_lock = await self.registry.remove_lock(cell_id)
        
        if removed_lock:
            if force:
                removed_lock.state = LockState.FORCE_RELEASED
                self._stats["locks_force_released"] += 1
                self.logger.warning(f"Force released lock {removed_lock.lock_id} for cell {cell_id}")
            else:
                self._stats["locks_released"] += 1
                self.logger.info(f"Released lock {removed_lock.lock_id} for cell {cell_id}")
            
            # Process pending locks
            await self.registry.process_pending_locks(cell_id)
            
            # Notify document managers
            await self._notify_lock_released(removed_lock, force=force)
            
            return True
        
        return False
    
    async def extend_lock(self,
                         cell_id: str,
                         user_id: str,
                         session_id: str,
                         extension_seconds: float = 300) -> bool:
        """Extend a lock timeout.
        
        Args:
            cell_id: ID of the cell
            user_id: ID of the user
            session_id: ID of the session
            extension_seconds: Number of seconds to extend
            
        Returns:
            True if lock was extended, False if no lock exists
            
        Raises:
            LockPermissionError: If user doesn't own the lock
        """
        lock = await self.registry.get_lock(cell_id)
        
        if lock is None:
            return False
        
        if not lock.is_owned_by(user_id, session_id):
            raise LockPermissionError(
                f"User {user_id} does not own lock on cell {cell_id}"
            )
        
        lock.extend_timeout(extension_seconds)
        await self._notify_lock_extended(lock)
        
        self.logger.debug(f"Extended lock {lock.lock_id} for cell {cell_id} by {extension_seconds}s")
        return True
    
    async def heartbeat_lock(self,
                            cell_id: str,
                            user_id: str,
                            session_id: str) -> bool:
        """Send heartbeat for a lock to indicate activity.
        
        Args:
            cell_id: ID of the cell
            user_id: ID of the user
            session_id: ID of the session
            
        Returns:
            True if heartbeat was recorded, False if no lock exists
        """
        lock = await self.registry.get_lock(cell_id)
        
        if lock is None:
            return False
        
        if lock.is_owned_by(user_id, session_id):
            lock.last_heartbeat = time.time()
            return True
        
        return False
    
    async def get_lock_status(self, cell_id: str) -> Optional[Dict[str, Any]]:
        """Get lock status for a cell.
        
        Returns:
            Dictionary with lock information or None if not locked
        """
        lock = await self.registry.get_lock(cell_id)
        
        if lock is None:
            return None
        
        return {
            "locked": True,
            "lock_info": lock.to_dict(),
            "is_expired": lock.is_expired(),
            "time_remaining": max(0, lock.expires_at - time.time())
        }
    
    async def get_user_lock_status(self, user_id: str) -> Dict[str, Any]:
        """Get all locks for a user.
        
        Returns:
            Dictionary with user's lock information
        """
        locks = await self.registry.get_user_locks(user_id)
        
        return {
            "user_id": user_id,
            "lock_count": len(locks),
            "locks": [lock.to_dict() for lock in locks],
            "max_locks": self.max_locks_per_user
        }
    
    async def release_user_locks(self,
                                user_id: str,
                                session_id: Optional[str] = None) -> int:
        """Release all locks for a user.
        
        Args:
            user_id: ID of the user
            session_id: Specific session to release (None for all sessions)
            
        Returns:
            Number of locks released
        """
        if session_id:
            locks = await self.registry.get_session_locks(session_id)
        else:
            locks = await self.registry.get_user_locks(user_id)
        
        released_count = 0
        
        for lock in locks:
            if await self.release_lock(lock.cell_id, user_id, session_id):
                released_count += 1
        
        if released_count > 0:
            self.logger.info(f"Released {released_count} locks for user {user_id}")
        
        return released_count
    
    async def _check_deadlock_potential(self,
                                       cell_id: str,
                                       user_id: str,
                                       session_id: str) -> None:
        """Check for potential deadlock scenarios."""
        # Get user's current locks
        user_locks = await self.registry.get_user_locks(user_id)
        
        if not user_locks:
            return  # No deadlock potential if user has no locks
        
        # Check if the cell being requested is already locked
        target_lock = await self.registry.get_lock(cell_id)
        
        if target_lock is None:
            return  # No deadlock if target cell is free
        
        # Simple deadlock detection: check if target lock owner is waiting for any of user's cells
        target_user_locks = await self.registry.get_user_locks(target_lock.user_id)
        
        user_cell_ids = {lock.cell_id for lock in user_locks}
        target_cell_ids = {lock.cell_id for lock in target_user_locks}
        
        # Check for circular dependency
        if user_cell_ids & target_cell_ids:
            self._stats["deadlocks_detected"] += 1
            raise DeadlockError(
                f"Potential deadlock detected between users {user_id} and {target_lock.user_id}"
            )
    
    async def _notify_lock_acquired(self, lock: CellLock) -> None:
        """Notify interested parties that a lock was acquired."""
        # This method can be extended to integrate with document managers
        # or broadcast lock events to collaboration clients
        pass
    
    async def _notify_lock_released(self, lock: CellLock, expired: bool = False, force: bool = False) -> None:
        """Notify interested parties that a lock was released."""
        # This method can be extended to integrate with document managers
        # or broadcast lock events to collaboration clients
        pass
    
    async def _notify_lock_extended(self, lock: CellLock) -> None:
        """Notify interested parties that a lock was extended."""
        # This method can be extended to integrate with document managers
        # or broadcast lock events to collaboration clients
        pass
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get lock manager statistics."""
        return {
            **self._stats,
            "active_locks": len(self.registry._locks),
            "pending_locks": sum(len(pending) for pending in self.registry._pending_locks.values()),
            "unique_users": len(self.registry._user_locks),
            "unique_sessions": len(self.registry._session_locks)
        }
    
    async def force_cleanup(self) -> Dict[str, int]:
        """Force cleanup of all locks and return statistics."""
        expired_locks = await self.registry.cleanup_expired_locks()
        all_locks = await self.registry.get_all_locks()
        
        # Force release remaining locks
        force_released = 0
        for lock in all_locks:
            if await self.release_lock(lock.cell_id, lock.user_id, force=True):
                force_released += 1
        
        return {
            "expired_locks": len(expired_locks),
            "force_released": force_released,
            "total_cleaned": len(expired_locks) + force_released
        }


# Global lock manager instance
_lock_manager: Optional[CellLockManager] = None


def get_lock_manager() -> Optional[CellLockManager]:
    """Get the global lock manager instance."""
    return _lock_manager


def set_lock_manager(manager: CellLockManager) -> None:
    """Set the global lock manager instance."""
    global _lock_manager
    _lock_manager = manager


def create_lock_manager(**kwargs) -> CellLockManager:
    """Create and configure a lock manager instance."""
    manager = CellLockManager(**kwargs)
    set_lock_manager(manager)
    manager.start_cleanup_task()
    return manager


async def cleanup_session_locks(session_id: str) -> int:
    """Cleanup all locks for a session (convenience function)."""
    manager = get_lock_manager()
    if manager:
        locks = await manager.registry.get_session_locks(session_id)
        released_count = 0
        
        for lock in locks:
            if await manager.release_lock(lock.cell_id, lock.user_id, session_id):
                released_count += 1
        
        return released_count
    
    return 0


async def cleanup_user_locks(user_id: str) -> int:
    """Cleanup all locks for a user (convenience function)."""
    manager = get_lock_manager()
    if manager:
        return await manager.release_user_locks(user_id)
    
    return 0


# Integration hooks for collaboration system
async def initialize_lock_integration() -> None:
    """Initialize lock manager integration with collaboration system."""
    if _lock_manager is None:
        create_lock_manager()
    
    logging.getLogger(__name__).info("Cell-level lock manager initialized")


async def shutdown_lock_integration() -> None:
    """Shutdown lock manager integration."""
    manager = get_lock_manager()
    if manager:
        await manager.stop_cleanup_task()
        cleanup_stats = await manager.force_cleanup()
        logging.getLogger(__name__).info(
            f"Lock manager shutdown complete. Cleaned up {cleanup_stats['total_cleaned']} locks."
        )