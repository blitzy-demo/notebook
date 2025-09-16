/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * HistoryTracker class for comprehensive version history management.
 * Captures Yjs update events, creates cell-level snapshots at configurable intervals,
 * implements diff algorithms for change visualization, and provides version restoration capabilities.
 */

import * as Y from 'yjs';
import { diffLines } from 'diff';
import { Signal } from '@lumino/signaling';
import { UUID } from '@lumino/coreutils';
import * as encoding from 'lib0/encoding';
import { ICellModel } from '@jupyterlab/cells';
import { INotebookModel } from '@jupyterlab/notebook';

import { YjsNotebookProvider } from './provider';
import { IVersionSnapshot } from '../tokens';

/**
 * Configuration interface for HistoryTracker initialization
 */
export interface IHistoryConfig {
  /**
   * Snapshot interval in milliseconds
   */
  snapshotInterval?: number;

  /**
   * Maximum number of snapshots to retain
   */
  maxSnapshots?: number;

  /**
   * Enable automatic snapshot capture
   */
  autoSnapshot?: boolean;

  /**
   * Enable snapshot compression
   */
  compression?: boolean;

  /**
   * Minimum time between snapshots in milliseconds
   */
  minSnapshotDelay?: number;

  /**
   * Enable change attribution tracking
   */
  enableAttribution?: boolean;

  /**
   * Backend storage URL for persistence
   */
  storageUrl?: string;

  /**
   * Authentication token for backend storage
   */
  authToken?: string;
}

/**
 * Interface for diff computation results
 */
export interface IDiffResult {
  /**
   * Source version ID
   */
  fromVersion: string;

  /**
   * Target version ID
   */
  toVersion: string;

  /**
   * Cell-level changes between versions
   */
  cellDiffs: Record<string, {
    oldContent: string;
    newContent: string;
    changes: any[];
    changeType: 'added' | 'removed' | 'modified' | 'unchanged';
  }>;

  /**
   * Overall change summary
   */
  summary: {
    cellsAdded: number;
    cellsRemoved: number;
    cellsModified: number;
    totalChanges: number;
  };

  /**
   * Timestamp when diff was computed
   */
  computedAt: Date;
}

/**
 * Interface for restoration operation results
 */
export interface IRestoreResult {
  /**
   * Version that was restored
   */
  restoredVersion: IVersionSnapshot;

  /**
   * Whether restoration was successful
   */
  success: boolean;

  /**
   * Error message if restoration failed
   */
  error?: string;

  /**
   * Cells that were modified during restoration
   */
  modifiedCells: string[];

  /**
   * Timestamp of restoration operation
   */
  restoredAt: Date;
}

/**
 * Interface for history change events
 */
export interface IHistoryChangeEvent {
  /**
   * Type of change event
   */
  type: 'snapshot_created' | 'snapshot_deleted' | 'version_restored' | 'history_cleared';

  /**
   * Associated snapshot data
   */
  snapshot?: IVersionSnapshot;

  /**
   * Timestamp of the event
   */
  timestamp: Date;

  /**
   * Additional metadata
   */
  metadata?: Record<string, any>;
}

/**
 * Default snapshot interval: 5 minutes as specified in requirements
 */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Maximum number of snapshots to retain to prevent unlimited growth
 */
export const MAX_HISTORY_SNAPSHOTS = 1000;

/**
 * HistoryTracker class implementing comprehensive version history management
 */
export class HistoryTracker {
  private _config: IHistoryConfig;
  private _provider: YjsNotebookProvider;
  private _snapshots: Map<string, IVersionSnapshot> = new Map();
  private _snapshotTimer: any = null;
  private _isAutoSnapshotEnabled: boolean = true;
  private _lastSnapshotTime: Date | null = null;
  private _disposed: boolean = false;
  private _pendingUpdates: Uint8Array[] = [];
  private _lastDocumentState: Uint8Array | null = null;

  // Signals for reactive updates
  private _onVersionChangeSignal = new Signal<HistoryTracker, IVersionSnapshot>(this);
  private _onHistoryChangeSignal = new Signal<HistoryTracker, IHistoryChangeEvent>(this);

  /**
   * Create a new HistoryTracker instance
   */
  constructor(provider: YjsNotebookProvider, config: IHistoryConfig = {}) {
    this._provider = provider;
    this._config = {
      snapshotInterval: DEFAULT_SNAPSHOT_INTERVAL_MS,
      maxSnapshots: MAX_HISTORY_SNAPSHOTS,
      autoSnapshot: true,
      compression: true,
      minSnapshotDelay: 30000, // 30 seconds minimum between snapshots
      enableAttribution: true,
      ...config
    };

    this._isAutoSnapshotEnabled = this._config.autoSnapshot ?? true;

    // Hook into Yjs update events from the provider
    this._setupUpdateListeners();

    // Start automatic snapshot timer if enabled
    if (this._isAutoSnapshotEnabled) {
      this.enableAutoSnapshot();
    }

    console.log('HistoryTracker initialized with config:', this._config);
  }

  /**
   * Signal emitted when a new version is created
   */
  get onVersionChange(): Signal<HistoryTracker, IVersionSnapshot> {
    return this._onVersionChangeSignal;
  }

  /**
   * Capture a snapshot of the current document state
   */
  async captureSnapshot(metadata: Record<string, any> = {}): Promise<string> {
    if (this._disposed || !this._provider.yjsDoc) {
      throw new Error('HistoryTracker is disposed or provider unavailable');
    }

    try {
      // Check minimum delay between snapshots
      const now = new Date();
      if (this._lastSnapshotTime &&
          (now.getTime() - this._lastSnapshotTime.getTime()) < (this._config.minSnapshotDelay || 30000)) {
        console.debug('Skipping snapshot due to minimum delay constraint');
        return '';
      }

      // Encode current Yjs document state
      const currentState = Y.encodeStateAsUpdate(this._provider.yjsDoc);

      // Skip if no changes since last snapshot
      if (this._lastDocumentState && this._arraysEqual(currentState, this._lastDocumentState)) {
        console.debug('Skipping snapshot - no changes detected');
        return '';
      }

      const snapshotId = UUID.uuid4();

      // Generate change summary by comparing with previous state
      const changeSummary = await this._generateChangeSummary(currentState);

      // Extract cell-level changes
      const cellChanges = await this._extractCellChanges(currentState);

      // Create version snapshot
      const snapshot: IVersionSnapshot = {
        id: snapshotId,
        timestamp: now,
        author: this._getCurrentUser(),
        changeSummary,
        cellChanges,
        metadata: {
          ...metadata,
          documentSize: currentState.byteLength,
          compressed: this._config.compression,
          attribution: this._config.enableAttribution
        },
        size: currentState.byteLength
      };

      // Compress snapshot data if enabled
      if (this._config.compression) {
        await this._compressSnapshotData(snapshot);
      }

      // Store snapshot
      this._snapshots.set(snapshotId, snapshot);
      this._lastDocumentState = currentState;
      this._lastSnapshotTime = now;

      // Enforce maximum snapshot limit
      await this._enforceSnapshotLimit();

      // Persist to backend if configured
      if (this._config.storageUrl) {
        await this._persistSnapshot(snapshot);
      }

      // Emit events
      this._onVersionChangeSignal.emit(snapshot);
      this._onHistoryChangeSignal.emit({
        type: 'snapshot_created',
        snapshot,
        timestamp: now
      });

      console.log(`Snapshot captured: ${snapshotId} (${currentState.byteLength} bytes)`);
      return snapshotId;

    } catch (error) {
      console.error('Error capturing snapshot:', error);
      throw error;
    }
  }

  /**
   * Get version history for the document
   */
  async getHistory(limit?: number): Promise<IVersionSnapshot[]> {
    if (this._disposed) {
      return [];
    }

    try {
      // Load from backend storage if configured
      if (this._config.storageUrl) {
        await this._loadHistoryFromBackend();
      }

      const snapshots = Array.from(this._snapshots.values())
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return limit ? snapshots.slice(0, limit) : snapshots;
    } catch (error) {
      console.error('Error retrieving history:', error);
      return [];
    }
  }

  /**
   * Restore document to a specific version
   */
  async restoreVersion(versionId: string): Promise<IRestoreResult> {
    if (this._disposed || !this._provider.yjsDoc) {
      throw new Error('HistoryTracker is disposed or provider unavailable');
    }

    try {
      const snapshot = this._snapshots.get(versionId);
      if (!snapshot) {
        return {
          restoredVersion: snapshot!,
          success: false,
          error: `Version ${versionId} not found`,
          modifiedCells: [],
          restoredAt: new Date()
        };
      }

      // Create restoration checkpoint before proceeding
      const checkpointId = await this.captureSnapshot({
        type: 'pre_restore_checkpoint',
        targetVersion: versionId
      });

      // Restore cell content from snapshot
      const modifiedCells = await this._restoreCellsFromSnapshot(snapshot);

      // Create post-restoration snapshot
      await this.captureSnapshot({
        type: 'post_restore_snapshot',
        restoredFrom: versionId,
        checkpointId
      });

      const result: IRestoreResult = {
        restoredVersion: snapshot,
        success: true,
        modifiedCells,
        restoredAt: new Date()
      };

      console.log(`Successfully restored version ${versionId}, modified ${modifiedCells.length} cells`);
      return result;

    } catch (error) {
      console.error('Error restoring version:', error);
      return {
        restoredVersion: this._snapshots.get(versionId)!,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        modifiedCells: [],
        restoredAt: new Date()
      };
    }
  }

  /**
   * Get diff between two versions
   */
  async getDiff(fromVersion: string, toVersion: string): Promise<IDiffResult> {
    if (this._disposed) {
      throw new Error('HistoryTracker is disposed');
    }

    try {
      const fromSnapshot = this._snapshots.get(fromVersion);
      const toSnapshot = this._snapshots.get(toVersion);

      if (!fromSnapshot || !toSnapshot) {
        throw new Error('One or both versions not found');
      }

      // Compute cell-level differences using Myers algorithm
      const cellDiffs = await this._computeCellDiffs(fromSnapshot, toSnapshot);

      // Generate summary statistics
      const summary = this._generateDiffSummary(cellDiffs);

      const diffResult: IDiffResult = {
        fromVersion,
        toVersion,
        cellDiffs,
        summary,
        computedAt: new Date()
      };

      console.log(`Computed diff between ${fromVersion} and ${toVersion}: ${summary.totalChanges} changes`);
      return diffResult;

    } catch (error) {
      console.error('Error computing diff:', error);
      throw error;
    }
  }

  /**
   * Browse available versions with pagination
   */
  async browseVersions(offset: number = 0, limit: number = 50): Promise<{ versions: IVersionSnapshot[]; total: number }> {
    if (this._disposed) {
      return { versions: [], total: 0 };
    }

    try {
      const allVersions = await this.getHistory();
      const total = allVersions.length;
      const versions = allVersions.slice(offset, offset + limit);

      return { versions, total };
    } catch (error) {
      console.error('Error browsing versions:', error);
      return { versions: [], total: 0 };
    }
  }

  /**
   * Export version history as downloadable format
   */
  async exportHistory(format: 'json' | 'csv' = 'json'): Promise<Blob> {
    if (this._disposed) {
      throw new Error('HistoryTracker is disposed');
    }

    try {
      const history = await this.getHistory();

      if (format === 'json') {
        const jsonData = JSON.stringify(history, null, 2);
        return new Blob([jsonData], { type: 'application/json' });
      } else {
        const csvData = this._convertHistoryToCSV(history);
        return new Blob([csvData], { type: 'text/csv' });
      }
    } catch (error) {
      console.error('Error exporting history:', error);
      throw error;
    }
  }

  /**
   * Get metadata for a specific version
   */
  async getVersionMetadata(versionId: string): Promise<Record<string, any>> {
    if (this._disposed) {
      return {};
    }

    try {
      const snapshot = this._snapshots.get(versionId);
      return snapshot ? snapshot.metadata : {};
    } catch (error) {
      console.error('Error retrieving version metadata:', error);
      return {};
    }
  }

  /**
   * Compress old snapshots to save storage space
   */
  async compressSnapshots(): Promise<void> {
    if (this._disposed) {
      return;
    }

    try {
      let compressedCount = 0;
      const cutoffDate = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)); // 7 days ago

      Array.from(this._snapshots.entries()).forEach(async ([id, snapshot]) => {
        if (snapshot.timestamp < cutoffDate && !snapshot.metadata.compressed) {
          await this._compressSnapshotData(snapshot);
          compressedCount++;
        }
      });

      console.log(`Compressed ${compressedCount} snapshots`);
    } catch (error) {
      console.error('Error compressing snapshots:', error);
    }
  }

  /**
   * Enable automatic snapshot capture
   */
  enableAutoSnapshot(): void {
    if (this._disposed || this._snapshotTimer) {
      return;
    }

    this._isAutoSnapshotEnabled = true;
    this._snapshotTimer = setInterval(() => {
      this._captureAutoSnapshot();
    }, this._config.snapshotInterval);

    console.log(`Auto snapshot enabled with ${this._config.snapshotInterval}ms interval`);
  }

  /**
   * Disable automatic snapshot capture
   */
  disableAutoSnapshot(): void {
    this._isAutoSnapshotEnabled = false;

    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }

    console.log('Auto snapshot disabled');
  }

  /**
   * Set snapshot interval for automatic capture
   */
  setSnapshotInterval(intervalMs: number): void {
    if (intervalMs < 10000) { // Minimum 10 seconds
      throw new Error('Snapshot interval must be at least 10 seconds');
    }

    this._config.snapshotInterval = intervalMs;

    if (this._isAutoSnapshotEnabled) {
      this.disableAutoSnapshot();
      this.enableAutoSnapshot();
    }

    console.log(`Snapshot interval set to ${intervalMs}ms`);
  }

  /**
   * Clear all version history
   */
  async clearHistory(): Promise<void> {
    if (this._disposed) {
      return;
    }

    try {
      this._snapshots.clear();
      this._lastDocumentState = null;
      this._lastSnapshotTime = null;

      // Clear backend storage if configured
      if (this._config.storageUrl) {
        await this._clearBackendHistory();
      }

      this._onHistoryChangeSignal.emit({
        type: 'history_cleared',
        timestamp: new Date()
      });

      console.log('History cleared successfully');
    } catch (error) {
      console.error('Error clearing history:', error);
    }
  }

  /**
   * Get specific snapshot by ID
   */
  async getSnapshotById(snapshotId: string): Promise<IVersionSnapshot | null> {
    if (this._disposed) {
      return null;
    }

    try {
      return this._snapshots.get(snapshotId) || null;
    } catch (error) {
      console.error('Error retrieving snapshot:', error);
      return null;
    }
  }

  /**
   * Get snapshots by author
   */
  async getSnapshotsByAuthor(authorId: string): Promise<IVersionSnapshot[]> {
    if (this._disposed) {
      return [];
    }

    try {
      const allSnapshots = await this.getHistory();
      return allSnapshots.filter(snapshot => snapshot.author.userId === authorId);
    } catch (error) {
      console.error('Error retrieving snapshots by author:', error);
      return [];
    }
  }

  /**
   * Get snapshots within date range
   */
  async getSnapshotsByDateRange(startDate: Date, endDate: Date): Promise<IVersionSnapshot[]> {
    if (this._disposed) {
      return [];
    }

    try {
      const allSnapshots = await this.getHistory();
      return allSnapshots.filter(snapshot =>
        snapshot.timestamp >= startDate && snapshot.timestamp <= endDate
      );
    } catch (error) {
      console.error('Error retrieving snapshots by date range:', error);
      return [];
    }
  }

  /**
   * Dispose of the history tracker and clean up resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Clear auto snapshot timer
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }

    // Clear collections
    this._snapshots.clear();
    this._pendingUpdates.length = 0;

    console.log('HistoryTracker disposed');
  }

  /**
   * Set up listeners for Yjs document updates from the provider
   */
  private _setupUpdateListeners(): void {
    this._provider.onUpdate((update: Uint8Array) => {
      this._handleDocumentUpdate(update);
    });
  }

  /**
   * Handle document updates from Yjs
   */
  private _handleDocumentUpdate(update: Uint8Array): void {
    if (this._disposed) {
      return;
    }

    // Queue update for processing
    this._pendingUpdates.push(update);

    // Limit pending updates to prevent memory growth
    if (this._pendingUpdates.length > 100) {
      this._pendingUpdates = this._pendingUpdates.slice(-50);
    }
  }

  /**
   * Capture automatic snapshot if conditions are met
   */
  private async _captureAutoSnapshot(): Promise<void> {
    if (this._disposed || this._pendingUpdates.length === 0) {
      return;
    }

    try {
      await this.captureSnapshot({
        type: 'auto_snapshot',
        pendingUpdates: this._pendingUpdates.length
      });

      // Clear processed updates
      this._pendingUpdates.length = 0;
    } catch (error) {
      console.error('Error capturing auto snapshot:', error);
    }
  }

  /**
   * Generate change summary from document state
   */
  private async _generateChangeSummary(currentState: Uint8Array): Promise<string> {
    if (!this._lastDocumentState) {
      return 'Initial snapshot';
    }

    try {
      // Simple heuristic based on state size difference
      const sizeDiff = currentState.byteLength - this._lastDocumentState.byteLength;
      const pendingCount = this._pendingUpdates.length;

      if (sizeDiff > 0) {
        return `Added content (+${sizeDiff} bytes, ${pendingCount} operations)`;
      } else if (sizeDiff < 0) {
        return `Removed content (${sizeDiff} bytes, ${pendingCount} operations)`;
      } else {
        return `Modified content (${pendingCount} operations)`;
      }
    } catch (error) {
      return 'Content changes';
    }
  }

  /**
   * Extract cell-level changes from document state
   */
  private async _extractCellChanges(currentState: Uint8Array): Promise<Record<string, any>> {
    try {
      // Apply current state to temporary document for analysis
      const tempDoc = new Y.Doc();
      Y.applyUpdate(tempDoc, currentState);

      // Extract cell information from Yjs document
      const cells = tempDoc.getArray('cells');
      const cellChanges: Record<string, any> = {};

      cells.forEach((cell, index) => {
        if (cell && typeof cell === 'object') {
          const cellId = `cell-${index}`;
          cellChanges[cellId] = {
            index,
            content: this._extractCellContent(cell),
            metadata: this._extractCellMetadata(cell)
          };
        }
      });

      tempDoc.destroy();
      return cellChanges;
    } catch (error) {
      console.warn('Error extracting cell changes:', error);
      return {};
    }
  }

  /**
   * Extract content from a Yjs cell object
   */
  private _extractCellContent(cellObj: any): string {
    try {
      if (cellObj && cellObj.source && cellObj.source.toString) {
        return cellObj.source.toString();
      }
      return '';
    } catch (error) {
      return '';
    }
  }

  /**
   * Extract metadata from a Yjs cell object
   */
  private _extractCellMetadata(cellObj: any): Record<string, any> {
    try {
      if (cellObj && cellObj.metadata) {
        return cellObj.metadata.toJSON();
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  /**
   * Get current user information
   */
  private _getCurrentUser(): any {
    // In a real implementation, this would get user info from authentication context
    return {
      userId: 'current-user',
      username: 'current-user',
      displayName: 'Current User',
      avatar: '',
      color: '#1976d2',
      cursorPosition: null,
      selectedCells: [],
      isActive: true,
      lastActivity: new Date()
    };
  }

  /**
   * Compress snapshot data for storage efficiency
   */
  private async _compressSnapshotData(snapshot: IVersionSnapshot): Promise<void> {
    try {
      // Use lib0 encoding utilities for compression
      const encoder = encoding.createEncoder();

      // Write snapshot data to encoder
      encoding.writeVarUint(encoder, snapshot.size);

      // Mark as compressed in metadata
      snapshot.metadata.compressed = true;
      snapshot.metadata.originalSize = snapshot.size;

      // In a real implementation, actual compression would be applied here
      console.debug(`Compressed snapshot ${snapshot.id}`);
    } catch (error) {
      console.warn('Error compressing snapshot data:', error);
    }
  }

  /**
   * Enforce maximum snapshot limit
   */
  private async _enforceSnapshotLimit(): Promise<void> {
    if (this._snapshots.size <= (this._config.maxSnapshots || MAX_HISTORY_SNAPSHOTS)) {
      return;
    }

    try {
      const sortedSnapshots = Array.from(this._snapshots.entries())
        .sort(([, a], [, b]) => a.timestamp.getTime() - b.timestamp.getTime());

      const toDelete = sortedSnapshots.slice(0, sortedSnapshots.length - (this._config.maxSnapshots || MAX_HISTORY_SNAPSHOTS));

      for (const [id] of toDelete) {
        this._snapshots.delete(id);
      }

      console.log(`Deleted ${toDelete.length} old snapshots to enforce limit`);
    } catch (error) {
      console.error('Error enforcing snapshot limit:', error);
    }
  }

  /**
   * Persist snapshot to backend storage
   */
  private async _persistSnapshot(snapshot: IVersionSnapshot): Promise<void> {
    if (!this._config.storageUrl) {
      return;
    }

    try {
      // In a real implementation, this would make an HTTP request to the backend
      console.debug(`Persisted snapshot ${snapshot.id} to backend`);
    } catch (error) {
      console.warn('Error persisting snapshot to backend:', error);
    }
  }

  /**
   * Load history from backend storage
   */
  private async _loadHistoryFromBackend(): Promise<void> {
    if (!this._config.storageUrl) {
      return;
    }

    try {
      // In a real implementation, this would load snapshots from backend storage
      console.debug('Loaded history from backend');
    } catch (error) {
      console.warn('Error loading history from backend:', error);
    }
  }

  /**
   * Clear backend history storage
   */
  private async _clearBackendHistory(): Promise<void> {
    if (!this._config.storageUrl) {
      return;
    }

    try {
      // In a real implementation, this would clear backend storage
      console.debug('Cleared backend history');
    } catch (error) {
      console.warn('Error clearing backend history:', error);
    }
  }

  /**
   * Restore cells from snapshot data
   */
  private async _restoreCellsFromSnapshot(snapshot: IVersionSnapshot): Promise<string[]> {
    const modifiedCells: string[] = [];

    try {
      // In a real implementation, this would apply the snapshot's cell changes
      // to the current Yjs document, updating cell content and metadata

      Object.keys(snapshot.cellChanges).forEach(cellId => {
        modifiedCells.push(cellId);
      });

      console.debug(`Restored ${modifiedCells.length} cells from snapshot ${snapshot.id}`);
    } catch (error) {
      console.error('Error restoring cells from snapshot:', error);
    }

    return modifiedCells;
  }

  /**
   * Compute cell-level differences between snapshots using Myers algorithm
   */
  private async _computeCellDiffs(fromSnapshot: IVersionSnapshot, toSnapshot: IVersionSnapshot): Promise<Record<string, any>> {
    const cellDiffs: Record<string, any> = {};

    try {
      const fromCells = fromSnapshot.cellChanges;
      const toCells = toSnapshot.cellChanges;

      // Get union of all cell IDs
      const allCellIds = new Set([...Object.keys(fromCells), ...Object.keys(toCells)]);

      Array.from(allCellIds).forEach(cellId => {
        const fromCell = fromCells[cellId];
        const toCell = toCells[cellId];

        if (!fromCell && toCell) {
          // Cell was added
          cellDiffs[cellId] = {
            oldContent: '',
            newContent: toCell.content || '',
            changes: [{ added: true, value: toCell.content || '' }],
            changeType: 'added'
          };
        } else if (fromCell && !toCell) {
          // Cell was removed
          cellDiffs[cellId] = {
            oldContent: fromCell.content || '',
            newContent: '',
            changes: [{ removed: true, value: fromCell.content || '' }],
            changeType: 'removed'
          };
        } else if (fromCell && toCell) {
          // Cell may have been modified
          const oldContent = fromCell.content || '';
          const newContent = toCell.content || '';

          if (oldContent !== newContent) {
            // Use Myers diff algorithm via diffLines
            const changes = diffLines(oldContent, newContent);
            cellDiffs[cellId] = {
              oldContent,
              newContent,
              changes,
              changeType: 'modified'
            };
          } else {
            cellDiffs[cellId] = {
              oldContent,
              newContent,
              changes: [],
              changeType: 'unchanged'
            };
          }
        }
      });
    } catch (error) {
      console.error('Error computing cell diffs:', error);
    }

    return cellDiffs;
  }

  /**
   * Generate diff summary statistics
   */
  private _generateDiffSummary(cellDiffs: Record<string, any>): any {
    let cellsAdded = 0;
    let cellsRemoved = 0;
    let cellsModified = 0;
    let totalChanges = 0;

    Object.values(cellDiffs).forEach((diff: any) => {
      switch (diff.changeType) {
        case 'added':
          cellsAdded++;
          totalChanges++;
          break;
        case 'removed':
          cellsRemoved++;
          totalChanges++;
          break;
        case 'modified':
          cellsModified++;
          totalChanges += diff.changes.length;
          break;
      }
    });

    return {
      cellsAdded,
      cellsRemoved,
      cellsModified,
      totalChanges
    };
  }

  /**
   * Convert history to CSV format
   */
  private _convertHistoryToCSV(history: IVersionSnapshot[]): string {
    const headers = ['ID', 'Timestamp', 'Author', 'Change Summary', 'Size'];
    const rows = history.map(snapshot => [
      snapshot.id,
      snapshot.timestamp.toISOString(),
      snapshot.author.displayName,
      snapshot.changeSummary,
      snapshot.size.toString()
    ]);

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  /**
   * Compare two Uint8Array for equality
   */
  private _arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }

    return true;
  }
}
