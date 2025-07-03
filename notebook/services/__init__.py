"""
Notebook Services Package

This package provides backend services for Jupyter Notebook v7 collaborative editing
capabilities. It includes services for real-time collaboration, content coordination,
session management, permissions, and other collaborative features.

The services module enables modular import of collaborative backend components
while maintaining backward compatibility with single-user workflows.

Core Services:
- Contents coordination for file operations and collaborative state management
- Session management for real-time collaboration
- Permissions and access control for collaborative features
- Comment and review system backend services
- File locking and conflict resolution services
- WebSocket protocol handlers for Yjs CRDT synchronization

Architecture:
The services are designed to work with Jupyter Server's extension system and
integrate seamlessly with JupyterHub for multi-user authentication and authorization.
All collaborative features gracefully degrade when collaboration is unavailable.

Usage:
    from notebook.services import contents, sessions, permissions, comments
    
    # Or import specific service components
    from notebook.services.contents import CollaborativeContentsManager
    from notebook.services.sessions import CollaborationSessionManager
"""

# Package metadata
__version__ = "7.0.0"
__author__ = "Jupyter Development Team"
__email__ = "jupyter@googlegroups.com"

# Import statements to expose key service interfaces
# These imports enable the services to be accessed through the package namespace

try:
    # Core collaborative services - imported conditionally to support graceful degradation
    from . import contents
    from . import sessions
    from . import permissions
    from . import comments
    from . import locks
    from . import awareness
    
    # Service registry for dependency injection and service discovery
    _SERVICE_REGISTRY = {
        'contents': contents,
        'sessions': sessions,
        'permissions': permissions,
        'comments': comments,
        'locks': locks,
        'awareness': awareness,
    }
    
except ImportError as e:
    # Graceful fallback when collaborative services are not available
    # This maintains backward compatibility with single-user deployments
    import warnings
    warnings.warn(
        f"Some collaborative services could not be imported: {e}. "
        "Notebook will fall back to single-user mode.",
        UserWarning
    )
    _SERVICE_REGISTRY = {}


def get_service(service_name: str):
    """
    Retrieve a service by name from the service registry.
    
    Args:
        service_name (str): Name of the service to retrieve
        
    Returns:
        Service module or None if service is not available
        
    Example:
        contents_service = get_service('contents')
        if contents_service:
            manager = contents_service.CollaborativeContentsManager()
    """
    return _SERVICE_REGISTRY.get(service_name)


def list_available_services():
    """
    List all available collaborative services.
    
    Returns:
        list: Names of available services
    """
    return list(_SERVICE_REGISTRY.keys())


def is_collaborative_mode_available():
    """
    Check if collaborative services are available.
    
    Returns:
        bool: True if collaborative features are available, False otherwise
    """
    required_services = {'contents', 'sessions', 'permissions'}
    available_services = set(_SERVICE_REGISTRY.keys())
    return required_services.issubset(available_services)


# Configuration constants for collaborative features
COLLABORATION_CONFIG = {
    'websocket_max_message_size': 1024 * 1024,  # 1MB max message size
    'session_timeout': 30 * 60,  # 30 minutes session timeout
    'lock_timeout': 5 * 60,      # 5 minutes lock timeout
    'snapshot_interval': 10 * 60,  # 10 minutes snapshot interval
    'max_history_entries': 100,  # Maximum number of history entries to keep
    'awareness_update_interval': 1000,  # Awareness update interval in ms
}


# Export the public API
__all__ = [
    # Core services (when available)
    'contents',
    'sessions', 
    'permissions',
    'comments',
    'locks',
    'awareness',
    
    # Service management functions
    'get_service',
    'list_available_services',
    'is_collaborative_mode_available',
    
    # Configuration
    'COLLABORATION_CONFIG',
    
    # Metadata
    '__version__',
    '__author__',
    '__email__',
]


# Initialize logging for the services package
import logging

# Create a logger for the services package
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Add a null handler to prevent "No handler found" warnings when logging is not configured
if not logger.handlers:
    logger.addHandler(logging.NullHandler())

# Log initialization status
if is_collaborative_mode_available():
    logger.info("Notebook collaborative services initialized successfully")
    logger.debug(f"Available services: {list_available_services()}")
else:
    logger.warning(
        "Collaborative services not fully available. "
        "Notebook will operate in single-user mode."
    )


# Service initialization hooks for extensions
_INITIALIZATION_HOOKS = []


def register_initialization_hook(hook_func):
    """
    Register a function to be called when services are initialized.
    
    This allows extensions to register additional setup logic for collaborative features.
    
    Args:
        hook_func (callable): Function to call during initialization
    """
    _INITIALIZATION_HOOKS.append(hook_func)


def _run_initialization_hooks():
    """Execute all registered initialization hooks."""
    for hook in _INITIALIZATION_HOOKS:
        try:
            hook()
        except Exception as e:
            logger.error(f"Error running initialization hook {hook}: {e}")


# Run initialization hooks if in collaborative mode
if is_collaborative_mode_available():
    _run_initialization_hooks()


# Backward compatibility aliases for legacy imports
# These maintain compatibility with any existing code that might import services directly
try:
    # Provide backward-compatible access to common service patterns
    from .contents import ContentsManager as BaseContentsManager
    from .sessions import SessionManager as BaseSessionManager
except ImportError:
    # Define minimal compatibility stubs if services are not available
    class BaseContentsManager:
        """Compatibility stub for ContentsManager when collaborative services unavailable."""
        pass
    
    class BaseSessionManager:
        """Compatibility stub for SessionManager when collaborative services unavailable."""
        pass


# Version compatibility information
SUPPORTED_JUPYTER_SERVER_VERSIONS = ">=2.4.0,<3"
SUPPORTED_PYTHON_VERSIONS = ">=3.8"
REQUIRED_DEPENDENCIES = [
    "tornado>=6.2.0",
    "traitlets>=5.0.0",
    "jupyter_server>=2.4.0,<3",
]

OPTIONAL_COLLABORATIVE_DEPENDENCIES = [
    "jupyterhub>=3.0.0",  # For multi-user authentication
    "sqlalchemy>=1.4.0",  # For comment persistence
    "redis>=4.0.0",       # For distributed session management (optional)
]


# Feature flags for progressive enhancement
FEATURE_FLAGS = {
    'collaborative_editing': is_collaborative_mode_available(),
    'real_time_presence': is_collaborative_mode_available(),
    'cell_locking': is_collaborative_mode_available(),
    'comment_system': 'comments' in _SERVICE_REGISTRY,
    'version_history': is_collaborative_mode_available(),
    'permissions_management': 'permissions' in _SERVICE_REGISTRY,
}