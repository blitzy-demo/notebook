"""WebSocket handlers for real-time collaborative editing in Jupyter Notebook v7.

This module implements WebSocket handlers for Yjs CRDT document synchronization,
user presence awareness, cell-level locking, commenting, and permissions management.
"""

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional, Set, Tuple, Union

import tornado.escape
import tornado.ioloop
import tornado.web
import tornado.websocket
from jupyter_server.auth import authorized
from jupyter_server.base.handlers import JupyterHandler
from tornado.websocket import WebSocketClosedError

# Set up logging
logger = logging.getLogger('notebook.collaboration')


class CollaborationWebSocketHandler(tornado.websocket.WebSocketHandler, JupyterHandler):
    """Base class for all collaboration WebSocket handlers.
    
    This class extends Tornado's WebSocketHandler and JupyterHandler to provide
    common functionality for all collaboration handlers, including authentication,
    user identification, and error handling.
    """
    
    def initialize(self, **kwargs: Any) -> None:
        """Initialize the handler with configuration options."""
        super().initialize(**kwargs)
        self.document_id = None
        self.user_id = None
        self.username = None
        self.clients_by_document = {}
        self.document_locks = {}
        self.last_activity = time.time()
    
    def check_origin(self, origin: str) -> bool:
        """Check if the origin is allowed to connect.
        
        This method is called during the WebSocket handshake to verify that the
        request origin is allowed to connect. It uses the JupyterHandler's
        check_origin method to enforce the same origin policy.
        
        Args:
            origin: The value of the Origin HTTP header
            
        Returns:
            True if the origin is allowed, False otherwise
        """
        # Use JupyterHandler's check_origin method which respects allow_origin setting
        return JupyterHandler.check_origin(self, origin)
    
    def get_current_user(self) -> Any:
        """Get the current authenticated user.
        
        Returns:
            The current user object from the JupyterHandler
        """
        return JupyterHandler.get_current_user(self)
    
    def open(self, document_id: str) -> None:
        """Handle WebSocket connection open.
        
        This method is called when a WebSocket connection is established. It
        authenticates the user, registers the connection, and initializes the
        document state.
        
        Args:
            document_id: The ID of the document being accessed
        """
        # Authenticate the user
        user = self.get_current_user()
        if not user:
            self.close(403, "Authentication required")
            return
        
        self.document_id = document_id
        self.user_id = user.get('name', 'anonymous')
        self.username = user.get('display_name', self.user_id)
        
        # Register this connection
        if document_id not in self.clients_by_document:
            self.clients_by_document[document_id] = set()
        self.clients_by_document[document_id].add(self)
        
        logger.info(f"WebSocket opened for document {document_id} by user {self.user_id}")
    
    def on_close(self) -> None:
        """Handle WebSocket connection close.
        
        This method is called when a WebSocket connection is closed. It removes
        the connection from the registry and cleans up any resources.
        """
        if self.document_id and self.document_id in self.clients_by_document:
            self.clients_by_document[self.document_id].discard(self)
            if not self.clients_by_document[self.document_id]:
                # No more clients for this document, clean up resources
                del self.clients_by_document[self.document_id]
        
        logger.info(f"WebSocket closed for document {self.document_id} by user {self.user_id}")
    
    def broadcast_to_document(self, message: Union[str, bytes], exclude_self: bool = False) -> None:
        """Broadcast a message to all clients connected to the same document.
        
        Args:
            message: The message to broadcast (string or binary)
            exclude_self: If True, don't send the message to the sender
        """
        if not self.document_id or self.document_id not in self.clients_by_document:
            return
        
        for client in self.clients_by_document[self.document_id]:
            if exclude_self and client is self:
                continue
            try:
                if isinstance(message, bytes):
                    client.write_message(message, binary=True)
                else:
                    client.write_message(message)
            except WebSocketClosedError:
                # Connection might have been closed, will be cleaned up on next cycle
                pass
    
    def check_permission(self, required_permission: str) -> bool:
        """Check if the current user has the required permission.
        
        Args:
            required_permission: The permission to check for
            
        Returns:
            True if the user has the permission, False otherwise
        """
        # This is a placeholder for a more sophisticated permission system
        # In a real implementation, this would check against a permission store
        return True


class YjsSyncHandler(CollaborationWebSocketHandler):
    """WebSocket handler for Yjs CRDT document synchronization.
    
    This handler manages the synchronization of Yjs documents between clients,
    handling binary update messages and state vector exchanges.
    """
    
    def initialize(self, **kwargs: Any) -> None:
        """Initialize the handler with Yjs-specific state."""
        super().initialize(**kwargs)
        self.document_states = {}
        self.update_queue = {}
    
    def open(self, document_id: str) -> None:
        """Handle WebSocket connection open for Yjs synchronization.
        
        Args:
            document_id: The ID of the document being synchronized
        """
        super().open(document_id)
        
        # Initialize document state if it doesn't exist
        if document_id not in self.document_states:
            # In a real implementation, we would load the document state from storage
            self.document_states[document_id] = bytearray()
        
        # Send initial sync step 1 message to client
        # This would be a state vector in a real implementation
        self.write_message(self.document_states[document_id], binary=True)
    
    def on_message(self, message: Union[str, bytes]) -> None:
        """Handle incoming Yjs update messages.
        
        Args:
            message: Binary Yjs update message
        """
        if not isinstance(message, bytes):
            logger.warning(f"Received non-binary message in YjsSyncHandler: {message}")
            return
        
        # In a real implementation, we would process the Yjs update message,
        # apply it to the document state, and broadcast it to other clients
        
        # For now, we'll just echo it back to all clients
        self.document_states[self.document_id] = message
        self.broadcast_to_document(message, exclude_self=True)
        
        # Update last activity timestamp
        self.last_activity = time.time()
        
        logger.debug(f"Processed Yjs update for document {self.document_id}")


class PresenceHandler(CollaborationWebSocketHandler):
    """WebSocket handler for user presence and awareness.
    
    This handler manages user presence information, including cursor positions,
    selections, and user metadata.
    """
    
    def initialize(self, **kwargs: Any) -> None:
        """Initialize the handler with presence-specific state."""
        super().initialize(**kwargs)
        self.awareness_states = {}
    
    def open(self, document_id: str) -> None:
        """Handle WebSocket connection open for presence awareness.
        
        Args:
            document_id: The ID of the document being accessed
        """
        super().open(document_id)
        
        # Initialize awareness state for this document if it doesn't exist
        if document_id not in self.awareness_states:
            self.awareness_states[document_id] = {}
        
        # Send current awareness state to the new client
        self.write_message(json.dumps({
            "type": "awareness",
            "states": self.awareness_states[document_id]
        }))
        
        # Broadcast new user joined
        self.broadcast_to_document(json.dumps({
            "type": "user-joined",
            "user": {
                "id": self.user_id,
                "name": self.username,
                "timestamp": time.time()
            }
        }), exclude_self=True)
    
    def on_message(self, message: Union[str, bytes]) -> None:
        """Handle incoming awareness messages.
        
        Args:
            message: JSON string containing awareness information
        """
        if isinstance(message, bytes):
            logger.warning("Received binary message in PresenceHandler")
            return
        
        try:
            data = json.loads(message)
            if data.get("type") == "awareness":
                # Update awareness state for this user
                awareness_data = data.get("state", {})
                
                # Add user metadata
                awareness_data["user"] = {
                    "id": self.user_id,
                    "name": self.username,
                    "timestamp": time.time()
                }
                
                # Store the awareness state
                self.awareness_states[self.document_id][self.user_id] = awareness_data
                
                # Broadcast to other clients
                self.broadcast_to_document(json.dumps({
                    "type": "awareness-update",
                    "user_id": self.user_id,
                    "state": awareness_data
                }), exclude_self=True)
                
                logger.debug(f"Updated awareness state for user {self.user_id} in document {self.document_id}")
        except json.JSONDecodeError:
            logger.warning(f"Invalid JSON in awareness message: {message}")
    
    def on_close(self) -> None:
        """Handle WebSocket connection close for presence awareness."""
        # Remove user's awareness state
        if self.document_id and self.document_id in self.awareness_states and self.user_id in self.awareness_states[self.document_id]:
            del self.awareness_states[self.document_id][self.user_id]
            
            # Broadcast user left
            self.broadcast_to_document(json.dumps({
                "type": "user-left",
                "user_id": self.user_id,
                "timestamp": time.time()
            }))
        
        super().on_close()


class LockHandler(CollaborationWebSocketHandler):
    """WebSocket handler for cell-level locking.
    
    This handler manages lock acquisition and release for cells to prevent
    concurrent editing conflicts.
    """
    
    def initialize(self, **kwargs: Any) -> None:
        """Initialize the handler with lock-specific state."""
        super().initialize(**kwargs)
        self.locks = {}
        self.lock_timeouts = {}
        self.lock_timeout_seconds = kwargs.get("lock_timeout_seconds", 60)
    
    def open(self, document_id: str) -> None:
        """Handle WebSocket connection open for lock management.
        
        Args:
            document_id: The ID of the document being accessed
        """
        super().open(document_id)
        
        # Initialize locks for this document if they don't exist
        if document_id not in self.locks:
            self.locks[document_id] = {}
        
        # Send current lock state to the new client
        self.write_message(json.dumps({
            "type": "locks",
            "locks": self.locks[document_id]
        }))
    
    def on_message(self, message: Union[str, bytes]) -> None:
        """Handle incoming lock messages.
        
        Args:
            message: JSON string containing lock operations
        """
        if isinstance(message, bytes):
            logger.warning("Received binary message in LockHandler")
            return
        
        try:
            data = json.loads(message)
            operation = data.get("operation")
            cell_id = data.get("cell_id")
            
            if not cell_id:
                logger.warning("Lock operation missing cell_id")
                return
            
            if operation == "acquire":
                self._handle_acquire_lock(cell_id, data)
            elif operation == "release":
                self._handle_release_lock(cell_id)
            elif operation == "heartbeat":
                self._handle_lock_heartbeat(cell_id)
            else:
                logger.warning(f"Unknown lock operation: {operation}")
        except json.JSONDecodeError:
            logger.warning(f"Invalid JSON in lock message: {message}")
    
    def _handle_acquire_lock(self, cell_id: str, data: Dict[str, Any]) -> None:
        """Handle a lock acquisition request.
        
        Args:
            cell_id: The ID of the cell to lock
            data: Additional lock request data
        """
        # Check if the cell is already locked
        if cell_id in self.locks[self.document_id]:
            current_lock = self.locks[self.document_id][cell_id]
            
            # If it's locked by someone else, deny the request
            if current_lock["user_id"] != self.user_id:
                self.write_message(json.dumps({
                    "type": "lock-denied",
                    "cell_id": cell_id,
                    "reason": "Cell is locked by another user",
                    "locked_by": current_lock["user_id"],
                    "locked_by_name": current_lock["username"]
                }))
                return
        
        # Grant the lock
        lock_info = {
            "user_id": self.user_id,
            "username": self.username,
            "timestamp": time.time(),
            "expires_at": time.time() + self.lock_timeout_seconds
        }
        
        self.locks[self.document_id][cell_id] = lock_info
        
        # Set up timeout for this lock
        self._set_lock_timeout(cell_id, self.lock_timeout_seconds)
        
        # Notify the requester that the lock was granted
        self.write_message(json.dumps({
            "type": "lock-granted",
            "cell_id": cell_id,
            "expires_at": lock_info["expires_at"]
        }))
        
        # Notify other clients about the lock
        self.broadcast_to_document(json.dumps({
            "type": "cell-locked",
            "cell_id": cell_id,
            "locked_by": self.user_id,
            "locked_by_name": self.username,
            "timestamp": lock_info["timestamp"],
            "expires_at": lock_info["expires_at"]
        }), exclude_self=True)
        
        logger.info(f"Cell {cell_id} locked by user {self.user_id} in document {self.document_id}")
    
    def _handle_release_lock(self, cell_id: str) -> None:
        """Handle a lock release request.
        
        Args:
            cell_id: The ID of the cell to unlock
        """
        # Check if the cell is locked by this user
        if cell_id in self.locks[self.document_id] and self.locks[self.document_id][cell_id]["user_id"] == self.user_id:
            # Remove the lock
            del self.locks[self.document_id][cell_id]
            
            # Cancel the timeout
            if cell_id in self.lock_timeouts:
                self.lock_timeouts[cell_id].cancel()
                del self.lock_timeouts[cell_id]
            
            # Notify all clients that the lock was released
            self.broadcast_to_document(json.dumps({
                "type": "cell-unlocked",
                "cell_id": cell_id,
                "previous_owner": self.user_id,
                "timestamp": time.time()
            }))
            
            logger.info(f"Cell {cell_id} unlocked by user {self.user_id} in document {self.document_id}")
    
    def _handle_lock_heartbeat(self, cell_id: str) -> None:
        """Handle a lock heartbeat to extend the lock timeout.
        
        Args:
            cell_id: The ID of the cell with the lock to extend
        """
        # Check if the cell is locked by this user
        if cell_id in self.locks[self.document_id] and self.locks[self.document_id][cell_id]["user_id"] == self.user_id:
            # Update the expiration time
            self.locks[self.document_id][cell_id]["expires_at"] = time.time() + self.lock_timeout_seconds
            
            # Reset the timeout
            self._set_lock_timeout(cell_id, self.lock_timeout_seconds)
            
            # Notify the client that the lock was extended
            self.write_message(json.dumps({
                "type": "lock-extended",
                "cell_id": cell_id,
                "expires_at": self.locks[self.document_id][cell_id]["expires_at"]
            }))
    
    def _set_lock_timeout(self, cell_id: str, timeout_seconds: int) -> None:
        """Set a timeout for a lock to automatically expire.
        
        Args:
            cell_id: The ID of the cell with the lock
            timeout_seconds: The number of seconds until the lock expires
        """
        # Cancel any existing timeout for this cell
        if cell_id in self.lock_timeouts:
            self.lock_timeouts[cell_id].cancel()
        
        # Set a new timeout
        def expire_lock():
            if cell_id in self.locks[self.document_id]:
                expired_lock = self.locks[self.document_id][cell_id]
                del self.locks[self.document_id][cell_id]
                
                # Notify all clients that the lock expired
                self.broadcast_to_document(json.dumps({
                    "type": "lock-expired",
                    "cell_id": cell_id,
                    "previous_owner": expired_lock["user_id"],
                    "timestamp": time.time()
                }))
                
                logger.info(f"Lock for cell {cell_id} expired in document {self.document_id}")
        
        self.lock_timeouts[cell_id] = tornado.ioloop.IOLoop.current().call_later(
            timeout_seconds, expire_lock)
    
    def on_close(self) -> None:
        """Handle WebSocket connection close for lock management."""
        # Release all locks held by this user
        if self.document_id and self.document_id in self.locks:
            cells_to_unlock = []
            for cell_id, lock_info in self.locks[self.document_id].items():
                if lock_info["user_id"] == self.user_id:
                    cells_to_unlock.append(cell_id)
            
            for cell_id in cells_to_unlock:
                self._handle_release_lock(cell_id)
        
        super().on_close()


class CommentHandler(CollaborationWebSocketHandler):
    """WebSocket handler for comment synchronization.
    
    This handler manages the creation, editing, and resolution of comments
    attached to cells or code blocks.
    """
    
    def initialize(self, **kwargs: Any) -> None:
        """Initialize the handler with comment-specific state."""
        super().initialize(**kwargs)
        self.comments = {}
        self.comment_threads = {}
    
    def open(self, document_id: str) -> None:
        """Handle WebSocket connection open for comment synchronization.
        
        Args:
            document_id: The ID of the document being accessed
        """
        super().open(document_id)
        
        # Initialize comments for this document if they don't exist
        if document_id not in self.comments:
            self.comments[document_id] = {}
        
        if document_id not in self.comment_threads:
            self.comment_threads[document_id] = {}
        
        # Send current comments to the new client
        self.write_message(json.dumps({
            "type": "comments",
            "comments": self.comments[document_id],
            "threads": self.comment_threads[document_id]
        }))
    
    def on_message(self, message: Union[str, bytes]) -> None:
        """Handle incoming comment messages.
        
        Args:
            message: JSON string containing comment operations
        """
        if isinstance(message, bytes):
            logger.warning("Received binary message in CommentHandler")
            return
        
        try:
            data = json.loads(message)
            operation = data.get("operation")
            
            if operation == "create":
                self._handle_create_comment(data)
            elif operation == "edit":
                self._handle_edit_comment(data)
            elif operation == "resolve":
                self._handle_resolve_comment(data)
            elif operation == "delete":
                self._handle_delete_comment(data)
            elif operation == "reply":
                self._handle_reply_comment(data)
            else:
                logger.warning(f"Unknown comment operation: {operation}")
        except json.JSONDecodeError:
            logger.warning(f"Invalid JSON in comment message: {message}")
    
    def _handle_create_comment(self, data: Dict[str, Any]) -> None:
        """Handle a comment creation request.
        
        Args:
            data: Comment creation data
        """
        comment_id = data.get("comment_id") or f"comment_{int(time.time() * 1000)}_{self.user_id}"
        cell_id = data.get("cell_id")
        content = data.get("content")
        range_start = data.get("range_start")
        range_end = data.get("range_end")
        
        if not cell_id or not content:
            logger.warning("Comment creation missing required fields")
            return
        
        # Create the comment
        comment = {
            "id": comment_id,
            "cell_id": cell_id,
            "content": content,
            "user_id": self.user_id,
            "username": self.username,
            "created_at": time.time(),
            "updated_at": time.time(),
            "resolved": False,
            "resolved_by": None,
            "resolved_at": None
        }
        
        # Add range information if provided
        if range_start is not None and range_end is not None:
            comment["range_start"] = range_start
            comment["range_end"] = range_end
        
        # Store the comment
        self.comments[self.document_id][comment_id] = comment
        
        # Create a thread for this comment
        thread_id = data.get("thread_id") or comment_id
        if thread_id not in self.comment_threads[self.document_id]:
            self.comment_threads[self.document_id][thread_id] = {
                "id": thread_id,
                "comments": [comment_id],
                "cell_id": cell_id
            }
        else:
            self.comment_threads[self.document_id][thread_id]["comments"].append(comment_id)
        
        # Broadcast to all clients
        self.broadcast_to_document(json.dumps({
            "type": "comment-created",
            "comment": comment,
            "thread_id": thread_id
        }))
        
        logger.info(f"Comment {comment_id} created by user {self.user_id} in document {self.document_id}")
    
    def _handle_edit_comment(self, data: Dict[str, Any]) -> None:
        """Handle a comment edit request.
        
        Args:
            data: Comment edit data
        """
        comment_id = data.get("comment_id")
        content = data.get("content")
        
        if not comment_id or not content or comment_id not in self.comments[self.document_id]:
            logger.warning("Comment edit missing required fields or comment not found")
            return
        
        comment = self.comments[self.document_id][comment_id]
        
        # Check if the user is allowed to edit this comment
        if comment["user_id"] != self.user_id and not self.check_permission("edit_any_comment"):
            self.write_message(json.dumps({
                "type": "comment-edit-denied",
                "comment_id": comment_id,
                "reason": "You don't have permission to edit this comment"
            }))
            return
        
        # Update the comment
        comment["content"] = content
        comment["updated_at"] = time.time()
        
        # Broadcast to all clients
        self.broadcast_to_document(json.dumps({
            "type": "comment-edited",
            "comment": comment
        }))
        
        logger.info(f"Comment {comment_id} edited by user {self.user_id} in document {self.document_id}")
    
    def _handle_resolve_comment(self, data: Dict[str, Any]) -> None:
        """Handle a comment resolution request.
        
        Args:
            data: Comment resolution data
        """
        thread_id = data.get("thread_id")
        
        if not thread_id or thread_id not in self.comment_threads[self.document_id]:
            logger.warning("Comment resolution missing thread_id or thread not found")
            return
        
        thread = self.comment_threads[self.document_id][thread_id]
        
        # Mark all comments in the thread as resolved
        for comment_id in thread["comments"]:
            if comment_id in self.comments[self.document_id]:
                comment = self.comments[self.document_id][comment_id]
                comment["resolved"] = True
                comment["resolved_by"] = self.user_id
                comment["resolved_at"] = time.time()
        
        # Broadcast to all clients
        self.broadcast_to_document(json.dumps({
            "type": "thread-resolved",
            "thread_id": thread_id,
            "resolved_by": self.user_id,
            "resolved_at": time.time()
        }))
        
        logger.info(f"Comment thread {thread_id} resolved by user {self.user_id} in document {self.document_id}")
    
    def _handle_delete_comment(self, data: Dict[str, Any]) -> None:
        """Handle a comment deletion request.
        
        Args:
            data: Comment deletion data
        """
        comment_id = data.get("comment_id")
        
        if not comment_id or comment_id not in self.comments[self.document_id]:
            logger.warning("Comment deletion missing comment_id or comment not found")
            return
        
        comment = self.comments[self.document_id][comment_id]
        
        # Check if the user is allowed to delete this comment
        if comment["user_id"] != self.user_id and not self.check_permission("delete_any_comment"):
            self.write_message(json.dumps({
                "type": "comment-delete-denied",
                "comment_id": comment_id,
                "reason": "You don't have permission to delete this comment"
            }))
            return
        
        # Remove the comment from any threads
        for thread_id, thread in self.comment_threads[self.document_id].items():
            if comment_id in thread["comments"]:
                thread["comments"].remove(comment_id)
                
                # If the thread is now empty, remove it
                if not thread["comments"]:
                    del self.comment_threads[self.document_id][thread_id]
        
        # Delete the comment
        del self.comments[self.document_id][comment_id]
        
        # Broadcast to all clients
        self.broadcast_to_document(json.dumps({
            "type": "comment-deleted",
            "comment_id": comment_id
        }))
        
        logger.info(f"Comment {comment_id} deleted by user {self.user_id} in document {self.document_id}")
    
    def _handle_reply_comment(self, data: Dict[str, Any]) -> None:
        """Handle a comment reply request.
        
        Args:
            data: Comment reply data
        """
        thread_id = data.get("thread_id")
        content = data.get("content")
        
        if not thread_id or not content or thread_id not in self.comment_threads[self.document_id]:
            logger.warning("Comment reply missing required fields or thread not found")
            return
        
        thread = self.comment_threads[self.document_id][thread_id]
        
        # Create a new comment as a reply
        comment_id = f"comment_{int(time.time() * 1000)}_{self.user_id}"
        comment = {
            "id": comment_id,
            "cell_id": thread["cell_id"],
            "content": content,
            "user_id": self.user_id,
            "username": self.username,
            "created_at": time.time(),
            "updated_at": time.time(),
            "resolved": False,
            "resolved_by": None,
            "resolved_at": None,
            "is_reply": True,
            "thread_id": thread_id
        }
        
        # Store the comment
        self.comments[self.document_id][comment_id] = comment
        
        # Add to the thread
        thread["comments"].append(comment_id)
        
        # If the thread was resolved, mark it as unresolved
        for comment_id in thread["comments"]:
            if comment_id in self.comments[self.document_id]:
                comment = self.comments[self.document_id][comment_id]
                if comment.get("resolved", False):
                    comment["resolved"] = False
                    comment["resolved_by"] = None
                    comment["resolved_at"] = None
        
        # Broadcast to all clients
        self.broadcast_to_document(json.dumps({
            "type": "comment-reply-added",
            "comment": comment,
            "thread_id": thread_id
        }))
        
        logger.info(f"Reply added to thread {thread_id} by user {self.user_id} in document {self.document_id}")


class PermissionsHandler(CollaborationWebSocketHandler):
    """WebSocket handler for permission management.
    
    This handler manages access control for collaborative editing, including
    role-based permissions and user capabilities.
    """
    
    def initialize(self, **kwargs: Any) -> None:
        """Initialize the handler with permission-specific state."""
        super().initialize(**kwargs)
        self.permissions = {}
        self.roles = {
            "viewer": ["view"],
            "commenter": ["view", "comment"],
            "editor": ["view", "comment", "edit"],
            "owner": ["view", "comment", "edit", "manage"]
        }
    
    def open(self, document_id: str) -> None:
        """Handle WebSocket connection open for permission management.
        
        Args:
            document_id: The ID of the document being accessed
        """
        super().open(document_id)
        
        # Initialize permissions for this document if they don't exist
        if document_id not in self.permissions:
            self.permissions[document_id] = {
                "default_role": "viewer",
                "users": {}
            }
            
            # The first user to connect becomes the owner
            self.permissions[document_id]["users"][self.user_id] = "owner"
        
        # Check if this user has a role, if not assign the default role
        if self.user_id not in self.permissions[document_id]["users"]:
            self.permissions[document_id]["users"][self.user_id] = self.permissions[document_id]["default_role"]
        
        # Send current permissions to the new client
        self.write_message(json.dumps({
            "type": "permissions",
            "permissions": self.permissions[document_id],
            "roles": self.roles,
            "your_role": self.permissions[document_id]["users"].get(self.user_id, self.permissions[document_id]["default_role"])
        }))
        
        # Broadcast user joined with their role
        self.broadcast_to_document(json.dumps({
            "type": "user-role-updated",
            "user_id": self.user_id,
            "username": self.username,
            "role": self.permissions[document_id]["users"].get(self.user_id, self.permissions[document_id]["default_role"])
        }), exclude_self=True)
    
    def on_message(self, message: Union[str, bytes]) -> None:
        """Handle incoming permission messages.
        
        Args:
            message: JSON string containing permission operations
        """
        if isinstance(message, bytes):
            logger.warning("Received binary message in PermissionsHandler")
            return
        
        try:
            data = json.loads(message)
            operation = data.get("operation")
            
            if operation == "set_user_role":
                self._handle_set_user_role(data)
            elif operation == "set_default_role":
                self._handle_set_default_role(data)
            elif operation == "check_permission":
                self._handle_check_permission(data)
            else:
                logger.warning(f"Unknown permission operation: {operation}")
        except json.JSONDecodeError:
            logger.warning(f"Invalid JSON in permission message: {message}")
    
    def _handle_set_user_role(self, data: Dict[str, Any]) -> None:
        """Handle a request to set a user's role.
        
        Args:
            data: Role assignment data
        """
        target_user_id = data.get("user_id")
        role = data.get("role")
        
        if not target_user_id or not role or role not in self.roles:
            logger.warning("Set user role missing required fields or invalid role")
            return
        
        # Check if the current user has permission to manage roles
        current_user_role = self.permissions[self.document_id]["users"].get(self.user_id, self.permissions[self.document_id]["default_role"])
        if "manage" not in self.roles.get(current_user_role, []):
            self.write_message(json.dumps({
                "type": "permission-denied",
                "operation": "set_user_role",
                "reason": "You don't have permission to manage roles"
            }))
            return
        
        # Set the user's role
        self.permissions[self.document_id]["users"][target_user_id] = role
        
        # Broadcast to all clients
        self.broadcast_to_document(json.dumps({
            "type": "user-role-updated",
            "user_id": target_user_id,
            "role": role,
            "updated_by": self.user_id
        }))
        
        logger.info(f"User {target_user_id} role set to {role} by user {self.user_id} in document {self.document_id}")
    
    def _handle_set_default_role(self, data: Dict[str, Any]) -> None:
        """Handle a request to set the default role for new users.
        
        Args:
            data: Default role data
        """
        role = data.get("role")
        
        if not role or role not in self.roles:
            logger.warning("Set default role missing required fields or invalid role")
            return
        
        # Check if the current user has permission to manage roles
        current_user_role = self.permissions[self.document_id]["users"].get(self.user_id, self.permissions[self.document_id]["default_role"])
        if "manage" not in self.roles.get(current_user_role, []):
            self.write_message(json.dumps({
                "type": "permission-denied",
                "operation": "set_default_role",
                "reason": "You don't have permission to manage roles"
            }))
            return
        
        # Set the default role
        self.permissions[self.document_id]["default_role"] = role
        
        # Broadcast to all clients
        self.broadcast_to_document(json.dumps({
            "type": "default-role-updated",
            "role": role,
            "updated_by": self.user_id
        }))
        
        logger.info(f"Default role set to {role} by user {self.user_id} in document {self.document_id}")
    
    def _handle_check_permission(self, data: Dict[str, Any]) -> None:
        """Handle a request to check if a user has a specific permission.
        
        Args:
            data: Permission check data
        """
        permission = data.get("permission")
        target_user_id = data.get("user_id", self.user_id)
        
        if not permission:
            logger.warning("Check permission missing required fields")
            return
        
        # Get the user's role
        role = self.permissions[self.document_id]["users"].get(
            target_user_id, self.permissions[self.document_id]["default_role"])
        
        # Check if the role has the permission
        has_permission = permission in self.roles.get(role, [])
        
        # Send the result back to the requester
        self.write_message(json.dumps({
            "type": "permission-check-result",
            "user_id": target_user_id,
            "permission": permission,
            "has_permission": has_permission
        }))


# Define the URL patterns for the WebSocket handlers
default_handlers = [
    (r"/api/collab/(?P<document_id>[^/]+)", YjsSyncHandler),
    (r"/api/collab/(?P<document_id>[^/]+)/awareness", PresenceHandler),
    (r"/api/collab/(?P<document_id>[^/]+)/locks", LockHandler),
    (r"/api/collab/(?P<document_id>[^/]+)/comments", CommentHandler),
    (r"/api/collab/(?P<document_id>[^/]+)/permissions", PermissionsHandler),
]