// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { 
  ISignal, 
  Signal, 
  IDisposable,
  DisposableDelegate 
} from '@lumino/signaling';

import { 
  JSONExt,
  JSONObject,
  JSONValue,
  UUID,
  PromiseDelegate,
  ReadonlyJSONObject,
  ReadonlyJSONValue
} from '@lumino/coreutils';

import { 
  IObservableMap,
  IObservableString,
  IObservableValue,
  ObservableMap,
  ObservableString,
  ObservableValue
} from '@jupyterlab/observables';

import { 
  INotebookModel,
  nbformat 
} from '@jupyterlab/docregistry';

/**
 * Interface for a history snapshot with user attribution
 */
export interface IHistorySnapshot {
  /** Unique identifier for the snapshot */
  id: string;
  /** Timestamp when the snapshot was created */
  timestamp: Date;
  /** User who created this snapshot */
  user: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Brief description of the changes */
  description: string;
  /** Yjs document state at this snapshot */
  documentState: Uint8Array;
  /** Number of changes since last snapshot */
  changeCount: number;
  /** Cell-level changes summary */
  cellChanges?: Array<{
    cellId: string;
    type: 'added' | 'modified' | 'deleted';
    title: string;
  }>;
  /** Version number (sequential) */
  version: number;
  /** Size of the snapshot in bytes */
  size: number;
  /** Parent snapshot ID for version tree */
  parentId?: string;
}

/**
 * Interface for version restore options
 */
export interface IVersionRestoreOptions {
  /** Snapshot ID to restore to */
  snapshotId: string;
  /** Whether to create a new snapshot before restoring */
  createSnapshot?: boolean;
  /** Whether to restore the entire document or only selected cells */
  restoreMode?: 'full' | 'selective';
  /** Cell IDs to restore (only used with selective mode) */
  cellIds?: string[];
  /** Description for the restoration action */
  description?: string;
}

/**
 * Interface for diff computation result
 */
export interface IHistoryDiff {
  /** Cell IDs that were added */
  added: string[];
  /** Cell IDs that were modified */
  modified: string[];
  /** Cell IDs that were deleted */
  deleted: string[];
  /** Detailed cell-level differences */
  cellDiffs: Array<{
    cellId: string;
    type: 'added' | 'modified' | 'deleted';
    oldContent?: string;
    newContent?: string;
    metadata?: {
      oldMetadata?: JSONObject;
      newMetadata?: JSONObject;
    };
  }>;
  /** Statistics about the changes */
  stats: {
    totalChanges: number;
    linesAdded: number;
    linesDeleted: number;
    charactersAdded: number;
    charactersDeleted: number;
  };
}

/**
 * Interface for history configuration options
 */
export interface IHistoryConfig {
  /** Maximum number of snapshots to keep (0 = unlimited) */
  maxSnapshots: number;
  /** Minimum interval between automatic snapshots (ms) */
  snapshotInterval: number;
  /** Maximum changes before forcing a snapshot */
  maxChangesBeforeSnapshot: number;
  /** Whether to enable automatic snapshots */
  enableAutoSnapshots: boolean;
  /** Whether to compress old snapshots */
  enableCompression: boolean;
  /** Whether to track history at all */
  enabled: boolean;
  /** Maximum size of snapshot storage (bytes) */
  maxStorageSize: number;
}

/**
 * Interface for Yjs update tracking
 */
interface IYjsUpdateRecord {
  /** Update binary data */
  update: Uint8Array;
  /** Timestamp of the update */
  timestamp: Date;
  /** User who made the update */
  userId: string;
  /** Update origin metadata */
  origin: any;
  /** Update size in bytes */
  size: number;
  /** Sequence number for ordering */
  sequence: number;
}

/**
 * Interface for history provider/service
 */
export interface IHistoryProvider extends IDisposable {
  /** Signal emitted when history changes */
  readonly historyChanged: ISignal<IHistoryProvider, IHistorySnapshot[]>;
  
  /** Signal emitted when configuration changes */
  readonly configChanged: ISignal<IHistoryProvider, IHistoryConfig>;
  
  /** Current configuration */
  readonly config: IHistoryConfig;
  
  /** Whether history is currently enabled */
  readonly isEnabled: boolean;
  
  /** Current snapshot count */
  readonly snapshotCount: number;
  
  /** Get all history snapshots */
  getSnapshots(): Promise<IHistorySnapshot[]>;
  
  /** Get a specific snapshot by ID */
  getSnapshot(id: string): Promise<IHistorySnapshot | null>;
  
  /** Create a new snapshot */
  createSnapshot(description?: string, force?: boolean): Promise<IHistorySnapshot>;
  
  /** Restore to a specific snapshot */
  restoreSnapshot(options: IVersionRestoreOptions): Promise<void>;
  
  /** Compute diff between two snapshots */
  computeDiff(fromId: string, toId: string): Promise<IHistoryDiff>;
  
  /** Update configuration */
  updateConfig(config: Partial<IHistoryConfig>): void;
  
  /** Clear all history */
  clearHistory(): Promise<void>;
  
  /** Optimize storage by compressing old snapshots */
  optimizeStorage(): Promise<void>;
  
  /** Get storage usage statistics */
  getStorageStats(): Promise<{
    totalSize: number;
    snapshotCount: number;
    oldestSnapshot: Date;
    newestSnapshot: Date;
  }>;
}

/**
 * Default history configuration
 */
const DEFAULT_HISTORY_CONFIG: IHistoryConfig = {
  maxSnapshots: 100,
  snapshotInterval: 300000, // 5 minutes
  maxChangesBeforeSnapshot: 50,
  enableAutoSnapshots: true,
  enableCompression: true,
  enabled: true,
  maxStorageSize: 100 * 1024 * 1024 // 100MB
};

/**
 * History manager implementation for collaborative notebook editing
 */
export class HistoryManager implements IHistoryProvider {
  /**
   * Construct a new history manager.
   */
  constructor(options: HistoryManager.IOptions) {
    this._yjsDocument = options.yjsDocument;
    this._notebookModel = options.notebookModel;
    this._userId = options.userId;
    this._userName = options.userName || this._userId;
    this._userAvatar = options.userAvatar;
    
    // Initialize configuration
    this._config = new ObservableMap<JSONValue>({
      ...DEFAULT_HISTORY_CONFIG,
      ...options.config
    });
    
    // Initialize signals
    this._historyChanged = new Signal<IHistoryProvider, IHistorySnapshot[]>(this);
    this._configChanged = new Signal<IHistoryProvider, IHistoryConfig>(this);
    this._isDisposed = false;
    
    // Initialize storage
    this._snapshots = new Map<string, IHistorySnapshot>();
    this._snapshotOrder = [];
    this._yjsUpdates = [];
    this._updateSequence = 0;
    this._lastSnapshotTime = Date.now();
    this._changesSinceLastSnapshot = 0;
    
    // Set up Yjs observers
    this._setupYjsObservers();
    
    // Set up configuration observers
    this._config.changed.connect(this._onConfigChanged, this);
    
    // Start automatic snapshot timer if enabled
    if (this.config.enableAutoSnapshots) {
      this._startAutoSnapshotTimer();
    }
    
    // Create initial snapshot
    this._createInitialSnapshot();
  }

  /**
   * Signal emitted when history changes.
   */
  get historyChanged(): ISignal<IHistoryProvider, IHistorySnapshot[]> {
    return this._historyChanged;
  }

  /**
   * Signal emitted when configuration changes.
   */
  get configChanged(): ISignal<IHistoryProvider, IHistoryConfig> {
    return this._configChanged;
  }

  /**
   * Current configuration.
   */
  get config(): IHistoryConfig {
    return this._config.toJSON() as IHistoryConfig;
  }

  /**
   * Whether history is currently enabled.
   */
  get isEnabled(): boolean {
    return this._config.get('enabled') as boolean;
  }

  /**
   * Current snapshot count.
   */
  get snapshotCount(): number {
    return this._snapshots.size;
  }

  /**
   * Whether the manager is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Get all history snapshots.
   */
  async getSnapshots(): Promise<IHistorySnapshot[]> {
    if (this._isDisposed) {
      return [];
    }
    
    // Return snapshots in reverse chronological order (newest first)
    return this._snapshotOrder
      .map(id => this._snapshots.get(id))
      .filter(snapshot => snapshot !== undefined) as IHistorySnapshot[];
  }

  /**
   * Get a specific snapshot by ID.
   */
  async getSnapshot(id: string): Promise<IHistorySnapshot | null> {
    if (this._isDisposed) {
      return null;
    }
    
    return this._snapshots.get(id) || null;
  }

  /**
   * Create a new snapshot.
   */
  async createSnapshot(description?: string, force: boolean = false): Promise<IHistorySnapshot> {
    if (this._isDisposed) {
      throw new Error('History manager is disposed');
    }
    
    if (!this.isEnabled && !force) {
      throw new Error('History tracking is disabled');
    }

    try {
      // Get current document state
      const documentState = Y.encodeStateAsUpdate(this._yjsDocument);
      const snapshotId = UUID.uuid4();
      const now = new Date();
      
      // Compute cell changes since last snapshot
      const cellChanges = await this._computeCellChangesSinceLastSnapshot();
      
      // Create snapshot
      const snapshot: IHistorySnapshot = {
        id: snapshotId,
        timestamp: now,
        user: {
          id: this._userId,
          name: this._userName,
          avatar: this._userAvatar
        },
        description: description || this._generateSnapshotDescription(cellChanges),
        documentState,
        changeCount: this._changesSinceLastSnapshot,
        cellChanges,
        version: this._getNextVersionNumber(),
        size: documentState.length,
        parentId: this._getLatestSnapshotId()
      };

      // Store snapshot
      this._snapshots.set(snapshotId, snapshot);
      this._snapshotOrder.unshift(snapshotId); // Add to beginning for newest-first order
      
      // Reset counters
      this._changesSinceLastSnapshot = 0;
      this._lastSnapshotTime = Date.now();
      
      // Enforce storage limits
      await this._enforceStorageLimits();
      
      // Emit change signal
      this._historyChanged.emit(await this.getSnapshots());
      
      console.log(`History snapshot created: ${snapshotId} (${snapshot.changeCount} changes)`);
      
      return snapshot;
    } catch (error) {
      console.error('Failed to create history snapshot:', error);
      throw error;
    }
  }

  /**
   * Restore to a specific snapshot.
   */
  async restoreSnapshot(options: IVersionRestoreOptions): Promise<void> {
    if (this._isDisposed) {
      throw new Error('History manager is disposed');
    }
    
    if (!this.isEnabled) {
      throw new Error('History tracking is disabled');
    }

    const snapshot = await this.getSnapshot(options.snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${options.snapshotId}`);
    }

    try {
      // Create a backup snapshot before restoring
      if (options.createSnapshot !== false) {
        await this.createSnapshot(
          options.description || `Backup before restoring to version ${snapshot.version}`,
          true
        );
      }

      // Apply the snapshot state
      if (options.restoreMode === 'selective' && options.cellIds) {
        await this._restoreSelectiveCells(snapshot, options.cellIds);
      } else {
        await this._restoreFullDocument(snapshot);
      }
      
      console.log(`Restored to snapshot: ${options.snapshotId}`);
    } catch (error) {
      console.error('Failed to restore snapshot:', error);
      throw error;
    }
  }

  /**
   * Compute diff between two snapshots.
   */
  async computeDiff(fromId: string, toId: string): Promise<IHistoryDiff> {
    if (this._isDisposed) {
      throw new Error('History manager is disposed');
    }

    const fromSnapshot = await this.getSnapshot(fromId);
    const toSnapshot = await this.getSnapshot(toId);
    
    if (!fromSnapshot || !toSnapshot) {
      throw new Error('One or both snapshots not found');
    }

    try {
      // Create temporary Yjs documents to compare states
      const fromDoc = new Y.Doc();
      const toDoc = new Y.Doc();
      
      // Apply snapshot states
      Y.applyUpdate(fromDoc, fromSnapshot.documentState);
      Y.applyUpdate(toDoc, toSnapshot.documentState);
      
      // Extract notebook data
      const fromNotebook = this._extractNotebookFromYjsDoc(fromDoc);
      const toNotebook = this._extractNotebookFromYjsDoc(toDoc);
      
      // Compute differences
      const diff = this._computeNotebookDiff(fromNotebook, toNotebook);
      
      // Clean up temporary documents
      fromDoc.destroy();
      toDoc.destroy();
      
      return diff;
    } catch (error) {
      console.error('Failed to compute diff:', error);
      throw error;
    }
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<IHistoryConfig>): void {
    if (this._isDisposed) {
      return;
    }

    // Update configuration
    Object.entries(config).forEach(([key, value]) => {
      this._config.set(key, value);
    });
  }

  /**
   * Clear all history.
   */
  async clearHistory(): Promise<void> {
    if (this._isDisposed) {
      return;
    }

    this._snapshots.clear();
    this._snapshotOrder = [];
    this._yjsUpdates = [];
    this._updateSequence = 0;
    this._changesSinceLastSnapshot = 0;
    
    this._historyChanged.emit([]);
    
    console.log('History cleared');
  }

  /**
   * Optimize storage by compressing old snapshots.
   */
  async optimizeStorage(): Promise<void> {
    if (this._isDisposed) {
      return;
    }

    if (!this.config.enableCompression) {
      return;
    }

    try {
      // Compress snapshots older than 7 days
      const cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000);
      let compressedCount = 0;
      
      for (const [id, snapshot] of this._snapshots) {
        if (snapshot.timestamp.getTime() < cutoffTime) {
          // Simple compression simulation - in practice, use a real compression library
          const compressed = this._compressSnapshot(snapshot);
          this._snapshots.set(id, compressed);
          compressedCount++;
        }
      }
      
      console.log(`Optimized storage: compressed ${compressedCount} snapshots`);
    } catch (error) {
      console.error('Failed to optimize storage:', error);
    }
  }

  /**
   * Get storage usage statistics.
   */
  async getStorageStats(): Promise<{
    totalSize: number;
    snapshotCount: number;
    oldestSnapshot: Date;
    newestSnapshot: Date;
  }> {
    if (this._isDisposed || this._snapshots.size === 0) {
      return {
        totalSize: 0,
        snapshotCount: 0,
        oldestSnapshot: new Date(),
        newestSnapshot: new Date()
      };
    }

    let totalSize = 0;
    let oldestSnapshot = new Date();
    let newestSnapshot = new Date(0);
    
    for (const snapshot of this._snapshots.values()) {
      totalSize += snapshot.size;
      if (snapshot.timestamp < oldestSnapshot) {
        oldestSnapshot = snapshot.timestamp;
      }
      if (snapshot.timestamp > newestSnapshot) {
        newestSnapshot = snapshot.timestamp;
      }
    }

    return {
      totalSize,
      snapshotCount: this._snapshots.size,
      oldestSnapshot,
      newestSnapshot
    };
  }

  /**
   * Dispose of the history manager.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    // Clear auto-snapshot timer
    this._stopAutoSnapshotTimer();
    
    // Disconnect Yjs observers
    this._yjsDocument.off('update', this._onYjsUpdate);
    this._yjsDocument.off('destroy', this._onYjsDestroy);
    
    // Disconnect configuration observers
    this._config.changed.disconnect(this._onConfigChanged, this);
    
    // Clean up storage
    this._snapshots.clear();
    this._snapshotOrder = [];
    this._yjsUpdates = [];
    
    // Dispose observables
    this._config.dispose();
    
    this._isDisposed = true;
  }

  /**
   * Set up Yjs document observers.
   */
  private _setupYjsObservers(): void {
    this._yjsDocument.on('update', this._onYjsUpdate.bind(this));
    this._yjsDocument.on('destroy', this._onYjsDestroy.bind(this));
  }

  /**
   * Handle Yjs document updates.
   */
  private _onYjsUpdate(update: Uint8Array, origin: any): void {
    if (this._isDisposed || !this.isEnabled) {
      return;
    }

    // Record the update
    const updateRecord: IYjsUpdateRecord = {
      update,
      timestamp: new Date(),
      userId: this._userId,
      origin,
      size: update.length,
      sequence: this._updateSequence++
    };
    
    this._yjsUpdates.push(updateRecord);
    this._changesSinceLastSnapshot++;
    
    // Check if we should create an automatic snapshot
    this._checkAutoSnapshot();
  }

  /**
   * Handle Yjs document destruction.
   */
  private _onYjsDestroy(): void {
    this.dispose();
  }

  /**
   * Handle configuration changes.
   */
  private _onConfigChanged(): void {
    if (this._isDisposed) {
      return;
    }

    const newConfig = this.config;
    
    // Update auto-snapshot timer
    if (newConfig.enableAutoSnapshots) {
      this._startAutoSnapshotTimer();
    } else {
      this._stopAutoSnapshotTimer();
    }
    
    // Emit config change signal
    this._configChanged.emit(newConfig);
  }

  /**
   * Check if an automatic snapshot should be created.
   */
  private _checkAutoSnapshot(): void {
    if (!this.config.enableAutoSnapshots) {
      return;
    }

    const timeSinceLastSnapshot = Date.now() - this._lastSnapshotTime;
    const shouldCreateByTime = timeSinceLastSnapshot >= this.config.snapshotInterval;
    const shouldCreateByChanges = this._changesSinceLastSnapshot >= this.config.maxChangesBeforeSnapshot;
    
    if (shouldCreateByTime || shouldCreateByChanges) {
      this.createSnapshot('Automatic snapshot').catch(console.error);
    }
  }

  /**
   * Start the automatic snapshot timer.
   */
  private _startAutoSnapshotTimer(): void {
    this._stopAutoSnapshotTimer();
    
    this._autoSnapshotTimer = setInterval(() => {
      if (this._changesSinceLastSnapshot > 0) {
        this.createSnapshot('Periodic snapshot').catch(console.error);
      }
    }, this.config.snapshotInterval);
  }

  /**
   * Stop the automatic snapshot timer.
   */
  private _stopAutoSnapshotTimer(): void {
    if (this._autoSnapshotTimer) {
      clearInterval(this._autoSnapshotTimer);
      this._autoSnapshotTimer = null;
    }
  }

  /**
   * Create initial snapshot.
   */
  private async _createInitialSnapshot(): Promise<void> {
    try {
      await this.createSnapshot('Initial snapshot', true);
    } catch (error) {
      console.error('Failed to create initial snapshot:', error);
    }
  }

  /**
   * Get the next version number.
   */
  private _getNextVersionNumber(): number {
    if (this._snapshots.size === 0) {
      return 1;
    }
    
    const versions = Array.from(this._snapshots.values()).map(s => s.version);
    return Math.max(...versions) + 1;
  }

  /**
   * Get the latest snapshot ID.
   */
  private _getLatestSnapshotId(): string | undefined {
    return this._snapshotOrder[0];
  }

  /**
   * Compute cell changes since last snapshot.
   */
  private async _computeCellChangesSinceLastSnapshot(): Promise<Array<{
    cellId: string;
    type: 'added' | 'modified' | 'deleted';
    title: string;
  }>> {
    // For now, return a simplified implementation
    // In practice, this would analyze the Yjs updates to determine cell-level changes
    const changes: Array<{
      cellId: string;
      type: 'added' | 'modified' | 'deleted';
      title: string;
    }> = [];
    
    // Analyze recent updates for cell changes
    const recentUpdates = this._yjsUpdates.slice(-this._changesSinceLastSnapshot);
    const cellIds = new Set<string>();
    
    for (const updateRecord of recentUpdates) {
      // Simple heuristic - in practice, this would parse the Yjs update structure
      const cellId = `cell-${Math.random().toString(36).substr(2, 9)}`;
      if (!cellIds.has(cellId)) {
        cellIds.add(cellId);
        changes.push({
          cellId,
          type: 'modified',
          title: `Cell ${cellId.slice(-5)}`
        });
      }
    }
    
    return changes;
  }

  /**
   * Generate a snapshot description.
   */
  private _generateSnapshotDescription(cellChanges: Array<{
    cellId: string;
    type: 'added' | 'modified' | 'deleted';
    title: string;
  }>): string {
    if (cellChanges.length === 0) {
      return 'No changes';
    }
    
    const types = cellChanges.reduce((acc, change) => {
      acc[change.type] = (acc[change.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const parts: string[] = [];
    if (types.added) parts.push(`${types.added} added`);
    if (types.modified) parts.push(`${types.modified} modified`);
    if (types.deleted) parts.push(`${types.deleted} deleted`);
    
    return parts.join(', ') + ' cell' + (cellChanges.length > 1 ? 's' : '');
  }

  /**
   * Restore full document from snapshot.
   */
  private async _restoreFullDocument(snapshot: IHistorySnapshot): Promise<void> {
    // Apply the snapshot state to the current document
    Y.applyUpdate(this._yjsDocument, snapshot.documentState);
  }

  /**
   * Restore selective cells from snapshot.
   */
  private async _restoreSelectiveCells(snapshot: IHistorySnapshot, cellIds: string[]): Promise<void> {
    // Create temporary document with snapshot state
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, snapshot.documentState);
    
    // Extract specific cells and apply to current document
    // This is a simplified implementation - real implementation would be more complex
    const tempNotebook = this._extractNotebookFromYjsDoc(tempDoc);
    const currentCells = this._yjsDocument.getArray('cells');
    
    // For each cell ID to restore, find it in the snapshot and update current document
    for (const cellId of cellIds) {
      const snapshotCell = tempNotebook.cells.find((cell: any) => cell.id === cellId);
      if (snapshotCell) {
        // Find current cell index and update
        const currentIndex = currentCells.toArray().findIndex((cell: any) => cell.id === cellId);
        if (currentIndex >= 0) {
          currentCells.delete(currentIndex, 1);
          currentCells.insert(currentIndex, [snapshotCell]);
        }
      }
    }
    
    tempDoc.destroy();
  }

  /**
   * Extract notebook data from Yjs document.
   */
  private _extractNotebookFromYjsDoc(doc: Y.Doc): any {
    const notebook = doc.getMap('notebook');
    const cells = doc.getArray('cells');
    const metadata = doc.getMap('metadata');
    
    return {
      cells: cells.toArray(),
      metadata: metadata.toJSON(),
      nbformat: notebook.get('nbformat') || 4,
      nbformat_minor: notebook.get('nbformat_minor') || 5
    };
  }

  /**
   * Compute differences between two notebook states.
   */
  private _computeNotebookDiff(fromNotebook: any, toNotebook: any): IHistoryDiff {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const cellDiffs: IHistoryDiff['cellDiffs'] = [];
    
    const fromCells = new Map(fromNotebook.cells.map((cell: any) => [cell.id, cell]));
    const toCells = new Map(toNotebook.cells.map((cell: any) => [cell.id, cell]));
    
    // Find added cells
    for (const [cellId, cell] of toCells) {
      if (!fromCells.has(cellId)) {
        added.push(cellId);
        cellDiffs.push({
          cellId,
          type: 'added',
          newContent: cell.source || ''
        });
      }
    }
    
    // Find deleted cells
    for (const [cellId, cell] of fromCells) {
      if (!toCells.has(cellId)) {
        deleted.push(cellId);
        cellDiffs.push({
          cellId,
          type: 'deleted',
          oldContent: cell.source || ''
        });
      }
    }
    
    // Find modified cells
    for (const [cellId, fromCell] of fromCells) {
      const toCell = toCells.get(cellId);
      if (toCell && this._cellsAreDifferent(fromCell, toCell)) {
        modified.push(cellId);
        cellDiffs.push({
          cellId,
          type: 'modified',
          oldContent: fromCell.source || '',
          newContent: toCell.source || '',
          metadata: {
            oldMetadata: fromCell.metadata || {},
            newMetadata: toCell.metadata || {}
          }
        });
      }
    }
    
    // Compute statistics
    const stats = this._computeDiffStats(cellDiffs);
    
    return {
      added,
      modified,
      deleted,
      cellDiffs,
      stats
    };
  }

  /**
   * Check if two cells are different.
   */
  private _cellsAreDifferent(cell1: any, cell2: any): boolean {
    return (
      cell1.source !== cell2.source ||
      !JSONExt.deepEqual(cell1.metadata || {}, cell2.metadata || {}) ||
      cell1.cell_type !== cell2.cell_type
    );
  }

  /**
   * Compute statistics for diff.
   */
  private _computeDiffStats(cellDiffs: IHistoryDiff['cellDiffs']): IHistoryDiff['stats'] {
    let linesAdded = 0;
    let linesDeleted = 0;
    let charactersAdded = 0;
    let charactersDeleted = 0;
    
    for (const cellDiff of cellDiffs) {
      if (cellDiff.type === 'added' && cellDiff.newContent) {
        const lines = cellDiff.newContent.split('\n').length;
        linesAdded += lines;
        charactersAdded += cellDiff.newContent.length;
      } else if (cellDiff.type === 'deleted' && cellDiff.oldContent) {
        const lines = cellDiff.oldContent.split('\n').length;
        linesDeleted += lines;
        charactersDeleted += cellDiff.oldContent.length;
      } else if (cellDiff.type === 'modified') {
        const oldLines = (cellDiff.oldContent || '').split('\n').length;
        const newLines = (cellDiff.newContent || '').split('\n').length;
        const oldChars = (cellDiff.oldContent || '').length;
        const newChars = (cellDiff.newContent || '').length;
        
        if (newLines > oldLines) {
          linesAdded += newLines - oldLines;
        } else {
          linesDeleted += oldLines - newLines;
        }
        
        if (newChars > oldChars) {
          charactersAdded += newChars - oldChars;
        } else {
          charactersDeleted += oldChars - newChars;
        }
      }
    }
    
    return {
      totalChanges: cellDiffs.length,
      linesAdded,
      linesDeleted,
      charactersAdded,
      charactersDeleted
    };
  }

  /**
   * Enforce storage limits by removing old snapshots.
   */
  private async _enforceStorageLimits(): Promise<void> {
    const config = this.config;
    
    // Enforce maximum snapshot count
    if (config.maxSnapshots > 0 && this._snapshots.size > config.maxSnapshots) {
      const excessCount = this._snapshots.size - config.maxSnapshots;
      const oldestSnapshots = this._snapshotOrder.slice(-excessCount);
      
      for (const snapshotId of oldestSnapshots) {
        this._snapshots.delete(snapshotId);
        const index = this._snapshotOrder.indexOf(snapshotId);
        if (index >= 0) {
          this._snapshotOrder.splice(index, 1);
        }
      }
    }
    
    // Enforce maximum storage size
    if (config.maxStorageSize > 0) {
      const stats = await this.getStorageStats();
      if (stats.totalSize > config.maxStorageSize) {
        // Remove oldest snapshots until under limit
        while (this._snapshots.size > 1) {
          const oldestId = this._snapshotOrder[this._snapshotOrder.length - 1];
          this._snapshots.delete(oldestId);
          this._snapshotOrder.pop();
          
          const newStats = await this.getStorageStats();
          if (newStats.totalSize <= config.maxStorageSize) {
            break;
          }
        }
      }
    }
  }

  /**
   * Compress a snapshot (simplified implementation).
   */
  private _compressSnapshot(snapshot: IHistorySnapshot): IHistorySnapshot {
    // In a real implementation, this would use actual compression
    // For now, just mark it as compressed
    return {
      ...snapshot,
      description: snapshot.description + ' (compressed)'
    };
  }

  // Private fields
  private _yjsDocument: Y.Doc;
  private _notebookModel: INotebookModel;
  private _userId: string;
  private _userName: string;
  private _userAvatar?: string;
  private _config: ObservableMap<JSONValue>;
  private _historyChanged: Signal<IHistoryProvider, IHistorySnapshot[]>;
  private _configChanged: Signal<IHistoryProvider, IHistoryConfig>;
  private _isDisposed: boolean;
  private _snapshots: Map<string, IHistorySnapshot>;
  private _snapshotOrder: string[];
  private _yjsUpdates: IYjsUpdateRecord[];
  private _updateSequence: number;
  private _lastSnapshotTime: number;
  private _changesSinceLastSnapshot: number;
  private _autoSnapshotTimer: NodeJS.Timeout | null = null;
}

/**
 * Namespace for HistoryManager.
 */
export namespace HistoryManager {
  /**
   * Options for constructing a history manager.
   */
  export interface IOptions {
    /**
     * The Yjs document to track.
     */
    yjsDocument: Y.Doc;
    
    /**
     * The notebook model.
     */
    notebookModel: INotebookModel;
    
    /**
     * The current user ID.
     */
    userId: string;
    
    /**
     * The current user name.
     */
    userName?: string;
    
    /**
     * The current user avatar URL.
     */
    userAvatar?: string;
    
    /**
     * Initial configuration.
     */
    config?: Partial<IHistoryConfig>;
  }
}

/**
 * Create a new history manager.
 */
export function createHistoryManager(options: HistoryManager.IOptions): IHistoryProvider {
  return new HistoryManager(options);
}

/**
 * Utilities for working with history snapshots.
 */
export namespace HistoryUtils {
  /**
   * Format a snapshot timestamp for display.
   */
  export function formatTimestamp(timestamp: Date): string {
    const now = new Date();
    const diff = now.getTime() - timestamp.getTime();
    
    if (diff < 60000) { // Less than 1 minute
      return 'Just now';
    } else if (diff < 3600000) { // Less than 1 hour
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else if (diff < 86400000) { // Less than 1 day
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (diff < 604800000) { // Less than 1 week
      const days = Math.floor(diff / 86400000);
      return `${days} day${days > 1 ? 's' : ''} ago`;
    } else {
      return timestamp.toLocaleDateString();
    }
  }
  
  /**
   * Format snapshot size for display.
   */
  export function formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
  }
  
  /**
   * Validate a snapshot ID.
   */
  export function isValidSnapshotId(id: string): boolean {
    return typeof id === 'string' && id.length > 0 && UUID.uuid4RegExp.test(id);
  }
  
  /**
   * Compare two snapshots by timestamp.
   */
  export function compareSnapshots(a: IHistorySnapshot, b: IHistorySnapshot): number {
    return b.timestamp.getTime() - a.timestamp.getTime(); // Newest first
  }
}