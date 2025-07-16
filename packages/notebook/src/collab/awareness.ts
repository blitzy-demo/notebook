// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import YjsNotebookProvider from './provider';

/**
 * Connection status enumeration for awareness system
 */
export enum ConnectionStatus {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
  SYNCING = 'syncing',
  SYNCED = 'synced'
}

/**
 * User activity type enumeration
 */
export enum UserActivityType {
  EDITING = 'editing',
  VIEWING = 'viewing',
  EXECUTING = 'executing',
  IDLE = 'idle',
  TYPING = 'typing',
  SCROLLING = 'scrolling',
  SELECTING = 'selecting',
  COMMENTING = 'commenting',
  DEBUGGING = 'debugging',
  OFFLINE = 'offline'
}

/**
 * Awareness event type enumeration
 */
export enum AwarenessEventType {
  USER_ADDED = 'user_added',
  USER_REMOVED = 'user_removed',
  USER_UPDATED = 'user_updated',
  CURSOR_MOVED = 'cursor_moved',
  SELECTION_CHANGED = 'selection_changed',
  ACTIVITY_CHANGED = 'activity_changed',
  CONNECTION_STATUS_CHANGED = 'connection_status_changed',
  PRESENCE_UPDATED = 'presence_updated',
  USER_JOINED = 'user_joined',
  USER_LEFT = 'user_left'
}

/**
 * Interface representing cursor position information
 */
export interface ICursorPosition {
  /** Cell identifier where cursor is located */
  cellId: string;
  /** Line number within the cell */
  line: number;
  /** Column position within the line */
  column: number;
  /** Character position within the cell */
  character: number;
  /** Byte offset within the cell content */
  offset: number;
  /** Timestamp of cursor position update */
  timestamp: number;
  /** User ID that owns this cursor */
  userId: string;
  /** Whether cursor is visible to other users */
  isVisible: boolean;
  /** Additional metadata for cursor position */
  metadata?: { [key: string]: any };
}

/**
 * Interface representing text selection information
 */
export interface ISelection {
  /** Cell identifier where selection is located */
  cellId: string;
  /** Selection start position */
  start: ICursorPosition;
  /** Selection end position */
  end: ICursorPosition;
  /** Selected text content */
  text: string;
  /** Timestamp of selection update */
  timestamp: number;
  /** User ID that owns this selection */
  userId: string;
  /** Whether selection is visible to other users */
  isVisible: boolean;
  /** Additional metadata for selection */
  metadata?: { [key: string]: any };
}

/**
 * Interface representing user activity information
 */
export interface IUserActivity {
  /** User identifier */
  userId: string;
  /** Current activity type */
  activity: UserActivityType;
  /** Cell being worked on, if applicable */
  cellId?: string;
  /** Timestamp of activity update */
  timestamp: number;
  /** Activity type identifier */
  type: string;
  /** Additional metadata for activity */
  metadata?: { [key: string]: any };
  /** Duration of current activity in milliseconds */
  duration?: number;
  /** Whether user is currently active */
  isActive: boolean;
}

/**
 * Interface representing user presence information
 */
export interface IUserPresence {
  /** User identifier */
  userId: string;
  /** Whether user is online */
  isOnline: boolean;
  /** Whether user is currently active */
  isActive: boolean;
  /** Last seen timestamp */
  lastSeen: number;
  /** Current cell being worked on */
  currentCell?: string;
  /** Current activity type */
  activity: UserActivityType;
  /** Current cursor position */
  cursorPosition?: ICursorPosition;
  /** Current selection */
  selection?: ISelection;
  /** Connection status */
  connectionStatus: ConnectionStatus;
  /** Session identifier */
  sessionId: string;
  /** Additional metadata */
  metadata?: { [key: string]: any };
}

/**
 * Interface representing user information
 */
export interface IUser {
  /** Unique user identifier */
  id: string;
  /** User ID from authentication system */
  userId: string;
  /** Username for display */
  username: string;
  /** User email address */
  email: string;
  /** Display name */
  displayName: string;
  /** User avatar URL or data */
  avatar?: string;
  /** User color for presence indicators */
  color: string;
  /** Session identifier */
  sessionId: string;
  /** Whether user is currently active */
  isActive: boolean;
  /** Last seen timestamp */
  lastSeen: number;
  /** Current cursor position */
  cursorPosition?: ICursorPosition;
  /** Current selection */
  selection?: ISelection;
  /** Current cell being worked on */
  currentCell?: string;
  /** Current activity */
  activity: UserActivityType;
  /** Connection status */
  connectionStatus: ConnectionStatus;
  /** Additional metadata */
  metadata?: { [key: string]: any };
  /** User roles */
  roles?: string[];
  /** User permissions */
  permissions?: string[];
}

/**
 * Interface representing awareness events
 */
export interface IAwarenessEvent {
  /** Event type */
  type: AwarenessEventType;
  /** User associated with event */
  user: IUser;
  /** Event timestamp */
  timestamp: number;
  /** Previous state before event */
  previousState?: any;
  /** New state after event */
  newState?: any;
  /** Additional metadata */
  metadata?: { [key: string]: any };
  /** Event origin */
  origin: string;
}

/**
 * Interface for awareness system configuration
 */
export interface IAwarenessConfig {
  /** Heartbeat interval in milliseconds */
  heartbeatInterval: number;
  /** User inactivity timeout in milliseconds */
  inactivityTimeout: number;
  /** Presence timeout in milliseconds */
  presenceTimeout: number;
  /** Maximum number of users to track */
  maxUsers: number;
  /** Enable cursor position tracking */
  enableCursorTracking: boolean;
  /** Enable selection tracking */
  enableSelectionTracking: boolean;
  /** Enable activity tracking */
  enableActivityTracking: boolean;
  /** Enable presence indicators */
  enablePresenceIndicators: boolean;
  /** Color palette for user indicators */
  colorPalette: string[];
  /** Update throttling interval in milliseconds */
  updateThrottleMs: number;
  /** Reconnection delay in milliseconds */
  reconnectDelay: number;
  /** Maximum reconnection attempts */
  maxReconnectAttempts: number;
}

/**
 * Interface for awareness registry functionality
 */
export interface IAwarenessRegistry {
  /** Register a user in the awareness system */
  register(user: IUser): void;
  /** Unregister a user from the awareness system */
  unregister(userId: string): void;
  /** Get all registered users */
  getUsers(): IUser[];
  /** Get user by ID */
  getUserById(userId: string): IUser | null;
  /** Get users currently working on a specific cell */
  getUsersByCell(cellId: string): IUser[];
  /** Get total user count */
  getUserCount(): number;
  /** Check if user is active */
  isUserActive(userId: string): boolean;
  /** Get all users regardless of activity status */
  getAllUsers(): IUser[];
  /** Get only active users */
  getActiveUsers(): IUser[];
  /** Clear all users from registry */
  clear(): void;
  /** Signal emitted when user is added */
  onUserAdded: ISignal<IAwarenessRegistry, IUser>;
  /** Signal emitted when user is removed */
  onUserRemoved: ISignal<IAwarenessRegistry, IUser>;
  /** Signal emitted when user is changed */
  onUserChanged: ISignal<IAwarenessRegistry, IUser>;
}

/**
 * Interface for user awareness functionality
 */
export interface IUserAwareness {
  /** Map of all users */
  users: Map<string, IUser>;
  /** Current connection status */
  connectionStatus: ConnectionStatus;
  /** Total user count */
  userCount: number;
  /** Signal emitted when users change */
  onUsersChanged: ISignal<IUserAwareness, Map<string, IUser>>;
  /** Signal emitted when connection status changes */
  onConnectionStatusChanged: ISignal<IUserAwareness, ConnectionStatus>;
  /** Get current user information */
  getCurrentUser(): IUser | null;
  /** Get active users */
  getActiveUsers(): IUser[];
  /** Update user status */
  updateUserStatus(userId: string, status: Partial<IUser>): void;
  /** Track user activity */
  trackUserActivity(userId: string, activity: IUserActivity): void;
  /** Get user by ID */
  getUserById(userId: string): IUser | null;
  /** Get users by cell */
  getUsersByCell(cellId: string): IUser[];
  /** Update user cursor position */
  updateUserCursor(userId: string, position: ICursorPosition): void;
  /** Update user selection */
  updateUserSelection(userId: string, selection: ISelection): void;
  /** Set user presence */
  setUserPresence(userId: string, presence: IUserPresence): void;
  /** Remove user */
  removeUser(userId: string): void;
  /** Check if user is active */
  isUserActive(userId: string): boolean;
  /** Dispose resources */
  dispose(): void;
}

/**
 * Default configuration for awareness system
 */
const DEFAULT_CONFIG: IAwarenessConfig = {
  heartbeatInterval: 30000, // 30 seconds
  inactivityTimeout: 300000, // 5 minutes
  presenceTimeout: 60000, // 1 minute
  maxUsers: 100,
  enableCursorTracking: true,
  enableSelectionTracking: true,
  enableActivityTracking: true,
  enablePresenceIndicators: true,
  colorPalette: [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
  ],
  updateThrottleMs: 100, // 100ms throttling
  reconnectDelay: 1000, // 1 second
  maxReconnectAttempts: 10
};

/**
 * UserAwareness system implementation for tracking and visualizing user presence
 * information in real-time collaborative editing sessions.
 */
export default class UserAwareness implements IUserAwareness, IDisposable {
  private _users = new Map<string, IUser>();
  private _localUser: IUser | null = null;
  private _remoteUsers = new Map<string, IUser>();
  private _awarenessMap: Y.Map<any>;
  private _provider: YjsNotebookProvider;
  private _websocketProvider: WebsocketProvider | null = null;
  private _config: IAwarenessConfig;
  private _connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private _heartbeatTimer: number | null = null;
  private _inactivityTimer: number | null = null;
  private _disposed = false;
  private _lastActivity = Date.now();
  private _updateThrottleTimer: number | null = null;
  private _pendingUpdates = new Set<string>();

  // Signals for awareness events
  private _onUsersChanged = new Signal<IUserAwareness, Map<string, IUser>>(this);
  private _onConnectionStatusChanged = new Signal<IUserAwareness, ConnectionStatus>(this);
  private _onUserAdded = new Signal<UserAwareness, IUser>(this);
  private _onUserRemoved = new Signal<UserAwareness, IUser>(this);
  private _onUserActivityChanged = new Signal<UserAwareness, IUserActivity>(this);
  private _onCursorPositionChanged = new Signal<UserAwareness, ICursorPosition>(this);
  private _onSelectionChanged = new Signal<UserAwareness, ISelection>(this);

  /**
   * Construct a new UserAwareness instance
   *
   * @param provider - The Yjs notebook provider instance
   * @param config - Configuration options for awareness system
   */
  constructor(provider: YjsNotebookProvider, config: Partial<IAwarenessConfig> = {}) {
    this._provider = provider;
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._awarenessMap = provider.yjsDocument.getMap('awareness');
    
    // Initialize awareness system
    this._initializeAwareness();
    
    // Set up provider connection monitoring
    this._setupProviderObservers();
    
    // Initialize local user
    this._initializeLocalUser();
  }

  /**
   * Get the map of all users
   */
  get users(): Map<string, IUser> {
    return new Map(this._users);
  }

  /**
   * Get current connection status
   */
  get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  /**
   * Get total user count
   */
  get userCount(): number {
    return this._users.size;
  }

  /**
   * Signal emitted when users change
   */
  get onUsersChanged(): ISignal<IUserAwareness, Map<string, IUser>> {
    return this._onUsersChanged;
  }

  /**
   * Signal emitted when connection status changes
   */
  get onConnectionStatusChanged(): ISignal<IUserAwareness, ConnectionStatus> {
    return this._onConnectionStatusChanged;
  }

  /**
   * Get awareness map for external access
   */
  get awarenessMap(): Y.Map<any> {
    return this._awarenessMap;
  }

  /**
   * Get local user information
   */
  get localUser(): IUser | null {
    return this._localUser;
  }

  /**
   * Get remote users map
   */
  get remoteUsers(): Map<string, IUser> {
    return new Map(this._remoteUsers);
  }

  /**
   * Signal emitted when user is added
   */
  get onUserAdded(): ISignal<UserAwareness, IUser> {
    return this._onUserAdded;
  }

  /**
   * Signal emitted when user is removed
   */
  get onUserRemoved(): ISignal<UserAwareness, IUser> {
    return this._onUserRemoved;
  }

  /**
   * Signal emitted when user activity changes
   */
  get onUserActivityChanged(): ISignal<UserAwareness, IUserActivity> {
    return this._onUserActivityChanged;
  }

  /**
   * Signal emitted when cursor position changes
   */
  get onCursorPositionChanged(): ISignal<UserAwareness, ICursorPosition> {
    return this._onCursorPositionChanged;
  }

  /**
   * Signal emitted when selection changes
   */
  get onSelectionChanged(): ISignal<UserAwareness, ISelection> {
    return this._onSelectionChanged;
  }

  /**
   * Get current user information
   */
  getCurrentUser(): IUser | null {
    return this._localUser;
  }

  /**
   * Get active users
   */
  getActiveUsers(): IUser[] {
    return Array.from(this._users.values()).filter(user => 
      user.isActive && user.connectionStatus === ConnectionStatus.CONNECTED
    );
  }

  /**
   * Update user status
   */
  updateUserStatus(userId: string, status: Partial<IUser>): void {
    const user = this._users.get(userId);
    if (!user) {
      console.warn(`User ${userId} not found for status update`);
      return;
    }

    // Update user object
    const updatedUser: IUser = { ...user, ...status, lastSeen: Date.now() };
    this._users.set(userId, updatedUser);

    // Update local user if this is the current user
    if (this._localUser && this._localUser.id === userId) {
      this._localUser = updatedUser;
    }

    // Update remote users
    if (this._remoteUsers.has(userId)) {
      this._remoteUsers.set(userId, updatedUser);
    }

    // Update awareness map
    this._updateAwarenessForUser(updatedUser);

    // Emit events
    this._onUsersChanged.emit(this.users);
  }

  /**
   * Track user activity
   */
  trackUserActivity(userId: string, activity: IUserActivity): void {
    const user = this._users.get(userId);
    if (!user) {
      console.warn(`User ${userId} not found for activity tracking`);
      return;
    }

    // Update user activity
    const updatedUser: IUser = {
      ...user,
      activity: activity.activity,
      currentCell: activity.cellId,
      lastSeen: Date.now(),
      isActive: activity.isActive
    };

    this._users.set(userId, updatedUser);

    // Update local user if this is the current user
    if (this._localUser && this._localUser.id === userId) {
      this._localUser = updatedUser;
    }

    // Update remote users
    if (this._remoteUsers.has(userId)) {
      this._remoteUsers.set(userId, updatedUser);
    }

    // Update awareness map
    this._updateAwarenessForUser(updatedUser);

    // Emit events
    this._onUserActivityChanged.emit(activity);
    this._onUsersChanged.emit(this.users);
  }

  /**
   * Get user by ID
   */
  getUserById(userId: string): IUser | null {
    return this._users.get(userId) || null;
  }

  /**
   * Get users currently working on a specific cell
   */
  getUsersByCell(cellId: string): IUser[] {
    return Array.from(this._users.values()).filter(user => 
      user.currentCell === cellId && user.isActive
    );
  }

  /**
   * Update user cursor position
   */
  updateUserCursor(userId: string, position: ICursorPosition): void {
    const user = this._users.get(userId);
    if (!user) {
      console.warn(`User ${userId} not found for cursor update`);
      return;
    }

    // Update user cursor
    const updatedUser: IUser = {
      ...user,
      cursorPosition: position,
      lastSeen: Date.now()
    };

    this._users.set(userId, updatedUser);

    // Update local user if this is the current user
    if (this._localUser && this._localUser.id === userId) {
      this._localUser = updatedUser;
    }

    // Update remote users
    if (this._remoteUsers.has(userId)) {
      this._remoteUsers.set(userId, updatedUser);
    }

    // Update awareness map with throttling
    this._throttleAwarenessUpdate(userId);

    // Emit events
    this._onCursorPositionChanged.emit(position);
    this._onUsersChanged.emit(this.users);
  }

  /**
   * Update user selection
   */
  updateUserSelection(userId: string, selection: ISelection): void {
    const user = this._users.get(userId);
    if (!user) {
      console.warn(`User ${userId} not found for selection update`);
      return;
    }

    // Update user selection
    const updatedUser: IUser = {
      ...user,
      selection: selection,
      lastSeen: Date.now()
    };

    this._users.set(userId, updatedUser);

    // Update local user if this is the current user
    if (this._localUser && this._localUser.id === userId) {
      this._localUser = updatedUser;
    }

    // Update remote users
    if (this._remoteUsers.has(userId)) {
      this._remoteUsers.set(userId, updatedUser);
    }

    // Update awareness map with throttling
    this._throttleAwarenessUpdate(userId);

    // Emit events
    this._onSelectionChanged.emit(selection);
    this._onUsersChanged.emit(this.users);
  }

  /**
   * Set user presence
   */
  setUserPresence(userId: string, presence: IUserPresence): void {
    const user = this._users.get(userId);
    if (!user) {
      console.warn(`User ${userId} not found for presence update`);
      return;
    }

    // Update user presence
    const updatedUser: IUser = {
      ...user,
      isActive: presence.isActive,
      lastSeen: presence.lastSeen,
      currentCell: presence.currentCell,
      activity: presence.activity,
      cursorPosition: presence.cursorPosition,
      selection: presence.selection,
      connectionStatus: presence.connectionStatus
    };

    this._users.set(userId, updatedUser);

    // Update local user if this is the current user
    if (this._localUser && this._localUser.id === userId) {
      this._localUser = updatedUser;
    }

    // Update remote users
    if (this._remoteUsers.has(userId)) {
      this._remoteUsers.set(userId, updatedUser);
    }

    // Update awareness map
    this._updateAwarenessForUser(updatedUser);

    // Emit events
    this._onUsersChanged.emit(this.users);
  }

  /**
   * Remove user from awareness system
   */
  removeUser(userId: string): void {
    const user = this._users.get(userId);
    if (!user) {
      return;
    }

    // Remove from maps
    this._users.delete(userId);
    this._remoteUsers.delete(userId);

    // Remove from awareness map
    this._awarenessMap.delete(userId);

    // Emit events
    this._onUserRemoved.emit(user);
    this._onUsersChanged.emit(this.users);
  }

  /**
   * Check if user is active
   */
  isUserActive(userId: string): boolean {
    const user = this._users.get(userId);
    if (!user) {
      return false;
    }

    // Check if user is active and recently seen
    const now = Date.now();
    const inactivityThreshold = now - this._config.inactivityTimeout;
    
    return user.isActive && 
           user.lastSeen > inactivityThreshold &&
           user.connectionStatus === ConnectionStatus.CONNECTED;
  }

  /**
   * Get user activity information
   */
  getUserActivity(userId: string): IUserActivity | null {
    const user = this._users.get(userId);
    if (!user) {
      return null;
    }

    return {
      userId: user.id,
      activity: user.activity,
      cellId: user.currentCell,
      timestamp: user.lastSeen,
      type: user.activity,
      isActive: user.isActive
    };
  }

  /**
   * Get connection health information
   */
  getConnectionHealth(): {
    healthy: boolean;
    connectedUsers: number;
    syncLatency: number;
  } {
    const connectedUsers = this.getActiveUsers().length;
    const syncLatency = this._calculateSyncLatency();
    
    return {
      healthy: this._connectionStatus === ConnectionStatus.CONNECTED,
      connectedUsers,
      syncLatency
    };
  }

  /**
   * Start heartbeat monitoring
   */
  startHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
    }

    this._heartbeatTimer = window.setInterval(() => {
      this._sendHeartbeat();
    }, this._config.heartbeatInterval);
  }

  /**
   * Stop heartbeat monitoring
   */
  stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Check if awareness system is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the awareness system
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Stop timers
    this.stopHeartbeat();
    
    if (this._inactivityTimer) {
      clearInterval(this._inactivityTimer);
      this._inactivityTimer = null;
    }

    if (this._updateThrottleTimer) {
      clearTimeout(this._updateThrottleTimer);
      this._updateThrottleTimer = null;
    }

    // Clean up awareness observers
    this._cleanupAwarenessObservers();

    // Clear user data
    this._users.clear();
    this._remoteUsers.clear();
    this._localUser = null;

    // Clear signals
    Signal.clearData(this);
  }

  /**
   * Initialize awareness system
   */
  private _initializeAwareness(): void {
    // Set up awareness map observers
    this._setupAwarenessObservers();

    // Start heartbeat
    this.startHeartbeat();

    // Start inactivity monitoring
    this._startInactivityMonitoring();
  }

  /**
   * Set up provider observers for connection monitoring
   */
  private _setupProviderObservers(): void {
    // Monitor connection state changes
    this._provider.onConnectionStateChanged.connect((sender, state) => {
      this._updateConnectionStatus(state.connected ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED);
    });

    // Monitor document changes
    this._provider.onDocumentChanged.connect((sender, event) => {
      this._handleDocumentChange(event);
    });

    // Set up WebSocket provider when available
    if (this._provider.websocketProvider) {
      this._websocketProvider = this._provider.websocketProvider;
      this._setupWebSocketAwareness();
    }
  }

  /**
   * Set up WebSocket awareness integration
   */
  private _setupWebSocketAwareness(): void {
    if (!this._websocketProvider || !this._websocketProvider.awareness) {
      return;
    }

    const awareness = this._websocketProvider.awareness;

    // Listen for awareness updates
    awareness.on('update', (update: any) => {
      this._handleAwarenessUpdate(update);
    });

    // Listen for awareness changes
    awareness.on('change', (changes: any) => {
      this._handleAwarenessChange(changes);
    });
  }

  /**
   * Set up awareness map observers
   */
  private _setupAwarenessObservers(): void {
    // Observe awareness map changes
    this._awarenessMap.observe((event: Y.YMapEvent<any>) => {
      this._handleAwarenessMapChange(event);
    });
  }

  /**
   * Clean up awareness observers
   */
  private _cleanupAwarenessObservers(): void {
    try {
      // Unobserve awareness map
      this._awarenessMap.unobserve(this._handleAwarenessMapChange);
    } catch (error) {
      console.warn('Error cleaning up awareness observers:', error);
    }
  }

  /**
   * Initialize local user
   */
  private async _initializeLocalUser(): Promise<void> {
    try {
      // Get user identity from server
      const userInfo = await this._fetchUserInfo();
      
      // Create local user object
      this._localUser = {
        id: UUID.uuid4(),
        userId: userInfo.id || 'anonymous',
        username: userInfo.username || 'Anonymous',
        email: userInfo.email || '',
        displayName: userInfo.displayName || userInfo.username || 'Anonymous',
        avatar: userInfo.avatar,
        color: this._assignUserColor(),
        sessionId: this._provider.sessionId,
        isActive: true,
        lastSeen: Date.now(),
        activity: UserActivityType.VIEWING,
        connectionStatus: ConnectionStatus.CONNECTED,
        metadata: {
          joinTime: Date.now(),
          userAgent: navigator.userAgent,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
      };

      // Add to users map
      this._users.set(this._localUser.id, this._localUser);

      // Update awareness map
      this._updateAwarenessForUser(this._localUser);

      // Emit events
      this._onUserAdded.emit(this._localUser);
      this._onUsersChanged.emit(this.users);

    } catch (error) {
      console.error('Failed to initialize local user:', error);
      
      // Create fallback anonymous user
      this._localUser = {
        id: UUID.uuid4(),
        userId: 'anonymous',
        username: 'Anonymous',
        email: '',
        displayName: 'Anonymous',
        color: this._assignUserColor(),
        sessionId: this._provider.sessionId,
        isActive: true,
        lastSeen: Date.now(),
        activity: UserActivityType.VIEWING,
        connectionStatus: ConnectionStatus.CONNECTED
      };

      this._users.set(this._localUser.id, this._localUser);
      this._updateAwarenessForUser(this._localUser);
      this._onUserAdded.emit(this._localUser);
      this._onUsersChanged.emit(this.users);
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
        email: ''
      };
    }
  }

  /**
   * Assign a color to a user
   */
  private _assignUserColor(): string {
    const usedColors = new Set(
      Array.from(this._users.values()).map(user => user.color)
    );
    
    // Find first available color
    for (const color of this._config.colorPalette) {
      if (!usedColors.has(color)) {
        return color;
      }
    }
    
    // If all colors are used, return a random one
    return this._config.colorPalette[
      Math.floor(Math.random() * this._config.colorPalette.length)
    ];
  }

  /**
   * Update awareness map for a user
   */
  private _updateAwarenessForUser(user: IUser): void {
    const awarenessData = {
      user: {
        id: user.id,
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        avatar: user.avatar,
        color: user.color
      },
      presence: {
        isActive: user.isActive,
        lastSeen: user.lastSeen,
        activity: user.activity,
        currentCell: user.currentCell,
        connectionStatus: user.connectionStatus
      },
      cursor: user.cursorPosition,
      selection: user.selection,
      timestamp: Date.now()
    };

    this._awarenessMap.set(user.id, awarenessData);
  }

  /**
   * Throttle awareness updates to prevent excessive network traffic
   */
  private _throttleAwarenessUpdate(userId: string): void {
    this._pendingUpdates.add(userId);

    if (this._updateThrottleTimer) {
      return;
    }

    this._updateThrottleTimer = window.setTimeout(() => {
      // Process all pending updates
      this._pendingUpdates.forEach(uid => {
        const user = this._users.get(uid);
        if (user) {
          this._updateAwarenessForUser(user);
        }
      });

      this._pendingUpdates.clear();
      this._updateThrottleTimer = null;
    }, this._config.updateThrottleMs);
  }

  /**
   * Handle awareness map changes
   */
  private _handleAwarenessMapChange(event: Y.YMapEvent<any>): void {
    const changes = event.changes.keys;
    changes.forEach((change, userId) => {
      if (change.action === 'add' || change.action === 'update') {
        this._handleUserAwarenessUpdate(userId, this._awarenessMap.get(userId));
      } else if (change.action === 'delete') {
        this._handleUserAwarenessRemoval(userId);
      }
    });
  }

  /**
   * Handle user awareness update
   */
  private _handleUserAwarenessUpdate(userId: string, awarenessData: any): void {
    if (!awarenessData || userId === this._localUser?.id) {
      return;
    }

    const existingUser = this._users.get(userId);
    const userData = awarenessData.user;
    const presenceData = awarenessData.presence;

    // Create or update user
    const user: IUser = {
      id: userId,
      userId: userData.userId,
      username: userData.username,
      email: userData.email || '',
      displayName: userData.displayName,
      avatar: userData.avatar,
      color: userData.color,
      sessionId: userData.sessionId || '',
      isActive: presenceData.isActive,
      lastSeen: presenceData.lastSeen,
      currentCell: presenceData.currentCell,
      activity: presenceData.activity,
      connectionStatus: presenceData.connectionStatus,
      cursorPosition: awarenessData.cursor,
      selection: awarenessData.selection,
      metadata: userData.metadata
    };

    // Update users map
    this._users.set(userId, user);
    this._remoteUsers.set(userId, user);

    // Emit appropriate events
    if (!existingUser) {
      this._onUserAdded.emit(user);
    }

    this._onUsersChanged.emit(this.users);
  }

  /**
   * Handle user awareness removal
   */
  private _handleUserAwarenessRemoval(userId: string): void {
    const user = this._users.get(userId);
    if (user) {
      this._users.delete(userId);
      this._remoteUsers.delete(userId);
      this._onUserRemoved.emit(user);
      this._onUsersChanged.emit(this.users);
    }
  }

  /**
   * Handle WebSocket awareness updates
   */
  private _handleAwarenessUpdate(update: any): void {
    // Process awareness updates from WebSocket
    if (update.added) {
      for (const clientId of update.added) {
        this._handleRemoteUserJoined(clientId);
      }
    }

    if (update.updated) {
      for (const clientId of update.updated) {
        this._handleRemoteUserUpdated(clientId);
      }
    }

    if (update.removed) {
      for (const clientId of update.removed) {
        this._handleRemoteUserLeft(clientId);
      }
    }
  }

  /**
   * Handle WebSocket awareness changes
   */
  private _handleAwarenessChange(changes: any): void {
    // Process awareness state changes
    for (const [clientId, change] of changes.entries()) {
      if (change.oldState && change.newState) {
        this._handleRemoteUserStateChange(clientId, change.oldState, change.newState);
      }
    }
  }

  /**
   * Handle remote user joined
   */
  private _handleRemoteUserJoined(clientId: number): void {
    if (!this._websocketProvider?.awareness) {
      return;
    }

    const awarenessState = this._websocketProvider.awareness.getStates().get(clientId);
    if (awarenessState) {
      this._handleUserAwarenessUpdate(awarenessState.user?.id || `client-${clientId}`, awarenessState);
    }
  }

  /**
   * Handle remote user updated
   */
  private _handleRemoteUserUpdated(clientId: number): void {
    if (!this._websocketProvider?.awareness) {
      return;
    }

    const awarenessState = this._websocketProvider.awareness.getStates().get(clientId);
    if (awarenessState) {
      this._handleUserAwarenessUpdate(awarenessState.user?.id || `client-${clientId}`, awarenessState);
    }
  }

  /**
   * Handle remote user left
   */
  private _handleRemoteUserLeft(clientId: number): void {
    // Find user by client ID and remove
    const userToRemove = Array.from(this._users.values()).find(
      user => user.metadata?.clientId === clientId
    );

    if (userToRemove) {
      this._handleUserAwarenessRemoval(userToRemove.id);
    }
  }

  /**
   * Handle remote user state change
   */
  private _handleRemoteUserStateChange(clientId: number, oldState: any, newState: any): void {
    if (newState.user) {
      this._handleUserAwarenessUpdate(newState.user.id || `client-${clientId}`, newState);
    }
  }

  /**
   * Handle document changes
   */
  private _handleDocumentChange(event: any): void {
    // Update local user activity when document changes
    if (this._localUser) {
      this._localUser.activity = UserActivityType.EDITING;
      this._localUser.lastSeen = Date.now();
      this._updateAwarenessForUser(this._localUser);
    }
  }

  /**
   * Send heartbeat to maintain presence
   */
  private _sendHeartbeat(): void {
    if (this._localUser && this._connectionStatus === ConnectionStatus.CONNECTED) {
      this._localUser.lastSeen = Date.now();
      this._updateAwarenessForUser(this._localUser);
    }
  }

  /**
   * Start inactivity monitoring
   */
  private _startInactivityMonitoring(): void {
    this._inactivityTimer = window.setInterval(() => {
      this._checkUserInactivity();
    }, this._config.inactivityTimeout / 4); // Check every quarter of timeout period
  }

  /**
   * Check for inactive users
   */
  private _checkUserInactivity(): void {
    const now = Date.now();
    const inactivityThreshold = now - this._config.inactivityTimeout;

    this._users.forEach((user, userId) => {
      if (user.lastSeen < inactivityThreshold && user.isActive) {
        // Mark user as inactive
        const updatedUser = { ...user, isActive: false, activity: UserActivityType.IDLE };
        this._users.set(userId, updatedUser);

        if (this._localUser && this._localUser.id === userId) {
          this._localUser = updatedUser;
        }

        if (this._remoteUsers.has(userId)) {
          this._remoteUsers.set(userId, updatedUser);
        }

        this._updateAwarenessForUser(updatedUser);
      }
    });

    // Emit users changed event if any changes were made
    this._onUsersChanged.emit(this.users);
  }

  /**
   * Update connection status
   */
  private _updateConnectionStatus(status: ConnectionStatus): void {
    if (this._connectionStatus !== status) {
      this._connectionStatus = status;
      this._onConnectionStatusChanged.emit(status);

      // Update local user connection status
      if (this._localUser) {
        this._localUser.connectionStatus = status;
        this._updateAwarenessForUser(this._localUser);
      }
    }
  }

  /**
   * Calculate synchronization latency
   */
  private _calculateSyncLatency(): number {
    // Simple latency calculation based on last activity
    return Date.now() - this._lastActivity;
  }
}

/**
 * Awareness registry implementation
 */
class AwarenessRegistry implements IAwarenessRegistry {
  private _users = new Map<string, IUser>();
  private _onUserAdded = new Signal<IAwarenessRegistry, IUser>(this);
  private _onUserRemoved = new Signal<IAwarenessRegistry, IUser>(this);
  private _onUserChanged = new Signal<IAwarenessRegistry, IUser>(this);

  /**
   * Register a user in the awareness system
   */
  register(user: IUser): void {
    const existing = this._users.get(user.id);
    this._users.set(user.id, user);

    if (!existing) {
      this._onUserAdded.emit(user);
    } else {
      this._onUserChanged.emit(user);
    }
  }

  /**
   * Unregister a user from the awareness system
   */
  unregister(userId: string): void {
    const user = this._users.get(userId);
    if (user) {
      this._users.delete(userId);
      this._onUserRemoved.emit(user);
    }
  }

  /**
   * Get all registered users
   */
  getUsers(): IUser[] {
    return Array.from(this._users.values());
  }

  /**
   * Get user by ID
   */
  getUserById(userId: string): IUser | null {
    return this._users.get(userId) || null;
  }

  /**
   * Get users currently working on a specific cell
   */
  getUsersByCell(cellId: string): IUser[] {
    return Array.from(this._users.values()).filter(user => 
      user.currentCell === cellId && user.isActive
    );
  }

  /**
   * Get total user count
   */
  getUserCount(): number {
    return this._users.size;
  }

  /**
   * Check if user is active
   */
  isUserActive(userId: string): boolean {
    const user = this._users.get(userId);
    return user ? user.isActive : false;
  }

  /**
   * Get all users regardless of activity status
   */
  getAllUsers(): IUser[] {
    return Array.from(this._users.values());
  }

  /**
   * Get only active users
   */
  getActiveUsers(): IUser[] {
    return Array.from(this._users.values()).filter(user => user.isActive);
  }

  /**
   * Clear all users from registry
   */
  clear(): void {
    this._users.clear();
  }

  /**
   * Signal emitted when user is added
   */
  get onUserAdded(): ISignal<IAwarenessRegistry, IUser> {
    return this._onUserAdded;
  }

  /**
   * Signal emitted when user is removed
   */
  get onUserRemoved(): ISignal<IAwarenessRegistry, IUser> {
    return this._onUserRemoved;
  }

  /**
   * Signal emitted when user is changed
   */
  get onUserChanged(): ISignal<IAwarenessRegistry, IUser> {
    return this._onUserChanged;
  }
}

// Export the registry class
export { AwarenessRegistry };