/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * CellLockIndicator React component providing visual feedback for cell locking
 * in collaborative Jupyter Notebook editing sessions.
 *
 * This component renders lock overlays on cells being edited by other users,
 * displaying lock owner information, countdown timers, and queue status.
 * Integrates with CellLockManager for real-time lock state updates.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { Cell } from '@jupyterlab/cells';
import { ITranslator } from '@jupyterlab/translation';
import { CellLockManager } from '../../../notebook/src/collab/locks';
import { ICellLockStatus } from '../../../notebook/src/tokens';

/**
 * Props interface for the CellLockIndicator component
 */
export interface ICellLockIndicatorProps {
  /**
   * The cell lock manager instance for accessing lock state and subscribing to changes
   */
  lockManager: CellLockManager;

  /**
   * The cell widget instance this indicator is attached to
   */
  cell: Cell;

  /**
   * Translation service for internationalized text
   */
  translator: ITranslator;
}

/**
 * Internal state interface for lock information
 */
interface ILockInfo {
  cellId: string;
  isLocked: boolean;
  lockOwner: string | null;
  lockTime: Date | null;
  timeout: number;
  queuedUsers: string[];
  timeRemaining: number;
}

/**
 * CellLockIndicator React component that displays lock status overlay on cells
 */
export const CellLockIndicator: React.FC<ICellLockIndicatorProps> = ({
  lockManager,
  cell,
  translator
}) => {
  const trans = translator.load('notebook');

  // State for tracking lock information
  const [lockInfo, setLockInfo] = useState<ILockInfo>({
    cellId: cell.model.id,
    isLocked: false,
    lockOwner: null,
    lockTime: null,
    timeout: 30000,
    queuedUsers: [],
    timeRemaining: 0
  });

  // Refs for managing timers
  const countdownTimer = useRef<NodeJS.Timeout | null>(null);
  const pulseAnimationEnabled = useRef<boolean>(false);

  /**
   * Update lock information from ICellLockStatus
   */
  const updateLockInfo = useCallback((status: ICellLockStatus | null) => {
    if (!status) {
      setLockInfo(prev => ({
        ...prev,
        isLocked: false,
        lockOwner: null,
        lockTime: null,
        timeRemaining: 0,
        queuedUsers: []
      }));
      return;
    }

    const timeRemaining = status.lockTime && status.isLocked
      ? Math.max(0, status.timeout - (Date.now() - status.lockTime.getTime()))
      : 0;

    setLockInfo({
      cellId: status.cellId,
      isLocked: status.isLocked,
      lockOwner: status.lockedBy,
      lockTime: status.lockTime,
      timeout: status.timeout,
      queuedUsers: status.queuedUsers,
      timeRemaining: Math.floor(timeRemaining / 1000) // Convert to seconds
    });
  }, []);

  /**
   * Start countdown timer for lock expiration
   */
  const startCountdownTimer = useCallback(() => {
    if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
    }

    if (!lockInfo.isLocked || !lockInfo.lockTime) {
      return;
    }

    countdownTimer.current = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lockInfo.lockTime!.getTime();
      const remaining = Math.max(0, lockInfo.timeout - elapsed);
      const secondsRemaining = Math.floor(remaining / 1000);

      setLockInfo(prev => ({
        ...prev,
        timeRemaining: secondsRemaining
      }));

      // Enable pulse animation when time is running out
      pulseAnimationEnabled.current = secondsRemaining <= 10;

      // Clear timer when expired
      if (secondsRemaining <= 0 && countdownTimer.current) {
        clearInterval(countdownTimer.current);
        countdownTimer.current = null;
      }
    }, 1000);
  }, [lockInfo.isLocked, lockInfo.lockTime, lockInfo.timeout]);

  /**
   * Handle lock state changes from the lock manager
   */
  const handleLockChange = useCallback((_: CellLockManager, data: { cellId: string; status: ICellLockStatus }) => {
    if (data.cellId === cell.model.id) {
      updateLockInfo(data.status);
    }
  }, [cell.model.id, updateLockInfo]);

  /**
   * Handle click attempts on locked cells
   */
  const handleLockedCellClick = useCallback((event: React.MouseEvent) => {
    if (lockInfo.isLocked) {
      event.preventDefault();
      event.stopPropagation();

      // Create and show temporary tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'jp-CellLockIndicator-tooltip';
      tooltip.textContent = trans.__(`Cell is locked by ${lockInfo.lockOwner}. ${lockInfo.timeRemaining}s remaining.`);
      tooltip.style.cssText = `
        position: fixed;
        top: ${event.clientY + 10}px;
        left: ${event.clientX + 10}px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 10000;
        pointer-events: none;
        animation: fadeInOut 2s ease-in-out forwards;
      `;

      document.body.appendChild(tooltip);

      // Remove tooltip after animation
      setTimeout(() => {
        if (tooltip.parentNode) {
          document.body.removeChild(tooltip);
        }
      }, 2000);
    }
  }, [lockInfo.isLocked, lockInfo.lockOwner, lockInfo.timeRemaining, trans]);

  /**
   * Get user display information for lock owner
   */
  const getUserDisplayInfo = useCallback((userId: string | null) => {
    if (!userId) return null;

    // For now, return basic user info - this could be enhanced with actual user lookup
    return {
      name: userId,
      avatar: `https://api.dicebear.com/6.x/initials/svg?seed=${userId}`,
      color: `hsl(${userId.charCodeAt(0) * 137.508}%, 50%, 50%)`
    };
  }, []);

  // Set up effect for lock state monitoring and timer management
  useEffect(() => {
    if (cell.isDisposed || !lockManager) {
      return;
    }

    let isComponentMounted = true;

    // Async function to handle initial setup
    const setupLockMonitoring = async () => {
      try {
        // Get initial lock status
        const initialStatus = lockManager.lockStatus(cell.model.id);

        if (isComponentMounted) {
          updateLockInfo(initialStatus);
        }

        // Subscribe to lock changes
        lockManager.onLockChange.connect(handleLockChange);

      } catch (error) {
        console.error('Error setting up lock monitoring:', error);
      }
    };

    setupLockMonitoring();

    // Cleanup function
    return () => {
      isComponentMounted = false;

      if (countdownTimer.current) {
        clearInterval(countdownTimer.current);
        countdownTimer.current = null;
      }

      try {
        if (lockManager && lockManager.onLockChange) {
          lockManager.onLockChange.disconnect(handleLockChange);
        }
      } catch (error) {
        console.warn('Error disconnecting from lock manager:', error);
      }
    };
  }, [cell.model.id, cell.isDisposed, lockManager, handleLockChange, updateLockInfo]);

  // Update countdown timer when lock state changes
  useEffect(() => {
    if (lockInfo.isLocked) {
      startCountdownTimer();
    } else if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
  }, [lockInfo.isLocked, startCountdownTimer]);

  // Don't render if cell is disposed or not locked
  if (cell.isDisposed || !lockInfo.isLocked || !lockInfo.lockOwner) {
    return null;
  }

  const userInfo = getUserDisplayInfo(lockInfo.lockOwner);
  const isExpiringSoon = lockInfo.timeRemaining <= 10;

  return (
    <div
      className={`jp-CellLockIndicator ${isExpiringSoon ? 'jp-CellLockIndicator-expiring' : ''}`}
      onClick={handleLockedCellClick}
      role="alert"
      aria-label={trans.__(`Cell locked by ${lockInfo.lockOwner}, ${lockInfo.timeRemaining} seconds remaining`)}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        pointerEvents: 'all',
        transition: 'opacity 0.3s ease-in-out'
      }}
    >
      {/* Lock overlay */}
      <div
        className="jp-CellLockIndicator-overlay"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(255, 255, 255, 0.85)',
          backdropFilter: 'blur(2px)',
          border: `2px solid ${userInfo?.color || '#ff6b6b'}`,
          borderRadius: '4px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          animation: isExpiringSoon ? 'pulse 1s infinite' : undefined
        }}
      >
        {/* Lock icon and user info */}
        <div
          className="jp-CellLockIndicator-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '12px'
          }}
        >
          <div
            className="jp-CellLockIndicator-icon"
            style={{
              fontSize: '24px',
              opacity: 0.8
            }}
          >
            🔒
          </div>

          {userInfo && (
            <div
              className="jp-CellLockIndicator-user"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <img
                src={userInfo.avatar}
                alt={`${userInfo.name} avatar`}
                className="jp-CellLockIndicator-avatar"
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  border: `2px solid ${userInfo.color}`,
                  backgroundColor: 'white'
                }}
                onError={(e) => {
                  // Fallback to initials if image fails
                  const target = e.target as HTMLImageElement;
                  target.style.display = 'none';
                }}
              />
              <span
                className="jp-CellLockIndicator-username"
                style={{
                  fontSize: '14px',
                  fontWeight: 500,
                  color: '#333'
                }}
              >
                {userInfo.name}
              </span>
            </div>
          )}
        </div>

        {/* Countdown timer */}
        <div
          className="jp-CellLockIndicator-timer"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            marginBottom: '8px'
          }}
        >
          <span
            className={`jp-CellLockIndicator-countdown ${isExpiringSoon ? 'jp-CellLockIndicator-countdown-warning' : ''}`}
            style={{
              fontSize: '18px',
              fontWeight: 'bold',
              color: isExpiringSoon ? '#ff4444' : '#666',
              minWidth: '32px',
              textAlign: 'center'
            }}
          >
            {lockInfo.timeRemaining}s
          </span>
          <span
            className="jp-CellLockIndicator-timer-label"
            style={{
              fontSize: '12px',
              color: '#888'
            }}
          >
            {trans.__('remaining')}
          </span>
        </div>

        {/* Queue indicator if users are waiting */}
        {lockInfo.queuedUsers.length > 0 && (
          <div
            className="jp-CellLockIndicator-queue"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
              marginBottom: '8px',
              padding: '6px 8px',
              backgroundColor: 'rgba(255, 193, 7, 0.1)',
              borderRadius: '8px',
              border: '1px solid rgba(255, 193, 7, 0.3)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span
                className="jp-CellLockIndicator-queue-icon"
                style={{ fontSize: '14px' }}
              >
                ⏳
              </span>
              <span
                className="jp-CellLockIndicator-queue-count"
                style={{
                  fontSize: '12px',
                  color: '#856404',
                  fontWeight: 500
                }}
              >
                {lockInfo.queuedUsers.length} {trans.__('waiting')}
              </span>
            </div>

            {/* Show queued users avatars */}
            <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap', maxWidth: '120px' }}>
              {lockInfo.queuedUsers.slice(0, 3).map((userId, index) => {
                const queuedUserInfo = getUserDisplayInfo(userId);
                return (
                  <img
                    key={userId}
                    src={queuedUserInfo?.avatar || `https://api.dicebear.com/6.x/initials/svg?seed=${userId}`}
                    alt={`${userId} avatar`}
                    title={`${userId} (position ${index + 1} in queue)`}
                    style={{
                      width: '16px',
                      height: '16px',
                      borderRadius: '50%',
                      border: `1px solid ${queuedUserInfo?.color || '#ccc'}`,
                      backgroundColor: 'white'
                    }}
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = 'none';
                    }}
                  />
                );
              })}
              {lockInfo.queuedUsers.length > 3 && (
                <div
                  style={{
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    backgroundColor: '#f0f0f0',
                    border: '1px solid #ccc',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '8px',
                    color: '#666'
                  }}
                  title={`${lockInfo.queuedUsers.length - 3} more users waiting`}
                >
                  +{lockInfo.queuedUsers.length - 3}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Warning message */}
        <div
          className="jp-CellLockIndicator-message"
          style={{
            fontSize: '12px',
            color: '#666',
            textAlign: 'center',
            maxWidth: '200px',
            lineHeight: 1.4
          }}
        >
          {trans.__('This cell is being edited by another user')}
        </div>
      </div>

      {/* CSS-in-JS Animation Styles */}
      <style>
        {`
          @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.8; transform: scale(1.02); }
            100% { opacity: 1; transform: scale(1); }
          }

          @keyframes fadeInOut {
            0% { opacity: 0; transform: translateY(10px); }
            20% { opacity: 1; transform: translateY(0); }
            80% { opacity: 1; transform: translateY(0); }
            100% { opacity: 0; transform: translateY(-10px); }
          }

          .jp-CellLockIndicator-expiring .jp-CellLockIndicator-overlay {
            animation: pulse 1s infinite;
          }

          .jp-CellLockIndicator:hover .jp-CellLockIndicator-overlay {
            background-color: rgba(255, 255, 255, 0.95);
            transform: scale(1.01);
          }

          .jp-CellLockIndicator-avatar {
            transition: all 0.2s ease;
          }

          .jp-CellLockIndicator-avatar:hover {
            transform: scale(1.1);
          }

          .jp-CellLockIndicator-overlay {
            transition: all 0.2s ease;
          }

          .jp-CellLockIndicator-queue {
            transition: all 0.2s ease;
          }

          .jp-CellLockIndicator-queue:hover {
            background-color: rgba(255, 193, 7, 0.2);
          }
        `}
      </style>
    </div>
  );
};

/**
 * Namespace containing static methods for creating CellLockIndicator widgets
 */
export namespace CellLockIndicatorComponent {
  /**
   * Create a new CellLockIndicator ReactWidget
   *
   * @param props - Component properties including lockManager, cell, and translator
   * @returns ReactWidget containing the CellLockIndicator component
   */
  export const create = (props: ICellLockIndicatorProps): ReactWidget => {
    return ReactWidget.create(
      <CellLockIndicator {...props} />
    );
  };
}
