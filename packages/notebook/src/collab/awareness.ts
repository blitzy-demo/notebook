// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * User presence and awareness system for real-time collaborative editing.
 * 
 * This module provides comprehensive tracking and visualization of active collaborators,
 * cursor positions, and cell-level editing indicators using the Yjs awareness API.
 * Enables real-time coordination between multiple users editing the same notebook.
 */

import { IDisposable } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';
import { UUID } from '@lumino/coreutils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

// Yjs collaboration imports
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

/**
 * Interface representing cursor position within a cell
 */
export interface ICursorPosition {
  /**
   * Line number within the cell (0-based)
   */
  line: number;

  /**
   * Column position within the line (0-based)
   */
  column: number;

  /**
   * Character offset from beginning of cell content
   */
  offset?: number;
}

/**
 * Interface representing text selection within a cell
 */
export interface ITextSelection {
  /**
   * Start position of selection
   */
  start: ICursorPosition;

  /**
   * End position of selection
   */
  end: ICursorPosition;

  /**
   * Selected text content
   */
  text?: string;
}

/**
 * Enumeration of user activity states
 */
export enum UserActivityState {
  /**
   * User is actively editing
   */
  Active = 'active',

  /**
   * User is viewing/navigating
   */
  Idle = 'idle',

  /**
   * User is temporarily away
   */
  Away = 'away',

  /**
   * User is disconnected
   */
  Offline = 'offline'
}

/**
 * Interface representing a user's presence information
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
   * User's email address (optional)
   */
  email?: string;

  /**
   * URL to user's avatar image (optional)
   */
  avatarUrl?: string;

  /**
   * User-specific color for UI indicators
   */
  color: string;

  /**
   * Current activity state
   */
  activityState: UserActivityState;

  /**
   * Timestamp of last activity
   */
  lastActivity: Date;

  /**
   * ID of cell currently being edited (if any)
   */
  currentCellId?: string;

  /**
   * Current cursor position within the cell
   */
  cursorPosition?: ICursorPosition;

  /**
   * Current text selection (if any)
   */
  selection?: ITextSelection;

  /**
   * Additional metadata for the user
   */
  metadata?: Record<string, any>;
}

/**
 * Interface for user position change events
 */
export interface IUserPositionChange {
  /**
   * User whose position changed
   */
  user: IUserPresence;

  /**
   * ID of the cell the user moved to
   */
  cellId: string;

  /**
   * Previous cell ID (if any)
   */
  previousCellId?: string;

  /**
   * New cursor position
   */
  position?: ICursorPosition;

  /**
   * New selection (if any)
   */
  selection?: ITextSelection;
}

/**
 * Interface for managing user color assignments
 */
export interface IUserColorManager extends IDisposable {
  /**
   * Assign a color to a user
   * 
   * @param userId - The user ID to assign a color to
   * @returns The assigned color string
   */
  assignColor(userId: string): string;

  /**
   * Get the color assigned to a user
   * 
   * @param userId - The user ID to get the color for
   * @returns The assigned color string, or undefined if not assigned
   */
  getColor(userId: string): string | undefined;

  /**
   * Release a color assignment for a user
   * 
   * @param userId - The user ID to release the color for
   */
  releaseColor(userId: string): void;

  /**
   * Get all available colors
   * 
   * @returns Array of available color strings
   */
  getAvailableColors(): string[];

  /**
   * Reset all color assignments
   */
  resetColors(): void;

  /**
   * Signal emitted when a color assignment changes
   */
  readonly colorChanged: ISignal<this, { userId: string; color: string }>;
}

/**
 * Interface for tracking user presence and awareness
 */
export interface IPresenceTracker extends IDisposable {
  /**
   * The current user's presence information
   */
  readonly currentUser: IUserPresence | null;

  /**
   * Array of all active users
   */
  readonly activeUsers: IUserPresence[];

  /**
   * Total number of active users
   */
  readonly userCount: number;

  /**
   * Whether the tracker is currently connected
   */
  readonly isConnected: boolean;

  /**
   * Initialize the presence tracker with a Yjs awareness instance
   * 
   * @param awareness - The Yjs awareness instance
   * @param currentUserInfo - Information about the current user
   */
  initialize(awareness: Awareness, currentUserInfo: Partial<IUserPresence>): void;

  /**
   * Update the current user's presence information
   * 
   * @param presence - Partial presence information to update
   */
  updateUserPresence(presence: Partial<IUserPresence>): void;

  /**
   * Update the current user's cursor position
   * 
   * @param cellId - ID of the cell being edited
   * @param position - Cursor position within the cell
   * @param selection - Text selection (optional)
   */
  updateCursorPosition(cellId: string, position: ICursorPosition, selection?: ITextSelection): void;

  /**
   * Update the current user's activity state
   * 
   * @param state - New activity state
   */
  updateActivityState(state: UserActivityState): void;

  /**
   * Get presence information for a specific user
   * 
   * @param userId - The user ID to get presence for
   * @returns User presence information or null if not found
   */
  getUserPresence(userId: string): IUserPresence | null;

  /**
   * Get all users currently in a specific cell
   * 
   * @param cellId - The cell ID to check
   * @returns Array of users present in the cell
   */
  getUsersInCell(cellId: string): IUserPresence[];

  /**
   * Signal emitted when the list of active users changes
   */
  readonly usersChanged: ISignal<this, IUserPresence[]>;

  /**
   * Signal emitted when a user's position changes
   */
  readonly userPositionChanged: ISignal<this, IUserPositionChange>;

  /**
   * Signal emitted when a user's activity state changes
   */
  readonly userActivityChanged: ISignal<this, { user: IUserPresence; previousState: UserActivityState }>;

  /**
   * Signal emitted when connection status changes
   */
  readonly connectionChanged: ISignal<this, boolean>;
}

/**
 * Interface for coordinating awareness updates across collaboration components
 */
export interface IAwarenessRegistry extends IDisposable {
  /**
   * Register a presence tracker with the registry
   * 
   * @param tracker - The presence tracker to register
   */
  registerTracker(tracker: IPresenceTracker): void;

  /**
   * Unregister a presence tracker from the registry
   * 
   * @param tracker - The presence tracker to unregister
   */
  unregisterTracker(tracker: IPresenceTracker): void;

  /**
   * Get the primary presence tracker
   * 
   * @returns The primary tracker or null if none registered
   */
  getPrimaryTracker(): IPresenceTracker | null;

  /**
   * Broadcast a presence update to all registered trackers
   * 
   * @param presence - Presence information to broadcast
   */
  broadcastPresenceUpdate(presence: Partial<IUserPresence>): void;

  /**
   * Broadcast a cursor position update to all registered trackers
   * 
   * @param cellId - ID of the cell
   * @param position - Cursor position
   * @param selection - Text selection (optional)
   */
  broadcastCursorUpdate(cellId: string, position: ICursorPosition, selection?: ITextSelection): void;

  /**
   * Signal emitted when presence information is updated
   */
  readonly presenceUpdated: ISignal<this, IUserPresence>;

  /**
   * Signal emitted when cursor position is updated
   */
  readonly cursorUpdated: ISignal<this, IUserPositionChange>;
}

/**
 * Default color palette for user assignments
 */
const DEFAULT_USER_COLORS = [
  '#FF6B6B', // Red
  '#4ECDC4', // Teal
  '#45B7D1', // Blue
  '#96CEB4', // Green
  '#FFEAA7', // Yellow
  '#DDA0DD', // Plum
  '#98D8C8', // Mint
  '#F7DC6F', // Light Yellow
  '#BB8FCE', // Light Purple
  '#85C1E9', // Light Blue
  '#82E0AA', // Light Green
  '#F8C471', // Light Orange
  '#EC7063', // Light Red
  '#AED6F1', // Pale Blue
  '#A9DFBF', // Pale Green
  '#F9E79F'  // Pale Yellow
];

/**
 * User color manager implementation
 */
export class UserColorManager implements IUserColorManager {
  private _colorAssignments = new Map<string, string>();
  private _availableColors = [...DEFAULT_USER_COLORS];
  private _usedColors = new Set<string>();
  private _colorChanged = new Signal<this, { userId: string; color: string }>(this);
  private _isDisposed = false;

  /**
   * Create a new user color manager
   * 
   * @param customColors - Optional custom color palette
   */
  constructor(customColors?: string[]) {
    if (customColors && customColors.length > 0) {
      this._availableColors = [...customColors];
    }
  }

  /**
   * Assign a color to a user
   */
  assignColor(userId: string): string {
    // Return existing color if already assigned
    const existingColor = this._colorAssignments.get(userId);
    if (existingColor) {
      return existingColor;
    }

    // Find next available color
    let color: string;
    const availableColors = this._availableColors.filter(c => !this._usedColors.has(c));
    
    if (availableColors.length > 0) {
      // Use next available color
      color = availableColors[0];
    } else {
      // Generate a random color if all predefined colors are used
      color = this._generateRandomColor();
    }

    this._colorAssignments.set(userId, color);
    this._usedColors.add(color);
    this._colorChanged.emit({ userId, color });

    return color;
  }

  /**
   * Get the color assigned to a user
   */
  getColor(userId: string): string | undefined {
    return this._colorAssignments.get(userId);
  }

  /**
   * Release a color assignment for a user
   */
  releaseColor(userId: string): void {
    const color = this._colorAssignments.get(userId);
    if (color) {
      this._colorAssignments.delete(userId);
      this._usedColors.delete(color);
      this._colorChanged.emit({ userId, color: '' });
    }
  }

  /**
   * Get all available colors
   */
  getAvailableColors(): string[] {
    return [...this._availableColors];
  }

  /**
   * Reset all color assignments
   */
  resetColors(): void {
    const userIds = Array.from(this._colorAssignments.keys());
    this._colorAssignments.clear();
    this._usedColors.clear();
    
    userIds.forEach(userId => {
      this._colorChanged.emit({ userId, color: '' });
    });
  }

  /**
   * Signal emitted when a color assignment changes
   */
  get colorChanged(): ISignal<this, { userId: string; color: string }> {
    return this._colorChanged;
  }

  /**
   * Test whether the color manager is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the color manager
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this.resetColors();
    Signal.clearData(this);
  }

  /**
   * Generate a random color for overflow cases
   */
  private _generateRandomColor(): string {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 60 + Math.floor(Math.random() * 30); // 60-90%
    const lightness = 50 + Math.floor(Math.random() * 20);  // 50-70%
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }
}

/**
 * Presence tracker implementation using Yjs awareness
 */
export class PresenceTracker implements IPresenceTracker {
  private _awareness: Awareness | null = null;
  private _currentUser: IUserPresence | null = null;
  private _activeUsers: IUserPresence[] = [];
  private _colorManager: IUserColorManager;
  private _translator: ITranslator;
  private _isConnected = false;
  private _isDisposed = false;
  private _activityTimer: number | null = null;

  // Signals
  private _usersChanged = new Signal<this, IUserPresence[]>(this);
  private _userPositionChanged = new Signal<this, IUserPositionChange>(this);
  private _userActivityChanged = new Signal<this, { user: IUserPresence; previousState: UserActivityState }>(this);
  private _connectionChanged = new Signal<this, boolean>(this);

  /**
   * Create a new presence tracker
   * 
   * @param colorManager - User color manager instance
   * @param translator - Translator for internationalization
   */
  constructor(colorManager?: IUserColorManager, translator?: ITranslator) {
    this._colorManager = colorManager || new UserColorManager();
    this._translator = translator || nullTranslator;
  }

  /**
   * The current user's presence information
   */
  get currentUser(): IUserPresence | null {
    return this._currentUser;
  }

  /**
   * Array of all active users
   */
  get activeUsers(): IUserPresence[] {
    return [...this._activeUsers];
  }

  /**
   * Total number of active users
   */
  get userCount(): number {
    return this._activeUsers.length;
  }

  /**
   * Whether the tracker is currently connected
   */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Initialize the presence tracker with a Yjs awareness instance
   */
  initialize(awareness: Awareness, currentUserInfo: Partial<IUserPresence>): void {
    this._awareness = awareness;
    
    // Create current user presence
    const userId = currentUserInfo.userId || UUID.uuid4();
    const color = this._colorManager.assignColor(userId);
    
    this._currentUser = {
      userId,
      displayName: currentUserInfo.displayName || 'Anonymous User',
      email: currentUserInfo.email,
      avatarUrl: currentUserInfo.avatarUrl,
      color,
      activityState: UserActivityState.Active,
      lastActivity: new Date(),
      metadata: currentUserInfo.metadata || {}
    };

    // Set local awareness state
    awareness.setLocalState(this._serializePresence(this._currentUser));

    // Listen for awareness changes
    awareness.on('change', this._handleAwarenessChange.bind(this));
    awareness.on('update', this._handleAwarenessUpdate.bind(this));

    // Initialize connection status
    this._updateConnectionStatus(true);

    // Setup activity monitoring
    this._setupActivityMonitoring();

    // Initial user list update
    this._updateActiveUsers();
  }

  /**
   * Update the current user's presence information
   */
  updateUserPresence(presence: Partial<IUserPresence>): void {
    if (!this._currentUser || !this._awareness) {
      return;
    }

    // Update current user object
    const previousState = this._currentUser.activityState;
    this._currentUser = {
      ...this._currentUser,
      ...presence,
      lastActivity: new Date()
    };

    // Update awareness state
    this._awareness.setLocalState(this._serializePresence(this._currentUser));

    // Emit activity change signal if state changed
    if (presence.activityState && presence.activityState !== previousState) {
      this._userActivityChanged.emit({
        user: this._currentUser,
        previousState
      });
    }
  }

  /**
   * Update the current user's cursor position
   */
  updateCursorPosition(cellId: string, position: ICursorPosition, selection?: ITextSelection): void {
    if (!this._currentUser || !this._awareness) {
      return;
    }

    const previousCellId = this._currentUser.currentCellId;
    
    // Update current user presence
    this._currentUser = {
      ...this._currentUser,
      currentCellId: cellId,
      cursorPosition: position,
      selection,
      lastActivity: new Date(),
      activityState: UserActivityState.Active
    };

    // Update awareness state
    this._awareness.setLocalState(this._serializePresence(this._currentUser));

    // Emit position change signal
    this._userPositionChanged.emit({
      user: this._currentUser,
      cellId,
      previousCellId,
      position,
      selection
    });

    // Reset activity timer
    this._resetActivityTimer();
  }

  /**
   * Update the current user's activity state
   */
  updateActivityState(state: UserActivityState): void {
    if (!this._currentUser) {
      return;
    }

    const previousState = this._currentUser.activityState;
    this.updateUserPresence({ activityState: state });

    if (state !== previousState) {
      this._userActivityChanged.emit({
        user: this._currentUser,
        previousState
      });
    }
  }

  /**
   * Get presence information for a specific user
   */
  getUserPresence(userId: string): IUserPresence | null {
    return this._activeUsers.find(user => user.userId === userId) || null;
  }

  /**
   * Get all users currently in a specific cell
   */
  getUsersInCell(cellId: string): IUserPresence[] {
    return this._activeUsers.filter(user => user.currentCellId === cellId);
  }

  /**
   * Signal emitted when the list of active users changes
   */
  get usersChanged(): ISignal<this, IUserPresence[]> {
    return this._usersChanged;
  }

  /**
   * Signal emitted when a user's position changes
   */
  get userPositionChanged(): ISignal<this, IUserPositionChange> {
    return this._userPositionChanged;
  }

  /**
   * Signal emitted when a user's activity state changes
   */
  get userActivityChanged(): ISignal<this, { user: IUserPresence; previousState: UserActivityState }> {
    return this._userActivityChanged;
  }

  /**
   * Signal emitted when connection status changes
   */
  get connectionChanged(): ISignal<this, boolean> {
    return this._connectionChanged;
  }

  /**
   * Test whether the tracker is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the presence tracker
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;

    // Clear activity timer
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
    }

    // Disconnect from awareness
    if (this._awareness && this._currentUser) {
      this._awareness.setLocalState(null);
    }

    // Dispose color manager if we own it
    if (this._colorManager && !this._colorManager.isDisposed) {
      this._colorManager.dispose();
    }

    Signal.clearData(this);
  }

  /**
   * Handle awareness changes
   */
  private _handleAwarenessChange(changes: any): void {
    this._updateActiveUsers();
    
    // Check for position changes
    changes.updated.forEach((clientId: number) => {
      const user = this._deserializePresence(this._awareness!.getStates().get(clientId));
      if (user && user.userId !== this._currentUser?.userId) {
        // Emit position change for other users
        this._userPositionChanged.emit({
          user,
          cellId: user.currentCellId || '',
          position: user.cursorPosition,
          selection: user.selection
        });
      }
    });
  }

  /**
   * Handle awareness updates
   */
  private _handleAwarenessUpdate(): void {
    this._updateActiveUsers();
  }

  /**
   * Update the list of active users from awareness states
   */
  private _updateActiveUsers(): void {
    if (!this._awareness) {
      return;
    }

    const states = this._awareness.getStates();
    const users: IUserPresence[] = [];
    
    states.forEach((state, clientId) => {
      const user = this._deserializePresence(state);
      if (user) {
        // Assign color if not already assigned
        if (!user.color) {
          user.color = this._colorManager.assignColor(user.userId);
        }
        users.push(user);
      }
    });

    // Sort users by last activity (most recent first)
    users.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

    this._activeUsers = users;
    this._usersChanged.emit(users);
  }

  /**
   * Update connection status
   */
  private _updateConnectionStatus(connected: boolean): void {
    if (this._isConnected !== connected) {
      this._isConnected = connected;
      this._connectionChanged.emit(connected);
    }
  }

  /**
   * Setup activity monitoring to auto-update user state
   */
  private _setupActivityMonitoring(): void {
    // Monitor user activity and auto-set to idle after inactivity
    this._resetActivityTimer();

    // Listen for user interactions to reset activity
    document.addEventListener('mousemove', this._handleUserActivity.bind(this));
    document.addEventListener('keydown', this._handleUserActivity.bind(this));
    document.addEventListener('click', this._handleUserActivity.bind(this));
  }

  /**
   * Handle user activity events
   */
  private _handleUserActivity(): void {
    if (this._currentUser?.activityState === UserActivityState.Idle) {
      this.updateActivityState(UserActivityState.Active);
    }
    this._resetActivityTimer();
  }

  /**
   * Reset the activity timer
   */
  private _resetActivityTimer(): void {
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
    }

    // Set user to idle after 30 seconds of inactivity
    this._activityTimer = window.setTimeout(() => {
      if (this._currentUser?.activityState === UserActivityState.Active) {
        this.updateActivityState(UserActivityState.Idle);
      }
    }, 30000);
  }

  /**
   * Serialize presence information for awareness state
   */
  private _serializePresence(presence: IUserPresence): any {
    return {
      userId: presence.userId,
      displayName: presence.displayName,
      email: presence.email,
      avatarUrl: presence.avatarUrl,
      color: presence.color,
      activityState: presence.activityState,
      lastActivity: presence.lastActivity.toISOString(),
      currentCellId: presence.currentCellId,
      cursorPosition: presence.cursorPosition,
      selection: presence.selection,
      metadata: presence.metadata
    };
  }

  /**
   * Deserialize presence information from awareness state
   */
  private _deserializePresence(state: any): IUserPresence | null {
    if (!state || !state.userId) {
      return null;
    }

    return {
      userId: state.userId,
      displayName: state.displayName || 'Anonymous User',
      email: state.email,
      avatarUrl: state.avatarUrl,
      color: state.color || '#999999',
      activityState: state.activityState || UserActivityState.Active,
      lastActivity: new Date(state.lastActivity || Date.now()),
      currentCellId: state.currentCellId,
      cursorPosition: state.cursorPosition,
      selection: state.selection,
      metadata: state.metadata || {}
    };
  }
}

/**
 * Awareness registry implementation for coordinating multiple trackers
 */
export class AwarenessRegistry implements IAwarenessRegistry {
  private _trackers = new Set<IPresenceTracker>();
  private _primaryTracker: IPresenceTracker | null = null;
  private _isDisposed = false;

  // Signals
  private _presenceUpdated = new Signal<this, IUserPresence>(this);
  private _cursorUpdated = new Signal<this, IUserPositionChange>(this);

  /**
   * Register a presence tracker with the registry
   */
  registerTracker(tracker: IPresenceTracker): void {
    this._trackers.add(tracker);
    
    // Set as primary if this is the first tracker
    if (!this._primaryTracker) {
      this._primaryTracker = tracker;
    }

    // Connect to tracker signals
    tracker.usersChanged.connect(this._handleUsersChanged, this);
    tracker.userPositionChanged.connect(this._handleUserPositionChanged, this);
  }

  /**
   * Unregister a presence tracker from the registry
   */
  unregisterTracker(tracker: IPresenceTracker): void {
    this._trackers.delete(tracker);
    
    // Clear primary tracker if this was it
    if (this._primaryTracker === tracker) {
      this._primaryTracker = this._trackers.size > 0 ? 
        this._trackers.values().next().value : null;
    }

    // Disconnect from tracker signals
    tracker.usersChanged.disconnect(this._handleUsersChanged, this);
    tracker.userPositionChanged.disconnect(this._handleUserPositionChanged, this);
  }

  /**
   * Get the primary presence tracker
   */
  getPrimaryTracker(): IPresenceTracker | null {
    return this._primaryTracker;
  }

  /**
   * Broadcast a presence update to all registered trackers
   */
  broadcastPresenceUpdate(presence: Partial<IUserPresence>): void {
    this._trackers.forEach(tracker => {
      tracker.updateUserPresence(presence);
    });
  }

  /**
   * Broadcast a cursor position update to all registered trackers
   */
  broadcastCursorUpdate(cellId: string, position: ICursorPosition, selection?: ITextSelection): void {
    this._trackers.forEach(tracker => {
      tracker.updateCursorPosition(cellId, position, selection);
    });
  }

  /**
   * Signal emitted when presence information is updated
   */
  get presenceUpdated(): ISignal<this, IUserPresence> {
    return this._presenceUpdated;
  }

  /**
   * Signal emitted when cursor position is updated
   */
  get cursorUpdated(): ISignal<this, IUserPositionChange> {
    return this._cursorUpdated;
  }

  /**
   * Test whether the registry is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the awareness registry
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;

    // Unregister all trackers
    const trackers = Array.from(this._trackers);
    trackers.forEach(tracker => this.unregisterTracker(tracker));

    Signal.clearData(this);
  }

  /**
   * Handle users changed event from trackers
   */
  private _handleUsersChanged(tracker: IPresenceTracker, users: IUserPresence[]): void {
    // Emit presence updates for all users
    users.forEach(user => {
      this._presenceUpdated.emit(user);
    });
  }

  /**
   * Handle user position changed event from trackers
   */
  private _handleUserPositionChanged(tracker: IPresenceTracker, change: IUserPositionChange): void {
    this._cursorUpdated.emit(change);
  }
}

/**
 * Create a new user color manager instance
 * 
 * @param customColors - Optional custom color palette
 * @returns New UserColorManager instance
 */
export function createUserColorManager(customColors?: string[]): IUserColorManager {
  return new UserColorManager(customColors);
}

/**
 * Create a new presence tracker instance
 * 
 * @param colorManager - Optional color manager (will create one if not provided)
 * @param translator - Optional translator (will use nullTranslator if not provided)
 * @returns New PresenceTracker instance
 */
export function createPresenceTracker(
  colorManager?: IUserColorManager,
  translator?: ITranslator
): IPresenceTracker {
  return new PresenceTracker(colorManager, translator);
}

/**
 * Create a new awareness registry instance
 * 
 * @returns New AwarenessRegistry instance
 */
export function createAwarenessRegistry(): IAwarenessRegistry {
  return new AwarenessRegistry();
}