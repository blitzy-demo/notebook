/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Cell Operations Module with Integrated Cell-Level Locking for Collaborative Editing
 *
 * This module provides comprehensive cell operations (execute, insert, delete, move, etc.)
 * with integrated distributed locking mechanisms to prevent editing conflicts during
 * collaborative sessions. All operations check lock status before proceeding and provide
 * visual feedback for locked cells.
 *
 * Key features:
 * - Lock acquisition and release for exclusive cell editing
 * - Automatic lock timeout and cleanup for disconnected users
 * - Visual lock indicators and user feedback
 * - Graceful degradation when collaboration is disabled
 * - Comprehensive error handling with specialized error types
 *
 * @module CellOperations
 */

import React from 'react';
import { ICellModel } from '@jupyterlab/cells';
import { INotebookModel } from '@jupyterlab/notebook';
import { ISignal } from '@lumino/signaling';
import { UUID } from '@lumino/coreutils';

import { CellLockManager } from './collab/locks';
import { ICellLockManager } from './tokens';

/**
 * Specialized error class for cell operation failures with lock status context
 */
export class CellOperationError extends Error {
  /**
   * Error message describing the operation failure
   */
  readonly message: string;

  /**
   * ID of the cell that failed the operation
   */
  readonly cellId: string;

  /**
   * Name of the operation that failed
   */
  readonly operation: string;

  /**
   * Current lock status when the error occurred
   */
  readonly lockStatus: ICellLockStatus | null;

  constructor(
    message: string,
    cellId: string,
    operation: string,
    lockStatus: ICellLockStatus | null = null
  ) {
    super(message);
    this.name = 'CellOperationError';
    this.message = message;
    this.cellId = cellId;
    this.operation = operation;
    this.lockStatus = lockStatus;
  }
}

/**
 * Interface representing cell lock status - compatible with ICellLockStatus
 */
export interface CellLockStatus {
  readonly cellId: string;
  readonly lockedBy: string | null;
  readonly lockTime: Date | null;
  readonly timeout: number;
  readonly isLocked: boolean;
  readonly queuedUsers: string[];
}

/**
 * React component for displaying cell lock status
 */
export class CellLockStatusComponent extends React.Component<{
  cellId: string;
  lockStatus: CellLockStatus | null;
  onLockRelease?: () => void;
}> {
  render() {
    const { cellId, lockStatus, onLockRelease } = this.props;

    if (!lockStatus || !lockStatus.isLocked) {
      return null;
    }

    const lockDuration = lockStatus.lockTime
      ? Date.now() - lockStatus.lockTime.getTime()
      : 0;

    return React.createElement(
      'div',
      {
        className: 'jp-cell-lock-status',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 8px',
          background: '#fff3cd',
          border: '1px solid #ffeaa7',
          borderRadius: '4px',
          fontSize: '12px',
          color: '#856404'
        }
      },
      React.createElement('span', { className: 'lock-icon' }, '🔒'),
      React.createElement(
        'span',
        { className: 'lock-message' },
        `Locked by ${lockStatus.lockedBy} (${Math.round(lockDuration / 1000)}s ago)`
      ),
      lockStatus.queuedUsers.length > 0 && React.createElement(
        'span',
        { className: 'queue-info' },
        `Queue: ${lockStatus.queuedUsers.length} waiting`
      ),
      onLockRelease && React.createElement(
        'button',
        {
          onClick: onLockRelease,
          style: {
            background: 'none',
            border: 'none',
            color: '#007bff',
            cursor: 'pointer',
            textDecoration: 'underline'
          }
        },
        'Force Release'
      )
    );
  }
}

/**
 * Options for cell operation configuration
 */
interface ICellOperationOptions {
  /**
   * Whether to enforce locking for this operation
   */
  enforceLocking?: boolean;

  /**
   * Timeout for lock acquisition in milliseconds
   */
  lockTimeout?: number;

  /**
   * Whether to queue the operation if cell is locked
   */
  queueIfLocked?: boolean;

  /**
   * User ID performing the operation
   */
  userId?: string;

  /**
   * Whether to provide visual feedback
   */
  visualFeedback?: boolean;
}

/**
 * Cell Operations manager providing all notebook cell manipulation functionality
 * with integrated distributed locking mechanisms for collaborative editing
 */
export const CellOperations = {
  // Lock manager instance - injected during initialization
  _lockManager: null as CellLockManager | null,
  _userId: null as string | null,
  _collaborationEnabled: false,

  /**
   * Initialize cell operations with lock manager
   */
  initialize(lockManager: CellLockManager | null, userId: string | null, collaborationEnabled: boolean = false) {
    this._lockManager = lockManager;
    this._userId = userId;
    this._collaborationEnabled = collaborationEnabled;

    // Set up lock change listener for reactive UI updates
    if (lockManager) {
      lockManager.onLockChange.connect((sender, args) => {
        this._handleLockChange(args.cellId, args.status);
      });
    }
  },

  /**
   * Configure lock timeout for automatic release
   */
  configureLockTimeout(timeoutMs: number): void {
    if (this._lockManager) {
      this._lockManager.setLockTimeout(timeoutMs);
    }
  },

  /**
   * Perform cleanup of expired locks
   */
  async performLockCleanup(): Promise<void> {
    if (this._lockManager) {
      await this._lockManager.cleanupLocks();
    }
  },

  /**
   * Handle lock change events for UI updates
   */
  _handleLockChange(cellId: string, status: CellLockStatus): void {
    console.log(`Lock status changed for cell ${cellId}:`, status);

    // Create visual lock indicator using React
    if (status.isLocked) {
      const lockIndicator = this._createLockIndicator(cellId, status);
      console.log(`Cell ${cellId} locked by user ${status.lockedBy}`, lockIndicator);
    } else {
      console.log(`Cell ${cellId} unlocked`);
    }
  },

  /**
   * Create a lock indicator component using React
   */
  _createLockIndicator(cellId: string, status: CellLockStatus) {
    return React.createElement(
      'div',
      {
        key: cellId,
        className: 'cell-lock-indicator',
        title: `Locked by ${status.lockedBy}`,
        style: {
          position: 'absolute',
          top: '5px',
          right: '5px',
          background: '#ff6b6b',
          color: 'white',
          padding: '2px 6px',
          borderRadius: '3px',
          fontSize: '12px',
          zIndex: 1000
        }
      },
      '🔒 ' + (status.lockedBy || 'Unknown')
    );
  },

  /**
   * Execute a cell with lock checking and conflict prevention
   */
  async executeCell(
    notebookModel: INotebookModel,
    cellIndex: number,
    options: ICellOperationOptions = {}
  ): Promise<void> {
    const cellId = this._getCellId(notebookModel, cellIndex);
    const userId = options.userId || this._userId;

    if (!cellId) {
      throw new CellOperationError(
        `Invalid cell index: ${cellIndex}`,
        '',
        'executeCell'
      );
    }

    try {
      // Check and acquire lock if collaboration is enabled
      if (this._collaborationEnabled && this._lockManager && userId) {
        await this._ensureLockAcquired(cellId, userId, options);
      }

      // Get the cell model
      const cell = notebookModel.cells.get(cellIndex);
      if (!cell) {
        throw new CellOperationError(
          `Cell not found at index ${cellIndex}`,
          cellId,
          'executeCell'
        );
      }

      // Perform the execution
      if (cell.type === 'code') {
        // Mark cell as executing
        cell.metadata.set('execution', { 'iopub.status.busy': Date.now() });

        // The actual execution is handled by the kernel connection
        // This would typically trigger kernel execution via the session
        console.log(`Executing code cell ${cellId} by user ${userId}`);

        // Simulate execution completion (in real implementation, this would be async)
        setTimeout(() => {
          cell.metadata.delete('execution');
        }, 100);
      } else {
        console.log(`Cannot execute non-code cell ${cellId} of type ${cell.type}`);
      }

    } catch (error) {
      const lockStatus = this._lockManager?.lockStatus(cellId) || null;
      throw new CellOperationError(
        `Failed to execute cell: ${error.message}`,
        cellId,
        'executeCell',
        lockStatus
      );
    } finally {
      // Release lock after execution
      if (this._collaborationEnabled && this._lockManager && userId) {
        try {
          await this._lockManager.releaseLock(cellId, userId);
        } catch (releaseError) {
          console.warn(`Failed to release lock for cell ${cellId}:`, releaseError);
        }
      }
    }
  },

  /**
   * Insert a new cell with lock checking
   */
  async insertCell(
    notebookModel: INotebookModel,
    index: number,
    cellType: 'code' | 'markdown' | 'raw' = 'code',
    options: ICellOperationOptions = {}
  ): Promise<string> {
    const newCellId = UUID.uuid4();
    const userId = options.userId || this._userId;

    try {
      // For insertions, we might need to check locks on adjacent cells
      // or the entire notebook depending on the implementation strategy
      if (this._collaborationEnabled && this._lockManager && userId) {
        // In this implementation, we'll create the cell first then handle locking
        console.log(`Inserting new cell ${newCellId} at index ${index} by user ${userId}`);
      }

      // Create new cell model based on type
      const newCell = notebookModel.contentFactory.createCell(cellType, {});

      // Set initial metadata
      newCell.metadata.set('id', newCellId);
      newCell.metadata.set('created_by', userId);
      newCell.metadata.set('created_at', new Date().toISOString());

      // Insert the cell into the notebook
      notebookModel.cells.insert(index, newCell);

      // Acquire lock on the new cell for the creator
      if (this._collaborationEnabled && this._lockManager && userId) {
        try {
          await this._lockManager.acquireLock(newCellId, userId);
        } catch (lockError) {
          console.warn(`Failed to acquire lock on new cell ${newCellId}:`, lockError);
        }
      }

      console.log(`Successfully inserted ${cellType} cell ${newCellId} at index ${index}`);
      return newCellId;

    } catch (error) {
      throw new CellOperationError(
        `Failed to insert cell: ${error.message}`,
        newCellId,
        'insertCell'
      );
    }
  },

  /**
   * Delete a cell with lock checking
   */
  async deleteCell(
    notebookModel: INotebookModel,
    cellIndex: number,
    options: ICellOperationOptions = {}
  ): Promise<void> {
    const cellId = this._getCellId(notebookModel, cellIndex);
    const userId = options.userId || this._userId;

    if (!cellId) {
      throw new CellOperationError(
        `Invalid cell index: ${cellIndex}`,
        '',
        'deleteCell'
      );
    }

    try {
      // Check if cell is locked by another user
      if (this._collaborationEnabled && this._lockManager) {
        const lockStatus = this._lockManager.lockStatus(cellId);
        if (lockStatus?.isLocked && lockStatus.lockedBy !== userId) {
          throw new CellOperationError(
            `Cannot delete cell: locked by user ${lockStatus.lockedBy}`,
            cellId,
            'deleteCell',
            lockStatus
          );
        }

        // Acquire lock for deletion
        if (userId) {
          await this._ensureLockAcquired(cellId, userId, options);
        }
      }

      // Perform the deletion
      const removedCell = notebookModel.cells.removeValue(notebookModel.cells.get(cellIndex));
      if (!removedCell) {
        throw new CellOperationError(
          `Cell not found at index ${cellIndex}`,
          cellId,
          'deleteCell'
        );
      }

      // Clean up lock state after deletion
      if (this._collaborationEnabled && this._lockManager && userId) {
        try {
          await this._lockManager.releaseLock(cellId, userId);
        } catch (releaseError) {
          console.warn(`Failed to release lock for deleted cell ${cellId}:`, releaseError);
        }
      }

      console.log(`Successfully deleted cell ${cellId} by user ${userId}`);

    } catch (error) {
      const lockStatus = this._lockManager?.lockStatus(cellId) || null;
      throw new CellOperationError(
        `Failed to delete cell: ${error.message}`,
        cellId,
        'deleteCell',
        lockStatus
      );
    }
  },

  /**
   * Move a cell to a different position with lock checking
   */
  async moveCell(
    notebookModel: INotebookModel,
    fromIndex: number,
    toIndex: number,
    options: ICellOperationOptions = {}
  ): Promise<void> {
    const cellId = this._getCellId(notebookModel, fromIndex);
    const userId = options.userId || this._userId;

    if (!cellId) {
      throw new CellOperationError(
        `Invalid source cell index: ${fromIndex}`,
        '',
        'moveCell'
      );
    }

    try {
      // Check lock status before moving
      if (this._collaborationEnabled && this._lockManager) {
        const lockStatus = this._lockManager.lockStatus(cellId);
        if (lockStatus?.isLocked && lockStatus.lockedBy !== userId) {
          throw new CellOperationError(
            `Cannot move cell: locked by user ${lockStatus.lockedBy}`,
            cellId,
            'moveCell',
            lockStatus
          );
        }

        // Acquire lock for the move operation
        if (userId) {
          await this._ensureLockAcquired(cellId, userId, options);
        }
      }

      // Validate indices
      if (fromIndex < 0 || fromIndex >= notebookModel.cells.length) {
        throw new CellOperationError(
          `Invalid source index: ${fromIndex}`,
          cellId,
          'moveCell'
        );
      }

      if (toIndex < 0 || toIndex > notebookModel.cells.length) {
        throw new CellOperationError(
          `Invalid destination index: ${toIndex}`,
          cellId,
          'moveCell'
        );
      }

      // Perform the move operation
      const cell = notebookModel.cells.get(fromIndex);
      notebookModel.cells.removeAt(fromIndex);

      // Adjust toIndex if needed (when moving down)
      const adjustedToIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
      notebookModel.cells.insert(adjustedToIndex, cell);

      console.log(`Successfully moved cell ${cellId} from index ${fromIndex} to ${adjustedToIndex} by user ${userId}`);

    } catch (error) {
      const lockStatus = this._lockManager?.lockStatus(cellId) || null;
      throw new CellOperationError(
        `Failed to move cell: ${error.message}`,
        cellId,
        'moveCell',
        lockStatus
      );
    } finally {
      // Release lock after move
      if (this._collaborationEnabled && this._lockManager && userId) {
        try {
          await this._lockManager.releaseLock(cellId, userId);
        } catch (releaseError) {
          console.warn(`Failed to release lock for moved cell ${cellId}:`, releaseError);
        }
      }
    }
  },

  /**
   * Change the type of a cell with lock checking
   */
  async changeCellType(
    notebookModel: INotebookModel,
    cellIndex: number,
    newType: 'code' | 'markdown' | 'raw',
    options: ICellOperationOptions = {}
  ): Promise<void> {
    const cellId = this._getCellId(notebookModel, cellIndex);
    const userId = options.userId || this._userId;

    if (!cellId) {
      throw new CellOperationError(
        `Invalid cell index: ${cellIndex}`,
        '',
        'changeCellType'
      );
    }

    try {
      // Check lock before type change
      if (this._collaborationEnabled && this._lockManager && userId) {
        await this._ensureLockAcquired(cellId, userId, options);
      }

      const currentCell = notebookModel.cells.get(cellIndex);
      if (!currentCell) {
        throw new CellOperationError(
          `Cell not found at index ${cellIndex}`,
          cellId,
          'changeCellType'
        );
      }

      // Skip if already the correct type
      if (currentCell.type === newType) {
        console.log(`Cell ${cellId} is already type ${newType}`);
        return;
      }

      // Create new cell of the desired type
      const newCell = notebookModel.contentFactory.createCell(newType, {});

      // Copy content and metadata from old cell
      newCell.value.text = currentCell.value.text;

      // Copy relevant metadata but preserve cell ID
      const oldMetadata = currentCell.metadata;
      for (const [key, value] of oldMetadata.entries()) {
        if (key !== 'execution' && key !== 'collapsed') { // Skip execution-specific metadata
          newCell.metadata.set(key, value);
        }
      }

      // Replace the cell
      notebookModel.cells.set(cellIndex, newCell);

      console.log(`Successfully changed cell ${cellId} type to ${newType} by user ${userId}`);

    } catch (error) {
      const lockStatus = this._lockManager?.lockStatus(cellId) || null;
      throw new CellOperationError(
        `Failed to change cell type: ${error.message}`,
        cellId,
        'changeCellType',
        lockStatus
      );
    } finally {
      // Release lock after type change
      if (this._collaborationEnabled && this._lockManager && userId) {
        try {
          await this._lockManager.releaseLock(cellId, userId);
        } catch (releaseError) {
          console.warn(`Failed to release lock for cell ${cellId}:`, releaseError);
        }
      }
    }
  },

  /**
   * Split a cell at the cursor position with lock checking
   */
  async splitCell(
    notebookModel: INotebookModel,
    cellIndex: number,
    cursorPosition: number,
    options: ICellOperationOptions = {}
  ): Promise<string[]> {
    const cellId = this._getCellId(notebookModel, cellIndex);
    const userId = options.userId || this._userId;

    if (!cellId) {
      throw new CellOperationError(
        `Invalid cell index: ${cellIndex}`,
        '',
        'splitCell'
      );
    }

    try {
      // Check lock before splitting
      if (this._collaborationEnabled && this._lockManager && userId) {
        await this._ensureLockAcquired(cellId, userId, options);
      }

      const originalCell = notebookModel.cells.get(cellIndex);
      if (!originalCell) {
        throw new CellOperationError(
          `Cell not found at index ${cellIndex}`,
          cellId,
          'splitCell'
        );
      }

      const originalText = originalCell.value.text;

      // Validate cursor position
      if (cursorPosition < 0 || cursorPosition > originalText.length) {
        throw new CellOperationError(
          `Invalid cursor position: ${cursorPosition}`,
          cellId,
          'splitCell'
        );
      }

      // Split the text at cursor position
      const firstPart = originalText.substring(0, cursorPosition);
      const secondPart = originalText.substring(cursorPosition);

      // Update original cell with first part
      originalCell.value.text = firstPart;

      // Create new cell with second part
      const newCellId = UUID.uuid4();
      const newCell = notebookModel.contentFactory.createCell(originalCell.type, {});
      newCell.value.text = secondPart;

      // Copy metadata to new cell
      const originalMetadata = originalCell.metadata;
      for (const [key, value] of originalMetadata.entries()) {
        if (key !== 'id') {
          newCell.metadata.set(key, value);
        }
      }
      newCell.metadata.set('id', newCellId);
      newCell.metadata.set('split_from', cellId);

      // Insert new cell after original
      notebookModel.cells.insert(cellIndex + 1, newCell);

      console.log(`Successfully split cell ${cellId} into ${cellId} and ${newCellId} by user ${userId}`);
      return [cellId, newCellId];

    } catch (error) {
      const lockStatus = this._lockManager?.lockStatus(cellId) || null;
      throw new CellOperationError(
        `Failed to split cell: ${error.message}`,
        cellId,
        'splitCell',
        lockStatus
      );
    } finally {
      // Release lock after split
      if (this._collaborationEnabled && this._lockManager && userId) {
        try {
          await this._lockManager.releaseLock(cellId, userId);
        } catch (releaseError) {
          console.warn(`Failed to release lock for split cell ${cellId}:`, releaseError);
        }
      }
    }
  },

  /**
   * Merge a cell with the one above it with lock checking
   */
  async mergeCell(
    notebookModel: INotebookModel,
    cellIndex: number,
    options: ICellOperationOptions = {}
  ): Promise<string> {
    const cellId = this._getCellId(notebookModel, cellIndex);
    const userId = options.userId || this._userId;

    if (!cellId) {
      throw new CellOperationError(
        `Invalid cell index: ${cellIndex}`,
        '',
        'mergeCell'
      );
    }

    if (cellIndex === 0) {
      throw new CellOperationError(
        'Cannot merge first cell - no cell above to merge with',
        cellId,
        'mergeCell'
      );
    }

    const aboveCellId = this._getCellId(notebookModel, cellIndex - 1);
    if (!aboveCellId) {
      throw new CellOperationError(
        `Invalid cell above at index: ${cellIndex - 1}`,
        cellId,
        'mergeCell'
      );
    }

    try {
      // Check locks for both cells
      if (this._collaborationEnabled && this._lockManager && userId) {
        // Check if either cell is locked by another user
        const cellLockStatus = this._lockManager.lockStatus(cellId);
        const aboveLockStatus = this._lockManager.lockStatus(aboveCellId);

        if (cellLockStatus?.isLocked && cellLockStatus.lockedBy !== userId) {
          throw new CellOperationError(
            `Cannot merge: current cell locked by user ${cellLockStatus.lockedBy}`,
            cellId,
            'mergeCell',
            cellLockStatus
          );
        }

        if (aboveLockStatus?.isLocked && aboveLockStatus.lockedBy !== userId) {
          throw new CellOperationError(
            `Cannot merge: cell above locked by user ${aboveLockStatus.lockedBy}`,
            cellId,
            'mergeCell',
            aboveLockStatus
          );
        }

        // Acquire locks for both cells
        await this._ensureLockAcquired(cellId, userId, options);
        await this._ensureLockAcquired(aboveCellId, userId, options);
      }

      const currentCell = notebookModel.cells.get(cellIndex);
      const aboveCell = notebookModel.cells.get(cellIndex - 1);

      if (!currentCell || !aboveCell) {
        throw new CellOperationError(
          'One or both cells not found for merge operation',
          cellId,
          'mergeCell'
        );
      }

      // Check if cells are compatible types
      if (currentCell.type !== aboveCell.type) {
        throw new CellOperationError(
          `Cannot merge cells of different types: ${aboveCell.type} and ${currentCell.type}`,
          cellId,
          'mergeCell'
        );
      }

      // Merge content - concatenate with newline
      const mergedText = aboveCell.value.text + '\n' + currentCell.value.text;
      aboveCell.value.text = mergedText;

      // Remove the current cell
      notebookModel.cells.removeAt(cellIndex);

      // Update metadata to indicate merge
      aboveCell.metadata.set('merged_with', cellId);
      aboveCell.metadata.set('merged_at', new Date().toISOString());

      console.log(`Successfully merged cell ${cellId} with cell above ${aboveCellId} by user ${userId}`);
      return aboveCellId;

    } catch (error) {
      const lockStatus = this._lockManager?.lockStatus(cellId) || null;
      throw new CellOperationError(
        `Failed to merge cell: ${error.message}`,
        cellId,
        'mergeCell',
        lockStatus
      );
    } finally {
      // Release locks for both cells
      if (this._collaborationEnabled && this._lockManager && userId) {
        try {
          await this._lockManager.releaseLock(cellId, userId);
          await this._lockManager.releaseLock(aboveCellId, userId);
        } catch (releaseError) {
          console.warn(`Failed to release locks after merge:`, releaseError);
        }
      }
    }
  },

  /**
   * Check if a cell is locked
   */
  checkLock(cellId: string): boolean {
    if (!this._collaborationEnabled || !this._lockManager) {
      return false;
    }
    return this._lockManager.isLocked(cellId);
  },

  /**
   * Acquire lock on a cell
   */
  async acquireLock(cellId: string, userId?: string): Promise<boolean> {
    if (!this._collaborationEnabled || !this._lockManager) {
      return true; // Always succeed when collaboration is disabled
    }

    const user = userId || this._userId;
    if (!user) {
      throw new CellOperationError(
        'User ID required for lock acquisition',
        cellId,
        'acquireLock'
      );
    }

    try {
      return await this._lockManager.acquireLock(cellId, user);
    } catch (error) {
      const lockStatus = this._lockManager.lockStatus(cellId);
      throw new CellOperationError(
        `Failed to acquire lock: ${error.message}`,
        cellId,
        'acquireLock',
        lockStatus
      );
    }
  },

  /**
   * Release lock on a cell
   */
  async releaseLock(cellId: string, userId?: string): Promise<void> {
    if (!this._collaborationEnabled || !this._lockManager) {
      return; // No-op when collaboration is disabled
    }

    const user = userId || this._userId;
    if (!user) {
      throw new CellOperationError(
        'User ID required for lock release',
        cellId,
        'releaseLock'
      );
    }

    try {
      await this._lockManager.releaseLock(cellId, user);
    } catch (error) {
      const lockStatus = this._lockManager.lockStatus(cellId);
      throw new CellOperationError(
        `Failed to release lock: ${error.message}`,
        cellId,
        'releaseLock',
        lockStatus
      );
    }
  },

  /**
   * Helper method to get cell ID from notebook model and index
   */
  _getCellId(notebookModel: INotebookModel, cellIndex: number): string | null {
    if (cellIndex < 0 || cellIndex >= notebookModel.cells.length) {
      return null;
    }

    const cell = notebookModel.cells.get(cellIndex);
    if (!cell) {
      return null;
    }

    // Try to get ID from metadata first
    const cellId = cell.metadata.get('id') as string;
    if (cellId) {
      return cellId;
    }

    // Generate and set ID if not present
    const newId = UUID.uuid4();
    cell.metadata.set('id', newId);
    return newId;
  },

  /**
   * Helper method to ensure lock is acquired with retry logic
   */
  async _ensureLockAcquired(
    cellId: string,
    userId: string,
    options: ICellOperationOptions
  ): Promise<void> {
    if (!this._lockManager) {
      return;
    }

    try {
      const success = await this._lockManager.acquireLock(cellId, userId);
      if (!success) {
        const lockStatus = this._lockManager.lockStatus(cellId);
        throw new CellOperationError(
          `Failed to acquire lock on cell ${cellId}`,
          cellId,
          'lock_acquisition',
          lockStatus
        );
      }
    } catch (error) {
      if (options.queueIfLocked) {
        // Queue the operation if requested
        await this._lockManager.queueLock(cellId, userId);
        throw new CellOperationError(
          `Cell is locked. Operation queued for user ${userId}`,
          cellId,
          'lock_queued'
        );
      }
      throw error;
    }
  }
};

/**
 * Handle cleanup of locks for disconnected users
 * This function is called when a user disconnects from the collaborative session
 */
export async function handleDisconnectedUserLocks(
  lockManager: CellLockManager,
  userId: string
): Promise<void> {
  if (!lockManager) {
    console.warn('No lock manager available for disconnected user cleanup');
    return;
  }

  try {
    // Get all locks held by the disconnected user
    const userLocks = lockManager.getLocksByUser(userId);

    if (userLocks.length === 0) {
      console.log(`No locks to clean up for disconnected user ${userId}`);
      return;
    }

    console.log(`Cleaning up ${userLocks.length} locks for disconnected user ${userId}`);

    // Release all locks held by the user
    for (const lockStatus of userLocks) {
      try {
        await lockManager.releaseLock(lockStatus.cellId, userId);
        console.log(`Released lock on cell ${lockStatus.cellId} for disconnected user ${userId}`);
      } catch (error) {
        console.error(`Failed to release lock on cell ${lockStatus.cellId} for user ${userId}:`, error);
        // Continue with other locks even if one fails
      }
    }

    console.log(`Completed lock cleanup for disconnected user ${userId}`);

  } catch (error) {
    console.error(`Error during disconnected user lock cleanup for ${userId}:`, error);
  }
}
