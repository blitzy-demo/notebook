/**
 * @fileoverview Sophisticated cell-level locking system for collaborative Jupyter Notebook editing.
 * 
 * This module implements intelligent lock acquisition, timeout management, and coordinated
 * release mechanisms to prevent editing conflicts in real-time collaborative sessions.
 * Features include Redis-based distributed coordination, queue-based contention resolution,
 * automatic timeout policies, and administrative force-override capabilities.
 * 
 * @version 1.0.0
 * @author Jupyter Collaboration Team
 */

import { Signal, ISignal } from '@lumino/signaling';
import { Disposable, IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import { ICollaborationProvider } from './YjsNotebookProvider';
import { IUserAwareness } from './awareness';

/**
 * Configuration interface for lock timeout policies and behavior settings.
 */
export interface ILockConfiguration {
  /** Default lock timeout in milliseconds (default: 30000 = 30s) */
  readonly defaultTimeout: number;
  /** Maximum allowed lock timeout in milliseconds (default: 300000 = 5min) */
  readonly maxTimeout: number;
  /** Queue timeout for waiting locks in milliseconds (default: 60000 = 1min) */
  readonly queueTimeout: number;
  /** Heartbeat interval for lock renewal in milliseconds (default: 10000 = 10s) */
  readonly heartbeatInterval: number;
  /** Maximum retries for lock acquisition (default: 3) */
  readonly maxRetries: number;
  /** Enable automatic lock release on user inactivity (default: true) */
  readonly autoReleaseOnInactivity: boolean;
  /** Inactivity timeout in milliseconds (default: 120000 = 2min) */
  readonly inactivityTimeout: number;
  /** Enable Redis clustering support (default: false) */
  readonly enableClustering: boolean;
  /** Redis key prefix for lock namespacing (default: 'jupyter:collab:locks') */
  readonly redisKeyPrefix: string;
}

/**
 * Default lock configuration with production-ready settings.
 */
export const DEFAULT_LOCK_CONFIG: ILockConfiguration = {
  defaultTimeout: 30000,
  maxTimeout: 300000,
  queueTimeout: 60000,
  heartbeatInterval: 10000,
  maxRetries: 3,
  autoReleaseOnInactivity: true,
  inactivityTimeout: 120000,
  enableClustering: false,
  redisKeyPrefix: 'jupyter:collab:locks'
};

/**
 * Lock status enumeration representing different states of cell locks.
 */
export enum LockStatus {
  /** Lock is available and can be acquired */
  Available = 'available',
  /** Lock is currently held by a user */
  Locked = 'locked',
  /** Lock is pending acquisition (queued) */
  Pending = 'pending',
  /** Lock acquisition failed due to timeout or error */
  Failed = 'failed',
  /** Lock is being released */
  Releasing = 'releasing',
  /** Lock was force-released by administrator */
  ForceReleased = 'force_released'
}

/**
 * Lock priority levels for queue management and administrative override.
 */
export enum LockPriority {
  /** Standard user lock request */
  Normal = 0,
  /** High priority for administrative actions */
  High = 1,
  /** Critical priority for system operations */
  Critical = 2,
  /** Emergency override (force-unlock capability) */
  Emergency = 3
}

/**
 * Comprehensive lock metadata containing ownership, timing, and state information.
 */
export interface ILockMetadata {
  /** Unique identifier for the lock */
  readonly lockId: string;
  /** Cell identifier this lock protects */
  readonly cellId: string;
  /** User ID who owns the lock */
  readonly userId: string;
  /** User display name for UI purposes */
  readonly userName: string;
  /** Session ID for distributed coordination */
  readonly sessionId: string;
  /** Lock priority level */
  readonly priority: LockPriority;
  /** Current lock status */
  readonly status: LockStatus;
  /** Timestamp when lock was acquired (ISO 8601) */
  readonly acquiredAt: string;
  /** Timestamp when lock expires (ISO 8601) */
  readonly expiresAt: string;
  /** Last heartbeat timestamp (ISO 8601) */
  readonly lastHeartbeat: string;
  /** Lock timeout duration in milliseconds */
  readonly timeoutMs: number;
  /** Number of acquisition attempts */
  readonly attempts: number;
  /** Queue position if pending (0-based) */
  readonly queuePosition?: number;
  /** Additional metadata for extensibility */
  readonly metadata?: Record<string, any>;
}

/**
 * Lock acquisition request with user context and configuration.
 */
export interface ILockRequest {
  /** Cell identifier to lock */
  readonly cellId: string;
  /** User requesting the lock */
  readonly userId: string;
  /** User display name */
  readonly userName: string;
  /** Session identifier */
  readonly sessionId: string;
  /** Request priority level */
  readonly priority?: LockPriority;
  /** Custom timeout in milliseconds */
  readonly timeoutMs?: number;
  /** Force acquisition even if locked */
  readonly force?: boolean;
  /** Additional request metadata */
  readonly metadata?: Record<string, any>;
}

/**
 * Lock release request with reason and cleanup options.
 */
export interface ILockReleaseRequest {
  /** Lock identifier to release */
  readonly lockId: string;
  /** User requesting the release */
  readonly userId: string;
  /** Session identifier */
  readonly sessionId: string;
  /** Reason for release */
  readonly reason?: string;
  /** Force release even if not owner */
  readonly force?: boolean;
  /** Clean up all locks for this user */
  readonly cleanupUser?: boolean;
}

/**
 * Queue entry for managing lock acquisition requests.
 */
export interface ILockQueueEntry {
  /** Queue entry identifier */
  readonly entryId: string;
  /** Lock request details */
  readonly request: ILockRequest;
  /** Timestamp when queued (ISO 8601) */
  readonly queuedAt: string;
  /** Queue timeout timestamp (ISO 8601) */
  readonly queueExpiresAt: string;
  /** Current queue position */
  readonly position: number;
  /** Callback for successful acquisition */
  readonly onSuccess?: (lock: ILockMetadata) => void;
  /** Callback for acquisition failure */
  readonly onFailure?: (error: Error) => void;
}

/**
 * Lock event data for broadcasting state changes to collaboration participants.
 */
export interface ILockEvent {
  /** Event type identifier */
  readonly type: 'acquired' | 'released' | 'queued' | 'failed' | 'expired' | 'force_released';
  /** Lock metadata */
  readonly lock: ILockMetadata;
  /** Timestamp of the event (ISO 8601) */
  readonly timestamp: string;
  /** Session ID where event originated */
  readonly sessionId: string;
  /** Additional event context */
  readonly context?: Record<string, any>;
}

/**
 * Redis-based lock storage interface for distributed coordination.
 */
export interface ILockStorage {
  /** 
   * Atomically acquire a lock with Redis SET NX EX operation.
   * @param lockId - Unique lock identifier
   * @param metadata - Lock metadata to store
   * @param timeoutMs - Lock timeout in milliseconds
   * @returns Promise resolving to success status
   */
  acquireLock(lockId: string, metadata: ILockMetadata, timeoutMs: number): Promise<boolean>;

  /**
   * Release a lock with ownership validation.
   * @param lockId - Lock identifier to release
   * @param userId - User requesting release
   * @param force - Force release without ownership check
   * @returns Promise resolving to release success
   */
  releaseLock(lockId: string, userId: string, force?: boolean): Promise<boolean>;

  /**
   * Retrieve lock metadata by lock identifier.
   * @param lockId - Lock identifier to query
   * @returns Promise resolving to lock metadata or null
   */
  getLock(lockId: string): Promise<ILockMetadata | null>;

  /**
   * List all active locks for a session or user.
   * @param sessionId - Optional session filter
   * @param userId - Optional user filter
   * @returns Promise resolving to array of lock metadata
   */
  listLocks(sessionId?: string, userId?: string): Promise<ILockMetadata[]>;

  /**
   * Update lock heartbeat to prevent expiration.
   * @param lockId - Lock identifier to update
   * @param userId - User performing heartbeat
   * @returns Promise resolving to success status
   */
  heartbeat(lockId: string, userId: string): Promise<boolean>;

  /**
   * Force release expired locks (cleanup operation).
   * @returns Promise resolving to number of released locks
   */
  cleanupExpiredLocks(): Promise<number>;

  /**
   * Add request to lock acquisition queue.
   * @param cellId - Cell identifier
   * @param entry - Queue entry to add
   * @returns Promise resolving to queue position
   */
  enqueueRequest(cellId: string, entry: ILockQueueEntry): Promise<number>;

  /**
   * Remove request from lock acquisition queue.
   * @param cellId - Cell identifier
   * @param entryId - Queue entry to remove
   * @returns Promise resolving to removal success
   */
  dequeueRequest(cellId: string, entryId: string): Promise<boolean>;

  /**
   * Get next queued request for a cell.
   * @param cellId - Cell identifier
   * @returns Promise resolving to next queue entry or null
   */
  getNextQueuedRequest(cellId: string): Promise<ILockQueueEntry | null>;
}

/**
 * WebSocket communication interface for broadcasting lock events.
 */
export interface ILockBroadcaster {
  /**
   * Broadcast lock event to all session participants.
   * @param event - Lock event to broadcast
   * @param sessionId - Target session identifier
   */
  broadcastLockEvent(event: ILockEvent, sessionId: string): Promise<void>;

  /**
   * Subscribe to lock events for a session.
   * @param sessionId - Session to monitor
   * @param callback - Event handler function
   * @returns Disposable for unsubscribing
   */
  subscribeLockEvents(sessionId: string, callback: (event: ILockEvent) => void): IDisposable;
}

/**
 * Core lock manager class implementing sophisticated cell-level locking with Redis coordination.
 * 
 * Features:
 * - Distributed lock coordination using Redis atomic operations
 * - Queue-based lock contention resolution with configurable timeouts
 * - Automatic lock expiration and heartbeat-based renewal
 * - Administrative force-override capabilities with proper authorization
 * - Real-time lock status broadcasting via WebSocket communication
 * - Cross-instance coordination for clustered deployments
 */
export class LockManager implements IDisposable {
  private readonly _config: ILockConfiguration;
  private readonly _storage: ILockStorage;
  private readonly _broadcaster: ILockBroadcaster;
  private readonly _awareness: IUserAwareness;
  private readonly _sessionId: string;
  private readonly _userId: string;
  private readonly _userName: string;
  private readonly _isDisposed = new Signal<this, void>(this);
  private readonly _lockAcquired = new Signal<this, ILockEvent>(this);
  private readonly _lockReleased = new Signal<this, ILockEvent>(this);
  private readonly _lockFailed = new Signal<this, ILockEvent>(this);
  private readonly _disposables = new Set<IDisposable>();
  private readonly _activeLocks = new Map<string, ILockMetadata>();
  private readonly _queuedRequests = new Map<string, ILockQueueEntry>();
  private readonly _heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly _inactivityTimer: NodeJS.Timeout;
  private _disposed = false;

  /**
   * Initialize lock manager with configuration and coordination services.
   * 
   * @param options - Configuration and service dependencies
   */
  constructor(options: {
    config?: Partial<ILockConfiguration>;
    storage: ILockStorage;
    broadcaster: ILockBroadcaster;
    awareness: IUserAwareness;
    sessionId: string;
    userId: string;
    userName: string;
  }) {
    this._config = { ...DEFAULT_LOCK_CONFIG, ...options.config };
    this._storage = options.storage;
    this._broadcaster = options.broadcaster;
    this._awareness = options.awareness;
    this._sessionId = options.sessionId;
    this._userId = options.userId;
    this._userName = options.userName;

    // Initialize WebSocket event subscription
    this._disposables.add(
      this._broadcaster.subscribeLockEvents(this._sessionId, this._handleLockEvent.bind(this))
    );

    // Set up periodic cleanup and heartbeat
    this._setupPeriodicMaintenance();

    // Initialize inactivity monitoring
    this._inactivityTimer = this._setupInactivityMonitoring();
  }

  /**
   * Signal emitted when the lock manager is disposed.
   */
  get isDisposed(): ISignal<this, void> {
    return this._isDisposed;
  }

  /**
   * Signal emitted when a lock is successfully acquired.
   */
  get lockAcquired(): ISignal<this, ILockEvent> {
    return this._lockAcquired;
  }

  /**
   * Signal emitted when a lock is released.
   */
  get lockReleased(): ISignal<this, ILockEvent> {
    return this._lockReleased;
  }

  /**
   * Signal emitted when lock acquisition fails.
   */
  get lockFailed(): ISignal<this, ILockEvent> {
    return this._lockFailed;
  }

  /**
   * Get current lock configuration.
   */
  get config(): ILockConfiguration {
    return { ...this._config };
  }

  /**
   * Check if the manager has been disposed.
   */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Get the current session identifier.
   */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Get the current user identifier.
   */
  get userId(): string {
    return this._userId;
  }

  /**
   * Acquire a lock on a specific cell with intelligent queue management.
   * 
   * @param request - Lock acquisition request
   * @returns Promise resolving to lock metadata on success
   * @throws Error if acquisition fails or times out
   */
  async acquireLock(request: ILockRequest): Promise<ILockMetadata> {
    this._ensureNotDisposed();

    const lockId = this._generateLockId(request.cellId, request.userId);
    const timeoutMs = Math.min(
      request.timeoutMs || this._config.defaultTimeout,
      this._config.maxTimeout
    );
    const priority = request.priority || LockPriority.Normal;

    // Check if user already owns this lock
    const existingLock = await this._storage.getLock(lockId);
    if (existingLock && existingLock.userId === request.userId) {
      // Extend existing lock
      return this._renewLock(existingLock, timeoutMs);
    }

    // Check if cell is already locked by another user
    const cellLocks = await this._getCellLocks(request.cellId);
    const activeLock = cellLocks.find(lock => lock.status === LockStatus.Locked);

    if (activeLock && !request.force) {
      // Add to queue if not forcing
      return this._queueLockRequest(request, timeoutMs);
    }

    // Attempt immediate acquisition
    const lockMetadata: ILockMetadata = {
      lockId,
      cellId: request.cellId,
      userId: request.userId,
      userName: request.userName,
      sessionId: request.sessionId,
      priority,
      status: LockStatus.Locked,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      lastHeartbeat: new Date().toISOString(),
      timeoutMs,
      attempts: 1,
      metadata: request.metadata
    };

    const acquired = await this._storage.acquireLock(lockId, lockMetadata, timeoutMs);
    
    if (acquired) {
      return this._onLockAcquired(lockMetadata);
    } else {
      // Acquisition failed, either queue or throw
      if (request.force && priority >= LockPriority.High) {
        return this._forceLockAcquisition(request, lockMetadata);
      } else {
        return this._queueLockRequest(request, timeoutMs);
      }
    }
  }

  /**
   * Release a lock with proper cleanup and queue processing.
   * 
   * @param request - Lock release request
   * @returns Promise resolving to release success status
   */
  async releaseLock(request: ILockReleaseRequest): Promise<boolean> {
    this._ensureNotDisposed();

    const lock = await this._storage.getLock(request.lockId);
    if (!lock) {
      return false; // Lock doesn't exist
    }

    // Validate ownership unless forcing
    if (!request.force && lock.userId !== request.userId) {
      throw new Error(`User ${request.userId} does not own lock ${request.lockId}`);
    }

    // Release the lock
    const released = await this._storage.releaseLock(
      request.lockId, 
      request.userId, 
      request.force
    );

    if (released) {
      await this._onLockReleased(lock, request.reason || 'user_request');
      
      // Process next queued request for this cell
      await this._processNextQueuedRequest(lock.cellId);
      
      return true;
    }

    return false;
  }

  /**
   * Get lock status for a specific cell.
   * 
   * @param cellId - Cell identifier to query
   * @returns Promise resolving to current lock metadata or null
   */
  async getLockStatus(cellId: string): Promise<ILockMetadata | null> {
    this._ensureNotDisposed();
    
    const locks = await this._getCellLocks(cellId);
    return locks.find(lock => lock.status === LockStatus.Locked) || null;
  }

  /**
   * Check if current user can edit a specific cell.
   * 
   * @param cellId - Cell identifier to check
   * @returns Promise resolving to edit permission status
   */
  async canEdit(cellId: string): Promise<boolean> {
    this._ensureNotDisposed();
    
    const lock = await this.getLockStatus(cellId);
    return !lock || lock.userId === this._userId;
  }

  /**
   * List all active locks for the current session.
   * 
   * @param userId - Optional user filter
   * @returns Promise resolving to array of lock metadata
   */
  async listActiveLocks(userId?: string): Promise<ILockMetadata[]> {
    this._ensureNotDisposed();
    return this._storage.listLocks(this._sessionId, userId);
  }

  /**
   * Force release all locks for a specific user (administrative function).
   * 
   * @param targetUserId - User whose locks to release
   * @param reason - Reason for force release
   * @returns Promise resolving to number of released locks
   */
  async forceReleaseUserLocks(targetUserId: string, reason: string = 'admin_override'): Promise<number> {
    this._ensureNotDisposed();
    
    // Verify current user has administrative privileges
    if (!this._hasAdminPrivileges()) {
      throw new Error('Insufficient privileges for force release operation');
    }

    const userLocks = await this._storage.listLocks(this._sessionId, targetUserId);
    let releasedCount = 0;

    for (const lock of userLocks) {
      const released = await this._storage.releaseLock(lock.lockId, targetUserId, true);
      if (released) {
        await this._onLockReleased(lock, reason);
        await this._processNextQueuedRequest(lock.cellId);
        releasedCount++;
      }
    }

    return releasedCount;
  }

  /**
   * Get queue status for a specific cell.
   * 
   * @param cellId - Cell identifier to query
   * @returns Promise resolving to queue length and user position
   */
  async getQueueStatus(cellId: string): Promise<{ length: number; userPosition?: number }> {
    this._ensureNotDisposed();
    
    const userEntry = Array.from(this._queuedRequests.values())
      .find(entry => entry.request.cellId === cellId && entry.request.userId === this._userId);
    
    const queueLength = Array.from(this._queuedRequests.values())
      .filter(entry => entry.request.cellId === cellId).length;
    
    return {
      length: queueLength,
      userPosition: userEntry?.position
    };
  }

  /**
   * Cancel a queued lock request.
   * 
   * @param cellId - Cell identifier
   * @returns Promise resolving to cancellation success
   */
  async cancelQueuedRequest(cellId: string): Promise<boolean> {
    this._ensureNotDisposed();
    
    const userEntry = Array.from(this._queuedRequests.entries())
      .find(([_, entry]) => entry.request.cellId === cellId && entry.request.userId === this._userId);
    
    if (userEntry) {
      const [entryId, entry] = userEntry;
      this._queuedRequests.delete(entryId);
      return this._storage.dequeueRequest(cellId, entryId);
    }
    
    return false;
  }

  /**
   * Perform maintenance operations: cleanup expired locks and process queues.
   * 
   * @returns Promise resolving to maintenance statistics
   */
  async performMaintenance(): Promise<{ cleanedLocks: number; processedQueues: number }> {
    this._ensureNotDisposed();
    
    const cleanedLocks = await this._storage.cleanupExpiredLocks();
    let processedQueues = 0;

    // Process any pending queue requests
    const activeCells = new Set(Array.from(this._queuedRequests.values()).map(entry => entry.request.cellId));
    for (const cellId of activeCells) {
      const processed = await this._processNextQueuedRequest(cellId);
      if (processed) processedQueues++;
    }

    return { cleanedLocks, processedQueues };
  }

  /**
   * Dispose of the lock manager and release all resources.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Clean up all disposables
    this._disposables.forEach(disposable => disposable.dispose());
    this._disposables.clear();

    // Clear all timers
    this._heartbeatTimers.forEach(timer => clearInterval(timer));
    this._heartbeatTimers.clear();
    
    if (this._inactivityTimer) {
      clearTimeout(this._inactivityTimer);
    }

    // Release all user locks
    this._releaseAllUserLocks('manager_disposed').catch(error => {
      console.warn('Error releasing locks during disposal:', error);
    });

    // Clear internal state
    this._activeLocks.clear();
    this._queuedRequests.clear();

    // Emit disposal signal
    this._isDisposed.emit();
  }

  /**
   * Generate a unique lock identifier for a cell and user combination.
   * 
   * @param cellId - Cell identifier
   * @param userId - User identifier
   * @returns Unique lock identifier
   */
  private _generateLockId(cellId: string, userId: string): string {
    return `${this._config.redisKeyPrefix}:${this._sessionId}:${cellId}:${userId}`;
  }

  /**
   * Get all locks for a specific cell.
   * 
   * @param cellId - Cell identifier
   * @returns Promise resolving to array of lock metadata
   */
  private async _getCellLocks(cellId: string): Promise<ILockMetadata[]> {
    const allLocks = await this._storage.listLocks(this._sessionId);
    return allLocks.filter(lock => lock.cellId === cellId);
  }

  /**
   * Queue a lock request when immediate acquisition fails.
   * 
   * @param request - Original lock request
   * @param timeoutMs - Lock timeout
   * @returns Promise resolving to lock metadata when acquired
   */
  private async _queueLockRequest(request: ILockRequest, timeoutMs: number): Promise<ILockMetadata> {
    const entryId = UUID.uuid4();
    const queuedAt = new Date().toISOString();
    const queueExpiresAt = new Date(Date.now() + this._config.queueTimeout).toISOString();

    return new Promise((resolve, reject) => {
      const entry: ILockQueueEntry = {
        entryId,
        request,
        queuedAt,
        queueExpiresAt,
        position: 0, // Will be updated by storage
        onSuccess: resolve,
        onFailure: reject
      };

      this._queuedRequests.set(entryId, entry);

      this._storage.enqueueRequest(request.cellId, entry).then(position => {
        // Update position and set timeout for queue expiration
        const updatedEntry = { ...entry, position };
        this._queuedRequests.set(entryId, updatedEntry);

        setTimeout(() => {
          if (this._queuedRequests.has(entryId)) {
            this._queuedRequests.delete(entryId);
            this._storage.dequeueRequest(request.cellId, entryId);
            reject(new Error(`Lock request queued too long, timed out after ${this._config.queueTimeout}ms`));
          }
        }, this._config.queueTimeout);
      }).catch(reject);
    });
  }

  /**
   * Force acquire a lock with administrative privileges.
   * 
   * @param request - Lock acquisition request
   * @param lockMetadata - Lock metadata to store
   * @returns Promise resolving to lock metadata
   */
  private async _forceLockAcquisition(request: ILockRequest, lockMetadata: ILockMetadata): Promise<ILockMetadata> {
    // Release any existing locks on this cell
    const cellLocks = await this._getCellLocks(request.cellId);
    for (const existingLock of cellLocks) {
      if (existingLock.status === LockStatus.Locked) {
        await this._storage.releaseLock(existingLock.lockId, existingLock.userId, true);
        await this._onLockReleased(existingLock, 'force_override');
      }
    }

    // Acquire the lock
    const acquired = await this._storage.acquireLock(lockMetadata.lockId, lockMetadata, lockMetadata.timeoutMs);
    if (acquired) {
      return this._onLockAcquired(lockMetadata);
    } else {
      throw new Error('Failed to force acquire lock');
    }
  }

  /**
   * Renew an existing lock with extended timeout.
   * 
   * @param lock - Existing lock metadata
   * @param timeoutMs - New timeout duration
   * @returns Promise resolving to updated lock metadata
   */
  private async _renewLock(lock: ILockMetadata, timeoutMs: number): Promise<ILockMetadata> {
    const renewedLock: ILockMetadata = {
      ...lock,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      lastHeartbeat: new Date().toISOString(),
      timeoutMs
    };

    const success = await this._storage.acquireLock(lock.lockId, renewedLock, timeoutMs);
    if (success) {
      this._activeLocks.set(lock.lockId, renewedLock);
      this._setupHeartbeat(renewedLock);
      return renewedLock;
    } else {
      throw new Error('Failed to renew lock');
    }
  }

  /**
   * Process the next queued request for a cell.
   * 
   * @param cellId - Cell identifier
   * @returns Promise resolving to processing success
   */
  private async _processNextQueuedRequest(cellId: string): Promise<boolean> {
    const nextRequest = await this._storage.getNextQueuedRequest(cellId);
    if (!nextRequest) {
      return false;
    }

    try {
      const lockMetadata = await this.acquireLock(nextRequest.request);
      this._queuedRequests.delete(nextRequest.entryId);
      await this._storage.dequeueRequest(cellId, nextRequest.entryId);
      
      if (nextRequest.onSuccess) {
        nextRequest.onSuccess(lockMetadata);
      }
      return true;
    } catch (error) {
      this._queuedRequests.delete(nextRequest.entryId);
      await this._storage.dequeueRequest(cellId, nextRequest.entryId);
      
      if (nextRequest.onFailure) {
        nextRequest.onFailure(error as Error);
      }
      return false;
    }
  }

  /**
   * Handle lock acquired event with cleanup and broadcasting.
   * 
   * @param lock - Acquired lock metadata
   * @returns Promise resolving to lock metadata
   */
  private async _onLockAcquired(lock: ILockMetadata): Promise<ILockMetadata> {
    this._activeLocks.set(lock.lockId, lock);
    this._setupHeartbeat(lock);

    const event: ILockEvent = {
      type: 'acquired',
      lock,
      timestamp: new Date().toISOString(),
      sessionId: this._sessionId
    };

    await this._broadcaster.broadcastLockEvent(event, this._sessionId);
    this._lockAcquired.emit(event);

    return lock;
  }

  /**
   * Handle lock released event with cleanup and broadcasting.
   * 
   * @param lock - Released lock metadata
   * @param reason - Release reason
   */
  private async _onLockReleased(lock: ILockMetadata, reason: string): Promise<void> {
    this._activeLocks.delete(lock.lockId);
    
    // Clear heartbeat timer
    const timer = this._heartbeatTimers.get(lock.lockId);
    if (timer) {
      clearInterval(timer);
      this._heartbeatTimers.delete(lock.lockId);
    }

    const releasedLock: ILockMetadata = {
      ...lock,
      status: reason === 'force_override' ? LockStatus.ForceReleased : LockStatus.Available
    };

    const event: ILockEvent = {
      type: 'released',
      lock: releasedLock,
      timestamp: new Date().toISOString(),
      sessionId: this._sessionId,
      context: { reason }
    };

    await this._broadcaster.broadcastLockEvent(event, this._sessionId);
    this._lockReleased.emit(event);
  }

  /**
   * Set up heartbeat timer for lock renewal.
   * 
   * @param lock - Lock metadata
   */
  private _setupHeartbeat(lock: ILockMetadata): void {
    // Clear existing timer
    const existingTimer = this._heartbeatTimers.get(lock.lockId);
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    // Set up new heartbeat timer
    const timer = setInterval(async () => {
      try {
        const success = await this._storage.heartbeat(lock.lockId, lock.userId);
        if (!success) {
          // Lock may have been released or expired
          clearInterval(timer);
          this._heartbeatTimers.delete(lock.lockId);
          this._activeLocks.delete(lock.lockId);
        }
      } catch (error) {
        console.warn(`Heartbeat failed for lock ${lock.lockId}:`, error);
      }
    }, this._config.heartbeatInterval);

    this._heartbeatTimers.set(lock.lockId, timer);
  }

  /**
   * Set up periodic maintenance tasks.
   */
  private _setupPeriodicMaintenance(): void {
    const maintenanceInterval = setInterval(async () => {
      if (!this._disposed) {
        try {
          await this.performMaintenance();
        } catch (error) {
          console.warn('Periodic maintenance failed:', error);
        }
      }
    }, this._config.heartbeatInterval * 2); // Run maintenance less frequently than heartbeat

    // Store for cleanup
    const disposable = new Disposable(() => clearInterval(maintenanceInterval));
    this._disposables.add(disposable);
  }

  /**
   * Set up user inactivity monitoring.
   * 
   * @returns Timeout handle for cleanup
   */
  private _setupInactivityMonitoring(): NodeJS.Timeout {
    if (!this._config.autoReleaseOnInactivity) {
      return null as any;
    }

    return setTimeout(async () => {
      try {
        // Check user activity via awareness system
        const isActive = await this._awareness.isUserActive(this._userId);
        if (!isActive) {
          await this._releaseAllUserLocks('user_inactive');
        } else {
          // Reset timer if user is still active
          if (!this._disposed) {
            this._inactivityTimer.refresh();
          }
        }
      } catch (error) {
        console.warn('Inactivity check failed:', error);
      }
    }, this._config.inactivityTimeout);
  }

  /**
   * Release all locks owned by the current user.
   * 
   * @param reason - Release reason
   * @returns Promise resolving to number of released locks
   */
  private async _releaseAllUserLocks(reason: string): Promise<number> {
    const userLocks = Array.from(this._activeLocks.values())
      .filter(lock => lock.userId === this._userId);
    
    let releasedCount = 0;
    for (const lock of userLocks) {
      try {
        const released = await this._storage.releaseLock(lock.lockId, this._userId, false);
        if (released) {
          await this._onLockReleased(lock, reason);
          releasedCount++;
        }
      } catch (error) {
        console.warn(`Failed to release lock ${lock.lockId}:`, error);
      }
    }

    return releasedCount;
  }

  /**
   * Handle incoming lock events from other session participants.
   * 
   * @param event - Lock event data
   */
  private _handleLockEvent(event: ILockEvent): void {
    if (this._disposed) {
      return;
    }

    // Update local cache based on event type
    switch (event.type) {
      case 'acquired':
        if (event.lock.userId !== this._userId) {
          // Another user acquired a lock
          this._lockAcquired.emit(event);
        }
        break;
      
      case 'released':
        if (event.lock.userId !== this._userId) {
          // Another user released a lock
          this._lockReleased.emit(event);
        }
        break;
      
      case 'failed':
        if (event.lock.userId !== this._userId) {
          this._lockFailed.emit(event);
        }
        break;
    }
  }

  /**
   * Check if current user has administrative privileges.
   * 
   * @returns True if user has admin privileges
   */
  private _hasAdminPrivileges(): boolean {
    // This would integrate with the permission system
    // For now, implement basic check
    return this._userId.includes('admin') || this._userId.includes('moderator');
  }

  /**
   * Ensure the manager has not been disposed.
   * 
   * @throws Error if disposed
   */
  private _ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('LockManager has been disposed');
    }
  }
}

/**
 * Factory function to create a lock manager with default Redis storage and WebSocket broadcasting.
 * 
 * @param options - Configuration options
 * @returns Configured lock manager instance
 */
export async function createLockManager(options: {
  config?: Partial<ILockConfiguration>;
  collaborationProvider: ICollaborationProvider;
  awareness: IUserAwareness;
  sessionId: string;
  userId: string;
  userName: string;
}): Promise<LockManager> {
  // This would be implemented to create the actual storage and broadcaster instances
  // For now, return a placeholder that would be replaced with real implementations
  
  throw new Error('LockManager factory not yet implemented - requires Redis storage and WebSocket broadcaster setup');
}

/**
 * Type guard to check if a value is a valid lock status.
 * 
 * @param value - Value to check
 * @returns True if value is a valid LockStatus
 */
export function isValidLockStatus(value: any): value is LockStatus {
  return Object.values(LockStatus).includes(value);
}

/**
 * Utility function to calculate lock timeout based on priority and base timeout.
 * 
 * @param baseTim eout - Base timeout in milliseconds
 * @param priority - Lock priority level
 * @returns Calculated timeout in milliseconds
 */
export function calculateLockTimeout(baseTimeout: number, priority: LockPriority): number {
  const multipliers = {
    [LockPriority.Normal]: 1.0,
    [LockPriority.High]: 1.5,
    [LockPriority.Critical]: 2.0,
    [LockPriority.Emergency]: 3.0
  };
  
  return Math.floor(baseTimeout * multipliers[priority]);
}

/**
 * Export all types and interfaces for external use.
 */
export type {
  ILockConfiguration,
  ILockMetadata,
  ILockRequest,
  ILockReleaseRequest,
  ILockQueueEntry,
  ILockEvent,
  ILockStorage,
  ILockBroadcaster
};