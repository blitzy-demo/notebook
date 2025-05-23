import { ReactWidget } from '@jupyterlab/apputils';

import { Cell } from '@jupyterlab/cells';

import { ILockService } from '@jupyterlab/notebook/lib/collab/locks';

import { Notebook } from '@jupyterlab/notebook';

import { ITranslator } from '@jupyterlab/translation';

import React, { useEffect, useState, useCallback } from 'react';

/**
 * Interface for the lock information
 */
interface ILockInfo {
  /** The ID of the cell that is locked */
  cellId: string;
  /** The ID of the user who holds the lock */
  userId: string;
  /** The display name of the user who holds the lock */
  userName: string;
  /** The time when the lock was acquired */
  acquiredTime: Date;
  /** Whether the lock is held by the current user */
  isOwnedByCurrentUser: boolean;
  /** Optional avatar URL of the user who holds the lock */
  avatarUrl?: string;
}

/**
 * Props for the CellLockIndicator component
 */
interface ICellLockIndicatorProps {
  /** The cell to display lock status for */
  cell: Cell;
  /** The notebook containing the cell */
  notebook: Notebook;
  /** The lock service to use for tracking lock states */
  lockService: ILockService;
  /** The translator service */
  translator: ITranslator;
}

/**
 * A React component to display the lock status of a cell.
 * 
 * @param props The component props
 */
const CellLockIndicator = ({
  cell,
  notebook,
  lockService,
  translator
}: ICellLockIndicatorProps): JSX.Element => {
  const trans = translator.load('notebook');
  const [lockInfo, setLockInfo] = useState<ILockInfo | null>(null);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  
  // Check if the cell is locked and update the lock info
  const checkLockStatus = useCallback(() => {
    const cellId = cell.model.id;
    const lockStatus = lockService.getLockStatus(cellId);
    
    if (lockStatus.isLocked) {
      setIsLocked(true);
      setLockInfo({
        cellId,
        userId: lockStatus.userId,
        userName: lockStatus.userName,
        acquiredTime: lockStatus.acquiredTime,
        isOwnedByCurrentUser: lockStatus.isOwnedByCurrentUser,
        avatarUrl: lockStatus.avatarUrl
      });
      
      // Add a CSS class to the cell element to indicate it's locked
      const cellElement = notebook.widgets.find(widget => widget.model.id === cellId);
      if (cellElement) {
        if (lockStatus.isOwnedByCurrentUser) {
          cellElement.addClass('jp-Cell-lockedByMe');
          cellElement.removeClass('jp-Cell-lockedByOther');
        } else {
          cellElement.addClass('jp-Cell-lockedByOther');
          cellElement.removeClass('jp-Cell-lockedByMe');
        }
      }
    } else {
      setIsLocked(false);
      setLockInfo(null);
      
      // Remove lock-related CSS classes from the cell element
      const cellElement = notebook.widgets.find(widget => widget.model.id === cellId);
      if (cellElement) {
        cellElement.removeClass('jp-Cell-lockedByMe');
        cellElement.removeClass('jp-Cell-lockedByOther');
      }
    }
  };

  // Handle acquiring a lock on the cell
  const acquireLock = async () => {
    try {
      // Show a visual indicator that we're trying to acquire the lock
      const cellElement = notebook.widgets.find(widget => widget.model.id === cell.model.id);
      if (cellElement) {
        cellElement.addClass('jp-Cell-lockPending');
      }
      
      await lockService.acquireLock(cell.model.id);
      checkLockStatus();
      
      // Remove the pending indicator
      if (cellElement) {
        cellElement.removeClass('jp-Cell-lockPending');
      }
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      
      // Remove the pending indicator on error
      const cellElement = notebook.widgets.find(widget => widget.model.id === cell.model.id);
      if (cellElement) {
        cellElement.removeClass('jp-Cell-lockPending');
      }
    }
  };

  // Handle releasing a lock on the cell
  const releaseLock = async () => {
    try {
      // Show a visual indicator that we're trying to release the lock
      const cellElement = notebook.widgets.find(widget => widget.model.id === cell.model.id);
      if (cellElement) {
        cellElement.addClass('jp-Cell-lockReleasing');
      }
      
      await lockService.releaseLock(cell.model.id);
      checkLockStatus();
      
      // Remove the releasing indicator
      if (cellElement) {
        cellElement.removeClass('jp-Cell-lockReleasing');
      }
    } catch (error) {
      console.error('Failed to release lock:', error);
      
      // Remove the releasing indicator on error
      const cellElement = notebook.widgets.find(widget => widget.model.id === cell.model.id);
      if (cellElement) {
        cellElement.removeClass('jp-Cell-lockReleasing');
      }
    }
  };

  // Format the time since lock acquisition
  const formatTimeSince = useCallback((date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffHour > 0) {
      return trans.__('%1 hours ago', diffHour);
    } else if (diffMin > 0) {
      return trans.__('%1 minutes ago', diffMin);
    } else {
      return trans.__('%1 seconds ago', diffSec);
    }
  }, [trans]);

  // Set up event listeners and handle cleanup
  useEffect(() => {
    // Check the initial lock status
    checkLockStatus();

    // Subscribe to lock changes for this cell
    const onLockChanged = (cellId: string) => {
      if (cellId === cell.model.id) {
        checkLockStatus();
      }
    };

    // Subscribe to cell activation changes to update lock status
    const onActiveCellChanged = (_: any, args: { newValue: Cell | null, oldValue: Cell | null }) => {
      if (args.newValue && args.newValue.model.id === cell.model.id) {
        // If this cell becomes active, check if we can acquire a lock automatically
        if (!isLocked) {
          lockService.acquireLock(cell.model.id).catch(error => {
            console.error('Failed to auto-acquire lock:', error);
          });
        }
      } else if (args.oldValue && args.oldValue.model.id === cell.model.id) {
        // If this cell is no longer active and we own the lock, consider releasing it
        if (isLocked && lockInfo?.isOwnedByCurrentUser) {
          // Optional: auto-release lock when moving away from cell
          // Uncomment the following lines to enable auto-release
          /*
          lockService.releaseLock(cell.model.id).catch(error => {
            console.error('Failed to auto-release lock:', error);
          });
          */
        }
      }
    };

    lockService.lockChanged.connect(onLockChanged);
    notebook.activeCellChanged.connect(onActiveCellChanged);

    // Clean up the subscriptions when the component unmounts
    return () => {
      lockService.lockChanged.disconnect(onLockChanged);
      notebook.activeCellChanged.disconnect(onActiveCellChanged);
      
      // Remove any lock-related CSS classes when unmounting
      const cellElement = notebook.widgets.find(widget => widget.model.id === cell.model.id);
      if (cellElement) {
        cellElement.removeClass('jp-Cell-lockedByMe');
        cellElement.removeClass('jp-Cell-lockedByOther');
      }
    };
  }, [cell.model.id, isLocked, lockInfo, checkLockStatus, notebook]);

  // Determine if this cell is the active cell in the notebook
  const isActiveCell = notebook.activeCell?.model.id === cell.model.id;

  // If the cell is not locked, show the lock button
  if (!isLocked) {
    return (
      <button
        className={`jp-CellLock-acquire ${isActiveCell ? 'jp-CellLock-active' : ''}`}
        onClick={acquireLock}
        title={trans.__('Lock this cell for editing')}
        aria-label={trans.__('Lock this cell for editing')}
      >
        <span className="jp-CellLock-icon jp-CellLock-unlocked" />
        {isActiveCell && (
          <span className="jp-CellLock-text">{trans.__('Lock')}</span>
        )}
      </button>
    );
  }

  // If the cell is locked by the current user, show the unlock button
  if (lockInfo?.isOwnedByCurrentUser) {
    return (
      <button
        className={`jp-CellLock-release ${isActiveCell ? 'jp-CellLock-active' : ''}`}
        onClick={releaseLock}
        title={trans.__('Release your lock on this cell')}
        aria-label={trans.__('Release your lock on this cell')}
      >
        <span className="jp-CellLock-icon jp-CellLock-lockedByMe" />
        <span className="jp-CellLock-text">
          {isActiveCell ? trans.__('Unlock') : trans.__('Locked by me')}
        </span>
        {isActiveCell && (
          <span className="jp-CellLock-time">
            {formatTimeSince(lockInfo?.acquiredTime || new Date())}
          </span>
        )}
      </button>
    );
  }

  // If the cell is locked by another user, show who has the lock
  return (
    <div 
      className={`jp-CellLock-indicator ${isActiveCell ? 'jp-CellLock-active' : ''}`}
      title={trans.__('Locked by %1 (%2)', lockInfo?.userName || '', formatTimeSince(lockInfo?.acquiredTime || new Date()))}
      aria-label={trans.__('Locked by %1 (%2)', lockInfo?.userName || '', formatTimeSince(lockInfo?.acquiredTime || new Date()))}
    >
      {lockInfo?.avatarUrl ? (
        <img 
          src={lockInfo.avatarUrl} 
          alt={lockInfo.userName}
          className="jp-CellLock-avatar"
        />
      ) : (
        <span className="jp-CellLock-icon jp-CellLock-lockedByOther" />
      )}
      <span className="jp-CellLock-text">
        {trans.__('Locked by %1', lockInfo?.userName || '')}
      </span>
      {isActiveCell && (
        <span className="jp-CellLock-time">
          {formatTimeSince(lockInfo?.acquiredTime || new Date())}
        </span>
      )}
    </div>
  );
};

/**
 * A namespace for CellLockIndicatorComponent static methods.
 * This component provides visual indicators and controls for the cell-level locking system
 * in collaborative notebooks. It displays lock status badges on cells, shows which user
 * currently holds a lock, and provides UI controls to acquire or release locks.
 */
export namespace CellLockIndicatorComponent {
  /**
   * Create a new CellLockIndicatorComponent
   *
   * @param cell The cell to display lock status for
   * @param lockService The lock service to use for tracking lock states
   * @param translator The translator service
   */
  export const create = ({
    cell,
    notebook,
    lockService,
    translator,
  }: {
    cell: Cell;
    notebook: Notebook;
    lockService: ILockService;
    translator: ITranslator;
  }): ReactWidget => {
    return ReactWidget.create(
      <CellLockIndicator 
        cell={cell} 
        notebook={notebook}
        lockService={lockService} 
        translator={translator} 
      />
    );
  };
}