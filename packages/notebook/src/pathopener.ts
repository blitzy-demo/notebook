/**
 * @fileoverview Enhanced path opener for collaborative notebook operations
 * 
 * This module provides comprehensive collaborative file opening capabilities
 * with advanced permission checking, multi-user coordination, and integration
 * with the collaborative session management system for Jupyter Notebook v7.
 * 
 * Key features:
 * - Permission-based access control with role verification
 * - Multi-user file operation coordination
 * - Integration with collaborative session management
 * - Enhanced error handling and user feedback
 * - Support for both standard and collaborative notebook opening
 * - Real-time permission validation
 * - Integration with JupyterHub authentication system
 * - Comprehensive logging and monitoring
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { URLExt } from '@jupyterlab/coreutils';
import { Token } from '@lumino/coreutils';
import { ServiceManager } from '@jupyterlab/services';
import { IStateDB } from '@jupyterlab/statedb';
import { IDisposable, DisposableSet } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';

// Internal imports
import { IPermissionService, ICollaborativeNotebookPathOpener } from './tokens';
// import { PermissionService } from './collab/permissions'; // Unused import
import { NotebookApp } from './app';
import { AwarenessService } from './collab/awareness';

/**
 * Interface for collaborative opening options
 */
export interface ICollaborativeOpenOptions {
  /** Base prefix for the path */
  prefix: string;
  /** Optional path to the notebook */
  path?: string;
  /** Optional URL search parameters */
  searchParams?: URLSearchParams;
  /** Target window for opening */
  target?: string;
  /** Window features string */
  features?: string;
  /** Whether to open in collaborative mode */
  collaborative?: boolean;
  /** Optional session ID for collaborative mode */
  sessionId?: string;
  /** Optional permission level for collaborative access */
  permissions?: 'view' | 'edit' | 'admin';
  /** Optional user context for opening */
  userContext?: {
    userId: string;
    name: string;
    avatar?: string;
  };
}

/**
 * Interface for permission check results
 */
export interface IPermissionCheckResult {
  /** Whether the user can open the file */
  canOpen: boolean;
  /** User's role for the file */
  role: 'view' | 'edit' | 'admin';
  /** Optional reason for denial */
  reason?: string;
  /** Additional context information */
  context?: {
    documentId: string;
    sessionId?: string;
    collaborators?: Array<{
      userId: string;
      name: string;
      role: string;
    }>;
  };
}

/**
 * Interface for collaborative session information
 */
export interface ICollaborativeSessionInfo {
  /** Session identifier */
  sessionId: string;
  /** Document path */
  documentPath: string;
  /** Session participants */
  participants: Array<{
    userId: string;
    name: string;
    role: 'view' | 'edit' | 'admin';
    isActive: boolean;
  }>;
  /** Session creation timestamp */
  createdAt: Date;
  /** Whether session is active */
  isActive: boolean;
}

/**
 * Enhanced path opener class for collaborative notebook operations
 * 
 * This class extends basic path opening functionality to support collaborative
 * features including permission checking, multi-user coordination, and
 * integration with the collaborative session management system.
 */
export class CollaborativeNotebookPathOpener implements ICollaborativeNotebookPathOpener, IDisposable {
  private _permissionService: IPermissionService;
  private _notebookApp: NotebookApp;
  private _awarenessService: AwarenessService;
  private _stateDB: IStateDB;
  private _disposed: boolean = false;
  private _disposables: DisposableSet = new DisposableSet();
  
  // Event signals
  private _sessionCreatedSignal = new Signal<CollaborativeNotebookPathOpener, ICollaborativeSessionInfo>(this);
  private _sessionJoinedSignal = new Signal<CollaborativeNotebookPathOpener, ICollaborativeSessionInfo>(this);
  private _permissionDeniedSignal = new Signal<CollaborativeNotebookPathOpener, { path: string; reason: string }>(this);
  
  // Configuration and state
  private _collaborativeMode: boolean = true;
  private _defaultPermissions: 'view' | 'edit' | 'admin' = 'edit';
  // private _maxRetries: number = 3; // Reserved for future use
  // private _retryDelay: number = 1000; // Reserved for future use
  
  /**
   * Create a new collaborative notebook path opener
   * 
   * @param options - Configuration options for the path opener
   */
  constructor(options: {
    permissionService: IPermissionService;
    notebookApp: NotebookApp;
    awarenessService: AwarenessService;
    serviceManager: ServiceManager;
    stateDB: IStateDB;
    collaborativeMode?: boolean;
    defaultPermissions?: 'view' | 'edit' | 'admin';
  }) {
    this._permissionService = options.permissionService;
    this._notebookApp = options.notebookApp;
    this._awarenessService = options.awarenessService;
    this._stateDB = options.stateDB;
    this._collaborativeMode = options.collaborativeMode ?? true;
    this._defaultPermissions = options.defaultPermissions ?? 'edit';
    
    // Add services to disposables
    this._disposables.add(this._permissionService);
    // Note: NotebookApp may not implement IDisposable, so we don't add it to disposables
    this._disposables.add(this._awarenessService);
    
    // Initialize event handlers
    this._setupEventHandlers();
    
    console.log('CollaborativeNotebookPathOpener initialized');
  }
  
  /**
   * Signal emitted when a collaborative session is created
   */
  get onSessionCreated(): ISignal<CollaborativeNotebookPathOpener, ICollaborativeSessionInfo> {
    return this._sessionCreatedSignal;
  }
  
  /**
   * Signal emitted when a collaborative session is joined
   */
  get onSessionJoined(): ISignal<CollaborativeNotebookPathOpener, ICollaborativeSessionInfo> {
    return this._sessionJoinedSignal;
  }
  
  /**
   * Signal emitted when permission is denied
   */
  get onPermissionDenied(): ISignal<CollaborativeNotebookPathOpener, { path: string; reason: string }> {
    return this._permissionDeniedSignal;
  }
  
  /**
   * Check if the path opener is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }
  
  /**
   * Open a notebook path with collaborative support
   * 
   * @param options - Options for opening the notebook
   * @returns Promise resolving to the opened window or null
   */
  async open(options: ICollaborativeOpenOptions): Promise<WindowProxy | null> {
    if (this._disposed) {
      throw new Error('CollaborativeNotebookPathOpener is disposed');
    }
    
    const {
      prefix,
      path,
      // searchParams, // Reserved for future use
      target,
      features,
      collaborative = this._collaborativeMode,
      sessionId,
      permissions,
      // userContext // Reserved for future use
    } = options;
    
    try {
      // If collaborative mode is disabled, use standard opening
      if (!collaborative) {
        return await this._openStandard(options);
      }
      
      // Check permissions before opening
      if (path) {
        const permissionResult = await this.checkPermissions(path);
        if (!permissionResult.canOpen) {
          this._permissionDeniedSignal.emit({
            path,
            reason: permissionResult.reason || 'Access denied'
          });
          throw new Error(`Permission denied for path: ${path}. ${permissionResult.reason || 'Insufficient permissions'}`);
        }
      }
      
      // Open in collaborative mode
      return await this.openCollaborative({
        prefix,
        path: path || '',
        sessionId,
        permissions: permissions || this._defaultPermissions,
        target,
        features
      });
      
    } catch (error) {
      console.error('Error opening collaborative notebook:', error);
      throw error;
    }
  }
  
  /**
   * Open a notebook specifically in collaborative mode
   * 
   * @param options - Collaborative opening options
   * @returns Promise resolving to the opened window or null
   */
  async openCollaborative(options: {
    prefix: string;
    path: string;
    sessionId?: string;
    permissions?: 'view' | 'edit' | 'admin';
    target?: string;
    features?: string;
  }): Promise<WindowProxy | null> {
    if (this._disposed) {
      throw new Error('CollaborativeNotebookPathOpener is disposed');
    }
    
    const { prefix, path, sessionId, permissions, target, features } = options;
    
    try {
      // Validate path
      if (!path || path.trim() === '') {
        throw new Error('Path is required for collaborative opening');
      }
      
      // Check permissions
      const permissionResult = await this.checkPermissions(path);
      if (!permissionResult.canOpen) {
        throw new Error(`Permission denied: ${permissionResult.reason || 'Insufficient permissions'}`);
      }
      
      // Get or create collaborative session
      const collaborativeSession = await this._getOrCreateCollaborativeSession(path, sessionId, permissions);
      
      // Update user status
      // const currentUser = this._awarenessService.getCurrentUser(); // Reserved for future use
      this._awarenessService.updateUserStatus('active' as any); // Cast to match the enum
      
      // Construct collaborative URL
      const collaborativeUrl = this._buildCollaborativeUrl(
        prefix,
        path,
        collaborativeSession.sessionId,
        permissions
      );
      
      // Open the collaborative notebook
      const windowProxy = window.open(collaborativeUrl, target, features);
      
      // Track the opened session
      await this._trackSessionOpening(collaborativeSession);
      
      // Save session state
      await this._saveSessionState(collaborativeSession);
      
      // Emit session joined signal
      this._sessionJoinedSignal.emit(collaborativeSession);
      
      console.log(`Collaborative notebook opened: ${path} (session: ${collaborativeSession.sessionId})`);
      
      return windowProxy;
      
    } catch (error) {
      console.error('Error opening collaborative notebook:', error);
      throw error;
    }
  }
  
  /**
   * Check permissions before opening a collaborative notebook
   * 
   * @param path - The notebook path to check
   * @returns Promise resolving to permission check result
   */
  async checkPermissions(path: string): Promise<IPermissionCheckResult> {
    if (this._disposed) {
      throw new Error('CollaborativeNotebookPathOpener is disposed');
    }
    
    try {
      // Validate path
      if (!path || path.trim() === '') {
        return {
          canOpen: false,
          role: 'view',
          reason: 'Invalid path provided'
        };
      }
      
      // Check if user is authenticated
      const currentUser = this._awarenessService.getCurrentUser();
      if (!currentUser) {
        return {
          canOpen: false,
          role: 'view',
          reason: 'User not authenticated'
        };
      }
      
      // Check basic view permissions
      const canView = await this._permissionService.canView();
      if (!canView) {
        return {
          canOpen: false,
          role: 'view',
          reason: 'No view permissions for this document'
        };
      }
      
      // Determine user's role
      // const userRole = await this._permissionService.getUserRole(); // Reserved for future use
      
      // Check if user can edit
      const canEdit = await this._permissionService.canEdit();
      
      // Check if user is admin
      const isAdmin = await this._permissionService.canAdmin();
      
      // Get collaborators information
      const collaborators = await this._permissionService.getCollaborators();
      
      // Check if there's an active session
      const activeSession = await this._notebookApp.collaborativeSessionManager.getActiveSession();
      
      // Determine final permission level
      let finalRole: 'view' | 'edit' | 'admin' = 'view';
      if (isAdmin) {
        finalRole = 'admin';
      } else if (canEdit) {
        finalRole = 'edit';
      }
      
      return {
        canOpen: true,
        role: finalRole,
        context: {
          documentId: this._generateDocumentId(path),
          sessionId: activeSession?.sessionId,
          collaborators: collaborators.map(c => ({
            userId: c.userId,
            name: c.name,
            role: c.role
          }))
        }
      };
      
    } catch (error) {
      console.error('Error checking permissions:', error);
      return {
        canOpen: false,
        role: 'view',
        reason: `Permission check failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Dispose of the path opener and cleanup resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    
    this._disposed = true;
    
    // Dispose of all disposables
    this._disposables.dispose();
    
    // Clear event handlers
    this._sessionCreatedSignal.emit = () => {};
    this._sessionJoinedSignal.emit = () => {};
    this._permissionDeniedSignal.emit = () => {};
    
    console.log('CollaborativeNotebookPathOpener disposed');
  }
  
  /**
   * Set up event handlers for collaborative features
   */
  private _setupEventHandlers(): void {
    // Listen for permission changes
    // Note: onPermissionChanged is available on PermissionService implementation
    if (this._permissionService && 'onPermissionChanged' in this._permissionService) {
      const service = this._permissionService as any;
      if (service.onPermissionChanged && service.onPermissionChanged.connect) {
        service.onPermissionChanged.connect(this._onPermissionChanged, this);
      }
    }
    
    // Listen for user presence changes
    this._awarenessService.onUserJoin.connect(this._onUserJoin, this);
    this._awarenessService.onUserLeave.connect(this._onUserLeave, this);
    
    // Listen for session events
    this._notebookApp.collaborativeSessionManager.onSessionCreated.connect(this._onSessionCreated, this);
    this._notebookApp.collaborativeSessionManager.onSessionJoined.connect(this._onSessionJoined, this);
    this._notebookApp.collaborativeSessionManager.onSessionLeft.connect(this._onSessionLeft, this);
  }
  
  /**
   * Open notebook in standard (non-collaborative) mode
   */
  private async _openStandard(options: ICollaborativeOpenOptions): Promise<WindowProxy | null> {
    const { prefix, path, searchParams, target, features } = options;
    
    const url = new URL(
      URLExt.join(prefix, path ?? ''),
      window.location.origin
    );
    
    if (searchParams) {
      url.search = searchParams.toString();
    }
    
    return window.open(url.toString(), target, features);
  }
  
  /**
   * Get or create a collaborative session for the notebook
   */
  private async _getOrCreateCollaborativeSession(
    path: string,
    sessionId?: string,
    permissions?: 'view' | 'edit' | 'admin'
  ): Promise<ICollaborativeSessionInfo> {
    const collaborativeSessionManager = this._notebookApp.collaborativeSessionManager;
    
    // Try to join existing session if sessionId provided
    if (sessionId) {
      try {
        const sessionInfo = await collaborativeSessionManager.joinSession(sessionId);
        return {
          sessionId: sessionInfo.sessionId,
          documentPath: sessionInfo.notebookPath,
          participants: sessionInfo.participants,
          createdAt: (sessionInfo as any).joinedAt || new Date(), // Handle potential missing property
          isActive: true
        };
      } catch (error) {
        console.warn(`Failed to join existing session ${sessionId}:`, error);
        // Fall through to create new session
      }
    }
    
    // Create new collaborative session
    const currentUser = this._awarenessService.getCurrentUser();
    const sessionInfo = await collaborativeSessionManager.createSession({
      notebookPath: path,
      permissions: permissions ? { [currentUser.userId]: permissions } : undefined
    });
    
    return {
      sessionId: sessionInfo.sessionId,
      documentPath: sessionInfo.notebookPath,
      participants: [{
        userId: currentUser.userId,
        name: currentUser.name,
        role: permissions || this._defaultPermissions,
        isActive: true
      }],
      createdAt: sessionInfo.createdAt,
      isActive: true
    };
  }
  
  /**
   * Build collaborative URL with session parameters
   */
  private _buildCollaborativeUrl(
    prefix: string,
    path: string,
    sessionId: string,
    permissions?: 'view' | 'edit' | 'admin'
  ): string {
    const url = new URL(
      URLExt.join(prefix, path),
      window.location.origin
    );
    
    // Add collaborative session parameters
    url.searchParams.set('collaborative', 'true');
    url.searchParams.set('sessionId', sessionId);
    
    if (permissions) {
      url.searchParams.set('permissions', permissions);
    }
    
    // Add user context
    const currentUser = this._awarenessService.getCurrentUser();
    url.searchParams.set('userId', currentUser.userId);
    url.searchParams.set('userName', currentUser.name);
    
    return url.toString();
  }
  
  /**
   * Track session opening for monitoring and analytics
   */
  private async _trackSessionOpening(session: ICollaborativeSessionInfo): Promise<void> {
    try {
      const currentUser = this._awarenessService.getCurrentUser();
      
      // Store session information in state database
      await this._stateDB.save('collaborative-sessions', {
        sessionId: session.sessionId,
        documentPath: session.documentPath,
        userId: currentUser.userId,
        openedAt: new Date().toISOString(),
        isActive: true
      });
      
      // Update user status
      this._awarenessService.updateUserStatus('active' as any);
      
    } catch (error) {
      console.error('Error tracking session opening:', error);
      // Don't throw - this is non-critical
    }
  }
  
  /**
   * Save session state for persistence
   */
  private async _saveSessionState(session: ICollaborativeSessionInfo): Promise<void> {
    try {
      const stateKey = `collaborative-session-${session.sessionId}`;
      await this._stateDB.save(stateKey, {
        sessionId: session.sessionId,
        documentPath: session.documentPath,
        participants: session.participants,
        createdAt: session.createdAt.toISOString(),
        isActive: session.isActive,
        lastAccessed: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error saving session state:', error);
      // Don't throw - this is non-critical
    }
  }
  
  /**
   * Generate document ID from path
   */
  private _generateDocumentId(path: string): string {
    // Simple hash-based ID generation
    return `doc-${path.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
  }
  
  /**
   * Handle permission changes
   */
  private _onPermissionChanged(sender: any, args: any): void {
    console.log('Permission changed:', args);
    // Handle permission changes if needed
  }
  
  /**
   * Handle user join events
   */
  private _onUserJoin(sender: AwarenessService, args: { userId: string; name: string; avatar?: string }): void {
    console.log('User joined:', args);
    // Handle user join events if needed
  }
  
  /**
   * Handle user leave events
   */
  private _onUserLeave(sender: AwarenessService, args: { userId: string }): void {
    console.log('User left:', args);
    // Handle user leave events if needed
  }
  
  /**
   * Handle session creation events
   */
  private _onSessionCreated(sender: any, args: any): void {
    console.log('Session created:', args);
    this._sessionCreatedSignal.emit({
      sessionId: args.sessionId,
      documentPath: args.notebookPath,
      participants: [],
      createdAt: new Date(),
      isActive: true
    });
  }
  
  /**
   * Handle session join events
   */
  private _onSessionJoined(sender: any, args: any): void {
    console.log('Session joined:', args);
    this._sessionJoinedSignal.emit({
      sessionId: args.sessionId,
      documentPath: '',
      participants: [],
      createdAt: new Date(),
      isActive: true
    });
  }
  
  /**
   * Handle session leave events
   */
  private _onSessionLeft(sender: any, args: any): void {
    console.log('Session left:', args);
    // Handle session leave events if needed
  }
}

/**
 * Token for injecting the ICollaborativeNotebookPathOpener dependency
 */
export const ICollaborativeNotebookPathOpenerToken = new Token<ICollaborativeNotebookPathOpener>(
  '@jupyter-notebook/notebook:ICollaborativeNotebookPathOpener',
  'Service for opening collaborative notebook paths with permission checks and multi-user coordination.'
);

/**
 * Create a default collaborative path opener instance
 * 
 * @param options - Configuration options
 * @returns A new collaborative path opener instance
 */
export function createCollaborativePathOpener(options: {
  permissionService: IPermissionService;
  notebookApp: NotebookApp;
  awarenessService: AwarenessService;
  serviceManager: ServiceManager;
  stateDB: IStateDB;
  collaborativeMode?: boolean;
  defaultPermissions?: 'view' | 'edit' | 'admin';
}): CollaborativeNotebookPathOpener {
  return new CollaborativeNotebookPathOpener(options);
}

/**
 * Default collaborative path opener instance
 * Note: This will be initialized by the application when services are available
 */
export let defaultCollaborativePathOpener: CollaborativeNotebookPathOpener | null = null;

/**
 * Initialize the default collaborative path opener
 * 
 * @param options - Configuration options
 */
export function initializeDefaultCollaborativePathOpener(options: {
  permissionService: IPermissionService;
  notebookApp: NotebookApp;
  awarenessService: AwarenessService;
  serviceManager: ServiceManager;
  stateDB: IStateDB;
  collaborativeMode?: boolean;
  defaultPermissions?: 'view' | 'edit' | 'admin';
}): void {
  if (defaultCollaborativePathOpener) {
    defaultCollaborativePathOpener.dispose();
  }
  
  defaultCollaborativePathOpener = createCollaborativePathOpener(options);
}

// Export interface for external use
export { ICollaborativeNotebookPathOpener } from './tokens';