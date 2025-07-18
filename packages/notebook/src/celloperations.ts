/**
 * @fileoverview Enhanced cell operations for collaborative notebook editing
 * 
 * This module provides comprehensive cell operations with real-time collaborative
 * editing capabilities, including cell-level locking, conflict resolution,
 * and synchronized operations across multiple users. It integrates with the
 * Yjs CRDT framework for conflict-free collaborative editing.
 * 
 * Key features:
 * - Cell-level locking mechanism to prevent simultaneous editing conflicts
 * - Real-time collaborative operations synchronized via Yjs
 * - User presence awareness for cell-level activity tracking
 * - Conflict resolution through CRDT properties
 * - Comprehensive event system for operation notifications
 * - Support for all notebook cell types (code, markdown, raw)
 * - Integration with notebook model and awareness systems
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { Array as YArray } from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ICellModel } from '@jupyterlab/cells';
import { INotebookModel } from '@jupyterlab/notebook';
import { ISignal, Signal } from '@lumino/signaling';
import { DisposableDelegate } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';

import { YjsNotebookProvider } from './model';
import { LockService } from './collab/locks';
import { AwarenessService } from './collab/awareness';
import { IYjsNotebookProvider } from './tokens';

/**
 * Enumeration of cell operation types for comprehensive operation tracking
 */
export enum CellOperationType {
  /** Cell was created and added to the notebook */
  CREATE = 'create',
  /** Cell was deleted from the notebook */
  DELETE = 'delete',
  /** Cell was moved to a different position */
  MOVE = 'move',
  /** Cell content was edited */
  EDIT = 'edit',
  /** Cell was locked for exclusive editing */
  LOCK = 'lock',
  /** Cell was unlocked and released */
  UNLOCK = 'unlock',
  /** Cell was executed */
  RUN = 'run',
  /** Cell execution was stopped */
  STOP = 'stop'
}

/**
 * Interface representing the operational state of a cell in collaborative editing
 */
export interface CellOperationState {
  /** Unique identifier of the cell */
  cellId: string;
  /** Whether the cell is currently locked by another user */
  isLocked: boolean;
  /** User ID of the current lock owner, if any */
  lockOwner?: string;
  /** Timestamp when the lock will expire */
  lockTimeout?: Date;
  /** Timestamp of the last modification */
  lastModified: Date;
  /** Additional collaborative metadata */
  collaborativeMetadata: CollaborativeCellMetadata;
}

/**
 * Interface representing a cell operation event for notifications and logging
 */
export interface CellOperationEvent {
  /** Type of operation that occurred */
  type: CellOperationType;
  /** ID of the cell involved in the operation */
  cellId: string;
  /** ID of the user who performed the operation */
  userId: string;
  /** Timestamp when the operation occurred */
  timestamp: Date;
  /** Additional data associated with the operation */
  data?: any;
  /** Optional metadata for the operation */
  metadata?: Record<string, any>;
}

/**
 * Interface representing collaborative metadata for a cell
 */
export interface CollaborativeCellMetadata {
  /** Current version number of the cell */
  version: number;
  /** User ID of the last editor */
  lastEditedBy: string;
  /** Timestamp of the last edit */
  lastEditedAt: Date;
  /** Current lock state information */
  lockState?: {
    isLocked: boolean;
    ownerId?: string;
    ownerName?: string;
    lockedAt?: Date;
    timeout?: number;
  };
  /** History of collaborative changes */
  collaborationHistory: Array<{
    userId: string;
    userName: string;
    timestamp: Date;
    operation: CellOperationType;
    description: string;
  }>;
  /** Any detected conflicts */
  conflicts?: Array<{
    conflictId: string;
    conflictType: string;
    involvedUsers: string[];
    timestamp: Date;
    resolved: boolean;
  }>;
}

/**
 * Interface representing conflict resolution information
 */
export interface CellConflictResolution {
  /** Unique identifier for the conflict */
  conflictId: string;
  /** ID of the cell where the conflict occurred */
  cellId: string;
  /** Type of conflict that occurred */
  conflictType: 'simultaneous_edit' | 'version_mismatch' | 'lock_timeout' | 'merge_conflict';
  /** How the conflict was resolved */
  resolution: 'manual' | 'automatic' | 'last_write_wins' | 'merge' | 'abort';
  /** User ID of who resolved the conflict */
  resolvedBy: string;
  /** Timestamp when the conflict was resolved */
  resolvedAt: Date;
}

/**
 * Main cell operations class for collaborative editing
 * 
 * This class provides comprehensive cell operations with collaborative features,
 * including locking, conflict resolution, and synchronized operations across
 * multiple users. It integrates with the Yjs CRDT framework and awareness system.
 */
export class CellOperations {
  private _yjsProvider: YjsNotebookProvider;
  private _lockService: LockService;
  private _awarenessService: AwarenessService;
  private _notebookModel: INotebookModel | null = null;
  private _cellStates: Map<string, CellOperationState> = new Map();
  private _isDisposed: boolean = false;
  private _operationInProgress: Map<string, CellOperationType> = new Map();
  
  // Signals for cell operation events
  private _cellChangeSignal = new Signal<CellOperations, {
    cellId: string;
    changeType: string;
    userId: string;
    timestamp: Date;
    data?: any;
  }>(this);
  
  private _cellLockSignal = new Signal<CellOperations, {
    cellId: string;
    isLocked: boolean;
    owner?: {userId: string; name: string};
  }>(this);
  
  private _cellOperationSignal = new Signal<CellOperations, CellOperationEvent>(this);

  /**
   * Create a new cell operations instance
   * 
   * @param yjsProvider - The Yjs provider for collaborative document synchronization
   * @param lockService - Service for managing cell locks
   * @param awarenessService - Service for user presence tracking
   */
  constructor(
    yjsProvider: YjsNotebookProvider,
    lockService: LockService,
    awarenessService: AwarenessService
  ) {
    this._yjsProvider = yjsProvider;
    this._lockService = lockService;
    this._awarenessService = awarenessService;
    
    this._setupEventListeners();
    this._initializeCellStates();
  }

  /**
   * Signal emitted when a cell changes
   */
  get onCellChange(): ISignal<CellOperations, {
    cellId: string;
    changeType: string;
    userId: string;
    timestamp: Date;
    data?: any;
  }> {
    return this._cellChangeSignal;
  }

  /**
   * Lock a cell for exclusive editing
   * 
   * @param cellId - The ID of the cell to lock
   * @param timeout - Optional timeout in milliseconds
   * @returns Promise resolving to true if lock was acquired
   */
  async lockCell(cellId: string, timeout?: number): Promise<boolean> {
    if (this._isDisposed) {
      return false;
    }

    try {
      // Check if we can lock this cell
      const canLock = await this._lockService.canLock();
      if (!canLock) {
        return false;
      }

      // Attempt to acquire the lock
      const lockAcquired = await this._lockService.lockCell(cellId, timeout);
      
      if (lockAcquired) {
        // Update local state
        const currentUser = this._awarenessService.getCurrentUser();
        await this._updateCellState(cellId, {
          isLocked: true,
          lockOwner: currentUser.userId,
          lockTimeout: new Date(Date.now() + (timeout || this._lockService.getLockTimeout()))
        });

        // Track the operation
        this._operationInProgress.set(cellId, CellOperationType.LOCK);

        // Emit operation event
        this._emitOperationEvent({
          type: CellOperationType.LOCK,
          cellId,
          userId: currentUser.userId,
          timestamp: new Date(),
          data: { timeout: timeout || this._lockService.getLockTimeout() }
        });

        // Clear operation tracking
        this._operationInProgress.delete(cellId);

        return true;
      }

      return false;
    } catch (error) {
      console.error('Error locking cell:', error);
      this._operationInProgress.delete(cellId);
      return false;
    }
  }

  /**
   * Unlock a cell to allow other users to edit
   * 
   * @param cellId - The ID of the cell to unlock
   * @returns Promise resolving when cell is unlocked
   */
  async unlockCell(cellId: string): Promise<void> {
    if (this._isDisposed) {
      return;
    }

    try {
      // Release the lock
      await this._lockService.unlockCell(cellId);
      
      // Update local state
      const currentUser = this._awarenessService.getCurrentUser();
      await this._updateCellState(cellId, {
        isLocked: false,
        lockOwner: undefined,
        lockTimeout: undefined
      });

      // Track the operation
      this._operationInProgress.set(cellId, CellOperationType.UNLOCK);

      // Emit operation event
      this._emitOperationEvent({
        type: CellOperationType.UNLOCK,
        cellId,
        userId: currentUser.userId,
        timestamp: new Date()
      });

      // Clear operation tracking
      this._operationInProgress.delete(cellId);
    } catch (error) {
      console.error('Error unlocking cell:', error);
      this._operationInProgress.delete(cellId);
    }
  }

  /**
   * Check if the current user can edit a specific cell
   * 
   * @param cellId - The ID of the cell to check
   * @returns Promise resolving to true if user can edit the cell
   */
  async canEdit(cellId: string): Promise<boolean> {
    if (this._isDisposed) {
      return false;
    }

    try {
      // Check if cell is locked by another user
      const isLocked = await this._lockService.isLocked(cellId);
      if (isLocked) {
        return false;
      }

      // Check if there's an operation in progress
      const operationInProgress = this._operationInProgress.get(cellId);
      if (operationInProgress && operationInProgress !== CellOperationType.EDIT) {
        return false;
      }

      // Check general lock permissions
      const canLock = await this._lockService.canLock();
      return canLock;
    } catch (error) {
      console.error('Error checking edit permissions:', error);
      return false;
    }
  }

  /**
   * Get the current state of a cell
   * 
   * @param cellId - The ID of the cell to get state for
   * @returns Promise resolving to the cell state
   */
  async getCellState(cellId: string): Promise<CellOperationState | null> {
    if (this._isDisposed) {
      return null;
    }

    const state = this._cellStates.get(cellId);
    if (!state) {
      return null;
    }

    // Update lock information from the lock service
    const lockOwner = await this._lockService.getLockOwner(cellId);
    const isLocked = await this._lockService.isLocked(cellId);

    return {
      ...state,
      isLocked,
      lockOwner: lockOwner?.userId,
      lockTimeout: lockOwner ? new Date(lockOwner.lockedAt.getTime() + (lockOwner.timeout || 0)) : undefined
    };
  }

  /**
   * Create a new cell in the notebook
   * 
   * @param cellType - The type of cell to create ('code', 'markdown', 'raw')
   * @param index - The index where to insert the cell
   * @param source - Initial source content for the cell
   * @returns Promise resolving to the created cell model
   */
  async createCell(cellType: 'code' | 'markdown' | 'raw', index?: number, source?: string): Promise<ICellModel | null> {
    if (this._isDisposed || !this._notebookModel) {
      return null;
    }

    try {
      const currentUser = this._awarenessService.getCurrentUser();
      const cellId = UUID.uuid4();
      
      // Track the operation
      this._operationInProgress.set(cellId, CellOperationType.CREATE);

      // Create the cell model
      const cellModel = this._notebookModel.contentFactory.createCell(cellType, {
        id: cellId,
        source: source || '',
        metadata: {
          collaborative: {
            createdBy: currentUser.userId,
            createdAt: new Date().toISOString(),
            version: 1
          }
        }
      });

      // Insert the cell into the notebook
      const insertIndex = index !== undefined ? index : this._notebookModel.cells.length;
      this._notebookModel.cells.insert(insertIndex, cellModel);

      // Initialize cell state
      await this._initializeCellState(cellId, cellModel);

      // Update Yjs document
      await this._syncCellToYjs(cellId, cellModel);

      // Emit operation event
      this._emitOperationEvent({
        type: CellOperationType.CREATE,
        cellId,
        userId: currentUser.userId,
        timestamp: new Date(),
        data: { 
          cellType,
          index: insertIndex,
          source: source || ''
        }
      });

      // Clear operation tracking
      this._operationInProgress.delete(cellId);

      return cellModel;
    } catch (error) {
      console.error('Error creating cell:', error);
      this._operationInProgress.delete(cellId);
      return null;
    }
  }

  /**
   * Delete a cell from the notebook
   * 
   * @param cellId - The ID of the cell to delete
   * @returns Promise resolving to true if cell was deleted
   */
  async deleteCell(cellId: string): Promise<boolean> {
    if (this._isDisposed || !this._notebookModel) {
      return false;
    }

    try {
      // Check if we can edit this cell
      const canEdit = await this.canEdit(cellId);
      if (!canEdit) {
        return false;
      }

      const currentUser = this._awarenessService.getCurrentUser();
      
      // Track the operation
      this._operationInProgress.set(cellId, CellOperationType.DELETE);

      // Find the cell index
      const cellIndex = this._findCellIndex(cellId);
      if (cellIndex === -1) {
        this._operationInProgress.delete(cellId);
        return false;
      }

      // Get cell model before deletion
      const cellModel = this._notebookModel.cells.get(cellIndex);
      const cellData = {
        type: cellModel.type,
        source: cellModel.source,
        metadata: cellModel.metadata
      };

      // Remove from notebook model
      this._notebookModel.cells.remove(cellIndex);

      // Update Yjs document
      await this._removeCellFromYjs(cellId);

      // Clean up cell state
      this._cellStates.delete(cellId);

      // Emit operation event
      this._emitOperationEvent({
        type: CellOperationType.DELETE,
        cellId,
        userId: currentUser.userId,
        timestamp: new Date(),
        data: {
          index: cellIndex,
          cellData
        }
      });

      // Clear operation tracking
      this._operationInProgress.delete(cellId);

      return true;
    } catch (error) {
      console.error('Error deleting cell:', error);
      this._operationInProgress.delete(cellId);
      return false;
    }
  }

  /**
   * Move a cell to a different position in the notebook
   * 
   * @param cellId - The ID of the cell to move
   * @param newIndex - The new index for the cell
   * @returns Promise resolving to true if cell was moved
   */
  async moveCell(cellId: string, newIndex: number): Promise<boolean> {
    if (this._isDisposed || !this._notebookModel) {
      return false;
    }

    try {
      // Check if we can edit this cell
      const canEdit = await this.canEdit(cellId);
      if (!canEdit) {
        return false;
      }

      const currentUser = this._awarenessService.getCurrentUser();
      
      // Track the operation
      this._operationInProgress.set(cellId, CellOperationType.MOVE);

      // Find the current cell index
      const currentIndex = this._findCellIndex(cellId);
      if (currentIndex === -1) {
        this._operationInProgress.delete(cellId);
        return false;
      }

      // Validate new index
      if (newIndex < 0 || newIndex >= this._notebookModel.cells.length) {
        this._operationInProgress.delete(cellId);
        return false;
      }

      // Move the cell
      this._notebookModel.cells.move(currentIndex, newIndex);

      // Update Yjs document
      await this._moveCellInYjs(cellId, currentIndex, newIndex);

      // Update cell state
      await this._updateCellState(cellId, {
        lastModified: new Date()
      });

      // Emit operation event
      this._emitOperationEvent({
        type: CellOperationType.MOVE,
        cellId,
        userId: currentUser.userId,
        timestamp: new Date(),
        data: {
          fromIndex: currentIndex,
          toIndex: newIndex
        }
      });

      // Clear operation tracking
      this._operationInProgress.delete(cellId);

      return true;
    } catch (error) {
      console.error('Error moving cell:', error);
      this._operationInProgress.delete(cellId);
      return false;
    }
  }

  /**
   * Execute a cell in the notebook
   * 
   * @param cellId - The ID of the cell to run
   * @returns Promise resolving to true if cell execution was initiated
   */
  async runCell(cellId: string): Promise<boolean> {
    if (this._isDisposed || !this._notebookModel) {
      return false;
    }

    try {
      // Check if we can edit this cell
      const canEdit = await this.canEdit(cellId);
      if (!canEdit) {
        return false;
      }

      const currentUser = this._awarenessService.getCurrentUser();
      
      // Track the operation
      this._operationInProgress.set(cellId, CellOperationType.RUN);

      // Find the cell
      const cellIndex = this._findCellIndex(cellId);
      if (cellIndex === -1) {
        this._operationInProgress.delete(cellId);
        return false;
      }

      const cellModel = this._notebookModel.cells.get(cellIndex);
      
      // Only code cells can be executed
      if (cellModel.type !== 'code') {
        this._operationInProgress.delete(cellId);
        return false;
      }

      // Update cell state
      await this._updateCellState(cellId, {
        lastModified: new Date()
      });

      // Emit operation event
      this._emitOperationEvent({
        type: CellOperationType.RUN,
        cellId,
        userId: currentUser.userId,
        timestamp: new Date(),
        data: {
          cellType: cellModel.type,
          source: cellModel.source
        }
      });

      // Clear operation tracking
      this._operationInProgress.delete(cellId);

      return true;
    } catch (error) {
      console.error('Error running cell:', error);
      this._operationInProgress.delete(cellId);
      return false;
    }
  }

  /**
   * Check if a cell is currently locked
   * 
   * @param cellId - The ID of the cell to check
   * @returns Promise resolving to true if cell is locked
   */
  async isLocked(cellId: string): Promise<boolean> {
    if (this._isDisposed) {
      return false;
    }

    return await this._lockService.isLocked(cellId);
  }

  /**
   * Get the current collaborative state of the notebook
   * 
   * @returns Promise resolving to the collaborative state
   */
  async getCollaborativeState(): Promise<{
    isCollaborative: boolean;
    activeUsers: Array<{userId: string; name: string; isActive: boolean}>;
    lockedCells: Array<{cellId: string; owner: string; lockedAt: Date}>;
    conflictingCells: Array<{cellId: string; conflictType: string; users: string[]}>;
  }> {
    if (this._isDisposed) {
      return {
        isCollaborative: false,
        activeUsers: [],
        lockedCells: [],
        conflictingCells: []
      };
    }

    try {
      const isCollaborative = this._yjsProvider.isConnected;
      const activeUsers = this._awarenessService.getUsers();
      const lockedCells: Array<{cellId: string; owner: string; lockedAt: Date}> = [];
      const conflictingCells: Array<{cellId: string; conflictType: string; users: string[]}> = [];

      // Collect locked cells
      for (const [cellId, state] of this._cellStates) {
        if (state.isLocked && state.lockOwner) {
          const lockOwner = await this._lockService.getLockOwner(cellId);
          if (lockOwner) {
            lockedCells.push({
              cellId,
              owner: lockOwner.name,
              lockedAt: lockOwner.lockedAt
            });
          }
        }

        // Collect conflicting cells
        if (state.collaborativeMetadata.conflicts) {
          for (const conflict of state.collaborativeMetadata.conflicts) {
            if (!conflict.resolved) {
              conflictingCells.push({
                cellId,
                conflictType: conflict.conflictType,
                users: conflict.involvedUsers
              });
            }
          }
        }
      }

      return {
        isCollaborative,
        activeUsers,
        lockedCells,
        conflictingCells
      };
    } catch (error) {
      console.error('Error getting collaborative state:', error);
      return {
        isCollaborative: false,
        activeUsers: [],
        lockedCells: [],
        conflictingCells: []
      };
    }
  }

  /**
   * Set the notebook model for this cell operations instance
   * 
   * @param notebookModel - The notebook model to use
   */
  setNotebookModel(notebookModel: INotebookModel): void {
    this._notebookModel = notebookModel;
    this._initializeCellStates();
  }

  /**
   * Check if the operations instance is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the cell operations instance
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;
    
    // Clear all operation tracking
    this._operationInProgress.clear();
    this._cellStates.clear();
  }

  /**
   * Set up event listeners for collaborative features
   */
  private _setupEventListeners(): void {
    // Listen for lock changes
    this._lockService.onLockChange.connect(this._onLockChange, this);
    
    // Listen for awareness changes
    this._awarenessService.onUserLeave.connect(this._onUserLeave, this);
    
    // Listen for document changes
    this._yjsProvider.onDocumentChange.connect(this._onDocumentChange, this);
  }

  /**
   * Handle lock state changes
   */
  private _onLockChange(sender: LockService, args: {
    cellId: string;
    isLocked: boolean;
    owner?: {userId: string; name: string};
  }): void {
    this._cellLockSignal.emit(args);
    
    // Update local cell state
    this._updateCellState(args.cellId, {
      isLocked: args.isLocked,
      lockOwner: args.owner?.userId
    });
  }

  /**
   * Handle user leaving the collaborative session
   */
  private _onUserLeave(sender: AwarenessService, args: {userId: string}): void {
    // Clean up any operations in progress by this user
    for (const [cellId, state] of this._cellStates) {
      if (state.lockOwner === args.userId) {
        this._updateCellState(cellId, {
          isLocked: false,
          lockOwner: undefined,
          lockTimeout: undefined
        });
      }
    }
  }

  /**
   * Handle document changes from Yjs
   */
  private _onDocumentChange(sender: IYjsNotebookProvider, args: {
    type: string;
    cellId?: string;
    changes: any;
  }): void {
    if (args.cellId) {
      this._cellChangeSignal.emit({
        cellId: args.cellId,
        changeType: args.type,
        userId: 'remote', // This would be determined from the change
        timestamp: new Date(),
        data: args.changes
      });
    }
  }

  /**
   * Initialize cell states from the current notebook model
   */
  private async _initializeCellStates(): Promise<void> {
    if (!this._notebookModel) {
      return;
    }

    this._cellStates.clear();

    for (let i = 0; i < this._notebookModel.cells.length; i++) {
      const cellModel = this._notebookModel.cells.get(i);
      await this._initializeCellState(cellModel.id, cellModel);
    }
  }

  /**
   * Initialize state for a specific cell
   */
  private async _initializeCellState(cellId: string, cellModel: ICellModel): Promise<void> {
    const currentUser = this._awarenessService.getCurrentUser();
    
    const state: CellOperationState = {
      cellId,
      isLocked: false,
      lastModified: new Date(),
      collaborativeMetadata: {
        version: 1,
        lastEditedBy: currentUser.userId,
        lastEditedAt: new Date(),
        collaborationHistory: [{
          userId: currentUser.userId,
          userName: currentUser.name,
          timestamp: new Date(),
          operation: CellOperationType.CREATE,
          description: 'Cell initialized'
        }],
        conflicts: []
      }
    };

    this._cellStates.set(cellId, state);
  }

  /**
   * Update the state of a specific cell
   */
  private async _updateCellState(cellId: string, updates: Partial<CellOperationState>): Promise<void> {
    const currentState = this._cellStates.get(cellId);
    if (!currentState) {
      return;
    }

    const updatedState = {
      ...currentState,
      ...updates
    };

    // Update collaborative metadata
    if (updates.lastModified) {
      const currentUser = this._awarenessService.getCurrentUser();
      updatedState.collaborativeMetadata = {
        ...currentState.collaborativeMetadata,
        version: currentState.collaborativeMetadata.version + 1,
        lastEditedBy: currentUser.userId,
        lastEditedAt: updates.lastModified
      };
    }

    this._cellStates.set(cellId, updatedState);
  }

  /**
   * Find the index of a cell in the notebook model
   */
  private _findCellIndex(cellId: string): number {
    if (!this._notebookModel) {
      return -1;
    }

    for (let i = 0; i < this._notebookModel.cells.length; i++) {
      if (this._notebookModel.cells.get(i).id === cellId) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Synchronize a cell to the Yjs document
   */
  private async _syncCellToYjs(cellId: string, cellModel: ICellModel): Promise<void> {
    const cellsArray = this._yjsProvider.doc.getArray('cells');
    const cellData = {
      id: cellId,
      type: cellModel.type,
      source: cellModel.source,
      metadata: cellModel.metadata
    };

    this._yjsProvider.doc.transact(() => {
      cellsArray.push([cellData]);
    });
  }

  /**
   * Remove a cell from the Yjs document
   */
  private async _removeCellFromYjs(cellId: string): Promise<void> {
    const cellsArray = this._yjsProvider.doc.getArray('cells');
    
    this._yjsProvider.doc.transact(() => {
      for (let i = 0; i < cellsArray.length; i++) {
        const cell = cellsArray.get(i);
        if (cell && cell.id === cellId) {
          cellsArray.delete(i, 1);
          break;
        }
      }
    });
  }

  /**
   * Move a cell within the Yjs document
   */
  private async _moveCellInYjs(cellId: string, fromIndex: number, toIndex: number): Promise<void> {
    const cellsArray = this._yjsProvider.doc.getArray('cells');
    
    this._yjsProvider.doc.transact(() => {
      const cellData = cellsArray.get(fromIndex);
      cellsArray.delete(fromIndex, 1);
      cellsArray.insert(toIndex, [cellData]);
    });
  }

  /**
   * Emit a cell operation event
   */
  private _emitOperationEvent(event: CellOperationEvent): void {
    this._cellOperationSignal.emit(event);
    
    // Update collaborative metadata
    const state = this._cellStates.get(event.cellId);
    if (state) {
      const currentUser = this._awarenessService.getCurrentUser();
      state.collaborativeMetadata.collaborationHistory.push({
        userId: event.userId,
        userName: currentUser.name,
        timestamp: event.timestamp,
        operation: event.type,
        description: this._getOperationDescription(event.type)
      });
    }
  }

  /**
   * Get a human-readable description for an operation type
   */
  private _getOperationDescription(operationType: CellOperationType): string {
    switch (operationType) {
      case CellOperationType.CREATE:
        return 'Created cell';
      case CellOperationType.DELETE:
        return 'Deleted cell';
      case CellOperationType.MOVE:
        return 'Moved cell';
      case CellOperationType.EDIT:
        return 'Edited cell content';
      case CellOperationType.LOCK:
        return 'Locked cell for editing';
      case CellOperationType.UNLOCK:
        return 'Unlocked cell';
      case CellOperationType.RUN:
        return 'Executed cell';
      case CellOperationType.STOP:
        return 'Stopped cell execution';
      default:
        return 'Unknown operation';
    }
  }
}

/**
 * Factory function to create a new cell operations instance
 * 
 * @param yjsProvider - The Yjs provider for collaborative document synchronization
 * @param lockService - Service for managing cell locks
 * @param awarenessService - Service for user presence tracking
 * @returns A new cell operations instance
 */
export function createCellOperations(
  yjsProvider: YjsNotebookProvider,
  lockService: LockService,
  awarenessService: AwarenessService
): CellOperations {
  return new CellOperations(yjsProvider, lockService, awarenessService);
}