// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { URLExt, PageConfig } from '@jupyterlab/coreutils';
import { User } from '@jupyterlab/services';
import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable, DisposableDelegate } from '@lumino/disposables';

/**
 * Permission levels for collaborative editing matching the UI enum
 */
export enum PermissionLevel {
  VIEW = 'view',
  EDIT = 'edit',
  ADMIN = 'admin'
}

/**
 * Interface for a collaborator in the notebook matching the UI interface
 */
export interface ICollaborator {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  permission: PermissionLevel;
  isOnline: boolean;
  lastSeen?: Date;
  addedBy?: string;
  addedAt: Date;
}

/**
 * Detailed permission level information
 */
export interface IPermissionLevelInfo {
  level: PermissionLevel;
  displayName: string;
  description: string;
  capabilities: IPermissionCapabilities;
}

/**
 * Specific capabilities for each permission level
 */
export interface IPermissionCapabilities {
  canView: boolean;
  canEdit: boolean;
  canExecute: boolean;
  canComment: boolean;
  canManageLocks: boolean;
  canViewHistory: boolean;
  canRestoreHistory: boolean;
  canManageCollaborators: boolean;
  canChangePermissions: boolean;
  canDeleteNotebook: boolean;
}

/**
 * Options for permission validation
 */
export interface IPermissionValidationOptions {
  /**
   * Whether to check permissions from cache first
   */
  useCache?: boolean;
  
  /**
   * Whether to update cache after validation
   */
  updateCache?: boolean;
  
  /**
   * Whether to throw on permission denial or return false
   */
  throwOnDenied?: boolean;
  
  /**
   * Context information for the operation
   */
  context?: {
    cellId?: string;
    operation?: string;
    resourceId?: string;
  };
}

/**
 * Result of permission validation
 */
export interface IPermissionValidationResult {
  granted: boolean;
  reason?: string;
  level: PermissionLevel;
  capabilities: IPermissionCapabilities;
}

/**
 * Options for adding a collaborator
 */
export interface IAddCollaboratorOptions {
  userEmail: string;
  permission: PermissionLevel;
  notifyUser?: boolean;
  temporaryAccess?: {
    expiresAt: Date;
    autoRevoke: boolean;
  };
}

/**
 * JupyterHub authentication context
 */
export interface IJupyterHubContext {
  hubUrl?: string;
  userToken?: string;
  apiToken?: string;
  serviceUrl?: string;
  isHubManaged: boolean;
}

/**
 * Permission cache entry
 */
interface IPermissionCacheEntry {
  permission: PermissionLevel;
  capabilities: IPermissionCapabilities;
  timestamp: number;
  ttl: number;
}

/**
 * Collaborative operation types for permission validation
 */
export enum CollabOperation {
  VIEW_NOTEBOOK = 'view_notebook',
  EDIT_CELL = 'edit_cell',
  EXECUTE_CELL = 'execute_cell',
  ADD_CELL = 'add_cell',
  DELETE_CELL = 'delete_cell',
  LOCK_CELL = 'lock_cell',
  UNLOCK_CELL = 'unlock_cell',
  ADD_COMMENT = 'add_comment',
  EDIT_COMMENT = 'edit_comment',
  DELETE_COMMENT = 'delete_comment',
  VIEW_HISTORY = 'view_history',
  RESTORE_VERSION = 'restore_version',
  MANAGE_COLLABORATORS = 'manage_collaborators',
  CHANGE_PERMISSIONS = 'change_permissions',
  JOIN_SESSION = 'join_session',
  BROADCAST_AWARENESS = 'broadcast_awareness'
}

/**
 * Interface for the permissions manager service matching the UI expectations
 */
export interface IPermissionsManager {
  /**
   * Current user's permission level
   */
  readonly currentUserPermission: PermissionLevel;
  
  /**
   * List of all collaborators with their permissions
   */
  readonly collaborators: ICollaborator[];
  
  /**
   * Signal emitted when collaborators list changes
   */
  readonly collaboratorsChanged: ISignal<this, ICollaborator[]>;
  
  /**
   * Signal emitted when current user's permission changes
   */
  readonly permissionChanged: ISignal<this, PermissionLevel>;
  
  /**
   * Signal emitted when permission validation fails
   */
  readonly permissionDenied: ISignal<this, { operation: string; reason: string }>;
  
  /**
   * Whether the current user is authenticated
   */
  readonly isAuthenticated: boolean;
  
  /**
   * Current notebook path for permission context
   */
  readonly notebookPath: string | null;
  
  /**
   * Whether permissions are being managed by JupyterHub
   */
  readonly isHubManaged: boolean;
  
  /**
   * Add a new collaborator with specified permission level
   */
  addCollaborator(userEmail: string, permission: PermissionLevel): Promise<void>;
  
  /**
   * Update a collaborator's permission level
   */
  updateCollaboratorPermission(userId: string, permission: PermissionLevel): Promise<void>;
  
  /**
   * Remove a collaborator from the notebook
   */
  removeCollaborator(userId: string): Promise<void>;
  
  /**
   * Get current user information
   */
  getCurrentUser(): Promise<User.IUser | null>;
  
  /**
   * Validate if current user can perform admin actions
   */
  canManagePermissions(): boolean;
  
  /**
   * Validate if user can perform a specific operation
   */
  validateOperation(operation: CollabOperation, options?: IPermissionValidationOptions): Promise<boolean>;
  
  /**
   * Get detailed permission information for current user
   */
  getPermissionInfo(): IPermissionLevelInfo;
  
  /**
   * Check if user has specific capability
   */
  hasCapability(capability: keyof IPermissionCapabilities): boolean;
  
  /**
   * Initialize permissions for a specific notebook
   */
  initialize(notebookPath: string): Promise<void>;
  
  /**
   * Clean up resources and disconnect from services
   */
  dispose(): void;
}

/**
 * Default permission capabilities for each level
 */
const PERMISSION_CAPABILITIES: Record<PermissionLevel, IPermissionCapabilities> = {
  [PermissionLevel.VIEW]: {
    canView: true,
    canEdit: false,
    canExecute: false,
    canComment: true,
    canManageLocks: false,
    canViewHistory: true,
    canRestoreHistory: false,
    canManageCollaborators: false,
    canChangePermissions: false,
    canDeleteNotebook: false
  },
  [PermissionLevel.EDIT]: {
    canView: true,
    canEdit: true,
    canExecute: true,
    canComment: true,
    canManageLocks: true,
    canViewHistory: true,
    canRestoreHistory: true,
    canManageCollaborators: false,
    canChangePermissions: false,
    canDeleteNotebook: false
  },
  [PermissionLevel.ADMIN]: {
    canView: true,
    canEdit: true,
    canExecute: true,
    canComment: true,
    canManageLocks: true,
    canViewHistory: true,
    canRestoreHistory: true,
    canManageCollaborators: true,
    canChangePermissions: true,
    canDeleteNotebook: true
  }
};

/**
 * Operation to capability mapping for validation
 */
const OPERATION_CAPABILITY_MAP: Record<CollabOperation, keyof IPermissionCapabilities> = {
  [CollabOperation.VIEW_NOTEBOOK]: 'canView',
  [CollabOperation.EDIT_CELL]: 'canEdit',
  [CollabOperation.EXECUTE_CELL]: 'canExecute',
  [CollabOperation.ADD_CELL]: 'canEdit',
  [CollabOperation.DELETE_CELL]: 'canEdit',
  [CollabOperation.LOCK_CELL]: 'canManageLocks',
  [CollabOperation.UNLOCK_CELL]: 'canManageLocks',
  [CollabOperation.ADD_COMMENT]: 'canComment',
  [CollabOperation.EDIT_COMMENT]: 'canComment',
  [CollabOperation.DELETE_COMMENT]: 'canComment',
  [CollabOperation.VIEW_HISTORY]: 'canViewHistory',
  [CollabOperation.RESTORE_VERSION]: 'canRestoreHistory',
  [CollabOperation.MANAGE_COLLABORATORS]: 'canManageCollaborators',
  [CollabOperation.CHANGE_PERMISSIONS]: 'canChangePermissions',
  [CollabOperation.JOIN_SESSION]: 'canView',
  [CollabOperation.BROADCAST_AWARENESS]: 'canView'
};

/**
 * Permission manager implementation for collaborative notebook editing
 */
export class PermissionsManager implements IPermissionsManager, IDisposable {
  private _currentUserPermission: PermissionLevel = PermissionLevel.VIEW;
  private _collaborators: ICollaborator[] = [];
  private _currentUser: User.IUser | null = null;
  private _notebookPath: string | null = null;
  private _isAuthenticated: boolean = false;
  private _isHubManaged: boolean = false;
  private _jupyterHubContext: IJupyterHubContext | null = null;
  private _isDisposed: boolean = false;
  
  // Permission cache for performance optimization
  private _permissionCache = new Map<string, IPermissionCacheEntry>();
  private _cacheDefaultTtl: number = 300000; // 5 minutes
  private _maxCacheSize: number = 1000;
  
  // Signals for reactive updates
  private _collaboratorsChanged = new Signal<this, ICollaborator[]>(this);
  private _permissionChanged = new Signal<this, PermissionLevel>(this);
  private _permissionDenied = new Signal<this, { operation: string; reason: string }>(this);
  
  // API endpoints
  private readonly _apiBaseUrl: string;
  private readonly _collaborationApiUrl: string;
  
  constructor() {
    this._apiBaseUrl = URLExt.join(PageConfig.getBaseUrl(), 'api');
    this._collaborationApiUrl = URLExt.join(this._apiBaseUrl, 'collaboration');
    
    // Detect JupyterHub context
    this._detectJupyterHubContext();
    
    // Initialize periodic cache cleanup
    this._startCacheCleanup();
  }

  /**
   * Current user's permission level
   */
  get currentUserPermission(): PermissionLevel {
    return this._currentUserPermission;
  }

  /**
   * List of all collaborators with their permissions
   */
  get collaborators(): ICollaborator[] {
    return [...this._collaborators];
  }

  /**
   * Signal emitted when collaborators list changes
   */
  get collaboratorsChanged(): ISignal<this, ICollaborator[]> {
    return this._collaboratorsChanged;
  }

  /**
   * Signal emitted when current user's permission changes
   */
  get permissionChanged(): ISignal<this, PermissionLevel> {
    return this._permissionChanged;
  }

  /**
   * Signal emitted when permission validation fails
   */
  get permissionDenied(): ISignal<this, { operation: string; reason: string }> {
    return this._permissionDenied;
  }

  /**
   * Whether the current user is authenticated
   */
  get isAuthenticated(): boolean {
    return this._isAuthenticated;
  }

  /**
   * Current notebook path for permission context
   */
  get notebookPath(): string | null {
    return this._notebookPath;
  }

  /**
   * Whether permissions are being managed by JupyterHub
   */
  get isHubManaged(): boolean {
    return this._isHubManaged;
  }

  /**
   * Whether the instance has been disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Initialize permissions for a specific notebook
   */
  async initialize(notebookPath: string): Promise<void> {
    if (this._isDisposed) {
      throw new Error('PermissionsManager has been disposed');
    }
    
    this._notebookPath = notebookPath;
    
    try {
      // Load current user information
      await this._loadCurrentUser();
      
      // Load notebook permissions and collaborators
      await this._loadNotebookPermissions();
      
      // Determine current user's permission level
      await this._determineCurrentUserPermission();
      
      this._isAuthenticated = true;
      
    } catch (error) {
      console.error('Failed to initialize permissions:', error);
      this._isAuthenticated = false;
      // Fallback to view-only mode for graceful degradation
      this._currentUserPermission = PermissionLevel.VIEW;
      throw error;
    }
  }

  /**
   * Add a new collaborator with specified permission level
   */
  async addCollaborator(userEmail: string, permission: PermissionLevel): Promise<void> {
    if (!this.canManagePermissions()) {
      const error = 'Insufficient permissions to add collaborators';
      this._permissionDenied.emit({ operation: 'add_collaborator', reason: error });
      throw new Error(error);
    }

    if (!this._notebookPath) {
      throw new Error('No notebook path set for permission management');
    }

    try {
      const response = await this._apiRequest('POST', '/collaborators', {
        notebook_path: this._notebookPath,
        user_email: userEmail,
        permission: permission,
        added_by: this._currentUser?.name || 'unknown'
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to add collaborator: ${error}`);
      }

      // Reload collaborators to get updated list
      await this._loadNotebookPermissions();
      
    } catch (error) {
      console.error('Failed to add collaborator:', error);
      throw error;
    }
  }

  /**
   * Update a collaborator's permission level
   */
  async updateCollaboratorPermission(userId: string, permission: PermissionLevel): Promise<void> {
    if (!this.canManagePermissions()) {
      const error = 'Insufficient permissions to update collaborator permissions';
      this._permissionDenied.emit({ operation: 'update_permission', reason: error });
      throw new Error(error);
    }

    if (!this._notebookPath) {
      throw new Error('No notebook path set for permission management');
    }

    try {
      const response = await this._apiRequest('PUT', `/collaborators/${userId}`, {
        notebook_path: this._notebookPath,
        permission: permission,
        updated_by: this._currentUser?.name || 'unknown'
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to update collaborator permission: ${error}`);
      }

      // Update local cache and collaborators list
      const collaboratorIndex = this._collaborators.findIndex(c => c.id === userId);
      if (collaboratorIndex >= 0) {
        this._collaborators[collaboratorIndex].permission = permission;
        this._collaboratorsChanged.emit([...this._collaborators]);
      }
      
      // Clear permission cache for this user
      this._clearUserPermissionCache(userId);
      
    } catch (error) {
      console.error('Failed to update collaborator permission:', error);
      throw error;
    }
  }

  /**
   * Remove a collaborator from the notebook
   */
  async removeCollaborator(userId: string): Promise<void> {
    if (!this.canManagePermissions()) {
      const error = 'Insufficient permissions to remove collaborators';
      this._permissionDenied.emit({ operation: 'remove_collaborator', reason: error });
      throw new Error(error);
    }

    if (!this._notebookPath) {
      throw new Error('No notebook path set for permission management');
    }

    try {
      const response = await this._apiRequest('DELETE', `/collaborators/${userId}`, {
        notebook_path: this._notebookPath,
        removed_by: this._currentUser?.name || 'unknown'
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to remove collaborator: ${error}`);
      }

      // Update local collaborators list
      this._collaborators = this._collaborators.filter(c => c.id !== userId);
      this._collaboratorsChanged.emit([...this._collaborators]);
      
      // Clear permission cache for this user
      this._clearUserPermissionCache(userId);
      
    } catch (error) {
      console.error('Failed to remove collaborator:', error);
      throw error;
    }
  }

  /**
   * Get current user information
   */
  async getCurrentUser(): Promise<User.IUser | null> {
    if (this._currentUser) {
      return this._currentUser;
    }
    
    await this._loadCurrentUser();
    return this._currentUser;
  }

  /**
   * Validate if current user can perform admin actions
   */
  canManagePermissions(): boolean {
    return this._currentUserPermission === PermissionLevel.ADMIN;
  }

  /**
   * Validate if user can perform a specific operation
   */
  async validateOperation(
    operation: CollabOperation, 
    options: IPermissionValidationOptions = {}
  ): Promise<boolean> {
    if (this._isDisposed) {
      return false;
    }
    
    const {
      useCache = true,
      updateCache = true,
      throwOnDenied = false,
      context = {}
    } = options;

    // Check cache first if enabled
    if (useCache) {
      const cacheKey = this._getPermissionCacheKey(operation, context);
      const cached = this._getFromCache(cacheKey);
      if (cached) {
        const capability = OPERATION_CAPABILITY_MAP[operation];
        const hasPermission = cached.capabilities[capability];
        
        if (!hasPermission && throwOnDenied) {
          const error = `Operation ${operation} denied: insufficient permissions`;
          this._permissionDenied.emit({ operation, reason: error });
          throw new Error(error);
        }
        
        return hasPermission;
      }
    }

    // Perform validation
    try {
      const result = await this._performPermissionValidation(operation, context);
      
      // Update cache if enabled
      if (updateCache) {
        const cacheKey = this._getPermissionCacheKey(operation, context);
        this._updateCache(cacheKey, {
          permission: result.level,
          capabilities: result.capabilities,
          timestamp: Date.now(),
          ttl: this._cacheDefaultTtl
        });
      }
      
      if (!result.granted && throwOnDenied) {
        const error = result.reason || `Operation ${operation} denied`;
        this._permissionDenied.emit({ operation, reason: error });
        throw new Error(error);
      }
      
      return result.granted;
      
    } catch (error) {
      console.error(`Permission validation failed for operation ${operation}:`, error);
      
      if (throwOnDenied) {
        throw error;
      }
      
      return false;
    }
  }

  /**
   * Get detailed permission information for current user
   */
  getPermissionInfo(): IPermissionLevelInfo {
    const capabilities = PERMISSION_CAPABILITIES[this._currentUserPermission];
    
    return {
      level: this._currentUserPermission,
      displayName: this._getPermissionDisplayName(this._currentUserPermission),
      description: this._getPermissionDescription(this._currentUserPermission),
      capabilities
    };
  }

  /**
   * Check if user has specific capability
   */
  hasCapability(capability: keyof IPermissionCapabilities): boolean {
    const capabilities = PERMISSION_CAPABILITIES[this._currentUserPermission];
    return capabilities[capability];
  }

  /**
   * Clean up resources and disconnect from services
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    this._isDisposed = true;
    
    // Clear caches
    this._permissionCache.clear();
    
    // Disconnect signals
    Signal.disconnectAll(this);
    
    // Reset state
    this._collaborators = [];
    this._currentUser = null;
    this._notebookPath = null;
    this._isAuthenticated = false;
  }

  /**
   * Detect if running in JupyterHub context
   */
  private _detectJupyterHubContext(): void {
    try {
      const hubPrefix = PageConfig.getOption('hubPrefix');
      const hubUser = PageConfig.getOption('hubUser');
      const hubServerName = PageConfig.getOption('hubServerName');
      
      this._isHubManaged = !!(hubPrefix || hubUser || hubServerName);
      
      if (this._isHubManaged) {
        this._jupyterHubContext = {
          hubUrl: PageConfig.getOption('hubHost') || '',
          userToken: PageConfig.getToken(),
          isHubManaged: true
        };
      }
    } catch (error) {
      console.warn('Failed to detect JupyterHub context:', error);
      this._isHubManaged = false;
    }
  }

  /**
   * Load current user information
   */
  private async _loadCurrentUser(): Promise<void> {
    try {
      if (this._isHubManaged && this._jupyterHubContext) {
        // Use JupyterHub API for user info
        const response = await this._apiRequest('GET', '/user');
        if (response.ok) {
          this._currentUser = await response.json();
        }
      } else {
        // Use standard Jupyter API
        const response = await fetch(URLExt.join(this._apiBaseUrl, 'me'), {
          method: 'GET',
          headers: this._getAuthHeaders()
        });
        
        if (response.ok) {
          this._currentUser = await response.json();
        }
      }
    } catch (error) {
      console.error('Failed to load current user:', error);
      this._currentUser = null;
    }
  }

  /**
   * Load notebook permissions and collaborators
   */
  private async _loadNotebookPermissions(): Promise<void> {
    if (!this._notebookPath) {
      return;
    }

    try {
      const response = await this._apiRequest('GET', '/permissions', {
        notebook_path: this._notebookPath
      });

      if (response.ok) {
        const data = await response.json();
        this._collaborators = data.collaborators.map((collab: any) => ({
          ...collab,
          addedAt: new Date(collab.addedAt),
          lastSeen: collab.lastSeen ? new Date(collab.lastSeen) : undefined
        }));
        
        this._collaboratorsChanged.emit([...this._collaborators]);
      }
    } catch (error) {
      console.error('Failed to load notebook permissions:', error);
      this._collaborators = [];
    }
  }

  /**
   * Determine current user's permission level
   */
  private async _determineCurrentUserPermission(): Promise<void> {
    if (!this._currentUser || !this._notebookPath) {
      this._currentUserPermission = PermissionLevel.VIEW;
      return;
    }

    // Check if user is notebook owner (admin by default)
    try {
      const response = await this._apiRequest('GET', '/ownership', {
        notebook_path: this._notebookPath,
        user_id: this._currentUser.id || this._currentUser.name
      });

      if (response.ok) {
        const data = await response.json();
        if (data.is_owner) {
          this._currentUserPermission = PermissionLevel.ADMIN;
          this._permissionChanged.emit(this._currentUserPermission);
          return;
        }
      }
    } catch (error) {
      console.warn('Failed to check notebook ownership:', error);
    }

    // Find user in collaborators list
    const userCollaborator = this._collaborators.find(c => 
      c.id === this._currentUser?.id || 
      c.email === this._currentUser?.email ||
      c.id === this._currentUser?.name
    );

    if (userCollaborator) {
      const previousPermission = this._currentUserPermission;
      this._currentUserPermission = userCollaborator.permission;
      
      if (previousPermission !== this._currentUserPermission) {
        this._permissionChanged.emit(this._currentUserPermission);
      }
    } else {
      // Default to VIEW for authenticated users not in collaborators list
      this._currentUserPermission = PermissionLevel.VIEW;
    }
  }

  /**
   * Perform actual permission validation
   */
  private async _performPermissionValidation(
    operation: CollabOperation,
    context: Record<string, any>
  ): Promise<IPermissionValidationResult> {
    const capability = OPERATION_CAPABILITY_MAP[operation];
    const capabilities = PERMISSION_CAPABILITIES[this._currentUserPermission];
    const granted = capabilities[capability];

    return {
      granted,
      reason: granted ? undefined : `Operation requires ${capability} capability`,
      level: this._currentUserPermission,
      capabilities
    };
  }

  /**
   * Generate cache key for permission checks
   */
  private _getPermissionCacheKey(operation: CollabOperation, context: Record<string, any>): string {
    const userId = this._currentUser?.id || this._currentUser?.name || 'anonymous';
    const contextKey = Object.keys(context).sort().map(k => `${k}:${context[k]}`).join(',');
    return `${userId}:${operation}:${contextKey}`;
  }

  /**
   * Get entry from permission cache
   */
  private _getFromCache(key: string): IPermissionCacheEntry | null {
    const entry = this._permissionCache.get(key);
    if (!entry) {
      return null;
    }

    // Check if entry is expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this._permissionCache.delete(key);
      return null;
    }

    return entry;
  }

  /**
   * Update permission cache
   */
  private _updateCache(key: string, entry: IPermissionCacheEntry): void {
    // Implement LRU eviction if cache is full
    if (this._permissionCache.size >= this._maxCacheSize) {
      const oldestKey = this._permissionCache.keys().next().value;
      this._permissionCache.delete(oldestKey);
    }

    this._permissionCache.set(key, entry);
  }

  /**
   * Clear permission cache for specific user
   */
  private _clearUserPermissionCache(userId: string): void {
    for (const [key, entry] of this._permissionCache.entries()) {
      if (key.startsWith(userId + ':')) {
        this._permissionCache.delete(key);
      }
    }
  }

  /**
   * Start periodic cache cleanup
   */
  private _startCacheCleanup(): void {
    const cleanup = () => {
      if (this._isDisposed) {
        return;
      }

      const now = Date.now();
      for (const [key, entry] of this._permissionCache.entries()) {
        if (now - entry.timestamp > entry.ttl) {
          this._permissionCache.delete(key);
        }
      }
    };

    // Run cleanup every 5 minutes
    setInterval(cleanup, 300000);
  }

  /**
   * Make API request with authentication
   */
  private async _apiRequest(method: string, endpoint: string, data?: any): Promise<Response> {
    const url = URLExt.join(this._collaborationApiUrl, endpoint);
    const headers = this._getAuthHeaders();

    const options: RequestInit = {
      method,
      headers
    };

    if (data && (method === 'POST' || method === 'PUT')) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    } else if (data && method === 'GET') {
      const params = new URLSearchParams(data);
      const urlWithParams = `${url}?${params.toString()}`;
      return fetch(urlWithParams, options);
    }

    return fetch(url, options);
  }

  /**
   * Get authentication headers for API requests
   */
  private _getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    if (this._isHubManaged && this._jupyterHubContext?.userToken) {
      headers['Authorization'] = `Bearer ${this._jupyterHubContext.userToken}`;
    }

    const token = PageConfig.getToken();
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    // Add XSRF token if available
    const xsrfToken = PageConfig.getOption('xsrfToken');
    if (xsrfToken) {
      headers['X-XSRFToken'] = xsrfToken;
    }

    return headers;
  }

  /**
   * Get display name for permission level
   */
  private _getPermissionDisplayName(permission: PermissionLevel): string {
    switch (permission) {
      case PermissionLevel.VIEW:
        return 'View';
      case PermissionLevel.EDIT:
        return 'Edit';
      case PermissionLevel.ADMIN:
        return 'Admin';
      default:
        return 'Unknown';
    }
  }

  /**
   * Get description for permission level
   */
  private _getPermissionDescription(permission: PermissionLevel): string {
    switch (permission) {
      case PermissionLevel.VIEW:
        return 'Can view the notebook and add comments but cannot make changes';
      case PermissionLevel.EDIT:
        return 'Can edit cells, execute code, and manage locks';
      case PermissionLevel.ADMIN:
        return 'Can edit content and manage collaborators and permissions';
      default:
        return '';
    }
  }
}

/**
 * Create a new permissions manager instance
 */
export function createPermissionsManager(): IPermissionsManager {
  return new PermissionsManager();
}

/**
 * Namespace for permissions utilities
 */
export namespace Permissions {
  /**
   * Check if one permission level is higher than another
   */
  export function isHigherLevel(level1: PermissionLevel, level2: PermissionLevel): boolean {
    const levels = [PermissionLevel.VIEW, PermissionLevel.EDIT, PermissionLevel.ADMIN];
    return levels.indexOf(level1) > levels.indexOf(level2);
  }

  /**
   * Get all permission levels in ascending order
   */
  export function getAllLevels(): PermissionLevel[] {
    return [PermissionLevel.VIEW, PermissionLevel.EDIT, PermissionLevel.ADMIN];
  }

  /**
   * Get capabilities for a permission level
   */
  export function getCapabilities(level: PermissionLevel): IPermissionCapabilities {
    return { ...PERMISSION_CAPABILITIES[level] };
  }

  /**
   * Check if a permission level allows a specific operation
   */
  export function canPerformOperation(level: PermissionLevel, operation: CollabOperation): boolean {
    const capability = OPERATION_CAPABILITY_MAP[operation];
    const capabilities = PERMISSION_CAPABILITIES[level];
    return capabilities[capability];
  }

  /**
   * Get minimum permission level required for an operation
   */
  export function getMinimumLevelForOperation(operation: CollabOperation): PermissionLevel {
    const capability = OPERATION_CAPABILITY_MAP[operation];
    
    for (const level of getAllLevels()) {
      const capabilities = PERMISSION_CAPABILITIES[level];
      if (capabilities[capability]) {
        return level;
      }
    }
    
    return PermissionLevel.ADMIN; // Fallback to admin for unknown operations
  }
}