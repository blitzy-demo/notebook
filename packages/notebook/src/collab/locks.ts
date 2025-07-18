/**
 * @fileoverview Cell locking mechanism for collaborative notebook editing
 * 
 * This module implements comprehensive cell-level locking to prevent simultaneous
 * editing conflicts during collaborative sessions. It uses the Yjs CRDT framework
 * for conflict-free lock state synchronization across all connected clients.
 * 
 * Key features:
 * - Cell-level locking using Yjs shared data for real-time synchronization
 * - Automatic timeout handling to prevent abandoned locks
 * - Visual indicators showing current lock owners
 * - Permission-based lock acquisition with role validation
 * - Conflict resolution through CRDT properties
 * - Comprehensive event system for lock state changes
 * - Lock ownership tracking with user identification
 * 
 * The system ensures that only one user can edit a cell at a time while maintaining
 * the collaborative nature of the notebook environment.
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { Doc } from 'yjs';
import { Signal, ISignal } from '@lumino/signaling';
import { DisposableSet, IDisposable, DisposableDelegate } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';

import { AwarenessService } from './awareness';
import { PermissionService } from './permissions';
import { ILockService } from '../tokens';

/**
 * Enumeration of lock event types for comprehensive event handling
 */
export enum LockEventType {
  /** Lock was successfully acquired by a user */
  LOCK_ACQUIRED = 'lock_acquired',
  /** Lock was released by the owner */
  LOCK_RELEASED = 'lock_released',
  /** Lock timed out due to inactivity */
  LOCK_TIMEOUT = 'lock_timeout',
  /** Lock conflict occurred during acquisition attempt */
  LOCK_CONFLICT = 'lock_conflict',
  /** Lock expired and was automatically released */
  LOCK_EXPIRED = 'lock_expired'
}

/**
 * Interface representing the complete state of a cell lock
 */
export interface ILockState {
  /** Unique identifier of the locked cell */
  cellId: string;
  /** Unique identifier for this specific lock instance */
  lockId: string;
  /** User ID of the lock owner */
  userId: string;
  /** Display name of the lock owner */
  userName: string;
  /** Timestamp when the lock was acquired */
  timestamp: Date;
  /** Lock timeout duration in milliseconds */
  timeout: number;
  /** Whether the lock is currently active */
  isActive: boolean;
  /** Additional metadata associated with the lock */
  metadata?: Record<string, any>;
}

/**
 * Interface representing a lock event for notifications and logging
 */
export interface ILockEvent {
  /** Type of lock event that occurred */
  type: LockEventType;
  /** ID of the cell involved in the event */
  cellId: string;
  /** ID of the lock instance */
  lockId: string;
  /** User ID associated with the event */
  userId: string;
  /** Timestamp when the event occurred */
  timestamp: Date;
  /** Current lock state after the event */
  lockState: ILockState | null;
  /** Additional event metadata */
  metadata?: Record<string, any>;
}

/**
 * Interface for lock acquisition options
 */
export interface ILockOptions {
  /** Custom timeout duration in milliseconds */
  timeout?: number;
  /** Force lock acquisition even if cell is locked */
  force?: boolean;
  /** Additional metadata to associate with the lock */
  metadata?: Record<string, any>;
  /** Callback function for lock events */
  callback?: (event: ILockEvent) => void;
}

/**
 * Main lock service class that manages cell-level locking in collaborative notebooks
 * 
 * This service provides comprehensive lock management including acquisition, release,
 * timeout handling, and conflict resolution. It integrates with the awareness system
 * for user tracking and the permission system for access control.
 */
export class LockService implements ILockService, IDisposable {
  private _doc: Doc;
  private _awarenessService: AwarenessService;
  private _permissionService: PermissionService;
  private _disposed: boolean = false;
  private _disposables: DisposableSet = new DisposableSet();
  private _lockTimers: Map<string, number> = new Map();
  private _lockStates: Map<string, ILockState> = new Map();
  private _defaultTimeout: number = 300000; // 5 minutes in milliseconds
  private _lockCleanupInterval: number | null = null;
  
  // Signals for lock events
  private _lockChangeSignal = new Signal<ILockService, {
    cellId: string;
    isLocked: boolean;
    owner?: {userId: string; name: string};
  }>(this);

  /**
   * Creates a new lock service instance
   * 
   * @param doc - The Yjs document for collaborative editing
   * @param awarenessService - Service for tracking user presence
   * @param permissionService - Service for managing user permissions
   * @param options - Optional initialization options
   */
  constructor(
    doc: Doc,
    awarenessService: AwarenessService,
    permissionService: PermissionService,
    options?: {
      defaultTimeout?: number;
      cleanupInterval?: number;
    }
  ) {
    this._doc = doc;
    this._awarenessService = awarenessService;
    this._permissionService = permissionService;
    
    if (options?.defaultTimeout) {
      this._defaultTimeout = options.defaultTimeout;
    }
    
    this._initializeLockData();
    this._setupEventListeners();
    this._startLockCleanup(options?.cleanupInterval || 30000); // 30 seconds
  }

  /**
   * Signal emitted when a cell lock state changes
   */
  get onLockChange(): ISignal<ILockService, {
    cellId: string;
    isLocked: boolean;
    owner?: {userId: string; name: string};
  }> {
    return this._lockChangeSignal;
  }

  /**
   * Check if a cell is currently locked by another user
   * 
   * @param cellId - The cell ID to check
   * @returns Promise resolving to true if cell is locked
   */
  async isLocked(cellId: string): Promise<boolean> {
    if (this._disposed) {
      return false;
    }

    const lockData = this._getLockDataFromYjs(cellId);
    if (!lockData) {
      return false;
    }

    // Check if lock is still valid (not expired)
    const now = Date.now();
    const lockTime = new Date(lockData.timestamp).getTime();
    const isExpired = now > lockTime + lockData.timeout;
    
    if (isExpired) {
      // Clean up expired lock
      await this._cleanupExpiredLock(cellId);
      return false;
    }

    // Check if lock is by current user
    const currentUser = this._awarenessService.getCurrentUser();
    if (lockData.userId === currentUser.userId) {
      return false; // Current user's own lock doesn't count as "locked"
    }

    return lockData.isActive;
  }

  /**
   * Attempt to lock a cell for exclusive editing
   * 
   * @param cellId - The cell ID to lock
   * @param timeout - Optional timeout in milliseconds
   * @returns Promise resolving to true if lock was acquired
   */
  async lockCell(cellId: string, timeout?: number): Promise<boolean> {
    if (this._disposed) {
      return false;
    }

    // Check permissions first
    if (!await this.canLock()) {
      return false;
    }

    const currentUser = this._awarenessService.getCurrentUser();
    const lockTimeout = timeout || this._defaultTimeout;
    const lockId = UUID.uuid4();
    const now = new Date();

    // Check if cell is already locked by another user
    const existingLock = this._getLockDataFromYjs(cellId);
    if (existingLock && existingLock.userId !== currentUser.userId) {
      const lockTime = new Date(existingLock.timestamp).getTime();
      const isExpired = Date.now() > lockTime + existingLock.timeout;
      
      if (!isExpired) {
        // Cell is locked by another user
        this._emitLockEvent({
          type: LockEventType.LOCK_CONFLICT,
          cellId,
          lockId,
          userId: currentUser.userId,
          timestamp: now,
          lockState: null,
          metadata: {
            conflictWith: existingLock.userId,
            reason: 'Cell already locked by another user'
          }
        });
        return false;
      } else {
        // Existing lock is expired, clean it up
        await this._cleanupExpiredLock(cellId);
      }
    }

    // Create new lock state
    const lockState: ILockState = {
      cellId,
      lockId,
      userId: currentUser.userId,
      userName: currentUser.name,
      timestamp: now,
      timeout: lockTimeout,
      isActive: true,
      metadata: {
        lockType: 'exclusive',
        source: 'user_interaction'
      }
    };

    // Store lock in Yjs document
    this._doc.transact(() => {
      const locks = this._doc.getMap('locks');
      locks.set(cellId, {
        lockId: lockState.lockId,
        userId: lockState.userId,
        userName: lockState.userName,
        timestamp: lockState.timestamp.toISOString(),
        timeout: lockState.timeout,
        isActive: lockState.isActive,
        metadata: lockState.metadata
      });
    });

    // Update local state
    this._lockStates.set(cellId, lockState);

    // Set up timeout timer
    const timer = setTimeout(() => {
      this._handleLockTimeout(cellId);
    }, lockTimeout);
    this._lockTimers.set(cellId, timer);

    // Emit lock acquired event
    this._emitLockEvent({
      type: LockEventType.LOCK_ACQUIRED,
      cellId,
      lockId,
      userId: currentUser.userId,
      timestamp: now,
      lockState,
      metadata: {
        timeout: lockTimeout
      }
    });

    // Emit lock change signal
    this._lockChangeSignal.emit({
      cellId,
      isLocked: true,
      owner: {
        userId: currentUser.userId,
        name: currentUser.name
      }
    });

    return true;
  }

  /**
   * Release a lock on a cell
   * 
   * @param cellId - The cell ID to unlock
   * @returns Promise resolving when lock is released
   */
  async unlockCell(cellId: string): Promise<void> {
    if (this._disposed) {
      return;
    }

    const lockState = this._lockStates.get(cellId);
    if (!lockState) {
      return; // No lock to release
    }

    const currentUser = this._awarenessService.getCurrentUser();
    
    // Check if current user owns the lock
    if (lockState.userId !== currentUser.userId) {
      // Check if user has admin permissions to force unlock
      const canAdmin = await this._permissionService.canAdmin();
      if (!canAdmin) {
        return; // Cannot unlock another user's lock
      }
    }

    // Clear timeout timer
    const timer = this._lockTimers.get(cellId);
    if (timer) {
      clearTimeout(timer);
      this._lockTimers.delete(cellId);
    }

    // Remove lock from Yjs document
    this._doc.transact(() => {
      const locks = this._doc.getMap('locks');
      locks.delete(cellId);
    });

    // Update local state
    this._lockStates.delete(cellId);

    // Emit lock released event
    this._emitLockEvent({
      type: LockEventType.LOCK_RELEASED,
      cellId,
      lockId: lockState.lockId,
      userId: currentUser.userId,
      timestamp: new Date(),
      lockState: null,
      metadata: {
        previousOwner: lockState.userId,
        releasedBy: currentUser.userId
      }
    });

    // Emit lock change signal
    this._lockChangeSignal.emit({
      cellId,
      isLocked: false
    });
  }

  /**
   * Get information about who owns a cell lock
   * 
   * @param cellId - The cell ID to check
   * @returns Promise resolving to lock owner information or null
   */
  async getLockOwner(cellId: string): Promise<{
    userId: string;
    name: string;
    lockedAt: Date;
    timeout?: number;
  } | null> {
    if (this._disposed) {
      return null;
    }

    const lockState = this._lockStates.get(cellId);
    if (!lockState || !lockState.isActive) {
      return null;
    }

    // Check if lock is still valid
    const now = Date.now();
    const lockTime = lockState.timestamp.getTime();
    const isExpired = now > lockTime + lockState.timeout;
    
    if (isExpired) {
      // Clean up expired lock
      await this._cleanupExpiredLock(cellId);
      return null;
    }

    return {
      userId: lockState.userId,
      name: lockState.userName,
      lockedAt: lockState.timestamp,
      timeout: lockState.timeout
    };
  }

  /**
   * Check if the current user can lock cells
   * 
   * @returns Promise resolving to true if user can lock cells
   */
  async canLock(): Promise<boolean> {
    if (this._disposed) {
      return false;
    }

    try {
      return await this._permissionService.canLock();
    } catch (error) {
      console.error('Error checking lock permissions:', error);
      return false;
    }
  }

  /**
   * Get the default lock timeout for cells
   * 
   * @returns Lock timeout in milliseconds
   */
  getLockTimeout(): number {
    return this._defaultTimeout;
  }

  /**
   * Subscribe to lock changes for a specific cell
   * 
   * @param cellId - The cell ID to monitor
   * @param callback - Callback function for lock changes
   * @returns Disposable subscription
   */
  subscribeToLockChanges(cellId: string, callback: (isLocked: boolean, owner?: {userId: string; name: string}) => void): IDisposable {
    const onLockChange = (sender: ILockService, args: {
      cellId: string;
      isLocked: boolean;
      owner?: {userId: string; name: string};
    }) => {
      if (args.cellId === cellId) {
        callback(args.isLocked, args.owner);
      }
    };

    this._lockChangeSignal.connect(onLockChange);
    
    return new DisposableDelegate(() => {
      this._lockChangeSignal.disconnect(onLockChange);
    });
  }

  /**
   * Create a new lock service instance
   * 
   * @param doc - The Yjs document for collaborative editing
   * @param awarenessService - Service for tracking user presence
   * @param permissionService - Service for managing user permissions
   * @param options - Optional initialization options
   * @returns A new lock service instance
   */
  create(
    doc: Doc,
    awarenessService: AwarenessService,
    permissionService: PermissionService,
    options?: {
      defaultTimeout?: number;
      cleanupInterval?: number;
    }
  ): LockService {
    return new LockService(doc, awarenessService, permissionService, options);
  }

  /**
   * Initialize the lock service
   * 
   * @param options - Initialization options
   * @returns Promise resolving when service is initialized
   */
  async initialize(options?: any): Promise<void> {
    if (this._disposed) {
      throw new Error('Cannot initialize disposed lock service');
    }

    // Sync existing locks from Yjs document
    await this._syncLocksFromYjs();
    
    // Service is initialized in constructor
    // This method is provided for interface compliance
    return Promise.resolve();
  }

  /**
   * Check if the service is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the lock service and cleanup resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Clear all lock timers
    for (const timer of this._lockTimers.values()) {
      clearTimeout(timer);
    }
    this._lockTimers.clear();

    // Clear cleanup interval
    if (this._lockCleanupInterval) {
      clearInterval(this._lockCleanupInterval);
      this._lockCleanupInterval = null;
    }

    // Dispose of all disposables
    this._disposables.dispose();

    // Clear local state
    this._lockStates.clear();
  }

  /**
   * Initialize lock data structures in the Yjs document
   */
  private _initializeLockData(): void {
    if (!this._doc.getMap('locks')) {
      this._doc.getMap('locks');
    }
  }

  /**
   * Set up event listeners for lock changes
   */
  private _setupEventListeners(): void {
    // Listen for changes to lock data in Yjs document
    const locks = this._doc.getMap('locks');
    
    const onLockUpdate = (event: any) => {
      this._handleYjsLockUpdate(event);
    };

    locks.observe(onLockUpdate);
    this._disposables.add(new DisposableDelegate(() => {
      locks.unobserve(onLockUpdate);
    }));

    // Listen for user leaving to clean up their locks
    this._awarenessService.onUserLeave.connect(this._onUserLeave, this);
    this._disposables.add(new DisposableDelegate(() => {
      this._awarenessService.onUserLeave.disconnect(this._onUserLeave, this);
    }));
  }

  /**
   * Start periodic cleanup of expired locks
   * 
   * @param interval - Cleanup interval in milliseconds
   */
  private _startLockCleanup(interval: number): void {
    this._lockCleanupInterval = setInterval(() => {
      this._cleanupExpiredLocks();
    }, interval);
  }

  /**
   * Clean up all expired locks
   */
  private async _cleanupExpiredLocks(): Promise<void> {
    if (this._disposed) {
      return;
    }

    const now = Date.now();
    const expiredCells: string[] = [];

    // Check all local lock states for expiration
    for (const [cellId, lockState] of this._lockStates) {
      const lockTime = lockState.timestamp.getTime();
      const isExpired = now > lockTime + lockState.timeout;
      
      if (isExpired) {
        expiredCells.push(cellId);
      }
    }

    // Clean up expired locks
    for (const cellId of expiredCells) {
      await this._cleanupExpiredLock(cellId);
    }
  }

  /**
   * Clean up a specific expired lock
   * 
   * @param cellId - The cell ID whose lock to clean up
   */
  private async _cleanupExpiredLock(cellId: string): Promise<void> {
    const lockState = this._lockStates.get(cellId);
    if (!lockState) {
      return;
    }

    // Clear timeout timer
    const timer = this._lockTimers.get(cellId);
    if (timer) {
      clearTimeout(timer);
      this._lockTimers.delete(cellId);
    }

    // Remove lock from Yjs document
    this._doc.transact(() => {
      const locks = this._doc.getMap('locks');
      locks.delete(cellId);
    });

    // Update local state
    this._lockStates.delete(cellId);

    // Emit lock expired event
    this._emitLockEvent({
      type: LockEventType.LOCK_EXPIRED,
      cellId,
      lockId: lockState.lockId,
      userId: lockState.userId,
      timestamp: new Date(),
      lockState: null,
      metadata: {
        reason: 'Lock timeout expired',
        originalTimeout: lockState.timeout
      }
    });

    // Emit lock change signal
    this._lockChangeSignal.emit({
      cellId,
      isLocked: false
    });
  }

  /**
   * Handle lock timeout for a specific cell
   * 
   * @param cellId - The cell ID whose lock timed out
   */
  private _handleLockTimeout(cellId: string): void {
    const lockState = this._lockStates.get(cellId);
    if (!lockState) {
      return;
    }

    // Emit timeout event
    this._emitLockEvent({
      type: LockEventType.LOCK_TIMEOUT,
      cellId,
      lockId: lockState.lockId,
      userId: lockState.userId,
      timestamp: new Date(),
      lockState: lockState,
      metadata: {
        reason: 'Lock timeout reached',
        timeout: lockState.timeout
      }
    });

    // Clean up the expired lock
    this._cleanupExpiredLock(cellId);
  }

  /**
   * Handle updates to the Yjs lock document
   * 
   * @param event - The Yjs update event
   */
  private _handleYjsLockUpdate(event: any): void {
    if (this._disposed) {
      return;
    }

    const currentUser = this._awarenessService.getCurrentUser();
    
    // Process changes in the lock document
    for (const [cellId, lockData] of event.target.entries()) {
      if (lockData === undefined) {
        // Lock was removed
        const localLock = this._lockStates.get(cellId);
        if (localLock) {
          this._lockStates.delete(cellId);
          
          // Clear timer if it exists
          const timer = this._lockTimers.get(cellId);
          if (timer) {
            clearTimeout(timer);
            this._lockTimers.delete(cellId);
          }

          // Only emit event if it wasn't removed by current user
          if (localLock.userId !== currentUser.userId) {
            this._lockChangeSignal.emit({
              cellId,
              isLocked: false
            });
          }
        }
      } else {
        // Lock was added or updated
        const lockState: ILockState = {
          cellId,
          lockId: lockData.lockId,
          userId: lockData.userId,
          userName: lockData.userName,
          timestamp: new Date(lockData.timestamp),
          timeout: lockData.timeout,
          isActive: lockData.isActive,
          metadata: lockData.metadata
        };

        // Update local state
        this._lockStates.set(cellId, lockState);

        // Set up timeout timer if this is not our own lock
        if (lockState.userId !== currentUser.userId) {
          const now = Date.now();
          const lockTime = lockState.timestamp.getTime();
          const remainingTime = (lockTime + lockState.timeout) - now;
          
          if (remainingTime > 0) {
            const timer = setTimeout(() => {
              this._handleLockTimeout(cellId);
            }, remainingTime);
            this._lockTimers.set(cellId, timer);
          }

          // Emit lock change signal
          this._lockChangeSignal.emit({
            cellId,
            isLocked: true,
            owner: {
              userId: lockState.userId,
              name: lockState.userName
            }
          });
        }
      }
    }
  }

  /**
   * Get lock data from the Yjs document
   * 
   * @param cellId - The cell ID to get lock data for
   * @returns Lock data or null if not found
   */
  private _getLockDataFromYjs(cellId: string): any | null {
    const locks = this._doc.getMap('locks');
    return locks.get(cellId) || null;
  }

  /**
   * Synchronize locks from the Yjs document
   */
  private async _syncLocksFromYjs(): Promise<void> {
    const locks = this._doc.getMap('locks');
    
    for (const [cellId, lockData] of locks.entries()) {
      if (lockData && typeof lockData === 'object') {
        const lockState: ILockState = {
          cellId,
          lockId: lockData.lockId,
          userId: lockData.userId,
          userName: lockData.userName,
          timestamp: new Date(lockData.timestamp),
          timeout: lockData.timeout,
          isActive: lockData.isActive,
          metadata: lockData.metadata
        };

        // Check if lock is still valid
        const now = Date.now();
        const lockTime = lockState.timestamp.getTime();
        const isExpired = now > lockTime + lockState.timeout;
        
        if (isExpired) {
          // Clean up expired lock
          await this._cleanupExpiredLock(cellId);
          continue;
        }

        // Update local state
        this._lockStates.set(cellId, lockState);

        // Set up timeout timer
        const remainingTime = (lockTime + lockState.timeout) - now;
        if (remainingTime > 0) {
          const timer = setTimeout(() => {
            this._handleLockTimeout(cellId);
          }, remainingTime);
          this._lockTimers.set(cellId, timer);
        }
      }
    }
  }

  /**
   * Handle user leaving the collaborative session
   * 
   * @param sender - The awareness service
   * @param args - Event arguments
   */
  private _onUserLeave(sender: AwarenessService, args: { userId: string }): void {
    const userLockedCells: string[] = [];
    
    // Find all cells locked by the leaving user
    for (const [cellId, lockState] of this._lockStates) {
      if (lockState.userId === args.userId) {
        userLockedCells.push(cellId);
      }
    }

    // Clean up locks for the leaving user
    for (const cellId of userLockedCells) {
      this._cleanupExpiredLock(cellId);
    }
  }

  /**
   * Emit a lock event
   * 
   * @param event - The lock event to emit
   */
  private _emitLockEvent(event: ILockEvent): void {
    // Log the event for debugging
    console.debug('Lock event:', event);
    
    // In a real implementation, this could emit to a central event bus
    // For now, we just log it as the event is also handled by the signal
  }
}

/**
 * Factory function to create a new lock service instance
 * 
 * @param doc - The Yjs document for collaborative editing
 * @param awarenessService - Service for tracking user presence
 * @param permissionService - Service for managing user permissions
 * @param options - Optional initialization options
 * @returns A new lock service instance
 */
export function createLockService(
  doc: Doc,
  awarenessService: AwarenessService,
  permissionService: PermissionService,
  options?: {
    defaultTimeout?: number;
    cleanupInterval?: number;
  }
): LockService {
  return new LockService(doc, awarenessService, permissionService, options);
}