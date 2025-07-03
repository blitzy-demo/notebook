/**
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable, DisposableDelegate } from '@lumino/signaling';
import { UUID } from '@lumino/coreutils';

/**
 * Interface for user presence information synchronized across collaborative sessions.
 */
export interface IUserPresence {
  /** Unique identifier for the user */
  readonly userId: string;
  /** Display name for the user */
  readonly displayName: string;
  /** User's current activity status */
  readonly status: 'active' | 'idle' | 'away' | 'busy';
  /** Timestamp of last activity */
  readonly lastActivity: number;
  /** User's role in the collaboration session */
  readonly role?: 'owner' | 'editor' | 'viewer';
  /** Color assigned to this user for presence indicators */
  readonly color: string;
  /** User's avatar URL or initials */
  readonly avatar?: string;
}

/**
 * Interface for cursor position and selection state tracking.
 */
export interface ISelectionState {
  /** ID of the cell where the cursor is positioned */
  readonly cellId: string;
  /** Cursor position within the cell (character offset) */
  readonly position: number;
  /** Text selection range if any */
  readonly selection?: {
    /** Selection anchor position */
    readonly anchor: number;
    /** Selection head position */
    readonly head: number;
  };
  /** Timestamp when the selection was last updated */
  readonly timestamp: number;
}

/**
 * Interface for a collaborative user combining presence and selection state.
 */
export interface ICollaborativeUser extends IUserPresence {
  /** Current cursor position and selection */
  readonly cursor?: ISelectionState;
  /** Yjs client ID for this user */
  readonly clientId: number;
  /** Whether the user is currently connected */
  readonly isConnected: boolean;
}

/**
 * Interface for awareness provider managing user presence and selection state.
 */
export interface IAwarenessProvider extends IDisposable {
  /** The underlying Yjs awareness instance */
  readonly awareness: Awareness;
  /** Current local user state */
  readonly localState: ICollaborativeUser | null;
  /** Map of remote users by client ID */
  readonly remoteStates: Map<number, ICollaborativeUser>;
  /** Whether the provider is connected */
  readonly isConnected: boolean;
  /** Signal emitted when collaborators change */
  readonly collaboratorsChanged: ISignal<IAwarenessProvider, ICollaborativeUser[]>;
  /** Signal emitted when local state changes */
  readonly localStateChanged: ISignal<IAwarenessProvider, ICollaborativeUser | null>;
  /** Signal emitted when selection states change */
  readonly selectionChanged: ISignal<IAwarenessProvider, Map<number, ISelectionState>>;
  
  /** Update the local user's presence information */
  updateLocalPresence(presence: Partial<IUserPresence>): void;
  /** Update the local user's cursor and selection state */
  updateLocalSelection(selection: ISelectionState | null): void;
  /** Get current list of all collaborative users */
  getCollaborators(): ICollaborativeUser[];
  /** Get current selection states for all users */
  getSelectionStates(): Map<number, ISelectionState>;
  /** Check if a specific user is currently active */
  isUserActive(userId: string): boolean;
  /** Get user by their client ID */
  getUserByClientId(clientId: number): ICollaborativeUser | null;
}

/**
 * Options for creating an awareness provider.
 */
export interface IAwarenessProviderOptions {
  /** Initial user information */
  readonly userInfo: IUserPresence;
  /** Delta update frequency in milliseconds */
  readonly updateFrequency?: number;
  /** Activity timeout in milliseconds */
  readonly activityTimeout?: number;
  /** Whether to enable detailed logging */
  readonly enableLogging?: boolean;
}

/**
 * Awareness state data structure for Yjs synchronization.
 */
interface IAwarenessState {
  /** User presence information */
  presence: IUserPresence;
  /** Current cursor and selection state */
  selection: ISelectionState | null;
  /** Connection timestamp */
  connectedAt: number;
  /** Last update timestamp */
  lastUpdate: number;
}

/**
 * Implementation of the awareness provider using Yjs awareness protocol.
 */
export class AwarenessProvider implements IAwarenessProvider {
  private _awareness: Awareness;
  private _localState: ICollaborativeUser | null = null;
  private _remoteStates = new Map<number, ICollaborativeUser>();
  private _isConnected = false;
  private _isDisposed = false;
  private _updateFrequency: number;
  private _activityTimeout: number;
  private _enableLogging: boolean;
  private _updateTimer: NodeJS.Timeout | null = null;
  private _activityTimer: NodeJS.Timeout | null = null;
  
  // Signals
  private _collaboratorsChanged = new Signal<IAwarenessProvider, ICollaborativeUser[]>(this);
  private _localStateChanged = new Signal<IAwarenessProvider, ICollaborativeUser | null>(this);
  private _selectionChanged = new Signal<IAwarenessProvider, Map<number, ISelectionState>>(this);

  /**
   * Construct a new awareness provider.
   */
  constructor(awareness: Awareness, options: IAwarenessProviderOptions) {
    this._awareness = awareness;
    this._updateFrequency = options.updateFrequency ?? 5000; // 5 seconds
    this._activityTimeout = options.activityTimeout ?? 300000; // 5 minutes
    this._enableLogging = options.enableLogging ?? false;

    // Initialize local state
    this._initializeLocalState(options.userInfo);

    // Set up awareness event handlers
    this._setupAwarenessHandlers();

    // Start periodic updates
    this._startPeriodicUpdates();

    // Set up activity monitoring
    this._setupActivityMonitoring();

    this._log('AwarenessProvider initialized', { 
      clientId: this._awareness.clientID,
      userInfo: options.userInfo 
    });
  }

  /**
   * Get the underlying Yjs awareness instance.
   */
  get awareness(): Awareness {
    return this._awareness;
  }

  /**
   * Get the current local user state.
   */
  get localState(): ICollaborativeUser | null {
    return this._localState;
  }

  /**
   * Get the map of remote user states.
   */
  get remoteStates(): Map<number, ICollaborativeUser> {
    return new Map(this._remoteStates);
  }

  /**
   * Check if the provider is connected.
   */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Signal emitted when collaborators change.
   */
  get collaboratorsChanged(): ISignal<IAwarenessProvider, ICollaborativeUser[]> {
    return this._collaboratorsChanged;
  }

  /**
   * Signal emitted when local state changes.
   */
  get localStateChanged(): ISignal<IAwarenessProvider, ICollaborativeUser | null> {
    return this._localStateChanged;
  }

  /**
   * Signal emitted when selection states change.
   */
  get selectionChanged(): ISignal<IAwarenessProvider, Map<number, ISelectionState>> {
    return this._selectionChanged;
  }

  /**
   * Whether the provider is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Update the local user's presence information.
   */
  updateLocalPresence(presence: Partial<IUserPresence>): void {
    if (this._isDisposed || !this._localState) {
      return;
    }

    try {
      // Create updated presence state
      const updatedPresence: IUserPresence = {
        ...this._localState,
        ...presence,
        lastActivity: Date.now()
      };

      // Update local state
      this._localState = {
        ...this._localState,
        ...updatedPresence
      };

      // Update awareness state
      this._updateAwarenessState({
        presence: updatedPresence,
        selection: this._localState.cursor || null,
        connectedAt: this._localState.clientId,
        lastUpdate: Date.now()
      });

      this._localStateChanged.emit(this._localState);
      this._log('Local presence updated', { presence: updatedPresence });

    } catch (error) {
      console.error('Error updating local presence:', error);
    }
  }

  /**
   * Update the local user's cursor and selection state.
   */
  updateLocalSelection(selection: ISelectionState | null): void {
    if (this._isDisposed || !this._localState) {
      return;
    }

    try {
      // Update local state
      this._localState = {
        ...this._localState,
        cursor: selection || undefined,
        lastActivity: Date.now()
      };

      // Update awareness state
      this._updateAwarenessState({
        presence: this._localState,
        selection: selection,
        connectedAt: this._awareness.clientID,
        lastUpdate: Date.now()
      });

      this._localStateChanged.emit(this._localState);
      
      // Emit selection change
      const selectionStates = this.getSelectionStates();
      this._selectionChanged.emit(selectionStates);

      this._log('Local selection updated', { selection });

    } catch (error) {
      console.error('Error updating local selection:', error);
    }
  }

  /**
   * Get current list of all collaborative users.
   */
  getCollaborators(): ICollaborativeUser[] {
    const collaborators: ICollaborativeUser[] = [];
    
    if (this._localState) {
      collaborators.push(this._localState);
    }
    
    for (const user of this._remoteStates.values()) {
      collaborators.push(user);
    }

    return collaborators.sort((a, b) => {
      // Sort by activity status, then by last activity time
      const statusOrder = { active: 0, busy: 1, idle: 2, away: 3 };
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;
      
      return b.lastActivity - a.lastActivity;
    });
  }

  /**
   * Get current selection states for all users.
   */
  getSelectionStates(): Map<number, ISelectionState> {
    const selections = new Map<number, ISelectionState>();
    
    if (this._localState?.cursor) {
      selections.set(this._awareness.clientID, this._localState.cursor);
    }
    
    for (const [clientId, user] of this._remoteStates) {
      if (user.cursor) {
        selections.set(clientId, user.cursor);
      }
    }
    
    return selections;
  }

  /**
   * Check if a specific user is currently active.
   */
  isUserActive(userId: string): boolean {
    if (this._localState?.userId === userId && this._localState.status === 'active') {
      return true;
    }
    
    for (const user of this._remoteStates.values()) {
      if (user.userId === userId && user.status === 'active') {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Get user by their client ID.
   */
  getUserByClientId(clientId: number): ICollaborativeUser | null {
    if (this._awareness.clientID === clientId) {
      return this._localState;
    }
    
    return this._remoteStates.get(clientId) || null;
  }

  /**
   * Dispose of the awareness provider.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._log('Disposing awareness provider');

    // Clear timers
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }

    if (this._activityTimer) {
      clearInterval(this._activityTimer);
      this._activityTimer = null;
    }

    // Remove event listeners
    this._awareness.off('change', this._handleAwarenessChange);
    this._awareness.off('update', this._handleAwarenessUpdate);

    // Clear local awareness state
    this._awareness.setLocalState(null);

    // Clear internal state
    this._localState = null;
    this._remoteStates.clear();
    this._isConnected = false;
    this._isDisposed = true;
  }

  /**
   * Initialize local state from user information.
   */
  private _initializeLocalState(userInfo: IUserPresence): void {
    const clientId = this._awareness.clientID;
    const now = Date.now();

    this._localState = {
      ...userInfo,
      clientId,
      isConnected: true,
      lastActivity: now
    };

    // Set initial awareness state
    this._updateAwarenessState({
      presence: userInfo,
      selection: null,
      connectedAt: now,
      lastUpdate: now
    });

    this._isConnected = true;
    this._localStateChanged.emit(this._localState);
  }

  /**
   * Set up awareness event handlers.
   */
  private _setupAwarenessHandlers(): void {
    // Handle awareness changes (users joining/leaving)
    this._awareness.on('change', this._handleAwarenessChange.bind(this));
    
    // Handle awareness updates (state changes)
    this._awareness.on('update', this._handleAwarenessUpdate.bind(this));
  }

  /**
   * Handle awareness change events.
   */
  private _handleAwarenessChange(changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void {
    if (this._isDisposed) {
      return;
    }

    try {
      const { added, updated, removed } = changes;
      let stateChanged = false;

      // Handle removed clients
      for (const clientId of removed) {
        if (this._remoteStates.has(clientId)) {
          this._remoteStates.delete(clientId);
          stateChanged = true;
          this._log('User disconnected', { clientId });
        }
      }

      // Handle added and updated clients
      for (const clientId of [...added, ...updated]) {
        if (clientId === this._awareness.clientID) {
          continue; // Skip local client
        }

        const awarenessState = this._awareness.getStates().get(clientId);
        if (awarenessState) {
          const user = this._createUserFromAwarenessState(clientId, awarenessState);
          if (user) {
            this._remoteStates.set(clientId, user);
            stateChanged = true;
            this._log('User state updated', { clientId, user });
          }
        }
      }

      // Emit events if state changed
      if (stateChanged) {
        this._collaboratorsChanged.emit(this.getCollaborators());
        this._selectionChanged.emit(this.getSelectionStates());
      }

    } catch (error) {
      console.error('Error handling awareness change:', error);
    }
  }

  /**
   * Handle awareness update events.
   */
  private _handleAwarenessUpdate(): void {
    if (this._isDisposed) {
      return;
    }

    try {
      // Check connection status
      const isConnected = this._awareness.getStates().size > 0;
      if (this._isConnected !== isConnected) {
        this._isConnected = isConnected;
        this._log('Connection status changed', { isConnected });
      }

      // Emit selection changes for real-time cursor updates
      this._selectionChanged.emit(this.getSelectionStates());

    } catch (error) {
      console.error('Error handling awareness update:', error);
    }
  }

  /**
   * Create a collaborative user from awareness state.
   */
  private _createUserFromAwarenessState(
    clientId: number, 
    awarenessState: any
  ): ICollaborativeUser | null {
    try {
      if (!awarenessState || typeof awarenessState !== 'object') {
        return null;
      }

      const { presence, selection } = awarenessState as IAwarenessState;
      
      if (!presence || !presence.userId) {
        return null;
      }

      return {
        ...presence,
        clientId,
        cursor: selection || undefined,
        isConnected: true
      };

    } catch (error) {
      console.error('Error creating user from awareness state:', error);
      return null;
    }
  }

  /**
   * Update the awareness state with new data.
   */
  private _updateAwarenessState(state: IAwarenessState): void {
    try {
      this._awareness.setLocalState(state);
    } catch (error) {
      console.error('Error updating awareness state:', error);
    }
  }

  /**
   * Start periodic updates for maintaining activity status.
   */
  private _startPeriodicUpdates(): void {
    this._updateTimer = setInterval(() => {
      if (this._isDisposed || !this._localState) {
        return;
      }

      // Update activity status based on focus and interaction
      const now = Date.now();
      const timeSinceLastActivity = now - this._localState.lastActivity;
      
      let newStatus: IUserPresence['status'] = this._localState.status;
      
      // Determine activity status
      if (document.hidden) {
        newStatus = 'away';
      } else if (timeSinceLastActivity > 60000) { // 1 minute
        newStatus = 'idle';
      } else if (document.hasFocus()) {
        newStatus = 'active';
      }

      // Update if status changed
      if (newStatus !== this._localState.status) {
        this.updateLocalPresence({ status: newStatus });
      }

    }, this._updateFrequency);
  }

  /**
   * Set up activity monitoring for automatic status updates.
   */
  private _setupActivityMonitoring(): void {
    // Monitor user activity events
    const activityEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
    
    const handleActivity = () => {
      if (this._localState && this._localState.status !== 'active') {
        this.updateLocalPresence({ 
          status: 'active',
          lastActivity: Date.now()
        });
      }
    };

    // Add event listeners
    activityEvents.forEach(event => {
      document.addEventListener(event, handleActivity, { passive: true });
    });

    // Monitor page visibility
    const handleVisibilityChange = () => {
      const status = document.hidden ? 'away' : 'active';
      this.updateLocalPresence({ status });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Set up activity timeout monitoring
    this._activityTimer = setInterval(() => {
      if (this._isDisposed || !this._localState) {
        return;
      }

      const now = Date.now();
      const timeSinceLastActivity = now - this._localState.lastActivity;

      // Mark user as idle if inactive for too long
      if (timeSinceLastActivity > this._activityTimeout && this._localState.status !== 'away') {
        this.updateLocalPresence({ status: 'idle' });
      }

    }, 30000); // Check every 30 seconds
  }

  /**
   * Log debug information if logging is enabled.
   */
  private _log(message: string, data?: any): void {
    if (this._enableLogging) {
      console.log(`[AwarenessProvider] ${message}`, data || '');
    }
  }
}

/**
 * Utility function to generate a consistent user color based on user ID.
 */
export function generateUserColor(userId: string): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F8C471', '#82E0AA', '#85C1E9', '#F1948A', '#D7BDE2'
  ];

  // Generate a hash from the user ID
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return colors[Math.abs(hash) % colors.length];
}

/**
 * Utility function to generate user initials from display name.
 */
export function generateUserInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/);
  
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  } else if (words.length === 1 && words[0].length >= 2) {
    return words[0].substring(0, 2).toUpperCase();
  } else {
    return '??';
  }
}

/**
 * Utility function to create default user information.
 */
export function createDefaultUserInfo(userId?: string, displayName?: string): IUserPresence {
  const id = userId || `user-${UUID.uuid4().substring(0, 8)}`;
  const name = displayName || `User ${id.substring(0, 8)}`;
  
  return {
    userId: id,
    displayName: name,
    status: 'active',
    lastActivity: Date.now(),
    color: generateUserColor(id),
    avatar: generateUserInitials(name)
  };
}

/**
 * Factory function to create an awareness provider.
 */
export function createAwarenessProvider(
  awareness: Awareness,
  userInfo?: Partial<IUserPresence>,
  options?: Partial<Omit<IAwarenessProviderOptions, 'userInfo'>>
): AwarenessProvider {
  const fullUserInfo = {
    ...createDefaultUserInfo(),
    ...userInfo
  };

  const fullOptions: IAwarenessProviderOptions = {
    userInfo: fullUserInfo,
    updateFrequency: 5000,
    activityTimeout: 300000,
    enableLogging: false,
    ...options
  };

  return new AwarenessProvider(awareness, fullOptions);
}

/**
 * Type guard to check if an object is a valid user presence.
 */
export function isValidUserPresence(obj: any): obj is IUserPresence {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.userId === 'string' &&
    typeof obj.displayName === 'string' &&
    ['active', 'idle', 'away', 'busy'].includes(obj.status) &&
    typeof obj.lastActivity === 'number' &&
    typeof obj.color === 'string'
  );
}

/**
 * Type guard to check if an object is a valid selection state.
 */
export function isValidSelectionState(obj: any): obj is ISelectionState {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.cellId === 'string' &&
    typeof obj.position === 'number' &&
    typeof obj.timestamp === 'number' &&
    (!obj.selection || (
      obj.selection &&
      typeof obj.selection.anchor === 'number' &&
      typeof obj.selection.head === 'number'
    ))
  );
}