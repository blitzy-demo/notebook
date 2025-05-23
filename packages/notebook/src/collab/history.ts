/**
 * History management for collaborative notebooks
 *
 * This module implements document revision history tracking with diff capabilities 
 * and restoration points for collaborative notebooks. It provides the IHistoryManager 
 * interface for creating snapshots, comparing versions, and restoring content from 
 * previous states.
 */

import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import * as Y from 'yjs';

/**
 * Interface for a history snapshot of a document
 */
export interface IDocumentSnapshot {
  /**
   * Unique identifier for the snapshot
   */
  id: string;

  /**
   * Timestamp when the snapshot was created
   */
  timestamp: number;

  /**
   * User who created the snapshot
   */
  author: {
    id: string;
    name: string;
    email?: string;
  };

  /**
   * Optional description or comment for the snapshot
   */
  description?: string;

  /**
   * The state vector at the time of the snapshot
   */
  stateVector: Uint8Array;

  /**
   * The document state at the time of the snapshot
   */
  state: Uint8Array;

  /**
   * Tags associated with this snapshot (e.g., 'checkpoint', 'auto-save')
   */
  tags?: string[];

  /**
   * Whether this snapshot is a major version
   */
  isMajorVersion: boolean;

  /**
   * Version number (auto-incremented)
   */
  version: number;
}

/**
 * Interface for a diff between two document snapshots
 */
export interface IDocumentDiff {
  /**
   * The source snapshot ID
   */
  fromId: string;

  /**
   * The target snapshot ID
   */
  toId: string;

  /**
   * Changes grouped by cell
   */
  cellChanges: {
    [cellId: string]: {
      /**
       * Type of change for the cell
       */
      type: 'added' | 'removed' | 'modified' | 'unchanged';

      /**
       * Content changes if the cell was modified
       */
      contentChanges?: {
        /**
         * Type of content change
         */
        type: 'added' | 'removed' | 'modified';

        /**
         * Line number where the change starts
         */
        lineStart: number;

        /**
         * Line number where the change ends
         */
        lineEnd: number;

        /**
         * Original content
         */
        oldContent?: string;

        /**
         * New content
         */
        newContent?: string;

        /**
         * User who made the change
         */
        author?: {
          id: string;
          name: string;
        };
      }[];

      /**
       * Metadata changes if the cell metadata was modified
       */
      metadataChanges?: {
        /**
         * Path to the changed metadata property
         */
        path: string;

        /**
         * Old value
         */
        oldValue?: any;

        /**
         * New value
         */
        newValue?: any;
      }[];
    };
  };

  /**
   * Changes to notebook metadata
   */
  metadataChanges?: {
    /**
     * Path to the changed metadata property
     */
    path: string;

    /**
     * Old value
     */
    oldValue?: any;

    /**
     * New value
     */
    newValue?: any;
  }[];

  /**
   * Summary of changes
   */
  summary: {
    /**
     * Number of cells added
     */
    cellsAdded: number;

    /**
     * Number of cells removed
     */
    cellsRemoved: number;

    /**
     * Number of cells modified
     */
    cellsModified: number;

    /**
     * Total number of content changes
     */
    totalContentChanges: number;

    /**
     * Total number of metadata changes
     */
    totalMetadataChanges: number;
  };
}

/**
 * Options for creating a snapshot
 */
export interface ISnapshotOptions {
  /**
   * Optional description for the snapshot
   */
  description?: string;

  /**
   * Whether this is a major version
   */
  isMajorVersion?: boolean;

  /**
   * Tags to associate with the snapshot
   */
  tags?: string[];

  /**
   * Author information (defaults to current user)
   */
  author?: {
    id: string;
    name: string;
    email?: string;
  };
}

/**
 * Options for retrieving history
 */
export interface IHistoryOptions {
  /**
   * Maximum number of snapshots to retrieve
   */
  limit?: number;

  /**
   * Skip this many snapshots
   */
  skip?: number;

  /**
   * Filter by author ID
   */
  authorId?: string;

  /**
   * Filter by tags
   */
  tags?: string[];

  /**
   * Only include major versions
   */
  majorVersionsOnly?: boolean;

  /**
   * Start timestamp (inclusive)
   */
  startTime?: number;

  /**
   * End timestamp (inclusive)
   */
  endTime?: number;
}

/**
 * Options for restoring content
 */
export interface IRestoreOptions {
  /**
   * Whether to create a new snapshot after restoring
   */
  createSnapshot?: boolean;

  /**
   * Description for the new snapshot if created
   */
  snapshotDescription?: string;

  /**
   * Cell IDs to restore (if not provided, restores the entire document)
   */
  cellIds?: string[];

  /**
   * Whether to restore cell metadata
   */
  restoreCellMetadata?: boolean;

  /**
   * Whether to restore notebook metadata
   */
  restoreNotebookMetadata?: boolean;
}

/**
 * Options for configuring the history manager
 */
export interface IHistoryManagerOptions {
  /**
   * Maximum number of snapshots to keep
   */
  maxSnapshots?: number;

  /**
   * Interval in milliseconds for automatic snapshots
   * Set to 0 to disable automatic snapshots
   */
  autoSnapshotInterval?: number;

  /**
   * Maximum age of snapshots in milliseconds
   * Snapshots older than this will be pruned
   */
  maxSnapshotAge?: number;

  /**
   * Whether to create a snapshot on document load
   */
  snapshotOnLoad?: boolean;

  /**
   * Whether to create a snapshot before document close
   */
  snapshotOnClose?: boolean;

  /**
   * Whether to create a snapshot when a user joins
   */
  snapshotOnUserJoin?: boolean;

  /**
   * Storage provider for persisting history
   */
  storageProvider?: IHistoryStorageProvider;
}

/**
 * Interface for history storage providers
 */
export interface IHistoryStorageProvider {
  /**
   * Store a snapshot
   */
  storeSnapshot(snapshot: IDocumentSnapshot): Promise<void>;

  /**
   * Retrieve a snapshot by ID
   */
  getSnapshot(id: string): Promise<IDocumentSnapshot | null>;

  /**
   * Retrieve multiple snapshots based on options
   */
  getSnapshots(options: IHistoryOptions): Promise<IDocumentSnapshot[]>;

  /**
   * Delete a snapshot
   */
  deleteSnapshot(id: string): Promise<void>;

  /**
   * Delete multiple snapshots based on criteria
   */
  pruneSnapshots(options: {
    maxAge?: number;
    maxCount?: number;
    exceptIds?: string[];
  }): Promise<number>;
}

/**
 * Interface for history manager
 */
export interface IHistoryManager {
  /**
   * Signal emitted when a new snapshot is created
   */
  readonly snapshotCreated: ISignal<IHistoryManager, IDocumentSnapshot>;

  /**
   * Signal emitted when content is restored from a snapshot
   */
  readonly contentRestored: ISignal<
    IHistoryManager,
    { snapshot: IDocumentSnapshot; options: IRestoreOptions }
  >;

  /**
   * Create a snapshot of the current document state
   */
  createSnapshot(options?: ISnapshotOptions): Promise<IDocumentSnapshot>;

  /**
   * Get the list of available snapshots
   */
  getHistory(options?: IHistoryOptions): Promise<IDocumentSnapshot[]>;

  /**
   * Get a specific snapshot by ID
   */
  getSnapshot(id: string): Promise<IDocumentSnapshot | null>;

  /**
   * Compare two snapshots and generate a diff
   */
  getDiff(fromId: string, toId: string): Promise<IDocumentDiff>;

  /**
   * Restore content from a snapshot
   */
  restoreSnapshot(id: string, options?: IRestoreOptions): Promise<void>;

  /**
   * Restore specific cells from a snapshot
   */
  restoreCells(id: string, cellIds: string[], options?: IRestoreOptions): Promise<void>;

  /**
   * Update history manager configuration
   */
  updateConfig(options: Partial<IHistoryManagerOptions>): void;

  /**
   * Prune old snapshots based on retention policy
   */
  pruneHistory(): Promise<number>;

  /**
   * Delete a specific snapshot
   */
  deleteSnapshot(id: string): Promise<void>;

  /**
   * Get the current configuration
   */
  getConfig(): IHistoryManagerOptions;

  /**
   * Dispose of the history manager and clean up resources
   */
  dispose(): void;
}

/**
 * Token for the history manager
 */
export const IHistoryManager = new Token<IHistoryManager>(
  '@jupyter-notebook/notebook:IHistoryManager'
);

/**
 * Implementation of the history manager
 */
export class HistoryManager implements IHistoryManager {
  /**
   * Constructor
   *
   * @param doc - The Yjs document to track
   * @param options - Configuration options
   */
  constructor(private doc: Y.Doc, options?: IHistoryManagerOptions) {
    this._config = {
      maxSnapshots: options?.maxSnapshots ?? 100,
      autoSnapshotInterval: options?.autoSnapshotInterval ?? 300000, // 5 minutes
      maxSnapshotAge: options?.maxSnapshotAge ?? 30 * 24 * 60 * 60 * 1000, // 30 days
      snapshotOnLoad: options?.snapshotOnLoad ?? true,
      snapshotOnClose: options?.snapshotOnClose ?? true,
      snapshotOnUserJoin: options?.snapshotOnUserJoin ?? false,
      storageProvider: options?.storageProvider
    };

    // Set up auto-snapshot timer if enabled
    if (this._config.autoSnapshotInterval && this._config.autoSnapshotInterval > 0) {
      this._autoSnapshotTimer = setInterval(() => {
        this.createSnapshot({
          description: 'Auto-snapshot',
          tags: ['auto'],
          isMajorVersion: false
        }).catch(error => {
          console.error('Failed to create auto-snapshot:', error);
        });
      }, this._config.autoSnapshotInterval);
    }

    // Create initial snapshot if configured
    if (this._config.snapshotOnLoad) {
      this.createSnapshot({
        description: 'Initial state',
        tags: ['initial'],
        isMajorVersion: true
      }).catch(error => {
        console.error('Failed to create initial snapshot:', error);
      });
    }

    // Set up document update handler to track changes
    this.doc.on('update', (update: Uint8Array, origin: any) => {
      // Track the update for potential future snapshots
      this._pendingChanges = true;
      
      // Store the origin (typically contains user info) for attribution
      if (origin && typeof origin === 'object' && origin.user) {
        this._lastChangeAuthor = origin.user;
      }
    });
  }

  /**
   * Signal emitted when a new snapshot is created
   */
  readonly snapshotCreated = new Signal<IHistoryManager, IDocumentSnapshot>(this);

  /**
   * Signal emitted when content is restored from a snapshot
   */
  readonly contentRestored = new Signal<
    IHistoryManager,
    { snapshot: IDocumentSnapshot; options: IRestoreOptions }
  >(this);

  /**
   * Create a snapshot of the current document state
   *
   * @param options - Options for the snapshot
   * @returns Promise resolving to the created snapshot
   */
  async createSnapshot(options: ISnapshotOptions = {}): Promise<IDocumentSnapshot> {
    // Generate a unique ID for the snapshot
    const id = this._generateSnapshotId();
    
    // Get the current state vector and document state
    const stateVector = Y.encodeStateVector(this.doc);
    const state = Y.encodeStateAsUpdate(this.doc);
    
    // Create the snapshot object
    const snapshot: IDocumentSnapshot = {
      id,
      timestamp: Date.now(),
      author: options.author || this._lastChangeAuthor || {
        id: 'unknown',
        name: 'Unknown User'
      },
      description: options.description,
      stateVector,
      state,
      tags: options.tags || [],
      isMajorVersion: options.isMajorVersion ?? false,
      version: this._nextVersion++
    };
    
    // Store the snapshot if a storage provider is configured
    if (this._config.storageProvider) {
      await this._config.storageProvider.storeSnapshot(snapshot);
    }
    
    // Add to in-memory cache
    this._snapshotCache.set(id, snapshot);
    
    // Reset pending changes flag
    this._pendingChanges = false;
    
    // Emit the snapshotCreated signal
    this.snapshotCreated.emit(snapshot);
    
    // Prune old snapshots based on retention policy
    this.pruneHistory().catch(error => {
      console.error('Failed to prune history after creating snapshot:', error);
    });
    
    return snapshot;
  }

  /**
   * Get the list of available snapshots
   *
   * @param options - Options for filtering and pagination
   * @returns Promise resolving to an array of snapshots
   */
  async getHistory(options: IHistoryOptions = {}): Promise<IDocumentSnapshot[]> {
    // If we have a storage provider, use it to get snapshots
    if (this._config.storageProvider) {
      return this._config.storageProvider.getSnapshots(options);
    }
    
    // Otherwise, filter the in-memory cache
    let snapshots = Array.from(this._snapshotCache.values());
    
    // Apply filters
    if (options.authorId) {
      snapshots = snapshots.filter(s => s.author.id === options.authorId);
    }
    
    if (options.tags && options.tags.length > 0) {
      snapshots = snapshots.filter(s => 
        s.tags && options.tags!.some(tag => s.tags!.includes(tag))
      );
    }
    
    if (options.majorVersionsOnly) {
      snapshots = snapshots.filter(s => s.isMajorVersion);
    }
    
    if (options.startTime) {
      snapshots = snapshots.filter(s => s.timestamp >= options.startTime!);
    }
    
    if (options.endTime) {
      snapshots = snapshots.filter(s => s.timestamp <= options.endTime!);
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

  /**
   * Get a specific snapshot by ID
   *
   * @param id - The snapshot ID
   * @returns Promise resolving to the snapshot or null if not found
   */
  async getSnapshot(id: string): Promise<IDocumentSnapshot | null> {
    // Check in-memory cache first
    if (this._snapshotCache.has(id)) {
      return this._snapshotCache.get(id)!;
    }
    
    // If not in cache and we have a storage provider, try to get it from storage
    if (this._config.storageProvider) {
      const snapshot = await this._config.storageProvider.getSnapshot(id);
      
      // Add to cache if found
      if (snapshot) {
        this._snapshotCache.set(id, snapshot);
      }
      
      return snapshot;
    }
    
    return null;
  }

  /**
   * Compare two snapshots and generate a diff
   *
   * @param fromId - The source snapshot ID
   * @param toId - The target snapshot ID
   * @returns Promise resolving to a diff object
   */
  async getDiff(fromId: string, toId: string): Promise<IDocumentDiff> {
    // Get the snapshots
    const fromSnapshot = await this.getSnapshot(fromId);
    const toSnapshot = await this.getSnapshot(toId);
    
    if (!fromSnapshot || !toSnapshot) {
      throw new Error(`Snapshot not found: ${!fromSnapshot ? fromId : toId}`);
    }
    
    // Create temporary Y.Doc instances to apply the snapshots
    const fromDoc = new Y.Doc();
    const toDoc = new Y.Doc();
    
    // Apply the states to the temporary docs
    Y.applyUpdate(fromDoc, fromSnapshot.state);
    Y.applyUpdate(toDoc, toSnapshot.state);
    
    // Initialize the diff object
    const diff: IDocumentDiff = {
      fromId,
      toId,
      cellChanges: {},
      metadataChanges: [],
      summary: {
        cellsAdded: 0,
        cellsRemoved: 0,
        cellsModified: 0,
        totalContentChanges: 0,
        totalMetadataChanges: 0
      }
    };
    
    // Compare cells
    // Note: This is a simplified implementation. In a real implementation,
    // you would need to access the actual notebook structure from the Y.Doc
    // and perform a more detailed comparison.
    
    // For demonstration purposes, we'll assume the Y.Doc has a 'cells' array
    // and a 'metadata' map
    const fromCells = fromDoc.getArray('cells');
    const toCells = toDoc.getArray('cells');
    
    // Get all cell IDs from both documents
    const fromCellIds = new Set<string>();
    const toCellIds = new Set<string>();
    
    fromCells.forEach((cell: any) => {
      if (cell && cell.get && cell.get('id')) {
        fromCellIds.add(cell.get('id'));
      }
    });
    
    toCells.forEach((cell: any) => {
      if (cell && cell.get && cell.get('id')) {
        toCellIds.add(cell.get('id'));
      }
    });
    
    // Find added, removed, and potentially modified cells
    const addedCellIds = new Set<string>();
    const removedCellIds = new Set<string>();
    const potentiallyModifiedCellIds = new Set<string>();
    
    for (const id of toCellIds) {
      if (!fromCellIds.has(id)) {
        addedCellIds.add(id);
      } else {
        potentiallyModifiedCellIds.add(id);
      }
    }
    
    for (const id of fromCellIds) {
      if (!toCellIds.has(id)) {
        removedCellIds.add(id);
      }
    }
    
    // Process added cells
    for (const id of addedCellIds) {
      diff.cellChanges[id] = {
        type: 'added'
      };
      diff.summary.cellsAdded++;
    }
    
    // Process removed cells
    for (const id of removedCellIds) {
      diff.cellChanges[id] = {
        type: 'removed'
      };
      diff.summary.cellsRemoved++;
    }
    
    // Process potentially modified cells
    for (const id of potentiallyModifiedCellIds) {
      // Find the cells in both documents
      const fromCell = this._findCellById(fromCells, id);
      const toCell = this._findCellById(toCells, id);
      
      if (!fromCell || !toCell) {
        continue;
      }
      
      // Compare cell content
      const fromContent = fromCell.get('source') || '';
      const toContent = toCell.get('source') || '';
      
      // Compare cell metadata
      const fromMetadata = fromCell.get('metadata') || {};
      const toMetadata = toCell.get('metadata') || {};
      
      const contentChanges: IDocumentDiff['cellChanges'][string]['contentChanges'] = [];
      const metadataChanges: IDocumentDiff['cellChanges'][string]['metadataChanges'] = [];
      
      // Detect content changes (simplified diff)
      if (fromContent !== toContent) {
        // In a real implementation, you would use a proper diff algorithm
        // to identify specific line changes. This is a simplified version.
        contentChanges.push({
          type: 'modified',
          lineStart: 0,
          lineEnd: Math.max(
            fromContent.split('\n').length,
            toContent.split('\n').length
          ),
          oldContent: fromContent,
          newContent: toContent,
          author: toSnapshot.author
        });
        
        diff.summary.totalContentChanges++;
      }
      
      // Detect metadata changes
      const metadataChangesResult = this._diffObjects(fromMetadata, toMetadata);
      for (const change of metadataChangesResult) {
        metadataChanges.push({
          path: change.path,
          oldValue: change.oldValue,
          newValue: change.newValue
        });
        
        diff.summary.totalMetadataChanges++;
      }
      
      // If there are any changes, mark the cell as modified
      if (contentChanges.length > 0 || metadataChanges.length > 0) {
        diff.cellChanges[id] = {
          type: 'modified',
          contentChanges: contentChanges.length > 0 ? contentChanges : undefined,
          metadataChanges: metadataChanges.length > 0 ? metadataChanges : undefined
        };
        
        diff.summary.cellsModified++;
      } else {
        diff.cellChanges[id] = {
          type: 'unchanged'
        };
      }
    }
    
    // Compare notebook metadata
    const fromMetadata = fromDoc.getMap('metadata')?.toJSON() || {};
    const toMetadata = toDoc.getMap('metadata')?.toJSON() || {};
    
    const notebookMetadataChanges = this._diffObjects(fromMetadata, toMetadata);
    if (notebookMetadataChanges.length > 0) {
      diff.metadataChanges = notebookMetadataChanges.map(change => ({
        path: change.path,
        oldValue: change.oldValue,
        newValue: change.newValue
      }));
      
      diff.summary.totalMetadataChanges += notebookMetadataChanges.length;
    }
    
    // Clean up temporary docs
    fromDoc.destroy();
    toDoc.destroy();
    
    return diff;
  }

  /**
   * Restore content from a snapshot
   *
   * @param id - The snapshot ID to restore from
   * @param options - Options for the restoration
   * @returns Promise that resolves when the restoration is complete
   */
  async restoreSnapshot(id: string, options: IRestoreOptions = {}): Promise<void> {
    const snapshot = await this.getSnapshot(id);
    
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${id}`);
    }
    
    // Create a transaction to apply the changes
    this.doc.transact(() => {
      // Apply the snapshot state to the current document
      Y.applyUpdate(this.doc, snapshot.state);
    }, 'history-restore');
    
    // Create a new snapshot if requested
    if (options.createSnapshot) {
      await this.createSnapshot({
        description: options.snapshotDescription || `Restored from snapshot ${snapshot.version}`,
        tags: ['restored'],
        isMajorVersion: true
      });
    }
    
    // Emit the contentRestored signal
    this.contentRestored.emit({ snapshot, options });
  }

  /**
   * Restore specific cells from a snapshot
   *
   * @param id - The snapshot ID to restore from
   * @param cellIds - Array of cell IDs to restore
   * @param options - Options for the restoration
   * @returns Promise that resolves when the restoration is complete
   */
  async restoreCells(id: string, cellIds: string[], options: IRestoreOptions = {}): Promise<void> {
    const snapshot = await this.getSnapshot(id);
    
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${id}`);
    }
    
    // Create a temporary doc to extract the cells from the snapshot
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, snapshot.state);
    
    // Get the cells array from both docs
    const tempCells = tempDoc.getArray('cells');
    const currentCells = this.doc.getArray('cells');
    
    // Create a transaction to apply the changes
    this.doc.transact(() => {
      // For each cell ID to restore
      for (const cellId of cellIds) {
        // Find the cell in the snapshot
        const snapshotCell = this._findCellById(tempCells, cellId);
        
        if (!snapshotCell) {
          console.warn(`Cell ${cellId} not found in snapshot ${id}`);
          continue;
        }
        
        // Find the cell in the current document
        const currentCellIndex = this._findCellIndexById(currentCells, cellId);
        
        if (currentCellIndex >= 0) {
          // Cell exists, update it
          const currentCell = currentCells.get(currentCellIndex);
          
          // Update cell content
          if (snapshotCell.has('source')) {
            currentCell.set('source', snapshotCell.get('source'));
          }
          
          // Update cell metadata if requested
          if (options.restoreCellMetadata && snapshotCell.has('metadata')) {
            currentCell.set('metadata', snapshotCell.get('metadata'));
          }
        } else {
          // Cell doesn't exist, create it
          // Clone the cell from the snapshot
          const newCell = new Y.Map();
          
          // Copy all properties from the snapshot cell
          for (const [key, value] of snapshotCell.entries()) {
            if (key === 'metadata' && !options.restoreCellMetadata) {
              continue;
            }
            newCell.set(key, value);
          }
          
          // Add the cell to the current document
          // In a real implementation, you would need to determine the correct position
          currentCells.push([newCell]);
        }
      }
      
      // Restore notebook metadata if requested
      if (options.restoreNotebookMetadata) {
        const snapshotMetadata = tempDoc.getMap('metadata');
        const currentMetadata = this.doc.getMap('metadata');
        
        // Clear current metadata
        for (const key of currentMetadata.keys()) {
          currentMetadata.delete(key);
        }
        
        // Copy metadata from snapshot
        for (const [key, value] of snapshotMetadata.entries()) {
          currentMetadata.set(key, value);
        }
      }
    }, 'history-restore-cells');
    
    // Clean up temporary doc
    tempDoc.destroy();
    
    // Create a new snapshot if requested
    if (options.createSnapshot) {
      await this.createSnapshot({
        description: options.snapshotDescription || `Restored cells from snapshot ${snapshot.version}`,
        tags: ['restored-cells'],
        isMajorVersion: false
      });
    }
    
    // Emit the contentRestored signal
    this.contentRestored.emit({ snapshot, options });
  }

  /**
   * Update history manager configuration
   *
   * @param options - New configuration options
   */
  updateConfig(options: Partial<IHistoryManagerOptions>): void {
    // Update configuration
    this._config = { ...this._config, ...options };
    
    // Update auto-snapshot timer if interval changed
    if (options.autoSnapshotInterval !== undefined) {
      if (this._autoSnapshotTimer) {
        clearInterval(this._autoSnapshotTimer);
        this._autoSnapshotTimer = null;
      }
      
      if (options.autoSnapshotInterval > 0) {
        this._autoSnapshotTimer = setInterval(() => {
          this.createSnapshot({
            description: 'Auto-snapshot',
            tags: ['auto'],
            isMajorVersion: false
          }).catch(error => {
            console.error('Failed to create auto-snapshot:', error);
          });
        }, options.autoSnapshotInterval);
      }
    }
  }

  /**
   * Prune old snapshots based on retention policy
   *
   * @returns Promise resolving to the number of snapshots pruned
   */
  async pruneHistory(): Promise<number> {
    // If we have a storage provider, use it to prune snapshots
    if (this._config.storageProvider) {
      const pruned = await this._config.storageProvider.pruneSnapshots({
        maxAge: this._config.maxSnapshotAge,
        maxCount: this._config.maxSnapshots
      });
      
      // Update in-memory cache
      const snapshots = await this._config.storageProvider.getSnapshots({});
      this._snapshotCache.clear();
      for (const snapshot of snapshots) {
        this._snapshotCache.set(snapshot.id, snapshot);
      }
      
      return pruned;
    }
    
    // Otherwise, prune the in-memory cache
    const now = Date.now();
    const maxAge = this._config.maxSnapshotAge;
    const maxCount = this._config.maxSnapshots;
    
    // Get all snapshots sorted by timestamp (oldest first)
    const snapshots = Array.from(this._snapshotCache.values())
      .sort((a, b) => a.timestamp - b.timestamp);
    
    const snapshotsToDelete: string[] = [];
    
    // Mark old snapshots for deletion
    if (maxAge) {
      for (const snapshot of snapshots) {
        if (now - snapshot.timestamp > maxAge) {
          snapshotsToDelete.push(snapshot.id);
        }
      }
    }
    
    // If we have more snapshots than the maximum, mark the oldest for deletion
    if (maxCount && snapshots.length - snapshotsToDelete.length > maxCount) {
      const excessCount = snapshots.length - snapshotsToDelete.length - maxCount;
      for (let i = 0; i < excessCount; i++) {
        // Skip snapshots already marked for deletion
        if (!snapshotsToDelete.includes(snapshots[i].id)) {
          snapshotsToDelete.push(snapshots[i].id);
        }
      }
    }
    
    // Delete the marked snapshots
    for (const id of snapshotsToDelete) {
      this._snapshotCache.delete(id);
    }
    
    return snapshotsToDelete.length;
  }

  /**
   * Delete a specific snapshot
   *
   * @param id - The snapshot ID to delete
   * @returns Promise that resolves when the deletion is complete
   */
  async deleteSnapshot(id: string): Promise<void> {
    // Delete from storage provider if available
    if (this._config.storageProvider) {
      await this._config.storageProvider.deleteSnapshot(id);
    }
    
    // Delete from in-memory cache
    this._snapshotCache.delete(id);
  }

  /**
   * Get the current configuration
   *
   * @returns The current configuration
   */
  getConfig(): IHistoryManagerOptions {
    return { ...this._config };
  }

  /**
   * Dispose of the history manager and clean up resources
   */
  dispose(): void {
    // Clear auto-snapshot timer
    if (this._autoSnapshotTimer) {
      clearInterval(this._autoSnapshotTimer);
      this._autoSnapshotTimer = null;
    }
    
    // Create final snapshot if configured
    if (this._config.snapshotOnClose && this._pendingChanges) {
      this.createSnapshot({
        description: 'Final state',
        tags: ['final'],
        isMajorVersion: true
      }).catch(error => {
        console.error('Failed to create final snapshot:', error);
      });
    }
    
    // Clear in-memory cache
    this._snapshotCache.clear();
  }

  /**
   * Generate a unique ID for a snapshot
   *
   * @returns A unique ID string
   */
  private _generateSnapshotId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Find a cell by ID in a Y.Array of cells
   *
   * @param cells - The Y.Array of cells to search
   * @param id - The cell ID to find
   * @returns The cell if found, or undefined
   */
  private _findCellById(cells: Y.Array<any>, id: string): Y.Map<any> | undefined {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells.get(i);
      if (cell && cell.get && cell.get('id') === id) {
        return cell;
      }
    }
    return undefined;
  }

  /**
   * Find the index of a cell by ID in a Y.Array of cells
   *
   * @param cells - The Y.Array of cells to search
   * @param id - The cell ID to find
   * @returns The index of the cell if found, or -1
   */
  private _findCellIndexById(cells: Y.Array<any>, id: string): number {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells.get(i);
      if (cell && cell.get && cell.get('id') === id) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Compare two objects and return the differences
   *
   * @param obj1 - The first object
   * @param obj2 - The second object
   * @param path - The current path (used for recursion)
   * @returns Array of changes
   */
  private _diffObjects(
    obj1: Record<string, any>,
    obj2: Record<string, any>,
    path: string = ''
  ): Array<{ path: string; oldValue: any; newValue: any }> {
    const changes: Array<{ path: string; oldValue: any; newValue: any }> = [];
    
    // Check for properties in obj1 that are different or missing in obj2
    for (const key in obj1) {
      const currentPath = path ? `${path}.${key}` : key;
      
      if (!(key in obj2)) {
        // Property removed
        changes.push({
          path: currentPath,
          oldValue: obj1[key],
          newValue: undefined
        });
      } else if (typeof obj1[key] === 'object' && obj1[key] !== null &&
                 typeof obj2[key] === 'object' && obj2[key] !== null) {
        // Recursively compare objects
        changes.push(...this._diffObjects(obj1[key], obj2[key], currentPath));
      } else if (obj1[key] !== obj2[key]) {
        // Value changed
        changes.push({
          path: currentPath,
          oldValue: obj1[key],
          newValue: obj2[key]
        });
      }
    }
    
    // Check for properties in obj2 that are not in obj1
    for (const key in obj2) {
      const currentPath = path ? `${path}.${key}` : key;
      
      if (!(key in obj1)) {
        // Property added
        changes.push({
          path: currentPath,
          oldValue: undefined,
          newValue: obj2[key]
        });
      }
    }
    
    return changes;
  }

  // Configuration
  private _config: IHistoryManagerOptions;
  
  // In-memory snapshot cache
  private _snapshotCache = new Map<string, IDocumentSnapshot>();
  
  // Auto-snapshot timer
  private _autoSnapshotTimer: NodeJS.Timeout | null = null;
  
  // Flag to track if there are pending changes since the last snapshot
  private _pendingChanges = false;
  
  // Track the author of the last change
  private _lastChangeAuthor: IDocumentSnapshot['author'] | null = null;
  
  // Counter for version numbers
  private _nextVersion = 1;
}