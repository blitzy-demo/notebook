// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISignal, Signal } from '@lumino/signaling';
import { Token } from '@lumino/coreutils';
import { ISessionContext } from '@jupyterlab/apputils';
import { URLExt, PageConfig } from '@jupyterlab/coreutils';

/**
 * Permission levels for collaborative notebook editing
 */
export enum PermissionLevel {
  /**
   * No access to the notebook
   */
  NONE = 'none',
  
  /**
   * Read-only access - can view notebook content
   */
  VIEW = 'view',
  
  /**
   * Can add comments but cannot modify content
   */
  COMMENT = 'comment',
  
  /**
   * Can modify content and execute code
   */
  EDIT = 'edit',
  
  /**
   * Full control including permission management
   */
  ADMIN = 'admin'
}

/**
 * Specific actions that can be performed in a collaborative notebook
 */
export enum CollaborativeAction {
  VIEW_NOTEBOOK = 'view_notebook',
  EDIT_CELL = 'edit_cell',
  EXECUTE_CELL = 'execute_cell',
  CREATE_CELL = 'create_cell',
  DELETE_CELL = 'delete_cell',
  MOVE_CELL = 'move_cell',
  LOCK_CELL = 'lock_cell',
  UNLOCK_CELL = 'unlock_cell',
  ADD_COMMENT = 'add_comment',
  EDIT_COMMENT = 'edit_comment',
  DELETE_COMMENT = 'delete_comment',
  RESOLVE_COMMENT = 'resolve_comment',
  MANAGE_PERMISSIONS = 'manage_permissions',
  VIEW_HISTORY = 'view_history',
  REVERT_CHANGE = 'revert_change'
}

/**
 * User identity and authentication information
 */
export interface IUserIdentity {
  /**
   * Unique user identifier from JupyterHub
   */
  readonly userId: string;
  
  /**
   * Display name for the user
   */
  readonly username: string;
  
  /**
   * User's email address
   */
  readonly email?: string;
  
  /**
   * Avatar URL or data URI
   */
  readonly avatar?: string;
  
  /**
   * User's groups from JupyterHub
   */
  readonly groups: string[];
  
  /**
   * Authentication token for verification
   */
  readonly token: string;
  
  /**
   * Token expiration timestamp
   */
  readonly tokenExpiry: number;
}

/**
 * Cell-level permission settings
 */
export interface ICellPermissions {
  /**
   * Cell identifier
   */
  readonly cellId: string;
  
  /**
   * User-specific permissions for this cell
   */
  readonly userPermissions: Map<string, PermissionLevel>;
  
  /**
   * Group-specific permissions for this cell
   */
  readonly groupPermissions: Map<string, PermissionLevel>;
  
  /**
   * Whether the cell is currently locked
   */
  readonly isLocked: boolean;
  
  /**
   * User who currently has the cell locked
   */
  readonly lockedBy?: string;
  
  /**
   * Lock expiration timestamp
   */
  readonly lockExpiry?: number;
  
  /**
   * Whether the cell requires elevated permissions to modify
   */
  readonly isProtected: boolean;
  
  /**
   * Users who can see private outputs from this cell
   */
  readonly privateOutputViewers: Set<string>;
}

/**
 * Document-level permission settings
 */
export interface IDocumentPermissions {
  /**
   * Document identifier (notebook path)
   */
  readonly documentId: string;
  
  /**
   * Owner of the document (has admin permissions by default)
   */
  readonly owner: string;
  
  /**
   * Default permission level for authenticated users
   */
  readonly defaultPermission: PermissionLevel;
  
  /**
   * User-specific permissions
   */
  readonly userPermissions: Map<string, PermissionLevel>;
  
  /**
   * Group-specific permissions from JupyterHub
   */
  readonly groupPermissions: Map<string, PermissionLevel>;
  
  /**
   * Whether the document allows public access
   */
  readonly isPublic: boolean;
  
  /**
   * Cell-specific permission overrides
   */
  readonly cellPermissions: Map<string, ICellPermissions>;
  
  /**
   * Document creation timestamp
   */
  readonly createdAt: Date;
  
  /**
   * Last permission modification timestamp
   */
  readonly lastModified: Date;
}

/**
 * Permission validation result
 */
export interface IPermissionResult {
  /**
   * Whether the action is allowed
   */
  readonly allowed: boolean;
  
  /**
   * Reason for denial if not allowed
   */
  readonly reason?: string;
  
  /**
   * Required permission level for the action
   */
  readonly requiredLevel: PermissionLevel;
  
  /**
   * User's current permission level
   */
  readonly userLevel: PermissionLevel;
  
  /**
   * Additional context for the permission check
   */
  readonly context?: Record<string, any>;
}

/**
 * Permission change event data
 */
export interface IPermissionChangeEvent {
  /**
   * Document or cell that was affected
   */
  readonly target: string;
  
  /**
   * Type of target (document or cell)
   */
  readonly targetType: 'document' | 'cell';
  
  /**
   * User whose permissions changed
   */
  readonly userId: string;
  
  /**
   * Previous permission level
   */
  readonly oldLevel: PermissionLevel;
  
  /**
   * New permission level
   */
  readonly newLevel: PermissionLevel;
  
  /**
   * User who made the change (admin)
   */
  readonly changedBy: string;
  
  /**
   * Timestamp of the change
   */
  readonly timestamp: Date;
}

/**
 * Main interface for the permissions management system
 */
export interface IPermissionsManager {
  /**
   * Signal emitted when permissions change
   */
  readonly permissionsChanged: ISignal<IPermissionsManager, IPermissionChangeEvent>;
  
  /**
   * Signal emitted when user authentication status changes
   */
  readonly authenticationChanged: ISignal<IPermissionsManager, IUserIdentity | null>;
  
  /**
   * Current authenticated user
   */
  readonly currentUser: IUserIdentity | null;
  
  /**
   * Whether the manager is initialized and connected
   */
  readonly isInitialized: boolean;
  
  /**
   * Initialize the permissions manager with session context
   */
  initialize(sessionContext: ISessionContext): Promise<void>;
  
  /**
   * Authenticate user with JupyterHub token
   */
  authenticateUser(token: string): Promise<IUserIdentity>;
  
  /**
   * Validate current user authentication
   */
  validateAuthentication(): Promise<boolean>;
  
  /**
   * Get document permissions for the current notebook
   */
  getDocumentPermissions(documentId: string): Promise<IDocumentPermissions>;
  
  /**
   * Get cell-specific permissions
   */
  getCellPermissions(documentId: string, cellId: string): Promise<ICellPermissions>;
  
  /**
   * Check if user has permission to perform an action
   */
  checkPermission(
    action: CollaborativeAction,
    documentId: string,
    cellId?: string,
    userId?: string
  ): Promise<IPermissionResult>;
  
  /**
   * Check if user has specific permission level
   */
  hasPermissionLevel(
    level: PermissionLevel,
    documentId: string,
    cellId?: string,
    userId?: string
  ): Promise<boolean>;
  
  /**
   * Get user's effective permission level for document or cell
   */
  getEffectivePermission(
    documentId: string,
    cellId?: string,
    userId?: string
  ): Promise<PermissionLevel>;
  
  /**
   * Set user permission for document
   */
  setDocumentPermission(
    documentId: string,
    userId: string,
    level: PermissionLevel
  ): Promise<void>;
  
  /**
   * Set user permission for specific cell
   */
  setCellPermission(
    documentId: string,
    cellId: string,
    userId: string,
    level: PermissionLevel
  ): Promise<void>;
  
  /**
   * Set group permission for document
   */
  setGroupPermission(
    documentId: string,
    groupName: string,
    level: PermissionLevel
  ): Promise<void>;
  
  /**
   * Remove user permission (revert to default)
   */
  removeUserPermission(documentId: string, userId: string, cellId?: string): Promise<void>;
  
  /**
   * Get list of users with access to document
   */
  getDocumentUsers(documentId: string): Promise<Array<{
    user: IUserIdentity;
    permission: PermissionLevel;
    source: 'direct' | 'group' | 'default';
  }>>;
  
  /**
   * Transfer document ownership to another user
   */
  transferOwnership(documentId: string, newOwnerId: string): Promise<void>;
  
  /**
   * Create default permissions for new document
   */
  createDocumentPermissions(
    documentId: string,
    owner: string,
    defaultLevel: PermissionLevel
  ): Promise<void>;
  
  /**
   * Dispose of the permissions manager
   */
  dispose(): void;
}

/**
 * The IPermissionsManager token.
 */
export const IPermissionsManager = new Token<IPermissionsManager>(
  '@jupyter-notebook/notebook:IPermissionsManager'
);

/**
 * Implementation of the permissions management system
 */
export class PermissionsManager implements IPermissionsManager {
  private _permissionsChanged = new Signal<IPermissionsManager, IPermissionChangeEvent>(this);
  private _authenticationChanged = new Signal<IPermissionsManager, IUserIdentity | null>(this);
  private _currentUser: IUserIdentity | null = null;
  private _isInitialized = false;
  private _sessionContext: ISessionContext | null = null;
  private _documentPermissions = new Map<string, IDocumentPermissions>();
  private _permissionCache = new Map<string, IPermissionResult>();
  private _authValidationInterval: number | null = null;
  
  /**
   * Signal emitted when permissions change
   */
  get permissionsChanged(): ISignal<IPermissionsManager, IPermissionChangeEvent> {
    return this._permissionsChanged;
  }
  
  /**
   * Signal emitted when user authentication status changes
   */
  get authenticationChanged(): ISignal<IPermissionsManager, IUserIdentity | null> {
    return this._authenticationChanged;
  }
  
  /**
   * Current authenticated user
   */
  get currentUser(): IUserIdentity | null {
    return this._currentUser;
  }
  
  /**
   * Whether the manager is initialized and connected
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }
  
  /**
   * Initialize the permissions manager with session context
   */
  async initialize(sessionContext: ISessionContext): Promise<void> {
    if (this._isInitialized) {
      return;
    }
    
    this._sessionContext = sessionContext;
    
    try {
      // Try to get existing authentication from server
      await this._loadExistingAuthentication();
      
      // Set up periodic authentication validation
      this._startAuthValidation();
      
      this._isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize permissions manager:', error);
      throw new Error(`Permissions initialization failed: ${error.message}`);
    }
  }
  
  /**
   * Authenticate user with JupyterHub token
   */
  async authenticateUser(token: string): Promise<IUserIdentity> {
    if (!this._isInitialized) {
      throw new Error('Permissions manager not initialized');
    }
    
    try {
      const response = await this._makeAuthenticatedRequest('/api/jupyter/user', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }
      
      const userData = await response.json();
      
      // Validate required fields
      if (!userData.name || !userData.id) {
        throw new Error('Invalid user data received from authentication service');
      }
      
      const userIdentity: IUserIdentity = {
        userId: userData.id,
        username: userData.name,
        email: userData.email,
        avatar: userData.avatar,
        groups: userData.groups || [],
        token: token,
        tokenExpiry: Date.now() + (8 * 60 * 60 * 1000) // 8 hours default
      };
      
      this._currentUser = userIdentity;
      this._clearPermissionCache();
      this._authenticationChanged.emit(userIdentity);
      
      return userIdentity;
    } catch (error) {
      console.error('Authentication failed:', error);
      throw new Error(`User authentication failed: ${error.message}`);
    }
  }
  
  /**
   * Validate current user authentication
   */
  async validateAuthentication(): Promise<boolean> {
    if (!this._currentUser || !this._currentUser.token) {
      return false;
    }
    
    // Check token expiry
    if (Date.now() > this._currentUser.tokenExpiry) {
      this._currentUser = null;
      this._authenticationChanged.emit(null);
      return false;
    }
    
    try {
      const response = await this._makeAuthenticatedRequest('/api/jupyter/user/validate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._currentUser.token}`,
          'Content-Type': 'application/json'
        }
      });
      
      return response.ok;
    } catch (error) {
      console.warn('Authentication validation failed:', error);
      return false;
    }
  }
  
  /**
   * Get document permissions for the current notebook
   */
  async getDocumentPermissions(documentId: string): Promise<IDocumentPermissions> {
    if (!this._currentUser) {
      throw new Error('User not authenticated');
    }
    
    // Check cache first
    const cached = this._documentPermissions.get(documentId);
    if (cached) {
      return cached;
    }
    
    try {
      const response = await this._makeAuthenticatedRequest(
        `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this._currentUser.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to fetch document permissions: ${response.status}`);
      }
      
      const permData = await response.json();
      const permissions = this._parseDocumentPermissions(permData);
      
      // Cache the permissions
      this._documentPermissions.set(documentId, permissions);
      
      return permissions;
    } catch (error) {
      console.error('Failed to get document permissions:', error);
      
      // Return default permissions for owner or minimal access
      return this._createDefaultDocumentPermissions(documentId);
    }
  }
  
  /**
   * Get cell-specific permissions
   */
  async getCellPermissions(documentId: string, cellId: string): Promise<ICellPermissions> {
    const docPermissions = await this.getDocumentPermissions(documentId);
    
    // Check if there are cell-specific permissions
    const cellPerms = docPermissions.cellPermissions.get(cellId);
    if (cellPerms) {
      return cellPerms;
    }
    
    // Return default cell permissions based on document permissions
    return this._createDefaultCellPermissions(cellId, docPermissions);
  }
  
  /**
   * Check if user has permission to perform an action
   */
  async checkPermission(
    action: CollaborativeAction,
    documentId: string,
    cellId?: string,
    userId?: string
  ): Promise<IPermissionResult> {
    const targetUserId = userId || this._currentUser?.userId;
    if (!targetUserId) {
      return {
        allowed: false,
        reason: 'User not authenticated',
        requiredLevel: PermissionLevel.VIEW,
        userLevel: PermissionLevel.NONE
      };
    }
    
    // Generate cache key
    const cacheKey = `${action}:${documentId}:${cellId || 'doc'}:${targetUserId}`;
    const cached = this._permissionCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    
    try {
      const userLevel = await this.getEffectivePermission(documentId, cellId, targetUserId);
      const requiredLevel = this._getRequiredPermissionLevel(action);
      
      const result: IPermissionResult = {
        allowed: this._isPermissionLevelSufficient(userLevel, requiredLevel),
        requiredLevel,
        userLevel,
        context: {
          action,
          documentId,
          cellId,
          userId: targetUserId
        }
      };
      
      if (!result.allowed) {
        result.reason = `Insufficient permissions: ${userLevel} < ${requiredLevel}`;
      }
      
      // Cache result for 30 seconds
      this._permissionCache.set(cacheKey, result);
      setTimeout(() => this._permissionCache.delete(cacheKey), 30000);
      
      return result;
    } catch (error) {
      console.error('Permission check failed:', error);
      
      return {
        allowed: false,
        reason: `Permission check failed: ${error.message}`,
        requiredLevel: this._getRequiredPermissionLevel(action),
        userLevel: PermissionLevel.NONE
      };
    }
  }
  
  /**
   * Check if user has specific permission level
   */
  async hasPermissionLevel(
    level: PermissionLevel,
    documentId: string,
    cellId?: string,
    userId?: string
  ): Promise<boolean> {
    try {
      const userLevel = await this.getEffectivePermission(documentId, cellId, userId);
      return this._isPermissionLevelSufficient(userLevel, level);
    } catch (error) {
      console.error('Permission level check failed:', error);
      return false;
    }
  }
  
  /**
   * Get user's effective permission level for document or cell
   */
  async getEffectivePermission(
    documentId: string,
    cellId?: string,
    userId?: string
  ): Promise<PermissionLevel> {
    const targetUserId = userId || this._currentUser?.userId;
    if (!targetUserId) {
      return PermissionLevel.NONE;
    }
    
    try {
      const docPermissions = await this.getDocumentPermissions(documentId);
      
      // Owner has admin rights
      if (docPermissions.owner === targetUserId) {
        return PermissionLevel.ADMIN;
      }
      
      // Check cell-specific permissions first if cellId provided
      if (cellId) {
        const cellPermissions = await this.getCellPermissions(documentId, cellId);
        const cellUserPerm = cellPermissions.userPermissions.get(targetUserId);
        if (cellUserPerm && cellUserPerm !== PermissionLevel.NONE) {
          return cellUserPerm;
        }
        
        // Check cell group permissions
        const user = await this._getUserIdentity(targetUserId);
        if (user) {
          for (const group of user.groups) {
            const cellGroupPerm = cellPermissions.groupPermissions.get(group);
            if (cellGroupPerm && cellGroupPerm !== PermissionLevel.NONE) {
              return cellGroupPerm;
            }
          }
        }
      }
      
      // Check document-level user permissions
      const docUserPerm = docPermissions.userPermissions.get(targetUserId);
      if (docUserPerm && docUserPerm !== PermissionLevel.NONE) {
        return docUserPerm;
      }
      
      // Check document-level group permissions
      const user = await this._getUserIdentity(targetUserId);
      if (user) {
        for (const group of user.groups) {
          const docGroupPerm = docPermissions.groupPermissions.get(group);
          if (docGroupPerm && docGroupPerm !== PermissionLevel.NONE) {
            return docGroupPerm;
          }
        }
      }
      
      // Return default permission level
      return docPermissions.defaultPermission;
    } catch (error) {
      console.error('Failed to get effective permission:', error);
      return PermissionLevel.NONE;
    }
  }
  
  /**
   * Set user permission for document
   */
  async setDocumentPermission(
    documentId: string,
    userId: string,
    level: PermissionLevel
  ): Promise<void> {
    if (!this._currentUser) {
      throw new Error('User not authenticated');
    }
    
    // Check if current user has admin permissions
    const hasAdmin = await this.hasPermissionLevel(PermissionLevel.ADMIN, documentId);
    if (!hasAdmin) {
      throw new Error('Insufficient permissions to modify document permissions');
    }
    
    try {
      const response = await this._makeAuthenticatedRequest(
        `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}/user/${encodeURIComponent(userId)}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this._currentUser.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ permission: level })
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to set document permission: ${response.status}`);
      }
      
      // Clear cache and emit change event
      this._clearPermissionCache();
      this._documentPermissions.delete(documentId);
      
      const changeEvent: IPermissionChangeEvent = {
        target: documentId,
        targetType: 'document',
        userId,
        oldLevel: PermissionLevel.NONE, // We don't track old level currently
        newLevel: level,
        changedBy: this._currentUser.userId,
        timestamp: new Date()
      };
      
      this._permissionsChanged.emit(changeEvent);
    } catch (error) {
      console.error('Failed to set document permission:', error);
      throw new Error(`Permission update failed: ${error.message}`);
    }
  }
  
  /**
   * Set user permission for specific cell
   */
  async setCellPermission(
    documentId: string,
    cellId: string,
    userId: string,
    level: PermissionLevel
  ): Promise<void> {
    if (!this._currentUser) {
      throw new Error('User not authenticated');
    }
    
    // Check if current user has admin permissions
    const hasAdmin = await this.hasPermissionLevel(PermissionLevel.ADMIN, documentId);
    if (!hasAdmin) {
      throw new Error('Insufficient permissions to modify cell permissions');
    }
    
    try {
      const response = await this._makeAuthenticatedRequest(
        `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}/cell/${encodeURIComponent(cellId)}/user/${encodeURIComponent(userId)}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this._currentUser.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ permission: level })
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to set cell permission: ${response.status}`);
      }
      
      // Clear cache and emit change event
      this._clearPermissionCache();
      this._documentPermissions.delete(documentId);
      
      const changeEvent: IPermissionChangeEvent = {
        target: cellId,
        targetType: 'cell',
        userId,
        oldLevel: PermissionLevel.NONE, // We don't track old level currently
        newLevel: level,
        changedBy: this._currentUser.userId,
        timestamp: new Date()
      };
      
      this._permissionsChanged.emit(changeEvent);
    } catch (error) {
      console.error('Failed to set cell permission:', error);
      throw new Error(`Cell permission update failed: ${error.message}`);
    }
  }
  
  /**
   * Set group permission for document
   */
  async setGroupPermission(
    documentId: string,
    groupName: string,
    level: PermissionLevel
  ): Promise<void> {
    if (!this._currentUser) {
      throw new Error('User not authenticated');
    }
    
    // Check if current user has admin permissions
    const hasAdmin = await this.hasPermissionLevel(PermissionLevel.ADMIN, documentId);
    if (!hasAdmin) {
      throw new Error('Insufficient permissions to modify group permissions');
    }
    
    try {
      const response = await this._makeAuthenticatedRequest(
        `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}/group/${encodeURIComponent(groupName)}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this._currentUser.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ permission: level })
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to set group permission: ${response.status}`);
      }
      
      // Clear cache and emit change event
      this._clearPermissionCache();
      this._documentPermissions.delete(documentId);
      
      const changeEvent: IPermissionChangeEvent = {
        target: documentId,
        targetType: 'document',
        userId: `group:${groupName}`,
        oldLevel: PermissionLevel.NONE,
        newLevel: level,
        changedBy: this._currentUser.userId,
        timestamp: new Date()
      };
      
      this._permissionsChanged.emit(changeEvent);
    } catch (error) {
      console.error('Failed to set group permission:', error);
      throw new Error(`Group permission update failed: ${error.message}`);
    }
  }
  
  /**
   * Remove user permission (revert to default)
   */
  async removeUserPermission(documentId: string, userId: string, cellId?: string): Promise<void> {
    if (!this._currentUser) {
      throw new Error('User not authenticated');
    }
    
    // Check if current user has admin permissions
    const hasAdmin = await this.hasPermissionLevel(PermissionLevel.ADMIN, documentId);
    if (!hasAdmin) {
      throw new Error('Insufficient permissions to remove user permissions');
    }
    
    try {
      const url = cellId 
        ? `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}/cell/${encodeURIComponent(cellId)}/user/${encodeURIComponent(userId)}`
        : `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}/user/${encodeURIComponent(userId)}`;
      
      const response = await this._makeAuthenticatedRequest(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this._currentUser.token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to remove user permission: ${response.status}`);
      }
      
      // Clear cache and emit change event
      this._clearPermissionCache();
      this._documentPermissions.delete(documentId);
      
      const changeEvent: IPermissionChangeEvent = {
        target: cellId || documentId,
        targetType: cellId ? 'cell' : 'document',
        userId,
        oldLevel: PermissionLevel.EDIT, // We don't track old level currently
        newLevel: PermissionLevel.NONE,
        changedBy: this._currentUser.userId,
        timestamp: new Date()
      };
      
      this._permissionsChanged.emit(changeEvent);
    } catch (error) {
      console.error('Failed to remove user permission:', error);
      throw new Error(`Permission removal failed: ${error.message}`);
    }
  }
  
  /**
   * Get list of users with access to document
   */
  async getDocumentUsers(documentId: string): Promise<Array<{
    user: IUserIdentity;
    permission: PermissionLevel;
    source: 'direct' | 'group' | 'default';
  }>> {
    if (!this._currentUser) {
      throw new Error('User not authenticated');
    }
    
    try {
      const response = await this._makeAuthenticatedRequest(
        `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}/users`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this._currentUser.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to get document users: ${response.status}`);
      }
      
      const usersData = await response.json();
      return usersData.map((userData: any) => ({
        user: {
          userId: userData.user.id,
          username: userData.user.name,
          email: userData.user.email,
          avatar: userData.user.avatar,
          groups: userData.user.groups || [],
          token: '', // Don't expose tokens
          tokenExpiry: 0
        },
        permission: userData.permission,
        source: userData.source
      }));
    } catch (error) {
      console.error('Failed to get document users:', error);
      throw new Error(`Failed to retrieve document users: ${error.message}`);
    }
  }
  
  /**
   * Transfer document ownership to another user
   */
  async transferOwnership(documentId: string, newOwnerId: string): Promise<void> {
    if (!this._currentUser) {
      throw new Error('User not authenticated');
    }
    
    // Check if current user has admin permissions
    const hasAdmin = await this.hasPermissionLevel(PermissionLevel.ADMIN, documentId);
    if (!hasAdmin) {
      throw new Error('Insufficient permissions to transfer ownership');
    }
    
    try {
      const response = await this._makeAuthenticatedRequest(
        `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}/owner`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this._currentUser.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ newOwner: newOwnerId })
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to transfer ownership: ${response.status}`);
      }
      
      // Clear cache and emit change event
      this._clearPermissionCache();
      this._documentPermissions.delete(documentId);
      
      const changeEvent: IPermissionChangeEvent = {
        target: documentId,
        targetType: 'document',
        userId: newOwnerId,
        oldLevel: PermissionLevel.NONE,
        newLevel: PermissionLevel.ADMIN,
        changedBy: this._currentUser.userId,
        timestamp: new Date()
      };
      
      this._permissionsChanged.emit(changeEvent);
    } catch (error) {
      console.error('Failed to transfer ownership:', error);
      throw new Error(`Ownership transfer failed: ${error.message}`);
    }
  }
  
  /**
   * Create default permissions for new document
   */
  async createDocumentPermissions(
    documentId: string,
    owner: string,
    defaultLevel: PermissionLevel
  ): Promise<void> {
    if (!this._currentUser) {
      throw new Error('User not authenticated');
    }
    
    try {
      const response = await this._makeAuthenticatedRequest(
        `/api/jupyter/collaboration/permissions/document/${encodeURIComponent(documentId)}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this._currentUser.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            owner,
            defaultPermission: defaultLevel
          })
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to create document permissions: ${response.status}`);
      }
      
      // Clear cache
      this._clearPermissionCache();
      this._documentPermissions.delete(documentId);
    } catch (error) {
      console.error('Failed to create document permissions:', error);
      throw new Error(`Permission creation failed: ${error.message}`);
    }
  }
  
  /**
   * Dispose of the permissions manager
   */
  dispose(): void {
    if (this._authValidationInterval) {
      clearInterval(this._authValidationInterval);
      this._authValidationInterval = null;
    }
    
    this._permissionsChanged.dispose();
    this._authenticationChanged.dispose();
    this._currentUser = null;
    this._isInitialized = false;
    this._sessionContext = null;
    this._documentPermissions.clear();
    this._permissionCache.clear();
  }
  
  // Private helper methods
  
  private async _loadExistingAuthentication(): Promise<void> {
    try {
      // Try to get authentication from session or cookie
      const response = await this._makeRequest('/api/jupyter/user/current', {
        method: 'GET',
        credentials: 'include'
      });
      
      if (response.ok) {
        const userData = await response.json();
        if (userData && userData.name) {
          this._currentUser = {
            userId: userData.id,
            username: userData.name,
            email: userData.email,
            avatar: userData.avatar,
            groups: userData.groups || [],
            token: userData.token || '',
            tokenExpiry: Date.now() + (8 * 60 * 60 * 1000)
          };
          
          this._authenticationChanged.emit(this._currentUser);
        }
      }
    } catch (error) {
      console.warn('Failed to load existing authentication:', error);
      // Not a critical error, user can authenticate manually
    }
  }
  
  private _startAuthValidation(): void {
    // Validate authentication every 5 minutes
    this._authValidationInterval = window.setInterval(async () => {
      const isValid = await this.validateAuthentication();
      if (!isValid && this._currentUser) {
        console.warn('Authentication validation failed, clearing user session');
        this._currentUser = null;
        this._authenticationChanged.emit(null);
      }
    }, 5 * 60 * 1000);
  }
  
  private async _makeAuthenticatedRequest(url: string, options: RequestInit): Promise<Response> {
    if (!this._currentUser?.token) {
      throw new Error('No authentication token available');
    }
    
    return this._makeRequest(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${this._currentUser.token}`
      }
    });
  }
  
  private async _makeRequest(url: string, options: RequestInit): Promise<Response> {
    const fullUrl = URLExt.join(PageConfig.getBaseUrl(), url);
    
    return fetch(fullUrl, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
  }
  
  private _parseDocumentPermissions(data: any): IDocumentPermissions {
    return {
      documentId: data.documentId,
      owner: data.owner,
      defaultPermission: data.defaultPermission || PermissionLevel.VIEW,
      userPermissions: new Map(Object.entries(data.userPermissions || {})),
      groupPermissions: new Map(Object.entries(data.groupPermissions || {})),
      isPublic: data.isPublic || false,
      cellPermissions: new Map(
        Object.entries(data.cellPermissions || {}).map(([cellId, cellData]: [string, any]) => [
          cellId,
          this._parseCellPermissions(cellId, cellData)
        ])
      ),
      createdAt: new Date(data.createdAt),
      lastModified: new Date(data.lastModified)
    };
  }
  
  private _parseCellPermissions(cellId: string, data: any): ICellPermissions {
    return {
      cellId,
      userPermissions: new Map(Object.entries(data.userPermissions || {})),
      groupPermissions: new Map(Object.entries(data.groupPermissions || {})),
      isLocked: data.isLocked || false,
      lockedBy: data.lockedBy,
      lockExpiry: data.lockExpiry ? new Date(data.lockExpiry).getTime() : undefined,
      isProtected: data.isProtected || false,
      privateOutputViewers: new Set(data.privateOutputViewers || [])
    };
  }
  
  private _createDefaultDocumentPermissions(documentId: string): IDocumentPermissions {
    const currentUserId = this._currentUser?.userId || 'unknown';
    
    return {
      documentId,
      owner: currentUserId,
      defaultPermission: PermissionLevel.VIEW,
      userPermissions: new Map([[currentUserId, PermissionLevel.ADMIN]]),
      groupPermissions: new Map(),
      isPublic: false,
      cellPermissions: new Map(),
      createdAt: new Date(),
      lastModified: new Date()
    };
  }
  
  private _createDefaultCellPermissions(cellId: string, docPermissions: IDocumentPermissions): ICellPermissions {
    return {
      cellId,
      userPermissions: new Map(),
      groupPermissions: new Map(),
      isLocked: false,
      isProtected: false,
      privateOutputViewers: new Set()
    };
  }
  
  private _getRequiredPermissionLevel(action: CollaborativeAction): PermissionLevel {
    switch (action) {
      case CollaborativeAction.VIEW_NOTEBOOK:
      case CollaborativeAction.VIEW_HISTORY:
        return PermissionLevel.VIEW;
      
      case CollaborativeAction.ADD_COMMENT:
        return PermissionLevel.COMMENT;
      
      case CollaborativeAction.EDIT_CELL:
      case CollaborativeAction.EXECUTE_CELL:
      case CollaborativeAction.CREATE_CELL:
      case CollaborativeAction.DELETE_CELL:
      case CollaborativeAction.MOVE_CELL:
      case CollaborativeAction.LOCK_CELL:
      case CollaborativeAction.UNLOCK_CELL:
      case CollaborativeAction.EDIT_COMMENT:
      case CollaborativeAction.DELETE_COMMENT:
      case CollaborativeAction.RESOLVE_COMMENT:
      case CollaborativeAction.REVERT_CHANGE:
        return PermissionLevel.EDIT;
      
      case CollaborativeAction.MANAGE_PERMISSIONS:
        return PermissionLevel.ADMIN;
      
      default:
        return PermissionLevel.EDIT;
    }
  }
  
  private _isPermissionLevelSufficient(userLevel: PermissionLevel, requiredLevel: PermissionLevel): boolean {
    const levels = [
      PermissionLevel.NONE,
      PermissionLevel.VIEW,
      PermissionLevel.COMMENT,
      PermissionLevel.EDIT,
      PermissionLevel.ADMIN
    ];
    
    const userIndex = levels.indexOf(userLevel);
    const requiredIndex = levels.indexOf(requiredLevel);
    
    return userIndex >= requiredIndex;
  }
  
  private async _getUserIdentity(userId: string): Promise<IUserIdentity | null> {
    if (this._currentUser && this._currentUser.userId === userId) {
      return this._currentUser;
    }
    
    // For other users, we'd need to fetch from server
    // For now, return null and rely on group permissions from document data
    return null;
  }
  
  private _clearPermissionCache(): void {
    this._permissionCache.clear();
  }
}

/**
 * Default implementation factory
 */
export function createPermissionsManager(): IPermissionsManager {
  return new PermissionsManager();
}

/**
 * Utility functions for permission checking
 */
export namespace PermissionUtils {
  /**
   * Check if a permission level includes another level
   */
  export function includes(level: PermissionLevel, required: PermissionLevel): boolean {
    const levels = [
      PermissionLevel.NONE,
      PermissionLevel.VIEW,
      PermissionLevel.COMMENT,
      PermissionLevel.EDIT,
      PermissionLevel.ADMIN
    ];
    
    const levelIndex = levels.indexOf(level);
    const requiredIndex = levels.indexOf(required);
    
    return levelIndex >= requiredIndex;
  }
  
  /**
   * Get human-readable permission level name
   */
  export function getPermissionName(level: PermissionLevel): string {
    switch (level) {
      case PermissionLevel.NONE:
        return 'No Access';
      case PermissionLevel.VIEW:
        return 'View Only';
      case PermissionLevel.COMMENT:
        return 'Comment Only';
      case PermissionLevel.EDIT:
        return 'Can Edit';
      case PermissionLevel.ADMIN:
        return 'Admin';
      default:
        return 'Unknown';
    }
  }
  
  /**
   * Get permission level description
   */
  export function getPermissionDescription(level: PermissionLevel): string {
    switch (level) {
      case PermissionLevel.NONE:
        return 'Cannot access the notebook';
      case PermissionLevel.VIEW:
        return 'Can view notebook content but cannot modify';
      case PermissionLevel.COMMENT:
        return 'Can view content and add comments';
      case PermissionLevel.EDIT:
        return 'Can modify content and execute code';
      case PermissionLevel.ADMIN:
        return 'Full control including permission management';
      default:
        return 'Unknown permission level';
    }
  }
  
  /**
   * Get available actions for a permission level
   */
  export function getAvailableActions(level: PermissionLevel): CollaborativeAction[] {
    const actions: CollaborativeAction[] = [];
    
    if (includes(level, PermissionLevel.VIEW)) {
      actions.push(
        CollaborativeAction.VIEW_NOTEBOOK,
        CollaborativeAction.VIEW_HISTORY
      );
    }
    
    if (includes(level, PermissionLevel.COMMENT)) {
      actions.push(CollaborativeAction.ADD_COMMENT);
    }
    
    if (includes(level, PermissionLevel.EDIT)) {
      actions.push(
        CollaborativeAction.EDIT_CELL,
        CollaborativeAction.EXECUTE_CELL,
        CollaborativeAction.CREATE_CELL,
        CollaborativeAction.DELETE_CELL,
        CollaborativeAction.MOVE_CELL,
        CollaborativeAction.LOCK_CELL,
        CollaborativeAction.UNLOCK_CELL,
        CollaborativeAction.EDIT_COMMENT,
        CollaborativeAction.DELETE_COMMENT,
        CollaborativeAction.RESOLVE_COMMENT,
        CollaborativeAction.REVERT_CHANGE
      );
    }
    
    if (includes(level, PermissionLevel.ADMIN)) {
      actions.push(CollaborativeAction.MANAGE_PERMISSIONS);
    }
    
    return actions;
  }
}