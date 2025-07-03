"""
Notebook Services Contents Module

This module provides the core services for managing collaborative state coordination,
file locking, and document synchronization in Jupyter Notebook v7's real-time 
collaborative editing system.

Key Components:
- CollaborationSessionManager: Manages active collaboration sessions and client connections
- ContentLockManager: Handles cell-level locking during collaborative editing
- CollaborativeStateManager: Manages collaborative state persistence and synchronization
- SnapshotManager: Handles Yjs document snapshot creation and persistence
- CommentManager: Manages comment data storage alongside notebook content

This module serves as the entry point for importing collaborative backend services
and establishes the namespace for file locking and collaborative state management.

Architecture Integration:
- Integrates with YjsProtocolHandler for CRDT synchronization
- Provides backend support for frontend collaboration features
- Ensures backward compatibility with single-user workflows
- Maintains .ipynb file format compatibility

Usage:
    from notebook.services.contents import (
        CollaborationSessionManager,
        ContentLockManager,
        CollaborativeStateManager
    )
"""

import logging
from typing import Dict, Any, Optional, List, Set
import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

# Configure logging for the contents module
logger = logging.getLogger(__name__)

__version__ = "1.0.0"
__all__ = [
    "CollaborationSessionManager",
    "ContentLockManager", 
    "CollaborativeStateManager",
    "SnapshotManager",
    "CommentManager",
    "CollaborationError",
    "LockError",
    "PermissionError",
    "SessionError"
]

# Custom exception classes for collaboration features
class CollaborationError(Exception):
    """Base exception for collaboration-related errors"""
    pass

class LockError(CollaborationError):
    """Exception raised when cell locking operations fail"""
    pass

class PermissionError(CollaborationError):
    """Exception raised when permission validation fails"""
    pass

class SessionError(CollaborationError):
    """Exception raised when session management operations fail"""
    pass

# Session management for collaborative editing
class CollaborationSessionManager:
    """
    Manages active collaboration sessions and client connections.
    
    This class handles the lifecycle of collaborative editing sessions,
    including client tracking, session metadata, and connection management.
    Designed to handle hundreds of concurrent collaborative sessions.
    """
    
    def __init__(self, max_sessions: int = 1000):
        self.max_sessions = max_sessions
        self.active_sessions: Dict[str, Dict[str, Any]] = {}
        self.client_connections: Dict[str, Set[str]] = {}
        self.session_metadata: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        logger.info(f"CollaborationSessionManager initialized with max_sessions={max_sessions}")
    
    async def create_session(self, document_id: str, user_id: str, 
                           permissions: Dict[str, Any]) -> str:
        """
        Create a new collaboration session for a document.
        
        Args:
            document_id: Unique identifier for the document
            user_id: User creating the session
            permissions: Permission configuration for the session
            
        Returns:
            session_id: Unique identifier for the created session
            
        Raises:
            SessionError: If session creation fails or limits exceeded
        """
        async with self._lock:
            if len(self.active_sessions) >= self.max_sessions:
                raise SessionError(f"Maximum session limit ({self.max_sessions}) exceeded")
            
            session_id = f"session_{document_id}_{int(time.time())}"
            
            session_data = {
                "document_id": document_id,
                "creator_id": user_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "permissions": permissions,
                "clients": set(),
                "locks": {},
                "last_activity": time.time()
            }
            
            self.active_sessions[session_id] = session_data
            self.client_connections[session_id] = set()
            self.session_metadata[session_id] = {
                "document_path": document_id,
                "collaboration_enabled": True,
                "snapshot_version": 0
            }
            
            logger.info(f"Created collaboration session {session_id} for document {document_id}")
            return session_id
    
    async def join_session(self, session_id: str, client_id: str, 
                          user_id: str) -> Dict[str, Any]:
        """
        Add a client to an existing collaboration session.
        
        Args:
            session_id: Session to join
            client_id: Unique client identifier
            user_id: User identifier
            
        Returns:
            session_info: Current session state and metadata
            
        Raises:
            SessionError: If session doesn't exist or join fails
        """
        async with self._lock:
            if session_id not in self.active_sessions:
                raise SessionError(f"Session {session_id} not found")
            
            session = self.active_sessions[session_id]
            session["clients"].add(client_id)
            session["last_activity"] = time.time()
            
            self.client_connections[session_id].add(client_id)
            
            session_info = {
                "session_id": session_id,
                "document_id": session["document_id"],
                "permissions": session["permissions"],
                "active_clients": list(session["clients"]),
                "locks": session["locks"],
                "metadata": self.session_metadata[session_id]
            }
            
            logger.info(f"Client {client_id} joined session {session_id}")
            return session_info
    
    async def leave_session(self, session_id: str, client_id: str) -> None:
        """
        Remove a client from a collaboration session.
        
        Args:
            session_id: Session to leave
            client_id: Client identifier to remove
        """
        async with self._lock:
            if session_id in self.active_sessions:
                session = self.active_sessions[session_id]
                session["clients"].discard(client_id)
                session["last_activity"] = time.time()
                
                if session_id in self.client_connections:
                    self.client_connections[session_id].discard(client_id)
                
                # Clean up empty sessions
                if not session["clients"]:
                    await self._cleanup_session(session_id)
                
                logger.info(f"Client {client_id} left session {session_id}")
    
    async def _cleanup_session(self, session_id: str) -> None:
        """Clean up an empty collaboration session"""
        if session_id in self.active_sessions:
            del self.active_sessions[session_id]
        if session_id in self.client_connections:
            del self.client_connections[session_id]
        if session_id in self.session_metadata:
            del self.session_metadata[session_id]
        
        logger.info(f"Cleaned up empty session {session_id}")
    
    def get_session_count(self) -> int:
        """Get the current number of active sessions"""
        return len(self.active_sessions)
    
    def get_client_count(self, session_id: str) -> int:
        """Get the number of clients in a specific session"""
        if session_id in self.active_sessions:
            return len(self.active_sessions[session_id]["clients"])
        return 0

# Cell-level locking for collaborative editing
class ContentLockManager:
    """
    Manages cell-level locking to prevent conflicting simultaneous edits.
    
    Implements distributed lock management with deadlock prevention,
    race condition handling, and automatic timeout mechanisms.
    """
    
    def __init__(self, default_timeout: float = 300.0):  # 5 minutes default
        self.default_timeout = default_timeout
        self.locks: Dict[str, Dict[str, Any]] = {}
        self.lock_timers: Dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()
        logger.info(f"ContentLockManager initialized with default_timeout={default_timeout}")
    
    async def acquire_lock(self, document_id: str, cell_id: str, 
                          user_id: str, timeout: Optional[float] = None) -> bool:
        """
        Acquire a lock on a specific cell.
        
        Args:
            document_id: Document containing the cell
            cell_id: Cell to lock
            user_id: User requesting the lock
            timeout: Lock timeout in seconds (uses default if None)
            
        Returns:
            success: True if lock acquired successfully
            
        Raises:
            LockError: If lock acquisition fails
        """
        async with self._lock:
            lock_key = f"{document_id}:{cell_id}"
            lock_timeout = timeout or self.default_timeout
            
            # Check if cell is already locked by another user
            if lock_key in self.locks:
                existing_lock = self.locks[lock_key]
                if existing_lock["user_id"] != user_id:
                    if time.time() < existing_lock["expires_at"]:
                        logger.warning(f"Cell {cell_id} already locked by {existing_lock['user_id']}")
                        return False
                    else:
                        # Lock expired, clean it up
                        await self._release_lock_internal(lock_key)
            
            # Acquire the lock
            expires_at = time.time() + lock_timeout
            lock_data = {
                "document_id": document_id,
                "cell_id": cell_id,
                "user_id": user_id,
                "acquired_at": time.time(),
                "expires_at": expires_at,
                "timeout": lock_timeout
            }
            
            self.locks[lock_key] = lock_data
            
            # Set up automatic lock release timer
            timer_task = asyncio.create_task(self._auto_release_lock(lock_key, lock_timeout))
            self.lock_timers[lock_key] = timer_task
            
            logger.info(f"Acquired lock on cell {cell_id} for user {user_id}")
            return True
    
    async def release_lock(self, document_id: str, cell_id: str, 
                          user_id: str) -> bool:
        """
        Release a lock on a specific cell.
        
        Args:
            document_id: Document containing the cell
            cell_id: Cell to unlock
            user_id: User releasing the lock
            
        Returns:
            success: True if lock released successfully
        """
        async with self._lock:
            lock_key = f"{document_id}:{cell_id}"
            
            if lock_key not in self.locks:
                logger.warning(f"No lock found for cell {cell_id}")
                return False
            
            lock_data = self.locks[lock_key]
            if lock_data["user_id"] != user_id:
                logger.warning(f"Lock on cell {cell_id} owned by {lock_data['user_id']}, not {user_id}")
                return False
            
            await self._release_lock_internal(lock_key)
            logger.info(f"Released lock on cell {cell_id} for user {user_id}")
            return True
    
    async def _release_lock_internal(self, lock_key: str) -> None:
        """Internal method to release a lock and clean up timers"""
        if lock_key in self.locks:
            del self.locks[lock_key]
        
        if lock_key in self.lock_timers:
            timer_task = self.lock_timers[lock_key]
            if not timer_task.done():
                timer_task.cancel()
            del self.lock_timers[lock_key]
    
    async def _auto_release_lock(self, lock_key: str, timeout: float) -> None:
        """Automatically release a lock after timeout"""
        try:
            await asyncio.sleep(timeout)
            async with self._lock:
                if lock_key in self.locks:
                    lock_data = self.locks[lock_key]
                    logger.info(f"Auto-releasing expired lock on cell {lock_data['cell_id']}")
                    await self._release_lock_internal(lock_key)
        except asyncio.CancelledError:
            # Lock was released manually before timeout
            pass
    
    def get_lock_status(self, document_id: str, cell_id: str) -> Optional[Dict[str, Any]]:
        """
        Get the current lock status for a cell.
        
        Args:
            document_id: Document containing the cell
            cell_id: Cell to check
            
        Returns:
            lock_info: Lock information if cell is locked, None otherwise
        """
        lock_key = f"{document_id}:{cell_id}"
        if lock_key in self.locks:
            lock_data = self.locks[lock_key].copy()
            lock_data["is_expired"] = time.time() > lock_data["expires_at"]
            return lock_data
        return None
    
    def get_user_locks(self, user_id: str) -> List[Dict[str, Any]]:
        """Get all locks currently held by a specific user"""
        user_locks = []
        for lock_key, lock_data in self.locks.items():
            if lock_data["user_id"] == user_id:
                lock_info = lock_data.copy()
                lock_info["is_expired"] = time.time() > lock_data["expires_at"]
                user_locks.append(lock_info)
        return user_locks

# Collaborative state management
class CollaborativeStateManager:
    """
    Manages collaborative state persistence and synchronization.
    
    Handles the coordination between file operations and collaborative
    editing state, ensuring consistency and providing recovery mechanisms.
    """
    
    def __init__(self, storage_path: Optional[Path] = None):
        self.storage_path = storage_path or Path(".jupyter_collab_state")
        self.document_states: Dict[str, Dict[str, Any]] = {}
        self.state_locks: Dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()
        
        # Ensure storage directory exists
        self.storage_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"CollaborativeStateManager initialized with storage_path={self.storage_path}")
    
    async def initialize_document_state(self, document_id: str, 
                                      initial_content: Dict[str, Any]) -> None:
        """
        Initialize collaborative state for a document.
        
        Args:
            document_id: Unique document identifier
            initial_content: Initial notebook content
        """
        async with self._global_lock:
            if document_id not in self.state_locks:
                self.state_locks[document_id] = asyncio.Lock()
        
        async with self.state_locks[document_id]:
            state_data = {
                "document_id": document_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "last_modified": datetime.now(timezone.utc).isoformat(),
                "content_hash": self._compute_content_hash(initial_content),
                "active_collaborators": set(),
                "pending_changes": [],
                "sync_version": 0,
                "metadata": {
                    "collaboration_enabled": True,
                    "permissions": {},
                    "comments": {},
                    "history": []
                }
            }
            
            self.document_states[document_id] = state_data
            await self._persist_state(document_id, state_data)
            logger.info(f"Initialized collaborative state for document {document_id}")
    
    async def update_document_state(self, document_id: str, 
                                   changes: Dict[str, Any]) -> None:
        """
        Update collaborative state with new changes.
        
        Args:
            document_id: Document to update
            changes: Changes to apply to the state
        """
        if document_id not in self.state_locks:
            raise SessionError(f"Document {document_id} not initialized")
        
        async with self.state_locks[document_id]:
            if document_id not in self.document_states:
                raise SessionError(f"Document state {document_id} not found")
            
            state = self.document_states[document_id]
            state["last_modified"] = datetime.now(timezone.utc).isoformat()
            state["sync_version"] += 1
            
            # Apply changes
            for key, value in changes.items():
                if key in state:
                    if key == "active_collaborators" and isinstance(value, (list, set)):
                        state[key] = set(value)
                    elif key == "pending_changes" and isinstance(value, list):
                        state[key].extend(value)
                    elif key == "metadata" and isinstance(value, dict):
                        state[key].update(value)
                    else:
                        state[key] = value
            
            await self._persist_state(document_id, state)
            logger.debug(f"Updated collaborative state for document {document_id}")
    
    async def get_document_state(self, document_id: str) -> Optional[Dict[str, Any]]:
        """
        Get current collaborative state for a document.
        
        Args:
            document_id: Document to retrieve state for
            
        Returns:
            state: Current collaborative state or None if not found
        """
        if document_id not in self.state_locks:
            return None
        
        async with self.state_locks[document_id]:
            state = self.document_states.get(document_id)
            if state:
                # Return a copy to prevent external modifications
                state_copy = state.copy()
                state_copy["active_collaborators"] = list(state["active_collaborators"])
                return state_copy
            return None
    
    async def cleanup_document_state(self, document_id: str) -> None:
        """
        Clean up collaborative state for a document.
        
        Args:
            document_id: Document to clean up
        """
        async with self._global_lock:
            if document_id in self.state_locks:
                async with self.state_locks[document_id]:
                    if document_id in self.document_states:
                        del self.document_states[document_id]
                    
                    # Remove persisted state file
                    state_file = self.storage_path / f"{document_id}.json"
                    if state_file.exists():
                        state_file.unlink()
                
                del self.state_locks[document_id]
                logger.info(f"Cleaned up collaborative state for document {document_id}")
    
    def _compute_content_hash(self, content: Dict[str, Any]) -> str:
        """Compute a hash of the notebook content for change detection"""
        import hashlib
        content_str = json.dumps(content, sort_keys=True, separators=(',', ':'))
        return hashlib.sha256(content_str.encode()).hexdigest()
    
    async def _persist_state(self, document_id: str, state_data: Dict[str, Any]) -> None:
        """Persist collaborative state to disk"""
        try:
            state_file = self.storage_path / f"{document_id}.json"
            
            # Convert sets to lists for JSON serialization
            serializable_state = state_data.copy()
            serializable_state["active_collaborators"] = list(state_data["active_collaborators"])
            
            with open(state_file, 'w') as f:
                json.dump(serializable_state, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to persist state for document {document_id}: {e}")

# Yjs document snapshot management
class SnapshotManager:
    """
    Handles Yjs document snapshot creation and persistence.
    
    Manages periodic snapshots of collaborative document state for
    recovery and synchronization purposes.
    """
    
    def __init__(self, storage_path: Optional[Path] = None, 
                 snapshot_interval: int = 300):  # 5 minutes default
        self.storage_path = storage_path or Path(".jupyter_snapshots")
        self.snapshot_interval = snapshot_interval
        self.snapshots: Dict[str, List[Dict[str, Any]]] = {}
        self._lock = asyncio.Lock()
        
        # Ensure storage directory exists
        self.storage_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"SnapshotManager initialized with interval={snapshot_interval}s")
    
    async def create_snapshot(self, document_id: str, yjs_state: bytes,
                            version: int, user_id: str) -> str:
        """
        Create a snapshot of the current Yjs document state.
        
        Args:
            document_id: Document identifier
            yjs_state: Serialized Yjs document state
            version: Version number
            user_id: User triggering the snapshot
            
        Returns:
            snapshot_id: Unique identifier for the created snapshot
        """
        async with self._lock:
            timestamp = datetime.now(timezone.utc)
            snapshot_id = f"snapshot_{document_id}_{version}_{int(timestamp.timestamp())}"
            
            snapshot_data = {
                "snapshot_id": snapshot_id,
                "document_id": document_id,
                "version": version,
                "timestamp": timestamp.isoformat(),
                "user_id": user_id,
                "yjs_state_size": len(yjs_state),
                "metadata": {
                    "created_by": user_id,
                    "auto_snapshot": True
                }
            }
            
            # Store snapshot data
            if document_id not in self.snapshots:
                self.snapshots[document_id] = []
            
            self.snapshots[document_id].append(snapshot_data)
            
            # Persist Yjs state to disk
            snapshot_file = self.storage_path / f"{snapshot_id}.yjs"
            with open(snapshot_file, 'wb') as f:
                f.write(yjs_state)
            
            # Persist metadata
            metadata_file = self.storage_path / f"{snapshot_id}.json"
            with open(metadata_file, 'w') as f:
                json.dump(snapshot_data, f, indent=2)
            
            logger.info(f"Created snapshot {snapshot_id} for document {document_id}")
            return snapshot_id
    
    async def get_latest_snapshot(self, document_id: str) -> Optional[Dict[str, Any]]:
        """
        Get the latest snapshot for a document.
        
        Args:
            document_id: Document to get snapshot for
            
        Returns:
            snapshot_data: Latest snapshot information or None
        """
        async with self._lock:
            if document_id in self.snapshots and self.snapshots[document_id]:
                return self.snapshots[document_id][-1].copy()
            return None
    
    async def load_snapshot_state(self, snapshot_id: str) -> Optional[bytes]:
        """
        Load the Yjs state from a snapshot.
        
        Args:
            snapshot_id: Snapshot to load
            
        Returns:
            yjs_state: Serialized Yjs document state or None
        """
        try:
            snapshot_file = self.storage_path / f"{snapshot_id}.yjs"
            if snapshot_file.exists():
                with open(snapshot_file, 'rb') as f:
                    return f.read()
        except Exception as e:
            logger.error(f"Failed to load snapshot {snapshot_id}: {e}")
        return None
    
    async def cleanup_old_snapshots(self, document_id: str, keep_count: int = 10) -> None:
        """
        Clean up old snapshots, keeping only the most recent ones.
        
        Args:
            document_id: Document to clean up snapshots for
            keep_count: Number of snapshots to keep
        """
        async with self._lock:
            if document_id in self.snapshots:
                snapshots = self.snapshots[document_id]
                if len(snapshots) > keep_count:
                    to_remove = snapshots[:-keep_count]
                    self.snapshots[document_id] = snapshots[-keep_count:]
                    
                    # Remove files
                    for snapshot in to_remove:
                        snapshot_id = snapshot["snapshot_id"]
                        
                        yjs_file = self.storage_path / f"{snapshot_id}.yjs"
                        if yjs_file.exists():
                            yjs_file.unlink()
                        
                        metadata_file = self.storage_path / f"{snapshot_id}.json"
                        if metadata_file.exists():
                            metadata_file.unlink()
                    
                    logger.info(f"Cleaned up {len(to_remove)} old snapshots for document {document_id}")

# Comment management for collaborative features
class CommentManager:
    """
    Manages comment data storage alongside notebook content.
    
    Provides CRUD operations for comments with persistence,
    supporting threaded discussions and comment resolution workflow.
    """
    
    def __init__(self, storage_path: Optional[Path] = None):
        self.storage_path = storage_path or Path(".jupyter_comments")
        self.comments: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        
        # Ensure storage directory exists
        self.storage_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"CommentManager initialized with storage_path={self.storage_path}")
    
    async def create_comment(self, document_id: str, cell_id: str,
                           user_id: str, content: str, 
                           parent_id: Optional[str] = None) -> str:
        """
        Create a new comment on a cell.
        
        Args:
            document_id: Document containing the cell
            cell_id: Cell to comment on
            user_id: User creating the comment
            content: Comment content
            parent_id: Parent comment ID for threaded replies
            
        Returns:
            comment_id: Unique identifier for the created comment
        """
        async with self._lock:
            comment_id = f"comment_{document_id}_{cell_id}_{int(time.time())}"
            
            comment_data = {
                "comment_id": comment_id,
                "document_id": document_id,
                "cell_id": cell_id,
                "user_id": user_id,
                "content": content,
                "parent_id": parent_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "resolved": False,
                "replies": []
            }
            
            # Store comment
            doc_key = f"{document_id}:{cell_id}"
            if doc_key not in self.comments:
                self.comments[doc_key] = {}
            
            self.comments[doc_key][comment_id] = comment_data
            
            # If this is a reply, add to parent's replies list
            if parent_id:
                parent_key = self._find_comment_key(document_id, parent_id)
                if parent_key:
                    parent_comment = self.comments[parent_key[0]][parent_key[1]]
                    parent_comment["replies"].append(comment_id)
            
            # Persist to disk
            await self._persist_comments(doc_key)
            
            logger.info(f"Created comment {comment_id} on cell {cell_id}")
            return comment_id
    
    async def update_comment(self, comment_id: str, user_id: str, 
                           content: str) -> bool:
        """
        Update an existing comment.
        
        Args:
            comment_id: Comment to update
            user_id: User updating the comment
            content: New comment content
            
        Returns:
            success: True if comment was updated successfully
        """
        async with self._lock:
            comment_key = self._find_comment_key_by_id(comment_id)
            if not comment_key:
                return False
            
            doc_key, comment_data = comment_key
            
            # Verify user can update this comment
            if comment_data["user_id"] != user_id:
                return False
            
            # Update comment
            comment_data["content"] = content
            comment_data["updated_at"] = datetime.now(timezone.utc).isoformat()
            
            # Persist to disk
            await self._persist_comments(doc_key)
            
            logger.info(f"Updated comment {comment_id}")
            return True
    
    async def resolve_comment(self, comment_id: str, user_id: str) -> bool:
        """
        Mark a comment as resolved.
        
        Args:
            comment_id: Comment to resolve
            user_id: User resolving the comment
            
        Returns:
            success: True if comment was resolved successfully
        """
        async with self._lock:
            comment_key = self._find_comment_key_by_id(comment_id)
            if not comment_key:
                return False
            
            doc_key, comment_data = comment_key
            
            # Update resolution status
            comment_data["resolved"] = True
            comment_data["resolved_by"] = user_id
            comment_data["resolved_at"] = datetime.now(timezone.utc).isoformat()
            comment_data["updated_at"] = datetime.now(timezone.utc).isoformat()
            
            # Persist to disk
            await self._persist_comments(doc_key)
            
            logger.info(f"Resolved comment {comment_id}")
            return True
    
    async def get_cell_comments(self, document_id: str, cell_id: str) -> List[Dict[str, Any]]:
        """
        Get all comments for a specific cell.
        
        Args:
            document_id: Document containing the cell
            cell_id: Cell to get comments for
            
        Returns:
            comments: List of comment data
        """
        async with self._lock:
            doc_key = f"{document_id}:{cell_id}"
            if doc_key in self.comments:
                return list(self.comments[doc_key].values())
            return []
    
    async def get_document_comments(self, document_id: str) -> Dict[str, List[Dict[str, Any]]]:
        """
        Get all comments for a document, organized by cell.
        
        Args:
            document_id: Document to get comments for
            
        Returns:
            comments: Dictionary mapping cell_id to list of comments
        """
        async with self._lock:
            doc_comments = {}
            for doc_key, comments in self.comments.items():
                if doc_key.startswith(f"{document_id}:"):
                    cell_id = doc_key.split(":", 1)[1]
                    doc_comments[cell_id] = list(comments.values())
            return doc_comments
    
    def _find_comment_key(self, document_id: str, comment_id: str) -> Optional[tuple]:
        """Find the storage key for a comment"""
        for doc_key, comments in self.comments.items():
            if doc_key.startswith(f"{document_id}:"):
                if comment_id in comments:
                    return (doc_key, comment_id)
        return None
    
    def _find_comment_key_by_id(self, comment_id: str) -> Optional[tuple]:
        """Find the storage key and comment data for a comment ID"""
        for doc_key, comments in self.comments.items():
            if comment_id in comments:
                return (doc_key, comments[comment_id])
        return None
    
    async def _persist_comments(self, doc_key: str) -> None:
        """Persist comments for a document/cell to disk"""
        try:
            comments_file = self.storage_path / f"{doc_key.replace(':', '_')}.json"
            with open(comments_file, 'w') as f:
                json.dump(self.comments[doc_key], f, indent=2)
        except Exception as e:
            logger.error(f"Failed to persist comments for {doc_key}: {e}")

# Module initialization
def initialize_contents_services(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Initialize the contents services with configuration.
    
    Args:
        config: Configuration dictionary for services
        
    Returns:
        services: Dictionary of initialized service instances
    """
    config = config or {}
    
    # Initialize services with configuration
    session_manager = CollaborationSessionManager(
        max_sessions=config.get("max_sessions", 1000)
    )
    
    lock_manager = ContentLockManager(
        default_timeout=config.get("lock_timeout", 300.0)
    )
    
    state_manager = CollaborativeStateManager(
        storage_path=config.get("state_storage_path")
    )
    
    snapshot_manager = SnapshotManager(
        storage_path=config.get("snapshot_storage_path"),
        snapshot_interval=config.get("snapshot_interval", 300)
    )
    
    comment_manager = CommentManager(
        storage_path=config.get("comment_storage_path")
    )
    
    services = {
        "session_manager": session_manager,
        "lock_manager": lock_manager,
        "state_manager": state_manager,
        "snapshot_manager": snapshot_manager,
        "comment_manager": comment_manager
    }
    
    logger.info("Contents services initialized successfully")
    return services

# Graceful shutdown for services
async def shutdown_contents_services(services: Dict[str, Any]) -> None:
    """
    Gracefully shutdown all contents services.
    
    Args:
        services: Dictionary of service instances to shutdown
    """
    try:
        # Cancel any pending tasks and cleanup resources
        if "lock_manager" in services:
            lock_manager = services["lock_manager"]
            for timer_task in lock_manager.lock_timers.values():
                if not timer_task.done():
                    timer_task.cancel()
        
        logger.info("Contents services shutdown completed")
    except Exception as e:
        logger.error(f"Error during contents services shutdown: {e}")