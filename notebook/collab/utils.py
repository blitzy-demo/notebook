"""
Common utilities and helper functions for collaboration infrastructure.

This module provides essential utilities for the Jupyter Notebook collaborative editing system,
including logging, configuration management, serialization helpers, and graceful degradation
mechanisms to support real-time multi-user collaboration.
"""

import asyncio
import json
import logging
import time
import traceback
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from enum import Enum
from functools import wraps
from typing import Any, Dict, List, Optional, Tuple, Union, Callable, AsyncGenerator
from urllib.parse import urlparse
import uuid
import weakref

try:
    import prometheus_client
    from prometheus_client import Counter, Histogram, Gauge, CollectorRegistry
    HAS_PROMETHEUS = True
except ImportError:
    HAS_PROMETHEUS = False

try:
    import pycrdt
    HAS_PYCRDT = True
except ImportError:
    HAS_PYCRDT = False

from jupyter_server.auth import User
from jupyter_server.base.handlers import JupyterHandler
from traitlets import Bool, Int, Float, Unicode, List as TraitList, Dict as TraitDict
from traitlets.config import Configurable


class CollaborationMode(Enum):
    """Collaboration mode enumeration."""
    DISABLED = "disabled"
    ENABLED = "enabled"
    FALLBACK = "fallback"  # Single-user mode with queued changes


class CollaborationStatus(Enum):
    """Collaboration connection status."""
    CONNECTED = "connected"
    CONNECTING = "connecting"
    DISCONNECTED = "disconnected"
    ERROR = "error"
    DEGRADED = "degraded"


class CollaborationError(Exception):
    """Base exception for collaboration-related errors."""
    pass


class CollaborationConnectionError(CollaborationError):
    """Raised when collaboration connection fails."""
    pass


class CollaborationPermissionError(CollaborationError):
    """Raised when collaboration permission is denied."""
    pass


class CollaborationSerializationError(CollaborationError):
    """Raised when Yjs document serialization fails."""
    pass


class CollaborationConfig(Configurable):
    """Configuration for collaboration features."""
    
    enabled = Bool(
        default_value=True,
        help="Enable collaborative editing features"
    ).tag(config=True)
    
    max_concurrent_users = Int(
        default_value=50,
        help="Maximum number of concurrent users per notebook"
    ).tag(config=True)
    
    connection_timeout = Float(
        default_value=30.0,
        help="WebSocket connection timeout in seconds"
    ).tag(config=True)
    
    retry_attempts = Int(
        default_value=3,
        help="Number of retry attempts for failed operations"
    ).tag(config=True)
    
    retry_delay = Float(
        default_value=1.0,
        help="Delay between retry attempts in seconds"
    ).tag(config=True)
    
    lock_timeout = Float(
        default_value=300.0,
        help="Cell lock timeout in seconds"
    ).tag(config=True)
    
    presence_timeout = Float(
        default_value=60.0,
        help="User presence timeout in seconds"
    ).tag(config=True)
    
    history_retention_days = Int(
        default_value=30,
        help="Number of days to retain collaboration history"
    ).tag(config=True)
    
    metrics_enabled = Bool(
        default_value=True,
        help="Enable Prometheus metrics collection"
    ).tag(config=True)
    
    graceful_degradation = Bool(
        default_value=True,
        help="Enable graceful degradation to single-user mode"
    ).tag(config=True)
    
    allowed_origins = TraitList(
        trait=Unicode(),
        default_value=["*"],
        help="Allowed origins for WebSocket connections"
    ).tag(config=True)
    
    compression_enabled = Bool(
        default_value=True,
        help="Enable WebSocket message compression"
    ).tag(config=True)
    
    batch_size = Int(
        default_value=50,
        help="Maximum number of operations to batch together"
    ).tag(config=True)
    
    batch_timeout = Float(
        default_value=0.1,
        help="Maximum time to wait for batching operations in seconds"
    ).tag(config=True)


class CollaborationLogger:
    """Centralized logging for collaboration operations."""
    
    def __init__(self, name: str = "jupyter_collaboration"):
        self.logger = logging.getLogger(name)
        self._setup_logging()
        
    def _setup_logging(self):
        """Set up logging configuration."""
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s - '
                '[%(filename)s:%(lineno)d]'
            )
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
            self.logger.setLevel(logging.INFO)
    
    def log_operation(self, operation: str, document_id: str, user_id: str, 
                     success: bool, duration: float, details: Optional[Dict] = None):
        """Log a collaboration operation."""
        context = {
            "operation": operation,
            "document_id": document_id,
            "user_id": user_id,
            "success": success,
            "duration": duration,
            "details": details or {}
        }
        
        level = logging.INFO if success else logging.WARNING
        message = f"Collaboration {operation}: {'SUCCESS' if success else 'FAILED'}"
        self.logger.log(level, message, extra=context)
    
    def log_connection(self, event: str, user_id: str, document_id: str, 
                      details: Optional[Dict] = None):
        """Log connection events."""
        context = {
            "event": event,
            "user_id": user_id,
            "document_id": document_id,
            "details": details or {}
        }
        self.logger.info(f"Connection {event}", extra=context)
    
    def log_error(self, error: Exception, context: Dict = None):
        """Log errors with full context."""
        context = context or {}
        context.update({
            "error_type": type(error).__name__,
            "error_message": str(error),
            "traceback": traceback.format_exc()
        })
        self.logger.error(f"Collaboration error: {error}", extra=context)


class CollaborationMetrics:
    """Prometheus metrics for collaboration monitoring."""
    
    def __init__(self, registry: Optional[CollectorRegistry] = None):
        self.registry = registry or prometheus_client.REGISTRY
        self.enabled = HAS_PROMETHEUS
        
        if self.enabled:
            self._setup_metrics()
    
    def _setup_metrics(self):
        """Initialize Prometheus metrics."""
        # Active collaborators gauge
        self.active_collaborators = Gauge(
            'jupyter_collaboration_active_users',
            'Number of active collaborative users',
            ['document_id'],
            registry=self.registry
        )
        
        # Operation counters
        self.operations_total = Counter(
            'jupyter_collaboration_operations_total',
            'Total collaboration operations',
            ['operation', 'status', 'document_id'],
            registry=self.registry
        )
        
        # Latency histogram
        self.operation_latency = Histogram(
            'jupyter_collaboration_operation_duration_seconds',
            'Duration of collaboration operations',
            ['operation'],
            registry=self.registry
        )
        
        # Yjs update rate
        self.yjs_updates_per_second = Gauge(
            'jupyter_collaboration_yjs_updates_per_second',
            'Rate of Yjs updates per second',
            ['document_id'],
            registry=self.registry
        )
        
        # Lock contention
        self.lock_contention = Counter(
            'jupyter_collaboration_lock_contention_total',
            'Lock contention events',
            ['document_id', 'cell_id', 'event_type'],
            registry=self.registry
        )
        
        # Connection health
        self.connection_events = Counter(
            'jupyter_collaboration_connection_events_total',
            'WebSocket connection events',
            ['event_type', 'user_id'],
            registry=self.registry
        )
        
        # Permission events
        self.permission_events = Counter(
            'jupyter_collaboration_permission_events_total',
            'Permission-related events',
            ['event_type', 'role', 'result'],
            registry=self.registry
        )
    
    def record_active_users(self, document_id: str, count: int):
        """Record active user count for a document."""
        if self.enabled:
            self.active_collaborators.labels(document_id=document_id).set(count)
    
    def record_operation(self, operation: str, document_id: str, 
                        success: bool, duration: float):
        """Record a collaboration operation."""
        if self.enabled:
            status = "success" if success else "failure"
            self.operations_total.labels(
                operation=operation, 
                status=status, 
                document_id=document_id
            ).inc()
            self.operation_latency.labels(operation=operation).observe(duration)
    
    def record_yjs_update_rate(self, document_id: str, rate: float):
        """Record Yjs update rate."""
        if self.enabled:
            self.yjs_updates_per_second.labels(document_id=document_id).set(rate)
    
    def record_lock_event(self, document_id: str, cell_id: str, event_type: str):
        """Record lock contention event."""
        if self.enabled:
            self.lock_contention.labels(
                document_id=document_id,
                cell_id=cell_id,
                event_type=event_type
            ).inc()
    
    def record_connection_event(self, event_type: str, user_id: str):
        """Record connection event."""
        if self.enabled:
            self.connection_events.labels(
                event_type=event_type,
                user_id=user_id
            ).inc()
    
    def record_permission_event(self, event_type: str, role: str, result: str):
        """Record permission event."""
        if self.enabled:
            self.permission_events.labels(
                event_type=event_type,
                role=role,
                result=result
            ).inc()


class RetryConfig:
    """Configuration for retry behavior."""
    
    def __init__(self, max_attempts: int = 3, delay: float = 1.0, 
                 backoff_multiplier: float = 2.0, max_delay: float = 60.0):
        self.max_attempts = max_attempts
        self.delay = delay
        self.backoff_multiplier = backoff_multiplier
        self.max_delay = max_delay


def with_retry(config: Optional[RetryConfig] = None, 
               exceptions: Tuple[Exception, ...] = (Exception,)):
    """Decorator for adding retry logic to functions."""
    config = config or RetryConfig()
    
    def decorator(func):
        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            last_exception = None
            delay = config.delay
            
            for attempt in range(config.max_attempts):
                try:
                    return await func(*args, **kwargs)
                except exceptions as e:
                    last_exception = e
                    if attempt < config.max_attempts - 1:
                        await asyncio.sleep(delay)
                        delay = min(delay * config.backoff_multiplier, config.max_delay)
                    else:
                        break
            
            raise last_exception
        
        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            last_exception = None
            delay = config.delay
            
            for attempt in range(config.max_attempts):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    last_exception = e
                    if attempt < config.max_attempts - 1:
                        time.sleep(delay)
                        delay = min(delay * config.backoff_multiplier, config.max_delay)
                    else:
                        break
            
            raise last_exception
        
        return async_wrapper if asyncio.iscoroutinefunction(func) else sync_wrapper
    
    return decorator


class GracefulDegradationManager:
    """Manages graceful degradation to single-user mode."""
    
    def __init__(self, config: CollaborationConfig):
        self.config = config
        self.logger = CollaborationLogger()
        self.mode = CollaborationMode.ENABLED
        self.queued_operations = []
        self.degradation_reason = None
        self.last_connection_attempt = None
        
    def is_collaborative_mode(self) -> bool:
        """Check if currently in collaborative mode."""
        return self.mode == CollaborationMode.ENABLED
    
    def enable_degradation(self, reason: str):
        """Switch to degraded mode with reason."""
        if self.mode != CollaborationMode.FALLBACK:
            self.mode = CollaborationMode.FALLBACK
            self.degradation_reason = reason
            self.logger.logger.warning(f"Switching to degraded mode: {reason}")
    
    def disable_degradation(self):
        """Return to collaborative mode."""
        if self.mode == CollaborationMode.FALLBACK:
            self.mode = CollaborationMode.ENABLED
            self.degradation_reason = None
            self.logger.logger.info("Returning to collaborative mode")
    
    def queue_operation(self, operation: Dict):
        """Queue operation for later sync."""
        if self.mode == CollaborationMode.FALLBACK:
            operation['queued_at'] = datetime.now(timezone.utc).isoformat()
            self.queued_operations.append(operation)
    
    def get_queued_operations(self) -> List[Dict]:
        """Get and clear queued operations."""
        operations = self.queued_operations.copy()
        self.queued_operations.clear()
        return operations
    
    @asynccontextmanager
    async def connection_context(self):
        """Context manager for handling connection failures."""
        try:
            yield
        except (ConnectionError, TimeoutError, CollaborationConnectionError) as e:
            if self.config.graceful_degradation:
                self.enable_degradation(f"Connection failed: {str(e)}")
            else:
                raise


class YjsDocumentSerializer:
    """Utilities for Yjs document serialization and deserialization."""
    
    @staticmethod
    def serialize_document(doc: Any) -> bytes:
        """Serialize a Yjs document to bytes."""
        if not HAS_PYCRDT:
            raise CollaborationSerializationError("pycrdt not available")
        
        try:
            # Convert to state vector and update
            state_vector = doc.get_state_vector()
            update = doc.get_update()
            
            # Create serialization payload
            payload = {
                'state_vector': list(state_vector),
                'update': list(update),
                'timestamp': datetime.now(timezone.utc).isoformat()
            }
            
            return json.dumps(payload).encode('utf-8')
        except Exception as e:
            raise CollaborationSerializationError(f"Failed to serialize document: {e}")
    
    @staticmethod
    def deserialize_document(data: bytes) -> Dict:
        """Deserialize bytes to Yjs document data."""
        if not HAS_PYCRDT:
            raise CollaborationSerializationError("pycrdt not available")
        
        try:
            payload = json.loads(data.decode('utf-8'))
            
            return {
                'state_vector': bytes(payload['state_vector']),
                'update': bytes(payload['update']),
                'timestamp': payload.get('timestamp')
            }
        except Exception as e:
            raise CollaborationSerializationError(f"Failed to deserialize document: {e}")
    
    @staticmethod
    def merge_updates(updates: List[bytes]) -> bytes:
        """Merge multiple Yjs updates into a single update."""
        if not HAS_PYCRDT:
            raise CollaborationSerializationError("pycrdt not available")
        
        try:
            # Use pycrdt to merge updates
            merged = pycrdt.merge_updates(updates)
            return merged
        except Exception as e:
            raise CollaborationSerializationError(f"Failed to merge updates: {e}")


class WebSocketOptimizer:
    """Utilities for optimizing WebSocket communication."""
    
    def __init__(self, config: CollaborationConfig):
        self.config = config
        self.message_buffer = []
        self.last_flush = time.time()
        self._flush_task = None
    
    def should_batch_message(self, message: Dict) -> bool:
        """Determine if message should be batched."""
        # Always batch update messages
        if message.get('type') == 'update':
            return True
        
        # Batch awareness messages if there's already a buffer
        if message.get('type') == 'awareness' and self.message_buffer:
            return True
        
        return False
    
    def add_to_batch(self, message: Dict):
        """Add message to batch buffer."""
        self.message_buffer.append(message)
        
        # Schedule flush if buffer is full or timeout reached
        if (len(self.message_buffer) >= self.config.batch_size or
            time.time() - self.last_flush >= self.config.batch_timeout):
            self._schedule_flush()
    
    def _schedule_flush(self):
        """Schedule buffer flush."""
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(self._flush_buffer())
    
    async def _flush_buffer(self):
        """Flush message buffer."""
        if not self.message_buffer:
            return
        
        # Group messages by type for optimal batching
        updates = []
        awareness_updates = []
        other_messages = []
        
        for msg in self.message_buffer:
            if msg.get('type') == 'update':
                updates.append(msg)
            elif msg.get('type') == 'awareness':
                awareness_updates.append(msg)
            else:
                other_messages.append(msg)
        
        # Create batched messages
        batched_messages = []
        
        if updates:
            batched_messages.append({
                'type': 'batch_update',
                'updates': updates,
                'timestamp': time.time()
            })
        
        if awareness_updates:
            batched_messages.append({
                'type': 'batch_awareness',
                'updates': awareness_updates,
                'timestamp': time.time()
            })
        
        batched_messages.extend(other_messages)
        
        # Clear buffer and update timestamp
        self.message_buffer.clear()
        self.last_flush = time.time()
        
        return batched_messages
    
    def compress_message(self, message: str) -> bytes:
        """Compress message for transmission."""
        if not self.config.compression_enabled:
            return message.encode('utf-8')
        
        import gzip
        return gzip.compress(message.encode('utf-8'))
    
    def decompress_message(self, data: bytes) -> str:
        """Decompress received message."""
        if not self.config.compression_enabled:
            return data.decode('utf-8')
        
        import gzip
        try:
            return gzip.decompress(data).decode('utf-8')
        except gzip.BadGzipFile:
            # Fallback to uncompressed
            return data.decode('utf-8')


class PermissionValidator:
    """Utilities for validating collaboration permissions."""
    
    def __init__(self):
        self.logger = CollaborationLogger()
    
    def extract_user_from_token(self, token: str) -> Optional[User]:
        """Extract user information from authentication token."""
        try:
            # This would integrate with JupyterHub token validation
            # For now, return a basic implementation
            return User(username="user", name="User")
        except Exception as e:
            self.logger.log_error(e, {"context": "token_validation"})
            return None
    
    def validate_permission(self, user: User, operation: str, 
                          document_id: str, resource: str = None) -> bool:
        """Validate user permission for operation."""
        try:
            # Check if user has required role for operation
            user_role = getattr(user, 'role', 'view')
            
            permission_matrix = {
                'view': ['read', 'list'],
                'edit': ['read', 'list', 'write', 'execute', 'comment'],
                'admin': ['read', 'list', 'write', 'execute', 'comment', 
                         'manage_permissions', 'manage_locks']
            }
            
            allowed_operations = permission_matrix.get(user_role, ['read'])
            return operation in allowed_operations
        except Exception as e:
            self.logger.log_error(e, {
                "context": "permission_validation",
                "user": user.username,
                "operation": operation,
                "document_id": document_id
            })
            return False
    
    def check_document_access(self, user: User, document_id: str) -> bool:
        """Check if user has access to document."""
        # Implement document-level access control
        return True  # Placeholder implementation


class CollaborationHealthChecker:
    """Health checking utilities for collaboration services."""
    
    def __init__(self, config: CollaborationConfig):
        self.config = config
        self.logger = CollaborationLogger()
    
    async def check_yjs_service(self) -> bool:
        """Check if Yjs service is healthy."""
        try:
            # Implement health check for Yjs WebSocket service
            return True
        except Exception as e:
            self.logger.log_error(e, {"context": "yjs_health_check"})
            return False
    
    async def check_permission_service(self) -> bool:
        """Check if permission service is healthy."""
        try:
            # Implement health check for permission service
            return True
        except Exception as e:
            self.logger.log_error(e, {"context": "permission_health_check"})
            return False
    
    async def comprehensive_health_check(self) -> Dict[str, bool]:
        """Perform comprehensive health check."""
        checks = {
            'yjs_service': await self.check_yjs_service(),
            'permission_service': await self.check_permission_service(),
            'pycrdt_available': HAS_PYCRDT,
            'prometheus_available': HAS_PROMETHEUS
        }
        
        return checks


# Global instances for easy access
_config = None
_logger = None
_metrics = None
_degradation_manager = None


def get_collaboration_config() -> CollaborationConfig:
    """Get global collaboration configuration."""
    global _config
    if _config is None:
        _config = CollaborationConfig()
    return _config


def get_collaboration_logger() -> CollaborationLogger:
    """Get global collaboration logger."""
    global _logger
    if _logger is None:
        _logger = CollaborationLogger()
    return _logger


def get_collaboration_metrics() -> CollaborationMetrics:
    """Get global collaboration metrics."""
    global _metrics
    if _metrics is None:
        _metrics = CollaborationMetrics()
    return _metrics


def get_degradation_manager() -> GracefulDegradationManager:
    """Get global degradation manager."""
    global _degradation_manager
    if _degradation_manager is None:
        _degradation_manager = GracefulDegradationManager(get_collaboration_config())
    return _degradation_manager


# Utility functions
def generate_session_id() -> str:
    """Generate a unique session ID."""
    return str(uuid.uuid4())


def validate_document_id(document_id: str) -> bool:
    """Validate document ID format."""
    if not document_id or not isinstance(document_id, str):
        return False
    
    # Check for valid characters and length
    if len(document_id) > 255:
        return False
    
    # Allow alphanumeric, hyphens, underscores, and dots
    import re
    pattern = r'^[a-zA-Z0-9._-]+$'
    return bool(re.match(pattern, document_id))


def sanitize_user_data(data: Dict) -> Dict:
    """Sanitize user data for safe transmission."""
    # Remove sensitive fields
    safe_data = {}
    safe_fields = ['username', 'name', 'display_name', 'avatar_url', 'role']
    
    for field in safe_fields:
        if field in data:
            safe_data[field] = data[field]
    
    return safe_data


def format_collaboration_message(message_type: str, data: Dict, 
                               user_id: str = None) -> Dict:
    """Format a collaboration message for transmission."""
    message = {
        'type': message_type,
        'data': data,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'message_id': str(uuid.uuid4())
    }
    
    if user_id:
        message['user_id'] = user_id
    
    return message


@contextmanager
def error_context(operation: str, **kwargs):
    """Context manager for standardized error handling."""
    logger = get_collaboration_logger()
    start_time = time.time()
    
    try:
        yield
        duration = time.time() - start_time
        logger.log_operation(operation, kwargs.get('document_id', 'unknown'),
                           kwargs.get('user_id', 'unknown'), True, duration)
    except Exception as e:
        duration = time.time() - start_time
        logger.log_operation(operation, kwargs.get('document_id', 'unknown'),
                           kwargs.get('user_id', 'unknown'), False, duration)
        logger.log_error(e, {'operation': operation, **kwargs})
        raise


def is_websocket_available() -> bool:
    """Check if WebSocket functionality is available."""
    try:
        import tornado.websocket
        return True
    except ImportError:
        return False


def get_client_info(handler: JupyterHandler) -> Dict:
    """Extract client information from request handler."""
    request = handler.request
    
    return {
        'user_agent': request.headers.get('User-Agent', ''),
        'remote_ip': request.headers.get('X-Real-IP') or 
                    request.headers.get('X-Forwarded-For') or 
                    request.remote_ip,
        'origin': request.headers.get('Origin', ''),
        'referer': request.headers.get('Referer', ''),
        'accept_language': request.headers.get('Accept-Language', ''),
        'connection_id': str(uuid.uuid4())
    }


# Performance monitoring decorators
def monitor_performance(operation_name: str):
    """Decorator to monitor operation performance."""
    def decorator(func):
        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            metrics = get_collaboration_metrics()
            start_time = time.time()
            success = False
            
            try:
                result = await func(*args, **kwargs)
                success = True
                return result
            finally:
                duration = time.time() - start_time
                document_id = kwargs.get('document_id', 'unknown')
                metrics.record_operation(operation_name, document_id, success, duration)
        
        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            metrics = get_collaboration_metrics()
            start_time = time.time()
            success = False
            
            try:
                result = func(*args, **kwargs)
                success = True
                return result
            finally:
                duration = time.time() - start_time
                document_id = kwargs.get('document_id', 'unknown')
                metrics.record_operation(operation_name, document_id, success, duration)
        
        return async_wrapper if asyncio.iscoroutinefunction(func) else sync_wrapper
    
    return decorator


# Connection utilities
async def wait_for_connection(check_func: Callable, timeout: float = 30.0,
                            interval: float = 1.0) -> bool:
    """Wait for a connection to be established."""
    end_time = time.time() + timeout
    
    while time.time() < end_time:
        if await check_func():
            return True
        await asyncio.sleep(interval)
    
    return False


def parse_collaboration_url(url: str) -> Dict[str, str]:
    """Parse collaboration WebSocket URL."""
    parsed = urlparse(url)
    
    return {
        'scheme': parsed.scheme,
        'host': parsed.hostname or 'localhost',
        'port': str(parsed.port or (443 if parsed.scheme == 'wss' else 80)),
        'path': parsed.path or '/collab',
        'query': parsed.query
    }