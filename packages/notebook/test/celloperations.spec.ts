// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { jest } from '@jest/globals';
import { YjsNotebookProvider } from '../src/collab/yjsnotebookprovider';
import { CellLockManager } from '../src/collab/locks';
import { AwarenessManager } from '../src/collab/awareness';
import * as Y from 'yjs';

// Mock WebSocket for testing
class MockWebSocket {
  url: string;
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  send: jest.Mock = jest.fn();
  close: jest.Mock = jest.fn();

  constructor(url: string) {
    this.url = url;
  }

  // Helper methods for testing
  simulateOpen(): void {
    this.readyState = WebSocket.OPEN;
    if (this.onopen) this.onopen({ target: this });
  }

  simulateMessage(data: any): void {
    if (this.onmessage) this.onmessage({ data, target: this });
  }

  simulateClose(code: number = 1000, reason: string = ''): void {
    this.readyState = WebSocket.CLOSED;
    if (this.onclose) this.onclose({ code, reason, target: this });
  }

  simulateError(): void {
    if (this.onerror) this.onerror({ target: this });
  }
}

// Mock for the cell operations module
const mockCellOperations = {
  insertCell: jest.fn(),
  deleteCell: jest.fn(),
  moveCell: jest.fn(),
  updateCell: jest.fn(),
  executeCellAndFocus: jest.fn(),
  executeCell: jest.fn(),
  clearCellOutput: jest.fn(),
  clearAllOutputs: jest.fn()
};

// Mock for the NotebookModel
class MockNotebookModel {
  cells: any[] = [];
  metadata: any = {};
  sharedModel: any;
  ydoc: Y.Doc;

  constructor() {
    this.ydoc = new Y.Doc();
    this.sharedModel = {
      getMetadata: jest.fn().mockReturnValue(this.metadata),
      setMetadata: jest.fn(),
      getSource: jest.fn().mockReturnValue(''),
      transact: jest.fn().mockImplementation((callback: () => void) => callback())
    };
  }

  addCell(cellType: string = 'code', source: string = ''): any {
    const cell = {
      id: `cell-${this.cells.length}`,
      type: cellType,
      source,
      sharedModel: {
        getSource: jest.fn().mockReturnValue(source),
        setSource: jest.fn(),
        getMetadata: jest.fn().mockReturnValue({}),
        setMetadata: jest.fn(),
        transact: jest.fn().mockImplementation((callback: () => void) => callback())
      }
    };
    this.cells.push(cell);
    return cell;
  }
}

describe('Cell Operations with Locking', () => {
  let notebookModel: MockNotebookModel;
  let lockManager: CellLockManager;
  let awarenessManager: AwarenessManager;
  let yjsProvider: YjsNotebookProvider;
  let mockSocket: MockWebSocket;
  
  // Setup before each test
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create a mock WebSocket
    mockSocket = new MockWebSocket('ws://localhost:8888/api/yjs');
    (global as any).WebSocket = jest.fn().mockImplementation(() => mockSocket);
    
    // Create a notebook model
    notebookModel = new MockNotebookModel();
    
    // Add some cells to the notebook
    notebookModel.addCell('code', 'print("Hello World")');
    notebookModel.addCell('markdown', '# Heading');
    notebookModel.addCell('code', 'import numpy as np\nimport pandas as pd');
    
    // Create the YjsNotebookProvider
    yjsProvider = new YjsNotebookProvider({
      url: 'ws://localhost:8888/api/yjs',
      notebookPath: '/path/to/notebook.ipynb',
      userId: 'user1'
    });
    
    // Create the lock manager
    lockManager = new CellLockManager(yjsProvider, notebookModel as any);
    
    // Create the awareness manager
    awarenessManager = new AwarenessManager(yjsProvider, notebookModel as any);
    
    // Simulate WebSocket connection
    mockSocket.simulateOpen();
  });
  
  // Cleanup after each test
  afterEach(() => {
    lockManager.dispose();
    awarenessManager.dispose();
    yjsProvider.dispose();
  });

  describe('Cell-level locking during edit operations', () => {
    test('should acquire a lock before editing a cell', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      const lockAcquiredSpy = jest.spyOn(lockManager, 'lockAcquired');
      const lockRequestSpy = jest.spyOn(lockManager, 'requestLock');
      
      // Act
      const lockAcquired = await lockManager.requestLock(cellId, 'user1');
      
      // Assert
      expect(lockRequestSpy).toHaveBeenCalledWith(cellId, 'user1');
      expect(lockAcquired).toBe(true);
      expect(lockAcquiredSpy).toHaveBeenCalledWith(cellId, 'user1');
      
      // Verify lock state
      expect(lockManager.isLocked(cellId)).toBe(true);
      expect(lockManager.getLockOwner(cellId)).toBe('user1');
    });
    
    test('should prevent concurrent edits on the same cell', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      
      // User2 tries to acquire lock on the same cell
      const lockAcquired = await lockManager.requestLock(cellId, 'user2');
      
      // Assert
      expect(lockAcquired).toBe(false);
      expect(lockManager.isLocked(cellId)).toBe(true);
      expect(lockManager.getLockOwner(cellId)).toBe('user1');
    });
    
    test('should release a lock after editing is complete', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      const lockReleasedSpy = jest.spyOn(lockManager, 'lockReleased');
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      
      // User1 releases lock
      lockManager.releaseLock(cellId, 'user1');
      
      // Assert
      expect(lockReleasedSpy).toHaveBeenCalledWith(cellId, 'user1');
      expect(lockManager.isLocked(cellId)).toBe(false);
      expect(lockManager.getLockOwner(cellId)).toBeNull();
      
      // Another user should now be able to acquire the lock
      const lockAcquired = await lockManager.requestLock(cellId, 'user2');
      expect(lockAcquired).toBe(true);
      expect(lockManager.getLockOwner(cellId)).toBe('user2');
    });
    
    test('should broadcast lock state changes to all clients', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      
      // Verify that a message was sent over the WebSocket
      expect(mockSocket.send).toHaveBeenCalled();
      
      // The message should contain lock information
      const sentMessages = mockSocket.send.mock.calls.map(call => JSON.parse(call[0]));
      const lockMessages = sentMessages.filter(msg => msg.type === 'lock' || msg.type === 'awareness');
      expect(lockMessages.length).toBeGreaterThan(0);
    });
  });

  describe('Conflict resolution between concurrent cell edits', () => {
    test('should resolve conflicts using CRDT when multiple users edit different cells', async () => {
      // Setup
      const cell1Id = notebookModel.cells[0].id;
      const cell2Id = notebookModel.cells[1].id;
      
      // User1 acquires lock on cell1
      await lockManager.requestLock(cell1Id, 'user1');
      
      // User2 acquires lock on cell2
      await lockManager.requestLock(cell2Id, 'user2');
      
      // Both users should have their respective locks
      expect(lockManager.getLockOwner(cell1Id)).toBe('user1');
      expect(lockManager.getLockOwner(cell2Id)).toBe('user2');
      
      // Simulate concurrent edits
      const ydoc = notebookModel.ydoc;
      const ymap = ydoc.getMap('cells');
      
      // User1 edits cell1
      ydoc.transact(() => {
        const cell1Data = ymap.get(cell1Id) || new Y.Map();
        cell1Data.set('source', 'print("Updated by user1")');
        ymap.set(cell1Id, cell1Data);
      }, 'user1');
      
      // User2 edits cell2
      ydoc.transact(() => {
        const cell2Data = ymap.get(cell2Id) || new Y.Map();
        cell2Data.set('source', '## Updated by user2');
        ymap.set(cell2Id, cell2Data);
      }, 'user2');
      
      // Both edits should be preserved
      expect(ymap.get(cell1Id).get('source')).toBe('print("Updated by user1")');
      expect(ymap.get(cell2Id).get('source')).toBe('## Updated by user2');
    });
    
    test('should queue edit operations when a cell is locked by another user', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      
      // User2 tries to edit the cell
      const editPromise = lockManager.withLock(cellId, 'user2', async () => {
        // This should be queued until user1 releases the lock
        return 'edited by user2';
      });
      
      // The edit should be pending
      expect(lockManager.hasPendingOperations(cellId)).toBe(true);
      
      // User1 releases lock
      lockManager.releaseLock(cellId, 'user1');
      
      // Now user2's edit should proceed
      const result = await editPromise;
      expect(result).toBe('edited by user2');
      expect(lockManager.getLockOwner(cellId)).toBe(null); // Lock should be released after the operation
    });
  });

  describe('Lock timeout handling during client disconnections', () => {
    test('should automatically release locks when a client disconnects', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      expect(lockManager.getLockOwner(cellId)).toBe('user1');
      
      // Simulate client disconnection
      mockSocket.simulateClose(1000, 'Client disconnected');
      
      // Wait for the lock timeout
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // The lock should be released
      expect(lockManager.isLocked(cellId)).toBe(false);
    });
    
    test('should handle reconnection and restore lock state', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      
      // Simulate temporary disconnection
      mockSocket.simulateClose(1006, 'Connection lost');
      
      // Simulate reconnection before lock timeout
      mockSocket = new MockWebSocket('ws://localhost:8888/api/yjs');
      (global as any).WebSocket = jest.fn().mockImplementation(() => mockSocket);
      mockSocket.simulateOpen();
      
      // Simulate receiving lock state from server
      mockSocket.simulateMessage(JSON.stringify({
        type: 'sync',
        locks: { [cellId]: { owner: 'user1', timestamp: Date.now() } }
      }));
      
      // The lock should be restored
      expect(lockManager.isLocked(cellId)).toBe(true);
      expect(lockManager.getLockOwner(cellId)).toBe('user1');
    });
  });

  describe('User feedback during lock contention', () => {
    test('should notify when a lock cannot be acquired', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      const lockDeniedSpy = jest.spyOn(lockManager, 'lockDenied');
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      
      // User2 tries to acquire the same lock
      const lockAcquired = await lockManager.requestLock(cellId, 'user2');
      
      // Assert
      expect(lockAcquired).toBe(false);
      expect(lockDeniedSpy).toHaveBeenCalledWith(cellId, 'user2', expect.any(Object));
    });
    
    test('should provide information about the current lock owner', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      
      // Get lock info
      const lockInfo = lockManager.getLockInfo(cellId);
      
      // Assert
      expect(lockInfo).toEqual(expect.objectContaining({
        owner: 'user1',
        timestamp: expect.any(Number)
      }));
    });
    
    test('should show user presence information for locked cells', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // Set user presence
      awarenessManager.setLocalUserInfo({
        userId: 'user1',
        username: 'User One',
        color: '#ff0000',
        cursor: { cellId, position: 10 }
      });
      
      // User1 acquires lock
      await lockManager.requestLock(cellId, 'user1');
      
      // Get presence info for the cell
      const presenceInfo = awarenessManager.getUsersAtCell(cellId);
      
      // Assert
      expect(presenceInfo).toContainEqual(expect.objectContaining({
        userId: 'user1',
        username: 'User One'
      }));
    });
  });

  describe('Performance requirements', () => {
    test('lock acquisition latency should be less than 100ms', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // Measure lock acquisition time
      const startTime = performance.now();
      await lockManager.requestLock(cellId, 'user1');
      const endTime = performance.now();
      
      // Assert
      const latency = endTime - startTime;
      expect(latency).toBeLessThan(100);
    });
    
    test('lock release response should be less than 100ms', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      await lockManager.requestLock(cellId, 'user1');
      
      // Measure lock release time
      const startTime = performance.now();
      lockManager.releaseLock(cellId, 'user1');
      const endTime = performance.now();
      
      // Assert
      const latency = endTime - startTime;
      expect(latency).toBeLessThan(100);
    });
    
    test('lock state visibility update should be less than 100ms', async () => {
      // Setup
      const cellId = notebookModel.cells[0].id;
      
      // Create a second lock manager to simulate another client
      const lockManager2 = new CellLockManager(yjsProvider, notebookModel as any);
      
      // Set up a spy to measure when the second client receives the lock update
      const lockChangedSpy = jest.spyOn(lockManager2, 'lockChanged');
      
      // Measure time for lock state to propagate
      const startTime = performance.now();
      await lockManager.requestLock(cellId, 'user1');
      
      // Simulate the message being sent to the other client
      const sentMessages = mockSocket.send.mock.calls.map(call => JSON.parse(call[0]));
      const lockMessages = sentMessages.filter(msg => msg.type === 'lock');
      
      if (lockMessages.length > 0) {
        mockSocket.simulateMessage(JSON.stringify(lockMessages[0]));
      }
      
      // Wait for the lock change to be processed
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const endTime = performance.now();
      
      // Assert
      expect(lockChangedSpy).toHaveBeenCalled();
      const latency = endTime - startTime;
      expect(latency).toBeLessThan(100);
      
      // Cleanup
      lockManager2.dispose();
    });
  });
});