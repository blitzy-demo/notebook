"""Main coordination manager for file locking and collaborative states.

This module provides the central coordination manager for Jupyter Notebook v7's
real-time collaborative editing features. It orchestrates cell-level locking,
collaborative state persistence, and document synchronization powered by Yjs CRDT
technology, serving as the primary integration point for all collaborative backend
services.

The manager coordinates between:
- Cell-level locking mechanisms (locks.py)
- Collaborative state persistence (collab_state.py) 
- Document synchronization (sync.py)
- WebSocket protocol handlers (handlers.py)

It ensures seamless integration of collaborative features while maintaining
backward compatibility with single-user workflows and graceful degradation
when collaboration services are unavailable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union
from enum import Enum
from weakref import WeakValueDictionary

from jupyter_server.services.contents.manager import ContentsManager
from jupyter_server.utils import ensure_async
from traitlets import Bool, Float, Int, Unicode, Instance, observe
from traitlets.config import Configurable

from .locks import (
    CellLockManager,
    LockState,
    LockType,
    LockError,
    LockAcquisitionError,
    LockNotFoundError,
    LockPermissionError,
    get_lock_manager,
    set_lock_manager,
    create_lock_manager
)
from .collab_state import (
    CollaborativeStateManager,
    CollaborativeSnapshot,
    CollaborativeStateError,
    SnapshotNotFoundError,
    get_collaborative_state_manager
)
from .sync import (
    DocumentSyncCoordinator,
    SyncEventType,
    SyncState,
    ConflictResolutionStrategy,
    SyncEvent,
    get_sync_coordinator,
    initialize_sync_coordinator
)
from ..handlers import (
    CollaborationSessionManager,
    DocumentState,
    YjsProtocolHandler,
    session_manager,
    COLLAB_EVENT_CELL_LOCK,
    COLLAB_EVENT_CELL_UNLOCK,
    COLLAB_EVENT_USER_JOIN,
    COLLAB_EVENT_USER_LEAVE
)


class CollaborationMode(Enum):
    """Collaboration mode enumeration."""
    DISABLED = "disabled"
    SINGLE_USER = "single_user"
    COLLABORATIVE = "collaborative"
    FALLBACK = "fallback"


class ManagerState(Enum):
    """Manager state enumeration."""
    UNINITIALIZED = "uninitialized"
    INITIALIZING = "initializing"
    ACTIVE = "active"
    DEGRADED = "degraded"
    SHUTTING_DOWN = "shutting_down"
    SHUTDOWN = "shutdown"
    ERROR = "error"


@dataclass
class CollaborationSession:
    """Represents an active collaboration session."""
    
    document_id: str
    document_path: str
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    mode: CollaborationMode = CollaborationMode.COLLABORATIVE
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    participant_count: int = 0
    active_locks: int = 0
    total_operations: int = 0
    error_count: int = 0
    state_snapshots: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def update_activity(self) -> None:
        """Update last activity timestamp."""
        self.last_activity = time.time()
    
    def increment_operations(self) -> None:
        """Increment operation counter."""
        self.total_operations += 1
        self.update_activity()
    
    def increment_errors(self) -> None:
        """Increment error counter."""
        self.error_count += 1
        self.update_activity()
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert session to dictionary for serialization."""
        return {
            "document_id": self.document_id,
            "document_path": self.document_path,
            "session_id": self.session_id,
            "mode": self.mode.value,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "participant_count": self.participant_count,
            "active_locks": self.active_locks,
            "total_operations": self.total_operations,
            "error_count": self.error_count,
            "state_snapshots": self.state_snapshots,
            "metadata": self.metadata
        }


class CollaborationManagerError(Exception):
    """Base exception for collaboration manager operations."""
    
    def __init__(self, message: str, code: str = "MANAGER_ERROR"):
        super().__init__(message)
        self.code = code


class CollaborationContentsManager(Configurable):
    """Main coordination manager for file locking and collaborative states.
    
    This manager serves as the central coordination point for all collaborative
    editing features, integrating cell-level locking, state persistence,
    document synchronization, and WebSocket protocol handling.
    """
    
    # Configuration traits
    collaboration_enabled = Bool(
        default_value=True,
        help="Enable collaborative editing features"
    ).tag(config=True)
    
    collaboration_mode = Unicode(
        default_value="collaborative",
        help="Collaboration mode: disabled, single_user, collaborative, fallback"
    ).tag(config=True)
    
    lock_timeout = Float(
        default_value=300.0,
        help="Default lock timeout in seconds"
    ).tag(config=True)
    
    max_locks_per_user = Int(
        default_value=50,
        help="Maximum number of locks per user"
    ).tag(config=True)
    
    snapshot_interval = Float(
        default_value=300.0,
        help="Snapshot creation interval in seconds"
    ).tag(config=True)
    
    cleanup_interval = Float(
        default_value=60.0,
        help="Cleanup interval in seconds"
    ).tag(config=True)
    
    session_timeout = Float(
        default_value=3600.0,
        help="Session timeout in seconds"
    ).tag(config=True)
    
    enable_graceful_degradation = Bool(
        default_value=True,
        help="Enable graceful degradation when collaboration fails"
    ).tag(config=True)
    
    base_directory = Unicode(
        help="Base directory for notebook files"
    )
    
    contents_manager = Instance(
        ContentsManager,
        help="The contents manager instance for file operations"
    )
    
    def __init__(self, contents_manager: ContentsManager, base_directory: str = "", **kwargs):
        """Initialize the collaboration contents manager.
        
        Args:
            contents_manager: The Jupyter contents manager
            base_directory: Base directory for notebook files
            **kwargs: Additional configuration options
        """
        super().__init__(**kwargs)
        
        self.contents_manager = contents_manager
        self.base_directory = base_directory
        self.logger = logging.getLogger(__name__)
        
        # Manager state
        self.state = ManagerState.UNINITIALIZED
        self.collaboration_mode_enum = CollaborationMode.COLLABORATIVE
        
        # Component managers
        self.lock_manager: Optional[CellLockManager] = None
        self.state_manager: Optional[CollaborativeStateManager] = None
        self.sync_coordinator: Optional[DocumentSyncCoordinator] = None
        self.session_manager: CollaborationSessionManager = session_manager
        
        # Session tracking
        self.active_sessions: Dict[str, CollaborationSession] = {}
        self.document_to_session: Dict[str, str] = {}  # document_id -> session_id
        
        # Coordination locks
        self.coordination_lock = asyncio.Lock()
        self.initialization_lock = asyncio.Lock()
        
        # Background tasks
        self.cleanup_task: Optional[asyncio.Task] = None
        self.monitoring_task: Optional[asyncio.Task] = None
        self.health_check_task: Optional[asyncio.Task] = None
        
        # Metrics and statistics
        self.metrics = {
            "sessions_created": 0,
            "sessions_destroyed": 0,
            "operations_processed": 0,
            "locks_acquired": 0,
            "locks_released": 0,
            "snapshots_created": 0,
            "conflicts_resolved": 0,
            "errors_handled": 0,
            "degradation_events": 0
        }
        
        # Event handlers
        self.event_handlers: Dict[str, List[callable]] = {}
        
        # Weak references to handlers for cleanup
        self.active_handlers: WeakValueDictionary = WeakValueDictionary()
        
        self.logger.info(f"Collaboration contents manager initialized with mode: {self.collaboration_mode}")
    
    @observe('collaboration_mode')
    def _collaboration_mode_changed(self, change):
        """Handle collaboration mode configuration changes."""
        try:
            self.collaboration_mode_enum = CollaborationMode(change['new'])
            self.logger.info(f"Collaboration mode changed to: {change['new']}")
        except ValueError:
            self.logger.warning(f"Invalid collaboration mode: {change['new']}")
            self.collaboration_mode_enum = CollaborationMode.FALLBACK
    
    async def initialize(self) -> None:
        """Initialize the collaboration manager and all component services."""
        async with self.initialization_lock:
            if self.state != ManagerState.UNINITIALIZED:
                return
            
            self.state = ManagerState.INITIALIZING
            self.logger.info("Initializing collaboration contents manager")
            
            try:
                # Update collaboration mode from configuration
                self._collaboration_mode_changed({'new': self.collaboration_mode})
                
                # Initialize component managers
                await self._initialize_lock_manager()
                await self._initialize_state_manager()
                await self._initialize_sync_coordinator()
                
                # Set up event handlers
                await self._setup_event_handlers()
                
                # Start background tasks
                await self._start_background_tasks()
                
                # Validate all components are working
                await self._validate_components()
                
                self.state = ManagerState.ACTIVE
                self.logger.info("Collaboration contents manager initialized successfully")
                
            except Exception as e:
                self.logger.error(f"Failed to initialize collaboration manager: {e}")
                self.state = ManagerState.ERROR
                
                if self.enable_graceful_degradation:
                    await self._enable_degraded_mode()
                else:
                    raise CollaborationManagerError(f"Initialization failed: {e}")
    
    async def _initialize_lock_manager(self) -> None:
        """Initialize the cell lock manager."""
        try:
            # Use existing global manager or create new one
            self.lock_manager = get_lock_manager()
            
            if self.lock_manager is None:
                self.lock_manager = create_lock_manager(
                    default_timeout=self.lock_timeout,
                    max_locks_per_user=self.max_locks_per_user,
                    cleanup_interval=self.cleanup_interval
                )
            
            self.logger.info("Lock manager initialized")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize lock manager: {e}")
            raise
    
    async def _initialize_state_manager(self) -> None:
        """Initialize the collaborative state manager."""
        try:
            self.state_manager = get_collaborative_state_manager(
                contents_manager=self.contents_manager,
                base_directory=self.base_directory
            )
            
            # Configure state manager
            self.state_manager.snapshot_interval = self.snapshot_interval
            self.state_manager.cleanup_interval = self.cleanup_interval
            
            self.logger.info("State manager initialized")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize state manager: {e}")
            raise
    
    async def _initialize_sync_coordinator(self) -> None:
        """Initialize the document sync coordinator."""
        try:
            self.sync_coordinator = initialize_sync_coordinator()
            self.logger.info("Sync coordinator initialized")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize sync coordinator: {e}")
            raise
    
    async def _setup_event_handlers(self) -> None:
        """Set up event handlers for coordination between components."""
        try:
            # Register sync event handlers
            if self.sync_coordinator:
                self.sync_coordinator.register_event_handler(
                    SyncEventType.DOCUMENT_CONFLICT,
                    self._handle_sync_conflict
                )
                self.sync_coordinator.register_event_handler(
                    SyncEventType.DOCUMENT_UPDATE,
                    self._handle_document_update
                )
                self.sync_coordinator.register_event_handler(
                    SyncEventType.SYNC_ERROR,
                    self._handle_sync_error
                )
            
            self.logger.info("Event handlers configured")
            
        except Exception as e:
            self.logger.error(f"Failed to setup event handlers: {e}")
            raise
    
    async def _start_background_tasks(self) -> None:
        """Start background coordination tasks."""
        try:
            # Start cleanup task
            self.cleanup_task = asyncio.create_task(self._cleanup_loop())
            
            # Start monitoring task
            self.monitoring_task = asyncio.create_task(self._monitoring_loop())
            
            # Start health check task
            self.health_check_task = asyncio.create_task(self._health_check_loop())
            
            self.logger.info("Background tasks started")
            
        except Exception as e:
            self.logger.error(f"Failed to start background tasks: {e}")
            raise
    
    async def _validate_components(self) -> None:
        """Validate that all components are functioning correctly."""
        try:
            # Validate lock manager
            if self.lock_manager is None:
                raise CollaborationManagerError("Lock manager not initialized")
            
            # Validate state manager
            if self.state_manager is None:
                raise CollaborationManagerError("State manager not initialized")
            
            # Validate sync coordinator
            if self.sync_coordinator is None:
                raise CollaborationManagerError("Sync coordinator not initialized")
            
            # Test basic functionality
            test_stats = await self.get_manager_statistics()
            if not isinstance(test_stats, dict):
                raise CollaborationManagerError("Manager statistics validation failed")
            
            self.logger.info("Component validation successful")
            
        except Exception as e:
            self.logger.error(f"Component validation failed: {e}")
            raise
    
    async def _enable_degraded_mode(self) -> None:
        """Enable degraded mode when collaboration features fail."""
        try:
            self.state = ManagerState.DEGRADED
            self.collaboration_mode_enum = CollaborationMode.FALLBACK
            self.metrics["degradation_events"] += 1
            
            self.logger.warning("Collaboration manager operating in degraded mode")
            
        except Exception as e:
            self.logger.error(f"Failed to enable degraded mode: {e}")
            self.state = ManagerState.ERROR
            raise
    
    async def create_collaboration_session(
        self,
        document_id: str,
        document_path: str,
        user_id: str,
        initial_mode: Optional[CollaborationMode] = None
    ) -> CollaborationSession:
        """Create a new collaboration session for a document.
        
        Args:
            document_id: Unique identifier for the document
            document_path: Path to the notebook file
            user_id: ID of the user creating the session
            initial_mode: Initial collaboration mode (defaults to manager mode)
            
        Returns:
            CollaborationSession object
            
        Raises:
            CollaborationManagerError: If session creation fails
        """
        async with self.coordination_lock:
            try:
                # Check if session already exists
                if document_id in self.document_to_session:
                    session_id = self.document_to_session[document_id]
                    return self.active_sessions[session_id]
                
                # Determine collaboration mode
                if initial_mode is None:
                    initial_mode = self.collaboration_mode_enum
                
                # Create new session
                session = CollaborationSession(
                    document_id=document_id,
                    document_path=document_path,
                    mode=initial_mode
                )
                
                # Register session
                self.active_sessions[session.session_id] = session
                self.document_to_session[document_id] = session.session_id
                
                # Initialize document in sync coordinator
                if self.sync_coordinator and initial_mode == CollaborationMode.COLLABORATIVE:
                    await self.sync_coordinator.get_document_sync_state(document_id)
                
                # Restore collaborative state if available
                if self.state_manager and initial_mode == CollaborationMode.COLLABORATIVE:
                    restored_state = await self.state_manager.restore_document_state(
                        document_id, document_path
                    )
                    if restored_state:
                        session.metadata["restored_state"] = True
                        session.state_snapshots = 1
                        self.logger.info(f"Restored collaborative state for document {document_id}")
                
                # Update metrics
                self.metrics["sessions_created"] += 1
                
                # Emit session created event
                await self._emit_event("session_created", {
                    "session": session.to_dict(),
                    "user_id": user_id
                })
                
                self.logger.info(f"Created collaboration session {session.session_id} for document {document_id}")
                
                return session
                
            except Exception as e:
                self.logger.error(f"Failed to create collaboration session: {e}")
                self.metrics["errors_handled"] += 1
                raise CollaborationManagerError(f"Session creation failed: {e}")
    
    async def get_collaboration_session(self, document_id: str) -> Optional[CollaborationSession]:
        """Get the collaboration session for a document.
        
        Args:
            document_id: Unique identifier for the document
            
        Returns:
            CollaborationSession object or None if not found
        """
        async with self.coordination_lock:
            session_id = self.document_to_session.get(document_id)
            if session_id:
                return self.active_sessions.get(session_id)
            return None
    
    async def destroy_collaboration_session(
        self,
        document_id: str,
        user_id: Optional[str] = None,
        reason: str = "normal_shutdown"
    ) -> bool:
        """Destroy a collaboration session and clean up resources.
        
        Args:
            document_id: Unique identifier for the document
            user_id: ID of the user requesting destruction (optional)
            reason: Reason for destruction
            
        Returns:
            True if session was destroyed, False if not found
        """
        async with self.coordination_lock:
            try:
                session_id = self.document_to_session.get(document_id)
                if not session_id:
                    return False
                
                session = self.active_sessions.get(session_id)
                if not session:
                    return False
                
                # Create final snapshot if needed
                if (self.state_manager and 
                    session.mode == CollaborationMode.COLLABORATIVE and
                    session.total_operations > 0):
                    try:
                        # Get document state for snapshot
                        document = await self.session_manager.get_document(document_id)
                        yjs_state = await document.get_yjs_state()
                        
                        snapshot_metadata = {
                            "session_id": session.session_id,
                            "final_snapshot": True,
                            "operations": session.total_operations,
                            "participants": session.participant_count,
                            "destroyed_by": user_id,
                            "reason": reason
                        }
                        
                        await self.state_manager.create_snapshot(
                            document_id,
                            session.document_path,
                            yjs_state,
                            snapshot_metadata,
                            force=True
                        )
                        
                        self.logger.info(f"Created final snapshot for session {session_id}")
                        
                    except Exception as e:
                        self.logger.warning(f"Failed to create final snapshot: {e}")
                
                # Release all locks for this document
                if self.lock_manager:
                    try:
                        all_locks = await self.lock_manager.registry.get_all_locks()
                        document_locks = [lock for lock in all_locks if lock.cell_id.startswith(document_id)]
                        
                        for lock in document_locks:
                            await self.lock_manager.release_lock(
                                lock.cell_id, 
                                lock.user_id, 
                                lock.session_id, 
                                force=True
                            )
                        
                        if document_locks:
                            self.logger.info(f"Released {len(document_locks)} locks for document {document_id}")
                        
                    except Exception as e:
                        self.logger.warning(f"Failed to release locks for document {document_id}: {e}")
                
                # Clean up sync coordinator state
                if self.sync_coordinator:
                    try:
                        await self.sync_coordinator.cleanup_document(document_id)
                    except Exception as e:
                        self.logger.warning(f"Failed to cleanup sync state: {e}")
                
                # Remove session tracking
                del self.active_sessions[session_id]
                del self.document_to_session[document_id]
                
                # Update metrics
                self.metrics["sessions_destroyed"] += 1
                
                # Emit session destroyed event
                await self._emit_event("session_destroyed", {
                    "session": session.to_dict(),
                    "user_id": user_id,
                    "reason": reason
                })
                
                self.logger.info(f"Destroyed collaboration session {session_id} for document {document_id}")
                
                return True
                
            except Exception as e:
                self.logger.error(f"Failed to destroy collaboration session: {e}")
                self.metrics["errors_handled"] += 1
                return False
    
    async def acquire_cell_lock(
        self,
        document_id: str,
        cell_id: str,
        user_id: str,
        session_id: str,
        lock_type: LockType = LockType.EDIT,
        timeout_seconds: Optional[float] = None,
        wait: bool = True
    ) -> bool:
        """Acquire a lock on a notebook cell.
        
        Args:
            document_id: Unique identifier for the document
            cell_id: Unique identifier for the cell
            user_id: ID of the user requesting the lock
            session_id: User's session ID
            lock_type: Type of lock to acquire
            timeout_seconds: Lock timeout (uses default if None)
            wait: Whether to wait for lock if cell is already locked
            
        Returns:
            True if lock was acquired, False otherwise
            
        Raises:
            CollaborationManagerError: If lock acquisition fails
        """
        try:
            # Check if collaboration is available
            if not self._is_collaboration_available():
                return True  # Always succeed in single-user mode
            
            # Validate session
            session = await self.get_collaboration_session(document_id)
            if not session:
                raise CollaborationManagerError(f"No collaboration session for document {document_id}")
            
            # Construct full cell ID
            full_cell_id = f"{document_id}#{cell_id}"
            
            # Acquire lock through lock manager
            lock = await self.lock_manager.acquire_lock(
                cell_id=full_cell_id,
                user_id=user_id,
                session_id=session_id,
                lock_type=lock_type,
                timeout_seconds=timeout_seconds,
                wait=wait
            )
            
            # Update session metrics
            session.active_locks += 1
            session.increment_operations()
            
            # Update global metrics
            self.metrics["locks_acquired"] += 1
            
            # Broadcast lock event
            await self._broadcast_collaboration_event(document_id, COLLAB_EVENT_CELL_LOCK, {
                "cell_id": cell_id,
                "user_id": user_id,
                "session_id": session_id,
                "lock_id": lock.lock_id,
                "lock_type": lock_type.value
            })
            
            self.logger.debug(f"Acquired lock {lock.lock_id} for cell {cell_id} by user {user_id}")
            
            return True
            
        except (LockAcquisitionError, LockPermissionError) as e:
            self.logger.info(f"Lock acquisition failed for cell {cell_id}: {e}")
            return False
        except Exception as e:
            self.logger.error(f"Error acquiring cell lock: {e}")
            self.metrics["errors_handled"] += 1
            raise CollaborationManagerError(f"Lock acquisition error: {e}")
    
    async def release_cell_lock(
        self,
        document_id: str,
        cell_id: str,
        user_id: str,
        session_id: Optional[str] = None,
        force: bool = False
    ) -> bool:
        """Release a lock on a notebook cell.
        
        Args:
            document_id: Unique identifier for the document
            cell_id: Unique identifier for the cell
            user_id: ID of the user releasing the lock
            session_id: User's session ID (optional for admin force release)
            force: Whether to force release (admin only)
            
        Returns:
            True if lock was released, False if no lock existed
            
        Raises:
            CollaborationManagerError: If lock release fails
        """
        try:
            # Check if collaboration is available
            if not self._is_collaboration_available():
                return True  # Always succeed in single-user mode
            
            # Validate session
            session = await self.get_collaboration_session(document_id)
            if not session:
                # Session might have been destroyed, but try to release anyway
                self.logger.info(f"No collaboration session for document {document_id}, attempting lock release")
            
            # Construct full cell ID
            full_cell_id = f"{document_id}#{cell_id}"
            
            # Release lock through lock manager
            released = await self.lock_manager.release_lock(
                cell_id=full_cell_id,
                user_id=user_id,
                session_id=session_id,
                force=force
            )
            
            if released:
                # Update session metrics
                if session:
                    session.active_locks = max(0, session.active_locks - 1)
                    session.increment_operations()
                
                # Update global metrics
                self.metrics["locks_released"] += 1
                
                # Broadcast unlock event
                await self._broadcast_collaboration_event(document_id, COLLAB_EVENT_CELL_UNLOCK, {
                    "cell_id": cell_id,
                    "user_id": user_id,
                    "session_id": session_id,
                    "force": force
                })
                
                self.logger.debug(f"Released lock for cell {cell_id} by user {user_id}")
            
            return released
            
        except LockPermissionError as e:
            self.logger.info(f"Lock release permission denied for cell {cell_id}: {e}")
            return False
        except Exception as e:
            self.logger.error(f"Error releasing cell lock: {e}")
            self.metrics["errors_handled"] += 1
            raise CollaborationManagerError(f"Lock release error: {e}")
    
    async def create_state_snapshot(
        self,
        document_id: str,
        yjs_state: bytes,
        metadata: Optional[Dict[str, Any]] = None,
        force: bool = False
    ) -> Optional[CollaborativeSnapshot]:
        """Create a snapshot of the collaborative state.
        
        Args:
            document_id: Unique identifier for the document
            yjs_state: Current Yjs document state
            metadata: Additional metadata to store
            force: Whether to force snapshot creation
            
        Returns:
            CollaborativeSnapshot object or None if creation failed
            
        Raises:
            CollaborationManagerError: If snapshot creation fails
        """
        try:
            # Check if collaboration is available
            if not self._is_collaboration_available():
                return None
            
            # Get session
            session = await self.get_collaboration_session(document_id)
            if not session:
                raise CollaborationManagerError(f"No collaboration session for document {document_id}")
            
            # Prepare metadata
            if metadata is None:
                metadata = {}
            
            snapshot_metadata = {
                **metadata,
                "session_id": session.session_id,
                "operations": session.total_operations,
                "participants": session.participant_count,
                "active_locks": session.active_locks,
                "created_by": "manager"
            }
            
            # Create snapshot through state manager
            snapshot = await self.state_manager.create_snapshot(
                document_id=document_id,
                document_path=session.document_path,
                yjs_state=yjs_state,
                metadata=snapshot_metadata,
                force=force
            )
            
            # Update session metrics
            session.state_snapshots += 1
            session.increment_operations()
            
            # Update global metrics
            self.metrics["snapshots_created"] += 1
            
            self.logger.info(f"Created snapshot {snapshot.snapshot_id} for document {document_id}")
            
            return snapshot
            
        except CollaborativeStateError as e:
            self.logger.info(f"Snapshot creation skipped: {e}")
            return None
        except Exception as e:
            self.logger.error(f"Error creating state snapshot: {e}")
            self.metrics["errors_handled"] += 1
            raise CollaborationManagerError(f"Snapshot creation error: {e}")
    
    async def handle_document_synchronization(
        self,
        document_id: str,
        change_data: Dict[str, Any],
        user_id: Optional[str] = None
    ) -> None:
        """Handle document synchronization through the sync coordinator.
        
        Args:
            document_id: Unique identifier for the document
            change_data: Document change data
            user_id: ID of the user who made the change
            
        Raises:
            CollaborationManagerError: If synchronization fails
        """
        try:
            # Check if collaboration is available
            if not self._is_collaboration_available():
                return
            
            # Get session
            session = await self.get_collaboration_session(document_id)
            if not session:
                raise CollaborationManagerError(f"No collaboration session for document {document_id}")
            
            # Handle through sync coordinator
            await self.sync_coordinator.handle_document_change(
                document_id, change_data, user_id
            )
            
            # Update session metrics
            session.increment_operations()
            
            # Update global metrics
            self.metrics["operations_processed"] += 1
            
        except Exception as e:
            self.logger.error(f"Error handling document synchronization: {e}")
            self.metrics["errors_handled"] += 1
            raise CollaborationManagerError(f"Synchronization error: {e}")
    
    async def get_collaboration_status(self, document_id: str) -> Dict[str, Any]:
        """Get comprehensive collaboration status for a document.
        
        Args:
            document_id: Unique identifier for the document
            
        Returns:
            Dictionary with collaboration status information
        """
        try:
            status = {
                "collaboration_enabled": self.collaboration_enabled,
                "collaboration_mode": self.collaboration_mode_enum.value,
                "manager_state": self.state.value,
                "document_id": document_id,
                "session_exists": False,
                "session_info": None,
                "sync_status": None,
                "lock_status": {},
                "state_info": None
            }
            
            # Get session information
            session = await self.get_collaboration_session(document_id)
            if session:
                status["session_exists"] = True
                status["session_info"] = session.to_dict()
            
            # Get sync status
            if self.sync_coordinator and self._is_collaboration_available():
                try:
                    sync_status = await self.sync_coordinator.get_sync_status(document_id)
                    status["sync_status"] = sync_status
                except Exception as e:
                    status["sync_status"] = {"error": str(e)}
            
            # Get lock status for document
            if self.lock_manager and self._is_collaboration_available():
                try:
                    all_locks = await self.lock_manager.registry.get_all_locks()
                    document_locks = [
                        lock for lock in all_locks 
                        if lock.cell_id.startswith(f"{document_id}#")
                    ]
                    
                    status["lock_status"] = {
                        "active_locks": len(document_locks),
                        "locks": [lock.to_dict() for lock in document_locks]
                    }
                except Exception as e:
                    status["lock_status"] = {"error": str(e)}
            
            # Get state information
            if self.state_manager and session and self._is_collaboration_available():
                try:
                    snapshots = await self.state_manager.list_snapshots(
                        document_id, session.document_path
                    )
                    status["state_info"] = {
                        "snapshots_available": len(snapshots),
                        "latest_snapshot": snapshots[0] if snapshots else None
                    }
                except Exception as e:
                    status["state_info"] = {"error": str(e)}
            
            return status
            
        except Exception as e:
            self.logger.error(f"Error getting collaboration status: {e}")
            return {
                "error": str(e),
                "collaboration_enabled": self.collaboration_enabled,
                "manager_state": self.state.value
            }
    
    async def get_manager_statistics(self) -> Dict[str, Any]:
        """Get comprehensive manager statistics and metrics.
        
        Returns:
            Dictionary with manager statistics
        """
        try:
            stats = {
                "manager_state": self.state.value,
                "collaboration_mode": self.collaboration_mode_enum.value,
                "collaboration_enabled": self.collaboration_enabled,
                "metrics": self.metrics.copy(),
                "active_sessions": len(self.active_sessions),
                "session_details": [session.to_dict() for session in self.active_sessions.values()],
                "component_stats": {}
            }
            
            # Get lock manager statistics
            if self.lock_manager:
                try:
                    stats["component_stats"]["lock_manager"] = self.lock_manager.get_statistics()
                except Exception as e:
                    stats["component_stats"]["lock_manager"] = {"error": str(e)}
            
            # Get state manager statistics
            if self.state_manager:
                try:
                    storage_stats = await self.state_manager.get_storage_stats()
                    cache_stats = self.state_manager.get_cache_stats()
                    stats["component_stats"]["state_manager"] = {
                        "storage": storage_stats,
                        "cache": cache_stats
                    }
                except Exception as e:
                    stats["component_stats"]["state_manager"] = {"error": str(e)}
            
            # Get sync coordinator statistics
            if self.sync_coordinator:
                try:
                    sync_metrics = await self.sync_coordinator.get_metrics()
                    stats["component_stats"]["sync_coordinator"] = sync_metrics
                except Exception as e:
                    stats["component_stats"]["sync_coordinator"] = {"error": str(e)}
            
            # Add system information
            stats["system_info"] = {
                "uptime": time.time() - getattr(self, '_start_time', time.time()),
                "background_tasks_active": sum(1 for task in [
                    self.cleanup_task, self.monitoring_task, self.health_check_task
                ] if task and not task.done()),
                "event_handlers": len(self.event_handlers),
                "active_handlers": len(self.active_handlers)
            }
            
            return stats
            
        except Exception as e:
            self.logger.error(f"Error getting manager statistics: {e}")
            return {
                "error": str(e),
                "manager_state": self.state.value,
                "metrics": self.metrics.copy()
            }
    
    def _is_collaboration_available(self) -> bool:
        """Check if collaboration features are available and functioning."""
        return (
            self.collaboration_enabled and
            self.state in [ManagerState.ACTIVE, ManagerState.DEGRADED] and
            self.collaboration_mode_enum in [CollaborationMode.COLLABORATIVE, CollaborationMode.FALLBACK] and
            self.lock_manager is not None and
            self.state_manager is not None and
            self.sync_coordinator is not None
        )
    
    async def _broadcast_collaboration_event(
        self,
        document_id: str,
        event_type: str,
        event_data: Dict[str, Any]
    ) -> None:
        """Broadcast collaboration event to all connected clients."""
        try:
            message = {
                "type": event_type,
                "document_id": document_id,
                "timestamp": time.time(),
                **event_data
            }
            
            message_bytes = json.dumps(message).encode()
            await self.session_manager.broadcast_to_document(document_id, message_bytes)
            
        except Exception as e:
            self.logger.error(f"Error broadcasting collaboration event: {e}")
    
    async def _emit_event(self, event_type: str, event_data: Dict[str, Any]) -> None:
        """Emit internal manager event to registered handlers."""
        try:
            if event_type in self.event_handlers:
                for handler in self.event_handlers[event_type]:
                    try:
                        if asyncio.iscoroutinefunction(handler):
                            await handler(event_data)
                        else:
                            handler(event_data)
                    except Exception as e:
                        self.logger.error(f"Error in event handler for {event_type}: {e}")
        
        except Exception as e:
            self.logger.error(f"Error emitting event {event_type}: {e}")
    
    async def _handle_sync_conflict(self, event: SyncEvent) -> None:
        """Handle synchronization conflict events."""
        try:
            self.metrics["conflicts_resolved"] += 1
            
            # Get session for metrics update
            session = await self.get_collaboration_session(event.document_id)
            if session:
                session.increment_operations()
            
            self.logger.info(f"Handled sync conflict for document {event.document_id}")
            
        except Exception as e:
            self.logger.error(f"Error handling sync conflict: {e}")
    
    async def _handle_document_update(self, event: SyncEvent) -> None:
        """Handle document update events."""
        try:
            # Get session for metrics update
            session = await self.get_collaboration_session(event.document_id)
            if session:
                session.increment_operations()
            
        except Exception as e:
            self.logger.error(f"Error handling document update: {e}")
    
    async def _handle_sync_error(self, event: SyncEvent) -> None:
        """Handle synchronization error events."""
        try:
            self.metrics["errors_handled"] += 1
            
            # Get session for metrics update
            session = await self.get_collaboration_session(event.document_id)
            if session:
                session.increment_errors()
            
            self.logger.warning(f"Sync error for document {event.document_id}: {event.data}")
            
        except Exception as e:
            self.logger.error(f"Error handling sync error: {e}")
    
    async def _cleanup_loop(self) -> None:
        """Main cleanup loop for expired sessions and resources."""
        while self.state not in [ManagerState.SHUTTING_DOWN, ManagerState.SHUTDOWN]:
            try:
                await asyncio.sleep(self.cleanup_interval)
                await self._cleanup_expired_sessions()
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in cleanup loop: {e}")
    
    async def _monitoring_loop(self) -> None:
        """Main monitoring loop for system health and metrics."""
        while self.state not in [ManagerState.SHUTTING_DOWN, ManagerState.SHUTDOWN]:
            try:
                await asyncio.sleep(60)  # Monitor every minute
                await self._update_monitoring_metrics()
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in monitoring loop: {e}")
    
    async def _health_check_loop(self) -> None:
        """Main health check loop for component validation."""
        while self.state not in [ManagerState.SHUTTING_DOWN, ManagerState.SHUTDOWN]:
            try:
                await asyncio.sleep(300)  # Health check every 5 minutes
                await self._perform_health_check()
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in health check loop: {e}")
    
    async def _cleanup_expired_sessions(self) -> None:
        """Clean up expired collaboration sessions."""
        try:
            current_time = time.time()
            expired_sessions = []
            
            # Find expired sessions
            async with self.coordination_lock:
                for session_id, session in self.active_sessions.items():
                    if current_time - session.last_activity > self.session_timeout:
                        expired_sessions.append(session.document_id)
            
            # Clean up expired sessions
            for document_id in expired_sessions:
                await self.destroy_collaboration_session(
                    document_id, 
                    reason="timeout_expired"
                )
            
            if expired_sessions:
                self.logger.info(f"Cleaned up {len(expired_sessions)} expired sessions")
                
        except Exception as e:
            self.logger.error(f"Error cleaning up expired sessions: {e}")
    
    async def _update_monitoring_metrics(self) -> None:
        """Update monitoring metrics."""
        try:
            # Update session metrics
            for session in self.active_sessions.values():
                # Get participant count from session manager
                try:
                    document = await self.session_manager.get_document(session.document_id)
                    session.participant_count = len(document.connected_users)
                except Exception:
                    pass  # Session might not exist in session manager
            
        except Exception as e:
            self.logger.error(f"Error updating monitoring metrics: {e}")
    
    async def _perform_health_check(self) -> None:
        """Perform health check on all components."""
        try:
            # Check component health
            components_healthy = True
            
            # Check lock manager
            if self.lock_manager:
                try:
                    stats = self.lock_manager.get_statistics()
                    if not isinstance(stats, dict):
                        components_healthy = False
                except Exception:
                    components_healthy = False
            
            # Check state manager
            if self.state_manager:
                try:
                    cache_stats = self.state_manager.get_cache_stats()
                    if not isinstance(cache_stats, dict):
                        components_healthy = False
                except Exception:
                    components_healthy = False
            
            # Check sync coordinator
            if self.sync_coordinator:
                try:
                    metrics = await self.sync_coordinator.get_metrics()
                    if not isinstance(metrics, dict):
                        components_healthy = False
                except Exception:
                    components_healthy = False
            
            # Update manager state based on health
            if not components_healthy and self.state == ManagerState.ACTIVE:
                self.logger.warning("Component health check failed, entering degraded mode")
                await self._enable_degraded_mode()
            elif components_healthy and self.state == ManagerState.DEGRADED:
                self.logger.info("Component health restored, returning to active mode")
                self.state = ManagerState.ACTIVE
                self.collaboration_mode_enum = CollaborationMode.COLLABORATIVE
                
        except Exception as e:
            self.logger.error(f"Error performing health check: {e}")
    
    async def shutdown(self) -> None:
        """Shutdown the collaboration manager and all component services."""
        if self.state in [ManagerState.SHUTTING_DOWN, ManagerState.SHUTDOWN]:
            return
        
        self.state = ManagerState.SHUTTING_DOWN
        self.logger.info("Shutting down collaboration contents manager")
        
        try:
            # Cancel background tasks
            for task in [self.cleanup_task, self.monitoring_task, self.health_check_task]:
                if task and not task.done():
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
            
            # Destroy all active sessions
            active_document_ids = list(self.document_to_session.keys())
            for document_id in active_document_ids:
                await self.destroy_collaboration_session(
                    document_id, 
                    reason="manager_shutdown"
                )
            
            # Shutdown sync coordinator
            if self.sync_coordinator:
                await self.sync_coordinator.shutdown()
            
            # Stop lock manager cleanup task
            if self.lock_manager:
                await self.lock_manager.stop_cleanup_task()
            
            # Stop state manager cleanup task
            if self.state_manager:
                self.state_manager.stop_cleanup_task()
            
            self.state = ManagerState.SHUTDOWN
            self.logger.info("Collaboration contents manager shutdown complete")
            
        except Exception as e:
            self.logger.error(f"Error during shutdown: {e}")
            self.state = ManagerState.ERROR
            raise


# Global manager instance
_collaboration_manager: Optional[CollaborationContentsManager] = None


def get_collaboration_manager() -> Optional[CollaborationContentsManager]:
    """Get the global collaboration manager instance."""
    return _collaboration_manager


def set_collaboration_manager(manager: CollaborationContentsManager) -> None:
    """Set the global collaboration manager instance."""
    global _collaboration_manager
    _collaboration_manager = manager


async def initialize_collaboration_manager(
    contents_manager: ContentsManager,
    base_directory: str = "",
    **kwargs
) -> CollaborationContentsManager:
    """Initialize and configure the global collaboration manager.
    
    Args:
        contents_manager: The Jupyter contents manager
        base_directory: Base directory for notebook files
        **kwargs: Additional configuration options
        
    Returns:
        CollaborationContentsManager instance
    """
    global _collaboration_manager
    
    if _collaboration_manager is None:
        _collaboration_manager = CollaborationContentsManager(
            contents_manager=contents_manager,
            base_directory=base_directory,
            **kwargs
        )
        
        # Initialize the manager
        await _collaboration_manager.initialize()
    
    return _collaboration_manager


async def cleanup_collaboration_manager() -> None:
    """Clean up the global collaboration manager instance."""
    global _collaboration_manager
    
    if _collaboration_manager is not None:
        await _collaboration_manager.shutdown()
        _collaboration_manager = None


# Convenience functions for common operations
async def create_collaboration_session(
    document_id: str,
    document_path: str,
    user_id: str,
    initial_mode: Optional[CollaborationMode] = None
) -> Optional[CollaborationSession]:
    """Create a collaboration session (convenience function).
    
    Args:
        document_id: Unique identifier for the document
        document_path: Path to the notebook file
        user_id: ID of the user creating the session
        initial_mode: Initial collaboration mode
        
    Returns:
        CollaborationSession object or None if manager not available
    """
    manager = get_collaboration_manager()
    if manager:
        return await manager.create_collaboration_session(
            document_id, document_path, user_id, initial_mode
        )
    return None


async def acquire_cell_lock(
    document_id: str,
    cell_id: str,
    user_id: str,
    session_id: str,
    lock_type: LockType = LockType.EDIT,
    timeout_seconds: Optional[float] = None,
    wait: bool = True
) -> bool:
    """Acquire a cell lock (convenience function).
    
    Args:
        document_id: Unique identifier for the document
        cell_id: Unique identifier for the cell
        user_id: ID of the user requesting the lock
        session_id: User's session ID
        lock_type: Type of lock to acquire
        timeout_seconds: Lock timeout
        wait: Whether to wait for lock
        
    Returns:
        True if lock was acquired, False otherwise
    """
    manager = get_collaboration_manager()
    if manager:
        return await manager.acquire_cell_lock(
            document_id, cell_id, user_id, session_id, lock_type, timeout_seconds, wait
        )
    return True  # Always succeed if no manager (single-user mode)


async def release_cell_lock(
    document_id: str,
    cell_id: str,
    user_id: str,
    session_id: Optional[str] = None,
    force: bool = False
) -> bool:
    """Release a cell lock (convenience function).
    
    Args:
        document_id: Unique identifier for the document
        cell_id: Unique identifier for the cell
        user_id: ID of the user releasing the lock
        session_id: User's session ID
        force: Whether to force release
        
    Returns:
        True if lock was released, False otherwise
    """
    manager = get_collaboration_manager()
    if manager:
        return await manager.release_cell_lock(
            document_id, cell_id, user_id, session_id, force
        )
    return True  # Always succeed if no manager (single-user mode)


async def get_collaboration_status(document_id: str) -> Dict[str, Any]:
    """Get collaboration status (convenience function).
    
    Args:
        document_id: Unique identifier for the document
        
    Returns:
        Dictionary with collaboration status
    """
    manager = get_collaboration_manager()
    if manager:
        return await manager.get_collaboration_status(document_id)
    return {
        "collaboration_enabled": False,
        "collaboration_mode": "single_user",
        "manager_state": "unavailable"
    }


# Integration hooks for collaboration system
async def initialize_collaboration_integration(
    contents_manager: ContentsManager,
    base_directory: str = "",
    **config_options
) -> None:
    """Initialize collaboration integration with the contents service.
    
    Args:
        contents_manager: The Jupyter contents manager
        base_directory: Base directory for notebook files
        **config_options: Additional configuration options
    """
    try:
        manager = await initialize_collaboration_manager(
            contents_manager=contents_manager,
            base_directory=base_directory,
            **config_options
        )
        
        logging.getLogger(__name__).info(
            f"Collaboration integration initialized successfully in {manager.collaboration_mode_enum.value} mode"
        )
        
    except Exception as e:
        logging.getLogger(__name__).error(f"Failed to initialize collaboration integration: {e}")
        raise


async def shutdown_collaboration_integration() -> None:
    """Shutdown collaboration integration."""
    try:
        await cleanup_collaboration_manager()
        logging.getLogger(__name__).info("Collaboration integration shutdown complete")
        
    except Exception as e:
        logging.getLogger(__name__).error(f"Error during collaboration integration shutdown: {e}")
        raise