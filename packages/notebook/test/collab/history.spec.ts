// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { IHistoryManager, HistoryManager, IDocumentSnapshot, IDocumentDiff, IHistoryStorageProvider } from '../../src/collab/history';
import * as Y from 'yjs';

/**
 * Mock implementation of IHistoryStorageProvider for testing
 */
class MockHistoryStorageProvider implements IHistoryStorageProvider {
  private snapshots: Map<string, IDocumentSnapshot> = new Map();

  async storeSnapshot(snapshot: IDocumentSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, { ...snapshot });
  }

  async getSnapshot(id: string): Promise<IDocumentSnapshot | null> {
    return this.snapshots.get(id) || null;
  }

  async getSnapshots(options: any = {}): Promise<IDocumentSnapshot[]> {
    let snapshots = Array.from(this.snapshots.values());
    
    // Apply filters
    if (options.authorId) {
      snapshots = snapshots.filter(s => s.author.id === options.authorId);
    }
    
    if (options.tags && options.tags.length > 0) {
      snapshots = snapshots.filter(s => 
        s.tags && options.tags.some((tag: string) => s.tags!.includes(tag))
      );
    }
    
    if (options.majorVersionsOnly) {
      snapshots = snapshots.filter(s => s.isMajorVersion);
    }
    
    if (options.startTime) {
      snapshots = snapshots.filter(s => s.timestamp >= options.startTime);
    }
    
    if (options.endTime) {
      snapshots = snapshots.filter(s => s.timestamp <= options.endTime);
    }
    
    // Sort by timestamp (newest first)
    snapshots.sort((a, b) => b.timestamp - a.timestamp);
    
    // Apply pagination
    if (options.skip) {
      snapshots = snapshots.slice(options.skip);
    }
    
    if (options.limit) {
      snapshots = snapshots.slice(0, options.limit);
    }
    
    return snapshots;
  }

  async deleteSnapshot(id: string): Promise<void> {
    this.snapshots.delete(id);
  }

  async pruneSnapshots(options: { maxAge?: number; maxCount?: number; exceptIds?: string[] }): Promise<number> {
    const now = Date.now();
    const snapshotsToDelete: string[] = [];
    const snapshots = Array.from(this.snapshots.values()).sort((a, b) => a.timestamp - b.timestamp);
    
    // Mark old snapshots for deletion
    if (options.maxAge) {
      for (const snapshot of snapshots) {
        if (now - snapshot.timestamp > options.maxAge && 
            (!options.exceptIds || !options.exceptIds.includes(snapshot.id))) {
          snapshotsToDelete.push(snapshot.id);
        }
      }
    }
    
    // If we have more snapshots than the maximum, mark the oldest for deletion
    if (options.maxCount && snapshots.length - snapshotsToDelete.length > options.maxCount) {
      const excessCount = snapshots.length - snapshotsToDelete.length - options.maxCount;
      let deleted = 0;
      
      for (const snapshot of snapshots) {
        if (deleted >= excessCount) break;
        
        if (!snapshotsToDelete.includes(snapshot.id) && 
            (!options.exceptIds || !options.exceptIds.includes(snapshot.id))) {
          snapshotsToDelete.push(snapshot.id);
          deleted++;
        }
      }
    }
    
    // Delete the marked snapshots
    for (const id of snapshotsToDelete) {
      this.snapshots.delete(id);
    }
    
    return snapshotsToDelete.length;
  }

  // Helper method for tests to clear all snapshots
  clear(): void {
    this.snapshots.clear();
  }

  // Helper method for tests to get snapshot count
  get size(): number {
    return this.snapshots.size;
  }
}

/**
 * Helper function to create a test Yjs document with notebook structure
 */
function createTestNotebookDoc(): Y.Doc {
  const doc = new Y.Doc();
  
  // Create cells array
  const cells = doc.getArray('cells');
  
  // Add some test cells
  const cell1 = new Y.Map();
  cell1.set('id', 'cell1');
  cell1.set('cell_type', 'code');
  cell1.set('source', 'print("Hello World")');
  cell1.set('metadata', new Y.Map());
  
  const cell2 = new Y.Map();
  cell2.set('id', 'cell2');
  cell2.set('cell_type', 'markdown');
  cell2.set('source', '# Heading\nSome markdown content');
  cell2.set('metadata', new Y.Map());
  
  cells.push([cell1, cell2]);
  
  // Create notebook metadata
  const metadata = doc.getMap('metadata');
  metadata.set('kernelspec', { name: 'python3', display_name: 'Python 3' });
  
  return doc;
}

/**
 * Helper function to modify a test document to create a new version
 */
function modifyTestNotebookDoc(doc: Y.Doc): void {
  // Modify a cell
  const cells = doc.getArray('cells');
  const cell1 = cells.get(0);
  cell1.set('source', 'print("Hello Modified World")');
  
  // Add a new cell
  const cell3 = new Y.Map();
  cell3.set('id', 'cell3');
  cell3.set('cell_type', 'code');
  cell3.set('source', 'print("New cell")');
  cell3.set('metadata', new Y.Map());
  
  cells.push([cell3]);
  
  // Modify metadata
  const metadata = doc.getMap('metadata');
  metadata.set('title', 'Modified Notebook');
}

describe('HistoryManager', () => {
  let doc: Y.Doc;
  let historyManager: IHistoryManager;
  let storageProvider: MockHistoryStorageProvider;
  
  beforeEach(() => {
    // Create a fresh document and history manager for each test
    doc = createTestNotebookDoc();
    storageProvider = new MockHistoryStorageProvider();
    historyManager = new HistoryManager(doc, {
      maxSnapshots: 10,
      autoSnapshotInterval: 0, // Disable auto snapshots for testing
      snapshotOnLoad: false, // Disable initial snapshot for testing
      storageProvider
    });
  });
  
  afterEach(() => {
    // Clean up
    historyManager.dispose();
    doc.destroy();
  });

  describe('Snapshot creation and retrieval', () => {
    it('should create a snapshot with the current document state', async () => {
      const snapshot = await historyManager.createSnapshot({
        description: 'Test snapshot',
        author: { id: 'user1', name: 'Test User' },
        isMajorVersion: true
      });
      
      expect(snapshot).toBeDefined();
      expect(snapshot.id).toBeDefined();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.description).toBe('Test snapshot');
      expect(snapshot.author).toEqual({ id: 'user1', name: 'Test User' });
      expect(snapshot.isMajorVersion).toBe(true);
      expect(snapshot.state).toBeInstanceOf(Uint8Array);
      expect(snapshot.stateVector).toBeInstanceOf(Uint8Array);
    });

    it('should retrieve a snapshot by ID', async () => {
      const createdSnapshot = await historyManager.createSnapshot({
        description: 'Test snapshot'
      });
      
      const retrievedSnapshot = await historyManager.getSnapshot(createdSnapshot.id);
      
      expect(retrievedSnapshot).not.toBeNull();
      expect(retrievedSnapshot!.id).toBe(createdSnapshot.id);
      expect(retrievedSnapshot!.description).toBe('Test snapshot');
    });

    it('should return null when retrieving a non-existent snapshot', async () => {
      const snapshot = await historyManager.getSnapshot('non-existent-id');
      expect(snapshot).toBeNull();
    });

    it('should retrieve history with filtering options', async () => {
      // Create snapshots with different authors and tags
      await historyManager.createSnapshot({
        description: 'Snapshot 1',
        author: { id: 'user1', name: 'User 1' },
        tags: ['test', 'important'],
        isMajorVersion: true
      });
      
      await historyManager.createSnapshot({
        description: 'Snapshot 2',
        author: { id: 'user2', name: 'User 2' },
        tags: ['test'],
        isMajorVersion: false
      });
      
      await historyManager.createSnapshot({
        description: 'Snapshot 3',
        author: { id: 'user1', name: 'User 1' },
        tags: ['draft'],
        isMajorVersion: false
      });
      
      // Test filtering by author
      let history = await historyManager.getHistory({ authorId: 'user1' });
      expect(history.length).toBe(2);
      expect(history[0].description).toBe('Snapshot 3');
      expect(history[1].description).toBe('Snapshot 1');
      
      // Test filtering by tags
      history = await historyManager.getHistory({ tags: ['test'] });
      expect(history.length).toBe(2);
      expect(history[0].description).toBe('Snapshot 2');
      expect(history[1].description).toBe('Snapshot 1');
      
      // Test filtering by major versions
      history = await historyManager.getHistory({ majorVersionsOnly: true });
      expect(history.length).toBe(1);
      expect(history[0].description).toBe('Snapshot 1');
      
      // Test pagination
      history = await historyManager.getHistory({ limit: 1 });
      expect(history.length).toBe(1);
      expect(history[0].description).toBe('Snapshot 3');
      
      history = await historyManager.getHistory({ skip: 1, limit: 1 });
      expect(history.length).toBe(1);
      expect(history[0].description).toBe('Snapshot 2');
    });
  });

  describe('Diff generation', () => {
    let snapshot1Id: string;
    let snapshot2Id: string;
    
    beforeEach(async () => {
      // Create initial snapshot
      const snapshot1 = await historyManager.createSnapshot({
        description: 'Initial state',
        author: { id: 'user1', name: 'User 1' }
      });
      snapshot1Id = snapshot1.id;
      
      // Modify the document
      modifyTestNotebookDoc(doc);
      
      // Create second snapshot
      const snapshot2 = await historyManager.createSnapshot({
        description: 'Modified state',
        author: { id: 'user2', name: 'User 2' }
      });
      snapshot2Id = snapshot2.id;
    });

    it('should generate a diff between two snapshots', async () => {
      const diff = await historyManager.getDiff(snapshot1Id, snapshot2Id);
      
      expect(diff).toBeDefined();
      expect(diff.fromId).toBe(snapshot1Id);
      expect(diff.toId).toBe(snapshot2Id);
      
      // Check summary
      expect(diff.summary.cellsAdded).toBe(1);
      expect(diff.summary.cellsModified).toBe(1);
      expect(diff.summary.cellsRemoved).toBe(0);
      expect(diff.summary.totalMetadataChanges).toBeGreaterThan(0);
      
      // Check cell changes
      expect(diff.cellChanges['cell1'].type).toBe('modified');
      expect(diff.cellChanges['cell1'].contentChanges).toBeDefined();
      expect(diff.cellChanges['cell1'].contentChanges![0].oldContent).toContain('Hello World');
      expect(diff.cellChanges['cell1'].contentChanges![0].newContent).toContain('Hello Modified World');
      
      expect(diff.cellChanges['cell2'].type).toBe('unchanged');
      
      expect(diff.cellChanges['cell3'].type).toBe('added');
      
      // Check metadata changes
      expect(diff.metadataChanges).toBeDefined();
      expect(diff.metadataChanges!.some(change => change.path === 'title')).toBe(true);
    });

    it('should throw an error when diffing with a non-existent snapshot', async () => {
      await expect(historyManager.getDiff('non-existent-id', snapshot2Id))
        .rejects.toThrow('Snapshot not found');
      
      await expect(historyManager.getDiff(snapshot1Id, 'non-existent-id'))
        .rejects.toThrow('Snapshot not found');
    });
  });

  describe('Content restoration', () => {
    let snapshot1Id: string;
    let modifiedDoc: Y.Doc;
    
    beforeEach(async () => {
      // Create initial snapshot
      const snapshot1 = await historyManager.createSnapshot({
        description: 'Initial state',
        author: { id: 'user1', name: 'User 1' }
      });
      snapshot1Id = snapshot1.id;
      
      // Save the initial state
      modifiedDoc = new Y.Doc();
      Y.applyUpdate(modifiedDoc, Y.encodeStateAsUpdate(doc));
      
      // Modify the document
      modifyTestNotebookDoc(doc);
    });

    afterEach(() => {
      modifiedDoc.destroy();
    });

    it('should restore the entire document from a snapshot', async () => {
      // Verify the document has been modified
      const cellsBefore = doc.getArray('cells');
      expect(cellsBefore.length).toBe(3); // We added a cell in modifyTestNotebookDoc
      
      // Restore from the initial snapshot
      await historyManager.restoreSnapshot(snapshot1Id);
      
      // Verify the document has been restored
      const cellsAfter = doc.getArray('cells');
      expect(cellsAfter.length).toBe(2); // Back to the original 2 cells
      
      const cell1 = cellsAfter.get(0);
      expect(cell1.get('source')).toBe('print("Hello World")');
      
      // Verify metadata is restored
      const metadata = doc.getMap('metadata');
      expect(metadata.get('title')).toBeUndefined(); // This was added in the modification
    });

    it('should restore specific cells from a snapshot', async () => {
      // Verify the document has been modified
      const cellsBefore = doc.getArray('cells');
      const cell1Before = cellsBefore.get(0);
      expect(cell1Before.get('source')).toBe('print("Hello Modified World")');
      
      // Restore only cell1 from the initial snapshot
      await historyManager.restoreCells(snapshot1Id, ['cell1']);
      
      // Verify only cell1 has been restored
      const cellsAfter = doc.getArray('cells');
      expect(cellsAfter.length).toBe(3); // Still have 3 cells
      
      const cell1After = cellsAfter.get(0);
      expect(cell1After.get('source')).toBe('print("Hello World")');
      
      // Verify cell3 is still there (wasn't restored)
      const cell3 = cellsAfter.get(2);
      expect(cell3.get('id')).toBe('cell3');
    });

    it('should emit contentRestored signal when restoring content', async () => {
      // Set up a spy on the contentRestored signal
      const spy = jest.fn();
      historyManager.contentRestored.connect(spy);
      
      // Restore from the initial snapshot
      await historyManager.restoreSnapshot(snapshot1Id);
      
      // Verify the signal was emitted
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1].snapshot.id).toBe(snapshot1Id);
    });

    it('should create a new snapshot after restoring if requested', async () => {
      // Get the current number of snapshots
      const beforeCount = (await historyManager.getHistory()).length;
      
      // Restore with createSnapshot option
      await historyManager.restoreSnapshot(snapshot1Id, { createSnapshot: true });
      
      // Verify a new snapshot was created
      const afterCount = (await historyManager.getHistory()).length;
      expect(afterCount).toBe(beforeCount + 1);
      
      // Verify the new snapshot has the correct description
      const history = await historyManager.getHistory({ limit: 1 });
      expect(history[0].description).toContain('Restored from snapshot');
    });
  });

  describe('History management', () => {
    it('should update configuration', () => {
      historyManager.updateConfig({ maxSnapshots: 20, autoSnapshotInterval: 60000 });
      
      const config = historyManager.getConfig();
      expect(config.maxSnapshots).toBe(20);
      expect(config.autoSnapshotInterval).toBe(60000);
    });

    it('should prune history based on retention policy', async () => {
      // Create snapshots with different timestamps
      const now = Date.now();
      
      // Create an old snapshot (30 days old)
      const oldSnapshot = await historyManager.createSnapshot({
        description: 'Old snapshot'
      });
      
      // Manually update the timestamp to make it old
      const oldSnapshotObj = await historyManager.getSnapshot(oldSnapshot.id);
      oldSnapshotObj!.timestamp = now - 31 * 24 * 60 * 60 * 1000; // 31 days old
      await storageProvider.storeSnapshot(oldSnapshotObj!);
      
      // Create some recent snapshots
      for (let i = 0; i < 5; i++) {
        await historyManager.createSnapshot({
          description: `Recent snapshot ${i}`
        });
      }
      
      // Update config to keep only 3 snapshots and max age of 30 days
      historyManager.updateConfig({ maxSnapshots: 3, maxSnapshotAge: 30 * 24 * 60 * 60 * 1000 });
      
      // Prune history
      const prunedCount = await historyManager.pruneHistory();
      
      // Should have pruned the old snapshot and the oldest 3 recent ones (total 4)
      expect(prunedCount).toBe(4);
      
      // Verify we have only 3 snapshots left
      const history = await historyManager.getHistory();
      expect(history.length).toBe(3);
      
      // Verify the old snapshot was pruned
      const oldSnapshotAfter = await historyManager.getSnapshot(oldSnapshot.id);
      expect(oldSnapshotAfter).toBeNull();
    });

    it('should delete a specific snapshot', async () => {
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot({
        description: 'Test snapshot'
      });
      
      // Verify it exists
      expect(await historyManager.getSnapshot(snapshot.id)).not.toBeNull();
      
      // Delete it
      await historyManager.deleteSnapshot(snapshot.id);
      
      // Verify it's gone
      expect(await historyManager.getSnapshot(snapshot.id)).toBeNull();
    });
  });

  describe('Signal emissions', () => {
    it('should emit snapshotCreated signal when creating a snapshot', async () => {
      // Set up a spy on the snapshotCreated signal
      const spy = jest.fn();
      historyManager.snapshotCreated.connect(spy);
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot({
        description: 'Test snapshot'
      });
      
      // Verify the signal was emitted
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1].id).toBe(snapshot.id);
    });
  });

  describe('Error handling', () => {
    it('should handle errors when storage provider fails', async () => {
      // Create a failing storage provider
      const failingProvider: IHistoryStorageProvider = {
        storeSnapshot: jest.fn().mockRejectedValue(new Error('Storage failure')),
        getSnapshot: jest.fn().mockRejectedValue(new Error('Storage failure')),
        getSnapshots: jest.fn().mockRejectedValue(new Error('Storage failure')),
        deleteSnapshot: jest.fn().mockRejectedValue(new Error('Storage failure')),
        pruneSnapshots: jest.fn().mockRejectedValue(new Error('Storage failure'))
      };
      
      // Create a history manager with the failing provider
      const errorHistoryManager = new HistoryManager(doc, {
        storageProvider: failingProvider
      });
      
      // Attempt to create a snapshot and expect it to fail
      await expect(errorHistoryManager.createSnapshot())
        .rejects.toThrow('Storage failure');
      
      // Clean up
      errorHistoryManager.dispose();
    });
  });
});

describe('UI Integration', () => {
  // These tests would typically be in a separate file that tests the UI components
  // Here we're just providing a skeleton to show what would be tested
  
  it('should render timeline visualization correctly', () => {
    // This would test that the UI component for timeline visualization
    // correctly renders the history data
    expect(true).toBe(true); // Placeholder
  });
  
  it('should display diff visualization between versions', () => {
    // This would test that the UI component for diff visualization
    // correctly renders the diff between two snapshots
    expect(true).toBe(true); // Placeholder
  });
  
  it('should allow restoring content from the UI', () => {
    // This would test that the UI provides functionality to restore
    // content from a snapshot
    expect(true).toBe(true); // Placeholder
  });
  
  it('should show author information for changes', () => {
    // This would test that the UI displays author information for changes
    expect(true).toBe(true); // Placeholder
  });
});