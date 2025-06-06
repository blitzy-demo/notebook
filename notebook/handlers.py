"""
WebSocket Communication Handlers for Real-time Collaborative Editing

This module implements comprehensive WebSocket handlers for Jupyter Notebook v7's 
collaborative editing capabilities, providing the critical WebSocket infrastructure 
that bridges frontend YjsNotebookProvider instances with server-side collaboration 
coordination services.

Key Components:
- CollaborationWebSocketHandler: Manages `/collaboration` endpoint for CRDT synchronization
- AwarenessWebSocketHandler: Handles `/collab/awareness` endpoint for user presence
- Comprehensive WebSocket message routing for Yjs protocol compliance
- Session-scoped authentication with JWT token validation
- Rate limiting and security validation for WebSocket connections
- Error handling and graceful degradation when collaboration services are unavailable

The handlers integrate with CollaborationManager for centralized session lifecycle
management, user coordination, and cross-instance session state synchronization.
"""

import asyncio
import json
import logging
import os
import time
import uuid
import weakref
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Union, Tuple, Callable
from dataclasses import dataclass, asdict
from enum import Enum
import re
import hashlib
import hmac
from urllib.parse import parse_qs, urlparse

# Third-party imports
import tornado.web
import tornado.websocket
import tornado.ioloop
import tornado.escape
import tornado.locks
import jwt
from prometheus_client import Counter, Histogram, Gauge, Summary
import aiohttp

# Local imports
from .collab.manager import (
    CollaborationManager, 
    CollaborationConfig, 
    CollaborationMessage,
    MessageType,
    UserRole,
    SessionStatus
)
from .collab.persistence import PersistenceLayer, CRDTOperation, OperationType

# Logging configuration
logger = logging.getLogger(__name__)


class SecurityPolicy:
    """WebSocket security policy configuration"""
    
    def __init__(self):
        # Origin validation
        self.strict_origin_check = os.getenv('JUPYTER_COLLAB_STRICT_ORIGIN', 'true').lower() == 'true'
        self.allowed_origins = os.getenv('JUPYTER_COLLAB_ALLOWED_ORIGINS', '').split(',')
        self.origin_pattern = os.getenv('JUPYTER_COLLAB_ORIGIN_PATTERN', r'https://.*\.jupyter\..*')
        
        # Authentication
        self.require_authentication = True
        self.jwt_secret_key = os.getenv('JUPYTER_COLLAB_JWT_SECRET', 'dev-secret-change-in-production')
        self.token_expiry_grace = int(os.getenv('JUPYTER_COLLAB_TOKEN_GRACE_SECONDS', '300'))  # 5 minutes
        
        # Rate limiting
        self.enable_rate_limiting = os.getenv('JUPYTER_COLLAB_RATE_LIMITING', 'true').lower() == 'true'
        self.connection_rate_limit = int(os.getenv('JUPYTER_COLLAB_CONNECTION_RATE_LIMIT', '10'))  # per minute
        self.message_rate_limit = int(os.getenv('JUPYTER_COLLAB_MESSAGE_RATE_LIMIT', '100'))  # per minute
        self.burst_limit = int(os.getenv('JUPYTER_COLLAB_BURST_LIMIT', '20'))
        
        # WebSocket configuration
        self.websocket_timeout = int(os.getenv('JUPYTER_COLLAB_WEBSOCKET_TIMEOUT', '300'))  # 5 minutes
        self.max_message_size = int(os.getenv('JUPYTER_COLLAB_MAX_MESSAGE_SIZE', '1048576'))  # 1MB
        self.heartbeat_interval = int(os.getenv('JUPYTER_COLLAB_HEARTBEAT_INTERVAL', '30'))  # 30 seconds
        
        # Security headers
        self.require_secure_transport = os.getenv('JUPYTER_COLLAB_REQUIRE_WSS', 'true').lower() == 'true'
        self.validate_user_agent = os.getenv('JUPYTER_COLLAB_VALIDATE_USER_AGENT', 'false').lower() == 'true'


class WebSocketMetrics:
    """Prometheus metrics for WebSocket handlers"""
    
    def __init__(self):
        # Connection metrics
        self.connections_total = Counter(
            'jupyter_collab_websocket_connections_total',
            'Total WebSocket connections',
            ['handler_type', 'status']
        )
        
        self.connections_active = Gauge(
            'jupyter_collab_websocket_connections_active',
            'Active WebSocket connections',
            ['handler_type']
        )
        
        self.connection_duration = Histogram(
            'jupyter_collab_websocket_connection_duration_seconds',
            'WebSocket connection duration',
            ['handler_type', 'disconnect_reason'],
            buckets=[1, 5, 15, 30, 60, 300, 900, 1800, 3600, 7200]
        )
        
        # Message metrics
        self.messages_total = Counter(
            'jupyter_collab_websocket_messages_total',
            'Total WebSocket messages',
            ['handler_type', 'message_type', 'direction', 'status']
        )
        
        self.message_size_bytes = Histogram(
            'jupyter_collab_websocket_message_size_bytes',
            'WebSocket message size in bytes',
            ['handler_type', 'message_type'],
            buckets=[100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000]
        )
        
        self.message_processing_duration = Histogram(
            'jupyter_collab_websocket_message_processing_duration_seconds',
            'Message processing duration',
            ['handler_type', 'message_type'],
            buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
        )
        
        # Authentication metrics
        self.auth_attempts_total = Counter(
            'jupyter_collab_websocket_auth_attempts_total',
            'WebSocket authentication attempts',
            ['handler_type', 'status']
        )
        
        self.auth_failures_total = Counter(
            'jupyter_collab_websocket_auth_failures_total',
            'WebSocket authentication failures',
            ['handler_type', 'reason']
        )
        
        # Rate limiting metrics
        self.rate_limit_hits = Counter(
            'jupyter_collab_websocket_rate_limit_hits_total',
            'Rate limit violations',
            ['handler_type', 'limit_type']
        )
        
        # Error metrics
        self.errors_total = Counter(
            'jupyter_collab_websocket_errors_total',
            'WebSocket errors',
            ['handler_type', 'error_type']
        )


class RateLimiter:
    """Token bucket rate limiter for WebSocket connections"""
    
    def __init__(self, policy: SecurityPolicy):
        self.policy = policy
        self.connection_buckets = {}  # IP -> (tokens, last_refill)
        self.message_buckets = {}     # connection_id -> (tokens, last_refill)
        self.cleanup_interval = 300   # 5 minutes
        self.last_cleanup = time.time()
    
    async def check_connection_rate(self, client_ip: str) -> bool:
        """Check if connection is allowed based on rate limit"""
        if not self.policy.enable_rate_limiting:
            return True
        
        current_time = time.time()
        
        # Cleanup old entries periodically
        if current_time - self.last_cleanup > self.cleanup_interval:
            await self._cleanup_old_entries()
        
        # Get or create bucket for IP
        if client_ip not in self.connection_buckets:
            self.connection_buckets[client_ip] = [
                self.policy.connection_rate_limit, 
                current_time
            ]
        
        tokens, last_refill = self.connection_buckets[client_ip]
        
        # Refill tokens based on time elapsed
        time_elapsed = current_time - last_refill
        tokens_to_add = int(time_elapsed * (self.policy.connection_rate_limit / 60))  # per minute
        tokens = min(self.policy.connection_rate_limit, tokens + tokens_to_add)
        
        # Check if request can be served
        if tokens > 0:
            self.connection_buckets[client_ip] = [tokens - 1, current_time]
            return True
        else:
            return False
    
    async def check_message_rate(self, connection_id: str) -> bool:
        """Check if message is allowed based on rate limit"""
        if not self.policy.enable_rate_limiting:
            return True
        
        current_time = time.time()
        
        # Get or create bucket for connection
        if connection_id not in self.message_buckets:
            self.message_buckets[connection_id] = [
                self.policy.message_rate_limit,
                current_time
            ]
        
        tokens, last_refill = self.message_buckets[connection_id]
        
        # Refill tokens based on time elapsed
        time_elapsed = current_time - last_refill
        tokens_to_add = int(time_elapsed * (self.policy.message_rate_limit / 60))  # per minute
        tokens = min(self.policy.message_rate_limit, tokens + tokens_to_add)
        
        # Check if request can be served
        if tokens > 0:
            self.message_buckets[connection_id] = [tokens - 1, current_time]
            return True
        else:
            return False
    
    async def _cleanup_old_entries(self):
        """Remove old rate limiting entries"""
        current_time = time.time()
        cutoff_time = current_time - 3600  # 1 hour
        
        # Clean connection buckets
        expired_connections = [
            ip for ip, (_, last_refill) in self.connection_buckets.items()
            if last_refill < cutoff_time
        ]
        for ip in expired_connections:
            del self.connection_buckets[ip]
        
        # Clean message buckets
        expired_messages = [
            conn_id for conn_id, (_, last_refill) in self.message_buckets.items()
            if last_refill < cutoff_time
        ]
        for conn_id in expired_messages:
            del self.message_buckets[conn_id]
        
        self.last_cleanup = current_time


@dataclass
class AuthenticationContext:
    """Authentication context for WebSocket connections"""
    user_id: str
    session_id: str
    permissions: UserRole
    token_expires_at: float
    authenticated_at: float
    client_ip: str
    user_agent: str


class CollaborationTokenValidator:
    """JWT token validator for collaboration sessions"""
    
    def __init__(self, policy: SecurityPolicy):
        self.policy = policy
        self.revoked_tokens = set()  # In production, use Redis
        
    async def validate_token(self, token: str, session_id: str, 
                           client_ip: str = None) -> Optional[AuthenticationContext]:
        """Validate collaboration JWT token"""
        try:
            # Check if token is revoked
            if token in self.revoked_tokens:
                logger.warning(f"Attempt to use revoked token from {client_ip}")
                return None
            
            # Decode JWT token
            payload = jwt.decode(
                token,
                self.policy.jwt_secret_key,
                algorithms=['HS256'],
                audience='jupyter-collaboration'
            )
            
            # Validate basic claims
            current_time = time.time()
            
            if payload.get('exp', 0) < current_time - self.policy.token_expiry_grace:
                logger.warning(f"Expired token from {client_ip}")
                return None
            
            if payload.get('session_id') != session_id:
                logger.warning(f"Session ID mismatch for token from {client_ip}")
                return None
            
            # Extract user information
            user_id = payload.get('sub')
            permissions_str = payload.get('permissions', 'guest')
            
            if not user_id:
                logger.warning(f"Missing user ID in token from {client_ip}")
                return None
            
            try:
                permissions = UserRole(permissions_str)
            except ValueError:
                logger.warning(f"Invalid permissions '{permissions_str}' in token from {client_ip}")
                permissions = UserRole.GUEST
            
            return AuthenticationContext(
                user_id=user_id,
                session_id=session_id,
                permissions=permissions,
                token_expires_at=payload.get('exp', 0),
                authenticated_at=current_time,
                client_ip=client_ip or 'unknown',
                user_agent=payload.get('user_agent', 'unknown')
            )
            
        except jwt.InvalidTokenError as e:
            logger.warning(f"Invalid JWT token from {client_ip}: {e}")
            return None
        except Exception as e:
            logger.error(f"Token validation error from {client_ip}: {e}")
            return None
    
    async def revoke_token(self, token: str):
        """Revoke a JWT token"""
        # In production, store in Redis with TTL
        self.revoked_tokens.add(token)
        
        # Limit memory usage by keeping only recent revocations
        if len(self.revoked_tokens) > 10000:
            # Remove oldest 20% (simple cleanup)
            tokens_to_remove = list(self.revoked_tokens)[:2000]
            for token in tokens_to_remove:
                self.revoked_tokens.discard(token)


class BaseCollaborationWebSocketHandler(tornado.websocket.WebSocketHandler):
    """Base class for collaboration WebSocket handlers"""
    
    def __init__(self, application, request, **kwargs):
        super().__init__(application, request, **kwargs)
        
        # Injected dependencies
        self.collaboration_manager: CollaborationManager = kwargs.get('collaboration_manager')
        self.security_policy = kwargs.get('security_policy', SecurityPolicy())
        self.rate_limiter = kwargs.get('rate_limiter', RateLimiter(self.security_policy))
        self.token_validator = kwargs.get('token_validator', CollaborationTokenValidator(self.security_policy))
        
        # Connection state
        self.connection_id = str(uuid.uuid4())
        self.auth_context: Optional[AuthenticationContext] = None
        self.connected_at = None
        self.last_heartbeat = None
        self.message_count = 0
        
        # Metrics
        self.metrics = WebSocketMetrics()
        
        # Handler type for metrics (overridden in subclasses)
        self.handler_type = 'base'
    
    def check_origin(self, origin: str) -> bool:
        """Validate WebSocket origin for security"""
        if not self.security_policy.strict_origin_check:
            return True
        
        # Check against allowed origins list
        if origin in self.security_policy.allowed_origins:
            return True
        
        # Check against origin pattern
        if self.security_policy.origin_pattern:
            import re
            pattern = re.compile(self.security_policy.origin_pattern)
            if pattern.match(origin):
                return True
        
        logger.warning(f"WebSocket connection rejected: invalid origin {origin}")
        return False
    
    async def prepare(self):
        """Prepare WebSocket connection with authentication and security checks"""
        try:
            # Check if WSS is required
            if self.security_policy.require_secure_transport:
                if not self.request.protocol.startswith('wss'):
                    raise tornado.web.HTTPError(403, "WSS required for collaborative endpoints")
            
            # Rate limiting check
            client_ip = self.get_client_ip()
            if not await self.rate_limiter.check_connection_rate(client_ip):
                self.metrics.rate_limit_hits.labels(
                    handler_type=self.handler_type,
                    limit_type='connection'
                ).inc()
                raise tornado.web.HTTPError(429, "Rate limit exceeded")
            
            # Extract authentication parameters
            token = self.get_authentication_token()
            session_id = self.get_session_id()
            
            if not token:
                self.metrics.auth_failures_total.labels(
                    handler_type=self.handler_type,
                    reason='missing_token'
                ).inc()
                raise tornado.web.HTTPError(403, "Authentication token required")
            
            if not session_id:
                self.metrics.auth_failures_total.labels(
                    handler_type=self.handler_type,
                    reason='missing_session_id'
                ).inc()
                raise tornado.web.HTTPError(403, "Session ID required")
            
            # Validate authentication token
            self.auth_context = await self.token_validator.validate_token(
                token, session_id, client_ip
            )
            
            if not self.auth_context:
                self.metrics.auth_failures_total.labels(
                    handler_type=self.handler_type,
                    reason='invalid_token'
                ).inc()
                raise tornado.web.HTTPError(403, "Invalid authentication token")
            
            # Log successful authentication
            self.metrics.auth_attempts_total.labels(
                handler_type=self.handler_type,
                status='success'
            ).inc()
            
            logger.info(
                f"WebSocket authentication successful: user={self.auth_context.user_id}, "
                f"session={self.auth_context.session_id}, ip={client_ip}"
            )
            
        except tornado.web.HTTPError:
            raise
        except Exception as e:
            logger.error(f"WebSocket preparation error: {e}")
            self.metrics.errors_total.labels(
                handler_type=self.handler_type,
                error_type='preparation'
            ).inc()
            raise tornado.web.HTTPError(500, "Internal server error")
    
    def open(self):
        """Handle WebSocket connection opening"""
        self.connected_at = datetime.utcnow()
        self.last_heartbeat = datetime.utcnow()
        
        # Update metrics
        self.metrics.connections_total.labels(
            handler_type=self.handler_type,
            status='opened'
        ).inc()
        self.metrics.connections_active.labels(
            handler_type=self.handler_type
        ).inc()
        
        logger.info(
            f"WebSocket connection opened: {self.connection_id}, "
            f"user={self.auth_context.user_id if self.auth_context else 'unknown'}"
        )
        
        # Start connection-specific tasks
        asyncio.create_task(self._start_heartbeat_task())
        asyncio.create_task(self._handle_connection_opened())
    
    async def on_message(self, message: str):
        """Handle incoming WebSocket message"""
        start_time = time.time()
        message_type = 'unknown'
        
        try:
            # Rate limiting check
            if not await self.rate_limiter.check_message_rate(self.connection_id):
                self.metrics.rate_limit_hits.labels(
                    handler_type=self.handler_type,
                    limit_type='message'
                ).inc()
                await self.send_error("Rate limit exceeded")
                return
            
            # Message size check
            if len(message) > self.security_policy.max_message_size:
                self.metrics.errors_total.labels(
                    handler_type=self.handler_type,
                    error_type='message_too_large'
                ).inc()
                await self.send_error("Message too large")
                return
            
            # Parse message
            try:
                message_data = json.loads(message)
            except json.JSONDecodeError as e:
                self.metrics.errors_total.labels(
                    handler_type=self.handler_type,
                    error_type='invalid_json'
                ).inc()
                await self.send_error(f"Invalid JSON: {e}")
                return
            
            message_type = message_data.get('type', 'unknown')
            
            # Update metrics
            self.metrics.messages_total.labels(
                handler_type=self.handler_type,
                message_type=message_type,
                direction='inbound',
                status='received'
            ).inc()
            
            self.metrics.message_size_bytes.labels(
                handler_type=self.handler_type,
                message_type=message_type
            ).observe(len(message))
            
            # Update heartbeat
            self.last_heartbeat = datetime.utcnow()
            self.message_count += 1
            
            # Process message
            success = await self._process_message(message_data)
            
            # Update metrics
            status = 'success' if success else 'failed'
            self.metrics.messages_total.labels(
                handler_type=self.handler_type,
                message_type=message_type,
                direction='inbound',
                status=status
            ).inc()
            
        except Exception as e:
            logger.error(f"Error processing WebSocket message: {e}")
            self.metrics.errors_total.labels(
                handler_type=self.handler_type,
                error_type='message_processing'
            ).inc()
            await self.send_error("Message processing error")
        finally:
            # Record processing duration
            duration = time.time() - start_time
            self.metrics.message_processing_duration.labels(
                handler_type=self.handler_type,
                message_type=message_type
            ).observe(duration)
    
    def on_close(self):
        """Handle WebSocket connection closing"""
        disconnect_reason = 'normal'
        
        try:
            # Calculate connection duration
            if self.connected_at:
                duration = (datetime.utcnow() - self.connected_at).total_seconds()
                self.metrics.connection_duration.labels(
                    handler_type=self.handler_type,
                    disconnect_reason=disconnect_reason
                ).observe(duration)
            
            # Update metrics
            self.metrics.connections_active.labels(
                handler_type=self.handler_type
            ).dec()
            
            logger.info(
                f"WebSocket connection closed: {self.connection_id}, "
                f"user={self.auth_context.user_id if self.auth_context else 'unknown'}, "
                f"messages={self.message_count}"
            )
            
            # Handle connection-specific cleanup
            asyncio.create_task(self._handle_connection_closed(disconnect_reason))
            
        except Exception as e:
            logger.error(f"Error during WebSocket close: {e}")
    
    async def _start_heartbeat_task(self):
        """Start heartbeat monitoring task"""
        while True:
            try:
                await asyncio.sleep(self.security_policy.heartbeat_interval)
                
                # Check if connection is still alive
                if self.ws_connection is None or self.ws_connection.is_closing():
                    break
                
                # Send heartbeat ping
                await self.send_message({
                    'type': 'heartbeat',
                    'timestamp': time.time()
                })
                
            except Exception as e:
                logger.error(f"Heartbeat task error: {e}")
                break
    
    async def _handle_connection_opened(self):
        """Handle connection opening (implemented by subclasses)"""
        pass
    
    async def _process_message(self, message_data: Dict[str, Any]) -> bool:
        """Process WebSocket message (implemented by subclasses)"""
        return True
    
    async def _handle_connection_closed(self, reason: str):
        """Handle connection closing (implemented by subclasses)"""
        pass
    
    async def send_message(self, message: Dict[str, Any]):
        """Send message to WebSocket client"""
        try:
            message_json = json.dumps(message)
            self.write_message(message_json)
            
            # Update metrics
            self.metrics.messages_total.labels(
                handler_type=self.handler_type,
                message_type=message.get('type', 'unknown'),
                direction='outbound',
                status='sent'
            ).inc()
            
            self.metrics.message_size_bytes.labels(
                handler_type=self.handler_type,
                message_type=message.get('type', 'unknown')
            ).observe(len(message_json))
            
        except Exception as e:
            logger.error(f"Error sending WebSocket message: {e}")
            self.metrics.errors_total.labels(
                handler_type=self.handler_type,
                error_type='send_failed'
            ).inc()
    
    async def send_error(self, error_message: str, error_code: str = None):
        """Send error message to client"""
        await self.send_message({
            'type': 'error',
            'error': error_message,
            'error_code': error_code,
            'timestamp': time.time()
        })
    
    def get_client_ip(self) -> str:
        """Get client IP address with proxy support"""
        # Check for forwarded headers (from reverse proxy)
        forwarded_for = self.request.headers.get('X-Forwarded-For')
        if forwarded_for:
            return forwarded_for.split(',')[0].strip()
        
        real_ip = self.request.headers.get('X-Real-IP')
        if real_ip:
            return real_ip
        
        return self.request.remote_ip or 'unknown'
    
    def get_authentication_token(self) -> Optional[str]:
        """Extract authentication token from request"""
        # Check Authorization header
        auth_header = self.request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            return auth_header[7:]
        
        # Check query parameters
        token = self.get_argument('token', None)
        if token:
            return token
        
        # Check cookies
        token = self.get_secure_cookie('jupyter-collaboration-token')
        if token:
            return token.decode('utf-8')
        
        return None
    
    def get_session_id(self) -> Optional[str]:
        """Extract session ID from request"""
        # Check URL path parameters
        session_id = self.get_argument('session_id', None)
        if session_id:
            return session_id
        
        # Check headers
        session_id = self.request.headers.get('X-Session-ID')
        if session_id:
            return session_id
        
        return None


class CollaborationWebSocketHandler(BaseCollaborationWebSocketHandler):
    """
    WebSocket handler for `/collaboration` endpoint managing WebSocket connections 
    for CRDT document synchronization with authentication and session validation.
    
    This handler manages:
    - CRDT document synchronization via Yjs protocol
    - Cell-level locking coordination
    - Session lifecycle management
    - User permission validation
    - Message routing to collaboration manager
    """
    
    def __init__(self, application, request, **kwargs):
        super().__init__(application, request, **kwargs)
        self.handler_type = 'collaboration'
        self.session_joined = False
    
    async def _handle_connection_opened(self):
        """Handle collaboration connection opening"""
        try:
            if not self.collaboration_manager:
                await self.send_error("Collaboration service unavailable")
                self.close()
                return
            
            # Join collaboration session
            success = await self.collaboration_manager.join_session(
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                connection_id=self.connection_id,
                websocket_handler=self
            )
            
            if not success:
                await self.send_error("Failed to join collaboration session")
                self.close()
                return
            
            self.session_joined = True
            
            # Send connection confirmation
            await self.send_message({
                'type': 'connection_established',
                'session_id': self.auth_context.session_id,
                'user_id': self.auth_context.user_id,
                'permissions': self.auth_context.permissions.value,
                'timestamp': time.time()
            })
            
            logger.info(
                f"User {self.auth_context.user_id} joined collaboration session "
                f"{self.auth_context.session_id}"
            )
            
        except Exception as e:
            logger.error(f"Error handling collaboration connection: {e}")
            await self.send_error("Connection setup failed")
            self.close()
    
    async def _process_message(self, message_data: Dict[str, Any]) -> bool:
        """Process collaboration message"""
        try:
            message_type = message_data.get('type')
            
            if message_type == 'heartbeat':
                return await self._handle_heartbeat(message_data)
            
            elif message_type == 'yjs_update':
                return await self._handle_yjs_update(message_data)
            
            elif message_type == 'yjs_sync_step1':
                return await self._handle_yjs_sync_step1(message_data)
            
            elif message_type == 'yjs_sync_step2':
                return await self._handle_yjs_sync_step2(message_data)
            
            elif message_type == 'yjs_query_awareness':
                return await self._handle_yjs_query_awareness(message_data)
            
            elif message_type == 'lock_request':
                return await self._handle_lock_request(message_data)
            
            elif message_type == 'lock_release':
                return await self._handle_lock_release(message_data)
            
            elif message_type == 'sync_request':
                return await self._handle_sync_request(message_data)
            
            else:
                logger.warning(f"Unknown message type: {message_type}")
                await self.send_error(f"Unknown message type: {message_type}")
                return False
                
        except Exception as e:
            logger.error(f"Error processing collaboration message: {e}")
            return False
    
    async def _handle_connection_closed(self, reason: str):
        """Handle collaboration connection closing"""
        if self.session_joined and self.collaboration_manager:
            try:
                await self.collaboration_manager.leave_session(
                    connection_id=self.connection_id,
                    reason=reason
                )
                logger.info(
                    f"User {self.auth_context.user_id} left collaboration session "
                    f"{self.auth_context.session_id} (reason: {reason})"
                )
            except Exception as e:
                logger.error(f"Error leaving collaboration session: {e}")
    
    async def _handle_heartbeat(self, message_data: Dict[str, Any]) -> bool:
        """Handle heartbeat message"""
        await self.send_message({
            'type': 'heartbeat_response',
            'timestamp': time.time()
        })
        return True
    
    async def _handle_yjs_update(self, message_data: Dict[str, Any]) -> bool:
        """Handle Yjs document update"""
        try:
            # Extract Yjs update data
            update_data = message_data.get('update')
            if not update_data:
                await self.send_error("Missing update data")
                return False
            
            # Create CRDT operation
            crdt_message = CollaborationMessage(
                message_type=MessageType.CRDT_OPERATION,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload={
                    'operation_type': 'update',
                    'yjs_update': update_data,
                    'metadata': message_data.get('metadata', {})
                },
                operation_id=message_data.get('operation_id')
            )
            
            # Process through collaboration manager
            success = await self.collaboration_manager.process_message(
                self.connection_id, 
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling Yjs update: {e}")
            return False
    
    async def _handle_yjs_sync_step1(self, message_data: Dict[str, Any]) -> bool:
        """Handle Yjs synchronization step 1 (state vector)"""
        try:
            state_vector = message_data.get('state_vector')
            if state_vector is None:
                await self.send_error("Missing state vector")
                return False
            
            # TODO: Implement Yjs sync step 1 logic
            # This would typically involve comparing state vectors and sending differences
            
            await self.send_message({
                'type': 'yjs_sync_step2',
                'update': b'',  # Placeholder - should contain actual differences
                'timestamp': time.time()
            })
            
            return True
            
        except Exception as e:
            logger.error(f"Error handling Yjs sync step 1: {e}")
            return False
    
    async def _handle_yjs_sync_step2(self, message_data: Dict[str, Any]) -> bool:
        """Handle Yjs synchronization step 2 (update)"""
        try:
            # Process as regular update
            return await self._handle_yjs_update(message_data)
            
        except Exception as e:
            logger.error(f"Error handling Yjs sync step 2: {e}")
            return False
    
    async def _handle_yjs_query_awareness(self, message_data: Dict[str, Any]) -> bool:
        """Handle Yjs awareness query"""
        try:
            # Request awareness information from collaboration manager
            crdt_message = CollaborationMessage(
                message_type=MessageType.SYNC_REQUEST,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload={'request_type': 'awareness'}
            )
            
            success = await self.collaboration_manager.process_message(
                self.connection_id,
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling awareness query: {e}")
            return False
    
    async def _handle_lock_request(self, message_data: Dict[str, Any]) -> bool:
        """Handle cell lock request"""
        try:
            cell_id = message_data.get('cell_id')
            if not cell_id:
                await self.send_error("Missing cell ID")
                return False
            
            # Validate permissions for locking
            if self.auth_context.permissions in [UserRole.VIEWER, UserRole.GUEST]:
                await self.send_error("Insufficient permissions for locking")
                return False
            
            # Process lock request through collaboration manager
            crdt_message = CollaborationMessage(
                message_type=MessageType.LOCK_REQUEST,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload={'cell_id': cell_id}
            )
            
            success = await self.collaboration_manager.process_message(
                self.connection_id,
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling lock request: {e}")
            return False
    
    async def _handle_lock_release(self, message_data: Dict[str, Any]) -> bool:
        """Handle cell lock release"""
        try:
            cell_id = message_data.get('cell_id')
            if not cell_id:
                await self.send_error("Missing cell ID")
                return False
            
            # Process lock release through collaboration manager
            crdt_message = CollaborationMessage(
                message_type=MessageType.LOCK_RELEASE,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload={'cell_id': cell_id}
            )
            
            success = await self.collaboration_manager.process_message(
                self.connection_id,
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling lock release: {e}")
            return False
    
    async def _handle_sync_request(self, message_data: Dict[str, Any]) -> bool:
        """Handle session synchronization request"""
        try:
            # Process sync request through collaboration manager
            crdt_message = CollaborationMessage(
                message_type=MessageType.SYNC_REQUEST,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload=message_data.get('payload', {})
            )
            
            success = await self.collaboration_manager.process_message(
                self.connection_id,
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling sync request: {e}")
            return False


class AwarenessWebSocketHandler(BaseCollaborationWebSocketHandler):
    """
    WebSocket handler for `/collab/awareness` endpoint handling real-time user 
    presence broadcasts, cursor position tracking, and activity status coordination.
    
    This handler manages:
    - Real-time user presence updates
    - Cursor position synchronization
    - User activity status
    - Presence-based notifications
    """
    
    def __init__(self, application, request, **kwargs):
        super().__init__(application, request, **kwargs)
        self.handler_type = 'awareness'
        self.presence_active = False
    
    async def _handle_connection_opened(self):
        """Handle awareness connection opening"""
        try:
            if not self.collaboration_manager:
                await self.send_error("Collaboration service unavailable")
                self.close()
                return
            
            # Initialize presence tracking
            self.presence_active = True
            
            # Send initial presence state
            await self.send_message({
                'type': 'presence_initialized',
                'user_id': self.auth_context.user_id,
                'session_id': self.auth_context.session_id,
                'timestamp': time.time()
            })
            
            logger.info(
                f"Awareness connection established for user {self.auth_context.user_id} "
                f"in session {self.auth_context.session_id}"
            )
            
        except Exception as e:
            logger.error(f"Error handling awareness connection: {e}")
            await self.send_error("Awareness setup failed")
            self.close()
    
    async def _process_message(self, message_data: Dict[str, Any]) -> bool:
        """Process awareness message"""
        try:
            message_type = message_data.get('type')
            
            if message_type == 'heartbeat':
                return await self._handle_heartbeat(message_data)
            
            elif message_type == 'awareness_update':
                return await self._handle_awareness_update(message_data)
            
            elif message_type == 'cursor_update':
                return await self._handle_cursor_update(message_data)
            
            elif message_type == 'presence_update':
                return await self._handle_presence_update(message_data)
            
            elif message_type == 'activity_status':
                return await self._handle_activity_status(message_data)
            
            else:
                logger.warning(f"Unknown awareness message type: {message_type}")
                await self.send_error(f"Unknown message type: {message_type}")
                return False
                
        except Exception as e:
            logger.error(f"Error processing awareness message: {e}")
            return False
    
    async def _handle_connection_closed(self, reason: str):
        """Handle awareness connection closing"""
        if self.presence_active and self.collaboration_manager:
            try:
                # Update presence to indicate user left
                crdt_message = CollaborationMessage(
                    message_type=MessageType.PRESENCE_UPDATE,
                    session_id=self.auth_context.session_id,
                    user_id=self.auth_context.user_id,
                    timestamp=datetime.utcnow(),
                    payload={
                        'presence': {
                            'status': 'offline',
                            'disconnect_reason': reason
                        }
                    }
                )
                
                await self.collaboration_manager.process_message(
                    self.connection_id,
                    asdict(crdt_message)
                )
                
                logger.info(
                    f"Awareness disconnected for user {self.auth_context.user_id} "
                    f"in session {self.auth_context.session_id} (reason: {reason})"
                )
                
            except Exception as e:
                logger.error(f"Error handling awareness disconnection: {e}")
    
    async def _handle_heartbeat(self, message_data: Dict[str, Any]) -> bool:
        """Handle heartbeat message"""
        await self.send_message({
            'type': 'heartbeat_response',
            'timestamp': time.time()
        })
        return True
    
    async def _handle_awareness_update(self, message_data: Dict[str, Any]) -> bool:
        """Handle general awareness update"""
        try:
            awareness_data = message_data.get('awareness', {})
            
            # Process awareness update through collaboration manager
            crdt_message = CollaborationMessage(
                message_type=MessageType.AWARENESS_UPDATE,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload={
                    'awareness': awareness_data,
                    'cursor': message_data.get('cursor'),
                    'selection': message_data.get('selection')
                }
            )
            
            success = await self.collaboration_manager.process_message(
                self.connection_id,
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling awareness update: {e}")
            return False
    
    async def _handle_cursor_update(self, message_data: Dict[str, Any]) -> bool:
        """Handle cursor position update"""
        try:
            cursor_data = message_data.get('cursor', {})
            cell_id = cursor_data.get('cell_id')
            position = cursor_data.get('position', {})
            
            # Process cursor update through collaboration manager
            crdt_message = CollaborationMessage(
                message_type=MessageType.AWARENESS_UPDATE,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload={
                    'cursor': {
                        'cell_id': cell_id,
                        'line': position.get('line'),
                        'column': position.get('column'),
                        'timestamp': time.time()
                    }
                }
            )
            
            success = await self.collaboration_manager.process_message(
                self.connection_id,
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling cursor update: {e}")
            return False
    
    async def _handle_presence_update(self, message_data: Dict[str, Any]) -> bool:
        """Handle user presence update"""
        try:
            presence_data = message_data.get('presence', {})
            
            # Process presence update through collaboration manager
            crdt_message = CollaborationMessage(
                message_type=MessageType.PRESENCE_UPDATE,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload={'presence': presence_data}
            )
            
            success = await self.collaboration_manager.process_message(
                self.connection_id,
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling presence update: {e}")
            return False
    
    async def _handle_activity_status(self, message_data: Dict[str, Any]) -> bool:
        """Handle activity status update"""
        try:
            status = message_data.get('status', 'active')
            activity_data = message_data.get('activity', {})
            
            # Process activity status through collaboration manager
            crdt_message = CollaborationMessage(
                message_type=MessageType.PRESENCE_UPDATE,
                session_id=self.auth_context.session_id,
                user_id=self.auth_context.user_id,
                timestamp=datetime.utcnow(),
                payload={
                    'presence': {
                        'status': status,
                        'activity': activity_data,
                        'last_seen': time.time()
                    }
                }
            )
            
            success = await self.collaboration_manager.process_message(
                self.connection_id,
                asdict(crdt_message)
            )
            
            return success
            
        except Exception as e:
            logger.error(f"Error handling activity status: {e}")
            return False


def setup_collaboration_handlers(web_app, collaboration_manager: CollaborationManager, 
                                config: Dict[str, Any] = None):
    """
    Setup collaboration WebSocket handlers with the Tornado web application.
    
    Args:
        web_app: Tornado web application
        collaboration_manager: Initialized collaboration manager
        config: Optional configuration dictionary
    """
    try:
        # Initialize components
        security_policy = SecurityPolicy()
        rate_limiter = RateLimiter(security_policy)
        token_validator = CollaborationTokenValidator(security_policy)
        
        # Common handler kwargs
        handler_kwargs = {
            'collaboration_manager': collaboration_manager,
            'security_policy': security_policy,
            'rate_limiter': rate_limiter,
            'token_validator': token_validator
        }
        
        # Define collaboration WebSocket routes
        collaboration_handlers = [
            # Main collaboration endpoint for CRDT synchronization
            (
                r'/api/collaboration/ws/([^/]+)',
                CollaborationWebSocketHandler,
                handler_kwargs
            ),
            
            # Awareness endpoint for presence and cursor tracking
            (
                r'/api/collab/awareness/([^/]+)',
                AwarenessWebSocketHandler,
                handler_kwargs
            ),
        ]
        
        # Add handlers to web application
        web_app.add_handlers('.*$', collaboration_handlers)
        
        logger.info("Collaboration WebSocket handlers setup completed")
        
        return {
            'security_policy': security_policy,
            'rate_limiter': rate_limiter,
            'token_validator': token_validator,
            'handlers': collaboration_handlers
        }
        
    except Exception as e:
        logger.error(f"Failed to setup collaboration handlers: {e}")
        raise


# Export main classes
__all__ = [
    'CollaborationWebSocketHandler',
    'AwarenessWebSocketHandler',
    'BaseCollaborationWebSocketHandler',
    'SecurityPolicy',
    'CollaborationTokenValidator',
    'RateLimiter',
    'WebSocketMetrics',
    'AuthenticationContext',
    'setup_collaboration_handlers'
]