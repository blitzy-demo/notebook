"""
Central CollaborationManager class providing comprehensive session lifecycle management,
user coordination, cross-instance session state synchronization, and real-time message
routing for collaborative editing.

This module serves as the central orchestrator for all collaborative editing operations,
coordinating between WebSocket connections, the persistence layer, and external services
like JupyterHub for authentication. It implements sophisticated session management with
automatic cleanup, user presence tracking with Redis pub/sub, distributed cell-level
locking, and cross-instance coordination for horizontal scaling.

Architecture:
- CollaborationManager: Main coordination class managing all collaborative sessions
- WebSocketPool: High-availability connection pool with automatic recovery
- SessionRegistry: Distributed session state coordination across server instances  
- PresenceTracker: Real-time user presence and awareness broadcasting
- LockManager: Intelligent cell-level conflict prevention with TTL management
- MessageRouter: CRDT operation routing and synchronization coordination
- AuthenticationBridge: JupyterHub integration for user identity and permissions
"""

import asyncio
import json
import logging
import time
import uuid
import weakref
import os
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any, Set, Callable, Tuple, Union
from dataclasses import dataclass, asdict
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
import hashlib

# WebSocket and HTTP handling
import tornado.web
import tornado.websocket
import tornado.escape
from tornado.concurrent import run_on_executor

# Jupyter integration
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from traitlets import TraitError
from jupyter_core.utils import ensure_async

# Import persistence layer
from .persistence import (
    PersistenceLayer, CollaborationSession, CRDTOperation, 
    VersionHistory, UserPermission, create_persistence_layer
)

# Logger setup
logger = logging.getLogger(__name__)


@dataclass
class WebSocketConnection:
    """WebSocket connection metadata for tracking and management"""
    connection_id: str
    user_id: str
    session_id: str
    websocket: tornado.websocket.WebSocketHandler
    connected_at: datetime
    last_heartbeat: datetime
    user_agent: Optional[str] = None
    ip_address: Optional[str] = None
    client_id: Optional[int] = None
    capabilities: Dict[str, Any] = None

    def __post_init__(self):
        if self.capabilities is None:
            self.capabilities = {}


@dataclass
class SessionState:
    """Collaborative session state for coordination across instances"""
    session_id: str
    notebook_path: str
    created_by: str
    created_at: datetime
    last_activity: datetime
    participant_count: int
    active_connections: Set[str]
    document_version: int
    locked_cells: Dict[str, str]  # cell_id -> user_id
    status: str = "active"
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}
        if isinstance(self.active_connections, list):
            self.active_connections = set(self.active_connections)


@dataclass
class PresenceUpdate:
    """User presence update for real-time awareness"""
    user_id: str
    session_id: str
    cursor_position: Optional[Dict[str, Any]] = None
    selection: Optional[Dict[str, Any]] = None
    active_cell: Optional[str] = None
    status: str = "active"
    timestamp: Optional[float] = None
    custom_data: Dict[str, Any] = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = time.time()
        if self.custom_data is None:
            self.custom_data = {}


class WebSocketPool:
    """High-availability WebSocket connection pool with automatic recovery and state management"""
    
    def __init__(self, collaboration_manager: 'CollaborationManager'):
        self.collaboration_manager = collaboration_manager
        self.connections: Dict[str, WebSocketConnection] = {}
        self.connections_by_user: Dict[str, Set[str]] = {}
        self.connections_by_session: Dict[str, Set[str]] = {}
        
        # Configuration
        self.heartbeat_interval = int(os.getenv('JUPYTER_COLLAB_HEARTBEAT_INTERVAL', '30'))  # 30 seconds
        self.connection_timeout = int(os.getenv('JUPYTER_COLLAB_CONNECTION_TIMEOUT', '300'))  # 5 minutes
        self.max_connections_per_user = int(os.getenv('JUPYTER_COLLAB_MAX_CONNECTIONS_PER_USER', '10'))
        
        # Background tasks
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._cleanup_task: Optional[asyncio.Task] = None
        
        logger.info("WebSocketPool initialized")
    
    async def start(self):
        """Start background maintenance tasks"""
        if not self._heartbeat_task:
            self._heartbeat_task = asyncio.create_task(self._heartbeat_monitor())
        if not self._cleanup_task:
            self._cleanup_task = asyncio.create_task(self._connection_cleanup())
        
        logger.info("WebSocketPool background tasks started")
    
    async def stop(self):
        """Stop background tasks and cleanup connections"""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        
        # Close all active connections gracefully
        for connection in list(self.connections.values()):
            await self.remove_connection(connection.connection_id, reason="server_shutdown")
        
        logger.info("WebSocketPool stopped")
    
    async def add_connection(self, websocket: tornado.websocket.WebSocketHandler, 
                           user_id: str, session_id: str, 
                           user_agent: Optional[str] = None,
                           client_id: Optional[int] = None) -> str:
        """Add new WebSocket connection with validation and limits"""
        try:
            # Check connection limits per user
            user_connections = self.connections_by_user.get(user_id, set())
            if len(user_connections) >= self.max_connections_per_user:
                oldest_connection_id = min(
                    user_connections,
                    key=lambda cid: self.connections[cid].connected_at
                )
                await self.remove_connection(
                    oldest_connection_id, 
                    reason="connection_limit_exceeded"
                )
            
            # Create connection metadata
            connection_id = str(uuid.uuid4())
            connection = WebSocketConnection(
                connection_id=connection_id,
                user_id=user_id,
                session_id=session_id,
                websocket=websocket,
                connected_at=datetime.utcnow(),
                last_heartbeat=datetime.utcnow(),
                user_agent=user_agent,
                ip_address=websocket.request.remote_ip,
                client_id=client_id or int(time.time() * 1000) % 2**31  # Generate client ID
            )
            
            # Register connection in all tracking structures
            self.connections[connection_id] = connection
            
            if user_id not in self.connections_by_user:
                self.connections_by_user[user_id] = set()
            self.connections_by_user[user_id].add(connection_id)
            
            if session_id not in self.connections_by_session:
                self.connections_by_session[session_id] = set()
            self.connections_by_session[session_id].add(connection_id)
            
            logger.info(f"WebSocket connection added: {connection_id} for user {user_id} in session {session_id}")
            return connection_id
            
        except Exception as e:
            logger.error(f"Error adding WebSocket connection: {e}")
            raise
    
    async def remove_connection(self, connection_id: str, reason: str = "client_disconnect") -> bool:
        """Remove WebSocket connection and cleanup references"""
        try:
            connection = self.connections.get(connection_id)
            if not connection:
                return False
            
            # Remove from tracking structures
            user_connections = self.connections_by_user.get(connection.user_id, set())
            user_connections.discard(connection_id)
            if not user_connections:
                del self.connections_by_user[connection.user_id]
            
            session_connections = self.connections_by_session.get(connection.session_id, set())
            session_connections.discard(connection_id)
            if not session_connections:
                del self.connections_by_session[connection.session_id]
            
            del self.connections[connection_id]
            
            # Close WebSocket if still open
            try:
                if not connection.websocket.ws_connection.is_closing():
                    connection.websocket.close(code=1000, reason=reason)
            except Exception as e:
                logger.warning(f"Error closing WebSocket: {e}")
            
            # Notify collaboration manager of disconnection
            await self.collaboration_manager.handle_user_disconnect(
                connection.user_id, connection.session_id, connection_id
            )
            
            logger.info(f"WebSocket connection removed: {connection_id} (reason: {reason})")
            return True
            
        except Exception as e:
            logger.error(f"Error removing WebSocket connection: {e}")
            return False
    
    async def update_heartbeat(self, connection_id: str) -> bool:
        """Update connection heartbeat timestamp"""
        connection = self.connections.get(connection_id)
        if connection:
            connection.last_heartbeat = datetime.utcnow()
            return True
        return False
    
    async def broadcast_to_session(self, session_id: str, message: Dict[str, Any], 
                                  exclude_connection_id: Optional[str] = None,
                                  exclude_user_id: Optional[str] = None) -> int:
        """Broadcast message to all connections in a session"""
        sent_count = 0
        session_connections = self.connections_by_session.get(session_id, set())
        
        for connection_id in list(session_connections):  # Copy to avoid iteration issues
            if connection_id == exclude_connection_id:
                continue
                
            connection = self.connections.get(connection_id)
            if not connection:
                continue
                
            if exclude_user_id and connection.user_id == exclude_user_id:
                continue
            
            try:
                if not connection.websocket.ws_connection.is_closing():
                    await connection.websocket.write_message(json.dumps(message))
                    sent_count += 1
                else:
                    # Schedule connection removal
                    asyncio.create_task(self.remove_connection(
                        connection_id, reason="connection_closed"
                    ))
            except Exception as e:
                logger.warning(f"Error sending message to connection {connection_id}: {e}")
                asyncio.create_task(self.remove_connection(
                    connection_id, reason="send_error"
                ))
        
        return sent_count
    
    async def send_to_user(self, user_id: str, message: Dict[str, Any]) -> int:
        """Send message to all connections for a specific user"""
        sent_count = 0
        user_connections = self.connections_by_user.get(user_id, set())
        
        for connection_id in list(user_connections):
            connection = self.connections.get(connection_id)
            if not connection:
                continue
            
            try:
                if not connection.websocket.ws_connection.is_closing():
                    await connection.websocket.write_message(json.dumps(message))
                    sent_count += 1
                else:
                    asyncio.create_task(self.remove_connection(
                        connection_id, reason="connection_closed"
                    ))
            except Exception as e:
                logger.warning(f"Error sending message to user {user_id}: {e}")
                asyncio.create_task(self.remove_connection(
                    connection_id, reason="send_error"
                ))
        
        return sent_count
    
    def get_connection(self, connection_id: str) -> Optional[WebSocketConnection]:
        """Get connection by ID"""
        return self.connections.get(connection_id)
    
    def get_session_connections(self, session_id: str) -> List[WebSocketConnection]:
        """Get all connections for a session"""
        connection_ids = self.connections_by_session.get(session_id, set())
        return [self.connections[cid] for cid in connection_ids if cid in self.connections]
    
    def get_user_connections(self, user_id: str) -> List[WebSocketConnection]:
        """Get all connections for a user"""
        connection_ids = self.connections_by_user.get(user_id, set())
        return [self.connections[cid] for cid in connection_ids if cid in self.connections]
    
    async def get_connection_stats(self) -> Dict[str, Any]:
        """Get comprehensive connection statistics"""
        return {
            'total_connections': len(self.connections),
            'active_users': len(self.connections_by_user),
            'active_sessions': len(self.connections_by_session),
            'connections_by_session': {
                session_id: len(connections) 
                for session_id, connections in self.connections_by_session.items()
            },
            'connections_by_user': {
                user_id: len(connections)
                for user_id, connections in self.connections_by_user.items()
            }
        }
    
    async def _heartbeat_monitor(self):
        """Background task to monitor connection health via heartbeats"""
        while True:
            try:
                await asyncio.sleep(self.heartbeat_interval)
                
                current_time = datetime.utcnow()
                stale_connections = []
                
                for connection_id, connection in self.connections.items():
                    time_since_heartbeat = (current_time - connection.last_heartbeat).total_seconds()
                    
                    if time_since_heartbeat > self.connection_timeout:
                        stale_connections.append(connection_id)
                
                # Remove stale connections
                for connection_id in stale_connections:
                    await self.remove_connection(connection_id, reason="heartbeat_timeout")
                
                if stale_connections:
                    logger.info(f"Removed {len(stale_connections)} stale connections")
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in heartbeat monitor: {e}")
    
    async def _connection_cleanup(self):
        """Background task for connection pool maintenance"""
        while True:
            try:
                await asyncio.sleep(300)  # Run every 5 minutes
                
                # Clean up orphaned connections
                orphaned_connections = []
                for connection_id, connection in self.connections.items():
                    try:
                        if connection.websocket.ws_connection.is_closing():
                            orphaned_connections.append(connection_id)
                    except Exception:
                        orphaned_connections.append(connection_id)
                
                for connection_id in orphaned_connections:
                    await self.remove_connection(connection_id, reason="orphaned_connection")
                
                if orphaned_connections:
                    logger.info(f"Cleaned up {len(orphaned_connections)} orphaned connections")
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in connection cleanup: {e}")


class SessionRegistry:
    """Distributed session state coordination across server instances"""
    
    def __init__(self, collaboration_manager: 'CollaborationManager'):
        self.collaboration_manager = collaboration_manager
        self.local_sessions: Dict[str, SessionState] = {}
        
        # Configuration
        self.session_ttl = int(os.getenv('JUPYTER_COLLAB_SESSION_TTL', '86400'))  # 24 hours
        self.cleanup_interval = int(os.getenv('JUPYTER_COLLAB_CLEANUP_INTERVAL', '300'))  # 5 minutes
        
        # Background cleanup task
        self._cleanup_task: Optional[asyncio.Task] = None
        
        logger.info("SessionRegistry initialized")
    
    async def start(self):
        """Start background maintenance tasks"""
        if not self._cleanup_task:
            self._cleanup_task = asyncio.create_task(self._session_cleanup())
        logger.info("SessionRegistry background tasks started")
    
    async def stop(self):
        """Stop background tasks"""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        logger.info("SessionRegistry stopped")
    
    async def create_session(self, notebook_path: str, created_by: str,
                           permissions: Optional[Dict[str, Any]] = None) -> str:
        """Create new collaborative session"""
        try:
            session_id = str(uuid.uuid4())
            current_time = datetime.utcnow()
            
            # Create session metadata
            session = CollaborationSession(
                session_id=session_id,
                notebook_path=notebook_path,
                created_by=created_by,
                created_at=current_time,
                expires_at=current_time + timedelta(seconds=self.session_ttl),
                permissions=permissions or {'default': 'editor'},
                participants=[created_by],
                status='active'
            )
            
            # Create local session state
            session_state = SessionState(
                session_id=session_id,
                notebook_path=notebook_path,
                created_by=created_by,
                created_at=current_time,
                last_activity=current_time,
                participant_count=1,
                active_connections=set(),
                document_version=0,
                locked_cells={}
            )
            
            # Store in persistence layer
            await self.collaboration_manager.persistence.create_collaboration_session(session)
            
            # Register locally
            self.local_sessions[session_id] = session_state
            
            logger.info(f"Collaboration session created: {session_id} for {notebook_path}")
            return session_id
            
        except Exception as e:
            logger.error(f"Error creating collaboration session: {e}")
            raise
    
    async def join_session(self, session_id: str, user_id: str, 
                          connection_id: str) -> Optional[SessionState]:
        """Join existing collaboration session"""
        try:
            # Get session from persistence if not cached locally
            if session_id not in self.local_sessions:
                session = await self.collaboration_manager.persistence.get_collaboration_session(session_id)
                if not session:
                    logger.warning(f"Session not found: {session_id}")
                    return None
                
                if session.status != 'active':
                    logger.warning(f"Session not active: {session_id} (status: {session.status})")
                    return None
                
                if session.expires_at < datetime.utcnow():
                    logger.warning(f"Session expired: {session_id}")
                    return None
                
                # Create local session state
                session_state = SessionState(
                    session_id=session_id,
                    notebook_path=session.notebook_path,
                    created_by=session.created_by,
                    created_at=session.created_at,
                    last_activity=datetime.utcnow(),
                    participant_count=len(session.participants),
                    active_connections=set(),
                    document_version=0,
                    locked_cells={}
                )
                
                self.local_sessions[session_id] = session_state
            
            session_state = self.local_sessions[session_id]
            
            # Add connection to session
            session_state.active_connections.add(connection_id)
            session_state.last_activity = datetime.utcnow()
            
            # Update participant count if new user
            if user_id not in [conn.user_id for conn in 
                              self.collaboration_manager.websocket_pool.get_session_connections(session_id)]:
                session_state.participant_count += 1
            
            logger.info(f"User {user_id} joined session {session_id}")
            return session_state
            
        except Exception as e:
            logger.error(f"Error joining session {session_id}: {e}")
            return None
    
    async def leave_session(self, session_id: str, user_id: str, connection_id: str):
        """Leave collaboration session"""
        try:
            session_state = self.local_sessions.get(session_id)
            if not session_state:
                return
            
            # Remove connection from session
            session_state.active_connections.discard(connection_id)
            session_state.last_activity = datetime.utcnow()
            
            # Update participant count if user has no more connections
            user_connections = [
                conn for conn in self.collaboration_manager.websocket_pool.get_session_connections(session_id)
                if conn.user_id == user_id and conn.connection_id != connection_id
            ]
            
            if not user_connections:
                session_state.participant_count = max(0, session_state.participant_count - 1)
            
            # Remove session if no active connections
            if not session_state.active_connections:
                await self.terminate_session(session_id, reason="no_active_participants")
            
            logger.info(f"User {user_id} left session {session_id}")
            
        except Exception as e:
            logger.error(f"Error leaving session {session_id}: {e}")
    
    async def terminate_session(self, session_id: str, reason: str = "manual_termination"):
        """Terminate collaboration session and cleanup resources"""
        try:
            session_state = self.local_sessions.get(session_id)
            if not session_state:
                return
            
            # Close all connections in session
            session_connections = self.collaboration_manager.websocket_pool.get_session_connections(session_id)
            for connection in session_connections:
                await self.collaboration_manager.websocket_pool.remove_connection(
                    connection.connection_id, reason=f"session_terminated_{reason}"
                )
            
            # Release all cell locks
            for cell_id in list(session_state.locked_cells.keys()):
                await self.collaboration_manager.lock_manager.release_cell_lock(
                    session_state.notebook_path, cell_id, session_state.locked_cells[cell_id]
                )
            
            # Update session status in persistence
            try:
                session = await self.collaboration_manager.persistence.get_collaboration_session(session_id)
                if session:
                    session.status = 'terminated'
                    # Note: persistence layer doesn't have update method, but we can log for audit
                    await self.collaboration_manager.persistence.postgres.log_audit_event(
                        session_id, session_state.created_by, 'session_terminated', 
                        'collaboration_session', session_id, metadata={'reason': reason}
                    )
            except Exception as e:
                logger.warning(f"Error updating session status in persistence: {e}")
            
            # Remove from local registry
            del self.local_sessions[session_id]
            
            logger.info(f"Session terminated: {session_id} (reason: {reason})")
            
        except Exception as e:
            logger.error(f"Error terminating session {session_id}: {e}")
    
    def get_session(self, session_id: str) -> Optional[SessionState]:
        """Get local session state"""
        return self.local_sessions.get(session_id)
    
    async def get_session_stats(self) -> Dict[str, Any]:
        """Get session statistics"""
        total_participants = sum(state.participant_count for state in self.local_sessions.values())
        total_connections = sum(len(state.active_connections) for state in self.local_sessions.values())
        
        return {
            'total_sessions': len(self.local_sessions),
            'active_sessions': len([s for s in self.local_sessions.values() if s.status == 'active']),
            'total_participants': total_participants,
            'total_connections': total_connections,
            'sessions': {
                session_id: {
                    'notebook_path': state.notebook_path,
                    'participant_count': state.participant_count,
                    'connection_count': len(state.active_connections),
                    'last_activity': state.last_activity.isoformat(),
                    'locked_cells': len(state.locked_cells)
                }
                for session_id, state in self.local_sessions.items()
            }
        }
    
    async def _session_cleanup(self):
        """Background task for session maintenance and cleanup"""
        while True:
            try:
                await asyncio.sleep(self.cleanup_interval)
                
                current_time = datetime.utcnow()
                expired_sessions = []
                
                for session_id, session_state in self.local_sessions.items():
                    # Check for expired sessions
                    if (current_time - session_state.last_activity).total_seconds() > self.session_ttl:
                        expired_sessions.append(session_id)
                    
                    # Check for orphaned sessions (no active connections)
                    elif not session_state.active_connections:
                        # Grace period of 5 minutes for reconnection
                        if (current_time - session_state.last_activity).total_seconds() > 300:
                            expired_sessions.append(session_id)
                
                # Clean up expired sessions
                for session_id in expired_sessions:
                    await self.terminate_session(session_id, reason="cleanup_expired")
                
                if expired_sessions:
                    logger.info(f"Cleaned up {len(expired_sessions)} expired sessions")
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in session cleanup: {e}")


class PresenceTracker:
    """Real-time user presence and awareness broadcasting"""
    
    def __init__(self, collaboration_manager: 'CollaborationManager'):
        self.collaboration_manager = collaboration_manager
        self.user_presence: Dict[str, Dict[str, PresenceUpdate]] = {}  # session_id -> user_id -> presence
        
        # Configuration
        self.presence_broadcast_interval = float(os.getenv('JUPYTER_COLLAB_PRESENCE_INTERVAL', '1.0'))  # 1 second
        self.presence_timeout = int(os.getenv('JUPYTER_COLLAB_PRESENCE_TIMEOUT', '30'))  # 30 seconds
        
        # Background tasks
        self._broadcast_task: Optional[asyncio.Task] = None
        self._cleanup_task: Optional[asyncio.Task] = None
        
        logger.info("PresenceTracker initialized")
    
    async def start(self):
        """Start background presence broadcasting"""
        if not self._broadcast_task:
            self._broadcast_task = asyncio.create_task(self._presence_broadcaster())
        if not self._cleanup_task:
            self._cleanup_task = asyncio.create_task(self._presence_cleanup())
        logger.info("PresenceTracker background tasks started")
    
    async def stop(self):
        """Stop background tasks"""
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
        
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        
        logger.info("PresenceTracker stopped")
    
    async def update_presence(self, session_id: str, user_id: str, 
                            presence_data: Dict[str, Any]) -> bool:
        """Update user presence information"""
        try:
            presence_update = PresenceUpdate(
                user_id=user_id,
                session_id=session_id,
                cursor_position=presence_data.get('cursor_position'),
                selection=presence_data.get('selection'),
                active_cell=presence_data.get('active_cell'),
                status=presence_data.get('status', 'active'),
                custom_data=presence_data.get('custom_data', {})
            )
            
            # Store locally
            if session_id not in self.user_presence:
                self.user_presence[session_id] = {}
            self.user_presence[session_id][user_id] = presence_update
            
            # Store in Redis for cross-instance coordination
            await self.collaboration_manager.persistence.update_user_presence(
                session_id, user_id, asdict(presence_update)
            )
            
            logger.debug(f"Presence updated for user {user_id} in session {session_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error updating presence for user {user_id}: {e}")
            return False
    
    async def remove_presence(self, session_id: str, user_id: str):
        """Remove user presence when disconnecting"""
        try:
            # Remove from local cache
            if session_id in self.user_presence:
                self.user_presence[session_id].pop(user_id, None)
                if not self.user_presence[session_id]:
                    del self.user_presence[session_id]
            
            # Update persistence layer (set status to offline)
            await self.collaboration_manager.persistence.update_user_presence(
                session_id, user_id, {
                    'user_id': user_id,
                    'session_id': session_id,
                    'status': 'offline',
                    'timestamp': time.time()
                }
            )
            
            logger.debug(f"Presence removed for user {user_id} in session {session_id}")
            
        except Exception as e:
            logger.error(f"Error removing presence for user {user_id}: {e}")
    
    async def get_session_presence(self, session_id: str) -> List[Dict[str, Any]]:
        """Get all active presence for a session"""
        try:
            # Get from Redis (authoritative for cross-instance coordination)
            participants = await self.collaboration_manager.persistence.get_session_participants(session_id)
            
            # Filter out stale presence (older than timeout)
            current_time = time.time()
            active_presence = []
            
            for participant in participants:
                last_seen = participant.get('last_seen', 0)
                if current_time - last_seen < self.presence_timeout:
                    active_presence.append(participant)
            
            return active_presence
            
        except Exception as e:
            logger.error(f"Error getting session presence: {e}")
            return []
    
    async def _presence_broadcaster(self):
        """Background task to broadcast presence updates to all clients"""
        while True:
            try:
                await asyncio.sleep(self.presence_broadcast_interval)
                
                # Broadcast presence for each active session
                for session_id in list(self.user_presence.keys()):
                    try:
                        presence_data = await self.get_session_presence(session_id)
                        
                        if presence_data:
                            # Prepare presence update message
                            message = {
                                'type': 'presence_update',
                                'session_id': session_id,
                                'participants': presence_data,
                                'timestamp': time.time()
                            }
                            
                            # Broadcast to all connections in session
                            await self.collaboration_manager.websocket_pool.broadcast_to_session(
                                session_id, message
                            )
                    
                    except Exception as e:
                        logger.warning(f"Error broadcasting presence for session {session_id}: {e}")
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in presence broadcaster: {e}")
    
    async def _presence_cleanup(self):
        """Background task to clean up stale presence data"""
        while True:
            try:
                await asyncio.sleep(60)  # Clean up every minute
                
                current_time = time.time()
                
                # Clean up local presence cache
                for session_id in list(self.user_presence.keys()):
                    session_presence = self.user_presence[session_id]
                    
                    stale_users = []
                    for user_id, presence in session_presence.items():
                        if current_time - presence.timestamp > self.presence_timeout:
                            stale_users.append(user_id)
                    
                    for user_id in stale_users:
                        await self.remove_presence(session_id, user_id)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in presence cleanup: {e}")


class LockManager:
    """Intelligent cell-level conflict prevention with TTL management"""
    
    def __init__(self, collaboration_manager: 'CollaborationManager'):
        self.collaboration_manager = collaboration_manager
        
        # Configuration
        self.lock_timeout = int(os.getenv('JUPYTER_COLLAB_LOCK_TIMEOUT', '300'))  # 5 minutes
        self.lock_extend_threshold = int(os.getenv('JUPYTER_COLLAB_LOCK_EXTEND_THRESHOLD', '60'))  # 1 minute
        
        logger.info("LockManager initialized")
    
    async def acquire_cell_lock(self, notebook_path: str, cell_id: str, 
                              user_id: str, session_id: str) -> Dict[str, Any]:
        """Acquire cell-level lock with intelligent conflict detection"""
        try:
            # Attempt to acquire lock via persistence layer
            lock_acquired = await self.collaboration_manager.persistence.acquire_cell_lock(
                notebook_path, cell_id, user_id
            )
            
            result = {
                'success': lock_acquired,
                'cell_id': cell_id,
                'user_id': user_id,
                'timestamp': time.time()
            }
            
            if lock_acquired:
                # Update local session state
                session_state = self.collaboration_manager.session_registry.get_session(session_id)
                if session_state:
                    session_state.locked_cells[cell_id] = user_id
                
                # Broadcast lock acquisition to other users
                lock_message = {
                    'type': 'cell_lock_acquired',
                    'cell_id': cell_id,
                    'user_id': user_id,
                    'timestamp': result['timestamp']
                }
                
                await self.collaboration_manager.websocket_pool.broadcast_to_session(
                    session_id, lock_message, exclude_user_id=user_id
                )
                
                result['expires_at'] = time.time() + self.lock_timeout
                logger.debug(f"Cell lock acquired: {cell_id} by {user_id}")
                
            else:
                # Check who currently holds the lock
                try:
                    # Query Redis for current lock holder
                    lock_key = f"lock:{hashlib.sha256(notebook_path.encode()).hexdigest()}:{cell_id}"
                    if self.collaboration_manager.persistence.redis:
                        existing_lock = await self.collaboration_manager.persistence.redis.redis_client.get(lock_key)
                        if existing_lock:
                            lock_data = self.collaboration_manager.persistence.redis.encryption.decrypt_data(existing_lock).decode('utf-8')
                            lock_holder = lock_data.split(':')[0]
                            result['current_holder'] = lock_holder
                            
                except Exception as e:
                    logger.warning(f"Error checking lock holder: {e}")
                
                logger.debug(f"Cell lock denied: {cell_id} for {user_id}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error acquiring cell lock: {e}")
            return {
                'success': False,
                'error': str(e),
                'cell_id': cell_id,
                'user_id': user_id,
                'timestamp': time.time()
            }
    
    async def release_cell_lock(self, notebook_path: str, cell_id: str, 
                              user_id: str, session_id: str) -> Dict[str, Any]:
        """Release cell-level lock with validation"""
        try:
            # Release lock via persistence layer
            lock_released = await self.collaboration_manager.persistence.release_cell_lock(
                notebook_path, cell_id, user_id
            )
            
            result = {
                'success': lock_released,
                'cell_id': cell_id,
                'user_id': user_id,
                'timestamp': time.time()
            }
            
            if lock_released:
                # Update local session state
                session_state = self.collaboration_manager.session_registry.get_session(session_id)
                if session_state:
                    session_state.locked_cells.pop(cell_id, None)
                
                # Broadcast lock release to other users
                release_message = {
                    'type': 'cell_lock_released',
                    'cell_id': cell_id,
                    'user_id': user_id,
                    'timestamp': result['timestamp']
                }
                
                await self.collaboration_manager.websocket_pool.broadcast_to_session(
                    session_id, release_message, exclude_user_id=user_id
                )
                
                logger.debug(f"Cell lock released: {cell_id} by {user_id}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error releasing cell lock: {e}")
            return {
                'success': False,
                'error': str(e),
                'cell_id': cell_id,
                'user_id': user_id,
                'timestamp': time.time()
            }
    
    async def extend_cell_lock(self, notebook_path: str, cell_id: str, 
                             user_id: str, session_id: str) -> Dict[str, Any]:
        """Extend cell lock TTL for continued editing"""
        try:
            # Re-acquire lock to extend TTL
            result = await self.acquire_cell_lock(notebook_path, cell_id, user_id, session_id)
            
            if result['success']:
                result['extended'] = True
                logger.debug(f"Cell lock extended: {cell_id} by {user_id}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error extending cell lock: {e}")
            return {
                'success': False,
                'error': str(e),
                'cell_id': cell_id,
                'user_id': user_id,
                'timestamp': time.time()
            }
    
    async def get_session_locks(self, session_id: str) -> Dict[str, str]:
        """Get all active cell locks for a session"""
        session_state = self.collaboration_manager.session_registry.get_session(session_id)
        if session_state:
            return dict(session_state.locked_cells)
        return {}
    
    async def release_user_locks(self, user_id: str, session_id: str):
        """Release all locks held by a user (on disconnect)"""
        try:
            session_state = self.collaboration_manager.session_registry.get_session(session_id)
            if not session_state:
                return
            
            user_locks = [
                cell_id for cell_id, lock_holder in session_state.locked_cells.items()
                if lock_holder == user_id
            ]
            
            for cell_id in user_locks:
                await self.release_cell_lock(
                    session_state.notebook_path, cell_id, user_id, session_id
                )
            
            if user_locks:
                logger.info(f"Released {len(user_locks)} locks for user {user_id} on disconnect")
            
        except Exception as e:
            logger.error(f"Error releasing user locks: {e}")


class MessageRouter:
    """CRDT operation routing and synchronization coordination"""
    
    def __init__(self, collaboration_manager: 'CollaborationManager'):
        self.collaboration_manager = collaboration_manager
        
        # Message queues for handling high-volume operations
        self.message_queue: asyncio.Queue = asyncio.Queue(maxsize=10000)
        self.dead_letter_queue: List[Dict[str, Any]] = []
        
        # Configuration
        self.max_message_size = int(os.getenv('JUPYTER_COLLAB_MAX_MESSAGE_SIZE', '1048576'))  # 1MB
        self.queue_timeout = float(os.getenv('JUPYTER_COLLAB_QUEUE_TIMEOUT', '5.0'))  # 5 seconds
        
        # Background task
        self._processor_task: Optional[asyncio.Task] = None
        
        logger.info("MessageRouter initialized")
    
    async def start(self):
        """Start message processing"""
        if not self._processor_task:
            self._processor_task = asyncio.create_task(self._message_processor())
        logger.info("MessageRouter background task started")
    
    async def stop(self):
        """Stop message processing"""
        if self._processor_task:
            self._processor_task.cancel()
            try:
                await self._processor_task
            except asyncio.CancelledError:
                pass
        logger.info("MessageRouter stopped")
    
    async def route_crdt_operation(self, session_id: str, user_id: str, 
                                  operation_data: Dict[str, Any], 
                                  connection_id: str) -> bool:
        """Route CRDT operation to all session participants"""
        try:
            # Validate message size
            message_size = len(json.dumps(operation_data))
            if message_size > self.max_message_size:
                logger.warning(f"Message too large: {message_size} bytes from {user_id}")
                return False
            
            # Create CRDT operation
            operation = CRDTOperation(
                operation_id=str(uuid.uuid4()),
                document_id=f"notebook:{session_id}",
                client_id=operation_data.get('client_id', int(time.time() * 1000) % 2**31),
                user_id=user_id,
                timestamp=datetime.utcnow(),
                operation_type=operation_data.get('type', 'update'),
                operation_data=json.dumps(operation_data).encode('utf-8'),
                cell_id=operation_data.get('cell_id')
            )
            
            # Store operation in persistence layer
            await self.collaboration_manager.persistence.store_crdt_operation(operation)
            
            # Prepare broadcast message
            broadcast_message = {
                'type': 'crdt_operation',
                'operation_id': operation.operation_id,
                'client_id': operation.client_id,
                'user_id': user_id,
                'timestamp': operation.timestamp.isoformat(),
                'operation_type': operation.operation_type,
                'operation_data': operation_data,
                'cell_id': operation.cell_id
            }
            
            # Queue for processing
            try:
                await asyncio.wait_for(
                    self.message_queue.put({
                        'session_id': session_id,
                        'message': broadcast_message,
                        'exclude_connection_id': connection_id,
                        'timestamp': time.time()
                    }),
                    timeout=self.queue_timeout
                )
                
                return True
                
            except asyncio.TimeoutError:
                logger.warning(f"Message queue timeout for session {session_id}")
                self.dead_letter_queue.append({
                    'session_id': session_id,
                    'message': broadcast_message,
                    'timestamp': time.time(),
                    'error': 'queue_timeout'
                })
                return False
            
        except Exception as e:
            logger.error(f"Error routing CRDT operation: {e}")
            return False
    
    async def route_awareness_update(self, session_id: str, user_id: str,
                                   awareness_data: Dict[str, Any],
                                   connection_id: str) -> bool:
        """Route awareness/presence update to session participants"""
        try:
            # Update presence tracker
            await self.collaboration_manager.presence_tracker.update_presence(
                session_id, user_id, awareness_data
            )
            
            # Prepare awareness message
            awareness_message = {
                'type': 'awareness_update',
                'user_id': user_id,
                'awareness_data': awareness_data,
                'timestamp': time.time()
            }
            
            # Broadcast immediately (don't queue - awareness needs low latency)
            await self.collaboration_manager.websocket_pool.broadcast_to_session(
                session_id, awareness_message, exclude_connection_id=connection_id
            )
            
            return True
            
        except Exception as e:
            logger.error(f"Error routing awareness update: {e}")
            return False
    
    async def route_lock_operation(self, session_id: str, user_id: str,
                                 lock_data: Dict[str, Any],
                                 connection_id: str) -> Dict[str, Any]:
        """Route cell lock operation"""
        try:
            operation = lock_data.get('operation')
            cell_id = lock_data.get('cell_id')
            
            if not operation or not cell_id:
                return {'success': False, 'error': 'Invalid lock operation data'}
            
            # Get session state for notebook path
            session_state = self.collaboration_manager.session_registry.get_session(session_id)
            if not session_state:
                return {'success': False, 'error': 'Session not found'}
            
            # Route to appropriate lock operation
            if operation == 'acquire':
                result = await self.collaboration_manager.lock_manager.acquire_cell_lock(
                    session_state.notebook_path, cell_id, user_id, session_id
                )
            elif operation == 'release':
                result = await self.collaboration_manager.lock_manager.release_cell_lock(
                    session_state.notebook_path, cell_id, user_id, session_id
                )
            elif operation == 'extend':
                result = await self.collaboration_manager.lock_manager.extend_cell_lock(
                    session_state.notebook_path, cell_id, user_id, session_id
                )
            else:
                return {'success': False, 'error': f'Unknown lock operation: {operation}'}
            
            return result
            
        except Exception as e:
            logger.error(f"Error routing lock operation: {e}")
            return {'success': False, 'error': str(e)}
    
    async def _message_processor(self):
        """Background task to process message queue"""
        while True:
            try:
                # Get message from queue
                message_item = await self.message_queue.get()
                
                try:
                    # Process the message
                    await self.collaboration_manager.websocket_pool.broadcast_to_session(
                        message_item['session_id'],
                        message_item['message'],
                        exclude_connection_id=message_item.get('exclude_connection_id')
                    )
                    
                    # Mark as processed
                    self.message_queue.task_done()
                    
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    # Move to dead letter queue
                    self.dead_letter_queue.append({
                        **message_item,
                        'error': str(e),
                        'processing_timestamp': time.time()
                    })
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in message processor: {e}")


class AuthenticationBridge:
    """JupyterHub integration for user identity and permissions"""
    
    def __init__(self, collaboration_manager: 'CollaborationManager'):
        self.collaboration_manager = collaboration_manager
        
        # Configuration
        self.auth_timeout = float(os.getenv('JUPYTER_COLLAB_AUTH_TIMEOUT', '30.0'))  # 30 seconds
        self.session_token_ttl = int(os.getenv('JUPYTER_COLLAB_SESSION_TOKEN_TTL', '3600'))  # 1 hour
        
        # Token cache for performance
        self.token_cache: Dict[str, Dict[str, Any]] = {}
        
        logger.info("AuthenticationBridge initialized")
    
    async def authenticate_user(self, request_handler: JupyterHandler) -> Optional[Dict[str, Any]]:
        """Authenticate user from Jupyter request handler"""
        try:
            # Get user from current handler (already authenticated by Jupyter)
            user = request_handler.current_user
            if not user:
                logger.warning("No authenticated user found")
                return None
            
            user_info = {
                'user_id': user['name'],
                'display_name': user.get('display_name', user['name']),
                'groups': user.get('groups', []),
                'admin': user.get('admin', False),
                'last_activity': user.get('last_activity'),
                'pending': user.get('pending'),
            }
            
            # Add session token for WebSocket authentication
            session_token = self._generate_session_token(user_info['user_id'])
            user_info['session_token'] = session_token
            
            # Cache token
            self.token_cache[session_token] = {
                'user_info': user_info,
                'expires_at': time.time() + self.session_token_ttl,
                'issued_at': time.time()
            }
            
            logger.debug(f"User authenticated: {user_info['user_id']}")
            return user_info
            
        except Exception as e:
            logger.error(f"Error authenticating user: {e}")
            return None
    
    async def validate_session_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Validate session token for WebSocket authentication"""
        try:
            # Check cache first
            cached_token = self.token_cache.get(token)
            if cached_token:
                if cached_token['expires_at'] > time.time():
                    return cached_token['user_info']
                else:
                    # Token expired, remove from cache
                    del self.token_cache[token]
            
            logger.warning(f"Invalid or expired session token")
            return None
            
        except Exception as e:
            logger.error(f"Error validating session token: {e}")
            return None
    
    async def validate_permission(self, user_id: str, session_id: str, 
                                required_permission: str) -> bool:
        """Validate user permission for specific action"""
        try:
            # Use persistence layer to validate permissions
            return await self.collaboration_manager.persistence.validate_user_permission(
                user_id, session_id, required_permission
            )
            
        except Exception as e:
            logger.error(f"Error validating permission: {e}")
            return False
    
    async def grant_permission(self, granter_user_id: str, target_user_id: str,
                             session_id: str, permission_level: str,
                             expires_at: Optional[datetime] = None) -> bool:
        """Grant permission to user for session"""
        try:
            # Validate that granter has admin permissions
            can_grant = await self.validate_permission(granter_user_id, session_id, 'admin')
            if not can_grant:
                logger.warning(f"User {granter_user_id} cannot grant permissions")
                return False
            
            # Create permission
            permission = UserPermission(
                user_id=target_user_id,
                session_id=session_id,
                permission_level=permission_level,
                granted_by=granter_user_id,
                granted_at=datetime.utcnow(),
                expires_at=expires_at
            )
            
            await self.collaboration_manager.persistence.manage_user_permissions(permission)
            
            logger.info(f"Permission granted: {target_user_id} -> {permission_level} in {session_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error granting permission: {e}")
            return False
    
    def _generate_session_token(self, user_id: str) -> str:
        """Generate secure session token for WebSocket authentication"""
        import secrets
        token_data = f"{user_id}:{time.time()}:{secrets.token_hex(16)}"
        return hashlib.sha256(token_data.encode()).hexdigest()
    
    def cleanup_expired_tokens(self):
        """Clean up expired tokens from cache"""
        current_time = time.time()
        expired_tokens = [
            token for token, data in self.token_cache.items()
            if data['expires_at'] < current_time
        ]
        
        for token in expired_tokens:
            del self.token_cache[token]
        
        if expired_tokens:
            logger.debug(f"Cleaned up {len(expired_tokens)} expired tokens")


class CollaborationManager:
    """
    Central CollaborationManager class providing comprehensive session lifecycle management,
    user coordination, cross-instance session state synchronization, and real-time message
    routing for collaborative editing.
    
    This is the main orchestrator that coordinates all collaborative editing operations,
    managing WebSocket connections, persistence, authentication, and real-time synchronization.
    """
    
    def __init__(self, persistence_config: Optional[Dict[str, str]] = None):
        """Initialize CollaborationManager with configuration"""
        self.persistence_config = persistence_config or {}
        
        # Core components (initialized during startup)
        self.persistence: Optional[PersistenceLayer] = None
        self.websocket_pool: Optional[WebSocketPool] = None
        self.session_registry: Optional[SessionRegistry] = None
        self.presence_tracker: Optional[PresenceTracker] = None
        self.lock_manager: Optional[LockManager] = None
        self.message_router: Optional[MessageRouter] = None
        self.auth_bridge: Optional[AuthenticationBridge] = None
        
        # State tracking
        self.is_running = False
        self.startup_time: Optional[datetime] = None
        
        # Configuration
        self.enabled = os.getenv('JUPYTER_COLLAB_ENABLED', 'true').lower() == 'true'
        self.degraded_mode = False
        
        # Thread pool for blocking operations
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='collab-')
        
        logger.info(f"CollaborationManager initialized (enabled: {self.enabled})")
    
    async def initialize(self) -> bool:
        """Initialize all collaboration components with error handling"""
        if not self.enabled:
            logger.info("Collaboration features disabled")
            return True
        
        try:
            logger.info("Initializing collaboration infrastructure...")
            
            # Initialize persistence layer first
            self.persistence = await create_persistence_layer(self.persistence_config)
            
            # Initialize core components
            self.websocket_pool = WebSocketPool(self)
            self.session_registry = SessionRegistry(self)
            self.presence_tracker = PresenceTracker(self)
            self.lock_manager = LockManager(self)
            self.message_router = MessageRouter(self)
            self.auth_bridge = AuthenticationBridge(self)
            
            # Start background tasks
            await self.websocket_pool.start()
            await self.session_registry.start()
            await self.presence_tracker.start()
            await self.message_router.start()
            
            self.is_running = True
            self.startup_time = datetime.utcnow()
            
            logger.info("Collaboration infrastructure initialized successfully")
            return True
            
        except Exception as e:
            logger.error(f"Failed to initialize collaboration infrastructure: {e}")
            
            # Enter degraded mode
            self.degraded_mode = True
            self.enabled = False
            
            # Try to cleanup any partial initialization
            await self._cleanup_components()
            
            return False
    
    async def shutdown(self):
        """Graceful shutdown of collaboration manager"""
        if not self.is_running:
            return
        
        logger.info("Shutting down collaboration infrastructure...")
        
        try:
            # Stop background tasks first
            if self.message_router:
                await self.message_router.stop()
            if self.presence_tracker:
                await self.presence_tracker.stop()
            if self.session_registry:
                await self.session_registry.stop()
            if self.websocket_pool:
                await self.websocket_pool.stop()
            
            # Close persistence layer
            if self.persistence:
                await self.persistence.close()
            
            # Shutdown thread pool
            self.executor.shutdown(wait=True)
            
            self.is_running = False
            
            logger.info("Collaboration infrastructure shutdown completed")
            
        except Exception as e:
            logger.error(f"Error during shutdown: {e}")
    
    async def create_session(self, notebook_path: str, user_id: str,
                           permissions: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """Create new collaborative session"""
        if not self.enabled:
            return None
        
        try:
            return await self.session_registry.create_session(
                notebook_path, user_id, permissions
            )
        except Exception as e:
            logger.error(f"Error creating session: {e}")
            return None
    
    async def join_session(self, session_id: str, user_id: str,
                         websocket: tornado.websocket.WebSocketHandler,
                         user_agent: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Join existing collaborative session"""
        if not self.enabled:
            return None
        
        try:
            # Add WebSocket connection
            connection_id = await self.websocket_pool.add_connection(
                websocket, user_id, session_id, user_agent
            )
            
            # Join session registry
            session_state = await self.session_registry.join_session(
                session_id, user_id, connection_id
            )
            
            if not session_state:
                await self.websocket_pool.remove_connection(
                    connection_id, reason="session_join_failed"
                )
                return None
            
            # Initialize user presence
            await self.presence_tracker.update_presence(session_id, user_id, {
                'status': 'active',
                'joined_at': time.time()
            })
            
            # Get current session state for client
            current_locks = await self.lock_manager.get_session_locks(session_id)
            current_presence = await self.presence_tracker.get_session_presence(session_id)
            
            return {
                'connection_id': connection_id,
                'session_state': {
                    'session_id': session_id,
                    'notebook_path': session_state.notebook_path,
                    'participant_count': session_state.participant_count,
                    'document_version': session_state.document_version,
                    'locked_cells': current_locks,
                    'participants': current_presence
                }
            }
            
        except Exception as e:
            logger.error(f"Error joining session: {e}")
            return None
    
    async def handle_websocket_message(self, connection_id: str, message: Dict[str, Any]) -> bool:
        """Handle incoming WebSocket message"""
        if not self.enabled:
            return False
        
        try:
            connection = self.websocket_pool.get_connection(connection_id)
            if not connection:
                logger.warning(f"Message from unknown connection: {connection_id}")
                return False
            
            message_type = message.get('type')
            user_id = connection.user_id
            session_id = connection.session_id
            
            # Update heartbeat
            await self.websocket_pool.update_heartbeat(connection_id)
            
            # Route message based on type
            if message_type == 'crdt_operation':
                return await self.message_router.route_crdt_operation(
                    session_id, user_id, message.get('data', {}), connection_id
                )
            
            elif message_type == 'awareness_update':
                return await self.message_router.route_awareness_update(
                    session_id, user_id, message.get('data', {}), connection_id
                )
            
            elif message_type == 'lock_operation':
                result = await self.message_router.route_lock_operation(
                    session_id, user_id, message.get('data', {}), connection_id
                )
                
                # Send response back to client
                response = {
                    'type': 'lock_operation_response',
                    'data': result
                }
                await connection.websocket.write_message(json.dumps(response))
                return result.get('success', False)
            
            elif message_type == 'heartbeat':
                # Send heartbeat response
                response = {
                    'type': 'heartbeat_response',
                    'timestamp': time.time()
                }
                await connection.websocket.write_message(json.dumps(response))
                return True
            
            else:
                logger.warning(f"Unknown message type: {message_type}")
                return False
            
        except Exception as e:
            logger.error(f"Error handling WebSocket message: {e}")
            return False
    
    async def handle_user_disconnect(self, user_id: str, session_id: str, connection_id: str):
        """Handle user disconnection and cleanup"""
        try:
            # Remove from session registry
            await self.session_registry.leave_session(session_id, user_id, connection_id)
            
            # Release all user locks
            await self.lock_manager.release_user_locks(user_id, session_id)
            
            # Remove presence
            await self.presence_tracker.remove_presence(session_id, user_id)
            
            # Broadcast disconnect to other users
            disconnect_message = {
                'type': 'user_disconnected',
                'user_id': user_id,
                'timestamp': time.time()
            }
            
            await self.websocket_pool.broadcast_to_session(
                session_id, disconnect_message, exclude_user_id=user_id
            )
            
            logger.debug(f"User disconnected: {user_id} from session {session_id}")
            
        except Exception as e:
            logger.error(f"Error handling user disconnect: {e}")
    
    async def get_health_status(self) -> Dict[str, Any]:
        """Get comprehensive health status of collaboration system"""
        if not self.enabled:
            return {
                'enabled': False,
                'status': 'disabled',
                'message': 'Collaboration features are disabled'
            }
        
        try:
            # Get persistence health
            persistence_health = {}
            if self.persistence:
                persistence_health = await self.persistence.get_health_status()
            
            # Get component statistics
            websocket_stats = {}
            session_stats = {}
            
            if self.websocket_pool:
                websocket_stats = await self.websocket_pool.get_connection_stats()
            
            if self.session_registry:
                session_stats = await self.session_registry.get_session_stats()
            
            # Calculate overall health
            overall_status = 'healthy'
            if self.degraded_mode:
                overall_status = 'degraded'
            elif not persistence_health.get('collaboration_ready', False):
                overall_status = 'degraded'
            
            return {
                'enabled': True,
                'status': overall_status,
                'startup_time': self.startup_time.isoformat() if self.startup_time else None,
                'uptime_seconds': (datetime.utcnow() - self.startup_time).total_seconds() if self.startup_time else 0,
                'degraded_mode': self.degraded_mode,
                'persistence': persistence_health,
                'websocket_pool': websocket_stats,
                'sessions': session_stats,
                'message_queue_size': self.message_router.message_queue.qsize() if self.message_router else 0,
                'dead_letter_queue_size': len(self.message_router.dead_letter_queue) if self.message_router else 0
            }
            
        except Exception as e:
            logger.error(f"Error getting health status: {e}")
            return {
                'enabled': True,
                'status': 'error',
                'error': str(e)
            }
    
    async def _cleanup_components(self):
        """Cleanup partially initialized components"""
        try:
            if self.message_router:
                await self.message_router.stop()
            if self.presence_tracker:
                await self.presence_tracker.stop()
            if self.session_registry:
                await self.session_registry.stop()
            if self.websocket_pool:
                await self.websocket_pool.stop()
            if self.persistence:
                await self.persistence.close()
        except Exception as e:
            logger.error(f"Error during component cleanup: {e}")


# Global collaboration manager instance
_collaboration_manager: Optional[CollaborationManager] = None


async def get_collaboration_manager(persistence_config: Optional[Dict[str, str]] = None) -> CollaborationManager:
    """Get or create global collaboration manager instance"""
    global _collaboration_manager
    
    if _collaboration_manager is None:
        _collaboration_manager = CollaborationManager(persistence_config)
        await _collaboration_manager.initialize()
    
    return _collaboration_manager


async def shutdown_collaboration_manager():
    """Shutdown global collaboration manager"""
    global _collaboration_manager
    
    if _collaboration_manager:
        await _collaboration_manager.shutdown()
        _collaboration_manager = None


# Convenience functions for external integration
async def create_collaboration_session(notebook_path: str, user_id: str,
                                     permissions: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Create new collaborative session (convenience function)"""
    manager = await get_collaboration_manager()
    return await manager.create_session(notebook_path, user_id, permissions)


async def join_collaboration_session(session_id: str, user_id: str,
                                   websocket: tornado.websocket.WebSocketHandler,
                                   user_agent: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Join collaborative session (convenience function)"""
    manager = await get_collaboration_manager()
    return await manager.join_session(session_id, user_id, websocket, user_agent)


async def get_collaboration_health() -> Dict[str, Any]:
    """Get collaboration system health status (convenience function)"""
    try:
        manager = await get_collaboration_manager()
        return await manager.get_health_status()
    except Exception as e:
        return {
            'enabled': False,
            'status': 'error',
            'error': str(e)
        }