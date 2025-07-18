/**
 * @fileoverview React component for cell-level locking indicators during collaborative editing
 * 
 * This component provides comprehensive visual indicators for cell-level locking mechanisms
 * in collaborative notebook environments. It displays lock status, owner information, and
 * provides controls for acquiring/releasing locks to prevent editing conflicts.
 * 
 * Key features:
 * - Visual lock status indicators with user ownership information
 * - Lock acquisition and release controls integrated with LockService
 * - Conflict resolution indicators for simultaneous edit attempts
 * - Responsive design that doesn't interfere with cell content
 * - Integration with awareness and permission systems
 * - Timeout mechanisms and lock state management
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ICellModel } from '@jupyterlab/cells';
import { ITranslator } from '@jupyterlab/translation';
import { Time } from '@jupyterlab/coreutils';
import { lockIcon } from '@jupyterlab/ui-components';

import { LockService } from '../../../notebook/src/collab/locks';
import { AwarenessService } from '../../../notebook/src/collab/awareness';
import { PermissionService } from '../../../notebook/src/collab/permissions';

/**
 * Enumeration of cell lock states for comprehensive status tracking
 */
export enum CellLockState {
  /** Cell is not locked and available for editing */
  UNLOCKED = 'unlocked',
  /** Cell is locked by the current user */
  LOCKED_BY_SELF = 'locked_by_self',
  /** Cell is locked by another user */
  LOCKED_BY_OTHER = 'locked_by_other',
  /** Lock acquisition is in progress */
  ACQUIRING_LOCK = 'acquiring_lock',
  /** Lock release is in progress */
  RELEASING_LOCK = 'releasing_lock',
  /** Lock conflict detected (simultaneous edit attempts) */
  CONFLICT = 'conflict'
}

/**
 * Interface representing complete cell lock status information
 */
export interface ICellLockStatus {
  /** Whether the cell is currently locked */
  isLocked: boolean;
  /** User ID of the lock owner */
  ownerId?: string;
  /** Display name of the lock owner */
  ownerName?: string;
  /** Timestamp when the lock was acquired */
  lockTime?: Date;
  /** Lock timeout duration in milliseconds */
  timeout?: number;
  /** Whether the current user can unlock this cell */
  canUnlock: boolean;
  /** Whether there's a conflict with this cell */
  isConflicted: boolean;
}

/**
 * Interface for cell lock indicator component properties
 */
export interface ICellLockIndicatorProps {
  /** The cell model to display lock indicator for */
  cellModel: ICellModel;
  /** Service for managing cell locks */
  lockService: LockService;
  /** Service for user awareness and presence */
  awarenessService: AwarenessService;
  /** Service for managing permissions */
  permissionService: PermissionService;
  /** Translation service for internationalization */
  translator: ITranslator;
  /** Callback when lock state changes */
  onLockChange?: (cellId: string, isLocked: boolean) => void;
  /** Callback when conflict is detected */
  onConflictDetected?: (cellId: string, conflictInfo: any) => void;
}

/**
 * React component for displaying cell lock indicators and controls
 * 
 * This component provides a comprehensive interface for managing cell locks
 * in collaborative editing environments, including visual indicators, user
 * information, and interactive controls for lock management.
 */
export function CellLockIndicator(props: ICellLockIndicatorProps): JSX.Element {
  const {
    cellModel,
    lockService,
    awarenessService,
    permissionService,
    translator,
    onLockChange,
    onConflictDetected
  } = props;

  const trans = translator.load('notebook');
  const [lockStatus, setLockStatus] = useState<ICellLockStatus>({
    isLocked: false,
    canUnlock: false,
    isConflicted: false
  });
  const [lockState, setLockState] = useState<CellLockState>(CellLockState.UNLOCKED);
  const [isProcessing, setIsProcessing] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);

  /**
   * Update lock status based on current cell state
   */
  const updateLockStatus = useCallback(async () => {
    if (!cellModel || !lockService) {
      return;
    }

    try {
      const cellId = cellModel.id;
      const isLocked = await lockService.isLocked(cellId);
      const lockOwner = await lockService.getLockOwner(cellId);
      const currentUserInfo = awarenessService.getCurrentUser();

      const newStatus: ICellLockStatus = {
        isLocked,
        ownerId: lockOwner?.userId,
        ownerName: lockOwner?.name,
        lockTime: lockOwner?.lockedAt,
        timeout: lockOwner?.timeout,
        canUnlock: lockOwner?.userId === currentUserInfo.userId || await permissionService.canAdmin(),
        isConflicted: false // Will be updated by conflict detection
      };

      setLockStatus(newStatus);

      // Update lock state based on ownership and user permissions
      if (!isLocked) {
        setLockState(CellLockState.UNLOCKED);
      } else if (lockOwner?.userId === currentUserInfo.userId) {
        setLockState(CellLockState.LOCKED_BY_SELF);
      } else {
        setLockState(CellLockState.LOCKED_BY_OTHER);
      }

      // Calculate time remaining if locked
      if (isLocked && lockOwner?.lockedAt && lockOwner?.timeout) {
        const elapsed = Date.now() - lockOwner.lockedAt.getTime();
        const remaining = Math.max(0, lockOwner.timeout - elapsed);
        setTimeRemaining(remaining);
      } else {
        setTimeRemaining(0);
      }

      // Notify parent of lock state change
      if (onLockChange) {
        onLockChange(cellId, isLocked);
      }
    } catch (error) {
      console.error('Error updating lock status:', error);
    }
  }, [cellModel, lockService, awarenessService, permissionService, onLockChange]);

  /**
   * Handle lock acquisition
   */
  const handleLockAcquisition = useCallback(async () => {
    if (!cellModel || !lockService || isProcessing) {
      return;
    }

    setIsProcessing(true);
    setLockState(CellLockState.ACQUIRING_LOCK);

    try {
      const cellId = cellModel.id;
      const success = await lockService.lockCell(cellId);
      
      if (success) {
        await updateLockStatus();
      } else {
        // Lock acquisition failed - likely due to conflict
        setLockState(CellLockState.CONFLICT);
        if (onConflictDetected) {
          onConflictDetected(cellId, { reason: 'lock_acquisition_failed' });
        }
        
        // Reset to unlocked state after showing conflict
        setTimeout(() => {
          setLockState(CellLockState.UNLOCKED);
          updateLockStatus();
        }, 2000);
      }
    } catch (error) {
      console.error('Error acquiring lock:', error);
      setLockState(CellLockState.CONFLICT);
      setTimeout(() => {
        setLockState(CellLockState.UNLOCKED);
        updateLockStatus();
      }, 2000);
    } finally {
      setIsProcessing(false);
    }
  }, [cellModel, lockService, isProcessing, updateLockStatus, onConflictDetected]);

  /**
   * Handle lock release
   */
  const handleLockRelease = useCallback(async () => {
    if (!cellModel || !lockService || isProcessing) {
      return;
    }

    setIsProcessing(true);
    setLockState(CellLockState.RELEASING_LOCK);

    try {
      const cellId = cellModel.id;
      await lockService.unlockCell(cellId);
      await updateLockStatus();
    } catch (error) {
      console.error('Error releasing lock:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [cellModel, lockService, isProcessing, updateLockStatus]);

  /**
   * Handle lock service change events
   */
  useEffect(() => {
    if (!lockService || !cellModel) {
      return;
    }

    const cellId = cellModel.id;
    const lockChangeHandler = (
      isLocked: boolean,
      owner?: { userId: string; name: string }
    ) => {
      updateLockStatus();
    };

    // Subscribe to lock changes for this cell
    const disposable = lockService.subscribeToLockChanges(cellId, lockChangeHandler);

    // Initial status update
    updateLockStatus();

    return () => {
      disposable.dispose();
    };
  }, [lockService, cellModel, updateLockStatus]);

  /**
   * Set up timeout countdown timer
   */
  useEffect(() => {
    if (timeRemaining <= 0) {
      return;
    }

    const timer = setInterval(() => {
      setTimeRemaining(prev => {
        const newTime = prev - 1000;
        if (newTime <= 0) {
          updateLockStatus(); // Refresh status when timeout expires
          return 0;
        }
        return newTime;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [timeRemaining, updateLockStatus]);

  /**
   * Get the appropriate CSS class for the lock indicator
   */
  const getLockIndicatorClass = (): string => {
    const baseClass = 'jp-cell-lock-indicator';
    
    switch (lockState) {
      case CellLockState.UNLOCKED:
        return `${baseClass} ${baseClass}-unlocked`;
      case CellLockState.LOCKED_BY_SELF:
        return `${baseClass} ${baseClass}-locked-self`;
      case CellLockState.LOCKED_BY_OTHER:
        return `${baseClass} ${baseClass}-locked-other`;
      case CellLockState.ACQUIRING_LOCK:
        return `${baseClass} ${baseClass}-acquiring`;
      case CellLockState.RELEASING_LOCK:
        return `${baseClass} ${baseClass}-releasing`;
      case CellLockState.CONFLICT:
        return `${baseClass} ${baseClass}-conflict`;
      default:
        return baseClass;
    }
  };

  /**
   * Get the lock indicator icon
   */
  const getLockIcon = (): React.ReactNode => {
    switch (lockState) {
      case CellLockState.UNLOCKED:
        return lockIcon.react({ className: 'jp-cell-lock-icon jp-cell-lock-icon-unlock' });
      case CellLockState.LOCKED_BY_SELF:
        return <span className="jp-cell-lock-icon jp-cell-lock-icon-self">🔒</span>;
      case CellLockState.LOCKED_BY_OTHER:
        return <span className="jp-cell-lock-icon jp-cell-lock-icon-other">🔒</span>;
      case CellLockState.ACQUIRING_LOCK:
        return <span className="jp-cell-lock-icon jp-cell-lock-icon-acquiring">⏳</span>;
      case CellLockState.RELEASING_LOCK:
        return <span className="jp-cell-lock-icon jp-cell-lock-icon-releasing">⏳</span>;
      case CellLockState.CONFLICT:
        return <span className="jp-cell-lock-icon jp-cell-lock-icon-conflict">⚠️</span>;
      default:
        return lockIcon.react({ className: 'jp-cell-lock-icon' });
    }
  };

  /**
   * Get tooltip text for the lock indicator
   */
  const getTooltipText = (): string => {
    switch (lockState) {
      case CellLockState.UNLOCKED:
        return trans.__('Cell is unlocked - click to lock for editing');
      case CellLockState.LOCKED_BY_SELF:
        return trans.__('Cell is locked by you - click to unlock');
      case CellLockState.LOCKED_BY_OTHER:
        const ownerName = lockStatus.ownerName || trans.__('Unknown user');
        const timeLeft = timeRemaining > 0 ? 
          ` (${Time.formatHuman(new Date(timeRemaining))} remaining)` : '';
        return trans.__('Cell is locked by %1%2', ownerName, timeLeft);
      case CellLockState.ACQUIRING_LOCK:
        return trans.__('Acquiring lock...');
      case CellLockState.RELEASING_LOCK:
        return trans.__('Releasing lock...');
      case CellLockState.CONFLICT:
        return trans.__('Lock conflict detected - please try again');
      default:
        return trans.__('Cell lock status');
    }
  };

  /**
   * Handle click on lock indicator
   */
  const handleLockClick = useCallback(() => {
    if (isProcessing) {
      return;
    }

    switch (lockState) {
      case CellLockState.UNLOCKED:
        handleLockAcquisition();
        break;
      case CellLockState.LOCKED_BY_SELF:
        handleLockRelease();
        break;
      case CellLockState.LOCKED_BY_OTHER:
        // Only allow unlock if user has admin permissions
        if (lockStatus.canUnlock) {
          handleLockRelease();
        }
        break;
      default:
        // No action for other states
        break;
    }
  }, [lockState, isProcessing, lockStatus.canUnlock, handleLockAcquisition, handleLockRelease]);

  /**
   * Check if the lock indicator should be clickable
   */
  const isClickable = (): boolean => {
    if (isProcessing) {
      return false;
    }

    switch (lockState) {
      case CellLockState.UNLOCKED:
        return true;
      case CellLockState.LOCKED_BY_SELF:
        return true;
      case CellLockState.LOCKED_BY_OTHER:
        return lockStatus.canUnlock;
      default:
        return false;
    }
  };

  /**
   * Format time remaining for display
   */
  const formatTimeRemaining = (milliseconds: number): string => {
    if (milliseconds <= 0) {
      return '';
    }
    
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  };

  return (
    <div
      className={getLockIndicatorClass()}
      title={getTooltipText()}
      onClick={isClickable() ? handleLockClick : undefined}
      style={{
        cursor: isClickable() ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 6px',
        borderRadius: '4px',
        fontSize: '12px',
        lineHeight: '1.2',
        maxWidth: '150px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {getLockIcon()}
      
      {lockState === CellLockState.LOCKED_BY_OTHER && lockStatus.ownerName && (
        <span className="jp-cell-lock-owner">
          {lockStatus.ownerName}
        </span>
      )}
      
      {timeRemaining > 0 && (
        <span className="jp-cell-lock-timeout">
          {formatTimeRemaining(timeRemaining)}
        </span>
      )}
      
      {lockState === CellLockState.CONFLICT && (
        <span className="jp-cell-lock-conflict-text">
          {trans.__('Conflict')}
        </span>
      )}
    </div>
  );
}

/**
 * Lumino ReactWidget wrapper for the cell lock indicator component
 * 
 * This widget provides integration with the Lumino widget system used
 * throughout JupyterLab and Jupyter Notebook v7.
 */
export class CellLockIndicatorWidget extends ReactWidget {
  private _cellModel: ICellModel;
  private _lockService: LockService;
  private _awarenessService: AwarenessService;
  private _permissionService: PermissionService;
  private _translator: ITranslator;
  private _onLockChange?: (cellId: string, isLocked: boolean) => void;
  private _onConflictDetected?: (cellId: string, conflictInfo: any) => void;

  /**
   * Create a new cell lock indicator widget
   * 
   * @param cellModel - The cell model to display lock indicator for
   * @param lockService - Service for managing cell locks
   * @param awarenessService - Service for user awareness and presence
   * @param permissionService - Service for managing permissions
   * @param translator - Translation service for internationalization
   * @param options - Optional configuration options
   */
  constructor(
    cellModel: ICellModel,
    lockService: LockService,
    awarenessService: AwarenessService,
    permissionService: PermissionService,
    translator: ITranslator,
    options?: {
      onLockChange?: (cellId: string, isLocked: boolean) => void;
      onConflictDetected?: (cellId: string, conflictInfo: any) => void;
    }
  ) {
    super();
    this._cellModel = cellModel;
    this._lockService = lockService;
    this._awarenessService = awarenessService;
    this._permissionService = permissionService;
    this._translator = translator;
    this._onLockChange = options?.onLockChange;
    this._onConflictDetected = options?.onConflictDetected;
    
    this.addClass('jp-cell-lock-indicator-widget');
  }



  /**
   * Update the widget with new cell model or services
   * 
   * @param cellModel - Updated cell model
   * @param lockService - Updated lock service
   * @param awarenessService - Updated awareness service
   * @param permissionService - Updated permission service
   */
  update(
    cellModel?: ICellModel,
    lockService?: LockService,
    awarenessService?: AwarenessService,
    permissionService?: PermissionService
  ): void {
    if (cellModel) {
      this._cellModel = cellModel;
    }
    if (lockService) {
      this._lockService = lockService;
    }
    if (awarenessService) {
      this._awarenessService = awarenessService;
    }
    if (permissionService) {
      this._permissionService = permissionService;
    }
    
    super.update();
  }

  /**
   * Render the React component
   */
  render(): React.ReactNode {
    return React.createElement(CellLockIndicator, {
      cellModel: this._cellModel,
      lockService: this._lockService,
      awarenessService: this._awarenessService,
      permissionService: this._permissionService,
      translator: this._translator,
      onLockChange: this._onLockChange,
      onConflictDetected: this._onConflictDetected
    });
  }

  /**
   * Dispose of the widget and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    
    super.dispose();
  }
}