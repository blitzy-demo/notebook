"""
Comprehensive Collaboration Manager for Jupyter Notebook v7

This module implements the central CollaborationManager class providing comprehensive 
session lifecycle management, user coordination, cross-instance session state 
synchronization, and real-time message routing for collaborative editing.

The CollaborationManager serves as the core orchestration layer for:
- WebSocket connection pool management with automatic reconnection
- User presence tracking and awareness broadcasting via Redis pub/sub
- Distributed cell-level locking system preventing editing conflicts
- Cross-instance session coordination for horizontal scaling
- JupyterHub authentication integration for secure multi-user access
- Real-time message routing between YjsNotebookProvider instances
- Session cleanup and resource management with graceful degradation

Architecture:
- Centralized session state management with Redis coordination
- WebSocket connection pooling with automatic failover and recovery
- Integration with multi-tier persistence layer for data durability
- Event-driven architecture for real-time collaboration synchronization
- Comprehensive error handling with fallback to single-user mode
"""

import asyncio
import json
import logging
import os
import time
import uuid
import weakref
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Callable, Union, Tuple
from dataclasses import dataclass, asdict
from enum import Enum
from contextlib import asynccontextmanager
from collections import defaultdict

# Third-party imports
import aiohttp
import aioredis
import tornado.websocket
import tornado.ioloop
from tornado.locks import Lock as TornadoLock
from prometheus_client import Counter, Histogram, Gauge, Summary

# Local imports
from .persistence import (
    PersistenceLayer, 
    PersistenceConfig, 
    CRDTOperation, 
    SessionMetadata, 
    UserPermission,
    OperationType
)

# Logging configuration
logger = logging.getLogger(__name__)


class SessionStatus(Enum):
    """Collaborative session status enumeration"""
    INITIALIZING = "initializing"
    ACTIVE = "active"
    PAUSED = "paused"
    TERMINATING = "terminating"
    TERMINATED = "terminated"
    ERROR = "error"


class UserRole(Enum):
    """User role enumeration for collaborative sessions"""
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"
    GUEST = "guest"


class MessageType(Enum):
    """WebSocket message type enumeration"""
    CRDT_OPERATION = "crdt_operation"
    AWARENESS_UPDATE = "awareness_update"
    LOCK_REQUEST = "lock_request"
    LOCK_RELEASE = "lock_release"
    LOCK_STATUS = "lock_status"
    PRESENCE_UPDATE = "presence_update"
    PERMISSION_CHANGE = "permission_change"
    SESSION_JOIN = "session_join"
    SESSION_LEAVE = "session_leave"
    SESSION_TERMINATE = "session_terminate"
    SYNC_REQUEST = "sync_request"
    SYNC_RESPONSE = "sync_response"
    ERROR = "error"
    HEARTBEAT = "heartbeat"


@dataclass
class CollaborationSession:
    """Collaborative session data structure"""
    session_id: str
    notebook_path: str
    created_by: str
    created_at: datetime
    participants: Set[str]
    status: SessionStatus
    permissions: Dict[str, UserRole]
    metadata: Dict[str, Any]
    last_activity: datetime
    websocket_connections: Set[str]  # WebSocket connection IDs
    lock_state: Dict[str, str]  # cell_id -> user_id mapping
    presence_data: Dict[str, Dict[str, Any]]  # user_id -> presence info


@dataclass
class WebSocketConnection:
    """WebSocket connection tracking"""
    connection_id: str
    user_id: str
    session_id: str
    handler: tornado.websocket.WebSocketHandler
    connected_at: datetime
    last_heartbeat: datetime
    permissions: UserRole


@dataclass
class CollaborationMessage:
    """Standardized collaboration message format"""
    message_type: MessageType
    session_id: str
    user_id: str
    timestamp: datetime
    payload: Dict[str, Any]
    operation_id: Optional[str] = None


class CollaborationMetrics:
    """Prometheus metrics for collaboration manager monitoring"""
    
    def __init__(self):
        # Session metrics
        self.sessions_total = Counter(
            'jupyter_collab_sessions_total',
            'Total collaborative sessions',
            ['status', 'notebook_type']
        )
        
        self.sessions_active = Gauge(
            'jupyter_collab_sessions_active',
            'Currently active collaborative sessions'
        )
        
        self.session_duration = Histogram(
            'jupyter_collab_session_duration_seconds',
            'Session duration in seconds',
            ['status'],
            buckets=[60, 300, 900, 1800, 3600, 7200, 14400]
        )
        
        # User metrics
        self.users_connected = Gauge(
            'jupyter_collab_users_connected',
            'Currently connected collaborative users'
        )
        
        self.users_per_session = Histogram(
            'jupyter_collab_users_per_session',
            'Number of users per collaborative session',
            buckets=[1, 2, 3, 5, 10, 15, 20, 30]
        )
        
        # WebSocket metrics
        self.websocket_connections = Gauge(
            'jupyter_collab_websocket_connections',
            'Active WebSocket connections'
        )
        
        self.websocket_messages = Counter(
            'jupyter_collab_websocket_messages_total',
            'WebSocket messages processed',
            ['message_type', 'status']
        )
        
        self.message_processing_duration = Histogram(
            'jupyter_collab_message_processing_duration_seconds',
            'Message processing duration',
            ['message_type'],
            buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5]
        )
        
        # Lock metrics
        self.lock_operations = Counter(
            'jupyter_collab_lock_operations_total',
            'Cell lock operations',
            ['operation', 'status']
        )
        
        self.lock_duration = Histogram(
            'jupyter_collab_lock_duration_seconds',
            'Cell lock duration',
            buckets=[1, 5, 15, 30, 60, 300, 600, 1800]
        )
        
        # Error metrics
        self.errors_total = Counter(
            'jupyter_collab_errors_total',
            'Collaboration errors',
            ['error_type', 'component']
        )


class CollaborationConfig:
    """Configuration management for collaboration manager"""
    
    def __init__(self):
        # Core configuration
        self.enabled = os.getenv('JUPYTER_COLLAB_ENABLED', 'false').lower() == 'true'
        self.debug = os.getenv('JUPYTER_COLLAB_DEBUG', 'false').lower() == 'true'
        self.server_url = os.getenv('JUPYTER_COLLAB_SERVER_URL', 'ws://localhost:1234')
        
        # Session configuration
        self.max_users_per_session = int(os.getenv('JUPYTER_COLLAB_MAX_USERS_PER_SESSION', '10'))
        self.session_timeout = int(os.getenv('JUPYTER_COLLAB_SESSION_TIMEOUT', '3600'))
        self.session_cleanup_interval = int(os.getenv('JUPYTER_COLLAB_CLEANUP_INTERVAL', '300'))
        
        # WebSocket configuration
        self.websocket_ping_interval = int(os.getenv('JUPYTER_COLLAB_WEBSOCKET_PING_INTERVAL', '30'))
        self.websocket_timeout = int(os.getenv('JUPYTER_COLLAB_WEBSOCKET_TIMEOUT', '60'))
        self.max_websocket_connections = int(os.getenv('JUPYTER_COLLAB_MAX_WEBSOCKET_CONNECTIONS', '1000'))
        
        # Lock configuration
        self.lock_timeout = int(os.getenv('JUPYTER_COLLAB_LOCK_TIMEOUT', '300'))
        self.lock_acquire_timeout = int(os.getenv('JUPYTER_COLLAB_LOCK_ACQUIRE_TIMEOUT', '5'))
        
        # JupyterHub integration
        self.hub_api_url = os.getenv('JUPYTER_COLLAB_HUB_API_URL', 'http://localhost:8081/hub/api')
        self.hub_api_token = os.getenv('JUPYTER_COLLAB_HUB_API_TOKEN')
        self.enable_jupyterhub_auth = os.getenv('JUPYTER_COLLAB_JUPYTERHUB_AUTH', 'true').lower() == 'true'
        
        # Performance tuning
        self.message_batch_size = int(os.getenv('JUPYTER_COLLAB_MESSAGE_BATCH_SIZE', '100'))
        self.presence_update_interval = int(os.getenv('JUPYTER_COLLAB_PRESENCE_UPDATE_INTERVAL', '5'))
        self.state_sync_interval = int(os.getenv('JUPYTER_COLLAB_STATE_SYNC_INTERVAL', '60'))


class JupyterHubAuthenticator:
    """JupyterHub authentication integration"""
    
    def __init__(self, config: CollaborationConfig):
        self.config = config
        self.session = None
        self._user_cache = {}
        self._cache_ttl = 300  # 5 minutes
        
    async def initialize(self):
        """Initialize HTTP session for JupyterHub API calls"""
        if self.config.enable_jupyterhub_auth and self.config.hub_api_token:
            self.session = aiohttp.ClientSession(
                headers={'Authorization': f'token {self.config.hub_api_token}'},
                timeout=aiohttp.ClientTimeout(total=10)
            )
            logger.info("JupyterHub authenticator initialized")
    
    async def close(self):
        """Close HTTP session"""
        if self.session:
            await self.session.close()
    
    async def authenticate_user(self, token: str) -> Optional[Dict[str, Any]]:
        """Authenticate user via JupyterHub API"""
        if not self.config.enable_jupyterhub_auth or not self.session:
            # Fallback authentication for development
            return {'name': 'dev-user', 'groups': ['notebook-editors']}
        
        try:
            # Check cache first
            cache_key = f"auth:{token}"
            if cache_key in self._user_cache:
                cached_result, cached_time = self._user_cache[cache_key]
                if time.time() - cached_time < self._cache_ttl:
                    return cached_result
            
            # Authenticate with JupyterHub
            url = f"{self.config.hub_api_url}/authorizations/token/{token}"
            async with self.session.get(url) as response:
                if response.status == 200:
                    user_info = await response.json()
                    
                    # Get user groups
                    user_url = f"{self.config.hub_api_url}/users/{user_info['name']}"
                    async with self.session.get(user_url) as user_response:
                        if user_response.status == 200:
                            user_data = await user_response.json()
                            user_info['groups'] = user_data.get('groups', [])
                    
                    # Cache result
                    self._user_cache[cache_key] = (user_info, time.time())
                    return user_info
                
                logger.warning(f"JupyterHub authentication failed: {response.status}")
                return None
                
        except Exception as e:
            logger.error(f"JupyterHub authentication error: {e}")
            return None
    
    async def get_user_permissions(self, user_id: str, notebook_path: str) -> UserRole:
        """Get user permissions for notebook access"""
        if not self.config.enable_jupyterhub_auth:
            return UserRole.EDITOR  # Default for development
        
        try:
            # Get user groups from cache or API
            cache_key = f"user:{user_id}"
            user_info = None
            
            if cache_key in self._user_cache:
                cached_result, cached_time = self._user_cache[cache_key]
                if time.time() - cached_time < self._cache_ttl:
                    user_info = cached_result
            
            if not user_info:
                url = f"{self.config.hub_api_url}/users/{user_id}"
                async with self.session.get(url) as response:
                    if response.status == 200:
                        user_info = await response.json()
                        self._user_cache[cache_key] = (user_info, time.time())
            
            if user_info:
                groups = user_info.get('groups', [])
                
                # Determine role based on groups
                if 'notebook-admins' in groups:
                    return UserRole.ADMIN
                elif 'notebook-editors' in groups:
                    return UserRole.EDITOR
                elif 'notebook-viewers' in groups:
                    return UserRole.VIEWER
                else:
                    return UserRole.GUEST
            
            return UserRole.GUEST
            
        except Exception as e:
            logger.error(f"Error getting user permissions: {e}")
            return UserRole.GUEST


class LockManager:
    """Distributed cell-level locking manager"""
    
    def __init__(self, redis_client: aioredis.Redis, config: CollaborationConfig):
        self.redis = redis_client
        self.config = config
        self.metrics = CollaborationMetrics()
        self._local_locks = {}  # Local lock cache
        
    async def acquire_lock(self, session_id: str, cell_id: str, user_id: str) -> bool:
        """Acquire exclusive lock for cell editing"""
        lock_key = f"lock:{session_id}:{cell_id}"
        
        start_time = time.time()
        try:
            # Attempt distributed lock acquisition with TTL
            lock_value = json.dumps({
                'user_id': user_id,
                'acquired_at': time.time(),
                'session_id': session_id,
                'lock_id': str(uuid.uuid4())
            })
            
            # Use Redis SET with NX (not exists) and EX (expire) for atomic operation
            acquired = await self.redis.set(
                lock_key, 
                lock_value, 
                nx=True, 
                ex=self.config.lock_timeout
            )
            
            if acquired:
                # Cache locally for fast lookup
                self._local_locks[f"{session_id}:{cell_id}"] = {
                    'user_id': user_id,
                    'acquired_at': time.time()
                }
                
                self.metrics.lock_operations.labels(
                    operation='acquire',
                    status='success'
                ).inc()
                
                logger.debug(f"Lock acquired: {cell_id} by {user_id} in session {session_id}")
                return True
            else:
                self.metrics.lock_operations.labels(
                    operation='acquire',
                    status='failed'
                ).inc()
                return False
                
        except Exception as e:
            self.metrics.lock_operations.labels(
                operation='acquire',
                status='error'
            ).inc()
            logger.error(f"Lock acquisition error: {e}")
            return False
        finally:
            duration = time.time() - start_time
            self.metrics.message_processing_duration.labels(
                message_type='lock_acquire'
            ).observe(duration)
    
    async def release_lock(self, session_id: str, cell_id: str, user_id: str) -> bool:
        """Release cell lock if owned by user"""
        lock_key = f"lock:{session_id}:{cell_id}"
        
        try:
            # Lua script for atomic lock release (only if owned by user)
            lua_script = """
            local lock_key = KEYS[1]
            local user_id = ARGV[1]
            local current_lock = redis.call('GET', lock_key)
            
            if current_lock then
                local lock_data = cjson.decode(current_lock)
                if lock_data.user_id == user_id then
                    redis.call('DEL', lock_key)
                    return 1
                end
            end
            return 0
            """
            
            result = await self.redis.eval(lua_script, 1, lock_key, user_id)
            
            if result == 1:
                # Remove from local cache
                local_key = f"{session_id}:{cell_id}"
                self._local_locks.pop(local_key, None)
                
                self.metrics.lock_operations.labels(
                    operation='release',
                    status='success'
                ).inc()
                
                logger.debug(f"Lock released: {cell_id} by {user_id} in session {session_id}")
                return True
            else:
                self.metrics.lock_operations.labels(
                    operation='release',
                    status='failed'
                ).inc()
                return False
                
        except Exception as e:
            self.metrics.lock_operations.labels(
                operation='release',
                status='error'
            ).inc()
            logger.error(f"Lock release error: {e}")
            return False
    
    async def get_lock_owner(self, session_id: str, cell_id: str) -> Optional[str]:
        """Get current lock owner for cell"""
        lock_key = f"lock:{session_id}:{cell_id}"
        
        try:
            lock_data = await self.redis.get(lock_key)
            if lock_data:
                lock_info = json.loads(lock_data)
                return lock_info.get('user_id')
            return None
            
        except Exception as e:
            logger.error(f"Error getting lock owner: {e}")
            return None
    
    async def get_session_locks(self, session_id: str) -> Dict[str, str]:
        """Get all locks for a session"""
        try:
            pattern = f"lock:{session_id}:*"
            lock_keys = await self.redis.keys(pattern)
            
            locks = {}
            if lock_keys:
                # Get all lock data in batch
                lock_values = await self.redis.mget(lock_keys)
                
                for key, value in zip(lock_keys, lock_values):
                    if value:
                        cell_id = key.split(':', 2)[2]  # Extract cell_id from key
                        lock_info = json.loads(value)
                        locks[cell_id] = lock_info['user_id']
            
            return locks
            
        except Exception as e:
            logger.error(f"Error getting session locks: {e}")
            return {}
    
    async def force_release_user_locks(self, session_id: str, user_id: str) -> int:
        """Force release all locks held by user in session"""
        try:
            pattern = f"lock:{session_id}:*"
            lock_keys = await self.redis.keys(pattern)
            
            released_count = 0
            for lock_key in lock_keys:
                lock_data = await self.redis.get(lock_key)
                if lock_data:
                    lock_info = json.loads(lock_data)
                    if lock_info.get('user_id') == user_id:
                        await self.redis.delete(lock_key)
                        released_count += 1
                        
                        # Remove from local cache
                        cell_id = lock_key.split(':', 2)[2]
                        local_key = f"{session_id}:{cell_id}"
                        self._local_locks.pop(local_key, None)
            
            if released_count > 0:
                logger.info(f"Force released {released_count} locks for user {user_id} in session {session_id}")
            
            return released_count
            
        except Exception as e:
            logger.error(f"Error force releasing locks: {e}")
            return 0


class PresenceManager:
    """User presence and awareness manager"""
    
    def __init__(self, redis_client: aioredis.Redis, config: CollaborationConfig):
        self.redis = redis_client
        self.config = config
        self.metrics = CollaborationMetrics()
        self._presence_subscriptions = defaultdict(set)  # session_id -> set of connections
        
    async def update_presence(self, session_id: str, user_id: str, presence_data: Dict[str, Any]) -> bool:
        """Update user presence data"""
        try:
            presence_key = f"presence:{session_id}"
            user_key = f"user:{user_id}"
            
            # Add timestamp to presence data
            enriched_presence = {
                **presence_data,
                'user_id': user_id,
                'timestamp': time.time(),
                'session_id': session_id
            }
            
            # Store presence data with TTL
            pipeline = self.redis.pipeline()
            pipeline.hset(presence_key, user_key, json.dumps(enriched_presence))
            pipeline.expire(presence_key, 120)  # 2-minute TTL
            await pipeline.execute()
            
            # Publish presence update for real-time broadcasting
            await self.redis.publish(
                f"presence:updates:{session_id}",
                json.dumps({
                    'type': 'presence_update',
                    'user_id': user_id,
                    'presence': enriched_presence,
                    'timestamp': time.time()
                })
            )
            
            return True
            
        except Exception as e:
            logger.error(f"Error updating presence: {e}")
            return False
    
    async def get_session_presence(self, session_id: str) -> Dict[str, Dict[str, Any]]:
        """Get presence data for all users in session"""
        try:
            presence_key = f"presence:{session_id}"
            presence_data = await self.redis.hgetall(presence_key)
            
            result = {}
            for user_key, data in presence_data.items():
                if user_key.startswith('user:'):
                    user_id = user_key[5:]  # Remove 'user:' prefix
                    result[user_id] = json.loads(data)
            
            return result
            
        except Exception as e:
            logger.error(f"Error getting session presence: {e}")
            return {}
    
    async def remove_user_presence(self, session_id: str, user_id: str) -> bool:
        """Remove user from session presence"""
        try:
            presence_key = f"presence:{session_id}"
            user_key = f"user:{user_id}"
            
            # Remove user from presence hash
            await self.redis.hdel(presence_key, user_key)
            
            # Publish user left event
            await self.redis.publish(
                f"presence:updates:{session_id}",
                json.dumps({
                    'type': 'user_left',
                    'user_id': user_id,
                    'timestamp': time.time()
                })
            )
            
            return True
            
        except Exception as e:
            logger.error(f"Error removing user presence: {e}")
            return False
    
    async def subscribe_to_presence(self, session_id: str, callback: Callable[[Dict[str, Any]], None]):
        """Subscribe to presence updates for a session"""
        try:
            # Create Redis pubsub client
            pubsub = self.redis.pubsub()
            await pubsub.subscribe(f"presence:updates:{session_id}")
            
            # Process messages
            async for message in pubsub.listen():
                if message['type'] == 'message':
                    try:
                        data = json.loads(message['data'])
                        await callback(data)
                    except Exception as e:
                        logger.error(f"Error processing presence message: {e}")
                        
        except Exception as e:
            logger.error(f"Error subscribing to presence: {e}")


class CollaborationManager:
    """
    Central CollaborationManager class providing comprehensive session lifecycle 
    management, user coordination, cross-instance session state synchronization, 
    and real-time message routing for collaborative editing.
    """
    
    def __init__(self, persistence_layer: PersistenceLayer = None, config: CollaborationConfig = None):
        self.config = config or CollaborationConfig()
        self.persistence = persistence_layer or PersistenceLayer()
        self.metrics = CollaborationMetrics()
        
        # Core components
        self.authenticator = JupyterHubAuthenticator(self.config)
        self.lock_manager = None  # Initialized after Redis connection
        self.presence_manager = None  # Initialized after Redis connection
        
        # Session management
        self.sessions: Dict[str, CollaborationSession] = {}
        self.websocket_connections: Dict[str, WebSocketConnection] = {}
        self.session_locks = defaultdict(TornadoLock)  # Per-session locks for thread safety
        
        # Redis client for coordination
        self.redis_client: Optional[aioredis.Redis] = None
        
        # Cleanup and maintenance
        self.cleanup_task = None
        self.heartbeat_task = None
        
        # State
        self._initialized = False
        self._shutting_down = False
        
        logger.info("CollaborationManager initialized with configuration")
    
    async def initialize(self):
        """Initialize collaboration manager and dependencies"""
        if self._initialized:
            return
        
        try:
            logger.info("Initializing CollaborationManager...")
            
            # Initialize persistence layer
            await self.persistence.initialize()
            
            # Initialize Redis client from persistence layer
            self.redis_client = self.persistence.redis.redis
            
            # Initialize component managers
            self.lock_manager = LockManager(self.redis_client, self.config)
            self.presence_manager = PresenceManager(self.redis_client, self.config)
            
            # Initialize JupyterHub authenticator
            await self.authenticator.initialize()
            
            # Start background tasks
            await self._start_background_tasks()
            
            self._initialized = True
            logger.info("CollaborationManager initialized successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize CollaborationManager: {e}")
            raise
    
    async def close(self):
        """Close collaboration manager and cleanup resources"""
        if not self._initialized or self._shutting_down:
            return
        
        self._shutting_down = True
        logger.info("Shutting down CollaborationManager...")
        
        try:
            # Cancel background tasks
            if self.cleanup_task:
                self.cleanup_task.cancel()
            if self.heartbeat_task:
                self.heartbeat_task.cancel()
            
            # Close all WebSocket connections
            for connection in list(self.websocket_connections.values()):
                try:
                    await self._disconnect_websocket(connection.connection_id, reason="server_shutdown")
                except Exception as e:
                    logger.error(f"Error closing WebSocket connection: {e}")
            
            # Terminate active sessions
            for session in list(self.sessions.values()):
                try:
                    await self.terminate_session(session.session_id, reason="server_shutdown")
                except Exception as e:
                    logger.error(f"Error terminating session: {e}")
            
            # Close components
            await self.authenticator.close()
            await self.persistence.close()
            
            self._initialized = False
            logger.info("CollaborationManager shutdown complete")
            
        except Exception as e:
            logger.error(f"Error during CollaborationManager shutdown: {e}")
    
    async def _start_background_tasks(self):
        """Start background maintenance tasks"""
        # Session cleanup task
        self.cleanup_task = asyncio.create_task(self._session_cleanup_loop())
        
        # WebSocket heartbeat task  
        self.heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        
        logger.info("Background tasks started")
    
    async def _session_cleanup_loop(self):
        """Background task for session cleanup and maintenance"""
        while not self._shutting_down:
            try:
                await asyncio.sleep(self.config.session_cleanup_interval)
                await self._cleanup_inactive_sessions()
                await self._cleanup_expired_locks()
                await self._sync_session_state()
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in session cleanup loop: {e}")
                self.metrics.errors_total.labels(
                    error_type='cleanup',
                    component='session_manager'
                ).inc()
    
    async def _heartbeat_loop(self):
        """Background task for WebSocket connection health monitoring"""
        while not self._shutting_down:
            try:
                await asyncio.sleep(self.config.websocket_ping_interval)
                await self._check_websocket_health()
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in heartbeat loop: {e}")
                self.metrics.errors_total.labels(
                    error_type='heartbeat',
                    component='websocket_manager'
                ).inc()
    
    async def create_session(self, notebook_path: str, created_by: str, 
                           permissions: Dict[str, UserRole] = None) -> str:
        """Create new collaborative session"""
        session_id = str(uuid.uuid4())
        
        try:
            # Validate user permissions
            user_role = await self.authenticator.get_user_permissions(created_by, notebook_path)
            if user_role not in [UserRole.ADMIN, UserRole.EDITOR]:
                raise PermissionError(f"User {created_by} lacks permission to create collaborative session")
            
            # Create session object
            session = CollaborationSession(
                session_id=session_id,
                notebook_path=notebook_path,
                created_by=created_by,
                created_at=datetime.utcnow(),
                participants={created_by},
                status=SessionStatus.INITIALIZING,
                permissions=permissions or {created_by: UserRole.ADMIN},
                metadata={
                    'created_by': created_by,
                    'notebook_path': notebook_path,
                    'server_instance': os.getenv('HOSTNAME', 'unknown')
                },
                last_activity=datetime.utcnow(),
                websocket_connections=set(),
                lock_state={},
                presence_data={}
            )
            
            # Store session
            async with self.session_locks[session_id]:
                self.sessions[session_id] = session
                
                # Persist session metadata
                session_metadata = SessionMetadata(
                    session_id=session_id,
                    notebook_path=notebook_path,
                    created_by=created_by,
                    created_at=session.created_at,
                    participants=list(session.participants),
                    permissions={user: role.value for user, role in session.permissions.items()},
                    status=session.status.value
                )
                
                await self.persistence.mongodb.store_collaboration_metadata(session_metadata)
                
                # Store session state in Redis
                session_state = {
                    'session_id': session_id,
                    'notebook_path': notebook_path,
                    'participants': list(session.participants),
                    'status': session.status.value,
                    'created_at': session.created_at.isoformat(),
                    'last_activity': session.last_activity.isoformat()
                }
                await self.persistence.redis.store_session_state(session_id, session_state)
            
            # Update session status
            session.status = SessionStatus.ACTIVE
            
            # Update metrics
            self.metrics.sessions_total.labels(
                status='created',
                notebook_type='jupyter'
            ).inc()
            self.metrics.sessions_active.inc()
            
            logger.info(f"Created collaborative session {session_id} for {notebook_path} by {created_by}")
            return session_id
            
        except Exception as e:
            logger.error(f"Error creating session: {e}")
            self.metrics.errors_total.labels(
                error_type='session_creation',
                component='session_manager'
            ).inc()
            raise
    
    async def join_session(self, session_id: str, user_id: str, connection_id: str,
                          websocket_handler: tornado.websocket.WebSocketHandler) -> bool:
        """Join user to collaborative session"""
        try:
            # Validate session exists
            if session_id not in self.sessions:
                # Try to load from persistence
                session_state = await self.persistence.get_session_state(session_id)
                if not session_state:
                    logger.warning(f"Session {session_id} not found")
                    return False
                
                # Reconstruct session from state
                await self._reconstruct_session(session_id, session_state)
            
            session = self.sessions[session_id]
            
            # Validate user permissions
            if user_id not in session.permissions:
                # Get default permissions from authenticator
                user_role = await self.authenticator.get_user_permissions(user_id, session.notebook_path)
                if user_role == UserRole.GUEST:
                    logger.warning(f"User {user_id} denied access to session {session_id}")
                    return False
                session.permissions[user_id] = user_role
            
            # Check session capacity
            if len(session.participants) >= self.config.max_users_per_session:
                logger.warning(f"Session {session_id} at capacity")
                return False
            
            async with self.session_locks[session_id]:
                # Add user to session
                session.participants.add(user_id)
                session.last_activity = datetime.utcnow()
                
                # Create WebSocket connection tracking
                connection = WebSocketConnection(
                    connection_id=connection_id,
                    user_id=user_id,
                    session_id=session_id,
                    handler=websocket_handler,
                    connected_at=datetime.utcnow(),
                    last_heartbeat=datetime.utcnow(),
                    permissions=session.permissions[user_id]
                )
                
                self.websocket_connections[connection_id] = connection
                session.websocket_connections.add(connection_id)
                
                # Update presence
                await self.presence_manager.update_presence(
                    session_id,
                    user_id,
                    {
                        'status': 'active',
                        'connection_id': connection_id,
                        'joined_at': time.time()
                    }
                )
                
                # Persist updated session state
                await self._persist_session_state(session)
            
            # Update metrics
            self.metrics.websocket_connections.inc()
            self.metrics.users_connected.inc()
            self.metrics.users_per_session.observe(len(session.participants))
            
            # Send session state to new user
            await self._send_session_sync(connection)
            
            # Broadcast user joined event
            await self._broadcast_to_session(
                session_id,
                CollaborationMessage(
                    message_type=MessageType.SESSION_JOIN,
                    session_id=session_id,
                    user_id=user_id,
                    timestamp=datetime.utcnow(),
                    payload={
                        'user_id': user_id,
                        'permissions': session.permissions[user_id].value,
                        'participants': list(session.participants)
                    }
                ),
                exclude_connections={connection_id}
            )
            
            logger.info(f"User {user_id} joined session {session_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error joining session: {e}")
            self.metrics.errors_total.labels(
                error_type='session_join',
                component='session_manager'
            ).inc()
            return False
    
    async def leave_session(self, connection_id: str, reason: str = "user_left") -> bool:
        """Remove user from collaborative session"""
        try:
            if connection_id not in self.websocket_connections:
                return False
            
            connection = self.websocket_connections[connection_id]
            session_id = connection.session_id
            user_id = connection.user_id
            
            if session_id not in self.sessions:
                return False
            
            session = self.sessions[session_id]
            
            async with self.session_locks[session_id]:
                # Remove connection
                self.websocket_connections.pop(connection_id, None)
                session.websocket_connections.discard(connection_id)
                
                # Check if user has other connections
                user_connections = [
                    conn for conn in self.websocket_connections.values()
                    if conn.user_id == user_id and conn.session_id == session_id
                ]
                
                if not user_connections:
                    # User completely left session
                    session.participants.discard(user_id)
                    
                    # Force release user's locks
                    released_locks = await self.lock_manager.force_release_user_locks(session_id, user_id)
                    if released_locks > 0:
                        logger.info(f"Released {released_locks} locks for departing user {user_id}")
                    
                    # Remove presence
                    await self.presence_manager.remove_user_presence(session_id, user_id)
                
                session.last_activity = datetime.utcnow()
                
                # Persist updated session state
                await self._persist_session_state(session)
            
            # Update metrics
            self.metrics.websocket_connections.dec()
            if not user_connections:
                self.metrics.users_connected.dec()
            
            # Broadcast user left event
            await self._broadcast_to_session(
                session_id,
                CollaborationMessage(
                    message_type=MessageType.SESSION_LEAVE,
                    session_id=session_id,
                    user_id=user_id,
                    timestamp=datetime.utcnow(),
                    payload={
                        'user_id': user_id,
                        'reason': reason,
                        'participants': list(session.participants)
                    }
                )
            )
            
            # Check if session should be terminated
            if len(session.participants) == 0:
                await self.terminate_session(session_id, reason="no_participants")
            
            logger.info(f"User {user_id} left session {session_id} (reason: {reason})")
            return True
            
        except Exception as e:
            logger.error(f"Error leaving session: {e}")
            self.metrics.errors_total.labels(
                error_type='session_leave',
                component='session_manager'
            ).inc()
            return False
    
    async def terminate_session(self, session_id: str, reason: str = "manual") -> bool:
        """Terminate collaborative session"""
        try:
            if session_id not in self.sessions:
                return False
            
            session = self.sessions[session_id]
            
            async with self.session_locks[session_id]:
                # Update session status
                session.status = SessionStatus.TERMINATING
                session.last_activity = datetime.utcnow()
                
                # Disconnect all WebSocket connections
                connections_to_close = list(session.websocket_connections)
                for connection_id in connections_to_close:
                    await self._disconnect_websocket(connection_id, reason=f"session_terminated:{reason}")
                
                # Clear session locks
                session_locks = await self.lock_manager.get_session_locks(session_id)
                for cell_id in session_locks:
                    await self.redis_client.delete(f"lock:{session_id}:{cell_id}")
                
                # Clear session presence
                await self.redis_client.delete(f"presence:{session_id}")
                
                # Update session status
                session.status = SessionStatus.TERMINATED
                
                # Persist final session state
                await self._persist_session_state(session)
                
                # Remove from active sessions
                self.sessions.pop(session_id, None)
            
            # Update metrics
            self.metrics.sessions_active.dec()
            session_duration = (datetime.utcnow() - session.created_at).total_seconds()
            self.metrics.session_duration.labels(status='terminated').observe(session_duration)
            
            logger.info(f"Terminated session {session_id} (reason: {reason})")
            return True
            
        except Exception as e:
            logger.error(f"Error terminating session: {e}")
            self.metrics.errors_total.labels(
                error_type='session_termination',
                component='session_manager'
            ).inc()
            return False
    
    async def process_message(self, connection_id: str, message_data: Dict[str, Any]) -> bool:
        """Process incoming WebSocket message"""
        start_time = time.time()
        
        try:
            if connection_id not in self.websocket_connections:
                logger.warning(f"Message from unknown connection: {connection_id}")
                return False
            
            connection = self.websocket_connections[connection_id]
            
            # Parse message
            message = CollaborationMessage(
                message_type=MessageType(message_data.get('type', 'unknown')),
                session_id=connection.session_id,
                user_id=connection.user_id,
                timestamp=datetime.utcnow(),
                payload=message_data.get('payload', {}),
                operation_id=message_data.get('operation_id')
            )
            
            # Update connection heartbeat
            connection.last_heartbeat = datetime.utcnow()
            
            # Process based on message type
            success = await self._process_message_by_type(message, connection)
            
            # Update metrics
            status = 'success' if success else 'failed'
            self.metrics.websocket_messages.labels(
                message_type=message.message_type.value,
                status=status
            ).inc()
            
            return success
            
        except Exception as e:
            logger.error(f"Error processing message: {e}")
            self.metrics.websocket_messages.labels(
                message_type='unknown',
                status='error'
            ).inc()
            return False
        finally:
            duration = time.time() - start_time
            message_type = message_data.get('type', 'unknown') if 'message_data' in locals() else 'unknown'
            self.metrics.message_processing_duration.labels(
                message_type=message_type
            ).observe(duration)
    
    async def _process_message_by_type(self, message: CollaborationMessage, 
                                     connection: WebSocketConnection) -> bool:
        """Process message based on type"""
        try:
            if message.message_type == MessageType.CRDT_OPERATION:
                return await self._handle_crdt_operation(message, connection)
            
            elif message.message_type == MessageType.LOCK_REQUEST:
                return await self._handle_lock_request(message, connection)
            
            elif message.message_type == MessageType.LOCK_RELEASE:
                return await self._handle_lock_release(message, connection)
            
            elif message.message_type == MessageType.AWARENESS_UPDATE:
                return await self._handle_awareness_update(message, connection)
            
            elif message.message_type == MessageType.PRESENCE_UPDATE:
                return await self._handle_presence_update(message, connection)
            
            elif message.message_type == MessageType.HEARTBEAT:
                return await self._handle_heartbeat(message, connection)
            
            elif message.message_type == MessageType.SYNC_REQUEST:
                return await self._handle_sync_request(message, connection)
            
            else:
                logger.warning(f"Unknown message type: {message.message_type}")
                return False
                
        except Exception as e:
            logger.error(f"Error processing {message.message_type}: {e}")
            return False
    
    async def _handle_crdt_operation(self, message: CollaborationMessage, 
                                   connection: WebSocketConnection) -> bool:
        """Handle CRDT operation message"""
        try:
            payload = message.payload
            
            # Create CRDT operation
            crdt_operation = CRDTOperation(
                operation_id=message.operation_id or str(uuid.uuid4()),
                session_id=message.session_id,
                user_id=message.user_id,
                operation_type=OperationType(payload.get('operation_type', 'update')),
                cell_id=payload.get('cell_id'),
                content=payload.get('content'),
                timestamp=message.timestamp,
                vector_clock=payload.get('vector_clock', {}),
                metadata=payload.get('metadata', {})
            )
            
            # Validate permissions for operation
            if not await self._validate_operation_permission(crdt_operation, connection):
                logger.warning(f"Permission denied for CRDT operation by {message.user_id}")
                return False
            
            # Check cell lock if required
            if crdt_operation.cell_id and crdt_operation.operation_type in [OperationType.UPDATE, OperationType.INSERT]:
                lock_owner = await self.lock_manager.get_lock_owner(message.session_id, crdt_operation.cell_id)
                if lock_owner and lock_owner != message.user_id:
                    logger.warning(f"Cell {crdt_operation.cell_id} locked by {lock_owner}, rejecting operation from {message.user_id}")
                    return False
            
            # Persist operation
            await self.persistence.store_crdt_operation(crdt_operation)
            
            # Broadcast to other session participants
            await self._broadcast_to_session(
                message.session_id,
                message,
                exclude_connections={connection.connection_id}
            )
            
            # Update session activity
            if message.session_id in self.sessions:
                self.sessions[message.session_id].last_activity = datetime.utcnow()
            
            return True
            
        except Exception as e:
            logger.error(f"Error handling CRDT operation: {e}")
            return False
    
    async def _handle_lock_request(self, message: CollaborationMessage, 
                                 connection: WebSocketConnection) -> bool:
        """Handle cell lock request"""
        try:
            cell_id = message.payload.get('cell_id')
            if not cell_id:
                return False
            
            # Attempt lock acquisition
            acquired = await self.lock_manager.acquire_lock(
                message.session_id,
                cell_id,
                message.user_id
            )
            
            # Send lock status response
            response_message = CollaborationMessage(
                message_type=MessageType.LOCK_STATUS,
                session_id=message.session_id,
                user_id=message.user_id,
                timestamp=datetime.utcnow(),
                payload={
                    'cell_id': cell_id,
                    'locked': acquired,
                    'owner': message.user_id if acquired else await self.lock_manager.get_lock_owner(message.session_id, cell_id)
                }
            )
            
            await self._send_message_to_connection(connection.connection_id, response_message)
            
            if acquired:
                # Broadcast lock acquisition to other participants
                await self._broadcast_to_session(
                    message.session_id,
                    response_message,
                    exclude_connections={connection.connection_id}
                )
            
            return True
            
        except Exception as e:
            logger.error(f"Error handling lock request: {e}")
            return False
    
    async def _handle_lock_release(self, message: CollaborationMessage, 
                                 connection: WebSocketConnection) -> bool:
        """Handle cell lock release"""
        try:
            cell_id = message.payload.get('cell_id')
            if not cell_id:
                return False
            
            # Release lock
            released = await self.lock_manager.release_lock(
                message.session_id,
                cell_id,
                message.user_id
            )
            
            if released:
                # Broadcast lock release
                await self._broadcast_to_session(
                    message.session_id,
                    CollaborationMessage(
                        message_type=MessageType.LOCK_STATUS,
                        session_id=message.session_id,
                        user_id=message.user_id,
                        timestamp=datetime.utcnow(),
                        payload={
                            'cell_id': cell_id,
                            'locked': False,
                            'owner': None
                        }
                    )
                )
            
            return released
            
        except Exception as e:
            logger.error(f"Error handling lock release: {e}")
            return False
    
    async def _handle_awareness_update(self, message: CollaborationMessage, 
                                     connection: WebSocketConnection) -> bool:
        """Handle awareness/cursor position update"""
        try:
            # Update presence with awareness data
            awareness_data = message.payload.get('awareness', {})
            await self.presence_manager.update_presence(
                message.session_id,
                message.user_id,
                {
                    'awareness': awareness_data,
                    'cursor': message.payload.get('cursor'),
                    'selection': message.payload.get('selection'),
                    'status': 'active'
                }
            )
            
            # Broadcast to other participants
            await self._broadcast_to_session(
                message.session_id,
                message,
                exclude_connections={connection.connection_id}
            )
            
            return True
            
        except Exception as e:
            logger.error(f"Error handling awareness update: {e}")
            return False
    
    async def _handle_presence_update(self, message: CollaborationMessage, 
                                    connection: WebSocketConnection) -> bool:
        """Handle user presence update"""
        try:
            presence_data = message.payload.get('presence', {})
            
            await self.presence_manager.update_presence(
                message.session_id,
                message.user_id,
                presence_data
            )
            
            return True
            
        except Exception as e:
            logger.error(f"Error handling presence update: {e}")
            return False
    
    async def _handle_heartbeat(self, message: CollaborationMessage, 
                              connection: WebSocketConnection) -> bool:
        """Handle heartbeat message"""
        try:
            # Update connection heartbeat timestamp
            connection.last_heartbeat = datetime.utcnow()
            
            # Send heartbeat response
            response = CollaborationMessage(
                message_type=MessageType.HEARTBEAT,
                session_id=message.session_id,
                user_id=message.user_id,
                timestamp=datetime.utcnow(),
                payload={'pong': True}
            )
            
            await self._send_message_to_connection(connection.connection_id, response)
            return True
            
        except Exception as e:
            logger.error(f"Error handling heartbeat: {e}")
            return False
    
    async def _handle_sync_request(self, message: CollaborationMessage, 
                                 connection: WebSocketConnection) -> bool:
        """Handle session synchronization request"""
        try:
            await self._send_session_sync(connection)
            return True
            
        except Exception as e:
            logger.error(f"Error handling sync request: {e}")
            return False
    
    async def _send_session_sync(self, connection: WebSocketConnection):
        """Send complete session state to connection"""
        try:
            session = self.sessions.get(connection.session_id)
            if not session:
                return
            
            # Get session locks
            locks = await self.lock_manager.get_session_locks(connection.session_id)
            
            # Get presence data
            presence = await self.presence_manager.get_session_presence(connection.session_id)
            
            sync_message = CollaborationMessage(
                message_type=MessageType.SYNC_RESPONSE,
                session_id=connection.session_id,
                user_id=connection.user_id,
                timestamp=datetime.utcnow(),
                payload={
                    'session_id': session.session_id,
                    'participants': list(session.participants),
                    'permissions': {user: role.value for user, role in session.permissions.items()},
                    'locks': locks,
                    'presence': presence,
                    'status': session.status.value
                }
            )
            
            await self._send_message_to_connection(connection.connection_id, sync_message)
            
        except Exception as e:
            logger.error(f"Error sending session sync: {e}")
    
    async def _broadcast_to_session(self, session_id: str, message: CollaborationMessage, 
                                  exclude_connections: Set[str] = None):
        """Broadcast message to all connections in session"""
        try:
            if session_id not in self.sessions:
                return
            
            session = self.sessions[session_id]
            exclude_connections = exclude_connections or set()
            
            # Get all connections for session
            target_connections = [
                conn_id for conn_id in session.websocket_connections
                if conn_id not in exclude_connections and conn_id in self.websocket_connections
            ]
            
            # Send message to all target connections
            for connection_id in target_connections:
                try:
                    await self._send_message_to_connection(connection_id, message)
                except Exception as e:
                    logger.error(f"Error sending message to connection {connection_id}: {e}")
                    # Remove failed connection
                    await self._disconnect_websocket(connection_id, reason="send_failed")
            
        except Exception as e:
            logger.error(f"Error broadcasting to session: {e}")
    
    async def _send_message_to_connection(self, connection_id: str, message: CollaborationMessage):
        """Send message to specific WebSocket connection"""
        try:
            if connection_id not in self.websocket_connections:
                return
            
            connection = self.websocket_connections[connection_id]
            
            # Convert message to JSON
            message_data = {
                'type': message.message_type.value,
                'session_id': message.session_id,
                'user_id': message.user_id,
                'timestamp': message.timestamp.isoformat(),
                'payload': message.payload
            }
            
            if message.operation_id:
                message_data['operation_id'] = message.operation_id
            
            # Send via WebSocket handler
            connection.handler.write_message(json.dumps(message_data))
            
        except Exception as e:
            logger.error(f"Error sending message to connection: {e}")
            raise
    
    async def _disconnect_websocket(self, connection_id: str, reason: str = "unknown"):
        """Disconnect WebSocket connection"""
        try:
            if connection_id in self.websocket_connections:
                connection = self.websocket_connections[connection_id]
                
                # Close WebSocket connection
                try:
                    connection.handler.close(code=1000, reason=reason)
                except Exception as e:
                    logger.debug(f"Error closing WebSocket handler: {e}")
                
                # Remove from session
                await self.leave_session(connection_id, reason=reason)
            
        except Exception as e:
            logger.error(f"Error disconnecting WebSocket: {e}")
    
    async def _validate_operation_permission(self, operation: CRDTOperation, 
                                           connection: WebSocketConnection) -> bool:
        """Validate user permission for CRDT operation"""
        try:
            # Check if user has write permissions
            if connection.permissions in [UserRole.VIEWER, UserRole.GUEST]:
                return False
            
            # Admin can do anything
            if connection.permissions == UserRole.ADMIN:
                return True
            
            # Editor can perform most operations
            if connection.permissions == UserRole.EDITOR:
                # Block certain admin-only operations
                admin_only_operations = [OperationType.DELETE]
                if operation.operation_type in admin_only_operations:
                    return False
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"Error validating operation permission: {e}")
            return False
    
    async def _cleanup_inactive_sessions(self):
        """Clean up inactive and expired sessions"""
        try:
            current_time = datetime.utcnow()
            timeout_threshold = timedelta(seconds=self.config.session_timeout)
            
            sessions_to_terminate = []
            
            for session_id, session in self.sessions.items():
                # Check for session timeout
                if current_time - session.last_activity > timeout_threshold:
                    sessions_to_terminate.append((session_id, "timeout"))
                
                # Check for sessions with no participants
                elif len(session.participants) == 0:
                    sessions_to_terminate.append((session_id, "no_participants"))
                
                # Check for orphaned sessions (no WebSocket connections)
                elif len(session.websocket_connections) == 0 and len(session.participants) > 0:
                    # Grace period for reconnection
                    grace_period = timedelta(minutes=5)
                    if current_time - session.last_activity > grace_period:
                        sessions_to_terminate.append((session_id, "no_connections"))
            
            # Terminate identified sessions
            for session_id, reason in sessions_to_terminate:
                await self.terminate_session(session_id, reason=reason)
                logger.info(f"Cleaned up session {session_id} (reason: {reason})")
            
        except Exception as e:
            logger.error(f"Error during session cleanup: {e}")
    
    async def _cleanup_expired_locks(self):
        """Clean up expired locks (Redis TTL should handle this, but double check)"""
        try:
            # This is mostly handled by Redis TTL, but we can add additional cleanup logic
            pattern = "lock:*"
            lock_keys = await self.redis_client.keys(pattern)
            
            expired_locks = 0
            for lock_key in lock_keys:
                ttl = await self.redis_client.ttl(lock_key)
                if ttl == -1:  # No expiration set
                    await self.redis_client.delete(lock_key)
                    expired_locks += 1
            
            if expired_locks > 0:
                logger.info(f"Cleaned up {expired_locks} expired locks")
                
        except Exception as e:
            logger.error(f"Error during lock cleanup: {e}")
    
    async def _sync_session_state(self):
        """Synchronize session state across instances"""
        try:
            # Update Redis with current session states
            for session_id, session in self.sessions.items():
                await self._persist_session_state(session)
            
            # Check for sessions from other instances
            # This would involve checking Redis for sessions not in local memory
            # and potentially reconstructing them if needed
            
        except Exception as e:
            logger.error(f"Error during state sync: {e}")
    
    async def _persist_session_state(self, session: CollaborationSession):
        """Persist session state to Redis"""
        try:
            session_state = {
                'session_id': session.session_id,
                'notebook_path': session.notebook_path,
                'participants': list(session.participants),
                'status': session.status.value,
                'created_at': session.created_at.isoformat(),
                'last_activity': session.last_activity.isoformat(),
                'permissions': {user: role.value for user, role in session.permissions.items()},
                'server_instance': session.metadata.get('server_instance', 'unknown')
            }
            
            await self.persistence.redis.store_session_state(session.session_id, session_state)
            
        except Exception as e:
            logger.error(f"Error persisting session state: {e}")
    
    async def _reconstruct_session(self, session_id: str, session_state: Dict[str, Any]):
        """Reconstruct session from persisted state"""
        try:
            session = CollaborationSession(
                session_id=session_id,
                notebook_path=session_state['notebook_path'],
                created_by=session_state.get('created_by', 'unknown'),
                created_at=datetime.fromisoformat(session_state['created_at']),
                participants=set(session_state['participants']),
                status=SessionStatus(session_state['status']),
                permissions={
                    user: UserRole(role) 
                    for user, role in session_state.get('permissions', {}).items()
                },
                metadata=session_state.get('metadata', {}),
                last_activity=datetime.fromisoformat(session_state['last_activity']),
                websocket_connections=set(),
                lock_state={},
                presence_data={}
            )
            
            self.sessions[session_id] = session
            logger.info(f"Reconstructed session {session_id} from persisted state")
            
        except Exception as e:
            logger.error(f"Error reconstructing session: {e}")
    
    async def _check_websocket_health(self):
        """Check health of WebSocket connections and remove stale ones"""
        try:
            current_time = datetime.utcnow()
            timeout_threshold = timedelta(seconds=self.config.websocket_timeout)
            
            stale_connections = []
            
            for connection_id, connection in self.websocket_connections.items():
                if current_time - connection.last_heartbeat > timeout_threshold:
                    stale_connections.append(connection_id)
            
            # Remove stale connections
            for connection_id in stale_connections:
                await self._disconnect_websocket(connection_id, reason="heartbeat_timeout")
                logger.info(f"Removed stale WebSocket connection {connection_id}")
            
        except Exception as e:
            logger.error(f"Error checking WebSocket health: {e}")
    
    # Public API methods for external integration
    
    async def get_session_info(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get session information"""
        try:
            if session_id in self.sessions:
                session = self.sessions[session_id]
                return {
                    'session_id': session.session_id,
                    'notebook_path': session.notebook_path,
                    'created_by': session.created_by,
                    'created_at': session.created_at.isoformat(),
                    'participants': list(session.participants),
                    'status': session.status.value,
                    'participant_count': len(session.participants),
                    'connection_count': len(session.websocket_connections),
                    'last_activity': session.last_activity.isoformat()
                }
            
            # Try to get from persistence
            session_state = await self.persistence.get_session_state(session_id)
            if session_state:
                return {
                    'session_id': session_id,
                    'notebook_path': session_state.get('notebook_path'),
                    'participants': session_state.get('participants', []),
                    'status': session_state.get('status'),
                    'participant_count': len(session_state.get('participants', [])),
                    'last_activity': session_state.get('last_activity'),
                    'from_persistence': True
                }
            
            return None
            
        except Exception as e:
            logger.error(f"Error getting session info: {e}")
            return None
    
    async def list_active_sessions(self) -> List[Dict[str, Any]]:
        """List all active collaborative sessions"""
        try:
            sessions = []
            for session in self.sessions.values():
                sessions.append({
                    'session_id': session.session_id,
                    'notebook_path': session.notebook_path,
                    'participant_count': len(session.participants),
                    'status': session.status.value,
                    'created_at': session.created_at.isoformat(),
                    'last_activity': session.last_activity.isoformat()
                })
            
            return sessions
            
        except Exception as e:
            logger.error(f"Error listing sessions: {e}")
            return []
    
    async def get_health_status(self) -> Dict[str, Any]:
        """Get collaboration manager health status"""
        try:
            # Get persistence layer health
            persistence_health = await self.persistence.get_health_status()
            
            return {
                'collaboration_manager': {
                    'status': 'healthy' if self._initialized and not self._shutting_down else 'unhealthy',
                    'active_sessions': len(self.sessions),
                    'websocket_connections': len(self.websocket_connections),
                    'total_participants': sum(len(s.participants) for s in self.sessions.values()),
                    'uptime_seconds': time.time() - (self.metrics.sessions_total._created if hasattr(self.metrics.sessions_total, '_created') else time.time())
                },
                'persistence': persistence_health,
                'components': {
                    'lock_manager': 'healthy' if self.lock_manager else 'not_initialized',
                    'presence_manager': 'healthy' if self.presence_manager else 'not_initialized',
                    'authenticator': 'healthy' if self.authenticator else 'not_initialized'
                },
                'timestamp': datetime.utcnow().isoformat()
            }
            
        except Exception as e:
            logger.error(f"Error getting health status: {e}")
            return {
                'collaboration_manager': {'status': 'error', 'error': str(e)},
                'timestamp': datetime.utcnow().isoformat()
            }


# Export main classes
__all__ = [
    'CollaborationManager',
    'CollaborationConfig',
    'CollaborationSession',
    'WebSocketConnection',
    'CollaborationMessage',
    'SessionStatus',
    'UserRole',
    'MessageType'
]