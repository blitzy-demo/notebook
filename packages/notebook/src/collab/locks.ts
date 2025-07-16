// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';

import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';


import YjsNotebookProvider from './provider';
import UserAwareness from './awareness';

/**
 * Enumeration of lock states for tracking lock lifecycle
 */
export enum LockState {
  PENDING = 'pending',
  ACQUIRED = 'acquired',
  ACTIVE = 'active',
  EXPIRED = 'expired',
  RELEASED = 'released',
  TIMEOUT = 'timeout',
  CONFLICT = 'conflict',
  ERROR = 'error'
}

/**
 * Enumeration of lock types for different editing operations
 */
export enum LockType {
  EXCLUSIVE = 'exclusive',
  SHARED = 'shared',
  EDIT = 'edit',
  EXECUTE = 'execute',
  METADATA = 'metadata',
  CONTENT = 'content'
}

/**
 * Enumeration of lock event types for tracking lock operations
 */
export enum LockEventType {
  LOCK_ACQUIRED = 'lock_acquired',
  LOCK_RELEASED = 'lock_released',
  LOCK_EXPIRED = 'lock_expired',
  LOCK_TIMEOUT = 'lock_timeout',
  LOCK_CONFLICT = 'lock_conflict',
  LOCK_ERROR = 'lock_error',
  HEARTBEAT_RECEIVED = 'heartbeat_received',
  HEARTBEAT_MISSED = 'heartbeat_missed'
}

/**
 * Interface representing a cell lock instance
 */
export interface ICellLock {
  /** Unique lock identifier */
  id: string;
  /** Cell identifier being locked */
  cellId: string;
  /** Display name of lock owner */
  owner: string;
  /** User ID of lock owner */
  ownerId: string;
  /** Timestamp when lock was acquired */
  acquiredAt: number;
  /** Timestamp when lock expires */
  expiresAt: number;
  /** Lock timeout duration in milliseconds */
  timeout: number;
  /** Whether lock is currently active */
  isActive: boolean;
  /** Session ID of lock owner */
  sessionId: string;
  /** Heartbeat interval in milliseconds */
  heartbeatInterval: number;
  /** Last heartbeat timestamp */
  lastHeartbeat: number;
  /** Type of lock */
  lockType: LockType;
  /** Additional metadata */
  metadata?: { [key: string]: any };
}

/**
 * Interface representing lock events
 */
export interface ILockEvent {
  /** Event type */
  type: LockEventType;
  /** Lock object */
  lock: ICellLock;
  /** Cell ID */
  cellId: string;
  /** Lock owner */
  owner: string;
  /** Event timestamp */
  timestamp: number;
  /** Previous lock state */
  previousState: LockState;
  /** New lock state */
  newState: LockState;
  /** Event reason */
  reason: string;
  /** Additional metadata */
  metadata?: { [key: string]: any };
}

/**
 * Interface for lock options
 */
export interface ILockOptions {
  /** Lock timeout duration in milliseconds */
  timeout?: number;
  /** Heartbeat interval in milliseconds */
  heartbeatInterval?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Retry delay in milliseconds */
  retryDelay?: number;
  /** Lock type */
  lockType?: LockType;
  /** Additional metadata */
  metadata?: { [key: string]: any };
  /** Auto-release lock when user goes inactive */
  autoRelease?: boolean;
  /** Enable visual indicators */
  enableVisualIndicators?: boolean;
}

/**
 * Interface for cell lock manager functionality
 */
export interface ICellLockManager {
  /** Acquire a lock for a cell */
  acquireLock(cellId: string, options?: ILockOptions): Promise<ICellLock | null>;
  /** Release a lock for a cell */
  releaseLock(cellId: string): Promise<boolean>;
  /** Check if a cell is locked */
  isLocked(cellId: string): boolean;
  /** Get lock owner for a cell */
  getLockOwner(cellId: string): string | null;
  /** Get lock by ID */
  getLockById(lockId: string): ICellLock | null;
  /** Get all active locks */
  getActiveLocks(): ICellLock[];
  /** Get locks owned by a user */
  getUserLocks(userId: string): ICellLock[];
  /** Set lock timeout */
  setLockTimeout(timeout: number): void;
  /** Start heartbeat for a lock */
  startHeartbeat(lockId: string): void;
  /** Stop heartbeat for a lock */
  stopHeartbeat(lockId: string): void;
  /** Signal emitted when lock state changes */
  onLockStateChanged: ISignal<ICellLockManager, ILockEvent>;
  /** Signal emitted when lock is acquired */
  onLockAcquired: ISignal<ICellLockManager, ICellLock>;
  /** Signal emitted when lock is released */
  onLockReleased: ISignal<ICellLockManager, ICellLock>;
  /** Signal emitted when lock expires */
  onLockExpired: ISignal<ICellLockManager, ICellLock>;
  /** Signal emitted when lock times out */
  onLockTimeout: ISignal<ICellLockManager, ICellLock>;
}

/**
 * Default lock configuration
 */
const DEFAULT_LOCK_CONFIG = {
  timeout: 300000, // 5 minutes
  heartbeatInterval: 30000, // 30 seconds
  maxRetries: 3,
  retryDelay: 1000, // 1 second
  lockType: LockType.EXCLUSIVE,
  metadata: {},
  autoRelease: true,
  enableVisualIndicators: true
};

/**
 * CellLocking: Distributed lock management system for collaborative notebook editing
 * 
 * This class provides exclusive cell-level access control during collaborative editing
 * to prevent simultaneous modifications. It implements distributed lock management
 * using Yjs shared data types with timeout and heartbeat mechanisms.
 */
export default class CellLocking implements ICellLockManager, IDisposable {
  private _provider: YjsNotebookProvider;
  private _awareness: UserAwareness;
  private _locksMap: Y.Map<any>;
  private _activeLocks = new Map<string, ICellLock>();
  private _heartbeatTimers = new Map<string, number>();
  private _lockTimeouts = new Map<string, number>();
  private _config: Required<ILockOptions>;
  private _disposed = false;

  // Visual indicator settings
  private _visualIndicatorSettings = {
    enableVisualIndicators: true,
    lockIndicatorColor: '#ff6b6b',
    lockIndicatorOpacity: 0.3,
    lockBorderWidth: 2,
    lockBorderStyle: 'solid'
  };

  // Lock acquisition timeout
  private _lockAcquisitionTimeout = 5000; // 5 seconds

  // Signals for lock events
  private _onLockStateChanged = new Signal<ICellLockManager, ILockEvent>(this);
  private _onLockAcquired = new Signal<ICellLockManager, ICellLock>(this);
  private _onLockReleased = new Signal<ICellLockManager, ICellLock>(this);
  private _onLockExpired = new Signal<ICellLockManager, ICellLock>(this);
  private _onLockTimeout = new Signal<ICellLockManager, ICellLock>(this);

  /**
   * Construct a new CellLocking instance
   *
   * @param provider - The Yjs notebook provider instance
   * @param awareness - The user awareness system
   * @param config - Configuration options for the lock system
   */
  constructor(
    provider: YjsNotebookProvider,
    awareness: UserAwareness,
    config: Partial<ILockOptions> = {}
  ) {
    this._provider = provider;
    this._awareness = awareness;
    this._config = { ...DEFAULT_LOCK_CONFIG, ...config };
    this._locksMap = provider.yjsDocument.getMap('cellLocks');

    // Initialize lock system
    this._initializeLockSystem();
  }

  /**
   * Get lock acquisition timeout
   */
  get lockAcquisitionTimeout(): number {
    return this._lockAcquisitionTimeout;
  }

  /**
   * Set lock acquisition timeout
   */
  set lockAcquisitionTimeout(timeout: number) {
    this._lockAcquisitionTimeout = timeout;
  }

  /**
   * Get visual indicator settings
   */
  get visualIndicatorSettings(): any {
    return { ...this._visualIndicatorSettings };
  }

  /**
   * Set visual indicator settings
   */
  set visualIndicatorSettings(settings: any) {
    this._visualIndicatorSettings = { ...this._visualIndicatorSettings, ...settings };
  }

  /**
   * Signal emitted when lock state changes
   */
  get onLockStateChanged(): ISignal<ICellLockManager, ILockEvent> {
    return this._onLockStateChanged;
  }

  /**
   * Signal emitted when lock is acquired
   */
  get onLockAcquired(): ISignal<ICellLockManager, ICellLock> {
    return this._onLockAcquired;
  }

  /**
   * Signal emitted when lock is released
   */
  get onLockReleased(): ISignal<ICellLockManager, ICellLock> {
    return this._onLockReleased;
  }

  /**
   * Signal emitted when lock expires
   */
  get onLockExpired(): ISignal<ICellLockManager, ICellLock> {
    return this._onLockExpired;
  }

  /**
   * Signal emitted when lock times out
   */
  get onLockTimeout(): ISignal<ICellLockManager, ICellLock> {
    return this._onLockTimeout;
  }

  /**
   * Acquire a lock for a cell
   */
  async acquireLock(cellId: string, options: ILockOptions = {}): Promise<ICellLock | null> {
    if (this._disposed) {
      throw new Error('CellLocking has been disposed');
    }

    const lockOptions = { ...this._config, ...options };
    const currentUser = this._awareness.getCurrentUser();
    
    if (!currentUser) {
      console.warn('Cannot acquire lock: no current user');
      return null;
    }

    // Check if cell is already locked
    const existingLock = this._getActiveLockForCell(cellId);
    if (existingLock) {
      // Check if current user already owns the lock
      if (existingLock.ownerId === currentUser.id) {
        // Refresh the existing lock
        return this._refreshLock(existingLock);
      } else {
        // Cell is locked by another user
        const event = this._createLockEvent(
          LockEventType.LOCK_CONFLICT,
          existingLock,
          LockState.ACTIVE,
          LockState.CONFLICT,
          'Cell is already locked by another user'
        );
        this._onLockStateChanged.emit(event);
        return null;
      }
    }

    // Create new lock
    const lock: ICellLock = {
      id: UUID.uuid4(),
      cellId,
      owner: currentUser.displayName || currentUser.username,
      ownerId: currentUser.id,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + lockOptions.timeout,
      timeout: lockOptions.timeout,
      isActive: true,
      sessionId: this._provider.sessionId,
      heartbeatInterval: lockOptions.heartbeatInterval,
      lastHeartbeat: Date.now(),
      lockType: lockOptions.lockType,
      metadata: lockOptions.metadata
    };

    try {
      // Add lock to Yjs document
      this._locksMap.set(lock.id, this._serializeLock(lock));
      
      // Add to local tracking
      this._activeLocks.set(cellId, lock);

      // Set up lock expiration timer
      this._setupLockExpiration(lock);

      // Start heartbeat if enabled
      if (lockOptions.heartbeatInterval > 0) {
        this.startHeartbeat(lock.id);
      }

      // Emit lock acquired event
      const event = this._createLockEvent(
        LockEventType.LOCK_ACQUIRED,
        lock,
        LockState.PENDING,
        LockState.ACQUIRED,
        'Lock acquired successfully'
      );
      this._onLockStateChanged.emit(event);
      this._onLockAcquired.emit(lock);

      return lock;
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      
      const event = this._createLockEvent(
        LockEventType.LOCK_ERROR,
        lock,
        LockState.PENDING,
        LockState.ERROR,
        `Failed to acquire lock: ${error instanceof Error ? error.message : String(error)}`
      );
      this._onLockStateChanged.emit(event);
      
      return null;
    }
  }

  /**
   * Release a lock for a cell
   */
  async releaseLock(cellId: string): Promise<boolean> {
    if (this._disposed) {
      throw new Error('CellLocking has been disposed');
    }

    const lock = this._activeLocks.get(cellId);
    if (!lock) {
      return false;
    }

    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser || lock.ownerId !== currentUser.id) {
      console.warn('Cannot release lock: not owned by current user');
      return false;
    }

    try {
      // Remove lock from Yjs document
      this._locksMap.delete(lock.id);
      
      // Remove from local tracking
      this._activeLocks.delete(cellId);

      // Clear timers
      this._clearLockTimers(lock.id);

      // Mark lock as released
      lock.isActive = false;

      // Emit lock released event
      const event = this._createLockEvent(
        LockEventType.LOCK_RELEASED,
        lock,
        LockState.ACTIVE,
        LockState.RELEASED,
        'Lock released by user'
      );
      this._onLockStateChanged.emit(event);
      this._onLockReleased.emit(lock);

      return true;
    } catch (error) {
      console.error('Failed to release lock:', error);
      
      const event = this._createLockEvent(
        LockEventType.LOCK_ERROR,
        lock,
        LockState.ACTIVE,
        LockState.ERROR,
        `Failed to release lock: ${error instanceof Error ? error.message : String(error)}`
      );
      this._onLockStateChanged.emit(event);
      
      return false;
    }
  }

  /**
   * Check if a cell is locked
   */
  isLocked(cellId: string): boolean {
    const lock = this._activeLocks.get(cellId);
    return lock !== undefined && lock.isActive && !this._isLockExpired(lock);
  }

  /**
   * Get lock owner for a cell
   */
  getLockOwner(cellId: string): string | null {
    const lock = this._activeLocks.get(cellId);
    return lock && lock.isActive && !this._isLockExpired(lock) ? lock.owner : null;
  }

  /**
   * Get lock by ID
   */
  getLockById(lockId: string): ICellLock | null {
    const locks = Array.from(this._activeLocks.values());
    for (const lock of locks) {
      if (lock.id === lockId) {
        return lock;
      }
    }
    return null;
  }

  /**
   * Get all active locks
   */
  getActiveLocks(): ICellLock[] {
    return Array.from(this._activeLocks.values()).filter(
      lock => lock.isActive && !this._isLockExpired(lock)
    );
  }

  /**
   * Get locks owned by a user
   */
  getUserLocks(userId: string): ICellLock[] {
    return this.getActiveLocks().filter(lock => lock.ownerId === userId);
  }

  /**
   * Set lock timeout
   */
  setLockTimeout(timeout: number): void {
    this._config.timeout = timeout;
  }

  /**
   * Get lock timeout
   */
  getLockTimeout(): number {
    return this._config.timeout;
  }

  /**
   * Start heartbeat for a lock
   */
  startHeartbeat(lockId: string): void {
    const lock = this.getLockById(lockId);
    if (!lock) {
      return;
    }

    // Clear existing heartbeat
    this.stopHeartbeat(lockId);

    // Start new heartbeat timer
    const timer = window.setInterval(() => {
      this._sendHeartbeat(lock);
    }, lock.heartbeatInterval);

    this._heartbeatTimers.set(lockId, timer);
  }

  /**
   * Stop heartbeat for a lock
   */
  stopHeartbeat(lockId: string): void {
    const timer = this._heartbeatTimers.get(lockId);
    if (timer) {
      clearInterval(timer);
      this._heartbeatTimers.delete(lockId);
    }
  }

  /**
   * Check if the lock system is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the lock system
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Release all locks owned by current user
    const currentUser = this._awareness.getCurrentUser();
    if (currentUser) {
      const userLocks = this.getUserLocks(currentUser.id);
      for (const lock of userLocks) {
        this.releaseLock(lock.cellId).catch(console.error);
      }
    }

    // Clear all timers
    const heartbeatEntries = Array.from(this._heartbeatTimers.entries());
    for (const [lockId] of heartbeatEntries) {
      this.stopHeartbeat(lockId);
    }
    
    const timeoutEntries = Array.from(this._lockTimeouts.entries());
    for (const [, timer] of timeoutEntries) {
      clearTimeout(timer);
    }
    this._lockTimeouts.clear();

    // Clean up Yjs observers
    this._cleanupObservers();

    // Clear local state
    this._activeLocks.clear();

    // Clear signals
    Signal.clearData(this);
  }

  /**
   * Initialize the lock system
   */
  private _initializeLockSystem(): void {
    // Set up Yjs document observers
    this._setupObservers();

    // Set up provider connection monitoring
    this._provider.onConnectionStateChanged.connect(this._onConnectionStateChanged, this);

    // Set up awareness monitoring for user status changes
    this._awareness.onUsersChanged.connect(this._onUsersChanged, this);

    // Load existing locks from Yjs document
    this._loadExistingLocks();
  }

  /**
   * Set up Yjs document observers
   */
  private _setupObservers(): void {
    // Observe changes to locks map
    this._locksMap.observe(this._onLocksMapChanged.bind(this));

    // Observe document changes for lock-related updates
    this._provider.onDocumentChanged.connect(this._onDocumentChanged, this);
  }

  /**
   * Clean up Yjs observers
   */
  private _cleanupObservers(): void {
    try {
      // Unobserve locks map
      this._locksMap.unobserve(this._onLocksMapChanged.bind(this));
    } catch (error) {
      console.warn('Error cleaning up lock observers:', error);
    }
  }

  /**
   * Handle locks map changes
   */
  private _onLocksMapChanged(event: Y.YMapEvent<any>): void {
    const changes = event.changes.keys;
    changes.forEach((change, lockId) => {
      if (change.action === 'add' || change.action === 'update') {
        this._handleLockAdded(lockId, this._locksMap.get(lockId));
      } else if (change.action === 'delete') {
        this._handleLockRemoved(lockId);
      }
    });
  }

  /**
   * Handle lock added to Yjs document
   */
  private _handleLockAdded(lockId: string, lockData: any): void {
    if (!lockData) {
      return;
    }

    const lock = this._deserializeLock(lockData);
    const currentUser = this._awareness.getCurrentUser();
    
    // Only track locks for other users (our own locks are already tracked)
    if (currentUser && lock.ownerId !== currentUser.id) {
      this._activeLocks.set(lock.cellId, lock);
    }

    // Set up expiration timer for remote locks
    this._setupLockExpiration(lock);
  }

  /**
   * Handle lock removed from Yjs document
   */
  private _handleLockRemoved(lockId: string): void {
    // Find and remove lock from local tracking
    const entries = Array.from(this._activeLocks.entries());
    for (const [cellId, lock] of entries) {
      if (lock.id === lockId) {
        this._activeLocks.delete(cellId);
        this._clearLockTimers(lockId);
        break;
      }
    }
  }

  /**
   * Handle document changes
   */
  private _onDocumentChanged(sender: YjsNotebookProvider, event: any): void {
    // Update user activity when document changes
    // This can be used to track if users are actively editing
  }

  /**
   * Handle connection state changes
   */
  private _onConnectionStateChanged(sender: YjsNotebookProvider, state: any): void {
    if (!state.connected) {
      // Connection lost - implement offline behavior
      this._handleOfflineMode();
    } else {
      // Connection restored - sync locks
      this._handleOnlineMode();
    }
  }

  /**
   * Handle users changed
   */
  private _onUsersChanged(sender: import('./awareness').IUserAwareness, users: Map<string, import('./awareness').IUser>): void {
    // Check for inactive users and clean up their locks
    this._cleanupInactiveUserLocks(users);
  }

  /**
   * Load existing locks from Yjs document
   */
  private _loadExistingLocks(): void {
    this._locksMap.forEach((lockData, lockId) => {
      const lock = this._deserializeLock(lockData);
      
      // Check if lock is still valid
      if (!this._isLockExpired(lock)) {
        this._activeLocks.set(lock.cellId, lock);
        this._setupLockExpiration(lock);
      } else {
        // Remove expired lock
        this._locksMap.delete(lockId);
      }
    });
  }

  /**
   * Get active lock for a cell
   */
  private _getActiveLockForCell(cellId: string): ICellLock | null {
    const lock = this._activeLocks.get(cellId);
    return lock && lock.isActive && !this._isLockExpired(lock) ? lock : null;
  }

  /**
   * Check if a lock is expired
   */
  private _isLockExpired(lock: ICellLock): boolean {
    return Date.now() > lock.expiresAt;
  }

  /**
   * Refresh an existing lock
   */
  private _refreshLock(lock: ICellLock): ICellLock {
    const now = Date.now();
    lock.lastHeartbeat = now;
    lock.expiresAt = now + lock.timeout;

    // Update in Yjs document
    this._locksMap.set(lock.id, this._serializeLock(lock));

    // Reset expiration timer
    this._setupLockExpiration(lock);

    return lock;
  }

  /**
   * Set up lock expiration timer
   */
  private _setupLockExpiration(lock: ICellLock): void {
    // Clear existing timer
    const existingTimer = this._lockTimeouts.get(lock.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timeUntilExpiry = lock.expiresAt - Date.now();
    if (timeUntilExpiry > 0) {
      const timer = window.setTimeout(() => {
        this._handleLockExpired(lock);
      }, timeUntilExpiry);
      
      this._lockTimeouts.set(lock.id, timer);
    }
  }

  /**
   * Handle lock expiration
   */
  private _handleLockExpired(lock: ICellLock): void {
    // Remove from local tracking
    this._activeLocks.delete(lock.cellId);
    
    // Remove from Yjs document
    this._locksMap.delete(lock.id);
    
    // Clear timers
    this._clearLockTimers(lock.id);
    
    // Mark as expired
    lock.isActive = false;
    
    // Emit expired event
    const event = this._createLockEvent(
      LockEventType.LOCK_EXPIRED,
      lock,
      LockState.ACTIVE,
      LockState.EXPIRED,
      'Lock expired due to timeout'
    );
    this._onLockStateChanged.emit(event);
    this._onLockExpired.emit(lock);
  }

  /**
   * Send heartbeat for a lock
   */
  private _sendHeartbeat(lock: ICellLock): void {
    if (this._disposed || !lock.isActive) {
      return;
    }

    const now = Date.now();
    lock.lastHeartbeat = now;

    // Update in Yjs document
    this._locksMap.set(lock.id, this._serializeLock(lock));

    // Emit heartbeat event
    const event = this._createLockEvent(
      LockEventType.HEARTBEAT_RECEIVED,
      lock,
      LockState.ACTIVE,
      LockState.ACTIVE,
      'Heartbeat sent'
    );
    this._onLockStateChanged.emit(event);
  }

  /**
   * Clear all timers for a lock
   */
  private _clearLockTimers(lockId: string): void {
    // Clear heartbeat timer
    this.stopHeartbeat(lockId);
    
    // Clear expiration timer
    const timer = this._lockTimeouts.get(lockId);
    if (timer) {
      clearTimeout(timer);
      this._lockTimeouts.delete(lockId);
    }
  }

  /**
   * Handle offline mode
   */
  private _handleOfflineMode(): void {
    // In offline mode, maintain local locks but don't sync to others
    console.log('Cell locking: Entered offline mode');
  }

  /**
   * Handle online mode
   */
  private _handleOnlineMode(): void {
    // When coming back online, sync locks with other users
    console.log('Cell locking: Entered online mode');
    this._loadExistingLocks();
  }

  /**
   * Clean up locks for inactive users
   */
  private _cleanupInactiveUserLocks(users: Map<string, any>): void {
    const activeUserIds = new Set(users.keys());
    
    const entries = Array.from(this._activeLocks.entries());
    for (const [cellId, lock] of entries) {
      if (!activeUserIds.has(lock.ownerId)) {
        // User is no longer active, remove their locks
        this._activeLocks.delete(cellId);
        this._locksMap.delete(lock.id);
        this._clearLockTimers(lock.id);
        
        // Emit expired event
        const event = this._createLockEvent(
          LockEventType.LOCK_EXPIRED,
          lock,
          LockState.ACTIVE,
          LockState.EXPIRED,
          'Lock expired due to user inactivity'
        );
        this._onLockStateChanged.emit(event);
        this._onLockExpired.emit(lock);
      }
    }
  }

  /**
   * Serialize a lock for storage in Yjs document
   */
  private _serializeLock(lock: ICellLock): any {
    return {
      id: lock.id,
      cellId: lock.cellId,
      owner: lock.owner,
      ownerId: lock.ownerId,
      acquiredAt: lock.acquiredAt,
      expiresAt: lock.expiresAt,
      timeout: lock.timeout,
      isActive: lock.isActive,
      sessionId: lock.sessionId,
      heartbeatInterval: lock.heartbeatInterval,
      lastHeartbeat: lock.lastHeartbeat,
      lockType: lock.lockType,
      metadata: lock.metadata
    };
  }

  /**
   * Deserialize a lock from Yjs document
   */
  private _deserializeLock(lockData: any): ICellLock {
    return {
      id: lockData.id,
      cellId: lockData.cellId,
      owner: lockData.owner,
      ownerId: lockData.ownerId,
      acquiredAt: lockData.acquiredAt,
      expiresAt: lockData.expiresAt,
      timeout: lockData.timeout,
      isActive: lockData.isActive,
      sessionId: lockData.sessionId,
      heartbeatInterval: lockData.heartbeatInterval,
      lastHeartbeat: lockData.lastHeartbeat,
      lockType: lockData.lockType,
      metadata: lockData.metadata
    };
  }

  /**
   * Create a lock event
   */
  private _createLockEvent(
    type: LockEventType,
    lock: ICellLock,
    previousState: LockState,
    newState: LockState,
    reason: string
  ): ILockEvent {
    return {
      type,
      lock,
      cellId: lock.cellId,
      owner: lock.owner,
      timestamp: Date.now(),
      previousState,
      newState,
      reason,
      metadata: {}
    };
  }
}