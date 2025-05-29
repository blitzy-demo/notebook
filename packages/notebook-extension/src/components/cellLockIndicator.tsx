import { ReactWidget } from '@jupyterlab/apputils';

import { Cell } from '@jupyterlab/cells';

import { NotebookPanel } from '@jupyterlab/notebook';

import { ITranslator } from '@jupyterlab/translation';

import { INotebookShell } from '@jupyter-notebook/application';

import { PromiseDelegate } from '@lumino/coreutils';

import { Widget } from '@lumino/widgets';

import React, { useEffect, useState, useCallback, useRef } from 'react';

// Yjs imports for collaboration
import * as Y from 'yjs';

/**
 * Interface for YjsNotebookProvider - represents the Yjs collaboration provider
 * that manages real-time synchronization of notebook state between clients.
 */
interface YjsNotebookProvider {
  /**
   * The shared Yjs document containing all collaborative state
   */
  ydoc: Y.Doc;

  /**
   * Awareness provider for user presence and cursor positions
   */
  awareness: any;

  /**
   * Connect to the collaboration backend
   */
  connect(): void;

  /**
   * Disconnect from the collaboration backend
   */
  disconnect(): void;

  /**
   * Check if the provider is connected
   */
  isConnected: boolean;

  /**
   * Get the current user's information
   */
  user: {
    id: string;
    name: string;
    color: string;
  };
}

/**
 * Interface representing a cell lock in the collaborative environment
 */
interface ICellLock {
  /**
   * Unique identifier for the cell being locked
   */
  cellId: string;

  /**
   * User ID of the person who holds the lock
   */
  userId: string;

  /**
   * Display name of the user who holds the lock
   */
  userName: string;

  /**
   * Color associated with the user for visual indication
   */
  userColor: string;

  /**
   * Timestamp when the lock was acquired
   */
  timestamp: number;

  /**
   * Optional timeout for the lock in milliseconds
   */
  timeout?: number;

  /**
   * Type of lock (edit, comment, etc.)
   */
  lockType: 'edit' | 'comment' | 'metadata';
}

/**
 * Lock acquisition result
 */
interface ILockResult {
  success: boolean;
  conflictUser?: string;
  error?: string;
}

/**
 * Default lock timeout in milliseconds (5 minutes)
 */
const DEFAULT_LOCK_TIMEOUT = 5 * 60 * 1000;

/**
 * Lock heartbeat interval in milliseconds (30 seconds)
 */
const LOCK_HEARTBEAT_INTERVAL = 30 * 1000;

/**
 * Check if a cell is currently locked by another user
 * @param locks The Y.Map containing all cell locks
 * @param cellId The cell ID to check
 * @param currentUserId The current user's ID
 * @returns The lock info if locked by another user, null otherwise
 */
const getCellLock = (
  locks: Y.Map<ICellLock>,
  cellId: string,
  currentUserId: string
): ICellLock | null => {
  const lock = locks.get(cellId);
  if (!lock) {
    return null;
  }

  // Check if lock has expired
  const now = Date.now();
  if (lock.timeout && now > lock.timestamp + lock.timeout) {
    // Lock has expired, remove it
    locks.delete(cellId);
    return null;
  }

  // Return lock if it exists and belongs to another user
  return lock.userId !== currentUserId ? lock : null;
};

/**
 * Check if current user owns the lock for a cell
 * @param locks The Y.Map containing all cell locks
 * @param cellId The cell ID to check
 * @param currentUserId The current user's ID
 * @returns True if current user owns the lock, false otherwise
 */
const isLockedByCurrentUser = (
  locks: Y.Map<ICellLock>,
  cellId: string,
  currentUserId: string
): boolean => {
  const lock = locks.get(cellId);
  if (!lock) {
    return false;
  }

  // Check if lock has expired
  const now = Date.now();
  if (lock.timeout && now > lock.timestamp + lock.timeout) {
    // Lock has expired, remove it
    locks.delete(cellId);
    return false;
  }

  return lock.userId === currentUserId;
};

/**
 * React component for displaying cell lock status and controls
 */
const CellLockIndicator = ({
  cell,
  cellIndex,
  yjsProvider,
  notebookPanel,
  translator,
}: {
  cell: Cell;
  cellIndex: number;
  yjsProvider: YjsNotebookProvider;
  notebookPanel: NotebookPanel;
  translator: ITranslator;
}): JSX.Element => {
  const trans = translator.load('notebook');
  const cellId = cell.model.id;
  const currentUser = yjsProvider.user;

  // State management
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [lockInfo, setLockInfo] = useState<ICellLock | null>(null);
  const [isOwnedByUser, setIsOwnedByUser] = useState<boolean>(false);
  const [showConflictDialog, setShowConflictDialog] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(yjsProvider.isConnected);
  const [lockAcquisitionPending, setLockAcquisitionPending] = useState<boolean>(false);

  // Refs for cleanup
  const heartbeatInterval = useRef<NodeJS.Timeout | null>(null);
  const lockTimeout = useRef<NodeJS.Timeout | null>(null);

  // Get the shared locks map from Yjs document
  const locks = yjsProvider.ydoc.getMap('cellLocks') as Y.Map<ICellLock>;

  /**
   * Update the lock state based on current Yjs state
   */
  const updateLockState = useCallback(() => {
    const lock = getCellLock(locks, cellId, currentUser.id);
    const ownedByUser = isLockedByCurrentUser(locks, cellId, currentUser.id);

    setLockInfo(lock);
    setIsLocked(!!lock);
    setIsOwnedByUser(ownedByUser);
  }, [locks, cellId, currentUser.id]);

  /**
   * Start heartbeat to maintain lock ownership
   */
  const startHeartbeat = useCallback(() => {
    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
    }

    heartbeatInterval.current = setInterval(() => {
      const lock = locks.get(cellId);
      if (lock && lock.userId === currentUser.id) {
        // Update timestamp to maintain lock
        const updatedLock: ICellLock = {
          ...lock,
          timestamp: Date.now(),
        };
        locks.set(cellId, updatedLock);
      } else {
        // Lock was released or taken by another user, stop heartbeat
        if (heartbeatInterval.current) {
          clearInterval(heartbeatInterval.current);
          heartbeatInterval.current = null;
        }
      }
    }, LOCK_HEARTBEAT_INTERVAL);
  }, [locks, cellId, currentUser]);

  /**
   * Acquire lock for the current cell
   */
  const acquireLock = useCallback(
    async (lockType: 'edit' | 'comment' | 'metadata' = 'edit'): Promise<ILockResult> => {
      if (!yjsProvider.isConnected) {
        return {
          success: false,
          error: trans.__('Collaboration service is not connected'),
        };
      }

      setLockAcquisitionPending(true);

      try {
        // Check if cell is already locked by another user
        const existingLock = getCellLock(locks, cellId, currentUser.id);
        if (existingLock) {
          setShowConflictDialog(true);
          return {
            success: false,
            conflictUser: existingLock.userName,
          };
        }

        // Acquire the lock
        const newLock: ICellLock = {
          cellId,
          userId: currentUser.id,
          userName: currentUser.name,
          userColor: currentUser.color,
          timestamp: Date.now(),
          timeout: DEFAULT_LOCK_TIMEOUT,
          lockType,
        };

        locks.set(cellId, newLock);

        // Start heartbeat to maintain lock
        startHeartbeat();

        // Set timeout for automatic lock release
        if (lockTimeout.current) {
          clearTimeout(lockTimeout.current);
        }
        lockTimeout.current = setTimeout(() => {
          releaseLock();
        }, DEFAULT_LOCK_TIMEOUT);

        updateLockState();

        return { success: true };
      } catch (error) {
        console.error('Failed to acquire cell lock:', error);
        return {
          success: false,
          error: trans.__('Failed to acquire cell lock'),
        };
      } finally {
        setLockAcquisitionPending(false);
      }
    },
    [yjsProvider.isConnected, locks, cellId, currentUser, trans, startHeartbeat, updateLockState]
  );

  /**
   * Release lock for the current cell
   */
  const releaseLock = useCallback(() => {
    try {
      const lock = locks.get(cellId);
      if (lock && lock.userId === currentUser.id) {
        locks.delete(cellId);
      }

      // Clear heartbeat and timeout
      if (heartbeatInterval.current) {
        clearInterval(heartbeatInterval.current);
        heartbeatInterval.current = null;
      }
      if (lockTimeout.current) {
        clearTimeout(lockTimeout.current);
        lockTimeout.current = null;
      }

      updateLockState();
    } catch (error) {
      console.error('Failed to release cell lock:', error);
    }
  }, [locks, cellId, currentUser.id, updateLockState]);

  /**
   * Handle conflict resolution when attempting to acquire a locked cell
   */
  const handleConflictResolution = useCallback(
    (action: 'wait' | 'override' | 'cancel') => {
      setShowConflictDialog(false);

      switch (action) {
        case 'wait':
          // Set up polling to check when lock becomes available
          const pollInterval = setInterval(() => {
            const lock = getCellLock(locks, cellId, currentUser.id);
            if (!lock) {
              clearInterval(pollInterval);
              acquireLock();
            }
          }, 2000);

          // Clear polling after 2 minutes
          setTimeout(() => {
            clearInterval(pollInterval);
          }, 120000);
          break;

        case 'override':
          // Force acquire the lock (admin override)
          const newLock: ICellLock = {
            cellId,
            userId: currentUser.id,
            userName: currentUser.name,
            userColor: currentUser.color,
            timestamp: Date.now(),
            timeout: DEFAULT_LOCK_TIMEOUT,
            lockType: 'edit',
          };
          locks.set(cellId, newLock);
          startHeartbeat();
          updateLockState();
          break;

        case 'cancel':
        default:
          // Do nothing, just close the dialog
          break;
      }
    },
    [locks, cellId, currentUser, acquireLock, startHeartbeat, updateLockState]
  );

  /**
   * Handle cell focus events to potentially acquire locks
   */
  const handleCellFocus = useCallback(() => {
    if (yjsProvider.isConnected && !isLocked && !isOwnedByUser) {
      acquireLock('edit');
    }
  }, [yjsProvider.isConnected, isLocked, isOwnedByUser, acquireLock]);

  /**
   * Handle cell blur events to potentially release locks
   */
  const handleCellBlur = useCallback(() => {
    if (isOwnedByUser) {
      releaseLock();
    }
  }, [isOwnedByUser, releaseLock]);

  // Effects
  useEffect(() => {
    // Subscribe to Yjs map changes for real-time lock updates
    const handleLocksChange = () => {
      updateLockState();
    };

    locks.observe(handleLocksChange);
    updateLockState();

    // Monitor connection status
    const handleConnectionChange = () => {
      setIsConnected(yjsProvider.isConnected);
      if (!yjsProvider.isConnected && isOwnedByUser) {
        // Connection lost, release any owned locks
        releaseLock();
      }
    };

    // Set up connection monitoring (implementation depends on YjsProvider interface)
    const connectionCheckInterval = setInterval(handleConnectionChange, 1000);

    // Set up cell focus/blur event handlers
    const cellNode = cell.node;
    cellNode.addEventListener('focus', handleCellFocus, true);
    cellNode.addEventListener('blur', handleCellBlur, true);

    return () => {
      // Cleanup
      locks.unobserve(handleLocksChange);
      clearInterval(connectionCheckInterval);
      cellNode.removeEventListener('focus', handleCellFocus, true);
      cellNode.removeEventListener('blur', handleCellBlur, true);

      if (heartbeatInterval.current) {
        clearInterval(heartbeatInterval.current);
      }
      if (lockTimeout.current) {
        clearTimeout(lockTimeout.current);
      }

      // Release lock on unmount if owned by current user
      if (isOwnedByUser) {
        releaseLock();
      }
    };
  }, [
    locks,
    updateLockState,
    yjsProvider.isConnected,
    isOwnedByUser,
    releaseLock,
    cell.node,
    handleCellFocus,
    handleCellBlur,
  ]);

  // Render lock indicator
  const renderLockIndicator = () => {
    if (!isConnected) {
      return (
        <div className="jp-Collab-CellLock-offline" title={trans.__('Collaboration offline')}>
          <span className="jp-Collab-CellLock-icon">⚡</span>
        </div>
      );
    }

    if (isOwnedByUser) {
      return (
        <div
          className="jp-Collab-CellLock-owned"
          title={trans.__('Cell locked by you')}
          onClick={releaseLock}
        >
          <span className="jp-Collab-CellLock-icon" style={{ color: currentUser.color }}>
            🔒
          </span>
          <span className="jp-Collab-CellLock-user">{trans.__('You')}</span>
        </div>
      );
    }

    if (isLocked && lockInfo) {
      return (
        <div
          className="jp-Collab-CellLock-locked"
          title={trans.__('Cell locked by %1', lockInfo.userName)}
        >
          <span className="jp-Collab-CellLock-icon" style={{ color: lockInfo.userColor }}>
            🔒
          </span>
          <span className="jp-Collab-CellLock-user">{lockInfo.userName}</span>
        </div>
      );
    }

    if (lockAcquisitionPending) {
      return (
        <div className="jp-Collab-CellLock-pending" title={trans.__('Acquiring lock...')}>
          <span className="jp-Collab-CellLock-icon">⏳</span>
        </div>
      );
    }

    return (
      <div
        className="jp-Collab-CellLock-available"
        title={trans.__('Click to lock for editing')}
        onClick={() => acquireLock('edit')}
      >
        <span className="jp-Collab-CellLock-icon">🔓</span>
      </div>
    );
  };

  // Render conflict resolution dialog
  const renderConflictDialog = () => {
    if (!showConflictDialog || !lockInfo) {
      return null;
    }

    return (
      <div className="jp-Collab-ConflictDialog-overlay">
        <div className="jp-Collab-ConflictDialog">
          <div className="jp-Collab-ConflictDialog-header">
            <h3>{trans.__('Cell Lock Conflict')}</h3>
          </div>
          <div className="jp-Collab-ConflictDialog-content">
            <p>
              {trans.__(
                'This cell is currently being edited by %1. What would you like to do?',
                lockInfo.userName
              )}
            </p>
            <div className="jp-Collab-ConflictDialog-userInfo">
              <span
                className="jp-Collab-ConflictDialog-userColor"
                style={{ backgroundColor: lockInfo.userColor }}
              ></span>
              <span className="jp-Collab-ConflictDialog-userName">{lockInfo.userName}</span>
            </div>
          </div>
          <div className="jp-Collab-ConflictDialog-actions">
            <button
              className="jp-Collab-ConflictDialog-button jp-Collab-ConflictDialog-button-secondary"
              onClick={() => handleConflictResolution('wait')}
            >
              {trans.__('Wait')}
            </button>
            <button
              className="jp-Collab-ConflictDialog-button jp-Collab-ConflictDialog-button-secondary"
              onClick={() => handleConflictResolution('cancel')}
            >
              {trans.__('Cancel')}
            </button>
            <button
              className="jp-Collab-ConflictDialog-button jp-Collab-ConflictDialog-button-danger"
              onClick={() => handleConflictResolution('override')}
            >
              {trans.__('Override')}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="jp-Collab-CellLockIndicator">
      {renderLockIndicator()}
      {renderConflictDialog()}
    </div>
  );
};

/**
 * Properties for CellLockIndicatorComponent
 */
interface ICellLockIndicatorProps {
  shell: INotebookShell;
  yjsProvider: YjsNotebookProvider;
  notebookPanel: NotebookPanel;
  translator: ITranslator;
}

/**
 * Cell Lock Indicator Component class implementing collaborative cell locking
 * 
 * This component provides real-time visualization and management of cell-level locks
 * in collaborative notebook editing sessions. It prevents concurrent edits to the
 * same cells, handles conflict resolution, and maintains lock state via Yjs CRDTs.
 * 
 * Key features:
 * - Real-time lock status visualization
 * - Automatic lock acquisition on cell focus
 * - Lock timeout and heartbeat mechanisms
 * - Conflict resolution dialogs
 * - Graceful degradation when collaboration is offline
 */
export class CellLockIndicatorComponent extends Widget {
  private _shell: INotebookShell;
  private _yjsProvider: YjsNotebookProvider;
  private _notebookPanel: NotebookPanel;
  private _translator: ITranslator;
  private _lockWidgets: Map<string, ReactWidget> = new Map();

  constructor(options: ICellLockIndicatorProps) {
    super();
    this._shell = options.shell;
    this._yjsProvider = options.yjsProvider;
    this._notebookPanel = options.notebookPanel;
    this._translator = options.translator;

    this.addClass('jp-Collab-CellLockIndicatorComponent');
    this.title.label = this._translator.load('notebook').__('Cell Lock Indicators');
  }

  /**
   * Create a cell lock widget for a specific cell
   * @param cell The cell to create a lock widget for
   * @param cellIndex The index of the cell in the notebook
   * @returns A ReactWidget containing the lock indicator, or null if creation fails
   */
  createCellLockWidget(cell: Cell, cellIndex: number): ReactWidget | null {
    try {
      const cellId = cell.model.id;

      // Remove existing widget if it exists
      const existingWidget = this._lockWidgets.get(cellId);
      if (existingWidget) {
        existingWidget.dispose();
        this._lockWidgets.delete(cellId);
      }

      // Create new lock indicator widget
      const lockWidget = ReactWidget.create(
        <CellLockIndicator
          cell={cell}
          cellIndex={cellIndex}
          yjsProvider={this._yjsProvider}
          notebookPanel={this._notebookPanel}
          translator={this._translator}
        />
      );

      lockWidget.addClass('jp-Collab-CellLockWidget');
      lockWidget.id = `cell-lock-${cellId}`;

      // Store reference for cleanup
      this._lockWidgets.set(cellId, lockWidget);

      return lockWidget;
    } catch (error) {
      console.error('Failed to create cell lock widget:', error);
      return null;
    }
  }

  /**
   * Update lock widgets for all cells in the notebook
   */
  updateAllCellLocks(): void {
    if (!this._notebookPanel.content) {
      return;
    }

    const cells = this._notebookPanel.content.widgets;
    cells.forEach((cell, index) => {
      if (cell instanceof Cell) {
        this.createCellLockWidget(cell, index);
      }
    });
  }

  /**
   * Remove lock widget for a specific cell
   * @param cellId The ID of the cell to remove the widget for
   */
  removeCellLockWidget(cellId: string): void {
    const widget = this._lockWidgets.get(cellId);
    if (widget) {
      widget.dispose();
      this._lockWidgets.delete(cellId);
    }
  }

  /**
   * Clean up all lock widgets
   */
  dispose(): void {
    // Dispose all lock widgets
    for (const widget of this._lockWidgets.values()) {
      widget.dispose();
    }
    this._lockWidgets.clear();

    super.dispose();
  }
}

/**
 * Namespace for CellLockIndicatorComponent static methods
 */
export namespace CellLockIndicatorComponent {
  /**
   * Create a new CellLockIndicatorComponent
   * 
   * @param options Configuration options for the component
   * @returns A new CellLockIndicatorComponent instance
   */
  export const create = (options: ICellLockIndicatorProps): CellLockIndicatorComponent => {
    return new CellLockIndicatorComponent(options);
  };
}