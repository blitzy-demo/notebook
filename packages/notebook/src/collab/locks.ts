/**
 * Cell-level locking mechanism for collaborative notebook editing
 */

import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import { Cell } from '@jupyterlab/cells';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * Interface for lock status information
 */
export interface ILockInfo {
  /**
   * The ID of the cell being locked
   */
  cellId: string;

  /**
   * The user ID of the lock owner
   */
  userId: string;

  /**
   * The display name of the lock owner
   */
  userName: string;

  /**
   * The timestamp when the lock was acquired
   */
  timestamp: number;

  /**
   * The timestamp when the lock will expire if not renewed
   */
  expiresAt: number;

  /**
   * Optional metadata for the lock
   */
  metadata?: { [key: string]: any };
}

/**
 * Lock acquisition options
 */
export interface ILockOptions {
  /**
   * Force acquisition of the lock even if it's held by another user
   * (requires admin permissions)
   */
  force?: boolean;

  /**
   * Custom timeout in milliseconds for this lock
   */
  timeout?: number;

  /**
   * Additional metadata to store with the lock
   */
  metadata?: { [key: string]: any };
}

/**
 * Lock acquisition result
 */
export interface ILockResult {
  /**
   * Whether the lock was successfully acquired
   */
  success: boolean;

  /**
   * The lock information if successful
   */
  lock?: ILockInfo;

  /**
   * Error message if the lock acquisition failed
   */
  error?: string;

  /**
   * Current lock owner information if the lock is already held
   */
  currentOwner?: ILockInfo;
}

/**
 * Lock manager status
 */
export enum LockManagerStatus {
  /**
   * Lock manager is initializing
   */
  Initializing = 'initializing',

  /**
   * Lock manager is ready and operational
   */
  Ready = 'ready',

  /**
   * Lock manager is in a degraded state (some functionality may be limited)
   */
  Degraded = 'degraded',

  /**
   * Lock manager is disconnected from the collaboration server
   */
  Disconnected = 'disconnected'
}

/**
 * Lock manager interface for managing cell-level locks in collaborative notebooks
 */
export interface ILockManager extends IDisposable {
  /**
   * The current status of the lock manager
   */
  readonly status: LockManagerStatus;

  /**
   * Signal emitted when the lock manager status changes
   */
  readonly statusChanged: ISignal<ILockManager, LockManagerStatus>;

  /**
   * Signal emitted when a lock is acquired
   */
  readonly lockAcquired: ISignal<ILockManager, ILockInfo>;

  /**
   * Signal emitted when a lock is released
   */
  readonly lockReleased: ISignal<ILockManager, ILockInfo>;

  /**
   * Signal emitted when a lock acquisition fails
   */
  readonly lockFailed: ISignal<ILockManager, ILockResult>;

  /**
   * Signal emitted when a lock is about to expire
   */
  readonly lockExpiring: ISignal<ILockManager, ILockInfo>;

  /**
   * Attempt to acquire a lock on a cell
   *
   * @param cellId - The ID of the cell to lock
   * @param options - Lock acquisition options
   * @returns A promise that resolves to the lock result
   */
  acquireLock(cellId: string, options?: ILockOptions): Promise<ILockResult>;

  /**
   * Release a lock on a cell
   *
   * @param cellId - The ID of the cell to unlock
   * @returns A promise that resolves to true if the lock was released, false otherwise
   */
  releaseLock(cellId: string): Promise<boolean>;

  /**
   * Check if a cell is currently locked
   *
   * @param cellId - The ID of the cell to check
   * @returns The lock information if the cell is locked, null otherwise
   */
  getLock(cellId: string): ILockInfo | null;

  /**
   * Check if the current user holds the lock on a cell
   *
   * @param cellId - The ID of the cell to check
   * @returns True if the current user holds the lock, false otherwise
   */
  hasLock(cellId: string): boolean;

  /**
   * Get all active locks in the notebook
   *
   * @returns An array of all active locks
   */
  getAllLocks(): ILockInfo[];

  /**
   * Renew a lock to prevent it from expiring
   *
   * @param cellId - The ID of the cell whose lock should be renewed
   * @returns A promise that resolves to true if the lock was renewed, false otherwise
   */
  renewLock(cellId: string): Promise<boolean>;

  /**
   * Force release a lock (requires admin permissions)
   *
   * @param cellId - The ID of the cell to unlock
   * @returns A promise that resolves to true if the lock was released, false otherwise
   */
  forceReleaseLock(cellId: string): Promise<boolean>;

  /**
   * Release all locks held by the current user
   *
   * @returns A promise that resolves to true if all locks were released, false otherwise
   */
  releaseAllLocks(): Promise<boolean>;
}

/**
 * Lock manager configuration options
 */
export interface ILockManagerOptions {
  /**
   * The Yjs document to use for lock synchronization
   */
  ydoc: Y.Doc;

  /**
   * The awareness instance for user presence information
   */
  awareness: Awareness;

  /**
   * The current user's ID
   */
  userId: string;

  /**
   * The current user's display name
   */
  userName: string;

  /**
   * Whether the current user has admin permissions
   */
  isAdmin?: boolean;

  /**
   * Default lock timeout in milliseconds (default: 30000 ms = 30 seconds)
   */
  defaultTimeout?: number;

  /**
   * Timeout warning threshold in milliseconds before expiration (default: 5000 ms = 5 seconds)
   */
  warningThreshold?: number;

  /**
   * Auto-renewal interval in milliseconds (default: 10000 ms = 10 seconds)
   */
  renewalInterval?: number;
}

/**
 * Implementation of the ILockManager interface
 */
export class LockManager implements ILockManager {
  /**
   * Create a new LockManager instance
   *
   * @param options - The lock manager configuration options
   */
  constructor(options: ILockManagerOptions) {
    this._ydoc = options.ydoc;
    this._awareness = options.awareness;
    this._userId = options.userId;
    this._userName = options.userName;
    this._isAdmin = options.isAdmin || false;
    this._defaultTimeout = options.defaultTimeout || 30000; // 30 seconds default
    this._warningThreshold = options.warningThreshold || 5000; // 5 seconds before expiration
    this._renewalInterval = options.renewalInterval || 10000; // 10 seconds renewal interval

    // Initialize the shared locks map
    this._yLocks = this._ydoc.getMap<ILockInfo>('locks');

    // Set up event listeners
    this._yLocks.observe(this._onLocksChanged.bind(this));
    this._awareness.on('change', this._onAwarenessChange.bind(this));

    // Set up lock renewal timer
    this._renewalTimer = setInterval(() => {
      this._renewActiveLocks();
    }, this._renewalInterval);

    // Set up lock expiration checker
    this._expirationTimer = setInterval(() => {
      this._checkLockExpirations();
    }, 1000); // Check every second

    this._status = LockManagerStatus.Ready;
  }

  /**
   * The current status of the lock manager
   */
  get status(): LockManagerStatus {
    return this._status;
  }

  /**
   * Signal emitted when the lock manager status changes
   */
  get statusChanged(): ISignal<ILockManager, LockManagerStatus> {
    return this._statusChanged;
  }

  /**
   * Signal emitted when a lock is acquired
   */
  get lockAcquired(): ISignal<ILockManager, ILockInfo> {
    return this._lockAcquired;
  }

  /**
   * Signal emitted when a lock is released
   */
  get lockReleased(): ISignal<ILockManager, ILockInfo> {
    return this._lockReleased;
  }

  /**
   * Signal emitted when a lock acquisition fails
   */
  get lockFailed(): ISignal<ILockManager, ILockResult> {
    return this._lockFailed;
  }

  /**
   * Signal emitted when a lock is about to expire
   */
  get lockExpiring(): ISignal<ILockManager, ILockInfo> {
    return this._lockExpiring;
  }

  /**
   * Attempt to acquire a lock on a cell
   *
   * @param cellId - The ID of the cell to lock
   * @param options - Lock acquisition options
   * @returns A promise that resolves to the lock result
   */
  async acquireLock(cellId: string, options: ILockOptions = {}): Promise<ILockResult> {
    // Check if the lock manager is in a valid state
    if (this._status !== LockManagerStatus.Ready && this._status !== LockManagerStatus.Degraded) {
      return {
        success: false,
        error: `Lock manager is not ready (status: ${this._status})`
      };
    }

    // Check if the cell is already locked
    const existingLock = this.getLock(cellId);
    if (existingLock) {
      // If the current user already holds the lock, renew it
      if (existingLock.userId === this._userId) {
        const renewed = await this.renewLock(cellId);
        if (renewed) {
          return {
            success: true,
            lock: this.getLock(cellId)!
          };
        }
      }

      // If force option is set and user has admin permissions, override the lock
      if (options.force && this._isAdmin) {
        // We'll proceed to override the lock
      } else {
        // Otherwise, return failure with information about the current owner
        return {
          success: false,
          error: `Cell is already locked by ${existingLock.userName}`,
          currentOwner: existingLock
        };
      }
    }

    // Create a new lock
    const now = Date.now();
    const timeout = options.timeout || this._defaultTimeout;
    const lockInfo: ILockInfo = {
      cellId,
      userId: this._userId,
      userName: this._userName,
      timestamp: now,
      expiresAt: now + timeout,
      metadata: options.metadata || {}
    };

    try {
      // Update the shared locks map
      this._ydoc.transact(() => {
        this._yLocks.set(cellId, lockInfo);
      });

      // Return success
      return {
        success: true,
        lock: lockInfo
      };
    } catch (error) {
      // Return failure with error message
      return {
        success: false,
        error: `Failed to acquire lock: ${error.message}`
      };
    }
  }

  /**
   * Release a lock on a cell
   *
   * @param cellId - The ID of the cell to unlock
   * @returns A promise that resolves to true if the lock was released, false otherwise
   */
  async releaseLock(cellId: string): Promise<boolean> {
    // Check if the cell is locked
    const lock = this.getLock(cellId);
    if (!lock) {
      return false; // Cell is not locked
    }

    // Check if the current user holds the lock
    if (lock.userId !== this._userId) {
      return false; // Lock is held by another user
    }

    try {
      // Update the shared locks map
      this._ydoc.transact(() => {
        this._yLocks.delete(cellId);
      });

      return true;
    } catch (error) {
      console.error('Failed to release lock:', error);
      return false;
    }
  }

  /**
   * Check if a cell is currently locked
   *
   * @param cellId - The ID of the cell to check
   * @returns The lock information if the cell is locked, null otherwise
   */
  getLock(cellId: string): ILockInfo | null {
    const lock = this._yLocks.get(cellId);
    if (!lock) {
      return null;
    }

    // Check if the lock has expired
    if (lock.expiresAt < Date.now()) {
      // Automatically clean up expired locks
      this._cleanupExpiredLock(cellId, lock);
      return null;
    }

    return lock;
  }

  /**
   * Check if the current user holds the lock on a cell
   *
   * @param cellId - The ID of the cell to check
   * @returns True if the current user holds the lock, false otherwise
   */
  hasLock(cellId: string): boolean {
    const lock = this.getLock(cellId);
    return !!lock && lock.userId === this._userId;
  }

  /**
   * Get all active locks in the notebook
   *
   * @returns An array of all active locks
   */
  getAllLocks(): ILockInfo[] {
    const now = Date.now();
    const locks: ILockInfo[] = [];

    // Filter out expired locks
    this._yLocks.forEach((lock, cellId) => {
      if (lock.expiresAt >= now) {
        locks.push(lock);
      } else {
        // Clean up expired locks
        this._cleanupExpiredLock(cellId, lock);
      }
    });

    return locks;
  }

  /**
   * Renew a lock to prevent it from expiring
   *
   * @param cellId - The ID of the cell whose lock should be renewed
   * @returns A promise that resolves to true if the lock was renewed, false otherwise
   */
  async renewLock(cellId: string): Promise<boolean> {
    // Check if the cell is locked
    const lock = this.getLock(cellId);
    if (!lock) {
      return false; // Cell is not locked
    }

    // Check if the current user holds the lock
    if (lock.userId !== this._userId) {
      return false; // Lock is held by another user
    }

    try {
      // Update the lock expiration time
      const now = Date.now();
      const updatedLock: ILockInfo = {
        ...lock,
        timestamp: now,
        expiresAt: now + this._defaultTimeout
      };

      // Update the shared locks map
      this._ydoc.transact(() => {
        this._yLocks.set(cellId, updatedLock);
      });

      return true;
    } catch (error) {
      console.error('Failed to renew lock:', error);
      return false;
    }
  }

  /**
   * Force release a lock (requires admin permissions)
   *
   * @param cellId - The ID of the cell to unlock
   * @returns A promise that resolves to true if the lock was released, false otherwise
   */
  async forceReleaseLock(cellId: string): Promise<boolean> {
    // Check if the user has admin permissions
    if (!this._isAdmin) {
      return false; // User does not have admin permissions
    }

    // Check if the cell is locked
    const lock = this.getLock(cellId);
    if (!lock) {
      return true; // Cell is not locked, consider it a success
    }

    try {
      // Update the shared locks map
      this._ydoc.transact(() => {
        this._yLocks.delete(cellId);
      });

      return true;
    } catch (error) {
      console.error('Failed to force release lock:', error);
      return false;
    }
  }

  /**
   * Release all locks held by the current user
   *
   * @returns A promise that resolves to true if all locks were released, false otherwise
   */
  async releaseAllLocks(): Promise<boolean> {
    try {
      const userLocks = this.getAllLocks().filter(lock => lock.userId === this._userId);
      
      if (userLocks.length === 0) {
        return true; // No locks to release
      }

      // Update the shared locks map
      this._ydoc.transact(() => {
        for (const lock of userLocks) {
          this._yLocks.delete(lock.cellId);
        }
      });

      return true;
    } catch (error) {
      console.error('Failed to release all locks:', error);
      return false;
    }
  }

  /**
   * Dispose of the lock manager and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    // Clear timers
    if (this._renewalTimer) {
      clearInterval(this._renewalTimer);
      this._renewalTimer = null;
    }

    if (this._expirationTimer) {
      clearInterval(this._expirationTimer);
      this._expirationTimer = null;
    }

    // Release all locks held by this user
    this.releaseAllLocks().catch(error => {
      console.error('Error releasing locks during disposal:', error);
    });

    // Remove event listeners
    this._yLocks.unobserve(this._onLocksChanged.bind(this));
    this._awareness.off('change', this._onAwarenessChange.bind(this));

    this._isDisposed = true;
  }

  /**
   * Handle changes to the shared locks map
   *
   * @param event - The Y.js map event
   */
  private _onLocksChanged(event: Y.YMapEvent<ILockInfo>): void {
    // Process added or updated locks
    event.keysChanged.forEach(cellId => {
      if (this._yLocks.has(cellId)) {
        const lock = this._yLocks.get(cellId)!;
        this._lockAcquired.emit(lock);
      } else {
        // Lock was deleted
        const prevLock = event.changes.keys.get(cellId)?.oldValue as ILockInfo;
        if (prevLock) {
          this._lockReleased.emit(prevLock);
        }
      }
    });
  }

  /**
   * Handle changes to the awareness state
   *
   * @param changes - The awareness changes
   */
  private _onAwarenessChange(changes: { added: number[]; updated: number[]; removed: number[] }): void {
    // When users disconnect, release their locks
    if (changes.removed.length > 0) {
      this._releaseLocksForDisconnectedUsers(changes.removed);
    }
  }

  /**
   * Release locks for disconnected users
   *
   * @param userIds - The IDs of the disconnected users
   */
  private _releaseLocksForDisconnectedUsers(userIds: number[]): void {
    // Convert awareness client IDs to user IDs
    const disconnectedUserIds = userIds.map(clientId => {
      const state = this._awareness.getStates().get(clientId);
      return state?.user?.id;
    }).filter(Boolean) as string[];

    if (disconnectedUserIds.length === 0) {
      return;
    }

    // Find locks held by disconnected users
    const locksToRelease: string[] = [];
    this._yLocks.forEach((lock, cellId) => {
      if (disconnectedUserIds.includes(lock.userId)) {
        locksToRelease.push(cellId);
      }
    });

    if (locksToRelease.length === 0) {
      return;
    }

    // Release the locks
    this._ydoc.transact(() => {
      for (const cellId of locksToRelease) {
        const lock = this._yLocks.get(cellId);
        if (lock) {
          this._yLocks.delete(cellId);
          // We don't emit lockReleased here because it will be emitted by the _onLocksChanged handler
        }
      }
    });
  }

  /**
   * Renew all active locks held by the current user
   */
  private _renewActiveLocks(): void {
    const now = Date.now();
    const userLocks = this.getAllLocks().filter(lock => lock.userId === this._userId);

    if (userLocks.length === 0) {
      return;
    }

    // Update the locks in a single transaction
    this._ydoc.transact(() => {
      for (const lock of userLocks) {
        // Only renew locks that are not about to expire (to avoid race conditions)
        if (lock.expiresAt - now > this._warningThreshold) {
          const updatedLock: ILockInfo = {
            ...lock,
            expiresAt: now + this._defaultTimeout
          };
          this._yLocks.set(lock.cellId, updatedLock);
        }
      }
    });
  }

  /**
   * Check for locks that are about to expire and emit warnings
   */
  private _checkLockExpirations(): void {
    const now = Date.now();
    const userLocks = this.getAllLocks().filter(lock => lock.userId === this._userId);

    for (const lock of userLocks) {
      const timeRemaining = lock.expiresAt - now;
      
      // Emit warning for locks that are about to expire
      if (timeRemaining > 0 && timeRemaining <= this._warningThreshold) {
        this._lockExpiring.emit(lock);
      }
    }
  }

  /**
   * Clean up an expired lock
   *
   * @param cellId - The ID of the cell with the expired lock
   * @param lock - The expired lock information
   */
  private _cleanupExpiredLock(cellId: string, lock: ILockInfo): void {
    this._ydoc.transact(() => {
      // Only delete if it still exists and is still expired
      const currentLock = this._yLocks.get(cellId);
      if (currentLock && currentLock.expiresAt < Date.now()) {
        this._yLocks.delete(cellId);
        // We don't emit lockReleased here because it will be emitted by the _onLocksChanged handler
      }
    });
  }

  /**
   * Set the lock manager status and emit a status change event
   *
   * @param status - The new status
   */
  private _setStatus(status: LockManagerStatus): void {
    if (this._status !== status) {
      this._status = status;
      this._statusChanged.emit(status);
    }
  }

  private _ydoc: Y.Doc;
  private _awareness: Awareness;
  private _yLocks: Y.Map<ILockInfo>;
  private _userId: string;
  private _userName: string;
  private _isAdmin: boolean;
  private _defaultTimeout: number;
  private _warningThreshold: number;
  private _renewalInterval: number;
  private _renewalTimer: any | null = null;
  private _expirationTimer: any | null = null;
  private _status: LockManagerStatus = LockManagerStatus.Initializing;
  private _isDisposed = false;

  private _statusChanged = new Signal<ILockManager, LockManagerStatus>(this);
  private _lockAcquired = new Signal<ILockManager, ILockInfo>(this);
  private _lockReleased = new Signal<ILockManager, ILockInfo>(this);
  private _lockFailed = new Signal<ILockManager, ILockResult>(this);
  private _lockExpiring = new Signal<ILockManager, ILockInfo>(this);
}

/**
 * Create a lock manager for a notebook
 *
 * @param options - The lock manager configuration options
 * @returns A new lock manager instance
 */
export function createLockManager(options: ILockManagerOptions): ILockManager {
  return new LockManager(options);
}