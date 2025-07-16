// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { Cell } from '@jupyterlab/cells';
import { Time } from '@jupyterlab/coreutils';
import { userIcon } from '@jupyterlab/ui-components';
import { CellLocking, ICellLock, LockState } from '../../../notebook/src/collab/locks';
import { YjsNotebookProvider } from '../../../notebook/src/collab/provider';
import { UserAwareness, IUser } from '../../../notebook/src/collab/awareness';

/**
 * Interface for cell lock indicator component properties
 */
export interface ICellLockIndicatorProps {
  /** Cell identifier */
  cellId: string;
  /** Whether the cell is currently locked */
  isLocked: boolean;
  /** Lock owner information */
  lockOwner: string | null;
  /** Lock timeout duration in milliseconds */
  lockTimeout: number;
  /** Visual settings for lock indicators */
  visualSettings: {
    enableVisualIndicators: boolean;
    lockIndicatorColor: string;
    lockIndicatorOpacity: number;
    lockBorderWidth: number;
    lockBorderStyle: string;
  };
  /** Callback for lock request */
  onLockRequest: (cellId: string) => Promise<void>;
  /** Callback for lock release */
  onLockRelease: (cellId: string) => Promise<void>;
  /** Translation service */
  translator: ITranslator;
}

/**
 * Interface for cell lock indicator state
 */
interface ICellLockIndicatorState {
  /** Whether the lock indicator is visible */
  isVisible: boolean;
  /** Current lock information */
  currentLock: ICellLock | null;
  /** Lock request in progress */
  lockRequestInProgress: boolean;
  /** Lock release in progress */
  lockReleaseInProgress: boolean;
  /** Time remaining until lock expires */
  timeRemaining: number;
  /** Lock owner user information */
  lockOwnerUser: IUser | null;
  /** Current user information */
  currentUser: IUser | null;
  /** Whether current user can acquire lock */
  canAcquireLock: boolean;
  /** Whether current user can release lock */
  canReleaseLock: boolean;
}

/**
 * CellLockIndicator: React component for displaying cell locking status and controls
 * 
 * This component provides visual indicators for cell locking states and user interaction
 * capabilities for acquiring and releasing locks during collaborative editing sessions.
 * It integrates with the CellLocking system to prevent simultaneous editing conflicts.
 */
export default class CellLockIndicator extends ReactWidget {
  private _cellLocking: CellLocking;
  private _provider: YjsNotebookProvider;
  private _awareness: UserAwareness;
  private _cellId: string;
  private _translator: ITranslator;
  private _disposed = false;
  private _lockUpdateTimer: number | null = null;

  /**
   * Construct a new CellLockIndicator
   */
  constructor(
    cellLocking: CellLocking,
    provider: YjsNotebookProvider,
    awareness: UserAwareness,
    cellId: string,
    translator: ITranslator
  ) {
    super();
    this._cellLocking = cellLocking;
    this._provider = provider;
    this._awareness = awareness;
    this._cellId = cellId;
    this._translator = translator;
    
    // Add CSS classes
    this.addClass('jp-CellLockIndicator');
    
    // Set up lock state monitoring
    this._setupLockStateMonitoring();
  }

  /**
   * Props for the cell lock indicator
   */
  get props(): ICellLockIndicatorProps {
    const currentLock = this._getLockForCell(this._cellId);
    const currentUser = this._awareness.getCurrentUser();
    const lockOwner = currentLock ? currentLock.owner : null;
    
    return {
      cellId: this._cellId,
      isLocked: this._cellLocking.isLocked(this._cellId),
      lockOwner,
      lockTimeout: this._cellLocking.getLockTimeout(),
      visualSettings: this._cellLocking.visualIndicatorSettings,
      onLockRequest: this._handleLockRequest.bind(this),
      onLockRelease: this._handleLockRelease.bind(this),
      translator: this._translator
    };
  }

  /**
   * Render the cell lock indicator
   */
  render(): JSX.Element {
    const props = this.props;
    return <CellLockIndicatorComponent {...props} />;
  }

  /**
   * Show lock status indicator
   */
  showLockStatus(): void {
    this.removeClass('jp-CellLockIndicator-hidden');
    this.addClass('jp-CellLockIndicator-visible');
    this.update();
  }

  /**
   * Hide lock status indicator
   */
  hideLockStatus(): void {
    this.removeClass('jp-CellLockIndicator-visible');
    this.addClass('jp-CellLockIndicator-hidden');
    this.update();
  }

  /**
   * Update lock state display
   */
  updateLockState(): void {
    this.update();
  }

  /**
   * Handle lock request
   */
  async onLockRequest(cellId: string): Promise<void> {
    await this._handleLockRequest(cellId);
  }

  /**
   * Handle lock release
   */
  async onLockRelease(cellId: string): Promise<void> {
    await this._handleLockRelease(cellId);
  }

  /**
   * Dispose of the component
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    
    this._disposed = true;
    
    // Clear update timer
    if (this._lockUpdateTimer) {
      clearInterval(this._lockUpdateTimer);
      this._lockUpdateTimer = null;
    }
    
    // Clean up signal connections
    this._cellLocking.onLockStateChanged.disconnect(this._onLockStateChanged, this);
    this._provider.onConnectionStateChanged.disconnect(this._onConnectionStateChanged, this);
    this._awareness.onUsersChanged.disconnect(this._onUsersChanged, this);
    
    super.dispose();
  }

  /**
   * Set up lock state monitoring
   */
  private _setupLockStateMonitoring(): void {
    // Connect to lock state changes
    this._cellLocking.onLockStateChanged.connect(this._onLockStateChanged, this);
    
    // Connect to connection state changes
    this._provider.onConnectionStateChanged.connect(this._onConnectionStateChanged, this);
    
    // Connect to user awareness changes
    this._awareness.onUsersChanged.connect(this._onUsersChanged, this);
    
    // Set up periodic updates for lock timeout display
    this._lockUpdateTimer = window.setInterval(() => {
      this.updateLockState();
    }, 1000); // Update every second
  }

  /**
   * Handle lock state changes
   */
  private _onLockStateChanged = (sender: any, event: any) => {
    if (event.cellId === this._cellId) {
      this.updateLockState();
    }
  };

  /**
   * Handle connection state changes
   */
  private _onConnectionStateChanged = (sender: any, state: any) => {
    this.updateLockState();
  };

  /**
   * Handle user awareness changes
   */
  private _onUsersChanged = (sender: any, users: Map<string, IUser>) => {
    this.updateLockState();
  };

  /**
   * Handle lock request
   */
  private async _handleLockRequest(cellId: string): Promise<void> {
    try {
      const lock = await this._cellLocking.acquireLock(cellId, {
        timeout: this._cellLocking.getLockTimeout(),
        enableVisualIndicators: true
      });
      
      if (lock) {
        this.showLockStatus();
        this.updateLockState();
      }
    } catch (error) {
      console.error('Failed to acquire lock:', error);
    }
  }

  /**
   * Handle lock release
   */
  private async _handleLockRelease(cellId: string): Promise<void> {
    try {
      const success = await this._cellLocking.releaseLock(cellId);
      
      if (success) {
        this.hideLockStatus();
        this.updateLockState();
      }
    } catch (error) {
      console.error('Failed to release lock:', error);
    }
  }

  /**
   * Get lock for a specific cell
   */
  private _getLockForCell(cellId: string): ICellLock | null {
    const activeLocks = this._cellLocking.getActiveLocks();
    return activeLocks.find(lock => lock.cellId === cellId) || null;
  }
}

/**
 * React functional component for cell lock indicator UI
 */
const CellLockIndicatorComponent: React.FC<ICellLockIndicatorProps> = ({
  cellId,
  isLocked,
  lockOwner,
  lockTimeout,
  visualSettings,
  onLockRequest,
  onLockRelease,
  translator
}) => {
  const [state, setState] = useState<ICellLockIndicatorState>({
    isVisible: isLocked,
    currentLock: null,
    lockRequestInProgress: false,
    lockReleaseInProgress: false,
    timeRemaining: 0,
    lockOwnerUser: null,
    currentUser: null,
    canAcquireLock: !isLocked,
    canReleaseLock: false
  });

  const trans = translator.load('notebook');

  // Update state when props change
  useEffect(() => {
    setState(prevState => ({
      ...prevState,
      isVisible: isLocked,
      canAcquireLock: !isLocked,
      canReleaseLock: isLocked && lockOwner !== null
    }));
  }, [isLocked, lockOwner]);

  // Memoized lock request handler
  const handleLockRequest = useCallback(async () => {
    if (state.lockRequestInProgress || isLocked) {
      return;
    }

    setState(prev => ({ ...prev, lockRequestInProgress: true }));
    
    try {
      await onLockRequest(cellId);
    } finally {
      setState(prev => ({ ...prev, lockRequestInProgress: false }));
    }
  }, [cellId, isLocked, onLockRequest, state.lockRequestInProgress]);

  // Memoized lock release handler
  const handleLockRelease = useCallback(async () => {
    if (state.lockReleaseInProgress || !isLocked) {
      return;
    }

    setState(prev => ({ ...prev, lockReleaseInProgress: true }));
    
    try {
      await onLockRelease(cellId);
    } finally {
      setState(prev => ({ ...prev, lockReleaseInProgress: false }));
    }
  }, [cellId, isLocked, onLockRelease, state.lockReleaseInProgress]);

  // Memoized time remaining calculation
  const timeRemainingFormatted = useMemo(() => {
    if (!isLocked || !lockTimeout) {
      return '';
    }

    const remaining = Math.max(0, lockTimeout - Date.now());
    return Time.formatHuman(new Date(remaining));
  }, [isLocked, lockTimeout]);

  // Memoized lock indicator styles
  const lockIndicatorStyles = useMemo(() => {
    if (!isLocked || !visualSettings.enableVisualIndicators) {
      return {};
    }

    return {
      backgroundColor: visualSettings.lockIndicatorColor,
      opacity: visualSettings.lockIndicatorOpacity,
      borderWidth: `${visualSettings.lockBorderWidth}px`,
      borderStyle: visualSettings.lockBorderStyle,
      borderColor: visualSettings.lockIndicatorColor
    };
  }, [isLocked, visualSettings]);

  // Don't render if visual indicators are disabled
  if (!visualSettings.enableVisualIndicators) {
    return null;
  }

  return (
    <div className="jp-CellLockIndicator-container">
      {/* Lock status indicator */}
      {isLocked && (
        <div 
          className="jp-CellLockIndicator-status"
          style={lockIndicatorStyles}
          title={trans.__('Cell is locked by %1', lockOwner || 'Unknown user')}
        >
          <div className="jp-CellLockIndicator-icon">
            <userIcon.react 
              className="jp-CellLockIndicator-userIcon"
              width="16px"
              height="16px"
            />
          </div>
          
          <div className="jp-CellLockIndicator-info">
            <div className="jp-CellLockIndicator-owner">
              {lockOwner || trans.__('Unknown user')}
            </div>
            
            {timeRemainingFormatted && (
              <div className="jp-CellLockIndicator-timeout">
                {trans.__('Expires in %1', timeRemainingFormatted)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Lock controls */}
      <div className="jp-CellLockIndicator-controls">
        {!isLocked && state.canAcquireLock && (
          <button
            className="jp-CellLockIndicator-lockButton"
            onClick={handleLockRequest}
            disabled={state.lockRequestInProgress}
            title={trans.__('Acquire exclusive lock for this cell')}
          >
            {state.lockRequestInProgress ? (
              <span className="jp-CellLockIndicator-spinner" />
            ) : (
              trans.__('Lock Cell')
            )}
          </button>
        )}

        {isLocked && state.canReleaseLock && (
          <button
            className="jp-CellLockIndicator-unlockButton"
            onClick={handleLockRelease}
            disabled={state.lockReleaseInProgress}
            title={trans.__('Release lock for this cell')}
          >
            {state.lockReleaseInProgress ? (
              <span className="jp-CellLockIndicator-spinner" />
            ) : (
              trans.__('Unlock Cell')
            )}
          </button>
        )}
      </div>

      {/* Lock conflict indicator */}
      {isLocked && !state.canReleaseLock && (
        <div className="jp-CellLockIndicator-conflict">
          <div className="jp-CellLockIndicator-conflictIcon">⚠️</div>
          <div className="jp-CellLockIndicator-conflictMessage">
            {trans.__('Cell is locked by another user')}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * CSS styles for the cell lock indicator component
 */
const CSS_STYLES = `
.jp-CellLockIndicator-container {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--jp-layout-color1);
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  font-size: var(--jp-ui-font-size1);
  line-height: var(--jp-ui-font-size1);
}

.jp-CellLockIndicator-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(255, 107, 107, 0.1);
  border: 1px solid rgba(255, 107, 107, 0.3);
}

.jp-CellLockIndicator-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.jp-CellLockIndicator-userIcon {
  color: var(--jp-ui-font-color1);
}

.jp-CellLockIndicator-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.jp-CellLockIndicator-owner {
  font-weight: 600;
  color: var(--jp-ui-font-color1);
  font-size: var(--jp-ui-font-size0);
}

.jp-CellLockIndicator-timeout {
  color: var(--jp-ui-font-color2);
  font-size: var(--jp-ui-font-size0);
}

.jp-CellLockIndicator-controls {
  display: flex;
  gap: 4px;
}

.jp-CellLockIndicator-lockButton,
.jp-CellLockIndicator-unlockButton {
  padding: 4px 8px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 3px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  cursor: pointer;
  font-size: var(--jp-ui-font-size0);
  transition: all 0.2s ease;
}

.jp-CellLockIndicator-lockButton:hover,
.jp-CellLockIndicator-unlockButton:hover {
  background: var(--jp-layout-color2);
  border-color: var(--jp-brand-color1);
}

.jp-CellLockIndicator-lockButton:disabled,
.jp-CellLockIndicator-unlockButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.jp-CellLockIndicator-lockButton {
  background: var(--jp-brand-color1);
  color: var(--jp-ui-inverse-font-color1);
  border-color: var(--jp-brand-color1);
}

.jp-CellLockIndicator-unlockButton {
  background: var(--jp-warn-color1);
  color: var(--jp-ui-inverse-font-color1);
  border-color: var(--jp-warn-color1);
}

.jp-CellLockIndicator-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid transparent;
  border-top: 2px solid currentColor;
  border-radius: 50%;
  animation: jp-CellLockIndicator-spin 1s linear infinite;
}

@keyframes jp-CellLockIndicator-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.jp-CellLockIndicator-conflict {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: rgba(255, 193, 7, 0.1);
  border: 1px solid rgba(255, 193, 7, 0.3);
  border-radius: 3px;
}

.jp-CellLockIndicator-conflictIcon {
  font-size: 12px;
}

.jp-CellLockIndicator-conflictMessage {
  font-size: var(--jp-ui-font-size0);
  color: var(--jp-warn-color1);
}

.jp-CellLockIndicator-hidden {
  display: none;
}

.jp-CellLockIndicator-visible {
  display: flex;
}
`;

// Inject CSS styles
const style = document.createElement('style');
style.textContent = CSS_STYLES;
document.head.appendChild(style);

// Export the component and interface
export { CellLockIndicator, ICellLockIndicatorProps };