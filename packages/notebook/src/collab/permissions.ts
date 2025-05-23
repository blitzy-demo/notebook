/**
 * Implements access control and edit permissions based on user roles for collaborative notebooks.
 * This module provides the IPermissionsManager interface for managing user roles, access levels,
 * and permission checks. It integrates with JupyterHub for authentication and user information.
 */

import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import * as Y from 'yjs';

/**
 * Permission roles for collaborative notebooks
 */
export enum PermissionRole {
  /**
   * Owner has full control over the notebook, including managing permissions
   */
  Owner = 'owner',

  /**
   * Editor can modify notebook content, execute cells, and manage comments
   */
  Editor = 'editor',

  /**
   * Commenter can view content, add/resolve comments, but cannot edit cells
   */
  Commenter = 'commenter',

  /**
   * Viewer has read-only access, can view others' cursors and comments
   */
  Viewer = 'viewer'
}

/**
 * Permission actions that can be performed on a notebook
 */
export enum PermissionAction {
  /**
   * View the notebook content
   */
  View = 'view',

  /**
   * Edit cells in the notebook
   */
  Edit = 'edit',

  /**
   * Execute cells in the notebook
   */
  Execute = 'execute',

  /**
   * Add, edit, or resolve comments
   */
  Comment = 'comment',

  /**
   * Acquire locks on cells
   */
  Lock = 'lock',

  /**
   * Manage permissions for other users
   */
  ManagePermissions = 'manage_permissions',

  /**
   * Delete the notebook
   */
  Delete = 'delete'
}

/**
 * Permission scope for applying permissions
 */
export enum PermissionScope {
  /**
   * Apply permissions to the entire notebook
   */
  Notebook = 'notebook',

  /**
   * Apply permissions to a specific cell
   */
  Cell = 'cell'
}

/**
 * User information for permission management
 */
export interface IPermissionUser {
  /**
   * Unique user identifier
   */
  id: string;

  /**
   * Display name of the user
   */
  displayName: string;

  /**
   * User's avatar URL
   */
  avatarUrl?: string;

  /**
   * User's email address
   */
  email?: string;

  /**
   * Whether the user is an admin in JupyterHub
   */
  isAdmin?: boolean;
}

/**
 * Permission entry for a user
 */
export interface IPermissionEntry {
  /**
   * User the permission applies to
   */
  user: IPermissionUser;

  /**
   * Role assigned to the user
   */
  role: PermissionRole;

  /**
   * Timestamp when the permission was granted
   */
  grantedAt: number;

  /**
   * User who granted the permission
   */
  grantedBy: IPermissionUser;

  /**
   * Scope of the permission (notebook or cell)
   */
  scope: PermissionScope;

  /**
   * ID of the cell if scope is Cell
   */
  cellId?: string;

  /**
   * Optional expiration timestamp for temporary permissions
   */
  expiresAt?: number;
}

/**
 * Permission check result
 */
export interface IPermissionCheckResult {
  /**
   * Whether the action is allowed
   */
  allowed: boolean;

  /**
   * The role that granted the permission
   */
  role?: PermissionRole;

  /**
   * Reason for denial if not allowed
   */
  reason?: string;
}

/**
 * Permission change event
 */
export interface IPermissionChangeEvent {
  /**
   * Type of change
   */
  type: 'added' | 'removed' | 'updated';

  /**
   * The permission entry that changed
   */
  entry: IPermissionEntry;

  /**
   * Previous role if updated
   */
  previousRole?: PermissionRole;
}

/**
 * Permission manager status
 */
export enum PermissionManagerStatus {
  /**
   * Permission manager is initializing
   */
  Initializing = 'initializing',

  /**
   * Permission manager is ready and operational
   */
  Ready = 'ready',

  /**
   * Permission manager is in a degraded state (some functionality may be limited)
   */
  Degraded = 'degraded',

  /**
   * Permission manager is disconnected from the collaboration server
   */
  Disconnected = 'disconnected'
}

/**
 * Interface for the permissions manager
 */
export interface IPermissionsManager extends IDisposable {
  /**
   * The current status of the permissions manager
   */
  readonly status: PermissionManagerStatus;

  /**
   * Signal emitted when the permissions manager status changes
   */
  readonly statusChanged: ISignal<IPermissionsManager, PermissionManagerStatus>;

  /**
   * Signal emitted when permissions change
   */
  readonly permissionsChanged: ISignal<IPermissionsManager, IPermissionChangeEvent>;

  /**
   * Get the current user's information
   */
  readonly currentUser: IPermissionUser;

  /**
   * Get the current user's role for the notebook
   */
  readonly currentRole: PermissionRole;

  /**
   * Check if the current user has permission to perform an action
   *
   * @param action - The action to check
   * @param cellId - Optional cell ID for cell-specific permissions
   * @returns A promise that resolves to the permission check result
   */
  checkPermission(action: PermissionAction, cellId?: string): Promise<IPermissionCheckResult>;

  /**
   * Check if a specific user has permission to perform an action
   *
   * @param userId - The ID of the user to check
   * @param action - The action to check
   * @param cellId - Optional cell ID for cell-specific permissions
   * @returns A promise that resolves to the permission check result
   */
  checkUserPermission(userId: string, action: PermissionAction, cellId?: string): Promise<IPermissionCheckResult>;

  /**
   * Get all permission entries for the notebook
   *
   * @returns An array of all permission entries
   */
  getPermissions(): IPermissionEntry[];

  /**
   * Get permission entries for a specific user
   *
   * @param userId - The ID of the user to get permissions for
   * @returns An array of permission entries for the user
   */
  getUserPermissions(userId: string): IPermissionEntry[];

  /**
   * Get permission entries for a specific cell
   *
   * @param cellId - The ID of the cell to get permissions for
   * @returns An array of permission entries for the cell
   */
  getCellPermissions(cellId: string): IPermissionEntry[];

  /**
   * Set a user's role for the notebook
   *
   * @param userId - The ID of the user to set the role for
   * @param role - The role to assign
   * @returns A promise that resolves to true if the role was set, false otherwise
   */
  setUserRole(userId: string, role: PermissionRole): Promise<boolean>;

  /**
   * Set a user's role for a specific cell
   *
   * @param userId - The ID of the user to set the role for
   * @param cellId - The ID of the cell to set the role for
   * @param role - The role to assign
   * @returns A promise that resolves to true if the role was set, false otherwise
   */
  setCellRole(userId: string, cellId: string, role: PermissionRole): Promise<boolean>;

  /**
   * Remove a user's permissions for the notebook
   *
   * @param userId - The ID of the user to remove permissions for
   * @returns A promise that resolves to true if the permissions were removed, false otherwise
   */
  removeUserPermissions(userId: string): Promise<boolean>;

  /**
   * Remove a user's permissions for a specific cell
   *
   * @param userId - The ID of the user to remove permissions for
   * @param cellId - The ID of the cell to remove permissions for
   * @returns A promise that resolves to true if the permissions were removed, false otherwise
   */
  removeCellPermissions(userId: string, cellId: string): Promise<boolean>;

  /**
   * Get all users with permissions for the notebook
   *
   * @returns An array of users with permissions
   */
  getUsers(): IPermissionUser[];

  /**
   * Get the role required to perform an action
   *
   * @param action - The action to check
   * @returns The minimum role required for the action
   */
  getRoleForAction(action: PermissionAction): PermissionRole;

  /**
   * Set a temporary permission for a user
   *
   * @param userId - The ID of the user to set the permission for
   * @param role - The role to assign
   * @param durationMs - Duration in milliseconds for the temporary permission
   * @param scope - The scope of the permission (notebook or cell)
   * @param cellId - The ID of the cell if scope is Cell
   * @returns A promise that resolves to true if the permission was set, false otherwise
   */
  setTemporaryPermission(
    userId: string,
    role: PermissionRole,
    durationMs: number,
    scope: PermissionScope,
    cellId?: string
  ): Promise<boolean>;

  /**
   * Synchronize permissions with the server
   *
   * @returns A promise that resolves when synchronization is complete
   */
  syncPermissions(): Promise<void>;
}

/**
 * Permission manager configuration options
 */
export interface IPermissionsManagerOptions {
  /**
   * The Yjs document to use for permission synchronization
   */
  ydoc: Y.Doc;

  /**
   * The current user's information
   */
  currentUser: IPermissionUser;

  /**
   * The notebook ID
   */
  notebookId: string;

  /**
   * Initial permissions for the notebook
   */
  initialPermissions?: IPermissionEntry[];

  /**
   * Whether to automatically make the current user an owner if no owners exist
   */
  autoAssignOwner?: boolean;

  /**
   * Default role for users not explicitly assigned a role
   */
  defaultRole?: PermissionRole;

  /**
   * Whether to enable cell-level permissions
   */
  enableCellPermissions?: boolean;

  /**
   * JupyterHub API URL for user information
   */
  hubApiUrl?: string;
}

/**
 * Implementation of the IPermissionsManager interface
 */
export class PermissionsManager implements IPermissionsManager {
  /**
   * Create a new PermissionsManager instance
   *
   * @param options - The permissions manager configuration options
   */
  constructor(options: IPermissionsManagerOptions) {
    this._ydoc = options.ydoc;
    this._currentUser = options.currentUser;
    this._notebookId = options.notebookId;
    this._enableCellPermissions = options.enableCellPermissions ?? true;
    this._defaultRole = options.defaultRole ?? PermissionRole.Viewer;
    this._hubApiUrl = options.hubApiUrl;
    this._autoAssignOwner = options.autoAssignOwner ?? true;

    // Initialize the shared permissions map
    this._yPermissions = this._ydoc.getMap<Y.Map<any>>('permissions');

    // Set up event listeners
    this._yPermissions.observe(this._onPermissionsChanged.bind(this));

    // Initialize signals
    this._statusChanged = new Signal<IPermissionsManager, PermissionManagerStatus>(this);
    this._permissionsChanged = new Signal<IPermissionsManager, IPermissionChangeEvent>(this);

    // Initialize with provided permissions or default permissions
    this._initializePermissions(options.initialPermissions);

    this._status = PermissionManagerStatus.Ready;
  }

  /**
   * The current status of the permissions manager
   */
  get status(): PermissionManagerStatus {
    return this._status;
  }

  /**
   * Signal emitted when the permissions manager status changes
   */
  get statusChanged(): ISignal<IPermissionsManager, PermissionManagerStatus> {
    return this._statusChanged;
  }

  /**
   * Signal emitted when permissions change
   */
  get permissionsChanged(): ISignal<IPermissionsManager, IPermissionChangeEvent> {
    return this._permissionsChanged;
  }

  /**
   * Get the current user's information
   */
  get currentUser(): IPermissionUser {
    return this._currentUser;
  }

  /**
   * Get the current user's role for the notebook
   */
  get currentRole(): PermissionRole {
    const permissions = this.getUserPermissions(this._currentUser.id);
    const notebookPermission = permissions.find(p => p.scope === PermissionScope.Notebook);
    return notebookPermission?.role ?? this._defaultRole;
  }

  /**
   * Check if the current user has permission to perform an action
   *
   * @param action - The action to check
   * @param cellId - Optional cell ID for cell-specific permissions
   * @returns A promise that resolves to the permission check result
   */
  async checkPermission(action: PermissionAction, cellId?: string): Promise<IPermissionCheckResult> {
    return this.checkUserPermission(this._currentUser.id, action, cellId);
  }

  /**
   * Check if a specific user has permission to perform an action
   *
   * @param userId - The ID of the user to check
   * @param action - The action to check
   * @param cellId - Optional cell ID for cell-specific permissions
   * @returns A promise that resolves to the permission check result
   */
  async checkUserPermission(userId: string, action: PermissionAction, cellId?: string): Promise<IPermissionCheckResult> {
    // Get the user's permissions
    const permissions = this.getUserPermissions(userId);

    // Check if the user is an admin (admins have all permissions)
    const isAdmin = permissions.some(p => p.user.isAdmin === true);
    if (isAdmin) {
      return {
        allowed: true,
        role: PermissionRole.Owner
      };
    }

    // Get the role required for the action
    const requiredRole = this.getRoleForAction(action);

    // Check cell-specific permissions first if a cellId is provided
    if (cellId && this._enableCellPermissions) {
      const cellPermission = permissions.find(p => p.scope === PermissionScope.Cell && p.cellId === cellId);
      if (cellPermission) {
        // Check if the permission has expired
        if (cellPermission.expiresAt && cellPermission.expiresAt < Date.now()) {
          // Remove the expired permission
          this.removeCellPermissions(userId, cellId);
        } else {
          // Check if the user's role for this cell is sufficient
          const allowed = this._isRoleSufficient(cellPermission.role, requiredRole);
          return {
            allowed,
            role: cellPermission.role,
            reason: allowed ? undefined : `User does not have ${requiredRole} role for this cell`
          };
        }
      }
    }

    // Check notebook-level permissions
    const notebookPermission = permissions.find(p => p.scope === PermissionScope.Notebook);
    if (notebookPermission) {
      // Check if the permission has expired
      if (notebookPermission.expiresAt && notebookPermission.expiresAt < Date.now()) {
        // Remove the expired permission
        this.removeUserPermissions(userId);
        return {
          allowed: false,
          reason: 'Permission has expired'
        };
      }

      // Check if the user's role is sufficient
      const allowed = this._isRoleSufficient(notebookPermission.role, requiredRole);
      return {
        allowed,
        role: notebookPermission.role,
        reason: allowed ? undefined : `User does not have ${requiredRole} role for this notebook`
      };
    }

    // If no permissions are found, use the default role
    const allowed = this._isRoleSufficient(this._defaultRole, requiredRole);
    return {
      allowed,
      role: this._defaultRole,
      reason: allowed ? undefined : `User does not have ${requiredRole} role (using default role)`
    };
  }

  /**
   * Get all permission entries for the notebook
   *
   * @returns An array of all permission entries
   */
  getPermissions(): IPermissionEntry[] {
    const permissions: IPermissionEntry[] = [];
    this._yPermissions.forEach((yPermission) => {
      permissions.push(this._yPermissionToPermission(yPermission));
    });
    return permissions;
  }

  /**
   * Get permission entries for a specific user
   *
   * @param userId - The ID of the user to get permissions for
   * @returns An array of permission entries for the user
   */
  getUserPermissions(userId: string): IPermissionEntry[] {
    const permissions = this.getPermissions();
    return permissions.filter(p => p.user.id === userId);
  }

  /**
   * Get permission entries for a specific cell
   *
   * @param cellId - The ID of the cell to get permissions for
   * @returns An array of permission entries for the cell
   */
  getCellPermissions(cellId: string): IPermissionEntry[] {
    const permissions = this.getPermissions();
    return permissions.filter(p => p.scope === PermissionScope.Cell && p.cellId === cellId);
  }

  /**
   * Set a user's role for the notebook
   *
   * @param userId - The ID of the user to set the role for
   * @param role - The role to assign
   * @returns A promise that resolves to true if the role was set, false otherwise
   */
  async setUserRole(userId: string, role: PermissionRole): Promise<boolean> {
    // Check if the current user has permission to manage permissions
    const canManage = await this.checkPermission(PermissionAction.ManagePermissions);
    if (!canManage.allowed) {
      console.warn('Current user does not have permission to manage permissions');
      return false;
    }

    // Get the user information
    const user = await this._getUserInfo(userId);
    if (!user) {
      console.warn(`User with ID ${userId} not found`);
      return false;
    }

    // Create a unique key for the permission
    const permissionKey = `notebook:${userId}`;

    // Check if the permission already exists
    const existingPermission = this._yPermissions.get(permissionKey);
    let previousRole: PermissionRole | undefined;

    if (existingPermission) {
      previousRole = existingPermission.get('role') as PermissionRole;
      // If the role is the same, no need to update
      if (previousRole === role) {
        return true;
      }
    }

    // Create the permission entry
    const permissionEntry: IPermissionEntry = {
      user,
      role,
      grantedAt: Date.now(),
      grantedBy: this._currentUser,
      scope: PermissionScope.Notebook
    };

    // Create the Yjs permission object
    const yPermission = this._permissionToYPermission(permissionEntry);

    // Update the shared permissions map
    this._ydoc.transact(() => {
      this._yPermissions.set(permissionKey, yPermission);
    });

    // Emit change event
    this._emitPermissionChangeEvent({
      type: existingPermission ? 'updated' : 'added',
      entry: permissionEntry,
      previousRole
    });

    return true;
  }

  /**
   * Set a user's role for a specific cell
   *
   * @param userId - The ID of the user to set the role for
   * @param cellId - The ID of the cell to set the role for
   * @param role - The role to assign
   * @returns A promise that resolves to true if the role was set, false otherwise
   */
  async setCellRole(userId: string, cellId: string, role: PermissionRole): Promise<boolean> {
    // Check if cell permissions are enabled
    if (!this._enableCellPermissions) {
      console.warn('Cell-level permissions are not enabled');
      return false;
    }

    // Check if the current user has permission to manage permissions
    const canManage = await this.checkPermission(PermissionAction.ManagePermissions);
    if (!canManage.allowed) {
      console.warn('Current user does not have permission to manage permissions');
      return false;
    }

    // Get the user information
    const user = await this._getUserInfo(userId);
    if (!user) {
      console.warn(`User with ID ${userId} not found`);
      return false;
    }

    // Create a unique key for the permission
    const permissionKey = `cell:${cellId}:${userId}`;

    // Check if the permission already exists
    const existingPermission = this._yPermissions.get(permissionKey);
    let previousRole: PermissionRole | undefined;

    if (existingPermission) {
      previousRole = existingPermission.get('role') as PermissionRole;
      // If the role is the same, no need to update
      if (previousRole === role) {
        return true;
      }
    }

    // Create the permission entry
    const permissionEntry: IPermissionEntry = {
      user,
      role,
      grantedAt: Date.now(),
      grantedBy: this._currentUser,
      scope: PermissionScope.Cell,
      cellId
    };

    // Create the Yjs permission object
    const yPermission = this._permissionToYPermission(permissionEntry);

    // Update the shared permissions map
    this._ydoc.transact(() => {
      this._yPermissions.set(permissionKey, yPermission);
    });

    // Emit change event
    this._emitPermissionChangeEvent({
      type: existingPermission ? 'updated' : 'added',
      entry: permissionEntry,
      previousRole
    });

    return true;
  }

  /**
   * Remove a user's permissions for the notebook
   *
   * @param userId - The ID of the user to remove permissions for
   * @returns A promise that resolves to true if the permissions were removed, false otherwise
   */
  async removeUserPermissions(userId: string): Promise<boolean> {
    // Check if the current user has permission to manage permissions
    const canManage = await this.checkPermission(PermissionAction.ManagePermissions);
    if (!canManage.allowed) {
      console.warn('Current user does not have permission to manage permissions');
      return false;
    }

    // Create a unique key for the permission
    const permissionKey = `notebook:${userId}`;

    // Check if the permission exists
    const existingPermission = this._yPermissions.get(permissionKey);
    if (!existingPermission) {
      // Permission doesn't exist, nothing to remove
      return true;
    }

    // Get the permission entry before removing it
    const permissionEntry = this._yPermissionToPermission(existingPermission);

    // Remove the permission from the shared map
    this._ydoc.transact(() => {
      this._yPermissions.delete(permissionKey);
    });

    // Emit change event
    this._emitPermissionChangeEvent({
      type: 'removed',
      entry: permissionEntry
    });

    return true;
  }

  /**
   * Remove a user's permissions for a specific cell
   *
   * @param userId - The ID of the user to remove permissions for
   * @param cellId - The ID of the cell to remove permissions for
   * @returns A promise that resolves to true if the permissions were removed, false otherwise
   */
  async removeCellPermissions(userId: string, cellId: string): Promise<boolean> {
    // Check if cell permissions are enabled
    if (!this._enableCellPermissions) {
      console.warn('Cell-level permissions are not enabled');
      return false;
    }

    // Check if the current user has permission to manage permissions
    const canManage = await this.checkPermission(PermissionAction.ManagePermissions);
    if (!canManage.allowed) {
      console.warn('Current user does not have permission to manage permissions');
      return false;
    }

    // Create a unique key for the permission
    const permissionKey = `cell:${cellId}:${userId}`;

    // Check if the permission exists
    const existingPermission = this._yPermissions.get(permissionKey);
    if (!existingPermission) {
      // Permission doesn't exist, nothing to remove
      return true;
    }

    // Get the permission entry before removing it
    const permissionEntry = this._yPermissionToPermission(existingPermission);

    // Remove the permission from the shared map
    this._ydoc.transact(() => {
      this._yPermissions.delete(permissionKey);
    });

    // Emit change event
    this._emitPermissionChangeEvent({
      type: 'removed',
      entry: permissionEntry
    });

    return true;
  }

  /**
   * Get all users with permissions for the notebook
   *
   * @returns An array of users with permissions
   */
  getUsers(): IPermissionUser[] {
    const permissions = this.getPermissions();
    const userMap = new Map<string, IPermissionUser>();

    // Collect unique users
    permissions.forEach(permission => {
      if (!userMap.has(permission.user.id)) {
        userMap.set(permission.user.id, permission.user);
      }
    });

    return Array.from(userMap.values());
  }

  /**
   * Get the role required to perform an action
   *
   * @param action - The action to check
   * @returns The minimum role required for the action
   */
  getRoleForAction(action: PermissionAction): PermissionRole {
    switch (action) {
      case PermissionAction.View:
        return PermissionRole.Viewer;
      case PermissionAction.Comment:
        return PermissionRole.Commenter;
      case PermissionAction.Edit:
      case PermissionAction.Execute:
      case PermissionAction.Lock:
        return PermissionRole.Editor;
      case PermissionAction.ManagePermissions:
      case PermissionAction.Delete:
        return PermissionRole.Owner;
      default:
        return PermissionRole.Owner; // Default to Owner for unknown actions
    }
  }

  /**
   * Set a temporary permission for a user
   *
   * @param userId - The ID of the user to set the permission for
   * @param role - The role to assign
   * @param durationMs - Duration in milliseconds for the temporary permission
   * @param scope - The scope of the permission (notebook or cell)
   * @param cellId - The ID of the cell if scope is Cell
   * @returns A promise that resolves to true if the permission was set, false otherwise
   */
  async setTemporaryPermission(
    userId: string,
    role: PermissionRole,
    durationMs: number,
    scope: PermissionScope,
    cellId?: string
  ): Promise<boolean> {
    // Check if the current user has permission to manage permissions
    const canManage = await this.checkPermission(PermissionAction.ManagePermissions);
    if (!canManage.allowed) {
      console.warn('Current user does not have permission to manage permissions');
      return false;
    }

    // Check if cell permissions are enabled if scope is Cell
    if (scope === PermissionScope.Cell && !this._enableCellPermissions) {
      console.warn('Cell-level permissions are not enabled');
      return false;
    }

    // Get the user information
    const user = await this._getUserInfo(userId);
    if (!user) {
      console.warn(`User with ID ${userId} not found`);
      return false;
    }

    // Create a unique key for the permission
    const permissionKey = scope === PermissionScope.Notebook
      ? `notebook:${userId}`
      : `cell:${cellId}:${userId}`;

    // Check if the permission already exists
    const existingPermission = this._yPermissions.get(permissionKey);
    let previousRole: PermissionRole | undefined;

    if (existingPermission) {
      previousRole = existingPermission.get('role') as PermissionRole;
    }

    // Create the permission entry
    const permissionEntry: IPermissionEntry = {
      user,
      role,
      grantedAt: Date.now(),
      grantedBy: this._currentUser,
      scope,
      expiresAt: Date.now() + durationMs
    };

    // Add cellId if scope is Cell
    if (scope === PermissionScope.Cell && cellId) {
      permissionEntry.cellId = cellId;
    }

    // Create the Yjs permission object
    const yPermission = this._permissionToYPermission(permissionEntry);

    // Update the shared permissions map
    this._ydoc.transact(() => {
      this._yPermissions.set(permissionKey, yPermission);
    });

    // Emit change event
    this._emitPermissionChangeEvent({
      type: existingPermission ? 'updated' : 'added',
      entry: permissionEntry,
      previousRole
    });

    return true;
  }

  /**
   * Synchronize permissions with the server
   *
   * @returns A promise that resolves when synchronization is complete
   */
  async syncPermissions(): Promise<void> {
    // This method would typically communicate with the server to ensure
    // permissions are synchronized. For now, we'll just ensure our local
    // state is consistent.
    
    // Check for and remove expired permissions
    const now = Date.now();
    const expiredPermissions: string[] = [];
    
    this._yPermissions.forEach((yPermission, key) => {
      const expiresAt = yPermission.get('expiresAt');
      if (expiresAt && expiresAt < now) {
        expiredPermissions.push(key);
      }
    });
    
    if (expiredPermissions.length > 0) {
      this._ydoc.transact(() => {
        for (const key of expiredPermissions) {
          this._yPermissions.delete(key);
        }
      });
    }
    
    // Ensure there's at least one owner if auto-assign is enabled
    if (this._autoAssignOwner) {
      const hasOwner = this.getPermissions().some(p => 
        p.scope === PermissionScope.Notebook && p.role === PermissionRole.Owner
      );
      
      if (!hasOwner) {
        // Make the current user an owner
        await this.setUserRole(this._currentUser.id, PermissionRole.Owner);
      }
    }
  }

  /**
   * Dispose of the permissions manager and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    // Remove event listeners
    this._yPermissions.unobserve(this._onPermissionsChanged.bind(this));

    // Clean up signals
    this._statusChanged.disconnect();
    this._permissionsChanged.disconnect();

    this._isDisposed = true;
  }

  /**
   * Initialize permissions with provided entries or default permissions
   *
   * @param initialPermissions - Optional initial permission entries
   */
  private _initializePermissions(initialPermissions?: IPermissionEntry[]): void {
    if (initialPermissions && initialPermissions.length > 0) {
      // Add initial permissions to the shared map
      this._ydoc.transact(() => {
        for (const permission of initialPermissions) {
          const key = permission.scope === PermissionScope.Notebook
            ? `notebook:${permission.user.id}`
            : `cell:${permission.cellId}:${permission.user.id}`;
          
          const yPermission = this._permissionToYPermission(permission);
          this._yPermissions.set(key, yPermission);
        }
      });
    } else if (this._autoAssignOwner) {
      // If no initial permissions and auto-assign is enabled, make the current user an owner
      const permissionEntry: IPermissionEntry = {
        user: this._currentUser,
        role: PermissionRole.Owner,
        grantedAt: Date.now(),
        grantedBy: this._currentUser,
        scope: PermissionScope.Notebook
      };
      
      const key = `notebook:${this._currentUser.id}`;
      const yPermission = this._permissionToYPermission(permissionEntry);
      
      this._ydoc.transact(() => {
        this._yPermissions.set(key, yPermission);
      });
    }
  }

  /**
   * Handle changes to the shared permissions map
   *
   * @param event - The Y.js map event
   */
  private _onPermissionsChanged(event: Y.YMapEvent<Y.Map<any>>): void {
    // Process added or updated permissions
    event.keysChanged.forEach(key => {
      if (this._yPermissions.has(key)) {
        const yPermission = this._yPermissions.get(key)!;
        const permission = this._yPermissionToPermission(yPermission);
        
        // Check if this is a new permission or an update
        const isNew = !event.changes.keys.get(key)?.oldValue;
        
        // Emit change event
        this._emitPermissionChangeEvent({
          type: isNew ? 'added' : 'updated',
          entry: permission,
          previousRole: isNew ? undefined : (event.changes.keys.get(key)?.oldValue as Y.Map<any>).get('role')
        });
      } else {
        // Permission was deleted
        const oldYPermission = event.changes.keys.get(key)?.oldValue as Y.Map<any>;
        if (oldYPermission) {
          const oldPermission = this._yPermissionToPermission(oldYPermission);
          
          // Emit change event
          this._emitPermissionChangeEvent({
            type: 'removed',
            entry: oldPermission
          });
        }
      }
    });
  }

  /**
   * Convert a Yjs permission to an IPermissionEntry
   *
   * @param yPermission - The Yjs permission to convert
   * @returns The converted permission entry
   */
  private _yPermissionToPermission(yPermission: Y.Map<any>): IPermissionEntry {
    return {
      user: yPermission.get('user'),
      role: yPermission.get('role'),
      grantedAt: yPermission.get('grantedAt'),
      grantedBy: yPermission.get('grantedBy'),
      scope: yPermission.get('scope'),
      cellId: yPermission.get('cellId'),
      expiresAt: yPermission.get('expiresAt')
    };
  }

  /**
   * Convert an IPermissionEntry to a Yjs permission
   *
   * @param permission - The permission entry to convert
   * @returns The converted Yjs permission
   */
  private _permissionToYPermission(permission: IPermissionEntry): Y.Map<any> {
    const yPermission = new Y.Map<any>();
    yPermission.set('user', permission.user);
    yPermission.set('role', permission.role);
    yPermission.set('grantedAt', permission.grantedAt);
    yPermission.set('grantedBy', permission.grantedBy);
    yPermission.set('scope', permission.scope);
    
    if (permission.cellId) {
      yPermission.set('cellId', permission.cellId);
    }
    
    if (permission.expiresAt) {
      yPermission.set('expiresAt', permission.expiresAt);
    }
    
    return yPermission;
  }

  /**
   * Check if a role is sufficient for a required role
   *
   * @param userRole - The user's role
   * @param requiredRole - The required role
   * @returns True if the user's role is sufficient, false otherwise
   */
  private _isRoleSufficient(userRole: PermissionRole, requiredRole: PermissionRole): boolean {
    const roleHierarchy = {
      [PermissionRole.Owner]: 4,
      [PermissionRole.Editor]: 3,
      [PermissionRole.Commenter]: 2,
      [PermissionRole.Viewer]: 1
    };
    
    return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
  }

  /**
   * Get user information from JupyterHub or local cache
   *
   * @param userId - The ID of the user to get information for
   * @returns A promise that resolves to the user information or null if not found
   */
  private async _getUserInfo(userId: string): Promise<IPermissionUser | null> {
    // First check if we already have this user in our permissions
    const existingUsers = this.getUsers();
    const existingUser = existingUsers.find(u => u.id === userId);
    if (existingUser) {
      return existingUser;
    }
    
    // If the user ID matches the current user, return the current user info
    if (userId === this._currentUser.id) {
      return this._currentUser;
    }
    
    // If we have a JupyterHub API URL, try to fetch the user information
    if (this._hubApiUrl) {
      try {
        const response = await fetch(`${this._hubApiUrl}/users/${userId}`);
        if (response.ok) {
          const userData = await response.json();
          return {
            id: userData.name,
            displayName: userData.display_name || userData.name,
            avatarUrl: userData.avatar_url,
            email: userData.email,
            isAdmin: userData.admin
          };
        }
      } catch (error) {
        console.warn(`Failed to fetch user information from JupyterHub: ${error.message}`);
      }
    }
    
    // If we couldn't get the user information, create a minimal user object
    return {
      id: userId,
      displayName: userId
    };
  }

  /**
   * Emit a permission change event
   *
   * @param event - The permission change event to emit
   */
  private _emitPermissionChangeEvent(event: IPermissionChangeEvent): void {
    this._permissionsChanged.emit(event);
  }

  /**
   * Set the permissions manager status and emit a status change event
   *
   * @param status - The new status
   */
  private _setStatus(status: PermissionManagerStatus): void {
    if (this._status !== status) {
      this._status = status;
      this._statusChanged.emit(status);
    }
  }

  private _ydoc: Y.Doc;
  private _yPermissions: Y.Map<Y.Map<any>>;
  private _currentUser: IPermissionUser;
  private _notebookId: string;
  private _enableCellPermissions: boolean;
  private _defaultRole: PermissionRole;
  private _hubApiUrl?: string;
  private _autoAssignOwner: boolean;
  private _status: PermissionManagerStatus = PermissionManagerStatus.Initializing;
  private _isDisposed = false;

  private _statusChanged: Signal<IPermissionsManager, PermissionManagerStatus>;
  private _permissionsChanged: Signal<IPermissionsManager, IPermissionChangeEvent>;
}

/**
 * Create a permissions manager for a notebook
 *
 * @param options - The permissions manager configuration options
 * @returns A new permissions manager instance
 */
export function createPermissionsManager(options: IPermissionsManagerOptions): IPermissionsManager {
  return new PermissionsManager(options);
}