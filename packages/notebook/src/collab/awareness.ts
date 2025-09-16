/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * CollaborationAwareness module implementing user presence tracking and broadcasting
 * using Yjs awareness protocol. Manages user information, cursor positions, selected
 * cells, and idle detection with timeout handling for comprehensive presence visualization.
 */

import { Awareness } from 'y-protocols';
import * as Y from 'yjs';
import { Signal } from '@lumino/signaling';
import { UUID } from '@lumino/coreutils';
import { ICellModel } from '@jupyterlab/cells';

import { YjsNotebookProvider } from './provider';
import { ICollaborativeUser } from '../tokens';

/**
 * User color enumeration for consistent color assignment across users
 */
export enum UserColor {
  BLUE = '#1f77b4',
  ORANGE = '#ff7f0e',
  GREEN = '#2ca02c',
  RED = '#d62728',
  PURPLE = '#9467bd',
  BROWN = '#8c564b',
  PINK = '#e377c2',
  GRAY = '#7f7f7f',
  OLIVE = '#bcbd22',
  CYAN = '#17becf',
  NAVY = '#001f3f',
  LIME = '#01ff70',
  YELLOW = '#ffdc00',
  FUCHSIA = '#f012be',
  AQUA = '#7fdbff',
  MAROON = '#85144b',
  SILVER = '#dddddd',
  TEAL = '#39cccc',
  BLACK = '#111111',
  WHITE = '#ffffff'
}

/**
 * Default presence timeout in milliseconds (5 minutes)
 */
export const DEFAULT_PRESENCE_TIMEOUT_MS = 300000;

/**
 * Maximum presence timeout backoff in milliseconds (30 minutes)
 */
export const MAX_PRESENCE_BACKOFF_MS = 1800000;

/**
 * Configuration interface for CollaborationAwareness initialization
 */
export interface IAwarenessConfig {
  /**
   * Presence timeout in milliseconds for idle user detection
   */
  presenceTimeout?: number;

  /**
   * Enable exponential backoff for timeout detection
   */
  exponentialBackoff?: boolean;

  /**
   * Maximum backoff timeout in milliseconds
   */
  maxBackoffTimeout?: number;

  /**
   * Custom user color assignment
   */
  userColors?: UserColor[];

  /**
   * Enable automatic user color assignment
   */
  autoAssignColors?: boolean;

  /**
   * Heartbeat interval for keeping users active (milliseconds)
   */
  heartbeatInterval?: number;

  /**
   * Whether to persist awareness state across sessions
   */
  persistAwareness?: boolean;

  /**
   * Custom awareness instance (optional)
   */
  customAwareness?: Awareness;
}

/**
 * Internal awareness state structure
 */
interface IAwarenessState {
  user: ICollaborativeUser;
  lastActivity: number;
  heartbeatTimer?: any;
  timeoutTimer?: any;
  backoffLevel: number;
}

/**
 * CollaborationAwareness class implementing comprehensive user presence tracking
 */
export class CollaborationAwareness {
  private _awareness: Awareness;
  private _provider: YjsNotebookProvider | null = null;
  private _config: Required<IAwarenessConfig>;
  private _localUserId: string;
  private _userStates: Map<string, IAwarenessState> = new Map();
  private _userColors: Map<string, UserColor> = new Map();
  private _colorIndex: number = 0;
  private _disposed: boolean = false;
  private _isEnabled: boolean = true;

  // Signals for reactive updates
  private _userJoinSignal = new Signal<CollaborationAwareness, ICollaborativeUser>(this);
  private _userLeaveSignal = new Signal<CollaborationAwareness, ICollaborativeUser>(this);

  // Heartbeat management
  private _globalHeartbeatTimer: any = null;

  /**
   * Create a new CollaborationAwareness instance
   */
  constructor(config: IAwarenessConfig = {}) {
    // Initialize configuration with defaults
    this._config = {
      presenceTimeout: config.presenceTimeout ?? DEFAULT_PRESENCE_TIMEOUT_MS,
      exponentialBackoff: config.exponentialBackoff ?? true,
      maxBackoffTimeout: config.maxBackoffTimeout ?? MAX_PRESENCE_BACKOFF_MS,
      userColors: config.userColors ?? Object.values(UserColor),
      autoAssignColors: config.autoAssignColors ?? true,
      heartbeatInterval: config.heartbeatInterval ?? 30000, // 30 seconds
      persistAwareness: config.persistAwareness ?? false,
      customAwareness: config.customAwareness
    };

    // Generate unique user ID
    this._localUserId = UUID.uuid4();

    // Initialize awareness instance
    this._awareness = this._config.customAwareness ?? new Awareness(new Y.Doc());

    // Set up awareness event handlers
    this._setupAwarenessEventHandlers();

    // Start global heartbeat
    this._startGlobalHeartbeat();

    console.log('CollaborationAwareness initialized with user ID:', this._localUserId);
  }

  /**
   * Get the underlying Yjs awareness instance
   */
  get awareness(): Awareness {
    return this._awareness;
  }

  /**
   * Signal emitted when a user joins the session
   */
  get onUserJoin(): Signal<CollaborationAwareness, ICollaborativeUser> {
    return this._userJoinSignal;
  }

  /**
   * Signal emitted when a user leaves the session
   */
  get onUserLeave(): Signal<CollaborationAwareness, ICollaborativeUser> {
    return this._userLeaveSignal;
  }

  /**
   * Get list of all currently active users
   */
  get activeUsers(): ICollaborativeUser[] {
    const users: ICollaborativeUser[] = [];

    for (const [userId, state] of this._userStates) {
      if (state.user.isActive) {
        users.push(state.user);
      }
    }

    return users;
  }

  /**
   * Check if collaboration awareness is enabled
   */
  get isEnabled(): boolean {
    return this._isEnabled && !this._disposed;
  }

  /**
   * Initialize awareness with a collaboration provider
   */
  initializeAwareness(provider: YjsNotebookProvider): void {
    if (this._disposed) {
      throw new Error('Cannot initialize disposed CollaborationAwareness');
    }

    this._provider = provider;

    // Use provider's awareness if available
    if (provider.websocketProvider?.awareness) {
      this._awareness = provider.websocketProvider.awareness;
      this._setupAwarenessEventHandlers();
    }

    // Set initial local user state
    const initialUser: ICollaborativeUser = {
      userId: this._localUserId,
      username: 'Anonymous User',
      displayName: 'Anonymous User',
      avatar: '',
      color: this._assignUserColor(this._localUserId),
      cursorPosition: null,
      selectedCells: [],
      isActive: true,
      lastActivity: new Date()
    };

    this.updateLocalUser(initialUser);

    console.log('CollaborationAwareness initialized with provider');
  }

  /**
   * Update local user information and broadcast to other clients
   */
  updateLocalUser(userUpdates: Partial<ICollaborativeUser>): void {
    if (this._disposed || !this._isEnabled) {
      return;
    }

    try {
      // Get current local state
      const currentState = this._awareness.getLocalState() as any;
      const currentUser = currentState?.user || {};

      // Merge updates with current user data
      const updatedUser: ICollaborativeUser = {
        userId: this._localUserId,
        username: userUpdates.username ?? currentUser.username ?? 'Anonymous User',
        displayName: userUpdates.displayName ?? currentUser.displayName ?? 'Anonymous User',
        avatar: userUpdates.avatar ?? currentUser.avatar ?? '',
        color: userUpdates.color ?? currentUser.color ?? this._assignUserColor(this._localUserId),
        cursorPosition: userUpdates.cursorPosition ?? currentUser.cursorPosition ?? null,
        selectedCells: userUpdates.selectedCells ?? currentUser.selectedCells ?? [],
        isActive: userUpdates.isActive ?? true,
        lastActivity: new Date()
      };

      // Update awareness state
      this._awareness.setLocalStateField('user', updatedUser);
      this._awareness.setLocalStateField('timestamp', Date.now());

      // Update local state tracking
      this._updateUserState(updatedUser);

      console.log('Local user updated:', updatedUser.displayName);
    } catch (error) {
      console.error('Error updating local user:', error);
    }
  }

  /**
   * Get information for a specific user
   */
  getUserInfo(userId: string): ICollaborativeUser | null {
    if (this._disposed) {
      return null;
    }

    const state = this._userStates.get(userId);
    return state?.user ?? null;
  }

  /**
   * Get user information by ID (alias for getUserInfo)
   */
  getUserById(userId: string): ICollaborativeUser | null {
    return this.getUserInfo(userId);
  }

  /**
   * Get all users currently in the session
   */
  getAllUsers(): ICollaborativeUser[] {
    const users: ICollaborativeUser[] = [];

    for (const [userId, state] of this._userStates) {
      users.push(state.user);
    }

    return users;
  }

  /**
   * Get current cursor position for a user
   */
  getCursorPosition(userId: string): { cellId: string; offset: number } | null {
    const userInfo = this.getUserInfo(userId);
    return userInfo?.cursorPosition ?? null;
  }

  /**
   * Get selected cells for a user
   */
  getSelectedCells(userId: string): string[] {
    const userInfo = this.getUserInfo(userId);
    return userInfo?.selectedCells ?? [];
  }

  /**
   * Set presence timeout for inactive user detection
   */
  setPresenceTimeout(timeout: number): void {
    if (timeout <= 0) {
      throw new Error('Presence timeout must be positive');
    }

    this._config.presenceTimeout = timeout;

    // Reset all existing timers with new timeout
    for (const [userId, state] of this._userStates) {
      this._resetUserTimeout(userId, state);
    }

    console.log('Presence timeout updated to:', timeout, 'ms');
  }

  /**
   * Set color for a specific user
   */
  setUserColor(userId: string, color: UserColor): void {
    this._userColors.set(userId, color);

    // Update user state if exists
    const state = this._userStates.get(userId);
    if (state) {
      const updatedUser = { ...state.user, color };

      if (userId === this._localUserId) {
        this.updateLocalUser({ color });
      } else {
        state.user = updatedUser;
      }
    }

    console.log('User color set:', userId, color);
  }

  /**
   * Update cursor position for current user
   */
  updateCursorPosition(cellId: string, offset: number): void {
    if (this._disposed || !this._isEnabled) {
      return;
    }

    const cursorPosition = { cellId, offset };
    this.updateLocalUser({ cursorPosition });
  }

  /**
   * Update selected cells for current user
   */
  updateSelectedCells(cellIds: string[]): void {
    if (this._disposed || !this._isEnabled) {
      return;
    }

    this.updateLocalUser({ selectedCells: [...cellIds] });
  }

  /**
   * Broadcast awareness update to all connected clients
   */
  broadcastAwareness(): void {
    if (this._disposed || !this._isEnabled || !this._provider) {
      return;
    }

    try {
      // Update timestamp to ensure broadcast
      this._awareness.setLocalStateField('timestamp', Date.now());

      // If provider is connected, updates will be automatically broadcast
      if (this._provider.isConnected()) {
        console.log('Awareness update broadcasted');
      } else {
        console.warn('Cannot broadcast awareness - provider not connected');
      }
    } catch (error) {
      console.error('Error broadcasting awareness:', error);
    }
  }

  /**
   * Handle user timeout due to inactivity
   */
  handleTimeout(userId: string): void {
    const state = this._userStates.get(userId);
    if (!state || this._disposed) {
      return;
    }

    // Mark user as inactive
    const inactiveUser: ICollaborativeUser = {
      ...state.user,
      isActive: false,
      lastActivity: new Date()
    };

    // Update state
    state.user = inactiveUser;
    this._userStates.set(userId, state);

    // If this is local user, update awareness
    if (userId === this._localUserId) {
      this._awareness.setLocalStateField('user', inactiveUser);
    }

    console.log('User timed out due to inactivity:', userId);

    // Schedule with exponential backoff if enabled
    if (this._config.exponentialBackoff) {
      this._scheduleTimeoutWithBackoff(userId, state);
    }
  }

  /**
   * Reset timeout timer for a user
   */
  resetTimeout(userId: string): void {
    const state = this._userStates.get(userId);
    if (!state || this._disposed) {
      return;
    }

    // Reset backoff level
    state.backoffLevel = 0;

    // Reset timeout timer
    this._resetUserTimeout(userId, state);

    // Reactivate user if they were inactive
    if (!state.user.isActive) {
      const activeUser: ICollaborativeUser = {
        ...state.user,
        isActive: true,
        lastActivity: new Date()
      };

      state.user = activeUser;
      this._userStates.set(userId, state);

      if (userId === this._localUserId) {
        this._awareness.setLocalStateField('user', activeUser);
      }

      console.log('User timeout reset and reactivated:', userId);
    }
  }

  /**
   * Clean up resources and dispose of the awareness instance
   */
  cleanup(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Clear all timers
    if (this._globalHeartbeatTimer) {
      clearInterval(this._globalHeartbeatTimer);
      this._globalHeartbeatTimer = null;
    }

    for (const [userId, state] of this._userStates) {
      if (state.heartbeatTimer) {
        clearTimeout(state.heartbeatTimer);
      }
      if (state.timeoutTimer) {
        clearTimeout(state.timeoutTimer);
      }
    }

    // Clear collections
    this._userStates.clear();
    this._userColors.clear();

    // Remove awareness event handlers
    this._awareness.off('change', this._handleAwarenessChange);

    // Destroy awareness if we own it
    if (!this._config.customAwareness) {
      this._awareness.destroy();
    }

    console.log('CollaborationAwareness cleaned up');
  }

  /**
   * Set up awareness event handlers for user join/leave detection
   */
  private _setupAwarenessEventHandlers(): void {
    this._awareness.on('change', this._handleAwarenessChange.bind(this));
  }

  /**
   * Handle awareness state changes (users joining/leaving)
   */
  private _handleAwarenessChange(changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void {
    if (this._disposed) {
      return;
    }

    try {
      const states = this._awareness.getStates();

      // Handle new users
      for (const clientId of changes.added) {
        const state = states.get(clientId);
        if (state?.user) {
          this._handleUserJoined(state.user);
        }
      }

      // Handle updated users
      for (const clientId of changes.updated) {
        const state = states.get(clientId);
        if (state?.user) {
          this._handleUserUpdated(state.user);
        }
      }

      // Handle removed users
      for (const clientId of changes.removed) {
        // We need to track user IDs separately since state is gone
        // Find user by client ID in our local tracking
        for (const [userId, userState] of this._userStates) {
          if (userState.user.userId === clientId.toString()) {
            this._handleUserLeft(userState.user);
            break;
          }
        }
      }
    } catch (error) {
      console.error('Error handling awareness change:', error);
    }
  }

  /**
   * Handle when a user joins the session
   */
  private _handleUserJoined(user: ICollaborativeUser): void {
    // Don't track local user in remote tracking
    if (user.userId === this._localUserId) {
      return;
    }

    // Create user state
    const userState: IAwarenessState = {
      user: { ...user },
      lastActivity: Date.now(),
      backoffLevel: 0
    };

    // Assign color if not set
    if (!user.color || user.color === '') {
      userState.user.color = this._assignUserColor(user.userId);
    }

    this._userStates.set(user.userId, userState);

    // Set up timeout for this user
    this._resetUserTimeout(user.userId, userState);

    // Emit signal
    this._userJoinSignal.emit(userState.user);

    console.log('User joined session:', user.displayName, user.userId);
  }

  /**
   * Handle when user information is updated
   */
  private _handleUserUpdated(user: ICollaborativeUser): void {
    const existingState = this._userStates.get(user.userId);
    if (!existingState) {
      // Treat as new user
      this._handleUserJoined(user);
      return;
    }

    // Update user information
    existingState.user = { ...user };
    existingState.lastActivity = Date.now();

    // Reset timeout
    this._resetUserTimeout(user.userId, existingState);

    console.log('User updated:', user.displayName);
  }

  /**
   * Handle when a user leaves the session
   */
  private _handleUserLeft(user: ICollaborativeUser): void {
    const state = this._userStates.get(user.userId);
    if (!state) {
      return;
    }

    // Clean up timers
    if (state.heartbeatTimer) {
      clearTimeout(state.heartbeatTimer);
    }
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
    }

    // Remove from tracking
    this._userStates.delete(user.userId);
    this._userColors.delete(user.userId);

    // Emit signal
    this._userLeaveSignal.emit(user);

    console.log('User left session:', user.displayName, user.userId);
  }

  /**
   * Update user state in local tracking
   */
  private _updateUserState(user: ICollaborativeUser): void {
    let state = this._userStates.get(user.userId);

    if (!state) {
      state = {
        user,
        lastActivity: Date.now(),
        backoffLevel: 0
      };
      this._userStates.set(user.userId, state);
    } else {
      state.user = user;
      state.lastActivity = Date.now();
    }

    // Reset timeout for activity
    this._resetUserTimeout(user.userId, state);
  }

  /**
   * Assign a color to a user automatically
   */
  private _assignUserColor(userId: string): UserColor {
    // Check if user already has assigned color
    const existingColor = this._userColors.get(userId);
    if (existingColor) {
      return existingColor;
    }

    if (!this._config.autoAssignColors) {
      return UserColor.GRAY;
    }

    // Assign next color in rotation
    const color = this._config.userColors[this._colorIndex % this._config.userColors.length];
    this._colorIndex++;

    this._userColors.set(userId, color);
    return color;
  }

  /**
   * Reset timeout timer for a specific user
   */
  private _resetUserTimeout(userId: string, state: IAwarenessState): void {
    // Clear existing timer
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
    }

    // Calculate timeout with exponential backoff
    let timeout = this._config.presenceTimeout;
    if (this._config.exponentialBackoff && state.backoffLevel > 0) {
      timeout = Math.min(
        timeout * Math.pow(2, state.backoffLevel),
        this._config.maxBackoffTimeout
      );
    }

    // Set new timeout
    state.timeoutTimer = setTimeout(() => {
      this.handleTimeout(userId);
    }, timeout);
  }

  /**
   * Schedule timeout with exponential backoff
   */
  private _scheduleTimeoutWithBackoff(userId: string, state: IAwarenessState): void {
    state.backoffLevel++;
    this._resetUserTimeout(userId, state);
  }

  /**
   * Start global heartbeat to keep local user active
   */
  private _startGlobalHeartbeat(): void {
    if (this._globalHeartbeatTimer) {
      clearInterval(this._globalHeartbeatTimer);
    }

    this._globalHeartbeatTimer = setInterval(() => {
      if (!this._disposed && this._isEnabled) {
        // Update local user's last activity
        this.updateLocalUser({ lastActivity: new Date() });
      }
    }, this._config.heartbeatInterval);
  }
}
