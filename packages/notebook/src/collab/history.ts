/**
 * Document revision history tracking with diff capabilities and restoration points for collaborative notebooks.
 * This module provides the IHistoryManager interface for creating snapshots, comparing versions,
 * and restoring content from previous states.
 */

import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import * as Y from 'yjs';
import { INotebookModel } from '../model';
import { ICellModel } from '@jupyterlab/cells';

/**
 * Interface for a history snapshot
 */
export interface IHistorySnapshot {
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
    /**
     * User ID
     */
    id: string;

    /**
     * User display name
     */
    name: string;

    /**
     * User avatar URL (optional)
     */
    avatarUrl?: string;
  };

  /**
   * Optional label for the snapshot
   */
  label?: string;

  /**
   * Optional description of the changes in this snapshot
   */
  description?: string;

  /**
   * Whether this is an automatic snapshot or user-initiated
   */
  automatic: boolean;

  /**
   * Size of the snapshot in bytes
   */
  size: number;

  /**
   * Tags associated with this snapshot
   */
  tags?: string[];

  /**
   * Additional metadata for the snapshot
   */
  metadata?: { [key: string]: any };
}

/**
 * Interface for a cell change in a diff
 */
export interface ICellDiff {
  /**
   * The cell ID
   */
  cellId: string;

  /**
   * The type of change
   */
  changeType: 'added' | 'removed' | 'modified' | 'unchanged';

  /**
   * The old cell content (if modified or removed)
   */
  oldContent?: string;

  /**
   * The new cell content (if modified or added)
   */
  newContent?: string;

  /**
   * Line-by-line diff information for modified cells
   */
  lineDiffs?: {
    /**
     * Line number in the old content
     */
    oldLineNumber: number;

    /**
     * Line number in the new content
     */
    newLineNumber: number;

    /**
     * The type of line change
     */
    type: 'added' | 'removed' | 'modified' | 'unchanged';

    /**
     * The line content
     */
    content: string;
  }[];

  /**
   * Metadata changes
   */
  metadataChanges?: {
    /**
     * The key that changed
     */
    key: string;

    /**
     * The old value
     */
    oldValue: any;

    /**
     * The new value
     */
    newValue: any;
  }[];
}

/**
 * Interface for a notebook diff between two snapshots
 */
export interface INotebookDiff {
  /**
   * The ID of the first snapshot
   */
  fromId: string;

  /**
   * The ID of the second snapshot
   */
  toId: string;

  /**
   * The timestamp of the first snapshot
   */
  fromTimestamp: number;

  /**
   * The timestamp of the second snapshot
   */
  toTimestamp: number;

  /**
   * Array of cell diffs
   */
  cellDiffs: ICellDiff[];

  /**
   * Metadata changes at the notebook level
   */
  metadataChanges?: {
    /**
     * The key that changed
     */
    key: string;

    /**
     * The old value
     */
    oldValue: any;

    /**
     * The new value
     */
    newValue: any;
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
     * Number of cells unchanged
     */
    cellsUnchanged: number;
  };
}

/**
 * Interface for history restoration options
 */
export interface IRestoreOptions {
  /**
   * Whether to restore the entire notebook or just selected cells
   */
  mode: 'full' | 'selective';

  /**
   * IDs of cells to restore (only used when mode is 'selective')
   */
  cellIds?: string[];

  /**
   * Whether to create a new snapshot before restoring
   */
  createSnapshot?: boolean;

  /**
   * Whether to apply the restoration as a new edit (true) or replace the current state (false)
   */
  asNewEdit?: boolean;
}

/**
 * Result of a history restoration operation
 */
export interface IRestoreResult {
  /**
   * Whether the restoration was successful
   */
  success: boolean;

  /**
   * Error message if the restoration failed
   */
  error?: string;

  /**
   * IDs of cells that were restored
   */
  restoredCells?: string[];

  /**
   * ID of the snapshot that was created before restoration (if createSnapshot was true)
   */
  snapshotId?: string;
}

/**
 * Filter options for retrieving history snapshots
 */
export interface IHistoryFilter {
  /**
   * Filter by author ID
   */
  authorId?: string;

  /**
   * Filter by tag
   */
  tag?: string;

  /**
   * Filter by time range (start timestamp)
   */
  startTime?: number;

  /**
   * Filter by time range (end timestamp)
   */
  endTime?: number;

  /**
   * Filter by automatic vs. manual snapshots
   */
  automatic?: boolean;

  /**
   * Filter by text in label or description
   */
  searchText?: string;

  /**
   * Maximum number of snapshots to return
   */
  limit?: number;

  /**
   * Sort order ('asc' or 'desc' by timestamp)
   */
  order?: 'asc' | 'desc';
}

/**
 * Status of the history manager
 */
export enum HistoryManagerStatus {
  /**
   * History manager is initializing
   */
  Initializing = 'initializing',

  /**
   * History manager is ready and operational
   */
  Ready = 'ready',

  /**
   * History manager is in a degraded state (some functionality may be limited)
   */
  Degraded = 'degraded',

  /**
   * History manager is disconnected from the collaboration server
   */
  Disconnected = 'disconnected'
}

/**
 * Interface for the history manager
 */
export interface IHistoryManager extends IDisposable {
  /**
   * The current status of the history manager
   */
  readonly status: HistoryManagerStatus;

  /**
   * Signal emitted when the history manager status changes
   */
  readonly statusChanged: ISignal<IHistoryManager, HistoryManagerStatus>;

  /**
   * Signal emitted when a new snapshot is created
   */
  readonly snapshotCreated: ISignal<IHistoryManager, IHistorySnapshot>;

  /**
   * Signal emitted when a snapshot is deleted
   */
  readonly snapshotDeleted: ISignal<IHistoryManager, string>;

  /**
   * Signal emitted when a snapshot is updated
   */
  readonly snapshotUpdated: ISignal<IHistoryManager, IHistorySnapshot>;

  /**
   * Create a new snapshot of the current notebook state
   * 
   * @param options - Options for creating the snapshot
   * @returns A promise that resolves to the created snapshot
   */
  createSnapshot(options?: {
    label?: string;
    description?: string;
    automatic?: boolean;
    tags?: string[];
    metadata?: { [key: string]: any };
  }): Promise<IHistorySnapshot>;

  /**
   * Get a snapshot by ID
   * 
   * @param id - The ID of the snapshot to retrieve
   * @returns The snapshot, or undefined if not found
   */
  getSnapshot(id: string): Promise<IHistorySnapshot | undefined>;

  /**
   * Get all snapshots, optionally filtered
   * 
   * @param filter - Filter options
   * @returns An array of snapshots matching the filter
   */
  getSnapshots(filter?: IHistoryFilter): Promise<IHistorySnapshot[]>;

  /**
   * Update a snapshot's metadata
   * 
   * @param id - The ID of the snapshot to update
   * @param updates - The fields to update
   * @returns The updated snapshot, or undefined if not found
   */
  updateSnapshot(id: string, updates: {
    label?: string;
    description?: string;
    tags?: string[];
    metadata?: { [key: string]: any };
  }): Promise<IHistorySnapshot | undefined>;

  /**
   * Delete a snapshot
   * 
   * @param id - The ID of the snapshot to delete
   * @returns A promise that resolves to true if the snapshot was deleted, false otherwise
   */
  deleteSnapshot(id: string): Promise<boolean>;

  /**
   * Compare two snapshots and generate a diff
   * 
   * @param fromId - The ID of the first snapshot
   * @param toId - The ID of the second snapshot
   * @returns A promise that resolves to the diff between the snapshots
   */
  compareSnapshots(fromId: string, toId: string): Promise<INotebookDiff>;

  /**
   * Restore the notebook to a previous snapshot
   * 
   * @param id - The ID of the snapshot to restore
   * @param options - Options for the restoration
   * @returns A promise that resolves to the result of the restoration
   */
  restoreSnapshot(id: string, options?: IRestoreOptions): Promise<IRestoreResult>;

  /**
   * Get the content of a snapshot as a notebook JSON object
   * 
   * @param id - The ID of the snapshot
   * @returns A promise that resolves to the notebook JSON, or undefined if not found
   */
  getSnapshotContent(id: string): Promise<any | undefined>;

  /**
   * Export a snapshot to a file
   * 
   * @param id - The ID of the snapshot to export
   * @param format - The export format ('ipynb' or 'json')
   * @returns A promise that resolves to the exported content as a string
   */
  exportSnapshot(id: string, format: 'ipynb' | 'json'): Promise<string>;

  /**
   * Set the retention policy for automatic snapshots
   * 
   * @param options - Retention policy options
   */
  setRetentionPolicy(options: {
    /**
     * Maximum number of automatic snapshots to keep
     */
    maxSnapshots?: number;

    /**
     * Maximum age of automatic snapshots in milliseconds
     */
    maxAge?: number;

    /**
     * Minimum interval between automatic snapshots in milliseconds
     */
    minInterval?: number;
  }): void;

  /**
   * Get the current retention policy
   * 
   * @returns The current retention policy
   */
  getRetentionPolicy(): {
    maxSnapshots: number;
    maxAge: number;
    minInterval: number;
  };

  /**
   * Apply the retention policy, removing snapshots that exceed the limits
   * 
   * @returns A promise that resolves to the number of snapshots removed
   */
  applyRetentionPolicy(): Promise<number>;
}

/**
 * Configuration options for the history manager
 */
export interface IHistoryManagerOptions {
  /**
   * The notebook model to track history for
   */
  notebookModel: INotebookModel;

  /**
   * The Yjs document
   */
  ydoc: Y.Doc;

  /**
   * The current user's ID
   */
  userId: string;

  /**
   * The current user's display name
   */
  userName: string;

  /**
   * The current user's avatar URL (optional)
   */
  userAvatarUrl?: string;

  /**
   * Initial retention policy options
   */
  retentionPolicy?: {
    /**
     * Maximum number of automatic snapshots to keep (default: 100)
     */
    maxSnapshots?: number;

    /**
     * Maximum age of automatic snapshots in milliseconds (default: 30 days)
     */
    maxAge?: number;

    /**
     * Minimum interval between automatic snapshots in milliseconds (default: 5 minutes)
     */
    minInterval?: number;
  };

  /**
   * Whether to create an initial snapshot on initialization (default: true)
   */
  createInitialSnapshot?: boolean;

  /**
   * Whether to enable automatic snapshots (default: true)
   */
  enableAutoSnapshots?: boolean;

  /**
   * Interval for automatic snapshots in milliseconds (default: 5 minutes)
   */
  autoSnapshotInterval?: number;
}

/**
 * Implementation of the IHistoryManager interface
 */
export class HistoryManager implements IHistoryManager {
  /**
   * Constructor
   * 
   * @param options - Configuration options for the history manager
   */
  constructor(options: IHistoryManagerOptions) {
    this._notebookModel = options.notebookModel;
    this._ydoc = options.ydoc;
    this._userId = options.userId;
    this._userName = options.userName;
    this._userAvatarUrl = options.userAvatarUrl;
    
    // Initialize signals
    this._statusChanged = new Signal<IHistoryManager, HistoryManagerStatus>(this);
    this._snapshotCreated = new Signal<IHistoryManager, IHistorySnapshot>(this);
    this._snapshotDeleted = new Signal<IHistoryManager, string>(this);
    this._snapshotUpdated = new Signal<IHistoryManager, IHistorySnapshot>(this);
    
    // Set initial status
    this._status = HistoryManagerStatus.Initializing;
    
    // Initialize Yjs shared data structures
    this._ySnapshots = this._ydoc.getMap<Y.Map<any>>('history-snapshots');
    
    // Set up retention policy
    this._retentionPolicy = {
      maxSnapshots: options.retentionPolicy?.maxSnapshots ?? 100,
      maxAge: options.retentionPolicy?.maxAge ?? 30 * 24 * 60 * 60 * 1000, // 30 days
      minInterval: options.retentionPolicy?.minInterval ?? 5 * 60 * 1000 // 5 minutes
    };
    
    // Set up auto-snapshot settings
    this._enableAutoSnapshots = options.enableAutoSnapshots ?? true;
    this._autoSnapshotInterval = options.autoSnapshotInterval ?? 5 * 60 * 1000; // 5 minutes
    
    // Initialize the history manager
    this._initialize(options.createInitialSnapshot ?? true);
  }
  
  /**
   * The current status of the history manager
   */
  get status(): HistoryManagerStatus {
    return this._status;
  }
  
  /**
   * Signal emitted when the history manager status changes
   */
  get statusChanged(): ISignal<IHistoryManager, HistoryManagerStatus> {
    return this._statusChanged;
  }
  
  /**
   * Signal emitted when a new snapshot is created
   */
  get snapshotCreated(): ISignal<IHistoryManager, IHistorySnapshot> {
    return this._snapshotCreated;
  }
  
  /**
   * Signal emitted when a snapshot is deleted
   */
  get snapshotDeleted(): ISignal<IHistoryManager, string> {
    return this._snapshotDeleted;
  }
  
  /**
   * Signal emitted when a snapshot is updated
   */
  get snapshotUpdated(): ISignal<IHistoryManager, IHistorySnapshot> {
    return this._snapshotUpdated;
  }
  
  /**
   * Create a new snapshot of the current notebook state
   * 
   * @param options - Options for creating the snapshot
   * @returns A promise that resolves to the created snapshot
   */
  async createSnapshot(options: {
    label?: string;
    description?: string;
    automatic?: boolean;
    tags?: string[];
    metadata?: { [key: string]: any };
  } = {}): Promise<IHistorySnapshot> {
    // Check if we can create a snapshot based on the retention policy
    if (options.automatic && !this._canCreateAutomaticSnapshot()) {
      throw new Error('Cannot create automatic snapshot: too soon after previous snapshot');
    }
    
    // Generate a unique ID for the snapshot
    const id = UUID.uuid4();
    
    // Get the current timestamp
    const timestamp = Date.now();
    
    // Get the current notebook state
    const notebookState = this._captureNotebookState();
    
    // Calculate the size of the snapshot
    const size = new TextEncoder().encode(JSON.stringify(notebookState)).length;
    
    // Create the snapshot object
    const snapshot: IHistorySnapshot = {
      id,
      timestamp,
      author: {
        id: this._userId,
        name: this._userName,
        avatarUrl: this._userAvatarUrl
      },
      label: options.label,
      description: options.description,
      automatic: options.automatic ?? false,
      size,
      tags: options.tags,
      metadata: options.metadata
    };
    
    // Store the snapshot in the Yjs shared map
    const ySnapshot = new Y.Map<any>();
    ySnapshot.set('id', snapshot.id);
    ySnapshot.set('timestamp', snapshot.timestamp);
    ySnapshot.set('author', snapshot.author);
    ySnapshot.set('label', snapshot.label);
    ySnapshot.set('description', snapshot.description);
    ySnapshot.set('automatic', snapshot.automatic);
    ySnapshot.set('size', snapshot.size);
    ySnapshot.set('tags', snapshot.tags);
    ySnapshot.set('metadata', snapshot.metadata);
    ySnapshot.set('state', notebookState);
    
    // Add the snapshot to the shared map
    this._ydoc.transact(() => {
      this._ySnapshots.set(id, ySnapshot);
    });
    
    // Apply retention policy if this is an automatic snapshot
    if (snapshot.automatic) {
      await this.applyRetentionPolicy();
    }
    
    // Emit the snapshotCreated signal
    this._snapshotCreated.emit(snapshot);
    
    return snapshot;
  }
  
  /**
   * Get a snapshot by ID
   * 
   * @param id - The ID of the snapshot to retrieve
   * @returns The snapshot, or undefined if not found
   */
  async getSnapshot(id: string): Promise<IHistorySnapshot | undefined> {
    const ySnapshot = this._ySnapshots.get(id);
    if (!ySnapshot) {
      return undefined;
    }
    
    return this._ySnapshotToSnapshot(ySnapshot);
  }
  
  /**
   * Get all snapshots, optionally filtered
   * 
   * @param filter - Filter options
   * @returns An array of snapshots matching the filter
   */
  async getSnapshots(filter: IHistoryFilter = {}): Promise<IHistorySnapshot[]> {
    // Get all snapshots
    const snapshots: IHistorySnapshot[] = [];
    this._ySnapshots.forEach((ySnapshot) => {
      snapshots.push(this._ySnapshotToSnapshot(ySnapshot));
    });
    
    // Apply filters
    let filteredSnapshots = snapshots;
    
    // Filter by author ID
    if (filter.authorId) {
      filteredSnapshots = filteredSnapshots.filter(snapshot => 
        snapshot.author.id === filter.authorId
      );
    }
    
    // Filter by tag
    if (filter.tag) {
      filteredSnapshots = filteredSnapshots.filter(snapshot => 
        snapshot.tags?.includes(filter.tag!)
      );
    }
    
    // Filter by time range
    if (filter.startTime) {
      filteredSnapshots = filteredSnapshots.filter(snapshot => 
        snapshot.timestamp >= filter.startTime!
      );
    }
    
    if (filter.endTime) {
      filteredSnapshots = filteredSnapshots.filter(snapshot => 
        snapshot.timestamp <= filter.endTime!
      );
    }
    
    // Filter by automatic vs. manual
    if (filter.automatic !== undefined) {
      filteredSnapshots = filteredSnapshots.filter(snapshot => 
        snapshot.automatic === filter.automatic
      );
    }
    
    // Filter by search text
    if (filter.searchText) {
      const searchText = filter.searchText.toLowerCase();
      filteredSnapshots = filteredSnapshots.filter(snapshot => {
        const label = snapshot.label?.toLowerCase() || '';
        const description = snapshot.description?.toLowerCase() || '';
        return label.includes(searchText) || description.includes(searchText);
      });
    }
    
    // Sort by timestamp
    filteredSnapshots.sort((a, b) => {
      if (filter.order === 'asc') {
        return a.timestamp - b.timestamp;
      } else {
        return b.timestamp - a.timestamp;
      }
    });
    
    // Apply limit
    if (filter.limit && filter.limit > 0) {
      filteredSnapshots = filteredSnapshots.slice(0, filter.limit);
    }
    
    return filteredSnapshots;
  }
  
  /**
   * Update a snapshot's metadata
   * 
   * @param id - The ID of the snapshot to update
   * @param updates - The fields to update
   * @returns The updated snapshot, or undefined if not found
   */
  async updateSnapshot(id: string, updates: {
    label?: string;
    description?: string;
    tags?: string[];
    metadata?: { [key: string]: any };
  }): Promise<IHistorySnapshot | undefined> {
    const ySnapshot = this._ySnapshots.get(id);
    if (!ySnapshot) {
      return undefined;
    }
    
    // Update the snapshot
    this._ydoc.transact(() => {
      if (updates.label !== undefined) {
        ySnapshot.set('label', updates.label);
      }
      
      if (updates.description !== undefined) {
        ySnapshot.set('description', updates.description);
      }
      
      if (updates.tags !== undefined) {
        ySnapshot.set('tags', updates.tags);
      }
      
      if (updates.metadata !== undefined) {
        ySnapshot.set('metadata', updates.metadata);
      }
    });
    
    // Get the updated snapshot
    const snapshot = this._ySnapshotToSnapshot(ySnapshot);
    
    // Emit the snapshotUpdated signal
    this._snapshotUpdated.emit(snapshot);
    
    return snapshot;
  }
  
  /**
   * Delete a snapshot
   * 
   * @param id - The ID of the snapshot to delete
   * @returns A promise that resolves to true if the snapshot was deleted, false otherwise
   */
  async deleteSnapshot(id: string): Promise<boolean> {
    const ySnapshot = this._ySnapshots.get(id);
    if (!ySnapshot) {
      return false;
    }
    
    // Delete the snapshot
    this._ydoc.transact(() => {
      this._ySnapshots.delete(id);
    });
    
    // Emit the snapshotDeleted signal
    this._snapshotDeleted.emit(id);
    
    return true;
  }
  
  /**
   * Compare two snapshots and generate a diff
   * 
   * @param fromId - The ID of the first snapshot
   * @param toId - The ID of the second snapshot
   * @returns A promise that resolves to the diff between the snapshots
   */
  async compareSnapshots(fromId: string, toId: string): Promise<INotebookDiff> {
    // Get the snapshots
    const fromSnapshot = await this.getSnapshot(fromId);
    const toSnapshot = await this.getSnapshot(toId);
    
    if (!fromSnapshot || !toSnapshot) {
      throw new Error('One or both snapshots not found');
    }
    
    // Get the notebook states
    const fromState = this._getSnapshotState(fromId);
    const toState = this._getSnapshotState(toId);
    
    if (!fromState || !toState) {
      throw new Error('One or both snapshot states not found');
    }
    
    // Compare the cells
    const cellDiffs = this._compareCells(fromState.cells, toState.cells);
    
    // Compare the metadata
    const metadataChanges = this._compareMetadata(fromState.metadata, toState.metadata);
    
    // Calculate summary
    const summary = {
      cellsAdded: cellDiffs.filter(diff => diff.changeType === 'added').length,
      cellsRemoved: cellDiffs.filter(diff => diff.changeType === 'removed').length,
      cellsModified: cellDiffs.filter(diff => diff.changeType === 'modified').length,
      cellsUnchanged: cellDiffs.filter(diff => diff.changeType === 'unchanged').length
    };
    
    // Create the diff object
    const diff: INotebookDiff = {
      fromId,
      toId,
      fromTimestamp: fromSnapshot.timestamp,
      toTimestamp: toSnapshot.timestamp,
      cellDiffs,
      metadataChanges,
      summary
    };
    
    return diff;
  }
  
  /**
   * Restore the notebook to a previous snapshot
   * 
   * @param id - The ID of the snapshot to restore
   * @param options - Options for the restoration
   * @returns A promise that resolves to the result of the restoration
   */
  async restoreSnapshot(id: string, options: IRestoreOptions = { mode: 'full' }): Promise<IRestoreResult> {
    // Get the snapshot
    const snapshot = await this.getSnapshot(id);
    if (!snapshot) {
      return {
        success: false,
        error: 'Snapshot not found'
      };
    }
    
    // Get the snapshot state
    const state = this._getSnapshotState(id);
    if (!state) {
      return {
        success: false,
        error: 'Snapshot state not found'
      };
    }
    
    // Create a new snapshot before restoring if requested
    let snapshotId: string | undefined;
    if (options.createSnapshot) {
      try {
        const newSnapshot = await this.createSnapshot({
          label: 'Pre-restoration snapshot',
          description: `Automatic snapshot created before restoring to snapshot ${id}`,
          automatic: true
        });
        snapshotId = newSnapshot.id;
      } catch (error) {
        console.warn('Failed to create pre-restoration snapshot:', error);
      }
    }
    
    // Perform the restoration
    try {
      const restoredCells = await this._restoreNotebookState(state, options);
      
      return {
        success: true,
        restoredCells,
        snapshotId
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to restore snapshot: ${error.message}`,
        snapshotId
      };
    }
  }
  
  /**
   * Get the content of a snapshot as a notebook JSON object
   * 
   * @param id - The ID of the snapshot
   * @returns A promise that resolves to the notebook JSON, or undefined if not found
   */
  async getSnapshotContent(id: string): Promise<any | undefined> {
    const state = this._getSnapshotState(id);
    if (!state) {
      return undefined;
    }
    
    return state;
  }
  
  /**
   * Export a snapshot to a file
   * 
   * @param id - The ID of the snapshot to export
   * @param format - The export format ('ipynb' or 'json')
   * @returns A promise that resolves to the exported content as a string
   */
  async exportSnapshot(id: string, format: 'ipynb' | 'json'): Promise<string> {
    const state = this._getSnapshotState(id);
    if (!state) {
      throw new Error('Snapshot not found');
    }
    
    if (format === 'ipynb') {
      // Return the notebook JSON as a string
      return JSON.stringify(state, null, 2);
    } else if (format === 'json') {
      // Include additional metadata about the snapshot
      const snapshot = await this.getSnapshot(id);
      if (!snapshot) {
        throw new Error('Snapshot metadata not found');
      }
      
      const exportData = {
        snapshot,
        content: state
      };
      
      return JSON.stringify(exportData, null, 2);
    } else {
      throw new Error(`Unsupported export format: ${format}`);
    }
  }
  
  /**
   * Set the retention policy for automatic snapshots
   * 
   * @param options - Retention policy options
   */
  setRetentionPolicy(options: {
    maxSnapshots?: number;
    maxAge?: number;
    minInterval?: number;
  }): void {
    if (options.maxSnapshots !== undefined) {
      this._retentionPolicy.maxSnapshots = options.maxSnapshots;
    }
    
    if (options.maxAge !== undefined) {
      this._retentionPolicy.maxAge = options.maxAge;
    }
    
    if (options.minInterval !== undefined) {
      this._retentionPolicy.minInterval = options.minInterval;
    }
  }
  
  /**
   * Get the current retention policy
   * 
   * @returns The current retention policy
   */
  getRetentionPolicy(): {
    maxSnapshots: number;
    maxAge: number;
    minInterval: number;
  } {
    return { ...this._retentionPolicy };
  }
  
  /**
   * Apply the retention policy, removing snapshots that exceed the limits
   * 
   * @returns A promise that resolves to the number of snapshots removed
   */
  async applyRetentionPolicy(): Promise<number> {
    // Get all automatic snapshots
    const snapshots = await this.getSnapshots({ automatic: true, order: 'desc' });
    
    // No snapshots to process
    if (snapshots.length === 0) {
      return 0;
    }
    
    const now = Date.now();
    const snapshotsToRemove: string[] = [];
    
    // Check age limit
    if (this._retentionPolicy.maxAge > 0) {
      const ageLimit = now - this._retentionPolicy.maxAge;
      
      for (const snapshot of snapshots) {
        if (snapshot.timestamp < ageLimit) {
          snapshotsToRemove.push(snapshot.id);
        }
      }
    }
    
    // Check count limit
    if (this._retentionPolicy.maxSnapshots > 0 && snapshots.length > this._retentionPolicy.maxSnapshots) {
      // Skip the most recent maxSnapshots snapshots
      for (let i = this._retentionPolicy.maxSnapshots; i < snapshots.length; i++) {
        if (!snapshotsToRemove.includes(snapshots[i].id)) {
          snapshotsToRemove.push(snapshots[i].id);
        }
      }
    }
    
    // Remove the snapshots
    for (const id of snapshotsToRemove) {
      await this.deleteSnapshot(id);
    }
    
    return snapshotsToRemove.length;
  }
  
  /**
   * Dispose of the history manager and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    // Clear auto-snapshot timer
    if (this._autoSnapshotTimer) {
      clearInterval(this._autoSnapshotTimer);
      this._autoSnapshotTimer = null;
    }
    
    // Clean up signals
    this._statusChanged.disconnect();
    this._snapshotCreated.disconnect();
    this._snapshotDeleted.disconnect();
    this._snapshotUpdated.disconnect();
    
    this._isDisposed = true;
  }
  
  /**
   * Initialize the history manager
   * 
   * @param createInitialSnapshot - Whether to create an initial snapshot
   */
  private async _initialize(createInitialSnapshot: boolean): Promise<void> {
    try {
      // Set up auto-snapshot timer if enabled
      if (this._enableAutoSnapshots) {
        this._autoSnapshotTimer = setInterval(() => {
          this._createAutoSnapshot().catch(error => {
            console.warn('Failed to create automatic snapshot:', error);
          });
        }, this._autoSnapshotInterval);
      }
      
      // Create initial snapshot if requested
      if (createInitialSnapshot) {
        await this.createSnapshot({
          label: 'Initial snapshot',
          description: 'Initial snapshot created when the document was opened',
          automatic: true
        });
      }
      
      // Set status to ready
      this._setStatus(HistoryManagerStatus.Ready);
    } catch (error) {
      console.error('Failed to initialize history manager:', error);
      this._setStatus(HistoryManagerStatus.Degraded);
    }
  }
  
  /**
   * Create an automatic snapshot
   */
  private async _createAutoSnapshot(): Promise<void> {
    if (!this._canCreateAutomaticSnapshot()) {
      return;
    }
    
    try {
      await this.createSnapshot({
        automatic: true
      });
    } catch (error) {
      console.warn('Failed to create automatic snapshot:', error);
    }
  }
  
  /**
   * Check if an automatic snapshot can be created based on the retention policy
   */
  private _canCreateAutomaticSnapshot(): boolean {
    // If auto snapshots are disabled, don't create one
    if (!this._enableAutoSnapshots) {
      return false;
    }
    
    // If there are no snapshots yet, allow creating one
    if (this._ySnapshots.size === 0) {
      return true;
    }
    
    // Check if enough time has passed since the last automatic snapshot
    const now = Date.now();
    let mostRecentAutoSnapshot: IHistorySnapshot | null = null;
    
    this._ySnapshots.forEach(ySnapshot => {
      const snapshot = this._ySnapshotToSnapshot(ySnapshot);
      if (snapshot.automatic) {
        if (!mostRecentAutoSnapshot || snapshot.timestamp > mostRecentAutoSnapshot.timestamp) {
          mostRecentAutoSnapshot = snapshot;
        }
      }
    });
    
    if (mostRecentAutoSnapshot) {
      const timeSinceLastSnapshot = now - mostRecentAutoSnapshot.timestamp;
      return timeSinceLastSnapshot >= this._retentionPolicy.minInterval;
    }
    
    return true;
  }
  
  /**
   * Capture the current state of the notebook
   */
  private _captureNotebookState(): any {
    // Get the notebook model content
    const notebook = this._notebookModel.toJSON();
    
    // Add additional metadata for history tracking
    notebook.history = {
      capturedAt: Date.now(),
      capturedBy: {
        id: this._userId,
        name: this._userName
      },
      version: 1
    };
    
    return notebook;
  }
  
  /**
   * Get the state of a snapshot
   * 
   * @param id - The ID of the snapshot
   */
  private _getSnapshotState(id: string): any | undefined {
    const ySnapshot = this._ySnapshots.get(id);
    if (!ySnapshot) {
      return undefined;
    }
    
    return ySnapshot.get('state');
  }
  
  /**
   * Convert a Yjs snapshot to an IHistorySnapshot
   * 
   * @param ySnapshot - The Yjs snapshot
   */
  private _ySnapshotToSnapshot(ySnapshot: Y.Map<any>): IHistorySnapshot {
    return {
      id: ySnapshot.get('id'),
      timestamp: ySnapshot.get('timestamp'),
      author: ySnapshot.get('author'),
      label: ySnapshot.get('label'),
      description: ySnapshot.get('description'),
      automatic: ySnapshot.get('automatic'),
      size: ySnapshot.get('size'),
      tags: ySnapshot.get('tags'),
      metadata: ySnapshot.get('metadata')
    };
  }
  
  /**
   * Compare two sets of notebook cells and generate diffs
   * 
   * @param fromCells - The cells from the first snapshot
   * @param toCells - The cells from the second snapshot
   */
  private _compareCells(fromCells: any[], toCells: any[]): ICellDiff[] {
    const cellDiffs: ICellDiff[] = [];
    const fromCellsMap = new Map<string, any>();
    const toCellsMap = new Map<string, any>();
    
    // Create maps for faster lookup
    fromCells.forEach(cell => {
      fromCellsMap.set(cell.id, cell);
    });
    
    toCells.forEach(cell => {
      toCellsMap.set(cell.id, cell);
    });
    
    // Find cells that were added, removed, or modified
    const allCellIds = new Set<string>([...fromCellsMap.keys(), ...toCellsMap.keys()]);
    
    allCellIds.forEach(cellId => {
      const fromCell = fromCellsMap.get(cellId);
      const toCell = toCellsMap.get(cellId);
      
      if (!fromCell) {
        // Cell was added
        cellDiffs.push({
          cellId,
          changeType: 'added',
          newContent: toCell.source
        });
      } else if (!toCell) {
        // Cell was removed
        cellDiffs.push({
          cellId,
          changeType: 'removed',
          oldContent: fromCell.source
        });
      } else {
        // Cell exists in both snapshots, check if it was modified
        if (fromCell.source !== toCell.source) {
          // Content was modified
          const lineDiffs = this._compareLines(fromCell.source, toCell.source);
          
          cellDiffs.push({
            cellId,
            changeType: 'modified',
            oldContent: fromCell.source,
            newContent: toCell.source,
            lineDiffs
          });
        } else {
          // Check if metadata was modified
          const metadataChanges = this._compareMetadata(fromCell.metadata, toCell.metadata);
          
          if (metadataChanges.length > 0) {
            cellDiffs.push({
              cellId,
              changeType: 'modified',
              oldContent: fromCell.source,
              newContent: toCell.source,
              metadataChanges
            });
          } else {
            // Cell is unchanged
            cellDiffs.push({
              cellId,
              changeType: 'unchanged'
            });
          }
        }
      }
    });
    
    return cellDiffs;
  }
  
  /**
   * Compare two strings line by line
   * 
   * @param oldText - The old text
   * @param newText - The new text
   */
  private _compareLines(oldText: string, newText: string): {
    oldLineNumber: number;
    newLineNumber: number;
    type: 'added' | 'removed' | 'modified' | 'unchanged';
    content: string;
  }[] {
    // Split the text into lines
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    
    // Simple line-by-line diff
    // In a real implementation, this would use a more sophisticated diff algorithm
    const lineDiffs: {
      oldLineNumber: number;
      newLineNumber: number;
      type: 'added' | 'removed' | 'modified' | 'unchanged';
      content: string;
    }[] = [];
    
    // Find the maximum length
    const maxLength = Math.max(oldLines.length, newLines.length);
    
    for (let i = 0; i < maxLength; i++) {
      const oldLine = i < oldLines.length ? oldLines[i] : null;
      const newLine = i < newLines.length ? newLines[i] : null;
      
      if (oldLine === null) {
        // Line was added
        lineDiffs.push({
          oldLineNumber: -1,
          newLineNumber: i,
          type: 'added',
          content: newLine!
        });
      } else if (newLine === null) {
        // Line was removed
        lineDiffs.push({
          oldLineNumber: i,
          newLineNumber: -1,
          type: 'removed',
          content: oldLine
        });
      } else if (oldLine !== newLine) {
        // Line was modified
        lineDiffs.push({
          oldLineNumber: i,
          newLineNumber: i,
          type: 'modified',
          content: newLine
        });
      } else {
        // Line is unchanged
        lineDiffs.push({
          oldLineNumber: i,
          newLineNumber: i,
          type: 'unchanged',
          content: newLine
        });
      }
    }
    
    return lineDiffs;
  }
  
  /**
   * Compare two metadata objects and generate changes
   * 
   * @param oldMetadata - The old metadata
   * @param newMetadata - The new metadata
   */
  private _compareMetadata(oldMetadata: any, newMetadata: any): {
    key: string;
    oldValue: any;
    newValue: any;
  }[] {
    const changes: {
      key: string;
      oldValue: any;
      newValue: any;
    }[] = [];
    
    // Handle undefined metadata
    const oldMeta = oldMetadata || {};
    const newMeta = newMetadata || {};
    
    // Get all keys from both objects
    const allKeys = new Set<string>([...Object.keys(oldMeta), ...Object.keys(newMeta)]);
    
    allKeys.forEach(key => {
      const oldValue = oldMeta[key];
      const newValue = newMeta[key];
      
      // Check if the key exists in both objects and has the same value
      if (!this._deepEqual(oldValue, newValue)) {
        changes.push({
          key,
          oldValue,
          newValue
        });
      }
    });
    
    return changes;
  }
  
  /**
   * Deep equality check for objects
   * 
   * @param a - The first value
   * @param b - The second value
   */
  private _deepEqual(a: any, b: any): boolean {
    // If both are undefined or null, they're equal
    if (a === b) {
      return true;
    }
    
    // If only one is undefined or null, they're not equal
    if (a == null || b == null) {
      return false;
    }
    
    // If they're not objects, compare directly
    if (typeof a !== 'object' || typeof b !== 'object') {
      return a === b;
    }
    
    // If they're arrays, compare each element
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return false;
      }
      
      for (let i = 0; i < a.length; i++) {
        if (!this._deepEqual(a[i], b[i])) {
          return false;
        }
      }
      
      return true;
    }
    
    // If one is an array and the other isn't, they're not equal
    if (Array.isArray(a) || Array.isArray(b)) {
      return false;
    }
    
    // Compare objects
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    
    if (keysA.length !== keysB.length) {
      return false;
    }
    
    for (const key of keysA) {
      if (!keysB.includes(key) || !this._deepEqual(a[key], b[key])) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Restore the notebook to a previous state
   * 
   * @param state - The notebook state to restore
   * @param options - Options for the restoration
   */
  private async _restoreNotebookState(state: any, options: IRestoreOptions): Promise<string[]> {
    const restoredCells: string[] = [];
    
    if (options.mode === 'full') {
      // Full restoration - replace the entire notebook
      await this._applyFullRestoration(state);
      
      // All cells were restored
      state.cells.forEach((cell: any) => {
        restoredCells.push(cell.id);
      });
    } else if (options.mode === 'selective' && options.cellIds && options.cellIds.length > 0) {
      // Selective restoration - only restore specified cells
      await this._applySelectiveRestoration(state, options.cellIds, options.asNewEdit ?? false);
      
      // Only the selected cells were restored
      restoredCells.push(...options.cellIds);
    } else {
      throw new Error('Invalid restoration mode or missing cell IDs for selective restoration');
    }
    
    return restoredCells;
  }
  
  /**
   * Apply a full restoration of the notebook
   * 
   * @param state - The notebook state to restore
   */
  private async _applyFullRestoration(state: any): Promise<void> {
    // This would typically involve updating the Yjs document
    // with the content from the snapshot, which would then
    // propagate to all clients
    
    // For simplicity, we'll just update the notebook model directly
    // In a real implementation, this would be more complex and involve
    // proper Yjs document updates
    
    // Clear the current notebook content
    this._notebookModel.fromJSON(state);
  }
  
  /**
   * Apply a selective restoration of specific cells
   * 
   * @param state - The notebook state to restore
   * @param cellIds - The IDs of the cells to restore
   * @param asNewEdit - Whether to apply the restoration as a new edit
   */
  private async _applySelectiveRestoration(state: any, cellIds: string[], asNewEdit: boolean): Promise<void> {
    // Get the cells from the snapshot
    const cellsToRestore = state.cells.filter((cell: any) => cellIds.includes(cell.id));
    
    if (cellsToRestore.length === 0) {
      throw new Error('No cells found in snapshot with the specified IDs');
    }
    
    // Get the current notebook state
    const currentState = this._notebookModel.toJSON();
    const currentCellsMap = new Map<string, any>();
    
    currentState.cells.forEach((cell: any) => {
      currentCellsMap.set(cell.id, cell);
    });
    
    // Apply the restoration
    if (asNewEdit) {
      // Add the restored cells as new cells
      // This would typically involve creating new cells with the content
      // from the snapshot, but with new IDs
      
      // For simplicity, we'll just add the cells to the end of the notebook
      // In a real implementation, this would be more complex
      
      const newCells = [...currentState.cells];
      
      cellsToRestore.forEach((cell: any) => {
        // Create a new cell with a new ID but the same content
        const newCell = { ...cell, id: UUID.uuid4() };
        newCells.push(newCell);
      });
      
      // Update the notebook model
      currentState.cells = newCells;
      this._notebookModel.fromJSON(currentState);
    } else {
      // Replace the existing cells with the restored cells
      // This would typically involve updating the existing cells
      // with the content from the snapshot
      
      const newCells = [...currentState.cells];
      
      cellsToRestore.forEach((cell: any) => {
        const index = newCells.findIndex((c: any) => c.id === cell.id);
        
        if (index !== -1) {
          // Replace the existing cell
          newCells[index] = cell;
        } else {
          // Cell doesn't exist in the current notebook, add it
          newCells.push(cell);
        }
      });
      
      // Update the notebook model
      currentState.cells = newCells;
      this._notebookModel.fromJSON(currentState);
    }
  }
  
  /**
   * Set the history manager status and emit a status change event
   * 
   * @param status - The new status
   */
  private _setStatus(status: HistoryManagerStatus): void {
    if (this._status !== status) {
      this._status = status;
      this._statusChanged.emit(status);
    }
  }
  
  private _notebookModel: INotebookModel;
  private _ydoc: Y.Doc;
  private _ySnapshots: Y.Map<Y.Map<any>>;
  private _userId: string;
  private _userName: string;
  private _userAvatarUrl?: string;
  private _status: HistoryManagerStatus = HistoryManagerStatus.Initializing;
  private _isDisposed = false;
  private _retentionPolicy: {
    maxSnapshots: number;
    maxAge: number;
    minInterval: number;
  };
  private _enableAutoSnapshots: boolean;
  private _autoSnapshotInterval: number;
  private _autoSnapshotTimer: any | null = null;
  
  private _statusChanged: Signal<IHistoryManager, HistoryManagerStatus>;
  private _snapshotCreated: Signal<IHistoryManager, IHistorySnapshot>;
  private _snapshotDeleted: Signal<IHistoryManager, string>;
  private _snapshotUpdated: Signal<IHistoryManager, IHistorySnapshot>;
}

/**
 * Create a history manager for a notebook
 * 
 * @param options - Configuration options for the history manager
 * @returns A new history manager instance
 */
export function createHistoryManager(options: IHistoryManagerOptions): IHistoryManager {
  return new HistoryManager(options);
}