"""
Collaborative Editing Infrastructure for Jupyter Notebook v7

This module provides the core collaborative editing infrastructure enabling real-time
multi-user editing capabilities in Jupyter Notebook v7. It serves as the centralized
entry point for importing and initializing collaborative backend services including
session management, document synchronization, and persistence coordination.

The collaborative infrastructure integrates:
- YjsNotebookProvider for CRDT-based document synchronization
- CollaborationManager for comprehensive session lifecycle management  
- PersistenceLayer for multi-tier storage coordination (Redis/MongoDB/PostgreSQL/S3)
- WebSocket-based real-time communication infrastructure
- User presence awareness and cell-level locking mechanisms
- Version history tracking and conflict resolution protocols

Architecture Overview:
- Real-time synchronization via Yjs CRDT operations
- Multi-tier persistence with hot/warm/cold/archive storage tiers
- Redis-based session coordination and lock management
- WebSocket connection pooling and health monitoring
- JupyterHub authentication integration
- Prometheus metrics collection and observability

This module is imported by notebook/handlers.py and notebook/app.py to integrate
collaborative capabilities into the Jupyter Notebook server infrastructure.

Example Usage:
    from notebook.collab import CollaborationManager, PersistenceLayer
    
    # Initialize collaboration infrastructure
    persistence = PersistenceLayer()
    await persistence.initialize()
    
    manager = CollaborationManager(persistence_layer=persistence)
    await manager.initialize()
    
    # Manager now ready for WebSocket handler integration
"""

import asyncio
import logging
import os
import sys
from typing import Dict, Any, Optional

# Import core collaboration classes
from .manager import (
    CollaborationManager,
    CollaborationConfig,
    CollaborationSession,
    WebSocketConnection,
    CollaborationMessage,
    SessionStatus,
    UserRole,
    MessageType,
    CollaborationMetrics,
    JupyterHubAuthenticator,
    LockManager,
    PresenceManager
)

from .persistence import (
    PersistenceLayer,
    PersistenceConfig,
    CRDTOperation,
    SessionMetadata,
    UserPermission,
    OperationType,
    StorageTier,
    PersistenceMetrics,
    EncryptionManager,
    RedisManager,
    MongoDBManager,
    PostgreSQLManager,
    S3Manager
)

# Version information for collaboration subsystem
__version__ = "7.0.0"
__author__ = "Jupyter Development Team"
__email__ = "jupyter@googlegroups.com"
__description__ = "Real-time collaborative editing infrastructure for Jupyter Notebook v7"

# Collaboration infrastructure metadata
__collaboration_info__ = {
    "version": __version__,
    "features": [
        "real-time-document-synchronization",
        "multi-user-awareness",
        "cell-level-locking",
        "version-history-tracking",
        "conflict-resolution",
        "presence-awareness",
        "permission-management",
        "session-coordination",
        "multi-tier-persistence"
    ],
    "dependencies": {
        "yjs": "^13.5.40",
        "y-websocket": "^1.5.0", 
        "y-protocols": "^1.0.5",
        "aioredis": "^2.0.0",
        "motor": "^3.3.0",
        "asyncpg": "^0.29.0",
        "sqlalchemy": "^1.4.0",
        "prometheus-client": "^0.19.0"
    },
    "storage_tiers": ["redis", "mongodb", "postgresql", "s3"],
    "protocols": ["websocket", "http", "crdt"],
    "authentication": ["jupyterhub", "oauth", "token-based"]
}

# Global collaboration manager instance for shared access
_collaboration_manager: Optional[CollaborationManager] = None
_persistence_layer: Optional[PersistenceLayer] = None

# Logging configuration for collaboration subsystem
def configure_collaboration_logging():
    """
    Configure specialized logging for collaborative editing operations.
    
    Sets up structured logging with collaboration-specific formatters,
    handlers, and log levels optimized for real-time operations debugging
    and performance monitoring.
    """
    # Create collaboration-specific logger
    collab_logger = logging.getLogger('jupyter.collaboration')
    
    # Prevent duplicate handlers if already configured
    if collab_logger.handlers:
        return
    
    # Configure log level from environment
    log_level = os.getenv('JUPYTER_COLLAB_LOG_LEVEL', 'INFO').upper()
    collab_logger.setLevel(getattr(logging, log_level, logging.INFO))
    
    # Create formatter for structured logging
    formatter = logging.Formatter(
        fmt='%(asctime)s - %(name)s - %(levelname)s - %(funcName)s:%(lineno)d - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    
    # Console handler for development
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    collab_logger.addHandler(console_handler)
    
    # File handler for production logging if specified
    log_file = os.getenv('JUPYTER_COLLAB_LOG_FILE')
    if log_file:
        try:
            file_handler = logging.FileHandler(log_file)
            file_handler.setFormatter(formatter)
            collab_logger.addHandler(file_handler)
        except (OSError, IOError) as e:
            collab_logger.warning(f"Failed to configure file logging: {e}")
    
    # Configure component-specific loggers
    component_loggers = [
        'jupyter.collaboration.manager',
        'jupyter.collaboration.persistence', 
        'jupyter.collaboration.websocket',
        'jupyter.collaboration.yjs',
        'jupyter.collaboration.awareness',
        'jupyter.collaboration.locks',
        'jupyter.collaboration.history',
        'jupyter.collaboration.permissions'
    ]
    
    for logger_name in component_loggers:
        component_logger = logging.getLogger(logger_name)
        component_logger.setLevel(collab_logger.level)
        component_logger.propagate = True
    
    collab_logger.info(f"Collaboration logging configured at {log_level} level")


def get_collaboration_manager() -> Optional[CollaborationManager]:
    """
    Get the global collaboration manager instance.
    
    Returns:
        The initialized CollaborationManager instance, or None if not initialized.
    """
    return _collaboration_manager


def get_persistence_layer() -> Optional[PersistenceLayer]:
    """
    Get the global persistence layer instance.
    
    Returns:
        The initialized PersistenceLayer instance, or None if not initialized.
    """
    return _persistence_layer


async def initialize_collaboration_infrastructure(
    persistence_config: Optional[PersistenceConfig] = None,
    collaboration_config: Optional[CollaborationConfig] = None
) -> tuple[CollaborationManager, PersistenceLayer]:
    """
    Initialize the complete collaboration infrastructure.
    
    This function sets up the multi-tier persistence layer and collaboration
    manager with proper configuration, health checks, and monitoring integration.
    
    Args:
        persistence_config: Optional persistence configuration. If None, uses defaults.
        collaboration_config: Optional collaboration configuration. If None, uses defaults.
    
    Returns:
        Tuple of (CollaborationManager, PersistenceLayer) instances ready for use.
    
    Raises:
        RuntimeError: If initialization fails for any component.
        ConnectionError: If unable to connect to required infrastructure services.
    """
    global _collaboration_manager, _persistence_layer
    
    logger = logging.getLogger('jupyter.collaboration')
    
    try:
        logger.info("Initializing collaborative editing infrastructure...")
        
        # Initialize persistence layer first
        if _persistence_layer is None:
            logger.info("Initializing multi-tier persistence layer...")
            _persistence_layer = PersistenceLayer(config=persistence_config)
            await _persistence_layer.initialize()
            logger.info("Persistence layer initialization complete")
        
        # Initialize collaboration manager
        if _collaboration_manager is None:
            logger.info("Initializing collaboration manager...")
            _collaboration_manager = CollaborationManager(
                persistence_layer=_persistence_layer,
                config=collaboration_config
            )
            await _collaboration_manager.initialize()
            logger.info("Collaboration manager initialization complete")
        
        # Perform health checks
        logger.info("Performing infrastructure health checks...")
        persistence_health = await _persistence_layer.get_health_status()
        manager_health = await _collaboration_manager.get_health_status()
        
        if not persistence_health.get('overall_healthy', False):
            raise RuntimeError(f"Persistence layer health check failed: {persistence_health}")
        
        if manager_health.get('collaboration_manager', {}).get('status') != 'healthy':
            raise RuntimeError(f"Collaboration manager health check failed: {manager_health}")
        
        logger.info("Collaborative editing infrastructure initialized successfully")
        logger.info(f"Active sessions: {manager_health.get('collaboration_manager', {}).get('active_sessions', 0)}")
        logger.info(f"Storage tiers: {list(persistence_health.get('tiers', {}).keys())}")
        
        return _collaboration_manager, _persistence_layer
        
    except Exception as e:
        logger.error(f"Failed to initialize collaboration infrastructure: {e}")
        
        # Cleanup on failure
        if _collaboration_manager:
            try:
                await _collaboration_manager.close()
            except Exception as cleanup_error:
                logger.error(f"Error during manager cleanup: {cleanup_error}")
            finally:
                _collaboration_manager = None
        
        if _persistence_layer:
            try:
                await _persistence_layer.close()
            except Exception as cleanup_error:
                logger.error(f"Error during persistence cleanup: {cleanup_error}")
            finally:
                _persistence_layer = None
        
        raise RuntimeError(f"Collaboration infrastructure initialization failed: {e}") from e


async def shutdown_collaboration_infrastructure():
    """
    Gracefully shutdown the collaboration infrastructure.
    
    Performs proper cleanup of all components including active sessions,
    WebSocket connections, database connections, and background tasks.
    """
    global _collaboration_manager, _persistence_layer
    
    logger = logging.getLogger('jupyter.collaboration')
    logger.info("Shutting down collaborative editing infrastructure...")
    
    # Shutdown collaboration manager first
    if _collaboration_manager:
        try:
            logger.info("Shutting down collaboration manager...")
            await _collaboration_manager.close()
            logger.info("Collaboration manager shutdown complete")
        except Exception as e:
            logger.error(f"Error during collaboration manager shutdown: {e}")
        finally:
            _collaboration_manager = None
    
    # Shutdown persistence layer
    if _persistence_layer:
        try:
            logger.info("Shutting down persistence layer...")
            await _persistence_layer.close()
            logger.info("Persistence layer shutdown complete")
        except Exception as e:
            logger.error(f"Error during persistence layer shutdown: {e}")
        finally:
            _persistence_layer = None
    
    logger.info("Collaborative editing infrastructure shutdown complete")


def get_collaboration_info() -> Dict[str, Any]:
    """
    Get comprehensive information about the collaboration subsystem.
    
    Returns:
        Dictionary containing version, features, dependencies, and configuration info.
    """
    info = __collaboration_info__.copy()
    
    # Add runtime status
    info["runtime"] = {
        "manager_initialized": _collaboration_manager is not None,
        "persistence_initialized": _persistence_layer is not None,
        "python_version": sys.version,
        "platform": sys.platform
    }
    
    # Add configuration status
    if _collaboration_manager:
        info["configuration"] = {
            "enabled": _collaboration_manager.config.enabled,
            "debug": _collaboration_manager.config.debug,
            "max_users_per_session": _collaboration_manager.config.max_users_per_session,
            "session_timeout": _collaboration_manager.config.session_timeout,
            "websocket_ping_interval": _collaboration_manager.config.websocket_ping_interval
        }
    
    return info


# Configure logging on module import
configure_collaboration_logging()

# Export public API
__all__ = [
    # Core classes
    "CollaborationManager",
    "PersistenceLayer",
    
    # Configuration classes
    "CollaborationConfig", 
    "PersistenceConfig",
    
    # Data structures
    "CollaborationSession",
    "WebSocketConnection", 
    "CollaborationMessage",
    "CRDTOperation",
    "SessionMetadata",
    "UserPermission",
    
    # Enums
    "SessionStatus",
    "UserRole", 
    "MessageType",
    "OperationType",
    "StorageTier",
    
    # Metrics and monitoring
    "CollaborationMetrics",
    "PersistenceMetrics",
    
    # Component managers
    "JupyterHubAuthenticator",
    "LockManager",
    "PresenceManager", 
    "EncryptionManager",
    "RedisManager",
    "MongoDBManager", 
    "PostgreSQLManager",
    "S3Manager",
    
    # Infrastructure functions
    "initialize_collaboration_infrastructure",
    "shutdown_collaboration_infrastructure",
    "get_collaboration_manager",
    "get_persistence_layer",
    "get_collaboration_info",
    "configure_collaboration_logging",
    
    # Module metadata
    "__version__",
    "__author__",
    "__email__", 
    "__description__",
    "__collaboration_info__"
]