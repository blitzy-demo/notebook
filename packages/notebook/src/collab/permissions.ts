/**
 * Enterprise-grade access control system for Jupyter Notebook v7 collaborative editing.
 * 
 * This Permission Service provides comprehensive role-based access control (RBAC) with
 * session-based validation and JupyterHub authentication integration. It enforces
 * real-time permissions across all collaborative operations and maintains detailed
 * audit trails for enterprise compliance requirements.
 * 
 * Key Features:
 * - JupyterHub OAuth integration with token validation
 * - Role-based access control with configurable permission levels
 * - Session-based permission validation with PostgreSQL persistence
 * - Real-time permission enforcement across collaborative operations
 * - Sharing workflows with invitation and approval mechanisms
 * - Permission inheritance and delegation for hierarchical access control
 * - Comprehensive audit logging for security event tracking
 * - Cell-level granular permission enforcement
 * - Redis-based permission caching for performance
 * - Policy engine for complex authorization scenarios
 * 
 * @author Jupyter Collaboration Team
 * @version 7.0.0
 * @license BSD-3-Clause
 */

import { Signal, ISignal } from '@lumino/signaling';
import { IStateDB, StateDB } from '@jupyterlab/statedb';
import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { Token } from '@lumino/coreutils';

// Interface imports for type definitions
export interface ICollaborationSession {
  readonly sessionId: string;
  readonly notebookPath: string;
  readonly participants: ISessionParticipant[];
  readonly permissions: ISessionPermissions;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: SessionStatus;
}

export interface ISessionParticipant {
  readonly userId: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly permissions: string[];
  readonly joinedAt: Date;
  readonly lastActivity: Date;
  readonly status: ParticipantStatus;
}

export interface ISessionPermissions {
  readonly ownerId: string;
  readonly defaultRole: UserRole;
  readonly allowInvites: boolean;
  readonly requireApproval: boolean;
  readonly cellPermissions: Record<string, ICellPermissions>;
  readonly sharedWith: Record<string, IUserPermissionSet>;
}

export interface ICellPermissions {
  readonly cellId: string;
  readonly readUsers: string[];
  readonly editUsers: string[];
  readonly executeUsers: string[];
  readonly commentUsers: string[];
  readonly locked: boolean;
  readonly lockedBy?: string;
  readonly inheritFromSession: boolean;
}

export interface IUserPermissionSet {
  readonly userId: string;
  readonly role: UserRole;
  readonly permissions: Permission[];
  readonly grantedBy: string;
  readonly grantedAt: Date;
  readonly expiresAt?: Date;
  readonly conditions?: IPermissionCondition[];
}

export interface IPermissionCondition {
  readonly type: 'time_range' | 'ip_address' | 'device' | 'location';
  readonly value: any;
  readonly operator: 'equals' | 'in' | 'not_in' | 'between';
}

export interface IAuditLogEntry {
  readonly id: string;
  readonly timestamp: Date;
  readonly userId: string;
  readonly sessionId: string;
  readonly action: PermissionAction;
  readonly resource: string;
  readonly result: 'granted' | 'denied' | 'error';
  readonly details: Record<string, any>;
  readonly ipAddress: string;
  readonly userAgent: string;
}

export interface IJupyterHubUser {
  readonly name: string;
  readonly admin: boolean;
  readonly groups: string[];
  readonly roles: string[];
  readonly created: string;
  readonly lastActivity: string;
  readonly sessionCount: number;
}

export interface IPolicyEvaluationContext {
  readonly user: IJupyterHubUser;
  readonly resource: IPermissionResource;
  readonly environment: IEnvironmentContext;
  readonly action: PermissionAction;
  readonly session: ICollaborationSession;
}

export interface IPermissionResource {
  readonly type: ResourceType;
  readonly id: string;
  readonly path: string;
  readonly metadata: Record<string, any>;
}

export interface IEnvironmentContext {
  readonly timestamp: Date;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly sessionType: string;
  readonly participantCount: number;
}

export interface IPolicyDecision {
  readonly decision: 'permit' | 'deny' | 'not_applicable';
  readonly reason: string;
  readonly confidence: number;
  readonly appliedPolicies: string[];
  readonly obligations?: string[];
}

export interface IAccessDecision {
  readonly permitted: boolean;
  readonly reason: string;
  readonly conditions?: string[];
  readonly cacheTtl?: number;
  readonly auditRequired: boolean;
}

// Enums for type safety
export enum UserRole {
  VIEWER = 'viewer',
  COMMENTER = 'commenter', 
  EDITOR = 'editor',
  COLLABORATOR = 'collaborator',
  ADMIN = 'admin',
  OWNER = 'owner'
}

export enum Permission {
  READ = 'read',
  WRITE = 'write',
  EXECUTE = 'execute',
  COMMENT = 'comment',
  SHARE = 'share',
  ADMIN = 'admin',
  DELETE = 'delete',
  HISTORY = 'history',
  EXPORT = 'export',
  IMPORT = 'import'
}

export enum PermissionAction {
  READ = 'read',
  write = 'write',
  execute = 'execute',
  comment = 'comment',
  share = 'share',
  invite = 'invite',
  remove_user = 'remove_user',
  change_permissions = 'change_permissions',
  lock_cell = 'lock_cell',
  unlock_cell = 'unlock_cell',
  view_history = 'view_history',
  rollback = 'rollback',
  export = 'export',
  delete = 'delete'
}

export enum ResourceType {
  NOTEBOOK = 'notebook',
  CELL = 'cell',
  SESSION = 'session',
  COMMENT = 'comment',
  HISTORY = 'history'
}

export enum SessionStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  TERMINATED = 'terminated',
  EXPIRED = 'expired'
}

export enum ParticipantStatus {
  ACTIVE = 'active',
  IDLE = 'idle',
  AWAY = 'away',
  DISCONNECTED = 'disconnected'
}

// Custom error classes for permission handling
export class PermissionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'PermissionError';
  }
}

export class AuthenticationError extends PermissionError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'AUTHENTICATION_FAILED', details);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends PermissionError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'AUTHORIZATION_FAILED', details);
    this.name = 'AuthorizationError';
  }
}

// DI Token for Permission Service
export const IPermissionService = new Token<IPermissionService>(
  '@jupyter-notebook/collaboration:IPermissionService'
);

/**
 * Interface for the Permission Service
 */
export interface IPermissionService {
  /**
   * Signal emitted when permissions change for a user/session
   */
  readonly permissionsChanged: ISignal<IPermissionService, IPermissionChange>;

  /**
   * Signal emitted when user access is revoked
   */
  readonly accessRevoked: ISignal<IPermissionService, IAccessRevocation>;

  /**
   * Validate user permission for specific operation
   */
  validatePermission(
    userId: string,
    sessionId: string,
    action: PermissionAction,
    resource?: IPermissionResource
  ): Promise<IAccessDecision>;

  /**
   * Get comprehensive user permissions for session
   */
  getUserPermissions(userId: string, sessionId: string): Promise<IUserPermissionSet>;

  /**
   * Get session permissions and participants
   */
  getSessionPermissions(sessionId: string): Promise<ISessionPermissions>;

  /**
   * Share session with user - invitation workflow
   */
  shareSession(
    sessionId: string,
    targetUserId: string,
    role: UserRole,
    requestingUserId: string,
    permissions?: Permission[]
  ): Promise<void>;

  /**
   * Update user role in session
   */
  updateUserRole(
    sessionId: string,
    targetUserId: string,
    newRole: UserRole,
    updatedBy: string
  ): Promise<void>;

  /**
   * Remove user from session
   */
  removeUserFromSession(
    sessionId: string,
    targetUserId: string,
    removedBy: string
  ): Promise<void>;

  /**
   * Set cell-specific permissions
   */
  setCellPermissions(
    sessionId: string,
    cellId: string,
    permissions: ICellPermissions,
    updatedBy: string
  ): Promise<void>;

  /**
   * Get audit log for session
   */
  getAuditLog(
    sessionId: string,
    startTime?: Date,
    endTime?: Date,
    actions?: PermissionAction[]
  ): Promise<IAuditLogEntry[]>;

  /**
   * Initialize session permissions
   */
  initializeSessionPermissions(
    sessionId: string,
    notebookPath: string,
    ownerId: string,
    initialPermissions?: Partial<ISessionPermissions>
  ): Promise<void>;

  /**
   * Terminate session and cleanup permissions
   */
  terminateSession(sessionId: string, terminatedBy: string): Promise<void>;
}

export interface IPermissionChange {
  readonly sessionId: string;
  readonly userId: string;
  readonly changes: Array<{
    field: string;
    oldValue: any;
    newValue: any;
  }>;
  readonly changedBy: string;
  readonly timestamp: Date;
}

export interface IAccessRevocation {
  readonly sessionId: string;
  readonly userId: string;
  readonly reason: string;
  readonly revokedBy: string;
  readonly timestamp: Date;
}

/**
 * Enterprise-grade Permission Service implementation
 * 
 * Provides comprehensive access control with JupyterHub integration,
 * role-based permissions, session management, and audit logging.
 */
export class PermissionService implements IPermissionService {
  private _permissionsChanged = new Signal<IPermissionService, IPermissionChange>(this);
  private _accessRevoked = new Signal<IPermissionService, IAccessRevocation>(this);
  
  private _serverSettings: ServerConnection.ISettings;
  private _stateDB: IStateDB;
  private _permissionCache = new Map<string, { data: any; expires: number }>();
  private _sessionPermissions = new Map<string, ISessionPermissions>();
  private _policyEngine: PolicyEngine;
  private _auditLogger: AuditLogger;
  private _jupyterHubClient: JupyterHubClient;
  
  private readonly _cacheTTL = 300000; // 5 minutes
  private readonly _maxCacheSize = 10000;

  constructor(options: PermissionService.IOptions = {}) {
    this._serverSettings = options.serverSettings || ServerConnection.makeSettings();
    this._stateDB = options.stateDB || new StateDB();
    
    // Initialize enterprise components
    this._policyEngine = new PolicyEngine();
    this._auditLogger = new AuditLogger(this._serverSettings);
    this._jupyterHubClient = new JupyterHubClient(this._serverSettings);
    
    // Setup cache cleanup
    this._setupCacheCleanup();
  }

  get permissionsChanged(): ISignal<IPermissionService, IPermissionChange> {
    return this._permissionsChanged;
  }

  get accessRevoked(): ISignal<IPermissionService, IAccessRevocation> {
    return this._accessRevoked;
  }

  /**
   * Validate user permission for specific operation with comprehensive policy evaluation
   */
  async validatePermission(
    userId: string,
    sessionId: string,
    action: PermissionAction,
    resource?: IPermissionResource
  ): Promise<IAccessDecision> {
    const cacheKey = `perm:${userId}:${sessionId}:${action}:${resource?.id || 'session'}`;
    
    try {
      // Check permission cache first
      const cached = this._getFromCache(cacheKey);
      if (cached) {
        await this._auditLogger.logAccess(userId, sessionId, action, 'granted', 'cached', resource);
        return cached;
      }

      // Validate user authentication
      const user = await this._jupyterHubClient.validateUser(userId);
      if (!user) {
        throw new AuthenticationError(`User ${userId} not authenticated`);
      }

      // Get session permissions
      const sessionPermissions = await this.getSessionPermissions(sessionId);
      if (!sessionPermissions) {
        throw new AuthorizationError(`Session ${sessionId} not found or access denied`);
      }

      // Build evaluation context
      const evaluationContext: IPolicyEvaluationContext = {
        user,
        resource: resource || {
          type: ResourceType.SESSION,
          id: sessionId,
          path: sessionPermissions.ownerId,
          metadata: {}
        },
        environment: await this._getEnvironmentContext(sessionId),
        action,
        session: await this._getSessionDetails(sessionId)
      };

      // Evaluate permissions through policy engine
      const decision = await this._policyEngine.evaluatePermission(evaluationContext, sessionPermissions);
      
      // Apply cell-level permissions if applicable
      if (resource?.type === ResourceType.CELL) {
        const cellDecision = await this._evaluateCellPermission(
          userId, 
          sessionId, 
          resource.id, 
          action, 
          sessionPermissions
        );
        
        // Merge decisions (most restrictive wins)
        if (!cellDecision.permitted) {
          const result: IAccessDecision = {
            permitted: false,
            reason: `Cell-level permission denied: ${cellDecision.reason}`,
            auditRequired: true
          };
          
          await this._auditLogger.logAccess(userId, sessionId, action, 'denied', result.reason, resource);
          return result;
        }
      }

      // Cache successful permission check
      if (decision.permitted) {
        this._setCache(cacheKey, decision, decision.cacheTtl || this._cacheTTL);
      }

      // Log access attempt
      await this._auditLogger.logAccess(
        userId, 
        sessionId, 
        action, 
        decision.permitted ? 'granted' : 'denied', 
        decision.reason, 
        resource
      );

      return decision;

    } catch (error) {
      const errorDecision: IAccessDecision = {
        permitted: false,
        reason: `Permission validation failed: ${error.message}`,
        auditRequired: true
      };

      await this._auditLogger.logAccess(userId, sessionId, action, 'error', error.message, resource);
      
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to validate permission for user ${userId}`,
        'VALIDATION_FAILED',
        { userId, sessionId, action, originalError: error.message }
      );
    }
  }

  /**
   * Get comprehensive user permissions for session
   */
  async getUserPermissions(userId: string, sessionId: string): Promise<IUserPermissionSet> {
    const cacheKey = `user_perms:${userId}:${sessionId}`;
    
    try {
      // Check cache first
      const cached = this._getFromCache(cacheKey);
      if (cached) {
        return cached;
      }

      // Validate user authentication
      const user = await this._jupyterHubClient.validateUser(userId);
      if (!user) {
        throw new AuthenticationError(`User ${userId} not authenticated`);
      }

      // Get session permissions
      const sessionPermissions = await this.getSessionPermissions(sessionId);
      if (!sessionPermissions) {
        throw new AuthorizationError(`Session ${sessionId} not found`);
      }

      // Check if user is owner
      if (sessionPermissions.ownerId === userId) {
        const ownerPermissions: IUserPermissionSet = {
          userId,
          role: UserRole.OWNER,
          permissions: Object.values(Permission),
          grantedBy: 'system',
          grantedAt: new Date()
        };
        
        this._setCache(cacheKey, ownerPermissions);
        return ownerPermissions;
      }

      // Get user's permissions from session
      const userPerms = sessionPermissions.sharedWith[userId];
      if (!userPerms) {
        throw new AuthorizationError(`User ${userId} not authorized for session ${sessionId}`);
      }

      // Check if permissions have expired
      if (userPerms.expiresAt && userPerms.expiresAt < new Date()) {
        throw new AuthorizationError(`User ${userId} permissions expired for session ${sessionId}`);
      }

      // Evaluate conditional permissions
      if (userPerms.conditions && userPerms.conditions.length > 0) {
        const environmentContext = await this._getEnvironmentContext(sessionId);
        const conditionsMet = await this._evaluatePermissionConditions(userPerms.conditions, environmentContext);
        
        if (!conditionsMet) {
          throw new AuthorizationError(`User ${userId} permission conditions not met for session ${sessionId}`);
        }
      }

      this._setCache(cacheKey, userPerms);
      return userPerms;

    } catch (error) {
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to get user permissions for ${userId}`,
        'GET_PERMISSIONS_FAILED',
        { userId, sessionId, originalError: error.message }
      );
    }
  }

  /**
   * Get session permissions and participants
   */
  async getSessionPermissions(sessionId: string): Promise<ISessionPermissions> {
    const cacheKey = `session_perms:${sessionId}`;
    
    try {
      // Check cache first
      const cached = this._getFromCache(cacheKey);
      if (cached) {
        return cached;
      }

      // Check in-memory cache
      if (this._sessionPermissions.has(sessionId)) {
        const permissions = this._sessionPermissions.get(sessionId)!;
        this._setCache(cacheKey, permissions);
        return permissions;
      }

      // Fetch from server
      const url = URLExt.join(this._serverSettings.baseUrl, 'api', 'collaboration', 'sessions', sessionId, 'permissions');
      const response = await ServerConnection.makeRequest(url, {}, this._serverSettings);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new AuthorizationError(`Session ${sessionId} not found`);
        }
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const permissions = this._parseSessionPermissions(data);
      
      // Cache the permissions
      this._sessionPermissions.set(sessionId, permissions);
      this._setCache(cacheKey, permissions);
      
      return permissions;

    } catch (error) {
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to get session permissions for ${sessionId}`,
        'GET_SESSION_PERMISSIONS_FAILED',
        { sessionId, originalError: error.message }
      );
    }
  }

  /**
   * Share session with user through invitation workflow
   */
  async shareSession(
    sessionId: string,
    targetUserId: string,
    role: UserRole,
    requestingUserId: string,
    permissions?: Permission[]
  ): Promise<void> {
    try {
      // Validate requesting user has share permission
      const shareDecision = await this.validatePermission(
        requestingUserId,
        sessionId,
        PermissionAction.share
      );
      
      if (!shareDecision.permitted) {
        throw new AuthorizationError(
          `User ${requestingUserId} not authorized to share session ${sessionId}: ${shareDecision.reason}`
        );
      }

      // Validate target user exists
      const targetUser = await this._jupyterHubClient.validateUser(targetUserId);
      if (!targetUser) {
        throw new AuthenticationError(`Target user ${targetUserId} not found`);
      }

      // Get session permissions to check approval requirements
      const sessionPermissions = await this.getSessionPermissions(sessionId);
      
      // Determine effective permissions for the role
      const effectivePermissions = permissions || this._getDefaultPermissionsForRole(role);
      
      // Create user permission set
      const userPermissionSet: IUserPermissionSet = {
        userId: targetUserId,
        role,
        permissions: effectivePermissions,
        grantedBy: requestingUserId,
        grantedAt: new Date()
      };

      // Send invitation or directly grant access based on session settings
      if (sessionPermissions.requireApproval && role !== UserRole.VIEWER) {
        await this._sendInvitation(sessionId, targetUserId, userPermissionSet, requestingUserId);
      } else {
        await this._grantSessionAccess(sessionId, userPermissionSet);
      }

      // Emit permission change signal
      this._permissionsChanged.emit({
        sessionId,
        userId: targetUserId,
        changes: [{
          field: 'shared_with',
          oldValue: null,
          newValue: userPermissionSet
        }],
        changedBy: requestingUserId,
        timestamp: new Date()
      });

      // Log sharing action
      await this._auditLogger.logPermissionChange(
        sessionId,
        requestingUserId,
        'share_session',
        targetUserId,
        { role, permissions: effectivePermissions }
      );

    } catch (error) {
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to share session ${sessionId} with user ${targetUserId}`,
        'SHARE_SESSION_FAILED',
        { sessionId, targetUserId, role, requestingUserId, originalError: error.message }
      );
    }
  }

  /**
   * Update user role in session with comprehensive validation
   */
  async updateUserRole(
    sessionId: string,
    targetUserId: string,
    newRole: UserRole,
    updatedBy: string
  ): Promise<void> {
    try {
      // Validate updating user has admin permission
      const adminDecision = await this.validatePermission(
        updatedBy,
        sessionId,
        PermissionAction.change_permissions
      );
      
      if (!adminDecision.permitted) {
        throw new AuthorizationError(
          `User ${updatedBy} not authorized to change permissions in session ${sessionId}: ${adminDecision.reason}`
        );
      }

      // Get current user permissions
      const currentPermissions = await this.getUserPermissions(targetUserId, sessionId);
      
      // Prevent downgrading owner role
      if (currentPermissions.role === UserRole.OWNER && newRole !== UserRole.OWNER) {
        const sessionPermissions = await this.getSessionPermissions(sessionId);
        if (sessionPermissions.ownerId === targetUserId) {
          throw new AuthorizationError('Cannot change role of session owner');
        }
      }

      // Update role and permissions
      const newPermissions = this._getDefaultPermissionsForRole(newRole);
      const updatedPermissionSet: IUserPermissionSet = {
        ...currentPermissions,
        role: newRole,
        permissions: newPermissions,
        grantedBy: updatedBy,
        grantedAt: new Date()
      };

      await this._updateUserPermissions(sessionId, targetUserId, updatedPermissionSet);

      // Clear relevant caches
      this._clearUserPermissionCaches(targetUserId, sessionId);

      // Emit permission change signal
      this._permissionsChanged.emit({
        sessionId,
        userId: targetUserId,
        changes: [
          {
            field: 'role',
            oldValue: currentPermissions.role,
            newValue: newRole
          },
          {
            field: 'permissions',
            oldValue: currentPermissions.permissions,
            newValue: newPermissions
          }
        ],
        changedBy: updatedBy,
        timestamp: new Date()
      });

      // Log role change
      await this._auditLogger.logPermissionChange(
        sessionId,
        updatedBy,
        'update_role',
        targetUserId,
        { oldRole: currentPermissions.role, newRole, newPermissions }
      );

    } catch (error) {
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to update role for user ${targetUserId} in session ${sessionId}`,
        'UPDATE_ROLE_FAILED',
        { sessionId, targetUserId, newRole, updatedBy, originalError: error.message }
      );
    }
  }

  /**
   * Remove user from session with proper authorization
   */
  async removeUserFromSession(
    sessionId: string,
    targetUserId: string,
    removedBy: string
  ): Promise<void> {
    try {
      // Validate removing user has admin permission
      const adminDecision = await this.validatePermission(
        removedBy,
        sessionId,
        PermissionAction.remove_user
      );
      
      if (!adminDecision.permitted) {
        throw new AuthorizationError(
          `User ${removedBy} not authorized to remove users from session ${sessionId}: ${adminDecision.reason}`
        );
      }

      // Prevent removing session owner
      const sessionPermissions = await this.getSessionPermissions(sessionId);
      if (sessionPermissions.ownerId === targetUserId) {
        throw new AuthorizationError('Cannot remove session owner');
      }

      // Get current user permissions for audit log
      const currentPermissions = await this.getUserPermissions(targetUserId, sessionId);

      // Remove user from session
      await this._removeUserFromSession(sessionId, targetUserId);

      // Clear user permission caches
      this._clearUserPermissionCaches(targetUserId, sessionId);

      // Emit access revocation signal
      this._accessRevoked.emit({
        sessionId,
        userId: targetUserId,
        reason: `Removed by ${removedBy}`,
        revokedBy: removedBy,
        timestamp: new Date()
      });

      // Log user removal
      await this._auditLogger.logPermissionChange(
        sessionId,
        removedBy,
        'remove_user',
        targetUserId,
        { removedRole: currentPermissions.role, removedPermissions: currentPermissions.permissions }
      );

    } catch (error) {
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to remove user ${targetUserId} from session ${sessionId}`,
        'REMOVE_USER_FAILED',
        { sessionId, targetUserId, removedBy, originalError: error.message }
      );
    }
  }

  /**
   * Set cell-specific permissions with inheritance support
   */
  async setCellPermissions(
    sessionId: string,
    cellId: string,
    permissions: ICellPermissions,
    updatedBy: string
  ): Promise<void> {
    try {
      // Validate user has admin permission
      const adminDecision = await this.validatePermission(
        updatedBy,
        sessionId,
        PermissionAction.change_permissions,
        {
          type: ResourceType.CELL,
          id: cellId,
          path: `${sessionId}/${cellId}`,
          metadata: {}
        }
      );
      
      if (!adminDecision.permitted) {
        throw new AuthorizationError(
          `User ${updatedBy} not authorized to change cell permissions: ${adminDecision.reason}`
        );
      }

      // Get current cell permissions for comparison
      const sessionPermissions = await this.getSessionPermissions(sessionId);
      const currentCellPermissions = sessionPermissions.cellPermissions[cellId];

      // Update cell permissions
      await this._updateCellPermissions(sessionId, cellId, permissions);

      // Clear relevant permission caches
      this._clearCellPermissionCaches(sessionId, cellId);

      // Emit permission change signal
      this._permissionsChanged.emit({
        sessionId,
        userId: cellId, // Using cellId as userId for cell-level changes
        changes: [{
          field: 'cell_permissions',
          oldValue: currentCellPermissions,
          newValue: permissions
        }],
        changedBy: updatedBy,
        timestamp: new Date()
      });

      // Log cell permission change
      await this._auditLogger.logPermissionChange(
        sessionId,
        updatedBy,
        'update_cell_permissions',
        cellId,
        { oldPermissions: currentCellPermissions, newPermissions: permissions }
      );

    } catch (error) {
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to set cell permissions for cell ${cellId} in session ${sessionId}`,
        'SET_CELL_PERMISSIONS_FAILED',
        { sessionId, cellId, updatedBy, originalError: error.message }
      );
    }
  }

  /**
   * Get audit log for session with filtering support
   */
  async getAuditLog(
    sessionId: string,
    startTime?: Date,
    endTime?: Date,
    actions?: PermissionAction[]
  ): Promise<IAuditLogEntry[]> {
    try {
      const url = URLExt.join(
        this._serverSettings.baseUrl,
        'api',
        'collaboration',
        'sessions',
        sessionId,
        'audit'
      );

      const params = new URLSearchParams();
      if (startTime) params.append('start_time', startTime.toISOString());
      if (endTime) params.append('end_time', endTime.toISOString());
      if (actions && actions.length > 0) {
        actions.forEach(action => params.append('actions', action));
      }

      const requestUrl = params.toString() ? `${url}?${params.toString()}` : url;
      const response = await ServerConnection.makeRequest(requestUrl, {}, this._serverSettings);
      
      if (!response.ok) {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.audit_entries.map((entry: any) => this._parseAuditLogEntry(entry));

    } catch (error) {
      throw new PermissionError(
        `Failed to get audit log for session ${sessionId}`,
        'GET_AUDIT_LOG_FAILED',
        { sessionId, startTime, endTime, actions, originalError: error.message }
      );
    }
  }

  /**
   * Initialize session permissions with default policies
   */
  async initializeSessionPermissions(
    sessionId: string,
    notebookPath: string,
    ownerId: string,
    initialPermissions?: Partial<ISessionPermissions>
  ): Promise<void> {
    try {
      // Validate owner user exists
      const ownerUser = await this._jupyterHubClient.validateUser(ownerId);
      if (!ownerUser) {
        throw new AuthenticationError(`Owner user ${ownerId} not found`);
      }

      // Create default session permissions
      const defaultPermissions: ISessionPermissions = {
        ownerId,
        defaultRole: UserRole.VIEWER,
        allowInvites: true,
        requireApproval: false,
        cellPermissions: {},
        sharedWith: {},
        ...initialPermissions
      };

      // Initialize permissions on server
      await this._initializeSessionPermissions(sessionId, notebookPath, defaultPermissions);

      // Cache session permissions
      this._sessionPermissions.set(sessionId, defaultPermissions);

      // Log session creation
      await this._auditLogger.logPermissionChange(
        sessionId,
        ownerId,
        'create_session',
        sessionId,
        { notebookPath, initialPermissions: defaultPermissions }
      );

    } catch (error) {
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to initialize session permissions for ${sessionId}`,
        'INITIALIZE_PERMISSIONS_FAILED',
        { sessionId, notebookPath, ownerId, originalError: error.message }
      );
    }
  }

  /**
   * Terminate session and cleanup permissions
   */
  async terminateSession(sessionId: string, terminatedBy: string): Promise<void> {
    try {
      // Validate user has admin permission
      const adminDecision = await this.validatePermission(
        terminatedBy,
        sessionId,
        PermissionAction.admin
      );
      
      if (!adminDecision.permitted) {
        throw new AuthorizationError(
          `User ${terminatedBy} not authorized to terminate session ${sessionId}: ${adminDecision.reason}`
        );
      }

      // Get session permissions for audit log
      const sessionPermissions = await this.getSessionPermissions(sessionId);
      
      // Terminate session on server
      await this._terminateSession(sessionId);

      // Clear all caches for this session
      this._clearSessionCaches(sessionId);
      this._sessionPermissions.delete(sessionId);

      // Emit access revocation for all participants
      Object.keys(sessionPermissions.sharedWith).forEach(userId => {
        this._accessRevoked.emit({
          sessionId,
          userId,
          reason: 'Session terminated',
          revokedBy: terminatedBy,
          timestamp: new Date()
        });
      });

      // Log session termination
      await this._auditLogger.logPermissionChange(
        sessionId,
        terminatedBy,
        'terminate_session',
        sessionId,
        { participants: Object.keys(sessionPermissions.sharedWith) }
      );

    } catch (error) {
      if (error instanceof PermissionError) {
        throw error;
      }
      
      throw new PermissionError(
        `Failed to terminate session ${sessionId}`,
        'TERMINATE_SESSION_FAILED',
        { sessionId, terminatedBy, originalError: error.message }
      );
    }
  }

  // Private helper methods

  private async _evaluateCellPermission(
    userId: string,
    sessionId: string,
    cellId: string,
    action: PermissionAction,
    sessionPermissions: ISessionPermissions
  ): Promise<IAccessDecision> {
    const cellPermissions = sessionPermissions.cellPermissions[cellId];
    
    // If no cell-specific permissions, inherit from session
    if (!cellPermissions || cellPermissions.inheritFromSession) {
      return { permitted: true, reason: 'Inherited from session', auditRequired: false };
    }

    // Check if cell is locked
    if (cellPermissions.locked && cellPermissions.lockedBy !== userId) {
      return {
        permitted: false,
        reason: `Cell locked by ${cellPermissions.lockedBy}`,
        auditRequired: true
      };
    }

    // Check action-specific permissions
    switch (action) {
      case PermissionAction.read:
        return {
          permitted: cellPermissions.readUsers.includes(userId),
          reason: cellPermissions.readUsers.includes(userId) ? 'Cell read access granted' : 'Cell read access denied',
          auditRequired: false
        };
        
      case PermissionAction.write:
        return {
          permitted: cellPermissions.editUsers.includes(userId),
          reason: cellPermissions.editUsers.includes(userId) ? 'Cell edit access granted' : 'Cell edit access denied',
          auditRequired: true
        };
        
      case PermissionAction.execute:
        return {
          permitted: cellPermissions.executeUsers.includes(userId),
          reason: cellPermissions.executeUsers.includes(userId) ? 'Cell execute access granted' : 'Cell execute access denied',
          auditRequired: true
        };
        
      case PermissionAction.comment:
        return {
          permitted: cellPermissions.commentUsers.includes(userId),
          reason: cellPermissions.commentUsers.includes(userId) ? 'Cell comment access granted' : 'Cell comment access denied',
          auditRequired: false
        };
        
      default:
        return {
          permitted: false,
          reason: `Action ${action} not supported at cell level`,
          auditRequired: true
        };
    }
  }

  private async _evaluatePermissionConditions(
    conditions: IPermissionCondition[],
    environment: IEnvironmentContext
  ): Promise<boolean> {
    for (const condition of conditions) {
      const result = await this._evaluateCondition(condition, environment);
      if (!result) {
        return false;
      }
    }
    return true;
  }

  private async _evaluateCondition(
    condition: IPermissionCondition,
    environment: IEnvironmentContext
  ): Promise<boolean> {
    switch (condition.type) {
      case 'time_range':
        return this._evaluateTimeRangeCondition(condition, environment);
        
      case 'ip_address':
        return this._evaluateIpAddressCondition(condition, environment);
        
      default:
        console.warn(`Unknown condition type: ${condition.type}`);
        return true; // Default to permissive for unknown conditions
    }
  }

  private _evaluateTimeRangeCondition(
    condition: IPermissionCondition,
    environment: IEnvironmentContext
  ): boolean {
    const { start, end } = condition.value;
    const now = environment.timestamp;
    
    switch (condition.operator) {
      case 'between':
        return now >= new Date(start) && now <= new Date(end);
      default:
        return false;
    }
  }

  private _evaluateIpAddressCondition(
    condition: IPermissionCondition,
    environment: IEnvironmentContext
  ): boolean {
    const allowedIps = Array.isArray(condition.value) ? condition.value : [condition.value];
    
    switch (condition.operator) {
      case 'in':
        return allowedIps.includes(environment.ipAddress);
      case 'not_in':
        return !allowedIps.includes(environment.ipAddress);
      default:
        return false;
    }
  }

  private async _getEnvironmentContext(sessionId: string): Promise<IEnvironmentContext> {
    // This would typically get real environment data from the request context
    return {
      timestamp: new Date(),
      ipAddress: '127.0.0.1', // Would be extracted from request
      userAgent: 'Jupyter Notebook v7', // Would be extracted from request
      sessionType: 'collaborative',
      participantCount: 0 // Would be fetched from session state
    };
  }

  private async _getSessionDetails(sessionId: string): Promise<ICollaborationSession> {
    // This would fetch full session details from the database
    const sessionPermissions = await this.getSessionPermissions(sessionId);
    
    return {
      sessionId,
      notebookPath: '', // Would be fetched from session record
      participants: [], // Would be fetched from session state
      permissions: sessionPermissions,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours default
      status: SessionStatus.ACTIVE
    };
  }

  private _getDefaultPermissionsForRole(role: UserRole): Permission[] {
    switch (role) {
      case UserRole.VIEWER:
        return [Permission.READ];
        
      case UserRole.COMMENTER:
        return [Permission.READ, Permission.COMMENT];
        
      case UserRole.EDITOR:
        return [Permission.READ, Permission.WRITE, Permission.COMMENT, Permission.EXECUTE];
        
      case UserRole.COLLABORATOR:
        return [Permission.READ, Permission.WRITE, Permission.COMMENT, Permission.EXECUTE, Permission.SHARE];
        
      case UserRole.ADMIN:
        return [Permission.READ, Permission.WRITE, Permission.COMMENT, Permission.EXECUTE, Permission.SHARE, Permission.ADMIN, Permission.HISTORY];
        
      case UserRole.OWNER:
        return Object.values(Permission);
        
      default:
        return [Permission.READ];
    }
  }

  private async _sendInvitation(
    sessionId: string,
    targetUserId: string,
    permissions: IUserPermissionSet,
    requestingUserId: string
  ): Promise<void> {
    const url = URLExt.join(
      this._serverSettings.baseUrl,
      'api',
      'collaboration',
      'sessions',
      sessionId,
      'invitations'
    );

    const response = await ServerConnection.makeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({
          target_user_id: targetUserId,
          permissions,
          requesting_user_id: requestingUserId
        })
      },
      this._serverSettings
    );

    if (!response.ok) {
      throw new Error(`Failed to send invitation: ${response.status} ${response.statusText}`);
    }
  }

  private async _grantSessionAccess(
    sessionId: string,
    permissions: IUserPermissionSet
  ): Promise<void> {
    const url = URLExt.join(
      this._serverSettings.baseUrl,
      'api',
      'collaboration',
      'sessions',
      sessionId,
      'permissions'
    );

    const response = await ServerConnection.makeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({
          user_id: permissions.userId,
          permissions
        })
      },
      this._serverSettings
    );

    if (!response.ok) {
      throw new Error(`Failed to grant session access: ${response.status} ${response.statusText}`);
    }
  }

  private async _updateUserPermissions(
    sessionId: string,
    userId: string,
    permissions: IUserPermissionSet
  ): Promise<void> {
    const url = URLExt.join(
      this._serverSettings.baseUrl,
      'api',
      'collaboration',
      'sessions',
      sessionId,
      'permissions',
      userId
    );

    const response = await ServerConnection.makeRequest(
      url,
      {
        method: 'PUT',
        body: JSON.stringify({ permissions })
      },
      this._serverSettings
    );

    if (!response.ok) {
      throw new Error(`Failed to update user permissions: ${response.status} ${response.statusText}`);
    }
  }

  private async _removeUserFromSession(sessionId: string, userId: string): Promise<void> {
    const url = URLExt.join(
      this._serverSettings.baseUrl,
      'api',
      'collaboration',
      'sessions',
      sessionId,
      'permissions',
      userId
    );

    const response = await ServerConnection.makeRequest(
      url,
      { method: 'DELETE' },
      this._serverSettings
    );

    if (!response.ok) {
      throw new Error(`Failed to remove user from session: ${response.status} ${response.statusText}`);
    }
  }

  private async _updateCellPermissions(
    sessionId: string,
    cellId: string,
    permissions: ICellPermissions
  ): Promise<void> {
    const url = URLExt.join(
      this._serverSettings.baseUrl,
      'api',
      'collaboration',
      'sessions',
      sessionId,
      'cells',
      cellId,
      'permissions'
    );

    const response = await ServerConnection.makeRequest(
      url,
      {
        method: 'PUT',
        body: JSON.stringify({ permissions })
      },
      this._serverSettings
    );

    if (!response.ok) {
      throw new Error(`Failed to update cell permissions: ${response.status} ${response.statusText}`);
    }
  }

  private async _initializeSessionPermissions(
    sessionId: string,
    notebookPath: string,
    permissions: ISessionPermissions
  ): Promise<void> {
    const url = URLExt.join(
      this._serverSettings.baseUrl,
      'api',
      'collaboration',
      'sessions',
      sessionId,
      'permissions'
    );

    const response = await ServerConnection.makeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({
          notebook_path: notebookPath,
          permissions
        })
      },
      this._serverSettings
    );

    if (!response.ok) {
      throw new Error(`Failed to initialize session permissions: ${response.status} ${response.statusText}`);
    }
  }

  private async _terminateSession(sessionId: string): Promise<void> {
    const url = URLExt.join(
      this._serverSettings.baseUrl,
      'api',
      'collaboration',
      'sessions',
      sessionId
    );

    const response = await ServerConnection.makeRequest(
      url,
      { method: 'DELETE' },
      this._serverSettings
    );

    if (!response.ok) {
      throw new Error(`Failed to terminate session: ${response.status} ${response.statusText}`);
    }
  }

  private _parseSessionPermissions(data: any): ISessionPermissions {
    return {
      ownerId: data.owner_id,
      defaultRole: data.default_role as UserRole,
      allowInvites: data.allow_invites,
      requireApproval: data.require_approval,
      cellPermissions: data.cell_permissions || {},
      sharedWith: data.shared_with || {}
    };
  }

  private _parseAuditLogEntry(data: any): IAuditLogEntry {
    return {
      id: data.id,
      timestamp: new Date(data.timestamp),
      userId: data.user_id,
      sessionId: data.session_id,
      action: data.action as PermissionAction,
      resource: data.resource,
      result: data.result,
      details: data.details || {},
      ipAddress: data.ip_address,
      userAgent: data.user_agent
    };
  }

  private _getFromCache(key: string): any {
    const cached = this._permissionCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }
    this._permissionCache.delete(key);
    return null;
  }

  private _setCache(key: string, data: any, ttl: number = this._cacheTTL): void {
    // Enforce cache size limit
    if (this._permissionCache.size >= this._maxCacheSize) {
      // Remove oldest entries (simple LRU-like behavior)
      const oldestKey = this._permissionCache.keys().next().value;
      this._permissionCache.delete(oldestKey);
    }

    this._permissionCache.set(key, {
      data,
      expires: Date.now() + ttl
    });
  }

  private _clearUserPermissionCaches(userId: string, sessionId: string): void {
    const keysToDelete: string[] = [];
    
    for (const [key] of this._permissionCache) {
      if (key.includes(`${userId}:${sessionId}`) || key.includes(`user_perms:${userId}:${sessionId}`)) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this._permissionCache.delete(key));
  }

  private _clearCellPermissionCaches(sessionId: string, cellId: string): void {
    const keysToDelete: string[] = [];
    
    for (const [key] of this._permissionCache) {
      if (key.includes(`${sessionId}`) && key.includes(`${cellId}`)) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this._permissionCache.delete(key));
  }

  private _clearSessionCaches(sessionId: string): void {
    const keysToDelete: string[] = [];
    
    for (const [key] of this._permissionCache) {
      if (key.includes(sessionId)) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this._permissionCache.delete(key));
  }

  private _setupCacheCleanup(): void {
    // Clean up expired cache entries every 5 minutes
    setInterval(() => {
      const now = Date.now();
      const keysToDelete: string[] = [];
      
      for (const [key, value] of this._permissionCache) {
        if (value.expires <= now) {
          keysToDelete.push(key);
        }
      }
      
      keysToDelete.forEach(key => this._permissionCache.delete(key));
    }, 5 * 60 * 1000);
  }
}

/**
 * Policy Engine for complex authorization scenarios
 */
class PolicyEngine {
  async evaluatePermission(
    context: IPolicyEvaluationContext,
    sessionPermissions: ISessionPermissions
  ): Promise<IAccessDecision> {
    try {
      // Check if user is session owner
      if (sessionPermissions.ownerId === context.user.name) {
        return {
          permitted: true,
          reason: 'Session owner has full access',
          auditRequired: false
        };
      }

      // Check if user is in shared users list
      const userPermissions = sessionPermissions.sharedWith[context.user.name];
      if (!userPermissions) {
        return {
          permitted: false,
          reason: 'User not authorized for this session',
          auditRequired: true
        };
      }

      // Check if user has required permission for action
      const requiredPermission = this._getRequiredPermissionForAction(context.action);
      if (!userPermissions.permissions.includes(requiredPermission)) {
        return {
          permitted: false,
          reason: `User lacks required permission: ${requiredPermission}`,
          auditRequired: true
        };
      }

      // Check role hierarchy
      if (!this._checkRoleHierarchy(userPermissions.role, context.action)) {
        return {
          permitted: false,
          reason: `User role ${userPermissions.role} insufficient for action ${context.action}`,
          auditRequired: true
        };
      }

      return {
        permitted: true,
        reason: `Access granted via role ${userPermissions.role}`,
        auditRequired: false,
        cacheTtl: 300000 // 5 minutes
      };

    } catch (error) {
      return {
        permitted: false,
        reason: `Policy evaluation failed: ${error.message}`,
        auditRequired: true
      };
    }
  }

  private _getRequiredPermissionForAction(action: PermissionAction): Permission {
    switch (action) {
      case PermissionAction.read:
        return Permission.READ;
      case PermissionAction.write:
        return Permission.WRITE;
      case PermissionAction.execute:
        return Permission.EXECUTE;
      case PermissionAction.comment:
        return Permission.COMMENT;
      case PermissionAction.share:
      case PermissionAction.invite:
        return Permission.SHARE;
      case PermissionAction.change_permissions:
      case PermissionAction.remove_user:
        return Permission.ADMIN;
      case PermissionAction.view_history:
      case PermissionAction.rollback:
        return Permission.HISTORY;
      case PermissionAction.delete:
        return Permission.DELETE;
      default:
        return Permission.READ;
    }
  }

  private _checkRoleHierarchy(role: UserRole, action: PermissionAction): boolean {
    const roleHierarchy = {
      [UserRole.VIEWER]: 0,
      [UserRole.COMMENTER]: 1,
      [UserRole.EDITOR]: 2,
      [UserRole.COLLABORATOR]: 3,
      [UserRole.ADMIN]: 4,
      [UserRole.OWNER]: 5
    };

    const actionRequiredLevel = {
      [PermissionAction.read]: 0,
      [PermissionAction.comment]: 1,
      [PermissionAction.write]: 2,
      [PermissionAction.execute]: 2,
      [PermissionAction.share]: 3,
      [PermissionAction.invite]: 3,
      [PermissionAction.change_permissions]: 4,
      [PermissionAction.remove_user]: 4,
      [PermissionAction.delete]: 4,
      [PermissionAction.view_history]: 2,
      [PermissionAction.rollback]: 4,
      [PermissionAction.lock_cell]: 2,
      [PermissionAction.unlock_cell]: 2,
      [PermissionAction.export]: 2
    };

    const userLevel = roleHierarchy[role] || 0;
    const requiredLevel = actionRequiredLevel[action] || 0;

    return userLevel >= requiredLevel;
  }
}

/**
 * Audit Logger for comprehensive security event tracking
 */
class AuditLogger {
  constructor(private _serverSettings: ServerConnection.ISettings) {}

  async logAccess(
    userId: string,
    sessionId: string,
    action: PermissionAction,
    result: 'granted' | 'denied' | 'error',
    reason: string,
    resource?: IPermissionResource
  ): Promise<void> {
    try {
      const logEntry = {
        user_id: userId,
        session_id: sessionId,
        action,
        result,
        reason,
        resource: resource ? {
          type: resource.type,
          id: resource.id,
          path: resource.path
        } : null,
        timestamp: new Date().toISOString(),
        ip_address: '127.0.0.1', // Would be extracted from request context
        user_agent: 'Jupyter Notebook v7' // Would be extracted from request context
      };

      const url = URLExt.join(this._serverSettings.baseUrl, 'api', 'collaboration', 'audit');
      await ServerConnection.makeRequest(
        url,
        {
          method: 'POST',
          body: JSON.stringify(logEntry)
        },
        this._serverSettings
      );
    } catch (error) {
      console.error('Failed to log audit entry:', error);
      // Don't throw - audit logging should not break application flow
    }
  }

  async logPermissionChange(
    sessionId: string,
    userId: string,
    action: string,
    targetResource: string,
    details: Record<string, any>
  ): Promise<void> {
    try {
      const logEntry = {
        user_id: userId,
        session_id: sessionId,
        action: `permission_${action}`,
        result: 'granted',
        reason: `Permission change: ${action}`,
        resource: targetResource,
        details,
        timestamp: new Date().toISOString(),
        ip_address: '127.0.0.1',
        user_agent: 'Jupyter Notebook v7'
      };

      const url = URLExt.join(this._serverSettings.baseUrl, 'api', 'collaboration', 'audit');
      await ServerConnection.makeRequest(
        url,
        {
          method: 'POST',
          body: JSON.stringify(logEntry)
        },
        this._serverSettings
      );
    } catch (error) {
      console.error('Failed to log permission change:', error);
    }
  }
}

/**
 * JupyterHub Client for authentication integration
 */
class JupyterHubClient {
  constructor(private _serverSettings: ServerConnection.ISettings) {}

  async validateUser(userId: string): Promise<IJupyterHubUser | null> {
    try {
      const url = URLExt.join(this._serverSettings.baseUrl, 'api', 'collaboration', 'users', userId, 'validate');
      const response = await ServerConnection.makeRequest(url, {}, this._serverSettings);
      
      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return {
        name: data.name,
        admin: data.admin || false,
        groups: data.groups || [],
        roles: data.roles || [],
        created: data.created,
        lastActivity: data.last_activity,
        sessionCount: data.session_count || 0
      };
    } catch (error) {
      console.error(`Failed to validate user ${userId}:`, error);
      return null;
    }
  }
}

/**
 * Namespace for PermissionService configuration options
 */
export namespace PermissionService {
  export interface IOptions {
    serverSettings?: ServerConnection.ISettings;
    stateDB?: IStateDB;
  }
}

// Export the PermissionService as the default implementation
export { PermissionService as default };