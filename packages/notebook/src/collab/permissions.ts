/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * PermissionManager class for role-based access control in collaborative Jupyter notebook sessions.
 * Provides comprehensive permission management including JupyterHub authentication integration,
 * real-time permission updates via Yjs CRDT, caching with TTL for performance, and extensive
 * audit logging for compliance requirements.
 */

import * as Y from 'yjs';
import { Signal } from '@lumino/signaling';
import { ServerConnection } from '@jupyterlab/services';

import { YjsNotebookProvider } from './provider';
import { ICollaborativeSession, CollaborativeRole } from '../tokens';

/**
 * Default cache TTL for permission data (5 minutes)
 */
export const DEFAULT_PERMISSION_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Default timeout for JupyterHub API requests (30 seconds)
 */
export const DEFAULT_JUPYTERHUB_API_TIMEOUT_MS = 30 * 1000;

/**
 * Configuration interface for PermissionManager initialization
 */
export interface IPermissionConfig {
  /**
   * JupyterHub API base URL
   */
  jupyterHubApiUrl?: string;

  /**
   * Cache TTL in milliseconds
   */
  cacheTtlMs?: number;

  /**
   * Enable/disable permission caching
   */
  enableCaching?: boolean;

  /**
   * Enable/disable audit logging
   */
  enableAuditLogging?: boolean;

  /**
   * Maximum audit log entries to maintain
   */
  maxAuditEntries?: number;

  /**
   * JupyterHub API request timeout
   */
  apiTimeoutMs?: number;

  /**
   * Default role for new users
   */
  defaultRole?: CollaborativeRole;

  /**
   * Enable single-user mode bypass
   */
  singleUserMode?: boolean;
}

/**
 * Interface representing an audit log entry
 */
export interface IPermissionAuditLog {
  /**
   * Unique identifier for the audit entry
   */
  readonly id: string;

  /**
   * User ID who performed the action
   */
  readonly userId: string;

  /**
   * Permission or role that was modified
   */
  readonly permission: string;

  /**
   * Timestamp when the action occurred
   */
  readonly timestamp: Date;

  /**
   * Type of action performed
   */
  readonly action: 'granted' | 'revoked' | 'updated' | 'checked';

  /**
   * Previous role (if applicable)
   */
  readonly previousRole?: CollaborativeRole;

  /**
   * New role (if applicable)
   */
  readonly newRole?: CollaborativeRole;

  /**
   * Additional context or metadata
   */
  readonly metadata?: Record<string, any>;

  /**
   * Session ID where action occurred
   */
  readonly sessionId?: string;
}

/**
 * Custom error class for permission-related errors
 */
export class PermissionError extends Error {
  /**
   * Error code for categorization
   */
  public readonly code: string;

  /**
   * User ID associated with the error
   */
  public readonly userId: string;

  /**
   * Operation that was attempted
   */
  public readonly operation: string;

  /**
   * Required role for the operation
   */
  public readonly requiredRole: CollaborativeRole;

  /**
   * Current role of the user
   */
  public readonly currentRole: CollaborativeRole;

  /**
   * Error message
   */
  public readonly message: string;

  constructor(
    code: string,
    userId: string,
    operation: string,
    requiredRole: CollaborativeRole,
    currentRole: CollaborativeRole,
    message?: string
  ) {
    const errorMessage = message ||
      `Permission denied: User ${userId} (${currentRole}) cannot perform ${operation} (requires ${requiredRole})`;

    super(errorMessage);
    this.name = 'PermissionError';
    this.code = code;
    this.userId = userId;
    this.operation = operation;
    this.requiredRole = requiredRole;
    this.currentRole = currentRole;
    this.message = errorMessage;
  }
}

/**
 * Permission cache entry
 */
interface IPermissionCacheEntry {
  role: CollaborativeRole;
  timestamp: number;
  expiresAt: number;
}

/**
 * PermissionManager class implementing comprehensive role-based access control
 */
export class PermissionManager {
  private _config: IPermissionConfig;
  private _provider: YjsNotebookProvider;
  private _session: ICollaborativeSession | null = null;

  // Yjs shared data structures for real-time permission sync
  private _permissionsMap: Y.Map<string> | null = null;
  private _rolesMap: Y.Map<string> | null = null;

  // Local caching for performance
  private _permissionCache: Map<string, IPermissionCacheEntry> = new Map();
  private _cacheTimeouts: Map<string, any> = new Map();

  // Audit logging
  private _auditLog: IPermissionAuditLog[] = [];
  private _auditCounter: number = 0;

  // Signals for reactive updates
  private _permissionChangedSignal = new Signal<PermissionManager, { userId: string; newRole: CollaborativeRole; previousRole: CollaborativeRole }>(this);

  // State management
  private _disposed: boolean = false;
  private _collaborationEnabled: boolean = true;

  /**
   * Create a new PermissionManager instance
   */
  constructor(config: IPermissionConfig = {}) {
    this._config = {
      cacheTtlMs: DEFAULT_PERMISSION_CACHE_TTL_MS,
      enableCaching: true,
      enableAuditLogging: true,
      maxAuditEntries: 1000,
      apiTimeoutMs: DEFAULT_JUPYTERHUB_API_TIMEOUT_MS,
      defaultRole: CollaborativeRole.VIEWER,
      singleUserMode: false,
      ...config
    };

    // Initialize provider reference (will be set when connected)
    this._provider = null as any;
  }

  /**
   * Initialize with YjsNotebookProvider for real-time sync
   */
  initialize(provider: YjsNotebookProvider, session?: ICollaborativeSession): void {
    if (this._disposed) {
      throw new Error('PermissionManager has been disposed');
    }

    this._provider = provider;
    this._session = session || null;

    if (this._provider && this._provider.yjsDoc) {
      // Initialize Yjs shared data structures
      this._permissionsMap = this._provider.yjsDoc.getMap('permissions');
      this._rolesMap = this._provider.yjsDoc.getMap('roles');

      // Set up real-time sync listeners
      this._setupYjsEventHandlers();
    }

    console.log('PermissionManager initialized with collaboration provider');
  }

  /**
   * Check if a user has specific permission
   */
  async checkPermission(userId: string, permission: string): Promise<boolean> {
    if (this._disposed) {
      return false;
    }

    // Single-user mode bypass
    if (this._config.singleUserMode) {
      this._logAuditEvent(userId, permission, 'checked', undefined, CollaborativeRole.ADMIN);
      return true;
    }

    try {
      const role = await this.getUserRole(userId);
      const hasPermission = this._evaluatePermission(role, permission);

      this._logAuditEvent(userId, permission, 'checked', undefined, role);
      return hasPermission;
    } catch (error) {
      console.error('Error checking permission:', error);
      this._logAuditEvent(userId, permission, 'checked', undefined, CollaborativeRole.VIEWER);
      return false;
    }
  }

  /**
   * Set permission for a user
   */
  async setPermission(userId: string, permission: string, granted: boolean): Promise<void> {
    if (this._disposed) {
      throw new Error('PermissionManager has been disposed');
    }

    const previousRole = await this.getUserRole(userId).catch(() => this._config.defaultRole!);
    const newRole = this._determineRoleFromPermission(permission, granted);

    try {
      // Update in Yjs for real-time sync
      if (this._rolesMap && this._collaborationEnabled) {
        this._rolesMap.set(userId, newRole);
      }

      // Update local cache
      this._updateCache(userId, newRole);

      // Sync with JupyterHub if available
      if (this._config.jupyterHubApiUrl) {
        await this._syncRoleWithJupyterHub(userId, newRole);
      }

      this._logAuditEvent(userId, permission, granted ? 'granted' : 'revoked', previousRole, newRole);
      this._permissionChangedSignal.emit({ userId, newRole, previousRole });

      console.log(`Permission ${granted ? 'granted' : 'revoked'} for user ${userId}: ${permission}`);
    } catch (error) {
      console.error('Error setting permission:', error);
      throw new PermissionError('SET_PERMISSION_FAILED', userId, 'setPermission', CollaborativeRole.ADMIN, previousRole);
    }
  }

  /**
   * Revoke all permissions for a user
   */
  async revokePermission(userId: string): Promise<void> {
    if (this._disposed) {
      throw new Error('PermissionManager has been disposed');
    }

    const previousRole = await this.getUserRole(userId).catch(() => this._config.defaultRole!);

    try {
      // Remove from Yjs maps
      if (this._rolesMap && this._collaborationEnabled) {
        this._rolesMap.delete(userId);
      }
      if (this._permissionsMap && this._collaborationEnabled) {
        this._permissionsMap.delete(userId);
      }

      // Clear local cache
      this._clearUserCache(userId);

      this._logAuditEvent(userId, 'all', 'revoked', previousRole, CollaborativeRole.VIEWER);
      this._permissionChangedSignal.emit({ userId, newRole: CollaborativeRole.VIEWER, previousRole });

      console.log(`All permissions revoked for user ${userId}`);
    } catch (error) {
      console.error('Error revoking permissions:', error);
      throw new PermissionError('REVOKE_PERMISSION_FAILED', userId, 'revokePermission', CollaborativeRole.ADMIN, previousRole);
    }
  }

  /**
   * Get role for a specific user
   */
  async getUserRole(userId: string): Promise<CollaborativeRole> {
    if (this._disposed) {
      return this._config.defaultRole!;
    }

    // Single-user mode bypass
    if (this._config.singleUserMode) {
      return CollaborativeRole.ADMIN;
    }

    try {
      // Check cache first
      if (this._config.enableCaching) {
        const cached = this._getCachedRole(userId);
        if (cached !== null) {
          return cached;
        }
      }

      // Check Yjs shared state
      let role: CollaborativeRole | null = null;
      if (this._rolesMap && this._collaborationEnabled) {
        const roleStr = this._rolesMap.get(userId);
        if (roleStr && Object.values(CollaborativeRole).includes(roleStr as CollaborativeRole)) {
          role = roleStr as CollaborativeRole;
        }
      }

      // Fall back to JupyterHub API
      if (!role && this._config.jupyterHubApiUrl) {
        role = await this._fetchRoleFromJupyterHub(userId);
      }

      // Use default role if nothing found
      role = role || this._config.defaultRole!;

      // Update cache
      this._updateCache(userId, role);

      return role;
    } catch (error) {
      console.error('Error getting user role:', error);
      return this._config.defaultRole!;
    }
  }

  /**
   * Check if user is in view-only mode
   */
  async isViewOnly(userId: string): Promise<boolean> {
    const role = await this.getUserRole(userId);
    return role === CollaborativeRole.VIEWER;
  }

  /**
   * Check if user can edit the document
   */
  async canEdit(userId: string): Promise<boolean> {
    const role = await this.getUserRole(userId);
    return role === CollaborativeRole.EDITOR || role === CollaborativeRole.ADMIN;
  }

  /**
   * Check if user has admin privileges
   */
  async isAdmin(userId: string): Promise<boolean> {
    const role = await this.getUserRole(userId);
    return role === CollaborativeRole.ADMIN;
  }

  /**
   * Update multiple permissions at once
   */
  async updatePermissions(permissions: Record<string, CollaborativeRole>): Promise<void> {
    if (this._disposed) {
      throw new Error('PermissionManager has been disposed');
    }

    const updates: Array<{ userId: string; newRole: CollaborativeRole; previousRole: CollaborativeRole }> = [];

    try {
      for (const [userId, newRole] of Object.entries(permissions)) {
        const previousRole = await this.getUserRole(userId).catch(() => this._config.defaultRole!);

        // Update in Yjs for real-time sync
        if (this._rolesMap && this._collaborationEnabled) {
          this._rolesMap.set(userId, newRole);
        }

        // Update local cache
        this._updateCache(userId, newRole);

        updates.push({ userId, newRole, previousRole });
        this._logAuditEvent(userId, 'role', 'updated', previousRole, newRole);
      }

      // Sync with JupyterHub if available
      if (this._config.jupyterHubApiUrl) {
        await this._batchSyncWithJupyterHub(permissions);
      }

      // Emit signals for all updates
      updates.forEach(update => {
        this._permissionChangedSignal.emit(update);
      });

      console.log(`Updated permissions for ${updates.length} users`);
    } catch (error) {
      console.error('Error updating permissions:', error);
      throw error;
    }
  }

  /**
   * Get audit log of permission changes
   */
  async auditLog(): Promise<IPermissionAuditLog[]> {
    return [...this._auditLog];
  }

  /**
   * Enable collaboration features
   */
  enableCollaboration(): void {
    if (this._disposed) {
      return;
    }

    this._collaborationEnabled = true;

    if (this._provider) {
      this._provider.enableCollaboration(true);
    }

    console.log('Collaboration enabled in PermissionManager');
  }

  /**
   * Disable collaboration features
   */
  disableCollaboration(): void {
    if (this._disposed) {
      return;
    }

    this._collaborationEnabled = false;

    if (this._provider) {
      this._provider.enableCollaboration(false);
    }

    console.log('Collaboration disabled in PermissionManager');
  }

  /**
   * Get cached permissions for performance
   */
  getCachedPermissions(): Map<string, CollaborativeRole> {
    const result = new Map<string, CollaborativeRole>();

    Array.from(this._permissionCache.entries()).forEach(([userId, entry]) => {
      if (entry.expiresAt > Date.now()) {
        result.set(userId, entry.role);
      }
    });

    return result;
  }

  /**
   * Clear permission cache
   */
  clearPermissionCache(): void {
    // Clear cache entries
    this._permissionCache.clear();

    // Clear timeout handlers
    Array.from(this._cacheTimeouts.values()).forEach(timeout => {
      clearTimeout(timeout);
    });
    this._cacheTimeouts.clear();

    console.log('Permission cache cleared');
  }

  /**
   * Synchronize with JupyterHub for user roles
   */
  async syncWithJupyterHub(): Promise<void> {
    if (this._disposed || !this._config.jupyterHubApiUrl) {
      return;
    }

    try {
      const users = await this._fetchAllUsersFromJupyterHub();

      for (const user of users) {
        const role = await this._fetchRoleFromJupyterHub(user.userId);
        if (role) {
          // Update in Yjs for real-time sync
          if (this._rolesMap && this._collaborationEnabled) {
            this._rolesMap.set(user.userId, role);
          }

          // Update local cache
          this._updateCache(user.userId, role);
        }
      }

      console.log(`Synchronized ${users.length} users with JupyterHub`);
    } catch (error) {
      console.error('Error syncing with JupyterHub:', error);
      throw error;
    }
  }

  /**
   * Signal emitted when permissions change
   */
  get onPermissionChange(): Signal<PermissionManager, { userId: string; newRole: CollaborativeRole; previousRole: CollaborativeRole }> {
    return this._permissionChangedSignal;
  }

  /**
   * Dispose of the permission manager and clean up resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Clear caches and timers
    this.clearPermissionCache();

    // Clear audit log
    this._auditLog.length = 0;

    // Disconnect from provider
    this._provider = null as any;
    this._session = null;
    this._permissionsMap = null;
    this._rolesMap = null;

    console.log('PermissionManager disposed');
  }

  /**
   * Set up Yjs event handlers for real-time synchronization
   */
  private _setupYjsEventHandlers(): void {
    if (!this._rolesMap) {
      return;
    }

    this._rolesMap.observe((event: Y.YMapEvent<string>) => {
      event.changes.keys.forEach((change: { action: 'add' | 'update' | 'delete', oldValue?: string }, userId: string) => {
        if (change.action === 'add' || change.action === 'update') {
          const newRole = this._rolesMap!.get(userId) as CollaborativeRole;
          const previousRole = this._getCachedRole(userId) || this._config.defaultRole!;

          // Update local cache
          this._updateCache(userId, newRole);

          // Emit signal for UI updates
          this._permissionChangedSignal.emit({ userId, newRole, previousRole });

          this._logAuditEvent(userId, 'role', 'updated', previousRole, newRole);
        } else if (change.action === 'delete') {
          const previousRole = this._getCachedRole(userId) || this._config.defaultRole!;

          // Clear from cache
          this._clearUserCache(userId);

          // Emit signal
          this._permissionChangedSignal.emit({
            userId,
            newRole: this._config.defaultRole!,
            previousRole
          });

          this._logAuditEvent(userId, 'role', 'revoked', previousRole, this._config.defaultRole!);
        }
      });
    });
  }

  /**
   * Evaluate if a role has a specific permission
   */
  private _evaluatePermission(role: CollaborativeRole, permission: string): boolean {
    switch (role) {
      case CollaborativeRole.ADMIN:
        return true; // Admin has all permissions

      case CollaborativeRole.EDITOR:
        return ['connect', 'view', 'edit', 'comment', 'save'].includes(permission);

      case CollaborativeRole.VIEWER:
        return ['connect', 'view'].includes(permission);

      default:
        return false;
    }
  }

  /**
   * Determine role from permission string and granted status
   */
  private _determineRoleFromPermission(permission: string, granted: boolean): CollaborativeRole {
    if (!granted) {
      return CollaborativeRole.VIEWER;
    }

    switch (permission) {
      case 'admin':
      case 'manage':
        return CollaborativeRole.ADMIN;

      case 'edit':
      case 'comment':
      case 'save':
        return CollaborativeRole.EDITOR;

      default:
        return CollaborativeRole.VIEWER;
    }
  }

  /**
   * Update permission cache for a user
   */
  private _updateCache(userId: string, role: CollaborativeRole): void {
    if (!this._config.enableCaching) {
      return;
    }

    const now = Date.now();
    const expiresAt = now + this._config.cacheTtlMs!;

    // Clear existing timeout
    const existingTimeout = this._cacheTimeouts.get(userId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set cache entry
    this._permissionCache.set(userId, {
      role,
      timestamp: now,
      expiresAt
    });

    // Set expiration timeout
    const timeout = setTimeout(() => {
      this._permissionCache.delete(userId);
      this._cacheTimeouts.delete(userId);
    }, this._config.cacheTtlMs!);

    this._cacheTimeouts.set(userId, timeout);
  }

  /**
   * Get cached role for user
   */
  private _getCachedRole(userId: string): CollaborativeRole | null {
    if (!this._config.enableCaching) {
      return null;
    }

    const entry = this._permissionCache.get(userId);
    if (!entry || entry.expiresAt < Date.now()) {
      this._permissionCache.delete(userId);
      return null;
    }

    return entry.role;
  }

  /**
   * Clear cache for specific user
   */
  private _clearUserCache(userId: string): void {
    this._permissionCache.delete(userId);

    const timeout = this._cacheTimeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this._cacheTimeouts.delete(userId);
    }
  }

  /**
   * Log audit event for compliance tracking
   */
  private _logAuditEvent(
    userId: string,
    permission: string,
    action: 'granted' | 'revoked' | 'updated' | 'checked',
    previousRole?: CollaborativeRole,
    newRole?: CollaborativeRole
  ): void {
    if (!this._config.enableAuditLogging) {
      return;
    }

    const entry: IPermissionAuditLog = {
      id: `audit_${this._auditCounter++}_${Date.now()}`,
      userId,
      permission,
      timestamp: new Date(),
      action,
      previousRole,
      newRole,
      sessionId: this._session?.sessionId,
      metadata: {
        collaborationEnabled: this._collaborationEnabled,
        singleUserMode: this._config.singleUserMode
      }
    };

    this._auditLog.push(entry);

    // Trim audit log if it exceeds maximum entries
    if (this._auditLog.length > this._config.maxAuditEntries!) {
      this._auditLog.splice(0, this._auditLog.length - this._config.maxAuditEntries!);
    }
  }

  /**
   * Fetch user role from JupyterHub API
   */
  private async _fetchRoleFromJupyterHub(userId: string): Promise<CollaborativeRole | null> {
    if (!this._config.jupyterHubApiUrl) {
      return null;
    }

    try {
      const settings = ServerConnection.makeSettings();
      const url = `${this._config.jupyterHubApiUrl}/users/${userId}`;

      const response = await ServerConnection.makeRequest(
        url,
        { method: 'GET' },
        settings
      );

      if (response.ok) {
        const userData = await response.json();
        return this._mapJupyterHubRoleToCollaborativeRole(userData.role || 'user');
      }
    } catch (error) {
      console.warn(`Failed to fetch role for user ${userId} from JupyterHub:`, error);
    }

    return null;
  }

  /**
   * Fetch all users from JupyterHub
   */
  private async _fetchAllUsersFromJupyterHub(): Promise<Array<{ userId: string; username: string }>> {
    if (!this._config.jupyterHubApiUrl) {
      return [];
    }

    try {
      const settings = ServerConnection.makeSettings();
      const url = `${this._config.jupyterHubApiUrl}/users`;

      const response = await ServerConnection.makeRequest(
        url,
        { method: 'GET' },
        settings
      );

      if (response.ok) {
        const users = await response.json();
        return users.map((user: any) => ({
          userId: user.name,
          username: user.name
        }));
      }
    } catch (error) {
      console.warn('Failed to fetch users from JupyterHub:', error);
    }

    return [];
  }

  /**
   * Sync role with JupyterHub
   */
  private async _syncRoleWithJupyterHub(userId: string, role: CollaborativeRole): Promise<void> {
    if (!this._config.jupyterHubApiUrl) {
      return;
    }

    try {
      const settings = ServerConnection.makeSettings();
      const url = `${this._config.jupyterHubApiUrl}/users/${userId}`;
      const hubRole = this._mapCollaborativeRoleToJupyterHubRole(role);

      await ServerConnection.makeRequest(
        url,
        {
          method: 'PATCH',
          body: JSON.stringify({ role: hubRole })
        },
        settings
      );
    } catch (error) {
      console.warn(`Failed to sync role for user ${userId} with JupyterHub:`, error);
    }
  }

  /**
   * Batch sync multiple roles with JupyterHub
   */
  private async _batchSyncWithJupyterHub(permissions: Record<string, CollaborativeRole>): Promise<void> {
    const syncPromises = Object.entries(permissions).map(([userId, role]) =>
      this._syncRoleWithJupyterHub(userId, role)
    );

    try {
      // Use Promise.all with individual error handling for compatibility with ES2018 target
      await Promise.all(syncPromises.map(promise =>
        promise.catch(error => {
          console.warn('Individual sync error:', error);
          return null; // Continue with other promises
        })
      ));
    } catch (error) {
      console.warn('Error in batch sync with JupyterHub:', error);
    }
  }

  /**
   * Map JupyterHub role to CollaborativeRole
   */
  private _mapJupyterHubRoleToCollaborativeRole(hubRole: string): CollaborativeRole {
    switch (hubRole.toLowerCase()) {
      case 'admin':
      case 'super-admin':
        return CollaborativeRole.ADMIN;
      case 'editor':
      case 'user':
        return CollaborativeRole.EDITOR;
      case 'viewer':
      case 'read-only':
        return CollaborativeRole.VIEWER;
      default:
        return this._config.defaultRole!;
    }
  }

  /**
   * Map CollaborativeRole to JupyterHub role
   */
  private _mapCollaborativeRoleToJupyterHubRole(role: CollaborativeRole): string {
    switch (role) {
      case CollaborativeRole.ADMIN:
        return 'admin';
      case CollaborativeRole.EDITOR:
        return 'user';
      case CollaborativeRole.VIEWER:
        return 'viewer';
      default:
        return 'user';
    }
  }
}
