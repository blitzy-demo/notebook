"""
Yjs document provider for server-side CRDT operations and collaborative state management.

This module implements a comprehensive Yjs document provider that serves as the core component
for collaborative notebook editing. It handles document synchronization, conflict resolution,
and persistence while maintaining backward compatibility with the standard .ipynb format.

The YjsNotebookProvider class manages the lifecycle of collaborative documents, provides
bidirectional conversion between notebook JSON and Yjs shared types, and integrates seamlessly
with the distributed locking system and collaboration infrastructure.

Key features:
- Server-side CRDT document management using pycrdt
- Bidirectional notebook JSON ↔ Yjs shared types conversion
- Document state persistence and recovery mechanisms
- Integration with cell-level locking system
- Performance optimization for sub-100ms latency
- Graceful degradation and error recovery
- Comprehensive monitoring and metrics collection
"""

import asyncio
import json
import time
import weakref
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Callable, Tuple, Union, AsyncGenerator
from dataclasses import dataclass, asdict
import uuid
import copy
import gzip
import hashlib
from pathlib import Path

try:
    import pycrdt
    from pycrdt import Doc as YDoc, Map as YMap, Array as YArray, Text as YText
    HAS_PYCRDT = True
except ImportError:
    HAS_PYCRDT = False
    # Fallback type hints for when pycrdt is not available
    YDoc = Any
    YMap = Any
    YArray = Any
    YText = Any

from .utils import (
    CollaborationConfig, CollaborationLogger, CollaborationMetrics,
    CollaborationError, CollaborationConnectionError, CollaborationSerializationError,
    GracefulDegradationManager, RetryConfig, with_retry, error_context,
    get_collaboration_config, get_collaboration_logger, get_collaboration_metrics,
    get_degradation_manager, monitor_performance, YjsDocumentSerializer,
    format_collaboration_message, sanitize_user_data
)
from .locks import LockManager, LockInfo, LockType, LockState, create_lock_manager


class DocumentState(Enum):
    """Enumeration of document lifecycle states."""
    INITIALIZING = "initializing"
    READY = "ready"
    SYNCING = "syncing"
    PERSISTING = "persisting"
    ERROR = "error"
    CLOSED = "closed"


class SyncOperation(Enum):
    """Types of synchronization operations."""
    LOAD = "load"
    SAVE = "save"
    UPDATE = "update"
    MERGE = "merge"
    RECOVER = "recover"


@dataclass
class DocumentSnapshot:
    """Snapshot of a document state at a specific time."""
    document_id: str
    timestamp: float
    state_vector: bytes
    update: bytes
    notebook_content: Dict[str, Any]
    metadata: Dict[str, Any]
    user_count: int
    lock_count: int
    version: int


@dataclass
class UpdateInfo:
    """Information about a document update."""
    update_id: str
    timestamp: float
    user_id: str
    operation_type: str
    update_data: bytes
    origin: str
    metadata: Dict[str, Any]


class YjsNotebookProvider:
    """
    Comprehensive Yjs document provider for collaborative notebook editing.
    
    This class serves as the central coordinator for all collaborative document operations,
    providing server-side CRDT management, state synchronization, and persistence while
    maintaining full backward compatibility with standard notebook formats.
    
    The provider implements a layered architecture where:
    1. Yjs Y.Doc provides CRDT conflict resolution
    2. Notebook JSON structure is preserved for compatibility
    3. Collaboration metadata is stored separately
    4. Lock management ensures editing conflicts are prevented
    5. State recovery mechanisms handle connection failures
    """
    
    def __init__(self, document_id: str, file_path: Optional[str] = None,
                 config: Optional[CollaborationConfig] = None,
                 lock_manager: Optional[LockManager] = None):
        """
        Initialize the Yjs notebook provider.
        
        Args:
            document_id: Unique identifier for the collaborative document
            file_path: Path to the notebook file (optional, for persistence)
            config: Collaboration configuration (optional, uses global if not provided)
            lock_manager: Lock manager instance (optional, creates new if not provided)
        """
        self.document_id = document_id
        self.file_path = file_path
        self.config = config or get_collaboration_config()
        self.logger = get_collaboration_logger()
        self.metrics = get_collaboration_metrics()
        self.degradation_manager = get_degradation_manager()
        
        # Core Yjs document and shared state
        self.yjs_doc: Optional[YDoc] = None
        self._cells_array: Optional[YArray] = None
        self._metadata_map: Optional[YMap] = None
        self._collaboration_map: Optional[YMap] = None
        self._history_array: Optional[YArray] = None
        self._awareness_map: Optional[YMap] = None
        
        # Document state management
        self._state = DocumentState.INITIALIZING
        self._version = 0
        self._last_save_time = 0.0
        self._last_update_time = 0.0
        self._change_count = 0
        self._pending_saves = 0
        
        # Notebook content caching
        self._cached_notebook: Optional[Dict[str, Any]] = None
        self._cache_valid = False
        self._content_hash = ""
        
        # Collaboration state
        self.lock_manager = lock_manager or create_lock_manager(document_id, config=config)
        self._connected_users: Dict[str, Dict[str, Any]] = {}
        self._active_sessions: Set[str] = set()
        self._update_buffer: List[UpdateInfo] = []
        
        # Performance tracking
        self._operation_metrics = {
            'load_count': 0,
            'save_count': 0,
            'update_count': 0,
            'merge_count': 0,
            'error_count': 0,
            'total_latency': 0.0
        }
        
        # Event handlers and callbacks
        self._update_callbacks: List[Callable] = []
        self._state_callbacks: List[Callable] = []
        self._error_callbacks: List[Callable] = []
        
        # Persistence settings
        self._auto_save_enabled = True
        self._save_interval = 30.0  # seconds
        self._snapshot_interval = 300.0  # 5 minutes
        self._save_task: Optional[asyncio.Task] = None
        self._snapshot_task: Optional[asyncio.Task] = None
        
        # Initialize if pycrdt is available
        if HAS_PYCRDT:
            self._initialize_yjs_document()
        else:
            self.logger.logger.warning(
                f"pycrdt not available, provider {document_id} running in degraded mode"
            )
    
    def _initialize_yjs_document(self):
        """Initialize the Yjs document and shared data structures."""
        try:
            # Create the main Yjs document
            self.yjs_doc = YDoc()
            
            # Initialize shared data structures following the specified schema
            # Root Y.Doc contains Y.Array for cells mirroring notebook structure
            self._cells_array = self.yjs_doc.get("cells", type=YArray)
            
            # Y.Map for notebook metadata (nbformat, nbformat_minor, etc.)
            self._metadata_map = self.yjs_doc.get("metadata", type=YMap)
            
            # Separate Y.Map for collaboration metadata (locks, comments, presence)
            self._collaboration_map = self.yjs_doc.get("collaboration", type=YMap)
            
            # Y.Array for document history and snapshots
            self._history_array = self.yjs_doc.get("history", type=YArray)
            
            # Y.Map for user awareness and presence
            self._awareness_map = self.yjs_doc.get("awareness", type=YMap)
            
            # Set up observers for change tracking
            self._cells_array.observe(self._on_cells_change)
            self._metadata_map.observe(self._on_metadata_change)
            self._collaboration_map.observe(self._on_collaboration_change)
            
            # Initialize lock manager with this document
            if self.lock_manager:
                self.lock_manager.yjs_doc = self.yjs_doc
                if hasattr(self.lock_manager, '_initialize_yjs_state'):
                    self.lock_manager._initialize_yjs_state()
            
            self._state = DocumentState.READY
            
            self.logger.logger.info(
                f"Initialized Yjs document provider for {self.document_id}",
                extra={
                    "document_id": self.document_id,
                    "file_path": self.file_path,
                    "yjs_version": getattr(pycrdt, '__version__', 'unknown')
                }
            )
            
        except Exception as e:
            self._state = DocumentState.ERROR
            self.logger.log_error(e, {
                "context": "yjs_initialization",
                "document_id": self.document_id
            })
            raise CollaborationError(f"Failed to initialize Yjs document: {e}")
    
    def _on_cells_change(self, event):
        """Handle changes to the cells array."""
        try:
            self._invalidate_cache()
            self._update_version()
            self._record_change("cells", event)
            self._trigger_update_callbacks("cells", event)
            
            # Update metrics
            self._operation_metrics['update_count'] += 1
            self.metrics.record_operation("cell_update", self.document_id, True, 0.0)
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "cells_change_handler",
                "document_id": self.document_id
            })
    
    def _on_metadata_change(self, event):
        """Handle changes to the metadata map."""
        try:
            self._invalidate_cache()
            self._update_version()
            self._record_change("metadata", event)
            self._trigger_update_callbacks("metadata", event)
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "metadata_change_handler",
                "document_id": self.document_id
            })
    
    def _on_collaboration_change(self, event):
        """Handle changes to the collaboration metadata."""
        try:
            self._record_change("collaboration", event)
            self._trigger_update_callbacks("collaboration", event)
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "collaboration_change_handler",
                "document_id": self.document_id
            })
    
    def _invalidate_cache(self):
        """Invalidate the cached notebook content."""
        self._cache_valid = False
        self._cached_notebook = None
        self._content_hash = ""
    
    def _update_version(self):
        """Update the document version and timestamps."""
        self._version += 1
        self._last_update_time = time.time()
        self._change_count += 1
        
        # Schedule auto-save if enabled
        if self._auto_save_enabled and not self._save_task:
            self._save_task = asyncio.create_task(
                self._auto_save_after_delay()
            )
    
    def _record_change(self, change_type: str, event):
        """Record a change in the document history."""
        if self._history_array is not None:
            try:
                change_record = {
                    'type': change_type,
                    'timestamp': time.time(),
                    'version': self._version,
                    'event_summary': self._summarize_event(event)
                }
                self._history_array.append([change_record])
                
                # Limit history size to prevent unbounded growth
                if len(self._history_array) > 1000:
                    # Remove oldest entries
                    for _ in range(100):
                        if len(self._history_array) > 0:
                            self._history_array.pop(0)
                            
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "record_change",
                    "change_type": change_type
                })
    
    def _summarize_event(self, event) -> Dict[str, Any]:
        """Create a summary of a Yjs event for history recording."""
        try:
            summary = {
                'action_count': len(getattr(event, 'changes', [])),
                'keys_changed': list(getattr(event, 'keys', {}).keys())[:10],  # Limit size
                'target_type': type(event.target).__name__ if hasattr(event, 'target') else 'unknown'
            }
            return summary
        except Exception:
            return {'summary': 'event_summary_failed'}
    
    @monitor_performance("load_notebook")
    async def load_notebook(self, notebook_content: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Load notebook content into the Yjs document.
        
        Args:
            notebook_content: Notebook JSON content (optional, loads from file if not provided)
        
        Returns:
            The loaded notebook content
        
        Raises:
            CollaborationError: If loading fails
            CollaborationSerializationError: If content serialization fails
        """
        if not HAS_PYCRDT:
            raise CollaborationError("pycrdt not available for document loading")
        
        self._state = DocumentState.SYNCING
        
        with error_context("load_notebook", document_id=self.document_id):
            try:
                # Load content from file if not provided
                if notebook_content is None:
                    notebook_content = await self._load_notebook_from_file()
                
                # Validate notebook structure
                self._validate_notebook_structure(notebook_content)
                
                # Convert notebook to Yjs shared types
                await self._notebook_to_yjs(notebook_content)
                
                # Cache the loaded content
                self._cached_notebook = copy.deepcopy(notebook_content)
                self._cache_valid = True
                self._content_hash = self._compute_content_hash(notebook_content)
                
                # Update metrics
                self._operation_metrics['load_count'] += 1
                self._last_save_time = time.time()
                
                self._state = DocumentState.READY
                self._trigger_state_callbacks(DocumentState.READY)
                
                self.logger.logger.info(
                    f"Successfully loaded notebook {self.document_id}",
                    extra={
                        "document_id": self.document_id,
                        "cell_count": len(notebook_content.get('cells', [])),
                        "version": self._version
                    }
                )
                
                return notebook_content
                
            except Exception as e:
                self._state = DocumentState.ERROR
                self._operation_metrics['error_count'] += 1
                self._trigger_state_callbacks(DocumentState.ERROR)
                raise CollaborationError(f"Failed to load notebook: {e}")
    
    async def _load_notebook_from_file(self) -> Dict[str, Any]:
        """Load notebook content from the file system."""
        if not self.file_path:
            raise CollaborationError("No file path specified for loading")
        
        try:
            file_path = Path(self.file_path)
            if not file_path.exists():
                # Create a new empty notebook
                return self._create_empty_notebook()
            
            with open(file_path, 'r', encoding='utf-8') as f:
                content = json.load(f)
            
            return content
            
        except Exception as e:
            raise CollaborationSerializationError(f"Failed to load notebook from file: {e}")
    
    def _create_empty_notebook(self) -> Dict[str, Any]:
        """Create an empty notebook structure."""
        return {
            "cells": [],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        }
    
    def _validate_notebook_structure(self, notebook: Dict[str, Any]):
        """Validate that notebook has required structure."""
        required_fields = ['cells', 'metadata', 'nbformat']
        for field in required_fields:
            if field not in notebook:
                raise CollaborationSerializationError(f"Missing required field: {field}")
        
        if not isinstance(notebook['cells'], list):
            raise CollaborationSerializationError("Notebook cells must be a list")
        
        if not isinstance(notebook['metadata'], dict):
            raise CollaborationSerializationError("Notebook metadata must be a dict")
    
    async def _notebook_to_yjs(self, notebook: Dict[str, Any]):
        """Convert notebook JSON to Yjs shared types."""
        if not self.yjs_doc:
            raise CollaborationError("Yjs document not initialized")
        
        try:
            # Clear existing content
            self._cells_array.clear()
            self._metadata_map.clear()
            
            # Convert cells to Yjs Y.Array of Y.Maps
            for cell in notebook['cells']:
                cell_map = YMap()
                
                # Basic cell properties
                if 'cell_type' in cell:
                    cell_map['cell_type'] = cell['cell_type']
                if 'id' in cell:
                    cell_map['id'] = cell['id']
                elif 'cell_id' in cell:
                    cell_map['id'] = cell['cell_id']
                else:
                    # Generate ID if missing
                    cell_map['id'] = str(uuid.uuid4())
                
                # Cell source content
                if 'source' in cell:
                    source_text = YText()
                    if isinstance(cell['source'], list):
                        source_text.extend(''.join(cell['source']))
                    else:
                        source_text.extend(str(cell['source']))
                    cell_map['source'] = source_text
                
                # Cell outputs (for code cells)
                if 'outputs' in cell:
                    outputs_array = YArray()
                    for output in cell['outputs']:
                        output_map = YMap()
                        for key, value in output.items():
                            output_map[key] = json.dumps(value) if not isinstance(value, (str, int, float, bool)) else value
                        outputs_array.append([output_map])
                    cell_map['outputs'] = outputs_array
                
                # Cell metadata
                if 'metadata' in cell:
                    metadata_map = YMap()
                    for key, value in cell['metadata'].items():
                        metadata_map[key] = json.dumps(value) if not isinstance(value, (str, int, float, bool)) else value
                    cell_map['metadata'] = metadata_map
                
                # Execution count for code cells
                if 'execution_count' in cell:
                    cell_map['execution_count'] = cell['execution_count']
                
                self._cells_array.append([cell_map])
            
            # Convert notebook metadata
            for key, value in notebook['metadata'].items():
                self._metadata_map[key] = json.dumps(value) if not isinstance(value, (str, int, float, bool)) else value
            
            # Add format version info
            self._metadata_map['nbformat'] = notebook.get('nbformat', 4)
            self._metadata_map['nbformat_minor'] = notebook.get('nbformat_minor', 5)
            
            # Initialize collaboration metadata if empty
            if not self._collaboration_map:
                self._collaboration_map['created_at'] = time.time()
                self._collaboration_map['last_modified'] = time.time()
                self._collaboration_map['version'] = self._version
            
        except Exception as e:
            raise CollaborationSerializationError(f"Failed to convert notebook to Yjs: {e}")
    
    @monitor_performance("save_notebook")
    async def save_notebook(self, file_path: Optional[str] = None) -> Dict[str, Any]:
        """
        Save the current Yjs document state as a notebook file.
        
        Args:
            file_path: Path to save the notebook (optional, uses instance file_path if not provided)
        
        Returns:
            The saved notebook content
        
        Raises:
            CollaborationError: If saving fails
        """
        if not HAS_PYCRDT or not self.yjs_doc:
            raise CollaborationError("Yjs document not available for saving")
        
        self._state = DocumentState.PERSISTING
        self._pending_saves += 1
        
        with error_context("save_notebook", document_id=self.document_id):
            try:
                # Convert Yjs state to notebook JSON
                notebook_content = await self._yjs_to_notebook()
                
                # Save to file if path provided
                target_path = file_path or self.file_path
                if target_path:
                    await self._save_notebook_to_file(notebook_content, target_path)
                
                # Update cache and metrics
                self._cached_notebook = copy.deepcopy(notebook_content)
                self._cache_valid = True
                self._content_hash = self._compute_content_hash(notebook_content)
                self._last_save_time = time.time()
                self._operation_metrics['save_count'] += 1
                self._pending_saves = max(0, self._pending_saves - 1)
                
                # Update collaboration metadata
                if self._collaboration_map:
                    self._collaboration_map['last_saved'] = time.time()
                    self._collaboration_map['save_count'] = self._operation_metrics['save_count']
                
                self._state = DocumentState.READY
                self._trigger_state_callbacks(DocumentState.READY)
                
                self.logger.logger.info(
                    f"Successfully saved notebook {self.document_id}",
                    extra={
                        "document_id": self.document_id,
                        "file_path": target_path,
                        "cell_count": len(notebook_content.get('cells', [])),
                        "version": self._version
                    }
                )
                
                return notebook_content
                
            except Exception as e:
                self._pending_saves = max(0, self._pending_saves - 1)
                self._state = DocumentState.ERROR
                self._operation_metrics['error_count'] += 1
                self._trigger_state_callbacks(DocumentState.ERROR)
                raise CollaborationError(f"Failed to save notebook: {e}")
    
    async def _yjs_to_notebook(self) -> Dict[str, Any]:
        """Convert Yjs shared types back to notebook JSON format."""
        if not self._cells_array or not self._metadata_map:
            raise CollaborationError("Yjs document not properly initialized")
        
        try:
            notebook = {}
            
            # Convert cells from Yjs Y.Array to list
            cells = []
            for cell_map in self._cells_array:
                if not isinstance(cell_map, YMap):
                    continue
                
                cell = {}
                
                # Basic cell properties
                if 'cell_type' in cell_map:
                    cell['cell_type'] = cell_map['cell_type']
                if 'id' in cell_map:
                    cell['id'] = cell_map['id']
                
                # Cell source
                if 'source' in cell_map:
                    source = cell_map['source']
                    if isinstance(source, YText):
                        cell['source'] = str(source)
                    else:
                        cell['source'] = str(source) if source else ""
                
                # Cell outputs
                if 'outputs' in cell_map:
                    outputs_array = cell_map['outputs']
                    if isinstance(outputs_array, YArray):
                        outputs = []
                        for output_map in outputs_array:
                            if isinstance(output_map, YMap):
                                output = {}
                                for key, value in output_map.items():
                                    try:
                                        # Try to parse JSON values
                                        output[key] = json.loads(value) if isinstance(value, str) and value.startswith(('{', '[', '"')) else value
                                    except (json.JSONDecodeError, TypeError):
                                        output[key] = value
                                outputs.append(output)
                        cell['outputs'] = outputs
                    else:
                        cell['outputs'] = []
                
                # Cell metadata
                if 'metadata' in cell_map:
                    metadata_map = cell_map['metadata']
                    if isinstance(metadata_map, YMap):
                        metadata = {}
                        for key, value in metadata_map.items():
                            try:
                                metadata[key] = json.loads(value) if isinstance(value, str) and value.startswith(('{', '[', '"')) else value
                            except (json.JSONDecodeError, TypeError):
                                metadata[key] = value
                        cell['metadata'] = metadata
                    else:
                        cell['metadata'] = {}
                
                # Execution count
                if 'execution_count' in cell_map:
                    cell['execution_count'] = cell_map['execution_count']
                
                cells.append(cell)
            
            notebook['cells'] = cells
            
            # Convert metadata
            metadata = {}
            for key, value in self._metadata_map.items():
                if key in ['nbformat', 'nbformat_minor']:
                    metadata[key] = value
                else:
                    try:
                        metadata[key] = json.loads(value) if isinstance(value, str) and value.startswith(('{', '[', '"')) else value
                    except (json.JSONDecodeError, TypeError):
                        metadata[key] = value
            
            # Ensure required fields
            notebook['metadata'] = metadata
            notebook['nbformat'] = metadata.get('nbformat', 4)
            notebook['nbformat_minor'] = metadata.get('nbformat_minor', 5)
            
            return notebook
            
        except Exception as e:
            raise CollaborationSerializationError(f"Failed to convert Yjs to notebook: {e}")
    
    async def _save_notebook_to_file(self, notebook_content: Dict[str, Any], file_path: str):
        """Save notebook content to file system."""
        try:
            target_path = Path(file_path)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Create backup if file exists
            if target_path.exists():
                backup_path = target_path.with_suffix('.ipynb.bak')
                import shutil
                shutil.copy2(target_path, backup_path)
            
            # Write notebook content
            with open(target_path, 'w', encoding='utf-8') as f:
                json.dump(notebook_content, f, indent=2, ensure_ascii=False)
            
        except Exception as e:
            raise CollaborationSerializationError(f"Failed to save notebook to file: {e}")
    
    def _compute_content_hash(self, content: Dict[str, Any]) -> str:
        """Compute a hash of the notebook content for change detection."""
        try:
            content_str = json.dumps(content, sort_keys=True, separators=(',', ':'))
            return hashlib.sha256(content_str.encode('utf-8')).hexdigest()[:16]
        except Exception:
            return str(time.time())
    
    async def _auto_save_after_delay(self):
        """Perform auto-save after the configured delay."""
        try:
            await asyncio.sleep(self._save_interval)
            
            # Check if there are pending changes
            if self._change_count > 0 and self._state == DocumentState.READY:
                await self.save_notebook()
                self._change_count = 0
                
        except Exception as e:
            self.logger.log_error(e, {
                "context": "auto_save",
                "document_id": self.document_id
            })
        finally:
            self._save_task = None
    
    @monitor_performance("apply_update")
    async def apply_update(self, update_data: bytes, origin: str = "remote") -> bool:
        """
        Apply a Yjs update to the document.
        
        Args:
            update_data: Binary Yjs update data
            origin: Origin of the update (remote, local, etc.)
        
        Returns:
            True if update was applied successfully
        
        Raises:
            CollaborationError: If update application fails
        """
        if not HAS_PYCRDT or not self.yjs_doc:
            if self.degradation_manager.is_collaborative_mode():
                self.degradation_manager.enable_degradation("Yjs not available for updates")
            return False
        
        with error_context("apply_update", document_id=self.document_id, origin=origin):
            try:
                # Record update info
                update_info = UpdateInfo(
                    update_id=str(uuid.uuid4()),
                    timestamp=time.time(),
                    user_id=origin,
                    operation_type="update",
                    update_data=update_data,
                    origin=origin,
                    metadata={}
                )
                
                # Apply the update to the Yjs document
                self.yjs_doc.apply_update(update_data)
                
                # Buffer the update for batching
                self._update_buffer.append(update_info)
                
                # Update metrics
                self._operation_metrics['update_count'] += 1
                self.metrics.record_operation("apply_update", self.document_id, True, 0.0)
                
                # Invalidate cache since content changed
                self._invalidate_cache()
                
                self.logger.logger.debug(
                    f"Applied update to document {self.document_id}",
                    extra={
                        "document_id": self.document_id,
                        "origin": origin,
                        "update_size": len(update_data)
                    }
                )
                
                return True
                
            except Exception as e:
                self._operation_metrics['error_count'] += 1
                self.metrics.record_operation("apply_update", self.document_id, False, 0.0)
                raise CollaborationError(f"Failed to apply update: {e}")
    
    def get_state_vector(self) -> Optional[bytes]:
        """
        Get the current state vector of the document.
        
        Returns:
            Binary state vector data, or None if not available
        """
        if not self.yjs_doc:
            return None
        
        try:
            return self.yjs_doc.get_state_vector()
        except Exception as e:
            self.logger.log_error(e, {
                "context": "get_state_vector",
                "document_id": self.document_id
            })
            return None
    
    def get_update_since(self, state_vector: bytes) -> Optional[bytes]:
        """
        Get updates since the provided state vector.
        
        Args:
            state_vector: State vector to compute diff from
        
        Returns:
            Binary update data, or None if not available
        """
        if not self.yjs_doc:
            return None
        
        try:
            return self.yjs_doc.get_update(state_vector)
        except Exception as e:
            self.logger.log_error(e, {
                "context": "get_update_since",
                "document_id": self.document_id
            })
            return None
    
    async def get_notebook_content(self, use_cache: bool = True) -> Dict[str, Any]:
        """
        Get the current notebook content.
        
        Args:
            use_cache: Whether to use cached content if available
        
        Returns:
            Current notebook content as JSON
        """
        if use_cache and self._cache_valid and self._cached_notebook:
            return copy.deepcopy(self._cached_notebook)
        
        if not self.yjs_doc:
            if self._cached_notebook:
                return copy.deepcopy(self._cached_notebook)
            return self._create_empty_notebook()
        
        notebook_content = await self._yjs_to_notebook()
        
        # Update cache
        self._cached_notebook = copy.deepcopy(notebook_content)
        self._cache_valid = True
        self._content_hash = self._compute_content_hash(notebook_content)
        
        return notebook_content
    
    async def create_snapshot(self) -> DocumentSnapshot:
        """
        Create a snapshot of the current document state.
        
        Returns:
            DocumentSnapshot containing current state
        """
        try:
            state_vector = self.get_state_vector() or b""
            update = self.yjs_doc.get_update() if self.yjs_doc else b""
            notebook_content = await self.get_notebook_content()
            
            # Get current collaboration statistics
            all_locks = await self.lock_manager.get_all_locks()
            
            metadata = {
                'change_count': self._change_count,
                'last_update': self._last_update_time,
                'last_save': self._last_save_time,
                'operation_metrics': self._operation_metrics.copy(),
                'active_sessions': len(self._active_sessions),
                'content_hash': self._content_hash
            }
            
            snapshot = DocumentSnapshot(
                document_id=self.document_id,
                timestamp=time.time(),
                state_vector=state_vector,
                update=update,
                notebook_content=notebook_content,
                metadata=metadata,
                user_count=len(self._connected_users),
                lock_count=len(all_locks),
                version=self._version
            )
            
            # Record snapshot in history
            if self._history_array:
                snapshot_record = {
                    'type': 'snapshot',
                    'timestamp': snapshot.timestamp,
                    'version': snapshot.version,
                    'user_count': snapshot.user_count,
                    'lock_count': snapshot.lock_count
                }
                self._history_array.append([snapshot_record])
            
            return snapshot
            
        except Exception as e:
            raise CollaborationError(f"Failed to create snapshot: {e}")
    
    async def restore_from_snapshot(self, snapshot: DocumentSnapshot) -> bool:
        """
        Restore document state from a snapshot.
        
        Args:
            snapshot: DocumentSnapshot to restore from
        
        Returns:
            True if restoration was successful
        """
        if not HAS_PYCRDT:
            return False
        
        try:
            # Create new document and apply snapshot
            new_doc = YDoc()
            if snapshot.update:
                new_doc.apply_update(snapshot.update)
            
            # Replace current document
            old_doc = self.yjs_doc
            self.yjs_doc = new_doc
            
            # Reinitialize shared types
            self._initialize_yjs_document()
            
            # Update version and state
            self._version = snapshot.version
            self._cached_notebook = copy.deepcopy(snapshot.notebook_content)
            self._cache_valid = True
            self._content_hash = self._compute_content_hash(snapshot.notebook_content)
            
            self.logger.logger.info(
                f"Restored document {self.document_id} from snapshot",
                extra={
                    "document_id": self.document_id,
                    "snapshot_timestamp": snapshot.timestamp,
                    "restored_version": snapshot.version
                }
            )
            
            return True
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "restore_from_snapshot",
                "document_id": self.document_id
            })
            return False
    
    def add_user_session(self, user_id: str, session_id: str, user_info: Dict[str, Any]):
        """
        Add a user session to the document.
        
        Args:
            user_id: User identifier
            session_id: Session identifier
            user_info: User information dictionary
        """
        safe_user_info = sanitize_user_data(user_info)
        safe_user_info.update({
            'session_id': session_id,
            'connected_at': time.time(),
            'last_activity': time.time()
        })
        
        self._connected_users[user_id] = safe_user_info
        self._active_sessions.add(session_id)
        
        # Update awareness
        if self._awareness_map:
            self._awareness_map[f"user_{user_id}"] = json.dumps(safe_user_info)
        
        # Record metrics
        self.metrics.record_active_users(self.document_id, len(self._connected_users))
        
        self.logger.logger.info(
            f"User {user_id} connected to document {self.document_id}",
            extra={
                "document_id": self.document_id,
                "user_id": user_id,
                "session_id": session_id,
                "total_users": len(self._connected_users)
            }
        )
    
    def remove_user_session(self, user_id: str, session_id: str):
        """
        Remove a user session from the document.
        
        Args:
            user_id: User identifier
            session_id: Session identifier
        """
        if user_id in self._connected_users:
            del self._connected_users[user_id]
        
        self._active_sessions.discard(session_id)
        
        # Update awareness
        if self._awareness_map:
            user_key = f"user_{user_id}"
            if user_key in self._awareness_map:
                del self._awareness_map[user_key]
        
        # Release user locks
        asyncio.create_task(self.lock_manager.release_user_locks(user_id))
        
        # Record metrics
        self.metrics.record_active_users(self.document_id, len(self._connected_users))
        
        self.logger.logger.info(
            f"User {user_id} disconnected from document {self.document_id}",
            extra={
                "document_id": self.document_id,
                "user_id": user_id,
                "session_id": session_id,
                "remaining_users": len(self._connected_users)
            }
        )
    
    def get_connected_users(self) -> Dict[str, Dict[str, Any]]:
        """Get all currently connected users."""
        return copy.deepcopy(self._connected_users)
    
    def get_document_statistics(self) -> Dict[str, Any]:
        """
        Get comprehensive document statistics.
        
        Returns:
            Dictionary containing document statistics
        """
        return {
            'document_id': self.document_id,
            'state': self._state.value,
            'version': self._version,
            'connected_users': len(self._connected_users),
            'active_sessions': len(self._active_sessions),
            'change_count': self._change_count,
            'last_update': self._last_update_time,
            'last_save': self._last_save_time,
            'pending_saves': self._pending_saves,
            'cache_valid': self._cache_valid,
            'content_hash': self._content_hash,
            'operation_metrics': self._operation_metrics.copy(),
            'yjs_available': HAS_PYCRDT and self.yjs_doc is not None,
            'file_path': self.file_path
        }
    
    def add_update_callback(self, callback: Callable):
        """Add a callback for document updates."""
        self._update_callbacks.append(callback)
    
    def remove_update_callback(self, callback: Callable):
        """Remove an update callback."""
        try:
            self._update_callbacks.remove(callback)
        except ValueError:
            pass
    
    def add_state_callback(self, callback: Callable):
        """Add a callback for state changes."""
        self._state_callbacks.append(callback)
    
    def remove_state_callback(self, callback: Callable):
        """Remove a state callback."""
        try:
            self._state_callbacks.remove(callback)
        except ValueError:
            pass
    
    def _trigger_update_callbacks(self, update_type: str, event):
        """Trigger all update callbacks."""
        for callback in self._update_callbacks:
            try:
                callback(self.document_id, update_type, event)
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "update_callback",
                    "document_id": self.document_id,
                    "update_type": update_type
                })
    
    def _trigger_state_callbacks(self, new_state: DocumentState):
        """Trigger all state change callbacks."""
        for callback in self._state_callbacks:
            try:
                callback(self.document_id, self._state, new_state)
            except Exception as e:
                self.logger.log_error(e, {
                    "context": "state_callback",
                    "document_id": self.document_id,
                    "new_state": new_state.value
                })
    
    async def close(self):
        """Close the provider and clean up resources."""
        try:
            self._state = DocumentState.CLOSED
            
            # Cancel background tasks
            if self._save_task and not self._save_task.done():
                self._save_task.cancel()
            if self._snapshot_task and not self._snapshot_task.done():
                self._snapshot_task.cancel()
            
            # Save any pending changes
            if self._change_count > 0 and self.yjs_doc:
                await self.save_notebook()
            
            # Release all locks
            if self.lock_manager:
                await self.lock_manager.force_release_all_locks()
                await self.lock_manager.disconnect()
            
            # Clear connected users
            self._connected_users.clear()
            self._active_sessions.clear()
            
            # Clear callbacks
            self._update_callbacks.clear()
            self._state_callbacks.clear()
            self._error_callbacks.clear()
            
            self.logger.logger.info(
                f"Closed Yjs provider for document {self.document_id}",
                extra={
                    "document_id": self.document_id,
                    "final_version": self._version,
                    "operation_metrics": self._operation_metrics
                }
            )
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "provider_close",
                "document_id": self.document_id
            })
    
    async def __aenter__(self):
        """Async context manager entry."""
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()


# Factory functions and utilities

def create_yjs_provider(document_id: str, file_path: Optional[str] = None,
                       config: Optional[CollaborationConfig] = None) -> YjsNotebookProvider:
    """
    Create a new Yjs notebook provider.
    
    Args:
        document_id: Unique document identifier
        file_path: Optional path to notebook file
        config: Optional collaboration configuration
    
    Returns:
        Configured YjsNotebookProvider instance
    """
    return YjsNotebookProvider(document_id, file_path, config)


async def merge_notebook_updates(base_notebook: Dict[str, Any],
                                updates: List[bytes]) -> Dict[str, Any]:
    """
    Merge multiple Yjs updates into a base notebook.
    
    Args:
        base_notebook: Base notebook content
        updates: List of binary Yjs updates
    
    Returns:
        Merged notebook content
    """
    if not HAS_PYCRDT or not updates:
        return base_notebook
    
    try:
        # Create provider and load base content
        provider = YjsNotebookProvider("temp_merge")
        await provider.load_notebook(base_notebook)
        
        # Apply all updates
        for update in updates:
            await provider.apply_update(update, origin="merge")
        
        # Get merged content
        merged_content = await provider.get_notebook_content()
        await provider.close()
        
        return merged_content
        
    except Exception as e:
        raise CollaborationError(f"Failed to merge notebook updates: {e}")


def validate_yjs_environment() -> Dict[str, Any]:
    """
    Validate the Yjs environment and return status information.
    
    Returns:
        Dictionary containing environment validation results
    """
    status = {
        'pycrdt_available': HAS_PYCRDT,
        'version': getattr(pycrdt, '__version__', 'unknown') if HAS_PYCRDT else None,
        'can_create_documents': False,
        'can_apply_updates': False,
        'error': None
    }
    
    if HAS_PYCRDT:
        try:
            # Test basic Yjs operations
            test_doc = YDoc()
            test_array = test_doc.get("test", type=YArray)
            test_array.append(["test"])
            
            state_vector = test_doc.get_state_vector()
            update = test_doc.get_update()
            
            status['can_create_documents'] = True
            status['can_apply_updates'] = len(update) > 0
            
        except Exception as e:
            status['error'] = str(e)
    
    return status