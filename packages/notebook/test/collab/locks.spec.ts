// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { LockManager, ILockManager, ILockInfo, LockManagerStatus } from '../../src/collab/locks';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

/**
 * Helper function to create a mock user for testing
 */
function createMockUser(id: string, name: string, isAdmin: boolean = false) {
  const ydoc = new Y.Doc();
  ydoc.clientID = parseInt(id, 10);
  const awareness = new Awareness(ydoc);
  
  // Set up awareness state for the user
  awareness.setLocalState({
    user: {
      id,
      name,
      role: isAdmin ? 'admin' : 'editor'
    }
  });
  
  const lockManager = new LockManager({
    ydoc,
    awareness,
    userId: id,
    userName: name,
    isAdmin
  });
  
  return { ydoc, awareness, lockManager };
}

/**
 * Helper function to connect two Yjs documents
 */
function connectYjsDocs(doc1: Y.Doc, doc2: Y.Doc): void {
  // Create update handlers to sync the documents
  const doc1UpdateHandler = (update: Uint8Array) => {
    Y.applyUpdate(doc2, update);
  };
  
  const doc2UpdateHandler = (update: Uint8Array) => {
    Y.applyUpdate(doc1, update);
  };
  
  // Set up event listeners
  doc1.on('update', doc1UpdateHandler);
  doc2.on('update', doc2UpdateHandler);
  
  // Sync the initial state
  doc1UpdateHandler(Y.encodeStateAsUpdate(doc1));
}

/**
 * Helper function to connect awareness between two users
 */
function connectAwareness(awareness1: Awareness, awareness2: Awareness): void {
  // Create update handlers to sync awareness
  const awareness1UpdateHandler = (update: Uint8Array) => {
    awareness2.applyUpdate(update);
  };
  
  const awareness2UpdateHandler = (update: Uint8Array) => {
    awareness1.applyUpdate(update);
  };
  
  // Set up event listeners
  awareness1.on('update', (changes: any, origin: any) => {
    const update = awareness1.encodeUpdate(Array.from(changes.added).concat(Array.from(changes.updated)));
    awareness1UpdateHandler(update);
  });
  
  awareness2.on('update', (changes: any, origin: any) => {
    const update = awareness2.encodeUpdate(Array.from(changes.added).concat(Array.from(changes.updated)));
    awareness2UpdateHandler(update);
  });
  
  // Sync the initial state
  const initialUpdate1 = awareness1.encodeUpdate([awareness1.clientID]);
  const initialUpdate2 = awareness2.encodeUpdate([awareness2.clientID]);
  awareness1UpdateHandler(initialUpdate2);
  awareness2UpdateHandler(initialUpdate1);
}

/**
 * Helper function to advance the timer and run pending timers
 */
function advanceTimersByTime(ms: number): void {
  jest.advanceTimersByTime(ms);
}

describe('LockManager', () => {
  // Use fake timers for testing timeouts and expirations
  beforeEach(() => {
    jest.useFakeTimers();
  });
  
  afterEach(() => {
    jest.useRealTimers();
  });
  
  describe('constructor', () => {
    it('should create a lock manager with the correct initial state', () => {
      const { lockManager } = createMockUser('1', 'User 1');
      
      expect(lockManager.status).toBe(LockManagerStatus.Ready);
      expect(lockManager.getAllLocks()).toHaveLength(0);
    });
  });
  
  describe('acquireLock', () => {
    it('should successfully acquire a lock on a cell', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      const cellId = 'cell1';
      
      const lockAcquiredSpy = jest.fn();
      lockManager.lockAcquired.connect(lockAcquiredSpy);
      
      const result = await lockManager.acquireLock(cellId);
      
      expect(result.success).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock?.cellId).toBe(cellId);
      expect(result.lock?.userId).toBe('1');
      expect(result.lock?.userName).toBe('User 1');
      expect(lockAcquiredSpy).toHaveBeenCalled();
      
      // Verify the lock is in the active locks
      const lock = lockManager.getLock(cellId);
      expect(lock).toBeDefined();
      expect(lock?.cellId).toBe(cellId);
    });
    
    it('should fail to acquire a lock if the cell is already locked by another user', async () => {
      // Create two users
      const { ydoc: ydoc1, awareness: awareness1, lockManager: lockManager1 } = createMockUser('1', 'User 1');
      const { ydoc: ydoc2, awareness: awareness2, lockManager: lockManager2 } = createMockUser('2', 'User 2');
      
      // Connect the Yjs documents and awareness
      connectYjsDocs(ydoc1, ydoc2);
      connectAwareness(awareness1, awareness2);
      
      const cellId = 'cell1';
      
      // User 1 acquires the lock
      const result1 = await lockManager1.acquireLock(cellId);
      expect(result1.success).toBe(true);
      
      // User 2 tries to acquire the same lock
      const lockFailedSpy = jest.fn();
      lockManager2.lockFailed.connect(lockFailedSpy);
      
      const result2 = await lockManager2.acquireLock(cellId);
      
      expect(result2.success).toBe(false);
      expect(result2.error).toBeDefined();
      expect(result2.currentOwner).toBeDefined();
      expect(result2.currentOwner?.userId).toBe('1');
      expect(lockFailedSpy).toHaveBeenCalled();
    });
    
    it('should allow a user to acquire a lock they already hold', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      const cellId = 'cell1';
      
      // First acquisition
      const result1 = await lockManager.acquireLock(cellId);
      expect(result1.success).toBe(true);
      
      // Second acquisition (should renew the lock)
      const result2 = await lockManager.acquireLock(cellId);
      expect(result2.success).toBe(true);
      
      // The lock should still be held by the user
      expect(lockManager.hasLock(cellId)).toBe(true);
    });
    
    it('should allow admin users to force-acquire a lock', async () => {
      // Create a regular user and an admin user
      const { ydoc: ydoc1, awareness: awareness1, lockManager: lockManager1 } = createMockUser('1', 'User 1');
      const { ydoc: ydoc2, awareness: awareness2, lockManager: lockManager2 } = createMockUser('2', 'Admin', true);
      
      // Connect the Yjs documents and awareness
      connectYjsDocs(ydoc1, ydoc2);
      connectAwareness(awareness1, awareness2);
      
      const cellId = 'cell1';
      
      // User 1 acquires the lock
      const result1 = await lockManager1.acquireLock(cellId);
      expect(result1.success).toBe(true);
      
      // Admin user force-acquires the lock
      const result2 = await lockManager2.acquireLock(cellId, { force: true });
      
      expect(result2.success).toBe(true);
      expect(lockManager2.hasLock(cellId)).toBe(true);
      expect(lockManager1.hasLock(cellId)).toBe(false);
    });
  });
  
  describe('releaseLock', () => {
    it('should successfully release a lock', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      const cellId = 'cell1';
      
      // Acquire the lock
      const acquireResult = await lockManager.acquireLock(cellId);
      expect(acquireResult.success).toBe(true);
      
      const lockReleasedSpy = jest.fn();
      lockManager.lockReleased.connect(lockReleasedSpy);
      
      // Release the lock
      const releaseResult = await lockManager.releaseLock(cellId);
      
      expect(releaseResult).toBe(true);
      expect(lockManager.getLock(cellId)).toBeNull();
      expect(lockReleasedSpy).toHaveBeenCalled();
    });
    
    it('should fail to release a lock held by another user', async () => {
      // Create two users
      const { ydoc: ydoc1, awareness: awareness1, lockManager: lockManager1 } = createMockUser('1', 'User 1');
      const { ydoc: ydoc2, awareness: awareness2, lockManager: lockManager2 } = createMockUser('2', 'User 2');
      
      // Connect the Yjs documents and awareness
      connectYjsDocs(ydoc1, ydoc2);
      connectAwareness(awareness1, awareness2);
      
      const cellId = 'cell1';
      
      // User 1 acquires the lock
      const acquireResult = await lockManager1.acquireLock(cellId);
      expect(acquireResult.success).toBe(true);
      
      // User 2 tries to release the lock
      const releaseResult = await lockManager2.releaseLock(cellId);
      
      expect(releaseResult).toBe(false);
      expect(lockManager1.hasLock(cellId)).toBe(true); // Lock should still be held by User 1
    });
  });
  
  describe('getLock and hasLock', () => {
    it('should correctly report lock status', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      const cellId = 'cell1';
      
      // Initially no lock
      expect(lockManager.getLock(cellId)).toBeNull();
      expect(lockManager.hasLock(cellId)).toBe(false);
      
      // Acquire the lock
      await lockManager.acquireLock(cellId);
      
      // Now there should be a lock
      const lock = lockManager.getLock(cellId);
      expect(lock).toBeDefined();
      expect(lock?.cellId).toBe(cellId);
      expect(lockManager.hasLock(cellId)).toBe(true);
    });
  });
  
  describe('getAllLocks', () => {
    it('should return all active locks', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      
      // Acquire locks on multiple cells
      await lockManager.acquireLock('cell1');
      await lockManager.acquireLock('cell2');
      await lockManager.acquireLock('cell3');
      
      const locks = lockManager.getAllLocks();
      
      expect(locks).toHaveLength(3);
      expect(locks.map(lock => lock.cellId).sort()).toEqual(['cell1', 'cell2', 'cell3']);
    });
  });
  
  describe('renewLock', () => {
    it('should successfully renew a lock', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      const cellId = 'cell1';
      
      // Acquire the lock
      await lockManager.acquireLock(cellId);
      const originalLock = lockManager.getLock(cellId);
      
      // Wait a bit
      advanceTimersByTime(1000);
      
      // Renew the lock
      const renewResult = await lockManager.renewLock(cellId);
      
      expect(renewResult).toBe(true);
      
      // The lock should have a new expiration time
      const renewedLock = lockManager.getLock(cellId);
      expect(renewedLock).toBeDefined();
      expect(renewedLock?.expiresAt).toBeGreaterThan(originalLock?.expiresAt || 0);
    });
    
    it('should fail to renew a lock held by another user', async () => {
      // Create two users
      const { ydoc: ydoc1, awareness: awareness1, lockManager: lockManager1 } = createMockUser('1', 'User 1');
      const { ydoc: ydoc2, awareness: awareness2, lockManager: lockManager2 } = createMockUser('2', 'User 2');
      
      // Connect the Yjs documents and awareness
      connectYjsDocs(ydoc1, ydoc2);
      connectAwareness(awareness1, awareness2);
      
      const cellId = 'cell1';
      
      // User 1 acquires the lock
      await lockManager1.acquireLock(cellId);
      
      // User 2 tries to renew the lock
      const renewResult = await lockManager2.renewLock(cellId);
      
      expect(renewResult).toBe(false);
    });
  });
  
  describe('forceReleaseLock', () => {
    it('should allow admin users to force-release locks', async () => {
      // Create a regular user and an admin user
      const { ydoc: ydoc1, awareness: awareness1, lockManager: lockManager1 } = createMockUser('1', 'User 1');
      const { ydoc: ydoc2, awareness: awareness2, lockManager: lockManager2 } = createMockUser('2', 'Admin', true);
      
      // Connect the Yjs documents and awareness
      connectYjsDocs(ydoc1, ydoc2);
      connectAwareness(awareness1, awareness2);
      
      const cellId = 'cell1';
      
      // User 1 acquires the lock
      await lockManager1.acquireLock(cellId);
      expect(lockManager1.hasLock(cellId)).toBe(true);
      
      // Admin user force-releases the lock
      const releaseResult = await lockManager2.forceReleaseLock(cellId);
      
      expect(releaseResult).toBe(true);
      expect(lockManager1.getLock(cellId)).toBeNull(); // Lock should be released
    });
    
    it('should not allow non-admin users to force-release locks', async () => {
      // Create two regular users
      const { ydoc: ydoc1, awareness: awareness1, lockManager: lockManager1 } = createMockUser('1', 'User 1');
      const { ydoc: ydoc2, awareness: awareness2, lockManager: lockManager2 } = createMockUser('2', 'User 2');
      
      // Connect the Yjs documents and awareness
      connectYjsDocs(ydoc1, ydoc2);
      connectAwareness(awareness1, awareness2);
      
      const cellId = 'cell1';
      
      // User 1 acquires the lock
      await lockManager1.acquireLock(cellId);
      
      // User 2 tries to force-release the lock
      const releaseResult = await lockManager2.forceReleaseLock(cellId);
      
      expect(releaseResult).toBe(false);
      expect(lockManager1.hasLock(cellId)).toBe(true); // Lock should still be held
    });
  });
  
  describe('releaseAllLocks', () => {
    it('should release all locks held by the user', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      
      // Acquire locks on multiple cells
      await lockManager.acquireLock('cell1');
      await lockManager.acquireLock('cell2');
      await lockManager.acquireLock('cell3');
      
      expect(lockManager.getAllLocks()).toHaveLength(3);
      
      // Release all locks
      const releaseResult = await lockManager.releaseAllLocks();
      
      expect(releaseResult).toBe(true);
      expect(lockManager.getAllLocks()).toHaveLength(0);
    });
  });
  
  describe('lock expiration', () => {
    it('should automatically clean up expired locks', async () => {
      const { lockManager } = createMockUser('1', 'User 1'); // Regular user
      const cellId = 'cell1';
      
      // Acquire the lock
      await lockManager.acquireLock(cellId, { timeout: 5000 }); // 5 second timeout
      expect(lockManager.hasLock(cellId)).toBe(true);
      
      // Advance time past the expiration
      advanceTimersByTime(6000); // 6 seconds
      
      // The lock should be automatically cleaned up
      expect(lockManager.getLock(cellId)).toBeNull();
    });
    
    it('should emit lockExpiring signal before lock expiration', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      const cellId = 'cell1';
      
      const lockExpiringSpy = jest.fn();
      lockManager.lockExpiring.connect(lockExpiringSpy);
      
      // Acquire the lock with a 10 second timeout
      await lockManager.acquireLock(cellId, { timeout: 10000 });
      
      // Advance time to just before the warning threshold (default is 5 seconds before expiration)
      advanceTimersByTime(4000); // 4 seconds
      expect(lockExpiringSpy).not.toHaveBeenCalled();
      
      // Advance time to the warning threshold
      advanceTimersByTime(1000); // 5 seconds total
      expect(lockExpiringSpy).toHaveBeenCalled();
    });
    
    it('should automatically renew active locks', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      const cellId = 'cell1';
      
      // Acquire the lock
      await lockManager.acquireLock(cellId);
      const originalLock = lockManager.getLock(cellId);
      
      // Advance time to trigger auto-renewal (default is 10 seconds)
      advanceTimersByTime(10000);
      
      // The lock should be renewed
      const renewedLock = lockManager.getLock(cellId);
      expect(renewedLock).toBeDefined();
      expect(renewedLock?.expiresAt).toBeGreaterThan(originalLock?.expiresAt || 0);
    });
  });
  
  describe('user disconnection', () => {
    it('should release locks when a user disconnects', async () => {
      // Create two users
      const { ydoc: ydoc1, awareness: awareness1, lockManager: lockManager1 } = createMockUser('1', 'User 1');
      const { ydoc: ydoc2, awareness: awareness2, lockManager: lockManager2 } = createMockUser('2', 'User 2');
      
      // Connect the Yjs documents and awareness
      connectYjsDocs(ydoc1, ydoc2);
      connectAwareness(awareness1, awareness2);
      
      const cellId = 'cell1';
      
      // User 1 acquires the lock
      await lockManager1.acquireLock(cellId);
      expect(lockManager2.getLock(cellId)).toBeDefined(); // User 2 can see the lock
      
      // Simulate User 1 disconnecting
      awareness1.setLocalState(null); // This triggers the 'change' event with a removal
      
      // The lock should be released
      expect(lockManager2.getLock(cellId)).toBeNull();
    });
  });
  
  describe('dispose', () => {
    it('should clean up resources and release locks', async () => {
      const { lockManager } = createMockUser('1', 'User 1');
      
      // Acquire a lock
      await lockManager.acquireLock('cell1');
      expect(lockManager.hasLock('cell1')).toBe(true);
      
      // Dispose the lock manager
      lockManager.dispose();
      
      // The lock should be released
      expect(lockManager.getAllLocks()).toHaveLength(0);
    });
  });
});