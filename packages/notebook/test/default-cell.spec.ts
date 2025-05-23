// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DefaultCell } from '@jupyter-notebook/notebook';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { ILockManager } from '@jupyter-notebook/notebook/lib/collab/locks';
import { YjsAwareness } from '@jupyter-notebook/notebook/lib/collab/awareness';

// Mock implementations
class MockLockManager implements ILockManager {
  private _locks: Map<string, string> = new Map();
  private _callbacks: Map<string, Function[]> = new Map();

  acquireLock(cellId: string, userId: string): Promise<boolean> {
    if (this._locks.has(cellId) && this._locks.get(cellId) !== userId) {
      return Promise.resolve(false);
    }
    this._locks.set(cellId, userId);
    this._notifyLockChange(cellId);
    return Promise.resolve(true);
  }

  releaseLock(cellId: string, userId: string): Promise<boolean> {
    if (this._locks.has(cellId) && this._locks.get(cellId) === userId) {
      this._locks.delete(cellId);
      this._notifyLockChange(cellId);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  isLocked(cellId: string): boolean {
    return this._locks.has(cellId);
  }

  getLockOwner(cellId: string): string | null {
    return this._locks.get(cellId) || null;
  }

  onLockChange(cellId: string, callback: Function): void {
    if (!this._callbacks.has(cellId)) {
      this._callbacks.set(cellId, []);
    }
    this._callbacks.get(cellId)?.push(callback);
  }

  private _notifyLockChange(cellId: string): void {
    const callbacks = this._callbacks.get(cellId) || [];
    callbacks.forEach(callback => callback(this.getLockOwner(cellId)));
  }
}

// Mock WebSocket provider to avoid actual network connections
jest.mock('y-websocket', () => {
  return {
    WebsocketProvider: jest.fn().mockImplementation(() => {
      return {
        awareness: {
          setLocalState: jest.fn(),
          getStates: jest.fn().mockReturnValue(new Map()),
          on: jest.fn(),
          off: jest.fn()
        },
        on: jest.fn(),
        off: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn()
      };
    })
  };
});

describe('DefaultCell', () => {
  let ydoc: Y.Doc;
  let provider: WebsocketProvider;
  let lockManager: MockLockManager;
  let awareness: YjsAwareness;
  
  beforeEach(() => {
    // Create a new Yjs document for each test
    ydoc = new Y.Doc();
    
    // Create a mock WebSocket provider
    provider = new WebsocketProvider('ws://localhost:1234', 'test-room', ydoc);
    
    // Create a mock lock manager
    lockManager = new MockLockManager();
    
    // Create a mock awareness instance
    awareness = new YjsAwareness(provider.awareness);
  });
  
  afterEach(() => {
    // Clean up
    ydoc.destroy();
  });

  describe('Collaborative state maintenance', () => {
    it('should maintain collaborative state during editing', () => {
      // Create a cell with collaborative state
      const cellId = 'test-cell-1';
      const cellYDoc = ydoc.getMap('cells');
      const cellContent = cellYDoc.set(cellId, new Y.Map());
      cellContent.set('source', new Y.Text('Initial content'));
      
      // Create a default cell with the collaborative state
      const cell = new DefaultCell({
        id: cellId,
        ydoc,
        lockManager,
        awareness
      });
      
      // Verify initial state
      expect(cell.getSource()).toBe('Initial content');
      
      // Update the cell content
      cell.setSource('Updated content');
      
      // Verify the cell content was updated in the Yjs document
      const ytext = cellContent.get('source') as Y.Text;
      expect(ytext.toString()).toBe('Updated content');
      
      // Verify the cell content can be retrieved
      expect(cell.getSource()).toBe('Updated content');
    });
    
    it('should handle concurrent modifications from multiple users', () => {
      // Create a cell with collaborative state
      const cellId = 'test-cell-2';
      const cellYDoc = ydoc.getMap('cells');
      const cellContent = cellYDoc.set(cellId, new Y.Map());
      cellContent.set('source', new Y.Text('Initial content'));
      
      // Create a default cell with the collaborative state
      const cell = new DefaultCell({
        id: cellId,
        ydoc,
        lockManager,
        awareness
      });
      
      // Simulate another user making changes to the same cell
      // by directly modifying the Yjs document
      const ytext = cellContent.get('source') as Y.Text;
      ytext.insert(0, 'User2: ');
      
      // Verify the cell content reflects the changes from the other user
      expect(cell.getSource()).toBe('User2: Initial content');
      
      // Make a change as the current user
      cell.setSource('User2: Initial content - with local changes');
      
      // Verify the cell content includes both changes
      expect(cell.getSource()).toBe('User2: Initial content - with local changes');
      expect(ytext.toString()).toBe('User2: Initial content - with local changes');
    });
  });
  
  describe('Cell metadata synchronization', () => {
    it('should synchronize cell metadata across clients', () => {
      // Create a cell with collaborative state
      const cellId = 'test-cell-3';
      const cellYDoc = ydoc.getMap('cells');
      const cellContent = cellYDoc.set(cellId, new Y.Map());
      cellContent.set('source', new Y.Text('Content'));
      cellContent.set('metadata', new Y.Map());
      
      // Create a default cell with the collaborative state
      const cell = new DefaultCell({
        id: cellId,
        ydoc,
        lockManager,
        awareness
      });
      
      // Set metadata on the cell
      cell.setMetadata({ collapsed: true, editable: false });
      
      // Verify the metadata was updated in the Yjs document
      const ymetadata = cellContent.get('metadata') as Y.Map<any>;
      expect(ymetadata.get('collapsed')).toBe(true);
      expect(ymetadata.get('editable')).toBe(false);
      
      // Simulate another user updating the metadata
      ymetadata.set('scrolled', true);
      
      // Verify the cell metadata includes the update from the other user
      const metadata = cell.getMetadata();
      expect(metadata.collapsed).toBe(true);
      expect(metadata.editable).toBe(false);
      expect(metadata.scrolled).toBe(true);
    });
  });
  
  describe('Cell locking mechanisms', () => {
    it('should prevent concurrent edits to the same cell', async () => {
      // Create a cell with collaborative state
      const cellId = 'test-cell-4';
      const cellYDoc = ydoc.getMap('cells');
      const cellContent = cellYDoc.set(cellId, new Y.Map());
      cellContent.set('source', new Y.Text('Content'));
      
      // Create a default cell with the collaborative state
      const cell = new DefaultCell({
        id: cellId,
        ydoc,
        lockManager,
        awareness,
        userId: 'user1'
      });
      
      // Acquire a lock for user1
      const lockAcquired = await cell.acquireLock();
      expect(lockAcquired).toBe(true);
      expect(lockManager.isLocked(cellId)).toBe(true);
      expect(lockManager.getLockOwner(cellId)).toBe('user1');
      
      // Try to acquire a lock for user2 (should fail)
      const cell2 = new DefaultCell({
        id: cellId,
        ydoc,
        lockManager,
        awareness,
        userId: 'user2'
      });
      
      const lockAcquired2 = await cell2.acquireLock();
      expect(lockAcquired2).toBe(false);
      
      // Release the lock for user1
      const lockReleased = await cell.releaseLock();
      expect(lockReleased).toBe(true);
      expect(lockManager.isLocked(cellId)).toBe(false);
      
      // Now user2 should be able to acquire the lock
      const lockAcquired2AfterRelease = await cell2.acquireLock();
      expect(lockAcquired2AfterRelease).toBe(true);
      expect(lockManager.getLockOwner(cellId)).toBe('user2');
    });
  });
  
  describe('Cell output synchronization', () => {
    it('should synchronize cell outputs across clients', () => {
      // Create a cell with collaborative state
      const cellId = 'test-cell-5';
      const cellYDoc = ydoc.getMap('cells');
      const cellContent = cellYDoc.set(cellId, new Y.Map());
      cellContent.set('source', new Y.Text('Content'));
      cellContent.set('outputs', new Y.Array());
      
      // Create a default cell with the collaborative state
      const cell = new DefaultCell({
        id: cellId,
        ydoc,
        lockManager,
        awareness
      });
      
      // Add an output to the cell
      const output = { output_type: 'display_data', data: { 'text/plain': 'Output content' } };
      cell.addOutput(output);
      
      // Verify the output was added to the Yjs document
      const youtputs = cellContent.get('outputs') as Y.Array<any>;
      expect(youtputs.length).toBe(1);
      expect(youtputs.get(0)).toEqual(output);
      
      // Simulate another user adding an output
      const output2 = { output_type: 'stream', name: 'stdout', text: 'Another output' };
      youtputs.push([output2]);
      
      // Verify the cell outputs include both outputs
      const outputs = cell.getOutputs();
      expect(outputs.length).toBe(2);
      expect(outputs[0]).toEqual(output);
      expect(outputs[1]).toEqual(output2);
    });
  });
  
  describe('Collaborative editing performance', () => {
    it('should maintain performance with multiple active users', () => {
      // Create a cell with collaborative state
      const cellId = 'test-cell-6';
      const cellYDoc = ydoc.getMap('cells');
      const cellContent = cellYDoc.set(cellId, new Y.Map());
      cellContent.set('source', new Y.Text(''));
      
      // Create a default cell with the collaborative state
      const cell = new DefaultCell({
        id: cellId,
        ydoc,
        lockManager,
        awareness
      });
      
      // Measure the time it takes to make a large number of edits
      const startTime = performance.now();
      
      // Make 1000 small edits
      for (let i = 0; i < 1000; i++) {
        cell.setSource(`Line ${i}\n`);
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      // Verify that the operation completed in a reasonable time
      // This is a simple performance test - in a real scenario you might want to
      // set more specific thresholds based on your performance requirements
      expect(duration).toBeLessThan(5000); // Should complete in less than 5 seconds
      
      // Verify the final content
      expect(cell.getSource()).toBe('Line 999\n');
    });
  });
});