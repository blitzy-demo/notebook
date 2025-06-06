/**
 * @fileoverview Visual lock indicators component for collaborative cell editing coordination
 * 
 * This component provides comprehensive visual feedback about cell-level locking status,
 * including lock ownership display, acquisition interfaces, and conflict resolution
 * capabilities. It integrates seamlessly with the Redis-coordinated lock management
 * system to prevent editing conflicts and enable smooth collaborative workflows.
 * 
 * Key Features:
 * - Real-time lock status visualization with user attribution
 * - Interactive lock acquisition and release interfaces
 * - Queue-based conflict resolution with waiting indicators
 * - Timeout management with visual countdown displays
 * - Administrative override capabilities with proper authorization
 * - Accessibility support with ARIA attributes and keyboard navigation
 * - Responsive design adapting to different screen sizes
 * - Integration with awareness system for user presence coordination
 * 
 * Architecture:
 * - React functional component with TypeScript for type safety
 * - Real-time updates via Lumino signals from lock manager
 * - Optimistic UI updates with server-side validation
 * - Error handling with user-friendly notification system
 * - Performance optimization with memo and callback hooks
 * - Modular design supporting different lock visualization modes
 * 
 * @author Jupyter Notebook Collaboration Team
 * @version 7.5.0-alpha.0
 * @since 2024-12-15
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IDisposable } from '@lumino/disposable';
import { JSONObject } from '@lumino/coreutils';

// Import collaboration dependencies
import { 
    LockManager,
    ILockMetadata,
    ILockRequest,
    ILockEvent,
    LockStatus,
    LockPriority,
    LockOperationType,
    LockUtils
} from '../../../notebook/src/collab/locks';
import { 
    CollaborativeAwareness,
    IUserPresence,
    UserActivityStatus,
    AwarenessEventType,
    ICursorPosition
} from '../../../notebook/src/collab/awareness';
import { 
    YjsNotebookProvider,
    SyncState,
    ProviderMode
} from '../../../notebook/src/collab/YjsNotebookProvider';

/**
 * Lock indicator display modes for different visual presentations
 */
export enum LockIndicatorMode {
    /** Compact icon-only display */
    COMPACT = 'compact',
    /** Full display with user info and controls */
    DETAILED = 'detailed',
    /** Inline display within cell toolbar */
    INLINE = 'inline',
    /** Overlay display positioned over cell content */
    OVERLAY = 'overlay'
}

/**
 * Lock indicator visual themes for different UI contexts
 */
export enum LockIndicatorTheme {
    /** Default theme matching notebook UI */
    DEFAULT = 'default',
    /** High contrast theme for accessibility */
    HIGH_CONTRAST = 'high_contrast',
    /** Minimal theme for reduced visual impact */
    MINIMAL = 'minimal',
    /** Dark theme for dark mode compatibility */
    DARK = 'dark'
}

/**
 * Queue entry information for contention display
 */
interface IQueueInfo {
    /** Position in queue (0-based) */
    position: number;
    /** Estimated wait time in milliseconds */
    estimatedWaitMs: number;
    /** Queue entry timestamp */
    queuedAt: number;
    /** User details */
    user: {
        userId: string;
        displayName: string;
        avatar?: string;
    };
}

/**
 * Properties for the CellLockIndicator component
 */
export interface ICellLockIndicatorProps {
    /** Unique cell identifier to monitor for locks */
    cellId: string;
    /** Lock manager instance for coordination */
    lockManager: LockManager;
    /** Awareness system for user presence integration */
    awareness: CollaborativeAwareness;
    /** Yjs provider for collaborative state */
    provider: YjsNotebookProvider;
    /** Current user information */
    currentUser: {
        userId: string;
        displayName: string;
        avatar?: string;
        role?: string;
    };
    /** Display mode for the indicator */
    mode?: LockIndicatorMode;
    /** Visual theme for the indicator */
    theme?: LockIndicatorTheme;
    /** Enable interactive lock controls */
    enableControls?: boolean;
    /** Enable administrative override controls */
    enableAdminOverride?: boolean;
    /** Show queue information for contended locks */
    showQueueInfo?: boolean;
    /** Enable accessibility features */
    enableAccessibility?: boolean;
    /** Custom CSS class for styling */
    className?: string;
    /** Callback for lock state changes */
    onLockStateChange?: (lockMetadata: ILockMetadata | null) => void;
    /** Callback for user interaction events */
    onUserInteraction?: (event: string, data: JSONObject) => void;
    /** Custom lock acquisition handler */
    onLockAcquire?: (cellId: string) => Promise<void>;
    /** Custom lock release handler */
    onLockRelease?: (lockId: string) => Promise<void>;
}

/**
 * Cell lock indicator component providing comprehensive lock status visualization
 * and interaction capabilities for collaborative editing coordination.
 * 
 * This component serves as the primary interface for users to understand and
 * interact with cell-level locking mechanisms, providing clear visual feedback
 * about lock ownership, timeout status, and queue positions while maintaining
 * accessibility and responsive design principles.
 */
export const CellLockIndicator: React.FC<ICellLockIndicatorProps> = ({
    cellId,
    lockManager,
    awareness,
    provider,
    currentUser,
    mode = LockIndicatorMode.COMPACT,
    theme = LockIndicatorTheme.DEFAULT,
    enableControls = true,
    enableAdminOverride = false,
    showQueueInfo = true,
    enableAccessibility = true,
    className = '',
    onLockStateChange,
    onUserInteraction,
    onLockAcquire,
    onLockRelease
}) => {
    // Component state management
    const [lockMetadata, setLockMetadata] = useState<ILockMetadata | null>(null);
    const [queueInfo, setQueueInfo] = useState<IQueueInfo | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [remainingTime, setRemainingTime] = useState<number>(0);
    const [userPresence, setUserPresence] = useState<IUserPresence | null>(null);
    const [showTooltip, setShowTooltip] = useState(false);
    const [showControls, setShowControls] = useState(false);

    // Component refs for DOM manipulation and cleanup
    const disposablesRef = useRef<IDisposable[]>([]);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(true);

    /**
     * Cleanup function to dispose of all event listeners and timers
     */
    const cleanup = useCallback(() => {
        mountedRef.current = false;
        
        // Clear timeout
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        // Dispose of all signal connections
        disposablesRef.current.forEach(disposable => {
            try {
                disposable.dispose();
            } catch (error) {
                console.warn('[CellLockIndicator] Error disposing signal connection:', error);
            }
        });
        disposablesRef.current = [];
    }, []);

    /**
     * Initialize component and set up event listeners
     */
    useEffect(() => {
        mountedRef.current = true;

        const initializeComponent = async () => {
            try {
                // Initial lock status check
                await updateLockStatus();

                // Set up lock event listeners
                setupLockEventListeners();

                // Set up awareness event listeners
                setupAwarenessEventListeners();

                // Start timeout monitoring
                startTimeoutMonitoring();

            } catch (error) {
                console.error('[CellLockIndicator] Initialization error:', error);
                setError(`Failed to initialize lock indicator: ${error.message}`);
            }
        };

        initializeComponent();

        // Cleanup on unmount
        return cleanup;
    }, [cellId, lockManager, awareness]);

    /**
     * Sets up event listeners for lock-related events
     */
    const setupLockEventListeners = useCallback(() => {
        if (!lockManager || !mountedRef.current) {
            return;
        }

        try {
            // Listen for lock acquisition events
            const lockAcquiredConnection = lockManager.lockAcquired.connect((sender, event: ILockEvent) => {
                if (event.lock.cellId === cellId && mountedRef.current) {
                    setLockMetadata(event.lock);
                    setError(null);
                    onLockStateChange?.(event.lock);
                    onUserInteraction?.('lock_acquired', { 
                        cellId, 
                        lockId: event.lock.lockId,
                        userId: event.userId 
                    });
                }
            });

            // Listen for lock release events
            const lockReleasedConnection = lockManager.lockReleased.connect((sender, event: ILockEvent) => {
                if (event.lock.cellId === cellId && mountedRef.current) {
                    setLockMetadata(null);
                    setQueueInfo(null);
                    setError(null);
                    onLockStateChange?.(null);
                    onUserInteraction?.('lock_released', { 
                        cellId, 
                        lockId: event.lock.lockId,
                        userId: event.userId 
                    });
                }
            });

            // Listen for lock contention events
            const lockContentionConnection = lockManager.lockContention.connect((sender, event: ILockEvent) => {
                if (event.lock.cellId === cellId && mountedRef.current) {
                    setQueueInfo({
                        position: event.lock.queuePosition || 0,
                        estimatedWaitMs: estimateWaitTime(event.lock.queuePosition || 0),
                        queuedAt: event.timestamp,
                        user: {
                            userId: event.userId,
                            displayName: event.lock.userName,
                            avatar: getUserAvatar(event.userId)
                        }
                    });
                    onUserInteraction?.('lock_contention', { 
                        cellId, 
                        queuePosition: event.lock.queuePosition,
                        userId: event.userId 
                    });
                }
            });

            // Listen for lock timeout events
            const lockTimeoutConnection = lockManager.lockTimeout.connect((sender, event: ILockEvent) => {
                if (event.lock.cellId === cellId && mountedRef.current) {
                    setLockMetadata(null);
                    setError('Lock expired');
                    onLockStateChange?.(null);
                    onUserInteraction?.('lock_timeout', { 
                        cellId, 
                        lockId: event.lock.lockId,
                        userId: event.userId 
                    });
                }
            });

            // Listen for lock error events
            const lockErrorConnection = lockManager.lockError.connect((sender, event: ILockEvent) => {
                if (event.lock.cellId === cellId && mountedRef.current) {
                    setError(`Lock error: ${event.data.error}`);
                    setIsLoading(false);
                    onUserInteraction?.('lock_error', { 
                        cellId, 
                        error: event.data.error,
                        userId: event.userId 
                    });
                }
            });

            // Store connections for cleanup
            disposablesRef.current.push(
                lockAcquiredConnection,
                lockReleasedConnection,
                lockContentionConnection,
                lockTimeoutConnection,
                lockErrorConnection
            );

        } catch (error) {
            console.error('[CellLockIndicator] Error setting up lock event listeners:', error);
        }
    }, [cellId, lockManager, onLockStateChange, onUserInteraction]);

    /**
     * Sets up event listeners for awareness events
     */
    const setupAwarenessEventListeners = useCallback(() => {
        if (!awareness || !mountedRef.current) {
            return;
        }

        try {
            // Listen for user presence updates
            const presenceConnection = awareness.presenceUpdated.connect((sender, event) => {
                if (lockMetadata && event.userId === lockMetadata.userId && mountedRef.current) {
                    setUserPresence(event.presence);
                }
            });

            // Listen for user leaving events
            const userLeftConnection = awareness.userLeft.connect((sender, event) => {
                if (lockMetadata && event.userId === lockMetadata.userId && mountedRef.current) {
                    setUserPresence(null);
                }
            });

            // Store connections for cleanup
            disposablesRef.current.push(presenceConnection, userLeftConnection);

        } catch (error) {
            console.error('[CellLockIndicator] Error setting up awareness event listeners:', error);
        }
    }, [awareness, lockMetadata]);

    /**
     * Updates the current lock status for the cell
     */
    const updateLockStatus = useCallback(async () => {
        if (!lockManager || !mountedRef.current) {
            return;
        }

        try {
            const currentLock = await lockManager.getCellLockStatus(cellId);
            if (mountedRef.current) {
                setLockMetadata(currentLock);
                
                // Update user presence if lock exists
                if (currentLock && awareness) {
                    const presence = awareness.getUserPresence(currentLock.userId);
                    setUserPresence(presence);
                }
                
                onLockStateChange?.(currentLock);
            }
        } catch (error) {
            console.error('[CellLockIndicator] Error updating lock status:', error);
            if (mountedRef.current) {
                setError(`Failed to check lock status: ${error.message}`);
            }
        }
    }, [cellId, lockManager, awareness, onLockStateChange]);

    /**
     * Starts monitoring for lock timeout countdown
     */
    const startTimeoutMonitoring = useCallback(() => {
        const updateRemainingTime = () => {
            if (!lockMetadata || !mountedRef.current) {
                return;
            }

            const remaining = LockUtils.getRemainingTime(lockMetadata);
            setRemainingTime(remaining);

            if (remaining > 0) {
                timeoutRef.current = setTimeout(updateRemainingTime, 1000);
            }
        };

        if (lockMetadata && lockMetadata.status === LockStatus.ACQUIRED) {
            updateRemainingTime();
        }
    }, [lockMetadata]);

    /**
     * Handles lock acquisition requests
     */
    const handleLockAcquire = useCallback(async () => {
        if (!lockManager || !enableControls || isLoading) {
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            if (onLockAcquire) {
                await onLockAcquire(cellId);
            } else {
                const lockRequest: ILockRequest = LockUtils.createLockRequest(
                    cellId,
                    currentUser.userId,
                    currentUser.displayName,
                    provider.sessionId,
                    {
                        priority: LockPriority.Normal,
                        timeoutMs: 120000, // 2 minutes
                        reason: 'User requested lock'
                    }
                );

                await lockManager.acquireLock(lockRequest);
            }

            onUserInteraction?.('lock_acquire_requested', { cellId, userId: currentUser.userId });

        } catch (error) {
            console.error('[CellLockIndicator] Lock acquisition failed:', error);
            setError(`Failed to acquire lock: ${error.message}`);
            onUserInteraction?.('lock_acquire_failed', { 
                cellId, 
                userId: currentUser.userId, 
                error: error.message 
            });
        } finally {
            if (mountedRef.current) {
                setIsLoading(false);
            }
        }
    }, [cellId, lockManager, enableControls, isLoading, currentUser, provider, onLockAcquire, onUserInteraction]);

    /**
     * Handles lock release requests
     */
    const handleLockRelease = useCallback(async () => {
        if (!lockManager || !lockMetadata || !enableControls || isLoading) {
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            if (onLockRelease) {
                await onLockRelease(lockMetadata.lockId);
            } else {
                await lockManager.releaseLock({
                    lockId: lockMetadata.lockId,
                    userId: currentUser.userId,
                    sessionId: provider.sessionId,
                    reason: 'User requested release'
                });
            }

            onUserInteraction?.('lock_release_requested', { 
                cellId, 
                lockId: lockMetadata.lockId, 
                userId: currentUser.userId 
            });

        } catch (error) {
            console.error('[CellLockIndicator] Lock release failed:', error);
            setError(`Failed to release lock: ${error.message}`);
            onUserInteraction?.('lock_release_failed', { 
                cellId, 
                lockId: lockMetadata.lockId, 
                userId: currentUser.userId, 
                error: error.message 
            });
        } finally {
            if (mountedRef.current) {
                setIsLoading(false);
            }
        }
    }, [lockMetadata, lockManager, enableControls, isLoading, currentUser, provider, onLockRelease, onUserInteraction]);

    /**
     * Handles administrative lock override
     */
    const handleAdminOverride = useCallback(async () => {
        if (!lockManager || !lockMetadata || !enableAdminOverride) {
            return;
        }

        const reason = prompt('Enter reason for administrative override:');
        if (!reason) {
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            await lockManager.forceReleaseLock(lockMetadata.lockId, currentUser.userId, reason);
            onUserInteraction?.('admin_override', { 
                cellId, 
                lockId: lockMetadata.lockId, 
                adminUserId: currentUser.userId, 
                reason 
            });

        } catch (error) {
            console.error('[CellLockIndicator] Admin override failed:', error);
            setError(`Admin override failed: ${error.message}`);
        } finally {
            if (mountedRef.current) {
                setIsLoading(false);
            }
        }
    }, [lockMetadata, lockManager, enableAdminOverride, currentUser, onUserInteraction]);

    /**
     * Estimates wait time based on queue position
     */
    const estimateWaitTime = useCallback((position: number): number => {
        // Estimate 30 seconds per position in queue
        return position * 30000;
    }, []);

    /**
     * Gets user avatar URL from awareness system
     */
    const getUserAvatar = useCallback((userId: string): string | undefined => {
        if (!awareness) {
            return undefined;
        }

        const presence = awareness.getUserPresence(userId);
        return presence?.avatar;
    }, [awareness]);

    /**
     * Determines if current user owns the lock
     */
    const isOwnLock = useMemo(() => {
        return lockMetadata?.userId === currentUser.userId;
    }, [lockMetadata, currentUser.userId]);

    /**
     * Determines if current user can override the lock
     */
    const canOverride = useMemo(() => {
        if (!enableAdminOverride || !lockMetadata) {
            return false;
        }

        return currentUser.role === 'admin' || currentUser.role === 'owner';
    }, [enableAdminOverride, lockMetadata, currentUser.role]);

    /**
     * Generates CSS classes based on component props and state
     */
    const cssClasses = useMemo(() => {
        const classes = [
            'jp-cell-lock-indicator',
            `jp-cell-lock-indicator-${mode}`,
            `jp-cell-lock-indicator-${theme}`,
            className
        ];

        if (lockMetadata) {
            classes.push('jp-cell-lock-indicator-locked');
            classes.push(`jp-cell-lock-indicator-${lockMetadata.status}`);
            
            if (isOwnLock) {
                classes.push('jp-cell-lock-indicator-own');
            }
        }

        if (queueInfo) {
            classes.push('jp-cell-lock-indicator-queued');
        }

        if (error) {
            classes.push('jp-cell-lock-indicator-error');
        }

        if (isLoading) {
            classes.push('jp-cell-lock-indicator-loading');
        }

        return classes.filter(Boolean).join(' ');
    }, [mode, theme, className, lockMetadata, queueInfo, error, isLoading, isOwnLock]);

    /**
     * Generates ARIA attributes for accessibility
     */
    const ariaAttributes = useMemo(() => {
        if (!enableAccessibility) {
            return {};
        }

        const attributes: any = {
            'role': 'status',
            'aria-live': 'polite',
            'aria-atomic': true
        };

        if (lockMetadata) {
            attributes['aria-label'] = `Cell locked by ${lockMetadata.userName}`;
            if (remainingTime > 0) {
                attributes['aria-label'] += `, ${LockUtils.formatLockDuration(remainingTime)} remaining`;
            }
        } else if (queueInfo) {
            attributes['aria-label'] = `Lock requested, position ${queueInfo.position + 1} in queue`;
        } else {
            attributes['aria-label'] = 'Cell available for editing';
        }

        return attributes;
    }, [enableAccessibility, lockMetadata, queueInfo, remainingTime]);

    /**
     * Renders the lock status icon
     */
    const renderLockIcon = useCallback(() => {
        if (isLoading) {
            return (
                <div className="jp-cell-lock-spinner" aria-hidden="true">
                    <div className="jp-cell-lock-spinner-inner"></div>
                </div>
            );
        }

        if (lockMetadata) {
            const iconClass = isOwnLock ? 'jp-icon-lock-open' : 'jp-icon-lock';
            return (
                <div className={`jp-cell-lock-icon ${iconClass}`} aria-hidden="true">
                    {lockMetadata.status === LockStatus.ACQUIRED && (
                        <div className="jp-cell-lock-pulse"></div>
                    )}
                </div>
            );
        }

        if (queueInfo) {
            return (
                <div className="jp-cell-lock-icon jp-icon-queue" aria-hidden="true">
                    <span className="jp-cell-lock-queue-position">{queueInfo.position + 1}</span>
                </div>
            );
        }

        return (
            <div className="jp-cell-lock-icon jp-icon-unlock" aria-hidden="true"></div>
        );
    }, [isLoading, lockMetadata, queueInfo, isOwnLock]);

    /**
     * Renders user information display
     */
    const renderUserInfo = useCallback(() => {
        if (mode === LockIndicatorMode.COMPACT) {
            return null;
        }

        if (lockMetadata) {
            const avatar = getUserAvatar(lockMetadata.userId);
            return (
                <div className="jp-cell-lock-user-info">
                    {avatar && (
                        <img 
                            src={avatar} 
                            alt={`${lockMetadata.userName} avatar`}
                            className="jp-cell-lock-user-avatar"
                            loading="lazy"
                        />
                    )}
                    <span className="jp-cell-lock-user-name">{lockMetadata.userName}</span>
                    {userPresence?.activityStatus === UserActivityStatus.EDITING && (
                        <span className="jp-cell-lock-activity-indicator" title="Currently editing">
                            ✏️
                        </span>
                    )}
                </div>
            );
        }

        if (queueInfo) {
            return (
                <div className="jp-cell-lock-queue-info">
                    <span className="jp-cell-lock-queue-text">
                        Position {queueInfo.position + 1} in queue
                    </span>
                    <span className="jp-cell-lock-queue-time">
                        ~{LockUtils.formatLockDuration(queueInfo.estimatedWaitMs)} wait
                    </span>
                </div>
            );
        }

        return null;
    }, [mode, lockMetadata, queueInfo, userPresence, getUserAvatar]);

    /**
     * Renders timeout countdown display
     */
    const renderTimeoutDisplay = useCallback(() => {
        if (!lockMetadata || remainingTime <= 0 || mode === LockIndicatorMode.COMPACT) {
            return null;
        }

        const progress = remainingTime / lockMetadata.timeoutMs;
        const isExpiringSoon = remainingTime < 30000; // 30 seconds

        return (
            <div className={`jp-cell-lock-timeout ${isExpiringSoon ? 'jp-cell-lock-timeout-warning' : ''}`}>
                <div className="jp-cell-lock-timeout-bar">
                    <div 
                        className="jp-cell-lock-timeout-progress"
                        style={{ width: `${progress * 100}%` }}
                    ></div>
                </div>
                <span className="jp-cell-lock-timeout-text">
                    {LockUtils.formatLockDuration(remainingTime)}
                </span>
            </div>
        );
    }, [lockMetadata, remainingTime, mode]);

    /**
     * Renders interactive controls
     */
    const renderControls = useCallback(() => {
        if (!enableControls || mode === LockIndicatorMode.COMPACT || !showControls) {
            return null;
        }

        return (
            <div className="jp-cell-lock-controls">
                {lockMetadata ? (
                    <>
                        {isOwnLock && (
                            <button
                                className="jp-cell-lock-button jp-cell-lock-release"
                                onClick={handleLockRelease}
                                disabled={isLoading}
                                title="Release lock"
                                aria-label="Release cell lock"
                            >
                                Release
                            </button>
                        )}
                        {canOverride && !isOwnLock && (
                            <button
                                className="jp-cell-lock-button jp-cell-lock-override"
                                onClick={handleAdminOverride}
                                disabled={isLoading}
                                title="Administrative override"
                                aria-label="Force release lock (admin)"
                            >
                                Override
                            </button>
                        )}
                    </>
                ) : (
                    <button
                        className="jp-cell-lock-button jp-cell-lock-acquire"
                        onClick={handleLockAcquire}
                        disabled={isLoading}
                        title="Acquire lock"
                        aria-label="Acquire cell lock"
                    >
                        Lock
                    </button>
                )}
            </div>
        );
    }, [enableControls, mode, showControls, lockMetadata, isOwnLock, canOverride, isLoading, handleLockRelease, handleAdminOverride, handleLockAcquire]);

    /**
     * Renders error display
     */
    const renderError = useCallback(() => {
        if (!error) {
            return null;
        }

        return (
            <div className="jp-cell-lock-error" role="alert">
                <span className="jp-cell-lock-error-icon" aria-hidden="true">⚠</span>
                <span className="jp-cell-lock-error-text">{error}</span>
                <button
                    className="jp-cell-lock-error-dismiss"
                    onClick={() => setError(null)}
                    aria-label="Dismiss error"
                >
                    ×
                </button>
            </div>
        );
    }, [error]);

    /**
     * Renders tooltip content
     */
    const renderTooltip = useCallback(() => {
        if (!showTooltip || mode !== LockIndicatorMode.COMPACT) {
            return null;
        }

        const tooltipContent = (
            <div 
                ref={tooltipRef}
                className="jp-cell-lock-tooltip"
                role="tooltip"
                aria-hidden={!showTooltip}
            >
                {lockMetadata && (
                    <div>
                        <strong>{lockMetadata.userName}</strong> is editing this cell
                        {remainingTime > 0 && (
                            <div>Lock expires in {LockUtils.formatLockDuration(remainingTime)}</div>
                        )}
                    </div>
                )}
                {queueInfo && (
                    <div>
                        Position {queueInfo.position + 1} in editing queue
                        <div>Estimated wait: {LockUtils.formatLockDuration(queueInfo.estimatedWaitMs)}</div>
                    </div>
                )}
                {!lockMetadata && !queueInfo && (
                    <div>Cell available for editing</div>
                )}
            </div>
        );

        // Use portal to render tooltip at document root for proper positioning
        return createPortal(tooltipContent, document.body);
    }, [showTooltip, mode, lockMetadata, queueInfo, remainingTime]);

    // Update timeout monitoring when lock metadata changes
    useEffect(() => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
        startTimeoutMonitoring();
    }, [lockMetadata, startTimeoutMonitoring]);

    // Handle keyboard events for accessibility
    const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
        if (!enableAccessibility) {
            return;
        }

        switch (event.key) {
            case 'Enter':
            case ' ':
                event.preventDefault();
                if (lockMetadata && isOwnLock) {
                    handleLockRelease();
                } else if (!lockMetadata) {
                    handleLockAcquire();
                }
                break;
            case 'Escape':
                setShowControls(false);
                setShowTooltip(false);
                break;
        }
    }, [enableAccessibility, lockMetadata, isOwnLock, handleLockRelease, handleLockAcquire]);

    return (
        <div 
            className={cssClasses}
            {...ariaAttributes}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
            onFocus={() => setShowTooltip(true)}
            onBlur={() => setShowTooltip(false)}
            onClick={() => setShowControls(!showControls)}
            onKeyDown={handleKeyDown}
            tabIndex={enableAccessibility ? 0 : -1}
        >
            {renderLockIcon()}
            {renderUserInfo()}
            {renderTimeoutDisplay()}
            {renderControls()}
            {renderError()}
            {renderTooltip()}
        </div>
    );
};

/**
 * Default props for the CellLockIndicator component
 */
CellLockIndicator.defaultProps = {
    mode: LockIndicatorMode.COMPACT,
    theme: LockIndicatorTheme.DEFAULT,
    enableControls: true,
    enableAdminOverride: false,
    showQueueInfo: true,
    enableAccessibility: true,
    className: ''
};

/**
 * CSS styles for the CellLockIndicator component
 * These styles should be included in the notebook extension's CSS file
 */
export const CELL_LOCK_INDICATOR_STYLES = `
/* Base styles for cell lock indicator */
.jp-cell-lock-indicator {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    position: relative;
    cursor: pointer;
    user-select: none;
    transition: all 0.2s ease;
}

.jp-cell-lock-indicator:focus {
    outline: 2px solid var(--jp-accent-color1);
    outline-offset: 2px;
}

/* Mode-specific styles */
.jp-cell-lock-indicator-compact {
    padding: 2px;
    min-width: 20px;
    min-height: 20px;
}

.jp-cell-lock-indicator-detailed {
    padding: 8px;
    min-width: 200px;
    border: 1px solid var(--jp-border-color1);
    border-radius: 4px;
    background: var(--jp-layout-color0);
}

.jp-cell-lock-indicator-inline {
    padding: 4px 8px;
    border-radius: 12px;
    background: var(--jp-layout-color1);
}

.jp-cell-lock-indicator-overlay {
    position: absolute;
    top: 4px;
    right: 4px;
    padding: 4px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

/* Lock status styles */
.jp-cell-lock-indicator-locked {
    color: var(--jp-error-color1);
}

.jp-cell-lock-indicator-own {
    color: var(--jp-success-color1);
}

.jp-cell-lock-indicator-queued {
    color: var(--jp-warn-color1);
}

/* Icon styles */
.jp-cell-lock-icon {
    width: 16px;
    height: 16px;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
}

.jp-icon-lock::before {
    content: "🔒";
    font-size: 14px;
}

.jp-icon-lock-open::before {
    content: "🔓";
    font-size: 14px;
}

.jp-icon-unlock::before {
    content: "🔐";
    font-size: 14px;
    opacity: 0.5;
}

.jp-icon-queue::before {
    content: "⏳";
    font-size: 14px;
}

/* Loading spinner */
.jp-cell-lock-spinner {
    width: 16px;
    height: 16px;
    position: relative;
}

.jp-cell-lock-spinner-inner {
    width: 100%;
    height: 100%;
    border: 2px solid var(--jp-border-color2);
    border-top-color: var(--jp-accent-color1);
    border-radius: 50%;
    animation: jp-cell-lock-spin 1s linear infinite;
}

@keyframes jp-cell-lock-spin {
    to {
        transform: rotate(360deg);
    }
}

/* Pulse animation for active locks */
.jp-cell-lock-pulse {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.3;
    animation: jp-cell-lock-pulse 2s ease-in-out infinite;
}

@keyframes jp-cell-lock-pulse {
    0%, 100% {
        transform: scale(1);
        opacity: 0.3;
    }
    50% {
        transform: scale(1.2);
        opacity: 0.1;
    }
}

/* User info styles */
.jp-cell-lock-user-info {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
}

.jp-cell-lock-user-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    object-fit: cover;
}

.jp-cell-lock-user-name {
    font-weight: 500;
}

.jp-cell-lock-activity-indicator {
    font-size: 10px;
}

/* Queue info styles */
.jp-cell-lock-queue-info {
    display: flex;
    flex-direction: column;
    font-size: 11px;
    line-height: 1.3;
}

.jp-cell-lock-queue-position {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 10px;
    font-weight: bold;
    color: white;
    text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.5);
}

/* Timeout display styles */
.jp-cell-lock-timeout {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
}

.jp-cell-lock-timeout-bar {
    width: 40px;
    height: 4px;
    background: var(--jp-border-color2);
    border-radius: 2px;
    overflow: hidden;
}

.jp-cell-lock-timeout-progress {
    height: 100%;
    background: var(--jp-success-color1);
    transition: width 1s linear;
}

.jp-cell-lock-timeout-warning .jp-cell-lock-timeout-progress {
    background: var(--jp-error-color1);
}

/* Controls styles */
.jp-cell-lock-controls {
    display: flex;
    gap: 4px;
    margin-top: 4px;
}

.jp-cell-lock-button {
    padding: 4px 8px;
    font-size: 11px;
    border: 1px solid var(--jp-border-color1);
    border-radius: 3px;
    background: var(--jp-layout-color1);
    color: var(--jp-content-font-color1);
    cursor: pointer;
    transition: all 0.2s ease;
}

.jp-cell-lock-button:hover {
    background: var(--jp-layout-color2);
}

.jp-cell-lock-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.jp-cell-lock-release {
    background: var(--jp-success-color1);
    color: white;
    border-color: var(--jp-success-color1);
}

.jp-cell-lock-override {
    background: var(--jp-error-color1);
    color: white;
    border-color: var(--jp-error-color1);
}

.jp-cell-lock-acquire {
    background: var(--jp-accent-color1);
    color: white;
    border-color: var(--jp-accent-color1);
}

/* Error display styles */
.jp-cell-lock-error {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--jp-error-color2);
    border: 1px solid var(--jp-error-color1);
    border-radius: 4px;
    font-size: 12px;
    color: var(--jp-error-color1);
    margin-top: 4px;
}

.jp-cell-lock-error-dismiss {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0;
    margin-left: auto;
}

/* Tooltip styles */
.jp-cell-lock-tooltip {
    position: fixed;
    z-index: 9999;
    padding: 8px 12px;
    background: var(--jp-layout-color3);
    border: 1px solid var(--jp-border-color1);
    border-radius: 4px;
    font-size: 12px;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
    max-width: 250px;
    pointer-events: none;
}

/* Theme variants */
.jp-cell-lock-indicator-high-contrast {
    filter: contrast(1.5);
}

.jp-cell-lock-indicator-minimal {
    opacity: 0.7;
}

.jp-cell-lock-indicator-minimal:hover {
    opacity: 1;
}

.jp-cell-lock-indicator-dark {
    color-scheme: dark;
}

/* Responsive design */
@media (max-width: 768px) {
    .jp-cell-lock-indicator-detailed {
        min-width: 150px;
        font-size: 11px;
    }
    
    .jp-cell-lock-user-avatar {
        width: 16px;
        height: 16px;
    }
    
    .jp-cell-lock-controls {
        flex-direction: column;
    }
}

/* Accessibility improvements */
@media (prefers-reduced-motion: reduce) {
    .jp-cell-lock-indicator,
    .jp-cell-lock-pulse,
    .jp-cell-lock-spinner-inner,
    .jp-cell-lock-timeout-progress {
        animation: none;
        transition: none;
    }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
    .jp-cell-lock-indicator {
        border: 2px solid currentColor;
    }
    
    .jp-cell-lock-button {
        border-width: 2px;
    }
}
`;

export default CellLockIndicator;