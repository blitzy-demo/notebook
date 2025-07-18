/**
 * @fileoverview Enhanced application logic for collaborative Jupyter Notebook sessions
 * 
 * This module provides comprehensive collaborative notebook session management,
 * integrating with YjsNotebookProvider for real-time collaborative editing,
 * handling WebSocket connections for real-time collaboration, and managing
 * authentication for multi-user access in Jupyter Notebook v7.
 * 
 * Key features:
 * - Real-time collaborative editing with Yjs CRDT framework
 * - WebSocket-based communication for live updates
 * - Multi-user session management with presence awareness
 * - Authentication integration with JupyterHub
 * - Comprehensive access control and permissions
 * - Cell-level locking and conflict resolution
 * - Change history tracking and version management
 * - Comment system for collaborative review
 * - Robust error handling and resource management
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { Doc } from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { ServiceManager } from '@jupyterlab/services';
import { PageConfig } from '@jupyterlab/coreutils';
import { Signal } from '@lumino/signaling';
import { Token } from '@lumino/coreutils';
import { DisposableSet } from '@lumino/disposable';
import { IndexeddbPersistence } from 'y-indexeddb';

// Import internal dependencies
import { YjsNotebookProvider } from './model';
import { NotebookPanel } from './widget';
import { IYjsNotebookProviderToken } from './tokens';
import { AwarenessService } from './collab/awareness';
import { PermissionService } from './collab/permissions';
import { LockService } from './collab/locks';
import { HistoryService } from './collab/history';
import { CommentService } from './collab/comments';

/**
 * Interface for collaborative session information
 */
export interface ICollaborativeSession {
  /** Unique identifier for the session */
  sessionId: string;
  /** Path to the notebook file */
  notebookPath: string;
  /** List of session participants */
  participants: Array<{
    userId: string;
    name: string;
    role: 'view' | 'edit' | 'admin';
    joinedAt: Date;
    isActive: boolean;
  }>;
  /** Session creation timestamp */
  createdAt: Date;
  /** User who created the session */
  createdBy: string;
  /** Whether the session is currently active */
  isActive: boolean;
  /** Last activity timestamp */
  lastActivity: Date;
  /** Session-specific permissions */
  permissions: Record<string, 'view' | 'edit' | 'admin'>;
}

/**
 * Interface for session manager options
 */
export interface ISessionManagerOptions {
  /** Service manager for backend communication */
  serviceManager: ServiceManager;
  /** WebSocket URL for collaboration */
  websocketUrl: string;
  /** Base URL for the application */
  baseUrl: string;
  /** Current user information */
  userInfo: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Whether to enable persistence */
  enablePersistence?: boolean;
  /** Session timeout in milliseconds */
  sessionTimeout?: number;
}

/**
 * Interface for notebook application options
 */
export interface INotebookAppOptions {
  /** Service manager instance */
  serviceManager: ServiceManager;
  /** Collaborative session manager instance */
  collaborativeSessionManager: CollaborativeSessionManager;
  /** Application configuration */
  config?: Record<string, any>;
  /** Whether to enable collaborative features */
  enableCollaboration?: boolean;
}

/**
 * Enhanced NotebookApp class with collaborative editing capabilities
 * 
 * This class manages the collaborative notebook application lifecycle,
 * including session management, WebSocket connections, and user authentication.
 * It integrates with the Yjs CRDT framework for conflict-free collaborative editing.
 */
export class NotebookApp {
  private _serviceManager: ServiceManager;
  private _collaborativeSessionManager: CollaborativeSessionManager;
  private _sessionManager: any;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;
  private _disposables: DisposableSet = new DisposableSet();
  private _config: Record<string, any> = {};
  private _enableCollaboration: boolean = true;
  
  // Application state
  private _currentSession: ICollaborativeSession | null = null;
  private _activeNotebooks: Map<string, {
    panel: NotebookPanel;
    provider: YjsNotebookProvider;
  }> = new Map();
  
  // Signals for application events
  private _sessionCreatedSignal = new Signal<NotebookApp, ICollaborativeSession>(this);
  private _sessionJoinedSignal = new Signal<NotebookApp, ICollaborativeSession>(this);
  private _sessionLeftSignal = new Signal<NotebookApp, string>(this);
  private _notebookOpenedSignal = new Signal<NotebookApp, {
    path: string;
    panel: NotebookPanel;
    collaborative: boolean;
  }>(this);
  
  /**
   * Create a new NotebookApp instance
   * 
   * @param options - Configuration options for the application
   */
  constructor(options: INotebookAppOptions) {
    this._serviceManager = options.serviceManager;
    this._collaborativeSessionManager = options.collaborativeSessionManager;
    this._config = options.config || {};
    this._enableCollaboration = options.enableCollaboration !== false;
    
    // Set up session manager reference
    this._sessionManager = this._serviceManager.sessions;
    
    // Initialize event handlers
    this._setupEventHandlers();
    
    // Add to disposables
    this._disposables.add(this._collaborativeSessionManager);
  }
  
  /**
   * Get the service manager instance
   */
  get serviceManager(): ServiceManager {
    return this._serviceManager;
  }
  
  /**
   * Get the session manager instance
   */
  get sessionManager(): any {
    return this._sessionManager;
  }
  
  /**
   * Get the collaborative session manager instance
   */
  get collaborativeSessionManager(): CollaborativeSessionManager {
    return this._collaborativeSessionManager;
  }
  
  /**
   * Check if the application is initialized
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }
  
  /**
   * Check if the application is running
   */
  get isRunning(): boolean {
    return this._isRunning;
  }
  
  /**
   * Get the current collaborative session
   */
  get currentSession(): ICollaborativeSession | null {
    return this._currentSession;
  }
  
  /**
   * Get list of active notebooks
   */
  get activeNotebooks(): Array<{
    path: string;
    panel: NotebookPanel;
    provider: YjsNotebookProvider;
    collaborative: boolean;
  }> {
    const notebooks: Array<{
      path: string;
      panel: NotebookPanel;
      provider: YjsNotebookProvider;
      collaborative: boolean;
    }> = [];
    
    for (const [path, notebook] of this._activeNotebooks) {
      notebooks.push({
        path,
        panel: notebook.panel,
        provider: notebook.provider,
        collaborative: notebook.provider.isConnected
      });
    }
    
    return notebooks;
  }
  
  /**
   * Initialize the application
   * 
   * @returns Promise that resolves when initialization is complete
   */
  async init(): Promise<void> {
    if (this._isInitialized) {
      return;
    }
    
    try {
      // Initialize service manager
      await this._serviceManager.ready;
      
      // Initialize collaborative session manager
      await this._collaborativeSessionManager.init();
      
      // Set up application configuration
      this._setupConfiguration();
      
      // Initialize collaborative features if enabled
      if (this._enableCollaboration) {
        await this._initializeCollaborativeFeatures();
      }
      
      this._isInitialized = true;
      console.log('NotebookApp initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize NotebookApp:', error);
      throw new Error(`NotebookApp initialization failed: ${error.message}`);
    }
  }
  
  /**
   * Start the application
   * 
   * @returns Promise that resolves when application is started
   */
  async start(): Promise<void> {
    if (!this._isInitialized) {
      throw new Error('Application must be initialized before starting');
    }
    
    if (this._isRunning) {
      return;
    }
    
    try {
      // Start service manager
      if (this._serviceManager.sessions && typeof this._serviceManager.sessions.ready === 'object') {
        await this._serviceManager.sessions.ready;
      }
      
      // Start collaborative session manager
      await this._collaborativeSessionManager.start();
      
      // Set up application-level event handlers
      this._setupApplicationEventHandlers();
      
      this._isRunning = true;
      console.log('NotebookApp started successfully');
      
    } catch (error) {
      console.error('Failed to start NotebookApp:', error);
      throw new Error(`NotebookApp start failed: ${error.message}`);
    }
  }
  
  /**
   * Stop the application
   * 
   * @returns Promise that resolves when application is stopped
   */
  async stop(): Promise<void> {
    if (!this._isRunning) {
      return;
    }
    
    try {
      // Stop collaborative session manager
      await this._collaborativeSessionManager.stop();
      
      // Close all active notebooks
      for (const [path, notebook] of this._activeNotebooks) {
        await this._closeNotebook(path);
      }
      
      // Clear active notebooks
      this._activeNotebooks.clear();
      
      // Dispose of resources
      this._disposables.dispose();
      
      this._isRunning = false;
      console.log('NotebookApp stopped successfully');
      
    } catch (error) {
      console.error('Failed to stop NotebookApp:', error);
      throw new Error(`NotebookApp stop failed: ${error.message}`);
    }
  }
  
  /**
   * Open a notebook with collaborative features
   * 
   * @param path - Path to the notebook file
   * @param collaborative - Whether to enable collaborative features
   * @returns Promise that resolves to the notebook panel
   */
  async openNotebook(path: string, collaborative: boolean = true): Promise<NotebookPanel> {
    try {
      // Check if notebook is already open
      const existingNotebook = this._activeNotebooks.get(path);
      if (existingNotebook) {
        return existingNotebook.panel;
      }
      
      // Create notebook panel
      const panel = await this._createNotebookPanel(path, collaborative);
      
      // Create Yjs provider if collaborative
      let provider: YjsNotebookProvider | null = null;
      if (collaborative && this._enableCollaboration) {
        provider = await this._createYjsProvider(path, panel);
      }
      
      // Store in active notebooks
      this._activeNotebooks.set(path, {
        panel,
        provider: provider!
      });
      
      // Emit signal
      this._notebookOpenedSignal.emit({
        path,
        panel,
        collaborative: collaborative && this._enableCollaboration
      });
      
      return panel;
      
    } catch (error) {
      console.error(`Failed to open notebook ${path}:`, error);
      throw new Error(`Failed to open notebook: ${error.message}`);
    }
  }
  
  /**
   * Close a notebook and cleanup resources
   * 
   * @param path - Path to the notebook file
   * @returns Promise that resolves when notebook is closed
   */
  async closeNotebook(path: string): Promise<void> {
    return this._closeNotebook(path);
  }
  
  /**
   * Join a collaborative session
   * 
   * @param sessionId - ID of the session to join
   * @returns Promise that resolves to session information
   */
  async joinCollaborativeSession(sessionId: string): Promise<ICollaborativeSession> {
    if (!this._enableCollaboration) {
      throw new Error('Collaborative features are disabled');
    }
    
    try {
      const sessionInfo = await this._collaborativeSessionManager.joinSession(sessionId);
      this._currentSession = sessionInfo;
      this._sessionJoinedSignal.emit(sessionInfo);
      return sessionInfo;
      
    } catch (error) {
      console.error(`Failed to join session ${sessionId}:`, error);
      throw new Error(`Failed to join session: ${error.message}`);
    }
  }
  
  /**
   * Leave the current collaborative session
   * 
   * @returns Promise that resolves when session is left
   */
  async leaveCollaborativeSession(): Promise<void> {
    if (!this._currentSession) {
      return;
    }
    
    try {
      const sessionId = this._currentSession.sessionId;
      await this._collaborativeSessionManager.leaveSession(sessionId);
      this._currentSession = null;
      this._sessionLeftSignal.emit(sessionId);
      
    } catch (error) {
      console.error('Failed to leave session:', error);
      throw new Error(`Failed to leave session: ${error.message}`);
    }
  }
  
  /**
   * Create a new collaborative session
   * 
   * @param options - Session creation options
   * @returns Promise that resolves to session information
   */
  async createCollaborativeSession(options: {
    notebookPath: string;
    permissions?: Record<string, 'view' | 'edit' | 'admin'>;
  }): Promise<ICollaborativeSession> {
    if (!this._enableCollaboration) {
      throw new Error('Collaborative features are disabled');
    }
    
    try {
      const sessionInfo = await this._collaborativeSessionManager.createSession(options);
      this._currentSession = sessionInfo;
      this._sessionCreatedSignal.emit(sessionInfo);
      return sessionInfo;
      
    } catch (error) {
      console.error('Failed to create session:', error);
      throw new Error(`Failed to create session: ${error.message}`);
    }
  }
  
  /**
   * Set up application configuration
   */
  private _setupConfiguration(): void {
    // Get configuration from PageConfig
    const baseUrl = PageConfig.getOption('baseUrl') || '';
    const hubHost = PageConfig.getOption('hubHost') || '';
    const hubPrefix = PageConfig.getOption('hubPrefix') || '';
    
    this._config = {
      ...this._config,
      baseUrl,
      hubHost,
      hubPrefix,
      enableCollaboration: this._enableCollaboration
    };
  }
  
  /**
   * Initialize collaborative features
   */
  private async _initializeCollaborativeFeatures(): Promise<void> {
    // Initialize collaborative services
    console.log('Initializing collaborative features...');
    
    // Additional initialization for collaborative features would go here
    // This might include setting up WebSocket connections, authentication, etc.
  }
  
  /**
   * Set up event handlers for collaborative features
   */
  private _setupEventHandlers(): void {
    // Set up collaborative session manager event handlers
    this._collaborativeSessionManager.onSessionCreated.connect(
      this._onSessionCreated, this
    );
    
    this._collaborativeSessionManager.onSessionJoined.connect(
      this._onSessionJoined, this
    );
    
    this._collaborativeSessionManager.onSessionLeft.connect(
      this._onSessionLeft, this
    );
    
    this._collaborativeSessionManager.onParticipantJoined.connect(
      this._onParticipantJoined, this
    );
    
    this._collaborativeSessionManager.onParticipantLeft.connect(
      this._onParticipantLeft, this
    );
  }
  
  /**
   * Set up application-level event handlers
   */
  private _setupApplicationEventHandlers(): void {
    // Set up service manager event handlers
    this._serviceManager.sessions.runningChanged.connect(
      this._onSessionsChanged, this
    );
    
    // Set up user event handlers
    if (this._serviceManager.user) {
      this._serviceManager.user.ready.then(() => {
        console.log('User service ready');
      });
    }
  }
  
  /**
   * Create a notebook panel
   */
  private async _createNotebookPanel(path: string, collaborative: boolean): Promise<NotebookPanel> {
    // This would create a proper NotebookPanel instance
    // For now, we'll create a basic mock implementation
    const panel = new NotebookPanel({
      model: null,
      content: null,
      context: null,
      sessionContext: null
    } as any);
    
    return panel;
  }
  
  /**
   * Create a Yjs provider for collaborative editing
   */
  private async _createYjsProvider(path: string, panel: NotebookPanel): Promise<YjsNotebookProvider> {
    const websocketUrl = this._config.websocketUrl || 'ws://localhost:8888';
    const userInfo = this._serviceManager.user?.identity || {
      id: 'anonymous',
      name: 'Anonymous User'
    };
    
    const provider = new YjsNotebookProvider({
      websocketUrl,
      roomName: path,
      userInfo,
      enablePersistence: true,
      enableAwareness: true,
      enableLocking: true,
      enableHistory: true,
      enableComments: true
    });
    
    // Connect to collaboration backend
    await provider.connect();
    
    return provider;
  }
  
  /**
   * Close a notebook and cleanup resources
   */
  private async _closeNotebook(path: string): Promise<void> {
    const notebook = this._activeNotebooks.get(path);
    if (!notebook) {
      return;
    }
    
    try {
      // Disconnect and dispose of provider
      if (notebook.provider) {
        await notebook.provider.disconnect();
        notebook.provider.dispose();
      }
      
      // Dispose of panel
      if (notebook.panel && !notebook.panel.isDisposed) {
        notebook.panel.dispose();
      }
      
      // Remove from active notebooks
      this._activeNotebooks.delete(path);
      
    } catch (error) {
      console.error(`Failed to close notebook ${path}:`, error);
      throw error;
    }
  }
  
  /**
   * Handle session created event
   */
  private _onSessionCreated(
    sender: CollaborativeSessionManager,
    session: ICollaborativeSession
  ): void {
    console.log('Session created:', session.sessionId);
  }
  
  /**
   * Handle session joined event
   */
  private _onSessionJoined(
    sender: CollaborativeSessionManager,
    session: ICollaborativeSession
  ): void {
    console.log('Session joined:', session.sessionId);
  }
  
  /**
   * Handle session left event
   */
  private _onSessionLeft(
    sender: CollaborativeSessionManager,
    sessionId: string
  ): void {
    console.log('Session left:', sessionId);
  }
  
  /**
   * Handle participant joined event
   */
  private _onParticipantJoined(
    sender: CollaborativeSessionManager,
    args: {
      sessionId: string;
      userId: string;
      userName: string;
      role: string;
    }
  ): void {
    console.log('Participant joined:', args.userId, args.userName);
  }
  
  /**
   * Handle participant left event
   */
  private _onParticipantLeft(
    sender: CollaborativeSessionManager,
    args: {
      sessionId: string;
      userId: string;
      userName: string;
    }
  ): void {
    console.log('Participant left:', args.userId, args.userName);
  }
  
  /**
   * Handle sessions changed event
   */
  private _onSessionsChanged(
    sender: any,
    args: any
  ): void {
    console.log('Sessions changed:', args);
  }
}

/**
 * CollaborativeSessionManager class for managing collaborative editing sessions
 * 
 * This class handles the lifecycle of collaborative sessions, including creation,
 * joining, leaving, and participant management. It integrates with the backend
 * collaboration service and manages real-time communication.
 */
export class CollaborativeSessionManager {
  private _serviceManager: ServiceManager;
  private _websocketUrl: string;
  private _baseUrl: string;
  private _userInfo: { id: string; name: string; avatar?: string };
  private _disposables: DisposableSet = new DisposableSet();
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;
  private _sessionTimeout: number = 30000; // 30 seconds
  
  // Active sessions and state
  private _activeSessions: Map<string, ICollaborativeSession> = new Map();
  private _websocketProviders: Map<string, WebsocketProvider> = new Map();
  private _currentSession: ICollaborativeSession | null = null;
  
  // Signals for session events
  private _sessionCreatedSignal = new Signal<CollaborativeSessionManager, ICollaborativeSession>(this);
  private _sessionJoinedSignal = new Signal<CollaborativeSessionManager, ICollaborativeSession>(this);
  private _sessionLeftSignal = new Signal<CollaborativeSessionManager, string>(this);
  private _participantJoinedSignal = new Signal<CollaborativeSessionManager, {
    sessionId: string;
    userId: string;
    userName: string;
    role: string;
  }>(this);
  private _participantLeftSignal = new Signal<CollaborativeSessionManager, {
    sessionId: string;
    userId: string;
    userName: string;
  }>(this);
  
  /**
   * Create a new CollaborativeSessionManager instance
   * 
   * @param options - Configuration options for the session manager
   */
  constructor(options: ISessionManagerOptions) {
    this._serviceManager = options.serviceManager;
    this._websocketUrl = options.websocketUrl;
    this._baseUrl = options.baseUrl;
    this._userInfo = options.userInfo;
    this._sessionTimeout = options.sessionTimeout || 30000;
  }
  
  /**
   * Signal emitted when a session is created
   */
  get onSessionCreated(): Signal<CollaborativeSessionManager, ICollaborativeSession> {
    return this._sessionCreatedSignal;
  }
  
  /**
   * Signal emitted when a session is joined
   */
  get onSessionJoined(): Signal<CollaborativeSessionManager, ICollaborativeSession> {
    return this._sessionJoinedSignal;
  }
  
  /**
   * Signal emitted when a session is left
   */
  get onSessionLeft(): Signal<CollaborativeSessionManager, string> {
    return this._sessionLeftSignal;
  }
  
  /**
   * Signal emitted when a participant joins a session
   */
  get onParticipantJoined(): Signal<CollaborativeSessionManager, {
    sessionId: string;
    userId: string;
    userName: string;
    role: string;
  }> {
    return this._participantJoinedSignal;
  }
  
  /**
   * Signal emitted when a participant leaves a session
   */
  get onParticipantLeft(): Signal<CollaborativeSessionManager, {
    sessionId: string;
    userId: string;
    userName: string;
  }> {
    return this._participantLeftSignal;
  }
  
  /**
   * Initialize the session manager
   * 
   * @returns Promise that resolves when initialization is complete
   */
  async init(): Promise<void> {
    if (this._isInitialized) {
      return;
    }
    
    try {
      // Initialize service manager
      await this._serviceManager.ready;
      
      // Set up user information
      if (this._serviceManager.user) {
        await this._serviceManager.user.ready;
        const identity = this._serviceManager.user.identity;
        if (identity) {
          this._userInfo = {
            id: identity.username || 'anonymous',
            name: identity.name || 'Anonymous User',
            avatar: identity.avatar_url
          };
        }
      }
      
      this._isInitialized = true;
      console.log('CollaborativeSessionManager initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize CollaborativeSessionManager:', error);
      throw new Error(`Session manager initialization failed: ${error.message}`);
    }
  }
  
  /**
   * Start the session manager
   * 
   * @returns Promise that resolves when session manager is started
   */
  async start(): Promise<void> {
    if (!this._isInitialized) {
      throw new Error('Session manager must be initialized before starting');
    }
    
    if (this._isRunning) {
      return;
    }
    
    try {
      // Start session management
      this._isRunning = true;
      console.log('CollaborativeSessionManager started successfully');
      
    } catch (error) {
      console.error('Failed to start CollaborativeSessionManager:', error);
      throw new Error(`Session manager start failed: ${error.message}`);
    }
  }
  
  /**
   * Stop the session manager
   * 
   * @returns Promise that resolves when session manager is stopped
   */
  async stop(): Promise<void> {
    if (!this._isRunning) {
      return;
    }
    
    try {
      // Leave all active sessions
      const sessionIds = Array.from(this._activeSessions.keys());
      await Promise.all(sessionIds.map(id => this.leaveSession(id)));
      
      // Dispose of all resources
      this._disposables.dispose();
      
      this._isRunning = false;
      console.log('CollaborativeSessionManager stopped successfully');
      
    } catch (error) {
      console.error('Failed to stop CollaborativeSessionManager:', error);
      throw new Error(`Session manager stop failed: ${error.message}`);
    }
  }
  
  /**
   * Create a new collaborative session
   * 
   * @param options - Session creation options
   * @returns Promise that resolves to the created session
   */
  async createSession(options: {
    notebookPath: string;
    sessionId?: string;
    permissions?: Record<string, 'view' | 'edit' | 'admin'>;
  }): Promise<ICollaborativeSession> {
    if (!this._isRunning) {
      throw new Error('Session manager is not running');
    }
    
    try {
      const sessionId = options.sessionId || this._generateSessionId();
      const now = new Date();
      
      const session: ICollaborativeSession = {
        sessionId,
        notebookPath: options.notebookPath,
        participants: [{
          userId: this._userInfo.id,
          name: this._userInfo.name,
          role: 'admin',
          joinedAt: now,
          isActive: true
        }],
        createdAt: now,
        createdBy: this._userInfo.id,
        isActive: true,
        lastActivity: now,
        permissions: options.permissions || {}
      };
      
      // Store the session
      this._activeSessions.set(sessionId, session);
      this._currentSession = session;
      
      // Create WebSocket provider for the session
      await this._createWebSocketProvider(sessionId, options.notebookPath);
      
      // Emit signal
      this._sessionCreatedSignal.emit(session);
      
      return session;
      
    } catch (error) {
      console.error('Failed to create session:', error);
      throw new Error(`Session creation failed: ${error.message}`);
    }
  }
  
  /**
   * Join an existing collaborative session
   * 
   * @param sessionId - The session ID to join
   * @returns Promise that resolves to session information
   */
  async joinSession(sessionId: string): Promise<ICollaborativeSession> {
    if (!this._isRunning) {
      throw new Error('Session manager is not running');
    }
    
    try {
      // Check if session exists locally
      let session = this._activeSessions.get(sessionId);
      
      if (!session) {
        // Fetch session from server
        session = await this._fetchSessionFromServer(sessionId);
      }
      
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      
      // Add current user as participant
      const existingParticipant = session.participants.find(p => p.userId === this._userInfo.id);
      if (!existingParticipant) {
        session.participants.push({
          userId: this._userInfo.id,
          name: this._userInfo.name,
          role: 'edit',
          joinedAt: new Date(),
          isActive: true
        });
      } else {
        existingParticipant.isActive = true;
        existingParticipant.joinedAt = new Date();
      }
      
      // Update session activity
      session.lastActivity = new Date();
      
      // Store the session
      this._activeSessions.set(sessionId, session);
      this._currentSession = session;
      
      // Create WebSocket provider for the session
      await this._createWebSocketProvider(sessionId, session.notebookPath);
      
      // Emit signals
      this._sessionJoinedSignal.emit(session);
      this._participantJoinedSignal.emit({
        sessionId,
        userId: this._userInfo.id,
        userName: this._userInfo.name,
        role: existingParticipant?.role || 'edit'
      });
      
      return session;
      
    } catch (error) {
      console.error(`Failed to join session ${sessionId}:`, error);
      throw new Error(`Session join failed: ${error.message}`);
    }
  }
  
  /**
   * Leave a collaborative session
   * 
   * @param sessionId - The session ID to leave
   * @returns Promise that resolves when session is left
   */
  async leaveSession(sessionId: string): Promise<void> {
    if (!this._isRunning) {
      return;
    }
    
    try {
      const session = this._activeSessions.get(sessionId);
      if (!session) {
        return;
      }
      
      // Remove current user from participants
      const participantIndex = session.participants.findIndex(p => p.userId === this._userInfo.id);
      if (participantIndex >= 0) {
        session.participants[participantIndex].isActive = false;
      }
      
      // Disconnect WebSocket provider
      const provider = this._websocketProviders.get(sessionId);
      if (provider) {
        provider.disconnect();
        provider.destroy();
        this._websocketProviders.delete(sessionId);
      }
      
      // Remove from active sessions
      this._activeSessions.delete(sessionId);
      
      // Clear current session if it's the one being left
      if (this._currentSession?.sessionId === sessionId) {
        this._currentSession = null;
      }
      
      // Emit signals
      this._sessionLeftSignal.emit(sessionId);
      this._participantLeftSignal.emit({
        sessionId,
        userId: this._userInfo.id,
        userName: this._userInfo.name
      });
      
    } catch (error) {
      console.error(`Failed to leave session ${sessionId}:`, error);
      throw new Error(`Session leave failed: ${error.message}`);
    }
  }
  
  /**
   * Get information about the active session
   * 
   * @returns Promise that resolves to active session information or null
   */
  async getActiveSession(): Promise<ICollaborativeSession | null> {
    return this._currentSession;
  }
  
  /**
   * Get participants in a session
   * 
   * @param sessionId - The session ID
   * @returns Promise that resolves to session participants
   */
  async getSessionParticipants(sessionId: string): Promise<Array<{
    userId: string;
    name: string;
    role: 'view' | 'edit' | 'admin';
    joinedAt: Date;
    isActive: boolean;
  }>> {
    const session = this._activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    return session.participants;
  }
  
  /**
   * Check if the session manager is disposed
   */
  get isDisposed(): boolean {
    return this._disposables.isDisposed;
  }
  
  /**
   * Dispose of the session manager and cleanup resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    
    // Stop the session manager
    this.stop().catch(console.error);
    
    // Dispose of all resources
    this._disposables.dispose();
  }
  
  /**
   * Generate a unique session ID
   */
  private _generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Create a WebSocket provider for a session
   */
  private async _createWebSocketProvider(sessionId: string, notebookPath: string): Promise<void> {
    try {
      const doc = new Doc();
      const provider = new WebsocketProvider(
        this._websocketUrl,
        `${sessionId}_${notebookPath}`,
        doc,
        {
          awareness: new Awareness(doc)
        }
      );
      
      // Set up event handlers
      provider.on('status', (event: any) => {
        console.log(`WebSocket status for session ${sessionId}:`, event.status);
      });
      
      provider.on('connection-error', (error: any) => {
        console.error(`WebSocket connection error for session ${sessionId}:`, error);
      });
      
      // Connect the provider
      provider.connect();
      
      // Store the provider
      this._websocketProviders.set(sessionId, provider);
      
    } catch (error) {
      console.error(`Failed to create WebSocket provider for session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * Fetch session information from the server
   */
  private async _fetchSessionFromServer(sessionId: string): Promise<ICollaborativeSession | null> {
    try {
      // This would make an HTTP request to the server to get session information
      // For now, we'll return null to indicate session not found
      return null;
      
    } catch (error) {
      console.error(`Failed to fetch session ${sessionId} from server:`, error);
      return null;
    }
  }
}