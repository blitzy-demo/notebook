// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Cell, ICellModel } from '@jupyterlab/cells';
import { IObservableMap } from '@jupyterlab/observables';
import { ISignal, Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { UUID } from '@lumino/coreutils';
import * as Y from 'yjs';

import { IYjsAwareness, ICursorPosition, IAwarenessState } from './collab/awareness';
import { ILockManager, ILockInfo } from './collab/locks';

/**
 * Interface for collaborative cell state
 */
export interface ICollaborativeCellState {
  /**
   * Whether the cell is currently being edited by a remote user
   */
  isRemotelyEdited: boolean;

  /**
   * The ID of the user currently editing the cell, if any
   */
  editorId?: string;

  /**
   * The name of the user currently editing the cell, if any
   */
  editorName?: string;

  /**
   * Whether the cell is currently locked
   */
  isLocked: boolean;

  /**
   * The lock information if the cell is locked
   */
  lockInfo?: ILockInfo;

  /**
   * Remote cursors and selections in this cell
   */
  remoteCursors: Map<string, ICursorPosition>;
}

/**
 * Interface for a cell with collaborative editing support
 */
export interface ICollaborativeCell extends Cell {
  /**
   * The collaborative state of the cell
   */
  readonly collaborativeState: ICollaborativeCellState;

  /**
   * Signal emitted when the collaborative state changes
   */
  readonly collaborativeStateChanged: ISignal<ICollaborativeCell, void>;

  /**
   * Attempt to acquire a lock on this cell
   * 
   * @returns A promise that resolves to true if the lock was acquired, false otherwise
   */
  acquireLock(): Promise<boolean>;

  /**
   * Release the lock on this cell
   * 
   * @returns A promise that resolves to true if the lock was released, false otherwise
   */
  releaseLock(): Promise<boolean>;

  /**
   * Update the collaborative state based on awareness and lock information
   */
  updateCollaborativeState(): void;

  /**
   * Set up collaborative editing for this cell
   * 
   * @param ydoc - The Yjs document
   * @param awareness - The awareness instance
   * @param lockManager - The lock manager
   */
  setupCollaboration(ydoc: Y.Doc, awareness: IYjsAwareness, lockManager: ILockManager): void;

  /**
   * Clean up collaborative editing resources
   */
  cleanupCollaboration(): void;
}

/**
 * Default implementation of a cell with collaborative editing support
 */
export class CollaborativeCell extends Cell implements ICollaborativeCell {
  /**
   * Constructor
   * 
   * @param options - The cell initialization options
   */
  constructor(options: Cell.IOptions) {
    super(options);
    this._collaborativeState = {
      isRemotelyEdited: false,
      isLocked: false,
      remoteCursors: new Map<string, ICursorPosition>()
    };

    // Add CSS class for collaborative cell
    this.addClass('jp-CollaborativeCell');

    // Create remote cursors container
    this._remoteCursorsContainer = document.createElement('div');
    this._remoteCursorsContainer.className = 'jp-CollaborativeCell-remoteCursors';
    this.node.appendChild(this._remoteCursorsContainer);

    // Create lock indicator
    this._lockIndicator = document.createElement('div');
    this._lockIndicator.className = 'jp-CollaborativeCell-lockIndicator';
    this._lockIndicator.style.display = 'none';
    this.node.appendChild(this._lockIndicator);

    // Handle editor focus events to update awareness
    this.editor.focus.connect(this._onEditorFocus, this);
    this.editor.blur.connect(this._onEditorBlur, this);
  }

  /**
   * The collaborative state of the cell
   */
  get collaborativeState(): ICollaborativeCellState {
    return this._collaborativeState;
  }

  /**
   * Signal emitted when the collaborative state changes
   */
  get collaborativeStateChanged(): ISignal<ICollaborativeCell, void> {
    return this._collaborativeStateChanged;
  }

  /**
   * Attempt to acquire a lock on this cell
   * 
   * @returns A promise that resolves to true if the lock was acquired, false otherwise
   */
  async acquireLock(): Promise<boolean> {
    if (!this._lockManager) {
      return false;
    }

    const result = await this._lockManager.acquireLock(this.model.id);
    if (result.success) {
      this.updateCollaborativeState();
      return true;
    }

    // If lock acquisition failed, update UI to show who has the lock
    this.updateCollaborativeState();
    return false;
  }

  /**
   * Release the lock on this cell
   * 
   * @returns A promise that resolves to true if the lock was released, false otherwise
   */
  async releaseLock(): Promise<boolean> {
    if (!this._lockManager) {
      return false;
    }

    const result = await this._lockManager.releaseLock(this.model.id);
    if (result) {
      this.updateCollaborativeState();
    }
    return result;
  }

  /**
   * Update the collaborative state based on awareness and lock information
   */
  updateCollaborativeState(): void {
    if (!this._awareness || !this._lockManager) {
      return;
    }

    // Get lock information
    const lockInfo = this._lockManager.getLock(this.model.id);
    const isLocked = !!lockInfo;
    const hasLock = this._lockManager.hasLock(this.model.id);

    // Update lock state
    this._collaborativeState.isLocked = isLocked;
    this._collaborativeState.lockInfo = lockInfo || undefined;

    // Update remote editing state
    const awarenessStates = this._awareness.getStates();
    const remoteCursors = new Map<string, ICursorPosition>();
    let isRemotelyEdited = false;
    let editorId: string | undefined;
    let editorName: string | undefined;

    // Process awareness states to find remote cursors and active editors
    awarenessStates.forEach((state: IAwarenessState, clientId: number) => {
      // Skip our own state
      if (clientId === this._awareness!.clientID) {
        return;
      }

      // Check if this user has a cursor in this cell
      if (state.cursor && state.cursor.cellIndex === this._cellIndex) {
        const userId = state.user.id || `user-${clientId}`;
        remoteCursors.set(userId, state.cursor);

        // If the user is actively editing this cell
        if (state.cursor.active) {
          isRemotelyEdited = true;
          editorId = userId;
          editorName = state.user.name || `User ${clientId}`;
        }
      }
    });

    // Update collaborative state
    this._collaborativeState.isRemotelyEdited = isRemotelyEdited;
    this._collaborativeState.editorId = editorId;
    this._collaborativeState.editorName = editorName;
    this._collaborativeState.remoteCursors = remoteCursors;

    // Update UI
    this._updateLockIndicator();
    this._updateRemoteCursors();
    this._updateCellClasses();

    // Emit signal
    this._collaborativeStateChanged.emit(void 0);
  }

  /**
   * Set up collaborative editing for this cell
   * 
   * @param ydoc - The Yjs document
   * @param awareness - The awareness instance
   * @param lockManager - The lock manager
   * @param cellIndex - The index of this cell in the notebook
   */
  setupCollaboration(ydoc: Y.Doc, awareness: IYjsAwareness, lockManager: ILockManager, cellIndex?: number): void {
    this._ydoc = ydoc;
    this._awareness = awareness;
    this._lockManager = lockManager;
    this._cellIndex = cellIndex !== undefined ? cellIndex : -1;

    // Set up Yjs text binding for the editor if not already set up
    if (!this._ytext && this.editor) {
      // Get or create a Yjs text for this cell
      const cellId = this.model.id;
      this._ytext = this._ydoc.getText(`cell:${cellId}`);

      // Bind the editor to the Yjs text
      this._bindEditor();
    }

    // Set up awareness change handler
    if (this._awareness) {
      this._awarenessChangeHandler = (changes: any) => {
        this.updateCollaborativeState();
      };
      this._awareness.stateChanged.connect(this._awarenessChangeHandler);
    }

    // Set up lock change handlers
    if (this._lockManager) {
      this._lockAcquiredHandler = (info: ILockInfo) => {
        if (info.cellId === this.model.id) {
          this.updateCollaborativeState();
        }
      };
      this._lockReleasedHandler = (info: ILockInfo) => {
        if (info.cellId === this.model.id) {
          this.updateCollaborativeState();
        }
      };
      this._lockManager.lockAcquired.connect(this._lockAcquiredHandler);
      this._lockManager.lockReleased.connect(this._lockReleasedHandler);
    }

    // Initial update of collaborative state
    this.updateCollaborativeState();
  }

  /**
   * Clean up collaborative editing resources
   */
  cleanupCollaboration(): void {
    // Disconnect awareness change handler
    if (this._awareness && this._awarenessChangeHandler) {
      this._awareness.stateChanged.disconnect(this._awarenessChangeHandler);
      this._awarenessChangeHandler = null;
    }

    // Disconnect lock change handlers
    if (this._lockManager) {
      if (this._lockAcquiredHandler) {
        this._lockManager.lockAcquired.disconnect(this._lockAcquiredHandler);
        this._lockAcquiredHandler = null;
      }
      if (this._lockReleasedHandler) {
        this._lockManager.lockReleased.disconnect(this._lockReleasedHandler);
        this._lockReleasedHandler = null;
      }
    }

    // Release any locks we hold
    if (this._lockManager && this._lockManager.hasLock(this.model.id)) {
      this.releaseLock().catch(error => {
        console.error('Error releasing lock during cleanup:', error);
      });
    }

    // Clean up Yjs text binding
    this._unbindEditor();

    // Clear references
    this._ydoc = null;
    this._awareness = null;
    this._lockManager = null;
    this._ytext = null;
  }

  /**
   * Dispose of the cell
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    // Clean up collaborative editing resources
    this.cleanupCollaboration();

    // Remove DOM elements
    if (this._remoteCursorsContainer && this._remoteCursorsContainer.parentNode) {
      this._remoteCursorsContainer.parentNode.removeChild(this._remoteCursorsContainer);
      this._remoteCursorsContainer = null;
    }

    if (this._lockIndicator && this._lockIndicator.parentNode) {
      this._lockIndicator.parentNode.removeChild(this._lockIndicator);
      this._lockIndicator = null;
    }

    super.dispose();
  }

  /**
   * Handle cell model changes
   */
  protected onModelChanged(oldValue: ICellModel, newValue: ICellModel): void {
    super.onModelChanged(oldValue, newValue);

    // Clean up old bindings
    this._unbindEditor();

    // Set up new bindings if collaboration is active
    if (this._ydoc && this._awareness && this._lockManager) {
      this.setupCollaboration(this._ydoc, this._awareness, this._lockManager, this._cellIndex);
    }
  }

  /**
   * Handle editor focus events
   */
  private _onEditorFocus(): void {
    if (!this._awareness) {
      return;
    }

    // Try to acquire a lock when the editor is focused
    this.acquireLock().catch(error => {
      console.error('Error acquiring lock on focus:', error);
    });

    // Update awareness state to show we're editing this cell
    const cursorPos = this.editor.getCursorPosition();
    const selection = this.editor.getSelection();

    this._awareness.setLocalStateField('cursor', {
      cellIndex: this._cellIndex,
      offset: cursorPos.column,
      active: true,
      selection: selection ? {
        start: selection.start.column,
        end: selection.end.column
      } : undefined
    });
  }

  /**
   * Handle editor blur events
   */
  private _onEditorBlur(): void {
    if (!this._awareness) {
      return;
    }

    // Update awareness state to show we're no longer editing this cell
    const cursorState = this._awareness.getLocalState()?.cursor;
    if (cursorState && cursorState.cellIndex === this._cellIndex) {
      this._awareness.setLocalStateField('cursor', {
        ...cursorState,
        active: false
      });
    }

    // Release the lock after a short delay to allow for focus switching between cells
    setTimeout(() => {
      // Only release if we still don't have focus
      if (!this.editor.hasFocus) {
        this.releaseLock().catch(error => {
          console.error('Error releasing lock on blur:', error);
        });
      }
    }, 1000);
  }

  /**
   * Bind the editor to the Yjs text
   */
  private _bindEditor(): void {
    if (!this._ytext || !this.editor) {
      return;
    }

    // This is a placeholder for the actual binding implementation
    // In a real implementation, this would use a CodeMirror binding for Yjs
    // such as y-codemirror or a custom implementation
    console.log('Binding editor to Yjs text for cell', this.model.id);

    // For now, we'll just set up change handlers to demonstrate the concept
    this._editorChangeHandler = (sender: any, args: any) => {
      // Only update the Yjs text if we have a lock
      if (this._lockManager && this._lockManager.hasLock(this.model.id)) {
        const text = this.editor.model.value.text;
        // Apply the change to the Yjs text
        this._ytext!.delete(0, this._ytext!.length);
        this._ytext!.insert(0, text);
      }
    };

    this._ytextChangeHandler = (event: Y.YTextEvent) => {
      // Only update the editor if we don't have a lock (i.e., it's a remote change)
      if (!this._lockManager || !this._lockManager.hasLock(this.model.id)) {
        const text = this._ytext!.toString();
        // Apply the change to the editor
        this.editor.model.value.text = text;
      }
    };

    // Connect the handlers
    this.editor.model.value.changed.connect(this._editorChangeHandler);
    this._ytext.observe(this._ytextChangeHandler);
  }

  /**
   * Unbind the editor from the Yjs text
   */
  private _unbindEditor(): void {
    // Disconnect the editor change handler
    if (this.editor && this._editorChangeHandler) {
      this.editor.model.value.changed.disconnect(this._editorChangeHandler);
      this._editorChangeHandler = null;
    }

    // Disconnect the Yjs text change handler
    if (this._ytext && this._ytextChangeHandler) {
      this._ytext.unobserve(this._ytextChangeHandler);
      this._ytextChangeHandler = null;
    }
  }

  /**
   * Update the lock indicator
   */
  private _updateLockIndicator(): void {
    if (!this._lockIndicator) {
      return;
    }

    const { isLocked, lockInfo } = this._collaborativeState;

    if (isLocked && lockInfo) {
      // Show the lock indicator
      this._lockIndicator.style.display = 'block';

      // Update the lock indicator content
      const isOwnLock = this._lockManager && this._lockManager.hasLock(this.model.id);
      if (isOwnLock) {
        this._lockIndicator.textContent = 'Editing';
        this._lockIndicator.className = 'jp-CollaborativeCell-lockIndicator jp-CollaborativeCell-ownLock';
      } else {
        this._lockIndicator.textContent = `Locked by ${lockInfo.userName}`;
        this._lockIndicator.className = 'jp-CollaborativeCell-lockIndicator jp-CollaborativeCell-remoteLock';
      }
    } else {
      // Hide the lock indicator
      this._lockIndicator.style.display = 'none';
    }
  }

  /**
   * Update the remote cursors
   */
  private _updateRemoteCursors(): void {
    if (!this._remoteCursorsContainer) {
      return;
    }

    // Clear existing cursors
    this._remoteCursorsContainer.innerHTML = '';

    // Add new cursors
    const { remoteCursors } = this._collaborativeState;
    remoteCursors.forEach((cursor, userId) => {
      // Create cursor element
      const cursorElement = document.createElement('div');
      cursorElement.className = 'jp-CollaborativeCell-remoteCursor';
      cursorElement.dataset.userId = userId;

      // Position the cursor
      // In a real implementation, this would convert the cursor position to pixel coordinates
      // For now, we'll just use a placeholder position
      cursorElement.style.left = `${cursor.offset * 8}px`; // Approximate character width

      // Add user name tooltip
      cursorElement.title = this._getUserNameFromId(userId);

      // Add selection if present
      if (cursor.selection && cursor.selection.start !== cursor.selection.end) {
        const selectionElement = document.createElement('div');
        selectionElement.className = 'jp-CollaborativeCell-remoteSelection';
        selectionElement.dataset.userId = userId;

        // Position the selection
        // In a real implementation, this would convert the selection range to pixel coordinates
        const start = Math.min(cursor.selection.start, cursor.selection.end);
        const end = Math.max(cursor.selection.start, cursor.selection.end);
        selectionElement.style.left = `${start * 8}px`; // Approximate character width
        selectionElement.style.width = `${(end - start) * 8}px`; // Approximate character width

        this._remoteCursorsContainer.appendChild(selectionElement);
      }

      this._remoteCursorsContainer.appendChild(cursorElement);
    });
  }

  /**
   * Update cell CSS classes based on collaborative state
   */
  private _updateCellClasses(): void {
    const { isLocked, isRemotelyEdited } = this._collaborativeState;
    const hasLock = this._lockManager && this._lockManager.hasLock(this.model.id);

    // Update locked class
    this.toggleClass('jp-CollaborativeCell-locked', isLocked);
    this.toggleClass('jp-CollaborativeCell-ownLock', isLocked && hasLock);
    this.toggleClass('jp-CollaborativeCell-remoteLock', isLocked && !hasLock);

    // Update remote editing class
    this.toggleClass('jp-CollaborativeCell-remotelyEdited', isRemotelyEdited);
  }

  /**
   * Get a user's display name from their ID
   * 
   * @param userId - The user ID
   * @returns The user's display name
   */
  private _getUserNameFromId(userId: string): string {
    if (!this._awareness) {
      return userId;
    }

    // Look up the user in the awareness states
    const states = this._awareness.getStates();
    for (const [clientId, state] of states.entries()) {
      if (state.user && (state.user.id === userId || `user-${clientId}` === userId)) {
        return state.user.name || `User ${clientId}`;
      }
    }

    return userId;
  }

  private _collaborativeState: ICollaborativeCellState;
  private _collaborativeStateChanged = new Signal<ICollaborativeCell, void>(this);
  private _ydoc: Y.Doc | null = null;
  private _awareness: IYjsAwareness | null = null;
  private _lockManager: ILockManager | null = null;
  private _ytext: Y.Text | null = null;
  private _cellIndex: number = -1;
  private _remoteCursorsContainer: HTMLElement | null;
  private _lockIndicator: HTMLElement | null;
  private _awarenessChangeHandler: ((changes: any) => void) | null = null;
  private _lockAcquiredHandler: ((info: ILockInfo) => void) | null = null;
  private _lockReleasedHandler: ((info: ILockInfo) => void) | null = null;
  private _editorChangeHandler: ((sender: any, args: any) => void) | null = null;
  private _ytextChangeHandler: ((event: Y.YTextEvent) => void) | null = null;
}

/**
 * Create a collaborative cell from a regular cell
 * 
 * @param cell - The cell to convert
 * @returns A collaborative cell
 */
export function createCollaborativeCell(cell: Cell): ICollaborativeCell {
  // If the cell is already a collaborative cell, return it
  if ((cell as any).collaborativeState) {
    return cell as ICollaborativeCell;
  }

  // Create a new collaborative cell with the same options
  const options = {
    model: cell.model,
    rendermime: (cell as any).rendermime,
    contentFactory: (cell as any).contentFactory
  };

  const collaborativeCell = new CollaborativeCell(options);

  // Copy any additional properties or state as needed
  // ...

  return collaborativeCell;
}

/**
 * Default implementation of a cell factory that creates collaborative cells
 */
export namespace CollaborativeCellFactory {
  /**
   * Create a new collaborative cell
   * 
   * @param options - The cell creation options
   * @returns A new collaborative cell
   */
  export function createCell(options: Cell.IOptions): ICollaborativeCell {
    return new CollaborativeCell(options);
  }

  /**
   * Convert an existing cell to a collaborative cell
   * 
   * @param cell - The cell to convert
   * @returns A collaborative cell
   */
  export function convertCell(cell: Cell): ICollaborativeCell {
    return createCollaborativeCell(cell);
  }
}