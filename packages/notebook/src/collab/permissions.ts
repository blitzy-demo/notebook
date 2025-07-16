// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';
import { YNotebook } from '@jupyter/ydoc';
import { Signal, ISignal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { ICellModel } from '@jupyterlab/cells';
import { INotebookModel } from '@jupyterlab/notebook';
import { UUID } from '@lumino/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { Time } from '@jupyterlab/coreutils';
import YjsNotebookProvider from './provider';
import UserAwareness from './awareness';

/**
 * Enumeration of available permission levels for collaborative editing
 */
export enum PermissionLevel {
  /** Full ownership permissions - create, edit, delete, manage permissions */
  OWNER = 'owner',
  /** Edit permissions - view, edit, execute, comment */
  EDITOR = 'editor',
  /** View permissions - view content, comment */
  VIEWER = 'viewer',
  /** Comment permissions - view and comment only */
  COMMENTER = 'commenter',
  /** No permissions - access denied */
  NONE = 'none'
}

/**
 * Enumeration of specific permission actions
 */
export enum PermissionAction {
  /** View notebook content */
  VIEW = 'view',
  /** Edit notebook or cell content */
  EDIT = 'edit',
  /** Execute code cells */
  EXECUTE = 'execute',
  /** Add comments to cells */
  COMMENT = 'comment',
  /** Invite other users to collaborate */
  INVITE = 'invite',
  /** Manage permissions for other users */
  MANAGE_PERMISSIONS = 'manage_permissions',
  /** Delete notebook or cells */
  DELETE = 'delete',
  /** Share notebook with others */
  SHARE = 'share',
  /** Lock cells for exclusive editing */
  LOCK_CELL = 'lock_cell',
  /** Unlock cells */
  UNLOCK_CELL = 'unlock_cell'
}

/**
 * Interface representing a permission grant
 */
export interface IPermissionGrant {
  /** Unique identifier for the permission grant */
  id: string;
  /** User ID receiving the permission */
  userId: string;
  /** Resource identifier (notebook path, cell ID, etc.) */
  resource: string;
  /** Specific action permitted */
  action: PermissionAction;
  /** Whether the permission is granted or denied */
  granted: boolean;
  /** User ID who granted the permission */
  grantedBy: string;
  /** Timestamp when permission was granted */
  grantedAt: number;
  /** Timestamp when permission expires (null for no expiration) */
  expiresAt?: number;
  /** Scope of the permission (notebook, cell, etc.) */
  scope: string;
  /** Additional conditions for the permission */
  conditions?: { [key: string]: any };
}

/**
 * Interface representing user context for permission validation
 */
export interface IUserContext {
  /** User identifier */
  userId: string;
  /** Username */
  username: string;
  /** User email address */
  email: string;
  /** Display name */
  displayName: string;
  /** User roles */
  roles: string[];
  /** User groups */
  groups: string[];
  /** User permissions */
  permissions: string[];
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Authentication method used */
  authenticationMethod: string;
  /** Current session ID */
  sessionId: string;
}

/**
 * Interface representing permission validation context
 */
export interface IPermissionContext {
  /** User context */
  user: IUserContext;
  /** Resource being accessed */
  resource: string;
  /** Action being performed */
  action: PermissionAction;
  /** Timestamp of the request */
  timestamp: number;
  /** Session ID */
  sessionId: string;
  /** Client ID */
  clientId: string;
  /** Additional metadata */
  metadata?: { [key: string]: any };
}

/**
 * Interface representing collaborative roles
 */
export interface ICollaborativeRole {
  /** Role name */
  role: string;
  /** General permissions for the role */
  permissions: PermissionAction[];
  /** Whether role can view content */
  canView: boolean;
  /** Whether role can edit content */
  canEdit: boolean;
  /** Whether role can execute code */
  canExecute: boolean;
  /** Whether role can comment */
  canComment: boolean;
  /** Whether role can invite others */
  canInvite: boolean;
  /** Whether role can manage permissions */
  canManagePermissions: boolean;
}

/**
 * Interface for permission validation functionality
 */
export interface IPermissionValidator {
  /** Validate a specific permission */
  validatePermission(context: IPermissionContext): Promise<boolean>;
  /** Check if user can perform an action */
  canPerformAction(userId: string, action: PermissionAction, resource: string): Promise<boolean>;
  /** Get user's role for a resource */
  getUserRole(userId: string, resource: string): Promise<string | null>;
  /** Get permission level for user */
  getPermissionLevel(userId: string, resource: string): Promise<PermissionLevel>;
  /** Check access to a resource */
  checkAccess(userId: string, resource: string): Promise<boolean>;
  /** Check if user is authorized for action */
  isAuthorized(userId: string, action: PermissionAction, resource: string): Promise<boolean>;
}

/**
 * Interface for permissions management functionality
 */
export interface IPermissionsManager {
  /** Check if user has permission for action */
  checkPermission(userId: string, action: PermissionAction, resource: string): Promise<boolean>;
  /** Update user permissions */
  updatePermission(userId: string, action: PermissionAction, resource: string, granted: boolean): Promise<void>;
  /** Get all permissions for user */
  getUserPermissions(userId: string): Promise<IPermissionGrant[]>;
  /** Get all permissions for notebook */
  getNotebookPermissions(notebookPath: string): Promise<IPermissionGrant[]>;
  /** Get all permissions for cell */
  getCellPermissions(cellId: string): Promise<IPermissionGrant[]>;
  /** Enforce permission before action */
  enforcePermission(context: IPermissionContext): Promise<void>;
}

/**
 * Interface for permission cache entry
 */
interface IPermissionCacheEntry {
  /** User ID */
  userId: string;
  /** Resource identifier */
  resource: string;
  /** Permission level */
  level: PermissionLevel;
  /** Cached permissions */
  permissions: Set<PermissionAction>;
  /** Cache timestamp */
  timestamp: number;
  /** Expiration time */
  expiresAt: number;
}

/**
 * Interface for role definitions
 */
interface IRoleDefinition {
  /** Role name */
  name: string;
  /** Role permissions */
  permissions: PermissionAction[];
  /** Whether role inherits from another role */
  inherits?: string;
  /** Additional metadata */
  metadata?: { [key: string]: any };
}

/**
 * Configuration for permissions system
 */
interface IPermissionsConfig {
  /** Cache timeout in milliseconds */
  cacheTimeout: number;
  /** Cache size limit */
  cacheSize: number;
  /** Default permission level for new users */
  defaultPermissionLevel: PermissionLevel;
  /** Whether to enable permission caching */
  enableCaching: boolean;
  /** Whether to enable real-time permission updates */
  enableRealTimeUpdates: boolean;
  /** Permission validation timeout in milliseconds */
  validationTimeout: number;
  /** Whether to enable audit logging */
  enableAuditLogging: boolean;
  /** Available roles configuration */
  roles: IRoleDefinition[];
}

/**
 * Default permissions configuration
 */
const DEFAULT_CONFIG: IPermissionsConfig = {
  cacheTimeout: 300000, // 5 minutes
  cacheSize: 1000,
  defaultPermissionLevel: PermissionLevel.VIEWER,
  enableCaching: true,
  enableRealTimeUpdates: true,
  validationTimeout: 5000, // 5 seconds
  enableAuditLogging: true,
  roles: [
    {
      name: 'owner',
      permissions: [
        PermissionAction.VIEW,
        PermissionAction.EDIT,
        PermissionAction.EXECUTE,
        PermissionAction.COMMENT,
        PermissionAction.INVITE,
        PermissionAction.MANAGE_PERMISSIONS,
        PermissionAction.DELETE,
        PermissionAction.SHARE,
        PermissionAction.LOCK_CELL,
        PermissionAction.UNLOCK_CELL
      ]
    },
    {
      name: 'editor',
      permissions: [
        PermissionAction.VIEW,
        PermissionAction.EDIT,
        PermissionAction.EXECUTE,
        PermissionAction.COMMENT,
        PermissionAction.LOCK_CELL,
        PermissionAction.UNLOCK_CELL
      ]
    },
    {
      name: 'viewer',
      permissions: [
        PermissionAction.VIEW,
        PermissionAction.COMMENT
      ]
    },
    {
      name: 'commenter',
      permissions: [
        PermissionAction.VIEW,
        PermissionAction.COMMENT
      ]
    }
  ]
};

/**
 * PermissionsSystem: Comprehensive access control system for collaborative notebook editing
 * 
 * This system provides fine-grained permission management for notebooks and individual cells,
 * integrating with JupyterHub authentication and implementing role-based access controls.
 * Features include permission caching, real-time updates, and secure collaboration controls.
 */
export default class PermissionsSystem implements IPermissionsManager, IPermissionValidator, IDisposable {
  private _provider: YjsNotebookProvider;
  private _awareness: UserAwareness;
  private _permissionsMap: Y.Map<any>;
  private _rolesMap: Y.Map<any>;
  private _grantsMap: Y.Map<any>;
  private _config: IPermissionsConfig;
  private _cache = new Map<string, IPermissionCacheEntry>();
  private _disposed = false;
  private _cacheCleanupTimer: number | null = null;
  private _currentUser: IUserContext | null = null;
  private _roleDefinitions = new Map<string, IRoleDefinition>();
  private _permissionGrants = new Map<string, IPermissionGrant>();
  private _auditLog: Array<{ timestamp: number; userId: string; action: string; resource: string; result: boolean }> = [];

  // Signals for permission system events
  private _onPermissionChanged = new Signal<PermissionsSystem, { userId: string; resource: string; action: PermissionAction; granted: boolean }>(this);
  private _onRoleChanged = new Signal<PermissionsSystem, { userId: string; resource: string; role: string }>(this);
  private _onPermissionDenied = new Signal<PermissionsSystem, { userId: string; resource: string; action: PermissionAction }>(this);

  /**
   * Construct a new PermissionsSystem
   * 
   * @param provider - The Yjs notebook provider for document synchronization
   * @param awareness - The user awareness system for tracking user presence
   * @param config - Configuration options for the permissions system
   */
  constructor(provider: YjsNotebookProvider, awareness: UserAwareness, config: Partial<IPermissionsConfig> = {}) {
    this._provider = provider;
    this._awareness = awareness;
    this._config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize Yjs maps for shared permission state
    this._permissionsMap = provider.yjsDocument.getMap('permissions');
    this._rolesMap = provider.yjsDocument.getMap('roles');
    this._grantsMap = provider.yjsDocument.getMap('grants');
    
    // Initialize role definitions
    this._initializeRoles();
    
    // Initialize current user
    this._initializeCurrentUser();
    
    // Set up observers for real-time updates
    this._setupObservers();
    
    // Start cache cleanup if caching is enabled
    if (this._config.enableCaching) {
      this._startCacheCleanup();
    }
    
    // Set up provider connection monitoring
    this._setupProviderObservers();
  }

  /**
   * Signal emitted when permissions change
   */
  get onPermissionChanged(): ISignal<PermissionsSystem, { userId: string; resource: string; action: PermissionAction; granted: boolean }> {
    return this._onPermissionChanged;
  }

  /**
   * Get the current user context
   */
  get currentUser(): IUserContext | null {
    return this._currentUser;
  }

  /**
   * Get the permissions cache size
   */
  get cacheSize(): number {
    return this._cache.size;
  }

  /**
   * Get the permission grants map
   */
  get permissionGrants(): Map<string, IPermissionGrant> {
    return new Map(this._permissionGrants);
  }

  /**
   * Get available roles
   */
  get availableRoles(): string[] {
    return Array.from(this._roleDefinitions.keys());
  }

  /**
   * Check if user has permission for a specific action on a resource
   * 
   * @param userId - User identifier
   * @param action - Permission action to check
   * @param resource - Resource identifier
   * @returns Promise resolving to true if permission is granted
   */
  async checkPermission(userId: string, action: PermissionAction, resource: string): Promise<boolean> {
    const context: IPermissionContext = {
      user: await this._getUserContext(userId),
      resource,
      action,
      timestamp: Date.now(),
      sessionId: this._provider.sessionId,
      clientId: this._provider.sessionId,
      metadata: { source: 'checkPermission' }
    };
    
    try {
      const result = await this.validatePermission(context);
      this._logAuditEvent(userId, `check_${action}`, resource, result);
      return result;
    } catch (error) {
      console.error('Permission check failed:', error);
      this._logAuditEvent(userId, `check_${action}`, resource, false);
      return false;
    }
  }

  /**
   * Update user permissions for a specific action on a resource
   * 
   * @param userId - User identifier
   * @param action - Permission action to update
   * @param resource - Resource identifier
   * @param granted - Whether permission is granted
   */
  async updatePermission(userId: string, action: PermissionAction, resource: string, granted: boolean): Promise<void> {
    if (!this._currentUser) {
      throw new Error('No current user context available');
    }
    
    // Check if current user can manage permissions
    const canManage = await this.checkPermission(this._currentUser.userId, PermissionAction.MANAGE_PERMISSIONS, resource);
    if (!canManage) {
      throw new Error('Insufficient permissions to update permissions');
    }
    
    // Create or update permission grant
    const grantId = this._generateGrantId(userId, resource, action);
    const grant: IPermissionGrant = {
      id: grantId,
      userId,
      resource,
      action,
      granted,
      grantedBy: this._currentUser.userId,
      grantedAt: Date.now(),
      scope: this._getResourceScope(resource),
      conditions: {}
    };
    
    // Update local storage
    this._permissionGrants.set(grantId, grant);
    
    // Update shared state
    this._grantsMap.set(grantId, grant);
    
    // Clear cache for affected user
    this._clearCacheForUser(userId);
    
    // Emit permission changed signal
    this._onPermissionChanged.emit({ userId, resource, action, granted });
    
    // Log audit event
    this._logAuditEvent(this._currentUser.userId, granted ? 'grant_permission' : 'revoke_permission', resource, true);
  }

  /**
   * Get all permissions for a specific user
   * 
   * @param userId - User identifier
   * @returns Promise resolving to array of permission grants
   */
  async getUserPermissions(userId: string): Promise<IPermissionGrant[]> {
    const userGrants = Array.from(this._permissionGrants.values()).filter(grant => grant.userId === userId);
    return userGrants;
  }

  /**
   * Get all permissions for a specific notebook
   * 
   * @param notebookPath - Notebook path identifier
   * @returns Promise resolving to array of permission grants
   */
  async getNotebookPermissions(notebookPath: string): Promise<IPermissionGrant[]> {
    const notebookGrants = Array.from(this._permissionGrants.values()).filter(grant => 
      grant.resource === notebookPath || grant.resource.startsWith(`${notebookPath}/`)
    );
    return notebookGrants;
  }

  /**
   * Get all permissions for a specific cell
   * 
   * @param cellId - Cell identifier
   * @returns Promise resolving to array of permission grants
   */
  async getCellPermissions(cellId: string): Promise<IPermissionGrant[]> {
    const cellGrants = Array.from(this._permissionGrants.values()).filter(grant => 
      grant.resource === cellId || grant.resource.endsWith(`/${cellId}`)
    );
    return cellGrants;
  }

  /**
   * Enforce permission before allowing an action
   * 
   * @param context - Permission context
   * @throws Error if permission is denied
   */
  async enforcePermission(context: IPermissionContext): Promise<void> {
    const allowed = await this.validatePermission(context);
    if (!allowed) {
      this._onPermissionDenied.emit({ 
        userId: context.user.userId, 
        resource: context.resource, 
        action: context.action 
      });
      throw new Error(`Permission denied: ${context.user.userId} cannot ${context.action} ${context.resource}`);
    }
  }

  /**
   * Cache permissions for efficient validation
   * 
   * @param userId - User identifier
   * @param resource - Resource identifier
   * @param level - Permission level
   * @param permissions - Set of allowed actions
   */
  cachePermissions(userId: string, resource: string, level: PermissionLevel, permissions: Set<PermissionAction>): void {
    if (!this._config.enableCaching) {
      return;
    }
    
    const cacheKey = this._getCacheKey(userId, resource);
    const entry: IPermissionCacheEntry = {
      userId,
      resource,
      level,
      permissions,
      timestamp: Date.now(),
      expiresAt: Date.now() + this._config.cacheTimeout
    };
    
    this._cache.set(cacheKey, entry);
    
    // Enforce cache size limit
    if (this._cache.size > this._config.cacheSize) {
      this._evictOldestCacheEntry();
    }
  }

  /**
   * Clear permission cache for a specific user
   * 
   * @param userId - User identifier
   */
  clearPermissionCache(userId?: string): void {
    if (userId) {
      this._clearCacheForUser(userId);
    } else {
      this._cache.clear();
    }
  }

  /**
   * Validate a permission request
   * 
   * @param context - Permission context
   * @returns Promise resolving to true if permission is granted
   */
  async validatePermission(context: IPermissionContext): Promise<boolean> {
    // Check cache first
    if (this._config.enableCaching) {
      const cached = this._getCachedPermission(context.user.userId, context.resource);
      if (cached && cached.permissions.has(context.action)) {
        return true;
      }
    }
    
    // Check user authentication
    if (!context.user.isAuthenticated) {
      return false;
    }
    
    // Get user role for resource
    const userRole = await this.getUserRole(context.user.userId, context.resource);
    if (!userRole) {
      return false;
    }
    
    // Check role permissions
    const roleDefinition = this._roleDefinitions.get(userRole);
    if (!roleDefinition) {
      return false;
    }
    
    const hasPermission = roleDefinition.permissions.includes(context.action);
    
    // Check for explicit grants/denials
    const explicitGrant = this._getExplicitGrant(context.user.userId, context.resource, context.action);
    if (explicitGrant) {
      return explicitGrant.granted;
    }
    
    // Cache result if caching is enabled
    if (this._config.enableCaching && hasPermission) {
      const permissions = new Set(roleDefinition.permissions);
      const level = this._getPermissionLevelFromRole(userRole);
      this.cachePermissions(context.user.userId, context.resource, level, permissions);
    }
    
    return hasPermission;
  }

  /**
   * Check if user can perform a specific action
   * 
   * @param userId - User identifier
   * @param action - Permission action
   * @param resource - Resource identifier
   * @returns Promise resolving to true if action is allowed
   */
  async canPerformAction(userId: string, action: PermissionAction, resource: string): Promise<boolean> {
    return this.checkPermission(userId, action, resource);
  }

  /**
   * Get user's role for a resource
   * 
   * @param userId - User identifier
   * @param resource - Resource identifier
   * @returns Promise resolving to role name or null
   */
  async getUserRole(userId: string, resource: string): Promise<string | null> {
    // Check shared roles map first
    const roleKey = this._getRoleKey(userId, resource);
    const sharedRole = this._rolesMap.get(roleKey);
    if (sharedRole) {
      return sharedRole.role;
    }
    
    // Check for inherited roles from notebook level
    if (resource.includes('/')) {
      const notebookPath = resource.split('/')[0];
      const notebookRoleKey = this._getRoleKey(userId, notebookPath);
      const notebookRole = this._rolesMap.get(notebookRoleKey);
      if (notebookRole) {
        return notebookRole.role;
      }
    }
    
    // Check user context for default role
    const userContext = await this._getUserContext(userId);
    if (userContext.roles.length > 0) {
      // Return highest priority role
      const roleOrder = ['owner', 'editor', 'viewer', 'commenter'];
      for (const role of roleOrder) {
        if (userContext.roles.includes(role)) {
          return role;
        }
      }
    }
    
    // Return default role based on configuration
    return this._config.defaultPermissionLevel;
  }

  /**
   * Get permission level for user on a resource
   * 
   * @param userId - User identifier
   * @param resource - Resource identifier
   * @returns Promise resolving to permission level
   */
  async getPermissionLevel(userId: string, resource: string): Promise<PermissionLevel> {
    const role = await this.getUserRole(userId, resource);
    if (!role) {
      return PermissionLevel.NONE;
    }
    
    return this._getPermissionLevelFromRole(role);
  }

  /**
   * Check if user has access to a resource
   * 
   * @param userId - User identifier
   * @param resource - Resource identifier
   * @returns Promise resolving to true if user has access
   */
  async checkAccess(userId: string, resource: string): Promise<boolean> {
    return this.checkPermission(userId, PermissionAction.VIEW, resource);
  }

  /**
   * Check if user is authorized for an action
   * 
   * @param userId - User identifier
   * @param action - Permission action
   * @param resource - Resource identifier
   * @returns Promise resolving to true if authorized
   */
  async isAuthorized(userId: string, action: PermissionAction, resource: string): Promise<boolean> {
    return this.checkPermission(userId, action, resource);
  }

  /**
   * Set user role for a resource
   * 
   * @param userId - User identifier
   * @param resource - Resource identifier
   * @param role - Role name
   */
  async setUserRole(userId: string, resource: string, role: string): Promise<void> {
    if (!this._currentUser) {
      throw new Error('No current user context available');
    }
    
    // Check if current user can manage permissions
    const canManage = await this.checkPermission(this._currentUser.userId, PermissionAction.MANAGE_PERMISSIONS, resource);
    if (!canManage) {
      throw new Error('Insufficient permissions to assign roles');
    }
    
    // Validate role exists
    if (!this._roleDefinitions.has(role)) {
      throw new Error(`Invalid role: ${role}`);
    }
    
    // Set role in shared state
    const roleKey = this._getRoleKey(userId, resource);
    const roleData = {
      userId,
      resource,
      role,
      assignedBy: this._currentUser.userId,
      assignedAt: Date.now()
    };
    
    this._rolesMap.set(roleKey, roleData);
    
    // Clear cache for affected user
    this._clearCacheForUser(userId);
    
    // Emit role changed signal
    this._onRoleChanged.emit({ userId, resource, role });
    
    // Log audit event
    this._logAuditEvent(this._currentUser.userId, 'assign_role', resource, true);
  }

  /**
   * Get collaborative role interface for a user
   * 
   * @param userId - User identifier
   * @param resource - Resource identifier
   * @returns Promise resolving to collaborative role or null
   */
  async getCollaborativeRole(userId: string, resource: string): Promise<ICollaborativeRole | null> {
    const roleName = await this.getUserRole(userId, resource);
    if (!roleName) {
      return null;
    }
    
    const roleDefinition = this._roleDefinitions.get(roleName);
    if (!roleDefinition) {
      return null;
    }
    
    return {
      role: roleName,
      permissions: roleDefinition.permissions,
      canView: roleDefinition.permissions.includes(PermissionAction.VIEW),
      canEdit: roleDefinition.permissions.includes(PermissionAction.EDIT),
      canExecute: roleDefinition.permissions.includes(PermissionAction.EXECUTE),
      canComment: roleDefinition.permissions.includes(PermissionAction.COMMENT),
      canInvite: roleDefinition.permissions.includes(PermissionAction.INVITE),
      canManagePermissions: roleDefinition.permissions.includes(PermissionAction.MANAGE_PERMISSIONS)
    };
  }

  /**
   * Check if the permissions system is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the permissions system
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    
    this._disposed = true;
    
    // Clean up cache cleanup timer
    if (this._cacheCleanupTimer) {
      clearInterval(this._cacheCleanupTimer);
      this._cacheCleanupTimer = null;
    }
    
    // Clear cache
    this._cache.clear();
    
    // Clear maps
    this._permissionGrants.clear();
    this._roleDefinitions.clear();
    
    // Clear audit log
    this._auditLog.length = 0;
    
    // Clear signals
    Signal.clearData(this);
  }

  /**
   * Initialize role definitions from configuration
   */
  private _initializeRoles(): void {
    this._config.roles.forEach(role => {
      this._roleDefinitions.set(role.name, role);
    });
  }

  /**
   * Initialize current user context
   */
  private async _initializeCurrentUser(): Promise<void> {
    try {
      const userInfo = await this._fetchUserInfo();
      this._currentUser = {
        userId: userInfo.id || 'anonymous',
        username: userInfo.username || 'Anonymous',
        email: userInfo.email || '',
        displayName: userInfo.displayName || userInfo.username || 'Anonymous',
        roles: userInfo.roles || [],
        groups: userInfo.groups || [],
        permissions: userInfo.permissions || [],
        isAuthenticated: true,
        authenticationMethod: 'token',
        sessionId: this._provider.sessionId
      };
    } catch (error) {
      console.error('Failed to initialize current user:', error);
      this._currentUser = {
        userId: 'anonymous',
        username: 'Anonymous',
        email: '',
        displayName: 'Anonymous',
        roles: [],
        groups: [],
        permissions: [],
        isAuthenticated: false,
        authenticationMethod: 'none',
        sessionId: this._provider.sessionId
      };
    }
  }

  /**
   * Fetch user information from server
   */
  private async _fetchUserInfo(): Promise<any> {
    try {
      const settings = ServerConnection.makeSettings();
      const response = await ServerConnection.makeRequest(
        '/api/me',
        {},
        settings
      );
      
      if (response.ok) {
        return await response.json();
      } else {
        throw new Error(`Failed to fetch user info: ${response.status}`);
      }
    } catch (error) {
      console.warn('Could not fetch user info from server:', error);
      return {
        id: 'anonymous',
        username: 'Anonymous',
        displayName: 'Anonymous',
        email: '',
        roles: [],
        groups: [],
        permissions: []
      };
    }
  }

  /**
   * Set up observers for real-time permission updates
   */
  private _setupObservers(): void {
    if (!this._config.enableRealTimeUpdates) {
      return;
    }
    
    // Observe permissions map changes
    this._permissionsMap.observe((event: Y.YMapEvent<any>) => {
      this._handlePermissionsMapChange(event);
    });
    
    // Observe roles map changes
    this._rolesMap.observe((event: Y.YMapEvent<any>) => {
      this._handleRolesMapChange(event);
    });
    
    // Observe grants map changes
    this._grantsMap.observe((event: Y.YMapEvent<any>) => {
      this._handleGrantsMapChange(event);
    });
  }

  /**
   * Set up provider observers for connection monitoring
   */
  private _setupProviderObservers(): void {
    // Monitor connection state changes
    this._provider.onConnectionStateChanged.connect((sender, state) => {
      if (state.connected) {
        this._syncPermissionsFromServer();
      }
    });
    
    // Monitor awareness changes for user context updates
    this._awareness.onUsersChanged.connect((sender, users) => {
      this._updateUserContexts(users);
    });
  }

  /**
   * Handle permissions map changes
   */
  private _handlePermissionsMapChange(event: Y.YMapEvent<any>): void {
    const changes = event.changes.keys;
    changes.forEach((change, key) => {
      if (change.action === 'add' || change.action === 'update') {
        // Permission was added or updated
        const permissionData = this._permissionsMap.get(key);
        if (permissionData) {
          // Clear cache for affected user
          this._clearCacheForUser(permissionData.userId);
        }
      } else if (change.action === 'delete') {
        // Permission was removed
        this._cache.delete(key);
      }
    });
  }

  /**
   * Handle roles map changes
   */
  private _handleRolesMapChange(event: Y.YMapEvent<any>): void {
    const changes = event.changes.keys;
    changes.forEach((change, key) => {
      if (change.action === 'add' || change.action === 'update') {
        // Role was added or updated
        const roleData = this._rolesMap.get(key);
        if (roleData) {
          // Clear cache for affected user
          this._clearCacheForUser(roleData.userId);
        }
      } else if (change.action === 'delete') {
        // Role was removed - need to determine which user was affected
        const [userId] = key.split(':');
        this._clearCacheForUser(userId);
      }
    });
  }

  /**
   * Handle grants map changes
   */
  private _handleGrantsMapChange(event: Y.YMapEvent<any>): void {
    const changes = event.changes.keys;
    changes.forEach((change, key) => {
      if (change.action === 'add' || change.action === 'update') {
        // Grant was added or updated
        const grantData = this._grantsMap.get(key);
        if (grantData) {
          this._permissionGrants.set(key, grantData);
          // Clear cache for affected user
          this._clearCacheForUser(grantData.userId);
        }
      } else if (change.action === 'delete') {
        // Grant was removed
        const grant = this._permissionGrants.get(key);
        if (grant) {
          this._permissionGrants.delete(key);
          this._clearCacheForUser(grant.userId);
        }
      }
    });
  }

  /**
   * Sync permissions from server on connection
   */
  private async _syncPermissionsFromServer(): Promise<void> {
    try {
      // Sync grants from shared state
      this._grantsMap.forEach((grant, key) => {
        this._permissionGrants.set(key, grant);
      });
      
      // Clear cache to force refresh
      this._cache.clear();
      
      console.log('Permissions synced from server');
    } catch (error) {
      console.error('Failed to sync permissions from server:', error);
    }
  }

  /**
   * Update user contexts from awareness updates
   */
  private _updateUserContexts(users: Map<string, any>): void {
    // Update user contexts based on awareness information
    users.forEach((user, userId) => {
      // Update user context if needed
      if (user.userId && this._currentUser?.userId === user.userId) {
        // Update current user context
        this._currentUser = {
          ...this._currentUser,
          roles: user.roles || this._currentUser.roles,
          groups: user.groups || this._currentUser.groups,
          permissions: user.permissions || this._currentUser.permissions
        };
      }
    });
  }

  /**
   * Start cache cleanup timer
   */
  private _startCacheCleanup(): void {
    this._cacheCleanupTimer = window.setInterval(() => {
      this._cleanupExpiredCache();
    }, this._config.cacheTimeout / 4); // Clean up every quarter of cache timeout
  }

  /**
   * Clean up expired cache entries
   */
  private _cleanupExpiredCache(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    this._cache.forEach((entry, key) => {
      if (entry.expiresAt < now) {
        expiredKeys.push(key);
      }
    });
    
    expiredKeys.forEach(key => {
      this._cache.delete(key);
    });
  }

  /**
   * Evict oldest cache entry to maintain size limit
   */
  private _evictOldestCacheEntry(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();
    
    this._cache.forEach((entry, key) => {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    });
    
    if (oldestKey) {
      this._cache.delete(oldestKey);
    }
  }

  /**
   * Clear cache for a specific user
   */
  private _clearCacheForUser(userId: string): void {
    const keysToDelete: string[] = [];
    
    this._cache.forEach((entry, key) => {
      if (entry.userId === userId) {
        keysToDelete.push(key);
      }
    });
    
    keysToDelete.forEach(key => {
      this._cache.delete(key);
    });
  }

  /**
   * Get cached permission for user and resource
   */
  private _getCachedPermission(userId: string, resource: string): IPermissionCacheEntry | null {
    const cacheKey = this._getCacheKey(userId, resource);
    const entry = this._cache.get(cacheKey);
    
    if (entry && entry.expiresAt > Date.now()) {
      return entry;
    }
    
    return null;
  }

  /**
   * Get cache key for user and resource
   */
  private _getCacheKey(userId: string, resource: string): string {
    return `${userId}:${resource}`;
  }

  /**
   * Get role key for user and resource
   */
  private _getRoleKey(userId: string, resource: string): string {
    return `${userId}:${resource}`;
  }

  /**
   * Generate grant ID for permission grant
   */
  private _generateGrantId(userId: string, resource: string, action: PermissionAction): string {
    return `${userId}:${resource}:${action}`;
  }

  /**
   * Get resource scope from resource identifier
   */
  private _getResourceScope(resource: string): string {
    if (resource.includes('/')) {
      return 'cell';
    }
    return 'notebook';
  }

  /**
   * Get user context for a user ID
   */
  private async _getUserContext(userId: string): Promise<IUserContext> {
    if (this._currentUser && this._currentUser.userId === userId) {
      return this._currentUser;
    }
    
    // Get user from awareness system
    const user = this._awareness.getUserById(userId);
    if (user) {
      return {
        userId: user.userId,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles || [],
        groups: user.metadata?.groups || [],
        permissions: user.permissions || [],
        isAuthenticated: true,
        authenticationMethod: 'token',
        sessionId: user.sessionId
      };
    }
    
    // Return minimal context for unknown users
    return {
      userId,
      username: 'Unknown',
      email: '',
      displayName: 'Unknown',
      roles: [],
      groups: [],
      permissions: [],
      isAuthenticated: false,
      authenticationMethod: 'none',
      sessionId: ''
    };
  }

  /**
   * Get explicit grant for user, resource, and action
   */
  private _getExplicitGrant(userId: string, resource: string, action: PermissionAction): IPermissionGrant | null {
    const grantId = this._generateGrantId(userId, resource, action);
    const grant = this._permissionGrants.get(grantId);
    
    if (grant && (!grant.expiresAt || grant.expiresAt > Date.now())) {
      return grant;
    }
    
    return null;
  }

  /**
   * Get permission level from role name
   */
  private _getPermissionLevelFromRole(role: string): PermissionLevel {
    switch (role) {
      case 'owner':
        return PermissionLevel.OWNER;
      case 'editor':
        return PermissionLevel.EDITOR;
      case 'viewer':
        return PermissionLevel.VIEWER;
      case 'commenter':
        return PermissionLevel.COMMENTER;
      default:
        return PermissionLevel.NONE;
    }
  }

  /**
   * Log audit event
   */
  private _logAuditEvent(userId: string, action: string, resource: string, result: boolean): void {
    if (!this._config.enableAuditLogging) {
      return;
    }
    
    const event = {
      timestamp: Date.now(),
      userId,
      action,
      resource,
      result
    };
    
    this._auditLog.push(event);
    
    // Limit audit log size
    if (this._auditLog.length > 1000) {
      this._auditLog.splice(0, this._auditLog.length - 1000);
    }
  }

  /**
   * Get audit log entries
   */
  getAuditLog(): Array<{ timestamp: number; userId: string; action: string; resource: string; result: boolean }> {
    return [...this._auditLog];
  }

  /**
   * Clear audit log
   */
  clearAuditLog(): void {
    this._auditLog.length = 0;
  }
}