"""Document synchronization coordination service for real-time collaborative editing.

This module provides comprehensive synchronization coordination between the notebook model 
and Yjs CRDT shared types, enabling real-time collaborative editing with automatic 
conflict resolution and document consistency maintenance.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple, Union
from enum import Enum

from tornado.concurrent import run_on_executor
from concurrent.futures import ThreadPoolExecutor

from ...handlers import (
    DocumentState,
    CollaborationSessionManager,
    YjsProtocolHandler,
    session_manager,
)


class SyncEventType(Enum):
    """Types of synchronization events."""
    
    DOCUMENT_INIT = "document_init"
    DOCUMENT_UPDATE = "document_update"
    DOCUMENT_CONFLICT = "document_conflict"
    DOCUMENT_MERGE = "document_merge"
    DOCUMENT_SNAPSHOT = "document_snapshot"
    DOCUMENT_RESTORE = "document_restore"
    SYNC_ERROR = "sync_error"
    SYNC_COMPLETE = "sync_complete"
    SYNC_PAUSE = "sync_pause"
    SYNC_RESUME = "sync_resume"


class SyncState(Enum):
    """Synchronization states."""
    
    IDLE = "idle"
    SYNCING = "syncing"
    PAUSED = "paused"
    ERROR = "error"
    DISCONNECTED = "disconnected"


class ConflictResolutionStrategy(Enum):
    """Conflict resolution strategies."""
    
    CRDT_MERGE = "crdt_merge"
    LAST_WRITER_WINS = "last_writer_wins"
    MANUAL_RESOLUTION = "manual_resolution"
    FORCE_OVERWRITE = "force_overwrite"


class SyncEvent:
    """Represents a synchronization event."""
    
    def __init__(
        self,
        event_type: SyncEventType,
        document_id: str,
        user_id: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        timestamp: Optional[float] = None,
        event_id: Optional[str] = None
    ):
        self.event_type = event_type
        self.document_id = document_id
        self.user_id = user_id
        self.data = data or {}
        self.timestamp = timestamp or time.time()
        self.event_id = event_id or str(uuid.uuid4())
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert event to dictionary for serialization."""
        return {
            "event_type": self.event_type.value,
            "document_id": self.document_id,
            "user_id": self.user_id,
            "data": self.data,
            "timestamp": self.timestamp,
            "event_id": self.event_id
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> SyncEvent:
        """Create event from dictionary."""
        return cls(
            event_type=SyncEventType(data["event_type"]),
            document_id=data["document_id"],
            user_id=data.get("user_id"),
            data=data.get("data", {}),
            timestamp=data.get("timestamp"),
            event_id=data.get("event_id")
        )


class DocumentSyncState:
    """Tracks synchronization state for a document."""
    
    def __init__(self, document_id: str):
        self.document_id = document_id
        self.sync_state = SyncState.IDLE
        self.last_sync_time = time.time()
        self.last_conflict_time: Optional[float] = None
        self.pending_updates: List[bytes] = []
        self.applied_updates: Set[str] = set()
        self.conflict_count = 0
        self.sync_version = 0
        self.notebook_version = 0
        self.yjs_version = 0
        self.lock = asyncio.Lock()
        self.sync_history: List[SyncEvent] = []
        self.max_history_size = 1000
        self.conflict_resolution_strategy = ConflictResolutionStrategy.CRDT_MERGE
        self.auto_resolve_conflicts = True
        self.snapshot_interval = 300  # 5 minutes
        self.last_snapshot_time = time.time()
        self.error_count = 0
        self.max_error_count = 10
        self.retry_backoff = 1.0
        self.max_retry_backoff = 60.0
    
    async def add_event(self, event: SyncEvent) -> None:
        """Add event to synchronization history."""
        async with self.lock:
            self.sync_history.append(event)
            if len(self.sync_history) > self.max_history_size:
                self.sync_history.pop(0)
            self.last_sync_time = time.time()
    
    async def get_recent_events(self, count: int = 10) -> List[SyncEvent]:
        """Get recent synchronization events."""
        async with self.lock:
            return self.sync_history[-count:] if self.sync_history else []
    
    async def set_sync_state(self, state: SyncState) -> None:
        """Set synchronization state."""
        async with self.lock:
            if self.sync_state != state:
                self.sync_state = state
                self.last_sync_time = time.time()
    
    async def add_pending_update(self, update: bytes) -> None:
        """Add pending update to queue."""
        async with self.lock:
            self.pending_updates.append(update)
    
    async def get_pending_updates(self) -> List[bytes]:
        """Get and clear pending updates."""
        async with self.lock:
            updates = self.pending_updates.copy()
            self.pending_updates.clear()
            return updates
    
    async def mark_update_applied(self, update_id: str) -> None:
        """Mark update as applied."""
        async with self.lock:
            self.applied_updates.add(update_id)
    
    async def is_update_applied(self, update_id: str) -> bool:
        """Check if update has been applied."""
        async with self.lock:
            return update_id in self.applied_updates
    
    async def increment_error_count(self) -> bool:
        """Increment error count and check if max reached."""
        async with self.lock:
            self.error_count += 1
            if self.error_count >= self.max_error_count:
                await self.set_sync_state(SyncState.ERROR)
                return True
            return False
    
    async def reset_error_count(self) -> None:
        """Reset error count."""
        async with self.lock:
            self.error_count = 0
            self.retry_backoff = 1.0
    
    async def get_retry_backoff(self) -> float:
        """Get retry backoff time."""
        async with self.lock:
            backoff = self.retry_backoff
            self.retry_backoff = min(self.retry_backoff * 2, self.max_retry_backoff)
            return backoff
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert sync state to dictionary."""
        return {
            "document_id": self.document_id,
            "sync_state": self.sync_state.value,
            "last_sync_time": self.last_sync_time,
            "last_conflict_time": self.last_conflict_time,
            "pending_updates": len(self.pending_updates),
            "applied_updates": len(self.applied_updates),
            "conflict_count": self.conflict_count,
            "sync_version": self.sync_version,
            "notebook_version": self.notebook_version,
            "yjs_version": self.yjs_version,
            "error_count": self.error_count,
            "last_snapshot_time": self.last_snapshot_time,
            "auto_resolve_conflicts": self.auto_resolve_conflicts,
            "conflict_resolution_strategy": self.conflict_resolution_strategy.value
        }


class DocumentSyncCoordinator:
    """Coordinates synchronization between notebook model and Yjs CRDT shared types."""
    
    def __init__(self, session_manager: CollaborationSessionManager):
        self.session_manager = session_manager
        self.document_sync_states: Dict[str, DocumentSyncState] = {}
        self.event_handlers: Dict[SyncEventType, List[callable]] = {}
        self.lock = asyncio.Lock()
        self.logger = logging.getLogger(__name__)
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.sync_tasks: Dict[str, asyncio.Task] = {}
        self.snapshot_tasks: Dict[str, asyncio.Task] = {}
        self.cleanup_task: Optional[asyncio.Task] = None
        self.metrics = {
            "sync_operations": 0,
            "conflict_resolutions": 0,
            "snapshots_created": 0,
            "errors": 0,
            "total_documents": 0
        }
        self.start_cleanup_task()
    
    async def get_document_sync_state(self, document_id: str) -> DocumentSyncState:
        """Get or create document synchronization state."""
        async with self.lock:
            if document_id not in self.document_sync_states:
                self.document_sync_states[document_id] = DocumentSyncState(document_id)
                self.metrics["total_documents"] += 1
                
                # Start sync task for this document
                await self.start_sync_task(document_id)
                
                self.logger.info(f"Created sync state for document {document_id}")
            
            return self.document_sync_states[document_id]
    
    async def start_sync_task(self, document_id: str) -> None:
        """Start synchronization task for a document."""
        if document_id not in self.sync_tasks or self.sync_tasks[document_id].done():
            self.sync_tasks[document_id] = asyncio.create_task(
                self.sync_document_loop(document_id)
            )
            self.logger.info(f"Started sync task for document {document_id}")
    
    async def stop_sync_task(self, document_id: str) -> None:
        """Stop synchronization task for a document."""
        if document_id in self.sync_tasks and not self.sync_tasks[document_id].done():
            self.sync_tasks[document_id].cancel()
            try:
                await self.sync_tasks[document_id]
            except asyncio.CancelledError:
                pass
            
            self.logger.info(f"Stopped sync task for document {document_id}")
    
    async def sync_document_loop(self, document_id: str) -> None:
        """Main synchronization loop for a document."""
        sync_state = await self.get_document_sync_state(document_id)
        
        while True:
            try:
                await self.sync_document_once(document_id)
                await asyncio.sleep(0.1)  # Small delay to prevent busy waiting
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in sync loop for document {document_id}: {e}")
                await sync_state.increment_error_count()
                self.metrics["errors"] += 1
                
                # Exponential backoff on errors
                backoff = await sync_state.get_retry_backoff()
                await asyncio.sleep(backoff)
    
    async def sync_document_once(self, document_id: str) -> None:
        """Perform one synchronization cycle for a document."""
        sync_state = await self.get_document_sync_state(document_id)
        
        try:
            # Get document state from session manager
            document = await self.session_manager.get_document(document_id)
            
            # Check if there are pending updates
            pending_updates = await sync_state.get_pending_updates()
            
            if pending_updates:
                await sync_state.set_sync_state(SyncState.SYNCING)
                
                for update in pending_updates:
                    await self.apply_yjs_update(document_id, update)
                
                await sync_state.set_sync_state(SyncState.IDLE)
                self.metrics["sync_operations"] += 1
                
                # Emit sync complete event
                event = SyncEvent(
                    SyncEventType.SYNC_COMPLETE,
                    document_id,
                    data={"updates_applied": len(pending_updates)}
                )
                await self.emit_event(event)
            
            # Check if snapshot is needed
            if await self.should_create_snapshot(document_id):
                await self.create_document_snapshot(document_id)
            
            # Reset error count on successful sync
            await sync_state.reset_error_count()
            
        except Exception as e:
            self.logger.error(f"Error syncing document {document_id}: {e}")
            await sync_state.increment_error_count()
            
            # Emit sync error event
            event = SyncEvent(
                SyncEventType.SYNC_ERROR,
                document_id,
                data={"error": str(e)}
            )
            await self.emit_event(event)
            
            raise
    
    async def apply_yjs_update(self, document_id: str, update: bytes) -> None:
        """Apply a Yjs update to the document."""
        try:
            # Get document state
            document = await self.session_manager.get_document(document_id)
            
            # Apply update to Yjs state
            await document.add_yjs_update(update)
            
            # Update sync state
            sync_state = await self.get_document_sync_state(document_id)
            sync_state.yjs_version += 1
            
            # Emit update event
            event = SyncEvent(
                SyncEventType.DOCUMENT_UPDATE,
                document_id,
                data={"update_size": len(update)}
            )
            await self.emit_event(event)
            
            self.logger.debug(f"Applied Yjs update to document {document_id}")
            
        except Exception as e:
            self.logger.error(f"Error applying Yjs update to document {document_id}: {e}")
            raise
    
    async def handle_document_change(
        self, 
        document_id: str, 
        change_data: Dict[str, Any], 
        user_id: Optional[str] = None
    ) -> None:
        """Handle notebook model changes and convert to Yjs updates."""
        try:
            sync_state = await self.get_document_sync_state(document_id)
            
            # Convert notebook change to Yjs update
            yjs_update = await self.convert_notebook_change_to_yjs(change_data)
            
            if yjs_update:
                # Queue update for processing
                await sync_state.add_pending_update(yjs_update)
                
                # Update notebook version
                sync_state.notebook_version += 1
                
                # Emit document change event
                event = SyncEvent(
                    SyncEventType.DOCUMENT_UPDATE,
                    document_id,
                    user_id=user_id,
                    data={"change_type": change_data.get("type", "unknown")}
                )
                await self.emit_event(event)
                
                self.logger.debug(f"Queued notebook change for document {document_id}")
        
        except Exception as e:
            self.logger.error(f"Error handling document change for {document_id}: {e}")
            raise
    
    async def convert_notebook_change_to_yjs(self, change_data: Dict[str, Any]) -> Optional[bytes]:
        """Convert notebook model change to Yjs update."""
        try:
            # This is a simplified conversion - in reality, this would need
            # to handle specific notebook operations and convert them to
            # appropriate Yjs operations
            
            change_type = change_data.get("type")
            
            if change_type == "cell_change":
                # Handle cell content changes
                cell_id = change_data.get("cell_id")
                new_content = change_data.get("content", "")
                
                # Create a simple Yjs update (in practice, this would be more complex)
                update_data = {
                    "type": "cell_update",
                    "cell_id": cell_id,
                    "content": new_content,
                    "timestamp": time.time()
                }
                
                return json.dumps(update_data).encode()
            
            elif change_type == "cell_add":
                # Handle cell addition
                cell_data = change_data.get("cell_data", {})
                index = change_data.get("index", 0)
                
                update_data = {
                    "type": "cell_insert",
                    "index": index,
                    "cell_data": cell_data,
                    "timestamp": time.time()
                }
                
                return json.dumps(update_data).encode()
            
            elif change_type == "cell_delete":
                # Handle cell deletion
                cell_id = change_data.get("cell_id")
                
                update_data = {
                    "type": "cell_delete",
                    "cell_id": cell_id,
                    "timestamp": time.time()
                }
                
                return json.dumps(update_data).encode()
            
            elif change_type == "cell_move":
                # Handle cell movement
                cell_id = change_data.get("cell_id")
                old_index = change_data.get("old_index")
                new_index = change_data.get("new_index")
                
                update_data = {
                    "type": "cell_move",
                    "cell_id": cell_id,
                    "old_index": old_index,
                    "new_index": new_index,
                    "timestamp": time.time()
                }
                
                return json.dumps(update_data).encode()
            
            # Return None for unhandled change types
            return None
            
        except Exception as e:
            self.logger.error(f"Error converting notebook change to Yjs: {e}")
            return None
    
    async def handle_conflict(
        self, 
        document_id: str, 
        conflict_data: Dict[str, Any],
        user_id: Optional[str] = None
    ) -> bool:
        """Handle synchronization conflicts."""
        try:
            sync_state = await self.get_document_sync_state(document_id)
            sync_state.conflict_count += 1
            sync_state.last_conflict_time = time.time()
            
            # Emit conflict event
            event = SyncEvent(
                SyncEventType.DOCUMENT_CONFLICT,
                document_id,
                user_id=user_id,
                data=conflict_data
            )
            await self.emit_event(event)
            
            # Resolve conflict based on strategy
            if sync_state.auto_resolve_conflicts:
                resolved = await self.resolve_conflict_automatically(
                    document_id, conflict_data, sync_state.conflict_resolution_strategy
                )
                
                if resolved:
                    self.metrics["conflict_resolutions"] += 1
                    
                    # Emit merge event
                    merge_event = SyncEvent(
                        SyncEventType.DOCUMENT_MERGE,
                        document_id,
                        user_id=user_id,
                        data={"resolution_strategy": sync_state.conflict_resolution_strategy.value}
                    )
                    await self.emit_event(merge_event)
                
                return resolved
            
            return False
            
        except Exception as e:
            self.logger.error(f"Error handling conflict for document {document_id}: {e}")
            return False
    
    async def resolve_conflict_automatically(
        self, 
        document_id: str, 
        conflict_data: Dict[str, Any], 
        strategy: ConflictResolutionStrategy
    ) -> bool:
        """Automatically resolve conflicts based on strategy."""
        try:
            if strategy == ConflictResolutionStrategy.CRDT_MERGE:
                # Use CRDT automatic merging (default for Yjs)
                return await self.perform_crdt_merge(document_id, conflict_data)
            
            elif strategy == ConflictResolutionStrategy.LAST_WRITER_WINS:
                # Use last writer wins strategy
                return await self.perform_last_writer_wins(document_id, conflict_data)
            
            elif strategy == ConflictResolutionStrategy.FORCE_OVERWRITE:
                # Force overwrite with latest version
                return await self.perform_force_overwrite(document_id, conflict_data)
            
            else:
                # Manual resolution required
                self.logger.info(f"Manual conflict resolution required for document {document_id}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error resolving conflict for document {document_id}: {e}")
            return False
    
    async def perform_crdt_merge(self, document_id: str, conflict_data: Dict[str, Any]) -> bool:
        """Perform CRDT-based conflict resolution."""
        try:
            # In a real implementation, this would use Yjs CRDT operations
            # to automatically merge conflicting changes
            self.logger.info(f"Performing CRDT merge for document {document_id}")
            
            # For now, return success as Yjs handles this automatically
            return True
            
        except Exception as e:
            self.logger.error(f"Error performing CRDT merge: {e}")
            return False
    
    async def perform_last_writer_wins(self, document_id: str, conflict_data: Dict[str, Any]) -> bool:
        """Perform last writer wins conflict resolution."""
        try:
            # Get the latest update and apply it
            latest_update = conflict_data.get("latest_update")
            if latest_update:
                await self.apply_yjs_update(document_id, latest_update)
                self.logger.info(f"Applied last writer wins for document {document_id}")
                return True
            
            return False
            
        except Exception as e:
            self.logger.error(f"Error performing last writer wins: {e}")
            return False
    
    async def perform_force_overwrite(self, document_id: str, conflict_data: Dict[str, Any]) -> bool:
        """Force overwrite with latest version."""
        try:
            # Get document state and force update
            document = await self.session_manager.get_document(document_id)
            
            overwrite_data = conflict_data.get("overwrite_data")
            if overwrite_data:
                await document.set_yjs_state(overwrite_data)
                self.logger.info(f"Performed force overwrite for document {document_id}")
                return True
            
            return False
            
        except Exception as e:
            self.logger.error(f"Error performing force overwrite: {e}")
            return False
    
    async def should_create_snapshot(self, document_id: str) -> bool:
        """Check if a snapshot should be created for the document."""
        try:
            sync_state = await self.get_document_sync_state(document_id)
            current_time = time.time()
            
            # Check if snapshot interval has passed
            if current_time - sync_state.last_snapshot_time >= sync_state.snapshot_interval:
                return True
            
            # Check if there have been significant changes
            if sync_state.sync_version - sync_state.last_snapshot_time > 100:
                return True
            
            return False
            
        except Exception as e:
            self.logger.error(f"Error checking snapshot condition: {e}")
            return False
    
    async def create_document_snapshot(self, document_id: str) -> bool:
        """Create a snapshot of the document state."""
        try:
            if document_id in self.snapshot_tasks and not self.snapshot_tasks[document_id].done():
                return False  # Snapshot already in progress
            
            self.snapshot_tasks[document_id] = asyncio.create_task(
                self.perform_snapshot_creation(document_id)
            )
            
            return True
            
        except Exception as e:
            self.logger.error(f"Error creating snapshot for document {document_id}: {e}")
            return False
    
    async def perform_snapshot_creation(self, document_id: str) -> None:
        """Perform the actual snapshot creation."""
        try:
            # Get document state
            document = await self.session_manager.get_document(document_id)
            sync_state = await self.get_document_sync_state(document_id)
            
            # Create snapshot data
            snapshot_data = {
                "document_id": document_id,
                "timestamp": time.time(),
                "yjs_state": await document.get_yjs_state(),
                "document_state": document.to_dict(),
                "sync_state": sync_state.to_dict()
            }
            
            # In a real implementation, this would persist the snapshot
            # For now, just log the snapshot creation
            self.logger.info(f"Created snapshot for document {document_id}")
            
            # Update snapshot time
            sync_state.last_snapshot_time = time.time()
            self.metrics["snapshots_created"] += 1
            
            # Emit snapshot event
            event = SyncEvent(
                SyncEventType.DOCUMENT_SNAPSHOT,
                document_id,
                data={"snapshot_size": len(json.dumps(snapshot_data))}
            )
            await self.emit_event(event)
            
        except Exception as e:
            self.logger.error(f"Error performing snapshot creation: {e}")
            raise
    
    async def pause_synchronization(self, document_id: str) -> bool:
        """Pause synchronization for a document."""
        try:
            sync_state = await self.get_document_sync_state(document_id)
            await sync_state.set_sync_state(SyncState.PAUSED)
            
            # Emit pause event
            event = SyncEvent(SyncEventType.SYNC_PAUSE, document_id)
            await self.emit_event(event)
            
            self.logger.info(f"Paused synchronization for document {document_id}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error pausing synchronization: {e}")
            return False
    
    async def resume_synchronization(self, document_id: str) -> bool:
        """Resume synchronization for a document."""
        try:
            sync_state = await self.get_document_sync_state(document_id)
            await sync_state.set_sync_state(SyncState.IDLE)
            
            # Restart sync task if needed
            await self.start_sync_task(document_id)
            
            # Emit resume event
            event = SyncEvent(SyncEventType.SYNC_RESUME, document_id)
            await self.emit_event(event)
            
            self.logger.info(f"Resumed synchronization for document {document_id}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error resuming synchronization: {e}")
            return False
    
    async def get_sync_status(self, document_id: str) -> Dict[str, Any]:
        """Get synchronization status for a document."""
        try:
            sync_state = await self.get_document_sync_state(document_id)
            document = await self.session_manager.get_document(document_id)
            
            return {
                "document_id": document_id,
                "sync_state": sync_state.to_dict(),
                "document_state": document.to_dict(),
                "connected_users": len(document.connected_users),
                "is_syncing": sync_state.sync_state == SyncState.SYNCING,
                "last_sync_time": sync_state.last_sync_time,
                "error_count": sync_state.error_count
            }
            
        except Exception as e:
            self.logger.error(f"Error getting sync status: {e}")
            return {"error": str(e)}
    
    async def get_metrics(self) -> Dict[str, Any]:
        """Get synchronization metrics."""
        return {
            **self.metrics,
            "active_documents": len(self.document_sync_states),
            "active_sync_tasks": len([t for t in self.sync_tasks.values() if not t.done()]),
            "active_snapshot_tasks": len([t for t in self.snapshot_tasks.values() if not t.done()])
        }
    
    def register_event_handler(self, event_type: SyncEventType, handler: callable) -> None:
        """Register an event handler for synchronization events."""
        if event_type not in self.event_handlers:
            self.event_handlers[event_type] = []
        self.event_handlers[event_type].append(handler)
    
    def unregister_event_handler(self, event_type: SyncEventType, handler: callable) -> None:
        """Unregister an event handler."""
        if event_type in self.event_handlers:
            try:
                self.event_handlers[event_type].remove(handler)
            except ValueError:
                pass  # Handler not found
    
    async def emit_event(self, event: SyncEvent) -> None:
        """Emit a synchronization event to registered handlers."""
        try:
            await self.get_document_sync_state(event.document_id)
            sync_state = self.document_sync_states[event.document_id]
            await sync_state.add_event(event)
            
            # Call registered handlers
            if event.event_type in self.event_handlers:
                for handler in self.event_handlers[event.event_type]:
                    try:
                        if asyncio.iscoroutinefunction(handler):
                            await handler(event)
                        else:
                            handler(event)
                    except Exception as e:
                        self.logger.error(f"Error in event handler: {e}")
        
        except Exception as e:
            self.logger.error(f"Error emitting event: {e}")
    
    async def cleanup_expired_documents(self) -> None:
        """Clean up expired document sync states."""
        current_time = time.time()
        expired_documents = []
        
        async with self.lock:
            for document_id, sync_state in self.document_sync_states.items():
                # Remove documents with no activity for 1 hour
                if current_time - sync_state.last_sync_time > 3600:
                    expired_documents.append(document_id)
        
        for document_id in expired_documents:
            await self.cleanup_document(document_id)
    
    async def cleanup_document(self, document_id: str) -> None:
        """Clean up resources for a document."""
        try:
            # Stop sync task
            await self.stop_sync_task(document_id)
            
            # Cancel snapshot task if running
            if document_id in self.snapshot_tasks and not self.snapshot_tasks[document_id].done():
                self.snapshot_tasks[document_id].cancel()
            
            # Remove from tracking
            async with self.lock:
                if document_id in self.document_sync_states:
                    del self.document_sync_states[document_id]
                if document_id in self.sync_tasks:
                    del self.sync_tasks[document_id]
                if document_id in self.snapshot_tasks:
                    del self.snapshot_tasks[document_id]
            
            self.logger.info(f"Cleaned up document {document_id}")
            
        except Exception as e:
            self.logger.error(f"Error cleaning up document {document_id}: {e}")
    
    def start_cleanup_task(self) -> None:
        """Start periodic cleanup task."""
        if self.cleanup_task is None or self.cleanup_task.done():
            self.cleanup_task = asyncio.create_task(self.cleanup_loop())
    
    async def cleanup_loop(self) -> None:
        """Periodic cleanup loop."""
        while True:
            try:
                await asyncio.sleep(600)  # 10 minutes
                await self.cleanup_expired_documents()
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in cleanup loop: {e}")
    
    async def shutdown(self) -> None:
        """Shutdown the synchronization coordinator."""
        self.logger.info("Shutting down document synchronization coordinator")
        
        # Cancel cleanup task
        if self.cleanup_task and not self.cleanup_task.done():
            self.cleanup_task.cancel()
        
        # Stop all sync tasks
        for document_id in list(self.sync_tasks.keys()):
            await self.stop_sync_task(document_id)
        
        # Cancel all snapshot tasks
        for task in self.snapshot_tasks.values():
            if not task.done():
                task.cancel()
        
        # Shutdown executor
        self.executor.shutdown(wait=True)
        
        self.logger.info("Document synchronization coordinator shutdown complete")


# Global synchronization coordinator instance
sync_coordinator = DocumentSyncCoordinator(session_manager)


def get_sync_coordinator() -> DocumentSyncCoordinator:
    """Get the global synchronization coordinator instance."""
    return sync_coordinator


def initialize_sync_coordinator() -> DocumentSyncCoordinator:
    """Initialize and return the synchronization coordinator."""
    global sync_coordinator
    if sync_coordinator is None:
        sync_coordinator = DocumentSyncCoordinator(session_manager)
    return sync_coordinator


async def handle_notebook_change(
    document_id: str, 
    change_data: Dict[str, Any], 
    user_id: Optional[str] = None
) -> None:
    """Handle notebook model changes and synchronize with Yjs."""
    coordinator = get_sync_coordinator()
    await coordinator.handle_document_change(document_id, change_data, user_id)


async def handle_yjs_update(
    document_id: str, 
    update: bytes, 
    user_id: Optional[str] = None
) -> None:
    """Handle Yjs updates and synchronize with notebook model."""
    coordinator = get_sync_coordinator()
    sync_state = await coordinator.get_document_sync_state(document_id)
    await sync_state.add_pending_update(update)


async def get_document_sync_status(document_id: str) -> Dict[str, Any]:
    """Get synchronization status for a document."""
    coordinator = get_sync_coordinator()
    return await coordinator.get_sync_status(document_id)


async def pause_document_sync(document_id: str) -> bool:
    """Pause synchronization for a document."""
    coordinator = get_sync_coordinator()
    return await coordinator.pause_synchronization(document_id)


async def resume_document_sync(document_id: str) -> bool:
    """Resume synchronization for a document."""
    coordinator = get_sync_coordinator()
    return await coordinator.resume_synchronization(document_id)


async def create_document_snapshot(document_id: str) -> bool:
    """Create a snapshot of the document state."""
    coordinator = get_sync_coordinator()
    return await coordinator.create_document_snapshot(document_id)


async def get_sync_metrics() -> Dict[str, Any]:
    """Get synchronization metrics."""
    coordinator = get_sync_coordinator()
    return await coordinator.get_metrics()