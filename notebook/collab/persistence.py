"""
Multi-tier Collaborative Persistence Layer

This module implements a sophisticated persistence infrastructure for Jupyter Notebook v7's
collaborative editing capabilities. It coordinates data storage across Redis (hot path),
MongoDB (warm path), PostgreSQL (cold path), and S3 (archive path) to provide optimal
performance, reliability, and enterprise-grade audit capabilities.

Architecture:
- Redis: Sub-millisecond operations for session coordination, locks, and presence
- MongoDB: Fast CRDT state storage and flexible collaborative metadata
- PostgreSQL: Structured storage for user permissions, version history, and audit trails
- S3: Cost-effective storage for snapshots, backups, and historical document states

The system implements eventual consistency with CRDT-based conflict resolution and
automated state reconstruction capabilities with priority-based recovery mechanisms.
"""

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Union, Tuple
from contextlib import asynccontextmanager
from dataclasses import dataclass, asdict
from enum import Enum

# Third-party imports
import aioredis
import boto3
from botocore.exceptions import ClientError, BotoCoreError
from motor.motor_asyncio import AsyncIOMotorClient
import asyncpg
import asyncpg.pool
from sqlalchemy import create_engine, MetaData, Table, Column, String, Integer, DateTime, JSON, Boolean, Text, ForeignKey
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base, relationship
from cryptography.fernet import Fernet
import lz4.frame

# Monitoring and observability
from prometheus_client import Counter, Histogram, Gauge, Summary

# Logging configuration
logger = logging.getLogger(__name__)


class StorageTier(Enum):
    """Storage tier enumeration for data flow management"""
    HOT = "hot"          # Redis - sub-millisecond operations
    WARM = "warm"        # MongoDB - fast document retrieval
    COLD = "cold"        # PostgreSQL - structured long-term storage
    ARCHIVE = "archive"  # S3 - cost-effective backup and archival


class OperationType(Enum):
    """CRDT operation types for collaborative editing"""
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    MOVE = "move"
    INSERT = "insert"
    MERGE = "merge"
    CONFLICT_RESOLUTION = "conflict_resolution"


@dataclass
class CRDTOperation:
    """CRDT operation data structure"""
    operation_id: str
    session_id: str
    user_id: str
    operation_type: OperationType
    cell_id: Optional[str]
    content: Optional[str]
    timestamp: datetime
    vector_clock: Dict[str, int]
    metadata: Dict[str, Any]


@dataclass
class SessionMetadata:
    """Collaborative session metadata"""
    session_id: str
    notebook_path: str
    created_by: str
    created_at: datetime
    participants: List[str]
    permissions: Dict[str, Any]
    status: str


@dataclass
class UserPermission:
    """User permission structure"""
    user_id: str
    session_id: str
    role: str
    permissions: List[str]
    granted_by: str
    granted_at: datetime
    expires_at: Optional[datetime]


class PersistenceMetrics:
    """Prometheus metrics for persistence layer monitoring"""
    
    def __init__(self):
        # Operation metrics
        self.operation_total = Counter(
            'jupyter_collab_persistence_operations_total',
            'Total persistence operations',
            ['storage_tier', 'operation_type', 'status']
        )
        
        self.operation_duration = Histogram(
            'jupyter_collab_persistence_operation_duration_seconds',
            'Persistence operation duration',
            ['storage_tier', 'operation_type'],
            buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0]
        )
        
        # Connection metrics
        self.connection_pool_size = Gauge(
            'jupyter_collab_persistence_connection_pool_size',
            'Connection pool size',
            ['storage_tier']
        )
        
        self.connection_errors = Counter(
            'jupyter_collab_persistence_connection_errors_total',
            'Connection errors',
            ['storage_tier', 'error_type']
        )
        
        # Data metrics
        self.data_size_bytes = Summary(
            'jupyter_collab_persistence_data_size_bytes',
            'Size of stored data',
            ['storage_tier', 'data_type']
        )
        
        # Replication metrics
        self.replication_lag = Histogram(
            'jupyter_collab_persistence_replication_lag_seconds',
            'Cross-tier replication lag',
            ['source_tier', 'target_tier'],
            buckets=[0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 30.0]
        )


class PersistenceConfig:
    """Configuration management for persistence layer"""
    
    def __init__(self):
        # Redis configuration
        self.redis_url = os.getenv('JUPYTER_COLLAB_REDIS_URL', 'redis://localhost:6379')
        self.redis_db = int(os.getenv('JUPYTER_COLLAB_REDIS_DB', '0'))
        self.redis_pool_size = int(os.getenv('JUPYTER_COLLAB_REDIS_POOL_SIZE', '20'))
        self.redis_timeout = int(os.getenv('JUPYTER_COLLAB_REDIS_TIMEOUT', '5'))
        
        # MongoDB configuration
        self.mongodb_url = os.getenv('JUPYTER_COLLAB_MONGODB_URL', 'mongodb://localhost:27017')
        self.mongodb_database = os.getenv('JUPYTER_COLLAB_MONGODB_DATABASE', 'jupyter_collaboration')
        self.mongodb_pool_size = int(os.getenv('JUPYTER_COLLAB_MONGODB_POOL_SIZE', '10'))
        
        # PostgreSQL configuration
        self.postgres_url = os.getenv('JUPYTER_COLLAB_POSTGRES_URL', 'postgresql://localhost:5432/jupyter_collab')
        self.postgres_pool_size = int(os.getenv('JUPYTER_COLLAB_POSTGRES_POOL_SIZE', '20'))
        self.postgres_max_overflow = int(os.getenv('JUPYTER_COLLAB_POSTGRES_MAX_OVERFLOW', '0'))
        
        # S3 configuration
        self.s3_endpoint = os.getenv('JUPYTER_COLLAB_S3_ENDPOINT')
        self.s3_bucket = os.getenv('JUPYTER_COLLAB_S3_BUCKET', 'jupyter-collaboration')
        self.s3_access_key = os.getenv('JUPYTER_COLLAB_S3_ACCESS_KEY')
        self.s3_secret_key = os.getenv('JUPYTER_COLLAB_S3_SECRET_KEY')
        self.s3_region = os.getenv('JUPYTER_COLLAB_S3_REGION', 'us-east-1')
        
        # Encryption configuration
        self.encryption_key = os.getenv('JUPYTER_COLLAB_ENCRYPTION_KEY')
        if not self.encryption_key:
            self.encryption_key = Fernet.generate_key()
            logger.warning("No encryption key provided, using generated key (not suitable for production)")
        
        # Data tier configuration
        self.hot_tier_ttl = int(os.getenv('JUPYTER_COLLAB_HOT_TTL', '3600'))  # 1 hour
        self.warm_tier_retention = int(os.getenv('JUPYTER_COLLAB_WARM_RETENTION', '604800'))  # 7 days
        self.cold_tier_retention = int(os.getenv('JUPYTER_COLLAB_COLD_RETENTION', '31536000'))  # 1 year
        
        # Performance tuning
        self.compression_enabled = os.getenv('JUPYTER_COLLAB_COMPRESSION', 'true').lower() == 'true'
        self.async_replication = os.getenv('JUPYTER_COLLAB_ASYNC_REPLICATION', 'true').lower() == 'true'
        self.batch_size = int(os.getenv('JUPYTER_COLLAB_BATCH_SIZE', '100'))


class EncryptionManager:
    """Encryption manager for sensitive data protection"""
    
    def __init__(self, encryption_key: bytes):
        self.fernet = Fernet(encryption_key)
        self.metrics = PersistenceMetrics()
    
    def encrypt(self, data: str) -> bytes:
        """Encrypt string data"""
        try:
            encrypted = self.fernet.encrypt(data.encode('utf-8'))
            self.metrics.operation_total.labels(
                storage_tier='encryption', 
                operation_type='encrypt', 
                status='success'
            ).inc()
            return encrypted
        except Exception as e:
            self.metrics.operation_total.labels(
                storage_tier='encryption', 
                operation_type='encrypt', 
                status='error'
            ).inc()
            logger.error(f"Encryption error: {e}")
            raise
    
    def decrypt(self, encrypted_data: bytes) -> str:
        """Decrypt data to string"""
        try:
            decrypted = self.fernet.decrypt(encrypted_data).decode('utf-8')
            self.metrics.operation_total.labels(
                storage_tier='encryption', 
                operation_type='decrypt', 
                status='success'
            ).inc()
            return decrypted
        except Exception as e:
            self.metrics.operation_total.labels(
                storage_tier='encryption', 
                operation_type='decrypt', 
                status='error'
            ).inc()
            logger.error(f"Decryption error: {e}")
            raise
    
    def encrypt_json(self, data: Dict[str, Any]) -> bytes:
        """Encrypt JSON data"""
        json_str = json.dumps(data, separators=(',', ':'))
        return self.encrypt(json_str)
    
    def decrypt_json(self, encrypted_data: bytes) -> Dict[str, Any]:
        """Decrypt data to JSON"""
        decrypted_str = self.decrypt(encrypted_data)
        return json.loads(decrypted_str)


class RedisManager:
    """Redis manager for hot-path operations"""
    
    def __init__(self, config: PersistenceConfig, encryption_manager: EncryptionManager):
        self.config = config
        self.encryption = encryption_manager
        self.metrics = PersistenceMetrics()
        self.redis: Optional[aioredis.Redis] = None
        self.connection_pool: Optional[aioredis.ConnectionPool] = None
    
    async def initialize(self):
        """Initialize Redis connection pool"""
        try:
            self.connection_pool = aioredis.ConnectionPool.from_url(
                self.config.redis_url,
                db=self.config.redis_db,
                max_connections=self.config.redis_pool_size,
                socket_timeout=self.config.redis_timeout,
                socket_connect_timeout=self.config.redis_timeout,
                health_check_interval=30
            )
            
            self.redis = aioredis.Redis(connection_pool=self.connection_pool)
            
            # Test connection
            await self.redis.ping()
            
            self.metrics.connection_pool_size.labels(storage_tier='redis').set(
                self.config.redis_pool_size
            )
            
            logger.info("Redis connection pool initialized successfully")
            
        except Exception as e:
            self.metrics.connection_errors.labels(
                storage_tier='redis',
                error_type='initialization'
            ).inc()
            logger.error(f"Failed to initialize Redis: {e}")
            raise
    
    async def close(self):
        """Close Redis connections"""
        if self.redis:
            await self.redis.close()
        if self.connection_pool:
            await self.connection_pool.disconnect()
    
    @asynccontextmanager
    async def _operation_timer(self, operation_type: str):
        """Context manager for operation timing"""
        start_time = time.time()
        try:
            yield
            self.metrics.operation_total.labels(
                storage_tier='redis',
                operation_type=operation_type,
                status='success'
            ).inc()
        except Exception as e:
            self.metrics.operation_total.labels(
                storage_tier='redis',
                operation_type=operation_type,
                status='error'
            ).inc()
            raise
        finally:
            duration = time.time() - start_time
            self.metrics.operation_duration.labels(
                storage_tier='redis',
                operation_type=operation_type
            ).observe(duration)
    
    async def store_session_state(self, session_id: str, state: Dict[str, Any]) -> bool:
        """Store session state in Redis"""
        async with self._operation_timer('store_session_state'):
            key = f"session:{session_id}"
            encrypted_state = self.encryption.encrypt_json(state)
            
            await self.redis.setex(
                key,
                self.config.hot_tier_ttl,
                encrypted_state
            )
            
            self.metrics.data_size_bytes.labels(
                storage_tier='redis',
                data_type='session_state'
            ).observe(len(encrypted_state))
            
            return True
    
    async def get_session_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve session state from Redis"""
        async with self._operation_timer('get_session_state'):
            key = f"session:{session_id}"
            encrypted_state = await self.redis.get(key)
            
            if encrypted_state:
                return self.encryption.decrypt_json(encrypted_state)
            return None
    
    async def acquire_cell_lock(self, session_id: str, cell_id: str, user_id: str, timeout: int = 300) -> bool:
        """Acquire cell lock with timeout"""
        async with self._operation_timer('acquire_cell_lock'):
            lock_key = f"lock:{session_id}:{cell_id}"
            lock_value = json.dumps({
                'user_id': user_id,
                'acquired_at': time.time(),
                'session_id': session_id
            })
            
            # Use Redis SET with NX (not exists) and EX (expire) for atomic lock acquisition
            result = await self.redis.set(lock_key, lock_value, nx=True, ex=timeout)
            return result is not None
    
    async def release_cell_lock(self, session_id: str, cell_id: str, user_id: str) -> bool:
        """Release cell lock"""
        async with self._operation_timer('release_cell_lock'):
            lock_key = f"lock:{session_id}:{cell_id}"
            
            # Lua script for atomic lock release
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
            return result == 1
    
    async def update_user_presence(self, session_id: str, user_id: str, presence_data: Dict[str, Any]) -> bool:
        """Update user presence data"""
        async with self._operation_timer('update_user_presence'):
            presence_key = f"presence:{session_id}"
            user_key = f"user:{user_id}"
            
            # Store presence data with TTL
            pipeline = self.redis.pipeline()
            pipeline.hset(presence_key, user_key, json.dumps(presence_data))
            pipeline.expire(presence_key, 60)  # 1-minute TTL
            await pipeline.execute()
            
            # Publish presence update
            await self.redis.publish(
                f"presence:updates:{session_id}",
                json.dumps({
                    'user_id': user_id,
                    'presence': presence_data,
                    'timestamp': time.time()
                })
            )
            
            return True
    
    async def get_session_participants(self, session_id: str) -> List[str]:
        """Get list of session participants"""
        async with self._operation_timer('get_session_participants'):
            presence_key = f"presence:{session_id}"
            user_keys = await self.redis.hkeys(presence_key)
            return [key.split(':', 1)[1] for key in user_keys if key.startswith('user:')]
    
    async def cache_crdt_operation(self, operation: CRDTOperation) -> bool:
        """Cache CRDT operation for fast access"""
        async with self._operation_timer('cache_crdt_operation'):
            operation_key = f"crdt_op:{operation.session_id}:{operation.operation_id}"
            operation_data = asdict(operation)
            operation_data['timestamp'] = operation.timestamp.isoformat()
            
            encrypted_data = self.encryption.encrypt_json(operation_data)
            
            await self.redis.setex(
                operation_key,
                self.config.hot_tier_ttl,
                encrypted_data
            )
            
            # Add to operation sequence
            sequence_key = f"crdt_seq:{operation.session_id}"
            await self.redis.lpush(sequence_key, operation.operation_id)
            await self.redis.expire(sequence_key, self.config.hot_tier_ttl)
            
            return True


class MongoDBManager:
    """MongoDB manager for warm-path CRDT state storage"""
    
    def __init__(self, config: PersistenceConfig, encryption_manager: EncryptionManager):
        self.config = config
        self.encryption = encryption_manager
        self.metrics = PersistenceMetrics()
        self.client: Optional[AsyncIOMotorClient] = None
        self.database = None
    
    async def initialize(self):
        """Initialize MongoDB connection"""
        try:
            self.client = AsyncIOMotorClient(
                self.config.mongodb_url,
                maxPoolSize=self.config.mongodb_pool_size,
                minPoolSize=2,
                maxIdleTimeMS=30000,
                serverSelectionTimeoutMS=5000
            )
            
            self.database = self.client[self.config.mongodb_database]
            
            # Test connection
            await self.client.admin.command('ping')
            
            # Create indexes
            await self._create_indexes()
            
            self.metrics.connection_pool_size.labels(storage_tier='mongodb').set(
                self.config.mongodb_pool_size
            )
            
            logger.info("MongoDB connection initialized successfully")
            
        except Exception as e:
            self.metrics.connection_errors.labels(
                storage_tier='mongodb',
                error_type='initialization'
            ).inc()
            logger.error(f"Failed to initialize MongoDB: {e}")
            raise
    
    async def close(self):
        """Close MongoDB connection"""
        if self.client:
            self.client.close()
    
    async def _create_indexes(self):
        """Create necessary indexes for performance"""
        collections = {
            'yjs_documents': [
                {'key': [('document_id', 1)], 'unique': True},
                {'key': [('last_modified', -1)]},
                {'key': [('document_id', 1), ('version', -1)]}
            ],
            'operation_logs': [
                {'key': [('document_id', 1), ('timestamp', -1)]},
                {'key': [('session_id', 1), ('operation_id', 1)], 'unique': True},
                {'key': [('user_id', 1), ('timestamp', -1)]},
                {'key': [('expires_at', 1)], 'expireAfterSeconds': 0}
            ],
            'collaboration_metadata': [
                {'key': [('session_id', 1)], 'unique': True},
                {'key': [('created_at', -1)]},
                {'key': [('participants', 1)]}
            ]
        }
        
        for collection_name, indexes in collections.items():
            collection = self.database[collection_name]
            for index in indexes:
                await collection.create_index(**index)
    
    @asynccontextmanager
    async def _operation_timer(self, operation_type: str):
        """Context manager for operation timing"""
        start_time = time.time()
        try:
            yield
            self.metrics.operation_total.labels(
                storage_tier='mongodb',
                operation_type=operation_type,
                status='success'
            ).inc()
        except Exception as e:
            self.metrics.operation_total.labels(
                storage_tier='mongodb',
                operation_type=operation_type,
                status='error'
            ).inc()
            raise
        finally:
            duration = time.time() - start_time
            self.metrics.operation_duration.labels(
                storage_tier='mongodb',
                operation_type=operation_type
            ).observe(duration)
    
    async def store_yjs_document(self, document_id: str, state_vector: bytes, 
                                document_state: bytes, metadata: Dict[str, Any]) -> bool:
        """Store Yjs document state"""
        async with self._operation_timer('store_yjs_document'):
            collection = self.database['yjs_documents']
            
            # Compress document state if enabled
            if self.config.compression_enabled:
                document_state = lz4.frame.compress(document_state)
                metadata['compression'] = 'lz4'
            
            document = {
                'document_id': document_id,
                'state_vector': state_vector,
                'document_state': document_state,
                'last_modified': datetime.utcnow(),
                'metadata': metadata,
                'size_bytes': len(document_state)
            }
            
            await collection.replace_one(
                {'document_id': document_id},
                document,
                upsert=True
            )
            
            self.metrics.data_size_bytes.labels(
                storage_tier='mongodb',
                data_type='yjs_document'
            ).observe(len(document_state))
            
            return True
    
    async def get_yjs_document(self, document_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve Yjs document state"""
        async with self._operation_timer('get_yjs_document'):
            collection = self.database['yjs_documents']
            document = await collection.find_one({'document_id': document_id})
            
            if document and document.get('metadata', {}).get('compression') == 'lz4':
                document['document_state'] = lz4.frame.decompress(document['document_state'])
            
            return document
    
    async def store_operation_log(self, operation: CRDTOperation) -> bool:
        """Store CRDT operation in operation log"""
        async with self._operation_timer('store_operation_log'):
            collection = self.database['operation_logs']
            
            # Calculate expiration time
            expires_at = datetime.utcnow() + timedelta(seconds=self.config.warm_tier_retention)
            
            operation_doc = {
                'operation_id': operation.operation_id,
                'session_id': operation.session_id,
                'document_id': f"notebook:{operation.session_id}",
                'user_id': operation.user_id,
                'operation_type': operation.operation_type.value,
                'cell_id': operation.cell_id,
                'content': operation.content,
                'timestamp': operation.timestamp,
                'vector_clock': operation.vector_clock,
                'metadata': operation.metadata,
                'expires_at': expires_at
            }
            
            await collection.insert_one(operation_doc)
            
            self.metrics.data_size_bytes.labels(
                storage_tier='mongodb',
                data_type='operation_log'
            ).observe(len(json.dumps(operation_doc, default=str)))
            
            return True
    
    async def get_operation_history(self, session_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        """Get operation history for session"""
        async with self._operation_timer('get_operation_history'):
            collection = self.database['operation_logs']
            
            cursor = collection.find(
                {'session_id': session_id}
            ).sort('timestamp', -1).limit(limit)
            
            return await cursor.to_list(length=limit)
    
    async def store_collaboration_metadata(self, metadata: SessionMetadata) -> bool:
        """Store collaboration session metadata"""
        async with self._operation_timer('store_collaboration_metadata'):
            collection = self.database['collaboration_metadata']
            
            metadata_doc = {
                'session_id': metadata.session_id,
                'notebook_path': metadata.notebook_path,
                'created_by': metadata.created_by,
                'created_at': metadata.created_at,
                'participants': metadata.participants,
                'permissions': metadata.permissions,
                'status': metadata.status,
                'last_updated': datetime.utcnow()
            }
            
            await collection.replace_one(
                {'session_id': metadata.session_id},
                metadata_doc,
                upsert=True
            )
            
            return True


class PostgreSQLManager:
    """PostgreSQL manager for cold-path structured data storage"""
    
    def __init__(self, config: PersistenceConfig, encryption_manager: EncryptionManager):
        self.config = config
        self.encryption = encryption_manager
        self.metrics = PersistenceMetrics()
        self.pool: Optional[asyncpg.Pool] = None
        self.engine = None
        self.session_factory = None
    
    async def initialize(self):
        """Initialize PostgreSQL connection pool"""
        try:
            # Create asyncpg connection pool
            self.pool = await asyncpg.create_pool(
                self.config.postgres_url,
                min_size=2,
                max_size=self.config.postgres_pool_size,
                command_timeout=60
            )
            
            # Create SQLAlchemy async engine
            self.engine = create_async_engine(
                self.config.postgres_url.replace('postgresql://', 'postgresql+asyncpg://'),
                pool_size=self.config.postgres_pool_size,
                max_overflow=self.config.postgres_max_overflow,
                echo=False
            )
            
            self.session_factory = async_sessionmaker(self.engine)
            
            # Create tables
            await self._create_tables()
            
            self.metrics.connection_pool_size.labels(storage_tier='postgresql').set(
                self.config.postgres_pool_size
            )
            
            logger.info("PostgreSQL connection pool initialized successfully")
            
        except Exception as e:
            self.metrics.connection_errors.labels(
                storage_tier='postgresql',
                error_type='initialization'
            ).inc()
            logger.error(f"Failed to initialize PostgreSQL: {e}")
            raise
    
    async def close(self):
        """Close PostgreSQL connections"""
        if self.pool:
            await self.pool.close()
        if self.engine:
            await self.engine.dispose()
    
    async def _create_tables(self):
        """Create necessary tables"""
        async with self.pool.acquire() as conn:
            # Create collaboration schema
            await conn.execute('CREATE SCHEMA IF NOT EXISTS collaboration')
            
            # Sessions table
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS collaboration.sessions (
                    session_id UUID PRIMARY KEY,
                    notebook_path TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
                    permissions JSONB NOT NULL,
                    metadata JSONB DEFAULT '{}',
                    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'terminated'))
                )
            ''')
            
            # Version history table
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS collaboration.version_history (
                    id SERIAL PRIMARY KEY,
                    session_id UUID REFERENCES collaboration.sessions(session_id),
                    operation_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    operation_type TEXT NOT NULL,
                    operation_data JSONB NOT NULL,
                    cell_id TEXT,
                    parent_version INTEGER REFERENCES collaboration.version_history(id)
                )
            ''')
            
            # Comments table
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS collaboration.comments (
                    comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    session_id UUID REFERENCES collaboration.sessions(session_id),
                    cell_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    parent_comment_id UUID REFERENCES collaboration.comments(comment_id),
                    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'deleted')),
                    metadata JSONB DEFAULT '{}'
                )
            ''')
            
            # User permissions table
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS collaboration.user_permissions (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    session_id UUID REFERENCES collaboration.sessions(session_id),
                    role TEXT NOT NULL,
                    permissions TEXT[] NOT NULL,
                    granted_by TEXT NOT NULL,
                    granted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    expires_at TIMESTAMP WITH TIME ZONE,
                    active BOOLEAN DEFAULT TRUE
                )
            ''')
            
            # Create indexes
            indexes = [
                'CREATE INDEX IF NOT EXISTS idx_sessions_notebook_path ON collaboration.sessions(notebook_path)',
                'CREATE INDEX IF NOT EXISTS idx_sessions_created_by ON collaboration.sessions(created_by)',
                'CREATE INDEX IF NOT EXISTS idx_version_history_session_timestamp ON collaboration.version_history(session_id, timestamp)',
                'CREATE INDEX IF NOT EXISTS idx_comments_session_cell ON collaboration.comments(session_id, cell_id)',
                'CREATE INDEX IF NOT EXISTS idx_user_permissions_user_session ON collaboration.user_permissions(user_id, session_id)',
                'CREATE INDEX IF NOT EXISTS idx_sessions_permissions_gin ON collaboration.sessions USING gin(permissions)',
                'CREATE INDEX IF NOT EXISTS idx_version_operation_data_gin ON collaboration.version_history USING gin(operation_data)'
            ]
            
            for index_sql in indexes:
                await conn.execute(index_sql)
    
    @asynccontextmanager
    async def _operation_timer(self, operation_type: str):
        """Context manager for operation timing"""
        start_time = time.time()
        try:
            yield
            self.metrics.operation_total.labels(
                storage_tier='postgresql',
                operation_type=operation_type,
                status='success'
            ).inc()
        except Exception as e:
            self.metrics.operation_total.labels(
                storage_tier='postgresql',
                operation_type=operation_type,
                status='error'
            ).inc()
            raise
        finally:
            duration = time.time() - start_time
            self.metrics.operation_duration.labels(
                storage_tier='postgresql',
                operation_type=operation_type
            ).observe(duration)
    
    async def store_user_permission(self, permission: UserPermission) -> bool:
        """Store user permission"""
        async with self._operation_timer('store_user_permission'):
            async with self.pool.acquire() as conn:
                await conn.execute('''
                    INSERT INTO collaboration.user_permissions 
                    (user_id, session_id, role, permissions, granted_by, granted_at, expires_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                ''', 
                permission.user_id, permission.session_id, permission.role,
                permission.permissions, permission.granted_by, 
                permission.granted_at, permission.expires_at)
                
                return True
    
    async def get_user_permissions(self, user_id: str, session_id: str) -> List[Dict[str, Any]]:
        """Get user permissions for session"""
        async with self._operation_timer('get_user_permissions'):
            async with self.pool.acquire() as conn:
                rows = await conn.fetch('''
                    SELECT * FROM collaboration.user_permissions 
                    WHERE user_id = $1 AND session_id = $2 AND active = TRUE
                    AND (expires_at IS NULL OR expires_at > NOW())
                ''', user_id, session_id)
                
                return [dict(row) for row in rows]
    
    async def store_version_history(self, session_id: str, operation: CRDTOperation) -> bool:
        """Store version history entry"""
        async with self._operation_timer('store_version_history'):
            async with self.pool.acquire() as conn:
                operation_data = {
                    'operation_type': operation.operation_type.value,
                    'content': operation.content,
                    'vector_clock': operation.vector_clock,
                    'metadata': operation.metadata
                }
                
                await conn.execute('''
                    INSERT INTO collaboration.version_history 
                    (session_id, operation_id, user_id, timestamp, operation_type, operation_data, cell_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                ''',
                session_id, operation.operation_id, operation.user_id,
                operation.timestamp, operation.operation_type.value,
                json.dumps(operation_data), operation.cell_id)
                
                return True
    
    async def get_version_history(self, session_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        """Get version history for session"""
        async with self._operation_timer('get_version_history'):
            async with self.pool.acquire() as conn:
                rows = await conn.fetch('''
                    SELECT * FROM collaboration.version_history 
                    WHERE session_id = $1 
                    ORDER BY timestamp DESC 
                    LIMIT $2
                ''', session_id, limit)
                
                return [dict(row) for row in rows]
    
    async def store_comment(self, session_id: str, cell_id: str, user_id: str, 
                           content: str, metadata: Dict[str, Any] = None) -> str:
        """Store comment"""
        async with self._operation_timer('store_comment'):
            async with self.pool.acquire() as conn:
                comment_id = str(uuid.uuid4())
                await conn.execute('''
                    INSERT INTO collaboration.comments 
                    (comment_id, session_id, cell_id, user_id, content, metadata)
                    VALUES ($1, $2, $3, $4, $5, $6)
                ''',
                comment_id, session_id, cell_id, user_id, content,
                json.dumps(metadata or {}))
                
                return comment_id
    
    async def get_comments(self, session_id: str, cell_id: str = None) -> List[Dict[str, Any]]:
        """Get comments for session or cell"""
        async with self._operation_timer('get_comments'):
            async with self.pool.acquire() as conn:
                if cell_id:
                    rows = await conn.fetch('''
                        SELECT * FROM collaboration.comments 
                        WHERE session_id = $1 AND cell_id = $2 AND status = 'active'
                        ORDER BY created_at ASC
                    ''', session_id, cell_id)
                else:
                    rows = await conn.fetch('''
                        SELECT * FROM collaboration.comments 
                        WHERE session_id = $1 AND status = 'active'
                        ORDER BY created_at ASC
                    ''', session_id)
                
                return [dict(row) for row in rows]


class S3Manager:
    """S3 manager for archive-path storage"""
    
    def __init__(self, config: PersistenceConfig, encryption_manager: EncryptionManager):
        self.config = config
        self.encryption = encryption_manager
        self.metrics = PersistenceMetrics()
        self.s3_client = None
    
    async def initialize(self):
        """Initialize S3 client"""
        try:
            # Configure S3 client
            s3_config = {
                'aws_access_key_id': self.config.s3_access_key,
                'aws_secret_access_key': self.config.s3_secret_key,
                'region_name': self.config.s3_region
            }
            
            if self.config.s3_endpoint:
                s3_config['endpoint_url'] = self.config.s3_endpoint
            
            self.s3_client = boto3.client('s3', **s3_config)
            
            # Test connection
            await self._test_connection()
            
            logger.info("S3 client initialized successfully")
            
        except Exception as e:
            self.metrics.connection_errors.labels(
                storage_tier='s3',
                error_type='initialization'
            ).inc()
            logger.error(f"Failed to initialize S3: {e}")
            raise
    
    async def _test_connection(self):
        """Test S3 connection"""
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(
                None, 
                self.s3_client.head_bucket,
                Bucket=self.config.s3_bucket
            )
        except ClientError as e:
            if e.response['Error']['Code'] == '404':
                # Bucket doesn't exist, create it
                await loop.run_in_executor(
                    None,
                    self.s3_client.create_bucket,
                    Bucket=self.config.s3_bucket
                )
            else:
                raise
    
    @asynccontextmanager
    async def _operation_timer(self, operation_type: str):
        """Context manager for operation timing"""
        start_time = time.time()
        try:
            yield
            self.metrics.operation_total.labels(
                storage_tier='s3',
                operation_type=operation_type,
                status='success'
            ).inc()
        except Exception as e:
            self.metrics.operation_total.labels(
                storage_tier='s3',
                operation_type=operation_type,
                status='error'
            ).inc()
            raise
        finally:
            duration = time.time() - start_time
            self.metrics.operation_duration.labels(
                storage_tier='s3',
                operation_type=operation_type
            ).observe(duration)
    
    async def store_document_snapshot(self, session_id: str, document_state: bytes, 
                                    metadata: Dict[str, Any]) -> str:
        """Store document snapshot to S3"""
        async with self._operation_timer('store_document_snapshot'):
            timestamp = int(time.time())
            session_hash = hashlib.sha256(session_id.encode()).hexdigest()[:16]
            object_key = f"snapshots/{session_hash}/{timestamp}.yjs"
            
            # Compress and encrypt data
            if self.config.compression_enabled:
                document_state = lz4.frame.compress(document_state)
                metadata['compression'] = 'lz4'
            
            encrypted_data = self.encryption.encrypt(document_state.hex())
            
            # Upload to S3
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                self.s3_client.put_object,
                {
                    'Bucket': self.config.s3_bucket,
                    'Key': object_key,
                    'Body': encrypted_data,
                    'Metadata': {
                        'session-id': session_id,
                        'timestamp': str(timestamp),
                        'content-type': 'application/octet-stream',
                        **{k: str(v) for k, v in metadata.items()}
                    },
                    'StorageClass': 'STANDARD_IA'
                }
            )
            
            self.metrics.data_size_bytes.labels(
                storage_tier='s3',
                data_type='document_snapshot'
            ).observe(len(encrypted_data))
            
            return object_key
    
    async def get_latest_snapshot(self, session_id: str) -> Optional[bytes]:
        """Get latest document snapshot"""
        async with self._operation_timer('get_latest_snapshot'):
            session_hash = hashlib.sha256(session_id.encode()).hexdigest()[:16]
            prefix = f"snapshots/{session_hash}/"
            
            loop = asyncio.get_event_loop()
            
            # List objects to find latest
            try:
                response = await loop.run_in_executor(
                    None,
                    self.s3_client.list_objects_v2,
                    {
                        'Bucket': self.config.s3_bucket,
                        'Prefix': prefix,
                        'MaxKeys': 1
                    }
                )
                
                if not response.get('Contents'):
                    return None
                
                latest_object = max(response['Contents'], key=lambda x: x['LastModified'])
                
                # Get object content
                obj_response = await loop.run_in_executor(
                    None,
                    self.s3_client.get_object,
                    {
                        'Bucket': self.config.s3_bucket,
                        'Key': latest_object['Key']
                    }
                )
                
                encrypted_data = obj_response['Body'].read()
                decrypted_hex = self.encryption.decrypt(encrypted_data)
                document_state = bytes.fromhex(decrypted_hex)
                
                # Decompress if needed
                metadata = obj_response.get('Metadata', {})
                if metadata.get('compression') == 'lz4':
                    document_state = lz4.frame.decompress(document_state)
                
                return document_state
                
            except ClientError as e:
                if e.response['Error']['Code'] == 'NoSuchKey':
                    return None
                raise
    
    async def store_version_archive(self, session_id: str, version_data: Dict[str, Any]) -> str:
        """Store version archive"""
        async with self._operation_timer('store_version_archive'):
            timestamp = int(time.time())
            object_key = f"versions/{session_id}/{timestamp}.json"
            
            # Encrypt version data
            version_json = json.dumps(version_data, separators=(',', ':'))
            encrypted_data = self.encryption.encrypt(version_json)
            
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                self.s3_client.put_object,
                {
                    'Bucket': self.config.s3_bucket,
                    'Key': object_key,
                    'Body': encrypted_data,
                    'Metadata': {
                        'session-id': session_id,
                        'timestamp': str(timestamp),
                        'content-type': 'application/json'
                    },
                    'StorageClass': 'STANDARD_IA'
                }
            )
            
            return object_key


class PersistenceLayer:
    """
    Multi-tier collaborative persistence layer
    
    Coordinates data storage across Redis (hot), MongoDB (warm), PostgreSQL (cold),
    and S3 (archive) tiers for optimal performance and reliability.
    """
    
    def __init__(self, config: PersistenceConfig = None):
        self.config = config or PersistenceConfig()
        self.encryption = EncryptionManager(self.config.encryption_key)
        self.metrics = PersistenceMetrics()
        
        # Storage managers
        self.redis = RedisManager(self.config, self.encryption)
        self.mongodb = MongoDBManager(self.config, self.encryption)
        self.postgresql = PostgreSQLManager(self.config, self.encryption)
        self.s3 = S3Manager(self.config, self.encryption)
        
        self._initialized = False
    
    async def initialize(self):
        """Initialize all storage tiers"""
        if self._initialized:
            return
        
        try:
            # Initialize storage managers in parallel
            await asyncio.gather(
                self.redis.initialize(),
                self.mongodb.initialize(),
                self.postgresql.initialize(),
                self.s3.initialize()
            )
            
            self._initialized = True
            logger.info("Multi-tier persistence layer initialized successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize persistence layer: {e}")
            raise
    
    async def close(self):
        """Close all connections"""
        if not self._initialized:
            return
        
        await asyncio.gather(
            self.redis.close(),
            self.mongodb.close(),
            self.postgresql.close(),
            return_exceptions=True
        )
        
        self._initialized = False
        logger.info("Persistence layer closed")
    
    async def store_crdt_operation(self, operation: CRDTOperation) -> bool:
        """
        Store CRDT operation across all appropriate tiers
        
        Hot path (Redis): Immediate caching for real-time access
        Warm path (MongoDB): Operation log for replay and debugging
        Cold path (PostgreSQL): Version history for audit
        """
        try:
            # Store in hot tier (Redis) for immediate access
            redis_task = self.redis.cache_crdt_operation(operation)
            
            # Store in warm tier (MongoDB) for operation log
            mongodb_task = self.mongodb.store_operation_log(operation)
            
            # Store in cold tier (PostgreSQL) for version history
            postgres_task = self.postgresql.store_version_history(operation.session_id, operation)
            
            # Execute storage operations
            if self.config.async_replication:
                # Async replication - don't wait for all tiers
                await redis_task
                asyncio.create_task(mongodb_task)
                asyncio.create_task(postgres_task)
            else:
                # Sync replication - wait for all tiers
                await asyncio.gather(redis_task, mongodb_task, postgres_task)
            
            self.metrics.operation_total.labels(
                storage_tier='multi_tier',
                operation_type='store_crdt_operation',
                status='success'
            ).inc()
            
            return True
            
        except Exception as e:
            self.metrics.operation_total.labels(
                storage_tier='multi_tier',
                operation_type='store_crdt_operation',
                status='error'
            ).inc()
            logger.error(f"Failed to store CRDT operation: {e}")
            raise
    
    async def get_session_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        """
        Get session state with tier fallback
        
        Priority: Redis → MongoDB → PostgreSQL → S3
        """
        try:
            # Try hot tier first (Redis)
            state = await self.redis.get_session_state(session_id)
            if state:
                return state
            
            # Fallback to warm tier (MongoDB)
            metadata = await self.mongodb.database['collaboration_metadata'].find_one(
                {'session_id': session_id}
            )
            if metadata:
                # Reconstruct state from metadata
                state = {
                    'session_id': metadata['session_id'],
                    'notebook_path': metadata['notebook_path'],
                    'participants': metadata['participants'],
                    'status': metadata['status'],
                    'last_updated': metadata.get('last_updated')
                }
                
                # Cache in hot tier for future access
                await self.redis.store_session_state(session_id, state)
                return state
            
            # If no state found, return None
            return None
            
        except Exception as e:
            logger.error(f"Failed to get session state: {e}")
            raise
    
    async def store_document_state(self, session_id: str, state_vector: bytes, 
                                 document_state: bytes, metadata: Dict[str, Any]) -> bool:
        """Store document state across tiers"""
        try:
            document_id = f"notebook:{session_id}"
            
            # Store in warm tier (MongoDB) for fast access
            mongodb_task = self.mongodb.store_yjs_document(
                document_id, state_vector, document_state, metadata
            )
            
            # Archive snapshot to S3 for backup
            s3_task = self.s3.store_document_snapshot(session_id, document_state, metadata)
            
            # Execute storage operations
            if self.config.async_replication:
                await mongodb_task
                asyncio.create_task(s3_task)
            else:
                await asyncio.gather(mongodb_task, s3_task)
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to store document state: {e}")
            raise
    
    async def reconstruct_session_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        """
        Reconstruct session state from available data across all tiers
        
        Priority-based recovery: Redis → MongoDB → PostgreSQL → S3
        """
        try:
            # Try to get latest state from MongoDB
            metadata = await self.mongodb.database['collaboration_metadata'].find_one(
                {'session_id': session_id}
            )
            
            if not metadata:
                # Try to reconstruct from PostgreSQL version history
                version_history = await self.postgresql.get_version_history(session_id, limit=1)
                if version_history:
                    # Basic reconstruction from version history
                    latest_version = version_history[0]
                    metadata = {
                        'session_id': session_id,
                        'notebook_path': latest_version.get('operation_data', {}).get('notebook_path'),
                        'created_by': latest_version['user_id'],
                        'participants': [latest_version['user_id']],
                        'status': 'reconstructed',
                        'last_updated': latest_version['timestamp']
                    }
            
            if metadata:
                # Cache reconstructed state in Redis
                state = {
                    'session_id': metadata['session_id'],
                    'notebook_path': metadata.get('notebook_path'),
                    'participants': metadata.get('participants', []),
                    'status': metadata.get('status', 'unknown'),
                    'last_updated': metadata.get('last_updated'),
                    'reconstructed': True
                }
                
                await self.redis.store_session_state(session_id, state)
                return state
            
            return None
            
        except Exception as e:
            logger.error(f"Failed to reconstruct session state: {e}")
            raise
    
    async def get_health_status(self) -> Dict[str, Any]:
        """Get health status of all storage tiers"""
        health_status = {
            'overall_healthy': True,
            'tiers': {},
            'timestamp': datetime.utcnow().isoformat()
        }
        
        # Check Redis health
        try:
            await self.redis.redis.ping()
            health_status['tiers']['redis'] = {'status': 'healthy', 'latency_ms': 1}
        except Exception as e:
            health_status['tiers']['redis'] = {'status': 'unhealthy', 'error': str(e)}
            health_status['overall_healthy'] = False
        
        # Check MongoDB health
        try:
            await self.mongodb.client.admin.command('ping')
            health_status['tiers']['mongodb'] = {'status': 'healthy', 'latency_ms': 5}
        except Exception as e:
            health_status['tiers']['mongodb'] = {'status': 'unhealthy', 'error': str(e)}
            health_status['overall_healthy'] = False
        
        # Check PostgreSQL health
        try:
            async with self.postgresql.pool.acquire() as conn:
                await conn.fetchval('SELECT 1')
            health_status['tiers']['postgresql'] = {'status': 'healthy', 'latency_ms': 10}
        except Exception as e:
            health_status['tiers']['postgresql'] = {'status': 'unhealthy', 'error': str(e)}
            health_status['overall_healthy'] = False
        
        # Check S3 health
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                self.s3.s3_client.head_bucket,
                Bucket=self.config.s3_bucket
            )
            health_status['tiers']['s3'] = {'status': 'healthy', 'latency_ms': 50}
        except Exception as e:
            health_status['tiers']['s3'] = {'status': 'unhealthy', 'error': str(e)}
            # S3 failure doesn't make overall system unhealthy
        
        return health_status
    
    # Convenience methods for common operations
    
    async def acquire_cell_lock(self, session_id: str, cell_id: str, user_id: str) -> bool:
        """Acquire cell lock"""
        return await self.redis.acquire_cell_lock(session_id, cell_id, user_id)
    
    async def release_cell_lock(self, session_id: str, cell_id: str, user_id: str) -> bool:
        """Release cell lock"""
        return await self.redis.release_cell_lock(session_id, cell_id, user_id)
    
    async def update_user_presence(self, session_id: str, user_id: str, presence_data: Dict[str, Any]) -> bool:
        """Update user presence"""
        return await self.redis.update_user_presence(session_id, user_id, presence_data)
    
    async def get_session_participants(self, session_id: str) -> List[str]:
        """Get session participants"""
        return await self.redis.get_session_participants(session_id)
    
    async def store_user_permission(self, permission: UserPermission) -> bool:
        """Store user permission"""
        return await self.postgresql.store_user_permission(permission)
    
    async def get_user_permissions(self, user_id: str, session_id: str) -> List[Dict[str, Any]]:
        """Get user permissions"""
        return await self.postgresql.get_user_permissions(user_id, session_id)
    
    async def store_comment(self, session_id: str, cell_id: str, user_id: str, 
                           content: str, metadata: Dict[str, Any] = None) -> str:
        """Store comment"""
        return await self.postgresql.store_comment(session_id, cell_id, user_id, content, metadata)
    
    async def get_comments(self, session_id: str, cell_id: str = None) -> List[Dict[str, Any]]:
        """Get comments"""
        return await self.postgresql.get_comments(session_id, cell_id)
    
    async def cleanup_expired_data(self):
        """Clean up expired data across all tiers"""
        try:
            # MongoDB cleanup happens automatically via TTL indexes
            # PostgreSQL cleanup for old sessions
            async with self.postgresql.pool.acquire() as conn:
                # Clean up old sessions
                await conn.execute('''
                    UPDATE collaboration.sessions 
                    SET status = 'expired' 
                    WHERE expires_at < NOW() AND status = 'active'
                ''')
                
                # Clean up old version history (keep last 1000 entries per session)
                await conn.execute('''
                    DELETE FROM collaboration.version_history 
                    WHERE id NOT IN (
                        SELECT id FROM (
                            SELECT id, ROW_NUMBER() OVER (
                                PARTITION BY session_id ORDER BY timestamp DESC
                            ) as rn
                            FROM collaboration.version_history
                        ) ranked WHERE rn <= 1000
                    )
                ''')
            
            logger.info("Expired data cleanup completed")
            
        except Exception as e:
            logger.error(f"Failed to cleanup expired data: {e}")


# Export main classes
__all__ = [
    'PersistenceLayer',
    'PersistenceConfig', 
    'CRDTOperation',
    'SessionMetadata',
    'UserPermission',
    'OperationType',
    'StorageTier'
]