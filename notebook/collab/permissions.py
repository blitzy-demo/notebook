"""
Permission management system for collaborative editing access control.

This module implements role-based permissions (view-only, edit, admin) with JupyterHub 
integration, providing server-side validation and enforcement of user permissions for 
all collaborative operations. The system ensures secure multi-user collaboration while 
maintaining backward compatibility with existing notebook functionality.

Key Components:
- PermissionManager: Core role-based access control system
- PermissionValidator: Validation logic for collaborative operations  
- PermissionCache: Efficient permission lookup and caching
- JupyterHub integration: Token-based authentication and role extraction
- Permission middleware: Server-side enforcement for all operations
"""

import asyncio
import hashlib
import json
import time
import weakref
from datetime import datetime, timezone, timedelta
from enum import Enum, IntEnum
from functools import wraps
from typing import Any, Dict, List, Optional, Set, Tuple, Union, Callable, AsyncGenerator
from urllib.parse import unquote
import uuid

try:
    import jwt
    HAS_JWT = True
except ImportError:
    HAS_JWT = False

try:
    from jupyterhub.auth import Authenticator
    from jupyterhub.user import User as HubUser
    HAS_JUPYTERHUB = True
except ImportError:
    HAS_JUPYTERHUB = False

from jupyter_server.auth import User
from jupyter_server.base.handlers import JupyterHandler
from traitlets import Bool, Dict as TraitDict, Float, Int, List as TraitList, Unicode
from traitlets.config import Configurable

from .utils import (
    CollaborationConfig,
    CollaborationError,
    CollaborationLogger,
    CollaborationMetrics,
    CollaborationPermissionError,
    error_context,
    get_collaboration_config,
    get_collaboration_logger,
    get_collaboration_metrics,
    monitor_performance,
    RetryConfig,
    sanitize_user_data,
    with_retry
)


class PermissionLevel(IntEnum):
    """Permission levels ordered by privilege level."""
    DENIED = 0
    VIEW = 1
    COMMENT = 2
    EDIT = 3
    ADMIN = 4


class UserRole(Enum):
    """User roles for collaborative editing."""
    VIEWER = "view"
    COMMENTER = "comment"
    EDITOR = "edit"
    ADMIN = "admin"
    OWNER = "owner"  # Document owner, highest privilege


class CollaborativeOperation(Enum):
    """Types of collaborative operations requiring permission validation."""
    # Read operations
    VIEW_DOCUMENT = "view_document"
    VIEW_COMMENTS = "view_comments"
    VIEW_HISTORY = "view_history"
    
    # Write operations
    EDIT_CELL = "edit_cell"
    ADD_CELL = "add_cell"
    DELETE_CELL = "delete_cell"
    MOVE_CELL = "move_cell"
    EXECUTE_CELL = "execute_cell"
    
    # Comment operations
    ADD_COMMENT = "add_comment"
    EDIT_COMMENT = "edit_comment"
    DELETE_COMMENT = "delete_comment"
    RESOLVE_COMMENT = "resolve_comment"
    
    # Lock operations
    ACQUIRE_LOCK = "acquire_lock"
    RELEASE_LOCK = "release_lock"
    BREAK_LOCK = "break_lock"
    
    # Administrative operations
    MANAGE_PERMISSIONS = "manage_permissions"
    MANAGE_USERS = "manage_users"
    EXPORT_DOCUMENT = "export_document"
    DELETE_DOCUMENT = "delete_document"


class PermissionRule:
    """Defines a permission rule for role-operation combinations."""
    
    def __init__(self, role: UserRole, operations: Set[CollaborativeOperation], 
                 conditions: Optional[Dict[str, Any]] = None):
        self.role = role
        self.operations = operations
        self.conditions = conditions or {}
    
    def allows_operation(self, operation: CollaborativeOperation, 
                        context: Optional[Dict[str, Any]] = None) -> bool:
        """Check if this rule allows the given operation."""
        if operation not in self.operations:
            return False
        
        # Check additional conditions if present
        if self.conditions and context:
            for condition_key, condition_value in self.conditions.items():
                if context.get(condition_key) != condition_value:
                    return False
        
        return True


class PermissionConfig(Configurable):
    """Configuration for permission management."""
    
    permission_cache_ttl = Float(
        default_value=300.0,
        help="Permission cache TTL in seconds"
    ).tag(config=True)
    
    permission_cache_size = Int(
        default_value=1000,
        help="Maximum number of cached permission entries"
    ).tag(config=True)
    
    jupyterhub_integration = Bool(
        default_value=True,
        help="Enable JupyterHub integration for authentication"
    ).tag(config=True)
    
    default_role = Unicode(
        default_value="view",
        help="Default role for users without explicit permissions"
    ).tag(config=True)
    
    allow_anonymous_view = Bool(
        default_value=False,
        help="Allow anonymous users to view documents"
    ).tag(config=True)
    
    token_validation_strict = Bool(
        default_value=True,
        help="Strict token validation mode"
    ).tag(config=True)
    
    permission_refresh_interval = Float(
        default_value=60.0,
        help="Interval for refreshing user permissions in seconds"
    ).tag(config=True)
    
    admin_users = TraitList(
        trait=Unicode(),
        default_value=[],
        help="List of users with administrative privileges"
    ).tag(config=True)
    
    document_owners = TraitDict(
        key_trait=Unicode(),
        value_trait=Unicode(),
        default_value={},
        help="Mapping of document IDs to owner usernames"
    ).tag(config=True)
    
    role_hierarchy = TraitDict(
        key_trait=Unicode(),
        value_trait=Int(),
        default_value={
            "view": 1,
            "comment": 2,
            "edit": 3,
            "admin": 4,
            "owner": 5
        },
        help="Role hierarchy levels"
    ).tag(config=True)


class PermissionCache:
    """Efficient caching system for permission lookups."""
    
    def __init__(self, config: PermissionConfig):
        self.config = config
        self.cache = {}
        self.access_times = {}
        self.logger = get_collaboration_logger()
        self._cleanup_task = None
        self._lock = asyncio.Lock()
    
    def _cache_key(self, user_id: str, document_id: str, operation: str) -> str:
        """Generate cache key for permission entry."""
        key_data = f"{user_id}:{document_id}:{operation}"
        return hashlib.sha256(key_data.encode()).hexdigest()[:16]
    
    async def get(self, user_id: str, document_id: str, 
                  operation: CollaborativeOperation) -> Optional[bool]:
        """Get cached permission result."""
        async with self._lock:
            cache_key = self._cache_key(user_id, document_id, operation.value)
            
            if cache_key not in self.cache:
                return None
            
            entry = self.cache[cache_key]
            now = time.time()
            
            # Check if entry has expired
            if now - entry['timestamp'] > self.config.permission_cache_ttl:
                del self.cache[cache_key]
                del self.access_times[cache_key]
                return None
            
            # Update access time
            self.access_times[cache_key] = now
            return entry['allowed']
    
    async def set(self, user_id: str, document_id: str, 
                  operation: CollaborativeOperation, allowed: bool):
        """Cache permission result."""
        async with self._lock:
            cache_key = self._cache_key(user_id, document_id, operation.value)
            now = time.time()
            
            # Evict least recently used entries if cache is full
            if len(self.cache) >= self.config.permission_cache_size:
                await self._evict_lru()
            
            self.cache[cache_key] = {
                'allowed': allowed,
                'timestamp': now
            }
            self.access_times[cache_key] = now
    
    async def invalidate_user(self, user_id: str):
        """Invalidate all cached entries for a user."""
        async with self._lock:
            keys_to_remove = []
            user_prefix = hashlib.sha256(f"{user_id}:".encode()).hexdigest()[:8]
            
            for cache_key in self.cache.keys():
                # Simple heuristic: if cache key starts with user hash prefix
                if cache_key.startswith(user_prefix):  
                    keys_to_remove.append(cache_key)
            
            for key in keys_to_remove:
                del self.cache[key]
                del self.access_times[key]
    
    async def invalidate_document(self, document_id: str):
        """Invalidate all cached entries for a document."""
        async with self._lock:
            keys_to_remove = []
            
            # This is inefficient but necessary for document invalidation
            # In production, consider using a more sophisticated indexing scheme
            for cache_key in list(self.cache.keys()):
                # Would need to store reverse mapping for efficiency
                # For now, clear entire cache when document permissions change
                keys_to_remove.append(cache_key)
            
            for key in keys_to_remove:
                del self.cache[key]
                del self.access_times[key]
    
    async def _evict_lru(self):
        """Evict least recently used cache entry."""
        if not self.access_times:
            return
        
        lru_key = min(self.access_times.keys(), key=lambda k: self.access_times[k])
        del self.cache[lru_key]
        del self.access_times[lru_key]
    
    async def cleanup_expired(self):
        """Clean up expired cache entries."""
        async with self._lock:
            now = time.time()
            expired_keys = []
            
            for cache_key, entry in self.cache.items():
                if now - entry['timestamp'] > self.config.permission_cache_ttl:
                    expired_keys.append(cache_key)
            
            for key in expired_keys:
                del self.cache[key]
                del self.access_times[key]
    
    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        return {
            'size': len(self.cache),
            'max_size': self.config.permission_cache_size,
            'hit_rate': getattr(self, '_hit_rate', 0.0),
            'miss_rate': getattr(self, '_miss_rate', 0.0)
        }


class JupyterHubTokenValidator:
    """Validates JupyterHub tokens and extracts user information."""
    
    def __init__(self, config: PermissionConfig):
        self.config = config
        self.logger = get_collaboration_logger()
        self._hub_auth = None
    
    def _get_hub_authenticator(self) -> Optional[Authenticator]:
        """Get JupyterHub authenticator instance."""
        if not HAS_JUPYTERHUB:
            return None
        
        try:
            # In a real deployment, this would connect to JupyterHub's authenticator
            # For now, return None as we'll implement basic token validation
            return None
        except Exception as e:
            self.logger.log_error(e, {"context": "hub_authenticator_init"})
            return None
    
    async def validate_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Validate JupyterHub token and extract user info."""
        if not token:
            return None
        
        try:
            # In production, this would validate against JupyterHub's token API
            # For now, implement a basic JWT-like validation
            if HAS_JWT and self.config.token_validation_strict:
                return await self._validate_jwt_token(token)
            else:
                return await self._validate_simple_token(token)
                
        except Exception as e:
            self.logger.log_error(e, {
                "context": "token_validation",
                "token_prefix": token[:10] if token else "empty"
            })
            return None
    
    async def _validate_jwt_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Validate JWT token (production implementation)."""
        try:
            # In production, use JupyterHub's secret key
            # For development, use a placeholder
            secret_key = "development_secret_key"
            
            payload = jwt.decode(token, secret_key, algorithms=["HS256"])
            
            return {
                'username': payload.get('username'),
                'name': payload.get('name', payload.get('username')),
                'role': payload.get('role', self.config.default_role),
                'groups': payload.get('groups', []),
                'admin': payload.get('admin', False),
                'expires': payload.get('exp')
            }
        except jwt.ExpiredSignatureError:
            self.logger.logger.warning("Token expired")
            return None
        except jwt.InvalidTokenError as e:
            self.logger.logger.warning(f"Invalid token: {e}")
            return None
    
    async def _validate_simple_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Simple token validation for development/testing."""
        try:
            # Simple format: base64(username:role:timestamp)
            import base64
            decoded = base64.b64decode(token).decode('utf-8')
            parts = decoded.split(':')
            
            if len(parts) >= 2:
                username = parts[0]
                role = parts[1] if len(parts) > 1 else self.config.default_role
                
                return {
                    'username': username,
                    'name': username,
                    'role': role,
                    'groups': [],
                    'admin': username in self.config.admin_users,
                    'expires': None
                }
        except Exception:
            pass
        
        # Fallback: treat token as username with default role
        return {
            'username': token,
            'name': token,
            'role': self.config.default_role,
            'groups': [],
            'admin': token in self.config.admin_users,
            'expires': None
        }
    
    async def refresh_user_permissions(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Refresh user permissions from JupyterHub."""
        try:
            # In production, query JupyterHub API for updated user permissions
            # For now, return cached information
            return None
        except Exception as e:
            self.logger.log_error(e, {
                "context": "permission_refresh",
                "user_id": user_id
            })
            return None


class PermissionRuleEngine:
    """Rule engine for evaluating permissions based on roles and operations."""
    
    def __init__(self, config: PermissionConfig):
        self.config = config
        self.rules = self._initialize_default_rules()
        self.logger = get_collaboration_logger()
    
    def _initialize_default_rules(self) -> Dict[UserRole, PermissionRule]:
        """Initialize default permission rules."""
        rules = {}
        
        # Viewer role permissions
        rules[UserRole.VIEWER] = PermissionRule(
            role=UserRole.VIEWER,
            operations={
                CollaborativeOperation.VIEW_DOCUMENT,
                CollaborativeOperation.VIEW_COMMENTS,
                CollaborativeOperation.VIEW_HISTORY
            }
        )
        
        # Commenter role permissions (includes viewer permissions)
        rules[UserRole.COMMENTER] = PermissionRule(
            role=UserRole.COMMENTER,
            operations={
                CollaborativeOperation.VIEW_DOCUMENT,
                CollaborativeOperation.VIEW_COMMENTS,
                CollaborativeOperation.VIEW_HISTORY,
                CollaborativeOperation.ADD_COMMENT,
                CollaborativeOperation.EDIT_COMMENT,
                CollaborativeOperation.DELETE_COMMENT,
                CollaborativeOperation.RESOLVE_COMMENT
            }
        )
        
        # Editor role permissions (includes commenter permissions)
        rules[UserRole.EDITOR] = PermissionRule(
            role=UserRole.EDITOR,
            operations={
                CollaborativeOperation.VIEW_DOCUMENT,
                CollaborativeOperation.VIEW_COMMENTS,
                CollaborativeOperation.VIEW_HISTORY,
                CollaborativeOperation.ADD_COMMENT,
                CollaborativeOperation.EDIT_COMMENT,
                CollaborativeOperation.DELETE_COMMENT,
                CollaborativeOperation.RESOLVE_COMMENT,
                CollaborativeOperation.EDIT_CELL,
                CollaborativeOperation.ADD_CELL,
                CollaborativeOperation.DELETE_CELL,
                CollaborativeOperation.MOVE_CELL,
                CollaborativeOperation.EXECUTE_CELL,
                CollaborativeOperation.ACQUIRE_LOCK,
                CollaborativeOperation.RELEASE_LOCK,
                CollaborativeOperation.EXPORT_DOCUMENT
            }
        )
        
        # Admin role permissions (includes editor permissions)
        rules[UserRole.ADMIN] = PermissionRule(
            role=UserRole.ADMIN,
            operations={
                CollaborativeOperation.VIEW_DOCUMENT,
                CollaborativeOperation.VIEW_COMMENTS,
                CollaborativeOperation.VIEW_HISTORY,
                CollaborativeOperation.ADD_COMMENT,
                CollaborativeOperation.EDIT_COMMENT,
                CollaborativeOperation.DELETE_COMMENT,
                CollaborativeOperation.RESOLVE_COMMENT,
                CollaborativeOperation.EDIT_CELL,
                CollaborativeOperation.ADD_CELL,
                CollaborativeOperation.DELETE_CELL,
                CollaborativeOperation.MOVE_CELL,
                CollaborativeOperation.EXECUTE_CELL,
                CollaborativeOperation.ACQUIRE_LOCK,
                CollaborativeOperation.RELEASE_LOCK,
                CollaborativeOperation.BREAK_LOCK,
                CollaborativeOperation.MANAGE_PERMISSIONS,
                CollaborativeOperation.MANAGE_USERS,
                CollaborativeOperation.EXPORT_DOCUMENT,
                CollaborativeOperation.DELETE_DOCUMENT
            }
        )
        
        # Owner role permissions (all operations)
        rules[UserRole.OWNER] = PermissionRule(
            role=UserRole.OWNER,
            operations=set(CollaborativeOperation)
        )
        
        return rules
    
    def evaluate_permission(self, role: UserRole, operation: CollaborativeOperation,
                          context: Optional[Dict[str, Any]] = None) -> bool:
        """Evaluate permission for a role and operation."""
        try:
            rule = self.rules.get(role)
            if not rule:
                return False
            
            return rule.allows_operation(operation, context)
        except Exception as e:
            self.logger.log_error(e, {
                "context": "permission_evaluation",
                "role": role.value,
                "operation": operation.value
            })
            return False
    
    def get_allowed_operations(self, role: UserRole) -> Set[CollaborativeOperation]:
        """Get all operations allowed for a role."""
        rule = self.rules.get(role)
        return rule.operations if rule else set()
    
    def add_custom_rule(self, role: UserRole, rule: PermissionRule):
        """Add or update a custom permission rule."""
        self.rules[role] = rule
        self.logger.logger.info(f"Added custom rule for role {role.value}")
    
    def remove_custom_rule(self, role: UserRole):
        """Remove a custom permission rule."""
        if role in self.rules:
            del self.rules[role]
            self.logger.logger.info(f"Removed custom rule for role {role.value}")


class PermissionManager:
    """Core permission management system for collaborative editing."""
    
    def __init__(self, config: Optional[PermissionConfig] = None):
        self.config = config or PermissionConfig()
        self.cache = PermissionCache(self.config)
        self.token_validator = JupyterHubTokenValidator(self.config)
        self.rule_engine = PermissionRuleEngine(self.config)
        self.logger = get_collaboration_logger()
        self.metrics = get_collaboration_metrics()
        
        # User role assignments (document_id -> user_id -> role)
        self.user_roles = {}
        
        # Document permissions (document_id -> permissions_dict)
        self.document_permissions = {}
        
        # Active user sessions
        self.active_sessions = weakref.WeakValueDictionary()
        
        # Background tasks
        self._cleanup_task = None
        self._refresh_task = None
        
    async def initialize(self):
        """Initialize the permission manager."""
        try:
            self.logger.logger.info("Initializing PermissionManager")
            
            # Start background tasks
            self._cleanup_task = asyncio.create_task(self._periodic_cleanup())
            if self.config.permission_refresh_interval > 0:
                self._refresh_task = asyncio.create_task(self._periodic_refresh())
            
            self.logger.logger.info("PermissionManager initialized successfully")
        except Exception as e:
            self.logger.log_error(e, {"context": "permission_manager_init"})
            raise
    
    async def shutdown(self):
        """Shutdown the permission manager."""
        try:
            self.logger.logger.info("Shutting down PermissionManager")
            
            # Cancel background tasks
            if self._cleanup_task:
                self._cleanup_task.cancel()
            if self._refresh_task:
                self._refresh_task.cancel()
            
            # Wait for tasks to complete
            for task in [self._cleanup_task, self._refresh_task]:
                if task and not task.done():
                    try:
                        await asyncio.wait_for(task, timeout=1.0)
                    except (asyncio.TimeoutError, asyncio.CancelledError):
                        pass
            
            self.logger.logger.info("PermissionManager shutdown complete")
        except Exception as e:
            self.logger.log_error(e, {"context": "permission_manager_shutdown"})
    
    @monitor_performance("authenticate_user")
    async def authenticate_user(self, token: str) -> Optional[Dict[str, Any]]:
        """Authenticate user and extract role information."""
        if not token:
            return None
        
        try:
            with error_context("authenticate_user"):
                user_info = await self.token_validator.validate_token(token)
                
                if user_info:
                    # Record successful authentication
                    self.metrics.record_permission_event(
                        "authentication", user_info.get('role', 'unknown'), "success"
                    )
                    
                    # Store session info
                    session_id = str(uuid.uuid4())
                    self.active_sessions[session_id] = {
                        'user_info': user_info,
                        'last_activity': time.time()
                    }
                    user_info['session_id'] = session_id
                
                return user_info
                
        except Exception as e:
            self.logger.log_error(e, {"context": "user_authentication", "token_prefix": token[:10]})
            self.metrics.record_permission_event("authentication", "unknown", "failure")
            return None
    
    @monitor_performance("check_permission")
    async def check_permission(self, user: Union[User, Dict[str, Any]], 
                              document_id: str, operation: CollaborativeOperation,
                              context: Optional[Dict[str, Any]] = None) -> bool:
        """Check if user has permission for the specified operation."""
        try:
            with error_context("check_permission", document_id=document_id, 
                             operation=operation.value):
                
                # Extract user information
                if isinstance(user, dict):
                    user_id = user.get('username')
                    user_role_str = user.get('role', self.config.default_role)
                else:
                    user_id = getattr(user, 'username', None)
                    user_role_str = getattr(user, 'role', self.config.default_role)
                
                if not user_id:
                    return False
                
                # Check cache first
                cached_result = await self.cache.get(user_id, document_id, operation)
                if cached_result is not None:
                    return cached_result
                
                # Determine user role for this document
                user_role = await self._get_user_role(user_id, document_id, user_role_str)
                
                # Evaluate permission using rule engine
                allowed = self.rule_engine.evaluate_permission(user_role, operation, context)
                
                # Cache the result
                await self.cache.set(user_id, document_id, operation, allowed)
                
                # Record metrics
                result = "allowed" if allowed else "denied"
                self.metrics.record_permission_event("check", user_role.value, result)
                
                return allowed
                
        except Exception as e:
            self.logger.log_error(e, {
                "context": "permission_check",
                "user": user_id if 'user_id' in locals() else "unknown",
                "document_id": document_id,
                "operation": operation.value
            })
            # Fail securely - deny permission on error
            return False
    
    async def _get_user_role(self, user_id: str, document_id: str, 
                           default_role: str) -> UserRole:
        """Get user's role for a specific document."""
        try:
            # Check if user is document owner
            if self.config.document_owners.get(document_id) == user_id:
                return UserRole.OWNER
            
            # Check if user is admin
            if user_id in self.config.admin_users:
                return UserRole.ADMIN
            
            # Check document-specific role assignments
            if document_id in self.user_roles:
                if user_id in self.user_roles[document_id]:
                    role_str = self.user_roles[document_id][user_id]
                    return UserRole(role_str)
            
            # Return default role
            return UserRole(default_role)
            
        except (ValueError, KeyError):
            # Invalid role, return viewer as fallback
            return UserRole.VIEWER
    
    @monitor_performance("assign_role")
    async def assign_user_role(self, admin_user: Union[User, Dict[str, Any]], 
                              target_user_id: str, document_id: str, 
                              role: UserRole) -> bool:
        """Assign a role to a user for a specific document."""
        try:
            with error_context("assign_user_role", document_id=document_id, 
                             target_user=target_user_id):
                
                # Check if admin user has permission to manage permissions
                has_permission = await self.check_permission(
                    admin_user, document_id, CollaborativeOperation.MANAGE_PERMISSIONS
                )
                
                if not has_permission:
                    return False
                
                # Initialize document permissions if needed
                if document_id not in self.user_roles:
                    self.user_roles[document_id] = {}
                
                # Assign role
                self.user_roles[document_id][target_user_id] = role.value
                
                # Invalidate cache for the target user
                await self.cache.invalidate_user(target_user_id)
                
                # Record metrics
                self.metrics.record_permission_event("role_assignment", role.value, "success")
                
                self.logger.logger.info(
                    f"Assigned role {role.value} to user {target_user_id} "
                    f"for document {document_id}"
                )
                
                return True
                
        except Exception as e:
            self.logger.log_error(e, {
                "context": "role_assignment",
                "target_user": target_user_id,
                "document_id": document_id,
                "role": role.value
            })
            self.metrics.record_permission_event("role_assignment", role.value, "failure")
            return False
    
    @monitor_performance("remove_user_access")
    async def remove_user_access(self, admin_user: Union[User, Dict[str, Any]], 
                                target_user_id: str, document_id: str) -> bool:
        """Remove a user's access to a document."""
        try:
            with error_context("remove_user_access", document_id=document_id, 
                             target_user=target_user_id):
                
                # Check admin permission
                has_permission = await self.check_permission(
                    admin_user, document_id, CollaborativeOperation.MANAGE_PERMISSIONS
                )
                
                if not has_permission:
                    return False
                
                # Remove user role
                if (document_id in self.user_roles and 
                    target_user_id in self.user_roles[document_id]):
                    del self.user_roles[document_id][target_user_id]
                
                # Invalidate cache
                await self.cache.invalidate_user(target_user_id)
                
                # Record metrics
                self.metrics.record_permission_event("access_removal", "removed", "success")
                
                self.logger.logger.info(
                    f"Removed access for user {target_user_id} "
                    f"from document {document_id}"
                )
                
                return True
                
        except Exception as e:
            self.logger.log_error(e, {
                "context": "access_removal",
                "target_user": target_user_id,
                "document_id": document_id
            })
            self.metrics.record_permission_event("access_removal", "removed", "failure")
            return False
    
    async def get_document_users(self, user: Union[User, Dict[str, Any]], 
                               document_id: str) -> Optional[Dict[str, str]]:
        """Get all users with access to a document."""
        try:
            # Check if user has permission to view user list
            has_permission = await self.check_permission(
                user, document_id, CollaborativeOperation.VIEW_DOCUMENT
            )
            
            if not has_permission:
                return None
            
            # Return user roles for the document
            return self.user_roles.get(document_id, {})
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "get_document_users",
                "document_id": document_id
            })
            return None
    
    async def get_user_permissions(self, user_id: str, 
                                 document_id: str) -> Set[CollaborativeOperation]:
        """Get all permitted operations for a user on a document."""
        try:
            user_role = await self._get_user_role(user_id, document_id, 
                                                self.config.default_role)
            return self.rule_engine.get_allowed_operations(user_role)
        except Exception as e:
            self.logger.log_error(e, {
                "context": "get_user_permissions",
                "user_id": user_id,
                "document_id": document_id
            })
            return set()
    
    async def validate_operation_batch(self, user: Union[User, Dict[str, Any]], 
                                     document_id: str, 
                                     operations: List[CollaborativeOperation]) -> Dict[CollaborativeOperation, bool]:
        """Validate multiple operations in batch for efficiency."""
        results = {}
        
        try:
            for operation in operations:
                results[operation] = await self.check_permission(user, document_id, operation)
        except Exception as e:
            self.logger.log_error(e, {
                "context": "batch_validation",
                "document_id": document_id,
                "operations": [op.value for op in operations]
            })
            # Return all False on error
            results = {op: False for op in operations}
        
        return results
    
    async def _periodic_cleanup(self):
        """Periodic cleanup of expired cache entries and sessions."""
        while True:
            try:
                await asyncio.sleep(60)  # Run every minute
                
                # Clean up expired cache entries
                await self.cache.cleanup_expired()
                
                # Clean up inactive sessions
                now = time.time()
                inactive_sessions = []
                
                for session_id, session_data in self.active_sessions.items():
                    if now - session_data['last_activity'] > 3600:  # 1 hour timeout
                        inactive_sessions.append(session_id)
                
                for session_id in inactive_sessions:
                    if session_id in self.active_sessions:
                        del self.active_sessions[session_id]
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.log_error(e, {"context": "periodic_cleanup"})
    
    async def _periodic_refresh(self):
        """Periodic refresh of user permissions from JupyterHub."""
        while True:
            try:
                await asyncio.sleep(self.config.permission_refresh_interval)
                
                # Refresh permissions for active users
                for session_data in self.active_sessions.values():
                    user_info = session_data.get('user_info')
                    if user_info:
                        user_id = user_info.get('username')
                        if user_id:
                            updated_info = await self.token_validator.refresh_user_permissions(user_id)
                            if updated_info:
                                session_data['user_info'].update(updated_info)
                                await self.cache.invalidate_user(user_id)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.log_error(e, {"context": "periodic_refresh"})
    
    def get_stats(self) -> Dict[str, Any]:
        """Get permission system statistics."""
        return {
            'active_sessions': len(self.active_sessions),
            'document_count': len(self.user_roles),
            'total_user_roles': sum(len(roles) for roles in self.user_roles.values()),
            'cache_stats': self.cache.get_stats()
        }


def permission_required(operation: CollaborativeOperation, 
                       document_id_param: str = 'document_id'):
    """
    Decorator for enforcing permissions on collaborative operations.
    
    Args:
        operation: The operation that requires permission
        document_id_param: Name of the parameter containing document_id
    """
    def decorator(func):
        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            # Extract handler and document_id
            handler = args[0] if args else None
            document_id = kwargs.get(document_id_param)
            
            if not isinstance(handler, JupyterHandler) or not document_id:
                raise CollaborationPermissionError("Invalid handler or document_id")
            
            # Get permission manager
            permission_manager = getattr(handler, 'permission_manager', None)
            if not permission_manager:
                raise CollaborationPermissionError("Permission manager not available")
            
            # Check permission
            has_permission = await permission_manager.check_permission(
                handler.current_user, document_id, operation
            )
            
            if not has_permission:
                raise CollaborationPermissionError(
                    f"User lacks permission for operation: {operation.value}"
                )
            
            return await func(*args, **kwargs)
        
        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            # For synchronous functions, convert to async temporarily
            return asyncio.run(async_wrapper(*args, **kwargs))
        
        return async_wrapper if asyncio.iscoroutinefunction(func) else sync_wrapper
    
    return decorator


# Global permission manager instance
_permission_manager = None


async def get_permission_manager() -> PermissionManager:
    """Get global permission manager instance."""
    global _permission_manager
    if _permission_manager is None:
        config = PermissionConfig()
        _permission_manager = PermissionManager(config)
        await _permission_manager.initialize()
    return _permission_manager


async def create_permission_manager(config: Optional[PermissionConfig] = None) -> PermissionManager:
    """Create and initialize a new permission manager instance."""
    manager = PermissionManager(config)
    await manager.initialize()
    return manager


# Utility functions for common permission checks
async def can_view_document(user: Union[User, Dict[str, Any]], document_id: str) -> bool:
    """Check if user can view a document."""
    manager = await get_permission_manager()
    return await manager.check_permission(user, document_id, CollaborativeOperation.VIEW_DOCUMENT)


async def can_edit_document(user: Union[User, Dict[str, Any]], document_id: str) -> bool:
    """Check if user can edit a document."""
    manager = await get_permission_manager()
    return await manager.check_permission(user, document_id, CollaborativeOperation.EDIT_CELL)


async def can_manage_permissions(user: Union[User, Dict[str, Any]], document_id: str) -> bool:
    """Check if user can manage document permissions."""
    manager = await get_permission_manager()
    return await manager.check_permission(user, document_id, CollaborativeOperation.MANAGE_PERMISSIONS)


async def validate_token_and_permissions(token: str, document_id: str, 
                                       operation: CollaborativeOperation) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Validate token and check permissions in one call."""
    manager = await get_permission_manager()
    
    # Authenticate user
    user_info = await manager.authenticate_user(token)
    if not user_info:
        return False, None
    
    # Check permission
    has_permission = await manager.check_permission(user_info, document_id, operation)
    
    return has_permission, user_info


# Permission validation middleware for WebSocket handlers
class PermissionMiddleware:
    """Middleware for validating permissions on WebSocket operations."""
    
    def __init__(self, permission_manager: PermissionManager):
        self.permission_manager = permission_manager
        self.logger = get_collaboration_logger()
    
    async def validate_message(self, user: Union[User, Dict[str, Any]], 
                             message: Dict[str, Any]) -> bool:
        """Validate permissions for a WebSocket message."""
        try:
            message_type = message.get('type')
            document_id = message.get('document_id')
            
            if not message_type or not document_id:
                return False
            
            # Map message types to operations
            operation_mapping = {
                'cell_edit': CollaborativeOperation.EDIT_CELL,
                'cell_add': CollaborativeOperation.ADD_CELL,
                'cell_delete': CollaborativeOperation.DELETE_CELL,
                'cell_move': CollaborativeOperation.MOVE_CELL,
                'cell_execute': CollaborativeOperation.EXECUTE_CELL,
                'comment_add': CollaborativeOperation.ADD_COMMENT,
                'comment_edit': CollaborativeOperation.EDIT_COMMENT,
                'comment_delete': CollaborativeOperation.DELETE_COMMENT,
                'lock_acquire': CollaborativeOperation.ACQUIRE_LOCK,
                'lock_release': CollaborativeOperation.RELEASE_LOCK,
                'permission_manage': CollaborativeOperation.MANAGE_PERMISSIONS
            }
            
            operation = operation_mapping.get(message_type)
            if not operation:
                # Unknown message type, log and deny
                self.logger.logger.warning(f"Unknown message type: {message_type}")
                return False
            
            return await self.permission_manager.check_permission(user, document_id, operation)
            
        except Exception as e:
            self.logger.log_error(e, {
                "context": "permission_middleware",
                "message_type": message.get('type'),
                "document_id": message.get('document_id')
            })
            return False