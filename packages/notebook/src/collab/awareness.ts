/**
 * Implements user presence tracking and cursor synchronization using the Yjs awareness protocol.
 * This module tracks and broadcasts user presence, editing activity, and cursor positions
 * in real-time across all connected clients.
 */

import { Doc } from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { ISignal, Signal } from '@lumino/signaling';

/**
 * Interface for user metadata in awareness state
 */
export interface IUserMetadata {
  /**
   * User's display name
   */
  name: string;

  /**
   * URL to user's avatar image
   */
  avatar?: string;

  /**
   * User's role in the collaborative session (e.g., 'viewer', 'editor', 'admin')
   */
  role?: string;

  /**
   * Additional user information
   */
  [key: string]: any;
}

/**
 * Interface for cursor position in awareness state
 */
export interface ICursorPosition {
  /**
   * Index of the cell containing the cursor
   */
  cellIndex: number;

  /**
   * Position within the cell (character offset)
   */
  offset: number;

  /**
   * Whether the cursor is currently active/focused
   */
  active: boolean;

  /**
   * Selection range if text is selected (start and end positions)
   */
  selection?: {
    start: number;
    end: number;
  };
}

/**
 * Interface for user activity in awareness state
 */
export interface IUserActivity {
  /**
   * Type of activity (e.g., 'editing', 'viewing', 'commenting')
   */
  type: string;

  /**
   * Timestamp when the activity started
   */
  timestamp: number;

  /**
   * Additional activity metadata
   */
  metadata?: Record<string, any>;
}

/**
 * Complete awareness state for a user
 */
export interface IAwarenessState {
  /**
   * User metadata
   */
  user: IUserMetadata;

  /**
   * Current cursor position
   */
  cursor?: ICursorPosition;

  /**
   * Current user activity
   */
  activity?: IUserActivity;

  /**
   * Additional awareness state fields
   */
  [key: string]: any;
}

/**
 * Interface for awareness change events
 */
export interface IAwarenessChanges {
  /**
   * Client IDs that were added
   */
  added: number[];

  /**
   * Client IDs that were updated
   */
  updated: number[];

  /**
   * Client IDs that were removed
   */
  removed: number[];
}

/**
 * Interface for the YjsAwareness class
 */
export interface IYjsAwareness {
  /**
   * Signal emitted when awareness state changes
   */
  readonly stateChanged: ISignal<IYjsAwareness, IAwarenessChanges>;

  /**
   * Get the local client ID
   */
  readonly clientID: number;

  /**
   * Get all awareness states
   */
  getStates(): Map<number, IAwarenessState>;

  /**
   * Get the local awareness state
   */
  getLocalState(): IAwarenessState | null;

  /**
   * Set the local awareness state
   */
  setLocalState(state: IAwarenessState | null): void;

  /**
   * Update a specific field in the local awareness state
   */
  setLocalStateField(field: string, value: any): void;

  /**
   * Remove awareness states for specific clients
   */
  removeStates(clients: number[], origin?: any): void;

  /**
   * Clean up resources
   */
  destroy(): void;
}

/**
 * Implementation of the YjsAwareness interface using the Yjs awareness protocol
 */
export class YjsAwareness implements IYjsAwareness {
  /**
   * Signal emitted when awareness state changes
   */
  readonly stateChanged: Signal<IYjsAwareness, IAwarenessChanges> = new Signal<IYjsAwareness, IAwarenessChanges>(this);

  /**
   * The underlying Yjs awareness instance
   */
  private _awareness: awarenessProtocol.Awareness;

  /**
   * Local storage key for persisting awareness state
   */
  private _storageKey: string;

  /**
   * Constructor
   * 
   * @param doc - The Yjs document
   * @param options - Configuration options
   */
  constructor(doc: Doc, options: { storageKey?: string } = {}) {
    this._awareness = new awarenessProtocol.Awareness(doc);
    this._storageKey = options.storageKey || `jupyter-notebook-awareness-${doc.clientID}`;

    // Set up event listeners
    this._awareness.on('update', this._onAwarenessUpdate.bind(this));

    // Try to restore local state from storage
    this._restoreLocalState();

    // Set up beforeunload handler to clean up awareness state
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this._onBeforeUnload.bind(this));
    }
  }

  /**
   * Get the local client ID
   */
  get clientID(): number {
    return this._awareness.clientID;
  }

  /**
   * Get all awareness states
   */
  getStates(): Map<number, IAwarenessState> {
    return this._awareness.getStates() as Map<number, IAwarenessState>;
  }

  /**
   * Get the local awareness state
   */
  getLocalState(): IAwarenessState | null {
    return this._awareness.getLocalState() as IAwarenessState | null;
  }

  /**
   * Set the local awareness state
   * 
   * @param state - The new local state or null to mark as offline
   */
  setLocalState(state: IAwarenessState | null): void {
    this._awareness.setLocalState(state);
    this._persistLocalState();
  }

  /**
   * Update a specific field in the local awareness state
   * 
   * @param field - The field to update
   * @param value - The new value
   */
  setLocalStateField(field: string, value: any): void {
    this._awareness.setLocalStateField(field, value);
    this._persistLocalState();
  }

  /**
   * Remove awareness states for specific clients
   * 
   * @param clients - Array of client IDs to remove
   * @param origin - Optional origin information
   */
  removeStates(clients: number[], origin?: any): void {
    awarenessProtocol.removeAwarenessStates(this._awareness, clients, origin);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    // Remove event listeners
    this._awareness.off('update', this._onAwarenessUpdate);

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._onBeforeUnload);
    }

    // Clear local state
    this.setLocalState(null);
  }

  /**
   * Create an encoded awareness update for the specified clients
   * 
   * @param clients - Array of client IDs to include in the update
   * @returns Encoded awareness update as Uint8Array
   */
  encodeUpdate(clients: number[]): Uint8Array {
    return awarenessProtocol.encodeAwarenessUpdate(this._awareness, clients);
  }

  /**
   * Apply an encoded awareness update
   * 
   * @param update - The encoded update to apply
   * @param origin - Optional origin information
   */
  applyUpdate(update: Uint8Array, origin?: any): void {
    awarenessProtocol.applyAwarenessUpdate(this._awareness, update, origin);
  }

  /**
   * Handle awareness update events
   * 
   * @param changes - The awareness changes
   * @param origin - Origin of the changes
   */
  private _onAwarenessUpdate(changes: IAwarenessChanges, origin: any): void {
    // Emit the stateChanged signal
    this.stateChanged.emit(changes);

    // Persist local state if it was updated
    if (changes.updated.includes(this.clientID)) {
      this._persistLocalState();
    }
  }

  /**
   * Handle beforeunload event to clean up awareness state
   */
  private _onBeforeUnload(): void {
    // Remove our own state when the page is closed
    awarenessProtocol.removeAwarenessStates(
      this._awareness,
      [this.clientID],
      'window unload'
    );
  }

  /**
   * Persist local awareness state to storage
   */
  private _persistLocalState(): void {
    try {
      const localState = this.getLocalState();
      if (localState && typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(this._storageKey, JSON.stringify(localState));
      }
    } catch (err) {
      console.warn('Failed to persist awareness state:', err);
    }
  }

  /**
   * Restore local awareness state from storage
   */
  private _restoreLocalState(): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const storedState = window.localStorage.getItem(this._storageKey);
        if (storedState) {
          const state = JSON.parse(storedState) as IAwarenessState;
          this.setLocalState(state);
        }
      }
    } catch (err) {
      console.warn('Failed to restore awareness state:', err);
    }
  }
}