/**
 * @fileoverview User presence and awareness system for collaborative notebook editing
 * 
 * This module provides comprehensive real-time user tracking and presence awareness
 * using the Yjs CRDT framework. It enables multiple users to see each other's cursor
 * positions, selections, and editing status during collaborative notebook sessions.
 * 
 * Key features:
 * - Real-time user presence tracking with status indicators
 * - Cursor position and selection synchronization across clients
 * - Visual indicators for active collaborators and their locations
 * - Integration with Yjs awareness protocol for conflict-free updates
 * - Comprehensive event system for user join/leave/update notifications
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { Doc } from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable, DisposableDelegate } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import { User } from '@jupyterlab/services';
import { ICellModel } from '@jupyterlab/cells';
import { IEditor } from '@jupyterlab/codeeditor';
import { Time } from '@jupyterlab/coreutils';
import { IAwarenessService } from '../tokens';

/**
 * Enumeration of possible user status states for collaborative editing
 */
export enum UserStatus {
  /** User is idle with no recent activity */
  IDLE = 'idle',
  /** User is actively interacting with the notebook */
  ACTIVE = 'active',
  /** User is viewing the notebook without editing */
  VIEWING = 'viewing',
  /** User is currently editing content */
  EDITING = 'editing',
  /** User is offline or disconnected */
  OFFLINE = 'offline'
}

/**
 * Enumeration of awareness event types for collaborative notifications
 */
export enum AwarenessEventType {
  /** User joined the collaborative session */
  USER_JOINED = 'user_joined',
  /** User left the collaborative session */
  USER_LEFT = 'user_left',
  /** User information or status was updated */
  USER_UPDATED = 'user_updated',
  /** User's cursor position changed */
  CURSOR_MOVED = 'cursor_moved',
  /** User's selection changed */
  SELECTION_CHANGED = 'selection_changed',
  /** User's status changed */
  STATUS_CHANGED = 'status_changed',
  /** User switched to a different cell */
  CELL_CHANGED = 'cell_changed'
}

/**
 * Interface representing a collaborative user with presence information
 */
export interface IUser {
  /** Unique identifier for the user */
  id: string;
  /** User's display name */
  name: string;
  /** User's full display name (if different from name) */
  displayName: string;
  /** User's email address */
  email: string;
  /** URL to user's avatar image */
  avatar: string;
  /** Color associated with the user for UI elements */
  color: string;
  /** Whether the user is currently active */
  isActive: boolean;
  /** Timestamp of user's last activity */
  lastSeen: Date;
  /** Current cursor position information */
  cursor: ICursorPosition | null;
  /** Current selection range information */
  selection: ISelectionRange | null;
  /** ID of the cell the user is currently in */
  currentCell: string | null;
  /** Current status of the user */
  status: UserStatus;
}

/**
 * Interface representing detailed user presence information
 */
export interface IUserPresence {
  /** ID of the user this presence information belongs to */
  userId: string;
  /** Complete user information */
  user: IUser;
  /** Timestamp when this presence was last updated */
  timestamp: Date;
  /** Current cursor position */
  cursor: ICursorPosition | null;
  /** Current selection range */
  selection: ISelectionRange | null;
  /** ID of the cell the user is currently in */
  currentCell: string | null;
  /** Current user status */
  status: UserStatus;
  /** Whether the user is currently active */
  isActive: boolean;
  /** Timestamp of the user's last activity */
  lastActivity: Date;
}

/**
 * Interface representing a cursor position in the notebook
 */
export interface ICursorPosition {
  /** Line number of the cursor */
  line: number;
  /** Column position of the cursor */
  column: number;
  /** ID of the cell containing the cursor */
  cellId: string;
  /** Timestamp when the cursor was positioned */
  timestamp: Date;
  /** ID of the user who owns this cursor */
  userId: string;
}

/**
 * Interface representing a selection range in the notebook
 */
export interface ISelectionRange {
  /** Start position of the selection */
  start: ICursorPosition;
  /** End position of the selection */
  end: ICursorPosition;
  /** ID of the cell containing the selection */
  cellId: string;
  /** Timestamp when the selection was made */
  timestamp: Date;
  /** ID of the user who made this selection */
  userId: string;
}

/**
 * Interface representing an awareness event for collaborative notifications
 */
export interface IAwarenessEvent {
  /** Type of the awareness event */
  type: AwarenessEventType;
  /** ID of the user associated with this event */
  userId: string;
  /** Timestamp when the event occurred */
  timestamp: Date;
  /** Additional data associated with the event */
  data: any;
  /** Optional metadata for the event */
  metadata?: any;
}

/**
 * Main awareness service class that manages user presence and collaborative state
 * 
 * This service integrates with the Yjs awareness protocol to provide real-time
 * tracking of user presence, cursor positions, and collaborative interactions.
 * It maintains a synchronized view of all active users and their current states.
 */
export class AwarenessService implements IAwarenessService, IDisposable {
  private _doc: Doc;
  private _awareness: Awareness;
  private _currentUser: IUser | null = null;
  private _users: Map<string, IUser> = new Map();
  private _userPresenceMap: Map<string, IUserPresence> = new Map();
  private _disposed: boolean = false;
  private _userColors: string[] = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
  ];
  private _colorIndex: number = 0;
  private _activityTimeout: number = 30000; // 30 seconds
  private _activityTimer: NodeJS.Timeout | null = null;

  // Signals for awareness events
  private _userJoinedSignal = new Signal<AwarenessService, { userId: string; name: string; avatar?: string }>(this);
  private _userLeftSignal = new Signal<AwarenessService, { userId: string }>(this);
  private _userUpdatedSignal = new Signal<AwarenessService, IAwarenessEvent>(this);

  /**
   * Creates a new awareness service instance
   * 
   * @param doc - The Yjs document for collaborative editing
   * @param user - The current user information
   */
  constructor(doc: Doc, user: User.IUser) {
    this._doc = doc;
    this._awareness = new Awareness(doc);
    this._initializeCurrentUser(user);
    this._setupAwarenessListeners();
    this._startActivityMonitoring();
  }

  /**
   * Signal emitted when a user joins the collaborative session
   */
  get onUserJoin(): ISignal<AwarenessService, { userId: string; name: string; avatar?: string }> {
    return this._userJoinedSignal;
  }

  /**
   * Signal emitted when a user leaves the collaborative session
   */
  get onUserLeave(): ISignal<AwarenessService, { userId: string }> {
    return this._userLeftSignal;
  }

  /**
   * Signal emitted when a user's information or status is updated
   */
  get onUserUpdate(): ISignal<AwarenessService, IAwarenessEvent> {
    return this._userUpdatedSignal;
  }

  /**
   * Get information about all users currently in the collaborative session
   * 
   * @returns Array of user information including presence data
   */
  getUsers(): Array<{
    userId: string;
    name: string;
    avatar?: string;
    cursor?: { cellId: string; position: number };
    selection?: { cellId: string; start: number; end: number };
    isActive: boolean;
    lastActivity: Date;
  }> {
    const users: Array<{
      userId: string;
      name: string;
      avatar?: string;
      cursor?: { cellId: string; position: number };
      selection?: { cellId: string; start: number; end: number };
      isActive: boolean;
      lastActivity: Date;
    }> = [];

    for (const [userId, user] of this._users) {
      const presence = this._userPresenceMap.get(userId);
      users.push({
        userId: user.id,
        name: user.name,
        avatar: user.avatar,
        cursor: user.cursor ? {
          cellId: user.cursor.cellId,
          position: user.cursor.line * 1000 + user.cursor.column
        } : undefined,
        selection: user.selection ? {
          cellId: user.selection.cellId,
          start: user.selection.start.line * 1000 + user.selection.start.column,
          end: user.selection.end.line * 1000 + user.selection.end.column
        } : undefined,
        isActive: user.isActive,
        lastActivity: presence?.lastActivity || user.lastSeen
      });
    }

    return users;
  }

  /**
   * Get information about the current user
   * 
   * @returns Current user information
   */
  getCurrentUser(): {
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
  } {
    if (!this._currentUser) {
      throw new Error('Current user not initialized');
    }

    return {
      userId: this._currentUser.id,
      name: this._currentUser.name,
      avatar: this._currentUser.avatar,
      isActive: this._currentUser.isActive
    };
  }

  /**
   * Get presence information for a specific user
   * 
   * @param userId - The user ID to get presence for
   * @returns User presence information or null if not found
   */
  getUserPresence(userId: string): {
    cursor?: { cellId: string; position: number };
    selection?: { cellId: string; start: number; end: number };
    isActive: boolean;
    lastActivity: Date;
  } | null {
    const user = this._users.get(userId);
    const presence = this._userPresenceMap.get(userId);

    if (!user || !presence) {
      return null;
    }

    return {
      cursor: user.cursor ? {
        cellId: user.cursor.cellId,
        position: user.cursor.line * 1000 + user.cursor.column
      } : undefined,
      selection: user.selection ? {
        cellId: user.selection.cellId,
        start: user.selection.start.line * 1000 + user.selection.start.column,
        end: user.selection.end.line * 1000 + user.selection.end.column
      } : undefined,
      isActive: user.isActive,
      lastActivity: presence.lastActivity
    };
  }

  /**
   * Get a user by their ID
   * 
   * @param userId - The user ID to look up
   * @returns User information or null if not found
   */
  getUserById(userId: string): IUser | null {
    return this._users.get(userId) || null;
  }

  /**
   * Update the current user's status
   * 
   * @param status - The new status to set
   */
  updateUserStatus(status: UserStatus): void {
    if (!this._currentUser) {
      return;
    }

    this._currentUser.status = status;
    this._currentUser.lastSeen = new Date();
    this._currentUser.isActive = status === UserStatus.ACTIVE || status === UserStatus.EDITING;

    this._updateLocalAwareness();
    this._emitUserUpdateEvent({
      type: AwarenessEventType.STATUS_CHANGED,
      userId: this._currentUser.id,
      timestamp: new Date(),
      data: { status, isActive: this._currentUser.isActive }
    });
  }

  /**
   * Track cursor position for the current user
   * 
   * @param cellId - ID of the cell containing the cursor
   * @param editor - The editor instance to get cursor position from
   */
  trackCursorPosition(cellId: string, editor: IEditor): void {
    if (!this._currentUser) {
      return;
    }

    const position = editor.getCursorPosition();
    const cursor: ICursorPosition = {
      line: position.line,
      column: position.column,
      cellId: cellId,
      timestamp: new Date(),
      userId: this._currentUser.id
    };

    this._currentUser.cursor = cursor;
    this._currentUser.currentCell = cellId;
    this._currentUser.lastSeen = new Date();

    // Update activity status
    if (this._currentUser.status === UserStatus.IDLE) {
      this._currentUser.status = UserStatus.ACTIVE;
      this._currentUser.isActive = true;
    }

    this._updateLocalAwareness();
    this._emitUserUpdateEvent({
      type: AwarenessEventType.CURSOR_MOVED,
      userId: this._currentUser.id,
      timestamp: new Date(),
      data: { cursor, cellId }
    });

    this._resetActivityTimer();
  }

  /**
   * Track selection changes for the current user
   * 
   * @param cellId - ID of the cell containing the selection
   * @param editor - The editor instance to get selection from
   */
  trackSelection(cellId: string, editor: IEditor): void {
    if (!this._currentUser) {
      return;
    }

    const selection = editor.getSelection();
    if (!selection) {
      return;
    }

    const selectionRange: ISelectionRange = {
      start: {
        line: selection.start.line,
        column: selection.start.column,
        cellId: cellId,
        timestamp: new Date(),
        userId: this._currentUser.id
      },
      end: {
        line: selection.end.line,
        column: selection.end.column,
        cellId: cellId,
        timestamp: new Date(),
        userId: this._currentUser.id
      },
      cellId: cellId,
      timestamp: new Date(),
      userId: this._currentUser.id
    };

    this._currentUser.selection = selectionRange;
    this._currentUser.currentCell = cellId;
    this._currentUser.lastSeen = new Date();

    this._updateLocalAwareness();
    this._emitUserUpdateEvent({
      type: AwarenessEventType.SELECTION_CHANGED,
      userId: this._currentUser.id,
      timestamp: new Date(),
      data: { selection: selectionRange, cellId }
    });

    this._resetActivityTimer();
  }

  /**
   * Create a new awareness service instance
   * 
   * @param doc - The Yjs document for collaborative editing
   * @param user - The current user information
   * @returns A new awareness service instance
   */
  create(doc: Doc, user: User.IUser): AwarenessService {
    return new AwarenessService(doc, user);
  }

  /**
   * Initialize the awareness service
   * 
   * @param options - Initialization options
   */
  async initialize(options?: any): Promise<void> {
    // Service is initialized in constructor
    // This method is provided for interface compliance
    return Promise.resolve();
  }

  /**
   * Check if the service is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the awareness service and cleanup resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;
    
    // Clear activity timer
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
      this._activityTimer = null;
    }

    // Remove awareness listeners
    this._awareness.off('update', this._onAwarenessUpdate);
    this._awareness.off('change', this._onAwarenessChange);

    // Clear local state
    this._users.clear();
    this._userPresenceMap.clear();
    this._currentUser = null;

    // Dispose of awareness
    this._awareness.destroy();
  }

  /**
   * Initialize the current user from JupyterLab user service
   * 
   * @param user - The JupyterLab user object
   */
  private _initializeCurrentUser(user: User.IUser): void {
    const userId = user.identity?.username || UUID.uuid4();
    const userName = user.identity?.name || user.identity?.username || 'Anonymous';
    const displayName = user.identity?.display_name || userName;
    const email = user.identity?.email || '';
    const avatar = user.identity?.avatar_url || '';
    const color = this._getNextUserColor();

    this._currentUser = {
      id: userId,
      name: userName,
      displayName: displayName,
      email: email,
      avatar: avatar,
      color: color,
      isActive: true,
      lastSeen: new Date(),
      cursor: null,
      selection: null,
      currentCell: null,
      status: UserStatus.ACTIVE
    };

    this._users.set(userId, this._currentUser);
    this._userPresenceMap.set(userId, {
      userId: userId,
      user: this._currentUser,
      timestamp: new Date(),
      cursor: null,
      selection: null,
      currentCell: null,
      status: UserStatus.ACTIVE,
      isActive: true,
      lastActivity: new Date()
    });

    this._updateLocalAwareness();
  }

  /**
   * Set up listeners for Yjs awareness updates
   */
  private _setupAwarenessListeners(): void {
    this._awareness.on('update', this._onAwarenessUpdate.bind(this));
    this._awareness.on('change', this._onAwarenessChange.bind(this));
  }

  /**
   * Handle awareness updates from other clients
   * 
   * @param changes - The awareness changes
   */
  private _onAwarenessUpdate(changes: any): void {
    // Handle binary awareness updates
    this._processAwarenessChanges();
  }

  /**
   * Handle awareness changes (user join/leave/update)
   * 
   * @param changes - The awareness changes
   */
  private _onAwarenessChange(changes: any): void {
    const { added, updated, removed } = changes;

    // Handle new users
    added.forEach((clientId: number) => {
      const state = this._awareness.getStates().get(clientId);
      if (state && state.user) {
        this._handleUserJoined(state.user);
      }
    });

    // Handle user updates
    updated.forEach((clientId: number) => {
      const state = this._awareness.getStates().get(clientId);
      if (state && state.user) {
        this._handleUserUpdated(state.user);
      }
    });

    // Handle user removal
    removed.forEach((clientId: number) => {
      const state = this._awareness.getStates().get(clientId);
      if (state && state.user) {
        this._handleUserLeft(state.user.id);
      }
    });
  }

  /**
   * Process awareness changes and update local state
   */
  private _processAwarenessChanges(): void {
    const states = this._awareness.getStates();
    
    for (const [clientId, state] of states) {
      if (state && state.user && state.user.id !== this._currentUser?.id) {
        this._updateUserFromAwareness(state.user);
      }
    }
  }

  /**
   * Handle a user joining the collaborative session
   * 
   * @param userData - The user data from awareness
   */
  private _handleUserJoined(userData: any): void {
    const user: IUser = {
      id: userData.id,
      name: userData.name,
      displayName: userData.displayName || userData.name,
      email: userData.email || '',
      avatar: userData.avatar || '',
      color: userData.color || this._getNextUserColor(),
      isActive: true,
      lastSeen: new Date(),
      cursor: userData.cursor || null,
      selection: userData.selection || null,
      currentCell: userData.currentCell || null,
      status: userData.status || UserStatus.ACTIVE
    };

    this._users.set(user.id, user);
    this._userPresenceMap.set(user.id, {
      userId: user.id,
      user: user,
      timestamp: new Date(),
      cursor: user.cursor,
      selection: user.selection,
      currentCell: user.currentCell,
      status: user.status,
      isActive: user.isActive,
      lastActivity: new Date()
    });

    this._userJoinedSignal.emit({
      userId: user.id,
      name: user.name,
      avatar: user.avatar
    });
  }

  /**
   * Handle a user leaving the collaborative session
   * 
   * @param userId - The ID of the user who left
   */
  private _handleUserLeft(userId: string): void {
    this._users.delete(userId);
    this._userPresenceMap.delete(userId);

    this._userLeftSignal.emit({ userId });
  }

  /**
   * Handle user information updates
   * 
   * @param userData - The updated user data
   */
  private _handleUserUpdated(userData: any): void {
    const existingUser = this._users.get(userData.id);
    if (!existingUser) {
      return;
    }

    // Update user information
    existingUser.cursor = userData.cursor || null;
    existingUser.selection = userData.selection || null;
    existingUser.currentCell = userData.currentCell || null;
    existingUser.status = userData.status || UserStatus.ACTIVE;
    existingUser.isActive = userData.isActive !== undefined ? userData.isActive : true;
    existingUser.lastSeen = new Date();

    // Update presence information
    const presence = this._userPresenceMap.get(userData.id);
    if (presence) {
      presence.cursor = existingUser.cursor;
      presence.selection = existingUser.selection;
      presence.currentCell = existingUser.currentCell;
      presence.status = existingUser.status;
      presence.isActive = existingUser.isActive;
      presence.lastActivity = new Date();
      presence.timestamp = new Date();
    }

    this._emitUserUpdateEvent({
      type: AwarenessEventType.USER_UPDATED,
      userId: userData.id,
      timestamp: new Date(),
      data: userData
    });
  }

  /**
   * Update user information from awareness state
   * 
   * @param userData - The user data from awareness
   */
  private _updateUserFromAwareness(userData: any): void {
    const existingUser = this._users.get(userData.id);
    if (existingUser) {
      this._handleUserUpdated(userData);
    } else {
      this._handleUserJoined(userData);
    }
  }

  /**
   * Update local awareness state with current user information
   */
  private _updateLocalAwareness(): void {
    if (!this._currentUser) {
      return;
    }

    const awarenessState = {
      user: {
        id: this._currentUser.id,
        name: this._currentUser.name,
        displayName: this._currentUser.displayName,
        email: this._currentUser.email,
        avatar: this._currentUser.avatar,
        color: this._currentUser.color,
        isActive: this._currentUser.isActive,
        lastSeen: this._currentUser.lastSeen.toISOString(),
        cursor: this._currentUser.cursor,
        selection: this._currentUser.selection,
        currentCell: this._currentUser.currentCell,
        status: this._currentUser.status
      },
      timestamp: new Date().toISOString()
    };

    this._awareness.setLocalState(awarenessState);
  }

  /**
   * Get the next available color for a user
   * 
   * @returns A color string
   */
  private _getNextUserColor(): string {
    const color = this._userColors[this._colorIndex % this._userColors.length];
    this._colorIndex++;
    return color;
  }

  /**
   * Emit a user update event
   * 
   * @param event - The awareness event to emit
   */
  private _emitUserUpdateEvent(event: IAwarenessEvent): void {
    this._userUpdatedSignal.emit(event);
  }

  /**
   * Start monitoring user activity for idle detection
   */
  private _startActivityMonitoring(): void {
    this._resetActivityTimer();

    // Set up global activity listeners
    document.addEventListener('mousemove', this._onUserActivity.bind(this));
    document.addEventListener('keypress', this._onUserActivity.bind(this));
    document.addEventListener('scroll', this._onUserActivity.bind(this));
    document.addEventListener('click', this._onUserActivity.bind(this));
  }

  /**
   * Handle user activity events
   */
  private _onUserActivity(): void {
    if (!this._currentUser) {
      return;
    }

    const wasIdle = this._currentUser.status === UserStatus.IDLE;
    
    if (wasIdle) {
      this._currentUser.status = UserStatus.ACTIVE;
      this._currentUser.isActive = true;
      this._updateLocalAwareness();
    }

    this._resetActivityTimer();
  }

  /**
   * Reset the activity timer for idle detection
   */
  private _resetActivityTimer(): void {
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
    }

    this._activityTimer = setTimeout(() => {
      this._handleUserIdle();
    }, this._activityTimeout);
  }

  /**
   * Handle user becoming idle
   */
  private _handleUserIdle(): void {
    if (!this._currentUser) {
      return;
    }

    this._currentUser.status = UserStatus.IDLE;
    this._currentUser.isActive = false;
    this._updateLocalAwareness();

    this._emitUserUpdateEvent({
      type: AwarenessEventType.STATUS_CHANGED,
      userId: this._currentUser.id,
      timestamp: new Date(),
      data: { status: UserStatus.IDLE, isActive: false }
    });
  }
}

/**
 * Factory function to create a new awareness service instance
 * 
 * @param doc - The Yjs document for collaborative editing
 * @param user - The current user information
 * @returns A new awareness service instance
 */
export function createAwarenessService(doc: Doc, user: User.IUser): AwarenessService {
  return new AwarenessService(doc, user);
}