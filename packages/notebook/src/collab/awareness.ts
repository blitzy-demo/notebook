// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { IDisposable, DisposableDelegate } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signals';
import { Awareness } from 'y-protocols/awareness';
import { encoding, decoding } from 'lib0';
import * as Y from 'yjs';

/**
 * Interface for user presence information
 */
export interface IUserPresence {
  /**
   * Unique user identifier
   */
  userId: string;

  /**
   * Display name for the user
   */
  displayName: string;

  /**
   * User avatar URL (optional)
   */
  avatar?: string;

  /**
   * Assigned color for user indicators
   */
  color: string;

  /**
   * Current cursor position in the active cell
   */
  cursor?: {
    cellId: string;
    line: number;
    column: number;
  };

  /**
   * Current text selection in the active cell
   */
  selection?: {
    cellId: string;
    start: { line: number; column: number };
    end: { line: number; column: number };
  };

  /**
   * Currently active cell
   */
  activeCell?: string;

  /**
   * User activity status
   */
  status: 'active' | 'idle' | 'typing';

  /**
   * Timestamp of last activity
   */
  lastActivity: number;

  /**
   * Whether user is currently typing
   */
  isTyping: boolean;

  /**
   * Permission level for this user
   */
  permission: 'view' | 'edit' | 'admin';
}

/**
 * Interface for notebook-specific awareness state
 */
export interface IAwarenessState {
  /**
   * User presence information
   */
  user: IUserPresence;

  /**
   * Additional metadata for notebook context
   */
  metadata?: {
    /**
     * Notebook path or identifier
     */
    notebookPath?: string;

    /**
     * Session identifier
     */
    sessionId?: string;

    /**
     * Browser/client information
     */
    clientInfo?: {
      userAgent: string;
      platform: string;
    };
  };
}

/**
 * Configuration options for awareness system
 */
export interface IAwarenessConfig {
  /**
   * Current user information
   */
  user: {
    id: string;
    name: string;
    avatar?: string;
  };

  /**
   * User permission level
   */
  permission: 'view' | 'edit' | 'admin';

  /**
   * Timeout for considering user inactive (ms)
   */
  inactivityTimeout?: number;

  /**
   * Timeout for typing indicator (ms)
   */
  typingTimeout?: number;

  /**
   * Maximum number of users to track
   */
  maxUsers?: number;

  /**
   * Color palette for user indicators
   */
  userColors?: string[];
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<Omit<IAwarenessConfig, 'user' | 'permission'>> = {
  inactivityTimeout: 300000, // 5 minutes
  typingTimeout: 3000, // 3 seconds
  maxUsers: 50,
  userColors: [
    '#e57373', '#f06292', '#ba68c8', '#9575cd',
    '#7986cb', '#64b5f6', '#4fc3f7', '#4dd0e1',
    '#4db6ac', '#81c784', '#aed581', '#dce775',
    '#fff176', '#ffb74d', '#ff8a65', '#a1887f',
    '#90a4ae', '#ff5722', '#795548', '#607d8b'
  ]
};

/**
 * Notebook-specific awareness system implementation
 * 
 * Extends Yjs awareness protocol with notebook-specific user presence data,
 * manages real-time cursor positions, cell selections, and user status indicators
 * for collaborative editing visualization.
 */
export class NotebookAwareness implements IDisposable {
  private _isDisposed = false;
  private _awareness: Awareness;
  private _config: Required<IAwarenessConfig>;
  private _currentState: IAwarenessState | null = null;
  private _remoteUsers = new Map<number, IUserPresence>();
  private _userColors = new Map<string, string>();
  private _activityTimer: number | null = null;
  private _typingTimer: number | null = null;
  private _colorIndex = 0;

  // Signals
  private _userJoined = new Signal<this, IUserPresence>(this);
  private _userLeft = new Signal<this, string>(this);
  private _userChanged = new Signal<this, IUserPresence>(this);
  private _cursorMoved = new Signal<this, { userId: string; cursor: IUserPresence['cursor'] }>(this);
  private _selectionChanged = new Signal<this, { userId: string; selection: IUserPresence['selection'] }>(this);
  private _activeCellChanged = new Signal<this, { userId: string; cellId: string | undefined }>(this);
  private _typingStatusChanged = new Signal<this, { userId: string; isTyping: boolean }>(this);

  /**
   * Create a new NotebookAwareness instance
   */
  constructor(ydoc: Y.Doc, config: IAwarenessConfig) {
    this._awareness = new Awareness(ydoc);
    this._config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize user color assignment
    this._assignUserColor(this._config.user.id);
    
    // Set up awareness event handlers
    this._awareness.on('change', this._onAwarenessChange.bind(this));
    this._awareness.on('update', this._onAwarenessUpdate.bind(this));

    // Initialize current user state
    this._initializeCurrentUser();

    // Start activity monitoring
    this._startActivityMonitoring();
  }

  /**
   * Whether the awareness system is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * The underlying Yjs awareness instance
   */
  get awareness(): Awareness {
    return this._awareness;
  }

  /**
   * Current user's awareness state
   */
  get currentState(): IAwarenessState | null {
    return this._currentState;
  }

  /**
   * Map of remote users and their presence information
   */
  get remoteUsers(): ReadonlyMap<number, IUserPresence> {
    return this._remoteUsers;
  }

  /**
   * Signal emitted when a user joins the collaborative session
   */
  get userJoined(): ISignal<this, IUserPresence> {
    return this._userJoined;
  }

  /**
   * Signal emitted when a user leaves the collaborative session
   */
  get userLeft(): ISignal<this, string> {
    return this._userLeft;
  }

  /**
   * Signal emitted when a user's presence information changes
   */
  get userChanged(): ISignal<this, IUserPresence> {
    return this._userChanged;
  }

  /**
   * Signal emitted when a user's cursor position changes
   */
  get cursorMoved(): ISignal<this, { userId: string; cursor: IUserPresence['cursor'] }> {
    return this._cursorMoved;
  }

  /**
   * Signal emitted when a user's text selection changes
   */
  get selectionChanged(): ISignal<this, { userId: string; selection: IUserPresence['selection'] }> {
    return this._selectionChanged;
  }

  /**
   * Signal emitted when a user's active cell changes
   */
  get activeCellChanged(): ISignal<this, { userId: string; cellId: string | undefined }> {
    return this._activeCellChanged;
  }

  /**
   * Signal emitted when a user's typing status changes
   */
  get typingStatusChanged(): ISignal<this, { userId: string; isTyping: boolean }> {
    return this._typingStatusChanged;
  }

  /**
   * Update the current user's cursor position
   */
  updateCursor(cellId: string, line: number, column: number): void {
    if (this._isDisposed) {
      return;
    }

    const cursor = { cellId, line, column };
    this._updateCurrentState({ cursor });
    this._recordActivity();
  }

  /**
   * Update the current user's text selection
   */
  updateSelection(
    cellId: string,
    start: { line: number; column: number },
    end: { line: number; column: number }
  ): void {
    if (this._isDisposed) {
      return;
    }

    const selection = { cellId, start, end };
    this._updateCurrentState({ selection });
    this._recordActivity();
  }

  /**
   * Update the current user's active cell
   */
  updateActiveCell(cellId: string | undefined): void {
    if (this._isDisposed) {
      return;
    }

    this._updateCurrentState({ activeCell: cellId });
    this._recordActivity();
  }

  /**
   * Mark the current user as typing
   */
  setTyping(isTyping: boolean): void {
    if (this._isDisposed) {
      return;
    }

    this._updateCurrentState({ 
      isTyping,
      status: isTyping ? 'typing' : 'active'
    });

    // Reset typing timeout
    if (this._typingTimer) {
      clearTimeout(this._typingTimer);
    }

    if (isTyping) {
      this._typingTimer = window.setTimeout(() => {
        this.setTyping(false);
      }, this._config.typingTimeout);
    }

    this._recordActivity();
  }

  /**
   * Get a user's assigned color
   */
  getUserColor(userId: string): string {
    return this._userColors.get(userId) || this._config.userColors[0];
  }

  /**
   * Get all active users (including current user)
   */
  getAllUsers(): IUserPresence[] {
    const users: IUserPresence[] = [];
    
    if (this._currentState) {
      users.push(this._currentState.user);
    }
    
    for (const user of this._remoteUsers.values()) {
      users.push(user);
    }
    
    return users;
  }

  /**
   * Dispose of the awareness system
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;

    // Clear timers
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
    }
    if (this._typingTimer) {
      clearTimeout(this._typingTimer);
    }

    // Remove awareness listeners
    this._awareness.off('change', this._onAwarenessChange.bind(this));
    this._awareness.off('update', this._onAwarenessUpdate.bind(this));

    // Clear awareness state
    this._awareness.setLocalState(null);

    // Clear internal state
    this._remoteUsers.clear();
    this._userColors.clear();
    this._currentState = null;

    // Clear signals
    Signal.clearData(this);
  }

  /**
   * Initialize the current user's awareness state
   */
  private _initializeCurrentUser(): void {
    const userColor = this._assignUserColor(this._config.user.id);
    
    this._currentState = {
      user: {
        userId: this._config.user.id,
        displayName: this._config.user.name,
        avatar: this._config.user.avatar,
        color: userColor,
        status: 'active',
        lastActivity: Date.now(),
        isTyping: false,
        permission: this._config.permission
      }
    };

    // Set initial awareness state
    this._awareness.setLocalState(this._encodeAwarenessState(this._currentState));
  }

  /**
   * Update the current user's state
   */
  private _updateCurrentState(updates: Partial<IUserPresence>): void {
    if (!this._currentState) {
      return;
    }

    // Update user properties
    Object.assign(this._currentState.user, updates, {
      lastActivity: Date.now()
    });

    // Broadcast updated state
    this._awareness.setLocalState(this._encodeAwarenessState(this._currentState));
  }

  /**
   * Record user activity and reset idle timer
   */
  private _recordActivity(): void {
    // Update activity status
    if (this._currentState && this._currentState.user.status === 'idle') {
      this._updateCurrentState({ status: 'active' });
    }

    // Reset activity timer
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
    }

    this._activityTimer = window.setTimeout(() => {
      if (this._currentState && !this._isDisposed) {
        this._updateCurrentState({ status: 'idle' });
      }
    }, this._config.inactivityTimeout);
  }

  /**
   * Start monitoring user activity
   */
  private _startActivityMonitoring(): void {
    this._recordActivity();
  }

  /**
   * Assign a color to a user
   */
  private _assignUserColor(userId: string): string {
    if (this._userColors.has(userId)) {
      return this._userColors.get(userId)!;
    }

    const color = this._config.userColors[this._colorIndex % this._config.userColors.length];
    this._userColors.set(userId, color);
    this._colorIndex++;

    return color;
  }

  /**
   * Handle awareness changes (users joining/leaving)
   */
  private _onAwarenessChange(changes: { added: number[]; updated: number[]; removed: number[] }): void {
    if (this._isDisposed) {
      return;
    }

    // Handle removed users
    for (const clientId of changes.removed) {
      const user = this._remoteUsers.get(clientId);
      if (user) {
        this._remoteUsers.delete(clientId);
        this._userLeft.emit(user.userId);
      }
    }

    // Handle added and updated users
    for (const clientId of [...changes.added, ...changes.updated]) {
      // Skip local client
      if (clientId === this._awareness.clientID) {
        continue;
      }

      const state = this._awareness.getStates().get(clientId);
      if (state) {
        const awarenessState = this._decodeAwarenessState(state);
        if (awarenessState) {
          const wasNew = !this._remoteUsers.has(clientId);
          const previousUser = this._remoteUsers.get(clientId);
          
          // Assign color if new user
          if (wasNew) {
            awarenessState.user.color = this._assignUserColor(awarenessState.user.userId);
          }

          this._remoteUsers.set(clientId, awarenessState.user);

          if (wasNew) {
            this._userJoined.emit(awarenessState.user);
          } else {
            this._userChanged.emit(awarenessState.user);
            
            // Emit specific change signals
            if (previousUser) {
              if (previousUser.cursor !== awarenessState.user.cursor) {
                this._cursorMoved.emit({
                  userId: awarenessState.user.userId,
                  cursor: awarenessState.user.cursor
                });
              }
              
              if (previousUser.selection !== awarenessState.user.selection) {
                this._selectionChanged.emit({
                  userId: awarenessState.user.userId,
                  selection: awarenessState.user.selection
                });
              }
              
              if (previousUser.activeCell !== awarenessState.user.activeCell) {
                this._activeCellChanged.emit({
                  userId: awarenessState.user.userId,
                  cellId: awarenessState.user.activeCell
                });
              }
              
              if (previousUser.isTyping !== awarenessState.user.isTyping) {
                this._typingStatusChanged.emit({
                  userId: awarenessState.user.userId,
                  isTyping: awarenessState.user.isTyping
                });
              }
            }
          }
        }
      }
    }

    // Cleanup inactive users
    this._cleanupInactiveUsers();
  }

  /**
   * Handle awareness updates (state synchronization)
   */
  private _onAwarenessUpdate(update: Uint8Array, origin: any): void {
    // This is called when awareness state is synchronized
    // The actual processing is handled in _onAwarenessChange
  }

  /**
   * Encode awareness state for transmission
   */
  private _encodeAwarenessState(state: IAwarenessState): any {
    return {
      user: {
        userId: state.user.userId,
        displayName: state.user.displayName,
        avatar: state.user.avatar,
        color: state.user.color,
        cursor: state.user.cursor,
        selection: state.user.selection,
        activeCell: state.user.activeCell,
        status: state.user.status,
        lastActivity: state.user.lastActivity,
        isTyping: state.user.isTyping,
        permission: state.user.permission
      },
      metadata: state.metadata
    };
  }

  /**
   * Decode awareness state from transmission
   */
  private _decodeAwarenessState(encodedState: any): IAwarenessState | null {
    try {
      if (!encodedState || !encodedState.user) {
        return null;
      }

      return {
        user: {
          userId: encodedState.user.userId,
          displayName: encodedState.user.displayName,
          avatar: encodedState.user.avatar,
          color: encodedState.user.color || '#000000',
          cursor: encodedState.user.cursor,
          selection: encodedState.user.selection,
          activeCell: encodedState.user.activeCell,
          status: encodedState.user.status || 'active',
          lastActivity: encodedState.user.lastActivity || Date.now(),
          isTyping: encodedState.user.isTyping || false,
          permission: encodedState.user.permission || 'view'
        },
        metadata: encodedState.metadata
      };
    } catch (error) {
      console.warn('Failed to decode awareness state:', error);
      return null;
    }
  }

  /**
   * Remove users that have been inactive for too long
   */
  private _cleanupInactiveUsers(): void {
    const now = Date.now();
    const threshold = this._config.inactivityTimeout * 2; // Double the inactivity timeout for cleanup

    for (const [clientId, user] of this._remoteUsers.entries()) {
      if (now - user.lastActivity > threshold) {
        this._remoteUsers.delete(clientId);
        this._userLeft.emit(user.userId);
      }
    }
  }
}

/**
 * Create a new NotebookAwareness instance
 */
export function createNotebookAwareness(
  ydoc: Y.Doc,
  config: IAwarenessConfig
): NotebookAwareness {
  return new NotebookAwareness(ydoc, config);
}

/**
 * Utility function to generate user colors based on user ID
 */
export function generateUserColor(userId: string, colors: string[]): string {
  // Use a simple hash function to deterministically assign colors
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

/**
 * Utility function to check if two cursor positions are equal
 */
export function isCursorEqual(
  a: IUserPresence['cursor'],
  b: IUserPresence['cursor']
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  
  return (
    a.cellId === b.cellId &&
    a.line === b.line &&
    a.column === b.column
  );
}

/**
 * Utility function to check if two selections are equal
 */
export function isSelectionEqual(
  a: IUserPresence['selection'],
  b: IUserPresence['selection']
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  
  return (
    a.cellId === b.cellId &&
    a.start.line === b.start.line &&
    a.start.column === b.start.column &&
    a.end.line === b.end.line &&
    a.end.column === b.end.column
  );
}