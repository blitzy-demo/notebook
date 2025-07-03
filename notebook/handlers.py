"""Tornado WebSocket handlers for real-time collaborative editing.

This module provides WebSocket handlers for Jupyter Notebook collaboration features
including Yjs CRDT protocol synchronization, user presence awareness, cell-level
locking, permissions validation, and comment system management.
"""

from __future__ import annotations

import asyncio
import json
import logging
import struct
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple, Union
from urllib.parse import parse_qs, urlparse

import tornado.web
import tornado.websocket
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado.concurrent import run_on_executor
from tornado.websocket import WebSocketHandler

from .auth import (
    CollaborationAuthenticator,
    CollaborationUser,
    CollaborationWebSocketMixin,
    get_authenticator,
)
from ._version import __version__


# Yjs protocol message types
YJS_MESSAGE_SYNC = 0
YJS_MESSAGE_AWARENESS = 1
YJS_MESSAGE_AUTH = 2
YJS_MESSAGE_QUERY_AWARENESS = 3
YJS_MESSAGE_SYNC_STEP1 = 0
YJS_MESSAGE_SYNC_STEP2 = 1
YJS_MESSAGE_SYNC_UPDATE = 2

# Collaboration event types
COLLAB_EVENT_CELL_LOCK = "cell_lock"
COLLAB_EVENT_CELL_UNLOCK = "cell_unlock"
COLLAB_EVENT_COMMENT_ADD = "comment_add"
COLLAB_EVENT_COMMENT_UPDATE = "comment_update"
COLLAB_EVENT_COMMENT_DELETE = "comment_delete"
COLLAB_EVENT_PERMISSION_CHANGE = "permission_change"
COLLAB_EVENT_USER_JOIN = "user_join"
COLLAB_EVENT_USER_LEAVE = "user_leave"
COLLAB_EVENT_SESSION_STATE = "session_state"

# Error codes
ERROR_AUTHENTICATION_FAILED = 1001
ERROR_PERMISSION_DENIED = 1002
ERROR_INVALID_MESSAGE = 1003
ERROR_DOCUMENT_NOT_FOUND = 1004
ERROR_CELL_LOCKED = 1005
ERROR_SESSION_EXPIRED = 1006
ERROR_PROTOCOL_ERROR = 1007
ERROR_RATE_LIMIT_EXCEEDED = 1008


class CollaborationError(Exception):
    """Base collaboration error."""
    
    def __init__(self, message: str, code: int = 0):
        super().__init__(message)
        self.code = code


class DocumentState:
    """Document state manager for collaborative editing."""
    
    def __init__(self, document_id: str):
        self.document_id = document_id
        self.yjs_state = bytearray()
        self.yjs_updates: List[bytes] = []
        self.awareness_states: Dict[str, Dict[str, Any]] = {}
        self.cell_locks: Dict[str, Tuple[str, float]] = {}  # cell_id -> (user_id, timestamp)
        self.comments: Dict[str, Dict[str, Any]] = {}
        self.permissions: Dict[str, str] = {}  # user_id -> role
        self.connected_users: Set[str] = set()
        self.last_activity = time.time()
        self.created_at = time.time()
        self.version = 0
        self.lock = asyncio.Lock()
    
    async def add_yjs_update(self, update: bytes) -> None:
        """Add Yjs update to document state."""
        async with self.lock:
            self.yjs_updates.append(update)
            self.version += 1
            self.last_activity = time.time()
    
    async def get_yjs_state(self) -> bytes:
        """Get current Yjs document state."""
        async with self.lock:
            return bytes(self.yjs_state)
    
    async def set_yjs_state(self, state: bytes) -> None:
        """Set Yjs document state."""
        async with self.lock:
            self.yjs_state = bytearray(state)
            self.version += 1
            self.last_activity = time.time()
    
    async def update_awareness(self, user_id: str, awareness_data: Dict[str, Any]) -> None:
        """Update user awareness state."""
        async with self.lock:
            self.awareness_states[user_id] = {
                **awareness_data,
                "timestamp": time.time()
            }
            self.last_activity = time.time()
    
    async def remove_awareness(self, user_id: str) -> None:
        """Remove user awareness state."""
        async with self.lock:
            self.awareness_states.pop(user_id, None)
    
    async def lock_cell(self, cell_id: str, user_id: str) -> bool:
        """Lock a cell for editing."""
        async with self.lock:
            if cell_id in self.cell_locks:
                locked_user, timestamp = self.cell_locks[cell_id]
                # Check if lock is expired (5 minutes)
                if time.time() - timestamp < 300 and locked_user != user_id:
                    return False
            
            self.cell_locks[cell_id] = (user_id, time.time())
            self.last_activity = time.time()
            return True
    
    async def unlock_cell(self, cell_id: str, user_id: str) -> bool:
        """Unlock a cell."""
        async with self.lock:
            if cell_id in self.cell_locks:
                locked_user, _ = self.cell_locks[cell_id]
                if locked_user == user_id:
                    del self.cell_locks[cell_id]
                    self.last_activity = time.time()
                    return True
            return False
    
    async def force_unlock_cell(self, cell_id: str) -> bool:
        """Force unlock a cell (admin only)."""
        async with self.lock:
            if cell_id in self.cell_locks:
                del self.cell_locks[cell_id]
                self.last_activity = time.time()
                return True
            return False
    
    async def add_comment(self, comment_id: str, comment_data: Dict[str, Any]) -> None:
        """Add a comment to the document."""
        async with self.lock:
            self.comments[comment_id] = {
                **comment_data,
                "created_at": time.time(),
                "updated_at": time.time()
            }
            self.last_activity = time.time()
    
    async def update_comment(self, comment_id: str, comment_data: Dict[str, Any]) -> bool:
        """Update a comment."""
        async with self.lock:
            if comment_id in self.comments:
                self.comments[comment_id].update({
                    **comment_data,
                    "updated_at": time.time()
                })
                self.last_activity = time.time()
                return True
            return False
    
    async def delete_comment(self, comment_id: str) -> bool:
        """Delete a comment."""
        async with self.lock:
            if comment_id in self.comments:
                del self.comments[comment_id]
                self.last_activity = time.time()
                return True
            return False
    
    async def add_user(self, user_id: str) -> None:
        """Add user to connected users."""
        async with self.lock:
            self.connected_users.add(user_id)
            self.last_activity = time.time()
    
    async def remove_user(self, user_id: str) -> None:
        """Remove user from connected users."""
        async with self.lock:
            self.connected_users.discard(user_id)
            # Remove user's awareness state
            self.awareness_states.pop(user_id, None)
            # Remove user's cell locks
            to_remove = []
            for cell_id, (locked_user, _) in self.cell_locks.items():
                if locked_user == user_id:
                    to_remove.append(cell_id)
            for cell_id in to_remove:
                del self.cell_locks[cell_id]
            self.last_activity = time.time()
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert document state to dictionary for serialization."""
        return {
            "document_id": self.document_id,
            "version": self.version,
            "connected_users": list(self.connected_users),
            "awareness_states": self.awareness_states,
            "cell_locks": {
                cell_id: {"user_id": user_id, "timestamp": timestamp}
                for cell_id, (user_id, timestamp) in self.cell_locks.items()
            },
            "comments": self.comments,
            "permissions": self.permissions,
            "last_activity": self.last_activity,
            "created_at": self.created_at
        }


class CollaborationSessionManager:
    """Global session manager for collaborative documents."""
    
    def __init__(self):
        self.documents: Dict[str, DocumentState] = {}
        self.user_connections: Dict[str, Set[WebSocketHandler]] = {}
        self.document_connections: Dict[str, Set[WebSocketHandler]] = {}
        self.cleanup_task: Optional[asyncio.Task] = None
        self.lock = asyncio.Lock()
        self.logger = logging.getLogger(__name__)
    
    async def get_document(self, document_id: str) -> DocumentState:
        """Get or create document state."""
        async with self.lock:
            if document_id not in self.documents:
                self.documents[document_id] = DocumentState(document_id)
                self.logger.info(f"Created new document state for {document_id}")
            return self.documents[document_id]
    
    async def add_connection(self, document_id: str, user_id: str, handler: WebSocketHandler) -> None:
        """Add WebSocket connection to document."""
        async with self.lock:
            # Add to document connections
            if document_id not in self.document_connections:
                self.document_connections[document_id] = set()
            self.document_connections[document_id].add(handler)
            
            # Add to user connections
            if user_id not in self.user_connections:
                self.user_connections[user_id] = set()
            self.user_connections[user_id].add(handler)
            
            # Add user to document state
            document = await self.get_document(document_id)
            await document.add_user(user_id)
            
            self.logger.info(f"Added connection for user {user_id} to document {document_id}")
    
    async def remove_connection(self, document_id: str, user_id: str, handler: WebSocketHandler) -> None:
        """Remove WebSocket connection from document."""
        async with self.lock:
            # Remove from document connections
            if document_id in self.document_connections:
                self.document_connections[document_id].discard(handler)
                if not self.document_connections[document_id]:
                    del self.document_connections[document_id]
            
            # Remove from user connections
            if user_id in self.user_connections:
                self.user_connections[user_id].discard(handler)
                if not self.user_connections[user_id]:
                    del self.user_connections[user_id]
            
            # Remove user from document state if no more connections
            if user_id not in self.user_connections:
                if document_id in self.documents:
                    await self.documents[document_id].remove_user(user_id)
            
            self.logger.info(f"Removed connection for user {user_id} from document {document_id}")
    
    async def broadcast_to_document(self, document_id: str, message: bytes, exclude_handler: Optional[WebSocketHandler] = None) -> None:
        """Broadcast message to all connections in a document."""
        async with self.lock:
            if document_id in self.document_connections:
                connections = self.document_connections[document_id].copy()
                
        # Broadcast outside of lock to avoid deadlock
        for handler in connections:
            if handler != exclude_handler and hasattr(handler, 'write_message'):
                try:
                    await handler.write_message(message, binary=True)
                except Exception as e:
                    self.logger.error(f"Error broadcasting to handler: {e}")
    
    async def broadcast_to_user(self, user_id: str, message: bytes) -> None:
        """Broadcast message to all connections for a user."""
        async with self.lock:
            if user_id in self.user_connections:
                connections = self.user_connections[user_id].copy()
            else:
                connections = set()
        
        # Broadcast outside of lock to avoid deadlock
        for handler in connections:
            if hasattr(handler, 'write_message'):
                try:
                    await handler.write_message(message, binary=True)
                except Exception as e:
                    self.logger.error(f"Error broadcasting to user {user_id}: {e}")
    
    async def cleanup_expired_documents(self) -> None:
        """Clean up expired document states."""
        current_time = time.time()
        expired_documents = []
        
        async with self.lock:
            for document_id, document in self.documents.items():
                # Remove documents with no connections and inactive for 1 hour
                if (document_id not in self.document_connections and 
                    current_time - document.last_activity > 3600):
                    expired_documents.append(document_id)
        
        for document_id in expired_documents:
            async with self.lock:
                if document_id in self.documents:
                    del self.documents[document_id]
                    self.logger.info(f"Cleaned up expired document {document_id}")
    
    def start_cleanup_task(self) -> None:
        """Start periodic cleanup task."""
        if self.cleanup_task is None or self.cleanup_task.done():
            self.cleanup_task = asyncio.create_task(self._cleanup_loop())
    
    async def _cleanup_loop(self) -> None:
        """Periodic cleanup loop."""
        while True:
            try:
                await asyncio.sleep(300)  # 5 minutes
                await self.cleanup_expired_documents()
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in cleanup loop: {e}")


# Global session manager
session_manager = CollaborationSessionManager()


class YjsProtocolHandler(CollaborationWebSocketMixin, WebSocketHandler):
    """WebSocket handler for Yjs CRDT protocol synchronization."""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.document_id: Optional[str] = None
        self.user_id: Optional[str] = None
        self.authenticated = False
        self.rate_limit_count = 0
        self.rate_limit_window = time.time()
        self.logger = logging.getLogger(__name__)
    
    def initialize(self, authenticator: CollaborationAuthenticator):
        """Initialize handler with authenticator."""
        self.initialize_collaboration_auth(authenticator)
    
    def check_origin(self, origin: str) -> bool:
        """Check WebSocket origin."""
        return True  # TODO: Implement proper origin checking
    
    async def open(self, document_id: str) -> None:
        """Handle WebSocket connection opening."""
        self.document_id = document_id
        self.logger.info(f"WebSocket connection opened for document {document_id}")
        
        # Start session manager cleanup task
        session_manager.start_cleanup_task()
        
        # Send authentication challenge
        await self.send_auth_challenge()
    
    async def on_message(self, message: Union[str, bytes]) -> None:
        """Handle incoming WebSocket messages."""
        try:
            # Rate limiting
            if not await self.check_rate_limit():
                await self.close(ERROR_RATE_LIMIT_EXCEEDED, "Rate limit exceeded")
                return
            
            if isinstance(message, str):
                # JSON message for collaboration events
                await self.handle_json_message(json.loads(message))
            else:
                # Binary message for Yjs protocol
                await self.handle_binary_message(message)
                
        except json.JSONDecodeError:
            self.logger.error("Invalid JSON message received")
            await self.close(ERROR_INVALID_MESSAGE, "Invalid message format")
        except Exception as e:
            self.logger.error(f"Error handling message: {e}")
            await self.close(ERROR_PROTOCOL_ERROR, "Protocol error")
    
    async def on_close(self) -> None:
        """Handle WebSocket connection closing."""
        if self.authenticated and self.document_id and self.user_id:
            await session_manager.remove_connection(self.document_id, self.user_id, self)
            await self.broadcast_user_leave()
        
        await self.end_collaboration_session()
        self.logger.info(f"WebSocket connection closed for document {self.document_id}")
    
    async def check_rate_limit(self) -> bool:
        """Check rate limiting."""
        current_time = time.time()
        
        # Reset counter if window expired
        if current_time - self.rate_limit_window > 60:  # 1 minute window
            self.rate_limit_count = 0
            self.rate_limit_window = current_time
        
        self.rate_limit_count += 1
        
        # Allow 1000 messages per minute
        return self.rate_limit_count <= 1000
    
    async def send_auth_challenge(self) -> None:
        """Send authentication challenge to client."""
        challenge = {
            "type": "auth_challenge",
            "challenge_id": str(uuid.uuid4()),
            "timestamp": time.time()
        }
        await self.write_message(json.dumps(challenge))
    
    async def handle_json_message(self, data: Dict[str, Any]) -> None:
        """Handle JSON collaboration messages."""
        message_type = data.get("type")
        
        if message_type == "auth_response":
            await self.handle_auth_response(data)
        elif not self.authenticated:
            await self.close(ERROR_AUTHENTICATION_FAILED, "Authentication required")
            return
        elif message_type == COLLAB_EVENT_CELL_LOCK:
            await self.handle_cell_lock(data)
        elif message_type == COLLAB_EVENT_CELL_UNLOCK:
            await self.handle_cell_unlock(data)
        elif message_type == COLLAB_EVENT_COMMENT_ADD:
            await self.handle_comment_add(data)
        elif message_type == COLLAB_EVENT_COMMENT_UPDATE:
            await self.handle_comment_update(data)
        elif message_type == COLLAB_EVENT_COMMENT_DELETE:
            await self.handle_comment_delete(data)
        elif message_type == COLLAB_EVENT_PERMISSION_CHANGE:
            await self.handle_permission_change(data)
        elif message_type == COLLAB_EVENT_SESSION_STATE:
            await self.handle_session_state_request(data)
        else:
            self.logger.warning(f"Unknown message type: {message_type}")
    
    async def handle_binary_message(self, message: bytes) -> None:
        """Handle binary Yjs protocol messages."""
        if not self.authenticated:
            await self.close(ERROR_AUTHENTICATION_FAILED, "Authentication required")
            return
        
        if len(message) == 0:
            return
        
        message_type = message[0]
        
        if message_type == YJS_MESSAGE_SYNC:
            await self.handle_yjs_sync(message[1:])
        elif message_type == YJS_MESSAGE_AWARENESS:
            await self.handle_yjs_awareness(message[1:])
        elif message_type == YJS_MESSAGE_QUERY_AWARENESS:
            await self.handle_yjs_query_awareness()
        else:
            self.logger.warning(f"Unknown Yjs message type: {message_type}")
    
    async def handle_auth_response(self, data: Dict[str, Any]) -> None:
        """Handle authentication response."""
        token = data.get("token")
        if not token:
            await self.close(ERROR_AUTHENTICATION_FAILED, "Token required")
            return
        
        # Authenticate user
        if not await self.authenticate_websocket(token):
            await self.close(ERROR_AUTHENTICATION_FAILED, "Authentication failed")
            return
        
        self.authenticated = True
        self.user_id = self.collaboration_user.user_id
        
        # Add connection to session manager
        await session_manager.add_connection(self.document_id, self.user_id, self)
        
        # Send authentication success
        auth_success = {
            "type": "auth_success",
            "user": self.collaboration_user.to_dict(),
            "timestamp": time.time()
        }
        await self.write_message(json.dumps(auth_success))
        
        # Broadcast user joined
        await self.broadcast_user_join()
        
        # Send initial document state
        await self.send_initial_state()
        
        self.logger.info(f"User {self.collaboration_user.username} authenticated for document {self.document_id}")
    
    async def handle_yjs_sync(self, message: bytes) -> None:
        """Handle Yjs sync messages."""
        if not self.check_permission("edit_notebook"):
            return
        
        document = await session_manager.get_document(self.document_id)
        
        if len(message) == 0:
            return
        
        sync_message_type = message[0]
        
        if sync_message_type == YJS_MESSAGE_SYNC_STEP1:
            # Client requesting state vector
            await self.handle_sync_step1(message[1:])
        elif sync_message_type == YJS_MESSAGE_SYNC_STEP2:
            # Client sending state vector, expecting update
            await self.handle_sync_step2(message[1:])
        elif sync_message_type == YJS_MESSAGE_SYNC_UPDATE:
            # Client sending update
            await self.handle_sync_update(message[1:])
    
    async def handle_sync_step1(self, message: bytes) -> None:
        """Handle Yjs sync step 1 - client requesting state vector."""
        document = await session_manager.get_document(self.document_id)
        
        # Send current state
        state = await document.get_yjs_state()
        response = bytes([YJS_MESSAGE_SYNC, YJS_MESSAGE_SYNC_STEP2]) + state
        await self.write_message(response, binary=True)
    
    async def handle_sync_step2(self, message: bytes) -> None:
        """Handle Yjs sync step 2 - client sending state vector."""
        document = await session_manager.get_document(self.document_id)
        
        # For now, send all updates
        # In a real implementation, this would compute the diff
        for update in document.yjs_updates:
            response = bytes([YJS_MESSAGE_SYNC, YJS_MESSAGE_SYNC_UPDATE]) + update
            await self.write_message(response, binary=True)
    
    async def handle_sync_update(self, message: bytes) -> None:
        """Handle Yjs sync update - client sending document update."""
        document = await session_manager.get_document(self.document_id)
        
        # Store update
        await document.add_yjs_update(message)
        
        # Broadcast update to other clients
        response = bytes([YJS_MESSAGE_SYNC, YJS_MESSAGE_SYNC_UPDATE]) + message
        await session_manager.broadcast_to_document(self.document_id, response, exclude_handler=self)
    
    async def handle_yjs_awareness(self, message: bytes) -> None:
        """Handle Yjs awareness messages."""
        try:
            # Decode awareness data (simplified)
            awareness_data = {
                "user_id": self.user_id,
                "user_name": self.collaboration_user.display_name,
                "cursor": None,  # Would be extracted from message
                "selection": None,  # Would be extracted from message
                "timestamp": time.time()
            }
            
            document = await session_manager.get_document(self.document_id)
            await document.update_awareness(self.user_id, awareness_data)
            
            # Broadcast awareness to other clients
            response = bytes([YJS_MESSAGE_AWARENESS]) + message
            await session_manager.broadcast_to_document(self.document_id, response, exclude_handler=self)
            
        except Exception as e:
            self.logger.error(f"Error handling awareness message: {e}")
    
    async def handle_yjs_query_awareness(self) -> None:
        """Handle Yjs query awareness messages."""
        document = await session_manager.get_document(self.document_id)
        
        # Send all awareness states
        for user_id, awareness_data in document.awareness_states.items():
            # Encode awareness data (simplified)
            awareness_message = json.dumps(awareness_data).encode()
            response = bytes([YJS_MESSAGE_AWARENESS]) + awareness_message
            await self.write_message(response, binary=True)
    
    async def handle_cell_lock(self, data: Dict[str, Any]) -> None:
        """Handle cell lock request."""
        if not await self.check_permission("lock_cells"):
            await self.send_error("permission_denied", "Insufficient permissions to lock cells")
            return
        
        cell_id = data.get("cell_id")
        if not cell_id:
            await self.send_error("invalid_request", "Cell ID required")
            return
        
        document = await session_manager.get_document(self.document_id)
        
        if await document.lock_cell(cell_id, self.user_id):
            # Broadcast lock event
            lock_event = {
                "type": COLLAB_EVENT_CELL_LOCK,
                "cell_id": cell_id,
                "user_id": self.user_id,
                "user_name": self.collaboration_user.display_name,
                "timestamp": time.time()
            }
            await self.broadcast_to_document(json.dumps(lock_event))
            
            # Send confirmation
            await self.write_message(json.dumps({
                "type": "lock_success",
                "cell_id": cell_id,
                "timestamp": time.time()
            }))
        else:
            await self.send_error("cell_locked", "Cell is already locked by another user")
    
    async def handle_cell_unlock(self, data: Dict[str, Any]) -> None:
        """Handle cell unlock request."""
        cell_id = data.get("cell_id")
        if not cell_id:
            await self.send_error("invalid_request", "Cell ID required")
            return
        
        document = await session_manager.get_document(self.document_id)
        force_unlock = data.get("force", False)
        
        if force_unlock and not await self.check_permission("force_unlock_cells"):
            await self.send_error("permission_denied", "Insufficient permissions to force unlock cells")
            return
        
        unlock_success = False
        if force_unlock:
            unlock_success = await document.force_unlock_cell(cell_id)
        else:
            unlock_success = await document.unlock_cell(cell_id, self.user_id)
        
        if unlock_success:
            # Broadcast unlock event
            unlock_event = {
                "type": COLLAB_EVENT_CELL_UNLOCK,
                "cell_id": cell_id,
                "user_id": self.user_id,
                "user_name": self.collaboration_user.display_name,
                "forced": force_unlock,
                "timestamp": time.time()
            }
            await self.broadcast_to_document(json.dumps(unlock_event))
            
            # Send confirmation
            await self.write_message(json.dumps({
                "type": "unlock_success",
                "cell_id": cell_id,
                "timestamp": time.time()
            }))
        else:
            await self.send_error("unlock_failed", "Failed to unlock cell")
    
    async def handle_comment_add(self, data: Dict[str, Any]) -> None:
        """Handle add comment request."""
        if not await self.check_permission("add_comments"):
            await self.send_error("permission_denied", "Insufficient permissions to add comments")
            return
        
        comment_data = {
            "id": str(uuid.uuid4()),
            "cell_id": data.get("cell_id"),
            "content": data.get("content", ""),
            "author_id": self.user_id,
            "author_name": self.collaboration_user.display_name,
            "parent_id": data.get("parent_id"),  # For threaded comments
            "resolved": False,
            "reactions": {}
        }
        
        if not comment_data["cell_id"] or not comment_data["content"]:
            await self.send_error("invalid_request", "Cell ID and content required")
            return
        
        document = await session_manager.get_document(self.document_id)
        await document.add_comment(comment_data["id"], comment_data)
        
        # Broadcast comment added event
        comment_event = {
            "type": COLLAB_EVENT_COMMENT_ADD,
            "comment": comment_data,
            "timestamp": time.time()
        }
        await self.broadcast_to_document(json.dumps(comment_event))
    
    async def handle_comment_update(self, data: Dict[str, Any]) -> None:
        """Handle update comment request."""
        comment_id = data.get("comment_id")
        if not comment_id:
            await self.send_error("invalid_request", "Comment ID required")
            return
        
        document = await session_manager.get_document(self.document_id)
        
        # Check permissions
        if comment_id in document.comments:
            comment = document.comments[comment_id]
            can_edit = (comment.get("author_id") == self.user_id and 
                       await self.check_permission("edit_own_comments")) or \
                      await self.check_permission("edit_all_comments")
            
            if not can_edit:
                await self.send_error("permission_denied", "Insufficient permissions to edit comment")
                return
        else:
            await self.send_error("not_found", "Comment not found")
            return
        
        # Update comment
        update_data = {
            "content": data.get("content", comment["content"]),
            "resolved": data.get("resolved", comment["resolved"]),
            "reactions": data.get("reactions", comment["reactions"])
        }
        
        if await document.update_comment(comment_id, update_data):
            # Broadcast comment updated event
            comment_event = {
                "type": COLLAB_EVENT_COMMENT_UPDATE,
                "comment_id": comment_id,
                "updates": update_data,
                "timestamp": time.time()
            }
            await self.broadcast_to_document(json.dumps(comment_event))
        else:
            await self.send_error("update_failed", "Failed to update comment")
    
    async def handle_comment_delete(self, data: Dict[str, Any]) -> None:
        """Handle delete comment request."""
        comment_id = data.get("comment_id")
        if not comment_id:
            await self.send_error("invalid_request", "Comment ID required")
            return
        
        document = await session_manager.get_document(self.document_id)
        
        # Check permissions
        if comment_id in document.comments:
            comment = document.comments[comment_id]
            can_delete = (comment.get("author_id") == self.user_id and 
                         await self.check_permission("edit_own_comments")) or \
                        await self.check_permission("edit_all_comments")
            
            if not can_delete:
                await self.send_error("permission_denied", "Insufficient permissions to delete comment")
                return
        else:
            await self.send_error("not_found", "Comment not found")
            return
        
        # Delete comment
        if await document.delete_comment(comment_id):
            # Broadcast comment deleted event
            comment_event = {
                "type": COLLAB_EVENT_COMMENT_DELETE,
                "comment_id": comment_id,
                "timestamp": time.time()
            }
            await self.broadcast_to_document(json.dumps(comment_event))
        else:
            await self.send_error("delete_failed", "Failed to delete comment")
    
    async def handle_permission_change(self, data: Dict[str, Any]) -> None:
        """Handle permission change request."""
        if not await self.check_permission("manage_permissions"):
            await self.send_error("permission_denied", "Insufficient permissions to manage permissions")
            return
        
        target_user_id = data.get("user_id")
        new_role = data.get("role")
        
        if not target_user_id or not new_role:
            await self.send_error("invalid_request", "User ID and role required")
            return
        
        document = await session_manager.get_document(self.document_id)
        document.permissions[target_user_id] = new_role
        
        # Broadcast permission change
        permission_event = {
            "type": COLLAB_EVENT_PERMISSION_CHANGE,
            "user_id": target_user_id,
            "role": new_role,
            "changed_by": self.user_id,
            "timestamp": time.time()
        }
        await self.broadcast_to_document(json.dumps(permission_event))
    
    async def handle_session_state_request(self, data: Dict[str, Any]) -> None:
        """Handle session state request."""
        document = await session_manager.get_document(self.document_id)
        
        session_state = {
            "type": "session_state",
            "document_state": document.to_dict(),
            "timestamp": time.time()
        }
        
        await self.write_message(json.dumps(session_state))
    
    async def send_initial_state(self) -> None:
        """Send initial document state to newly connected client."""
        document = await session_manager.get_document(self.document_id)
        
        # Send Yjs state
        state = await document.get_yjs_state()
        if state:
            response = bytes([YJS_MESSAGE_SYNC, YJS_MESSAGE_SYNC_STEP2]) + state
            await self.write_message(response, binary=True)
        
        # Send awareness states
        for user_id, awareness_data in document.awareness_states.items():
            if user_id != self.user_id:
                awareness_message = json.dumps(awareness_data).encode()
                response = bytes([YJS_MESSAGE_AWARENESS]) + awareness_message
                await self.write_message(response, binary=True)
        
        # Send session state
        session_state = {
            "type": "initial_state",
            "document_state": document.to_dict(),
            "timestamp": time.time()
        }
        await self.write_message(json.dumps(session_state))
    
    async def broadcast_user_join(self) -> None:
        """Broadcast user joined event."""
        user_event = {
            "type": COLLAB_EVENT_USER_JOIN,
            "user": self.collaboration_user.to_dict(),
            "timestamp": time.time()
        }
        await self.broadcast_to_document(json.dumps(user_event), exclude_self=True)
    
    async def broadcast_user_leave(self) -> None:
        """Broadcast user left event."""
        user_event = {
            "type": COLLAB_EVENT_USER_LEAVE,
            "user_id": self.user_id,
            "user_name": self.collaboration_user.display_name,
            "timestamp": time.time()
        }
        await self.broadcast_to_document(json.dumps(user_event), exclude_self=True)
    
    async def broadcast_to_document(self, message: str, exclude_self: bool = False) -> None:
        """Broadcast JSON message to all clients in document."""
        message_bytes = message.encode()
        exclude_handler = self if exclude_self else None
        await session_manager.broadcast_to_document(self.document_id, message_bytes, exclude_handler)
    
    async def send_error(self, error_type: str, message: str) -> None:
        """Send error message to client."""
        error_msg = {
            "type": "error",
            "error_type": error_type,
            "message": message,
            "timestamp": time.time()
        }
        await self.write_message(json.dumps(error_msg))


class CollaborationAPIHandler(JupyterHandler):
    """REST API handler for collaboration features."""
    
    def initialize(self, authenticator: CollaborationAuthenticator):
        """Initialize handler with authenticator."""
        self.authenticator = authenticator
    
    async def get(self, document_id: str) -> None:
        """Get collaboration information for a document."""
        # TODO: Implement authentication check
        
        document = await session_manager.get_document(document_id)
        
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({
            "document_id": document_id,
            "connected_users": len(document.connected_users),
            "version": document.version,
            "last_activity": document.last_activity,
            "collaboration_enabled": True
        }))
    
    async def post(self, document_id: str) -> None:
        """Create or join collaboration session."""
        # TODO: Implement authentication and session management
        
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({
            "status": "success",
            "document_id": document_id,
            "websocket_url": f"/api/collaboration/ws/{document_id}"
        }))


def add_collaboration_handlers(web_app, authenticator: CollaborationAuthenticator) -> None:
    """Add collaboration handlers to the web application."""
    base_url = web_app.settings.get("base_url", "/")
    
    # WebSocket handler for Yjs protocol
    web_app.add_handlers(
        ".*",
        [
            (
                url_path_join(base_url, r"/api/collaboration/ws/(.*)"),
                YjsProtocolHandler,
                {"authenticator": authenticator}
            ),
            (
                url_path_join(base_url, r"/api/collaboration/(.*)"),
                CollaborationAPIHandler,
                {"authenticator": authenticator}
            )
        ]
    )


# Initialize global session manager
def initialize_collaboration_handlers(web_app, authenticator: CollaborationAuthenticator) -> None:
    """Initialize collaboration handlers and session manager."""
    add_collaboration_handlers(web_app, authenticator)
    
    # Start session manager cleanup
    session_manager.start_cleanup_task()
    
    logging.getLogger(__name__).info(
        f"Collaboration handlers initialized for Jupyter Notebook v{__version__}"
    )