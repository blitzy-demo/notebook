// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Distributed cell-level locking mechanism using Yjs Y.Map for collaborative notebook editing.
 * 
 * This module implements a robust, conflict-free locking system that prevents editing conflicts
 * during collaborative sessions while maintaining optimal user experience with minimal latency.
 * 
 * Features:
 * - Distributed lock acquisition and release using Yjs Y.Map CRDT
 * - Timeout-based lock management (5 minute lock timeout, 10 second acquisition timeout)
 * - Timestamp-based conflict resolution for simultaneous lock requests
 * - Visual lock indicators and user identification
 * - Automatic cleanup and recovery mechanisms
 * - Integration with JupyterLab cell components
 */

import { ISignal, Signal } from '@lumino/signaling';
import { DisposableDelegate, IDisposable } from '@lumino/disposable';
import * as Y from 'yjs';

/**
 * Namespace for cell locking related types and interfaces
 */
export namespace CellLocks {
  /**
   * Lock state information for a cell
   */
  export interface ILockInfo {
    /** User ID who holds the lock */
    userId: string;
    /** User display name */
    userName: string;
    /** User color for UI indication */
    userColor: string;
    /** Timestamp when lock was acquired (UTC milliseconds) */
    timestamp: number;
    /** Session ID to handle user disconnections */
    sessionId: string;
    /** Optional lock reason or context */
    reason?: string;
  }

  /**
   * Lock acquisition result
   */
  export interface ILockResult {
    /** Whether lock was successfully acquired */
    success: boolean;
    /** Lock information if acquired, or current holder if failed */
    lockInfo?: ILockInfo;
    /** Error message if acquisition failed */
    error?: string;
  }

  /**
   * Lock event data
   */
  export interface ILockEvent {
    /** Cell ID that was locked/unlocked */
    cellId: string;
    /** Lock information (null for unlock events) */
    lockInfo: ILockInfo | null;
    /** Type of lock event */
    type: 'acquired' | 'released' | 'timeout' | 'conflict';
    /** User who triggered the event */
    userId: string;
  }

  /**
   * User information for lock display
   */
  export interface IUserInfo {
    /** Unique user identifier */
    userId: string;
    /** Display name */
    userName: string;
    /** Color for UI indicators */
    userColor: string;
    /** Current session ID */
    sessionId: string;
  }

  /**
   * Lock configuration options
   */
  export interface ILockOptions {
    /** Lock timeout in milliseconds (default: 5 minutes) */
    lockTimeout?: number;
    /** Lock acquisition timeout in milliseconds (default: 10 seconds) */
    acquisitionTimeout?: number;
    /** Cleanup interval in milliseconds (default: 30 seconds) */
    cleanupInterval?: number;
    /** Maximum lock retries (default: 3) */
    maxRetries?: number;
  }
}

/**
 * Default lock configuration
 */
const DEFAULT_LOCK_OPTIONS: Required<CellLocks.ILockOptions> = {
  lockTimeout: 5 * 60 * 1000,        // 5 minutes
  acquisitionTimeout: 10 * 1000,      // 10 seconds
  cleanupInterval: 30 * 1000,         // 30 seconds
  maxRetries: 3                       // 3 attempts
};

/**
 * Distributed cell-level locking manager using Yjs Y.Map for conflict-free replication.
 * 
 * This class manages collaborative editing locks at the cell level to prevent conflicts
 * when multiple users attempt to edit the same cell simultaneously. It uses Yjs shared
 * types to ensure consistent lock state across all connected clients.
 */
export class CellLockManager implements IDisposable {
  private _isDisposed = false;
  private _ydoc: Y.Doc;
  private _locksMap: Y.Map<CellLocks.ILockInfo>;
  private _currentUser: CellLocks.IUserInfo;
  private _options: Required<CellLocks.ILockOptions>;
  private _cleanupTimer: number | null = null;
  private _lockChanged = new Signal<this, CellLocks.ILockEvent>(this);
  private _retryTimers = new Map<string, number>();
  private _acquisitionPromises = new Map<string, {
    resolve: (result: CellLocks.ILockResult) => void;
    reject: (error: Error) => void;
    timeout: number;
  }>();

  /**
   * Create a new cell lock manager
   * 
   * @param ydoc - Yjs document for collaboration state
   * @param currentUser - Current user information
   * @param options - Lock configuration options
   */
  constructor(
    ydoc: Y.Doc,
    currentUser: CellLocks.IUserInfo,
    options: CellLocks.ILockOptions = {}
  ) {
    this._ydoc = ydoc;
    this._currentUser = { ...currentUser };
    this._options = { ...DEFAULT_LOCK_OPTIONS, ...options };
    
    // Get or create the locks map in the Yjs document
    this._locksMap = this._ydoc.getMap('cellLocks');
    
    // Set up lock state monitoring
    this._setupLockObserver();
    
    // Start periodic cleanup of expired locks
    this._startCleanupTimer();
  }

  /**
   * Signal emitted when lock state changes
   */
  get lockChanged(): ISignal<this, CellLocks.ILockEvent> {
    return this._lockChanged;
  }

  /**
   * Get current user information
   */
  get currentUser(): CellLocks.IUserInfo {
    return { ...this._currentUser };
  }

  /**
   * Update current user information
   * 
   * @param userInfo - Updated user information
   */
  updateUser(userInfo: CellLocks.IUserInfo): void {
    if (this._isDisposed) {
      return;
    }
    
    this._currentUser = { ...userInfo };
  }

  /**
   * Attempt to acquire a lock on a cell
   * 
   * @param cellId - Unique identifier for the cell
   * @param reason - Optional reason for acquiring the lock
   * @returns Promise resolving to lock acquisition result
   */
  async acquireLock(cellId: string, reason?: string): Promise<CellLocks.ILockResult> {
    if (this._isDisposed) {
      return {
        success: false,
        error: 'Lock manager is disposed'
      };
    }

    // Check if we already have a pending acquisition for this cell
    if (this._acquisitionPromises.has(cellId)) {
      return {
        success: false,
        error: 'Lock acquisition already in progress for this cell'
      };
    }

    return new Promise<CellLocks.ILockResult>((resolve, reject) => {
      // Set up acquisition timeout
      const timeout = window.setTimeout(() => {
        this._acquisitionPromises.delete(cellId);
        resolve({
          success: false,
          error: 'Lock acquisition timeout'
        });
      }, this._options.acquisitionTimeout);

      // Store promise handlers for potential cleanup
      this._acquisitionPromises.set(cellId, { resolve, reject, timeout });

      // Attempt to acquire the lock
      this._attemptLockAcquisition(cellId, reason);
    });
  }

  /**
   * Release a lock on a cell
   * 
   * @param cellId - Unique identifier for the cell
   * @returns Whether the lock was successfully released
   */
  releaseLock(cellId: string): boolean {
    if (this._isDisposed) {
      return false;
    }

    const currentLock = this._locksMap.get(cellId);
    
    // Check if we own this lock
    if (!currentLock || 
        currentLock.userId !== this._currentUser.userId || 
        currentLock.sessionId !== this._currentUser.sessionId) {
      return false;
    }

    // Remove the lock from the shared map
    this._locksMap.delete(cellId);
    
    // Clean up any pending retry timers
    this._clearRetryTimer(cellId);
    
    return true;
  }

  /**
   * Check if a cell is currently locked
   * 
   * @param cellId - Unique identifier for the cell
   * @returns Lock information if cell is locked, null otherwise
   */
  getLockInfo(cellId: string): CellLocks.ILockInfo | null {
    if (this._isDisposed) {
      return null;
    }

    const lockInfo = this._locksMap.get(cellId);
    
    if (!lockInfo) {
      return null;
    }

    // Check if lock has expired
    const now = Date.now();
    if (now - lockInfo.timestamp > this._options.lockTimeout) {
      // Lock has expired, remove it
      this._locksMap.delete(cellId);
      return null;
    }

    return { ...lockInfo };
  }

  /**
   * Check if current user owns the lock for a cell
   * 
   * @param cellId - Unique identifier for the cell
   * @returns Whether current user owns the lock
   */
  isLockedByCurrentUser(cellId: string): boolean {
    const lockInfo = this.getLockInfo(cellId);
    return lockInfo !== null && 
           lockInfo.userId === this._currentUser.userId &&
           lockInfo.sessionId === this._currentUser.sessionId;
  }

  /**
   * Get all currently locked cells
   * 
   * @returns Map of cell IDs to lock information
   */
  getAllLocks(): Map<string, CellLocks.ILockInfo> {
    const locks = new Map<string, CellLocks.ILockInfo>();
    const now = Date.now();

    this._locksMap.forEach((lockInfo, cellId) => {
      // Only include non-expired locks
      if (now - lockInfo.timestamp <= this._options.lockTimeout) {
        locks.set(cellId, { ...lockInfo });
      }
    });

    return locks;
  }

  /**
   * Force release all locks held by current user
   * 
   * This is useful when user is about to disconnect or switch contexts
   */
  releaseAllUserLocks(): void {
    if (this._isDisposed) {
      return;
    }

    const cellsToRelease: string[] = [];
    
    this._locksMap.forEach((lockInfo, cellId) => {
      if (lockInfo.userId === this._currentUser.userId &&
          lockInfo.sessionId === this._currentUser.sessionId) {
        cellsToRelease.push(cellId);
      }
    });

    // Release all user's locks
    cellsToRelease.forEach(cellId => {
      this._locksMap.delete(cellId);
      this._clearRetryTimer(cellId);
    });
  }

  /**
   * Cleanup expired locks manually
   * 
   * This is called automatically by the cleanup timer, but can be triggered manually
   */
  cleanupExpiredLocks(): void {
    if (this._isDisposed) {
      return;
    }

    const now = Date.now();
    const cellsToCleanup: string[] = [];

    this._locksMap.forEach((lockInfo, cellId) => {
      if (now - lockInfo.timestamp > this._options.lockTimeout) {
        cellsToCleanup.push(cellId);
      }
    });

    cellsToCleanup.forEach(cellId => {
      const lockInfo = this._locksMap.get(cellId);
      this._locksMap.delete(cellId);
      
      if (lockInfo) {
        this._lockChanged.emit({
          cellId,
          lockInfo: null,
          type: 'timeout',
          userId: lockInfo.userId
        });
      }
    });
  }

  /**
   * Dispose of the lock manager and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;

    // Release all locks held by current user
    this.releaseAllUserLocks();

    // Clear all timers
    if (this._cleanupTimer !== null) {
      window.clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    // Clear retry timers
    this._retryTimers.forEach(timer => window.clearTimeout(timer));
    this._retryTimers.clear();

    // Clear acquisition promises
    this._acquisitionPromises.forEach(({ resolve, timeout }) => {
      window.clearTimeout(timeout);
      resolve({
        success: false,
        error: 'Lock manager disposed'
      });
    });
    this._acquisitionPromises.clear();

    // Remove Yjs observer
    this._locksMap.unobserve(this._onLockMapChange);

    Signal.clearData(this);
  }

  /**
   * Check if the lock manager is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Attempt to acquire a lock for a cell
   * 
   * @private
   * @param cellId - Cell identifier
   * @param reason - Optional lock reason
   */
  private _attemptLockAcquisition(cellId: string, reason?: string): void {
    const now = Date.now();
    const currentLock = this._locksMap.get(cellId);

    // Check if cell is already locked
    if (currentLock) {
      // Check if lock has expired
      if (now - currentLock.timestamp > this._options.lockTimeout) {
        // Lock expired, we can take it
        this._setLock(cellId, reason);
      } else if (currentLock.userId === this._currentUser.userId &&
                 currentLock.sessionId === this._currentUser.sessionId) {
        // We already own this lock
        this._resolveLockAcquisition(cellId, {
          success: true,
          lockInfo: currentLock
        });
      } else {
        // Lock is held by another user
        this._resolveLockAcquisition(cellId, {
          success: false,
          lockInfo: currentLock,
          error: `Cell is locked by ${currentLock.userName}`
        });
      }
    } else {
      // Cell is not locked, acquire it
      this._setLock(cellId, reason);
    }
  }

  /**
   * Set a lock for a cell
   * 
   * @private
   * @param cellId - Cell identifier
   * @param reason - Optional lock reason
   */
  private _setLock(cellId: string, reason?: string): void {
    const lockInfo: CellLocks.ILockInfo = {
      userId: this._currentUser.userId,
      userName: this._currentUser.userName,
      userColor: this._currentUser.userColor,
      timestamp: Date.now(),
      sessionId: this._currentUser.sessionId,
      reason
    };

    // Use Yjs transaction for atomic operation
    this._ydoc.transact(() => {
      this._locksMap.set(cellId, lockInfo);
    });
  }

  /**
   * Resolve a lock acquisition promise
   * 
   * @private
   * @param cellId - Cell identifier
   * @param result - Lock acquisition result
   */
  private _resolveLockAcquisition(cellId: string, result: CellLocks.ILockResult): void {
    const promise = this._acquisitionPromises.get(cellId);
    if (promise) {
      window.clearTimeout(promise.timeout);
      promise.resolve(result);
      this._acquisitionPromises.delete(cellId);
    }
  }

  /**
   * Set up observer for lock map changes
   * 
   * @private
   */
  private _setupLockObserver(): void {
    this._locksMap.observe(this._onLockMapChange.bind(this));
  }

  /**
   * Handle changes to the lock map
   * 
   * @private
   * @param event - Yjs map event
   */
  private _onLockMapChange(event: Y.YMapEvent<CellLocks.ILockInfo>): void {
    if (this._isDisposed) {
      return;
    }

    event.changes.keys.forEach((change, cellId) => {
      if (change.action === 'add' || change.action === 'update') {
        const lockInfo = this._locksMap.get(cellId);
        if (lockInfo) {
          // Check if this is our lock acquisition
          if (lockInfo.userId === this._currentUser.userId &&
              lockInfo.sessionId === this._currentUser.sessionId) {
            this._resolveLockAcquisition(cellId, {
              success: true,
              lockInfo
            });
          }

          this._lockChanged.emit({
            cellId,
            lockInfo,
            type: 'acquired',
            userId: lockInfo.userId
          });
        }
      } else if (change.action === 'delete') {
        const oldValue = change.oldValue;
        this._lockChanged.emit({
          cellId,
          lockInfo: null,
          type: 'released',
          userId: oldValue?.userId || 'unknown'
        });
      }
    });
  }

  /**
   * Start the cleanup timer for expired locks
   * 
   * @private
   */
  private _startCleanupTimer(): void {
    this._cleanupTimer = window.setInterval(() => {
      this.cleanupExpiredLocks();
    }, this._options.cleanupInterval);
  }

  /**
   * Clear retry timer for a cell
   * 
   * @private
   * @param cellId - Cell identifier
   */
  private _clearRetryTimer(cellId: string): void {
    const timer = this._retryTimers.get(cellId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this._retryTimers.delete(cellId);
    }
  }
}

/**
 * Utility class for managing visual lock indicators
 * 
 * This class provides helper methods for displaying lock status in the UI
 */
export class LockIndicatorManager {
  private _lockManager: CellLockManager;
  private _cellElements = new Map<string, HTMLElement>();
  private _indicatorElements = new Map<string, HTMLElement>();

  /**
   * Create a new lock indicator manager
   * 
   * @param lockManager - Cell lock manager instance
   */
  constructor(lockManager: CellLockManager) {
    this._lockManager = lockManager;
    this._lockManager.lockChanged.connect(this._onLockChanged, this);
  }

  /**
   * Register a cell element for lock indication
   * 
   * @param cellId - Unique cell identifier
   * @param element - Cell DOM element
   */
  registerCell(cellId: string, element: HTMLElement): void {
    this._cellElements.set(cellId, element);
    this._updateCellIndicator(cellId);
  }

  /**
   * Unregister a cell element
   * 
   * @param cellId - Unique cell identifier
   */
  unregisterCell(cellId: string): void {
    this._removeCellIndicator(cellId);
    this._cellElements.delete(cellId);
  }

  /**
   * Create lock indicator element
   * 
   * @private
   * @param lockInfo - Lock information
   * @returns Lock indicator element
   */
  private _createLockIndicator(lockInfo: CellLocks.ILockInfo): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'jp-notebook-cell-lock-indicator';
    indicator.style.cssText = `
      position: absolute;
      top: 4px;
      right: 4px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background-color: ${lockInfo.userColor};
      border: 2px solid #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      z-index: 1000;
      cursor: help;
    `;

    indicator.title = `Locked by ${lockInfo.userName}`;
    
    return indicator;
  }

  /**
   * Update cell lock indicator
   * 
   * @private
   * @param cellId - Cell identifier
   */
  private _updateCellIndicator(cellId: string): void {
    const element = this._cellElements.get(cellId);
    if (!element) {
      return;
    }

    const lockInfo = this._lockManager.getLockInfo(cellId);
    
    if (lockInfo) {
      // Add lock indicator
      if (!this._indicatorElements.has(cellId)) {
        const indicator = this._createLockIndicator(lockInfo);
        element.style.position = 'relative';
        element.appendChild(indicator);
        this._indicatorElements.set(cellId, indicator);
      }
      
      // Add locked class for styling
      element.classList.add('jp-notebook-cell-locked');
      
      // Add different styling if locked by current user
      if (lockInfo.userId === this._lockManager.currentUser.userId) {
        element.classList.add('jp-notebook-cell-locked-self');
      } else {
        element.classList.add('jp-notebook-cell-locked-other');
      }
    } else {
      // Remove lock indicator
      this._removeCellIndicator(cellId);
    }
  }

  /**
   * Remove cell lock indicator
   * 
   * @private
   * @param cellId - Cell identifier
   */
  private _removeCellIndicator(cellId: string): void {
    const element = this._cellElements.get(cellId);
    const indicator = this._indicatorElements.get(cellId);
    
    if (element) {
      element.classList.remove(
        'jp-notebook-cell-locked',
        'jp-notebook-cell-locked-self',
        'jp-notebook-cell-locked-other'
      );
    }
    
    if (indicator && indicator.parentNode) {
      indicator.parentNode.removeChild(indicator);
      this._indicatorElements.delete(cellId);
    }
  }

  /**
   * Handle lock state changes
   * 
   * @private
   * @param sender - Lock manager instance
   * @param event - Lock event data
   */
  private _onLockChanged(sender: CellLockManager, event: CellLocks.ILockEvent): void {
    this._updateCellIndicator(event.cellId);
  }

  /**
   * Dispose of the indicator manager
   */
  dispose(): void {
    this._lockManager.lockChanged.disconnect(this._onLockChanged, this);
    
    // Remove all indicators
    this._cellElements.forEach((element, cellId) => {
      this._removeCellIndicator(cellId);
    });
    
    this._cellElements.clear();
    this._indicatorElements.clear();
  }
}

/**
 * Create a new cell lock manager instance
 * 
 * @param ydoc - Yjs document for collaboration
 * @param currentUser - Current user information
 * @param options - Lock configuration options
 * @returns New cell lock manager instance
 */
export function createCellLockManager(
  ydoc: Y.Doc,
  currentUser: CellLocks.IUserInfo,
  options?: CellLocks.ILockOptions
): CellLockManager {
  return new CellLockManager(ydoc, currentUser, options);
}

/**
 * Create a disposable that automatically releases locks for a cell when disposed
 * 
 * @param lockManager - Cell lock manager instance
 * @param cellId - Cell identifier
 * @returns Disposable that releases the lock
 */
export function createCellLockDisposable(
  lockManager: CellLockManager,
  cellId: string
): IDisposable {
  return new DisposableDelegate(() => {
    lockManager.releaseLock(cellId);
  });
}