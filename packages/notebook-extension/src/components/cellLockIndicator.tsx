import { ReactWidget } from '@jupyterlab/apputils';

import { Cell } from '@jupyterlab/cells';

import { ITranslator } from '@jupyterlab/translation';

import React, { useEffect, useState, useCallback } from 'react';

import './cellLockIndicator.css';

/**
 * Interface for cell lock information
 * Contains all data needed to display lock status for a specific cell
 */
interface ICellLockInfo {
  /** Unique identifier for the cell */
  cellId: string;
  /** Whether the cell is currently locked */
  locked: boolean;
  /** ID of the user who locked the cell */
  userId?: string;
  /** Display name of the user who locked the cell */
  userName?: string;
  /** Color associated with the user for visual distinction */
  userColor?: string;
  /** Timestamp when the lock was acquired */
  timestamp?: number;
}

/**
 * Interface for Yjs lock manager (will be implemented in locks.ts)
 * Manages cell-level locking using Yjs shared data structures
 */
interface ILockManager {
  /** Get current lock information for a specific cell */
  getLockInfo(cellId: string): ICellLockInfo | null;
  /** Subscribe to lock state changes */
  onLockChanged: (callback: (cellId: string, lockInfo: ICellLockInfo | null) => void) => void;
  /** Unsubscribe from lock state changes */
  offLockChanged: (callback: (cellId: string, lockInfo: ICellLockInfo | null) => void) => void;
}

/**
 * Props for the CellLockIndicator component
 */
interface CellLockIndicatorProps {
  /** The notebook cell to monitor for lock status */
  cell: Cell;
  /** Lock manager instance for accessing lock state */
  lockManager: ILockManager;
  /** Translator instance for internationalization */
  translator: ITranslator;
}

/**
 * A React component to display cell lock status indicators
 * Shows which user has acquired editing locks on specific notebook cells
 * 
 * Features:
 * - Real-time lock status updates using Yjs shared data structures
 * - User avatar with initials and color coding
 * - Tooltip with lock owner and timestamp information
 * - Responsive design with accessibility support
 * - Smooth animations for lock state changes
 * 
 * @param props - Component props
 * @returns JSX element or empty div if cell is not locked
 */
const CellLockIndicator = ({
  cell,
  lockManager,
  translator,
}: CellLockIndicatorProps): JSX.Element => {
  const trans = translator.load('notebook');
  const [lockInfo, setLockInfo] = useState<ICellLockInfo | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  // Get the cell ID from the cell model
  const cellId = cell.model.id;

  // Callback to handle lock state changes
  const handleLockChange = useCallback((changedCellId: string, newLockInfo: ICellLockInfo | null) => {
    if (changedCellId === cellId) {
      // Add animation when lock state changes
      if (newLockInfo && newLockInfo.locked && (!lockInfo || !lockInfo.locked)) {
        setIsAnimating(true);
        setTimeout(() => setIsAnimating(false), 300);
      }
      setLockInfo(newLockInfo);
    }
  }, [cellId, lockInfo]);

  // Initialize lock state and subscribe to changes
  useEffect(() => {
    if (!lockManager) {
      console.warn('CellLockIndicator: lockManager is not available');
      return;
    }

    try {
      // Get initial lock state
      const initialLockInfo = lockManager.getLockInfo(cellId);
      setLockInfo(initialLockInfo);

      // Subscribe to lock changes
      lockManager.onLockChanged(handleLockChange);

      // Cleanup subscription on unmount
      return () => {
        lockManager.offLockChanged(handleLockChange);
      };
    } catch (error) {
      console.error('CellLockIndicator: Error initializing lock state:', error);
    }
  }, [cellId, lockManager, handleLockChange]);

  // Handle cell disposal
  useEffect(() => {
    const onCellDisposed = () => {
      lockManager.offLockChanged(handleLockChange);
    };

    cell.disposed.connect(onCellDisposed);

    return () => {
      cell.disposed.disconnect(onCellDisposed);
    };
  }, [cell, lockManager, handleLockChange]);

  // If no lock info or cell is not locked, don't render anything
  if (!lockInfo || !lockInfo.locked) {
    return <div className="jp-CellLockIndicator-hidden" />;
  }

  // Fallback for missing user information
  const displayName = lockInfo.userName || lockInfo.userId || trans.__('Unknown User');
  const safeDisplayName = displayName.trim() || trans.__('Unknown User');

  // Generate user avatar initials (memoized for performance)
  const getUserInitials = useCallback((userName: string): string => {
    if (!userName || typeof userName !== 'string' || userName.trim() === '') {
      return '?';
    }
    
    const cleanName = userName.trim();
    const words = cleanName.split(/\s+/).filter(word => word.length > 0);
    
    if (words.length === 0) {
      return '?';
    }
    
    if (words.length === 1) {
      return words[0].charAt(0).toUpperCase();
    }
    
    return words
      .slice(0, 2)
      .map(word => word.charAt(0).toUpperCase())
      .join('');
  }, []);

  // Format lock timestamp (memoized for performance)
  const formatTimestamp = useCallback((timestamp: number): string => {
    if (!timestamp || typeof timestamp !== 'number') {
      return '';
    }
    
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    
    if (minutes < 1) {
      return trans.__('just now');
    } else if (minutes < 60) {
      return trans.__('%1 min ago', minutes);
    } else {
      const hours = Math.floor(minutes / 60);
      return trans.__('%1 hr ago', hours);
    }
  }, [trans]);

  // Generate CSS custom properties for user color
  const userColorStyle = lockInfo.userColor
    ? { 
        '--jp-cell-lock-user-color': lockInfo.userColor,
        '--jp-cell-lock-user-color-alpha': lockInfo.userColor + '20' // 20% opacity
      } as React.CSSProperties
    : {};

  return (
    <div
      className={`jp-CellLockIndicator ${isAnimating ? 'jp-mod-appearing' : ''}`}
      style={userColorStyle}
      title={trans.__(
        'Cell locked by %1%2',
        safeDisplayName,
        lockInfo.timestamp ? ` (${formatTimestamp(lockInfo.timestamp)})` : ''
      )}
      data-user-color={lockInfo.userColor ? lockInfo.userColor.toLowerCase() : 'default'}
    >
      <div className="jp-CellLockIndicator-content">
        <div className="jp-CellLockIndicator-avatar">
          {getUserInitials(safeDisplayName)}
        </div>
        <div className="jp-CellLockIndicator-info">
          <div className="jp-CellLockIndicator-user">
            {safeDisplayName}
          </div>
          <div className="jp-CellLockIndicator-status">
            {trans.__('Editing')}
          </div>
        </div>
        <div className="jp-CellLockIndicator-icon">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M3 5V3.5C3 2.11929 4.11929 1 5.5 1H6.5C7.88071 1 9 2.11929 9 3.5V5M2 5H10C10.5523 5 11 5.44772 11 6V10C11 10.5523 10.5523 11 10 11H2C1.44772 11 1 10.5523 1 10V6C1 5.44772 1.44772 5 2 5Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
};

/**
 * A namespace for CellLockIndicator static methods.
 */
export namespace CellLockIndicator {
  /**
   * Create a new CellLockIndicator widget
   *
   * @param cell The cell to monitor for lock status
   * @param lockManager The lock manager instance
   * @param translator The translator instance
   */
  export const create = ({
    cell,
    lockManager,
    translator,
  }: {
    cell: Cell;
    lockManager: ILockManager;
    translator: ITranslator;
  }): ReactWidget => {
    const widget = ReactWidget.create(
      <CellLockIndicator
        cell={cell}
        lockManager={lockManager}
        translator={translator}
      />
    );

    // Add CSS classes for styling
    widget.addClass('jp-CellLockIndicator-widget');
    widget.id = `cell-lock-indicator-${cell.model.id}`;

    return widget;
  };

  /**
   * Check if a cell is currently locked
   *
   * @param cell The cell to check
   * @param lockManager The lock manager instance
   * @returns True if the cell is locked, false otherwise
   */
  export const isLocked = (cell: Cell, lockManager: ILockManager): boolean => {
    const lockInfo = lockManager.getLockInfo(cell.model.id);
    return lockInfo ? lockInfo.locked : false;
  };

  /**
   * Get the lock owner information for a cell
   *
   * @param cell The cell to check
   * @param lockManager The lock manager instance
   * @returns Lock information if the cell is locked, null otherwise
   */
  export const getLockOwner = (cell: Cell, lockManager: ILockManager): ICellLockInfo | null => {
    const lockInfo = lockManager.getLockInfo(cell.model.id);
    return lockInfo && lockInfo.locked ? lockInfo : null;
  };
}

/**
 * Export the interfaces for use by other modules
 */
export { ICellLockInfo, ILockManager };