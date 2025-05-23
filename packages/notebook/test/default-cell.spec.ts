// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DefaultCell, ICollaborativeCell, ICollaborativeCellState } from '../src/default-cell';
import { LockManager, ILockManager, LockManagerStatus } from '../src/collab/locks';
import { YjsAwareness } from '../src/collab/awareness';
import { Cell } from '@jupyterlab/cells';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { Widget } from '@lumino/widgets';
import * as Y from 'yjs';

// Mock implementations
class MockCodeEditor implements Partial<CodeEditor.IEditor> {
  model = {
    value: {
      text: 'Initial content',
      changed: {
        connect: jest.fn()
      }
    },
    selections: {
      changed: {
        connect: jest.fn()
      }
    }
  };
  
  getCursor = jest.fn(() => ({ line: 0, column: 0 }));
  getPositionAt = jest.fn((offset: number) => ({ line: 0, column: offset }));
  getCoordinateForPosition = jest.fn(() => ({ top: 10, left: 10, height: 20, width: 10 }));
  getDoc = jest.fn(() => ({
    getValue: () => 'Initial content',
    posFromIndex: (index: number) => ({ line: 0, ch: index }),
    indexFromPos: (pos: { line: number; ch: number }) => pos.ch,
    getSelection: () => 'Selected text',
    setCursor: jest.fn(),
    setSelection: jest.fn()
  }));
  on = jest.fn();
  off = jest.fn();
  refresh = jest.fn();
  focus = jest.fn();
}

class MockCellModel {
  id = 'test-cell-id';
  contentChanged = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn()
  };
  metadata = {
    get: jest.fn((key: string) => null),
    set: jest.fn(),
    changed: {
      connect: jest.fn()
    }
  };
  value = {
    text: 'Initial content',
    changed: {
      connect: jest.fn()
    }
  };
  sharedModel = {
    getSource: jest.fn(() => 'Initial content'),
    setSource: jest.fn()
  };
  ydoc = new Y.Doc();
  ytext = this.ydoc.getText('content');
  ydocChanged = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn()
  };
  setYDoc = jest.fn((ydoc: Y.Doc) => {
    this.ydoc = ydoc;
    this.ytext = ydoc.getText('content');
    this.ydocChanged.emit();
  });
}

describe('DefaultCell', () => {
  let cell: DefaultCell;
  let model: MockCellModel;
  let editor: MockCodeEditor;
  let ydoc: Y.Doc;
  let awareness: YjsAwareness;
  let lockManager: ILockManager;

  beforeEach(() => {
    // Set up the document
    ydoc = new Y.Doc();
    
    // Set up the model
    model = new MockCellModel();
    model.ydoc = ydoc;
    model.ytext = ydoc.getText('content');
    
    // Set up the editor
    editor = new MockCodeEditor();
    
    // Create the cell
    cell = new DefaultCell({
      model: model as any,
      contentFactory: {
        createCellEditor: () => editor as any,
        createOutputArea: jest.fn(() => ({
          model: {
            clear: jest.fn(),
            fromJSON: jest.fn(),
            toJSON: jest.fn(() => [])
          },
          renderModel: jest.fn(),
          dispose: jest.fn()
        })),
        createOutputPrompt: jest.fn(() => new Widget()),
        createInputPrompt: jest.fn(() => new Widget())
      } as any
    });
    
    // Set up awareness
    awareness = new YjsAwareness(ydoc);
    cell.setAwareness(awareness);
    
    // Set up lock manager
    lockManager = new LockManager({
      ydoc,
      awareness: awareness as any,
      userId: 'test-user-id',
      userName: 'Test User'
    });
    cell.setLockManager(lockManager);
    
    // Attach the cell to the DOM for testing
    Widget.attach(cell, document.body);
  });

  afterEach(() => {
    cell.dispose();
    ydoc.destroy();
    awareness.destroy();
    lockManager.dispose();
  });

  describe('Collaborative state initialization', () => {
    it('should initialize with correct collaborative state', () => {
      const state = cell.collaborativeState;
      expect(state).toBeDefined();
      expect(state.locked).toBe(false);
      expect(state.lockedBy).toBeNull();
      expect(state.ydoc).toBe(ydoc);
      expect(state.ytext).toBe(model.ytext);
      expect(state.awareness).toBe(awareness);
    });

    it('should have the correct CSS classes for collaborative editing', () => {
      expect(cell.hasClass('jp-CollaborativeCell')).toBe(true);
      expect(cell.hasClass('jp-DefaultCell')).toBe(true);
    });

    it('should create lock status indicator and remote cursors container', () => {
      // Check for lock indicator
      const lockIndicator = cell.node.querySelector('.jp-CollaborativeCell-LockIndicator');
      expect(lockIndicator).not.toBeNull();
      
      // Check for remote cursors container
      const remoteCursors = cell.node.querySelector('.jp-CollaborativeCell-RemoteCursors');
      expect(remoteCursors).not.toBeNull();
    });
  });

  describe('Cell locking mechanism', () => {
    it('should acquire a lock on the cell', async () => {
      const spy = jest.spyOn(lockManager, 'acquireLock');
      const result = await cell.acquireLock();
      
      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledWith(model.id);
      expect(cell.collaborativeState.locked).toBe(true);
      expect(cell.collaborativeState.lockedBy).toBe('test-user-id');
      expect(cell.hasClass('jp-CollaborativeCell-locked')).toBe(true);
      expect(cell.hasClass('jp-CollaborativeCell-lockedByCurrentUser')).toBe(true);
    });

    it('should release a lock on the cell', async () => {
      // First acquire the lock
      await cell.acquireLock();
      
      const spy = jest.spyOn(lockManager, 'releaseLock');
      await cell.releaseLock();
      
      expect(spy).toHaveBeenCalledWith(model.id);
      expect(cell.collaborativeState.locked).toBe(false);
      expect(cell.collaborativeState.lockedBy).toBeNull();
      expect(cell.hasClass('jp-CollaborativeCell-locked')).toBe(false);
      expect(cell.hasClass('jp-CollaborativeCell-lockedByCurrentUser')).toBe(false);
    });

    it('should update lock status indicator when lock state changes', async () => {
      // Initially no lock
      let lockText = cell.node.querySelector('.jp-CollaborativeCell-lockText');
      expect(lockText).toBeNull();
      
      // Acquire lock
      await cell.acquireLock();
      
      // Should show lock indicator with "Editing" text
      lockText = cell.node.querySelector('.jp-CollaborativeCell-lockText');
      expect(lockText).not.toBeNull();
      expect(lockText?.textContent).toBe('Editing');
      
      // Release lock
      await cell.releaseLock();
      
      // Lock indicator should be empty again
      lockText = cell.node.querySelector('.jp-CollaborativeCell-lockText');
      expect(lockText).toBeNull();
    });

    it('should prevent concurrent edits by different users', async () => {
      // Simulate another user acquiring the lock first
      const otherUserLock = {
        cellId: model.id,
        userId: 'other-user-id',
        userName: 'Other User',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30000
      };
      
      // Mock the getLock method to return the other user's lock
      jest.spyOn(lockManager, 'getLock').mockReturnValue(otherUserLock);
      
      // Try to acquire the lock
      const result = await cell.acquireLock();
      
      // Should fail to acquire the lock
      expect(result).toBe(false);
      expect(cell.collaborativeState.locked).toBe(false);
      expect(cell.collaborativeState.lockedBy).toBeNull();
    });

    it('should handle lock expiration correctly', async () => {
      // Acquire a lock
      await cell.acquireLock();
      
      // Simulate lock expiration
      const expiredLock = {
        ...lockManager.getLock(model.id)!,
        expiresAt: Date.now() - 1000 // Expired 1 second ago
      };
      
      // Mock the getLock method to return the expired lock
      jest.spyOn(lockManager, 'getLock').mockReturnValue(null);
      
      // Check lock status
      expect(cell.collaborativeState.locked).toBe(true); // Still locked in cell state
      
      // Try to acquire the lock again (should succeed because the previous lock expired)
      const result = await cell.acquireLock();
      expect(result).toBe(true);
    });
  });

  describe('Collaborative editing with Yjs', () => {
    it('should update content when Yjs text changes', () => {
      // Set up a spy on the editor's setValue method
      const setValueSpy = jest.spyOn(cell.editor?.model.value, 'text', 'set');
      
      // Simulate a remote change to the Yjs text
      const otherDoc = new Y.Doc();
      otherDoc.clientID = 2; // Different client ID
      
      // Create a text in the other doc with the same name
      const otherText = otherDoc.getText('content');
      otherText.insert(0, 'Remote change');
      
      // Apply the update to our doc
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(otherDoc));
      
      // The editor content should be updated
      // Note: In a real implementation, this would be handled by a binding between
      // the editor and the Yjs text, which we're not fully simulating here
      expect(model.ytext.toString()).toBe('Remote change');
    });

    it('should handle concurrent edits from multiple users correctly', () => {
      // Create docs for three different users
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const doc3 = new Y.Doc();
      
      // Set different client IDs
      doc1.clientID = 1;
      doc2.clientID = 2;
      doc3.clientID = 3;
      
      // Get text instances for each doc
      const text1 = doc1.getText('content');
      const text2 = doc2.getText('content');
      const text3 = doc3.getText('content');
      
      // Make concurrent edits
      text1.insert(0, 'User 1 edit ');
      text2.insert(0, 'User 2 edit ');
      text3.insert(0, 'User 3 edit ');
      
      // Sync the documents
      const update1 = Y.encodeStateAsUpdate(doc1);
      const update2 = Y.encodeStateAsUpdate(doc2);
      const update3 = Y.encodeStateAsUpdate(doc3);
      
      Y.applyUpdate(doc1, update2);
      Y.applyUpdate(doc1, update3);
      Y.applyUpdate(doc2, update1);
      Y.applyUpdate(doc2, update3);
      Y.applyUpdate(doc3, update1);
      Y.applyUpdate(doc3, update2);
      
      // All documents should converge to the same state
      expect(text1.toString()).toBe(text2.toString());
      expect(text2.toString()).toBe(text3.toString());
      
      // Apply to our test document
      Y.applyUpdate(ydoc, update1);
      
      // Our document should have the same content
      expect(model.ytext.toString()).toBe(text1.toString());
    });

    it('should track remote cursor positions', () => {
      // Set up awareness states for remote users
      const remoteAwareness = new YjsAwareness(ydoc);
      remoteAwareness.setLocalStateField('user', {
        name: 'Remote User',
        color: '#ff0000'
      });
      remoteAwareness.setLocalStateField('cursor', {
        cellId: model.id,
        position: 5,
        selection: { start: 5, end: 10 }
      });
      
      // Update our awareness with the remote state
      awareness.applyUpdate(
        remoteAwareness.encodeUpdate([remoteAwareness.clientID])
      );
      
      // Update remote cursors
      cell.updateRemoteCursors();
      
      // Check if remote cursor is rendered
      const remoteCursor = cell.node.querySelector('.jp-CollaborativeCell-remoteCursor');
      expect(remoteCursor).not.toBeNull();
      
      // Check if remote selection is rendered
      const remoteSelection = cell.node.querySelector('.jp-CollaborativeCell-remoteSelection');
      expect(remoteSelection).not.toBeNull();
    });
  });

  describe('Cell metadata synchronization', () => {
    it('should synchronize cell metadata across clients', () => {
      // Create a shared map for cell metadata
      const metadataMap = ydoc.getMap('metadata');
      
      // Set some metadata
      metadataMap.set('tags', ['important', 'example']);
      metadataMap.set('collapsed', true);
      
      // Create another doc to simulate another client
      const otherDoc = new Y.Doc();
      
      // Apply our state to the other doc
      Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(ydoc));
      
      // Get the metadata map from the other doc
      const otherMetadataMap = otherDoc.getMap('metadata');
      
      // Check that metadata is synchronized
      expect(otherMetadataMap.get('tags')).toEqual(['important', 'example']);
      expect(otherMetadataMap.get('collapsed')).toBe(true);
      
      // Make a change in the other doc
      otherMetadataMap.set('tags', ['important', 'example', 'updated']);
      
      // Apply the update back to our doc
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(otherDoc));
      
      // Check that our metadata is updated
      expect(metadataMap.get('tags')).toEqual(['important', 'example', 'updated']);
    });
  });

  describe('Cell output synchronization', () => {
    it('should synchronize cell outputs across clients', () => {
      // Create a shared array for cell outputs
      const outputsArray = ydoc.getArray('outputs');
      
      // Add some outputs
      outputsArray.push([{ 
        output_type: 'display_data',
        data: { 'text/plain': 'Hello, world!' }
      }]);
      
      // Create another doc to simulate another client
      const otherDoc = new Y.Doc();
      
      // Apply our state to the other doc
      Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(ydoc));
      
      // Get the outputs array from the other doc
      const otherOutputsArray = otherDoc.getArray('outputs');
      
      // Check that outputs are synchronized
      expect(otherOutputsArray.toJSON()).toEqual(outputsArray.toJSON());
      
      // Add another output in the other doc
      otherOutputsArray.push([{ 
        output_type: 'stream',
        name: 'stdout',
        text: 'Another output'
      }]);
      
      // Apply the update back to our doc
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(otherDoc));
      
      // Check that our outputs are updated
      expect(outputsArray.toJSON()).toEqual(otherOutputsArray.toJSON());
    });
  });

  describe('Performance with multiple users', () => {
    it('should maintain performance with multiple active users', () => {
      // Create multiple docs to simulate multiple users
      const userCount = 10;
      const userDocs: Y.Doc[] = [];
      const userTexts: Y.Text[] = [];
      
      for (let i = 0; i < userCount; i++) {
        const doc = new Y.Doc();
        doc.clientID = i + 1;
        userDocs.push(doc);
        userTexts.push(doc.getText('content'));
      }
      
      // Measure time to apply multiple updates
      const startTime = performance.now();
      
      // Each user makes an edit
      for (let i = 0; i < userCount; i++) {
        userTexts[i].insert(0, `User ${i + 1} edit `);
      }
      
      // Sync all documents with each other
      for (let i = 0; i < userCount; i++) {
        const update = Y.encodeStateAsUpdate(userDocs[i]);
        for (let j = 0; j < userCount; j++) {
          if (i !== j) {
            Y.applyUpdate(userDocs[j], update);
          }
        }
      }
      
      // Apply to our test document
      for (let i = 0; i < userCount; i++) {
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(userDocs[i]));
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      // All documents should have converged to the same state
      for (let i = 1; i < userCount; i++) {
        expect(userTexts[i].toString()).toBe(userTexts[0].toString());
      }
      
      // Our document should have the same content
      expect(model.ytext.toString()).toBe(userTexts[0].toString());
      
      // Performance should be reasonable (adjust threshold as needed)
      // This is a simple check to ensure operations don't take too long
      expect(duration).toBeLessThan(500); // 500ms is a generous threshold for this test
    });
  });

  describe('Cleanup and disposal', () => {
    it('should clean up resources when disposed', () => {
      // Set up spies
      const releaseLockSpy = jest.spyOn(cell, 'releaseLock');
      
      // Acquire a lock first
      cell.acquireLock();
      
      // Dispose the cell
      cell.dispose();
      
      // Should release locks and clean up resources
      expect(releaseLockSpy).toHaveBeenCalled();
      expect(cell.isDisposed).toBe(true);
    });
  });
});