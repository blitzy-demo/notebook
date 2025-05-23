/**
 * Cell operations with collaborative awareness for Jupyter Notebook
 * 
 * This module manages cell-level operations with collaborative awareness,
 * implementing locking mechanisms to prevent concurrent editing conflicts.
 * It coordinates cell selection, editing, execution, and movement operations
 * while ensuring consistency in a multi-user environment.
 */

import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { Cell, ICellModel } from '@jupyterlab/cells';
import { NotebookPanel, Notebook, INotebookModel } from '@jupyterlab/notebook';
import { IObservableList } from '@jupyterlab/observables';
import { ILockManager, ILockInfo, ILockResult } from './collab/locks';
import { IYjsAwareness, ICursorPosition } from './collab/awareness';
import * as Y from 'yjs';

/**
 * Interface for cell operation options
 */
export interface ICellOperationOptions {
  /**
   * Whether to force the operation even if the cell is locked by another user
   * (requires admin permissions)
   */
  force?: boolean;

  /**
   * Whether to skip acquiring a lock for this operation
   * (use for read-only operations)
   */
  skipLock?: boolean;

  /**
   * Additional metadata for the operation
   */
  metadata?: Record<string, any>;
}

/**
 * Interface for cell operation result
 */
export interface ICellOperationResult {
  /**
   * Whether the operation was successful
   */
  success: boolean;

  /**
   * Error message if the operation failed
   */
  error?: string;

  /**
   * Lock information if a lock was acquired
   */
  lock?: ILockInfo;

  /**
   * Current lock owner information if the cell is already locked
   */
  currentOwner?: ILockInfo;

  /**
   * Additional result data
   */
  data?: any;
}

/**
 * Status of the cell operations manager
 */
export enum CellOperationsStatus {
  /**
   * Manager is initializing
   */
  Initializing = 'initializing',

  /**
   * Manager is ready and operational
   */
  Ready = 'ready',

  /**
   * Manager is in a degraded state (some functionality may be limited)
   */
  Degraded = 'degraded',

  /**
   * Manager is disconnected from the collaboration server
   */
  Disconnected = 'disconnected'
}

/**
 * Interface for cell operations manager
 */
export interface ICellOperations extends IDisposable {
  /**
   * The current status of the cell operations manager
   */
  readonly status: CellOperationsStatus;

  /**
   * Signal emitted when the cell operations manager status changes
   */
  readonly statusChanged: ISignal<ICellOperations, CellOperationsStatus>;

  /**
   * Signal emitted when a cell operation starts
   */
  readonly operationStarted: ISignal<ICellOperations, { cellId: string; operation: string }>;

  /**
   * Signal emitted when a cell operation completes
   */
  readonly operationCompleted: ISignal<ICellOperations, { cellId: string; operation: string; result: ICellOperationResult }>;

  /**
   * Signal emitted when a cell operation fails
   */
  readonly operationFailed: ISignal<ICellOperations, { cellId: string; operation: string; error: string }>;

  /**
   * Signal emitted when a remote cell operation is detected
   */
  readonly remoteOperationDetected: ISignal<ICellOperations, { cellId: string; operation: string; userId: string }>;

  /**
   * Begin editing a cell
   * 
   * @param cell - The cell to edit
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  beginEdit(cell: Cell, options?: ICellOperationOptions): Promise<ICellOperationResult>;

  /**
   * End editing a cell
   * 
   * @param cell - The cell being edited
   * @returns A promise that resolves to the operation result
   */
  endEdit(cell: Cell): Promise<ICellOperationResult>;

  /**
   * Execute a cell
   * 
   * @param cell - The cell to execute
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  executeCell(cell: Cell, options?: ICellOperationOptions): Promise<ICellOperationResult>;

  /**
   * Select a cell
   * 
   * @param cell - The cell to select
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  selectCell(cell: Cell, options?: ICellOperationOptions): Promise<ICellOperationResult>;

  /**
   * Move a cell
   * 
   * @param cell - The cell to move
   * @param targetIndex - The target index to move the cell to
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  moveCell(cell: Cell, targetIndex: number, options?: ICellOperationOptions): Promise<ICellOperationResult>;

  /**
   * Insert a cell
   * 
   * @param index - The index to insert the cell at
   * @param cellType - The type of cell to insert
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  insertCell(index: number, cellType: 'code' | 'markdown' | 'raw', options?: ICellOperationOptions): Promise<ICellOperationResult>;

  /**
   * Delete a cell
   * 
   * @param cell - The cell to delete
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  deleteCell(cell: Cell, options?: ICellOperationOptions): Promise<ICellOperationResult>;

  /**
   * Update cursor position for the current user
   * 
   * @param cell - The cell containing the cursor
   * @param offset - The character offset within the cell
   * @param selection - Optional selection range
   */
  updateCursorPosition(cell: Cell, offset: number, selection?: { start: number; end: number }): void;

  /**
   * Check if a cell is currently being edited by any user
   * 
   * @param cell - The cell to check
   * @returns True if the cell is being edited, false otherwise
   */
  isCellBeingEdited(cell: Cell): boolean;

  /**
   * Check if a cell is currently being edited by the current user
   * 
   * @param cell - The cell to check
   * @returns True if the cell is being edited by the current user, false otherwise
   */
  isCellBeingEditedByMe(cell: Cell): boolean;

  /**
   * Get the user who is currently editing a cell
   * 
   * @param cell - The cell to check
   * @returns The user ID and name of the editor, or null if the cell is not being edited
   */
  getCellEditor(cell: Cell): { userId: string; userName: string } | null;

  /**
   * Release all locks held by the current user
   * 
   * @returns A promise that resolves to true if all locks were released, false otherwise
   */
  releaseAllLocks(): Promise<boolean>;
}

/**
 * Options for creating a cell operations manager
 */
export interface ICellOperationsOptions {
  /**
   * The notebook panel
   */
  notebookPanel: NotebookPanel;

  /**
   * The lock manager
   */
  lockManager: ILockManager;

  /**
   * The awareness provider
   */
  awareness: IYjsAwareness;

  /**
   * The Yjs document
   */
  ydoc: Y.Doc;

  /**
   * The current user's ID
   */
  userId: string;

  /**
   * The current user's display name
   */
  userName: string;

  /**
   * Whether the current user has admin permissions
   */
  isAdmin?: boolean;
}

/**
 * Implementation of the ICellOperations interface
 */
export class CellOperations implements ICellOperations {
  /**
   * Create a new CellOperations instance
   * 
   * @param options - The cell operations configuration options
   */
  constructor(options: ICellOperationsOptions) {
    this._notebookPanel = options.notebookPanel;
    this._notebook = options.notebookPanel.content;
    this._model = options.notebookPanel.model!;
    this._lockManager = options.lockManager;
    this._awareness = options.awareness;
    this._ydoc = options.ydoc;
    this._userId = options.userId;
    this._userName = options.userName;
    this._isAdmin = options.isAdmin || false;

    // Set up event listeners
    this._setupEventListeners();

    // Set initial status
    this._status = CellOperationsStatus.Ready;
  }

  /**
   * The current status of the cell operations manager
   */
  get status(): CellOperationsStatus {
    return this._status;
  }

  /**
   * Signal emitted when the cell operations manager status changes
   */
  get statusChanged(): ISignal<ICellOperations, CellOperationsStatus> {
    return this._statusChanged;
  }

  /**
   * Signal emitted when a cell operation starts
   */
  get operationStarted(): ISignal<ICellOperations, { cellId: string; operation: string }> {
    return this._operationStarted;
  }

  /**
   * Signal emitted when a cell operation completes
   */
  get operationCompleted(): ISignal<ICellOperations, { cellId: string; operation: string; result: ICellOperationResult }> {
    return this._operationCompleted;
  }

  /**
   * Signal emitted when a cell operation fails
   */
  get operationFailed(): ISignal<ICellOperations, { cellId: string; operation: string; error: string }> {
    return this._operationFailed;
  }

  /**
   * Signal emitted when a remote cell operation is detected
   */
  get remoteOperationDetected(): ISignal<ICellOperations, { cellId: string; operation: string; userId: string }> {
    return this._remoteOperationDetected;
  }

  /**
   * Begin editing a cell
   * 
   * @param cell - The cell to edit
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  async beginEdit(cell: Cell, options: ICellOperationOptions = {}): Promise<ICellOperationResult> {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return {
        success: false,
        error: 'Cell ID not found'
      };
    }

    // Emit operation started signal
    this._operationStarted.emit({ cellId, operation: 'beginEdit' });

    try {
      // Skip lock acquisition if requested
      if (options.skipLock) {
        // Update awareness to show we're viewing the cell
        this._updateAwarenessForCell(cell, 'viewing');
        
        return {
          success: true,
          data: { skipLock: true }
        };
      }

      // Try to acquire a lock on the cell
      const lockResult = await this._lockManager.acquireLock(cellId, {
        force: options.force,
        metadata: {
          operation: 'edit',
          ...options.metadata
        }
      });

      if (!lockResult.success) {
        // Lock acquisition failed
        this._operationFailed.emit({
          cellId,
          operation: 'beginEdit',
          error: lockResult.error || 'Failed to acquire lock'
        });

        return {
          success: false,
          error: lockResult.error,
          currentOwner: lockResult.currentOwner
        };
      }

      // Lock acquired successfully
      // Update awareness to show we're editing the cell
      this._updateAwarenessForCell(cell, 'editing');

      // Emit operation completed signal
      const result: ICellOperationResult = {
        success: true,
        lock: lockResult.lock
      };

      this._operationCompleted.emit({
        cellId,
        operation: 'beginEdit',
        result
      });

      return result;
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = `Error in beginEdit: ${error.message}`;
      console.error(errorMessage, error);

      this._operationFailed.emit({
        cellId,
        operation: 'beginEdit',
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * End editing a cell
   * 
   * @param cell - The cell being edited
   * @returns A promise that resolves to the operation result
   */
  async endEdit(cell: Cell): Promise<ICellOperationResult> {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return {
        success: false,
        error: 'Cell ID not found'
      };
    }

    // Emit operation started signal
    this._operationStarted.emit({ cellId, operation: 'endEdit' });

    try {
      // Check if we have a lock on this cell
      if (!this._lockManager.hasLock(cellId)) {
        // We don't have a lock, so there's nothing to release
        return {
          success: true,
          data: { noLock: true }
        };
      }

      // Release the lock
      const released = await this._lockManager.releaseLock(cellId);
      if (!released) {
        // Failed to release the lock
        this._operationFailed.emit({
          cellId,
          operation: 'endEdit',
          error: 'Failed to release lock'
        });

        return {
          success: false,
          error: 'Failed to release lock'
        };
      }

      // Update awareness to show we're no longer editing the cell
      this._updateAwarenessForCell(cell, 'viewing');

      // Emit operation completed signal
      const result: ICellOperationResult = {
        success: true
      };

      this._operationCompleted.emit({
        cellId,
        operation: 'endEdit',
        result
      });

      return result;
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = `Error in endEdit: ${error.message}`;
      console.error(errorMessage, error);

      this._operationFailed.emit({
        cellId,
        operation: 'endEdit',
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Execute a cell
   * 
   * @param cell - The cell to execute
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  async executeCell(cell: Cell, options: ICellOperationOptions = {}): Promise<ICellOperationResult> {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return {
        success: false,
        error: 'Cell ID not found'
      };
    }

    // Emit operation started signal
    this._operationStarted.emit({ cellId, operation: 'executeCell' });

    try {
      // Check if the cell is locked by someone else
      const lock = this._lockManager.getLock(cellId);
      if (lock && lock.userId !== this._userId && !options.force) {
        // Cell is locked by another user
        this._operationFailed.emit({
          cellId,
          operation: 'executeCell',
          error: `Cell is being edited by ${lock.userName}`
        });

        return {
          success: false,
          error: `Cell is being edited by ${lock.userName}`,
          currentOwner: lock
        };
      }

      // Update awareness to show we're executing the cell
      this._updateAwarenessForCell(cell, 'executing');

      // Execute the cell using the notebook's API
      // This is an asynchronous operation that will be handled by the notebook's execution manager
      const sessionContext = this._notebookPanel.sessionContext;
      if (!sessionContext || !sessionContext.session?.kernel) {
        throw new Error('No kernel available');
      }

      // Find the cell index
      const index = this._notebook.widgets.findIndex(c => c === cell);
      if (index === -1) {
        throw new Error('Cell not found in notebook');
      }

      // Execute the cell
      await this._notebookPanel.content.execute(index);

      // Update awareness to show we're no longer executing the cell
      this._updateAwarenessForCell(cell, 'viewing');

      // Emit operation completed signal
      const result: ICellOperationResult = {
        success: true
      };

      this._operationCompleted.emit({
        cellId,
        operation: 'executeCell',
        result
      });

      return result;
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = `Error in executeCell: ${error.message}`;
      console.error(errorMessage, error);

      // Update awareness to show we're no longer executing the cell
      this._updateAwarenessForCell(cell, 'viewing');

      this._operationFailed.emit({
        cellId,
        operation: 'executeCell',
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Select a cell
   * 
   * @param cell - The cell to select
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  async selectCell(cell: Cell, options: ICellOperationOptions = {}): Promise<ICellOperationResult> {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return {
        success: false,
        error: 'Cell ID not found'
      };
    }

    // Emit operation started signal
    this._operationStarted.emit({ cellId, operation: 'selectCell' });

    try {
      // Find the cell index
      const index = this._notebook.widgets.findIndex(c => c === cell);
      if (index === -1) {
        throw new Error('Cell not found in notebook');
      }

      // Select the cell
      this._notebook.activeCellIndex = index;

      // Update awareness to show we're viewing the cell
      this._updateAwarenessForCell(cell, 'viewing');

      // Emit operation completed signal
      const result: ICellOperationResult = {
        success: true
      };

      this._operationCompleted.emit({
        cellId,
        operation: 'selectCell',
        result
      });

      return result;
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = `Error in selectCell: ${error.message}`;
      console.error(errorMessage, error);

      this._operationFailed.emit({
        cellId,
        operation: 'selectCell',
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Move a cell
   * 
   * @param cell - The cell to move
   * @param targetIndex - The target index to move the cell to
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  async moveCell(cell: Cell, targetIndex: number, options: ICellOperationOptions = {}): Promise<ICellOperationResult> {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return {
        success: false,
        error: 'Cell ID not found'
      };
    }

    // Emit operation started signal
    this._operationStarted.emit({ cellId, operation: 'moveCell' });

    try {
      // Find the current cell index
      const currentIndex = this._notebook.widgets.findIndex(c => c === cell);
      if (currentIndex === -1) {
        throw new Error('Cell not found in notebook');
      }

      // Check if any cells in the range are locked by other users
      const minIndex = Math.min(currentIndex, targetIndex);
      const maxIndex = Math.max(currentIndex, targetIndex);
      
      for (let i = minIndex; i <= maxIndex; i++) {
        const c = this._notebook.widgets[i];
        const cId = this._getCellId(c);
        if (!cId) continue;
        
        const lock = this._lockManager.getLock(cId);
        if (lock && lock.userId !== this._userId && !options.force) {
          // Cell is locked by another user
          this._operationFailed.emit({
            cellId,
            operation: 'moveCell',
            error: `Cell at index ${i} is being edited by ${lock.userName}`
          });

          return {
            success: false,
            error: `Cell at index ${i} is being edited by ${lock.userName}`,
            currentOwner: lock
          };
        }
      }

      // Move the cell using the notebook model's API
      const cells = this._model.cells;
      const modelIndex = cells.indexOf(cell.model as ICellModel);
      
      if (modelIndex === -1) {
        throw new Error('Cell model not found in notebook model');
      }

      // The move operation will be handled by the Yjs binding
      // which will propagate the change to all clients
      cells.move(modelIndex, targetIndex);

      // Emit operation completed signal
      const result: ICellOperationResult = {
        success: true
      };

      this._operationCompleted.emit({
        cellId,
        operation: 'moveCell',
        result
      });

      return result;
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = `Error in moveCell: ${error.message}`;
      console.error(errorMessage, error);

      this._operationFailed.emit({
        cellId,
        operation: 'moveCell',
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Insert a cell
   * 
   * @param index - The index to insert the cell at
   * @param cellType - The type of cell to insert
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  async insertCell(index: number, cellType: 'code' | 'markdown' | 'raw', options: ICellOperationOptions = {}): Promise<ICellOperationResult> {
    // Emit operation started signal
    this._operationStarted.emit({ cellId: 'new', operation: 'insertCell' });

    try {
      // Check if any adjacent cells are locked by other users
      if (index > 0 && index <= this._notebook.widgets.length) {
        const prevCell = this._notebook.widgets[index - 1];
        const prevCellId = this._getCellId(prevCell);
        
        if (prevCellId) {
          const lock = this._lockManager.getLock(prevCellId);
          if (lock && lock.userId !== this._userId && !options.force) {
            // Previous cell is locked by another user
            this._operationFailed.emit({
              cellId: 'new',
              operation: 'insertCell',
              error: `Adjacent cell is being edited by ${lock.userName}`
            });

            return {
              success: false,
              error: `Adjacent cell is being edited by ${lock.userName}`,
              currentOwner: lock
            };
          }
        }
      }

      if (index >= 0 && index < this._notebook.widgets.length) {
        const nextCell = this._notebook.widgets[index];
        const nextCellId = this._getCellId(nextCell);
        
        if (nextCellId) {
          const lock = this._lockManager.getLock(nextCellId);
          if (lock && lock.userId !== this._userId && !options.force) {
            // Next cell is locked by another user
            this._operationFailed.emit({
              cellId: 'new',
              operation: 'insertCell',
              error: `Adjacent cell is being edited by ${lock.userName}`
            });

            return {
              success: false,
              error: `Adjacent cell is being edited by ${lock.userName}`,
              currentOwner: lock
            };
          }
        }
      }

      // Insert the cell using the notebook model's API
      // The insert operation will be handled by the Yjs binding
      // which will propagate the change to all clients
      const model = this._model.contentFactory.createCell(cellType, {});
      this._model.cells.insert(index, model);

      // Get the newly inserted cell
      const cell = this._notebook.widgets[index];
      const cellId = this._getCellId(cell);

      if (!cellId) {
        throw new Error('Failed to get ID of newly inserted cell');
      }

      // Emit operation completed signal
      const result: ICellOperationResult = {
        success: true,
        data: { cellId }
      };

      this._operationCompleted.emit({
        cellId,
        operation: 'insertCell',
        result
      });

      return result;
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = `Error in insertCell: ${error.message}`;
      console.error(errorMessage, error);

      this._operationFailed.emit({
        cellId: 'new',
        operation: 'insertCell',
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Delete a cell
   * 
   * @param cell - The cell to delete
   * @param options - Operation options
   * @returns A promise that resolves to the operation result
   */
  async deleteCell(cell: Cell, options: ICellOperationOptions = {}): Promise<ICellOperationResult> {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return {
        success: false,
        error: 'Cell ID not found'
      };
    }

    // Emit operation started signal
    this._operationStarted.emit({ cellId, operation: 'deleteCell' });

    try {
      // Check if the cell is locked by someone else
      const lock = this._lockManager.getLock(cellId);
      if (lock && lock.userId !== this._userId && !options.force) {
        // Cell is locked by another user
        this._operationFailed.emit({
          cellId,
          operation: 'deleteCell',
          error: `Cell is being edited by ${lock.userName}`
        });

        return {
          success: false,
          error: `Cell is being edited by ${lock.userName}`,
          currentOwner: lock
        };
      }

      // Find the cell index
      const index = this._notebook.widgets.findIndex(c => c === cell);
      if (index === -1) {
        throw new Error('Cell not found in notebook');
      }

      // If we have a lock on this cell, release it
      if (this._lockManager.hasLock(cellId)) {
        await this._lockManager.releaseLock(cellId);
      }

      // Delete the cell using the notebook model's API
      // The delete operation will be handled by the Yjs binding
      // which will propagate the change to all clients
      this._model.cells.remove(index);

      // Emit operation completed signal
      const result: ICellOperationResult = {
        success: true
      };

      this._operationCompleted.emit({
        cellId,
        operation: 'deleteCell',
        result
      });

      return result;
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = `Error in deleteCell: ${error.message}`;
      console.error(errorMessage, error);

      this._operationFailed.emit({
        cellId,
        operation: 'deleteCell',
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Update cursor position for the current user
   * 
   * @param cell - The cell containing the cursor
   * @param offset - The character offset within the cell
   * @param selection - Optional selection range
   */
  updateCursorPosition(cell: Cell, offset: number, selection?: { start: number; end: number }): void {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return;
    }

    // Find the cell index
    const cellIndex = this._notebook.widgets.findIndex(c => c === cell);
    if (cellIndex === -1) {
      return;
    }

    // Update the cursor position in the awareness state
    const cursorPosition: ICursorPosition = {
      cellIndex,
      offset,
      active: true,
      selection
    };

    // Get the current local state
    const localState = this._awareness.getLocalState() || {};

    // Update the cursor position
    this._awareness.setLocalState({
      ...localState,
      cursor: cursorPosition
    });
  }

  /**
   * Check if a cell is currently being edited by any user
   * 
   * @param cell - The cell to check
   * @returns True if the cell is being edited, false otherwise
   */
  isCellBeingEdited(cell: Cell): boolean {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return false;
    }

    // Check if the cell has a lock
    return this._lockManager.getLock(cellId) !== null;
  }

  /**
   * Check if a cell is currently being edited by the current user
   * 
   * @param cell - The cell to check
   * @returns True if the cell is being edited by the current user, false otherwise
   */
  isCellBeingEditedByMe(cell: Cell): boolean {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return false;
    }

    // Check if the current user holds the lock
    return this._lockManager.hasLock(cellId);
  }

  /**
   * Get the user who is currently editing a cell
   * 
   * @param cell - The cell to check
   * @returns The user ID and name of the editor, or null if the cell is not being edited
   */
  getCellEditor(cell: Cell): { userId: string; userName: string } | null {
    const cellId = this._getCellId(cell);
    if (!cellId) {
      return null;
    }

    // Get the lock information
    const lock = this._lockManager.getLock(cellId);
    if (!lock) {
      return null;
    }

    return {
      userId: lock.userId,
      userName: lock.userName
    };
  }

  /**
   * Release all locks held by the current user
   * 
   * @returns A promise that resolves to true if all locks were released, false otherwise
   */
  async releaseAllLocks(): Promise<boolean> {
    return this._lockManager.releaseAllLocks();
  }

  /**
   * Dispose of the cell operations manager and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    // Release all locks held by this user
    this.releaseAllLocks().catch(error => {
      console.error('Error releasing locks during disposal:', error);
    });

    // Remove event listeners
    this._removeEventListeners();

    this._isDisposed = true;
  }

  /**
   * Set up event listeners
   */
  private _setupEventListeners(): void {
    // Listen for lock acquisition and release events
    this._lockManager.lockAcquired.connect(this._onLockAcquired, this);
    this._lockManager.lockReleased.connect(this._onLockReleased, this);
    this._lockManager.lockFailed.connect(this._onLockFailed, this);
    this._lockManager.lockExpiring.connect(this._onLockExpiring, this);

    // Listen for awareness state changes
    this._awareness.stateChanged.connect(this._onAwarenessStateChanged, this);

    // Listen for notebook model changes
    this._model.cells.changed.connect(this._onCellsChanged, this);
  }

  /**
   * Remove event listeners
   */
  private _removeEventListeners(): void {
    // Remove lock event listeners
    this._lockManager.lockAcquired.disconnect(this._onLockAcquired, this);
    this._lockManager.lockReleased.disconnect(this._onLockReleased, this);
    this._lockManager.lockFailed.disconnect(this._onLockFailed, this);
    this._lockManager.lockExpiring.disconnect(this._onLockExpiring, this);

    // Remove awareness event listeners
    this._awareness.stateChanged.disconnect(this._onAwarenessStateChanged, this);

    // Remove notebook model event listeners
    this._model.cells.changed.disconnect(this._onCellsChanged, this);
  }

  /**
   * Handle lock acquisition events
   * 
   * @param sender - The lock manager
   * @param lock - The acquired lock
   */
  private _onLockAcquired(sender: ILockManager, lock: ILockInfo): void {
    // Check if the lock was acquired by another user
    if (lock.userId !== this._userId) {
      // Emit remote operation detected signal
      this._remoteOperationDetected.emit({
        cellId: lock.cellId,
        operation: 'beginEdit',
        userId: lock.userId
      });
    }
  }

  /**
   * Handle lock release events
   * 
   * @param sender - The lock manager
   * @param lock - The released lock
   */
  private _onLockReleased(sender: ILockManager, lock: ILockInfo): void {
    // Check if the lock was released by another user
    if (lock.userId !== this._userId) {
      // Emit remote operation detected signal
      this._remoteOperationDetected.emit({
        cellId: lock.cellId,
        operation: 'endEdit',
        userId: lock.userId
      });
    }
  }

  /**
   * Handle lock failure events
   * 
   * @param sender - The lock manager
   * @param result - The lock result
   */
  private _onLockFailed(sender: ILockManager, result: ILockResult): void {
    // No specific handling needed here, as the operation methods handle failures
  }

  /**
   * Handle lock expiring events
   * 
   * @param sender - The lock manager
   * @param lock - The expiring lock
   */
  private _onLockExpiring(sender: ILockManager, lock: ILockInfo): void {
    // Check if the lock is held by the current user
    if (lock.userId === this._userId) {
      // Automatically renew the lock
      this._lockManager.renewLock(lock.cellId).catch(error => {
        console.error(`Error renewing lock for cell ${lock.cellId}:`, error);
      });
    }
  }

  /**
   * Handle awareness state changes
   * 
   * @param sender - The awareness provider
   * @param changes - The awareness changes
   */
  private _onAwarenessStateChanged(sender: IYjsAwareness, changes: { added: number[]; updated: number[]; removed: number[] }): void {
    // Process updated states to detect remote cursor movements and activities
    const states = sender.getStates();
    
    // Process added and updated clients
    const changedClients = [...changes.added, ...changes.updated];
    
    for (const clientId of changedClients) {
      // Skip our own client
      if (clientId === sender.clientID) {
        continue;
      }
      
      const state = states.get(clientId);
      if (!state) {
        continue;
      }
      
      // Check for cursor position updates
      if (state.cursor && state.user) {
        const { cursor, user } = state;
        
        // Find the cell at the cursor position
        if (cursor.cellIndex >= 0 && cursor.cellIndex < this._notebook.widgets.length) {
          const cell = this._notebook.widgets[cursor.cellIndex];
          const cellId = this._getCellId(cell);
          
          if (cellId) {
            // Emit remote operation detected signal for cursor movement
            this._remoteOperationDetected.emit({
              cellId,
              operation: 'cursorMove',
              userId: user.id
            });
          }
        }
      }
      
      // Check for activity updates
      if (state.activity && state.user) {
        const { activity, user } = state;
        
        // Handle different activity types
        if (activity.type === 'executing' && activity.metadata?.cellIndex !== undefined) {
          const cellIndex = activity.metadata.cellIndex;
          
          if (cellIndex >= 0 && cellIndex < this._notebook.widgets.length) {
            const cell = this._notebook.widgets[cellIndex];
            const cellId = this._getCellId(cell);
            
            if (cellId) {
              // Emit remote operation detected signal for cell execution
              this._remoteOperationDetected.emit({
                cellId,
                operation: 'executeCell',
                userId: user.id
              });
            }
          }
        }
      }
    }
  }

  /**
   * Handle cell changes in the notebook model
   * 
   * @param sender - The cell list
   * @param args - The change args
   */
  private _onCellsChanged(sender: IObservableList<ICellModel>, args: IObservableList.IChangedArgs<ICellModel>): void {
    // Handle different types of cell changes
    switch (args.type) {
      case 'add':
        // A cell was added
        // No specific handling needed here, as the insertCell method handles this
        break;
        
      case 'remove':
        // A cell was removed
        // No specific handling needed here, as the deleteCell method handles this
        break;
        
      case 'move':
        // A cell was moved
        // No specific handling needed here, as the moveCell method handles this
        break;
        
      case 'set':
        // A cell was replaced
        // This is a rare operation, but we should handle it
        // by releasing any locks on the old cell and acquiring locks on the new cell if needed
        break;
    }
  }

  /**
   * Get the ID of a cell
   * 
   * @param cell - The cell to get the ID for
   * @returns The cell ID, or null if not found
   */
  private _getCellId(cell: Cell): string | null {
    return cell.model.id || null;
  }

  /**
   * Update the awareness state for a cell operation
   * 
   * @param cell - The cell being operated on
   * @param activityType - The type of activity
   */
  private _updateAwarenessForCell(cell: Cell, activityType: 'editing' | 'viewing' | 'executing'): void {
    // Find the cell index
    const cellIndex = this._notebook.widgets.findIndex(c => c === cell);
    if (cellIndex === -1) {
      return;
    }

    // Get the current local state
    const localState = this._awareness.getLocalState() || {};

    // Update the activity
    this._awareness.setLocalState({
      ...localState,
      activity: {
        type: activityType,
        timestamp: Date.now(),
        metadata: {
          cellIndex,
          cellId: this._getCellId(cell)
        }
      }
    });
  }

  /**
   * Set the cell operations manager status and emit a status change event
   * 
   * @param status - The new status
   */
  private _setStatus(status: CellOperationsStatus): void {
    if (this._status !== status) {
      this._status = status;
      this._statusChanged.emit(status);
    }
  }

  private _notebookPanel: NotebookPanel;
  private _notebook: Notebook;
  private _model: INotebookModel;
  private _lockManager: ILockManager;
  private _awareness: IYjsAwareness;
  private _ydoc: Y.Doc;
  private _userId: string;
  private _userName: string;
  private _isAdmin: boolean;
  private _status: CellOperationsStatus = CellOperationsStatus.Initializing;
  private _isDisposed = false;

  private _statusChanged = new Signal<ICellOperations, CellOperationsStatus>(this);
  private _operationStarted = new Signal<ICellOperations, { cellId: string; operation: string }>(this);
  private _operationCompleted = new Signal<ICellOperations, { cellId: string; operation: string; result: ICellOperationResult }>(this);
  private _operationFailed = new Signal<ICellOperations, { cellId: string; operation: string; error: string }>(this);
  private _remoteOperationDetected = new Signal<ICellOperations, { cellId: string; operation: string; userId: string }>(this);
}

/**
 * Create a cell operations manager for a notebook
 * 
 * @param options - The cell operations configuration options
 * @returns A new cell operations manager instance
 */
export function createCellOperations(options: ICellOperationsOptions): ICellOperations {
  return new CellOperations(options);
}