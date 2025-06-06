/**
 * @fileoverview CellLockIndicator - Visual lock indicators component for collaborative editing
 * 
 * This component provides comprehensive cell-level editing coordination preventing conflicts
 * through sophisticated lock acquisition, visual ownership indicators, and intelligent
 * conflict resolution interfaces. It integrates with the Redis-coordinated Lock Manager
 * to provide real-time lock status updates and queue-based waiting mechanisms.
 * 
 * Key Features:
 * - Real-time lock status display with user attribution
 * - Lock acquisition and release controls with timeout management
 * - Queue-based conflict resolution with position indicators
 * - Visual feedback for lock ownership and contention
 * - Accessibility support with ARIA live regions
 * - Integration with collaborative presence awareness
 * 
 * @author Jupyter Notebook Collaboration Team
 * @version 7.5.0-alpha.0
 * @since 2024-12-15
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { classes } from 'typestyle';

// Lumino framework imports for Jupyter integration
import { Widget } from '@lumino/widgets';
import { ISignal, Signal } from '@lumino/signaling';

// Collaboration system imports
import { 
  LockManager, 
  ILockMetadata, 
  ILockRequest, 
  ILockReleaseRequest,
  LockStatus, 
  LockPriority,
  ILockEvent,
  ILockQueueEntry
} from '../../../notebook/src/collab/locks';
import { 
  CollaborativeAwareness,
  IUserPresence,
  ActivityStatus 
} from '../../../notebook/src/collab/awareness';
import { 
  YjsNotebookProvider,
  ICollaborationProvider,
  ConnectionState 
} from '../../../notebook/src/collab/YjsNotebookProvider';

/**
 * Props interface for the CellLockIndicator component
 */
export interface ICellLockIndicatorProps {
  /** Unique identifier of the cell this indicator controls */
  cellId: string;
  
  /** Collaboration provider instance for lock coordination */
  collaborationProvider: ICollaborationProvider;
  
  /** Lock manager instance for cell-level coordination */
  lockManager: LockManager | null;
  
  /** Awareness system for presence integration */
  awareness: CollaborativeAwareness | null;
  
  /** Current user information */
  currentUser: {
    userId: string;
    displayName: string;
    avatar?: string;
    role?: string;
  };
  
  /** Optional CSS class name for styling */
  className?: string;
  
  /** Whether the cell is currently selected */
  isSelected?: boolean;
  
  /** Whether the cell is currently being edited */
  isEditing?: boolean;
  
  /** Callback fired when lock status changes */
  onLockStatusChange?: (cellId: string, lockInfo: ILockMetadata | null) => void;
  
  /** Callback fired when lock acquisition is requested */
  onLockRequested?: (cellId: string) => void;
  
  /** Callback fired when lock release is requested */
  onLockReleased?: (cellId: string) => void;
  
  /** Callback fired when conflict resolution is needed */
  onConflictResolution?: (cellId: string, conflictInfo: ILockConflictInfo) => void;
}

/**
 * Interface for lock conflict information
 */
export interface ILockConflictInfo {
  /** Current lock holder information */
  currentHolder: {
    userId: string;
    displayName: string;
    lockAcquiredAt: string;
    lockExpiresAt: string;
  };
  
  /** Queue position if waiting for lock */
  queuePosition?: number;
  
  /** Estimated time until lock becomes available */
  estimatedWaitTime?: number;
  
  /** Available conflict resolution actions */
  resolutionOptions: ILockResolutionOption[];
}

/**
 * Interface for lock resolution options
 */
export interface ILockResolutionOption {
  /** Unique identifier for the resolution action */
  id: string;
  
  /** Human-readable label for the action */
  label: string;
  
  /** Detailed description of the action */
  description: string;
  
  /** Whether this action requires elevated permissions */
  requiresElevatedPermissions: boolean;
  
  /** Function to execute the resolution action */
  execute: () => Promise<void>;
}

/**
 * Lock status display information
 */
interface ILockDisplayInfo {
  status: LockStatus;
  displayText: string;
  iconClass: string;
  colorClass: string;
  isActionable: boolean;
  tooltipText: string;
}

/**
 * Hook for managing lock state and operations
 */
const useLockManager = (
  cellId: string,
  lockManager: LockManager | null,
  currentUser: ICellLockIndicatorProps['currentUser']
) => {
  const [lockInfo, setLockInfo] = useState<ILockMetadata | null>(null);
  const [queueInfo, setQueueInfo] = useState<ILockQueueEntry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Update lock status from lock manager
  const updateLockStatus = useCallback(async () => {
    if (!lockManager) return;

    try {
      const currentLock = await lockManager.getLockStatus(cellId);
      setLockInfo(currentLock);
      
      if (!currentLock) {
        setQueueInfo(null);
      } else if (currentLock.userId !== currentUser.userId) {
        // Check if current user is queued for this lock
        const queueStatus = await lockManager.getQueueStatus(cellId);
        if (queueStatus.userPosition !== undefined) {
          // User is in queue - get queue entry details if needed
          setQueueInfo({
            entryId: `queue-${cellId}-${currentUser.userId}`,
            request: {
              cellId,
              userId: currentUser.userId,
              userName: currentUser.displayName,
              sessionId: lockManager.sessionId,
              priority: LockPriority.Normal
            },
            queuedAt: new Date().toISOString(),
            queueExpiresAt: new Date(Date.now() + 60000).toISOString(),
            position: queueStatus.userPosition
          });
        } else {
          setQueueInfo(null);
        }
      }
    } catch (err) {
      console.error('Failed to update lock status:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [lockManager, cellId, currentUser]);

  // Acquire lock for the current cell
  const acquireLock = useCallback(async (priority: LockPriority = LockPriority.Normal): Promise<boolean> => {
    if (!lockManager) return false;

    setIsLoading(true);
    setError(null);

    try {
      const request: ILockRequest = {
        cellId,
        userId: currentUser.userId,
        userName: currentUser.displayName,
        sessionId: lockManager.sessionId,
        priority,
        timeoutMs: 120000 // 2 minutes
      };

      const lockResult = await lockManager.acquireLock(request);
      setLockInfo(lockResult);
      return true;
    } catch (err) {
      console.error('Failed to acquire lock:', err);
      setError(err instanceof Error ? err.message : 'Failed to acquire lock');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [lockManager, cellId, currentUser]);

  // Release lock for the current cell
  const releaseLock = useCallback(async (force: boolean = false): Promise<boolean> => {
    if (!lockManager || !lockInfo) return false;

    setIsLoading(true);
    setError(null);

    try {
      const releaseRequest: ILockReleaseRequest = {
        lockId: lockInfo.lockId,
        userId: currentUser.userId,
        sessionId: lockManager.sessionId,
        reason: 'user_release',
        force
      };

      const released = await lockManager.releaseLock(releaseRequest);
      if (released) {
        setLockInfo(null);
        setQueueInfo(null);
      }
      return released;
    } catch (err) {
      console.error('Failed to release lock:', err);
      setError(err instanceof Error ? err.message : 'Failed to release lock');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [lockManager, lockInfo, currentUser]);

  // Cancel queued lock request
  const cancelQueuedRequest = useCallback(async (): Promise<boolean> => {
    if (!lockManager) return false;

    try {
      const cancelled = await lockManager.cancelQueuedRequest(cellId);
      if (cancelled) {
        setQueueInfo(null);
      }
      return cancelled;
    } catch (err) {
      console.error('Failed to cancel queued request:', err);
      setError(err instanceof Error ? err.message : 'Failed to cancel request');
      return false;
    }
  }, [lockManager, cellId]);

  // Set up event listeners for lock changes
  useEffect(() => {
    if (!lockManager) return;

    const onLockAcquired = (event: ILockEvent) => {
      if (event.lock.cellId === cellId) {
        setLockInfo(event.lock);
        setError(null);
      }
    };

    const onLockReleased = (event: ILockEvent) => {
      if (event.lock.cellId === cellId) {
        setLockInfo(null);
        setQueueInfo(null);
        setError(null);
      }
    };

    const onLockFailed = (event: ILockEvent) => {
      if (event.lock.cellId === cellId) {
        setError('Lock acquisition failed');
      }
    };

    // Connect to lock manager signals
    lockManager.lockAcquired.connect(onLockAcquired);
    lockManager.lockReleased.connect(onLockReleased);
    lockManager.lockFailed.connect(onLockFailed);

    // Initial lock status check
    updateLockStatus();

    return () => {
      lockManager.lockAcquired.disconnect(onLockAcquired);
      lockManager.lockReleased.disconnect(onLockReleased);
      lockManager.lockFailed.disconnect(onLockFailed);
    };
  }, [lockManager, cellId, updateLockStatus]);

  return {
    lockInfo,
    queueInfo,
    isLoading,
    error,
    acquireLock,
    releaseLock,
    cancelQueuedRequest,
    updateLockStatus
  };
};

/**
 * Hook for managing lock display information
 */
const useLockDisplayInfo = (
  lockInfo: ILockMetadata | null,
  queueInfo: ILockQueueEntry | null,
  currentUser: ICellLockIndicatorProps['currentUser']
): ILockDisplayInfo => {
  return useMemo(() => {
    if (!lockInfo) {
      if (queueInfo) {
        return {
          status: LockStatus.Pending,
          displayText: `Queued (position ${queueInfo.position})`,
          iconClass: 'jp-collab-lock-queued-icon',
          colorClass: 'jp-collab-lock-queued',
          isActionable: true,
          tooltipText: `You are in queue for this cell at position ${queueInfo.position}`
        };
      }
      
      return {
        status: LockStatus.Available,
        displayText: 'Available',
        iconClass: 'jp-collab-lock-available-icon',
        colorClass: 'jp-collab-lock-available',
        isActionable: true,
        tooltipText: 'Cell is available for editing'
      };
    }

    const isOwnLock = lockInfo.userId === currentUser.userId;
    const timeRemaining = new Date(lockInfo.expiresAt).getTime() - Date.now();
    const timeRemainingText = timeRemaining > 0 ? 
      `${Math.ceil(timeRemaining / 1000)}s remaining` : 
      'Expired';

    if (isOwnLock) {
      return {
        status: lockInfo.status,
        displayText: `Locked by you (${timeRemainingText})`,
        iconClass: 'jp-collab-lock-owned-icon',
        colorClass: 'jp-collab-lock-owned',
        isActionable: true,
        tooltipText: `You have exclusive editing access to this cell. ${timeRemainingText}`
      };
    }

    return {
      status: lockInfo.status,
      displayText: `Locked by ${lockInfo.userName}`,
      iconClass: 'jp-collab-lock-locked-icon',
      colorClass: 'jp-collab-lock-locked',
      isActionable: false,
      tooltipText: `Cell is locked by ${lockInfo.userName}. ${timeRemainingText}`
    };
  }, [lockInfo, queueInfo, currentUser]);
};

/**
 * CellLockIndicator React component
 */
export const CellLockIndicator: React.FC<ICellLockIndicatorProps> = ({
  cellId,
  collaborationProvider,
  lockManager,
  awareness,
  currentUser,
  className,
  isSelected = false,
  isEditing = false,
  onLockStatusChange,
  onLockRequested,
  onLockReleased,
  onConflictResolution
}) => {
  // Lock management hooks
  const {
    lockInfo,
    queueInfo,
    isLoading,
    error,
    acquireLock,
    releaseLock,
    cancelQueuedRequest
  } = useLockManager(cellId, lockManager, currentUser);

  // Display information hook
  const displayInfo = useLockDisplayInfo(lockInfo, queueInfo, currentUser);

  // Component state
  const [showTooltip, setShowTooltip] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const tooltipTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Notify parent of lock status changes
  useEffect(() => {
    onLockStatusChange?.(cellId, lockInfo);
  }, [cellId, lockInfo, onLockStatusChange]);

  // Handle lock acquisition
  const handleAcquireLock = useCallback(async () => {
    if (!lockManager) return;

    onLockRequested?.(cellId);

    const success = await acquireLock(LockPriority.Normal);
    if (!success && lockInfo && lockInfo.userId !== currentUser.userId) {
      // Show conflict resolution dialog
      setShowConflictDialog(true);
      
      const conflictInfo: ILockConflictInfo = {
        currentHolder: {
          userId: lockInfo.userId,
          displayName: lockInfo.userName,
          lockAcquiredAt: lockInfo.acquiredAt,
          lockExpiresAt: lockInfo.expiresAt
        },
        queuePosition: queueInfo?.position,
        estimatedWaitTime: queueInfo ? 
          (new Date(queueInfo.queueExpiresAt).getTime() - Date.now()) : undefined,
        resolutionOptions: [
          {
            id: 'wait',
            label: 'Wait in Queue',
            description: 'Wait for the current user to release the lock',
            requiresElevatedPermissions: false,
            execute: async () => {
              // Already queued, just close dialog
              setShowConflictDialog(false);
            }
          },
          {
            id: 'force',
            label: 'Force Acquire',
            description: 'Force acquire the lock (requires admin privileges)',
            requiresElevatedPermissions: true,
            execute: async () => {
              await acquireLock(LockPriority.Emergency);
              setShowConflictDialog(false);
            }
          }
        ]
      };

      onConflictResolution?.(cellId, conflictInfo);
    }
  }, [lockManager, cellId, currentUser, lockInfo, queueInfo, acquireLock, onLockRequested, onConflictResolution]);

  // Handle lock release
  const handleReleaseLock = useCallback(async () => {
    if (!lockManager || !lockInfo) return;

    onLockReleased?.(cellId);
    await releaseLock(false);
  }, [lockManager, lockInfo, cellId, releaseLock, onLockReleased]);

  // Handle queue cancellation
  const handleCancelQueue = useCallback(async () => {
    await cancelQueuedRequest();
  }, [cancelQueuedRequest]);

  // Tooltip management
  const showTooltipDelayed = useCallback(() => {
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
    }
    tooltipTimeoutRef.current = setTimeout(() => {
      setShowTooltip(true);
    }, 500);
  }, []);

  const hideTooltip = useCallback(() => {
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
    setShowTooltip(false);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
      }
    };
  }, []);

  // If collaboration is not available, don't render
  if (!collaborationProvider || collaborationProvider.connectionState !== ConnectionState.CONNECTED) {
    return null;
  }

  // Generate CSS classes
  const containerClasses = classes(
    'jp-collab-cell-lock-indicator',
    displayInfo.colorClass,
    {
      'jp-collab-lock-selected': isSelected,
      'jp-collab-lock-editing': isEditing,
      'jp-collab-lock-loading': isLoading,
      'jp-collab-lock-error': !!error
    },
    className || ''
  );

  return (
    <div className={containerClasses}>
      {/* Lock status icon and text */}
      <div 
        className="jp-collab-lock-status"
        onMouseEnter={showTooltipDelayed}
        onMouseLeave={hideTooltip}
        role="status"
        aria-label={displayInfo.tooltipText}
        aria-live="polite"
      >
        <div className={classes('jp-collab-lock-icon', displayInfo.iconClass)}>
          {displayInfo.status === LockStatus.Locked && (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 7V5C4 2.79086 5.79086 1 8 1C10.2091 1 12 2.79086 12 5V7H13C13.5523 7 14 7.44772 14 8V14C14 14.5523 13.5523 15 13 15H3C2.44772 15 2 14.5523 2 14V8C2 7.44772 2.44772 7 3 7H4ZM6 7H10V5C10 3.89543 9.10457 3 8 3C6.89543 3 6 3.89543 6 5V7Z"/>
            </svg>
          )}
          {displayInfo.status === LockStatus.Available && (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 7V5C4 2.79086 5.79086 1 8 1C10.2091 1 12 2.79086 12 5V5.5C12 5.77614 11.7761 6 11.5 6C11.2239 6 11 5.77614 11 5.5V5C11 3.34315 9.65685 2 8 2C6.34315 2 5 3.34315 5 5V7H13C13.5523 7 14 7.44772 14 8V14C14 14.5523 13.5523 15 13 15H3C2.44772 15 2 14.5523 2 14V8C2 7.44772 2.44772 7 3 7H4Z"/>
            </svg>
          )}
          {displayInfo.status === LockStatus.Pending && (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1ZM8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8C2 4.68629 4.68629 2 8 2ZM8 3C7.44772 3 7 3.44772 7 4V8C7 8.26522 7.10536 8.51957 7.29289 8.70711L9.29289 10.7071C9.68342 11.0976 10.3166 11.0976 10.7071 10.7071C11.0976 10.3166 11.0976 9.68342 10.7071 9.29289L9 7.58579V4C9 3.44772 8.55228 3 8 3Z"/>
            </svg>
          )}
        </div>
        
        <span className="jp-collab-lock-text">
          {displayInfo.displayText}
        </span>
      </div>

      {/* Action buttons */}
      <div className="jp-collab-lock-actions">
        {displayInfo.status === LockStatus.Available && (
          <button
            className="jp-collab-lock-acquire-btn"
            onClick={handleAcquireLock}
            disabled={isLoading}
            title="Acquire exclusive editing lock for this cell"
            aria-label="Acquire editing lock"
          >
            Lock
          </button>
        )}

        {displayInfo.status === LockStatus.Locked && lockInfo?.userId === currentUser.userId && (
          <button
            className="jp-collab-lock-release-btn"
            onClick={handleReleaseLock}
            disabled={isLoading}
            title="Release exclusive editing lock"
            aria-label="Release editing lock"
          >
            Release
          </button>
        )}

        {displayInfo.status === LockStatus.Pending && queueInfo && (
          <button
            className="jp-collab-lock-cancel-btn"
            onClick={handleCancelQueue}
            disabled={isLoading}
            title="Cancel lock request and leave queue"
            aria-label="Cancel lock request"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="jp-collab-lock-error-message" role="alert">
          <span className="jp-collab-lock-error-icon">⚠</span>
          <span className="jp-collab-lock-error-text">{error}</span>
        </div>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <div className="jp-collab-lock-loading-indicator" aria-hidden="true">
          <div className="jp-collab-lock-spinner"></div>
        </div>
      )}

      {/* Tooltip */}
      {showTooltip && (
        <div className="jp-collab-lock-tooltip" role="tooltip">
          {displayInfo.tooltipText}
          {lockInfo && (
            <div className="jp-collab-lock-tooltip-details">
              <div>Acquired: {new Date(lockInfo.acquiredAt).toLocaleTimeString()}</div>
              <div>Expires: {new Date(lockInfo.expiresAt).toLocaleTimeString()}</div>
              {lockInfo.attempts > 1 && (
                <div>Attempts: {lockInfo.attempts}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Live region for screen readers */}
      <div 
        className="jp-collab-lock-live-region" 
        aria-live="polite" 
        aria-atomic="true"
        style={{ position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' }}
      >
        {lockInfo && `Cell lock status: ${displayInfo.displayText}`}
        {error && `Lock error: ${error}`}
      </div>
    </div>
  );
};

/**
 * CellLockIndicator widget class for Lumino integration
 */
export class CellLockIndicatorWidget extends Widget {
  private _reactComponent: React.ReactElement | null = null;
  private _props: ICellLockIndicatorProps;

  constructor(options: ICellLockIndicatorProps) {
    super();
    this._props = options;
    this.addClass('jp-collab-cell-lock-indicator-widget');
    this._renderComponent();
  }

  /**
   * Update component props
   */
  updateProps(newProps: Partial<ICellLockIndicatorProps>): void {
    this._props = { ...this._props, ...newProps };
    this._renderComponent();
  }

  /**
   * Get current lock status
   */
  async getLockStatus(): Promise<ILockMetadata | null> {
    if (!this._props.lockManager) return null;
    return this._props.lockManager.getLockStatus(this._props.cellId);
  }

  /**
   * Force refresh lock status
   */
  async refreshLockStatus(): Promise<void> {
    // This would trigger a re-render of the React component
    this._renderComponent();
  }

  private _renderComponent(): void {
    this._reactComponent = React.createElement(CellLockIndicator, this._props);
    // Note: In a real implementation, this would use ReactDOM.render or a similar method
    // to render the React component into this widget's DOM node
  }

  /**
   * Dispose of the widget
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    
    this._reactComponent = null;
    super.dispose();
  }
}

/**
 * CSS styling for the CellLockIndicator component
 */
export const cellLockIndicatorStyles = `
.jp-collab-cell-lock-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.4;
  transition: all 0.2s ease;
  position: relative;
}

.jp-collab-lock-status {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: default;
}

.jp-collab-lock-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

.jp-collab-lock-text {
  font-weight: 500;
  white-space: nowrap;
}

.jp-collab-lock-actions {
  display: flex;
  gap: 4px;
}

.jp-collab-lock-actions button {
  padding: 2px 8px;
  border: 1px solid;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.jp-collab-lock-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Status-specific styling */
.jp-collab-lock-available {
  background-color: var(--jp-collab-lock-available-bg, rgba(34, 197, 94, 0.1));
  border: 1px solid var(--jp-collab-lock-available-border, rgba(34, 197, 94, 0.3));
  color: var(--jp-collab-lock-available-text, #059669);
}

.jp-collab-lock-locked {
  background-color: var(--jp-collab-lock-locked-bg, rgba(239, 68, 68, 0.1));
  border: 1px solid var(--jp-collab-lock-locked-border, rgba(239, 68, 68, 0.3));
  color: var(--jp-collab-lock-locked-text, #dc2626);
}

.jp-collab-lock-owned {
  background-color: var(--jp-collab-lock-owned-bg, rgba(59, 130, 246, 0.1));
  border: 1px solid var(--jp-collab-lock-owned-border, rgba(59, 130, 246, 0.3));
  color: var(--jp-collab-lock-owned-text, #2563eb);
}

.jp-collab-lock-queued {
  background-color: var(--jp-collab-lock-queued-bg, rgba(245, 158, 11, 0.1));
  border: 1px solid var(--jp-collab-lock-queued-border, rgba(245, 158, 11, 0.3));
  color: var(--jp-collab-lock-queued-text, #d97706);
}

/* Interactive states */
.jp-collab-lock-selected {
  box-shadow: 0 0 0 2px var(--jp-collab-selection-color, #2563eb);
}

.jp-collab-lock-editing {
  background-color: var(--jp-collab-editing-bg, rgba(59, 130, 246, 0.05));
}

.jp-collab-lock-loading {
  opacity: 0.7;
}

.jp-collab-lock-error {
  border-color: var(--jp-collab-error-color, #dc2626) !important;
}

/* Loading spinner */
.jp-collab-lock-loading-indicator {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
}

.jp-collab-lock-spinner {
  width: 12px;
  height: 12px;
  border: 1px solid var(--jp-collab-spinner-bg, #e5e7eb);
  border-top-color: var(--jp-collab-spinner-color, #2563eb);
  border-radius: 50%;
  animation: jp-collab-spin 0.8s linear infinite;
}

@keyframes jp-collab-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Tooltip */
.jp-collab-lock-tooltip {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--jp-collab-tooltip-bg, rgba(0, 0, 0, 0.9));
  color: var(--jp-collab-tooltip-text, white);
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
  z-index: 1000;
  pointer-events: none;
}

.jp-collab-lock-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-top-color: var(--jp-collab-tooltip-bg, rgba(0, 0, 0, 0.9));
}

.jp-collab-lock-tooltip-details {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.2);
  font-size: 10px;
}

/* Error message */
.jp-collab-lock-error-message {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--jp-collab-error-color, #dc2626);
  font-size: 11px;
}

.jp-collab-lock-error-icon {
  font-size: 12px;
}

/* Responsive design */
@media (max-width: 768px) {
  .jp-collab-cell-lock-indicator {
    font-size: 11px;
    padding: 3px 6px;
    gap: 6px;
  }
  
  .jp-collab-lock-actions button {
    padding: 1px 6px;
    font-size: 10px;
  }
  
  .jp-collab-lock-tooltip {
    font-size: 10px;
    padding: 6px 8px;
  }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .jp-collab-cell-lock-indicator {
    border-width: 2px;
  }
  
  .jp-collab-lock-actions button {
    border-width: 2px;
  }
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  .jp-collab-cell-lock-indicator,
  .jp-collab-lock-actions button,
  .jp-collab-lock-spinner {
    transition: none;
    animation: none;
  }
}
`;

// Export the default component
export default CellLockIndicator;