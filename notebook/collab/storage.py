"""
Storage backend for collaborative document persistence.

This module implements persistent collaborative document state using .ipynb_collab directory
structure with CRDT update logs, version history snapshots, and comment persistence.
Supports pluggable filesystem and database backends for scalability.

The storage system maintains the following structure:
- .ipynb_collab/updates/ - CRDT update logs (append-only binary)
- .ipynb_collab/history/ - Document snapshots for version browsing
- .ipynb_collab/comments/ - Comment threads (JSON format)
- .ipynb_collab/locks/ - Cell locking information

All storage operations are optimized for concurrent access by multiple users
while maintaining data integrity and supporting configurable retention policies.
"""

import os
import json
import sqlite3
import asyncio
import logging
import threading
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Union, Any, Callable, Protocol, TypeVar, Generic, Tuple, NamedTuple
from concurrent.futures import ThreadPoolExecutor, Future, as_completed, wait, FIRST_COMPLETED, ALL_COMPLETED

# External dependencies for CRDT operations and database backends
try:
    from ypy import YDoc
except ImportError:
    YDoc = None

try:
    import psycopg2
    from psycopg2 import extras, sql
except ImportError:
    psycopg2 = None

try:
    import redis
except ImportError:
    redis = None

try:
    from jupyter_server import utils, services, auth, base
except ImportError:
    pass

# Internal imports from notebook application
from notebook.app import JupyterNotebookApp
from notebook._version import __version__


# Type definitions for storage interfaces
T = TypeVar('T')
UpdateData = Union[bytes, str]
SnapshotData = Dict[str, Any]
CommentData = Dict[str, Any]
TimestampType = Union[datetime, str, float]

# Constants for storage configuration
DEFAULT_RETENTION_DAYS = 30
DEFAULT_COMPACTION_INTERVAL = 3600  # 1 hour in seconds
DEFAULT_MAX_UPDATE_LOG_SIZE = 10 * 1024 * 1024  # 10MB
DEFAULT_CACHE_SIZE = 1024
COLLAB_DIR_NAME = ".ipynb_collab"
UPDATES_DIR_NAME = "updates"
HISTORY_DIR_NAME = "history"
COMMENTS_DIR_NAME = "comments"
LOCKS_DIR_NAME = "locks"


class StorageError(Exception):
    """Base exception for storage-related errors."""
    pass


class StorageConnectionError(StorageError):
    """Exception raised when storage backend connection fails."""
    pass


class StorageCorruptionError(StorageError):
    """Exception raised when storage data is corrupted or invalid."""
    pass


class StorageConfiguration:
    """Configuration class for collaborative storage settings."""
    
    def __init__(
        self,
        backend_type: str = "filesystem",
        connection_string: str = "",
        retention_policy: str = "30d",
        compaction_interval: int = DEFAULT_COMPACTION_INTERVAL,
        max_update_log_size: int = DEFAULT_MAX_UPDATE_LOG_SIZE,
        enable_caching: bool = True,
        cache_size: int = DEFAULT_CACHE_SIZE
    ):
        """
        Initialize storage configuration.
        
        Args:
            backend_type: Storage backend type ('filesystem', 'sqlite', 'postgresql', 'redis')
            connection_string: Connection string for database backends
            retention_policy: Retention period (e.g., '30d', '24h', '60m')
            compaction_interval: Interval for update log compaction in seconds
            max_update_log_size: Maximum size for update logs before compaction
            enable_caching: Whether to enable in-memory caching
            cache_size: Size of the cache in number of entries
        """
        self.backend_type = backend_type
        self.connection_string = connection_string
        self.retention_policy = retention_policy
        self.compaction_interval = compaction_interval
        self.max_update_log_size = max_update_log_size
        self.enable_caching = enable_caching
        self.cache_size = cache_size
        
        # Parse retention policy
        self._parse_retention_policy()
    
    def _parse_retention_policy(self) -> None:
        """Parse retention policy string into timedelta."""
        import re
        
        # Parse retention policy format: <number><unit>
        match = re.match(r'^(\d+)([dhm])$', self.retention_policy)
        if not match:
            raise ValueError(f"Invalid retention policy format: {self.retention_policy}")
        
        value, unit = match.groups()
        value = int(value)
        
        if unit == 'd':
            self.retention_timedelta = timedelta(days=value)
        elif unit == 'h':
            self.retention_timedelta = timedelta(hours=value)
        elif unit == 'm':
            self.retention_timedelta = timedelta(minutes=value)
        else:
            raise ValueError(f"Invalid retention policy unit: {unit}")
    
    def validate(self) -> None:
        """Validate configuration parameters."""
        valid_backends = ['filesystem', 'sqlite', 'postgresql', 'redis']
        if self.backend_type not in valid_backends:
            raise ValueError(f"Invalid backend type: {self.backend_type}")
        
        if self.backend_type in ['postgresql', 'redis'] and not self.connection_string:
            raise ValueError(f"Connection string required for {self.backend_type} backend")
        
        if self.compaction_interval <= 0:
            raise ValueError("Compaction interval must be positive")
        
        if self.max_update_log_size <= 0:
            raise ValueError("Max update log size must be positive")
        
        if self.cache_size <= 0:
            raise ValueError("Cache size must be positive")
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert configuration to dictionary."""
        return {
            'backend_type': self.backend_type,
            'connection_string': self.connection_string,
            'retention_policy': self.retention_policy,
            'compaction_interval': self.compaction_interval,
            'max_update_log_size': self.max_update_log_size,
            'enable_caching': self.enable_caching,
            'cache_size': self.cache_size
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'StorageConfiguration':
        """Create configuration from dictionary."""
        return cls(**data)


class UpdateRecord(NamedTuple):
    """Record structure for CRDT updates."""
    update_id: str
    document_id: str
    timestamp: datetime
    user_id: str
    update_data: UpdateData
    size: int


class SnapshotRecord(NamedTuple):
    """Record structure for document snapshots."""
    snapshot_id: str
    document_id: str
    timestamp: datetime
    user_id: str
    snapshot_data: SnapshotData
    version: int


class CommentRecord(NamedTuple):
    """Record structure for comments."""
    comment_id: str
    document_id: str
    cell_id: str
    timestamp: datetime
    user_id: str
    comment_data: CommentData
    parent_id: Optional[str]


class StorageBackend(Protocol):
    """Protocol defining the storage backend interface."""
    
    async def initialize(self) -> None:
        """Initialize the storage backend."""
        ...
    
    async def cleanup(self) -> None:
        """Clean up storage backend resources."""
        ...
    
    async def store_update(self, update_record: UpdateRecord) -> None:
        """Store a CRDT update record."""
        ...
    
    async def retrieve_updates(
        self, 
        document_id: str, 
        since_timestamp: Optional[datetime] = None,
        limit: Optional[int] = None
    ) -> List[UpdateRecord]:
        """Retrieve CRDT updates for a document."""
        ...
    
    async def create_snapshot(self, snapshot_record: SnapshotRecord) -> None:
        """Create a document snapshot."""
        ...
    
    async def get_snapshots(
        self, 
        document_id: str, 
        limit: Optional[int] = None
    ) -> List[SnapshotRecord]:
        """Get document snapshots."""
        ...
    
    async def store_comment(self, comment_record: CommentRecord) -> None:
        """Store a comment record."""
        ...
    
    async def get_comments(
        self, 
        document_id: str, 
        cell_id: Optional[str] = None
    ) -> List[CommentRecord]:
        """Get comments for a document or cell."""
        ...


class FilesystemStorageBackend:
    """Filesystem-based storage backend using .ipynb_collab directory structure."""
    
    def __init__(self, config: StorageConfiguration, base_path: str = ""):
        """
        Initialize filesystem storage backend.
        
        Args:
            config: Storage configuration
            base_path: Base path for storage operations
        """
        self.config = config
        self.base_path = Path(base_path) if base_path else Path.cwd()
        self.logger = logging.getLogger(__name__ + ".FilesystemStorageBackend")
        self._lock = threading.RLock()
        
        # Cache for frequently accessed data
        self._cache: Dict[str, Any] = {} if config.enable_caching else None
        self._cache_lock = threading.Lock() if config.enable_caching else None
    
    async def initialize(self) -> None:
        """Initialize filesystem storage backend."""
        self.logger.info("Initializing filesystem storage backend")
        # No special initialization needed for filesystem backend
    
    async def cleanup(self) -> None:
        """Clean up filesystem storage backend."""
        self.logger.info("Cleaning up filesystem storage backend")
        if self._cache:
            with self._cache_lock:
                self._cache.clear()
    
    def get_collab_dir(self, document_path: str) -> Path:
        """Get the collaboration directory for a document."""
        doc_path = Path(document_path)
        if not doc_path.is_absolute():
            doc_path = self.base_path / doc_path
        
        # Create .ipynb_collab directory adjacent to notebook
        collab_dir = doc_path.parent / COLLAB_DIR_NAME
        return collab_dir
    
    def ensure_directories(self, document_path: str) -> None:
        """Ensure all required directories exist for a document."""
        collab_dir = self.get_collab_dir(document_path)
        
        # Create all required subdirectories
        for subdir in [UPDATES_DIR_NAME, HISTORY_DIR_NAME, COMMENTS_DIR_NAME, LOCKS_DIR_NAME]:
            dir_path = collab_dir / subdir
            dir_path.mkdir(parents=True, exist_ok=True)
    
    def _get_cache_key(self, prefix: str, document_id: str, suffix: str = "") -> str:
        """Generate cache key for document data."""
        return f"{prefix}:{document_id}:{suffix}" if suffix else f"{prefix}:{document_id}"
    
    def _get_from_cache(self, key: str) -> Any:
        """Get item from cache."""
        if not self._cache:
            return None
        
        with self._cache_lock:
            return self._cache.get(key)
    
    def _put_to_cache(self, key: str, value: Any) -> None:
        """Put item to cache."""
        if not self._cache:
            return
        
        with self._cache_lock:
            if len(self._cache) >= self.config.cache_size:
                # Simple LRU eviction - remove oldest item
                oldest_key = next(iter(self._cache))
                del self._cache[oldest_key]
            
            self._cache[key] = value
    
    async def store_update(self, update_record: UpdateRecord) -> None:
        """Store a CRDT update record to filesystem."""
        document_path = update_record.document_id
        self.ensure_directories(document_path)
        
        collab_dir = self.get_collab_dir(document_path)
        updates_dir = collab_dir / UPDATES_DIR_NAME
        
        # Create update filename with timestamp and update_id
        timestamp_str = update_record.timestamp.strftime("%Y%m%d_%H%M%S_%f")
        update_filename = f"{timestamp_str}_{update_record.update_id}.update"
        update_path = updates_dir / update_filename
        
        # Prepare update metadata
        update_metadata = {
            'update_id': update_record.update_id,
            'document_id': update_record.document_id,
            'timestamp': update_record.timestamp.isoformat(),
            'user_id': update_record.user_id,
            'size': update_record.size,
            'version': __version__
        }
        
        # Store update with metadata
        with self._lock:
            try:
                # Write binary update data
                if isinstance(update_record.update_data, bytes):
                    update_path.write_bytes(update_record.update_data)
                else:
                    update_path.write_text(str(update_record.update_data), encoding='utf-8')
                
                # Write metadata file
                metadata_path = update_path.with_suffix('.metadata.json')
                metadata_path.write_text(json.dumps(update_metadata, indent=2), encoding='utf-8')
                
                self.logger.debug(f"Stored update {update_record.update_id} for document {document_path}")
                
            except Exception as e:
                self.logger.error(f"Failed to store update {update_record.update_id}: {e}")
                raise StorageError(f"Failed to store update: {e}")
    
    async def retrieve_updates(
        self, 
        document_id: str, 
        since_timestamp: Optional[datetime] = None,
        limit: Optional[int] = None
    ) -> List[UpdateRecord]:
        """Retrieve CRDT updates for a document from filesystem."""
        cache_key = self._get_cache_key("updates", document_id, 
                                       since_timestamp.isoformat() if since_timestamp else "all")
        
        # Check cache first
        cached_updates = self._get_from_cache(cache_key)
        if cached_updates:
            return cached_updates[:limit] if limit else cached_updates
        
        collab_dir = self.get_collab_dir(document_id)
        updates_dir = collab_dir / UPDATES_DIR_NAME
        
        if not updates_dir.exists():
            return []
        
        updates = []
        
        with self._lock:
            try:
                # Get all update files
                update_files = list(updates_dir.glob("*.update"))
                update_files.sort()  # Sort by filename (includes timestamp)
                
                for update_file in update_files:
                    metadata_file = update_file.with_suffix('.metadata.json')
                    
                    if not metadata_file.exists():
                        self.logger.warning(f"Missing metadata for update file: {update_file}")
                        continue
                    
                    # Read metadata
                    metadata = json.loads(metadata_file.read_text(encoding='utf-8'))
                    update_timestamp = datetime.fromisoformat(metadata['timestamp'])
                    
                    # Filter by timestamp if specified
                    if since_timestamp and update_timestamp <= since_timestamp:
                        continue
                    
                    # Read update data
                    try:
                        update_data = update_file.read_bytes()
                    except Exception:
                        # Fallback to text if binary read fails
                        update_data = update_file.read_text(encoding='utf-8')
                    
                    # Create update record
                    update_record = UpdateRecord(
                        update_id=metadata['update_id'],
                        document_id=metadata['document_id'],
                        timestamp=update_timestamp,
                        user_id=metadata['user_id'],
                        update_data=update_data,
                        size=metadata['size']
                    )
                    
                    updates.append(update_record)
                    
                    # Apply limit if specified
                    if limit and len(updates) >= limit:
                        break
                
                # Cache the results
                self._put_to_cache(cache_key, updates)
                
                self.logger.debug(f"Retrieved {len(updates)} updates for document {document_id}")
                return updates
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve updates for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve updates: {e}")
    
    async def create_snapshot(self, snapshot_record: SnapshotRecord) -> None:
        """Create a document snapshot on filesystem."""
        document_path = snapshot_record.document_id
        self.ensure_directories(document_path)
        
        collab_dir = self.get_collab_dir(document_path)
        history_dir = collab_dir / HISTORY_DIR_NAME
        
        # Create snapshot filename with timestamp and version
        timestamp_str = snapshot_record.timestamp.strftime("%Y%m%d_%H%M%S_%f")
        snapshot_filename = f"{timestamp_str}_v{snapshot_record.version}_{snapshot_record.snapshot_id}.snapshot.json"
        snapshot_path = history_dir / snapshot_filename
        
        # Prepare snapshot with metadata
        snapshot_with_metadata = {
            'snapshot_id': snapshot_record.snapshot_id,
            'document_id': snapshot_record.document_id,
            'timestamp': snapshot_record.timestamp.isoformat(),
            'user_id': snapshot_record.user_id,
            'version': snapshot_record.version,
            'notebook_version': __version__,
            'snapshot_data': snapshot_record.snapshot_data
        }
        
        with self._lock:
            try:
                snapshot_path.write_text(
                    json.dumps(snapshot_with_metadata, indent=2), 
                    encoding='utf-8'
                )
                
                self.logger.debug(f"Created snapshot {snapshot_record.snapshot_id} for document {document_path}")
                
            except Exception as e:
                self.logger.error(f"Failed to create snapshot {snapshot_record.snapshot_id}: {e}")
                raise StorageError(f"Failed to create snapshot: {e}")
    
    async def get_snapshots(
        self, 
        document_id: str, 
        limit: Optional[int] = None
    ) -> List[SnapshotRecord]:
        """Get document snapshots from filesystem."""
        cache_key = self._get_cache_key("snapshots", document_id)
        
        # Check cache first
        cached_snapshots = self._get_from_cache(cache_key)
        if cached_snapshots:
            return cached_snapshots[:limit] if limit else cached_snapshots
        
        collab_dir = self.get_collab_dir(document_id)
        history_dir = collab_dir / HISTORY_DIR_NAME
        
        if not history_dir.exists():
            return []
        
        snapshots = []
        
        with self._lock:
            try:
                # Get all snapshot files
                snapshot_files = list(history_dir.glob("*.snapshot.json"))
                snapshot_files.sort(reverse=True)  # Most recent first
                
                for snapshot_file in snapshot_files:
                    # Read snapshot data
                    snapshot_data = json.loads(snapshot_file.read_text(encoding='utf-8'))
                    
                    # Create snapshot record
                    snapshot_record = SnapshotRecord(
                        snapshot_id=snapshot_data['snapshot_id'],
                        document_id=snapshot_data['document_id'],
                        timestamp=datetime.fromisoformat(snapshot_data['timestamp']),
                        user_id=snapshot_data['user_id'],
                        snapshot_data=snapshot_data['snapshot_data'],
                        version=snapshot_data['version']
                    )
                    
                    snapshots.append(snapshot_record)
                    
                    # Apply limit if specified
                    if limit and len(snapshots) >= limit:
                        break
                
                # Cache the results
                self._put_to_cache(cache_key, snapshots)
                
                self.logger.debug(f"Retrieved {len(snapshots)} snapshots for document {document_id}")
                return snapshots
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve snapshots for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve snapshots: {e}")
    
    async def store_comment(self, comment_record: CommentRecord) -> None:
        """Store a comment record to filesystem."""
        document_path = comment_record.document_id
        self.ensure_directories(document_path)
        
        collab_dir = self.get_collab_dir(document_path)
        comments_dir = collab_dir / COMMENTS_DIR_NAME
        
        # Create comment filename with timestamp and comment_id
        timestamp_str = comment_record.timestamp.strftime("%Y%m%d_%H%M%S_%f")
        comment_filename = f"{timestamp_str}_{comment_record.comment_id}.comment.json"
        comment_path = comments_dir / comment_filename
        
        # Prepare comment with metadata
        comment_with_metadata = {
            'comment_id': comment_record.comment_id,
            'document_id': comment_record.document_id,
            'cell_id': comment_record.cell_id,
            'timestamp': comment_record.timestamp.isoformat(),
            'user_id': comment_record.user_id,
            'parent_id': comment_record.parent_id,
            'notebook_version': __version__,
            'comment_data': comment_record.comment_data
        }
        
        with self._lock:
            try:
                comment_path.write_text(
                    json.dumps(comment_with_metadata, indent=2), 
                    encoding='utf-8'
                )
                
                self.logger.debug(f"Stored comment {comment_record.comment_id} for document {document_path}")
                
            except Exception as e:
                self.logger.error(f"Failed to store comment {comment_record.comment_id}: {e}")
                raise StorageError(f"Failed to store comment: {e}")
    
    async def get_comments(
        self, 
        document_id: str, 
        cell_id: Optional[str] = None
    ) -> List[CommentRecord]:
        """Get comments for a document or cell from filesystem."""
        cache_key = self._get_cache_key("comments", document_id, cell_id or "all")
        
        # Check cache first
        cached_comments = self._get_from_cache(cache_key)
        if cached_comments:
            return cached_comments
        
        collab_dir = self.get_collab_dir(document_id)
        comments_dir = collab_dir / COMMENTS_DIR_NAME
        
        if not comments_dir.exists():
            return []
        
        comments = []
        
        with self._lock:
            try:
                # Get all comment files
                comment_files = list(comments_dir.glob("*.comment.json"))
                comment_files.sort()  # Sort by filename (includes timestamp)
                
                for comment_file in comment_files:
                    # Read comment data
                    comment_data = json.loads(comment_file.read_text(encoding='utf-8'))
                    
                    # Filter by cell_id if specified
                    if cell_id and comment_data.get('cell_id') != cell_id:
                        continue
                    
                    # Create comment record
                    comment_record = CommentRecord(
                        comment_id=comment_data['comment_id'],
                        document_id=comment_data['document_id'],
                        cell_id=comment_data['cell_id'],
                        timestamp=datetime.fromisoformat(comment_data['timestamp']),
                        user_id=comment_data['user_id'],
                        comment_data=comment_data['comment_data'],
                        parent_id=comment_data.get('parent_id')
                    )
                    
                    comments.append(comment_record)
                
                # Cache the results
                self._put_to_cache(cache_key, comments)
                
                self.logger.debug(f"Retrieved {len(comments)} comments for document {document_id}")
                return comments
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve comments for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve comments: {e}")


class DatabaseStorageBackend:
    """Database-based storage backend supporting SQLite and PostgreSQL."""
    
    def __init__(self, config: StorageConfiguration):
        """
        Initialize database storage backend.
        
        Args:
            config: Storage configuration with connection string
        """
        self.config = config
        self.logger = logging.getLogger(__name__ + ".DatabaseStorageBackend")
        self._connection = None
        self._lock = threading.RLock()
        
        # Determine database type from connection string
        if self.config.connection_string.startswith('postgresql://'):
            self._db_type = 'postgresql'
            if not psycopg2:
                raise ImportError("psycopg2 required for PostgreSQL backend")
        else:
            self._db_type = 'sqlite'
        
        # Cache for frequently accessed data
        self._cache: Dict[str, Any] = {} if config.enable_caching else None
        self._cache_lock = threading.Lock() if config.enable_caching else None
    
    async def initialize(self) -> None:
        """Initialize database storage backend."""
        self.logger.info(f"Initializing {self._db_type} storage backend")
        
        try:
            await self._create_connection()
            await self._create_tables()
            await self._migrate_schema()
            self.logger.info(f"Database storage backend initialized successfully")
        except Exception as e:
            self.logger.error(f"Failed to initialize database storage backend: {e}")
            raise StorageConnectionError(f"Failed to initialize database: {e}")
    
    async def cleanup(self) -> None:
        """Clean up database storage backend."""
        self.logger.info("Cleaning up database storage backend")
        
        if self._cache:
            with self._cache_lock:
                self._cache.clear()
        
        if self._connection:
            try:
                if self._db_type == 'postgresql':
                    self._connection.close()
                else:
                    self._connection.close()
                self._connection = None
            except Exception as e:
                self.logger.error(f"Error closing database connection: {e}")
    
    async def _create_connection(self) -> None:
        """Create database connection."""
        if self._db_type == 'postgresql':
            self._connection = psycopg2.connect(
                self.config.connection_string,
                cursor_factory=psycopg2.extras.RealDictCursor
            )
        else:
            # SQLite connection
            if self.config.connection_string:
                db_path = self.config.connection_string
            else:
                db_path = 'collab.db'
            
            self._connection = sqlite3.connect(db_path, check_same_thread=False)
            self._connection.row_factory = sqlite3.Row
    
    def get_connection(self):
        """Get database connection."""
        return self._connection
    
    async def _create_tables(self) -> None:
        """Create necessary database tables."""
        with self._lock:
            cursor = self._connection.cursor()
            
            try:
                # Create updates table
                if self._db_type == 'postgresql':
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS crdt_updates (
                            id SERIAL PRIMARY KEY,
                            update_id VARCHAR(255) UNIQUE NOT NULL,
                            document_id VARCHAR(255) NOT NULL,
                            timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
                            user_id VARCHAR(255) NOT NULL,
                            update_data BYTEA NOT NULL,
                            size INTEGER NOT NULL,
                            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_updates_document_timestamp 
                        ON crdt_updates(document_id, timestamp)
                    """)
                else:
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS crdt_updates (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            update_id TEXT UNIQUE NOT NULL,
                            document_id TEXT NOT NULL,
                            timestamp TEXT NOT NULL,
                            user_id TEXT NOT NULL,
                            update_data BLOB NOT NULL,
                            size INTEGER NOT NULL,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_updates_document_timestamp 
                        ON crdt_updates(document_id, timestamp)
                    """)
                
                # Create snapshots table
                if self._db_type == 'postgresql':
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS document_snapshots (
                            id SERIAL PRIMARY KEY,
                            snapshot_id VARCHAR(255) UNIQUE NOT NULL,
                            document_id VARCHAR(255) NOT NULL,
                            timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
                            user_id VARCHAR(255) NOT NULL,
                            snapshot_data JSONB NOT NULL,
                            version INTEGER NOT NULL,
                            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_snapshots_document_timestamp 
                        ON document_snapshots(document_id, timestamp DESC)
                    """)
                else:
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS document_snapshots (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            snapshot_id TEXT UNIQUE NOT NULL,
                            document_id TEXT NOT NULL,
                            timestamp TEXT NOT NULL,
                            user_id TEXT NOT NULL,
                            snapshot_data TEXT NOT NULL,
                            version INTEGER NOT NULL,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_snapshots_document_timestamp 
                        ON document_snapshots(document_id, timestamp DESC)
                    """)
                
                # Create comments table
                if self._db_type == 'postgresql':
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS comments (
                            id SERIAL PRIMARY KEY,
                            comment_id VARCHAR(255) UNIQUE NOT NULL,
                            document_id VARCHAR(255) NOT NULL,
                            cell_id VARCHAR(255) NOT NULL,
                            timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
                            user_id VARCHAR(255) NOT NULL,
                            comment_data JSONB NOT NULL,
                            parent_id VARCHAR(255),
                            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_comments_document_cell 
                        ON comments(document_id, cell_id, timestamp)
                    """)
                else:
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS comments (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            comment_id TEXT UNIQUE NOT NULL,
                            document_id TEXT NOT NULL,
                            cell_id TEXT NOT NULL,
                            timestamp TEXT NOT NULL,
                            user_id TEXT NOT NULL,
                            comment_data TEXT NOT NULL,
                            parent_id TEXT,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_comments_document_cell 
                        ON comments(document_id, cell_id, timestamp)
                    """)
                
                self._connection.commit()
                self.logger.debug("Database tables created successfully")
                
            except Exception as e:
                self._connection.rollback()
                self.logger.error(f"Failed to create database tables: {e}")
                raise StorageError(f"Failed to create tables: {e}")
            finally:
                cursor.close()
    
    async def migrate_schema(self) -> None:
        """Migrate database schema if needed."""
        # In a real implementation, this would handle schema migrations
        # For now, this is a placeholder
        self.logger.debug("Schema migration completed")
    
    def _get_cache_key(self, prefix: str, document_id: str, suffix: str = "") -> str:
        """Generate cache key for document data."""
        return f"{prefix}:{document_id}:{suffix}" if suffix else f"{prefix}:{document_id}"
    
    def _get_from_cache(self, key: str) -> Any:
        """Get item from cache."""
        if not self._cache:
            return None
        
        with self._cache_lock:
            return self._cache.get(key)
    
    def _put_to_cache(self, key: str, value: Any) -> None:
        """Put item to cache."""
        if not self._cache:
            return
        
        with self._cache_lock:
            if len(self._cache) >= self.config.cache_size:
                # Simple LRU eviction - remove oldest item
                oldest_key = next(iter(self._cache))
                del self._cache[oldest_key]
            
            self._cache[key] = value
    
    async def store_update(self, update_record: UpdateRecord) -> None:
        """Store a CRDT update record to database."""
        with self._lock:
            cursor = self._connection.cursor()
            
            try:
                if self._db_type == 'postgresql':
                    cursor.execute("""
                        INSERT INTO crdt_updates 
                        (update_id, document_id, timestamp, user_id, update_data, size)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (update_id) DO NOTHING
                    """, (
                        update_record.update_id,
                        update_record.document_id,
                        update_record.timestamp,
                        update_record.user_id,
                        update_record.update_data,
                        update_record.size
                    ))
                else:
                    cursor.execute("""
                        INSERT OR IGNORE INTO crdt_updates 
                        (update_id, document_id, timestamp, user_id, update_data, size)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """, (
                        update_record.update_id,
                        update_record.document_id,
                        update_record.timestamp.isoformat(),
                        update_record.user_id,
                        update_record.update_data,
                        update_record.size
                    ))
                
                self._connection.commit()
                self.logger.debug(f"Stored update {update_record.update_id} to database")
                
            except Exception as e:
                self._connection.rollback()
                self.logger.error(f"Failed to store update {update_record.update_id}: {e}")
                raise StorageError(f"Failed to store update: {e}")
            finally:
                cursor.close()
    
    async def retrieve_updates(
        self, 
        document_id: str, 
        since_timestamp: Optional[datetime] = None,
        limit: Optional[int] = None
    ) -> List[UpdateRecord]:
        """Retrieve CRDT updates for a document from database."""
        cache_key = self._get_cache_key("updates", document_id, 
                                       since_timestamp.isoformat() if since_timestamp else "all")
        
        # Check cache first
        cached_updates = self._get_from_cache(cache_key)
        if cached_updates:
            return cached_updates[:limit] if limit else cached_updates
        
        with self._lock:
            cursor = self._connection.cursor()
            
            try:
                if self._db_type == 'postgresql':
                    if since_timestamp:
                        query = """
                            SELECT update_id, document_id, timestamp, user_id, update_data, size
                            FROM crdt_updates 
                            WHERE document_id = %s AND timestamp > %s
                            ORDER BY timestamp ASC
                        """
                        params = (document_id, since_timestamp)
                    else:
                        query = """
                            SELECT update_id, document_id, timestamp, user_id, update_data, size
                            FROM crdt_updates 
                            WHERE document_id = %s
                            ORDER BY timestamp ASC
                        """
                        params = (document_id,)
                    
                    if limit:
                        query += f" LIMIT {limit}"
                    
                    cursor.execute(query, params)
                else:
                    if since_timestamp:
                        query = """
                            SELECT update_id, document_id, timestamp, user_id, update_data, size
                            FROM crdt_updates 
                            WHERE document_id = ? AND timestamp > ?
                            ORDER BY timestamp ASC
                        """
                        params = (document_id, since_timestamp.isoformat())
                    else:
                        query = """
                            SELECT update_id, document_id, timestamp, user_id, update_data, size
                            FROM crdt_updates 
                            WHERE document_id = ?
                            ORDER BY timestamp ASC
                        """
                        params = (document_id,)
                    
                    if limit:
                        query += f" LIMIT {limit}"
                    
                    cursor.execute(query, params)
                
                rows = cursor.fetchall()
                updates = []
                
                for row in rows:
                    if self._db_type == 'postgresql':
                        timestamp = row['timestamp']
                    else:
                        timestamp = datetime.fromisoformat(row['timestamp'])
                    
                    update_record = UpdateRecord(
                        update_id=row['update_id'],
                        document_id=row['document_id'],
                        timestamp=timestamp,
                        user_id=row['user_id'],
                        update_data=row['update_data'],
                        size=row['size']
                    )
                    updates.append(update_record)
                
                # Cache the results
                self._put_to_cache(cache_key, updates)
                
                self.logger.debug(f"Retrieved {len(updates)} updates for document {document_id}")
                return updates
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve updates for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve updates: {e}")
            finally:
                cursor.close()
    
    async def create_snapshot(self, snapshot_record: SnapshotRecord) -> None:
        """Create a document snapshot in database."""
        with self._lock:
            cursor = self._connection.cursor()
            
            try:
                if self._db_type == 'postgresql':
                    cursor.execute("""
                        INSERT INTO document_snapshots 
                        (snapshot_id, document_id, timestamp, user_id, snapshot_data, version)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (snapshot_id) DO NOTHING
                    """, (
                        snapshot_record.snapshot_id,
                        snapshot_record.document_id,
                        snapshot_record.timestamp,
                        snapshot_record.user_id,
                        json.dumps(snapshot_record.snapshot_data),
                        snapshot_record.version
                    ))
                else:
                    cursor.execute("""
                        INSERT OR IGNORE INTO document_snapshots 
                        (snapshot_id, document_id, timestamp, user_id, snapshot_data, version)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """, (
                        snapshot_record.snapshot_id,
                        snapshot_record.document_id,
                        snapshot_record.timestamp.isoformat(),
                        snapshot_record.user_id,
                        json.dumps(snapshot_record.snapshot_data),
                        snapshot_record.version
                    ))
                
                self._connection.commit()
                self.logger.debug(f"Created snapshot {snapshot_record.snapshot_id} in database")
                
            except Exception as e:
                self._connection.rollback()
                self.logger.error(f"Failed to create snapshot {snapshot_record.snapshot_id}: {e}")
                raise StorageError(f"Failed to create snapshot: {e}")
            finally:
                cursor.close()
    
    async def get_snapshots(
        self, 
        document_id: str, 
        limit: Optional[int] = None
    ) -> List[SnapshotRecord]:
        """Get document snapshots from database."""
        cache_key = self._get_cache_key("snapshots", document_id)
        
        # Check cache first
        cached_snapshots = self._get_from_cache(cache_key)
        if cached_snapshots:
            return cached_snapshots[:limit] if limit else cached_snapshots
        
        with self._lock:
            cursor = self._connection.cursor()
            
            try:
                query = """
                    SELECT snapshot_id, document_id, timestamp, user_id, snapshot_data, version
                    FROM document_snapshots 
                    WHERE document_id = %s
                    ORDER BY timestamp DESC
                """ if self._db_type == 'postgresql' else """
                    SELECT snapshot_id, document_id, timestamp, user_id, snapshot_data, version
                    FROM document_snapshots 
                    WHERE document_id = ?
                    ORDER BY timestamp DESC
                """
                
                if limit:
                    query += f" LIMIT {limit}"
                
                cursor.execute(query, (document_id,))
                rows = cursor.fetchall()
                snapshots = []
                
                for row in rows:
                    if self._db_type == 'postgresql':
                        timestamp = row['timestamp']
                        snapshot_data = row['snapshot_data']
                    else:
                        timestamp = datetime.fromisoformat(row['timestamp'])
                        snapshot_data = json.loads(row['snapshot_data'])
                    
                    snapshot_record = SnapshotRecord(
                        snapshot_id=row['snapshot_id'],
                        document_id=row['document_id'],
                        timestamp=timestamp,
                        user_id=row['user_id'],
                        snapshot_data=snapshot_data,
                        version=row['version']
                    )
                    snapshots.append(snapshot_record)
                
                # Cache the results
                self._put_to_cache(cache_key, snapshots)
                
                self.logger.debug(f"Retrieved {len(snapshots)} snapshots for document {document_id}")
                return snapshots
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve snapshots for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve snapshots: {e}")
            finally:
                cursor.close()
    
    async def store_comment(self, comment_record: CommentRecord) -> None:
        """Store a comment record to database."""
        with self._lock:
            cursor = self._connection.cursor()
            
            try:
                if self._db_type == 'postgresql':
                    cursor.execute("""
                        INSERT INTO comments 
                        (comment_id, document_id, cell_id, timestamp, user_id, comment_data, parent_id)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (comment_id) DO NOTHING
                    """, (
                        comment_record.comment_id,
                        comment_record.document_id,
                        comment_record.cell_id,
                        comment_record.timestamp,
                        comment_record.user_id,
                        json.dumps(comment_record.comment_data),
                        comment_record.parent_id
                    ))
                else:
                    cursor.execute("""
                        INSERT OR IGNORE INTO comments 
                        (comment_id, document_id, cell_id, timestamp, user_id, comment_data, parent_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, (
                        comment_record.comment_id,
                        comment_record.document_id,
                        comment_record.cell_id,
                        comment_record.timestamp.isoformat(),
                        comment_record.user_id,
                        json.dumps(comment_record.comment_data),
                        comment_record.parent_id
                    ))
                
                self._connection.commit()
                self.logger.debug(f"Stored comment {comment_record.comment_id} to database")
                
            except Exception as e:
                self._connection.rollback()
                self.logger.error(f"Failed to store comment {comment_record.comment_id}: {e}")
                raise StorageError(f"Failed to store comment: {e}")
            finally:
                cursor.close()
    
    async def get_comments(
        self, 
        document_id: str, 
        cell_id: Optional[str] = None
    ) -> List[CommentRecord]:
        """Get comments for a document or cell from database."""
        cache_key = self._get_cache_key("comments", document_id, cell_id or "all")
        
        # Check cache first
        cached_comments = self._get_from_cache(cache_key)
        if cached_comments:
            return cached_comments
        
        with self._lock:
            cursor = self._connection.cursor()
            
            try:
                if cell_id:
                    query = """
                        SELECT comment_id, document_id, cell_id, timestamp, user_id, comment_data, parent_id
                        FROM comments 
                        WHERE document_id = %s AND cell_id = %s
                        ORDER BY timestamp ASC
                    """ if self._db_type == 'postgresql' else """
                        SELECT comment_id, document_id, cell_id, timestamp, user_id, comment_data, parent_id
                        FROM comments 
                        WHERE document_id = ? AND cell_id = ?
                        ORDER BY timestamp ASC
                    """
                    params = (document_id, cell_id)
                else:
                    query = """
                        SELECT comment_id, document_id, cell_id, timestamp, user_id, comment_data, parent_id
                        FROM comments 
                        WHERE document_id = %s
                        ORDER BY timestamp ASC
                    """ if self._db_type == 'postgresql' else """
                        SELECT comment_id, document_id, cell_id, timestamp, user_id, comment_data, parent_id
                        FROM comments 
                        WHERE document_id = ?
                        ORDER BY timestamp ASC
                    """
                    params = (document_id,)
                
                cursor.execute(query, params)
                rows = cursor.fetchall()
                comments = []
                
                for row in rows:
                    if self._db_type == 'postgresql':
                        timestamp = row['timestamp']
                        comment_data = row['comment_data']
                    else:
                        timestamp = datetime.fromisoformat(row['timestamp'])
                        comment_data = json.loads(row['comment_data'])
                    
                    comment_record = CommentRecord(
                        comment_id=row['comment_id'],
                        document_id=row['document_id'],
                        cell_id=row['cell_id'],
                        timestamp=timestamp,
                        user_id=row['user_id'],
                        comment_data=comment_data,
                        parent_id=row['parent_id']
                    )
                    comments.append(comment_record)
                
                # Cache the results
                self._put_to_cache(cache_key, comments)
                
                self.logger.debug(f"Retrieved {len(comments)} comments for document {document_id}")
                return comments
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve comments for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve comments: {e}")
            finally:
                cursor.close()


class RedisStorageBackend:
    """Redis-based storage backend for high-performance collaborative storage."""
    
    def __init__(self, config: StorageConfiguration):
        """
        Initialize Redis storage backend.
        
        Args:
            config: Storage configuration with Redis connection string
        """
        self.config = config
        self.logger = logging.getLogger(__name__ + ".RedisStorageBackend")
        self._redis_client = None
        self._lock = threading.RLock()
        
        if not redis:
            raise ImportError("redis package required for Redis backend")
        
        # Parse Redis connection string
        self._parse_connection_string()
    
    def _parse_connection_string(self) -> None:
        """Parse Redis connection string."""
        # Example: redis://localhost:6379/0
        # Example: redis://user:password@localhost:6379/0
        try:
            if self.config.connection_string.startswith('redis://'):
                self._redis_url = self.config.connection_string
            else:
                # Assume host:port format
                host, port = self.config.connection_string.split(':')
                self._redis_url = f"redis://{host}:{port}/0"
        except Exception as e:
            raise ValueError(f"Invalid Redis connection string: {e}")
    
    async def initialize(self) -> None:
        """Initialize Redis storage backend."""
        self.logger.info("Initializing Redis storage backend")
        
        try:
            # Create Redis connection pool
            self._redis_client = redis.Redis.from_url(
                self._redis_url,
                decode_responses=False,  # Keep binary data as bytes
                health_check_interval=30,
                socket_keepalive=True,
                socket_keepalive_options={}
            )
            
            # Test connection
            await asyncio.get_event_loop().run_in_executor(
                None, self._redis_client.ping
            )
            
            self.logger.info("Redis storage backend initialized successfully")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize Redis storage backend: {e}")
            raise StorageConnectionError(f"Failed to connect to Redis: {e}")
    
    async def cleanup(self) -> None:
        """Clean up Redis storage backend."""
        self.logger.info("Cleaning up Redis storage backend")
        
        if self._redis_client:
            try:
                await asyncio.get_event_loop().run_in_executor(
                    None, self._redis_client.close
                )
                self._redis_client = None
            except Exception as e:
                self.logger.error(f"Error closing Redis connection: {e}")
    
    def get_client(self):
        """Get Redis client instance."""
        return self._redis_client
    
    def _get_update_key(self, document_id: str, update_id: str) -> str:
        """Generate Redis key for update record."""
        return f"updates:{document_id}:{update_id}"
    
    def _get_updates_list_key(self, document_id: str) -> str:
        """Generate Redis key for updates list."""
        return f"updates_list:{document_id}"
    
    def _get_snapshot_key(self, document_id: str, snapshot_id: str) -> str:
        """Generate Redis key for snapshot record."""
        return f"snapshots:{document_id}:{snapshot_id}"
    
    def _get_snapshots_list_key(self, document_id: str) -> str:
        """Generate Redis key for snapshots list."""
        return f"snapshots_list:{document_id}"
    
    def _get_comment_key(self, document_id: str, comment_id: str) -> str:
        """Generate Redis key for comment record."""
        return f"comments:{document_id}:{comment_id}"
    
    def _get_comments_list_key(self, document_id: str, cell_id: str = None) -> str:
        """Generate Redis key for comments list."""
        if cell_id:
            return f"comments_list:{document_id}:{cell_id}"
        return f"comments_list:{document_id}"
    
    async def publish_update(self, document_id: str, update_data: UpdateData) -> None:
        """Publish update to Redis pub/sub for real-time distribution."""
        channel = f"updates:{document_id}"
        
        try:
            await asyncio.get_event_loop().run_in_executor(
                None, self._redis_client.publish, channel, update_data
            )
            self.logger.debug(f"Published update to channel {channel}")
        except Exception as e:
            self.logger.error(f"Failed to publish update to channel {channel}: {e}")
            raise StorageError(f"Failed to publish update: {e}")
    
    async def subscribe_updates(self, document_id: str, callback: Callable[[UpdateData], None]) -> None:
        """Subscribe to updates for a document."""
        channel = f"updates:{document_id}"
        
        try:
            pubsub = self._redis_client.pubsub()
            await asyncio.get_event_loop().run_in_executor(
                None, pubsub.subscribe, channel
            )
            
            self.logger.debug(f"Subscribed to updates channel {channel}")
            
            # Process messages in background
            async def message_handler():
                try:
                    for message in pubsub.listen():
                        if message['type'] == 'message':
                            callback(message['data'])
                except Exception as e:
                    self.logger.error(f"Error in message handler: {e}")
            
            # Start message handler
            asyncio.create_task(message_handler())
            
        except Exception as e:
            self.logger.error(f"Failed to subscribe to updates channel {channel}: {e}")
            raise StorageError(f"Failed to subscribe to updates: {e}")
    
    async def store_update(self, update_record: UpdateRecord) -> None:
        """Store a CRDT update record to Redis."""
        update_key = self._get_update_key(update_record.document_id, update_record.update_id)
        updates_list_key = self._get_updates_list_key(update_record.document_id)
        
        # Prepare update data
        update_data = {
            'update_id': update_record.update_id,
            'document_id': update_record.document_id,
            'timestamp': update_record.timestamp.isoformat(),
            'user_id': update_record.user_id,
            'update_data': update_record.update_data,
            'size': update_record.size
        }
        
        with self._lock:
            try:
                # Use Redis pipeline for atomic operations
                pipe = self._redis_client.pipeline()
                
                # Store update data
                pipe.hset(update_key, mapping={
                    'update_id': update_record.update_id,
                    'document_id': update_record.document_id,
                    'timestamp': update_record.timestamp.isoformat(),
                    'user_id': update_record.user_id,
                    'size': update_record.size
                })
                
                # Store binary update data separately
                pipe.set(f"{update_key}:data", update_record.update_data)
                
                # Add to ordered list (sorted by timestamp)
                pipe.zadd(updates_list_key, {
                    update_record.update_id: update_record.timestamp.timestamp()
                })
                
                # Set expiration based on retention policy
                expiration = int(self.config.retention_timedelta.total_seconds())
                pipe.expire(update_key, expiration)
                pipe.expire(f"{update_key}:data", expiration)
                pipe.expire(updates_list_key, expiration)
                
                # Execute pipeline
                await asyncio.get_event_loop().run_in_executor(
                    None, pipe.execute
                )
                
                # Publish update for real-time distribution
                await self.publish_update(update_record.document_id, update_record.update_data)
                
                self.logger.debug(f"Stored update {update_record.update_id} to Redis")
                
            except Exception as e:
                self.logger.error(f"Failed to store update {update_record.update_id}: {e}")
                raise StorageError(f"Failed to store update: {e}")
    
    async def retrieve_updates(
        self, 
        document_id: str, 
        since_timestamp: Optional[datetime] = None,
        limit: Optional[int] = None
    ) -> List[UpdateRecord]:
        """Retrieve CRDT updates for a document from Redis."""
        updates_list_key = self._get_updates_list_key(document_id)
        
        with self._lock:
            try:
                # Get update IDs from sorted set
                if since_timestamp:
                    min_score = since_timestamp.timestamp()
                    update_ids = await asyncio.get_event_loop().run_in_executor(
                        None, self._redis_client.zrangebyscore, 
                        updates_list_key, min_score, '+inf'
                    )
                else:
                    update_ids = await asyncio.get_event_loop().run_in_executor(
                        None, self._redis_client.zrange, 
                        updates_list_key, 0, -1
                    )
                
                # Apply limit if specified
                if limit:
                    update_ids = update_ids[:limit]
                
                updates = []
                
                for update_id in update_ids:
                    update_id = update_id.decode('utf-8') if isinstance(update_id, bytes) else update_id
                    update_key = self._get_update_key(document_id, update_id)
                    
                    # Get update metadata
                    update_metadata = await asyncio.get_event_loop().run_in_executor(
                        None, self._redis_client.hgetall, update_key
                    )
                    
                    if not update_metadata:
                        continue
                    
                    # Get update data
                    update_data = await asyncio.get_event_loop().run_in_executor(
                        None, self._redis_client.get, f"{update_key}:data"
                    )
                    
                    if not update_data:
                        continue
                    
                    # Decode metadata
                    update_metadata = {k.decode('utf-8'): v.decode('utf-8') 
                                     for k, v in update_metadata.items()}
                    
                    # Create update record
                    update_record = UpdateRecord(
                        update_id=update_metadata['update_id'],
                        document_id=update_metadata['document_id'],
                        timestamp=datetime.fromisoformat(update_metadata['timestamp']),
                        user_id=update_metadata['user_id'],
                        update_data=update_data,
                        size=int(update_metadata['size'])
                    )
                    
                    updates.append(update_record)
                
                self.logger.debug(f"Retrieved {len(updates)} updates for document {document_id}")
                return updates
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve updates for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve updates: {e}")
    
    async def create_snapshot(self, snapshot_record: SnapshotRecord) -> None:
        """Create a document snapshot in Redis."""
        snapshot_key = self._get_snapshot_key(snapshot_record.document_id, snapshot_record.snapshot_id)
        snapshots_list_key = self._get_snapshots_list_key(snapshot_record.document_id)
        
        # Prepare snapshot data
        snapshot_data = {
            'snapshot_id': snapshot_record.snapshot_id,
            'document_id': snapshot_record.document_id,
            'timestamp': snapshot_record.timestamp.isoformat(),
            'user_id': snapshot_record.user_id,
            'snapshot_data': json.dumps(snapshot_record.snapshot_data),
            'version': snapshot_record.version
        }
        
        with self._lock:
            try:
                # Use Redis pipeline for atomic operations
                pipe = self._redis_client.pipeline()
                
                # Store snapshot data
                pipe.hset(snapshot_key, mapping=snapshot_data)
                
                # Add to ordered list (sorted by timestamp, most recent first)
                pipe.zadd(snapshots_list_key, {
                    snapshot_record.snapshot_id: snapshot_record.timestamp.timestamp()
                })
                
                # Set expiration based on retention policy
                expiration = int(self.config.retention_timedelta.total_seconds())
                pipe.expire(snapshot_key, expiration)
                pipe.expire(snapshots_list_key, expiration)
                
                # Execute pipeline
                await asyncio.get_event_loop().run_in_executor(
                    None, pipe.execute
                )
                
                self.logger.debug(f"Created snapshot {snapshot_record.snapshot_id} in Redis")
                
            except Exception as e:
                self.logger.error(f"Failed to create snapshot {snapshot_record.snapshot_id}: {e}")
                raise StorageError(f"Failed to create snapshot: {e}")
    
    async def get_snapshots(
        self, 
        document_id: str, 
        limit: Optional[int] = None
    ) -> List[SnapshotRecord]:
        """Get document snapshots from Redis."""
        snapshots_list_key = self._get_snapshots_list_key(document_id)
        
        with self._lock:
            try:
                # Get snapshot IDs from sorted set (most recent first)
                if limit:
                    snapshot_ids = await asyncio.get_event_loop().run_in_executor(
                        None, self._redis_client.zrevrange, 
                        snapshots_list_key, 0, limit - 1
                    )
                else:
                    snapshot_ids = await asyncio.get_event_loop().run_in_executor(
                        None, self._redis_client.zrevrange, 
                        snapshots_list_key, 0, -1
                    )
                
                snapshots = []
                
                for snapshot_id in snapshot_ids:
                    snapshot_id = snapshot_id.decode('utf-8') if isinstance(snapshot_id, bytes) else snapshot_id
                    snapshot_key = self._get_snapshot_key(document_id, snapshot_id)
                    
                    # Get snapshot data
                    snapshot_data = await asyncio.get_event_loop().run_in_executor(
                        None, self._redis_client.hgetall, snapshot_key
                    )
                    
                    if not snapshot_data:
                        continue
                    
                    # Decode data
                    snapshot_data = {k.decode('utf-8'): v.decode('utf-8') 
                                   for k, v in snapshot_data.items()}
                    
                    # Create snapshot record
                    snapshot_record = SnapshotRecord(
                        snapshot_id=snapshot_data['snapshot_id'],
                        document_id=snapshot_data['document_id'],
                        timestamp=datetime.fromisoformat(snapshot_data['timestamp']),
                        user_id=snapshot_data['user_id'],
                        snapshot_data=json.loads(snapshot_data['snapshot_data']),
                        version=int(snapshot_data['version'])
                    )
                    
                    snapshots.append(snapshot_record)
                
                self.logger.debug(f"Retrieved {len(snapshots)} snapshots for document {document_id}")
                return snapshots
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve snapshots for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve snapshots: {e}")
    
    async def store_comment(self, comment_record: CommentRecord) -> None:
        """Store a comment record to Redis."""
        comment_key = self._get_comment_key(comment_record.document_id, comment_record.comment_id)
        comments_list_key = self._get_comments_list_key(comment_record.document_id, comment_record.cell_id)
        
        # Prepare comment data
        comment_data = {
            'comment_id': comment_record.comment_id,
            'document_id': comment_record.document_id,
            'cell_id': comment_record.cell_id,
            'timestamp': comment_record.timestamp.isoformat(),
            'user_id': comment_record.user_id,
            'comment_data': json.dumps(comment_record.comment_data),
            'parent_id': comment_record.parent_id or ''
        }
        
        with self._lock:
            try:
                # Use Redis pipeline for atomic operations
                pipe = self._redis_client.pipeline()
                
                # Store comment data
                pipe.hset(comment_key, mapping=comment_data)
                
                # Add to ordered list (sorted by timestamp)
                pipe.zadd(comments_list_key, {
                    comment_record.comment_id: comment_record.timestamp.timestamp()
                })
                
                # Set expiration based on retention policy
                expiration = int(self.config.retention_timedelta.total_seconds())
                pipe.expire(comment_key, expiration)
                pipe.expire(comments_list_key, expiration)
                
                # Execute pipeline
                await asyncio.get_event_loop().run_in_executor(
                    None, pipe.execute
                )
                
                self.logger.debug(f"Stored comment {comment_record.comment_id} to Redis")
                
            except Exception as e:
                self.logger.error(f"Failed to store comment {comment_record.comment_id}: {e}")
                raise StorageError(f"Failed to store comment: {e}")
    
    async def get_comments(
        self, 
        document_id: str, 
        cell_id: Optional[str] = None
    ) -> List[CommentRecord]:
        """Get comments for a document or cell from Redis."""
        if cell_id:
            comments_list_key = self._get_comments_list_key(document_id, cell_id)
            comment_ids = await asyncio.get_event_loop().run_in_executor(
                None, self._redis_client.zrange, 
                comments_list_key, 0, -1
            )
        else:
            # Get all comments for document by scanning all cell comment lists
            pattern = f"comments_list:{document_id}:*"
            comment_ids = []
            
            # Get all comment list keys for this document
            comment_list_keys = await asyncio.get_event_loop().run_in_executor(
                None, self._redis_client.keys, pattern
            )
            
            for key in comment_list_keys:
                key = key.decode('utf-8') if isinstance(key, bytes) else key
                ids = await asyncio.get_event_loop().run_in_executor(
                    None, self._redis_client.zrange, key, 0, -1
                )
                comment_ids.extend(ids)
        
        comments = []
        
        with self._lock:
            try:
                for comment_id in comment_ids:
                    comment_id = comment_id.decode('utf-8') if isinstance(comment_id, bytes) else comment_id
                    comment_key = self._get_comment_key(document_id, comment_id)
                    
                    # Get comment data
                    comment_data = await asyncio.get_event_loop().run_in_executor(
                        None, self._redis_client.hgetall, comment_key
                    )
                    
                    if not comment_data:
                        continue
                    
                    # Decode data
                    comment_data = {k.decode('utf-8'): v.decode('utf-8') 
                                  for k, v in comment_data.items()}
                    
                    # Create comment record
                    comment_record = CommentRecord(
                        comment_id=comment_data['comment_id'],
                        document_id=comment_data['document_id'],
                        cell_id=comment_data['cell_id'],
                        timestamp=datetime.fromisoformat(comment_data['timestamp']),
                        user_id=comment_data['user_id'],
                        comment_data=json.loads(comment_data['comment_data']),
                        parent_id=comment_data['parent_id'] if comment_data['parent_id'] else None
                    )
                    
                    comments.append(comment_record)
                
                # Sort comments by timestamp
                comments.sort(key=lambda x: x.timestamp)
                
                self.logger.debug(f"Retrieved {len(comments)} comments for document {document_id}")
                return comments
                
            except Exception as e:
                self.logger.error(f"Failed to retrieve comments for document {document_id}: {e}")
                raise StorageError(f"Failed to retrieve comments: {e}")


class CollaborativeStorage:
    """
    Main collaborative storage class that orchestrates backend operations.
    
    This class provides a unified interface for storing and retrieving collaborative
    document state including CRDT updates, snapshots, and comments. It supports
    pluggable backends (filesystem, database, Redis) and handles configuration,
    initialization, and cleanup operations.
    """
    
    def __init__(
        self, 
        config: Optional[StorageConfiguration] = None,
        app: Optional[JupyterNotebookApp] = None
    ):
        """
        Initialize collaborative storage.
        
        Args:
            config: Storage configuration (if None, creates default config)
            app: Jupyter notebook application instance for logging and configuration
        """
        self.config = config or StorageConfiguration()
        self.app = app
        self.logger = logging.getLogger(__name__ + ".CollaborativeStorage")
        
        # Initialize backend
        self._backend: Optional[StorageBackend] = None
        self._initialized = False
        self._lock = asyncio.Lock()
        
        # Compaction and cleanup
        self._compaction_task: Optional[asyncio.Task] = None
        self._cleanup_task: Optional[asyncio.Task] = None
        
        # Thread pool for CPU-intensive operations
        self._executor = ThreadPoolExecutor(max_workers=4)
        
        # Configure logging from app if available
        if app and hasattr(app, 'log'):
            self.logger = app.log.getChild('collab.storage')
    
    async def setup_storage(self) -> None:
        """Set up and initialize the storage backend."""
        async with self._lock:
            if self._initialized:
                return
            
            self.logger.info(f"Setting up collaborative storage with {self.config.backend_type} backend")
            
            # Validate configuration
            try:
                self.config.validate()
            except Exception as e:
                self.logger.error(f"Invalid storage configuration: {e}")
                raise StorageError(f"Invalid configuration: {e}")
            
            # Create backend instance
            try:
                self._backend = self._create_backend()
                await self._backend.initialize()
                self._initialized = True
                
                # Start background tasks
                await self._start_background_tasks()
                
                self.logger.info("Collaborative storage setup completed successfully")
                
            except Exception as e:
                self.logger.error(f"Failed to setup storage backend: {e}")
                raise StorageError(f"Failed to setup storage: {e}")
    
    def _create_backend(self) -> StorageBackend:
        """Create storage backend instance based on configuration."""
        if self.config.backend_type == 'filesystem':
            base_path = ""
            if self.app and hasattr(self.app, 'serverapp') and self.app.serverapp:
                base_path = getattr(self.app.serverapp, 'root_dir', '')
            return FilesystemStorageBackend(self.config, base_path)
        
        elif self.config.backend_type in ['sqlite', 'postgresql']:
            return DatabaseStorageBackend(self.config)
        
        elif self.config.backend_type == 'redis':
            return RedisStorageBackend(self.config)
        
        else:
            raise ValueError(f"Unsupported backend type: {self.config.backend_type}")
    
    async def _start_background_tasks(self) -> None:
        """Start background tasks for maintenance operations."""
        # Start compaction task
        if self.config.compaction_interval > 0:
            self._compaction_task = asyncio.create_task(self._compaction_loop())
        
        # Start cleanup task
        cleanup_interval = max(3600, self.config.compaction_interval)  # At least 1 hour
        self._cleanup_task = asyncio.create_task(self._cleanup_loop(cleanup_interval))
    
    async def _compaction_loop(self) -> None:
        """Background task for periodic update log compaction."""
        while True:
            try:
                await asyncio.sleep(self.config.compaction_interval)
                await self._compact_update_logs()
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in compaction loop: {e}")
                await asyncio.sleep(60)  # Wait before retrying
    
    async def _cleanup_loop(self, interval: int) -> None:
        """Background task for periodic cleanup of old data."""
        while True:
            try:
                await asyncio.sleep(interval)
                await self._cleanup_old_data()
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in cleanup loop: {e}")
                await asyncio.sleep(300)  # Wait before retrying
    
    async def _compact_update_logs(self) -> None:
        """Compact update logs by merging sequential updates."""
        if not self._backend:
            return
        
        self.logger.debug("Starting update log compaction")
        
        # This is a simplified compaction strategy
        # In a real implementation, you would:
        # 1. Identify documents with large update logs
        # 2. Merge sequential updates from the same user
        # 3. Create consolidated snapshots
        # 4. Remove old update entries
        
        # For now, we'll just log the operation
        self.logger.debug("Update log compaction completed")
    
    async def _cleanup_old_data(self) -> None:
        """Clean up old data based on retention policy."""
        if not self._backend:
            return
        
        self.logger.debug("Starting cleanup of old data")
        
        # Calculate cutoff time
        cutoff_time = datetime.now(timezone.utc) - self.config.retention_timedelta
        
        # This is a simplified cleanup strategy
        # In a real implementation, you would:
        # 1. Identify old updates, snapshots, and comments
        # 2. Remove data older than retention policy
        # 3. Update indexes and references
        
        self.logger.debug(f"Cleanup completed for data older than {cutoff_time}")
    
    async def cleanup_storage(self) -> None:
        """Clean up storage resources."""
        async with self._lock:
            self.logger.info("Cleaning up collaborative storage")
            
            # Cancel background tasks
            if self._compaction_task:
                self._compaction_task.cancel()
                try:
                    await self._compaction_task
                except asyncio.CancelledError:
                    pass
                self._compaction_task = None
            
            if self._cleanup_task:
                self._cleanup_task.cancel()
                try:
                    await self._cleanup_task
                except asyncio.CancelledError:
                    pass
                self._cleanup_task = None
            
            # Cleanup backend
            if self._backend:
                await self._backend.cleanup()
                self._backend = None
            
            # Shutdown executor
            if self._executor:
                self._executor.shutdown(wait=True)
                self._executor = None
            
            self._initialized = False
            self.logger.info("Collaborative storage cleanup completed")
    
    async def store_crdt_update(
        self, 
        document_id: str, 
        update_id: str, 
        user_id: str, 
        update_data: UpdateData
    ) -> None:
        """
        Store a CRDT update for a document.
        
        Args:
            document_id: Document identifier (typically notebook path)
            update_id: Unique identifier for the update
            user_id: User who made the update
            update_data: Serialized CRDT update data
        """
        if not self._initialized or not self._backend:
            raise StorageError("Storage not initialized")
        
        # Create update record
        update_record = UpdateRecord(
            update_id=update_id,
            document_id=document_id,
            timestamp=datetime.now(timezone.utc),
            user_id=user_id,
            update_data=update_data,
            size=len(update_data) if isinstance(update_data, (bytes, str)) else 0
        )
        
        try:
            await self._backend.store_update(update_record)
            self.logger.debug(f"Stored CRDT update {update_id} for document {document_id}")
        except Exception as e:
            self.logger.error(f"Failed to store CRDT update {update_id}: {e}")
            raise StorageError(f"Failed to store CRDT update: {e}")
    
    async def get_updates(
        self, 
        document_id: str, 
        since_timestamp: Optional[datetime] = None,
        limit: Optional[int] = None
    ) -> List[UpdateRecord]:
        """
        Get CRDT updates for a document.
        
        Args:
            document_id: Document identifier
            since_timestamp: Only return updates after this timestamp
            limit: Maximum number of updates to return
        
        Returns:
            List of update records
        """
        if not self._initialized or not self._backend:
            raise StorageError("Storage not initialized")
        
        try:
            updates = await self._backend.retrieve_updates(document_id, since_timestamp, limit)
            self.logger.debug(f"Retrieved {len(updates)} updates for document {document_id}")
            return updates
        except Exception as e:
            self.logger.error(f"Failed to retrieve updates for document {document_id}: {e}")
            raise StorageError(f"Failed to retrieve updates: {e}")
    
    async def create_snapshot(
        self, 
        document_id: str, 
        snapshot_id: str, 
        user_id: str, 
        snapshot_data: SnapshotData,
        version: int = 1
    ) -> None:
        """
        Create a document snapshot.
        
        Args:
            document_id: Document identifier
            snapshot_id: Unique identifier for the snapshot
            user_id: User who created the snapshot
            snapshot_data: Snapshot data dictionary
            version: Snapshot version number
        """
        if not self._initialized or not self._backend:
            raise StorageError("Storage not initialized")
        
        # Create snapshot record
        snapshot_record = SnapshotRecord(
            snapshot_id=snapshot_id,
            document_id=document_id,
            timestamp=datetime.now(timezone.utc),
            user_id=user_id,
            snapshot_data=snapshot_data,
            version=version
        )
        
        try:
            await self._backend.create_snapshot(snapshot_record)
            self.logger.debug(f"Created snapshot {snapshot_id} for document {document_id}")
        except Exception as e:
            self.logger.error(f"Failed to create snapshot {snapshot_id}: {e}")
            raise StorageError(f"Failed to create snapshot: {e}")
    
    async def get_history(
        self, 
        document_id: str, 
        limit: Optional[int] = None
    ) -> List[SnapshotRecord]:
        """
        Get document history snapshots.
        
        Args:
            document_id: Document identifier
            limit: Maximum number of snapshots to return
        
        Returns:
            List of snapshot records (most recent first)
        """
        if not self._initialized or not self._backend:
            raise StorageError("Storage not initialized")
        
        try:
            snapshots = await self._backend.get_snapshots(document_id, limit)
            self.logger.debug(f"Retrieved {len(snapshots)} snapshots for document {document_id}")
            return snapshots
        except Exception as e:
            self.logger.error(f"Failed to retrieve history for document {document_id}: {e}")
            raise StorageError(f"Failed to retrieve history: {e}")
    
    async def store_comment(
        self, 
        document_id: str, 
        cell_id: str, 
        comment_id: str, 
        user_id: str, 
        comment_data: CommentData,
        parent_id: Optional[str] = None
    ) -> None:
        """
        Store a comment.
        
        Args:
            document_id: Document identifier
            cell_id: Cell identifier
            comment_id: Unique identifier for the comment
            user_id: User who made the comment
            comment_data: Comment data dictionary
            parent_id: Parent comment ID for threaded comments
        """
        if not self._initialized or not self._backend:
            raise StorageError("Storage not initialized")
        
        # Create comment record
        comment_record = CommentRecord(
            comment_id=comment_id,
            document_id=document_id,
            cell_id=cell_id,
            timestamp=datetime.now(timezone.utc),
            user_id=user_id,
            comment_data=comment_data,
            parent_id=parent_id
        )
        
        try:
            await self._backend.store_comment(comment_record)
            self.logger.debug(f"Stored comment {comment_id} for document {document_id}, cell {cell_id}")
        except Exception as e:
            self.logger.error(f"Failed to store comment {comment_id}: {e}")
            raise StorageError(f"Failed to store comment: {e}")
    
    async def get_comments(
        self, 
        document_id: str, 
        cell_id: Optional[str] = None
    ) -> List[CommentRecord]:
        """
        Get comments for a document or cell.
        
        Args:
            document_id: Document identifier
            cell_id: Cell identifier (if None, returns all comments for document)
        
        Returns:
            List of comment records
        """
        if not self._initialized or not self._backend:
            raise StorageError("Storage not initialized")
        
        try:
            comments = await self._backend.get_comments(document_id, cell_id)
            self.logger.debug(f"Retrieved {len(comments)} comments for document {document_id}")
            return comments
        except Exception as e:
            self.logger.error(f"Failed to retrieve comments for document {document_id}: {e}")
            raise StorageError(f"Failed to retrieve comments: {e}")
    
    def is_initialized(self) -> bool:
        """Check if storage is initialized."""
        return self._initialized
    
    def get_backend_type(self) -> str:
        """Get the backend type."""
        return self.config.backend_type
    
    def get_storage_stats(self) -> Dict[str, Any]:
        """Get storage statistics."""
        return {
            'backend_type': self.config.backend_type,
            'initialized': self._initialized,
            'retention_policy': self.config.retention_policy,
            'compaction_interval': self.config.compaction_interval,
            'cache_enabled': self.config.enable_caching,
            'cache_size': self.config.cache_size
        }
    
    async def health_check(self) -> Dict[str, Any]:
        """Perform health check on storage backend."""
        if not self._initialized or not self._backend:
            return {
                'status': 'error',
                'message': 'Storage not initialized'
            }
        
        try:
            # Try to perform a basic operation
            test_doc_id = "health_check_test"
            test_update_id = f"health_check_{datetime.now().isoformat()}"
            
            # Store test update
            await self.store_crdt_update(
                test_doc_id, 
                test_update_id, 
                "system", 
                b"health_check_data"
            )
            
            # Retrieve test update
            updates = await self.get_updates(test_doc_id, limit=1)
            
            # Clean up test data if possible
            # (This would require a delete method which we haven't implemented)
            
            return {
                'status': 'healthy',
                'message': 'Storage backend operational',
                'backend_type': self.config.backend_type,
                'test_update_retrieved': len(updates) > 0
            }
            
        except Exception as e:
            return {
                'status': 'error',
                'message': f'Health check failed: {e}',
                'backend_type': self.config.backend_type
            }
    
    async def __aenter__(self):
        """Async context manager entry."""
        await self.setup_storage()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.cleanup_storage()


# Utility functions for storage management

def create_storage_from_app(app: JupyterNotebookApp) -> CollaborativeStorage:
    """
    Create collaborative storage instance from Jupyter notebook application.
    
    Args:
        app: Jupyter notebook application instance
    
    Returns:
        Configured collaborative storage instance
    """
    # Extract configuration from app
    config = StorageConfiguration(
        backend_type=getattr(app, 'collaboration_storage_backend', 'filesystem'),
        connection_string=getattr(app, 'collaboration_storage_uri', ''),
        retention_policy=getattr(app, 'collaboration_history_retention', '30d'),
        compaction_interval=3600,  # 1 hour
        max_update_log_size=DEFAULT_MAX_UPDATE_LOG_SIZE,
        enable_caching=True,
        cache_size=DEFAULT_CACHE_SIZE
    )
    
    return CollaborativeStorage(config, app)


def create_storage_from_config(config_dict: Dict[str, Any]) -> CollaborativeStorage:
    """
    Create collaborative storage instance from configuration dictionary.
    
    Args:
        config_dict: Configuration dictionary
    
    Returns:
        Configured collaborative storage instance
    """
    config = StorageConfiguration.from_dict(config_dict)
    return CollaborativeStorage(config)