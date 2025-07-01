"""
Distributed locking service for cell-level editing conflict prevention.

This module implements a comprehensive distributed locking mechanism using Yjs shared types
to coordinate cell-level edit access across multiple collaborative users. The system ensures
that only one user can edit a cell at a time while providing automatic timeout, conflict
resolution, and persistence across reconnections.

The LockManager class serves as the central coordinator for all locking operations,
integrating seamlessly with the Jupyter Notebook collaborative editing infrastructure
and providing robust fallback mechanisms for network failures and edge cases.
"""

import asyncio
import time
import weakref
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Callable, Tuple, Union
from dataclasses import dataclass, asdict
import json
import uuid

try:
    import pycrdt
    from pycrdt import Map as YMap, Array as YArray, Doc as YDoc
    HAS_PYCRDT = True
except ImportError:
    HAS_PYCRDT = False
    # Fallback type hints for when pycrdt is not available
    YMap = Any
    YArray = Any
    YDoc = Any

from .utils import (
    CollaborationConfig, CollaborationLogger, CollaborationMetrics,
    CollaborationError, CollaborationConnectionError, CollaborationPermissionError,
    GracefulDegradationManager, RetryConfig, with_retry, error_context,
    get_collaboration_config, get_collaboration_logger, get_collaboration_metrics,
    get_degradation_manager, monitor_performance, PermissionValidator
)


class LockState(Enum):
    """Enumeration of possible lock states for a cell."""
    UNLOCKED = "unlocked"
    ACQUIRING = "acquiring"
    LOCKED = "locked"
    RELEASED = "released"
    EXPIRED = "expired"
    DENIED = "denied"
    ERROR = "error"


class LockType(Enum):
    """Types of locks that can be acquired on cells."""
    EDIT = "edit"           # Standard editing lock
    EXECUTE = "execute"     # Execution lock (prevents other operations)
    COMMENT = "comment"     # Comment-only lock (allows multiple)
    ADMIN = "admin"         # Administrative lock (highest priority)


class LockPriority(Enum):
    """Priority levels for lock acquisition."""
    LOW = 1
    NORMAL = 2
    HIGH = 3
    CRITICAL = 4


@dataclass
class LockInfo:
    """Information about a cell lock."""
    cell_id: str
    user_id: str
    username: str
    lock_type: LockType
    priority: LockPriority
    acquired_at: float
    expires_at: float
    session_id: str
    client_id: str
    metadata: Dict[str, Any]
    
    def is_expired(self) -> bool:
        """Check if the lock has expired."""
        return time.time() > self.expires_at
    
    def time_remaining(self) -> float:
        """Get remaining time before lock expires."""
        return max(0, self.expires_at - time.time())
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert lock info to dictionary for serialization."""
        return {
            'cell_id': self.cell_id,
            'user_id': self.user_id,
            'username': self.username,
            'lock_type': self.lock_type.value,
            'priority': self.priority.value,
            'acquired_at': self.acquired_at,
            'expires_at': self.expires_at,
            'session_id': self.session_id,
            'client_id': self.client_id,
            'metadata': self.metadata
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'LockInfo':
        """Create LockInfo from dictionary."""
        return cls(
            cell_id=data['cell_id'],
            user_id=data['user_id'],
            username=data['username'],
            lock_type=LockType(data['lock_type']),
            priority=LockPriority(data['priority']),
            acquired_at=data['acquired_at'],
            expires_at=data['expires_at'],
            session_id=data['session_id'],
            client_id=data['client_id'],
            metadata=data.get('metadata', {})
        )


@dataclass
class LockRequest:
    """Request for acquiring a lock."""
    cell_id: str
    user_id: str
    username: str
    lock_type: LockType
    priority: LockPriority
    timeout: float
    session_id: str
    client_id: str
    metadata: Dict[str, Any]
    request_id: str
    timestamp: float


class LockConflictError(CollaborationError):
    """Raised when a lock conflict occurs."""
    
    def __init__(self, message: str, current_lock: Optional[LockInfo] = None,
                 requested_lock: Optional[LockRequest] = None):
        super().__init__(message)
        self.current_lock = current_lock
        self.requested_lock = requested_lock


class LockTimeoutError(CollaborationError):
    """Raised when lock acquisition times out."""
    pass


class LockManager:
    """
    Distributed lock manager for cell-level editing conflict prevention.
    
    This class implements a comprehensive locking system using Yjs shared Maps to coordinate
    cell access across multiple collaborative users. It provides automatic timeout handling,
    conflict resolution, and graceful degradation mechanisms.
    
    The lock manager integrates with the broader collaboration infrastructure to ensure
    consistent behavior and proper monitoring of lock operations.
    """
    
    def __init__(self, document_id: str, yjs_doc: Optional[YDoc] = None,
                 config: Optional[CollaborationConfig] = None):
        """
        Initialize the lock manager.
        
        Args:
            document_id: Unique identifier for the document
            yjs_doc: Yjs document for shared state (optional, will create if not provided)
            config: Collaboration configuration (optional, will use global if not provided)
        """
        self.document_id = document_id
        self.config = config or get_collaboration_config()
        self.logger = get_collaboration_logger()
        self.metrics = get_collaboration_metrics()
        self.degradation_manager = get_degradation_manager()
        
        # Yjs document and shared state
        self.yjs_doc = yjs_doc or (YDoc() if HAS_PYCRDT else None)
        self._locks_map: Optional[YMap] = None
        self._awareness_map: Optional[YMap] = None
        self._history_array: Optional[YArray] = None
        
        # Local state management
        self._local_locks: Dict[str, LockInfo] = {}
        self._pending_requests: Dict[str, LockRequest] = {}
        self._lock_callbacks: Dict[str, List[Callable]] = {}
        self._cleanup_tasks: Set[asyncio.Task] = set()
        
        # Connection state
        self._connected = False
        self._session_id = str(uuid.uuid4())
        self._client_id = str(uuid.uuid4())
        
        # Performance tracking
        self._operation_count = 0
        self._last_cleanup = time.time()
        
        # Permission validator
        self.permission_validator = PermissionValidator()
        
        # Initialize shared state if Yjs is available
        if HAS_PYCRDT and self.yjs_doc:
            self._initialize_yjs_state()
    
    def _initialize_yjs_state(self):
        """Initialize Yjs shared state for distributed locking."""
        try:
            # Create or get shared maps for lock coordination
            self._locks_map = self.yjs_doc.get("locks", type=YMap)
            self._awareness_map = self.yjs_doc.get("awareness", type=YMap)
            self._history_array = self.yjs_doc.get("lock_history", type=YArray)
            
            # Set up observers for remote changes
            self._locks_map.observe(self._on_remote_lock_change)
            self._awareness_map.observe(self._on_awareness_change)
            
            self.logger.logger.info(
                f"Initialized Yjs lock state for document {self.document_id}",
                extra={"document_id": self.document_id, "session_id": self._session_id}
            )
        except Exception as e:
            self.logger.log_error(e, {
                "context": "yjs_initialization",
                "document_id": self.document_id
            })
            # Fall back to local-only mode
            self._locks_map = None
            self._awareness_map = None
            self._history_array = None
    
    def _on_remote_lock_change(self, event):
        """Handle remote lock state changes from other clients."""
        try:
            for key, value in event.keys.items():
                if key.startswith("cell_"):
                    cell_id = key[5:]  # Remove "cell_" prefix
                    
                    if value.action == "add" or value.action == "update":
                        # Lock acquired or updated by remote client
                        lock_data = value.new_value
                        if isinstance(lock_data, dict):
                            lock_info = LockInfo.from_dict(lock_data)
                            self._handle_remote_lock_acquired(cell_id, lock_info)
                    
                    elif value.action == "delete":
                        # Lock released by remote client
                        self._handle_remote_lock_released(cell_id)
        except Exception as e:
            self.logger.log_error(e, {
                "context": "remote_lock_change",
                "document_id": self.document_id
            })
    
    def _on_awareness_change(self, event):
        """Handle awareness changes for lock-related user presence."""
        try:
            # Update local awareness state and trigger callbacks
            self._trigger_awareness_callbacks()
        except Exception as e:
            self.logger.log_error(e, {
                "context": "awareness_change",
                "document_id": self.document_id
            })
    
    def _handle_remote_lock_acquired(self, cell_id: str, lock_info: LockInfo):
        """Handle remote lock acquisition."""
        # Update local state
        self._local_locks[cell_id] = lock_info
        
        # Record metrics
        self.metrics.record_lock_event(
            self.document_id, cell_id, "remote_acquired"
        )
        
        # Trigger callbacks
        self._trigger_lock_callbacks(cell_id, LockState.LOCKED, lock_info)
        
        self.logger.logger.info(
            f"Remote lock acquired on cell {cell_id} by {lock_info.username}",
            extra={
                "document_id": self.document_id,
                "cell_id": cell_id,
                "user_id": lock_info.user_id
            }
        )
    
    def _handle_remote_lock_released(self, cell_id: str):
        """Handle remote lock release."""
        lock_info = self._local_locks.pop(cell_id, None)
        
        # Record metrics
        self.metrics.record_lock_event(
            self.document_id, cell_id, "remote_released"
        )
        
        # Trigger callbacks
        self._trigger_lock_callbacks(cell_id, LockState.RELEASED, lock_info)
        
        self.logger.logger.info(
            f"Remote lock released on cell {cell_id}",
            extra={
                "document_id": self.document_id,
                "cell_id": cell_id
            }
        )
    
    @monitor_performance("acquire_lock")
    async def acquire_lock(self, cell_id: str, user_id: str, username: str,
                          lock_type: LockType = LockType.EDIT,
                          priority: LockPriority = LockPriority.NORMAL,
                          timeout: Optional[float] = None,
                          metadata: Optional[Dict[str, Any]] = None) -> LockInfo:
        """
        Acquire a lock on a specific cell.
        
        Args:
            cell_id: Unique identifier for the cell
            user_id: User requesting the lock
            username: Display name of the user
            lock_type: Type of lock to acquire
            priority: Priority level for lock acquisition
            timeout: Custom timeout in seconds (uses config default if not provided)
            metadata: Additional metadata for the lock
        
        Returns:
            LockInfo object containing lock details
        
        Raises:
            LockConflictError: If another user holds a conflicting lock
            LockTimeoutError: If lock acquisition times out
            CollaborationPermissionError: If user lacks permission
            CollaborationConnectionError: If connection to collaboration service fails
        """
        timeout = timeout or self.config.lock_timeout
        metadata = metadata or {}
        
        # Validate permissions
        if not self.permission_validator.validate_permission(
            user=type('User', (), {'username': username, 'role': 'edit'})(),
            operation='lock_acquire',
            document_id=self.document_id
        ):
            raise CollaborationPermissionError(
                f"User {username} lacks permission to acquire locks"
            )
        
        # Create lock request
        request = LockRequest(
            cell_id=cell_id,
            user_id=user_id,
            username=username,
            lock_type=lock_type,
            priority=priority,
            timeout=timeout,
            session_id=self._session_id,
            client_id=self._client_id,
            metadata=metadata,
            request_id=str(uuid.uuid4()),
            timestamp=time.time()
        )
        
        with error_context("acquire_lock", document_id=self.document_id,
                          user_id=user_id, cell_id=cell_id):
            try:
                # Check for existing locks
                current_lock = await self.get_lock_info(cell_id)
                if current_lock and not current_lock.is_expired():
                    # Check for conflict
                    if not self._can_acquire_lock(request, current_lock):
                        raise LockConflictError(
                            f"Cell {cell_id} is locked by {current_lock.username}",
                            current_lock=current_lock,
                            requested_lock=request
                        )
                
                # Attempt lock acquisition
                lock_info = await self._execute_lock_acquisition(request)
                
                # Record successful acquisition
                self.metrics.record_lock_event(
                    self.document_id, cell_id, "acquired"
                )
                
                self.logger.logger.info(
                    f"Lock acquired on cell {cell_id} by {username}",
                    extra={
                        "document_id": self.document_id,
                        "cell_id": cell_id,
                        "user_id": user_id,
                        "lock_type": lock_type.value
                    }
                )
                
                return lock_info
                
            except asyncio.TimeoutError:
                self.metrics.record_lock_event(
                    self.document_id, cell_id, "timeout"
                )
                raise LockTimeoutError(
                    f"Lock acquisition timeout for cell {cell_id}"
                )
            except Exception as e:
                self.metrics.record_lock_event(
                    self.document_id, cell_id, "error"
                )
                raise
    
    async def _execute_lock_acquisition(self, request: LockRequest) -> LockInfo:
        """Execute the actual lock acquisition process."""
        # Calculate expiration time
        expires_at = time.time() + request.timeout
        
        # Create lock info
        lock_info = LockInfo(
            cell_id=request.cell_id,
            user_id=request.user_id,
            username=request.username,
            lock_type=request.lock_type,
            priority=request.priority,
            acquired_at=time.time(),
            expires_at=expires_at,
            session_id=request.session_id,
            client_id=request.client_id,
            metadata=request.metadata
        )
        
        # Update local state
        self._local_locks[request.cell_id] = lock_info
        
        # Update Yjs shared state if available
        if self._locks_map is not None:
            try:
                key = f"cell_{request.cell_id}"
                self._locks_map[key] = lock_info.to_dict()
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "yjs_lock_update",
                    "cell_id": request.cell_id
                })
                # Continue with local-only mode
        
        # Schedule automatic cleanup
        self._schedule_lock_cleanup(lock_info)
        
        # Record in history
        self._record_lock_history("acquired", lock_info)
        
        # Trigger callbacks
        self._trigger_lock_callbacks(request.cell_id, LockState.LOCKED, lock_info)
        
        return lock_info
    
    def _can_acquire_lock(self, request: LockRequest, current_lock: LockInfo) -> bool:
        """Determine if a lock can be acquired given the current lock state."""
        # Same user can always re-acquire their own lock
        if current_lock.user_id == request.user_id:
            return True
        
        # Check if current lock has expired
        if current_lock.is_expired():
            return True
        
        # Admin locks have highest priority
        if request.lock_type == LockType.ADMIN:
            return True
        
        # Comment locks can coexist with other comment locks
        if (request.lock_type == LockType.COMMENT and 
            current_lock.lock_type == LockType.COMMENT):
            return True
        
        # Check priority levels
        if request.priority.value > current_lock.priority.value:
            return True
        
        # Otherwise, cannot acquire
        return False
    
    @monitor_performance("release_lock")
    async def release_lock(self, cell_id: str, user_id: str,
                          force: bool = False) -> bool:
        """
        Release a lock on a specific cell.
        
        Args:
            cell_id: Unique identifier for the cell
            user_id: User releasing the lock
            force: Force release even if user doesn't own the lock
        
        Returns:
            True if lock was successfully released, False otherwise
        
        Raises:
            CollaborationPermissionError: If user lacks permission to release lock
        """
        with error_context("release_lock", document_id=self.document_id,
                          user_id=user_id, cell_id=cell_id):
            try:
                # Get current lock info
                current_lock = await self.get_lock_info(cell_id)
                if not current_lock:
                    return False  # No lock to release
                
                # Check permissions
                if not force and current_lock.user_id != user_id:
                    # Check if user has admin permissions for forced release
                    if not self.permission_validator.validate_permission(
                        user=type('User', (), {'username': 'admin', 'role': 'admin'})(),
                        operation='manage_locks',
                        document_id=self.document_id
                    ):
                        raise CollaborationPermissionError(
                            f"User {user_id} cannot release lock owned by {current_lock.user_id}"
                        )
                
                # Remove from local state
                self._local_locks.pop(cell_id, None)
                
                # Update Yjs shared state if available
                if self._locks_map is not None:
                    try:
                        key = f"cell_{cell_id}"
                        if key in self._locks_map:
                            del self._locks_map[key]
                    except Exception as e:
                        self.logger.log_error(e, {
                            "context": "yjs_lock_release",
                            "cell_id": cell_id
                        })
                
                # Record in history
                self._record_lock_history("released", current_lock)
                
                # Record metrics
                self.metrics.record_lock_event(
                    self.document_id, cell_id, "released"
                )
                
                # Trigger callbacks
                self._trigger_lock_callbacks(cell_id, LockState.RELEASED, current_lock)
                
                self.logger.logger.info(
                    f"Lock released on cell {cell_id} by {user_id}",
                    extra={
                        "document_id": self.document_id,
                        "cell_id": cell_id,
                        "user_id": user_id
                    }
                )
                
                return True
                
            except Exception as e:
                self.metrics.record_lock_event(
                    self.document_id, cell_id, "release_error"
                )
                raise
    
    async def get_lock_info(self, cell_id: str) -> Optional[LockInfo]:
        """
        Get information about the current lock on a cell.
        
        Args:
            cell_id: Unique identifier for the cell
        
        Returns:
            LockInfo object if cell is locked, None otherwise
        """
        # Check local state first
        local_lock = self._local_locks.get(cell_id)
        if local_lock and not local_lock.is_expired():
            return local_lock
        
        # Check Yjs shared state if available
        if self._locks_map is not None:
            try:
                key = f"cell_{cell_id}"
                lock_data = self._locks_map.get(key)
                if lock_data and isinstance(lock_data, dict):
                    lock_info = LockInfo.from_dict(lock_data)
                    if not lock_info.is_expired():
                        # Update local cache
                        self._local_locks[cell_id] = lock_info
                        return lock_info
                    else:
                        # Remove expired lock
                        await self._cleanup_expired_lock(cell_id, lock_info)
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "get_lock_info",
                    "cell_id": cell_id
                })
        
        # Clean up expired local lock
        if local_lock and local_lock.is_expired():
            await self._cleanup_expired_lock(cell_id, local_lock)
        
        return None
    
    async def is_locked(self, cell_id: str) -> bool:
        """
        Check if a cell is currently locked.
        
        Args:
            cell_id: Unique identifier for the cell
        
        Returns:
            True if cell is locked, False otherwise
        """
        lock_info = await self.get_lock_info(cell_id)
        return lock_info is not None
    
    async def get_all_locks(self) -> Dict[str, LockInfo]:
        """
        Get information about all current locks.
        
        Returns:
            Dictionary mapping cell IDs to LockInfo objects
        """
        all_locks = {}
        
        # Start with local locks
        for cell_id, lock_info in self._local_locks.items():
            if not lock_info.is_expired():
                all_locks[cell_id] = lock_info
        
        # Add locks from Yjs state if available
        if self._locks_map is not None:
            try:
                for key, lock_data in self._locks_map.items():
                    if key.startswith("cell_") and isinstance(lock_data, dict):
                        cell_id = key[5:]  # Remove "cell_" prefix
                        lock_info = LockInfo.from_dict(lock_data)
                        if not lock_info.is_expired():
                            all_locks[cell_id] = lock_info
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "get_all_locks"
                })
        
        return all_locks
    
    async def get_user_locks(self, user_id: str) -> List[LockInfo]:
        """
        Get all locks held by a specific user.
        
        Args:
            user_id: User identifier
        
        Returns:
            List of LockInfo objects for locks held by the user
        """
        all_locks = await self.get_all_locks()
        return [lock for lock in all_locks.values() if lock.user_id == user_id]
    
    async def release_user_locks(self, user_id: str) -> int:
        """
        Release all locks held by a specific user.
        
        Args:
            user_id: User identifier
        
        Returns:
            Number of locks released
        """
        user_locks = await self.get_user_locks(user_id)
        released_count = 0
        
        for lock_info in user_locks:
            try:
                success = await self.release_lock(lock_info.cell_id, user_id)
                if success:
                    released_count += 1
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "release_user_locks",
                    "user_id": user_id,
                    "cell_id": lock_info.cell_id
                })
        
        return released_count
    
    def add_lock_callback(self, cell_id: str, callback: Callable[[str, LockState, Optional[LockInfo]], None]):
        """
        Add a callback for lock state changes on a specific cell.
        
        Args:
            cell_id: Cell identifier to monitor
            callback: Function to call when lock state changes
        """
        if cell_id not in self._lock_callbacks:
            self._lock_callbacks[cell_id] = []
        self._lock_callbacks[cell_id].append(callback)
    
    def remove_lock_callback(self, cell_id: str, callback: Callable):
        """
        Remove a lock state change callback.
        
        Args:
            cell_id: Cell identifier
            callback: Callback function to remove
        """
        if cell_id in self._lock_callbacks:
            try:
                self._lock_callbacks[cell_id].remove(callback)
            except ValueError:
                pass  # Callback not found
    
    def _trigger_lock_callbacks(self, cell_id: str, state: LockState, lock_info: Optional[LockInfo]):
        """Trigger all callbacks for a cell's lock state change."""
        callbacks = self._lock_callbacks.get(cell_id, [])
        for callback in callbacks:
            try:
                callback(cell_id, state, lock_info)
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "lock_callback",
                    "cell_id": cell_id
                })
    
    def _trigger_awareness_callbacks(self):
        """Trigger awareness callbacks for lock-related presence updates."""
        # This would integrate with the awareness system
        pass
    
    def _schedule_lock_cleanup(self, lock_info: LockInfo):
        """Schedule automatic cleanup for an expired lock."""
        delay = lock_info.time_remaining()
        if delay > 0:
            task = asyncio.create_task(
                self._cleanup_lock_after_delay(delay, lock_info)
            )
            self._cleanup_tasks.add(task)
            task.add_done_callback(self._cleanup_tasks.discard)
    
    async def _cleanup_lock_after_delay(self, delay: float, lock_info: LockInfo):
        """Clean up a lock after the specified delay."""
        await asyncio.sleep(delay)
        
        # Check if lock is still active and expired
        current_lock = await self.get_lock_info(lock_info.cell_id)
        if (current_lock and 
            current_lock.user_id == lock_info.user_id and
            current_lock.acquired_at == lock_info.acquired_at and
            current_lock.is_expired()):
            
            await self._cleanup_expired_lock(lock_info.cell_id, current_lock)
    
    async def _cleanup_expired_lock(self, cell_id: str, lock_info: LockInfo):
        """Clean up an expired lock."""
        try:
            # Remove from local state
            self._local_locks.pop(cell_id, None)
            
            # Remove from Yjs state if available
            if self._locks_map is not None:
                key = f"cell_{cell_id}"
                if key in self._locks_map:
                    del self._locks_map[key]
            
            # Record in history
            self._record_lock_history("expired", lock_info)
            
            # Record metrics
            self.metrics.record_lock_event(
                self.document_id, cell_id, "expired"
            )
            
            # Trigger callbacks
            self._trigger_lock_callbacks(cell_id, LockState.EXPIRED, lock_info)
            
            self.logger.logger.info(
                f"Expired lock cleaned up for cell {cell_id}",
                extra={
                    "document_id": self.document_id,
                    "cell_id": cell_id,
                    "user_id": lock_info.user_id
                }
            )
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "cleanup_expired_lock",
                "cell_id": cell_id
            })
    
    def _record_lock_history(self, action: str, lock_info: LockInfo):
        """Record lock operation in history."""
        if self._history_array is not None:
            try:
                history_entry = {
                    'action': action,
                    'timestamp': time.time(),
                    'lock_info': lock_info.to_dict()
                }
                self._history_array.append([history_entry])
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "record_lock_history",
                    "action": action
                })
    
    async def cleanup_expired_locks(self) -> int:
        """
        Clean up all expired locks.
        
        Returns:
            Number of locks cleaned up
        """
        cleanup_count = 0
        all_locks = await self.get_all_locks()
        
        for cell_id, lock_info in all_locks.items():
            if lock_info.is_expired():
                await self._cleanup_expired_lock(cell_id, lock_info)
                cleanup_count += 1
        
        self._last_cleanup = time.time()
        return cleanup_count
    
    async def get_lock_statistics(self) -> Dict[str, Any]:
        """
        Get comprehensive lock statistics.
        
        Returns:
            Dictionary containing lock statistics
        """
        all_locks = await self.get_all_locks()
        
        # Count locks by type
        type_counts = {}
        for lock_type in LockType:
            type_counts[lock_type.value] = 0
        
        for lock_info in all_locks.values():
            type_counts[lock_info.lock_type.value] += 1
        
        # Count locks by user
        user_counts = {}
        for lock_info in all_locks.values():
            user_counts[lock_info.username] = user_counts.get(lock_info.username, 0) + 1
        
        return {
            'total_locks': len(all_locks),
            'locks_by_type': type_counts,
            'locks_by_user': user_counts,
            'document_id': self.document_id,
            'last_cleanup': self._last_cleanup,
            'operation_count': self._operation_count,
            'connected': self._connected
        }
    
    async def force_release_all_locks(self) -> int:
        """
        Force release all locks (admin operation).
        
        Returns:
            Number of locks released
        """
        all_locks = await self.get_all_locks()
        released_count = 0
        
        for cell_id, lock_info in all_locks.items():
            try:
                success = await self.release_lock(cell_id, lock_info.user_id, force=True)
                if success:
                    released_count += 1
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "force_release_all_locks",
                    "cell_id": cell_id
                })
        
        return released_count
    
    def get_connection_status(self) -> Dict[str, Any]:
        """Get current connection status."""
        return {
            'connected': self._connected,
            'session_id': self._session_id,
            'client_id': self._client_id,
            'document_id': self.document_id,
            'yjs_available': HAS_PYCRDT and self.yjs_doc is not None,
            'shared_state_initialized': self._locks_map is not None
        }
    
    async def connect(self) -> bool:
        """
        Connect to the collaboration service.
        
        Returns:
            True if connection successful, False otherwise
        """
        try:
            if not HAS_PYCRDT:
                self.logger.logger.warning(
                    "pycrdt not available, running in local-only mode"
                )
                return False
            
            # Initialize or reconnect Yjs state
            if not self._locks_map:
                self._initialize_yjs_state()
            
            self._connected = True
            
            # Perform initial sync
            await self.cleanup_expired_locks()
            
            self.logger.logger.info(
                f"Connected to collaboration service for document {self.document_id}",
                extra={"document_id": self.document_id, "session_id": self._session_id}
            )
            
            return True
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "connect",
                "document_id": self.document_id
            })
            return False
    
    async def disconnect(self):
        """Disconnect from the collaboration service."""
        try:
            # Cancel all cleanup tasks
            for task in self._cleanup_tasks:
                if not task.done():
                    task.cancel()
            
            # Release all local locks
            user_locks = await self.get_user_locks('*')  # Get all locks for cleanup
            for lock_info in user_locks:
                if lock_info.session_id == self._session_id:
                    await self.release_lock(lock_info.cell_id, lock_info.user_id)
            
            self._connected = False
            
            self.logger.logger.info(
                f"Disconnected from collaboration service for document {self.document_id}",
                extra={"document_id": self.document_id, "session_id": self._session_id}
            )
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "disconnect",
                "document_id": self.document_id
            })
    
    async def __aenter__(self):
        """Async context manager entry."""
        await self.connect()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.disconnect()


# Utility functions for lock management

def create_lock_manager(document_id: str, yjs_doc: Optional[YDoc] = None,
                       config: Optional[CollaborationConfig] = None) -> LockManager:
    """
    Create a new lock manager instance.
    
    Args:
        document_id: Unique identifier for the document
        yjs_doc: Yjs document for shared state (optional)
        config: Collaboration configuration (optional)
    
    Returns:
        Configured LockManager instance
    """
    return LockManager(document_id, yjs_doc, config)


async def acquire_cell_lock(lock_manager: LockManager, cell_id: str,
                           user_id: str, username: str) -> Optional[LockInfo]:
    """
    Convenience function to acquire a standard edit lock on a cell.
    
    Args:
        lock_manager: LockManager instance
        cell_id: Cell identifier
        user_id: User identifier
        username: Display name
    
    Returns:
        LockInfo if successful, None if failed
    """
    try:
        return await lock_manager.acquire_lock(
            cell_id=cell_id,
            user_id=user_id,
            username=username,
            lock_type=LockType.EDIT,
            priority=LockPriority.NORMAL
        )
    except (LockConflictError, LockTimeoutError, CollaborationPermissionError):
        return None


async def release_cell_lock(lock_manager: LockManager, cell_id: str,
                           user_id: str) -> bool:
    """
    Convenience function to release a lock on a cell.
    
    Args:
        lock_manager: LockManager instance
        cell_id: Cell identifier
        user_id: User identifier
    
    Returns:
        True if successful, False otherwise
    """
    try:
        return await lock_manager.release_lock(cell_id, user_id)
    except CollaborationPermissionError:
        return False


def is_lock_compatible(lock_type1: LockType, lock_type2: LockType) -> bool:
    """
    Check if two lock types are compatible (can coexist).
    
    Args:
        lock_type1: First lock type
        lock_type2: Second lock type
    
    Returns:
        True if locks are compatible, False otherwise
    """
    # Comment locks can coexist with other comment locks
    if lock_type1 == LockType.COMMENT and lock_type2 == LockType.COMMENT:
        return True
    
    # Admin locks are exclusive
    if lock_type1 == LockType.ADMIN or lock_type2 == LockType.ADMIN:
        return False
    
    # Edit and execute locks are mutually exclusive
    return False