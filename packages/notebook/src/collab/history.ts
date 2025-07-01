// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { nbformat } from '@jupyterlab/nbformat';
import { IChangedArgs } from '@jupyterlab/coreutils';
import { PartialJSONObject, JSONExt } from '@lumino/coreutils';

// Yjs imports for CRDT functionality
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

// Local imports
import { IYjsNotebookProvider, IUserPresence, ICollaborativeChange } from '../model';

/**
 * Interface for managing document version history and change tracking
 */
export interface IHistoryTracker extends IDisposable {
  /**
   * Signal emitted when a new version is created
   */
  readonly versionCreated: ISignal<this, IVersionSnapshot>;

  /**
   * Signal emitted when history is updated
   */
  readonly historyUpdated: ISignal<this, IHistoryUpdate>;

  /**
   * Signal emitted when a version is restored
   */
  readonly versionRestored: ISignal<this, IVersionSnapshot>;

  /**
   * The current version ID
   */
  readonly currentVersionId: string;

  /**
   * All available version snapshots in chronological order
   */
  readonly versions: readonly IVersionSnapshot[];

  /**
   * The collaborative provider this tracker is associated with
   */
  readonly provider: IYjsNotebookProvider;

  /**
   * Whether the tracker is actively recording changes
   */
  readonly isRecording: boolean;

  /**
   * Start recording document changes
   */
  startRecording(): void;

  /**
   * Stop recording document changes
   */
  stopRecording(): void;

  /**
   * Create a manual version snapshot with optional label
   */
  createSnapshot(label?: string): Promise<IVersionSnapshot>;

  /**
   * Restore a specific version of the document
   */
  restoreVersion(versionId: string): Promise<void>;

  /**
   * Get changes between two versions
   */
  getDiff(fromVersionId: string, toVersionId: string): Promise<IVersionDiff>;

  /**
   * Get a specific version snapshot
   */
  getVersion(versionId: string): IVersionSnapshot | null;

  /**
   * Get timeline of changes for a specific time range
   */
  getTimelineChanges(startTime: Date, endTime: Date): Promise<ITimelineChange[]>;

  /**
   * Set auto-snapshot interval (in milliseconds, 0 to disable)
   */
  setAutoSnapshotInterval(intervalMs: number): void;

  /**
   * Clear all version history
   */
  clearHistory(): Promise<void>;

  /**
   * Get storage statistics for the history
   */
  getStorageStats(): Promise<IHistoryStats>;
}

/**
 * Interface for efficient version management and storage
 */
export interface IVersionManager extends IDisposable {
  /**
   * Store a compressed version snapshot
   */
  storeVersion(snapshot: IVersionSnapshot): Promise<string>;

  /**
   * Retrieve a version snapshot by ID
   */
  retrieveVersion(versionId: string): Promise<IVersionSnapshot | null>;

  /**
   * Store a change delta
   */
  storeDelta(delta: IChangeDelta): Promise<void>;

  /**
   * Retrieve compressed deltas between versions
   */
  getDeltas(fromVersionId: string, toVersionId: string): Promise<IChangeDelta[]>;

  /**
   * Compress and optimize stored history
   */
  compressHistory(): Promise<void>;

  /**
   * Get version metadata without full content
   */
  getVersionMetadata(versionId: string): Promise<IVersionMetadata | null>;

  /**
   * Bulk retrieve multiple versions efficiently
   */
  retrieveVersions(versionIds: string[]): Promise<Map<string, IVersionSnapshot>>;

  /**
   * Set retention policy for automatic cleanup
   */
  setRetentionPolicy(policy: IRetentionPolicy): void;

  /**
   * Get storage usage information
   */
  getStorageUsage(): Promise<IStorageUsage>;
}

/**
 * Represents a complete version snapshot of the document
 */
export interface IVersionSnapshot {
  /**
   * Unique identifier for this version
   */
  readonly id: string;

  /**
   * Human-readable label for this version
   */
  readonly label?: string;

  /**
   * Timestamp when this version was created
   */
  readonly timestamp: Date;

  /**
   * User who created this version
   */
  readonly user: IUserPresence;

  /**
   * Complete notebook content at this version
   */
  readonly content: nbformat.INotebookContent;

  /**
   * Yjs document state for this version
   */
  readonly yjsState: Uint8Array;

  /**
   * Metadata about this version
   */
  readonly metadata: IVersionMetadata;

  /**
   * Size of this version in bytes
   */
  readonly size: number;

  /**
   * Whether this is an auto-generated snapshot
   */
  readonly isAutoSnapshot: boolean;

  /**
   * Parent version ID (if applicable)
   */
  readonly parentVersionId?: string;

  /**
   * Change summary since previous version
   */
  readonly changeSummary: IChangeSummary;
}

/**
 * Metadata about a version without full content
 */
export interface IVersionMetadata {
  /**
   * Version identifier
   */
  readonly id: string;

  /**
   * Version label
   */
  readonly label?: string;

  /**
   * Creation timestamp
   */
  readonly timestamp: Date;

  /**
   * User information
   */
  readonly user: IUserPresence;

  /**
   * Version size in bytes
   */
  readonly size: number;

  /**
   * Number of cells in this version
   */
  readonly cellCount: number;

  /**
   * Version type
   */
  readonly type: 'manual' | 'auto' | 'checkpoint';

  /**
   * Additional custom metadata
   */
  readonly custom?: PartialJSONObject;
}

/**
 * Represents a compressed change delta between versions
 */
export interface IChangeDelta {
  /**
   * Unique identifier for this delta
   */
  readonly id: string;

  /**
   * Source version ID
   */
  readonly fromVersionId: string;

  /**
   * Target version ID
   */
  readonly toVersionId: string;

  /**
   * Yjs update bytes representing the change
   */
  readonly yjsUpdate: Uint8Array;

  /**
   * Human-readable change operations
   */
  readonly operations: IChangeOperation[];

  /**
   * Timestamp of this delta
   */
  readonly timestamp: Date;

  /**
   * User who made the change
   */
  readonly user: IUserPresence;

  /**
   * Compressed size in bytes
   */
  readonly compressedSize: number;
}

/**
 * Individual change operation within a delta
 */
export interface IChangeOperation {
  /**
   * Type of operation
   */
  readonly type: 'insert' | 'delete' | 'retain' | 'modify';

  /**
   * Target of the operation
   */
  readonly target: 'cell' | 'metadata' | 'output' | 'source';

  /**
   * Cell ID if applicable
   */
  readonly cellId?: string;

  /**
   * Index position for array operations
   */
  readonly index?: number;

  /**
   * Length of operation
   */
  readonly length?: number;

  /**
   * Content of the operation
   */
  readonly content?: any;

  /**
   * Additional attributes
   */
  readonly attributes?: PartialJSONObject;
}

/**
 * Difference between two document versions
 */
export interface IVersionDiff {
  /**
   * Source version metadata
   */
  readonly fromVersion: IVersionMetadata;

  /**
   * Target version metadata
   */
  readonly toVersion: IVersionMetadata;

  /**
   * All change operations between versions
   */
  readonly operations: IChangeOperation[];

  /**
   * Cell-level differences
   */
  readonly cellDiffs: ICellDiff[];

  /**
   * Metadata differences
   */
  readonly metadataDiff: IMetadataDiff;

  /**
   * Statistics about the diff
   */
  readonly stats: IDiffStats;
}

/**
 * Difference between two cells
 */
export interface ICellDiff {
  /**
   * Cell identifier
   */
  readonly cellId: string;

  /**
   * Type of cell difference
   */
  readonly type: 'added' | 'removed' | 'modified' | 'moved';

  /**
   * Original cell index
   */
  readonly oldIndex?: number;

  /**
   * New cell index
   */
  readonly newIndex?: number;

  /**
   * Source content differences
   */
  readonly sourceDiff?: ITextDiff[];

  /**
   * Output differences
   */
  readonly outputDiff?: IOutputDiff[];

  /**
   * Metadata differences
   */
  readonly metadataDiff?: IMetadataDiff;
}

/**
 * Text-level differences within cell content
 */
export interface ITextDiff {
  /**
   * Operation type
   */
  readonly operation: 'insert' | 'delete' | 'equal';

  /**
   * Text content
   */
  readonly text: string;

  /**
   * Line number (0-based)
   */
  readonly line?: number;

  /**
   * Column position (0-based)
   */
  readonly column?: number;

  /**
   * Length of the change
   */
  readonly length: number;
}

/**
 * Differences in cell outputs
 */
export interface IOutputDiff {
  /**
   * Output index
   */
  readonly index: number;

  /**
   * Type of output difference
   */
  readonly type: 'added' | 'removed' | 'modified';

  /**
   * Output content (if applicable)
   */
  readonly content?: nbformat.IOutput;

  /**
   * Previous output content (if applicable)
   */
  readonly previousContent?: nbformat.IOutput;
}

/**
 * Metadata differences
 */
export interface IMetadataDiff {
  /**
   * Added metadata keys
   */
  readonly added: string[];

  /**
   * Removed metadata keys
   */
  readonly removed: string[];

  /**
   * Modified metadata with old and new values
   */
  readonly modified: Array<{
    key: string;
    oldValue: any;
    newValue: any;
  }>;
}

/**
 * Statistics about a version diff
 */
export interface IDiffStats {
  /**
   * Total number of changes
   */
  readonly totalChanges: number;

  /**
   * Number of cells added
   */
  readonly cellsAdded: number;

  /**
   * Number of cells removed
   */
  readonly cellsRemoved: number;

  /**
   * Number of cells modified
   */
  readonly cellsModified: number;

  /**
   * Total lines added
   */
  readonly linesAdded: number;

  /**
   * Total lines removed
   */
  readonly linesRemoved: number;

  /**
   * Percentage of document changed
   */
  readonly changePercentage: number;
}

/**
 * Timeline change entry for history visualization
 */
export interface ITimelineChange {
  /**
   * Change identifier
   */
  readonly id: string;

  /**
   * Timestamp of the change
   */
  readonly timestamp: Date;

  /**
   * User who made the change
   */
  readonly user: IUserPresence;

  /**
   * Type of change
   */
  readonly type: ICollaborativeChange['type'];

  /**
   * Brief description of the change
   */
  readonly description: string;

  /**
   * Affected cells
   */
  readonly affectedCells: string[];

  /**
   * Version ID if this change created a snapshot
   */
  readonly versionId?: string;

  /**
   * Change delta information
   */
  readonly delta: IChangeDelta;
}

/**
 * Update notification for history changes
 */
export interface IHistoryUpdate {
  /**
   * Type of update
   */
  readonly type: 'version-added' | 'version-removed' | 'delta-added' | 'history-cleared';

  /**
   * Related version ID
   */
  readonly versionId?: string;

  /**
   * Additional data about the update
   */
  readonly data?: any;

  /**
   * Timestamp of the update
   */
  readonly timestamp: Date;
}

/**
 * Change summary for a version
 */
export interface IChangeSummary {
  /**
   * Total number of changes
   */
  readonly totalChanges: number;

  /**
   * Changes by type
   */
  readonly changesByType: Map<string, number>;

  /**
   * Affected cell count
   */
  readonly affectedCells: number;

  /**
   * Key changes description
   */
  readonly keyChanges: string[];

  /**
   * Collaboration statistics
   */
  readonly collaborationStats: {
    totalUsers: number;
    activeUsers: number;
    conflictsResolved: number;
  };
}

/**
 * History storage statistics
 */
export interface IHistoryStats {
  /**
   * Total number of versions
   */
  readonly totalVersions: number;

  /**
   * Total storage size in bytes
   */
  readonly totalSize: number;

  /**
   * Average version size
   */
  readonly averageVersionSize: number;

  /**
   * Compression ratio
   */
  readonly compressionRatio: number;

  /**
   * Number of deltas stored
   */
  readonly totalDeltas: number;

  /**
   * Storage efficiency metrics
   */
  readonly efficiency: {
    deltaToSnapshotRatio: number;
    storageOptimization: number;
    retrievalPerformance: number;
  };
}

/**
 * Retention policy for automatic history cleanup
 */
export interface IRetentionPolicy {
  /**
   * Maximum number of versions to keep
   */
  readonly maxVersions?: number;

  /**
   * Maximum age of versions in milliseconds
   */
  readonly maxAge?: number;

  /**
   * Maximum total storage size in bytes
   */
  readonly maxStorageSize?: number;

  /**
   * Keep versions that match these criteria
   */
  readonly keepCriteria?: {
    manualSnapshots?: boolean;
    checkpoints?: boolean;
    labeledVersions?: boolean;
    recentVersions?: number;
  };

  /**
   * Compression settings
   */
  readonly compression?: {
    enableDeltaCompression?: boolean;
    compressOldSnapshots?: boolean;
    compressionThreshold?: number;
  };
}

/**
 * Storage usage information
 */
export interface IStorageUsage {
  /**
   * Total storage used in bytes
   */
  readonly totalUsed: number;

  /**
   * Storage by component type
   */
  readonly breakdown: {
    snapshots: number;
    deltas: number;
    metadata: number;
    indexes: number;
  };

  /**
   * Potential savings from compression
   */
  readonly potentialSavings: number;

  /**
   * Storage efficiency score (0-1)
   */
  readonly efficiencyScore: number;
}

/**
 * Default implementation of the History Tracker
 */
export class HistoryTracker implements IHistoryTracker {
  private _isDisposed = false;
  private _provider: IYjsNotebookProvider;
  private _versionManager: IVersionManager;
  private _isRecording = false;
  private _currentVersionId = '';
  private _versions: IVersionSnapshot[] = [];
  private _autoSnapshotInterval = 0;
  private _autoSnapshotTimer: any = null;
  private _changeBuffer: ICollaborativeChange[] = [];
  private _lastSnapshotTime = 0;

  // Signals
  private _versionCreated = new Signal<this, IVersionSnapshot>(this);
  private _historyUpdated = new Signal<this, IHistoryUpdate>(this);
  private _versionRestored = new Signal<this, IVersionSnapshot>(this);

  constructor(provider: IYjsNotebookProvider, versionManager?: IVersionManager) {
    this._provider = provider;
    this._versionManager = versionManager || new DefaultVersionManager();
    this._currentVersionId = this._generateVersionId();
    
    this._setupDocumentTracking();
    this._setupAutoSnapshot();
  }

  /**
   * Signal emitted when a new version is created
   */
  get versionCreated(): ISignal<this, IVersionSnapshot> {
    return this._versionCreated;
  }

  /**
   * Signal emitted when history is updated
   */
  get historyUpdated(): ISignal<this, IHistoryUpdate> {
    return this._historyUpdated;
  }

  /**
   * Signal emitted when a version is restored
   */
  get versionRestored(): ISignal<this, IVersionSnapshot> {
    return this._versionRestored;
  }

  /**
   * The current version ID
   */
  get currentVersionId(): string {
    return this._currentVersionId;
  }

  /**
   * All available version snapshots in chronological order
   */
  get versions(): readonly IVersionSnapshot[] {
    return [...this._versions];
  }

  /**
   * The collaborative provider this tracker is associated with
   */
  get provider(): IYjsNotebookProvider {
    return this._provider;
  }

  /**
   * Whether the tracker is actively recording changes
   */
  get isRecording(): boolean {
    return this._isRecording;
  }

  /**
   * Whether the tracker has been disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Start recording document changes
   */
  startRecording(): void {
    if (this._isDisposed) {
      throw new Error('HistoryTracker has been disposed');
    }

    if (this._isRecording) {
      return;
    }

    this._isRecording = true;
    
    // Create initial snapshot if we don't have one
    if (this._versions.length === 0) {
      this.createSnapshot('Initial version').catch(error => {
        console.error('Failed to create initial snapshot:', error);
      });
    }

    console.log('HistoryTracker: Started recording changes');
  }

  /**
   * Stop recording document changes
   */
  stopRecording(): void {
    if (!this._isRecording) {
      return;
    }

    this._isRecording = false;
    this._clearAutoSnapshotTimer();
    
    console.log('HistoryTracker: Stopped recording changes');
  }

  /**
   * Create a manual version snapshot with optional label
   */
  async createSnapshot(label?: string): Promise<IVersionSnapshot> {
    if (this._isDisposed) {
      throw new Error('HistoryTracker has been disposed');
    }

    const user = this._getCurrentUser();
    const content = this._provider.getDocumentState();
    const yjsState = Y.encodeStateAsUpdate(this._provider.yjsDocument);
    
    const versionId = this._generateVersionId();
    const timestamp = new Date();
    
    // Calculate change summary
    const changeSummary = await this._calculateChangeSummary();
    
    const snapshot: IVersionSnapshot = {
      id: versionId,
      label,
      timestamp,
      user,
      content,
      yjsState,
      metadata: {
        id: versionId,
        label,
        timestamp,
        user,
        size: new TextEncoder().encode(JSON.stringify(content)).length,
        cellCount: content.cells.length,
        type: label ? 'manual' : 'auto'
      },
      size: yjsState.length + new TextEncoder().encode(JSON.stringify(content)).length,
      isAutoSnapshot: !label,
      parentVersionId: this._currentVersionId || undefined,
      changeSummary
    };

    // Store in version manager
    await this._versionManager.storeVersion(snapshot);
    
    // Add to local versions
    this._versions.push(snapshot);
    this._currentVersionId = versionId;
    this._lastSnapshotTime = Date.now();

    // Create delta from previous version if exists
    if (this._versions.length > 1) {
      const previousVersion = this._versions[this._versions.length - 2];
      await this._createDelta(previousVersion.id, versionId);
    }

    // Emit signals
    this._versionCreated.emit(snapshot);
    this._historyUpdated.emit({
      type: 'version-added',
      versionId,
      timestamp,
      data: snapshot
    });

    console.log(`HistoryTracker: Created version snapshot ${versionId}${label ? ` (${label})` : ''}`);
    return snapshot;
  }

  /**
   * Restore a specific version of the document
   */
  async restoreVersion(versionId: string): Promise<void> {
    if (this._isDisposed) {
      throw new Error('HistoryTracker has been disposed');
    }

    const version = await this._versionManager.retrieveVersion(versionId);
    if (!version) {
      throw new Error(`Version ${versionId} not found`);
    }

    // Stop recording during restore to avoid circular updates
    const wasRecording = this._isRecording;
    if (wasRecording) {
      this.stopRecording();
    }

    try {
      // Apply the version state to the Yjs document
      Y.applyUpdate(this._provider.yjsDocument, version.yjsState);
      
      // Update the provider with the restored content
      this._provider.updateDocument(version.content);
      
      // Update current version
      this._currentVersionId = versionId;
      
      // Emit signal
      this._versionRestored.emit(version);
      
      console.log(`HistoryTracker: Restored version ${versionId}`);
      
    } finally {
      // Resume recording if it was active
      if (wasRecording) {
        this.startRecording();
      }
    }
  }

  /**
   * Get changes between two versions
   */
  async getDiff(fromVersionId: string, toVersionId: string): Promise<IVersionDiff> {
    if (this._isDisposed) {
      throw new Error('HistoryTracker has been disposed');
    }

    const [fromVersion, toVersion] = await Promise.all([
      this._versionManager.getVersionMetadata(fromVersionId),
      this._versionManager.getVersionMetadata(toVersionId)
    ]);

    if (!fromVersion || !toVersion) {
      throw new Error('One or both versions not found');
    }

    // Get deltas between versions
    const deltas = await this._versionManager.getDeltas(fromVersionId, toVersionId);
    
    // Compute detailed diff
    const diff = await this._computeVersionDiff(fromVersion, toVersion, deltas);
    
    return diff;
  }

  /**
   * Get a specific version snapshot
   */
  getVersion(versionId: string): IVersionSnapshot | null {
    return this._versions.find(v => v.id === versionId) || null;
  }

  /**
   * Get timeline of changes for a specific time range
   */
  async getTimelineChanges(startTime: Date, endTime: Date): Promise<ITimelineChange[]> {
    if (this._isDisposed) {
      throw new Error('HistoryTracker has been disposed');
    }

    const timelineChanges: ITimelineChange[] = [];
    
    // Filter versions within time range
    const relevantVersions = this._versions.filter(v => 
      v.timestamp >= startTime && v.timestamp <= endTime
    );

    // Create timeline entries for each version
    for (const version of relevantVersions) {
      if (version.parentVersionId) {
        const deltas = await this._versionManager.getDeltas(
          version.parentVersionId,
          version.id
        );

        for (const delta of deltas) {
          const timelineChange: ITimelineChange = {
            id: delta.id,
            timestamp: delta.timestamp,
            user: delta.user,
            type: this._inferChangeType(delta.operations),
            description: this._generateChangeDescription(delta.operations),
            affectedCells: this._extractAffectedCells(delta.operations),
            versionId: version.id,
            delta
          };
          
          timelineChanges.push(timelineChange);
        }
      }
    }

    // Sort by timestamp
    timelineChanges.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    return timelineChanges;
  }

  /**
   * Set auto-snapshot interval (in milliseconds, 0 to disable)
   */
  setAutoSnapshotInterval(intervalMs: number): void {
    this._autoSnapshotInterval = intervalMs;
    this._setupAutoSnapshot();
  }

  /**
   * Clear all version history
   */
  async clearHistory(): Promise<void> {
    if (this._isDisposed) {
      throw new Error('HistoryTracker has been disposed');
    }

    this._versions = [];
    this._currentVersionId = this._generateVersionId();
    this._changeBuffer = [];
    
    // Clear storage
    await this._versionManager.compressHistory();
    
    this._historyUpdated.emit({
      type: 'history-cleared',
      timestamp: new Date()
    });

    console.log('HistoryTracker: Cleared all version history');
  }

  /**
   * Get storage statistics for the history
   */
  async getStorageStats(): Promise<IHistoryStats> {
    if (this._isDisposed) {
      throw new Error('HistoryTracker has been disposed');
    }

    const usage = await this._versionManager.getStorageUsage();
    
    const totalVersions = this._versions.length;
    const totalSize = usage.totalUsed;
    const averageVersionSize = totalVersions > 0 ? totalSize / totalVersions : 0;
    
    return {
      totalVersions,
      totalSize,
      averageVersionSize,
      compressionRatio: usage.efficiencyScore,
      totalDeltas: usage.breakdown.deltas,
      efficiency: {
        deltaToSnapshotRatio: usage.breakdown.deltas / Math.max(usage.breakdown.snapshots, 1),
        storageOptimization: usage.efficiencyScore,
        retrievalPerformance: 0.95 // Placeholder - would be measured in real implementation
      }
    };
  }

  /**
   * Dispose of the tracker and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this.stopRecording();
    this._clearAutoSnapshotTimer();
    
    // Dispose version manager
    this._versionManager.dispose();
    
    // Clear data structures
    this._versions = [];
    this._changeBuffer = [];
    
    this._isDisposed = true;
    
    console.log('HistoryTracker: Disposed');
  }

  /**
   * Setup document change tracking
   */
  private _setupDocumentTracking(): void {
    if (!this._provider.documentChanged) {
      return;
    }

    this._provider.documentChanged.connect((sender, events) => {
      if (!this._isRecording) {
        return;
      }

      // Buffer changes for processing
      events.forEach(event => {
        const change = this._createChangeFromYjsEvent(event);
        if (change) {
          this._changeBuffer.push(change);
        }
      });

      // Process buffered changes
      this._processChangeBuffer();
    });
  }

  /**
   * Setup automatic snapshot creation
   */
  private _setupAutoSnapshot(): void {
    this._clearAutoSnapshotTimer();

    if (this._autoSnapshotInterval > 0) {
      this._autoSnapshotTimer = setInterval(() => {
        if (this._isRecording && this._changeBuffer.length > 0) {
          this.createSnapshot().catch(error => {
            console.error('Auto-snapshot failed:', error);
          });
        }
      }, this._autoSnapshotInterval);
    }
  }

  /**
   * Clear auto-snapshot timer
   */
  private _clearAutoSnapshotTimer(): void {
    if (this._autoSnapshotTimer) {
      clearInterval(this._autoSnapshotTimer);
      this._autoSnapshotTimer = null;
    }
  }

  /**
   * Process buffered changes
   */
  private _processChangeBuffer(): void {
    if (this._changeBuffer.length === 0) {
      return;
    }

    // Create snapshot if significant changes accumulated
    const significantChangeThreshold = 10;
    const timeSinceLastSnapshot = Date.now() - this._lastSnapshotTime;
    const minimumSnapshotInterval = 30000; // 30 seconds

    if (
      this._changeBuffer.length >= significantChangeThreshold &&
      timeSinceLastSnapshot > minimumSnapshotInterval
    ) {
      this.createSnapshot().catch(error => {
        console.error('Failed to create automatic snapshot:', error);
      });
    }
  }

  /**
   * Create a change delta between two versions
   */
  private async _createDelta(fromVersionId: string, toVersionId: string): Promise<IChangeDelta> {
    const fromVersion = await this._versionManager.retrieveVersion(fromVersionId);
    const toVersion = await this._versionManager.retrieveVersion(toVersionId);
    
    if (!fromVersion || !toVersion) {
      throw new Error('Cannot create delta: version not found');
    }

    // Calculate Yjs update between versions
    const fromDoc = new Y.Doc();
    const toDoc = new Y.Doc();
    
    Y.applyUpdate(fromDoc, fromVersion.yjsState);
    Y.applyUpdate(toDoc, toVersion.yjsState);
    
    const yjsUpdate = Y.encodeStateAsUpdate(toDoc);
    
    // Generate operations from buffer
    const operations = this._changeBuffer.map(change => this._convertToOperation(change));
    
    const delta: IChangeDelta = {
      id: this._generateDeltaId(),
      fromVersionId,
      toVersionId,
      yjsUpdate,
      operations,
      timestamp: toVersion.timestamp,
      user: toVersion.user,
      compressedSize: yjsUpdate.length
    };

    await this._versionManager.storeDelta(delta);
    this._changeBuffer = []; // Clear buffer after creating delta
    
    return delta;
  }

  /**
   * Calculate change summary for current state
   */
  private async _calculateChangeSummary(): Promise<IChangeSummary> {
    const totalChanges = this._changeBuffer.length;
    const changesByType = new Map<string, number>();
    const affectedCells = new Set<string>();

    this._changeBuffer.forEach(change => {
      const count = changesByType.get(change.type) || 0;
      changesByType.set(change.type, count + 1);
      
      if (change.cellId) {
        affectedCells.add(change.cellId);
      }
    });

    const keyChanges = this._generateKeyChanges(this._changeBuffer);
    
    return {
      totalChanges,
      changesByType,
      affectedCells: affectedCells.size,
      keyChanges,
      collaborationStats: {
        totalUsers: 1, // Would be calculated from awareness
        activeUsers: 1,
        conflictsResolved: 0
      }
    };
  }

  /**
   * Generate key changes description
   */
  private _generateKeyChanges(changes: ICollaborativeChange[]): string[] {
    const descriptions: string[] = [];
    const typeCounts = new Map<string, number>();

    changes.forEach(change => {
      const count = typeCounts.get(change.type) || 0;
      typeCounts.set(change.type, count + 1);
    });

    typeCounts.forEach((count, type) => {
      if (count > 0) {
        descriptions.push(`${count} ${type} operation${count > 1 ? 's' : ''}`);
      }
    });

    return descriptions;
  }

  /**
   * Get current user information
   */
  private _getCurrentUser(): IUserPresence {
    // In a real implementation, this would get the current user from the provider
    return {
      userId: 'current-user',
      displayName: 'Current User',
      color: '#007acc',
      lastActivity: new Date()
    };
  }

  /**
   * Generate unique version ID
   */
  private _generateVersionId(): string {
    return `version-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique delta ID
   */
  private _generateDeltaId(): string {
    return `delta-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create collaborative change from Yjs event
   */
  private _createChangeFromYjsEvent(event: Y.YEvent<any>): ICollaborativeChange | null {
    // Simplified implementation - would need proper Yjs event handling
    return {
      type: 'cell-modify',
      content: event,
      user: this._getCurrentUser(),
      timestamp: new Date()
    };
  }

  /**
   * Convert collaborative change to operation
   */
  private _convertToOperation(change: ICollaborativeChange): IChangeOperation {
    return {
      type: 'modify',
      target: 'cell',
      cellId: change.cellId,
      index: change.index,
      content: change.content
    };
  }

  /**
   * Compute detailed diff between versions
   */
  private async _computeVersionDiff(
    fromVersion: IVersionMetadata,
    toVersion: IVersionMetadata,
    deltas: IChangeDelta[]
  ): Promise<IVersionDiff> {
    const operations = deltas.flatMap(delta => delta.operations);
    
    // Simplified implementation - would need comprehensive diff algorithm
    const cellDiffs: ICellDiff[] = [];
    const metadataDiff: IMetadataDiff = {
      added: [],
      removed: [],
      modified: []
    };

    const stats: IDiffStats = {
      totalChanges: operations.length,
      cellsAdded: operations.filter(op => op.type === 'insert' && op.target === 'cell').length,
      cellsRemoved: operations.filter(op => op.type === 'delete' && op.target === 'cell').length,
      cellsModified: operations.filter(op => op.type === 'modify' && op.target === 'cell').length,
      linesAdded: 0, // Would be calculated from text diffs
      linesRemoved: 0,
      changePercentage: 0 // Would be calculated based on content changes
    };

    return {
      fromVersion,
      toVersion,
      operations,
      cellDiffs,
      metadataDiff,
      stats
    };
  }

  /**
   * Infer change type from operations
   */
  private _inferChangeType(operations: IChangeOperation[]): ICollaborativeChange['type'] {
    if (operations.some(op => op.type === 'insert' && op.target === 'cell')) {
      return 'cell-insert';
    }
    if (operations.some(op => op.type === 'delete' && op.target === 'cell')) {
      return 'cell-delete';
    }
    if (operations.some(op => op.target === 'metadata')) {
      return 'metadata-change';
    }
    return 'cell-modify';
  }

  /**
   * Generate change description from operations
   */
  private _generateChangeDescription(operations: IChangeOperation[]): string {
    if (operations.length === 0) {
      return 'No changes';
    }

    const typeCounts = new Map<string, number>();
    operations.forEach(op => {
      const key = `${op.type}-${op.target}`;
      typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
    });

    const descriptions: string[] = [];
    typeCounts.forEach((count, type) => {
      descriptions.push(`${count} ${type}`);
    });

    return descriptions.join(', ');
  }

  /**
   * Extract affected cell IDs from operations
   */
  private _extractAffectedCells(operations: IChangeOperation[]): string[] {
    const cellIds = new Set<string>();
    operations.forEach(op => {
      if (op.cellId) {
        cellIds.add(op.cellId);
      }
    });
    return Array.from(cellIds);
  }
}

/**
 * Default implementation of Version Manager
 */
export class DefaultVersionManager implements IVersionManager {
  private _isDisposed = false;
  private _versions = new Map<string, IVersionSnapshot>();
  private _deltas = new Map<string, IChangeDelta>();
  private _retentionPolicy: IRetentionPolicy = {};

  constructor() {
    // Initialize with default retention policy
    this.setRetentionPolicy({
      maxVersions: 100,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      keepCriteria: {
        manualSnapshots: true,
        checkpoints: true,
        labeledVersions: true,
        recentVersions: 10
      },
      compression: {
        enableDeltaCompression: true,
        compressOldSnapshots: true,
        compressionThreshold: 1024 * 1024 // 1MB
      }
    });
  }

  /**
   * Whether the manager has been disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Store a compressed version snapshot
   */
  async storeVersion(snapshot: IVersionSnapshot): Promise<string> {
    if (this._isDisposed) {
      throw new Error('VersionManager has been disposed');
    }

    this._versions.set(snapshot.id, snapshot);
    await this._applyRetentionPolicy();
    return snapshot.id;
  }

  /**
   * Retrieve a version snapshot by ID
   */
  async retrieveVersion(versionId: string): Promise<IVersionSnapshot | null> {
    if (this._isDisposed) {
      throw new Error('VersionManager has been disposed');
    }

    return this._versions.get(versionId) || null;
  }

  /**
   * Store a change delta
   */
  async storeDelta(delta: IChangeDelta): Promise<void> {
    if (this._isDisposed) {
      throw new Error('VersionManager has been disposed');
    }

    this._deltas.set(delta.id, delta);
  }

  /**
   * Retrieve compressed deltas between versions
   */
  async getDeltas(fromVersionId: string, toVersionId: string): Promise<IChangeDelta[]> {
    if (this._isDisposed) {
      throw new Error('VersionManager has been disposed');
    }

    const deltas: IChangeDelta[] = [];
    
    for (const delta of this._deltas.values()) {
      if (delta.fromVersionId === fromVersionId && delta.toVersionId === toVersionId) {
        deltas.push(delta);
      }
    }

    return deltas.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Compress and optimize stored history
   */
  async compressHistory(): Promise<void> {
    if (this._isDisposed) {
      throw new Error('VersionManager has been disposed');
    }

    // Clear all data for now - in real implementation would compress
    this._versions.clear();
    this._deltas.clear();
  }

  /**
   * Get version metadata without full content
   */
  async getVersionMetadata(versionId: string): Promise<IVersionMetadata | null> {
    if (this._isDisposed) {
      throw new Error('VersionManager has been disposed');
    }

    const version = this._versions.get(versionId);
    return version ? version.metadata : null;
  }

  /**
   * Bulk retrieve multiple versions efficiently
   */
  async retrieveVersions(versionIds: string[]): Promise<Map<string, IVersionSnapshot>> {
    if (this._isDisposed) {
      throw new Error('VersionManager has been disposed');
    }

    const result = new Map<string, IVersionSnapshot>();
    
    for (const versionId of versionIds) {
      const version = this._versions.get(versionId);
      if (version) {
        result.set(versionId, version);
      }
    }

    return result;
  }

  /**
   * Set retention policy for automatic cleanup
   */
  setRetentionPolicy(policy: IRetentionPolicy): void {
    this._retentionPolicy = { ...this._retentionPolicy, ...policy };
  }

  /**
   * Get storage usage information
   */
  async getStorageUsage(): Promise<IStorageUsage> {
    if (this._isDisposed) {
      throw new Error('VersionManager has been disposed');
    }

    let totalSnapshots = 0;
    let totalDeltas = 0;

    for (const version of this._versions.values()) {
      totalSnapshots += version.size;
    }

    for (const delta of this._deltas.values()) {
      totalDeltas += delta.compressedSize;
    }

    const totalUsed = totalSnapshots + totalDeltas;

    return {
      totalUsed,
      breakdown: {
        snapshots: totalSnapshots,
        deltas: totalDeltas,
        metadata: Math.floor(totalUsed * 0.05), // Estimate 5% for metadata
        indexes: Math.floor(totalUsed * 0.02) // Estimate 2% for indexes
      },
      potentialSavings: Math.floor(totalUsed * 0.3), // Estimate 30% potential savings
      efficiencyScore: 0.8 // Placeholder efficiency score
    };
  }

  /**
   * Dispose of the manager and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._versions.clear();
    this._deltas.clear();
    this._isDisposed = true;
  }

  /**
   * Apply retention policy to clean up old versions
   */
  private async _applyRetentionPolicy(): Promise<void> {
    const policy = this._retentionPolicy;
    
    if (!policy.maxVersions && !policy.maxAge && !policy.maxStorageSize) {
      return;
    }

    const versions = Array.from(this._versions.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const toRemove: string[] = [];
    const now = Date.now();

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      const age = now - version.timestamp.getTime();
      
      // Check if version should be kept based on criteria
      if (policy.keepCriteria) {
        if (policy.keepCriteria.manualSnapshots && !version.isAutoSnapshot) {
          continue;
        }
        if (policy.keepCriteria.labeledVersions && version.label) {
          continue;
        }
        if (policy.keepCriteria.recentVersions && i < policy.keepCriteria.recentVersions) {
          continue;
        }
      }

      // Check removal criteria
      if (policy.maxVersions && i >= policy.maxVersions) {
        toRemove.push(version.id);
      } else if (policy.maxAge && age > policy.maxAge) {
        toRemove.push(version.id);
      }
    }

    // Remove selected versions
    for (const versionId of toRemove) {
      this._versions.delete(versionId);
      
      // Also remove related deltas
      for (const [deltaId, delta] of this._deltas.entries()) {
        if (delta.fromVersionId === versionId || delta.toVersionId === versionId) {
          this._deltas.delete(deltaId);
        }
      }
    }
  }
}

/**
 * Create a new history tracker instance
 */
export function createHistoryTracker(
  provider: IYjsNotebookProvider,
  versionManager?: IVersionManager
): IHistoryTracker {
  return new HistoryTracker(provider, versionManager);
}

/**
 * Create a new version manager instance
 */
export function createVersionManager(): IVersionManager {
  return new DefaultVersionManager();
}