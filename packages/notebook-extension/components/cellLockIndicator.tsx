/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Cell lock indicator component that provides visual feedback when cells are locked for editing by other users.
 * Renders lock icons, user information, and timeout countdowns as overlays on locked cells, integrating with
 * the CellLockManager to prevent simultaneous editing conflicts.
 *
 * Key features:
 * - Display lock icons on cells being edited by others
 * - Show lock owner information with avatar and name
 * - Display timeout countdown for automatic lock release
 * - Integrate with CellLockManager for lock state updates
 * - Prevent edit attempts on locked cells with visual feedback
 * - Support lock transfer and queue visualization
 */

import React, { useState, useEffect, useRef } from 'react';

import { Cell, ICellModel } from '@jupyterlab/cells';
import { ITranslator } from '@jupyterlab/translation';
import { ReactWidget } from '@jupyterlab/apputils';

import { CellLockManager } from 'packages/notebook/src/collab/locks';
import { ICellLockManager, ICellLockStatus, ICollaborativeUser } from 'packages/notebook/src/tokens';

/**
 * Props interface for the CellLockIndicator component
 */
export interface ICellLockIndicatorProps {
  /**
   * The lock manager service for handling cell-level locking
   */
  lockManager: ICellLockManager;

  /**
   * The cell that this indicator is monitoring
   */
  cell: Cell;

  /**
   * Translation service for internationalization
   */
  translator: ITranslator;
}

/**
 * Internal state interface for tracking lock status and user information
 */
interface ICellLockState {
  /**
   * Whether the cell is currently locked
   */
  isLocked: boolean;

  /**
   * Information about the user who holds the lock
   */
  lockOwner: ICollaborativeUser | null;

  /**
   * Time remaining before automatic lock release (in seconds)
   */
  timeRemaining: number;

  /**
   * Users waiting in queue for this cell
   */
  queuedUsers: ICollaborativeUser[];

  /**
   * Whether the lock is about to expire (< 10 seconds)
   */
  isExpiringSoon: boolean;
}

/**
 * CellLockIndicator React component for displaying cell lock status and user information
 */
export const CellLockIndicator = ({
  lockManager,
  cell,
  translator
}: ICellLockIndicatorProps): JSX.Element => {
  const trans = translator.load('notebook');

  // State for tracking lock information
  const [lockState, setLockState] = useState<ICellLockState>({
    isLocked: false,
    lockOwner: null,
    timeRemaining: 0,
    queuedUsers: [],
    isExpiringSoon: false
  });

  // Refs for timer management
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const lockStatusRef = useRef<ICellLockStatus | null>(null);

  /**
   * Get the cell ID from the cell model
   */
  const getCellId = (): string => {
    const model = cell.model;
    return model?.id || '';
  };

  /**
   * Convert user ID to ICollaborativeUser object (mock implementation)
   * In a real implementation, this would fetch user data from the awareness system
   */
  const getUserInfo = (userId: string): ICollaborativeUser => {
    return {
      userId,
      username: userId,
      displayName: userId,
      avatar: '', // Would be populated from user service
      color: '#4285f4', // Default blue color
      cursorPosition: null,
      selectedCells: [],
      isActive: true,
      lastActivity: new Date()
    };
  };

  /**
   * Update lock state from ICellLockStatus
   */
  const updateLockState = (status: ICellLockStatus | null) => {
    if (!status) {
      setLockState({
        isLocked: false,
        lockOwner: null,
        timeRemaining: 0,
        queuedUsers: [],
        isExpiringSoon: false
      });
      return;
    }

    const lockOwner = status.lockedBy ? getUserInfo(status.lockedBy) : null;
    const queuedUsers = status.queuedUsers.map(getUserInfo);

    let timeRemaining = 0;
    if (status.isLocked && status.lockTime) {
      const elapsed = Date.now() - status.lockTime.getTime();
      timeRemaining = Math.max(0, Math.floor((status.timeout - elapsed) / 1000));
    }

    setLockState({
      isLocked: status.isLocked,
      lockOwner,
      timeRemaining,
      queuedUsers,
      isExpiringSoon: timeRemaining < 10 && timeRemaining > 0
    });

    lockStatusRef.current = status;
  };

  /**
   * Handle lock state changes from the lock manager
   */
  const handleLockChange = (
    sender: ICellLockManager,
    args: { cellId: string; status: ICellLockStatus }
  ) => {
    const cellId = getCellId();
    if (args.cellId === cellId) {
      updateLockState(args.status);
    }
  };

  /**
   * Start countdown timer for lock expiration
   */
  const startTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    timerRef.current = setInterval(() => {
      const status = lockStatusRef.current;
      if (!status || !status.isLocked || !status.lockTime) {
        return;
      }

      const elapsed = Date.now() - status.lockTime.getTime();
      const remaining = Math.max(0, Math.floor((status.timeout - elapsed) / 1000));

      if (remaining === 0) {
        // Lock has expired, stop timer
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }

      setLockState(prev => ({
        ...prev,
        timeRemaining: remaining,
        isExpiringSoon: remaining < 10 && remaining > 0
      }));
    }, 1000);
  };

  /**
   * Stop countdown timer
   */
  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  /**
   * Handle click attempts on locked cells
   */
  const handleLockedCellClick = (event: React.MouseEvent) => {
    if (lockState.isLocked) {
      event.preventDefault();
      event.stopPropagation();

      const ownerName = lockState.lockOwner?.displayName || 'Another user';
      const message = trans.__('Cell is locked by %1. Please wait for them to finish editing.', ownerName);

      // Show warning tooltip or notification
      console.warn(message);
      // In real implementation, would show a proper notification/tooltip
    }
  };

  /**
   * Format time remaining into human-readable string
   */
  const formatTimeRemaining = (seconds: number): string => {
    if (seconds < 60) {
      return trans.__('%1s', seconds.toString());
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return trans.__('%1m %2s', minutes.toString(), remainingSeconds.toString());
  };

  // Effect for subscribing to lock state changes
  useEffect(() => {
    const cellId = getCellId();
    if (!cellId) {
      return;
    }

    // Initial lock status check
    const initialStatus = lockManager.lockStatus(cellId);
    updateLockState(initialStatus);

    // Subscribe to lock changes
    lockManager.onLockChange.connect(handleLockChange);

    return () => {
      // Cleanup: disconnect from signals
      lockManager.onLockChange.disconnect(handleLockChange);
      stopTimer();
    };
  }, [lockManager, cell]);

  // Effect for managing countdown timer
  useEffect(() => {
    if (lockState.isLocked && lockState.timeRemaining > 0) {
      startTimer();
    } else {
      stopTimer();
    }

    return () => {
      stopTimer();
    };
  }, [lockState.isLocked, lockState.lockOwner]);

  // Don't render if cell is not locked
  if (!lockState.isLocked || !lockState.lockOwner) {
    return <></>;
  }

  return (
    <div
      className={`jp-CellLockIndicator ${lockState.isExpiringSoon ? 'jp-CellLockIndicator-expiring' : ''}`}
      onClick={handleLockedCellClick}
      title={trans.__('This cell is locked by %1', lockState.lockOwner.displayName)}
    >
      <div className="jp-CellLockIndicator-overlay">
        {/* Lock icon */}
        <div className="jp-CellLockIndicator-icon">
          🔒
        </div>

        {/* User information */}
        <div className="jp-CellLockIndicator-userInfo">
          {lockState.lockOwner.avatar && (
            <img
              className="jp-CellLockIndicator-avatar"
              src={lockState.lockOwner.avatar}
              alt={lockState.lockOwner.displayName}
              width={24}
              height={24}
            />
          )}
          <span className="jp-CellLockIndicator-userName">
            {lockState.lockOwner.displayName}
          </span>
        </div>

        {/* Timer countdown */}
        {lockState.timeRemaining > 0 && (
          <div className="jp-CellLockIndicator-timer">
            <span className="jp-CellLockIndicator-timerLabel">
              {trans.__('Auto-release in:')}
            </span>
            <span className="jp-CellLockIndicator-timerValue">
              {formatTimeRemaining(lockState.timeRemaining)}
            </span>
          </div>
        )}

        {/* Queue indicator */}
        {lockState.queuedUsers.length > 0 && (
          <div className="jp-CellLockIndicator-queue">
            <span className="jp-CellLockIndicator-queueLabel">
              {trans.__('Waiting:')}
            </span>
            <div className="jp-CellLockIndicator-queueUsers">
              {lockState.queuedUsers.slice(0, 3).map((user, index) => (
                <span
                  key={user.userId}
                  className="jp-CellLockIndicator-queueUser"
                  title={user.displayName}
                >
                  {user.avatar ? (
                    <img
                      src={user.avatar}
                      alt={user.displayName}
                      width={16}
                      height={16}
                    />
                  ) : (
                    user.displayName.charAt(0).toUpperCase()
                  )}
                </span>
              ))}
              {lockState.queuedUsers.length > 3 && (
                <span className="jp-CellLockIndicator-queueMore">
                  +{lockState.queuedUsers.length - 3}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Pulse animation for expiring locks */}
        {lockState.isExpiringSoon && (
          <div className="jp-CellLockIndicator-pulseEffect" />
        )}
      </div>
    </div>
  );
};

/**
 * A namespace for CellLockIndicatorComponent static methods.
 */
export namespace CellLockIndicatorComponent {
  /**
   * Create a new CellLockIndicatorComponent
   *
   * @param lockManager The cell lock manager
   * @param cell The cell to monitor for lock status
   * @param translator The translator
   */
  export const create = ({
    lockManager,
    cell,
    translator
  }: {
    lockManager: ICellLockManager;
    cell: Cell;
    translator: ITranslator;
  }): ReactWidget => {
    return ReactWidget.create(
      <CellLockIndicator
        lockManager={lockManager}
        cell={cell}
        translator={translator}
      />
    );
  };
}
