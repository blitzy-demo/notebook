// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Cell, CodeCell, ICellModel } from '@jupyterlab/cells';
import { ObservableList } from '@jupyterlab/observables';
import { UUID } from '@lumino/coreutils';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { CellOperations, ICellLockResult } from '../src/celloperations';
import { ILockManager, LockManager, LockManagerStatus } from '../src/collab/locks';
import { YjsAwareness } from '../src/collab/awareness';

// Mock implementation of YjsAwareness for testing
class MockYjsAwareness extends YjsAwareness {
  constructor(awareness: Awareness) {
    super(awareness);
    this._clientID = 1;
  }

  get clientID(): number {
    return this._clientID;
  }

  setClientID(id: number): void {
    this._clientID = id;
  }

  private _clientID: number;
}

// Mock implementation of Cell for testing
class MockCell extends Cell {
  constructor(id: string) {
    super({
      model: {
        id,
        cell: {
          cell_type: 'code'
        }
      } as any,
      contentFactory: {} as any,
      editorConfig: {} as any
    });
  }
}

describe('CellOperations', () => {
  let ydoc1: Y.Doc;
  let ydoc2: Y.Doc;
  let awareness1: Awareness;
  let awareness2: Awareness;
  let yjsAwareness1: YjsAwareness;
  let yjsAwareness2: YjsAwareness;
  let lockManager1: ILockManager;
  let lockManager2: ILockManager;
  let cells1: ObservableList<ICellModel>;
  let cells2: ObservableList<ICellModel>;
  let cellOperations1: CellOperations;
  let cellOperations2: CellOperations;
  let mockCellModels: ICellModel[];

  beforeEach(() => {
    // Set up two Yjs documents to simulate two clients
    ydoc1 = new Y.Doc();
    ydoc2 = new Y.Doc();
    
    // Create awareness instances
    awareness1 = new Awareness(ydoc1);
    awareness2 = new Awareness(ydoc2);
    
    // Create YjsAwareness instances
    yjsAwareness1 = new MockYjsAwareness(awareness1);
    yjsAwareness2 = new MockYjsAwareness(awareness2);
    (yjsAwareness1 as MockYjsAwareness).setClientID(1);
    (yjsAwareness2 as MockYjsAwareness).setClientID(2);
    
    // Set user information
    yjsAwareness1.setLocalStateField('user', { id: 'user1', name: 'User 1', color: '#ff0000' });
    yjsAwareness2.setLocalStateField('user', { id: 'user2', name: 'User 2', color: '#0000ff' });
    
    // Create lock managers
    lockManager1 = new LockManager({
      ydoc: ydoc1,
      awareness: awareness1,
      userId: 'user1',
      userName: 'User 1'
    });
    
    lockManager2 = new LockManager({
      ydoc: ydoc2,
      awareness: awareness2,
      userId: 'user2',
      userName: 'User 2'
    });
    
    // Create mock cell models
    mockCellModels = [
      { id: 'cell1' } as ICellModel,
      { id: 'cell2' } as ICellModel,
      { id: 'cell3' } as ICellModel
    ];
    
    // Create cell lists
    cells1 = new ObservableList<ICellModel>();
    cells2 = new ObservableList<ICellModel>();
    
    // Add mock cells to the lists
    mockCellModels.forEach(cell => {
      cells1.push(cell);
      cells2.push(cell);
    });
    
    // Create cell operations
    cellOperations1 = new CellOperations(cells1, {
      lockManager: lockManager1,
      awareness: yjsAwareness1
    });
    
    cellOperations2 = new CellOperations(cells2, {
      lockManager: lockManager2,
      awareness: yjsAwareness2
    });
    
    // Connect the two Yjs documents to simulate real-time collaboration
    Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
    Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2));
  });

  afterEach(() => {
    // Clean up
    cellOperations1.dispose();
    cellOperations2.dispose();
    lockManager1.dispose();
    lockManager2.dispose();
    ydoc1.destroy();
    ydoc2.destroy();
  });

  describe('Cell-level locking during edit operations', () => {
    it('should successfully acquire a lock on an unlocked cell', async () => {
      // Attempt to acquire a lock on cell1
      const result = await cellOperations1.requestLock('cell1', 'edit');
      
      // Verify the lock was acquired
      expect(result.acquired).toBe(true);
      expect(cellOperations1.isLockedByCurrentUser('cell1')).toBe(true);
      
      // Synchronize the documents to propagate the lock
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Verify the other client sees the lock
      expect(cellOperations2.isLockedByOtherUser('cell1')).toBe(true);
      
      // Verify lock owner information
      const lockOwner = cellOperations2.getLockOwner('cell1');
      expect(lockOwner).not.toBeNull();
      expect(lockOwner?.user.name).toBe('User 1');
    });

    it('should fail to acquire a lock on a cell locked by another user', async () => {
      // User 1 acquires a lock on cell1
      await cellOperations1.requestLock('cell1', 'edit');
      
      // Synchronize the documents to propagate the lock
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // User 2 attempts to acquire a lock on the same cell
      const result = await cellOperations2.requestLock('cell1', 'edit');
      
      // Verify the lock acquisition failed
      expect(result.acquired).toBe(false);
      expect(result.owner).not.toBeUndefined();
      expect(result.owner?.user.name).toBe('User 1');
      
      // Verify lock status
      expect(cellOperations1.isLockedByCurrentUser('cell1')).toBe(true);
      expect(cellOperations2.isLockedByOtherUser('cell1')).toBe(true);
    });

    it('should successfully release a lock', async () => {
      // User 1 acquires a lock on cell1
      await cellOperations1.requestLock('cell1', 'edit');
      
      // Synchronize the documents to propagate the lock
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Verify the lock was acquired
      expect(cellOperations1.isLockedByCurrentUser('cell1')).toBe(true);
      expect(cellOperations2.isLockedByOtherUser('cell1')).toBe(true);
      
      // User 1 releases the lock
      await cellOperations1.releaseLock('cell1');
      
      // Synchronize the documents to propagate the lock release
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Verify the lock was released
      expect(cellOperations1.isLockedByCurrentUser('cell1')).toBe(false);
      expect(cellOperations2.isLockedByOtherUser('cell1')).toBe(false);
      
      // User 2 should now be able to acquire the lock
      const result = await cellOperations2.requestLock('cell1', 'edit');
      expect(result.acquired).toBe(true);
    });

    it('should ensure distributed lock convergence across all clients', async () => {
      // User 1 acquires locks on multiple cells
      await cellOperations1.requestLock('cell1', 'edit');
      await cellOperations1.requestLock('cell2', 'edit');
      
      // User 2 acquires a lock on a different cell
      await cellOperations2.requestLock('cell3', 'edit');
      
      // Synchronize both documents in both directions
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2));
      
      // Verify lock convergence for User 1
      expect(cellOperations1.isLockedByCurrentUser('cell1')).toBe(true);
      expect(cellOperations1.isLockedByCurrentUser('cell2')).toBe(true);
      expect(cellOperations1.isLockedByOtherUser('cell3')).toBe(true);
      
      // Verify lock convergence for User 2
      expect(cellOperations2.isLockedByOtherUser('cell1')).toBe(true);
      expect(cellOperations2.isLockedByOtherUser('cell2')).toBe(true);
      expect(cellOperations2.isLockedByCurrentUser('cell3')).toBe(true);
      
      // Release all locks from User 1
      await cellOperations1.releaseLock('cell1');
      await cellOperations1.releaseLock('cell2');
      
      // Synchronize again
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Verify lock releases are converged
      expect(cellOperations2.isLockedByOtherUser('cell1')).toBe(false);
      expect(cellOperations2.isLockedByOtherUser('cell2')).toBe(false);
      expect(cellOperations2.isLockedByCurrentUser('cell3')).toBe(true);
    });
  });

  describe('Conflict resolution between concurrent cell edits', () => {
    it('should prevent concurrent edits on the same cell', async () => {
      // User 1 acquires a lock on cell1
      const result1 = await cellOperations1.requestLock('cell1', 'edit');
      expect(result1.acquired).toBe(true);
      
      // Synchronize the documents
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // User 2 attempts to acquire a lock on the same cell
      const result2 = await cellOperations2.requestLock('cell1', 'edit');
      
      // Verify User 2's lock acquisition failed
      expect(result2.acquired).toBe(false);
      expect(result2.owner).not.toBeUndefined();
      expect(result2.owner?.user.name).toBe('User 1');
      
      // User 1 releases the lock
      await cellOperations1.releaseLock('cell1');
      
      // Synchronize the documents
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Now User 2 should be able to acquire the lock
      const result3 = await cellOperations2.requestLock('cell1', 'edit');
      expect(result3.acquired).toBe(true);
    });

    it('should handle rapid lock/unlock sequences correctly', async () => {
      // User 1 rapidly locks and unlocks a cell
      await cellOperations1.requestLock('cell1', 'edit');
      await cellOperations1.releaseLock('cell1');
      
      // Synchronize the documents
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // User 2 should be able to acquire the lock immediately
      const result = await cellOperations2.requestLock('cell1', 'edit');
      expect(result.acquired).toBe(true);
      
      // User 1 should now see the cell as locked by User 2
      Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2));
      expect(cellOperations1.isLockedByOtherUser('cell1')).toBe(true);
      
      // Verify lock owner
      const lockOwner = cellOperations1.getLockOwner('cell1');
      expect(lockOwner).not.toBeNull();
      expect(lockOwner?.user.name).toBe('User 2');
    });

    it('should handle concurrent lock requests on different cells', async () => {
      // User 1 and User 2 concurrently request locks on different cells
      const promise1 = cellOperations1.requestLock('cell1', 'edit');
      const promise2 = cellOperations2.requestLock('cell2', 'edit');
      
      // Wait for both lock requests to complete
      const [result1, result2] = await Promise.all([promise1, promise2]);
      
      // Verify both lock acquisitions succeeded
      expect(result1.acquired).toBe(true);
      expect(result2.acquired).toBe(true);
      
      // Synchronize the documents
      Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2));
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Verify lock status for User 1
      expect(cellOperations1.isLockedByCurrentUser('cell1')).toBe(true);
      expect(cellOperations1.isLockedByOtherUser('cell2')).toBe(true);
      
      // Verify lock status for User 2
      expect(cellOperations2.isLockedByOtherUser('cell1')).toBe(true);
      expect(cellOperations2.isLockedByCurrentUser('cell2')).toBe(true);
    });
  });

  describe('Lock timeout handling during client disconnections', () => {
    // Mock the Date.now function to simulate time passing
    let originalDateNow: () => number;
    let mockTime: number;

    beforeEach(() => {
      originalDateNow = Date.now;
      mockTime = Date.now();
      Date.now = jest.fn(() => mockTime);
    });

    afterEach(() => {
      Date.now = originalDateNow;
    });

    it('should automatically release locks when they expire', async () => {
      // User 1 acquires a lock on cell1
      await cellOperations1.requestLock('cell1', 'edit');
      
      // Synchronize the documents
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Verify User 2 sees the lock
      expect(cellOperations2.isLockedByOtherUser('cell1')).toBe(true);
      
      // Advance time past the lock expiration (default is 30 seconds)
      mockTime += 31000; // 31 seconds
      
      // Trigger lock expiration check (normally done by the lock manager's timer)
      // We'll do this by requesting a lock, which checks for expired locks
      await cellOperations2.requestLock('cell2', 'edit');
      
      // Now User 2 should be able to acquire the lock on cell1
      const result = await cellOperations2.requestLock('cell1', 'edit');
      expect(result.acquired).toBe(true);
    });

    it('should handle client disconnections appropriately', async () => {
      // User 1 acquires a lock on cell1
      await cellOperations1.requestLock('cell1', 'edit');
      
      // Synchronize the documents
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Simulate User 1 disconnecting by removing their awareness state
      awareness1.setLocalState(null);
      
      // Propagate the awareness change to User 2
      awareness2.on('update', () => {
        // This would normally happen automatically in a real environment
        // For testing, we need to manually trigger the lock cleanup for disconnected users
        (lockManager2 as any)._releaseLocksForDisconnectedUsers([1]);
      });
      
      // Trigger the awareness update
      awareness2.on('change', () => {
        // Now User 2 should be able to acquire the lock on cell1
        cellOperations2.requestLock('cell1', 'edit').then(result => {
          expect(result.acquired).toBe(true);
        });
      });
    });

    it('should handle lock timeouts with appropriate user feedback', async () => {
      // Mock the lock expiring signal
      const lockExpiringHandler = jest.fn();
      (lockManager1 as any)._lockExpiring.connect(lockExpiringHandler);
      
      // User 1 acquires a lock on cell1
      await cellOperations1.requestLock('cell1', 'edit');
      
      // Advance time to just before the warning threshold (default is 5 seconds before expiration)
      mockTime += 25000; // 25 seconds (5 seconds before the 30-second expiration)
      
      // Trigger the expiration check
      (lockManager1 as any)._checkLockExpirations();
      
      // Verify the lock expiring signal was emitted
      expect(lockExpiringHandler).toHaveBeenCalled();
      const lockInfo = lockExpiringHandler.mock.calls[0][1];
      expect(lockInfo.cellId).toBe('cell1');
      expect(lockInfo.userId).toBe('user1');
    });
  });

  describe('User feedback during lock contention scenarios', () => {
    it('should provide clear user feedback when a lock acquisition fails', async () => {
      // User 1 acquires a lock on cell1
      await cellOperations1.requestLock('cell1', 'edit');
      
      // Synchronize the documents
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // User 2 attempts to acquire the same lock
      const result = await cellOperations2.requestLock('cell1', 'edit');
      
      // Verify the result contains clear feedback about the lock owner
      expect(result.acquired).toBe(false);
      expect(result.owner).not.toBeUndefined();
      expect(result.owner?.user.name).toBe('User 1');
      
      // In a real UI, this information would be used to display a message to the user
      const feedbackMessage = `Cell is locked by ${result.owner?.user.name}`;
      expect(feedbackMessage).toBe('Cell is locked by User 1');
    });

    it('should apply lock indicators to cell widgets', () => {
      // Create a mock cell
      const mockCell = new MockCell('cell1');
      
      // User 1 acquires a lock on cell1
      cellOperations1.requestLock('cell1', 'edit').then(() => {
        // Synchronize the documents
        Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
        
        // Apply cell operations to the mock cell for User 2
        cellOperations2.applyCellOperations(mockCell);
        
        // Verify a lock indicator was added to the cell
        const indicator = mockCell.node.querySelector('.jp-CellLockIndicator');
        expect(indicator).not.toBeNull();
        expect(indicator?.title).toContain('Locked by User 1');
        
        // Verify the indicator has the correct client ID
        expect(indicator?.dataset.clientId).toBe('1');
      });
    });

    it('should update remote cursor and selection indicators', () => {
      // Create a mock cell
      const mockCell = new MockCell('cell1');
      
      // User 1 updates cursor position
      cellOperations1.updateCursorPosition('cell1', 10);
      
      // Synchronize awareness
      const user1State = awareness1.getLocalState();
      awareness2.setLocalState(user1State);
      
      // Apply cell operations to the mock cell for User 2
      cellOperations2.applyCellOperations(mockCell);
      
      // Verify a remote cursor indicator was added to the cell
      const cursor = mockCell.node.querySelector('.jp-RemoteCursor');
      expect(cursor).not.toBeNull();
      expect(cursor?.dataset.position).toBe('10');
      expect(cursor?.dataset.clientId).toBe('1');
      
      // User 1 updates selection range
      cellOperations1.updateSelectionRange('cell1', [5, 15]);
      
      // Synchronize awareness again
      const updatedUser1State = awareness1.getLocalState();
      awareness2.setLocalState(updatedUser1State);
      
      // Apply cell operations again
      cellOperations2.applyCellOperations(mockCell);
      
      // Verify a remote selection indicator was added to the cell
      const selection = mockCell.node.querySelector('.jp-RemoteSelection');
      expect(selection).not.toBeNull();
      expect(selection?.dataset.rangeStart).toBe('5');
      expect(selection?.dataset.rangeEnd).toBe('15');
      expect(selection?.dataset.clientId).toBe('1');
    });
  });

  describe('Performance requirements for lock operations', () => {
    it('should acquire locks with latency <100ms', async () => {
      // Measure the time it takes to acquire a lock
      const startTime = performance.now();
      await cellOperations1.requestLock('cell1', 'edit');
      const endTime = performance.now();
      
      // Verify the lock acquisition latency is less than 100ms
      const latency = endTime - startTime;
      expect(latency).toBeLessThan(100);
    });

    it('should release locks with response time <100ms', async () => {
      // First acquire a lock
      await cellOperations1.requestLock('cell1', 'edit');
      
      // Measure the time it takes to release the lock
      const startTime = performance.now();
      await cellOperations1.releaseLock('cell1');
      const endTime = performance.now();
      
      // Verify the lock release response time is less than 100ms
      const responseTime = endTime - startTime;
      expect(responseTime).toBeLessThan(100);
    });

    it('should update lock state visibility in <100ms', async () => {
      // Set up a lock changed handler to measure visibility update time
      let visibilityUpdateTime = 0;
      const lockChangedHandler = jest.fn(() => {
        visibilityUpdateTime = performance.now();
      });
      
      cellOperations2.lockChanged.connect(lockChangedHandler);
      
      // User 1 acquires a lock
      await cellOperations1.requestLock('cell1', 'edit');
      const syncStartTime = performance.now();
      
      // Synchronize the documents
      Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
      
      // Verify the lock changed handler was called
      expect(lockChangedHandler).toHaveBeenCalled();
      
      // Verify the lock state visibility update time is less than 100ms
      const updateTime = visibilityUpdateTime - syncStartTime;
      expect(updateTime).toBeLessThan(100);
      
      // Clean up
      cellOperations2.lockChanged.disconnect(lockChangedHandler);
    });
  });
});