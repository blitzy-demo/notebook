"""
Server-side collaboration infrastructure for Jupyter Notebook real-time collaborative editing.

This package provides the core server-side components for enabling real-time collaborative
editing capabilities in Jupyter Notebook v7. The implementation uses Yjs CRDT framework
for conflict-free synchronization, integrates with JupyterHub for authentication, and 
provides cell-level locking, presence awareness, and permission management.

The package exposes the essential collaboration services required for multi-user notebook
editing while providing graceful degradation when collaboration dependencies are unavailable.

Key Components:
- YjsWebSocketHandler: WebSocket handler for real-time document synchronization
- YjsNotebookProvider: Server-side CRDT document provider and persistence
- PermissionManager: Role-based access control and authentication integration
- LockManager: Distributed cell-level locking for conflict prevention

Integration Features:
- Seamless integration with existing Jupyter Server architecture
- Automatic service registration for Jupyter Server extension discovery
- Graceful fallback mechanisms when collaboration dependencies are missing
- Comprehensive monitoring and error handling
"""

import warnings
from typing import Any, Dict, List, Optional, Set, Callable, Union

# Version information
__version__ = "1.0.0"
__author__ = "Jupyter Collaboration Team"

# Dependency availability flags
HAS_COLLABORATION_DEPS = True
MISSING_DEPS = []

# Core collaboration dependencies check
try:
    import pycrdt
    HAS_PYCRDT = True
except ImportError:
    HAS_PYCRDT = False
    HAS_COLLABORATION_DEPS = False
    MISSING_DEPS.append("pycrdt")

try:
    import tornado
    HAS_TORNADO = True
except ImportError:
    HAS_TORNADO = False
    HAS_COLLABORATION_DEPS = False
    MISSING_DEPS.append("tornado")

try:
    from jupyter_server.base.handlers import JupyterHandler
    HAS_JUPYTER_SERVER = True
except ImportError:
    HAS_JUPYTER_SERVER = False
    HAS_COLLABORATION_DEPS = False
    MISSING_DEPS.append("jupyter_server")

# Import core collaboration classes with graceful degradation
if HAS_COLLABORATION_DEPS:
    try:
        # WebSocket handler and routing
        from .handlers import (
            YjsWebSocketHandler,
            CollaborationSessionManager,
            MessageType,
            WebSocketMessage,
            create_collaboration_handlers,
            initialize_collaboration_handlers,
            shutdown_collaboration_handlers,
            get_active_sessions_stats,
            get_collaboration_health
        )
        
        # Document provider and CRDT management
        from .provider import (
            YjsNotebookProvider,
            DocumentState,
            DocumentSnapshot,
            UpdateInfo,
            create_yjs_provider,
            merge_notebook_updates,
            validate_yjs_environment
        )
        
        # Permission management and authentication
        from .permissions import (
            PermissionManager,
            UserRole,
            CollaborativeOperation,
            PermissionLevel,
            PermissionConfig,
            PermissionCache,
            PermissionRule,
            PermissionRuleEngine,
            JupyterHubTokenValidator,
            get_permission_manager,
            validate_token_and_permissions,
            create_permission_middleware
        )
        
        # Lock management and conflict prevention
        from .locks import (
            LockManager,
            LockInfo,
            LockType,
            LockState,
            LockPriority,
            LockRequest,
            create_lock_manager,
            acquire_cell_lock,
            release_cell_lock,
            is_lock_compatible
        )
        
        # Utility classes and functions
        from .utils import (
            CollaborationConfig,
            CollaborationLogger,
            CollaborationMetrics,
            CollaborationError,
            CollaborationConnectionError,
            CollaborationPermissionError,
            CollaborationSerializationError,
            GracefulDegradationManager,
            get_collaboration_config,
            get_collaboration_logger,
            get_collaboration_metrics,
            get_degradation_manager
        )
        
        COLLABORATION_AVAILABLE = True
        
    except ImportError as e:
        # Partial import failure - some dependencies missing
        COLLABORATION_AVAILABLE = False
        HAS_COLLABORATION_DEPS = False
        MISSING_DEPS.append(f"collaboration_module: {str(e)}")
        
        # Create stub classes for missing components
        class _CollaborationStub:
            """Stub class for missing collaboration components."""
            def __init__(self, *args, **kwargs):
                raise RuntimeError(
                    f"Collaboration features not available. Missing dependencies: {', '.join(MISSING_DEPS)}"
                )
        
        # Assign stubs to expected names
        YjsWebSocketHandler = _CollaborationStub
        YjsNotebookProvider = _CollaborationStub
        PermissionManager = _CollaborationStub
        LockManager = _CollaborationStub

else:
    # No collaboration dependencies available
    COLLABORATION_AVAILABLE = False
    
    # Issue warning about missing dependencies
    warnings.warn(
        f"Jupyter Notebook collaboration features are disabled. "
        f"Missing required dependencies: {', '.join(MISSING_DEPS)}. "
        f"Install with: pip install pycrdt tornado jupyter_server",
        RuntimeWarning,
        stacklevel=2
    )
    
    # Create stub classes for all collaboration components
    class _CollaborationStub:
        """Stub class for missing collaboration components."""
        def __init__(self, *args, **kwargs):
            raise RuntimeError(
                f"Collaboration features not available. Missing dependencies: {', '.join(MISSING_DEPS)}"
            )
    
    # Core collaboration classes
    YjsWebSocketHandler = _CollaborationStub
    YjsNotebookProvider = _CollaborationStub
    PermissionManager = _CollaborationStub
    LockManager = _CollaborationStub
    
    # Handler and service functions
    def create_collaboration_handlers():
        """Stub for collaboration handlers when dependencies are missing."""
        return []
    
    def initialize_collaboration_handlers():
        """Stub for handler initialization when dependencies are missing."""
        warnings.warn("Collaboration handlers not available - missing dependencies", RuntimeWarning)
        return False
    
    def shutdown_collaboration_handlers():
        """Stub for handler shutdown when dependencies are missing."""
        pass
    
    def get_active_sessions_stats():
        """Stub for session stats when dependencies are missing."""
        return {"error": "Collaboration not available", "active_sessions": 0}
    
    def get_collaboration_health():
        """Stub for health check when dependencies are missing."""
        return {
            "status": "disabled",
            "collaboration_available": False,
            "missing_dependencies": MISSING_DEPS,
            "pycrdt_available": HAS_PYCRDT,
            "tornado_available": HAS_TORNADO,
            "jupyter_server_available": HAS_JUPYTER_SERVER
        }
    
    # Provider functions
    def create_yjs_provider(*args, **kwargs):
        """Stub for Yjs provider creation when dependencies are missing."""
        raise RuntimeError(f"Yjs provider not available. Missing dependencies: {', '.join(MISSING_DEPS)}")
    
    def validate_yjs_environment():
        """Stub for Yjs environment validation when dependencies are missing."""
        return {
            "pycrdt_available": HAS_PYCRDT,
            "can_create_documents": False,
            "can_apply_updates": False,
            "error": f"Missing dependencies: {', '.join(MISSING_DEPS)}"
        }
    
    # Permission functions
    def get_permission_manager(*args, **kwargs):
        """Stub for permission manager when dependencies are missing."""
        raise RuntimeError(f"Permission manager not available. Missing dependencies: {', '.join(MISSING_DEPS)}")
    
    def validate_token_and_permissions(*args, **kwargs):
        """Stub for token validation when dependencies are missing."""
        return False, None
    
    # Lock functions
    def create_lock_manager(*args, **kwargs):
        """Stub for lock manager creation when dependencies are missing."""
        raise RuntimeError(f"Lock manager not available. Missing dependencies: {', '.join(MISSING_DEPS)}")


# Service registration functions for Jupyter Server extension discovery
def _jupyter_server_extension_points():
    """
    Define extension points for Jupyter Server integration.
    
    Returns:
        List of extension point configurations
    """
    if not COLLABORATION_AVAILABLE:
        return []
    
    return [
        {
            "module": "notebook.collab",
            "app": {
                "name": "notebook_collaboration",
                "description": "Real-time collaborative editing for Jupyter Notebook",
                "load": "_load_jupyter_server_extension",
                "unload": "_unload_jupyter_server_extension"
            }
        }
    ]


def _load_jupyter_server_extension(server_app):
    """
    Load the collaboration extension into Jupyter Server.
    
    Args:
        server_app: The Jupyter Server application instance
    """
    if not COLLABORATION_AVAILABLE:
        server_app.log.warning(
            "Collaboration extension not loaded - missing dependencies: %s",
            ", ".join(MISSING_DEPS)
        )
        return
    
    try:
        # Initialize collaboration infrastructure
        server_app.log.info("Loading Jupyter Notebook collaboration extension...")
        
        # Add collaboration WebSocket handlers
        collaboration_handlers = create_collaboration_handlers()
        server_app.web_app.add_handlers(".*$", collaboration_handlers)
        
        # Initialize session management
        import asyncio
        asyncio.create_task(initialize_collaboration_handlers())
        
        # Register cleanup on server shutdown
        def cleanup_collaboration():
            import asyncio
            asyncio.create_task(shutdown_collaboration_handlers())
        
        server_app.add_shutdown_task(cleanup_collaboration)
        
        server_app.log.info("Jupyter Notebook collaboration extension loaded successfully")
        
    except Exception as e:
        server_app.log.error(
            "Failed to load collaboration extension: %s", str(e)
        )
        raise


def _unload_jupyter_server_extension(server_app):
    """
    Unload the collaboration extension from Jupyter Server.
    
    Args:
        server_app: The Jupyter Server application instance
    """
    if COLLABORATION_AVAILABLE:
        try:
            server_app.log.info("Unloading Jupyter Notebook collaboration extension...")
            
            # Shutdown collaboration infrastructure
            import asyncio
            asyncio.create_task(shutdown_collaboration_handlers())
            
            server_app.log.info("Jupyter Notebook collaboration extension unloaded successfully")
            
        except Exception as e:
            server_app.log.error(
                "Error during collaboration extension unload: %s", str(e)
            )


# Service discovery and health check functions
def is_collaboration_available() -> bool:
    """
    Check if collaboration features are available.
    
    Returns:
        True if all collaboration dependencies are available, False otherwise
    """
    return COLLABORATION_AVAILABLE


def get_missing_dependencies() -> List[str]:
    """
    Get list of missing collaboration dependencies.
    
    Returns:
        List of missing dependency names
    """
    return MISSING_DEPS.copy()


def get_collaboration_status() -> Dict[str, Any]:
    """
    Get comprehensive collaboration system status.
    
    Returns:
        Dictionary containing collaboration system status information
    """
    status = {
        "collaboration_available": COLLABORATION_AVAILABLE,
        "version": __version__,
        "dependencies": {
            "pycrdt_available": HAS_PYCRDT,
            "tornado_available": HAS_TORNADO,
            "jupyter_server_available": HAS_JUPYTER_SERVER
        },
        "missing_dependencies": MISSING_DEPS,
        "services": {
            "websocket_handler": COLLABORATION_AVAILABLE,
            "document_provider": COLLABORATION_AVAILABLE,
            "permission_manager": COLLABORATION_AVAILABLE,
            "lock_manager": COLLABORATION_AVAILABLE
        }
    }
    
    if COLLABORATION_AVAILABLE:
        try:
            # Add runtime health information
            health_info = get_collaboration_health()
            status.update({"health": health_info})
            
            # Add session statistics if available
            session_stats = get_active_sessions_stats()
            status.update({"session_stats": session_stats})
            
        except Exception as e:
            status["health_check_error"] = str(e)
    
    return status


def create_collaboration_service(document_id: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Create a complete collaboration service stack for a document.
    
    Args:
        document_id: Unique identifier for the collaborative document
        config: Optional collaboration configuration
    
    Returns:
        Dictionary containing all collaboration service instances
    
    Raises:
        RuntimeError: If collaboration features are not available
    """
    if not COLLABORATION_AVAILABLE:
        raise RuntimeError(
            f"Cannot create collaboration service - missing dependencies: {', '.join(MISSING_DEPS)}"
        )
    
    try:
        # Create collaboration configuration
        collab_config = get_collaboration_config()
        if config:
            # Apply custom configuration overrides
            for key, value in config.items():
                if hasattr(collab_config, key):
                    setattr(collab_config, key, value)
        
        # Create core service components
        services = {
            "document_id": document_id,
            "config": collab_config,
            "provider": create_yjs_provider(document_id, config=collab_config),
            "permission_manager": None,  # Will be set async
            "lock_manager": create_lock_manager(document_id, config=collab_config),
            "logger": get_collaboration_logger(),
            "metrics": get_collaboration_metrics()
        }
        
        return services
        
    except Exception as e:
        raise RuntimeError(f"Failed to create collaboration service: {e}")


# Export public API
__all__ = [
    # Version and status
    "__version__",
    "is_collaboration_available",
    "get_missing_dependencies", 
    "get_collaboration_status",
    
    # Core collaboration classes
    "YjsWebSocketHandler",
    "YjsNotebookProvider", 
    "PermissionManager",
    "LockManager",
    
    # Service creation and management
    "create_collaboration_service",
    "create_collaboration_handlers",
    "initialize_collaboration_handlers",
    "shutdown_collaboration_handlers",
    
    # Provider functions
    "create_yjs_provider",
    "validate_yjs_environment",
    
    # Permission functions
    "get_permission_manager",
    "validate_token_and_permissions",
    
    # Lock functions
    "create_lock_manager",
    "acquire_cell_lock",
    "release_cell_lock",
    
    # Health and monitoring
    "get_collaboration_health",
    "get_active_sessions_stats",
    
    # Extension points
    "_jupyter_server_extension_points",
    "_load_jupyter_server_extension",
    "_unload_jupyter_server_extension"
]

# Conditional exports based on availability
if COLLABORATION_AVAILABLE:
    # Add additional exports when collaboration is fully available
    __all__.extend([
        "CollaborationSessionManager",
        "MessageType",
        "WebSocketMessage",
        "DocumentState",
        "DocumentSnapshot", 
        "UpdateInfo",
        "UserRole",
        "CollaborativeOperation",
        "PermissionLevel",
        "LockInfo",
        "LockType",
        "LockState",
        "LockPriority",
        "CollaborationConfig",
        "CollaborationError"
    ])

# Module-level initialization
if COLLABORATION_AVAILABLE:
    # Perform any initialization required when collaboration is available
    try:
        # Validate the Yjs environment on import
        yjs_status = validate_yjs_environment()
        if not yjs_status.get("pycrdt_available", False):
            warnings.warn(
                "pycrdt validation failed - collaboration features may not work correctly",
                RuntimeWarning
            )
    except Exception as e:
        warnings.warn(
            f"Failed to validate collaboration environment: {e}",
            RuntimeWarning
        )