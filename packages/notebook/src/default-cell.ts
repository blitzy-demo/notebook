// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Cell, ICellModel } from '@jupyterlab/cells';
import { IObservableMap } from '@jupyterlab/observables';
import { ISignal, Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { CodeEditor } from '@jupyterlab/codeeditor';
import * as Y from 'yjs';

import { ILockManager } from './collab/locks';
import { YjsAwareness } from './collab/awareness';

/**
 * An interface describing the collaborative state of a cell.
 */
export interface ICollaborativeCellState {
  /**
   * Whether the cell is currently locked for editing.
   */
  locked: boolean;

  /**
   * The ID of the user who has locked the cell, if any.
   */
  lockedBy: string | null;

  /**
   * The Yjs shared document for this cell.
   */
  ydoc: Y.Doc | null;

  /**
   * The Yjs text type for the cell's content.
   */
  ytext: Y.Text | null;

  /**
   * The awareness instance for tracking user presence in this cell.
   */
  awareness: YjsAwareness | null;
}

/**
 * An interface describing a cell with collaborative editing capabilities.
 */
export interface ICollaborativeCell extends Cell {
  /**
   * The collaborative state of the cell.
   */
  readonly collaborativeState: ICollaborativeCellState;

  /**
   * Signal emitted when the collaborative state of the cell changes.
   */
  readonly collaborativeStateChanged: ISignal<ICollaborativeCell, void>;

  /**
   * Acquire a lock on this cell for editing.
   * 
   * @returns A promise that resolves to a boolean indicating whether the lock was acquired.
   */
  acquireLock(): Promise<boolean>;

  /**
   * Release the lock on this cell.
   * 
   * @returns A promise that resolves when the lock is released.
   */
  releaseLock(): Promise<void>;

  /**
   * Update the visual indicators for remote cursors and selections.
   */
  updateRemoteCursors(): void;

  /**
   * Update the lock status indicator.
   */
  updateLockStatus(): void;
}

/**
 * An interface describing a cell model with collaborative editing capabilities.
 */
export interface ICollaborativeCellModel extends ICellModel {
  /**
   * The Yjs shared document for this cell model.
   */
  readonly ydoc: Y.Doc | null;

  /**
   * The Yjs text type for the cell's content.
   */
  readonly ytext: Y.Text | null;

  /**
   * Set the Yjs shared document for this cell model.
   */
  setYDoc(ydoc: Y.Doc): void;

  /**
   * Signal emitted when the Yjs document changes.
   */
  readonly ydocChanged: ISignal<ICollaborativeCellModel, void>;
}

/**
 * A class that adds collaborative editing capabilities to a cell.
 */
export class CollaborativeCell extends Cell implements ICollaborativeCell {
  /**
   * Construct a new collaborative cell.
   */
  constructor(options: Cell.IOptions) {
    super(options);
    this._collaborativeState = {
      locked: false,
      lockedBy: null,
      ydoc: null,
      ytext: null,
      awareness: null
    };

    // Add CSS class for collaborative cell
    this.addClass('jp-CollaborativeCell');

    // Create lock status indicator
    this._lockStatusIndicator = new Widget();
    this._lockStatusIndicator.addClass('jp-CollaborativeCell-LockIndicator');
    this.layout!.addWidget(this._lockStatusIndicator);

    // Create remote cursors container
    this._remoteCursorsContainer = new Widget();
    this._remoteCursorsContainer.addClass('jp-CollaborativeCell-RemoteCursors');
    this.layout!.addWidget(this._remoteCursorsContainer);

    // Initialize collaborative features if the model supports them
    if (this._isCollaborativeModel(this.model)) {
      this._initializeCollaboration();
    }

    // Listen for model changes
    this.model.contentChanged.connect(this._onContentChanged, this);
  }

  /**
   * The collaborative state of the cell.
   */
  get collaborativeState(): ICollaborativeCellState {
    return this._collaborativeState;
  }

  /**
   * Signal emitted when the collaborative state of the cell changes.
   */
  get collaborativeStateChanged(): ISignal<ICollaborativeCell, void> {
    return this._collaborativeStateChanged;
  }

  /**
   * Acquire a lock on this cell for editing.
   * 
   * @returns A promise that resolves to a boolean indicating whether the lock was acquired.
   */
  async acquireLock(): Promise<boolean> {
    if (!this._lockManager) {
      return true; // No lock manager, so editing is always allowed
    }

    const lockAcquired = await this._lockManager.acquireLock(this.model.id);
    if (lockAcquired) {
      this._collaborativeState.locked = true;
      this._collaborativeState.lockedBy = this._getCurrentUserId();
      this.updateLockStatus();
      this._collaborativeStateChanged.emit(void 0);
    }
    return lockAcquired;
  }

  /**
   * Release the lock on this cell.
   * 
   * @returns A promise that resolves when the lock is released.
   */
  async releaseLock(): Promise<void> {
    if (!this._lockManager || !this._collaborativeState.locked) {
      return;
    }

    await this._lockManager.releaseLock(this.model.id);
    this._collaborativeState.locked = false;
    this._collaborativeState.lockedBy = null;
    this.updateLockStatus();
    this._collaborativeStateChanged.emit(void 0);
  }

  /**
   * Update the visual indicators for remote cursors and selections.
   */
  updateRemoteCursors(): void {
    if (!this._collaborativeState.awareness) {
      return;
    }

    // Clear existing cursors
    this._remoteCursorsContainer.node.innerHTML = '';

    const awareness = this._collaborativeState.awareness;
    const currentUserId = this._getCurrentUserId();
    const states = awareness.getStates();

    // Iterate through all users
    states.forEach((state, clientId) => {
      // Skip current user
      if (clientId.toString() === currentUserId) {
        return;
      }

      // Check if user has cursor data for this cell
      if (state.cursor && state.cursor.cellId === this.model.id) {
        this._renderRemoteCursor(clientId, state);
      }
    });
  }

  /**
   * Update the lock status indicator.
   */
  updateLockStatus(): void {
    this._lockStatusIndicator.node.innerHTML = '';

    if (this._collaborativeState.locked) {
      const lockedBy = this._collaborativeState.lockedBy;
      const isCurrentUser = lockedBy === this._getCurrentUserId();

      // Update CSS classes based on lock state
      this.toggleClass('jp-CollaborativeCell-locked', true);
      this.toggleClass('jp-CollaborativeCell-lockedByCurrentUser', isCurrentUser);
      this.toggleClass('jp-CollaborativeCell-lockedByOtherUser', !isCurrentUser);

      // Create lock indicator content
      const lockIcon = document.createElement('div');
      lockIcon.className = 'jp-CollaborativeCell-lockIcon';
      
      const lockText = document.createElement('span');
      lockText.className = 'jp-CollaborativeCell-lockText';
      lockText.textContent = isCurrentUser ? 'Editing' : 'Locked';

      this._lockStatusIndicator.node.appendChild(lockIcon);
      this._lockStatusIndicator.node.appendChild(lockText);
    } else {
      // Remove lock-related CSS classes
      this.toggleClass('jp-CollaborativeCell-locked', false);
      this.toggleClass('jp-CollaborativeCell-lockedByCurrentUser', false);
      this.toggleClass('jp-CollaborativeCell-lockedByOtherUser', false);
    }
  }

  /**
   * Dispose of the resources held by the cell.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    // Clean up Yjs and awareness resources
    this._cleanupCollaboration();

    // Dispose of widgets
    if (this._lockStatusIndicator) {
      this._lockStatusIndicator.dispose();
    }
    if (this._remoteCursorsContainer) {
      this._remoteCursorsContainer.dispose();
    }

    super.dispose();
  }

  /**
   * Set the lock manager for this cell.
   */
  setLockManager(lockManager: ILockManager): void {
    this._lockManager = lockManager;
  }

  /**
   * Set the awareness instance for this cell.
   */
  setAwareness(awareness: YjsAwareness): void {
    // Clean up existing awareness if any
    if (this._collaborativeState.awareness) {
      this._collaborativeState.awareness.off('change', this._onAwarenessChange);
    }

    this._collaborativeState.awareness = awareness;
    awareness.on('change', this._onAwarenessChange);
    this.updateRemoteCursors();
    this._collaborativeStateChanged.emit(void 0);
  }

  /**
   * Initialize collaborative features for this cell.
   */
  private _initializeCollaboration(): void {
    const model = this.model as ICollaborativeCellModel;
    
    // Connect to model's Yjs document changes
    model.ydocChanged.connect(this._onYDocChanged, this);
    
    // Initialize with current Yjs document if available
    if (model.ydoc) {
      this._onYDocChanged();
    }
  }

  /**
   * Clean up collaborative resources.
   */
  private _cleanupCollaboration(): void {
    // Disconnect from Yjs document
    if (this._collaborativeState.ytext) {
      this._collaborativeState.ytext.unobserve(this._onYTextChange);
    }

    // Disconnect from awareness
    if (this._collaborativeState.awareness) {
      this._collaborativeState.awareness.off('change', this._onAwarenessChange);
    }

    // Release lock if held
    if (this._collaborativeState.locked) {
      this.releaseLock().catch(console.error);
    }

    // Clear collaborative state
    this._collaborativeState.ydoc = null;
    this._collaborativeState.ytext = null;
    this._collaborativeState.awareness = null;
  }

  /**
   * Handle changes to the Yjs document.
   */
  private _onYDocChanged(): void {
    const model = this.model as ICollaborativeCellModel;
    
    // Clean up existing Yjs resources
    if (this._collaborativeState.ytext) {
      this._collaborativeState.ytext.unobserve(this._onYTextChange);
    }

    // Update collaborative state with new Yjs document
    this._collaborativeState.ydoc = model.ydoc;
    this._collaborativeState.ytext = model.ytext;

    // Observe changes to the Yjs text
    if (this._collaborativeState.ytext) {
      this._collaborativeState.ytext.observe(this._onYTextChange);
    }

    this._collaborativeStateChanged.emit(void 0);
  }

  /**
   * Handle changes to the Yjs text.
   */
  private _onYTextChange = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    // Skip if the change originated from this client
    if (transaction.local) {
      return;
    }

    // Update the editor content if needed
    // This is handled by the editor binding in most cases
  };

  /**
   * Handle changes to the awareness state.
   */
  private _onAwarenessChange = (): void => {
    this.updateRemoteCursors();
  };

  /**
   * Handle changes to the cell content.
   */
  private _onContentChanged(): void {
    // Update cursor position in awareness if we have the lock
    if (this._collaborativeState.awareness && this._collaborativeState.locked) {
      const cursorPos = this._getCurrentCursorPosition();
      if (cursorPos !== null) {
        this._collaborativeState.awareness.setLocalStateField('cursor', {
          cellId: this.model.id,
          position: cursorPos,
          selection: this._getCurrentSelection()
        });
      }
    }
  }

  /**
   * Render a remote cursor for a specific user.
   */
  private _renderRemoteCursor(clientId: number, state: any): void {
    if (!state.user || !state.cursor) {
      return;
    }

    const cursorElement = document.createElement('div');
    cursorElement.className = 'jp-CollaborativeCell-remoteCursor';
    cursorElement.style.backgroundColor = state.user.color || '#000';
    cursorElement.setAttribute('data-user-id', clientId.toString());
    
    const cursorLabel = document.createElement('div');
    cursorLabel.className = 'jp-CollaborativeCell-remoteCursorLabel';
    cursorLabel.textContent = state.user.name || `User ${clientId}`;
    cursorLabel.style.backgroundColor = state.user.color || '#000';
    
    cursorElement.appendChild(cursorLabel);
    
    // Position the cursor based on state.cursor.position
    const editor = this.editor;
    if (editor && state.cursor.position !== undefined) {
      try {
        // Convert position index to editor coordinates
        const position = this._positionToCoordinates(state.cursor.position);
        if (position) {
          cursorElement.style.left = `${position.left}px`;
          cursorElement.style.top = `${position.top}px`;
          cursorElement.style.height = `${position.height}px`;
        }
      } catch (error) {
        console.error('Error positioning remote cursor:', error);
      }
    }
    
    this._remoteCursorsContainer.node.appendChild(cursorElement);
    
    // If there's a selection, render it
    if (state.cursor.selection) {
      this._renderRemoteSelection(clientId, state);
    }
  }
  
  /**
   * Convert a text position index to editor coordinates.
   */
  private _positionToCoordinates(position: number): { left: number; top: number; height: number } | null {
    const editor = this.editor;
    if (!editor) {
      return null;
    }
    
    try {
      // For CodeMirror editor
      if ((editor as any).getDoc) {
        const doc = (editor as any).getDoc();
        const pos = doc.posFromIndex(position);
        const coords = (editor as any).charCoords(pos, 'local');
        const lineHeight = (editor as any).defaultTextHeight();
        
        return {
          left: coords.left,
          top: coords.top,
          height: lineHeight
        };
      }
      
      // For CodeEditor interface
      if ((editor as CodeEditor.IEditor).getPositionAt) {
        const pos = (editor as CodeEditor.IEditor).getPositionAt(position);
        if (pos) {
          const coords = (editor as CodeEditor.IEditor).getCoordinateForPosition(pos);
          if (coords) {
            return {
              left: coords.left,
              top: coords.top,
              height: (editor as any).lineHeight || 20
            };
          }
        }
      }
    } catch (error) {
      console.error('Error converting position to coordinates:', error);
    }
    
    return null;
  }

  /**
   * Render a remote selection for a specific user.
   */
  private _renderRemoteSelection(clientId: number, state: any): void {
    if (!state.user || !state.cursor || !state.cursor.selection) {
      return;
    }
    
    const selection = state.cursor.selection;
    const editor = this.editor;
    
    if (!editor || selection.start === selection.end) {
      return; // No selection or no editor
    }
    
    try {
      // Create selection element with user-specific color
      const selectionElement = document.createElement('div');
      selectionElement.className = 'jp-CollaborativeCell-remoteSelection';
      selectionElement.style.backgroundColor = this._getSelectionColor(state.user.color || '#000');
      selectionElement.setAttribute('data-user-id', clientId.toString());
      
      // For multi-line selections, we need to create multiple elements
      const startCoords = this._positionToCoordinates(selection.start);
      const endCoords = this._positionToCoordinates(selection.end);
      
      if (startCoords && endCoords) {
        // Simple case: single-line selection
        if (startCoords.top === endCoords.top) {
          selectionElement.style.left = `${startCoords.left}px`;
          selectionElement.style.top = `${startCoords.top}px`;
          selectionElement.style.width = `${endCoords.left - startCoords.left}px`;
          selectionElement.style.height = `${startCoords.height}px`;
          this._remoteCursorsContainer.node.appendChild(selectionElement);
        } else {
          // Complex case: multi-line selection
          // This is a simplified implementation that would need to be extended
          // for a complete multi-line selection rendering
          
          // First line (from start to end of line)
          const firstLine = document.createElement('div');
          firstLine.className = 'jp-CollaborativeCell-remoteSelection';
          firstLine.style.backgroundColor = this._getSelectionColor(state.user.color || '#000');
          firstLine.style.left = `${startCoords.left}px`;
          firstLine.style.top = `${startCoords.top}px`;
          firstLine.style.right = '0px'; // To end of line
          firstLine.style.height = `${startCoords.height}px`;
          
          // Last line (from start of line to end)
          const lastLine = document.createElement('div');
          lastLine.className = 'jp-CollaborativeCell-remoteSelection';
          lastLine.style.backgroundColor = this._getSelectionColor(state.user.color || '#000');
          lastLine.style.left = '0px'; // From start of line
          lastLine.style.top = `${endCoords.top}px`;
          lastLine.style.width = `${endCoords.left}px`;
          lastLine.style.height = `${endCoords.height}px`;
          
          // Middle area (if more than two lines)
          if (endCoords.top - startCoords.top > startCoords.height) {
            const middleArea = document.createElement('div');
            middleArea.className = 'jp-CollaborativeCell-remoteSelection';
            middleArea.style.backgroundColor = this._getSelectionColor(state.user.color || '#000');
            middleArea.style.left = '0px';
            middleArea.style.top = `${startCoords.top + startCoords.height}px`;
            middleArea.style.right = '0px';
            middleArea.style.height = `${endCoords.top - (startCoords.top + startCoords.height)}px`;
            this._remoteCursorsContainer.node.appendChild(middleArea);
          }
          
          this._remoteCursorsContainer.node.appendChild(firstLine);
          this._remoteCursorsContainer.node.appendChild(lastLine);
        }
      }
    } catch (error) {
      console.error('Error rendering remote selection:', error);
    }
  }

  /**
   * Get the current cursor position in the editor.
   * This is editor-specific and would need to be implemented
   * based on the specific editor being used.
   */
  private _getCurrentCursorPosition(): number | null {
    // For CodeMirror editor, we would get the cursor position from the editor instance
    // This is a simplified implementation that would need to be extended based on the editor type
    const editor = this.editor;
    if (editor && (editor as any).getCursor) {
      const cursor = (editor as any).getCursor();
      const doc = (editor as any).getDoc();
      return doc.indexFromPos(cursor);
    }
    return null;
  }

  /**
   * Get the current selection in the editor.
   * This is editor-specific and would need to be implemented
   * based on the specific editor being used.
   */
  private _getCurrentSelection(): { start: number; end: number } | null {
    // For CodeMirror editor, we would get the selection range from the editor instance
    // This is a simplified implementation that would need to be extended based on the editor type
    const editor = this.editor;
    if (editor && (editor as any).getDoc) {
      const doc = (editor as any).getDoc();
      const selection = doc.getSelection();
      if (selection) {
        const range = doc.getSelection();
        const from = doc.indexFromPos(range.from);
        const to = doc.indexFromPos(range.to);
        return { start: from, end: to };
      }
    }
    return null;
  }

  /**
   * Get the current user ID.
   */
  private _getCurrentUserId(): string {
    if (!this._collaborativeState.awareness) {
      return 'local';
    }
    return this._collaborativeState.awareness.clientID.toString();
  }

  /**
   * Get a semi-transparent color for selection highlighting.
   */
  private _getSelectionColor(color: string): string {
    // Convert hex color to rgba with transparency
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, 0.3)`;
    }
    return color;
  }

  /**
   * Check if a model implements the ICollaborativeCellModel interface.
   */
  private _isCollaborativeModel(model: ICellModel): model is ICollaborativeCellModel {
    return (
      (model as any).ydoc !== undefined &&
      (model as any).ytext !== undefined &&
      (model as any).ydocChanged !== undefined
    );
  }

  private _collaborativeState: ICollaborativeCellState;
  private _collaborativeStateChanged = new Signal<ICollaborativeCell, void>(this);
  private _lockManager: ILockManager | null = null;
  private _lockStatusIndicator: Widget;
  private _remoteCursorsContainer: Widget;
}

/**
 * The default implementation of a cell with collaborative editing capabilities.
 */
export class DefaultCell extends CollaborativeCell {
  /**
   * Construct a new default cell.
   */
  constructor(options: Cell.IOptions) {
    super(options);
    this.addClass('jp-DefaultCell');
    
    // Set up editor event listeners for cursor/selection tracking
    this._setupEditorListeners();
  }
  
  /**
   * Set up listeners for editor events to track cursor and selection changes.
   */
  private _setupEditorListeners(): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }
    
    // For CodeMirror editor
    if ((editor as any).on) {
      (editor as any).on('cursorActivity', () => {
        this._onEditorCursorActivity();
      });
    }
    
    // For CodeEditor interface
    if ((editor as CodeEditor.IEditor).model) {
      const model = (editor as CodeEditor.IEditor).model;
      model.selections.changed.connect(() => {
        this._onEditorCursorActivity();
      });
      model.value.changed.connect(() => {
        this._onEditorCursorActivity();
      });
    }
  }
  
  /**
   * Handle cursor activity in the editor.
   */
  private _onEditorCursorActivity(): void {
    // Only update awareness if we have the lock and awareness is set up
    if (this._collaborativeState.awareness && this._collaborativeState.locked) {
      const cursorPos = this._getCurrentCursorPosition();
      if (cursorPos !== null) {
        this._collaborativeState.awareness.setLocalStateField('cursor', {
          cellId: this.model.id,
          position: cursorPos,
          selection: this._getCurrentSelection()
        });
      }
    }
  }
}