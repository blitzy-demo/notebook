import { ReactWidget } from '@jupyterlab/apputils';

import { Cell } from '@jupyterlab/cells';

import { ITranslator } from '@jupyterlab/translation';

import React, { useEffect, useState, useCallback } from 'react';

/**
 * Interface for lock service operations
 * This should match the ILockService interface from packages/notebook/src/collab/locks.ts
 */
interface ILockService {
  /**
   * Acquire a lock on a specific cell
   */
  acquireLock(cellId: string): Promise<boolean>;
  
  /**
   * Release a lock on a specific cell
   */
  releaseLock(cellId: string): Promise<boolean>;
  
  /**
   * Get the current lock state for a cell
   */
  getLockState(cellId: string): ILockState | null;
  
  /**
   * Check if the current user owns the lock for a cell
   */
  isOwnedByCurrentUser(cellId: string): boolean;
  
  /**
   * Signal emitted when lock state changes
   */
  lockStateChanged: {
    connect: (callback: (sender: any, args: ILockStateChangedArgs) => void) => void;
    disconnect: (callback: (sender: any, args: ILockStateChangedArgs) => void) => void;
  };
}

/**
 * Interface for awareness/presence service
 * This should match the IAwarenessService interface from packages/notebook/src/collab/awareness.ts
 */
interface IAwarenessService {
  /**
   * Get current user information
   */
  getCurrentUser(): IUserInfo;
  
  /**
   * Get user information by user ID
   */
  getUser(userId: string): IUserInfo | null;
}

/**
 * Lock state information
 */
interface ILockState {
  cellId: string;
  userId: string;
  userName: string;
  userColor: string;
  acquiredAt: Date;
  isLocked: boolean;
}

/**
 * Lock state change event arguments
 */
interface ILockStateChangedArgs {
  cellId: string;
  oldState: ILockState | null;
  newState: ILockState | null;
}

/**
 * User information from awareness service
 */
interface IUserInfo {
  id: string;
  name: string;
  email?: string;
  color: string;
  avatar?: string;
}

/**
 * Props for the CellLockIndicator component
 */
interface ICellLockIndicatorProps {
  cell: Cell;
  lockService: ILockService;
  awarenessService: IAwarenessService;
  translator: ITranslator;
}

/**
 * React component that displays lock status and provides lock management for a cell
 */
const CellLockIndicator = ({
  cell,
  lockService,
  awarenessService,
  translator,
}: ICellLockIndicatorProps): JSX.Element => {
  const trans = translator.load('notebook');
  const [lockState, setLockState] = useState<ILockState | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Get the cell ID - use the cell model's id or generate one
  const cellId = cell.model.id || cell.model.metadata.get('id') as string || '';

  /**
   * Update lock state from the lock service
   */
  const updateLockState = useCallback(() => {
    const currentState = lockService.getLockState(cellId);
    setLockState(currentState);
  }, [lockService, cellId]);

  /**
   * Handle lock state changes from the service
   */
  const handleLockStateChanged = useCallback((sender: any, args: ILockStateChangedArgs) => {
    if (args.cellId === cellId) {
      setLockState(args.newState);
    }
  }, [cellId]);

  /**
   * Handle click to acquire or release lock
   */
  const handleLockClick = useCallback(async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    
    if (isProcessing) {
      return;
    }

    setIsProcessing(true);

    try {
      if (lockState?.isLocked) {
        // Try to release the lock if we own it
        if (lockService.isOwnedByCurrentUser(cellId)) {
          await lockService.releaseLock(cellId);
        }
      } else {
        // Try to acquire the lock
        await lockService.acquireLock(cellId);
      }
    } catch (error) {
      console.error('Failed to toggle lock state:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [lockState, lockService, cellId, isProcessing]);

  /**
   * Generate tooltip text based on lock state
   */
  const getTooltipText = useCallback((): string => {
    if (!lockState || !lockState.isLocked) {
      return trans.__('Click to acquire lock on this cell');
    }

    const currentUser = awarenessService.getCurrentUser();
    const isOwnLock = lockState.userId === currentUser.id;
    const timeAgo = getTimeAgo(lockState.acquiredAt);

    if (isOwnLock) {
      return trans.__('Locked by you %1 ago. Click to release.', timeAgo);
    } else {
      return trans.__('Locked by %1 (%2 ago)', lockState.userName, timeAgo);
    }
  }, [lockState, awarenessService, trans]);

  /**
   * Get CSS classes for the lock indicator
   */
  const getLockClasses = useCallback((): string => {
    const baseClasses = 'jp-CellLockIndicator';
    
    if (!lockState || !lockState.isLocked) {
      return `${baseClasses} jp-CellLockIndicator-unlocked`;
    }

    const currentUser = awarenessService.getCurrentUser();
    const isOwnLock = lockState.userId === currentUser.id;
    
    if (isOwnLock) {
      return `${baseClasses} jp-CellLockIndicator-locked-own`;
    } else {
      return `${baseClasses} jp-CellLockIndicator-locked-other`;
    }
  }, [lockState, awarenessService]);

  /**
   * Get the lock icon to display
   */
  const getLockIcon = useCallback((): string => {
    if (!lockState || !lockState.isLocked) {
      return '🔓'; // Unlocked icon
    }
    return '🔒'; // Locked icon
  }, [lockState]);

  /**
   * Helper function to format time ago
   */
  const getTimeAgo = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
      return trans.__('%1 seconds', diffSeconds);
    } else if (diffMinutes < 60) {
      return trans.__('%1 minutes', diffMinutes);
    } else if (diffHours < 24) {
      return trans.__('%1 hours', diffHours);
    } else {
      return trans.__('%1 days', diffDays);
    }
  };

  // Set up event listeners and initial state
  useEffect(() => {
    // Initialize lock state
    updateLockState();

    // Listen for lock state changes
    lockService.lockStateChanged.connect(handleLockStateChanged);

    // Cleanup
    return () => {
      lockService.lockStateChanged.disconnect(handleLockStateChanged);
    };
  }, [updateLockState, handleLockStateChanged, lockService]);

  // Render the lock indicator
  return (
    <div
      className={getLockClasses()}
      onClick={handleLockClick}
      title={getTooltipText()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        cursor: isProcessing ? 'wait' : 'pointer',
        opacity: isProcessing ? 0.7 : 1,
        minWidth: '20px',
        height: '20px',
        fontSize: '14px',
        justifyContent: 'center',
        borderRadius: '3px',
        margin: '2px',
        backgroundColor: lockState?.isLocked 
          ? (lockService.isOwnedByCurrentUser(cellId) ? '#e8f5e8' : '#fff3cd')
          : 'transparent',
        border: lockState?.isLocked 
          ? (lockService.isOwnedByCurrentUser(cellId) ? '1px solid #28a745' : '1px solid #ffc107')
          : '1px solid transparent',
        color: lockState?.isLocked 
          ? (lockService.isOwnedByCurrentUser(cellId) ? '#155724' : '#856404')
          : '#6c757d',
        transition: 'all 0.2s ease-in-out'
      }}
      data-cell-id={cellId}
      data-lock-state={lockState?.isLocked ? 'locked' : 'unlocked'}
      data-own-lock={lockState?.isLocked ? lockService.isOwnedByCurrentUser(cellId) : false}
    >
      <span className="jp-CellLockIndicator-icon">
        {getLockIcon()}
      </span>
      {lockState?.isLocked && (
        <span 
          className="jp-CellLockIndicator-owner"
          style={{
            marginLeft: '4px',
            fontSize: '10px',
            fontWeight: 'bold',
            maxWidth: '60px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {lockService.isOwnedByCurrentUser(cellId) ? trans.__('You') : lockState.userName}
        </span>
      )}
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
   * @param cell The cell to display lock indicator for
   * @param lockService The lock service for managing locks
   * @param awarenessService The awareness service for user information
   * @param translator The translator for localization
   */
  export const create = ({
    cell,
    lockService,
    awarenessService,
    translator,
  }: {
    cell: Cell;
    lockService: ILockService;
    awarenessService: IAwarenessService;
    translator: ITranslator;
  }): ReactWidget => {
    return ReactWidget.create(
      <CellLockIndicator
        cell={cell}
        lockService={lockService}
        awarenessService={awarenessService}
        translator={translator}
      />
    );
  };

  /**
   * CSS class names for styling
   */
  export namespace CSS_CLASSES {
    export const ROOT = 'jp-CellLockIndicator';
    export const UNLOCKED = 'jp-CellLockIndicator-unlocked';
    export const LOCKED_OWN = 'jp-CellLockIndicator-locked-own';
    export const LOCKED_OTHER = 'jp-CellLockIndicator-locked-other';
    export const ICON = 'jp-CellLockIndicator-icon';
    export const OWNER = 'jp-CellLockIndicator-owner';
    export const PROCESSING = 'jp-CellLockIndicator-processing';
  }
}

/**
 * CSS styles for the cell lock indicator component
 * These styles should be included in the extension's CSS
 */
export const CSS_STYLES = `
.jp-CellLockIndicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  border-radius: 3px;
  margin: 2px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  user-select: none;
}

.jp-CellLockIndicator:hover {
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  transform: translateY(-1px);
}

.jp-CellLockIndicator-unlocked {
  background-color: transparent;
  border: 1px solid transparent;
  color: #6c757d;
}

.jp-CellLockIndicator-unlocked:hover {
  background-color: #f8f9fa;
  border: 1px solid #dee2e6;
}

.jp-CellLockIndicator-locked-own {
  background-color: #e8f5e8;
  border: 1px solid #28a745;
  color: #155724;
}

.jp-CellLockIndicator-locked-own:hover {
  background-color: #d4edda;
  border-color: #1e7e34;
}

.jp-CellLockIndicator-locked-other {
  background-color: #fff3cd;
  border: 1px solid #ffc107;
  color: #856404;
}

.jp-CellLockIndicator-locked-other:hover {
  background-color: #ffeaa7;
  border-color: #e0a800;
}

.jp-CellLockIndicator-locked-other {
  cursor: not-allowed;
}

.jp-CellLockIndicator-processing {
  opacity: 0.7;
  cursor: wait;
}

.jp-CellLockIndicator-icon {
  display: inline-block;
  line-height: 1;
}

.jp-CellLockIndicator-owner {
  margin-left: 4px;
  font-size: 10px;
  font-weight: bold;
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Responsive design for smaller screens */
@media (max-width: 768px) {
  .jp-CellLockIndicator {
    min-width: 16px;
    height: 16px;
    font-size: 12px;
  }
  
  .jp-CellLockIndicator-owner {
    display: none; /* Hide owner text on small screens */
  }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .jp-CellLockIndicator-locked-own {
    background-color: #ffffff;
    border: 2px solid #000000;
    color: #000000;
  }
  
  .jp-CellLockIndicator-locked-other {
    background-color: #ffff00;
    border: 2px solid #000000;
    color: #000000;
  }
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  .jp-CellLockIndicator {
    transition: none;
  }
  
  .jp-CellLockIndicator:hover {
    transform: none;
  }
}

/* Focus indicators for accessibility */
.jp-CellLockIndicator:focus {
  outline: 2px solid #0066cc;
  outline-offset: 2px;
}

.jp-CellLockIndicator:focus:not(:focus-visible) {
  outline: none;
}

/* Dark theme support */
[data-jp-theme-light="false"] .jp-CellLockIndicator-unlocked {
  color: #adb5bd;
}

[data-jp-theme-light="false"] .jp-CellLockIndicator-unlocked:hover {
  background-color: #343a40;
  border-color: #6c757d;
}

[data-jp-theme-light="false"] .jp-CellLockIndicator-locked-own {
  background-color: #1e4620;
  border-color: #28a745;
  color: #a8e6a3;
}

[data-jp-theme-light="false"] .jp-CellLockIndicator-locked-other {
  background-color: #664d03;
  border-color: #ffc107;
  color: #ffec9e;
}
`;

export default CellLockIndicator;