// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  HistoryManager,
  IHistoryManager,
  IHistorySnapshot,
  INotebookDiff,
  IRestoreResult,
  HistoryManagerStatus,
  IHistoryFilter
} from '../../src/collab/history';

import { INotebookModel } from '../../src/model';
import * as Y from 'yjs';

/**
 * Mock notebook model for testing
 */
class MockNotebookModel implements Partial<INotebookModel> {
  constructor() {
    this._cells = [];
    this._metadata = {};
  }

  /**
   * Convert the model to a JSON representation.
   */
  toJSON(): any {
    return {
      cells: this._cells,
      metadata: this._metadata,
      nbformat: 4,
      nbformat_minor: 5
    };
  }

  /**
   * Deserialize the model from JSON.
   *
   * @param data - The JSON data to deserialize.
   */
  fromJSON(data: any): void {
    this._cells = data.cells || [];
    this._metadata = data.metadata || {};
  }

  /**
   * Add a cell to the model for testing
   */
  addCell(cell: any): void {
    this._cells.push(cell);
  }

  /**
   * Update a cell in the model for testing
   */
  updateCell(id: string, content: string): void {
    const index = this._cells.findIndex(cell => cell.id === id);
    if (index !== -1) {
      this._cells[index].source = content;
    }
  }

  /**
   * Remove a cell from the model for testing
   */
  removeCell(id: string): void {
    const index = this._cells.findIndex(cell => cell.id === id);
    if (index !== -1) {
      this._cells.splice(index, 1);
    }
  }

  /**
   * Set metadata for testing
   */
  setMetadata(key: string, value: any): void {
    this._metadata[key] = value;
  }

  private _cells: any[];
  private _metadata: any;
}

/**
 * Helper function to create a mock cell for testing
 */
function createMockCell(id: string, content: string, cellType: string = 'code'): any {
  return {
    id,
    cell_type: cellType,
    source: content,
    metadata: {},
    execution_count: null,
    outputs: []
  };
}

/**
 * Helper function to create a history manager for testing
 */
function createHistoryManager(): { 
  ydoc: Y.Doc; 
  notebookModel: MockNotebookModel; 
  historyManager: IHistoryManager 
} {
  const ydoc = new Y.Doc();
  const notebookModel = new MockNotebookModel();
  
  // Add some initial cells
  notebookModel.addCell(createMockCell('cell1', 'print("Hello World")', 'code'));
  notebookModel.addCell(createMockCell('cell2', '# Markdown cell', 'markdown'));
  
  const historyManager = new HistoryManager({
    notebookModel: notebookModel as INotebookModel,
    ydoc,
    userId: 'user1',
    userName: 'Test User',
    userAvatarUrl: 'https://example.com/avatar.png',
    createInitialSnapshot: false, // Disable automatic initial snapshot for testing
    enableAutoSnapshots: false // Disable auto snapshots for testing
  });
  
  return { ydoc, notebookModel, historyManager };
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

describe('HistoryManager', () => {
  describe('constructor', () => {
    it('should create a history manager with the correct initial state', () => {
      const { historyManager } = createHistoryManager();
      
      expect(historyManager.status).toBe(HistoryManagerStatus.Ready);
      expect(historyManager.getSnapshots()).resolves.toHaveLength(0);
    });
    
    it('should create an initial snapshot when configured', async () => {
      const { ydoc, notebookModel } = createHistoryManager();
      
      // Create a history manager with initial snapshot enabled
      const historyManager = new HistoryManager({
        notebookModel: notebookModel as INotebookModel,
        ydoc,
        userId: 'user1',
        userName: 'Test User',
        createInitialSnapshot: true,
        enableAutoSnapshots: false
      });
      
      // Verify an initial snapshot was created
      const snapshots = await historyManager.getSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].automatic).toBe(true);
      expect(snapshots[0].label).toBe('Initial snapshot');
    });
  });
  
  describe('snapshot management', () => {
    it('should create a snapshot', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot({
        label: 'Test Snapshot',
        description: 'A test snapshot',
        tags: ['test']
      });
      
      // Verify the snapshot was created with the correct properties
      expect(snapshot).toBeDefined();
      expect(snapshot.id).toBeDefined();
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.author.id).toBe('user1');
      expect(snapshot.author.name).toBe('Test User');
      expect(snapshot.label).toBe('Test Snapshot');
      expect(snapshot.description).toBe('A test snapshot');
      expect(snapshot.automatic).toBe(false);
      expect(snapshot.tags).toEqual(['test']);
      
      // Verify the snapshot is in the history manager
      const snapshots = await historyManager.getSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].id).toBe(snapshot.id);
    });
    
    it('should get a snapshot by ID', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot({
        label: 'Test Snapshot'
      });
      
      // Get the snapshot by ID
      const retrievedSnapshot = await historyManager.getSnapshot(snapshot.id);
      
      // Verify the snapshot was retrieved correctly
      expect(retrievedSnapshot).toBeDefined();
      expect(retrievedSnapshot?.id).toBe(snapshot.id);
      expect(retrievedSnapshot?.label).toBe('Test Snapshot');
    });
    
    it('should return undefined for non-existent snapshot ID', async () => {
      const { historyManager } = createHistoryManager();
      
      // Try to get a non-existent snapshot
      const snapshot = await historyManager.getSnapshot('non-existent-id');
      
      // Verify the result is undefined
      expect(snapshot).toBeUndefined();
    });
    
    it('should update a snapshot', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot({
        label: 'Original Label',
        description: 'Original description',
        tags: ['original']
      });
      
      // Update the snapshot
      const updatedSnapshot = await historyManager.updateSnapshot(snapshot.id, {
        label: 'Updated Label',
        description: 'Updated description',
        tags: ['updated']
      });
      
      // Verify the snapshot was updated
      expect(updatedSnapshot).toBeDefined();
      expect(updatedSnapshot?.label).toBe('Updated Label');
      expect(updatedSnapshot?.description).toBe('Updated description');
      expect(updatedSnapshot?.tags).toEqual(['updated']);
      
      // Verify the update is persistent
      const retrievedSnapshot = await historyManager.getSnapshot(snapshot.id);
      expect(retrievedSnapshot?.label).toBe('Updated Label');
    });
    
    it('should delete a snapshot', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Verify the snapshot exists
      expect(await historyManager.getSnapshots()).toHaveLength(1);
      
      // Delete the snapshot
      const result = await historyManager.deleteSnapshot(snapshot.id);
      
      // Verify the deletion was successful
      expect(result).toBe(true);
      expect(await historyManager.getSnapshots()).toHaveLength(0);
      expect(await historyManager.getSnapshot(snapshot.id)).toBeUndefined();
    });
    
    it('should return false when deleting a non-existent snapshot', async () => {
      const { historyManager } = createHistoryManager();
      
      // Try to delete a non-existent snapshot
      const result = await historyManager.deleteSnapshot('non-existent-id');
      
      // Verify the result is false
      expect(result).toBe(false);
    });
  });
  
  describe('snapshot filtering', () => {
    it('should filter snapshots by author ID', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create snapshots
      await historyManager.createSnapshot();
      
      // Filter by author ID
      const snapshots = await historyManager.getSnapshots({ authorId: 'user1' });
      expect(snapshots).toHaveLength(1);
      
      // Filter by non-existent author ID
      const noSnapshots = await historyManager.getSnapshots({ authorId: 'non-existent-user' });
      expect(noSnapshots).toHaveLength(0);
    });
    
    it('should filter snapshots by tag', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create snapshots with different tags
      await historyManager.createSnapshot({ tags: ['tag1'] });
      await historyManager.createSnapshot({ tags: ['tag2'] });
      await historyManager.createSnapshot({ tags: ['tag1', 'tag3'] });
      
      // Filter by tag1
      const tag1Snapshots = await historyManager.getSnapshots({ tag: 'tag1' });
      expect(tag1Snapshots).toHaveLength(2);
      
      // Filter by tag2
      const tag2Snapshots = await historyManager.getSnapshots({ tag: 'tag2' });
      expect(tag2Snapshots).toHaveLength(1);
      
      // Filter by non-existent tag
      const noSnapshots = await historyManager.getSnapshots({ tag: 'non-existent-tag' });
      expect(noSnapshots).toHaveLength(0);
    });
    
    it('should filter snapshots by time range', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create snapshots at different times
      const snapshot1 = await historyManager.createSnapshot();
      
      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const snapshot2 = await historyManager.createSnapshot();
      
      // Filter by start time
      const laterSnapshots = await historyManager.getSnapshots({ 
        startTime: snapshot1.timestamp + 1 
      });
      expect(laterSnapshots).toHaveLength(1);
      expect(laterSnapshots[0].id).toBe(snapshot2.id);
      
      // Filter by end time
      const earlierSnapshots = await historyManager.getSnapshots({ 
        endTime: snapshot2.timestamp - 1 
      });
      expect(earlierSnapshots).toHaveLength(1);
      expect(earlierSnapshots[0].id).toBe(snapshot1.id);
      
      // Filter by time range that includes both
      const allSnapshots = await historyManager.getSnapshots({ 
        startTime: snapshot1.timestamp - 1,
        endTime: snapshot2.timestamp + 1 
      });
      expect(allSnapshots).toHaveLength(2);
    });
    
    it('should filter snapshots by automatic flag', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create manual and automatic snapshots
      await historyManager.createSnapshot({ automatic: false });
      await historyManager.createSnapshot({ automatic: true });
      
      // Filter by automatic = true
      const autoSnapshots = await historyManager.getSnapshots({ automatic: true });
      expect(autoSnapshots).toHaveLength(1);
      expect(autoSnapshots[0].automatic).toBe(true);
      
      // Filter by automatic = false
      const manualSnapshots = await historyManager.getSnapshots({ automatic: false });
      expect(manualSnapshots).toHaveLength(1);
      expect(manualSnapshots[0].automatic).toBe(false);
    });
    
    it('should filter snapshots by search text', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create snapshots with different labels and descriptions
      await historyManager.createSnapshot({ 
        label: 'Python Notebook', 
        description: 'A notebook about Python' 
      });
      await historyManager.createSnapshot({ 
        label: 'JavaScript Notebook', 
        description: 'A notebook about JavaScript' 
      });
      
      // Search for Python
      const pythonSnapshots = await historyManager.getSnapshots({ searchText: 'Python' });
      expect(pythonSnapshots).toHaveLength(1);
      expect(pythonSnapshots[0].label).toBe('Python Notebook');
      
      // Search for JavaScript
      const jsSnapshots = await historyManager.getSnapshots({ searchText: 'JavaScript' });
      expect(jsSnapshots).toHaveLength(1);
      expect(jsSnapshots[0].label).toBe('JavaScript Notebook');
      
      // Search for Notebook (should find both)
      const notebookSnapshots = await historyManager.getSnapshots({ searchText: 'Notebook' });
      expect(notebookSnapshots).toHaveLength(2);
      
      // Search for non-existent text
      const noSnapshots = await historyManager.getSnapshots({ searchText: 'non-existent-text' });
      expect(noSnapshots).toHaveLength(0);
    });
    
    it('should limit the number of snapshots returned', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create multiple snapshots
      await historyManager.createSnapshot();
      await historyManager.createSnapshot();
      await historyManager.createSnapshot();
      
      // Limit to 2 snapshots
      const limitedSnapshots = await historyManager.getSnapshots({ limit: 2 });
      expect(limitedSnapshots).toHaveLength(2);
    });
    
    it('should sort snapshots by timestamp', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create snapshots at different times
      const snapshot1 = await historyManager.createSnapshot();
      
      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const snapshot2 = await historyManager.createSnapshot();
      
      // Sort in ascending order
      const ascSnapshots = await historyManager.getSnapshots({ order: 'asc' });
      expect(ascSnapshots).toHaveLength(2);
      expect(ascSnapshots[0].id).toBe(snapshot1.id);
      expect(ascSnapshots[1].id).toBe(snapshot2.id);
      
      // Sort in descending order (default)
      const descSnapshots = await historyManager.getSnapshots();
      expect(descSnapshots).toHaveLength(2);
      expect(descSnapshots[0].id).toBe(snapshot2.id);
      expect(descSnapshots[1].id).toBe(snapshot1.id);
    });
  });
  
  describe('snapshot comparison', () => {
    it('should compare two snapshots with no changes', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create two identical snapshots
      const snapshot1 = await historyManager.createSnapshot();
      const snapshot2 = await historyManager.createSnapshot();
      
      // Compare the snapshots
      const diff = await historyManager.compareSnapshots(snapshot1.id, snapshot2.id);
      
      // Verify the diff shows no changes
      expect(diff.fromId).toBe(snapshot1.id);
      expect(diff.toId).toBe(snapshot2.id);
      expect(diff.cellDiffs).toHaveLength(2); // Two cells in the notebook
      expect(diff.cellDiffs.every(cell => cell.changeType === 'unchanged')).toBe(true);
      expect(diff.summary.cellsAdded).toBe(0);
      expect(diff.summary.cellsRemoved).toBe(0);
      expect(diff.summary.cellsModified).toBe(0);
      expect(diff.summary.cellsUnchanged).toBe(2);
    });
    
    it('should compare snapshots with added cells', async () => {
      const { historyManager, notebookModel } = createHistoryManager();
      
      // Create a snapshot of the initial state
      const snapshot1 = await historyManager.createSnapshot();
      
      // Add a new cell
      notebookModel.addCell(createMockCell('cell3', 'print("New cell")', 'code'));
      
      // Create a snapshot of the updated state
      const snapshot2 = await historyManager.createSnapshot();
      
      // Compare the snapshots
      const diff = await historyManager.compareSnapshots(snapshot1.id, snapshot2.id);
      
      // Verify the diff shows the added cell
      expect(diff.cellDiffs).toHaveLength(3); // Three cells in total
      expect(diff.cellDiffs.filter(cell => cell.changeType === 'added')).toHaveLength(1);
      expect(diff.cellDiffs.filter(cell => cell.changeType === 'unchanged')).toHaveLength(2);
      expect(diff.summary.cellsAdded).toBe(1);
      expect(diff.summary.cellsUnchanged).toBe(2);
      
      // Verify the added cell has the correct content
      const addedCell = diff.cellDiffs.find(cell => cell.changeType === 'added');
      expect(addedCell?.cellId).toBe('cell3');
      expect(addedCell?.newContent).toBe('print("New cell")');
    });
    
    it('should compare snapshots with removed cells', async () => {
      const { historyManager, notebookModel } = createHistoryManager();
      
      // Create a snapshot of the initial state
      const snapshot1 = await historyManager.createSnapshot();
      
      // Remove a cell
      notebookModel.removeCell('cell2');
      
      // Create a snapshot of the updated state
      const snapshot2 = await historyManager.createSnapshot();
      
      // Compare the snapshots
      const diff = await historyManager.compareSnapshots(snapshot1.id, snapshot2.id);
      
      // Verify the diff shows the removed cell
      expect(diff.cellDiffs).toHaveLength(2); // Two cells in total (one removed, one unchanged)
      expect(diff.cellDiffs.filter(cell => cell.changeType === 'removed')).toHaveLength(1);
      expect(diff.cellDiffs.filter(cell => cell.changeType === 'unchanged')).toHaveLength(1);
      expect(diff.summary.cellsRemoved).toBe(1);
      expect(diff.summary.cellsUnchanged).toBe(1);
      
      // Verify the removed cell has the correct ID
      const removedCell = diff.cellDiffs.find(cell => cell.changeType === 'removed');
      expect(removedCell?.cellId).toBe('cell2');
      expect(removedCell?.oldContent).toBe('# Markdown cell');
    });
    
    it('should compare snapshots with modified cells', async () => {
      const { historyManager, notebookModel } = createHistoryManager();
      
      // Create a snapshot of the initial state
      const snapshot1 = await historyManager.createSnapshot();
      
      // Modify a cell
      notebookModel.updateCell('cell1', 'print("Modified cell")');
      
      // Create a snapshot of the updated state
      const snapshot2 = await historyManager.createSnapshot();
      
      // Compare the snapshots
      const diff = await historyManager.compareSnapshots(snapshot1.id, snapshot2.id);
      
      // Verify the diff shows the modified cell
      expect(diff.cellDiffs).toHaveLength(2); // Two cells in total
      expect(diff.cellDiffs.filter(cell => cell.changeType === 'modified')).toHaveLength(1);
      expect(diff.cellDiffs.filter(cell => cell.changeType === 'unchanged')).toHaveLength(1);
      expect(diff.summary.cellsModified).toBe(1);
      expect(diff.summary.cellsUnchanged).toBe(1);
      
      // Verify the modified cell has the correct content
      const modifiedCell = diff.cellDiffs.find(cell => cell.changeType === 'modified');
      expect(modifiedCell?.cellId).toBe('cell1');
      expect(modifiedCell?.oldContent).toBe('print("Hello World")');
      expect(modifiedCell?.newContent).toBe('print("Modified cell")');
      
      // Verify line diffs are included
      expect(modifiedCell?.lineDiffs).toBeDefined();
      expect(modifiedCell?.lineDiffs?.length).toBeGreaterThan(0);
    });
    
    it('should compare snapshots with metadata changes', async () => {
      const { historyManager, notebookModel } = createHistoryManager();
      
      // Create a snapshot of the initial state
      const snapshot1 = await historyManager.createSnapshot();
      
      // Add metadata
      notebookModel.setMetadata('kernelspec', { name: 'python3', display_name: 'Python 3' });
      
      // Create a snapshot of the updated state
      const snapshot2 = await historyManager.createSnapshot();
      
      // Compare the snapshots
      const diff = await historyManager.compareSnapshots(snapshot1.id, snapshot2.id);
      
      // Verify the diff shows the metadata changes
      expect(diff.metadataChanges).toBeDefined();
      expect(diff.metadataChanges?.length).toBeGreaterThan(0);
      
      // Verify the metadata change has the correct key and values
      const metadataChange = diff.metadataChanges?.find(change => change.key === 'kernelspec');
      expect(metadataChange).toBeDefined();
      expect(metadataChange?.oldValue).toBeUndefined();
      expect(metadataChange?.newValue).toEqual({ name: 'python3', display_name: 'Python 3' });
    });
    
    it('should throw an error when comparing non-existent snapshots', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Try to compare with a non-existent snapshot
      await expect(historyManager.compareSnapshots(snapshot.id, 'non-existent-id'))
        .rejects.toThrow('One or both snapshots not found');
      
      await expect(historyManager.compareSnapshots('non-existent-id', snapshot.id))
        .rejects.toThrow('One or both snapshots not found');
    });
  });
  
  describe('snapshot restoration', () => {
    it('should restore a notebook to a previous snapshot', async () => {
      const { historyManager, notebookModel } = createHistoryManager();
      
      // Create a snapshot of the initial state
      const snapshot1 = await historyManager.createSnapshot();
      
      // Modify the notebook
      notebookModel.updateCell('cell1', 'print("Modified cell")');
      notebookModel.removeCell('cell2');
      notebookModel.addCell(createMockCell('cell3', 'print("New cell")', 'code'));
      
      // Verify the notebook has changed
      const modifiedNotebook = notebookModel.toJSON();
      expect(modifiedNotebook.cells).toHaveLength(2);
      expect(modifiedNotebook.cells[0].source).toBe('print("Modified cell")');
      expect(modifiedNotebook.cells[1].id).toBe('cell3');
      
      // Restore to the first snapshot
      const result = await historyManager.restoreSnapshot(snapshot1.id);
      
      // Verify the restoration was successful
      expect(result.success).toBe(true);
      
      // Verify the notebook was restored to its original state
      const restoredNotebook = notebookModel.toJSON();
      expect(restoredNotebook.cells).toHaveLength(2);
      expect(restoredNotebook.cells[0].source).toBe('print("Hello World")');
      expect(restoredNotebook.cells[1].source).toBe('# Markdown cell');
    });
    
    it('should restore selected cells from a snapshot', async () => {
      const { historyManager, notebookModel } = createHistoryManager();
      
      // Create a snapshot of the initial state
      const snapshot1 = await historyManager.createSnapshot();
      
      // Modify the notebook
      notebookModel.updateCell('cell1', 'print("Modified cell")');
      notebookModel.updateCell('cell2', '# Modified markdown');
      
      // Restore only cell1 from the snapshot
      const result = await historyManager.restoreSnapshot(snapshot1.id, {
        mode: 'selective',
        cellIds: ['cell1']
      });
      
      // Verify the restoration was successful
      expect(result.success).toBe(true);
      expect(result.restoredCells).toContain('cell1');
      
      // Verify only cell1 was restored
      const restoredNotebook = notebookModel.toJSON();
      expect(restoredNotebook.cells[0].source).toBe('print("Hello World")');
      expect(restoredNotebook.cells[1].source).toBe('# Modified markdown');
    });
    
    it('should create a pre-restoration snapshot when requested', async () => {
      const { historyManager, notebookModel } = createHistoryManager();
      
      // Create a snapshot of the initial state
      const snapshot1 = await historyManager.createSnapshot();
      
      // Modify the notebook
      notebookModel.updateCell('cell1', 'print("Modified cell")');
      
      // Restore with createSnapshot option
      const result = await historyManager.restoreSnapshot(snapshot1.id, {
        mode: 'full',
        createSnapshot: true
      });
      
      // Verify a pre-restoration snapshot was created
      expect(result.success).toBe(true);
      expect(result.snapshotId).toBeDefined();
      
      // Verify the pre-restoration snapshot contains the modified state
      const preRestoreSnapshot = await historyManager.getSnapshot(result.snapshotId!);
      expect(preRestoreSnapshot).toBeDefined();
      expect(preRestoreSnapshot?.automatic).toBe(true);
      
      // Verify the notebook was restored
      const restoredNotebook = notebookModel.toJSON();
      expect(restoredNotebook.cells[0].source).toBe('print("Hello World")');
    });
    
    it('should fail gracefully when restoring a non-existent snapshot', async () => {
      const { historyManager } = createHistoryManager();
      
      // Try to restore a non-existent snapshot
      const result = await historyManager.restoreSnapshot('non-existent-id');
      
      // Verify the restoration failed
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Snapshot not found');
    });
    
    it('should fail gracefully with invalid restoration options', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Try to restore with invalid options
      const result = await historyManager.restoreSnapshot(snapshot.id, {
        mode: 'selective',
        cellIds: [] // Empty cell IDs array
      });
      
      // Verify the restoration failed
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid restoration mode or missing cell IDs');
    });
  });
  
  describe('snapshot content and export', () => {
    it('should get the content of a snapshot', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Get the snapshot content
      const content = await historyManager.getSnapshotContent(snapshot.id);
      
      // Verify the content is a valid notebook
      expect(content).toBeDefined();
      expect(content.cells).toHaveLength(2);
      expect(content.nbformat).toBe(4);
      expect(content.nbformat_minor).toBe(5);
    });
    
    it('should return undefined for non-existent snapshot content', async () => {
      const { historyManager } = createHistoryManager();
      
      // Try to get content for a non-existent snapshot
      const content = await historyManager.getSnapshotContent('non-existent-id');
      
      // Verify the result is undefined
      expect(content).toBeUndefined();
    });
    
    it('should export a snapshot as ipynb', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Export the snapshot as ipynb
      const exported = await historyManager.exportSnapshot(snapshot.id, 'ipynb');
      
      // Verify the export is a valid JSON string
      expect(exported).toBeDefined();
      const parsed = JSON.parse(exported);
      expect(parsed.cells).toHaveLength(2);
      expect(parsed.nbformat).toBe(4);
    });
    
    it('should export a snapshot as json with metadata', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Export the snapshot as json
      const exported = await historyManager.exportSnapshot(snapshot.id, 'json');
      
      // Verify the export is a valid JSON string with metadata
      expect(exported).toBeDefined();
      const parsed = JSON.parse(exported);
      expect(parsed.snapshot).toBeDefined();
      expect(parsed.snapshot.id).toBe(snapshot.id);
      expect(parsed.content).toBeDefined();
      expect(parsed.content.cells).toHaveLength(2);
    });
    
    it('should throw an error when exporting a non-existent snapshot', async () => {
      const { historyManager } = createHistoryManager();
      
      // Try to export a non-existent snapshot
      await expect(historyManager.exportSnapshot('non-existent-id', 'ipynb'))
        .rejects.toThrow('Snapshot not found');
    });
    
    it('should throw an error for unsupported export format', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Try to export with an unsupported format
      // @ts-ignore - Testing invalid format
      await expect(historyManager.exportSnapshot(snapshot.id, 'invalid-format'))
        .rejects.toThrow('Unsupported export format');
    });
  });
  
  describe('retention policy', () => {
    it('should set and get the retention policy', () => {
      const { historyManager } = createHistoryManager();
      
      // Set a new retention policy
      historyManager.setRetentionPolicy({
        maxSnapshots: 10,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        minInterval: 10 * 60 * 1000 // 10 minutes
      });
      
      // Get the retention policy
      const policy = historyManager.getRetentionPolicy();
      
      // Verify the policy was set correctly
      expect(policy.maxSnapshots).toBe(10);
      expect(policy.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
      expect(policy.minInterval).toBe(10 * 60 * 1000);
    });
    
    it('should apply the retention policy based on count', async () => {
      const { historyManager } = createHistoryManager();
      
      // Set a retention policy with a low max count
      historyManager.setRetentionPolicy({
        maxSnapshots: 2,
        maxAge: 0 // Disable age-based retention for this test
      });
      
      // Create automatic snapshots
      await historyManager.createSnapshot({ automatic: true });
      await historyManager.createSnapshot({ automatic: true });
      await historyManager.createSnapshot({ automatic: true });
      
      // Apply the retention policy
      const removed = await historyManager.applyRetentionPolicy();
      
      // Verify snapshots were removed
      expect(removed).toBe(1); // One snapshot should be removed
      
      // Verify only 2 snapshots remain
      const snapshots = await historyManager.getSnapshots();
      expect(snapshots).toHaveLength(2);
    });
    
    it('should not apply retention policy to manual snapshots', async () => {
      const { historyManager } = createHistoryManager();
      
      // Set a retention policy with a low max count
      historyManager.setRetentionPolicy({
        maxSnapshots: 1,
        maxAge: 0 // Disable age-based retention for this test
      });
      
      // Create automatic and manual snapshots
      await historyManager.createSnapshot({ automatic: true });
      await historyManager.createSnapshot({ automatic: false });
      await historyManager.createSnapshot({ automatic: true });
      
      // Apply the retention policy
      const removed = await historyManager.applyRetentionPolicy();
      
      // Verify automatic snapshots were removed
      expect(removed).toBe(1); // One automatic snapshot should be removed
      
      // Verify the manual snapshot remains
      const manualSnapshots = await historyManager.getSnapshots({ automatic: false });
      expect(manualSnapshots).toHaveLength(1);
    });
  });
  
  describe('multi-user collaboration', () => {
    it('should synchronize snapshots between users', async () => {
      // Create two history managers with connected Yjs docs
      const { ydoc: ydoc1, notebookModel: model1, historyManager: manager1 } = createHistoryManager();
      const { ydoc: ydoc2, historyManager: manager2 } = createHistoryManager();
      
      // Connect the Yjs documents
      connectYjsDocs(ydoc1, ydoc2);
      
      // User 1 creates a snapshot
      const snapshot = await manager1.createSnapshot({
        label: 'Snapshot from User 1'
      });
      
      // Verify User 2 can see the snapshot
      const snapshotsForUser2 = await manager2.getSnapshots();
      expect(snapshotsForUser2).toHaveLength(1);
      expect(snapshotsForUser2[0].id).toBe(snapshot.id);
      expect(snapshotsForUser2[0].label).toBe('Snapshot from User 1');
      
      // User 2 updates the snapshot
      await manager2.updateSnapshot(snapshot.id, {
        label: 'Updated by User 2'
      });
      
      // Verify User 1 sees the updated snapshot
      const updatedSnapshotForUser1 = await manager1.getSnapshot(snapshot.id);
      expect(updatedSnapshotForUser1?.label).toBe('Updated by User 2');
    });
    
    it('should synchronize snapshot deletions between users', async () => {
      // Create two history managers with connected Yjs docs
      const { ydoc: ydoc1, historyManager: manager1 } = createHistoryManager();
      const { ydoc: ydoc2, historyManager: manager2 } = createHistoryManager();
      
      // Connect the Yjs documents
      connectYjsDocs(ydoc1, ydoc2);
      
      // User 1 creates a snapshot
      const snapshot = await manager1.createSnapshot();
      
      // Verify both users can see the snapshot
      expect(await manager1.getSnapshots()).toHaveLength(1);
      expect(await manager2.getSnapshots()).toHaveLength(1);
      
      // User 2 deletes the snapshot
      await manager2.deleteSnapshot(snapshot.id);
      
      // Verify the snapshot is deleted for both users
      expect(await manager1.getSnapshots()).toHaveLength(0);
      expect(await manager2.getSnapshots()).toHaveLength(0);
    });
  });
  
  describe('event handling', () => {
    it('should emit events when snapshots are created', () => {
      const { historyManager } = createHistoryManager();
      
      // Set up event listener
      const snapshotCreatedHandler = jest.fn();
      historyManager.snapshotCreated.connect(snapshotCreatedHandler);
      
      // Create a snapshot
      historyManager.createSnapshot();
      
      // Verify the event was emitted
      expect(snapshotCreatedHandler).toHaveBeenCalled();
      expect(snapshotCreatedHandler.mock.calls[0][1]).toBeDefined();
      expect(snapshotCreatedHandler.mock.calls[0][1].id).toBeDefined();
    });
    
    it('should emit events when snapshots are updated', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Set up event listener
      const snapshotUpdatedHandler = jest.fn();
      historyManager.snapshotUpdated.connect(snapshotUpdatedHandler);
      
      // Update the snapshot
      await historyManager.updateSnapshot(snapshot.id, { label: 'Updated' });
      
      // Verify the event was emitted
      expect(snapshotUpdatedHandler).toHaveBeenCalled();
      expect(snapshotUpdatedHandler.mock.calls[0][1].id).toBe(snapshot.id);
      expect(snapshotUpdatedHandler.mock.calls[0][1].label).toBe('Updated');
    });
    
    it('should emit events when snapshots are deleted', async () => {
      const { historyManager } = createHistoryManager();
      
      // Create a snapshot
      const snapshot = await historyManager.createSnapshot();
      
      // Set up event listener
      const snapshotDeletedHandler = jest.fn();
      historyManager.snapshotDeleted.connect(snapshotDeletedHandler);
      
      // Delete the snapshot
      await historyManager.deleteSnapshot(snapshot.id);
      
      // Verify the event was emitted
      expect(snapshotDeletedHandler).toHaveBeenCalled();
      expect(snapshotDeletedHandler.mock.calls[0][1]).toBe(snapshot.id);
    });
    
    it('should emit events when status changes', () => {
      const { historyManager } = createHistoryManager();
      
      // Set up event listener
      const statusChangedHandler = jest.fn();
      historyManager.statusChanged.connect(statusChangedHandler);
      
      // Dispose the history manager (should change status)
      historyManager.dispose();
      
      // Verify the event was emitted
      // Note: This test might be flaky if the implementation doesn't change status on dispose
      // In a real implementation, this would be more robust
      expect(statusChangedHandler).toHaveBeenCalled();
    });
  });
  
  describe('cleanup', () => {
    it('should dispose resources properly', () => {
      const { historyManager } = createHistoryManager();
      
      // Create some data
      historyManager.createSnapshot();
      
      // Set up event listeners
      const snapshotCreatedHandler = jest.fn();
      const statusChangedHandler = jest.fn();
      historyManager.snapshotCreated.connect(snapshotCreatedHandler);
      historyManager.statusChanged.connect(statusChangedHandler);
      
      // Dispose the history manager
      historyManager.dispose();
      
      // Verify the signals are disconnected
      expect(historyManager.snapshotCreated.hasConnections).toBe(false);
      expect(historyManager.statusChanged.hasConnections).toBe(false);
    });
  });
});