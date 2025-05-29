import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import React, { useEffect, useState, useCallback, useRef } from 'react';

/**
 * Interface for cell lock information
 */
export interface ICellLock {
  cellId: string;
  userId: string;
  userName: string;
  userColor: string;
  clientId: number;
  timestamp: number;
  lockType: 'edit' | 'view' | 'exclusive';
  expiresAt?: number;
  sessionId?: string;
}

/**
 * Interface for lock conflict information
 */
export interface ILockConflict {
  cellId: string;
  requestingUser: {
    userId: string;
    userName: string;
    clientId: number;
  };
  currentLock: ICellLock;
  conflictType: 'simultaneous_request' | 'timeout_override' | 'permission_override';
  timestamp: number;
}

/**
 * Interface for lock request
 */
export interface ILockRequest {
  cellId: string;
  lockType: 'edit' | 'view' | 'exclusive';
  force?: boolean;
  timeout?: number;
}

/**
 * Interface for YjsNotebookProvider lock methods (placeholder - will be provided by the collaboration module)
 */
export interface IYjsNotebookProvider {
  locks: {
    // Y.Map<string, ICellLock> equivalent
    getAll(): Map<string, ICellLock>;
    getLock(cellId: string): ICellLock | null;
    requestLock(request: ILockRequest): Promise<boolean>;
    releaseLock(cellId: string): Promise<boolean>;
    on(event: 'lockChanged' | 'lockConflict' | 'lockTimeout', handler: (data: any) => void): void;
    off(event: 'lockChanged' | 'lockConflict' | 'lockTimeout', handler: (data: any) => void): void;
    isLockExpired(lock: ICellLock): boolean;
    canOverrideLock(cellId: string): boolean;
    currentUserId: string;
    currentUserName: string;
    clientId: number;
  };
  isConnected: boolean;
}

/**
 * Props for the CellLockIndicator component
 */
export interface ICellLockIndicatorProps {
  provider: IYjsNotebookProvider;
  translator: ITranslator;
  cellId: string;
  isActive?: boolean;
  onLockAcquired?: (cellId: string, lock: ICellLock) => void;
  onLockReleased?: (cellId: string) => void;
  onConflictResolved?: (cellId: string, resolution: 'override' | 'wait' | 'cancel') => void;
}

/**
 * Generate a deterministic color for a user
 */
const getUserColor = (userId: string): string => {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F8C471', '#82E0AA', '#F1948A', '#85C1E9', '#D2B4DE'
  ];
  
  const hash = userId.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  
  return colors[Math.abs(hash) % colors.length];
};

/**
 * Format lock duration as human-readable text
 */
const formatLockDuration = (timestamp: number, translator: ITranslator): string => {
  const trans = translator.load('notebook');
  const now = Date.now();
  const duration = now - timestamp;
  
  if (duration < 60000) { // Less than 1 minute
    return trans.__('Just now');
  } else if (duration < 3600000) { // Less than 1 hour
    const minutes = Math.floor(duration / 60000);
    return trans.__('%1 minute(s) ago', minutes);
  } else {
    const hours = Math.floor(duration / 3600000);
    return trans.__('%1 hour(s) ago', hours);
  }
};

/**
 * Format lock expiration time
 */
const formatLockExpiration = (expiresAt: number, translator: ITranslator): string => {
  const trans = translator.load('notebook');
  const now = Date.now();
  const timeLeft = expiresAt - now;
  
  if (timeLeft <= 0) {
    return trans.__('Expired');
  } else if (timeLeft < 60000) {
    return trans.__('Expires in %1s', Math.ceil(timeLeft / 1000));
  } else if (timeLeft < 3600000) {
    return trans.__('Expires in %1m', Math.ceil(timeLeft / 60000));
  } else {
    return trans.__('Expires in %1h', Math.ceil(timeLeft / 3600000));
  }
};

/**
 * Conflict resolution dialog component
 */
const ConflictResolutionDialog: React.FC<{
  conflict: ILockConflict;
  translator: ITranslator;
  onResolve: (resolution: 'override' | 'wait' | 'cancel') => void;
  onClose: () => void;
}> = ({ conflict, translator, onResolve, onClose }) => {
  const trans = translator.load('notebook');
  const [countdown, setCountdown] = useState(30); // 30 second countdown for auto-cancel
  
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          onResolve('cancel');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    
    return () => clearInterval(timer);
  }, [onResolve]);
  
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      onResolve('cancel');
    }
  }, [onResolve]);
  
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
  
  return (
    <div 
      className="jp-Collab-ConflictDialog-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div 
        className="jp-Collab-ConflictDialog"
        style={{
          backgroundColor: 'var(--jp-layout-color0)',
          border: '1px solid var(--jp-border-color1)',
          borderRadius: '6px',
          padding: '24px',
          maxWidth: '500px',
          minWidth: '400px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
          animation: 'jp-Collab-slideIn 0.2s ease-out'
        }}
      >
        {/* Dialog header */}
        <div className="jp-Collab-ConflictDialog-header" style={{ marginBottom: '16px' }}>
          <h3 style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: '600',
            color: 'var(--jp-ui-font-color0)',
            display: 'flex',
            alignItems: 'center'
          }}>
            <span style={{ marginRight: '8px', fontSize: '18px' }}>⚠️</span>
            {trans.__('Cell Lock Conflict')}
          </h3>
        </div>
        
        {/* Conflict details */}
        <div className="jp-Collab-ConflictDialog-content" style={{ marginBottom: '20px' }}>
          <p style={{
            margin: '0 0 12px 0',
            color: 'var(--jp-ui-font-color1)',
            lineHeight: '1.5'
          }}>
            {trans.__('The cell you\'re trying to edit is currently locked by another user:')}
          </p>
          
          <div style={{
            backgroundColor: 'var(--jp-layout-color1)',
            border: '1px solid var(--jp-border-color2)',
            borderRadius: '4px',
            padding: '12px',
            marginBottom: '12px'
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: '8px'
            }}>
              <div 
                style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  backgroundColor: conflict.currentLock.userColor,
                  marginRight: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  fontSize: '10px',
                  fontWeight: 'bold'
                }}
              >
                {conflict.currentLock.userName.charAt(0).toUpperCase()}
              </div>
              <span style={{ fontWeight: '500', color: 'var(--jp-ui-font-color0)' }}>
                {conflict.currentLock.userName}
              </span>
            </div>
            
            <div style={{ fontSize: '12px', color: 'var(--jp-ui-font-color2)' }}>
              <div>{trans.__('Lock type')}: {conflict.currentLock.lockType}</div>
              <div>{trans.__('Locked')}: {formatLockDuration(conflict.currentLock.timestamp, translator)}</div>
              {conflict.currentLock.expiresAt && (
                <div>{formatLockExpiration(conflict.currentLock.expiresAt, translator)}</div>
              )}
            </div>
          </div>
          
          <p style={{
            margin: '0 0 8px 0',
            color: 'var(--jp-ui-font-color1)',
            fontSize: '14px'
          }}>
            {trans.__('How would you like to proceed?')}
          </p>
          
          <div style={{
            fontSize: '12px',
            color: 'var(--jp-ui-font-color2)',
            fontStyle: 'italic'
          }}>
            {trans.__('This dialog will automatically close in %1 seconds', countdown)}
          </div>
        </div>
        
        {/* Action buttons */}
        <div className="jp-Collab-ConflictDialog-actions" style={{
          display: 'flex',
          gap: '8px',
          justifyContent: 'flex-end'
        }}>
          <button
            className="jp-Collab-Button jp-Collab-Button-secondary"
            onClick={() => onResolve('cancel')}
            style={{
              background: 'var(--jp-layout-color2)',
              border: '1px solid var(--jp-border-color1)',
              borderRadius: '4px',
              padding: '8px 16px',
              fontSize: '13px',
              cursor: 'pointer',
              color: 'var(--jp-ui-font-color1)'
            }}
          >
            {trans.__('Cancel')}
          </button>
          
          <button
            className="jp-Collab-Button jp-Collab-Button-wait"
            onClick={() => onResolve('wait')}
            style={{
              background: 'var(--jp-brand-color1)',
              border: '1px solid var(--jp-brand-color1)',
              borderRadius: '4px',
              padding: '8px 16px',
              fontSize: '13px',
              cursor: 'pointer',
              color: 'white'
            }}
          >
            {trans.__('Wait for unlock')}
          </button>
          
          <button
            className="jp-Collab-Button jp-Collab-Button-override"
            onClick={() => onResolve('override')}
            style={{
              background: 'var(--jp-warn-color1)',
              border: '1px solid var(--jp-warn-color1)',
              borderRadius: '4px',
              padding: '8px 16px',
              fontSize: '13px',
              cursor: 'pointer',
              color: 'white'
            }}
          >
            {trans.__('Override lock')}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Lock indicator component for displaying lock status
 */
const LockIndicator: React.FC<{
  lock: ICellLock;
  isOwnLock: boolean;
  translator: ITranslator;
  onRelease?: () => void;
  onForceUnlock?: () => void;
}> = ({ lock, isOwnLock, translator, onRelease, onForceUnlock }) => {
  const trans = translator.load('notebook');
  const [showTooltip, setShowTooltip] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  
  // Update time left for expiring locks
  useEffect(() => {
    if (!lock.expiresAt) return;
    
    const updateTimer = () => {
      const remaining = lock.expiresAt! - Date.now();
      setTimeLeft(remaining > 0 ? remaining : 0);
    };
    
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    
    return () => clearInterval(interval);
  }, [lock.expiresAt]);
  
  const isExpired = lock.expiresAt && Date.now() > lock.expiresAt;
  const lockIcon = isOwnLock ? '🔒' : (lock.lockType === 'exclusive' ? '🔐' : '👁️');
  const lockColor = isOwnLock ? '#28a745' : (isExpired ? '#dc3545' : lock.userColor);
  
  return (
    <div
      className={`jp-Collab-LockIndicator ${isOwnLock ? 'own-lock' : 'other-lock'} ${isExpired ? 'expired' : ''}`}
      style={{
        position: 'absolute',
        top: '4px',
        right: '4px',
        background: lockColor,
        color: 'white',
        borderRadius: '12px',
        padding: '2px 8px',
        fontSize: '11px',
        fontWeight: 'bold',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        cursor: 'pointer',
        zIndex: 1000,
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
        transition: 'all 0.2s ease',
        animation: isExpired ? 'jp-Collab-blink 1s infinite' : 'none'
      }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (isOwnLock && onRelease) {
          onRelease();
        }
      }}
    >
      <span>{lockIcon}</span>
      <span className="jp-Collab-LockIndicator-text">
        {isOwnLock ? trans.__('You') : lock.userName}
      </span>
      
      {/* Tooltip */}
      {showTooltip && (
        <div
          className="jp-Collab-LockIndicator-tooltip"
          style={{
            position: 'absolute',
            bottom: '100%',
            right: '0',
            marginBottom: '8px',
            background: 'var(--jp-layout-color0)',
            border: '1px solid var(--jp-border-color1)',
            borderRadius: '4px',
            padding: '8px 12px',
            fontSize: '12px',
            color: 'var(--jp-ui-font-color1)',
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            zIndex: 1001,
            animation: 'jp-Collab-fadeIn 0.2s ease'
          }}
        >
          <div style={{ fontWeight: '500', marginBottom: '4px' }}>
            {isOwnLock ? trans.__('Your lock') : trans.__('Locked by %1', lock.userName)}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--jp-ui-font-color2)' }}>
            <div>{trans.__('Type')}: {lock.lockType}</div>
            <div>{trans.__('Since')}: {formatLockDuration(lock.timestamp, translator)}</div>
            {timeLeft !== null && (
              <div style={{ color: timeLeft < 60000 ? '#dc3545' : 'inherit' }}>
                {timeLeft > 0 ? 
                  trans.__('Expires in %1s', Math.ceil(timeLeft / 1000)) : 
                  trans.__('Expired')
                }
              </div>
            )}
          </div>
          
          {isOwnLock && (
            <div style={{
              marginTop: '8px',
              fontSize: '11px',
              fontStyle: 'italic',
              color: 'var(--jp-ui-font-color2)'
            }}>
              {trans.__('Click to release')}
            </div>
          )}
          
          {!isOwnLock && onForceUnlock && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onForceUnlock();
              }}
              style={{
                marginTop: '8px',
                background: 'var(--jp-warn-color1)',
                border: 'none',
                borderRadius: '3px',
                padding: '4px 8px',
                fontSize: '10px',
                color: 'white',
                cursor: 'pointer'
              }}
            >
              {trans.__('Force unlock')}
            </button>
          )}
          
          {/* Tooltip arrow */}
          <div
            style={{
              position: 'absolute',
              top: '100%',
              right: '12px',
              width: 0,
              height: 0,
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: '6px solid var(--jp-layout-color0)'
            }}
          />
        </div>
      )}
    </div>
  );
};

/**
 * React component for cell lock visualization and management
 */
const CellLockIndicatorComponent: React.FC<ICellLockIndicatorProps> = ({
  provider,
  translator,
  cellId,
  isActive = false,
  onLockAcquired,
  onLockReleased,
  onConflictResolved
}) => {
  const trans = translator.load('notebook');
  const [cellLock, setCellLock] = useState<ICellLock | null>(null);
  const [isLocking, setIsLocking] = useState(false);
  const [conflict, setConflict] = useState<ILockConflict | null>(null);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Get current lock state for this cell
  useEffect(() => {
    const updateLockState = () => {
      const lock = provider.locks.getLock(cellId);
      setCellLock(lock);
      
      // Check for expired locks
      if (lock && provider.locks.isLockExpired(lock)) {
        // Auto-release expired locks
        provider.locks.releaseLock(cellId).catch(console.error);
      }
    };
    
    updateLockState();
    
    // Subscribe to lock changes
    const handleLockChanged = (data: { cellId: string; lock: ICellLock | null }) => {
      if (data.cellId === cellId) {
        setCellLock(data.lock);
        
        if (data.lock && onLockAcquired) {
          onLockAcquired(cellId, data.lock);
        } else if (!data.lock && onLockReleased) {
          onLockReleased(cellId);
        }
      }
    };
    
    const handleLockConflict = (conflictData: ILockConflict) => {
      if (conflictData.cellId === cellId) {
        setConflict(conflictData);
        setShowConflictDialog(true);
      }
    };
    
    const handleLockTimeout = (timeoutData: { cellId: string; lock: ICellLock }) => {
      if (timeoutData.cellId === cellId) {
        // Handle lock timeout - could show notification or auto-release
        console.log('Lock timeout for cell:', cellId, timeoutData.lock);
      }
    };
    
    provider.locks.on('lockChanged', handleLockChanged);
    provider.locks.on('lockConflict', handleLockConflict);
    provider.locks.on('lockTimeout', handleLockTimeout);
    
    return () => {
      provider.locks.off('lockChanged', handleLockChanged);
      provider.locks.off('lockConflict', handleLockConflict);
      provider.locks.off('lockTimeout', handleLockTimeout);
    };
  }, [cellId, provider.locks, onLockAcquired, onLockReleased]);
  
  // Automatic lock acquisition when cell becomes active
  useEffect(() => {
    if (isActive && !cellLock && provider.isConnected) {
      // Small delay to prevent rapid lock/unlock cycles
      timeoutRef.current = setTimeout(() => {
        requestCellLock('edit');
      }, 100);
    } else if (!isActive && cellLock && cellLock.userId === provider.locks.currentUserId) {
      // Release lock when cell becomes inactive
      timeoutRef.current = setTimeout(() => {
        releaseCellLock();
      }, 2000); // 2 second delay to avoid rapid release
    }
    
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isActive, cellLock, provider.isConnected, provider.locks.currentUserId]);
  
  // Request lock for the cell
  const requestCellLock = useCallback(async (lockType: 'edit' | 'view' | 'exclusive' = 'edit') => {
    if (isLocking || (cellLock && cellLock.userId === provider.locks.currentUserId)) {
      return;
    }
    
    setIsLocking(true);
    
    try {
      const request: ILockRequest = {
        cellId,
        lockType,
        timeout: 300000 // 5 minutes default timeout
      };
      
      const success = await provider.locks.requestLock(request);
      
      if (!success) {
        // Lock request failed - might trigger conflict dialog
        console.log('Lock request failed for cell:', cellId);
      }
    } catch (error) {
      console.error('Error requesting lock:', error);
    } finally {
      setIsLocking(false);
    }
  }, [cellId, cellLock, isLocking, provider.locks]);
  
  // Release lock for the cell
  const releaseCellLock = useCallback(async () => {
    if (!cellLock || cellLock.userId !== provider.locks.currentUserId) {
      return;
    }
    
    try {
      await provider.locks.releaseLock(cellId);
    } catch (error) {
      console.error('Error releasing lock:', error);
    }
  }, [cellId, cellLock, provider.locks]);
  
  // Force unlock (override another user's lock)
  const forceUnlockCell = useCallback(async () => {
    if (!cellLock || !provider.locks.canOverrideLock(cellId)) {
      return;
    }
    
    try {
      const request: ILockRequest = {
        cellId,
        lockType: 'edit',
        force: true
      };
      
      await provider.locks.requestLock(request);
    } catch (error) {
      console.error('Error forcing unlock:', error);
    }
  }, [cellId, cellLock, provider.locks]);
  
  // Handle conflict resolution
  const handleConflictResolution = useCallback(async (resolution: 'override' | 'wait' | 'cancel') => {
    setShowConflictDialog(false);
    
    if (onConflictResolved) {
      onConflictResolved(cellId, resolution);
    }
    
    switch (resolution) {
      case 'override':
        if (conflict && provider.locks.canOverrideLock(cellId)) {
          await forceUnlockCell();
        }
        break;
      case 'wait':
        // Set up polling to check when lock is released
        const pollInterval = setInterval(() => {
          const currentLock = provider.locks.getLock(cellId);
          if (!currentLock) {
            clearInterval(pollInterval);
            requestCellLock('edit');
          }
        }, 1000);
        
        // Clear polling after 5 minutes
        setTimeout(() => clearInterval(pollInterval), 300000);
        break;
      case 'cancel':
        // Do nothing - user cancelled the request
        break;
    }
    
    setConflict(null);
  }, [cellId, conflict, forceUnlockCell, onConflictResolved, provider.locks, requestCellLock]);
  
  const isOwnLock = cellLock && cellLock.userId === provider.locks.currentUserId;
  const canOverride = cellLock && !isOwnLock && provider.locks.canOverrideLock(cellId);
  
  return (
    <div className="jp-Collab-CellLockIndicator" data-cell-id={cellId}>
      {/* Lock indicator */}
      {cellLock && (
        <LockIndicator
          lock={cellLock}
          isOwnLock={!!isOwnLock}
          translator={translator}
          onRelease={isOwnLock ? releaseCellLock : undefined}
          onForceUnlock={canOverride ? forceUnlockCell : undefined}
        />
      )}
      
      {/* Lock acquisition button for unlocked cells */}
      {!cellLock && isActive && provider.isConnected && (
        <button
          className="jp-Collab-LockButton"
          onClick={() => requestCellLock('edit')}
          disabled={isLocking}
          style={{
            position: 'absolute',
            top: '4px',
            right: '4px',
            background: 'var(--jp-layout-color2)',
            border: '1px solid var(--jp-border-color1)',
            borderRadius: '4px',
            padding: '4px 8px',
            fontSize: '11px',
            cursor: isLocking ? 'not-allowed' : 'pointer',
            color: 'var(--jp-ui-font-color1)',
            zIndex: 1000,
            opacity: isLocking ? 0.6 : 1,
            transition: 'all 0.2s ease'
          }}
          title={trans.__('Click to lock cell for editing')}
        >
          {isLocking ? '⏳' : '🔓'} {isLocking ? trans.__('Locking...') : trans.__('Lock')}
        </button>
      )}
      
      {/* Conflict resolution dialog */}
      {showConflictDialog && conflict && (
        <ConflictResolutionDialog
          conflict={conflict}
          translator={translator}
          onResolve={handleConflictResolution}
          onClose={() => setShowConflictDialog(false)}
        />
      )}
    </div>
  );
};

/**
 * CSS styles for CellLockIndicator animations and theming
 */
const LOCK_INDICATOR_STYLES = `
  @keyframes jp-Collab-slideIn {
    from { 
      opacity: 0; 
      transform: translate(-50%, -50%) scale(0.9); 
    }
    to { 
      opacity: 1; 
      transform: translate(-50%, -50%) scale(1); 
    }
  }
  
  @keyframes jp-Collab-fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  
  @keyframes jp-Collab-blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0.5; }
  }
  
  .jp-Collab-CellLockIndicator {
    position: relative;
    pointer-events: none;
  }
  
  .jp-Collab-CellLockIndicator .jp-Collab-LockIndicator,
  .jp-Collab-CellLockIndicator .jp-Collab-LockButton {
    pointer-events: auto;
  }
  
  .jp-Collab-LockIndicator:hover {
    transform: scale(1.05);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
  }
  
  .jp-Collab-LockIndicator.own-lock {
    border: 2px solid rgba(40, 167, 69, 0.3);
  }
  
  .jp-Collab-LockIndicator.other-lock {
    border: 2px solid rgba(255, 107, 107, 0.3);
  }
  
  .jp-Collab-LockIndicator.expired {
    border-color: #dc3545 !important;
    background: #dc3545 !important;
  }
  
  .jp-Collab-ConflictDialog-overlay {
    font-family: var(--jp-ui-font-family);
  }
  
  .jp-Collab-Button:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }
  
  .jp-Collab-Button:active {
    transform: translateY(0);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }
  
  .jp-Collab-Button-override:hover {
    background: #e0a800 !important;
    border-color: #e0a800 !important;
  }
  
  .jp-Collab-LockButton:hover {
    background: var(--jp-layout-color3) !important;
    border-color: var(--jp-border-color2) !important;
  }
  
  /* Responsive design for mobile */
  @media (max-width: 768px) {
    .jp-Collab-ConflictDialog {
      margin: 16px;
      min-width: auto !important;
      max-width: calc(100vw - 32px) !important;
    }
    
    .jp-Collab-ConflictDialog-actions {
      flex-direction: column;
      gap: 8px;
    }
    
    .jp-Collab-LockIndicator-tooltip {
      right: auto !important;
      left: 0 !important;
      transform: translateX(-50%);
    }
  }
  
  /* Integration with notebook cell overlay system */
  .jp-Cell[data-jp-collab-locked="true"] {
    border: 2px solid var(--jp-warn-color1);
    background: rgba(255, 235, 59, 0.1);
  }
  
  .jp-Cell[data-jp-collab-locked="own"] {
    border: 2px solid var(--jp-success-color1);
    background: rgba(76, 175, 80, 0.1);
  }
  
  .jp-Cell[data-jp-collab-readonly="true"] {
    opacity: 0.7;
    pointer-events: none;
  }
  
  .jp-Cell[data-jp-collab-readonly="true"] .jp-Cell-inputWrapper {
    background: var(--jp-layout-color2);
  }
`;

/**
 * Inject CSS styles for CellLockIndicator component
 */
const injectLockIndicatorStyles = (): void => {
  const styleId = 'jp-collab-cell-lock-indicator-styles';
  
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = LOCK_INDICATOR_STYLES;
    document.head.appendChild(style);
  }
};

/**
 * Namespace for CellLockIndicator component utilities and integrations
 */
export namespace CellLockIndicator {
  /**
   * Configuration options for CellLockIndicator
   */
  export interface ILockIndicatorOptions {
    provider: IYjsNotebookProvider;
    translator: ITranslator;
    cellId: string;
    isActive?: boolean;
    autoLock?: boolean;
    lockTimeout?: number;
    onLockAcquired?: (cellId: string, lock: ICellLock) => void;
    onLockReleased?: (cellId: string) => void;
    onConflictResolved?: (cellId: string, resolution: 'override' | 'wait' | 'cancel') => void;
  }
  
  /**
   * Create a new CellLockIndicator widget
   * 
   * @param options - Configuration options for the cell lock indicator
   */
  export const create = (options: ILockIndicatorOptions): ReactWidget => {
    // Inject CSS styles when creating the widget
    injectLockIndicatorStyles();
    
    const widget = ReactWidget.create(
      <CellLockIndicatorComponent {...options} />
    );
    
    // Add CSS classes for theming and cell overlay integration
    widget.addClass('jp-Collab-CellLockIndicatorWidget');
    widget.node.setAttribute('data-jp-theme-schematic', 'true');
    widget.node.setAttribute('data-cell-id', options.cellId);
    
    return widget;
  };
  
  /**
   * Request lock for a specific cell
   * 
   * @param provider - The Yjs notebook provider
   * @param cellId - The cell ID to lock
   * @param lockType - Type of lock to request
   */
  export const requestLock = async (
    provider: IYjsNotebookProvider,
    cellId: string,
    lockType: 'edit' | 'view' | 'exclusive' = 'edit'
  ): Promise<boolean> => {
    try {
      return await provider.locks.requestLock({
        cellId,
        lockType,
        timeout: 300000 // 5 minutes default
      });
    } catch (error) {
      console.error('Error requesting lock:', error);
      return false;
    }
  };
  
  /**
   * Release lock for a specific cell
   * 
   * @param provider - The Yjs notebook provider
   * @param cellId - The cell ID to unlock
   */
  export const releaseLock = async (
    provider: IYjsNotebookProvider,
    cellId: string
  ): Promise<boolean> => {
    try {
      return await provider.locks.releaseLock(cellId);
    } catch (error) {
      console.error('Error releasing lock:', error);
      return false;
    }
  };
  
  /**
   * Get all locked cells from the provider
   * 
   * @param provider - The Yjs notebook provider
   * @returns Map of cell IDs to their lock information
   */
  export const getAllLocks = (provider: IYjsNotebookProvider): Map<string, ICellLock> => {
    return provider.locks.getAll();
  };
  
  /**
   * Check if a cell is locked by the current user
   * 
   * @param provider - The Yjs notebook provider
   * @param cellId - The cell ID to check
   * @returns True if locked by current user, false otherwise
   */
  export const isOwnLock = (provider: IYjsNotebookProvider, cellId: string): boolean => {
    const lock = provider.locks.getLock(cellId);
    return lock ? lock.userId === provider.locks.currentUserId : false;
  };
  
  /**
   * Check if a cell is locked by another user
   * 
   * @param provider - The Yjs notebook provider
   * @param cellId - The cell ID to check
   * @returns True if locked by another user, false otherwise
   */
  export const isLockedByOther = (provider: IYjsNotebookProvider, cellId: string): boolean => {
    const lock = provider.locks.getLock(cellId);
    return lock ? lock.userId !== provider.locks.currentUserId : false;
  };
  
  /**
   * Force unlock a cell (override another user's lock)
   * 
   * @param provider - The Yjs notebook provider
   * @param cellId - The cell ID to force unlock
   */
  export const forceUnlock = async (
    provider: IYjsNotebookProvider,
    cellId: string
  ): Promise<boolean> => {
    if (!provider.locks.canOverrideLock(cellId)) {
      return false;
    }
    
    try {
      return await provider.locks.requestLock({
        cellId,
        lockType: 'edit',
        force: true
      });
    } catch (error) {
      console.error('Error forcing unlock:', error);
      return false;
    }
  };
  
  /**
   * Apply cell lock styling to a notebook cell element
   * 
   * @param cellElement - The cell DOM element
   * @param lock - The lock information (null if unlocked)
   * @param isCurrentUser - Whether the lock belongs to the current user
   */
  export const applyCellLockStyling = (
    cellElement: Element,
    lock: ICellLock | null,
    isCurrentUser: boolean
  ): void => {
    // Remove existing lock attributes
    cellElement.removeAttribute('data-jp-collab-locked');
    cellElement.removeAttribute('data-jp-collab-readonly');
    
    if (lock) {
      if (isCurrentUser) {
        cellElement.setAttribute('data-jp-collab-locked', 'own');
      } else {
        cellElement.setAttribute('data-jp-collab-locked', 'true');
        cellElement.setAttribute('data-jp-collab-readonly', 'true');
      }
    }
  };
  
  /**
   * Setup automatic lock management for a notebook cell
   * 
   * @param provider - The Yjs notebook provider
   * @param cellElement - The cell DOM element
   * @param cellId - The cell ID
   * @param options - Configuration options
   */
  export const setupAutomaticLocking = (
    provider: IYjsNotebookProvider,
    cellElement: Element,
    cellId: string,
    options: {
      autoLock?: boolean;
      lockOnFocus?: boolean;
      unlockOnBlur?: boolean;
      lockTimeout?: number;
    } = {}
  ): () => void => {
    const {
      autoLock = true,
      lockOnFocus = true,
      unlockOnBlur = true,
      lockTimeout = 300000
    } = options;
    
    let lockTimeoutHandle: NodeJS.Timeout | null = null;
    
    const handleFocus = async () => {
      if (lockOnFocus && autoLock) {
        await requestLock(provider, cellId, 'edit');
      }
    };
    
    const handleBlur = async () => {
      if (unlockOnBlur && autoLock) {
        // Delay unlock to prevent rapid lock/unlock cycles
        lockTimeoutHandle = setTimeout(async () => {
          if (isOwnLock(provider, cellId)) {
            await releaseLock(provider, cellId);
          }
        }, 2000);
      }
    };
    
    const handleInput = () => {
      // Cancel any pending unlock when user starts typing
      if (lockTimeoutHandle) {
        clearTimeout(lockTimeoutHandle);
        lockTimeoutHandle = null;
      }
    };
    
    // Add event listeners
    cellElement.addEventListener('focusin', handleFocus);
    cellElement.addEventListener('focusout', handleBlur);
    cellElement.addEventListener('input', handleInput);
    
    // Cleanup function
    return () => {
      cellElement.removeEventListener('focusin', handleFocus);
      cellElement.removeEventListener('focusout', handleBlur);
      cellElement.removeEventListener('input', handleInput);
      
      if (lockTimeoutHandle) {
        clearTimeout(lockTimeoutHandle);
      }
      
      // Release lock on cleanup
      if (isOwnLock(provider, cellId)) {
        releaseLock(provider, cellId).catch(console.error);
      }
    };
  };
}