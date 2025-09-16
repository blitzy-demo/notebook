/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * CellLockManager class implementing distributed cell-level locking protocol using
 * Yjs shared data structures. Prevents editing conflicts through lock acquisition,
 * timeout management, and automatic release mechanisms with visual feedback integration.
 *
 * This module implements a timestamp-based distributed locking protocol where:
 * - Lock states are stored in Y.Map keyed by cell ID
 * - Locks have configurable timeouts with automatic cleanup
 * - Queue management ensures fair access for multiple users
 * - Integration with awareness system handles disconnected users
 * - Events are emitted for reactive UI updates
 */

import * as Y from 'yjs';
import { Signal } from '@lumino/signaling';
import { UUID } from '@lumino/coreutils';

import { YjsNotebookProvider } from './provider';
import { ICellLockStatus } from '../tokens';
import { CollaborationAwareness } from './awareness';

/**
 * Configuration interface for CellLockManager initialization
 */
export interface ILockConfig {
  /**
   * Default timeout for lock acquisition in milliseconds
   */
  defaultTimeout?: number;

  /**
   * Timeout for queue processing in milliseconds
   */
  queueTimeout?: number;

  /**
   * Maximum number of users that can be queued for a single cell
   */
  maxQueueSize?: number;

  /**
   * Interval for cleanup of expired locks in milliseconds
   */
  cleanupInterval?: number;

  /**
   * Whether to enable automatic lock cleanup
   */
  enableAutoCleanup?: boolean;

  /**
   * Grace period for lock release after user disconnect
   */
  disconnectGracePeriod?: number;

  /**
   * Whether to pause locking in single-user mode
   */
  pauseInSingleUserMode?: boolean;
}

/**
 * Default lock timeout in milliseconds (30 seconds)
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 30000;

/**
 * Default queue timeout in milliseconds (60 seconds)
 */
export const LOCK_QUEUE_TIMEOUT_MS = 60000;

/**
 * Lock error codes for different failure scenarios
 */
export enum LockErrorCode {
  ALREADY_LOCKED = 'ALREADY_LOCKED',
  TIMEOUT_EXPIRED = 'TIMEOUT_EXPIRED',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_CELL_ID = 'INVALID_CELL_ID',
  LOCK_NOT_HELD = 'LOCK_NOT_HELD',
  QUEUE_FULL = 'QUEUE_FULL',
  COLLABORATION_DISABLED = 'COLLABORATION_DISABLED',
  PROVIDER_NOT_CONNECTED = 'PROVIDER_NOT_CONNECTED'
}

/**
 * Specialized error class for lock-related failures
 */
export class LockError extends Error {
  /**
   * Error code identifying the specific lock failure
   */
  readonly code: LockErrorCode;

  /**
   * Cell ID associated with the lock error
   */
  readonly cellId: string;

  /**
   * Lock status at the time of error
   */
  readonly lockStatus: ICellLockStatus | null;

  constructor(
    code: LockErrorCode,
    message: string,
    cellId: string = '',
    lockStatus: ICellLockStatus | null = null
  ) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    this.cellId = cellId;
    this.lockStatus = lockStatus;
  }
}

/**
 * Internal lock state structure stored in Yjs Y.Map
 */
interface ILockState {
  cellId: string;
  lockedBy: string | null;
  lockTime: number | null; // timestamp
  lockId: string | null; // unique lock identifier
  timeout: number;
  isLocked: boolean;
  queuedUsers: string[];
}

/**
 * Internal queue entry for lock requests
 */
interface IQueueEntry {
  userId: string;
  timestamp: number;
  lockId: string;
  timeoutId?: any;
}

/**
 * CellLockManager class implementing distributed cell-level locking protocol
 */
export class CellLockManager {
  private _provider: YjsNotebookProvider;
  private _awareness: CollaborationAwareness;
  private _config: Required<ILockConfig>;
  private _lockStates: Y.Map<ILockState>;
  private _disposed: boolean = false;
  private _lockingPaused: boolean = false;

  // Queue management
  private _queueEntries: Map<string, IQueueEntry[]> = new Map();
  private _queueTimeouts: Map<string, any> = new Map();

  // Cleanup management
  private _cleanupTimer: any = null;
  private _lockTimeouts: Map<string, any> = new Map();

  // Event signaling
  private _lockChangeSignal = new Signal<CellLockManager, { cellId: string; status: ICellLockStatus }>(this);

  /**
   * Create a new CellLockManager instance
   */
  constructor(
    provider: YjsNotebookProvider,
    awareness: CollaborationAwareness,
    config: ILockConfig = {}
  ) {
    // Validate dependencies
    if (!provider) {
      throw new Error('YjsNotebookProvider is required for CellLockManager');
    }
    if (!awareness) {
      throw new Error('CollaborationAwareness is required for CellLockManager');
    }

    this._provider = provider;
    this._awareness = awareness;

    // Initialize configuration with defaults
    this._config = {
      defaultTimeout: config.defaultTimeout ?? DEFAULT_LOCK_TIMEOUT_MS,
      queueTimeout: config.queueTimeout ?? LOCK_QUEUE_TIMEOUT_MS,
      maxQueueSize: config.maxQueueSize ?? 10,
      cleanupInterval: config.cleanupInterval ?? 60000, // 1 minute
      enableAutoCleanup: config.enableAutoCleanup ?? true,
      disconnectGracePeriod: config.disconnectGracePeriod ?? 5000, // 5 seconds
      pauseInSingleUserMode: config.pauseInSingleUserMode ?? true
    };

    // Initialize Yjs map for lock states
    this._lockStates = this._provider.yjsDoc.getMap('cellLocks');

    // Set up event handlers
    this._setupEventHandlers();

    // Start cleanup timer if enabled
    if (this._config.enableAutoCleanup) {
      this._startCleanupTimer();
    }

    console.log('CellLockManager initialized with config:', this._config);
  }

  /**
   * Signal emitted when lock state changes
   */
  get onLockChange(): Signal<CellLockManager, { cellId: string; status: ICellLockStatus }> {
    return this._lockChangeSignal;
  }

  /**
   * Acquire exclusive lock on a cell for a specific user
   */
  async acquireLock(cellId: string, userId: string): Promise<boolean> {
    if (this._disposed) {
      throw new LockError(
        LockErrorCode.COLLABORATION_DISABLED,
        'CellLockManager has been disposed',
        cellId
      );
    }

    if (this._lockingPaused) {
      return true; // In single-user mode, always grant locks
    }

    if (!this._provider.isConnected()) {
      throw new LockError(
        LockErrorCode.PROVIDER_NOT_CONNECTED,
        'Cannot acquire lock: provider not connected',
        cellId
      );
    }

    if (!cellId || !userId) {
      throw new LockError(
        LockErrorCode.INVALID_CELL_ID,
        'Cell ID and User ID are required',
        cellId
      );
    }

    // Check if user exists in awareness system
    if (!this._awareness.getUserById(userId)) {
      throw new LockError(
        LockErrorCode.USER_NOT_FOUND,
        `User ${userId} not found in collaborative session`,
        cellId
      );
    }

    const currentState = this._getLockState(cellId);

    // If cell is already locked by same user, extend timeout
    if (currentState.isLocked && currentState.lockedBy === userId) {
      await this._extendLock(cellId, userId);
      return true;
    }

    // If cell is locked by another user, acquisition fails
    if (currentState.isLocked && currentState.lockedBy !== userId) {
      throw new LockError(
        LockErrorCode.ALREADY_LOCKED,
        `Cell ${cellId} is already locked by user ${currentState.lockedBy}`,
        cellId,
        this._convertToLockStatus(currentState)
      );
    }

    // Acquire the lock
    const lockId = UUID.uuid4();
    const now = Date.now();

    const newLockState: ILockState = {
      cellId,
      lockedBy: userId,
      lockTime: now,
      lockId,
      timeout: this._config.defaultTimeout,
      isLocked: true,
      queuedUsers: [...currentState.queuedUsers]
    };

    // Update Yjs state atomically
    this._lockStates.set(cellId, newLockState);

    // Set up automatic timeout
    this._setLockTimeout(cellId, lockId, this._config.defaultTimeout);

    // Emit lock change event
    this._emitLockChange(cellId, newLockState);

    console.log(`Lock acquired for cell ${cellId} by user ${userId}`);
    return true;
  }

  /**
   * Release lock on a cell for a specific user
   */
  async releaseLock(cellId: string, userId: string): Promise<void> {
    if (this._disposed) {
      return;
    }

    if (this._lockingPaused) {
      return; // In single-user mode, no locks to release
    }

    if (!cellId || !userId) {
      throw new LockError(
        LockErrorCode.INVALID_CELL_ID,
        'Cell ID and User ID are required',
        cellId
      );
    }

    const currentState = this._getLockState(cellId);

    // Check if user holds the lock
    if (!currentState.isLocked || currentState.lockedBy !== userId) {
      throw new LockError(
        LockErrorCode.LOCK_NOT_HELD,
        `User ${userId} does not hold lock for cell ${cellId}`,
        cellId,
        this._convertToLockStatus(currentState)
      );
    }

    // Clear timeout for this lock
    if (currentState.lockId) {
      this._clearLockTimeout(cellId, currentState.lockId);
    }

    // Release the lock
    const releasedState: ILockState = {
      ...currentState,
      lockedBy: null,
      lockTime: null,
      lockId: null,
      isLocked: false
    };

    this._lockStates.set(cellId, releasedState);

    // Process queue for this cell
    await this._processQueue(cellId);

    // Emit lock change event
    this._emitLockChange(cellId, releasedState);

    console.log(`Lock released for cell ${cellId} by user ${userId}`);
  }

  /**
   * Check if a cell is currently locked
   */
  isLocked(cellId: string): boolean {
    if (this._disposed || this._lockingPaused) {
      return false;
    }

    const state = this._getLockState(cellId);
    return state.isLocked && this._isLockValid(state);
  }

  /**
   * Get detailed lock status for a cell
   */
  lockStatus(cellId: string): ICellLockStatus | null {
    if (this._disposed) {
      return null;
    }

    const state = this._getLockState(cellId);
    return this._convertToLockStatus(state);
  }

  /**
   * Transfer lock ownership from one user to another
   */
  async transferLock(cellId: string, fromUserId: string, toUserId: string): Promise<boolean> {
    if (this._disposed) {
      throw new LockError(
        LockErrorCode.COLLABORATION_DISABLED,
        'CellLockManager has been disposed',
        cellId
      );
    }

    if (this._lockingPaused) {
      return true; // In single-user mode, always allow transfers
    }

    if (!cellId || !fromUserId || !toUserId) {
      throw new LockError(
        LockErrorCode.INVALID_CELL_ID,
        'Cell ID, from User ID, and to User ID are required',
        cellId
      );
    }

    // Verify both users exist
    if (!this._awareness.getUserById(fromUserId) || !this._awareness.getUserById(toUserId)) {
      throw new LockError(
        LockErrorCode.USER_NOT_FOUND,
        'One or both users not found in collaborative session',
        cellId
      );
    }

    const currentState = this._getLockState(cellId);

    // Verify fromUser holds the lock
    if (!currentState.isLocked || currentState.lockedBy !== fromUserId) {
      throw new LockError(
        LockErrorCode.LOCK_NOT_HELD,
        `User ${fromUserId} does not hold lock for cell ${cellId}`,
        cellId,
        this._convertToLockStatus(currentState)
      );
    }

    // Transfer lock
    const newLockId = UUID.uuid4();
    const transferredState: ILockState = {
      ...currentState,
      lockedBy: toUserId,
      lockId: newLockId,
      lockTime: Date.now() // Reset lock time for new owner
    };

    // Clear old timeout
    if (currentState.lockId) {
      this._clearLockTimeout(cellId, currentState.lockId);
    }

    // Set new timeout
    this._setLockTimeout(cellId, newLockId, this._config.defaultTimeout);

    // Update state
    this._lockStates.set(cellId, transferredState);

    // Emit lock change event
    this._emitLockChange(cellId, transferredState);

    console.log(`Lock transferred for cell ${cellId} from ${fromUserId} to ${toUserId}`);
    return true;
  }

  /**
   * Add user to lock acquisition queue for a cell
   */
  async queueLock(cellId: string, userId: string): Promise<void> {
    if (this._disposed) {
      throw new LockError(
        LockErrorCode.COLLABORATION_DISABLED,
        'CellLockManager has been disposed',
        cellId
      );
    }

    if (this._lockingPaused) {
      return; // In single-user mode, no queuing needed
    }

    if (!cellId || !userId) {
      throw new LockError(
        LockErrorCode.INVALID_CELL_ID,
        'Cell ID and User ID are required',
        cellId
      );
    }

    // Verify user exists
    if (!this._awareness.getUserById(userId)) {
      throw new LockError(
        LockErrorCode.USER_NOT_FOUND,
        `User ${userId} not found in collaborative session`,
        cellId
      );
    }

    const currentState = this._getLockState(cellId);

    // Don't queue if user already holds the lock
    if (currentState.isLocked && currentState.lockedBy === userId) {
      return;
    }

    // Don't queue if user is already in queue
    if (currentState.queuedUsers.includes(userId)) {
      return;
    }

    // Check queue size limit
    if (currentState.queuedUsers.length >= this._config.maxQueueSize) {
      throw new LockError(
        LockErrorCode.QUEUE_FULL,
        `Queue for cell ${cellId} is full (max ${this._config.maxQueueSize})`,
        cellId,
        this._convertToLockStatus(currentState)
      );
    }

    // Add user to queue
    const updatedState: ILockState = {
      ...currentState,
      queuedUsers: [...currentState.queuedUsers, userId]
    };

    this._lockStates.set(cellId, updatedState);

    // Set up queue timeout
    this._setQueueTimeout(cellId, userId);

    // Emit lock change event
    this._emitLockChange(cellId, updatedState);

    console.log(`User ${userId} queued for lock on cell ${cellId}`);
  }

  /**
   * Set timeout for automatic lock release
   */
  setLockTimeout(timeout: number): void {
    if (timeout <= 0) {
      throw new Error('Lock timeout must be positive');
    }

    this._config.defaultTimeout = timeout;
    console.log('Default lock timeout updated to:', timeout, 'ms');
  }

  /**
   * Clean up stale or expired locks
   */
  async cleanupLocks(): Promise<void> {
    if (this._disposed || this._lockingPaused) {
      return;
    }

    const now = Date.now();
    const lockStates = Array.from(this._lockStates.entries());
    let cleanedCount = 0;

    for (const [cellId, state] of lockStates) {
      if (this._isLockExpired(state, now)) {
        await this._forceReleaseLock(cellId, 'Expired lock cleanup');
        cleanedCount++;
      }
    }

    console.log(`Cleaned up ${cleanedCount} expired locks`);
  }

  /**
   * Get all locks currently held by a specific user
   */
  getLocksByUser(userId: string): ICellLockStatus[] {
    if (this._disposed || !userId) {
      return [];
    }

    const userLocks: ICellLockStatus[] = [];

    const lockEntries = Array.from(this._lockStates.entries());
    for (const [, state] of lockEntries) {
      if (state.isLocked && state.lockedBy === userId && this._isLockValid(state)) {
        userLocks.push(this._convertToLockStatus(state));
      }
    }

    return userLocks;
  }

  /**
   * Get all current lock states across all cells
   */
  getAllLocks(): ICellLockStatus[] {
    if (this._disposed) {
      return [];
    }

    const allLocks: ICellLockStatus[] = [];

    const allEntries = Array.from(this._lockStates.entries());
    for (const [, state] of allEntries) {
      if (this._isLockValid(state)) {
        allLocks.push(this._convertToLockStatus(state));
      }
    }

    return allLocks;
  }

  /**
   * Clear all expired locks based on timeout
   */
  async clearExpiredLocks(): Promise<void> {
    if (this._disposed || this._lockingPaused) {
      return;
    }

    const now = Date.now();
    const expiredCells: string[] = [];

    const stateEntries = Array.from(this._lockStates.entries());
    for (const [cellId, state] of stateEntries) {
      if (this._isLockExpired(state, now)) {
        expiredCells.push(cellId);
      }
    }

    // Force release all expired locks
    for (const cellId of expiredCells) {
      await this._forceReleaseLock(cellId, 'Expired lock cleared');
    }

    console.log(`Cleared ${expiredCells.length} expired locks`);
  }

  /**
   * Pause locking mechanism (typically for single-user mode)
   */
  pauseLocking(): void {
    if (this._disposed) {
      return;
    }

    this._lockingPaused = true;

    // Clear all current locks when pausing
    this._clearAllLocks();

    console.log('Cell locking paused');
  }

  /**
   * Resume locking mechanism (typically when entering collaborative mode)
   */
  resumeLocking(): void {
    if (this._disposed) {
      return;
    }

    this._lockingPaused = false;

    console.log('Cell locking resumed');
  }

  /**
   * Dispose of the lock manager and clean up all resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Clear all timers
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    // Clear all lock timeouts
    const lockTimeoutValues = Array.from(this._lockTimeouts.values());
    for (const timeoutId of lockTimeoutValues) {
      clearTimeout(timeoutId);
    }
    this._lockTimeouts.clear();

    // Clear all queue timeouts
    const queueTimeoutValues = Array.from(this._queueTimeouts.values());
    for (const timeoutId of queueTimeoutValues) {
      clearTimeout(timeoutId);
    }
    this._queueTimeouts.clear();

    // Clear all locks
    this._clearAllLocks();

    // Clear collections
    this._queueEntries.clear();

    // Remove event handlers
    this._awareness.onUserLeave.disconnect(this._handleUserDisconnected, this);

    console.log('CellLockManager disposed');
  }

  /**
   * Set up event handlers for awareness and provider events
   */
  private _setupEventHandlers(): void {
    // Listen for user disconnect events to handle orphaned locks
    this._awareness.onUserLeave.connect(this._handleUserDisconnected, this);

    // Listen for Yjs map changes to track external lock state changes
    this._lockStates.observeDeep((events: any[], transaction: any) => {
      this._handleLockStateChange(events as Y.YMapEvent<ILockState>[]);
    });
  }

  /**
   * Handle user disconnection - clean up their locks after grace period
   */
  private _handleUserDisconnected(sender: CollaborationAwareness, user: any): void {
    if (this._disposed || this._lockingPaused) {
      return;
    }

    const userId = user.userId;
    if (!userId) {
      return;
    }

    // Set grace period timeout for disconnected user's locks
    setTimeout(async () => {
      // Check if user is still disconnected
      if (!this._awareness.getUserById(userId)) {
        await this._releaseLocksForUser(userId, 'User disconnected');
      }
    }, this._config.disconnectGracePeriod);
  }

  /**
   * Handle changes to lock state from external sources (other clients)
   */
  private _handleLockStateChange(events: Y.YMapEvent<ILockState>[]): void {
    if (this._disposed) {
      return;
    }

    for (const event of events) {
      const changedKeys = Array.from(event.changes.keys.entries());
      for (const [cellId] of changedKeys) {
        const state = this._lockStates.get(cellId);
        if (state) {
          this._emitLockChange(cellId, state);
        }
      }
    }
  }

  /**
   * Get current lock state for a cell, creating default if not exists
   */
  private _getLockState(cellId: string): ILockState {
    const existingState = this._lockStates.get(cellId);

    if (existingState) {
      return existingState;
    }

    // Create default empty lock state
    const defaultState: ILockState = {
      cellId,
      lockedBy: null,
      lockTime: null,
      lockId: null,
      timeout: this._config.defaultTimeout,
      isLocked: false,
      queuedUsers: []
    };

    return defaultState;
  }

  /**
   * Convert internal lock state to public ICellLockStatus interface
   */
  private _convertToLockStatus(state: ILockState): ICellLockStatus {
    return {
      cellId: state.cellId,
      lockedBy: state.lockedBy,
      lockTime: state.lockTime ? new Date(state.lockTime) : null,
      timeout: state.timeout,
      isLocked: state.isLocked && this._isLockValid(state),
      queuedUsers: [...state.queuedUsers]
    };
  }

  /**
   * Check if a lock state is valid (not expired)
   */
  private _isLockValid(state: ILockState): boolean {
    if (!state.isLocked || !state.lockTime) {
      return false;
    }

    return !this._isLockExpired(state, Date.now());
  }

  /**
   * Check if a lock has expired based on timestamp
   */
  private _isLockExpired(state: ILockState, currentTime: number): boolean {
    if (!state.isLocked || !state.lockTime) {
      return false;
    }

    return (currentTime - state.lockTime) > state.timeout;
  }

  /**
   * Extend lock timeout for current owner
   */
  private async _extendLock(cellId: string, userId: string): Promise<void> {
    const currentState = this._getLockState(cellId);

    if (currentState.isLocked && currentState.lockedBy === userId) {
      const extendedState: ILockState = {
        ...currentState,
        lockTime: Date.now() // Reset lock time
      };

      this._lockStates.set(cellId, extendedState);

      // Reset timeout
      if (currentState.lockId) {
        this._clearLockTimeout(cellId, currentState.lockId);
        this._setLockTimeout(cellId, currentState.lockId, this._config.defaultTimeout);
      }

      console.log(`Lock extended for cell ${cellId} by user ${userId}`);
    }
  }

  /**
   * Set automatic timeout for a lock
   */
  private _setLockTimeout(cellId: string, lockId: string, timeoutMs: number): void {
    const timeoutKey = `${cellId}:${lockId}`;

    // Clear existing timeout
    this._clearLockTimeout(cellId, lockId);

    // Set new timeout
    const timeoutId = setTimeout(async () => {
      await this._handleLockTimeout(cellId, lockId);
    }, timeoutMs);

    this._lockTimeouts.set(timeoutKey, timeoutId);
  }

  /**
   * Clear automatic timeout for a lock
   */
  private _clearLockTimeout(cellId: string, lockId: string): void {
    const timeoutKey = `${cellId}:${lockId}`;
    const timeoutId = this._lockTimeouts.get(timeoutKey);

    if (timeoutId) {
      clearTimeout(timeoutId);
      this._lockTimeouts.delete(timeoutKey);
    }
  }

  /**
   * Handle lock timeout expiration
   */
  private async _handleLockTimeout(cellId: string, lockId: string): Promise<void> {
    const currentState = this._getLockState(cellId);

    // Only timeout if this is still the current lock
    if (currentState.isLocked && currentState.lockId === lockId) {
      await this._forceReleaseLock(cellId, 'Lock timeout expired');
    }
  }

  /**
   * Force release a lock without user interaction
   */
  private async _forceReleaseLock(cellId: string, reason: string): Promise<void> {
    const currentState = this._getLockState(cellId);

    if (!currentState.isLocked) {
      return;
    }

    // Clear timeout
    if (currentState.lockId) {
      this._clearLockTimeout(cellId, currentState.lockId);
    }

    // Release the lock
    const releasedState: ILockState = {
      ...currentState,
      lockedBy: null,
      lockTime: null,
      lockId: null,
      isLocked: false
    };

    this._lockStates.set(cellId, releasedState);

    // Process queue
    await this._processQueue(cellId);

    // Emit event
    this._emitLockChange(cellId, releasedState);

    console.log(`Lock force released for cell ${cellId}: ${reason}`);
  }

  /**
   * Process lock queue for a cell after lock release
   */
  private async _processQueue(cellId: string): Promise<void> {
    const currentState = this._getLockState(cellId);

    if (currentState.queuedUsers.length === 0 || currentState.isLocked) {
      return;
    }

    // Get next user from queue (FIFO)
    const nextUserId = currentState.queuedUsers[0];

    // Verify user still exists and is active
    if (!this._awareness.getUserById(nextUserId)) {
      // Remove invalid user from queue
      const updatedQueue = currentState.queuedUsers.slice(1);
      const queueState: ILockState = {
        ...currentState,
        queuedUsers: updatedQueue
      };
      this._lockStates.set(cellId, queueState);

      // Try next user in queue
      await this._processQueue(cellId);
      return;
    }

    try {
      // Grant lock to next user
      await this.acquireLock(cellId, nextUserId);

      // Remove user from queue
      const updatedQueue = currentState.queuedUsers.slice(1);
      const newState = this._getLockState(cellId);
      const finalState: ILockState = {
        ...newState,
        queuedUsers: updatedQueue
      };
      this._lockStates.set(cellId, finalState);

      console.log(`Lock granted from queue to user ${nextUserId} for cell ${cellId}`);
    } catch (error) {
      console.error(`Failed to grant lock from queue to user ${nextUserId}:`, error);

      // Remove failed user from queue and try next
      const updatedQueue = currentState.queuedUsers.slice(1);
      const queueState: ILockState = {
        ...currentState,
        queuedUsers: updatedQueue
      };
      this._lockStates.set(cellId, queueState);

      await this._processQueue(cellId);
    }
  }

  /**
   * Set timeout for queue entries
   */
  private _setQueueTimeout(cellId: string, userId: string): void {
    const queueKey = `${cellId}:${userId}`;

    // Clear existing timeout
    const existingTimeout = this._queueTimeouts.get(queueKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeoutId = setTimeout(() => {
      this._handleQueueTimeout(cellId, userId);
    }, this._config.queueTimeout);

    this._queueTimeouts.set(queueKey, timeoutId);
  }

  /**
   * Handle queue entry timeout
   */
  private _handleQueueTimeout(cellId: string, userId: string): void {
    const currentState = this._getLockState(cellId);

    // Remove user from queue
    const updatedQueue = currentState.queuedUsers.filter(id => id !== userId);

    if (updatedQueue.length !== currentState.queuedUsers.length) {
      const queueState: ILockState = {
        ...currentState,
        queuedUsers: updatedQueue
      };

      this._lockStates.set(cellId, queueState);
      this._emitLockChange(cellId, queueState);

      console.log(`User ${userId} removed from queue for cell ${cellId} due to timeout`);
    }

    // Clean up queue timeout
    const queueKey = `${cellId}:${userId}`;
    this._queueTimeouts.delete(queueKey);
  }

  /**
   * Release all locks held by a specific user
   */
  private async _releaseLocksForUser(userId: string, reason: string): Promise<void> {
    const userLocks = this.getLocksByUser(userId);

    for (const lockStatus of userLocks) {
      try {
        await this._forceReleaseLock(lockStatus.cellId, `${reason} - user ${userId}`);
      } catch (error) {
        console.error(`Failed to release lock for cell ${lockStatus.cellId}:`, error);
      }
    }

    if (userLocks.length > 0) {
      console.log(`Released ${userLocks.length} locks for user ${userId}: ${reason}`);
    }
  }

  /**
   * Clear all locks (used when pausing locking)
   */
  private _clearAllLocks(): void {
    const allCells = Array.from(this._lockStates.keys());

    for (const cellId of allCells) {
      const currentState = this._getLockState(cellId);

      if (currentState.isLocked) {
        const clearedState: ILockState = {
          ...currentState,
          lockedBy: null,
          lockTime: null,
          lockId: null,
          isLocked: false,
          queuedUsers: [] // Clear queue as well
        };

        this._lockStates.set(cellId, clearedState);
      }
    }

    // Clear all timeouts
    const lockTimeouts = Array.from(this._lockTimeouts.values());
    for (const timeoutId of lockTimeouts) {
      clearTimeout(timeoutId);
    }
    this._lockTimeouts.clear();

    const queueTimeouts = Array.from(this._queueTimeouts.values());
    for (const timeoutId of queueTimeouts) {
      clearTimeout(timeoutId);
    }
    this._queueTimeouts.clear();

    console.log('All locks cleared');
  }

  /**
   * Start automatic cleanup timer
   */
  private _startCleanupTimer(): void {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }

    this._cleanupTimer = setInterval(async () => {
      if (!this._disposed && !this._lockingPaused) {
        await this.cleanupLocks();
      }
    }, this._config.cleanupInterval);
  }

  /**
   * Emit lock change event for reactive UI updates
   */
  private _emitLockChange(cellId: string, state: ILockState): void {
    if (this._disposed) {
      return;
    }

    const status = this._convertToLockStatus(state);
    this._lockChangeSignal.emit({ cellId, status });
  }
}
