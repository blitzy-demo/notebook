// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Cell, ICellModel } from '@jupyterlab/cells';
import { IObservableList } from '@jupyterlab/observables';
import { ISignal, Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { ILockManager } from './collab/locks';
import { YjsAwareness } from './collab/awareness';

/**
 * Interface for cell operation options with collaborative awareness.
 */
export interface ICellOperationOptions {
  /**
   * The lock manager to use for cell-level locking.
   */
  lockManager: ILockManager;

  /**
   * The awareness protocol instance for tracking user presence.
   */
  awareness: YjsAwareness;
}

/**
 * Interface for cell lock request result.
 */
export interface ICellLockResult {
  /**
   * Whether the lock was successfully acquired.
   */
  acquired: boolean;

  /**
   * The owner of the lock if not acquired.
   */
  owner?: {
    /**
     * The client ID of the lock owner.
     */
    clientId: number;

    /**
     * The user information of the lock owner.
     */
    user: any;
  };
}

/**
 * Class that manages cell-level operations with collaborative awareness.
 * 
 * This class coordinates cell selection, editing, execution, and movement operations
 * while ensuring consistency in a multi-user environment through cell-level locking.
 */
export class CellOperations {
  /**
   * Construct a new CellOperations.
   * 
   * @param cells - The list of notebook cells.
   * @param options - The cell operation options.
   */
  constructor(
    cells: IObservableList<ICellModel>,
    options: ICellOperationOptions
  ) {
    this._cells = cells;
    this._lockManager = options.lockManager;
    this._awareness = options.awareness;

    // Listen for changes in the cells list
    this._cells.changed.connect(this._onCellsChanged, this);

    // Listen for awareness changes to update UI
    this._awareness.on('change', this._onAwarenessChanged.bind(this));
  }

  /**
   * Signal emitted when a cell lock state changes.
   */
  get lockChanged(): ISignal<CellOperations, string> {
    return this._lockChanged;
  }

  /**
   * Signal emitted when a remote cursor or selection changes.
   */
  get remoteCursorChanged(): ISignal<CellOperations, { cellId: string, clientId: number }> {
    return this._remoteCursorChanged;
  }

  /**
   * Request a lock for a cell to perform an operation.
   * 
   * @param cellId - The ID of the cell to lock.
   * @param operation - The operation to perform (e.g., 'edit', 'execute').
   * @returns A promise that resolves to the lock result.
   */
  async requestLock(cellId: string, operation: string): Promise<ICellLockResult> {
    // Check if the cell is already locked
    const currentLock = this._lockManager.getLock(cellId);
    if (currentLock && currentLock.clientId !== this._awareness.clientID) {
      // Cell is locked by another user
      const states = this._awareness.getStates();
      const ownerState = states.get(currentLock.clientId);
      
      return {
        acquired: false,
        owner: {
          clientId: currentLock.clientId,
          user: ownerState?.user || { name: 'Unknown user' }
        }
      };
    }

    // Try to acquire the lock
    const lockAcquired = await this._lockManager.acquireLock(cellId, operation);
    
    if (lockAcquired) {
      // Update awareness state to indicate we're editing this cell
      this._updateAwarenessState(cellId, operation);
      
      // Emit lock changed signal
      this._lockChanged.emit(cellId);
      
      return { acquired: true };
    } else {
      // Lock acquisition failed (could be a race condition)
      const currentLock = this._lockManager.getLock(cellId);
      const states = this._awareness.getStates();
      const ownerState = currentLock ? states.get(currentLock.clientId) : undefined;
      
      return {
        acquired: false,
        owner: currentLock ? {
          clientId: currentLock.clientId,
          user: ownerState?.user || { name: 'Unknown user' }
        } : undefined
      };
    }
  }

  /**
   * Release a lock for a cell.
   * 
   * @param cellId - The ID of the cell to unlock.
   * @returns A promise that resolves when the lock is released.
   */
  async releaseLock(cellId: string): Promise<void> {
    const lockReleased = await this._lockManager.releaseLock(cellId);
    
    if (lockReleased) {
      // Update awareness state to indicate we're no longer editing this cell
      this._removeFromAwarenessState(cellId);
      
      // Emit lock changed signal
      this._lockChanged.emit(cellId);
    }
  }

  /**
   * Check if a cell is locked by the current user.
   * 
   * @param cellId - The ID of the cell to check.
   * @returns Whether the cell is locked by the current user.
   */
  isLockedByCurrentUser(cellId: string): boolean {
    const lock = this._lockManager.getLock(cellId);
    return lock !== null && lock.clientId === this._awareness.clientID;
  }

  /**
   * Check if a cell is locked by another user.
   * 
   * @param cellId - The ID of the cell to check.
   * @returns Whether the cell is locked by another user.
   */
  isLockedByOtherUser(cellId: string): boolean {
    const lock = this._lockManager.getLock(cellId);
    return lock !== null && lock.clientId !== this._awareness.clientID;
  }

  /**
   * Get information about who has locked a cell.
   * 
   * @param cellId - The ID of the cell to check.
   * @returns The lock owner information or null if the cell is not locked.
   */
  getLockOwner(cellId: string): { clientId: number, user: any } | null {
    const lock = this._lockManager.getLock(cellId);
    if (!lock) {
      return null;
    }

    const states = this._awareness.getStates();
    const ownerState = states.get(lock.clientId);
    
    return {
      clientId: lock.clientId,
      user: ownerState?.user || { name: 'Unknown user' }
    };
  }

  /**
   * Update the cursor position in a cell.
   * 
   * @param cellId - The ID of the cell.
   * @param position - The cursor position.
   */
  updateCursorPosition(cellId: string, position: number): void {
    const localState = this._awareness.getLocalState() || {};
    const cursors = localState.cursors || {};
    
    cursors[cellId] = {
      position,
      timestamp: Date.now()
    };
    
    this._awareness.setLocalStateField('cursors', cursors);
  }

  /**
   * Update the selection range in a cell.
   * 
   * @param cellId - The ID of the cell.
   * @param range - The selection range [start, end].
   */
  updateSelectionRange(cellId: string, range: [number, number]): void {
    const localState = this._awareness.getLocalState() || {};
    const selections = localState.selections || {};
    
    selections[cellId] = {
      range,
      timestamp: Date.now()
    };
    
    this._awareness.setLocalStateField('selections', selections);
  }

  /**
   * Get all remote cursors for a cell.
   * 
   * @param cellId - The ID of the cell.
   * @returns Map of client ID to cursor position.
   */
  getRemoteCursors(cellId: string): Map<number, number> {
    const result = new Map<number, number>();
    const states = this._awareness.getStates();
    const currentClientId = this._awareness.clientID;
    
    states.forEach((state, clientId) => {
      if (clientId !== currentClientId && state.cursors && state.cursors[cellId]) {
        result.set(clientId, state.cursors[cellId].position);
      }
    });
    
    return result;
  }

  /**
   * Get all remote selections for a cell.
   * 
   * @param cellId - The ID of the cell.
   * @returns Map of client ID to selection range.
   */
  getRemoteSelections(cellId: string): Map<number, [number, number]> {
    const result = new Map<number, [number, number]>();
    const states = this._awareness.getStates();
    const currentClientId = this._awareness.clientID;
    
    states.forEach((state, clientId) => {
      if (clientId !== currentClientId && state.selections && state.selections[cellId]) {
        result.set(clientId, state.selections[cellId].range);
      }
    });
    
    return result;
  }

  /**
   * Apply cell operations to a cell widget.
   * 
   * This method applies collaborative awareness features to a cell widget,
   * such as lock indicators and remote cursor visualization.
   * 
   * @param cell - The cell widget to apply operations to.
   */
  applyCellOperations(cell: Cell): void {
    const cellId = cell.model.id;
    
    // Add lock indicator if the cell is locked by another user
    if (this.isLockedByOtherUser(cellId)) {
      const lockOwner = this.getLockOwner(cellId);
      this._addLockIndicator(cell, lockOwner);
    } else {
      this._removeLockIndicator(cell);
    }
    
    // Add remote cursor and selection indicators
    this._updateRemoteCursorsAndSelections(cell);
  }

  /**
   * Dispose of the resources held by the cell operations.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._cells.changed.disconnect(this._onCellsChanged, this);
    this._awareness.off('change', this._onAwarenessChanged.bind(this));
    this._isDisposed = true;
    Signal.clearData(this);
  }

  /**
   * Whether the cell operations have been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Handle changes to the cells list.
   */
  private _onCellsChanged(sender: IObservableList<ICellModel>, args: IObservableList.IChangedArgs<ICellModel>): void {
    switch (args.type) {
      case 'add':
        // New cells added, ensure they have unique IDs for collaboration
        args.newValues.forEach(cellModel => {
          if (!cellModel.id) {
            console.warn('Cell model does not have an ID, which is required for collaboration');
          }
        });
        break;
      case 'remove':
        // Cells removed, release any locks held on them
        args.oldValues.forEach(cellModel => {
          if (this.isLockedByCurrentUser(cellModel.id)) {
            this.releaseLock(cellModel.id).catch(error => {
              console.error('Error releasing lock on removed cell:', error);
            });
          }
        });
        break;
      case 'set':
        // Handle replaced cells
        args.oldValues.forEach(cellModel => {
          if (this.isLockedByCurrentUser(cellModel.id)) {
            this.releaseLock(cellModel.id).catch(error => {
              console.error('Error releasing lock on replaced cell:', error);
            });
          }
        });
        break;
      case 'move':
        // Cell order changed, no lock changes needed
        break;
    }
  }

  /**
   * Handle changes to the awareness state.
   */
  private _onAwarenessChanged({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }): void {
    // Get all cell IDs that need to be updated
    const cellIds = new Set<string>();
    const states = this._awareness.getStates();
    
    // Check added and updated clients for cursor/selection changes
    [...added, ...updated].forEach(clientId => {
      const state = states.get(clientId);
      if (!state) return;
      
      // Add cell IDs with cursors
      if (state.cursors) {
        Object.keys(state.cursors).forEach(cellId => cellIds.add(cellId));
      }
      
      // Add cell IDs with selections
      if (state.selections) {
        Object.keys(state.selections).forEach(cellId => cellIds.add(cellId));
      }
      
      // Add cell IDs with active operations
      if (state.activeOperations) {
        Object.keys(state.activeOperations).forEach(cellId => cellIds.add(cellId));
      }
    });
    
    // Check removed clients for lock releases
    removed.forEach(clientId => {
      // When a client disconnects, all their locks should be released by the lock manager
      // We just need to update the UI for any cells they had locked
      this._lockManager.getLocksForClient(clientId).forEach(cellId => {
        cellIds.add(cellId);
        this._lockChanged.emit(cellId);
      });
    });
    
    // Emit signals for all affected cells
    cellIds.forEach(cellId => {
      this._remoteCursorChanged.emit({ cellId, clientId: 0 }); // 0 is a placeholder, receivers should check all clients
    });
  }

  /**
   * Update the awareness state to indicate the current user is performing an operation on a cell.
   */
  private _updateAwarenessState(cellId: string, operation: string): void {
    const localState = this._awareness.getLocalState() || {};
    const activeOperations = localState.activeOperations || {};
    
    activeOperations[cellId] = {
      operation,
      timestamp: Date.now()
    };
    
    this._awareness.setLocalStateField('activeOperations', activeOperations);
  }

  /**
   * Remove a cell from the awareness state's active operations.
   */
  private _removeFromAwarenessState(cellId: string): void {
    const localState = this._awareness.getLocalState();
    if (!localState || !localState.activeOperations) {
      return;
    }
    
    const activeOperations = { ...localState.activeOperations };
    delete activeOperations[cellId];
    
    this._awareness.setLocalStateField('activeOperations', activeOperations);
  }

  /**
   * Add a lock indicator to a cell.
   */
  private _addLockIndicator(cell: Cell, lockOwner: { clientId: number, user: any } | null): void {
    // Remove any existing indicator first
    this._removeLockIndicator(cell);
    
    if (!lockOwner) {
      return;
    }
    
    // Create lock indicator element
    const indicator = document.createElement('div');
    indicator.className = 'jp-CellLockIndicator';
    indicator.dataset.clientId = String(lockOwner.clientId);
    
    // Add user information if available
    if (lockOwner.user) {
      indicator.title = `Locked by ${lockOwner.user.name || 'Unknown user'}`;
      
      // Add user color if available
      if (lockOwner.user.color) {
        indicator.style.borderColor = lockOwner.user.color;
      }
    } else {
      indicator.title = 'Locked by another user';
    }
    
    // Add the indicator to the cell
    cell.node.appendChild(indicator);
  }

  /**
   * Remove the lock indicator from a cell.
   */
  private _removeLockIndicator(cell: Cell): void {
    const indicator = cell.node.querySelector('.jp-CellLockIndicator');
    if (indicator) {
      indicator.remove();
    }
  }

  /**
   * Update remote cursors and selections for a cell.
   */
  private _updateRemoteCursorsAndSelections(cell: Cell): void {
    const cellId = cell.model.id;
    
    // Remove existing remote cursors and selections
    cell.node.querySelectorAll('.jp-RemoteCursor, .jp-RemoteSelection').forEach(el => el.remove());
    
    // Add remote cursors
    const remoteCursors = this.getRemoteCursors(cellId);
    remoteCursors.forEach((position, clientId) => {
      this._addRemoteCursor(cell, position, clientId);
    });
    
    // Add remote selections
    const remoteSelections = this.getRemoteSelections(cellId);
    remoteSelections.forEach((range, clientId) => {
      this._addRemoteSelection(cell, range, clientId);
    });
  }

  /**
   * Add a remote cursor indicator to a cell.
   */
  private _addRemoteCursor(cell: Cell, position: number, clientId: number): void {
    // This is a simplified implementation
    // In a real implementation, you would need to convert the position to DOM coordinates
    // based on the editor's content and scroll position
    
    const states = this._awareness.getStates();
    const userState = states.get(clientId);
    
    const cursor = document.createElement('div');
    cursor.className = 'jp-RemoteCursor';
    cursor.dataset.clientId = String(clientId);
    
    // Add user information if available
    if (userState?.user) {
      cursor.title = userState.user.name || 'Unknown user';
      
      // Add user color if available
      if (userState.user.color) {
        cursor.style.backgroundColor = userState.user.color;
      }
    }
    
    // In a real implementation, you would position the cursor at the correct location
    // For now, we just add it to the cell with a data attribute for the position
    cursor.dataset.position = String(position);
    
    cell.node.appendChild(cursor);
  }

  /**
   * Add a remote selection indicator to a cell.
   */
  private _addRemoteSelection(cell: Cell, range: [number, number], clientId: number): void {
    // This is a simplified implementation
    // In a real implementation, you would need to convert the range to DOM coordinates
    // based on the editor's content and scroll position
    
    const states = this._awareness.getStates();
    const userState = states.get(clientId);
    
    const selection = document.createElement('div');
    selection.className = 'jp-RemoteSelection';
    selection.dataset.clientId = String(clientId);
    selection.dataset.rangeStart = String(range[0]);
    selection.dataset.rangeEnd = String(range[1]);
    
    // Add user information if available
    if (userState?.user) {
      selection.title = `Selected by ${userState.user.name || 'Unknown user'}`;
      
      // Add user color if available
      if (userState.user.color) {
        selection.style.backgroundColor = `${userState.user.color}33`; // Add transparency
      }
    }
    
    // In a real implementation, you would position the selection at the correct location
    // For now, we just add it to the cell with data attributes for the range
    
    cell.node.appendChild(selection);
  }

  private _cells: IObservableList<ICellModel>;
  private _lockManager: ILockManager;
  private _awareness: YjsAwareness;
  private _isDisposed = false;
  private _lockChanged = new Signal<CellOperations, string>(this);
  private _remoteCursorChanged = new Signal<CellOperations, { cellId: string, clientId: number }>(this);
}