// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISignal, Signal } from '@lumino/signaling';
import { JSONObject, JSONValue, PartialJSONObject } from '@lumino/coreutils';
import { IDisposable, DisposableDelegate } from '@lumino/disposable';
import * as Y from 'yjs';
import { encodeStateAsUpdate, applyUpdate } from 'yjs';
import { INotebookModel } from '@jupyterlab/notebook';

/**
 * Interface for a change record in the collaborative history.
 */
export interface IChangeRecord {
  /**
   * Unique identifier for the change.
   */
  readonly id: string;

  /**
   * Timestamp when the change was created.
   */
  readonly timestamp: Date;

  /**
   * User ID who made the change.
   */
  readonly userId: string;

  /**
   * Display name of the user who made the change.
   */
  readonly userName: string;

  /**
   * Type of change made.
   */
  readonly changeType: 'cell-added' | 'cell-deleted' | 'cell-modified' | 'cell-moved' | 'metadata-changed' | 'notebook-modified';

  /**
   * Cell ID affected by the change (if applicable).
   */
  readonly cellId?: string;

  /**
   * Description of the change.
   */
  readonly description: string;

  /**
   * Yjs update data for this change.
   */
  readonly updateData: Uint8Array;

  /**
   * Size of the change in bytes.
   */
  readonly changeSize: number;

  /**
   * Additional metadata about the change.
   */
  readonly metadata?: JSONObject;
}

/**
 * Interface for history snapshot containing document state.
 */
export interface IHistorySnapshot {
  /**
   * Unique identifier for the snapshot.
   */
  readonly id: string;

  /**
   * Timestamp when the snapshot was created.
   */
  readonly timestamp: Date;

  /**
   * Document state at the time of snapshot.
   */
  readonly documentState: Uint8Array;

  /**
   * User who triggered the snapshot.
   */
  readonly userId: string;

  /**
   * Snapshot type.
   */
  readonly snapshotType: 'manual' | 'auto' | 'checkpoint' | 'recovery';

  /**
   * Description of the snapshot.
   */
  readonly description: string;

  /**
   * Associated metadata.
   */
  readonly metadata?: JSONObject;
}

/**
 * Configuration interface for history retention policies.
 */
export interface IHistoryRetentionConfig {
  /**
   * Maximum age of history records in days.
   */
  maxAgeDays: number;

  /**
   * Maximum number of history records to keep.
   */
  maxRecords: number;

  /**
   * Maximum number of snapshots to keep.
   */
  maxSnapshots: number;

  /**
   * Interval for automatic cleanup in minutes.
   */
  cleanupIntervalMinutes: number;

  /**
   * Whether to compress old history records.
   */
  compressOldRecords: boolean;

  /**
   * Age threshold for compression in days.
   */
  compressionThresholdDays: number;
}

/**
 * Interface for history playback controls.
 */
export interface IHistoryPlayback {
  /**
   * Current playback position.
   */
  readonly currentPosition: number;

  /**
   * Total number of changes available for playback.
   */
  readonly totalChanges: number;

  /**
   * Whether playback is currently active.
   */
  readonly isPlaying: boolean;

  /**
   * Playback speed multiplier.
   */
  playbackSpeed: number;

  /**
   * Start playback from a specific position.
   */
  play(fromPosition?: number): void;

  /**
   * Pause playback.
   */
  pause(): void;

  /**
   * Stop playback and return to current state.
   */
  stop(): void;

  /**
   * Step forward one change.
   */
  stepForward(): void;

  /**
   * Step backward one change.
   */
  stepBackward(): void;

  /**
   * Jump to a specific position.
   */
  jumpTo(position: number): void;

  /**
   * Get the document state at a specific position.
   */
  getStateAt(position: number): Promise<Uint8Array>;
}

/**
 * Event arguments for history changes.
 */
export interface IHistoryChangedArgs {
  /**
   * Type of history change.
   */
  readonly type: 'record-added' | 'snapshot-created' | 'records-cleaned' | 'playback-position-changed';

  /**
   * The change record or snapshot involved.
   */
  readonly data?: IChangeRecord | IHistorySnapshot;

  /**
   * Additional context information.
   */
  readonly context?: JSONObject;
}

/**
 * Interface for the collaborative history provider that integrates with Yjs.
 */
export interface ICollabHistoryProvider extends IDisposable {
  /**
   * Whether the history tracking is enabled.
   */
  readonly isEnabled: boolean;

  /**
   * Current retention configuration.
   */
  readonly retentionConfig: IHistoryRetentionConfig;

  /**
   * Signal emitted when history changes.
   */
  readonly historyChanged: ISignal<this, IHistoryChangedArgs>;

  /**
   * All change records in chronological order.
   */
  readonly changeRecords: ReadonlyArray<IChangeRecord>;

  /**
   * All snapshots in chronological order.
   */
  readonly snapshots: ReadonlyArray<IHistorySnapshot>;

  /**
   * Current playback controller.
   */
  readonly playback: IHistoryPlayback | null;

  /**
   * Start tracking changes for the given Yjs document.
   */
  startTracking(ydoc: Y.Doc, userId: string, userName: string): void;

  /**
   * Stop tracking changes.
   */
  stopTracking(): void;

  /**
   * Create a manual snapshot of the current document state.
   */
  createSnapshot(description: string, snapshotType?: IHistorySnapshot['snapshotType']): Promise<IHistorySnapshot>;

  /**
   * Get change records within a time range.
   */
  getChangeRecords(startTime?: Date, endTime?: Date): IChangeRecord[];

  /**
   * Get snapshots within a time range.
   */
  getSnapshots(startTime?: Date, endTime?: Date): IHistorySnapshot[];

  /**
   * Get changes made by a specific user.
   */
  getChangesByUser(userId: string): IChangeRecord[];

  /**
   * Get changes affecting a specific cell.
   */
  getChangesByCell(cellId: string): IChangeRecord[];

  /**
   * Restore document to a specific snapshot.
   */
  restoreToSnapshot(snapshotId: string): Promise<void>;

  /**
   * Restore document to a specific change position.
   */
  restoreToPosition(position: number): Promise<void>;

  /**
   * Create a history playback controller.
   */
  createPlayback(): IHistoryPlayback;

  /**
   * Update retention configuration.
   */
  updateRetentionConfig(config: Partial<IHistoryRetentionConfig>): void;

  /**
   * Manually trigger cleanup of old records.
   */
  cleanup(): Promise<number>;

  /**
   * Export history data for backup or analysis.
   */
  exportHistory(format: 'json' | 'binary'): Promise<Uint8Array | JSONObject>;

  /**
   * Import history data from backup.
   */
  importHistory(data: Uint8Array | JSONObject, format: 'json' | 'binary'): Promise<void>;

  /**
   * Get statistics about the history.
   */
  getStatistics(): {
    totalRecords: number;
    totalSnapshots: number;
    totalSize: number;
    oldestRecord?: Date;
    newestRecord?: Date;
    userContributions: { [userId: string]: number };
  };
}

/**
 * Default configuration for history retention.
 */
export const DEFAULT_RETENTION_CONFIG: IHistoryRetentionConfig = {
  maxAgeDays: 30,
  maxRecords: 10000,
  maxSnapshots: 100,
  cleanupIntervalMinutes: 60,
  compressOldRecords: true,
  compressionThresholdDays: 7
};

/**
 * Implementation of the collaborative history tracking system.
 * 
 * This class captures Yjs update events and maintains a comprehensive
 * history of collaborative editing sessions with user attribution,
 * configurable retention policies, and playback capabilities.
 */
export class CollabHistoryProvider implements ICollabHistoryProvider {
  private _isEnabled = false;
  private _retentionConfig: IHistoryRetentionConfig;
  private _historyChanged = new Signal<this, IHistoryChangedArgs>(this);
  private _changeRecords: IChangeRecord[] = [];
  private _snapshots: IHistorySnapshot[] = [];
  private _ydoc: Y.Doc | null = null;
  private _currentUserId = '';
  private _currentUserName = '';
  private _updateHandler: ((update: Uint8Array, origin: any) => void) | null = null;
  private _cleanupTimer: any = null;
  private _playback: HistoryPlayback | null = null;
  private _isDisposed = false;
  private _changeIdCounter = 0;
  private _snapshotIdCounter = 0;

  /**
   * Construct a new collaborative history provider.
   */
  constructor(retentionConfig: Partial<IHistoryRetentionConfig> = {}) {
    this._retentionConfig = { ...DEFAULT_RETENTION_CONFIG, ...retentionConfig };
    this._scheduleCleanup();
  }

  /**
   * Whether the history tracking is enabled.
   */
  get isEnabled(): boolean {
    return this._isEnabled;
  }

  /**
   * Current retention configuration.
   */
  get retentionConfig(): IHistoryRetentionConfig {
    return { ...this._retentionConfig };
  }

  /**
   * Signal emitted when history changes.
   */
  get historyChanged(): ISignal<this, IHistoryChangedArgs> {
    return this._historyChanged;
  }

  /**
   * All change records in chronological order.
   */
  get changeRecords(): ReadonlyArray<IChangeRecord> {
    return [...this._changeRecords];
  }

  /**
   * All snapshots in chronological order.
   */
  get snapshots(): ReadonlyArray<IHistorySnapshot> {
    return [...this._snapshots];
  }

  /**
   * Current playback controller.
   */
  get playback(): IHistoryPlayback | null {
    return this._playback;
  }

  /**
   * Start tracking changes for the given Yjs document.
   */
  startTracking(ydoc: Y.Doc, userId: string, userName: string): void {
    if (this._isDisposed) {
      throw new Error('Cannot start tracking on disposed history provider');
    }

    this.stopTracking();

    this._ydoc = ydoc;
    this._currentUserId = userId;
    this._currentUserName = userName;

    // Create update handler to capture Yjs changes
    this._updateHandler = (update: Uint8Array, origin: any) => {
      this._onYjsUpdate(update, origin);
    };

    // Listen for Yjs document updates
    this._ydoc.on('update', this._updateHandler);

    this._isEnabled = true;

    console.info('Collaborative history tracking started for user:', userName);
  }

  /**
   * Stop tracking changes.
   */
  stopTracking(): void {
    if (this._ydoc && this._updateHandler) {
      this._ydoc.off('update', this._updateHandler);
    }

    this._ydoc = null;
    this._updateHandler = null;
    this._isEnabled = false;

    if (this._playback) {
      this._playback.stop();
      this._playback = null;
    }

    console.info('Collaborative history tracking stopped');
  }

  /**
   * Create a manual snapshot of the current document state.
   */
  async createSnapshot(
    description: string, 
    snapshotType: IHistorySnapshot['snapshotType'] = 'manual'
  ): Promise<IHistorySnapshot> {
    if (!this._ydoc) {
      throw new Error('Cannot create snapshot: no document being tracked');
    }

    const snapshot: IHistorySnapshot = {
      id: `snapshot-${++this._snapshotIdCounter}-${Date.now()}`,
      timestamp: new Date(),
      documentState: encodeStateAsUpdate(this._ydoc),
      userId: this._currentUserId,
      snapshotType,
      description,
      metadata: {
        totalChanges: this._changeRecords.length,
        documentSize: this._ydoc.share.size
      }
    };

    this._snapshots.push(snapshot);
    this._snapshots.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Enforce snapshot retention limits
    if (this._snapshots.length > this._retentionConfig.maxSnapshots) {
      const removed = this._snapshots.splice(0, this._snapshots.length - this._retentionConfig.maxSnapshots);
      console.debug(`Removed ${removed.length} old snapshots due to retention limit`);
    }

    this._historyChanged.emit({
      type: 'snapshot-created',
      data: snapshot
    });

    console.debug('Created snapshot:', snapshot.id, description);
    return snapshot;
  }

  /**
   * Get change records within a time range.
   */
  getChangeRecords(startTime?: Date, endTime?: Date): IChangeRecord[] {
    let records = this._changeRecords;

    if (startTime) {
      records = records.filter(record => record.timestamp >= startTime);
    }

    if (endTime) {
      records = records.filter(record => record.timestamp <= endTime);
    }

    return [...records];
  }

  /**
   * Get snapshots within a time range.
   */
  getSnapshots(startTime?: Date, endTime?: Date): IHistorySnapshot[] {
    let snapshots = this._snapshots;

    if (startTime) {
      snapshots = snapshots.filter(snapshot => snapshot.timestamp >= startTime);
    }

    if (endTime) {
      snapshots = snapshots.filter(snapshot => snapshot.timestamp <= endTime);
    }

    return [...snapshots];
  }

  /**
   * Get changes made by a specific user.
   */
  getChangesByUser(userId: string): IChangeRecord[] {
    return this._changeRecords.filter(record => record.userId === userId);
  }

  /**
   * Get changes affecting a specific cell.
   */
  getChangesByCell(cellId: string): IChangeRecord[] {
    return this._changeRecords.filter(record => record.cellId === cellId);
  }

  /**
   * Restore document to a specific snapshot.
   */
  async restoreToSnapshot(snapshotId: string): Promise<void> {
    if (!this._ydoc) {
      throw new Error('Cannot restore: no document being tracked');
    }

    const snapshot = this._snapshots.find(s => s.id === snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    // Temporarily stop tracking to prevent recording the restoration as a change
    const wasEnabled = this._isEnabled;
    this.stopTracking();

    try {
      // Clear current document state
      this._ydoc.destroy();
      this._ydoc = new Y.Doc();

      // Apply snapshot state
      applyUpdate(this._ydoc, snapshot.documentState);

      console.info(`Restored document to snapshot: ${snapshotId}`);

      // Create a restoration record
      await this.createSnapshot(
        `Restored to snapshot: ${snapshot.description}`,
        'recovery'
      );
    } finally {
      if (wasEnabled) {
        this.startTracking(this._ydoc, this._currentUserId, this._currentUserName);
      }
    }
  }

  /**
   * Restore document to a specific change position.
   */
  async restoreToPosition(position: number): Promise<void> {
    if (!this._ydoc) {
      throw new Error('Cannot restore: no document being tracked');
    }

    if (position < 0 || position >= this._changeRecords.length) {
      throw new Error(`Invalid position: ${position}`);
    }

    // Find the nearest snapshot before the target position
    let baseSnapshot: IHistorySnapshot | null = null;
    let basePosition = -1;

    for (let i = this._snapshots.length - 1; i >= 0; i--) {
      const snapshot = this._snapshots[i];
      const snapshotPosition = this._findPositionForTimestamp(snapshot.timestamp);
      if (snapshotPosition <= position) {
        baseSnapshot = snapshot;
        basePosition = snapshotPosition;
        break;
      }
    }

    // Temporarily stop tracking
    const wasEnabled = this._isEnabled;
    this.stopTracking();

    try {
      // Start from base snapshot or empty document
      if (baseSnapshot) {
        this._ydoc.destroy();
        this._ydoc = new Y.Doc();
        applyUpdate(this._ydoc, baseSnapshot.documentState);
      } else {
        this._ydoc.destroy();
        this._ydoc = new Y.Doc();
        basePosition = -1;
      }

      // Apply changes from base position to target position
      for (let i = basePosition + 1; i <= position; i++) {
        const change = this._changeRecords[i];
        if (change) {
          applyUpdate(this._ydoc, change.updateData);
        }
      }

      console.info(`Restored document to position: ${position}`);

      // Create a restoration record
      await this.createSnapshot(
        `Restored to position ${position}`,
        'recovery'
      );
    } finally {
      if (wasEnabled) {
        this.startTracking(this._ydoc, this._currentUserId, this._currentUserName);
      }
    }
  }

  /**
   * Create a history playback controller.
   */
  createPlayback(): IHistoryPlayback {
    if (this._playback) {
      this._playback.stop();
    }

    this._playback = new HistoryPlayback(this);
    return this._playback;
  }

  /**
   * Update retention configuration.
   */
  updateRetentionConfig(config: Partial<IHistoryRetentionConfig>): void {
    this._retentionConfig = { ...this._retentionConfig, ...config };
    this._scheduleCleanup();
    console.debug('Updated history retention configuration:', this._retentionConfig);
  }

  /**
   * Manually trigger cleanup of old records.
   */
  async cleanup(): Promise<number> {
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - this._retentionConfig.maxAgeDays * 24 * 60 * 60 * 1000);

    let removedCount = 0;

    // Remove old change records
    const originalRecordCount = this._changeRecords.length;
    this._changeRecords = this._changeRecords.filter(record => record.timestamp >= cutoffTime);
    
    // Also enforce max records limit
    if (this._changeRecords.length > this._retentionConfig.maxRecords) {
      const excess = this._changeRecords.length - this._retentionConfig.maxRecords;
      this._changeRecords.splice(0, excess);
      removedCount += excess;
    }

    removedCount += originalRecordCount - this._changeRecords.length;

    // Remove old snapshots
    const originalSnapshotCount = this._snapshots.length;
    this._snapshots = this._snapshots.filter(snapshot => snapshot.timestamp >= cutoffTime);
    
    // Also enforce max snapshots limit
    if (this._snapshots.length > this._retentionConfig.maxSnapshots) {
      const excess = this._snapshots.length - this._retentionConfig.maxSnapshots;
      this._snapshots.splice(0, excess);
    }

    removedCount += originalSnapshotCount - this._snapshots.length;

    if (removedCount > 0) {
      this._historyChanged.emit({
        type: 'records-cleaned',
        context: { removedCount, cutoffTime: cutoffTime.toISOString() }
      });

      console.debug(`Cleaned up ${removedCount} old history items`);
    }

    return removedCount;
  }

  /**
   * Export history data for backup or analysis.
   */
  async exportHistory(format: 'json' | 'binary'): Promise<Uint8Array | JSONObject> {
    const historyData = {
      version: '1.0',
      exportTimestamp: new Date().toISOString(),
      retentionConfig: this._retentionConfig,
      changeRecords: this._changeRecords.map(record => ({
        ...record,
        updateData: Array.from(record.updateData) // Convert Uint8Array to array for JSON
      })),
      snapshots: this._snapshots.map(snapshot => ({
        ...snapshot,
        documentState: Array.from(snapshot.documentState) // Convert Uint8Array to array for JSON
      }))
    };

    if (format === 'json') {
      return historyData;
    } else {
      // Binary format using MessagePack or similar could be implemented here
      // For now, return JSON encoded as UTF-8 bytes
      const jsonStr = JSON.stringify(historyData);
      return new TextEncoder().encode(jsonStr);
    }
  }

  /**
   * Import history data from backup.
   */
  async importHistory(data: Uint8Array | JSONObject, format: 'json' | 'binary'): Promise<void> {
    let historyData: any;

    if (format === 'binary') {
      // Decode binary data
      const jsonStr = new TextDecoder().decode(data as Uint8Array);
      historyData = JSON.parse(jsonStr);
    } else {
      historyData = data as JSONObject;
    }

    // Validate and import data
    if (!historyData.version || !historyData.changeRecords || !historyData.snapshots) {
      throw new Error('Invalid history data format');
    }

    // Convert arrays back to Uint8Arrays
    const changeRecords = historyData.changeRecords.map((record: any) => ({
      ...record,
      timestamp: new Date(record.timestamp),
      updateData: new Uint8Array(record.updateData)
    }));

    const snapshots = historyData.snapshots.map((snapshot: any) => ({
      ...snapshot,
      timestamp: new Date(snapshot.timestamp),
      documentState: new Uint8Array(snapshot.documentState)
    }));

    // Merge with existing data
    this._changeRecords = [...this._changeRecords, ...changeRecords];
    this._snapshots = [...this._snapshots, ...snapshots];

    // Sort by timestamp
    this._changeRecords.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    this._snapshots.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Update counters
    this._changeIdCounter = Math.max(this._changeIdCounter, ...changeRecords.map((r: any) => {
      const match = r.id.match(/change-(\d+)/);
      return match ? parseInt(match[1]) : 0;
    }));

    this._snapshotIdCounter = Math.max(this._snapshotIdCounter, ...snapshots.map((s: any) => {
      const match = s.id.match(/snapshot-(\d+)/);
      return match ? parseInt(match[1]) : 0;
    }));

    console.info(`Imported ${changeRecords.length} change records and ${snapshots.length} snapshots`);
  }

  /**
   * Get statistics about the history.
   */
  getStatistics(): {
    totalRecords: number;
    totalSnapshots: number;
    totalSize: number;
    oldestRecord?: Date;
    newestRecord?: Date;
    userContributions: { [userId: string]: number };
  } {
    const userContributions: { [userId: string]: number } = {};
    let totalSize = 0;

    // Calculate user contributions and total size
    this._changeRecords.forEach(record => {
      userContributions[record.userId] = (userContributions[record.userId] || 0) + 1;
      totalSize += record.changeSize;
    });

    this._snapshots.forEach(snapshot => {
      totalSize += snapshot.documentState.length;
    });

    return {
      totalRecords: this._changeRecords.length,
      totalSnapshots: this._snapshots.length,
      totalSize,
      oldestRecord: this._changeRecords.length > 0 ? this._changeRecords[0].timestamp : undefined,
      newestRecord: this._changeRecords.length > 0 ? this._changeRecords[this._changeRecords.length - 1].timestamp : undefined,
      userContributions
    };
  }

  /**
   * Dispose of the history provider and clean up resources.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this.stopTracking();

    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    if (this._playback) {
      this._playback.stop();
      this._playback = null;
    }

    this._changeRecords = [];
    this._snapshots = [];
    this._isDisposed = true;

    console.debug('Collaborative history provider disposed');
  }

  /**
   * Handle Yjs document updates and create change records.
   */
  private _onYjsUpdate(update: Uint8Array, origin: any): void {
    if (!this._isEnabled || this._isDisposed) {
      return;
    }

    // Skip updates that we generated ourselves during restoration
    if (origin === 'history-restore') {
      return;
    }

    try {
      const changeType = this._analyzeChangeType(update);
      const description = this._generateChangeDescription(changeType, update);
      const cellId = this._extractAffectedCellId(update);

      const changeRecord: IChangeRecord = {
        id: `change-${++this._changeIdCounter}-${Date.now()}`,
        timestamp: new Date(),
        userId: this._currentUserId,
        userName: this._currentUserName,
        changeType,
        cellId,
        description,
        updateData: new Uint8Array(update),
        changeSize: update.length,
        metadata: {
          origin: origin ? String(origin) : 'unknown',
          updateSize: update.length
        }
      };

      this._changeRecords.push(changeRecord);

      // Emit change event
      this._historyChanged.emit({
        type: 'record-added',
        data: changeRecord
      });

      // Auto-create snapshots at regular intervals
      if (this._changeRecords.length % 100 === 0) {
        this.createSnapshot(`Auto-snapshot at ${this._changeRecords.length} changes`, 'auto');
      }

      console.debug('Recorded change:', changeRecord.id, description);
    } catch (error) {
      console.warn('Failed to record history change:', error);
    }
  }

  /**
   * Analyze the type of change from Yjs update data.
   */
  private _analyzeChangeType(update: Uint8Array): IChangeRecord['changeType'] {
    // This is a simplified analysis - in a real implementation,
    // we would decode the Yjs update to determine the specific change type
    if (update.length < 50) {
      return 'metadata-changed';
    } else if (update.length < 200) {
      return 'cell-modified';
    } else {
      return 'notebook-modified';
    }
  }

  /**
   * Generate a human-readable description of the change.
   */
  private _generateChangeDescription(changeType: IChangeRecord['changeType'], update: Uint8Array): string {
    const size = update.length;
    
    switch (changeType) {
      case 'cell-added':
        return 'Added new cell';
      case 'cell-deleted':
        return 'Deleted cell';
      case 'cell-modified':
        return `Modified cell content (${size} bytes)`;
      case 'cell-moved':
        return 'Moved cell';
      case 'metadata-changed':
        return 'Changed metadata';
      case 'notebook-modified':
        return `Modified notebook (${size} bytes)`;
      default:
        return `Unknown change (${size} bytes)`;
    }
  }

  /**
   * Extract the cell ID affected by the change (if applicable).
   */
  private _extractAffectedCellId(update: Uint8Array): string | undefined {
    // This would require decoding the Yjs update data to extract cell information
    // For now, return undefined as we would need the full Yjs parsing logic
    return undefined;
  }

  /**
   * Find the position of a change record for a given timestamp.
   */
  private _findPositionForTimestamp(timestamp: Date): number {
    for (let i = 0; i < this._changeRecords.length; i++) {
      if (this._changeRecords[i].timestamp <= timestamp) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Schedule automatic cleanup based on retention configuration.
   */
  private _scheduleCleanup(): void {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }

    this._cleanupTimer = setInterval(() => {
      this.cleanup().catch(error => {
        console.warn('Auto-cleanup failed:', error);
      });
    }, this._retentionConfig.cleanupIntervalMinutes * 60 * 1000);
  }
}

/**
 * Implementation of history playback functionality.
 */
class HistoryPlayback implements IHistoryPlayback {
  private _historyProvider: CollabHistoryProvider;
  private _currentPosition = -1;
  private _isPlaying = false;
  private _playbackSpeed = 1.0;
  private _playbackTimer: any = null;

  constructor(historyProvider: CollabHistoryProvider) {
    this._historyProvider = historyProvider;
    this._currentPosition = historyProvider.changeRecords.length - 1;
  }

  /**
   * Current playback position.
   */
  get currentPosition(): number {
    return this._currentPosition;
  }

  /**
   * Total number of changes available for playback.
   */
  get totalChanges(): number {
    return this._historyProvider.changeRecords.length;
  }

  /**
   * Whether playback is currently active.
   */
  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * Playback speed multiplier.
   */
  get playbackSpeed(): number {
    return this._playbackSpeed;
  }

  set playbackSpeed(speed: number) {
    this._playbackSpeed = Math.max(0.1, Math.min(10.0, speed));
  }

  /**
   * Start playback from a specific position.
   */
  play(fromPosition?: number): void {
    if (fromPosition !== undefined) {
      this._currentPosition = Math.max(-1, Math.min(this.totalChanges - 1, fromPosition));
    }

    this._isPlaying = true;
    this._scheduleNextStep();
  }

  /**
   * Pause playback.
   */
  pause(): void {
    this._isPlaying = false;
    if (this._playbackTimer) {
      clearTimeout(this._playbackTimer);
      this._playbackTimer = null;
    }
  }

  /**
   * Stop playback and return to current state.
   */
  stop(): void {
    this.pause();
    this._currentPosition = this.totalChanges - 1;
    this._emitPositionChanged();
  }

  /**
   * Step forward one change.
   */
  stepForward(): void {
    if (this._currentPosition < this.totalChanges - 1) {
      this._currentPosition++;
      this._emitPositionChanged();
    }
  }

  /**
   * Step backward one change.
   */
  stepBackward(): void {
    if (this._currentPosition > -1) {
      this._currentPosition--;
      this._emitPositionChanged();
    }
  }

  /**
   * Jump to a specific position.
   */
  jumpTo(position: number): void {
    this._currentPosition = Math.max(-1, Math.min(this.totalChanges - 1, position));
    this._emitPositionChanged();
  }

  /**
   * Get the document state at a specific position.
   */
  async getStateAt(position: number): Promise<Uint8Array> {
    if (position < -1 || position >= this.totalChanges) {
      throw new Error(`Invalid position: ${position}`);
    }

    // This would reconstruct the document state at the given position
    // For now, return empty state
    return new Uint8Array();
  }

  /**
   * Schedule the next playback step.
   */
  private _scheduleNextStep(): void {
    if (!this._isPlaying) {
      return;
    }

    if (this._currentPosition >= this.totalChanges - 1) {
      this.pause();
      return;
    }

    const delay = 1000 / this._playbackSpeed; // Base delay of 1 second per step
    this._playbackTimer = setTimeout(() => {
      this.stepForward();
      this._scheduleNextStep();
    }, delay);
  }

  /**
   * Emit position changed event.
   */
  private _emitPositionChanged(): void {
    (this._historyProvider as any)._historyChanged.emit({
      type: 'playback-position-changed',
      context: { position: this._currentPosition }
    });
  }
}

/**
 * Utility function to create a collaborative history provider.
 */
export function createCollabHistoryProvider(
  retentionConfig?: Partial<IHistoryRetentionConfig>
): ICollabHistoryProvider {
  return new CollabHistoryProvider(retentionConfig);
}

/**
 * Utility function to create a disposable delegate for history tracking.
 */
export function createHistoryTrackingDelegate(
  historyProvider: ICollabHistoryProvider,
  ydoc: Y.Doc,
  userId: string,
  userName: string
): IDisposable {
  historyProvider.startTracking(ydoc, userId, userName);
  
  return new DisposableDelegate(() => {
    historyProvider.stopTracking();
  });
}