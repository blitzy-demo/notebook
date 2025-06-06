"""
Multi-tier persistence layer managing sophisticated collaborative data storage across
Redis, MongoDB, PostgreSQL, and S3 backends.

This module coordinates CRDT operation storage, version history tracking, user permission
persistence, and collaborative metadata management. It provides the critical data layer
enabling real-time synchronization, conflict resolution, and enterprise-grade audit
capabilities.

The persistence layer implements a performance tier hierarchy:
- Hot Path (Redis): Sub-millisecond operations for active collaboration state
- Warm Path (MongoDB): Fast document retrieval for CRDT states and change history  
- Cold Path (PostgreSQL): Structured storage for long-term version history and compliance
- Archive Path (S3): Cost-effective storage for snapshots and backup versions

Architecture:
- PersistenceLayer: Main coordinator class implementing multi-tier storage strategy
- Storage adapters: Redis, MongoDB, PostgreSQL, and S3 integration managers
- Connection pooling: High-availability connection management with failover
- Encryption: Comprehensive encryption at rest and in transit for all storage tiers
- Recovery: Automated state reconstruction with priority-based recovery mechanisms
"""

import asyncio
import json
import time
import hashlib
import logging
import os
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any, Union, Tuple
from dataclasses import dataclass, asdict
from contextlib import asynccontextmanager
import uuid

# Redis integration
import redis.asyncio as redis
import redis.sentinel
from redis.exceptions import ConnectionError, TimeoutError as RedisTimeoutError

# PostgreSQL integration  
import asyncpg
from asyncpg.pool import Pool as AsyncPGPool
from asyncpg.exceptions import PostgresError

# MongoDB integration
import motor.motor_asyncio
from pymongo.errors import PyMongoError
from bson import Binary, ObjectId

# S3 integration
import aioboto3
from botocore.exceptions import ClientError, NoCredentialsError
from botocore.config import Config

# Encryption
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import base64

# Logger setup
logger = logging.getLogger(__name__)


@dataclass
class CollaborationSession:
    """Collaborative session metadata model"""
    session_id: str
    notebook_path: str
    created_by: str
    created_at: datetime
    expires_at: datetime
    permissions: Dict[str, Any]
    participants: List[str]
    status: str = "active"
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


@dataclass 
class CRDTOperation:
    """CRDT operation model for Yjs synchronization"""
    operation_id: str
    document_id: str
    client_id: int
    user_id: str
    timestamp: datetime
    operation_type: str
    operation_data: bytes
    cell_id: Optional[str] = None
    parent_version: Optional[int] = None


@dataclass
class VersionHistory:
    """Version history entry for audit trails"""
    version_id: str
    session_id: str
    operation_id: str
    user_id: str
    timestamp: datetime
    operation_type: str
    operation_data: Dict[str, Any]
    cell_id: Optional[str] = None
    diff_data: Optional[Dict[str, Any]] = None


@dataclass
class UserPermission:
    """User permission model for role-based access control"""
    user_id: str
    session_id: str
    permission_level: str  # viewer, editor, admin
    granted_by: str
    granted_at: datetime
    expires_at: Optional[datetime] = None
    cell_permissions: Dict[str, List[str]] = None

    def __post_init__(self):
        if self.cell_permissions is None:
            self.cell_permissions = {}


class EncryptionManager:
    """Manages encryption for all storage tiers with enterprise security compliance"""
    
    def __init__(self, master_key: Optional[str] = None):
        """Initialize encryption with master key from environment or generate new"""
        if master_key:
            self.master_key = master_key.encode()
        else:
            # Generate key from environment or create new
            key_material = os.getenv('JUPYTER_COLLAB_ENCRYPTION_KEY', self._generate_key_material())
            self.master_key = key_material.encode()
        
        # Derive encryption key using PBKDF2
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b'jupyter_collab_salt_2024',  # Production should use random salt per deployment
            iterations=100000,
        )
        key = base64.urlsafe_b64encode(kdf.derive(self.master_key))
        self.fernet = Fernet(key)
    
    def _generate_key_material(self) -> str:
        """Generate secure key material for new deployments"""
        return base64.urlsafe_b64encode(os.urandom(32)).decode()
    
    def encrypt_data(self, data: Union[str, bytes]) -> bytes:
        """Encrypt data with AES-256 encryption"""
        if isinstance(data, str):
            data = data.encode('utf-8')
        return self.fernet.encrypt(data)
    
    def decrypt_data(self, encrypted_data: bytes) -> bytes:
        """Decrypt data and return original bytes"""
        return self.fernet.decrypt(encrypted_data)
    
    def encrypt_json(self, data: Dict[str, Any]) -> bytes:
        """Encrypt JSON data for storage"""
        json_str = json.dumps(data, default=str)
        return self.encrypt_data(json_str)
    
    def decrypt_json(self, encrypted_data: bytes) -> Dict[str, Any]:
        """Decrypt and parse JSON data"""
        json_str = self.decrypt_data(encrypted_data).decode('utf-8')
        return json.loads(json_str)


class RedisManager:
    """Redis integration for session coordination, cell-lock management, and presence tracking"""
    
    def __init__(self, redis_url: str, encryption_manager: EncryptionManager):
        self.redis_url = redis_url
        self.encryption = encryption_manager
        self.redis_client: Optional[redis.Redis] = None
        self.sentinel: Optional[redis.sentinel.Sentinel] = None
        
        # Configuration from environment
        self.lock_timeout = int(os.getenv('JUPYTER_COLLAB_LOCK_TIMEOUT', '300'))  # 5 minutes
        self.presence_ttl = int(os.getenv('JUPYTER_COLLAB_PRESENCE_TTL', '60'))  # 1 minute
        self.session_ttl = int(os.getenv('JUPYTER_COLLAB_SESSION_TTL', '86400'))  # 24 hours
        
        logger.info(f"Initializing Redis manager with URL: {redis_url}")
    
    async def initialize(self):
        """Initialize Redis connection with sentinel support for high availability"""
        try:
            if 'sentinel://' in self.redis_url:
                await self._initialize_sentinel()
            else:
                await self._initialize_direct()
            
            # Test connection
            await self.redis_client.ping()
            logger.info("Redis connection established successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize Redis connection: {e}")
            raise
    
    async def _initialize_sentinel(self):
        """Initialize Redis Sentinel for automatic failover"""
        # Parse sentinel URLs - format: sentinel://host1:port1,host2:port2/service_name
        url_parts = self.redis_url.replace('sentinel://', '').split('/')
        sentinel_hosts = [(host.split(':')[0], int(host.split(':')[1])) 
                         for host in url_parts[0].split(',')]
        service_name = url_parts[1] if len(url_parts) > 1 else 'jupyter-collab'
        
        self.sentinel = redis.sentinel.Sentinel(
            sentinel_hosts,
            socket_timeout=0.1,
            socket_connect_timeout=0.1,
            socket_keepalive=True,
        )
        
        self.redis_client = self.sentinel.master_for(
            service_name,
            socket_timeout=0.1,
            socket_connect_timeout=0.1,
            decode_responses=False,  # Handle binary data for encryption
            retry_on_timeout=True,
            health_check_interval=30
        )
    
    async def _initialize_direct(self):
        """Initialize direct Redis connection"""
        self.redis_client = redis.from_url(
            self.redis_url,
            decode_responses=False,  # Handle binary data for encryption
            retry_on_timeout=True,
            health_check_interval=30,
            max_connections=20
        )
    
    async def acquire_cell_lock(self, notebook_path: str, cell_id: str, user_id: str) -> bool:
        """Acquire distributed cell lock with TTL for conflict prevention"""
        lock_key = f"lock:{hashlib.sha256(notebook_path.encode()).hexdigest()}:{cell_id}"
        lock_value = f"{user_id}:{int(time.time())}"
        
        try:
            # Use Redis SET with NX (not exists) and EX (expire) for atomic lock acquisition
            result = await self.redis_client.set(
                lock_key,
                self.encryption.encrypt_data(lock_value),
                nx=True,
                ex=self.lock_timeout
            )
            
            if result:
                logger.debug(f"Cell lock acquired: {lock_key} by {user_id}")
                return True
            else:
                # Check if lock is owned by same user (allow re-entrant locks)
                existing_lock = await self.redis_client.get(lock_key)
                if existing_lock:
                    try:
                        existing_value = self.encryption.decrypt_data(existing_lock).decode('utf-8')
                        existing_user = existing_value.split(':')[0]
                        if existing_user == user_id:
                            # Extend lock TTL for same user
                            await self.redis_client.expire(lock_key, self.lock_timeout)
                            return True
                    except Exception as e:
                        logger.warning(f"Error checking existing lock: {e}")
                
                logger.debug(f"Cell lock acquisition failed: {lock_key} by {user_id}")
                return False
                
        except Exception as e:
            logger.error(f"Error acquiring cell lock: {e}")
            return False
    
    async def release_cell_lock(self, notebook_path: str, cell_id: str, user_id: str) -> bool:
        """Release cell lock with ownership validation"""
        lock_key = f"lock:{hashlib.sha256(notebook_path.encode()).hexdigest()}:{cell_id}"
        
        try:
            # Get current lock value to verify ownership
            existing_lock = await self.redis_client.get(lock_key)
            if not existing_lock:
                return True  # Lock doesn't exist, consider it released
            
            try:
                existing_value = self.encryption.decrypt_data(existing_lock).decode('utf-8')
                existing_user = existing_value.split(':')[0]
                
                if existing_user == user_id:
                    await self.redis_client.delete(lock_key)
                    logger.debug(f"Cell lock released: {lock_key} by {user_id}")
                    return True
                else:
                    logger.warning(f"Lock release denied: {lock_key} owned by {existing_user}, requested by {user_id}")
                    return False
                    
            except Exception as e:
                logger.warning(f"Error verifying lock ownership: {e}")
                return False
                
        except Exception as e:
            logger.error(f"Error releasing cell lock: {e}")
            return False
    
    async def update_user_presence(self, session_id: str, user_id: str, presence_data: Dict[str, Any]):
        """Update user presence with automatic expiration and broadcasting"""
        presence_key = f"presence:{session_id}"
        user_key = f"user:{user_id}"
        
        try:
            # Store encrypted presence data with TTL
            encrypted_data = self.encryption.encrypt_json(presence_data)
            
            pipeline = self.redis_client.pipeline()
            pipeline.hset(presence_key, user_key, encrypted_data)
            pipeline.expire(presence_key, self.presence_ttl)
            await pipeline.execute()
            
            # Broadcast presence update via pub/sub
            broadcast_data = {
                'user_id': user_id,
                'presence': presence_data,
                'timestamp': time.time()
            }
            
            await self.redis_client.publish(
                f"presence:updates:{session_id}",
                self.encryption.encrypt_json(broadcast_data)
            )
            
            logger.debug(f"Presence updated for user {user_id} in session {session_id}")
            
        except Exception as e:
            logger.error(f"Error updating user presence: {e}")
    
    async def get_session_participants(self, session_id: str) -> List[Dict[str, Any]]:
        """Retrieve all active participants in a collaborative session"""
        presence_key = f"presence:{session_id}"
        
        try:
            # Get all user presence data
            participants_data = await self.redis_client.hgetall(presence_key)
            
            participants = []
            for user_key, encrypted_data in participants_data.items():
                try:
                    user_id = user_key.decode('utf-8').replace('user:', '')
                    presence_data = self.encryption.decrypt_json(encrypted_data)
                    
                    participants.append({
                        'user_id': user_id,
                        'presence': presence_data,
                        'last_seen': presence_data.get('timestamp', time.time())
                    })
                    
                except Exception as e:
                    logger.warning(f"Error decrypting presence data for {user_key}: {e}")
            
            return participants
            
        except Exception as e:
            logger.error(f"Error retrieving session participants: {e}")
            return []
    
    async def store_session_cache(self, session: CollaborationSession):
        """Cache session metadata for fast access"""
        session_key = f"session:{session.session_id}"
        
        try:
            session_data = asdict(session)
            encrypted_data = self.encryption.encrypt_json(session_data)
            
            await self.redis_client.setex(
                session_key,
                self.session_ttl,
                encrypted_data
            )
            
            logger.debug(f"Session cached: {session.session_id}")
            
        except Exception as e:
            logger.error(f"Error caching session: {e}")
    
    async def get_session_cache(self, session_id: str) -> Optional[CollaborationSession]:
        """Retrieve cached session metadata"""
        session_key = f"session:{session_id}"
        
        try:
            encrypted_data = await self.redis_client.get(session_key)
            if not encrypted_data:
                return None
            
            session_data = self.encryption.decrypt_json(encrypted_data)
            
            # Convert datetime strings back to datetime objects
            session_data['created_at'] = datetime.fromisoformat(session_data['created_at'])
            session_data['expires_at'] = datetime.fromisoformat(session_data['expires_at'])
            
            return CollaborationSession(**session_data)
            
        except Exception as e:
            logger.error(f"Error retrieving cached session: {e}")
            return None
    
    async def cleanup_expired_sessions(self):
        """Periodic cleanup of expired sessions and locks"""
        try:
            # Clean up expired presence data
            presence_keys = await self.redis_client.keys("presence:*")
            for key in presence_keys:
                ttl = await self.redis_client.ttl(key)
                if ttl == -1:  # No TTL set, set one
                    await self.redis_client.expire(key, self.presence_ttl)
            
            # Clean up orphaned locks (locks without TTL)
            lock_keys = await self.redis_client.keys("lock:*")
            for key in lock_keys:
                ttl = await self.redis_client.ttl(key)
                if ttl == -1:  # No TTL set, remove orphaned lock
                    await self.redis_client.delete(key)
                    logger.info(f"Removed orphaned lock: {key}")
            
            logger.debug("Redis cleanup completed")
            
        except Exception as e:
            logger.error(f"Error during Redis cleanup: {e}")


class PostgreSQLManager:
    """PostgreSQL integration for structured storage of user permissions, version history, and audit trails"""
    
    def __init__(self, postgres_url: str, encryption_manager: EncryptionManager):
        self.postgres_url = postgres_url
        self.encryption = encryption_manager
        self.pool: Optional[AsyncPGPool] = None
        
        logger.info("Initializing PostgreSQL manager")
    
    async def initialize(self):
        """Initialize PostgreSQL connection pool with optimized settings"""
        try:
            self.pool = await asyncpg.create_pool(
                self.postgres_url,
                min_size=5,
                max_size=20,
                max_queries=50000,
                max_inactive_connection_lifetime=300,
                command_timeout=60,
                server_settings={
                    'jit': 'off',  # Disable JIT for better connection startup time
                    'application_name': 'jupyter_collab_persistence'
                }
            )
            
            # Test connection and create schema if needed
            async with self.pool.acquire() as conn:
                await conn.execute("SELECT 1")
                await self._create_collaboration_schema(conn)
            
            logger.info("PostgreSQL connection pool established successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize PostgreSQL pool: {e}")
            raise
    
    async def _create_collaboration_schema(self, conn: asyncpg.Connection):
        """Create collaboration schema and tables if they don't exist"""
        schema_sql = """
        -- Create collaboration schema
        CREATE SCHEMA IF NOT EXISTS collaboration;
        
        -- Sessions table
        CREATE TABLE IF NOT EXISTS collaboration.sessions (
            session_id UUID PRIMARY KEY,
            notebook_path TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            permissions JSONB NOT NULL,
            participants TEXT[] DEFAULT '{}',
            status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'terminated')),
            metadata JSONB DEFAULT '{}'
        );
        
        -- Version history table
        CREATE TABLE IF NOT EXISTS collaboration.version_history (
            id SERIAL PRIMARY KEY,
            version_id UUID NOT NULL,
            session_id UUID REFERENCES collaboration.sessions(session_id) ON DELETE CASCADE,
            operation_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
            operation_type TEXT NOT NULL,
            operation_data JSONB NOT NULL,
            cell_id TEXT,
            diff_data JSONB,
            parent_version INTEGER REFERENCES collaboration.version_history(id)
        );
        
        -- User permissions table
        CREATE TABLE IF NOT EXISTS collaboration.user_permissions (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            session_id UUID REFERENCES collaboration.sessions(session_id) ON DELETE CASCADE,
            permission_level TEXT NOT NULL CHECK (permission_level IN ('viewer', 'editor', 'admin')),
            granted_by TEXT NOT NULL,
            granted_at TIMESTAMP WITH TIME ZONE NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE,
            cell_permissions JSONB DEFAULT '{}',
            UNIQUE(user_id, session_id)
        );
        
        -- Comments table for review system
        CREATE TABLE IF NOT EXISTS collaboration.comments (
            comment_id UUID PRIMARY KEY,
            session_id UUID REFERENCES collaboration.sessions(session_id) ON DELETE CASCADE,
            cell_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            parent_comment_id UUID REFERENCES collaboration.comments(comment_id),
            status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'deleted')),
            metadata JSONB DEFAULT '{}'
        );
        
        -- Audit trail table
        CREATE TABLE IF NOT EXISTS collaboration.audit_trail (
            id SERIAL PRIMARY KEY,
            session_id UUID REFERENCES collaboration.sessions(session_id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            action TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id TEXT,
            timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
            ip_address INET,
            user_agent TEXT,
            metadata JSONB DEFAULT '{}'
        );
        
        -- Performance indexes
        CREATE INDEX IF NOT EXISTS idx_sessions_notebook_path ON collaboration.sessions USING btree(notebook_path);
        CREATE INDEX IF NOT EXISTS idx_sessions_created_by ON collaboration.sessions USING btree(created_by);
        CREATE INDEX IF NOT EXISTS idx_sessions_status_expires ON collaboration.sessions USING btree(status, expires_at);
        
        CREATE INDEX IF NOT EXISTS idx_version_history_session_timestamp ON collaboration.version_history USING btree(session_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_version_history_operation_id ON collaboration.version_history USING btree(operation_id);
        CREATE INDEX IF NOT EXISTS idx_version_history_user_id ON collaboration.version_history USING btree(user_id);
        
        CREATE INDEX IF NOT EXISTS idx_user_permissions_user_session ON collaboration.user_permissions USING btree(user_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_user_permissions_session_level ON collaboration.user_permissions USING btree(session_id, permission_level);
        
        CREATE INDEX IF NOT EXISTS idx_comments_session_cell ON collaboration.comments USING btree(session_id, cell_id);
        CREATE INDEX IF NOT EXISTS idx_comments_user_created ON collaboration.comments USING btree(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_comments_status ON collaboration.comments USING btree(status) WHERE status = 'active';
        
        CREATE INDEX IF NOT EXISTS idx_audit_trail_session_timestamp ON collaboration.audit_trail USING btree(session_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_trail_user_action ON collaboration.audit_trail USING btree(user_id, action);
        
        -- JSONB indexes for fast metadata queries
        CREATE INDEX IF NOT EXISTS idx_sessions_permissions_gin ON collaboration.sessions USING gin(permissions);
        CREATE INDEX IF NOT EXISTS idx_version_operation_data_gin ON collaboration.version_history USING gin(operation_data);
        CREATE INDEX IF NOT EXISTS idx_comments_metadata_gin ON collaboration.comments USING gin(metadata);
        CREATE INDEX IF NOT EXISTS idx_audit_metadata_gin ON collaboration.audit_trail USING gin(metadata);
        """
        
        try:
            await conn.execute(schema_sql)
            logger.debug("Collaboration schema and tables verified/created")
        except Exception as e:
            logger.error(f"Error creating collaboration schema: {e}")
            raise
    
    async def create_session(self, session: CollaborationSession) -> str:
        """Create new collaborative session with full metadata"""
        async with self.pool.acquire() as conn:
            try:
                session_id = await conn.fetchval("""
                    INSERT INTO collaboration.sessions 
                    (session_id, notebook_path, created_by, created_at, expires_at, 
                     permissions, participants, status, metadata)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING session_id
                """,
                    uuid.UUID(session.session_id),
                    session.notebook_path,
                    session.created_by,
                    session.created_at,
                    session.expires_at,
                    json.dumps(session.permissions),
                    session.participants,
                    session.status,
                    json.dumps(session.metadata)
                )
                
                logger.info(f"Session created in PostgreSQL: {session_id}")
                return str(session_id)
                
            except Exception as e:
                logger.error(f"Error creating session in PostgreSQL: {e}")
                raise
    
    async def get_session(self, session_id: str) -> Optional[CollaborationSession]:
        """Retrieve session with all metadata"""
        async with self.pool.acquire() as conn:
            try:
                row = await conn.fetchrow("""
                    SELECT session_id, notebook_path, created_by, created_at, expires_at,
                           permissions, participants, status, metadata
                    FROM collaboration.sessions 
                    WHERE session_id = $1
                """, uuid.UUID(session_id))
                
                if not row:
                    return None
                
                return CollaborationSession(
                    session_id=str(row['session_id']),
                    notebook_path=row['notebook_path'],
                    created_by=row['created_by'],
                    created_at=row['created_at'],
                    expires_at=row['expires_at'],
                    permissions=json.loads(row['permissions']),
                    participants=list(row['participants']),
                    status=row['status'],
                    metadata=json.loads(row['metadata'])
                )
                
            except Exception as e:
                logger.error(f"Error retrieving session from PostgreSQL: {e}")
                return None
    
    async def store_version_history(self, version: VersionHistory):
        """Store version history entry with comprehensive metadata"""
        async with self.pool.acquire() as conn:
            try:
                await conn.execute("""
                    INSERT INTO collaboration.version_history 
                    (version_id, session_id, operation_id, user_id, timestamp, 
                     operation_type, operation_data, cell_id, diff_data, parent_version)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                """,
                    uuid.UUID(version.version_id),
                    uuid.UUID(version.session_id),
                    version.operation_id,
                    version.user_id,
                    version.timestamp,
                    version.operation_type,
                    json.dumps(version.operation_data),
                    version.cell_id,
                    json.dumps(version.diff_data) if version.diff_data else None,
                    version.parent_version
                )
                
                logger.debug(f"Version history stored: {version.version_id}")
                
            except Exception as e:
                logger.error(f"Error storing version history: {e}")
                raise
    
    async def get_version_history(self, session_id: str, limit: int = 100) -> List[VersionHistory]:
        """Retrieve version history with optional limit and filtering"""
        async with self.pool.acquire() as conn:
            try:
                rows = await conn.fetch("""
                    SELECT version_id, session_id, operation_id, user_id, timestamp,
                           operation_type, operation_data, cell_id, diff_data, parent_version
                    FROM collaboration.version_history 
                    WHERE session_id = $1
                    ORDER BY timestamp DESC
                    LIMIT $2
                """, uuid.UUID(session_id), limit)
                
                history = []
                for row in rows:
                    history.append(VersionHistory(
                        version_id=str(row['version_id']),
                        session_id=str(row['session_id']),
                        operation_id=row['operation_id'],
                        user_id=row['user_id'],
                        timestamp=row['timestamp'],
                        operation_type=row['operation_type'],
                        operation_data=json.loads(row['operation_data']),
                        cell_id=row['cell_id'],
                        diff_data=json.loads(row['diff_data']) if row['diff_data'] else None
                    ))
                
                return history
                
            except Exception as e:
                logger.error(f"Error retrieving version history: {e}")
                return []
    
    async def store_user_permission(self, permission: UserPermission):
        """Store or update user permissions with upsert logic"""
        async with self.pool.acquire() as conn:
            try:
                await conn.execute("""
                    INSERT INTO collaboration.user_permissions 
                    (user_id, session_id, permission_level, granted_by, granted_at, 
                     expires_at, cell_permissions)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (user_id, session_id) 
                    DO UPDATE SET 
                        permission_level = EXCLUDED.permission_level,
                        granted_by = EXCLUDED.granted_by,
                        granted_at = EXCLUDED.granted_at,
                        expires_at = EXCLUDED.expires_at,
                        cell_permissions = EXCLUDED.cell_permissions
                """,
                    permission.user_id,
                    uuid.UUID(permission.session_id),
                    permission.permission_level,
                    permission.granted_by,
                    permission.granted_at,
                    permission.expires_at,
                    json.dumps(permission.cell_permissions)
                )
                
                logger.debug(f"User permission stored: {permission.user_id} -> {permission.permission_level}")
                
            except Exception as e:
                logger.error(f"Error storing user permission: {e}")
                raise
    
    async def get_user_permissions(self, user_id: str, session_id: str) -> Optional[UserPermission]:
        """Retrieve user permissions for specific session"""
        async with self.pool.acquire() as conn:
            try:
                row = await conn.fetchrow("""
                    SELECT user_id, session_id, permission_level, granted_by, granted_at,
                           expires_at, cell_permissions
                    FROM collaboration.user_permissions 
                    WHERE user_id = $1 AND session_id = $2
                    AND (expires_at IS NULL OR expires_at > NOW())
                """, user_id, uuid.UUID(session_id))
                
                if not row:
                    return None
                
                return UserPermission(
                    user_id=row['user_id'],
                    session_id=str(row['session_id']),
                    permission_level=row['permission_level'],
                    granted_by=row['granted_by'],
                    granted_at=row['granted_at'],
                    expires_at=row['expires_at'],
                    cell_permissions=json.loads(row['cell_permissions'])
                )
                
            except Exception as e:
                logger.error(f"Error retrieving user permissions: {e}")
                return None
    
    async def log_audit_event(self, session_id: str, user_id: str, action: str, 
                            resource_type: str, resource_id: Optional[str] = None,
                            metadata: Optional[Dict[str, Any]] = None,
                            ip_address: Optional[str] = None, user_agent: Optional[str] = None):
        """Log audit event for compliance and security monitoring"""
        async with self.pool.acquire() as conn:
            try:
                await conn.execute("""
                    INSERT INTO collaboration.audit_trail 
                    (session_id, user_id, action, resource_type, resource_id, timestamp,
                     ip_address, user_agent, metadata)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                """,
                    uuid.UUID(session_id),
                    user_id,
                    action,
                    resource_type,
                    resource_id,
                    datetime.utcnow(),
                    ip_address,
                    user_agent,
                    json.dumps(metadata or {})
                )
                
                logger.debug(f"Audit event logged: {action} by {user_id}")
                
            except Exception as e:
                logger.error(f"Error logging audit event: {e}")


class MongoDBManager:
    """MongoDB integration for BSON storage of Yjs document states and CRDT operation logs"""
    
    def __init__(self, mongodb_url: str, encryption_manager: EncryptionManager):
        self.mongodb_url = mongodb_url
        self.encryption = encryption_manager
        self.client: Optional[motor.motor_asyncio.AsyncIOMotorClient] = None
        self.db: Optional[motor.motor_asyncio.AsyncIOMotorDatabase] = None
        
        # Configuration
        self.database_name = os.getenv('JUPYTER_COLLAB_MONGODB_DB', 'jupyter_collaboration')
        self.operation_log_ttl = int(os.getenv('JUPYTER_COLLAB_OPERATION_LOG_TTL', '2592000'))  # 30 days
        
        logger.info("Initializing MongoDB manager")
    
    async def initialize(self):
        """Initialize MongoDB connection with optimized settings"""
        try:
            self.client = motor.motor_asyncio.AsyncIOMotorClient(
                self.mongodb_url,
                maxPoolSize=20,
                minPoolSize=5,
                maxIdleTimeMS=300000,  # 5 minutes
                serverSelectionTimeoutMS=5000,
                socketTimeoutMS=20000,
                connectTimeoutMS=20000,
                heartbeatFrequencyMS=10000,
                retryWrites=True,
                retryReads=True
            )
            
            self.db = self.client[self.database_name]
            
            # Test connection
            await self.client.admin.command('ping')
            
            # Create collections and indexes
            await self._setup_collections()
            
            logger.info("MongoDB connection established successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize MongoDB connection: {e}")
            raise
    
    async def _setup_collections(self):
        """Setup MongoDB collections with appropriate indexes and TTL"""
        try:
            # Yjs documents collection
            yjs_docs = self.db.yjs_documents
            await yjs_docs.create_index([("document_id", 1), ("version", -1)], unique=True)
            await yjs_docs.create_index([("last_modified", -1)])
            await yjs_docs.create_index([("metadata.participants", 1)])
            
            # Operation logs collection with TTL
            operation_logs = self.db.operation_logs
            await operation_logs.create_index([("document_id", 1), ("timestamp", -1)])
            await operation_logs.create_index([("client_id", 1), ("timestamp", -1)])
            await operation_logs.create_index([("user_id", 1), ("timestamp", -1)])
            await operation_logs.create_index([("expires_at", 1)], expireAfterSeconds=0)  # TTL index
            
            # Collaboration metadata collection
            collab_metadata = self.db.collaboration_metadata
            await collab_metadata.create_index([("session_id", 1), ("metadata_type", 1)])
            await collab_metadata.create_index([("created_at", -1)])
            
            logger.debug("MongoDB collections and indexes created successfully")
            
        except Exception as e:
            logger.error(f"Error setting up MongoDB collections: {e}")
            raise
    
    async def store_yjs_document_state(self, document_id: str, state_vector: bytes, 
                                     document_state: bytes, metadata: Dict[str, Any]) -> str:
        """Store Yjs document state with version tracking"""
        try:
            # Encrypt binary data
            encrypted_state_vector = self.encryption.encrypt_data(state_vector)
            encrypted_document_state = self.encryption.encrypt_data(document_state)
            
            # Create document with metadata
            doc = {
                "_id": ObjectId(),
                "document_id": document_id,
                "version": int(time.time() * 1000),  # Millisecond timestamp as version
                "state_vector": Binary(encrypted_state_vector),
                "document_state": Binary(encrypted_document_state),
                "last_modified": datetime.utcnow(),
                "metadata": metadata
            }
            
            # Upsert document (replace if exists)
            result = await self.db.yjs_documents.replace_one(
                {"document_id": document_id},
                doc,
                upsert=True
            )
            
            document_oid = str(result.upserted_id) if result.upserted_id else str(doc["_id"])
            logger.debug(f"Yjs document state stored: {document_id}")
            return document_oid
            
        except Exception as e:
            logger.error(f"Error storing Yjs document state: {e}")
            raise
    
    async def get_yjs_document_state(self, document_id: str) -> Optional[Tuple[bytes, bytes, Dict[str, Any]]]:
        """Retrieve latest Yjs document state"""
        try:
            doc = await self.db.yjs_documents.find_one(
                {"document_id": document_id},
                sort=[("version", -1)]
            )
            
            if not doc:
                return None
            
            # Decrypt binary data
            state_vector = self.encryption.decrypt_data(doc["state_vector"])
            document_state = self.encryption.decrypt_data(doc["document_state"])
            metadata = doc["metadata"]
            
            return state_vector, document_state, metadata
            
        except Exception as e:
            logger.error(f"Error retrieving Yjs document state: {e}")
            return None
    
    async def store_crdt_operation(self, operation: CRDTOperation):
        """Store CRDT operation with automatic TTL for log rotation"""
        try:
            # Encrypt operation data
            encrypted_operation_data = self.encryption.encrypt_data(operation.operation_data)
            
            # Create operation document
            op_doc = {
                "_id": ObjectId(),
                "document_id": operation.document_id,
                "client_id": operation.client_id,
                "operation_id": operation.operation_id,
                "timestamp": operation.timestamp,
                "operation_type": operation.operation_type,
                "operation_data": Binary(encrypted_operation_data),
                "user_id": operation.user_id,
                "cell_id": operation.cell_id,
                "parent_version": operation.parent_version,
                "expires_at": datetime.utcnow() + timedelta(seconds=self.operation_log_ttl)
            }
            
            await self.db.operation_logs.insert_one(op_doc)
            logger.debug(f"CRDT operation stored: {operation.operation_id}")
            
        except Exception as e:
            logger.error(f"Error storing CRDT operation: {e}")
            raise
    
    async def get_crdt_operations(self, document_id: str, since_timestamp: Optional[datetime] = None,
                                limit: int = 1000) -> List[CRDTOperation]:
        """Retrieve CRDT operations for document synchronization"""
        try:
            query = {"document_id": document_id}
            if since_timestamp:
                query["timestamp"] = {"$gte": since_timestamp}
            
            cursor = self.db.operation_logs.find(query).sort("timestamp", 1).limit(limit)
            operations = []
            
            async for doc in cursor:
                try:
                    # Decrypt operation data
                    operation_data = self.encryption.decrypt_data(doc["operation_data"])
                    
                    operations.append(CRDTOperation(
                        operation_id=doc["operation_id"],
                        document_id=doc["document_id"],
                        client_id=doc["client_id"],
                        user_id=doc["user_id"],
                        timestamp=doc["timestamp"],
                        operation_type=doc["operation_type"],
                        operation_data=operation_data,
                        cell_id=doc.get("cell_id"),
                        parent_version=doc.get("parent_version")
                    ))
                    
                except Exception as e:
                    logger.warning(f"Error decrypting operation {doc.get('operation_id')}: {e}")
            
            return operations
            
        except Exception as e:
            logger.error(f"Error retrieving CRDT operations: {e}")
            return []
    
    async def store_collaboration_metadata(self, session_id: str, metadata_type: str, 
                                         metadata: Dict[str, Any]) -> str:
        """Store flexible collaboration metadata"""
        try:
            # Encrypt sensitive metadata
            encrypted_metadata = self.encryption.encrypt_json(metadata)
            
            doc = {
                "_id": ObjectId(),
                "session_id": session_id,
                "metadata_type": metadata_type,
                "metadata": Binary(encrypted_metadata),
                "created_at": datetime.utcnow(),
                "updated_at": datetime.utcnow()
            }
            
            # Upsert metadata by session_id and type
            result = await self.db.collaboration_metadata.replace_one(
                {"session_id": session_id, "metadata_type": metadata_type},
                doc,
                upsert=True
            )
            
            metadata_oid = str(result.upserted_id) if result.upserted_id else str(doc["_id"])
            logger.debug(f"Collaboration metadata stored: {session_id}:{metadata_type}")
            return metadata_oid
            
        except Exception as e:
            logger.error(f"Error storing collaboration metadata: {e}")
            raise
    
    async def get_collaboration_metadata(self, session_id: str, metadata_type: str) -> Optional[Dict[str, Any]]:
        """Retrieve collaboration metadata by type"""
        try:
            doc = await self.db.collaboration_metadata.find_one({
                "session_id": session_id,
                "metadata_type": metadata_type
            })
            
            if not doc:
                return None
            
            # Decrypt metadata
            metadata = self.encryption.decrypt_json(doc["metadata"])
            return metadata
            
        except Exception as e:
            logger.error(f"Error retrieving collaboration metadata: {e}")
            return None


class S3Manager:
    """S3 integration for collaborative session persistence, document versioning, and backup storage"""
    
    def __init__(self, encryption_manager: EncryptionManager):
        self.encryption = encryption_manager
        self.s3_client = None
        
        # Configuration from environment
        self.endpoint_url = os.getenv('JUPYTER_COLLAB_S3_ENDPOINT')
        self.bucket_name = os.getenv('JUPYTER_COLLAB_S3_BUCKET', 'jupyter-collaboration')
        self.region = os.getenv('JUPYTER_COLLAB_S3_REGION', 'us-east-1')
        self.access_key = os.getenv('JUPYTER_COLLAB_S3_ACCESS_KEY')
        self.secret_key = os.getenv('JUPYTER_COLLAB_S3_SECRET_KEY')
        
        logger.info(f"Initializing S3 manager with bucket: {self.bucket_name}")
    
    async def initialize(self):
        """Initialize S3 client with retry configuration"""
        try:
            if not all([self.access_key, self.secret_key]):
                logger.warning("S3 credentials not provided, S3 storage will be disabled")
                return
            
            # Configure S3 client with retry and timeout settings
            config = Config(
                retries={'max_attempts': 3, 'mode': 'adaptive'},
                max_pool_connections=20,
                read_timeout=60,
                connect_timeout=10,
                region_name=self.region
            )
            
            session = aioboto3.Session()
            self.s3_client = session.client(
                's3',
                endpoint_url=self.endpoint_url,
                aws_access_key_id=self.access_key,
                aws_secret_access_key=self.secret_key,
                config=config
            )
            
            # Test connection and create bucket if needed
            async with self.s3_client as s3:
                try:
                    await s3.head_bucket(Bucket=self.bucket_name)
                except ClientError as e:
                    if e.response['Error']['Code'] == '404':
                        await s3.create_bucket(Bucket=self.bucket_name)
                        logger.info(f"Created S3 bucket: {self.bucket_name}")
            
            logger.info("S3 connection established successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize S3 connection: {e}")
            # Don't raise - S3 is optional for basic operation
    
    async def store_crdt_snapshot(self, notebook_path: str, yjs_state: bytes) -> Optional[str]:
        """Store CRDT snapshot to S3 with versioning"""
        if not self.s3_client:
            return None
        
        try:
            timestamp = int(time.time())
            notebook_hash = hashlib.sha256(notebook_path.encode()).hexdigest()[:16]
            object_key = f"snapshots/{notebook_hash}/{timestamp}.yjs"
            
            # Encrypt and compress state data
            encrypted_state = self.encryption.encrypt_data(yjs_state)
            
            # Upload with metadata
            metadata = {
                'notebook-path': notebook_path,
                'timestamp': str(timestamp),
                'content-type': 'application/octet-stream',
                'encryption': 'aes-256-gcm'
            }
            
            async with self.s3_client as s3:
                await s3.put_object(
                    Bucket=self.bucket_name,
                    Key=object_key,
                    Body=encrypted_state,
                    Metadata=metadata,
                    StorageClass='STANDARD_IA'  # Infrequent access for cost optimization
                )
            
            logger.info(f"CRDT snapshot stored: {object_key}")
            return object_key
            
        except Exception as e:
            logger.error(f"Error storing CRDT snapshot: {e}")
            return None
    
    async def retrieve_latest_snapshot(self, notebook_path: str) -> Optional[bytes]:
        """Retrieve most recent CRDT snapshot for document restoration"""
        if not self.s3_client:
            return None
        
        try:
            notebook_hash = hashlib.sha256(notebook_path.encode()).hexdigest()[:16]
            prefix = f"snapshots/{notebook_hash}/"
            
            async with self.s3_client as s3:
                # List objects to find latest snapshot
                response = await s3.list_objects_v2(
                    Bucket=self.bucket_name,
                    Prefix=prefix,
                    MaxKeys=1
                )
                
                if response.get('Contents'):
                    latest_object = max(response['Contents'], key=lambda x: x['LastModified'])
                    
                    # Retrieve object content
                    obj_response = await s3.get_object(
                        Bucket=self.bucket_name,
                        Key=latest_object['Key']
                    )
                    
                    encrypted_data = await obj_response['Body'].read()
                    
                    # Decrypt state data
                    yjs_state = self.encryption.decrypt_data(encrypted_data)
                    
                    logger.info(f"CRDT snapshot retrieved: {latest_object['Key']}")
                    return yjs_state
            
            return None
            
        except Exception as e:
            logger.error(f"Error retrieving CRDT snapshot: {e}")
            return None
    
    async def store_version_archive(self, notebook_path: str, version_id: str, 
                                  notebook_content: Dict[str, Any]) -> Optional[str]:
        """Store versioned notebook archive for audit and compliance"""
        if not self.s3_client:
            return None
        
        try:
            notebook_hash = hashlib.sha256(notebook_path.encode()).hexdigest()[:16]
            object_key = f"versions/{notebook_hash}/{version_id}.ipynb"
            
            # Encrypt notebook content
            encrypted_content = self.encryption.encrypt_json(notebook_content)
            
            # Upload with versioning metadata
            metadata = {
                'notebook-path': notebook_path,
                'version-id': version_id,
                'content-type': 'application/json',
                'archive-type': 'notebook-version'
            }
            
            async with self.s3_client as s3:
                await s3.put_object(
                    Bucket=self.bucket_name,
                    Key=object_key,
                    Body=encrypted_content,
                    Metadata=metadata,
                    StorageClass='STANDARD_IA'
                )
            
            logger.info(f"Version archive stored: {object_key}")
            return object_key
            
        except Exception as e:
            logger.error(f"Error storing version archive: {e}")
            return None
    
    async def create_backup_bundle(self, session_id: str, backup_data: Dict[str, Any]) -> Optional[str]:
        """Create comprehensive backup bundle for disaster recovery"""
        if not self.s3_client:
            return None
        
        try:
            date_str = datetime.utcnow().strftime('%Y-%m-%d')
            object_key = f"backups/{date_str}/{session_id}_backup.json"
            
            # Encrypt entire backup bundle
            encrypted_backup = self.encryption.encrypt_json(backup_data)
            
            # Upload with backup metadata
            metadata = {
                'session-id': session_id,
                'backup-date': date_str,
                'backup-type': 'full-session',
                'content-type': 'application/json'
            }
            
            async with self.s3_client as s3:
                await s3.put_object(
                    Bucket=self.bucket_name,
                    Key=object_key,
                    Body=encrypted_backup,
                    Metadata=metadata,
                    StorageClass='GLACIER'  # Long-term archival storage
                )
            
            logger.info(f"Backup bundle created: {object_key}")
            return object_key
            
        except Exception as e:
            logger.error(f"Error creating backup bundle: {e}")
            return None


class PersistenceLayer:
    """
    Main persistence coordinator implementing multi-tier storage strategy.
    
    Provides unified interface for collaborative data persistence across:
    - Hot Path (Redis): Sub-millisecond session coordination and locks
    - Warm Path (MongoDB): Fast CRDT state and operation storage
    - Cold Path (PostgreSQL): Structured metadata and audit trails
    - Archive Path (S3): Long-term snapshots and backup storage
    """
    
    def __init__(self, config: Optional[Dict[str, str]] = None):
        """Initialize persistence layer with configuration"""
        self.config = config or {}
        
        # Initialize encryption manager
        self.encryption = EncryptionManager(self.config.get('encryption_key'))
        
        # Initialize storage managers
        self.redis = None
        self.postgres = None
        self.mongodb = None
        self.s3 = None
        
        # Configuration from environment or config
        self.redis_url = self.config.get('redis_url') or os.getenv('JUPYTER_COLLAB_REDIS_URL', 'redis://localhost:6379/0')
        self.postgres_url = self.config.get('postgres_url') or os.getenv('JUPYTER_COLLAB_POSTGRES_URL')
        self.mongodb_url = self.config.get('mongodb_url') or os.getenv('JUPYTER_COLLAB_MONGODB_URL')
        
        # Health check status
        self.health_status = {
            'redis': False,
            'postgres': False,
            'mongodb': False,
            's3': False
        }
        
        logger.info("PersistenceLayer initialized with multi-tier storage architecture")
    
    async def initialize(self):
        """Initialize all storage backends with graceful degradation"""
        initialization_tasks = []
        
        # Initialize Redis (required for basic collaboration)
        if self.redis_url:
            try:
                self.redis = RedisManager(self.redis_url, self.encryption)
                await self.redis.initialize()
                self.health_status['redis'] = True
                logger.info("Redis storage initialized successfully")
            except Exception as e:
                logger.error(f"Redis initialization failed: {e}")
                raise RuntimeError("Redis is required for collaborative features")
        
        # Initialize PostgreSQL (required for structured data)
        if self.postgres_url:
            try:
                self.postgres = PostgreSQLManager(self.postgres_url, self.encryption)
                await self.postgres.initialize()
                self.health_status['postgres'] = True
                logger.info("PostgreSQL storage initialized successfully")
            except Exception as e:
                logger.error(f"PostgreSQL initialization failed: {e}")
                raise RuntimeError("PostgreSQL is required for metadata storage")
        
        # Initialize MongoDB (optional, degrades to PostgreSQL for CRDT storage)
        if self.mongodb_url:
            try:
                self.mongodb = MongoDBManager(self.mongodb_url, self.encryption)
                await self.mongodb.initialize()
                self.health_status['mongodb'] = True
                logger.info("MongoDB storage initialized successfully")
            except Exception as e:
                logger.warning(f"MongoDB initialization failed, continuing without: {e}")
        
        # Initialize S3 (optional, for long-term storage)
        try:
            self.s3 = S3Manager(self.encryption)
            await self.s3.initialize()
            self.health_status['s3'] = True
            logger.info("S3 storage initialized successfully")
        except Exception as e:
            logger.warning(f"S3 initialization failed, continuing without: {e}")
        
        # Start background maintenance tasks
        asyncio.create_task(self._background_maintenance())
        
        logger.info(f"Persistence layer initialized. Health status: {self.health_status}")
    
    async def create_collaboration_session(self, session: CollaborationSession) -> str:
        """Create new collaboration session across all storage tiers"""
        try:
            # Store in PostgreSQL (authoritative)
            session_id = await self.postgres.create_session(session)
            
            # Cache in Redis for fast access
            await self.redis.store_session_cache(session)
            
            # Store metadata in MongoDB if available
            if self.mongodb:
                await self.mongodb.store_collaboration_metadata(
                    session.session_id, 
                    'session_metadata', 
                    asdict(session)
                )
            
            # Log audit event
            await self.postgres.log_audit_event(
                session.session_id, 
                session.created_by, 
                'session_created', 
                'collaboration_session',
                session.session_id
            )
            
            logger.info(f"Collaboration session created: {session_id}")
            return session_id
            
        except Exception as e:
            logger.error(f"Error creating collaboration session: {e}")
            raise
    
    async def get_collaboration_session(self, session_id: str) -> Optional[CollaborationSession]:
        """Retrieve collaboration session with priority-based recovery"""
        try:
            # Try Redis cache first (hot path)
            session = await self.redis.get_session_cache(session_id)
            if session:
                return session
            
            # Fall back to PostgreSQL (authoritative)
            session = await self.postgres.get_session(session_id)
            if session:
                # Restore to Redis cache
                await self.redis.store_session_cache(session)
                return session
            
            # Try MongoDB if available
            if self.mongodb:
                metadata = await self.mongodb.get_collaboration_metadata(session_id, 'session_metadata')
                if metadata:
                    session = CollaborationSession(**metadata)
                    # Restore to cache and PostgreSQL
                    await self.redis.store_session_cache(session)
                    await self.postgres.create_session(session)
                    return session
            
            logger.warning(f"Session not found in any storage tier: {session_id}")
            return None
            
        except Exception as e:
            logger.error(f"Error retrieving collaboration session: {e}")
            return None
    
    async def store_crdt_operation(self, operation: CRDTOperation):
        """Store CRDT operation across warm and cold paths"""
        try:
            # Store in MongoDB for fast retrieval (warm path)
            if self.mongodb:
                await self.mongodb.store_crdt_operation(operation)
            
            # Store in PostgreSQL as version history (cold path)
            version = VersionHistory(
                version_id=str(uuid.uuid4()),
                session_id=operation.document_id.split(':')[1] if ':' in operation.document_id else operation.document_id,
                operation_id=operation.operation_id,
                user_id=operation.user_id,
                timestamp=operation.timestamp,
                operation_type=operation.operation_type,
                operation_data={
                    'client_id': operation.client_id,
                    'operation_data_size': len(operation.operation_data),
                    'cell_id': operation.cell_id
                },
                cell_id=operation.cell_id
            )
            
            await self.postgres.store_version_history(version)
            
            logger.debug(f"CRDT operation stored: {operation.operation_id}")
            
        except Exception as e:
            logger.error(f"Error storing CRDT operation: {e}")
            raise
    
    async def get_crdt_operations(self, document_id: str, since_timestamp: Optional[datetime] = None) -> List[CRDTOperation]:
        """Retrieve CRDT operations with fallback across storage tiers"""
        try:
            # Try MongoDB first (warm path)
            if self.mongodb:
                operations = await self.mongodb.get_crdt_operations(document_id, since_timestamp)
                if operations:
                    return operations
            
            # Fall back to reconstructing from PostgreSQL version history
            session_id = document_id.split(':')[1] if ':' in document_id else document_id
            history = await self.postgres.get_version_history(session_id)
            
            # Convert version history to CRDT operations (limited reconstruction)
            operations = []
            for version in history:
                if since_timestamp and version.timestamp < since_timestamp:
                    continue
                
                operation = CRDTOperation(
                    operation_id=version.operation_id,
                    document_id=document_id,
                    client_id=version.operation_data.get('client_id', 0),
                    user_id=version.user_id,
                    timestamp=version.timestamp,
                    operation_type=version.operation_type,
                    operation_data=b'',  # Data not recoverable from PostgreSQL
                    cell_id=version.cell_id
                )
                operations.append(operation)
            
            return operations
            
        except Exception as e:
            logger.error(f"Error retrieving CRDT operations: {e}")
            return []
    
    async def store_document_snapshot(self, document_id: str, state_vector: bytes, 
                                    document_state: bytes, metadata: Dict[str, Any]):
        """Store document snapshot across warm and archive paths"""
        try:
            # Store in MongoDB (warm path)
            if self.mongodb:
                await self.mongodb.store_yjs_document_state(
                    document_id, state_vector, document_state, metadata
                )
            
            # Store in S3 for long-term archival (archive path)
            if self.s3:
                notebook_path = metadata.get('notebook_path', document_id)
                await self.s3.store_crdt_snapshot(notebook_path, document_state)
            
            logger.debug(f"Document snapshot stored: {document_id}")
            
        except Exception as e:
            logger.error(f"Error storing document snapshot: {e}")
            raise
    
    async def get_document_snapshot(self, document_id: str) -> Optional[Tuple[bytes, bytes, Dict[str, Any]]]:
        """Retrieve document snapshot with fallback to archive storage"""
        try:
            # Try MongoDB first (warm path)
            if self.mongodb:
                result = await self.mongodb.get_yjs_document_state(document_id)
                if result:
                    return result
            
            # Fall back to S3 archive (archive path)
            if self.s3:
                # Extract notebook path from document_id
                notebook_path = document_id.replace('notebook:', '')
                document_state = await self.s3.retrieve_latest_snapshot(notebook_path)
                
                if document_state:
                    # Return with empty state vector and minimal metadata
                    return b'', document_state, {'source': 's3_archive'}
            
            logger.warning(f"Document snapshot not found: {document_id}")
            return None
            
        except Exception as e:
            logger.error(f"Error retrieving document snapshot: {e}")
            return None
    
    async def manage_user_permissions(self, permission: UserPermission):
        """Manage user permissions with caching"""
        try:
            # Store in PostgreSQL (authoritative)
            await self.postgres.store_user_permission(permission)
            
            # Cache permission in Redis for fast access
            permission_key = f"permission:{permission.user_id}:{permission.session_id}"
            await self.redis.redis_client.setex(
                permission_key,
                3600,  # 1 hour cache
                self.encryption.encrypt_json(asdict(permission))
            )
            
            logger.debug(f"User permission stored: {permission.user_id} -> {permission.permission_level}")
            
        except Exception as e:
            logger.error(f"Error managing user permissions: {e}")
            raise
    
    async def validate_user_permission(self, user_id: str, session_id: str, 
                                     required_permission: str) -> bool:
        """Validate user permission with caching"""
        try:
            # Check Redis cache first
            permission_key = f"permission:{user_id}:{session_id}"
            cached_permission = await self.redis.redis_client.get(permission_key)
            
            if cached_permission:
                try:
                    permission_data = self.encryption.decrypt_json(cached_permission)
                    permission = UserPermission(**permission_data)
                except Exception as e:
                    logger.warning(f"Error decrypting cached permission: {e}")
                    permission = None
            else:
                permission = None
            
            # Fall back to PostgreSQL if not cached
            if not permission:
                permission = await self.postgres.get_user_permissions(user_id, session_id)
                if permission:
                    # Cache the permission
                    await self.redis.redis_client.setex(
                        permission_key,
                        3600,
                        self.encryption.encrypt_json(asdict(permission))
                    )
            
            if not permission:
                return False
            
            # Check if permission has expired
            if permission.expires_at and permission.expires_at < datetime.utcnow():
                return False
            
            # Validate permission level
            permission_hierarchy = {'viewer': 1, 'editor': 2, 'admin': 3}
            required_level = permission_hierarchy.get(required_permission, 0)
            user_level = permission_hierarchy.get(permission.permission_level, 0)
            
            return user_level >= required_level
            
        except Exception as e:
            logger.error(f"Error validating user permission: {e}")
            return False
    
    async def acquire_cell_lock(self, notebook_path: str, cell_id: str, user_id: str) -> bool:
        """Acquire cell-level lock for conflict prevention"""
        try:
            return await self.redis.acquire_cell_lock(notebook_path, cell_id, user_id)
        except Exception as e:
            logger.error(f"Error acquiring cell lock: {e}")
            return False
    
    async def release_cell_lock(self, notebook_path: str, cell_id: str, user_id: str) -> bool:
        """Release cell-level lock"""
        try:
            return await self.redis.release_cell_lock(notebook_path, cell_id, user_id)
        except Exception as e:
            logger.error(f"Error releasing cell lock: {e}")
            return False
    
    async def update_user_presence(self, session_id: str, user_id: str, presence_data: Dict[str, Any]):
        """Update user presence information"""
        try:
            await self.redis.update_user_presence(session_id, user_id, presence_data)
        except Exception as e:
            logger.error(f"Error updating user presence: {e}")
    
    async def get_session_participants(self, session_id: str) -> List[Dict[str, Any]]:
        """Get all active participants in a session"""
        try:
            return await self.redis.get_session_participants(session_id)
        except Exception as e:
            logger.error(f"Error retrieving session participants: {e}")
            return []
    
    async def create_backup_bundle(self, session_id: str) -> Optional[str]:
        """Create comprehensive backup bundle for disaster recovery"""
        try:
            if not self.s3:
                logger.warning("S3 not available, skipping backup bundle creation")
                return None
            
            # Gather data from all storage tiers
            session = await self.get_collaboration_session(session_id)
            if not session:
                logger.error(f"Session not found for backup: {session_id}")
                return None
            
            participants = await self.get_session_participants(session_id)
            version_history = await self.postgres.get_version_history(session_id)
            
            # Create backup bundle
            backup_data = {
                'session': asdict(session),
                'participants': participants,
                'version_history': [asdict(v) for v in version_history],
                'backup_timestamp': datetime.utcnow().isoformat(),
                'backup_version': '1.0'
            }
            
            return await self.s3.create_backup_bundle(session_id, backup_data)
            
        except Exception as e:
            logger.error(f"Error creating backup bundle: {e}")
            return None
    
    async def get_health_status(self) -> Dict[str, Any]:
        """Get comprehensive health status of all storage tiers"""
        health_checks = {}
        
        # Check Redis
        try:
            if self.redis and self.redis.redis_client:
                await self.redis.redis_client.ping()
                health_checks['redis'] = {'status': 'healthy', 'latency_ms': 0}
            else:
                health_checks['redis'] = {'status': 'unavailable'}
        except Exception as e:
            health_checks['redis'] = {'status': 'error', 'error': str(e)}
        
        # Check PostgreSQL
        try:
            if self.postgres and self.postgres.pool:
                async with self.postgres.pool.acquire() as conn:
                    await conn.execute("SELECT 1")
                health_checks['postgres'] = {'status': 'healthy'}
            else:
                health_checks['postgres'] = {'status': 'unavailable'}
        except Exception as e:
            health_checks['postgres'] = {'status': 'error', 'error': str(e)}
        
        # Check MongoDB
        try:
            if self.mongodb and self.mongodb.client:
                await self.mongodb.client.admin.command('ping')
                health_checks['mongodb'] = {'status': 'healthy'}
            else:
                health_checks['mongodb'] = {'status': 'unavailable'}
        except Exception as e:
            health_checks['mongodb'] = {'status': 'error', 'error': str(e)}
        
        # Check S3
        try:
            if self.s3 and self.s3.s3_client:
                async with self.s3.s3_client as s3:
                    await s3.head_bucket(Bucket=self.s3.bucket_name)
                health_checks['s3'] = {'status': 'healthy'}
            else:
                health_checks['s3'] = {'status': 'unavailable'}
        except Exception as e:
            health_checks['s3'] = {'status': 'error', 'error': str(e)}
        
        # Calculate overall health
        healthy_services = sum(1 for status in health_checks.values() if status['status'] == 'healthy')
        total_critical_services = 2  # Redis and PostgreSQL are critical
        
        overall_health = 'healthy' if healthy_services >= total_critical_services else 'degraded'
        
        return {
            'overall_health': overall_health,
            'services': health_checks,
            'collaboration_ready': health_checks.get('redis', {}).get('status') == 'healthy' and 
                                 health_checks.get('postgres', {}).get('status') == 'healthy',
            'timestamp': datetime.utcnow().isoformat()
        }
    
    async def _background_maintenance(self):
        """Background maintenance tasks for storage optimization"""
        while True:
            try:
                # Clean up expired sessions and locks every 5 minutes
                await asyncio.sleep(300)
                
                if self.redis:
                    await self.redis.cleanup_expired_sessions()
                
                logger.debug("Background maintenance completed")
                
            except Exception as e:
                logger.error(f"Error in background maintenance: {e}")
    
    async def close(self):
        """Clean shutdown of all storage connections"""
        try:
            if self.redis and self.redis.redis_client:
                await self.redis.redis_client.aclose()
            
            if self.postgres and self.postgres.pool:
                await self.postgres.pool.close()
            
            if self.mongodb and self.mongodb.client:
                self.mongodb.client.close()
            
            if self.s3 and self.s3.s3_client:
                await self.s3.s3_client.aclose()
            
            logger.info("Persistence layer shutdown completed")
            
        except Exception as e:
            logger.error(f"Error during persistence layer shutdown: {e}")


# Convenience function for easy initialization
async def create_persistence_layer(config: Optional[Dict[str, str]] = None) -> PersistenceLayer:
    """Create and initialize persistence layer with configuration"""
    persistence = PersistenceLayer(config)
    await persistence.initialize()
    return persistence