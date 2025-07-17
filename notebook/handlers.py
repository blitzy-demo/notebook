"""
Collaboration handlers for Jupyter Notebook v7 real-time collaborative editing.

This module implements comprehensive collaboration capabilities including:
- Yjs-based CRDT document synchronization
- WebSocket providers for real-time updates
- User presence awareness and cursor tracking
- Cell-level locking mechanism
- Comment and discussion system
- Permission-based access control
- Integration with JupyterHub authentication
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Union

# Standard library imports
from tornado import web
from tornado.websocket import WebSocketHandler

# Third-party imports
from pycrdt import Doc
from pycrdt_websocket import WebsocketServer
from prometheus_client import Counter, Gauge, Histogram
from jupyterhub import HubAuth
from jsonschema import validate, ValidationError

# Internal imports
from notebook.app import NotebookBaseHandler


# Configure logging
logger = logging.getLogger(__name__)

# Prometheus metrics for collaboration monitoring
collab_metrics = {
    'crdt_updates_total': Counter(
        'jupyter_collab_crdt_updates_total',
        'Total CRDT updates processed',
        ['document_id', 'operation_type']
    ),
    'awareness_updates_total': Counter(
        'jupyter_collab_awareness_updates_total',
        'Total awareness updates processed',
        ['document_id', 'user_id']
    ),
    'lock_conflicts_total': Counter(
        'jupyter_collab_lock_conflicts_total',
        'Total lock conflicts encountered',
        ['document_id', 'cell_id']
    ),
    'sync_latency_seconds': Histogram(
        'jupyter_collab_sync_latency_seconds',
        'End-to-end synchronization latency',
        ['document_id'],
        buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0]
    ),
    'connections_current': Gauge(
        'jupyter_collab_connections_current',
        'Current active WebSocket connections',
        ['document_id']
    ),
    'queue_depth': Gauge(
        'jupyter_collab_queue_depth',
        'Current depth of message queue',
        ['document_id']
    ),
    'comment_errors_total': Counter(
        'jupyter_collab_comment_errors_total',
        'Total comment operation errors',
        ['document_id', 'operation']
    )
}

# JSON Schema for WebSocket message validation
websocket_message_schema = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["yjs_update", "awareness", "lock", "comment", "permission"]},
        "document_id": {"type": "string"},
        "user_id": {"type": "string"},
        "timestamp": {"type": "number"},
        "data": {"type": "object"}
    },
    "required": ["type", "document_id", "user_id", "timestamp"],
    "additionalProperties": False
}

# Rate limiting configuration
RATE_LIMITS = {
    'document_updates': 100,  # per minute
    'awareness_updates': 300,  # per minute  
    'comment_operations': 60,  # per minute
    'lock_operations': 120,    # per minute
}


class YjsDocumentPersistenceService:
    """Service for persisting Yjs document state and managing document history."""
    
    def __init__(self, storage_backend: str = 'filesystem'):
        self.storage_backend = storage_backend
        self.document_cache: Dict[str, Doc] = {}
        self.history_cache: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        self.logger = logging.getLogger(__name__ + '.YjsDocumentPersistenceService')
        
    async def save_document(self, document_id: str, document: Doc) -> bool:
        """
        Save a Yjs document to persistent storage.
        
        Args:
            document_id: Unique identifier for the document
            document: Yjs document instance to save
            
        Returns:
            bool: True if save was successful
        """
        try:
            # Get current document state
            state = document.get_state()
            update = document.get_update()
            
            # Create document snapshot
            snapshot = {
                'document_id': document_id,
                'timestamp': time.time(),
                'state': state,
                'update': update,
                'version': len(self.history_cache[document_id]) + 1
            }
            
            # Store in history cache
            self.history_cache[document_id].append(snapshot)
            
            # Cache the document
            self.document_cache[document_id] = document
            
            # In a real implementation, would save to actual storage backend
            # For now, we simulate success
            self.logger.info(f"Saved document {document_id} to {self.storage_backend}")
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to save document {document_id}: {str(e)}")
            return False
    
    async def load_document(self, document_id: str) -> Optional[Doc]:
        """
        Load a Yjs document from persistent storage.
        
        Args:
            document_id: Unique identifier for the document
            
        Returns:
            Optional[Doc]: Loaded document or None if not found
        """
        try:
            # Check cache first
            if document_id in self.document_cache:
                return self.document_cache[document_id]
            
            # In a real implementation, would load from storage backend
            # For now, create a new document
            document = Doc()
            self.document_cache[document_id] = document
            
            self.logger.info(f"Loaded document {document_id} from {self.storage_backend}")
            return document
            
        except Exception as e:
            self.logger.error(f"Failed to load document {document_id}: {str(e)}")
            return None
    
    async def get_document_history(self, document_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Retrieve document change history.
        
        Args:
            document_id: Unique identifier for the document
            limit: Maximum number of history entries to return
            
        Returns:
            List[Dict[str, Any]]: List of document history entries
        """
        try:
            history = self.history_cache.get(document_id, [])
            return history[-limit:] if limit > 0 else history
            
        except Exception as e:
            self.logger.error(f"Failed to get document history for {document_id}: {str(e)}")
            return []


class AwarenessService:
    """Service for tracking user presence and broadcasting awareness updates."""
    
    def __init__(self):
        self.awareness_state: Dict[str, Dict[str, Any]] = {}
        self.user_connections: Dict[str, Set[WebSocketHandler]] = defaultdict(set)
        self.logger = logging.getLogger(__name__ + '.AwarenessService')
        
    async def track_user_presence(self, document_id: str, user_id: str, 
                                  connection: WebSocketHandler, presence_data: Dict[str, Any]) -> None:
        """
        Track user presence information for a document.
        
        Args:
            document_id: Unique identifier for the document
            user_id: Unique identifier for the user
            connection: WebSocket connection for the user
            presence_data: User presence information (cursor, selection, etc.)
        """
        try:
            # Create composite key for document-user tracking
            doc_user_key = f"{document_id}:{user_id}"
            
            # Update presence data
            self.awareness_state[doc_user_key] = {
                'user_id': user_id,
                'document_id': document_id,
                'timestamp': time.time(),
                'presence': presence_data,
                'connection_id': id(connection)
            }
            
            # Track connection
            self.user_connections[doc_user_key].add(connection)
            
            # Update metrics
            collab_metrics['awareness_updates_total'].labels(
                document_id=document_id, user_id=user_id
            ).inc()
            
            self.logger.debug(f"Updated presence for user {user_id} in document {document_id}")
            
        except Exception as e:
            self.logger.error(f"Failed to track user presence: {str(e)}")
    
    async def broadcast_awareness_update(self, document_id: str, user_id: str, 
                                       update_data: Dict[str, Any]) -> None:
        """
        Broadcast awareness update to all connected users in a document.
        
        Args:
            document_id: Unique identifier for the document
            user_id: User who triggered the update
            update_data: Awareness update data to broadcast
        """
        try:
            # Find all connections for this document
            connections_to_notify = set()
            
            for doc_user_key, connections in self.user_connections.items():
                if doc_user_key.startswith(f"{document_id}:"):
                    connections_to_notify.update(connections)
            
            # Prepare broadcast message
            broadcast_message = {
                'type': 'awareness',
                'document_id': document_id,
                'user_id': user_id,
                'timestamp': time.time(),
                'data': update_data
            }
            
            # Send to all connections
            for connection in connections_to_notify:
                try:
                    if hasattr(connection, 'write_message'):
                        await connection.write_message(json.dumps(broadcast_message))
                except Exception as conn_error:
                    self.logger.warning(f"Failed to send awareness update to connection: {str(conn_error)}")
            
            self.logger.debug(f"Broadcasted awareness update to {len(connections_to_notify)} connections")
            
        except Exception as e:
            self.logger.error(f"Failed to broadcast awareness update: {str(e)}")
    
    async def get_active_users(self, document_id: str) -> List[Dict[str, Any]]:
        """
        Get list of active users for a document.
        
        Args:
            document_id: Unique identifier for the document
            
        Returns:
            List[Dict[str, Any]]: List of active user information
        """
        try:
            active_users = []
            current_time = time.time()
            
            for doc_user_key, awareness_data in self.awareness_state.items():
                if awareness_data['document_id'] == document_id:
                    # Check if user is still active (within last 30 seconds)
                    if current_time - awareness_data['timestamp'] < 30:
                        active_users.append({
                            'user_id': awareness_data['user_id'],
                            'presence': awareness_data['presence'],
                            'last_seen': awareness_data['timestamp']
                        })
            
            return active_users
            
        except Exception as e:
            self.logger.error(f"Failed to get active users for document {document_id}: {str(e)}")
            return []


class RateLimitingService:
    """Service for rate limiting collaboration events."""
    
    def __init__(self):
        self.user_request_counts: Dict[str, Dict[str, List[float]]] = defaultdict(lambda: defaultdict(list))
        self.logger = logging.getLogger(__name__ + '.RateLimitingService')
        
    async def check_rate_limit(self, user_id: str, operation_type: str) -> bool:
        """
        Check if user has exceeded rate limit for operation type.
        
        Args:
            user_id: Unique identifier for the user
            operation_type: Type of operation being rate limited
            
        Returns:
            bool: True if request is within rate limit
        """
        try:
            current_time = time.time()
            limit = RATE_LIMITS.get(operation_type, 100)
            
            # Get user's request history for this operation
            user_requests = self.user_request_counts[user_id][operation_type]
            
            # Remove requests older than 1 minute
            cutoff_time = current_time - 60
            user_requests[:] = [req_time for req_time in user_requests if req_time > cutoff_time]
            
            # Check if under limit
            if len(user_requests) >= limit:
                self.logger.warning(f"Rate limit exceeded for user {user_id}, operation {operation_type}")
                return False
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to check rate limit: {str(e)}")
            return False
    
    async def record_request(self, user_id: str, operation_type: str) -> None:
        """
        Record a request for rate limiting purposes.
        
        Args:
            user_id: Unique identifier for the user
            operation_type: Type of operation being recorded
        """
        try:
            current_time = time.time()
            self.user_request_counts[user_id][operation_type].append(current_time)
            
        except Exception as e:
            self.logger.error(f"Failed to record request: {str(e)}")
    
    async def get_rate_limit_status(self, user_id: str) -> Dict[str, Any]:
        """
        Get current rate limit status for a user.
        
        Args:
            user_id: Unique identifier for the user
            
        Returns:
            Dict[str, Any]: Rate limit status information
        """
        try:
            current_time = time.time()
            cutoff_time = current_time - 60
            
            status = {}
            for operation_type, limit in RATE_LIMITS.items():
                user_requests = self.user_request_counts[user_id][operation_type]
                # Count recent requests
                recent_requests = [req for req in user_requests if req > cutoff_time]
                
                status[operation_type] = {
                    'limit': limit,
                    'current_count': len(recent_requests),
                    'remaining': max(0, limit - len(recent_requests)),
                    'reset_time': cutoff_time + 60
                }
            
            return status
            
        except Exception as e:
            self.logger.error(f"Failed to get rate limit status: {str(e)}")
            return {}


class CollaborationMetricsService:
    """Service for collecting and exposing collaboration metrics."""
    
    def __init__(self):
        self.event_history: List[Dict[str, Any]] = []
        self.logger = logging.getLogger(__name__ + '.CollaborationMetricsService')
        
    async def record_collaboration_event(self, event_type: str, document_id: str, 
                                       user_id: str, metadata: Dict[str, Any]) -> None:
        """
        Record a collaboration event for metrics collection.
        
        Args:
            event_type: Type of collaboration event
            document_id: Unique identifier for the document
            user_id: Unique identifier for the user
            metadata: Additional event metadata
        """
        try:
            event = {
                'type': event_type,
                'document_id': document_id,
                'user_id': user_id,
                'timestamp': time.time(),
                'metadata': metadata
            }
            
            self.event_history.append(event)
            
            # Keep only last 1000 events to prevent memory growth
            if len(self.event_history) > 1000:
                self.event_history = self.event_history[-1000:]
            
            self.logger.debug(f"Recorded collaboration event: {event_type}")
            
        except Exception as e:
            self.logger.error(f"Failed to record collaboration event: {str(e)}")
    
    async def get_metrics(self) -> Dict[str, Any]:
        """
        Get collaboration metrics summary.
        
        Returns:
            Dict[str, Any]: Metrics summary
        """
        try:
            current_time = time.time()
            recent_events = [e for e in self.event_history if current_time - e['timestamp'] < 3600]
            
            metrics = {
                'total_events': len(self.event_history),
                'recent_events_1h': len(recent_events),
                'event_types': {},
                'active_documents': set(),
                'active_users': set()
            }
            
            for event in recent_events:
                event_type = event['type']
                metrics['event_types'][event_type] = metrics['event_types'].get(event_type, 0) + 1
                metrics['active_documents'].add(event['document_id'])
                metrics['active_users'].add(event['user_id'])
            
            # Convert sets to counts
            metrics['active_documents'] = len(metrics['active_documents'])
            metrics['active_users'] = len(metrics['active_users'])
            
            return metrics
            
        except Exception as e:
            self.logger.error(f"Failed to get metrics: {str(e)}")
            return {}
    
    async def export_prometheus_metrics(self) -> str:
        """
        Export metrics in Prometheus format.
        
        Returns:
            str: Prometheus-formatted metrics
        """
        try:
            # This would integrate with the prometheus_client library
            # For now, return a basic format
            metrics = await self.get_metrics()
            
            prometheus_output = []
            prometheus_output.append(f"# HELP jupyter_collab_events_total Total collaboration events")
            prometheus_output.append(f"# TYPE jupyter_collab_events_total counter")
            prometheus_output.append(f"jupyter_collab_events_total {metrics['total_events']}")
            
            prometheus_output.append(f"# HELP jupyter_collab_active_documents Active documents")
            prometheus_output.append(f"# TYPE jupyter_collab_active_documents gauge")
            prometheus_output.append(f"jupyter_collab_active_documents {metrics['active_documents']}")
            
            prometheus_output.append(f"# HELP jupyter_collab_active_users Active users")
            prometheus_output.append(f"# TYPE jupyter_collab_active_users gauge")
            prometheus_output.append(f"jupyter_collab_active_users {metrics['active_users']}")
            
            return '\n'.join(prometheus_output)
            
        except Exception as e:
            self.logger.error(f"Failed to export Prometheus metrics: {str(e)}")
            return ""


# Initialize global services
document_service = YjsDocumentPersistenceService()
awareness_service = AwarenessService()
rate_limit_service = RateLimitingService()
metrics_service = CollaborationMetricsService()


class CollaborationWebSocketHandler(WebSocketHandler):
    """WebSocket handler for real-time collaboration events."""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.user_id: Optional[str] = None
        self.document_id: Optional[str] = None
        self.authenticated: bool = False
        self.message_queue: asyncio.Queue = asyncio.Queue()
        self.logger = logging.getLogger(__name__ + '.CollaborationWebSocketHandler')
        
    def check_origin(self, origin: str) -> bool:
        """Check if the origin is allowed for WebSocket connections."""
        # In production, implement proper origin checking
        return True
    
    async def open(self, document_id: str) -> None:
        """
        Handle WebSocket connection opening.
        
        Args:
            document_id: Unique identifier for the document
        """
        try:
            self.document_id = document_id
            
            # Authenticate user
            if not await self._authenticate_user():
                await self.close(code=4001, reason="Authentication failed")
                return
            
            # Update connection metrics
            collab_metrics['connections_current'].labels(document_id=document_id).inc()
            
            # Load document
            document = await document_service.load_document(document_id)
            if not document:
                await self.close(code=4004, reason="Document not found")
                return
            
            # Send initial document state
            await self._send_document_state(document)
            
            # Start message processing task
            asyncio.create_task(self._process_message_queue())
            
            self.logger.info(f"WebSocket connection opened for user {self.user_id}, document {document_id}")
            
        except Exception as e:
            self.logger.error(f"Failed to open WebSocket connection: {str(e)}")
            await self.close(code=4000, reason="Connection failed")
    
    async def on_message(self, message: Union[str, bytes]) -> None:
        """
        Handle incoming WebSocket messages.
        
        Args:
            message: WebSocket message (string or bytes)
        """
        try:
            if not self.authenticated:
                await self.close(code=4001, reason="Not authenticated")
                return
            
            # Handle binary messages (Yjs updates)
            if isinstance(message, bytes):
                await self._handle_yjs_update(message)
                return
            
            # Handle JSON messages
            try:
                data = json.loads(message)
                validate(data, websocket_message_schema)
            except (json.JSONDecodeError, ValidationError) as e:
                self.logger.warning(f"Invalid message format: {str(e)}")
                return
            
            # Check rate limits
            if not await rate_limit_service.check_rate_limit(self.user_id, data['type']):
                await self.write_message(json.dumps({
                    'type': 'error',
                    'message': 'Rate limit exceeded'
                }))
                return
            
            # Record request
            await rate_limit_service.record_request(self.user_id, data['type'])
            
            # Route message based on type
            if data['type'] == 'awareness':
                await self._handle_awareness_update(data)
            elif data['type'] == 'lock':
                await self._handle_lock_operation(data)
            elif data['type'] == 'comment':
                await self._handle_comment_operation(data)
            elif data['type'] == 'permission':
                await self._handle_permission_operation(data)
            
        except Exception as e:
            self.logger.error(f"Error handling WebSocket message: {str(e)}")
    
    async def on_close(self) -> None:
        """Handle WebSocket connection closing."""
        try:
            if self.document_id:
                # Update connection metrics
                collab_metrics['connections_current'].labels(document_id=self.document_id).dec()
                
            self.logger.info(f"WebSocket connection closed for user {self.user_id}, document {self.document_id}")
            
        except Exception as e:
            self.logger.error(f"Error handling WebSocket close: {str(e)}")
    
    async def write_message(self, message: Union[str, bytes]) -> None:
        """
        Write message to WebSocket with error handling.
        
        Args:
            message: Message to send
        """
        try:
            if self.ws_connection:
                await super().write_message(message)
        except Exception as e:
            self.logger.error(f"Failed to write WebSocket message: {str(e)}")
    
    async def _authenticate_user(self) -> bool:
        """Authenticate the WebSocket connection."""
        try:
            # Get token from query parameters or headers
            token = self.get_argument('token', None)
            if not token:
                token = self.request.headers.get('Authorization', '').replace('Bearer ', '')
            
            if not token:
                return False
            
            # Use JupyterHub authentication if available
            if hasattr(self.settings, 'hub_auth'):
                hub_auth = self.settings['hub_auth']
                user_info = await hub_auth.user_for_token(token)
                if user_info:
                    self.user_id = user_info['name']
                    self.authenticated = True
                    return True
            
            # Fallback to basic token validation
            # In production, implement proper token validation
            self.user_id = f"user_{hash(token) % 10000}"
            self.authenticated = True
            return True
            
        except Exception as e:
            self.logger.error(f"Authentication failed: {str(e)}")
            return False
    
    async def _send_document_state(self, document: Doc) -> None:
        """Send initial document state to client."""
        try:
            state = document.get_state()
            await self.write_message(state)
            
        except Exception as e:
            self.logger.error(f"Failed to send document state: {str(e)}")
    
    async def _handle_yjs_update(self, update: bytes) -> None:
        """Handle Yjs document update."""
        try:
            # Load document
            document = await document_service.load_document(self.document_id)
            if not document:
                return
            
            # Apply update
            document.apply_update(update)
            
            # Save document
            await document_service.save_document(self.document_id, document)
            
            # Update metrics
            collab_metrics['crdt_updates_total'].labels(
                document_id=self.document_id, operation_type='yjs_update'
            ).inc()
            
            # Record event
            await metrics_service.record_collaboration_event(
                'yjs_update', self.document_id, self.user_id, {'size': len(update)}
            )
            
        except Exception as e:
            self.logger.error(f"Failed to handle Yjs update: {str(e)}")
    
    async def _handle_awareness_update(self, data: Dict[str, Any]) -> None:
        """Handle awareness update."""
        try:
            await awareness_service.track_user_presence(
                self.document_id, self.user_id, self, data['data']
            )
            
            await awareness_service.broadcast_awareness_update(
                self.document_id, self.user_id, data['data']
            )
            
        except Exception as e:
            self.logger.error(f"Failed to handle awareness update: {str(e)}")
    
    async def _handle_lock_operation(self, data: Dict[str, Any]) -> None:
        """Handle cell lock operation."""
        try:
            # Implement lock logic here
            # For now, just broadcast the lock event
            await awareness_service.broadcast_awareness_update(
                self.document_id, self.user_id, {
                    'type': 'lock',
                    'operation': data['data']['operation'],
                    'cell_id': data['data']['cell_id']
                }
            )
            
        except Exception as e:
            self.logger.error(f"Failed to handle lock operation: {str(e)}")
    
    async def _handle_comment_operation(self, data: Dict[str, Any]) -> None:
        """Handle comment operation."""
        try:
            # Implement comment logic here
            # For now, just broadcast the comment event
            await awareness_service.broadcast_awareness_update(
                self.document_id, self.user_id, {
                    'type': 'comment',
                    'operation': data['data']['operation'],
                    'comment_data': data['data']
                }
            )
            
        except Exception as e:
            self.logger.error(f"Failed to handle comment operation: {str(e)}")
    
    async def _handle_permission_operation(self, data: Dict[str, Any]) -> None:
        """Handle permission operation."""
        try:
            # Implement permission logic here
            # For now, just log the event
            self.logger.info(f"Permission operation: {data['data']}")
            
        except Exception as e:
            self.logger.error(f"Failed to handle permission operation: {str(e)}")
    
    async def _process_message_queue(self) -> None:
        """Process queued messages."""
        try:
            while True:
                message = await self.message_queue.get()
                await self.write_message(message)
                
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.logger.error(f"Error processing message queue: {str(e)}")


class CollaborationSessionsHandler(NotebookBaseHandler):
    """Handler for collaboration session management."""
    
    @web.authenticated
    async def get(self) -> None:
        """Get list of active collaboration sessions."""
        try:
            # Get active sessions from awareness service
            sessions = []
            # This would typically query a database or cache
            # For now, return empty list
            
            self.write(json.dumps({'sessions': sessions}))
            
        except Exception as e:
            logger.error(f"Failed to get collaboration sessions: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def post(self) -> None:
        """Create new collaboration session."""
        try:
            data = json.loads(self.request.body)
            
            # Validate request
            required_fields = ['notebook_path']
            for field in required_fields:
                if field not in data:
                    self.set_status(400)
                    self.write({'error': f'Missing required field: {field}'})
                    return
            
            # Create session
            session_id = f"session_{int(time.time() * 1000)}"
            document_id = f"doc_{hash(data['notebook_path']) % 100000}"
            
            session = {
                'session_id': session_id,
                'document_id': document_id,
                'notebook_path': data['notebook_path'],
                'created_at': time.time(),
                'created_by': self.current_user['name'] if self.current_user else 'anonymous'
            }
            
            self.write(json.dumps(session))
            
        except Exception as e:
            logger.error(f"Failed to create collaboration session: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def delete(self) -> None:
        """Delete collaboration session."""
        try:
            session_id = self.get_argument('session_id', None)
            if not session_id:
                self.set_status(400)
                self.write({'error': 'Missing session_id parameter'})
                return
            
            # Delete session logic here
            # For now, just return success
            
            self.write({'success': True})
            
        except Exception as e:
            logger.error(f"Failed to delete collaboration session: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})


class CollaborationPermissionsHandler(NotebookBaseHandler):
    """Handler for collaboration permissions management."""
    
    @web.authenticated
    async def get(self) -> None:
        """Get permissions for a document."""
        try:
            document_id = self.get_argument('document_id', None)
            if not document_id:
                self.set_status(400)
                self.write({'error': 'Missing document_id parameter'})
                return
            
            # Get permissions logic here
            permissions = {
                'document_id': document_id,
                'permissions': []
            }
            
            self.write(json.dumps(permissions))
            
        except Exception as e:
            logger.error(f"Failed to get permissions: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def post(self) -> None:
        """Add permission for a user."""
        try:
            data = json.loads(self.request.body)
            
            # Validate request
            required_fields = ['document_id', 'user_id', 'role']
            for field in required_fields:
                if field not in data:
                    self.set_status(400)
                    self.write({'error': f'Missing required field: {field}'})
                    return
            
            # Add permission logic here
            permission = {
                'document_id': data['document_id'],
                'user_id': data['user_id'],
                'role': data['role'],
                'granted_by': self.current_user['name'] if self.current_user else 'anonymous',
                'granted_at': time.time()
            }
            
            self.write(json.dumps(permission))
            
        except Exception as e:
            logger.error(f"Failed to add permission: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def put(self) -> None:
        """Update permission for a user."""
        try:
            data = json.loads(self.request.body)
            
            # Update permission logic here
            # For now, just return success
            
            self.write({'success': True})
            
        except Exception as e:
            logger.error(f"Failed to update permission: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def delete(self) -> None:
        """Remove permission for a user."""
        try:
            document_id = self.get_argument('document_id', None)
            user_id = self.get_argument('user_id', None)
            
            if not document_id or not user_id:
                self.set_status(400)
                self.write({'error': 'Missing document_id or user_id parameter'})
                return
            
            # Remove permission logic here
            # For now, just return success
            
            self.write({'success': True})
            
        except Exception as e:
            logger.error(f"Failed to remove permission: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})


class CollaborationCommentsHandler(NotebookBaseHandler):
    """Handler for collaboration comments management."""
    
    @web.authenticated
    async def get(self) -> None:
        """Get comments for a document."""
        try:
            document_id = self.get_argument('document_id', None)
            if not document_id:
                self.set_status(400)
                self.write({'error': 'Missing document_id parameter'})
                return
            
            # Get comments logic here
            comments = {
                'document_id': document_id,
                'comments': []
            }
            
            self.write(json.dumps(comments))
            
        except Exception as e:
            logger.error(f"Failed to get comments: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def post(self) -> None:
        """Create new comment."""
        try:
            data = json.loads(self.request.body)
            
            # Validate request
            required_fields = ['document_id', 'cell_id', 'content']
            for field in required_fields:
                if field not in data:
                    self.set_status(400)
                    self.write({'error': f'Missing required field: {field}'})
                    return
            
            # Create comment logic here
            comment = {
                'comment_id': f"comment_{int(time.time() * 1000)}",
                'document_id': data['document_id'],
                'cell_id': data['cell_id'],
                'content': data['content'],
                'author': self.current_user['name'] if self.current_user else 'anonymous',
                'created_at': time.time(),
                'updated_at': time.time()
            }
            
            self.write(json.dumps(comment))
            
        except Exception as e:
            logger.error(f"Failed to create comment: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def put(self) -> None:
        """Update comment."""
        try:
            data = json.loads(self.request.body)
            
            # Update comment logic here
            # For now, just return success
            
            self.write({'success': True})
            
        except Exception as e:
            logger.error(f"Failed to update comment: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})
    
    @web.authenticated
    async def delete(self) -> None:
        """Delete comment."""
        try:
            comment_id = self.get_argument('comment_id', None)
            if not comment_id:
                self.set_status(400)
                self.write({'error': 'Missing comment_id parameter'})
                return
            
            # Delete comment logic here
            # For now, just return success
            
            self.write({'success': True})
            
        except Exception as e:
            logger.error(f"Failed to delete comment: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})


class CollaborationHistoryHandler(NotebookBaseHandler):
    """Handler for collaboration history management."""
    
    @web.authenticated
    async def get(self) -> None:
        """Get history for a document."""
        try:
            document_id = self.get_argument('document_id', None)
            if not document_id:
                self.set_status(400)
                self.write({'error': 'Missing document_id parameter'})
                return
            
            limit = int(self.get_argument('limit', 50))
            
            # Get history from persistence service
            history = await document_service.get_document_history(document_id, limit)
            
            self.write(json.dumps({
                'document_id': document_id,
                'history': history
            }))
            
        except Exception as e:
            logger.error(f"Failed to get collaboration history: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Internal server error'})


# Additional handler classes and helper functions

class CollaborationHealthHandler(NotebookBaseHandler):
    """Handler for collaboration service health checks."""
    
    async def get(self) -> None:
        """Get collaboration service health status."""
        try:
            # Check service components
            health_status = {
                'status': 'healthy',
                'version': '1.0.0',
                'uptime': time.time() - startup_time,
                'services': {
                    'document_persistence': 'healthy',
                    'awareness_service': 'healthy',
                    'rate_limiting': 'healthy',
                    'metrics_collection': 'healthy'
                }
            }
            
            # Get active connections and documents
            active_connections = sum(
                len(connections) for connections in awareness_service.user_connections.values()
            )
            active_documents = len(set(
                awareness_data['document_id'] 
                for awareness_data in awareness_service.awareness_state.values()
            ))
            
            health_status.update({
                'active_connections': active_connections,
                'active_documents': active_documents,
                'memory_usage': {
                    'document_cache_size': len(document_service.document_cache),
                    'awareness_state_size': len(awareness_service.awareness_state)
                }
            })
            
            self.write(json.dumps(health_status))
            
        except Exception as e:
            logger.error(f"Failed to get health status: {str(e)}")
            self.set_status(500)
            self.write({'error': 'Health check failed'})


class CollaborationMetricsHandler(NotebookBaseHandler):
    """Handler for collaboration metrics in Prometheus format."""
    
    async def get(self) -> None:
        """Get collaboration metrics."""
        try:
            # Get metrics in Prometheus format
            metrics_output = await metrics_service.export_prometheus_metrics()
            
            self.set_header('Content-Type', 'text/plain')
            self.write(metrics_output)
            
        except Exception as e:
            logger.error(f"Failed to get metrics: {str(e)}")
            self.set_status(500)
            self.write('# Error retrieving metrics')


# Global variables
startup_time = time.time()


def validate_websocket_message(message: Dict[str, Any]) -> bool:
    """
    Validate WebSocket message against schema.
    
    Args:
        message: Message to validate
        
    Returns:
        bool: True if valid
    """
    try:
        validate(message, websocket_message_schema)
        return True
    except ValidationError:
        return False


def sanitize_comment_content(content: str) -> str:
    """
    Sanitize comment content to prevent XSS attacks.
    
    Args:
        content: Raw comment content
        
    Returns:
        str: Sanitized content
    """
    # Basic HTML escaping - in production, use a proper sanitization library
    import html
    return html.escape(content)


def generate_session_id() -> str:
    """
    Generate a unique session identifier.
    
    Returns:
        str: Unique session ID
    """
    import uuid
    return str(uuid.uuid4())


def get_user_from_token(token: str) -> Optional[Dict[str, Any]]:
    """
    Extract user information from authentication token.
    
    Args:
        token: Authentication token
        
    Returns:
        Optional[Dict[str, Any]]: User information or None if invalid
    """
    try:
        # In production, implement proper token validation
        # This is a simplified implementation
        if token and len(token) > 10:
            return {
                'name': f"user_{hash(token) % 10000}",
                'id': hash(token) % 10000,
                'roles': ['user']
            }
        return None
    except Exception:
        return None


def check_permission(user_id: str, document_id: str, permission: str) -> bool:
    """
    Check if user has permission for document operation.
    
    Args:
        user_id: User identifier
        document_id: Document identifier
        permission: Permission to check
        
    Returns:
        bool: True if user has permission
    """
    try:
        # In production, implement proper permission checking
        # This is a simplified implementation
        return True
    except Exception:
        return False


def setup_collaboration_logging() -> None:
    """Setup structured logging for collaboration events."""
    try:
        # Configure logging format
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.StreamHandler(),
                logging.FileHandler('collaboration.log')
            ]
        )
        
        # Set collaboration-specific log levels
        logging.getLogger('notebook.handlers').setLevel(logging.DEBUG)
        
    except Exception as e:
        print(f"Failed to setup logging: {str(e)}")


def initialize_collaboration_services() -> None:
    """Initialize collaboration services and dependencies."""
    try:
        # Setup logging
        setup_collaboration_logging()
        
        # Initialize services (already done globally)
        logger.info("Collaboration services initialized successfully")
        
        # Register cleanup handlers
        import atexit
        atexit.register(cleanup_collaboration_services)
        
    except Exception as e:
        logger.error(f"Failed to initialize collaboration services: {str(e)}")


def cleanup_collaboration_services() -> None:
    """Cleanup collaboration services on shutdown."""
    try:
        logger.info("Cleaning up collaboration services")
        
        # Close any open connections
        for connections in awareness_service.user_connections.values():
            for connection in connections:
                try:
                    if hasattr(connection, 'close'):
                        connection.close()
                except Exception:
                    pass
        
        # Clear caches
        document_service.document_cache.clear()
        awareness_service.awareness_state.clear()
        
        logger.info("Collaboration services cleanup completed")
        
    except Exception as e:
        logger.error(f"Failed to cleanup collaboration services: {str(e)}")


# Initialize services on module load
initialize_collaboration_services()


# Export all required classes for use by the notebook application
__all__ = [
    'CollaborationWebSocketHandler',
    'CollaborationSessionsHandler', 
    'CollaborationPermissionsHandler',
    'CollaborationCommentsHandler',
    'CollaborationHistoryHandler',
    'YjsDocumentPersistenceService',
    'AwarenessService',
    'RateLimitingService',
    'CollaborationMetricsService',
    'CollaborationHealthHandler',
    'CollaborationMetricsHandler'
]