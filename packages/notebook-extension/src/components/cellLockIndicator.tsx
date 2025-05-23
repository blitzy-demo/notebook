/**
 * Cell lock indicator component for collaborative notebooks
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { Cell } from '@jupyterlab/cells';
import { ILockManager, ILockInfo, LockManagerStatus } from '@jupyterlab/notebook/lib/collab/locks';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Time } from '@jupyterlab/coreutils';

/**
 * Props for the CellLockIndicator component
 */
export interface ICellLockIndicatorProps {
  /**
   * The cell ID to track lock status for
   */
  cellId: string;

  /**
   * The lock manager service
   */
  lockManager: ILockManager;

  /**
   * The current user ID
   */
  userId: string;

  /**
   * Optional translator
   */
  translator?: ITranslator;

  /**
   * Optional callback when lock is acquired
   */
  onLockAcquired?: (lockInfo: ILockInfo) => void;

  /**
   * Optional callback when lock is released
   */
  onLockReleased?: (lockInfo: ILockInfo) => void;
}

/**
 * Lock status types
 */
enum LockStatus {
  /**
   * Cell is not locked
   */
  Unlocked = 'unlocked',

  /**
   * Cell is locked by the current user
   */
  LockedByMe = 'locked-by-me',

  /**
   * Cell is locked by another user
   */
  LockedByOther = 'locked-by-other',

  /**
   * Lock manager is not available
   */
  Unavailable = 'unavailable'
}

/**
 * A React component for displaying cell lock status and controls
 */
export const CellLockIndicator: React.FC<ICellLockIndicatorProps> = ({
  cellId,
  lockManager,
  userId,
  translator = nullTranslator,
  onLockAcquired,
  onLockReleased
}) => {
  const trans = translator.load('notebook');
  
  // State for lock status and info
  const [lockStatus, setLockStatus] = useState<LockStatus>(LockStatus.Unlocked);
  const [lockInfo, setLockInfo] = useState<ILockInfo | null>(null);
  const [isAcquiringLock, setIsAcquiringLock] = useState(false);
  const [managerStatus, setManagerStatus] = useState<LockManagerStatus>(lockManager.status);
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [isStateChanging, setIsStateChanging] = useState(false);

  // Update lock status based on current state
  const updateLockStatus = useCallback(() => {
    if (managerStatus !== LockManagerStatus.Ready && managerStatus !== LockManagerStatus.Degraded) {
      setLockStatus(LockStatus.Unavailable);
      setLockInfo(null);
      return;
    }

    const currentLock = lockManager.getLock(cellId);
    if (!currentLock) {
      setLockStatus(LockStatus.Unlocked);
      setLockInfo(null);
      return;
    }

    if (currentLock.userId === userId) {
      setLockStatus(LockStatus.LockedByMe);
    } else {
      setLockStatus(LockStatus.LockedByOther);
    }
    
    setLockInfo(currentLock);
  }, [cellId, lockManager, userId, managerStatus]);

  // Update time remaining for locks
  const updateTimeRemaining = useCallback(() => {
    if (!lockInfo || lockStatus !== LockStatus.LockedByMe) {
      setTimeRemaining('');
      return;
    }

    const now = Date.now();
    const remaining = Math.max(0, lockInfo.expiresAt - now);
    
    if (remaining <= 0) {
      setTimeRemaining(trans.__('Expired'));
      return;
    }

    // Format as MM:SS if more than a minute, otherwise as SS seconds
    const seconds = Math.floor(remaining / 1000);
    if (seconds >= 60) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      setTimeRemaining(`${minutes}:${remainingSeconds.toString().padStart(2, '0')}`);
    } else {
      setTimeRemaining(`${seconds}s`);
    }
  }, [lockInfo, lockStatus, trans]);

  // Handle acquiring a lock
  const handleAcquireLock = async () => {
    if (lockStatus !== LockStatus.Unlocked || isAcquiringLock) {
      return;
    }

    setIsAcquiringLock(true);
    setIsStateChanging(true);
    try {
      const result = await lockManager.acquireLock(cellId);
      if (result.success && result.lock) {
        setLockStatus(LockStatus.LockedByMe);
        setLockInfo(result.lock);
        if (onLockAcquired) {
          onLockAcquired(result.lock);
        }
      }
    } catch (error) {
      console.error('Failed to acquire lock:', error);
    } finally {
      setIsAcquiringLock(false);
      // Reset state changing flag after animation duration
      setTimeout(() => setIsStateChanging(false), 300);
    }
  };

  // Handle releasing a lock
  const handleReleaseLock = async () => {
    if (lockStatus !== LockStatus.LockedByMe || !lockInfo) {
      return;
    }

    setIsStateChanging(true);
    try {
      const released = await lockManager.releaseLock(cellId);
      if (released) {
        const lockInfoCopy = { ...lockInfo };
        setLockStatus(LockStatus.Unlocked);
        setLockInfo(null);
        if (onLockReleased) {
          onLockReleased(lockInfoCopy);
        }
      }
    } catch (error) {
      console.error('Failed to release lock:', error);
    } finally {
      // Reset state changing flag after animation duration
      setTimeout(() => setIsStateChanging(false), 300);
    }
  };

  // Set up event listeners for lock changes
  useEffect(() => {
    // Initial status check
    updateLockStatus();

    // Set up lock event handlers
    const onLockAcquiredHandler = (info: ILockInfo) => {
      if (info.cellId === cellId) {
        setIsStateChanging(true);
        updateLockStatus();
        // Reset state changing flag after animation duration
        setTimeout(() => setIsStateChanging(false), 300);
      }
    };

    const onLockReleasedHandler = (info: ILockInfo) => {
      if (info.cellId === cellId) {
        setIsStateChanging(true);
        updateLockStatus();
        // Reset state changing flag after animation duration
        setTimeout(() => setIsStateChanging(false), 300);
      }
    };

    const onStatusChangedHandler = (status: LockManagerStatus) => {
      setManagerStatus(status);
    };

    // Connect to signals
    const acquiredSlot = lockManager.lockAcquired.connect(onLockAcquiredHandler);
    const releasedSlot = lockManager.lockReleased.connect(onLockReleasedHandler);
    const statusSlot = lockManager.statusChanged.connect(onStatusChangedHandler);

    // Set up timer for updating time remaining
    const timer = setInterval(() => {
      updateTimeRemaining();
    }, 1000);

    // Clean up event listeners
    return () => {
      lockManager.lockAcquired.disconnect(acquiredSlot);
      lockManager.lockReleased.disconnect(releasedSlot);
      lockManager.statusChanged.disconnect(statusSlot);
      clearInterval(timer);
    };
  }, [cellId, lockManager, updateLockStatus, updateTimeRemaining]);

  // Get user initials for the lock owner badge
  const getUserInitials = (name: string): string => {
    if (!name) return '';
    
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) {
      return parts[0].substring(0, 2).toUpperCase();
    } else {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
  };

  // Render different UI based on lock status
  let lockIconClass: string;
  let tooltipText: string;
  let buttonAction: (() => void) | undefined;
  let buttonLabel: string;
  let statusClass: string;

  switch (lockStatus) {
    case LockStatus.Unlocked:
      lockIconClass = 'jp-cell-unlocked';
      tooltipText = trans.__('Cell is available for editing');
      buttonAction = handleAcquireLock;
      buttonLabel = trans.__('Lock');
      statusClass = 'jp-cell-unlocked';
      break;

    case LockStatus.LockedByMe:
      lockIconClass = 'jp-cell-locked jp-cell-locked-by-me';
      tooltipText = timeRemaining 
        ? trans.__('You have locked this cell (%1 remaining)', timeRemaining)
        : trans.__('You have locked this cell');
      buttonAction = handleReleaseLock;
      buttonLabel = trans.__('Unlock');
      statusClass = 'jp-cell-locked-by-me';
      break;

    case LockStatus.LockedByOther:
      lockIconClass = 'jp-cell-locked jp-cell-locked-by-other';
      tooltipText = lockInfo 
        ? trans.__('Locked by %1 at %2', lockInfo.userName, Time.formatHuman(new Date(lockInfo.timestamp)))
        : trans.__('Locked by another user');
      buttonAction = undefined; // No action available
      buttonLabel = trans.__('Locked');
      statusClass = 'jp-cell-locked-by-other';
      break;

    case LockStatus.Unavailable:
      lockIconClass = 'jp-cell-unlocked';
      tooltipText = trans.__('Lock service unavailable');
      buttonAction = undefined; // No action available
      buttonLabel = trans.__('Unavailable');
      statusClass = 'jp-cell-unavailable';
      break;
  }

  // Add animation class if state is changing
  const animationClass = isStateChanging ? 'jp-cell-lock-state-changing' : '';

  return (
    <div 
      className={`jp-cell-lock-indicator ${lockIconClass} ${animationClass}`} 
      title={tooltipText}
      data-user-initials={lockInfo && lockStatus === LockStatus.LockedByOther ? getUserInitials(lockInfo.userName) : ''}
    >
      {/* Lock icon is rendered via CSS */}
      {buttonAction && (
        <button 
          className="jp-cell-lock-button" 
          onClick={buttonAction}
          disabled={isAcquiringLock}
          aria-label={buttonLabel}
        >
          {isAcquiringLock ? trans.__('...') : buttonLabel}
        </button>
      )}
    </div>
  );
};

/**
 * A namespace for CellLockIndicatorWidget
 */
export namespace CellLockIndicatorWidget {
  /**
   * Options for creating a CellLockIndicatorWidget
   */
  export interface IOptions {
    /**
     * The cell to track lock status for
     */
    cell: Cell;

    /**
     * The lock manager service
     */
    lockManager: ILockManager;

    /**
     * The current user ID
     */
    userId: string;

    /**
     * Optional translator
     */
    translator?: ITranslator;
  }

  /**
   * Create a new CellLockIndicatorWidget
   * 
   * @param options - The widget options
   * @returns A new CellLockIndicatorWidget instance
   */
  export function create(options: IOptions): ReactWidget {
    const { cell, lockManager, userId, translator = nullTranslator } = options;
    
    // Create a widget that will be disposed when the cell is disposed
    const widget = ReactWidget.create(
      <CellLockIndicator
        cellId={cell.model.id}
        lockManager={lockManager}
        userId={userId}
        translator={translator}
        onLockAcquired={(lockInfo) => {
          // Add a CSS class to the cell when locked by current user
          if (lockInfo.userId === userId) {
            cell.addClass('jp-mod-locked-by-me');
          } else {
            cell.addClass('jp-mod-locked-by-other');
          }
        }}
        onLockReleased={() => {
          // Remove lock-related CSS classes
          cell.removeClass('jp-mod-locked-by-me');
          cell.removeClass('jp-mod-locked-by-other');
        }}
      />
    );

    widget.addClass('jp-CellLockIndicatorWidget');
    
    return widget;
  }
}