"""Collaborative state persistence service for Jupyter Notebook.

This module provides collaborative state management, storage, and retrieval
functionality for Jupyter Notebook v7's real-time collaborative editing features.
It handles Yjs document snapshots, collaborative metadata, and session recovery
while maintaining compatibility with the standard .ipynb file format.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
from urllib.parse import urlparse

import tornado.ioloop
from jupyter_server.services.contents.manager import ContentsManager
from jupyter_server.utils import ensure_async
from traitlets import Bool, Float, Instance, Int, Unicode, Union as TraitUnion
from traitlets.config import Configurable


# Constants for collaborative state management
COLLAB_SNAPSHOTS_DIR = ".collab_snapshots"
SNAPSHOT_METADATA_FILE = "metadata.json"
SNAPSHOT_STATE_FILE = "state.json"
SNAPSHOT_YJS_FILE = "yjs_state.bin"

# Default configuration values
DEFAULT_SNAPSHOT_INTERVAL = 300  # 5 minutes
DEFAULT_CLEANUP_INTERVAL = 3600  # 1 hour
DEFAULT_MAX_SNAPSHOTS = 10
DEFAULT_INACTIVE_TIMEOUT = 86400  # 24 hours


class CollaborativeStateError(Exception):
    """Base exception for collaborative state operations."""
    
    def __init__(self, message: str, code: str = "COLLAB_STATE_ERROR"):
        super().__init__(message)
        self.code = code


class SnapshotNotFoundError(CollaborativeStateError):
    """Raised when a requested snapshot is not found."""
    
    def __init__(self, document_id: str, snapshot_id: Optional[str] = None):
        if snapshot_id:
            message = f"Snapshot {snapshot_id} not found for document {document_id}"
        else:
            message = f"No snapshots found for document {document_id}"
        super().__init__(message, "SNAPSHOT_NOT_FOUND")


class CollaborativeSnapshot:
    """Represents a collaborative state snapshot."""
    
    def __init__(
        self,
        document_id: str,
        snapshot_id: str,
        yjs_state: bytes,
        metadata: Dict[str, Any],
        created_at: float,
        file_path: str
    ):
        self.document_id = document_id
        self.snapshot_id = snapshot_id
        self.yjs_state = yjs_state
        self.metadata = metadata
        self.created_at = created_at
        self.file_path = file_path
        self.size = len(yjs_state) if yjs_state else 0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert snapshot to dictionary representation."""
        return {
            "document_id": self.document_id,
            "snapshot_id": self.snapshot_id,
            "created_at": self.created_at,
            "size": self.size,
            "file_path": self.file_path,
            "metadata": self.metadata
        }
    
    def is_expired(self, max_age: float) -> bool:
        """Check if snapshot is expired based on age."""
        return time.time() - self.created_at > max_age


class CollaborativeStateManager(Configurable):
    """Manager for collaborative state persistence and retrieval."""
    
    # Configuration traits
    snapshot_interval = Float(
        default_value=DEFAULT_SNAPSHOT_INTERVAL,
        help="Minimum interval between snapshots in seconds"
    ).tag(config=True)
    
    cleanup_interval = Float(
        default_value=DEFAULT_CLEANUP_INTERVAL,
        help="Interval between cleanup operations in seconds"
    ).tag(config=True)
    
    max_snapshots_per_document = Int(
        default_value=DEFAULT_MAX_SNAPSHOTS,
        help="Maximum number of snapshots to keep per document"
    ).tag(config=True)
    
    inactive_timeout = Float(
        default_value=DEFAULT_INACTIVE_TIMEOUT,
        help="Time in seconds after which inactive snapshots are cleaned up"
    ).tag(config=True)
    
    enable_compression = Bool(
        default_value=True,
        help="Enable compression for snapshot storage"
    ).tag(config=True)
    
    contents_manager = Instance(
        ContentsManager,
        help="The contents manager instance for file operations"
    )
    
    base_directory = Unicode(
        help="Base directory for notebook files"
    )
    
    def __init__(self, contents_manager: ContentsManager, base_directory: str = "", **kwargs):
        super().__init__(**kwargs)
        self.contents_manager = contents_manager
        self.base_directory = base_directory or os.getcwd()
        self.logger = logging.getLogger(__name__)
        
        # In-memory cache for active snapshots
        self._snapshot_cache: Dict[str, CollaborativeSnapshot] = {}
        self._last_snapshot_times: Dict[str, float] = {}
        
        # Cleanup task
        self._cleanup_task: Optional[asyncio.Task] = None
        
        # Lock for thread-safe operations
        self._lock = asyncio.Lock()
        
        self.logger.info(f"Collaborative state manager initialized with base directory: {self.base_directory}")
    
    def _get_snapshot_directory(self, document_path: str) -> str:
        """Get the snapshot directory for a document."""
        # Convert document path to absolute path
        if not os.path.isabs(document_path):
            document_path = os.path.join(self.base_directory, document_path)
        
        # Get the directory containing the notebook file
        notebook_dir = os.path.dirname(document_path)
        
        # Create snapshots directory path
        snapshots_dir = os.path.join(notebook_dir, COLLAB_SNAPSHOTS_DIR)
        
        return snapshots_dir
    
    def _get_document_snapshot_directory(self, document_path: str) -> str:
        """Get the snapshot directory for a specific document."""
        snapshots_dir = self._get_snapshot_directory(document_path)
        
        # Use the notebook filename (without extension) as the subdirectory
        notebook_name = os.path.splitext(os.path.basename(document_path))[0]
        document_snapshots_dir = os.path.join(snapshots_dir, notebook_name)
        
        return document_snapshots_dir
    
    def _generate_snapshot_id(self) -> str:
        """Generate a unique snapshot ID."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        unique_id = str(uuid.uuid4())[:8]
        return f"{timestamp}_{unique_id}"
    
    async def _ensure_snapshot_directory(self, document_path: str) -> str:
        """Ensure the snapshot directory exists."""
        snapshot_dir = self._get_document_snapshot_directory(document_path)
        
        # Create directory if it doesn't exist
        os.makedirs(snapshot_dir, exist_ok=True)
        
        return snapshot_dir
    
    async def create_snapshot(
        self,
        document_id: str,
        document_path: str,
        yjs_state: bytes,
        metadata: Dict[str, Any],
        force: bool = False
    ) -> CollaborativeSnapshot:
        """Create a new collaborative state snapshot."""
        async with self._lock:
            # Check if we should create a snapshot based on timing
            if not force and document_id in self._last_snapshot_times:
                last_snapshot_time = self._last_snapshot_times[document_id]
                if time.time() - last_snapshot_time < self.snapshot_interval:
                    self.logger.debug(f"Skipping snapshot for {document_id} - too soon since last snapshot")
                    # Return the cached snapshot if available
                    if document_id in self._snapshot_cache:
                        return self._snapshot_cache[document_id]
                    raise CollaborativeStateError(
                        f"Snapshot interval not met for document {document_id}"
                    )
            
            # Ensure snapshot directory exists
            snapshot_dir = await self._ensure_snapshot_directory(document_path)
            
            # Generate snapshot ID
            snapshot_id = self._generate_snapshot_id()
            
            # Create snapshot subdirectory
            snapshot_path = os.path.join(snapshot_dir, snapshot_id)
            os.makedirs(snapshot_path, exist_ok=True)
            
            try:
                # Write Yjs state to binary file
                yjs_file_path = os.path.join(snapshot_path, SNAPSHOT_YJS_FILE)
                with open(yjs_file_path, 'wb') as f:
                    f.write(yjs_state)
                
                # Prepare snapshot metadata
                snapshot_metadata = {
                    "document_id": document_id,
                    "snapshot_id": snapshot_id,
                    "created_at": time.time(),
                    "document_path": document_path,
                    "yjs_state_size": len(yjs_state),
                    "metadata": metadata
                }
                
                # Write metadata to JSON file
                metadata_file_path = os.path.join(snapshot_path, SNAPSHOT_METADATA_FILE)
                with open(metadata_file_path, 'w') as f:
                    json.dump(snapshot_metadata, f, indent=2)
                
                # Write collaborative state to JSON file
                state_file_path = os.path.join(snapshot_path, SNAPSHOT_STATE_FILE)
                with open(state_file_path, 'w') as f:
                    json.dump(metadata, f, indent=2)
                
                # Create snapshot object
                snapshot = CollaborativeSnapshot(
                    document_id=document_id,
                    snapshot_id=snapshot_id,
                    yjs_state=yjs_state,
                    metadata=metadata,
                    created_at=snapshot_metadata["created_at"],
                    file_path=snapshot_path
                )
                
                # Update cache and timing
                self._snapshot_cache[document_id] = snapshot
                self._last_snapshot_times[document_id] = time.time()
                
                self.logger.info(f"Created snapshot {snapshot_id} for document {document_id}")
                
                # Clean up old snapshots
                await self._cleanup_old_snapshots(document_path)
                
                return snapshot
                
            except Exception as e:
                # Clean up on error
                if os.path.exists(snapshot_path):
                    import shutil
                    shutil.rmtree(snapshot_path, ignore_errors=True)
                raise CollaborativeStateError(f"Failed to create snapshot: {str(e)}")
    
    async def get_latest_snapshot(self, document_id: str, document_path: str) -> Optional[CollaborativeSnapshot]:
        """Get the latest snapshot for a document."""
        # Check cache first
        if document_id in self._snapshot_cache:
            return self._snapshot_cache[document_id]
        
        # Load from disk
        snapshot_dir = self._get_document_snapshot_directory(document_path)
        
        if not os.path.exists(snapshot_dir):
            return None
        
        # Find the latest snapshot
        latest_snapshot = None
        latest_time = 0
        
        for snapshot_name in os.listdir(snapshot_dir):
            snapshot_path = os.path.join(snapshot_dir, snapshot_name)
            if not os.path.isdir(snapshot_path):
                continue
            
            metadata_file = os.path.join(snapshot_path, SNAPSHOT_METADATA_FILE)
            if not os.path.exists(metadata_file):
                continue
            
            try:
                with open(metadata_file, 'r') as f:
                    metadata = json.load(f)
                
                created_at = metadata.get("created_at", 0)
                if created_at > latest_time:
                    latest_time = created_at
                    latest_snapshot = (snapshot_name, snapshot_path, metadata)
                    
            except (json.JSONDecodeError, IOError) as e:
                self.logger.warning(f"Failed to read snapshot metadata {metadata_file}: {e}")
                continue
        
        if latest_snapshot is None:
            return None
        
        # Load the latest snapshot
        snapshot_name, snapshot_path, metadata = latest_snapshot
        
        try:
            # Load Yjs state
            yjs_file_path = os.path.join(snapshot_path, SNAPSHOT_YJS_FILE)
            yjs_state = b""
            if os.path.exists(yjs_file_path):
                with open(yjs_file_path, 'rb') as f:
                    yjs_state = f.read()
            
            # Load collaborative state
            state_file_path = os.path.join(snapshot_path, SNAPSHOT_STATE_FILE)
            collab_metadata = {}
            if os.path.exists(state_file_path):
                with open(state_file_path, 'r') as f:
                    collab_metadata = json.load(f)
            
            # Create snapshot object
            snapshot = CollaborativeSnapshot(
                document_id=document_id,
                snapshot_id=metadata["snapshot_id"],
                yjs_state=yjs_state,
                metadata=collab_metadata,
                created_at=metadata["created_at"],
                file_path=snapshot_path
            )
            
            # Update cache
            self._snapshot_cache[document_id] = snapshot
            
            return snapshot
            
        except Exception as e:
            self.logger.error(f"Failed to load snapshot {snapshot_name}: {e}")
            return None
    
    async def get_snapshot(self, document_id: str, document_path: str, snapshot_id: str) -> Optional[CollaborativeSnapshot]:
        """Get a specific snapshot by ID."""
        snapshot_dir = self._get_document_snapshot_directory(document_path)
        snapshot_path = os.path.join(snapshot_dir, snapshot_id)
        
        if not os.path.exists(snapshot_path):
            return None
        
        metadata_file = os.path.join(snapshot_path, SNAPSHOT_METADATA_FILE)
        if not os.path.exists(metadata_file):
            return None
        
        try:
            # Load metadata
            with open(metadata_file, 'r') as f:
                metadata = json.load(f)
            
            # Load Yjs state
            yjs_file_path = os.path.join(snapshot_path, SNAPSHOT_YJS_FILE)
            yjs_state = b""
            if os.path.exists(yjs_file_path):
                with open(yjs_file_path, 'rb') as f:
                    yjs_state = f.read()
            
            # Load collaborative state
            state_file_path = os.path.join(snapshot_path, SNAPSHOT_STATE_FILE)
            collab_metadata = {}
            if os.path.exists(state_file_path):
                with open(state_file_path, 'r') as f:
                    collab_metadata = json.load(f)
            
            # Create snapshot object
            snapshot = CollaborativeSnapshot(
                document_id=document_id,
                snapshot_id=snapshot_id,
                yjs_state=yjs_state,
                metadata=collab_metadata,
                created_at=metadata["created_at"],
                file_path=snapshot_path
            )
            
            return snapshot
            
        except Exception as e:
            self.logger.error(f"Failed to load snapshot {snapshot_id}: {e}")
            return None
    
    async def list_snapshots(self, document_id: str, document_path: str) -> List[Dict[str, Any]]:
        """List all snapshots for a document."""
        snapshot_dir = self._get_document_snapshot_directory(document_path)
        
        if not os.path.exists(snapshot_dir):
            return []
        
        snapshots = []
        
        for snapshot_name in os.listdir(snapshot_dir):
            snapshot_path = os.path.join(snapshot_dir, snapshot_name)
            if not os.path.isdir(snapshot_path):
                continue
            
            metadata_file = os.path.join(snapshot_path, SNAPSHOT_METADATA_FILE)
            if not os.path.exists(metadata_file):
                continue
            
            try:
                with open(metadata_file, 'r') as f:
                    metadata = json.load(f)
                
                snapshots.append({
                    "snapshot_id": metadata["snapshot_id"],
                    "created_at": metadata["created_at"],
                    "size": metadata.get("yjs_state_size", 0),
                    "path": snapshot_path
                })
                
            except (json.JSONDecodeError, IOError) as e:
                self.logger.warning(f"Failed to read snapshot metadata {metadata_file}: {e}")
                continue
        
        # Sort by creation time (newest first)
        snapshots.sort(key=lambda x: x["created_at"], reverse=True)
        
        return snapshots
    
    async def delete_snapshot(self, document_id: str, document_path: str, snapshot_id: str) -> bool:
        """Delete a specific snapshot."""
        snapshot_dir = self._get_document_snapshot_directory(document_path)
        snapshot_path = os.path.join(snapshot_dir, snapshot_id)
        
        if not os.path.exists(snapshot_path):
            return False
        
        try:
            import shutil
            shutil.rmtree(snapshot_path)
            
            # Remove from cache if present
            if document_id in self._snapshot_cache:
                cached_snapshot = self._snapshot_cache[document_id]
                if cached_snapshot.snapshot_id == snapshot_id:
                    del self._snapshot_cache[document_id]
            
            self.logger.info(f"Deleted snapshot {snapshot_id} for document {document_id}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to delete snapshot {snapshot_id}: {e}")
            return False
    
    async def _cleanup_old_snapshots(self, document_path: str) -> None:
        """Clean up old snapshots for a document."""
        snapshot_dir = self._get_document_snapshot_directory(document_path)
        
        if not os.path.exists(snapshot_dir):
            return
        
        # Get all snapshots with their metadata
        snapshots = []
        
        for snapshot_name in os.listdir(snapshot_dir):
            snapshot_path = os.path.join(snapshot_dir, snapshot_name)
            if not os.path.isdir(snapshot_path):
                continue
            
            metadata_file = os.path.join(snapshot_path, SNAPSHOT_METADATA_FILE)
            if not os.path.exists(metadata_file):
                continue
            
            try:
                with open(metadata_file, 'r') as f:
                    metadata = json.load(f)
                
                snapshots.append({
                    "snapshot_id": metadata["snapshot_id"],
                    "created_at": metadata["created_at"],
                    "path": snapshot_path
                })
                
            except (json.JSONDecodeError, IOError):
                # Remove invalid snapshot directory
                try:
                    import shutil
                    shutil.rmtree(snapshot_path, ignore_errors=True)
                except Exception:
                    pass
        
        # Sort by creation time (newest first)
        snapshots.sort(key=lambda x: x["created_at"], reverse=True)
        
        # Remove excess snapshots
        if len(snapshots) > self.max_snapshots_per_document:
            excess_snapshots = snapshots[self.max_snapshots_per_document:]
            for snapshot in excess_snapshots:
                try:
                    import shutil
                    shutil.rmtree(snapshot["path"], ignore_errors=True)
                    self.logger.info(f"Removed excess snapshot {snapshot['snapshot_id']}")
                except Exception as e:
                    self.logger.warning(f"Failed to remove excess snapshot {snapshot['snapshot_id']}: {e}")
    
    async def cleanup_expired_snapshots(self) -> None:
        """Clean up expired snapshots across all documents."""
        current_time = time.time()
        removed_count = 0
        
        # Find all snapshot directories
        snapshots_dirs = []
        
        for root, dirs, files in os.walk(self.base_directory):
            if COLLAB_SNAPSHOTS_DIR in dirs:
                snapshots_base = os.path.join(root, COLLAB_SNAPSHOTS_DIR)
                if os.path.exists(snapshots_base):
                    for doc_dir in os.listdir(snapshots_base):
                        doc_snapshots_dir = os.path.join(snapshots_base, doc_dir)
                        if os.path.isdir(doc_snapshots_dir):
                            snapshots_dirs.append(doc_snapshots_dir)
        
        # Process each document's snapshots
        for doc_snapshots_dir in snapshots_dirs:
            try:
                for snapshot_name in os.listdir(doc_snapshots_dir):
                    snapshot_path = os.path.join(doc_snapshots_dir, snapshot_name)
                    if not os.path.isdir(snapshot_path):
                        continue
                    
                    metadata_file = os.path.join(snapshot_path, SNAPSHOT_METADATA_FILE)
                    if not os.path.exists(metadata_file):
                        continue
                    
                    try:
                        with open(metadata_file, 'r') as f:
                            metadata = json.load(f)
                        
                        created_at = metadata.get("created_at", 0)
                        if current_time - created_at > self.inactive_timeout:
                            # Remove expired snapshot
                            import shutil
                            shutil.rmtree(snapshot_path, ignore_errors=True)
                            removed_count += 1
                            self.logger.info(f"Removed expired snapshot {snapshot_name}")
                        
                    except (json.JSONDecodeError, IOError):
                        # Remove invalid snapshot
                        import shutil
                        shutil.rmtree(snapshot_path, ignore_errors=True)
                        removed_count += 1
                        self.logger.info(f"Removed invalid snapshot {snapshot_name}")
                
            except Exception as e:
                self.logger.warning(f"Error processing snapshots in {doc_snapshots_dir}: {e}")
        
        if removed_count > 0:
            self.logger.info(f"Cleanup completed: removed {removed_count} expired snapshots")
    
    async def restore_document_state(self, document_id: str, document_path: str) -> Optional[Dict[str, Any]]:
        """Restore collaborative state for a document from the latest snapshot."""
        snapshot = await self.get_latest_snapshot(document_id, document_path)
        
        if snapshot is None:
            self.logger.info(f"No snapshot found for document {document_id}")
            return None
        
        # Return the collaborative state
        restored_state = {
            "document_id": document_id,
            "snapshot_id": snapshot.snapshot_id,
            "yjs_state": snapshot.yjs_state,
            "metadata": snapshot.metadata,
            "restored_at": time.time(),
            "original_created_at": snapshot.created_at
        }
        
        self.logger.info(f"Restored collaborative state for document {document_id} from snapshot {snapshot.snapshot_id}")
        
        return restored_state
    
    def start_cleanup_task(self) -> None:
        """Start the periodic cleanup task."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            self.logger.info("Started collaborative state cleanup task")
    
    def stop_cleanup_task(self) -> None:
        """Stop the periodic cleanup task."""
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            self.logger.info("Stopped collaborative state cleanup task")
    
    async def _cleanup_loop(self) -> None:
        """Periodic cleanup loop."""
        while True:
            try:
                await asyncio.sleep(self.cleanup_interval)
                await self.cleanup_expired_snapshots()
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in cleanup loop: {e}")
    
    async def get_storage_stats(self) -> Dict[str, Any]:
        """Get storage statistics for collaborative state."""
        stats = {
            "total_snapshots": 0,
            "total_size": 0,
            "documents_with_snapshots": 0,
            "oldest_snapshot": None,
            "newest_snapshot": None
        }
        
        oldest_time = float('inf')
        newest_time = 0
        
        # Find all snapshot directories
        for root, dirs, files in os.walk(self.base_directory):
            if COLLAB_SNAPSHOTS_DIR in dirs:
                snapshots_base = os.path.join(root, COLLAB_SNAPSHOTS_DIR)
                if os.path.exists(snapshots_base):
                    for doc_dir in os.listdir(snapshots_base):
                        doc_snapshots_dir = os.path.join(snapshots_base, doc_dir)
                        if os.path.isdir(doc_snapshots_dir):
                            has_snapshots = False
                            
                            for snapshot_name in os.listdir(doc_snapshots_dir):
                                snapshot_path = os.path.join(doc_snapshots_dir, snapshot_name)
                                if not os.path.isdir(snapshot_path):
                                    continue
                                
                                metadata_file = os.path.join(snapshot_path, SNAPSHOT_METADATA_FILE)
                                if not os.path.exists(metadata_file):
                                    continue
                                
                                try:
                                    with open(metadata_file, 'r') as f:
                                        metadata = json.load(f)
                                    
                                    stats["total_snapshots"] += 1
                                    stats["total_size"] += metadata.get("yjs_state_size", 0)
                                    has_snapshots = True
                                    
                                    created_at = metadata.get("created_at", 0)
                                    if created_at < oldest_time:
                                        oldest_time = created_at
                                        stats["oldest_snapshot"] = datetime.fromtimestamp(created_at).isoformat()
                                    
                                    if created_at > newest_time:
                                        newest_time = created_at
                                        stats["newest_snapshot"] = datetime.fromtimestamp(created_at).isoformat()
                                
                                except (json.JSONDecodeError, IOError):
                                    pass
                            
                            if has_snapshots:
                                stats["documents_with_snapshots"] += 1
        
        return stats
    
    def invalidate_cache(self, document_id: str) -> None:
        """Invalidate cached snapshot for a document."""
        if document_id in self._snapshot_cache:
            del self._snapshot_cache[document_id]
        
        if document_id in self._last_snapshot_times:
            del self._last_snapshot_times[document_id]
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        return {
            "cached_snapshots": len(self._snapshot_cache),
            "last_snapshot_times": len(self._last_snapshot_times),
            "cache_memory_usage": sum(
                len(snapshot.yjs_state) + len(json.dumps(snapshot.metadata).encode())
                for snapshot in self._snapshot_cache.values()
            )
        }


# Global instance holder
_state_manager_instance: Optional[CollaborativeStateManager] = None


def get_collaborative_state_manager(
    contents_manager: Optional[ContentsManager] = None,
    base_directory: str = ""
) -> CollaborativeStateManager:
    """Get or create the global collaborative state manager instance."""
    global _state_manager_instance
    
    if _state_manager_instance is None:
        if contents_manager is None:
            raise ValueError("Contents manager is required for first-time initialization")
        
        _state_manager_instance = CollaborativeStateManager(
            contents_manager=contents_manager,
            base_directory=base_directory
        )
        
        # Start cleanup task
        _state_manager_instance.start_cleanup_task()
    
    return _state_manager_instance


def cleanup_collaborative_state_manager() -> None:
    """Clean up the global collaborative state manager instance."""
    global _state_manager_instance
    
    if _state_manager_instance is not None:
        _state_manager_instance.stop_cleanup_task()
        _state_manager_instance = None