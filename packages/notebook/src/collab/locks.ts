// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Token } from '@lumino/coreutils';
import { IDisposable } from '@lumino/disposable';
import { Signal, ISignal } from '@lumino/signaling';
import { IObservableMap, ObservableMap } from '@jupyterlab/observables';
import { User } from '@jupyter/shared-models';

/**
 * The cell lock manager token.
 */
export const ICellLockManager = new Token<ICellLockManager>(
  '@jupyter-notebook/collab:ICellLockManager'
);

/**
 * The lock request handler token.
 */
export const ILockRequestHandler = new Token<ILockRequestHandler>(
  '@jupyter-notebook/collab:ILockRequestHandler'
);

/**
 * Enumeration of possible lock statuses
 */
export enum LockStatus {
  /**
   * Cell is unlocked and available for editing
   */
  Unlocked = 'unlocked',
  
  /**
   * Cell is locked for exclusive editing
   */
  Locked = 'locked',
  
  /**
   * Lock acquisition is in progress
   */
  Pending = 'pending',
  
  /**
   * Lock request was denied
   */
  Denied = 'denied',
  
  /**
   * Lock has expired due to timeout
   */
  Expired = 'expired'
}

/**
 * Lock priority levels for conflict resolution
 */
export enum LockPriority {
  /**
   * Standard user lock request
   */
  Normal = 0,
  
  /**
   * High priority lock (e.g., for admin users)
   */
  High = 1,
  
  /**
   * Emergency lock override
   */
  Emergency = 2
}

/**
 * Lock acquisition mode
 */
export enum LockMode {
  /**
   * Standard exclusive lock
   */
  Exclusive = 'exclusive',
  
  /**
   * Shared read-only lock
   */
  Shared = 'shared',
  
  /**
   * Intent to edit (pre-lock)
   */
  Intent = 'intent'
}

/**
 * Interface representing the state of a cell lock
 */
export interface ICellLockState {
  /**
   * Unique identifier of the cell
   */
  cellId: string;
  
  /**
   * Current lock status
   */
  status: LockStatus;
  
  /**
   * User ID who owns the lock
   */
  lockedBy?: string;
  
  /**
   * Display name of the lock owner
   */
  ownerName?: string;
  
  /**
   * Color associated with the lock owner
   */
  ownerColor?: string;
  
  /**
   * Timestamp when the lock was acquired
   */
  lockedAt?: Date;
  
  /**
   * Timestamp when the lock will expire
   */
  expiresAt?: Date;
  
  /**
   * Lock mode (exclusive, shared, intent)
   */
  mode: LockMode;
  
  /**
   * Lock priority level
   */
  priority: LockPriority;
  
  /**
   * Additional metadata
   */
  metadata?: { [key: string]: any };
}

/**
 * Lock request information
 */
export interface ILockRequest {
  /**
   * Unique identifier for the request
   */
  requestId: string;
  
  /**
   * Cell ID being requested
   */
  cellId: string;
  
  /**
   * User making the request
   */
  userId: string;
  
  /**
   * Display name of the requesting user
   */
  userName?: string;
  
  /**
   * Requested lock mode
   */
  mode: LockMode;
  
  /**
   * Request priority
   */
  priority: LockPriority;
  
  /**
   * Timestamp of the request
   */
  requestedAt: Date;
  
  /**
   * Optional timeout for the request
   */
  timeout?: number;
  
  /**
   * Message from the requesting user
   */
  message?: string;
}

/**
 * Lock response information
 */
export interface ILockResponse {
  /**
   * Original request ID
   */
  requestId: string;
  
  /**
   * Whether the lock was granted
   */
  granted: boolean;
  
  /**
   * Lock state if granted
   */
  lockState?: ICellLockState;
  
  /**
   * Reason if denied
   */
  reason?: string;
  
  /**
   * Estimated wait time if denied (in milliseconds)
   */
  estimatedWait?: number;
  
  /**
   * Response timestamp
   */
  respondedAt: Date;
}

/**
 * Lock transfer request
 */
export interface ILockTransfer {
  /**
   * Cell ID to transfer
   */
  cellId: string;
  
  /**
   * Current lock owner
   */
  fromUserId: string;
  
  /**
   * New lock owner
   */
  toUserId: string;
  
  /**
   * Transfer message
   */
  message?: string;
  
  /**
   * Whether the transfer is forced
   */
  forced: boolean;
}

/**
 * Configuration options for the lock manager
 */
export interface ILockManagerOptions {
  /**
   * Default lock timeout in milliseconds
   */
  defaultTimeout: number;
  
  /**
   * Maximum lock duration in milliseconds
   */
  maxLockDuration: number;
  
  /**
   * Heartbeat interval for lock keep-alive
   */
  heartbeatInterval: number;
  
  /**
   * Grace period before considering a lock stale
   */
  staleLockGracePeriod: number;
  
  /**
   * Whether to enable automatic lock release
   */
  autoRelease: boolean;
  
  /**
   * Whether to enable lock request queuing
   */
  enableRequestQueue: boolean;
  
  /**
   * Maximum number of queued requests per cell
   */
  maxQueuedRequests: number;
  
  /**
   * Response timeout for lock operations
   */
  responseTimeout: number;
}

/**
 * Interface for handling lock requests and responses
 */
export interface ILockRequestHandler extends IDisposable {
  /**
   * Process a lock acquisition request
   */
  handleLockRequest(request: ILockRequest): Promise<ILockResponse>;
  
  /**
   * Process a lock release request
   */
  handleLockRelease(cellId: string, userId: string, forced?: boolean): Promise<boolean>;
  
  /**
   * Process a lock transfer request
   */
  handleLockTransfer(transfer: ILockTransfer): Promise<boolean>;
  
  /**
   * Handle heartbeat for lock keep-alive
   */
  handleHeartbeat(cellId: string, userId: string): Promise<boolean>;
  
  /**
   * Get current lock state for a cell
   */
  getLockState(cellId: string): Promise<ICellLockState | null>;
  
  /**
   * Get all active locks for a user
   */
  getUserLocks(userId: string): Promise<ICellLockState[]>;
  
  /**
   * Check if a user can acquire a lock
   */
  canAcquireLock(cellId: string, userId: string, mode: LockMode): Promise<boolean>;
  
  /**
   * Signal emitted when a lock state changes
   */
  readonly lockStateChanged: ISignal<this, { cellId: string; lockState: ICellLockState | null }>;
  
  /**
   * Signal emitted when a lock request is received
   */
  readonly lockRequestReceived: ISignal<this, ILockRequest>;
  
  /**
   * Signal emitted when a lock transfer is requested
   */
  readonly lockTransferRequested: ISignal<this, ILockTransfer>;
}

/**
 * Interface for managing cell locks in collaborative editing
 */
export interface ICellLockManager extends IDisposable {
  /**
   * Current user information
   */
  readonly currentUser: User | null;
  
  /**
   * Lock manager configuration
   */
  readonly options: ILockManagerOptions;
  
  /**
   * Observable map of current lock states
   */
  readonly lockStates: IObservableMap<ICellLockState>;
  
  /**
   * Map of pending lock requests
   */
  readonly pendingRequests: IObservableMap<ILockRequest>;
  
  /**
   * Attempt to acquire a lock on a cell
   */
  acquireLock(
    cellId: string, 
    mode?: LockMode, 
    priority?: LockPriority,
    timeout?: number
  ): Promise<ICellLockState>;
  
  /**
   * Release a lock on a cell
   */
  releaseLock(cellId: string, forced?: boolean): Promise<boolean>;
  
  /**
   * Request a lock from another user
   */
  requestLock(
    cellId: string,
    message?: string,
    priority?: LockPriority
  ): Promise<ILockResponse>;
  
  /**
   * Transfer a lock to another user
   */
  transferLock(cellId: string, toUserId: string, message?: string): Promise<boolean>;
  
  /**
   * Check if the current user owns a lock
   */
  ownsLock(cellId: string): boolean;
  
  /**
   * Check if a cell is locked
   */
  isLocked(cellId: string): boolean;
  
  /**
   * Check if a cell can be edited by the current user
   */
  canEdit(cellId: string): boolean;
  
  /**
   * Get the lock state for a cell
   */
  getLockState(cellId: string): ICellLockState | null;
  
  /**
   * Get all locks owned by the current user
   */
  getOwnedLocks(): ICellLockState[];
  
  /**
   * Get all active locks
   */
  getAllLocks(): ICellLockState[];
  
  /**
   * Start heartbeat for lock keep-alive
   */
  startHeartbeat(cellId: string): void;
  
  /**
   * Stop heartbeat for a cell
   */
  stopHeartbeat(cellId: string): void;
  
  /**
   * Refresh a lock to extend its duration
   */
  refreshLock(cellId: string): Promise<boolean>;
  
  /**
   * Clear all locks for the current user
   */
  clearAllLocks(): Promise<void>;
  
  /**
   * Handle user disconnection cleanup
   */
  handleUserDisconnection(userId: string): Promise<void>;
  
  /**
   * Signal emitted when lock state changes
   */
  readonly lockStateChanged: ISignal<this, { cellId: string; lockState: ICellLockState | null }>;
  
  /**
   * Signal emitted when a lock request is received
   */
  readonly lockRequestReceived: ISignal<this, ILockRequest>;
  
  /**
   * Signal emitted when a lock transfer is requested
   */
  readonly lockTransferRequested: ISignal<this, ILockTransfer>;
  
  /**
   * Signal emitted when a lock expires
   */
  readonly lockExpired: ISignal<this, { cellId: string; userId: string }>;
  
  /**
   * Signal emitted when lock acquisition fails
   */
  readonly lockAcquisitionFailed: ISignal<this, { cellId: string; reason: string }>;
}

/**
 * Default configuration for the lock manager
 */
export const DEFAULT_LOCK_OPTIONS: ILockManagerOptions = {
  defaultTimeout: 30000, // 30 seconds
  maxLockDuration: 300000, // 5 minutes
  heartbeatInterval: 10000, // 10 seconds
  staleLockGracePeriod: 15000, // 15 seconds
  autoRelease: true,
  enableRequestQueue: true,
  maxQueuedRequests: 5,
  responseTimeout: 50 // 50ms as per technical requirements
};

/**
 * Implementation of the lock request handler
 */
export class LockRequestHandler implements ILockRequestHandler {
  private _isDisposed = false;
  private _lockStateChanged = new Signal<this, { cellId: string; lockState: ICellLockState | null }>(this);
  private _lockRequestReceived = new Signal<this, ILockRequest>(this);
  private _lockTransferRequested = new Signal<this, ILockTransfer>(this);
  private _activeLocks = new Map<string, ICellLockState>();
  private _requestQueue = new Map<string, ILockRequest[]>();
  private _options: ILockManagerOptions;

  constructor(options: Partial<ILockManagerOptions> = {}) {
    this._options = { ...DEFAULT_LOCK_OPTIONS, ...options };
  }

  /**
   * Whether the handler is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Signal emitted when a lock state changes
   */
  get lockStateChanged(): ISignal<this, { cellId: string; lockState: ICellLockState | null }> {
    return this._lockStateChanged;
  }

  /**
   * Signal emitted when a lock request is received
   */
  get lockRequestReceived(): ISignal<this, ILockRequest> {
    return this._lockRequestReceived;
  }

  /**
   * Signal emitted when a lock transfer is requested
   */
  get lockTransferRequested(): ISignal<this, ILockTransfer> {
    return this._lockTransferRequested;
  }

  /**
   * Process a lock acquisition request
   */
  async handleLockRequest(request: ILockRequest): Promise<ILockResponse> {
    const startTime = Date.now();
    
    try {
      // Emit signal for request received
      this._lockRequestReceived.emit(request);
      
      // Check if cell is already locked
      const currentLock = this._activeLocks.get(request.cellId);
      
      if (currentLock && currentLock.status === LockStatus.Locked) {
        // Check if it's the same user
        if (currentLock.lockedBy === request.userId) {
          return {
            requestId: request.requestId,
            granted: true,
            lockState: currentLock,
            respondedAt: new Date()
          };
        }
        
        // Check priority
        if (request.priority <= currentLock.priority) {
          // Queue the request if enabled
          if (this._options.enableRequestQueue) {
            this._addToQueue(request);
            
            return {
              requestId: request.requestId,
              granted: false,
              reason: 'Cell is locked by another user. Request has been queued.',
              estimatedWait: this._estimateWaitTime(request.cellId),
              respondedAt: new Date()
            };
          } else {
            return {
              requestId: request.requestId,
              granted: false,
              reason: `Cell is locked by ${currentLock.ownerName || currentLock.lockedBy}`,
              respondedAt: new Date()
            };
          }
        }
        
        // Higher priority request - force release current lock
        await this._forceReleaseLock(request.cellId, 'Higher priority request');
      }
      
      // Create new lock
      const lockState: ICellLockState = {
        cellId: request.cellId,
        status: LockStatus.Locked,
        lockedBy: request.userId,
        ownerName: request.userName,
        ownerColor: this._generateUserColor(request.userId),
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + (request.timeout || this._options.defaultTimeout)),
        mode: request.mode,
        priority: request.priority,
        metadata: {}
      };
      
      // Store the lock
      this._activeLocks.set(request.cellId, lockState);
      
      // Emit lock state change
      this._lockStateChanged.emit({ cellId: request.cellId, lockState });
      
      // Set up expiration timer
      this._scheduleExpiration(lockState);
      
      // Ensure response time is under 50ms
      const responseTime = Date.now() - startTime;
      if (responseTime > this._options.responseTimeout) {
        console.warn(`Lock request processing took ${responseTime}ms, exceeding target of ${this._options.responseTimeout}ms`);
      }
      
      return {
        requestId: request.requestId,
        granted: true,
        lockState,
        respondedAt: new Date()
      };
      
    } catch (error) {
      console.error('Error processing lock request:', error);
      return {
        requestId: request.requestId,
        granted: false,
        reason: 'Internal error processing lock request',
        respondedAt: new Date()
      };
    }
  }

  /**
   * Process a lock release request
   */
  async handleLockRelease(cellId: string, userId: string, forced = false): Promise<boolean> {
    try {
      const lockState = this._activeLocks.get(cellId);
      
      if (!lockState) {
        return true; // Already released
      }
      
      // Check if user can release the lock
      if (!forced && lockState.lockedBy !== userId) {
        throw new Error('User does not own this lock');
      }
      
      // Remove the lock
      this._activeLocks.delete(cellId);
      
      // Emit lock state change
      this._lockStateChanged.emit({ cellId, lockState: null });
      
      // Process any queued requests
      await this._processQueue(cellId);
      
      return true;
      
    } catch (error) {
      console.error('Error releasing lock:', error);
      return false;
    }
  }

  /**
   * Process a lock transfer request
   */
  async handleLockTransfer(transfer: ILockTransfer): Promise<boolean> {
    try {
      this._lockTransferRequested.emit(transfer);
      
      const lockState = this._activeLocks.get(transfer.cellId);
      
      if (!lockState) {
        return false; // No lock to transfer
      }
      
      if (!transfer.forced && lockState.lockedBy !== transfer.fromUserId) {
        return false; // User doesn't own the lock
      }
      
      // Update lock ownership
      lockState.lockedBy = transfer.toUserId;
      lockState.ownerName = transfer.toUserId; // This should be resolved to display name
      lockState.ownerColor = this._generateUserColor(transfer.toUserId);
      lockState.lockedAt = new Date();
      lockState.expiresAt = new Date(Date.now() + this._options.defaultTimeout);
      
      // Emit lock state change
      this._lockStateChanged.emit({ cellId: transfer.cellId, lockState });
      
      return true;
      
    } catch (error) {
      console.error('Error transferring lock:', error);
      return false;
    }
  }

  /**
   * Handle heartbeat for lock keep-alive
   */
  async handleHeartbeat(cellId: string, userId: string): Promise<boolean> {
    try {
      const lockState = this._activeLocks.get(cellId);
      
      if (!lockState || lockState.lockedBy !== userId) {
        return false;
      }
      
      // Extend lock expiration
      lockState.expiresAt = new Date(Date.now() + this._options.defaultTimeout);
      
      // Re-schedule expiration
      this._scheduleExpiration(lockState);
      
      return true;
      
    } catch (error) {
      console.error('Error processing heartbeat:', error);
      return false;
    }
  }

  /**
   * Get current lock state for a cell
   */
  async getLockState(cellId: string): Promise<ICellLockState | null> {
    return this._activeLocks.get(cellId) || null;
  }

  /**
   * Get all active locks for a user
   */
  async getUserLocks(userId: string): Promise<ICellLockState[]> {
    const userLocks: ICellLockState[] = [];
    
    for (const lockState of this._activeLocks.values()) {
      if (lockState.lockedBy === userId) {
        userLocks.push(lockState);
      }
    }
    
    return userLocks;
  }

  /**
   * Check if a user can acquire a lock
   */
  async canAcquireLock(cellId: string, userId: string, mode: LockMode): Promise<boolean> {
    const currentLock = this._activeLocks.get(cellId);
    
    if (!currentLock) {
      return true; // Cell is not locked
    }
    
    if (currentLock.lockedBy === userId) {
      return true; // User already owns the lock
    }
    
    if (mode === LockMode.Shared && currentLock.mode === LockMode.Shared) {
      return true; // Both are shared locks
    }
    
    return false; // Cell is exclusively locked by another user
  }

  /**
   * Dispose of the handler
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    this._isDisposed = true;
    
    // Clear all locks
    this._activeLocks.clear();
    this._requestQueue.clear();
    
    // Clear signals
    Signal.clearData(this);
  }

  /**
   * Add a request to the queue
   */
  private _addToQueue(request: ILockRequest): void {
    const queue = this._requestQueue.get(request.cellId) || [];
    
    if (queue.length >= this._options.maxQueuedRequests) {
      // Remove oldest request
      queue.shift();
    }
    
    queue.push(request);
    this._requestQueue.set(request.cellId, queue);
  }

  /**
   * Process queued requests for a cell
   */
  private async _processQueue(cellId: string): Promise<void> {
    const queue = this._requestQueue.get(cellId);
    
    if (!queue || queue.length === 0) {
      return;
    }
    
    // Sort by priority and timestamp
    queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // Higher priority first
      }
      return a.requestedAt.getTime() - b.requestedAt.getTime(); // Earlier timestamp first
    });
    
    // Process the highest priority request
    const nextRequest = queue.shift();
    if (nextRequest) {
      this._requestQueue.set(cellId, queue);
      await this.handleLockRequest(nextRequest);
    }
  }

  /**
   * Force release a lock
   */
  private async _forceReleaseLock(cellId: string, reason: string): Promise<void> {
    const lockState = this._activeLocks.get(cellId);
    
    if (lockState) {
      this._activeLocks.delete(cellId);
      this._lockStateChanged.emit({ cellId, lockState: null });
      console.log(`Forced release of lock on cell ${cellId}: ${reason}`);
    }
  }

  /**
   * Schedule lock expiration
   */
  private _scheduleExpiration(lockState: ICellLockState): void {
    if (!lockState.expiresAt) {
      return;
    }
    
    const timeUntilExpiration = lockState.expiresAt.getTime() - Date.now();
    
    if (timeUntilExpiration > 0) {
      setTimeout(() => {
        const currentLock = this._activeLocks.get(lockState.cellId);
        if (currentLock && currentLock.lockedAt === lockState.lockedAt) {
          // Lock hasn't been renewed, expire it
          this._forceReleaseLock(lockState.cellId, 'Lock expired');
        }
      }, timeUntilExpiration);
    }
  }

  /**
   * Estimate wait time for a queued request
   */
  private _estimateWaitTime(cellId: string): number {
    const currentLock = this._activeLocks.get(cellId);
    
    if (!currentLock || !currentLock.expiresAt) {
      return 0;
    }
    
    const timeUntilExpiration = currentLock.expiresAt.getTime() - Date.now();
    return Math.max(0, timeUntilExpiration);
  }

  /**
   * Generate a color for a user
   */
  private _generateUserColor(userId: string): string {
    // Simple hash-based color generation
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = ((hash << 5) - hash) + userId.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  }
}

/**
 * Implementation of the cell lock manager
 */
export class CellLockManager implements ICellLockManager {
  private _isDisposed = false;
  private _currentUser: User | null = null;
  private _options: ILockManagerOptions;
  private _lockStates: ObservableMap<ICellLockState>;
  private _pendingRequests: ObservableMap<ILockRequest>;
  private _lockRequestHandler: ILockRequestHandler;
  private _heartbeatTimers = new Map<string, number>();
  private _requestIdCounter = 0;
  
  // Signals
  private _lockStateChanged = new Signal<this, { cellId: string; lockState: ICellLockState | null }>(this);
  private _lockRequestReceived = new Signal<this, ILockRequest>(this);
  private _lockTransferRequested = new Signal<this, ILockTransfer>(this);
  private _lockExpired = new Signal<this, { cellId: string; userId: string }>(this);
  private _lockAcquisitionFailed = new Signal<this, { cellId: string; reason: string }>(this);

  constructor(
    currentUser: User | null,
    lockRequestHandler: ILockRequestHandler,
    options: Partial<ILockManagerOptions> = {}
  ) {
    this._currentUser = currentUser;
    this._lockRequestHandler = lockRequestHandler;
    this._options = { ...DEFAULT_LOCK_OPTIONS, ...options };
    
    this._lockStates = new ObservableMap<ICellLockState>();
    this._pendingRequests = new ObservableMap<ILockRequest>();
    
    // Connect to handler signals
    this._lockRequestHandler.lockStateChanged.connect(this._onLockStateChanged, this);
    this._lockRequestHandler.lockRequestReceived.connect(this._onLockRequestReceived, this);
    this._lockRequestHandler.lockTransferRequested.connect(this._onLockTransferRequested, this);
  }

  /**
   * Whether the manager is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Current user information
   */
  get currentUser(): User | null {
    return this._currentUser;
  }

  /**
   * Lock manager configuration
   */
  get options(): ILockManagerOptions {
    return this._options;
  }

  /**
   * Observable map of current lock states
   */
  get lockStates(): IObservableMap<ICellLockState> {
    return this._lockStates;
  }

  /**
   * Map of pending lock requests
   */
  get pendingRequests(): IObservableMap<ILockRequest> {
    return this._pendingRequests;
  }

  /**
   * Signal emitted when lock state changes
   */
  get lockStateChanged(): ISignal<this, { cellId: string; lockState: ICellLockState | null }> {
    return this._lockStateChanged;
  }

  /**
   * Signal emitted when a lock request is received
   */
  get lockRequestReceived(): ISignal<this, ILockRequest> {
    return this._lockRequestReceived;
  }

  /**
   * Signal emitted when a lock transfer is requested
   */
  get lockTransferRequested(): ISignal<this, ILockTransfer> {
    return this._lockTransferRequested;
  }

  /**
   * Signal emitted when a lock expires
   */
  get lockExpired(): ISignal<this, { cellId: string; userId: string }> {
    return this._lockExpired;
  }

  /**
   * Signal emitted when lock acquisition fails
   */
  get lockAcquisitionFailed(): ISignal<this, { cellId: string; reason: string }> {
    return this._lockAcquisitionFailed;
  }

  /**
   * Attempt to acquire a lock on a cell
   */
  async acquireLock(
    cellId: string,
    mode: LockMode = LockMode.Exclusive,
    priority: LockPriority = LockPriority.Normal,
    timeout?: number
  ): Promise<ICellLockState> {
    if (!this._currentUser) {
      throw new Error('No current user available for lock acquisition');
    }

    const requestId = this._generateRequestId();
    const request: ILockRequest = {
      requestId,
      cellId,
      userId: this._currentUser.id,
      userName: this._currentUser.displayName,
      mode,
      priority,
      requestedAt: new Date(),
      timeout: timeout || this._options.defaultTimeout
    };

    // Add to pending requests
    this._pendingRequests.set(requestId, request);

    try {
      const response = await this._lockRequestHandler.handleLockRequest(request);
      
      // Remove from pending requests
      this._pendingRequests.delete(requestId);
      
      if (response.granted && response.lockState) {
        // Start heartbeat if auto-release is enabled
        if (this._options.autoRelease) {
          this.startHeartbeat(cellId);
        }
        
        return response.lockState;
      } else {
        const reason = response.reason || 'Lock request denied';
        this._lockAcquisitionFailed.emit({ cellId, reason });
        throw new Error(reason);
      }
    } catch (error) {
      // Remove from pending requests
      this._pendingRequests.delete(requestId);
      
      const reason = error instanceof Error ? error.message : 'Unknown error';
      this._lockAcquisitionFailed.emit({ cellId, reason });
      throw error;
    }
  }

  /**
   * Release a lock on a cell
   */
  async releaseLock(cellId: string, forced = false): Promise<boolean> {
    if (!this._currentUser) {
      return false;
    }

    // Stop heartbeat
    this.stopHeartbeat(cellId);

    try {
      const success = await this._lockRequestHandler.handleLockRelease(
        cellId, 
        this._currentUser.id, 
        forced
      );
      
      if (success) {
        // Remove from local state
        this._lockStates.delete(cellId);
      }
      
      return success;
    } catch (error) {
      console.error('Error releasing lock:', error);
      return false;
    }
  }

  /**
   * Request a lock from another user
   */
  async requestLock(
    cellId: string,
    message?: string,
    priority: LockPriority = LockPriority.Normal
  ): Promise<ILockResponse> {
    if (!this._currentUser) {
      throw new Error('No current user available for lock request');
    }

    const requestId = this._generateRequestId();
    const request: ILockRequest = {
      requestId,
      cellId,
      userId: this._currentUser.id,
      userName: this._currentUser.displayName,
      mode: LockMode.Exclusive,
      priority,
      requestedAt: new Date(),
      timeout: this._options.defaultTimeout,
      message
    };

    return await this._lockRequestHandler.handleLockRequest(request);
  }

  /**
   * Transfer a lock to another user
   */
  async transferLock(cellId: string, toUserId: string, message?: string): Promise<boolean> {
    if (!this._currentUser) {
      return false;
    }

    const transfer: ILockTransfer = {
      cellId,
      fromUserId: this._currentUser.id,
      toUserId,
      message,
      forced: false
    };

    try {
      const success = await this._lockRequestHandler.handleLockTransfer(transfer);
      
      if (success) {
        // Stop our heartbeat since we no longer own the lock
        this.stopHeartbeat(cellId);
      }
      
      return success;
    } catch (error) {
      console.error('Error transferring lock:', error);
      return false;
    }
  }

  /**
   * Check if the current user owns a lock
   */
  ownsLock(cellId: string): boolean {
    if (!this._currentUser) {
      return false;
    }

    const lockState = this._lockStates.get(cellId);
    return lockState?.lockedBy === this._currentUser.id && lockState?.status === LockStatus.Locked;
  }

  /**
   * Check if a cell is locked
   */
  isLocked(cellId: string): boolean {
    const lockState = this._lockStates.get(cellId);
    return lockState?.status === LockStatus.Locked;
  }

  /**
   * Check if a cell can be edited by the current user
   */
  canEdit(cellId: string): boolean {
    if (!this._currentUser) {
      return false;
    }

    const lockState = this._lockStates.get(cellId);
    
    if (!lockState || lockState.status !== LockStatus.Locked) {
      return true; // Cell is not locked
    }
    
    if (lockState.lockedBy === this._currentUser.id) {
      return true; // User owns the lock
    }
    
    if (lockState.mode === LockMode.Shared) {
      return true; // Shared lock allows editing
    }
    
    return false; // Cell is exclusively locked by another user
  }

  /**
   * Get the lock state for a cell
   */
  getLockState(cellId: string): ICellLockState | null {
    return this._lockStates.get(cellId) || null;
  }

  /**
   * Get all locks owned by the current user
   */
  getOwnedLocks(): ICellLockState[] {
    if (!this._currentUser) {
      return [];
    }

    const ownedLocks: ICellLockState[] = [];
    
    for (const lockState of this._lockStates.values()) {
      if (lockState.lockedBy === this._currentUser.id) {
        ownedLocks.push(lockState);
      }
    }
    
    return ownedLocks;
  }

  /**
   * Get all active locks
   */
  getAllLocks(): ICellLockState[] {
    return Array.from(this._lockStates.values());
  }

  /**
   * Start heartbeat for lock keep-alive
   */
  startHeartbeat(cellId: string): void {
    // Clear existing heartbeat
    this.stopHeartbeat(cellId);
    
    if (!this._currentUser) {
      return;
    }

    const heartbeatFn = async () => {
      try {
        const success = await this._lockRequestHandler.handleHeartbeat(
          cellId, 
          this._currentUser!.id
        );
        
        if (!success) {
          // Heartbeat failed, stop sending
          this.stopHeartbeat(cellId);
          this._lockExpired.emit({ cellId, userId: this._currentUser!.id });
        }
      } catch (error) {
        console.error('Heartbeat error:', error);
        this.stopHeartbeat(cellId);
      }
    };

    const timerId = window.setInterval(heartbeatFn, this._options.heartbeatInterval);
    this._heartbeatTimers.set(cellId, timerId);
  }

  /**
   * Stop heartbeat for a cell
   */
  stopHeartbeat(cellId: string): void {
    const timerId = this._heartbeatTimers.get(cellId);
    if (timerId) {
      window.clearInterval(timerId);
      this._heartbeatTimers.delete(cellId);
    }
  }

  /**
   * Refresh a lock to extend its duration
   */
  async refreshLock(cellId: string): Promise<boolean> {
    if (!this._currentUser) {
      return false;
    }

    return await this._lockRequestHandler.handleHeartbeat(cellId, this._currentUser.id);
  }

  /**
   * Clear all locks for the current user
   */
  async clearAllLocks(): Promise<void> {
    if (!this._currentUser) {
      return;
    }

    const ownedLocks = this.getOwnedLocks();
    
    for (const lockState of ownedLocks) {
      try {
        await this.releaseLock(lockState.cellId, true);
      } catch (error) {
        console.error(`Error releasing lock for cell ${lockState.cellId}:`, error);
      }
    }
  }

  /**
   * Handle user disconnection cleanup
   */
  async handleUserDisconnection(userId: string): Promise<void> {
    const userLocks: ICellLockState[] = [];
    
    for (const lockState of this._lockStates.values()) {
      if (lockState.lockedBy === userId) {
        userLocks.push(lockState);
      }
    }
    
    for (const lockState of userLocks) {
      try {
        await this._lockRequestHandler.handleLockRelease(lockState.cellId, userId, true);
      } catch (error) {
        console.error(`Error releasing lock for disconnected user ${userId}:`, error);
      }
    }
  }

  /**
   * Dispose of the manager
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    this._isDisposed = true;
    
    // Clear all heartbeats
    for (const timerId of this._heartbeatTimers.values()) {
      window.clearInterval(timerId);
    }
    this._heartbeatTimers.clear();
    
    // Clear all locks
    this.clearAllLocks().catch(error => {
      console.error('Error clearing locks during disposal:', error);
    });
    
    // Dispose observables
    this._lockStates.dispose();
    this._pendingRequests.dispose();
    
    // Clear signals
    Signal.clearData(this);
  }

  /**
   * Generate a unique request ID
   */
  private _generateRequestId(): string {
    return `lock-request-${Date.now()}-${++this._requestIdCounter}`;
  }

  /**
   * Handle lock state changes from the request handler
   */
  private _onLockStateChanged(
    handler: ILockRequestHandler,
    args: { cellId: string; lockState: ICellLockState | null }
  ): void {
    const { cellId, lockState } = args;
    
    if (lockState) {
      this._lockStates.set(cellId, lockState);
    } else {
      this._lockStates.delete(cellId);
    }
    
    // Emit our own signal
    this._lockStateChanged.emit(args);
  }

  /**
   * Handle lock requests received by the handler
   */
  private _onLockRequestReceived(handler: ILockRequestHandler, request: ILockRequest): void {
    this._lockRequestReceived.emit(request);
  }

  /**
   * Handle lock transfer requests received by the handler
   */
  private _onLockTransferRequested(handler: ILockRequestHandler, transfer: ILockTransfer): void {
    this._lockTransferRequested.emit(transfer);
  }
}

/**
 * Utility functions for working with locks
 */
export namespace LockUtils {
  /**
   * Check if a lock is expired
   */
  export function isExpired(lockState: ICellLockState): boolean {
    if (!lockState.expiresAt) {
      return false;
    }
    return lockState.expiresAt.getTime() < Date.now();
  }

  /**
   * Get time remaining until lock expires
   */
  export function getTimeRemaining(lockState: ICellLockState): number {
    if (!lockState.expiresAt) {
      return Infinity;
    }
    return Math.max(0, lockState.expiresAt.getTime() - Date.now());
  }

  /**
   * Format lock duration for display
   */
  export function formatDuration(milliseconds: number): string {
    if (milliseconds === Infinity) {
      return 'Never';
    }
    
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Check if a user can override a lock
   */
  export function canOverride(
    currentPriority: LockPriority,
    lockPriority: LockPriority
  ): boolean {
    return currentPriority > lockPriority;
  }

  /**
   * Get lock status display text
   */
  export function getStatusText(status: LockStatus): string {
    switch (status) {
      case LockStatus.Unlocked:
        return 'Available';
      case LockStatus.Locked:
        return 'Locked';
      case LockStatus.Pending:
        return 'Pending...';
      case LockStatus.Denied:
        return 'Access Denied';
      case LockStatus.Expired:
        return 'Expired';
      default:
        return 'Unknown';
    }
  }

  /**
   * Get lock mode display text
   */
  export function getModeText(mode: LockMode): string {
    switch (mode) {
      case LockMode.Exclusive:
        return 'Exclusive';
      case LockMode.Shared:
        return 'Shared';
      case LockMode.Intent:
        return 'Intent';
      default:
        return 'Unknown';
    }
  }

  /**
   * Get priority display text
   */
  export function getPriorityText(priority: LockPriority): string {
    switch (priority) {
      case LockPriority.Normal:
        return 'Normal';
      case LockPriority.High:
        return 'High';
      case LockPriority.Emergency:
        return 'Emergency';
      default:
        return 'Unknown';
    }
  }
}