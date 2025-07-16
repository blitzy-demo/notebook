// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';
import { YNotebook } from '@jupyter/ydoc';
import { Signal, ISignal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import { Time } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { IDocumentUpdateEvent } from './provider';
import { IPermissionsManager } from './permissions';
import UserAwareness from './awareness';

/**
 * Enumeration of change types for history tracking
 */
export enum ChangeType {
  /** Cell added to notebook */
  CELL_ADDED = 'cell_added',
  /** Cell deleted from notebook */
  CELL_DELETED = 'cell_deleted',
  /** Cell moved within notebook */
  CELL_MOVED = 'cell_moved',
  /** Cell content changed */
  CELL_CONTENT_CHANGED = 'cell_content_changed',
  /** Cell metadata changed */
  CELL_METADATA_CHANGED = 'cell_metadata_changed',
  /** Notebook metadata changed */
  NOTEBOOK_METADATA_CHANGED = 'notebook_metadata_changed',
  /** Cell executed */
  CELL_EXECUTION = 'cell_execution',
  /** Cell output changed */
  CELL_OUTPUT_CHANGED = 'cell_output_changed',
  /** Collaborative edit operation */
  COLLABORATIVE_EDIT = 'collaborative_edit'
}

/**
 * Enumeration of version statuses
 */
export enum VersionStatus {
  /** Active version */
  ACTIVE = 'active',
  /** Archived version */
  ARCHIVED = 'archived',
  /** Deleted version */
  DELETED = 'deleted',
  /** Corrupted version */
  CORRUPTED = 'corrupted',
  /** Pending cleanup */
  PENDING_CLEANUP = 'pending_cleanup'
}

/**
 * Interface representing version metadata
 */
export interface IVersionMetadata {
  /** Version identifier */
  version: string;
  /** Version creation timestamp */
  timestamp: number;
  /** Author of the version */
  author: string;
  /** Changes included in this version */
  changes: string[];
  /** Version description */
  description?: string;
  /** Parent version identifier */
  parentVersion?: string;
}

/**
 * Interface representing a change set
 */
export interface IChangeSet {
  /** Change set identifier */
  id: string;
  /** Change timestamp */
  timestamp: number;
  /** Author of the change */
  author: string;
  /** Array of changes */
  changes: Y.YEvent<any>[];
  /** Affected cell identifiers */
  affectedCells: string[];
  /** Type of change */
  changeType: ChangeType;
  /** Previous version identifier */
  previousVersion?: string;
  /** Next version identifier */
  nextVersion?: string;
  /** Change description */
  description?: string;
  /** Additional metadata */
  metadata?: { [key: string]: any };
}

/**
 * Interface for version storage configuration
 */
export interface IVersionStorageConfig {
  /** Maximum number of versions to retain */
  maxVersions: number;
  /** Retention period in milliseconds */
  retentionPeriod: number;
  /** Enable compression for stored versions */
  compressionEnabled: boolean;
  /** Storage backend type */
  storageBackend: 'memory' | 'indexeddb' | 'server';
  /** Enable automatic snapshots */
  autoSnapshot: boolean;
  /** Snapshot interval in milliseconds */
  snapshotInterval: number;
  /** Enable persistent storage */
  persistentStorage: boolean;
  /** Maximum storage size in bytes */
  maxStorageSize: number;
}

/**
 * Interface representing change events
 */
export interface IChangeEvent {
  /** Event type */
  type: string;
  /** Associated change set */
  changeSet: IChangeSet;
  /** Version identifier */
  version: string;
  /** Event timestamp */
  timestamp: number;
  /** Event author */
  author: string;
  /** Affected cells */
  affectedCells: string[];
  /** Whether rollback is available */
  rollbackAvailable: boolean;
  /** Whether undo is available */
  canUndo: boolean;
  /** Whether redo is available */
  canRedo: boolean;
}

/**
 * Interface for version provider functionality
 */
export interface IVersionProvider {
  /** Get a specific version */
  getVersion(versionId: string): Promise<IVersionMetadata | null>;
  /** Get all versions */
  getVersions(): Promise<IVersionMetadata[]>;
  /** Create a snapshot */
  createSnapshot(description?: string): Promise<string>;
  /** Restore a snapshot */
  restoreSnapshot(versionId: string): Promise<void>;
  /** Get version difference */
  getVersionDiff(fromVersion: string, toVersion: string): Promise<any>;
  /** Get version timestamp */
  getVersionTimestamp(versionId: string): Promise<number>;
  /** Get version author */
  getVersionAuthor(versionId: string): Promise<string>;
}

/**
 * Interface for change history functionality
 */
export interface IChangeHistory {
  /** Get version history */
  getVersionHistory(): Promise<IVersionMetadata[]>;
  /** Get change set by identifier */
  getChangeSet(changeSetId: string): Promise<IChangeSet | null>;
  /** Rollback to specific version */
  rollbackToVersion(versionId: string): Promise<void>;
  /** Track a change */
  trackChange(event: IDocumentUpdateEvent): Promise<void>;
  /** Get version metadata */
  getVersionMetadata(versionId: string): Promise<IVersionMetadata | null>;
  /** Subscribe to changes */
  subscribeToChanges(): ISignal<IChangeHistory, IChangeEvent>;
  /** Unsubscribe from changes */
  unsubscribeFromChanges(): void;
}

/**
 * Default configuration for version storage
 */
const DEFAULT_CONFIG: IVersionStorageConfig = {
  maxVersions: 100,
  retentionPeriod: 30 * 24 * 60 * 60 * 1000, // 30 days
  compressionEnabled: true,
  storageBackend: 'indexeddb',
  autoSnapshot: true,
  snapshotInterval: 5 * 60 * 1000, // 5 minutes
  persistentStorage: true,
  maxStorageSize: 100 * 1024 * 1024 // 100MB
};

/**
 * ChangeHistory system implementation for tracking document changes and maintaining
 * version history with user attribution for collaborative notebooks.
 * 
 * This system leverages Yjs update events and state vectors to capture document evolution,
 * provides rollback capabilities, and implements configurable retention policies.
 */
export default class ChangeHistory implements IChangeHistory, IVersionProvider, IDisposable {
  private _provider: any; // YjsNotebookProvider
  private _permissions: IPermissionsManager;
  private _awareness: UserAwareness;
  private _yjsDocument: Y.Doc;
  private _yNotebook: YNotebook;
  private _config: IVersionStorageConfig;
  private _disposed = false;
  private _enabled = true;
  private _currentVersion: string;
  private _versions = new Map<string, IVersionMetadata>();
  private _changeSets = new Map<string, IChangeSet>();
  private _versionData = new Map<string, Uint8Array>();
  private _snapshotTimer: number | null = null;
  private _retentionTimer: number | null = null;
  private _changeCounter = 0;

  // Signals for history events
  private _onChangeTracked = new Signal<IChangeHistory, IChangeEvent>(this);
  private _onVersionCreated = new Signal<ChangeHistory, IVersionMetadata>(this);
  private _onVersionRestored = new Signal<ChangeHistory, string>(this);
  private _onSnapshotCreated = new Signal<ChangeHistory, string>(this);

  /**
   * Construct a new ChangeHistory instance
   * 
   * @param provider - The Yjs notebook provider instance
   * @param permissions - Permissions manager for access control
   * @param awareness - User awareness system for user tracking
   * @param config - Configuration options for version storage
   */
  constructor(
    provider: any, // YjsNotebookProvider
    permissions: IPermissionsManager,
    awareness: UserAwareness,
    config: Partial<IVersionStorageConfig> = {}
  ) {
    this._provider = provider;
    this._permissions = permissions;
    this._awareness = awareness;
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._yjsDocument = provider.yjsDocument;
    this._yNotebook = provider.yNotebook;
    this._currentVersion = this._generateVersionId();

    // Initialize version storage
    this._initializeVersionStorage();

    // Set up document observers
    this._setupDocumentObservers();

    // Initialize automatic snapshots
    if (this._config.autoSnapshot) {
      this._startSnapshotTimer();
    }

    // Initialize retention policy
    this._startRetentionTimer();

    // Create initial snapshot
    this._createInitialSnapshot();
  }

  /**
   * Get the current version identifier
   */
  get currentVersion(): string {
    return this._currentVersion;
  }

  /**
   * Get whether change history is enabled
   */
  get isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Set whether change history is enabled
   */
  set isEnabled(enabled: boolean) {
    this._enabled = enabled;
    if (enabled) {
      this._setupDocumentObservers();
      if (this._config.autoSnapshot) {
        this._startSnapshotTimer();
      }
    } else {
      this._cleanupDocumentObservers();
      this._stopSnapshotTimer();
    }
  }

  /**
   * Get the retention policy configuration
   */
  get retention(): IVersionStorageConfig {
    return { ...this._config };
  }

  /**
   * Get version history
   */
  async getVersionHistory(): Promise<IVersionMetadata[]> {
    try {
      // Check permissions
      const currentUser = this._awareness.getCurrentUser();
      if (!currentUser) {
        throw new Error('No current user context available');
      }

      const canAccess = await this._permissions.checkPermission(
        currentUser.userId,
        'view' as any,
        'notebook'
      );
      if (!canAccess) {
        throw new Error('Insufficient permissions to access version history');
      }

      // Return sorted versions by timestamp
      const versions = Array.from(this._versions.values());
      return versions.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('Failed to get version history:', error);
      throw error;
    }
  }

  /**
   * Get change set by identifier
   */
  async getChangeSet(changeSetId: string): Promise<IChangeSet | null> {
    try {
      // Check permissions
      const currentUser = this._awareness.getCurrentUser();
      if (!currentUser) {
        throw new Error('No current user context available');
      }

      const canAccess = await this._permissions.checkPermission(
        currentUser.userId,
        'view' as any,
        'notebook'
      );
      if (!canAccess) {
        throw new Error('Insufficient permissions to access change history');
      }

      return this._changeSets.get(changeSetId) || null;
    } catch (error) {
      console.error('Failed to get change set:', error);
      return null;
    }
  }

  /**
   * Rollback to specific version
   */
  async rollbackToVersion(versionId: string): Promise<void> {
    try {
      // Check permissions
      const currentUser = this._awareness.getCurrentUser();
      if (!currentUser) {
        throw new Error('No current user context available');
      }

      const canEdit = await this._permissions.checkPermission(
        currentUser.userId,
        'edit' as any,
        'notebook'
      );
      if (!canEdit) {
        throw new Error('Insufficient permissions to rollback version');
      }

      // Get version data
      const versionData = this._versionData.get(versionId);
      if (!versionData) {
        throw new Error(`Version ${versionId} not found`);
      }

      // Create backup of current state
      const backupVersionId = await this.createSnapshot(`Backup before rollback to ${versionId}`);

      // Apply the version update
      Y.applyUpdate(this._yjsDocument, versionData, 'rollback');

      // Update current version
      this._currentVersion = versionId;

      // Create change set for rollback
      const changeSet: IChangeSet = {
        id: UUID.uuid4(),
        timestamp: Date.now(),
        author: currentUser.userId,
        changes: [],
        affectedCells: this._getAllCellIds(),
        changeType: ChangeType.COLLABORATIVE_EDIT,
        previousVersion: backupVersionId,
        description: `Rollback to version ${versionId}`,
        metadata: { rollback: true, targetVersion: versionId }
      };

      this._changeSets.set(changeSet.id, changeSet);

      // Emit events
      this._onVersionRestored.emit(versionId);
      this._emitChangeEvent(changeSet);

      console.log(`Rolled back to version ${versionId}`);
    } catch (error) {
      console.error('Failed to rollback to version:', error);
      throw error;
    }
  }

  /**
   * Track a change from document update event
   */
  async trackChange(event: IDocumentUpdateEvent): Promise<void> {
    if (!this._enabled) {
      return;
    }

    try {
      // Determine change type
      const changeType = this._determineChangeType(event);

      // Get affected cells
      const affectedCells = this._getAffectedCells(event);

      // Create change set
      const changeSet: IChangeSet = {
        id: UUID.uuid4(),
        timestamp: event.timestamp,
        author: event.author,
        changes: event.changes,
        affectedCells,
        changeType,
        previousVersion: this._currentVersion,
        description: this._generateChangeDescription(changeType, affectedCells),
        metadata: {
          origin: event.origin,
          transactionId: event.transaction.local ? 'local' : 'remote',
          updateSize: event.update.length
        }
      };

      // Store change set
      this._changeSets.set(changeSet.id, changeSet);

      // Create version if significant change
      if (this._isSignificantChange(changeType)) {
        const versionId = await this._createVersionFromChangeSet(changeSet);
        changeSet.nextVersion = versionId;
      }

      // Emit change event
      this._emitChangeEvent(changeSet);

      this._changeCounter++;
    } catch (error) {
      console.error('Failed to track change:', error);
    }
  }

  /**
   * Get version metadata
   */
  async getVersionMetadata(versionId: string): Promise<IVersionMetadata | null> {
    try {
      // Check permissions
      const currentUser = this._awareness.getCurrentUser();
      if (!currentUser) {
        throw new Error('No current user context available');
      }

      const canAccess = await this._permissions.checkPermission(
        currentUser.userId,
        'view' as any,
        'notebook'
      );
      if (!canAccess) {
        throw new Error('Insufficient permissions to access version metadata');
      }

      return this._versions.get(versionId) || null;
    } catch (error) {
      console.error('Failed to get version metadata:', error);
      return null;
    }
  }

  /**
   * Subscribe to change events
   */
  subscribeToChanges(): ISignal<IChangeHistory, IChangeEvent> {
    return this._onChangeTracked;
  }

  /**
   * Unsubscribe from change events
   */
  unsubscribeFromChanges(): void {
    // Signal cleanup is handled by dispose
  }

  /**
   * Get a specific version
   */
  async getVersion(versionId: string): Promise<IVersionMetadata | null> {
    return this.getVersionMetadata(versionId);
  }

  /**
   * Get all versions
   */
  async getVersions(): Promise<IVersionMetadata[]> {
    return this.getVersionHistory();
  }

  /**
   * Create a snapshot
   */
  async createSnapshot(description?: string): Promise<string> {
    try {
      // Check permissions
      const currentUser = this._awareness.getCurrentUser();
      if (!currentUser) {
        throw new Error('No current user context available');
      }

      const canEdit = await this._permissions.checkPermission(
        currentUser.userId,
        'edit' as any,
        'notebook'
      );
      if (!canEdit) {
        throw new Error('Insufficient permissions to create snapshot');
      }

      // Generate version ID
      const versionId = this._generateVersionId();

      // Create snapshot of current state
      const stateUpdate = Y.encodeStateAsUpdate(this._yjsDocument);
      this._versionData.set(versionId, stateUpdate);

      // Create version metadata
      const metadata: IVersionMetadata = {
        version: versionId,
        timestamp: Date.now(),
        author: currentUser.userId,
        changes: this._getRecentChanges(),
        description: description || `Snapshot at ${Time.format(new Date())}`,
        parentVersion: this._currentVersion
      };

      // Store version
      this._versions.set(versionId, metadata);

      // Update current version
      this._currentVersion = versionId;

      // Emit events
      this._onVersionCreated.emit(metadata);
      this._onSnapshotCreated.emit(versionId);

      // Persist if enabled
      if (this._config.persistentStorage) {
        await this._persistVersion(versionId, stateUpdate, metadata);
      }

      // Clean up old versions
      this._enforceRetentionPolicy();

      return versionId;
    } catch (error) {
      console.error('Failed to create snapshot:', error);
      throw error;
    }
  }

  /**
   * Restore a snapshot
   */
  async restoreSnapshot(versionId: string): Promise<void> {
    await this.rollbackToVersion(versionId);
  }

  /**
   * Get version difference
   */
  async getVersionDiff(fromVersion: string, toVersion: string): Promise<any> {
    try {
      const fromData = this._versionData.get(fromVersion);
      const toData = this._versionData.get(toVersion);

      if (!fromData || !toData) {
        throw new Error('Version data not found');
      }

      // Calculate the diff between versions
      const fromDoc = new Y.Doc();
      Y.applyUpdate(fromDoc, fromData);
      const diff = Y.diffUpdate(toData, Y.encodeStateVector(fromDoc));
      
      return {
        from: fromVersion,
        to: toVersion,
        diff: diff,
        summary: this._generateDiffSummary(fromVersion, toVersion)
      };
    } catch (error) {
      console.error('Failed to get version diff:', error);
      throw error;
    }
  }

  /**
   * Get version timestamp
   */
  async getVersionTimestamp(versionId: string): Promise<number> {
    const metadata = await this.getVersionMetadata(versionId);
    return metadata ? metadata.timestamp : 0;
  }

  /**
   * Get version author
   */
  async getVersionAuthor(versionId: string): Promise<string> {
    const metadata = await this.getVersionMetadata(versionId);
    return metadata ? metadata.author : '';
  }

  /**
   * Check if the history system is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the history system
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Stop timers
    this._stopSnapshotTimer();
    this._stopRetentionTimer();

    // Clean up observers
    this._cleanupDocumentObservers();

    // Clear data
    this._versions.clear();
    this._changeSets.clear();
    this._versionData.clear();

    // Clear signals
    Signal.clearData(this);
  }

  /**
   * Initialize version storage
   */
  private _initializeVersionStorage(): void {
    // Initialize maps for in-memory storage
    this._versions = new Map();
    this._changeSets = new Map();
    this._versionData = new Map();

    // Load existing data if persistent storage is enabled
    if (this._config.persistentStorage) {
      this._loadPersistedData().catch(console.error);
    }
  }

  /**
   * Set up document observers for change tracking
   */
  private _setupDocumentObservers(): void {
    if (!this._enabled) {
      return;
    }

    // Observe document updates
    this._yjsDocument.on('update', this._handleDocumentUpdate.bind(this));

    // Observe provider events
    if (this._provider.onDocumentChanged) {
      this._provider.onDocumentChanged.connect(this._handleProviderUpdate.bind(this));
    }
  }

  /**
   * Clean up document observers
   */
  private _cleanupDocumentObservers(): void {
    try {
      this._yjsDocument.off('update', this._handleDocumentUpdate.bind(this));
      if (this._provider.onDocumentChanged) {
        this._provider.onDocumentChanged.disconnect(this._handleProviderUpdate.bind(this));
      }
    } catch (error) {
      console.warn('Error cleaning up document observers:', error);
    }
  }

  /**
   * Handle document update events
   */
  private _handleDocumentUpdate(update: Uint8Array, origin: string, doc: Y.Doc, transaction: Y.Transaction): void {
    if (!this._enabled) {
      return;
    }

    // Create document update event
    const event: IDocumentUpdateEvent = {
      update,
      origin,
      transaction,
      timestamp: Date.now(),
      author: this._awareness.getCurrentUser()?.userId || 'unknown',
      changes: Array.from(transaction.changedParentTypes.values()).flat(),
      stateVector: Y.encodeStateVector(doc)
    };

    // Track the change
    this.trackChange(event).catch(console.error);
  }

  /**
   * Handle provider update events
   */
  private _handleProviderUpdate(sender: any, event: IDocumentUpdateEvent): void {
    if (!this._enabled) {
      return;
    }

    // Track the change
    this.trackChange(event).catch(console.error);
  }

  /**
   * Start snapshot timer
   */
  private _startSnapshotTimer(): void {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
    }

    this._snapshotTimer = window.setInterval(() => {
      this._createAutomaticSnapshot();
    }, this._config.snapshotInterval);
  }

  /**
   * Stop snapshot timer
   */
  private _stopSnapshotTimer(): void {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
  }

  /**
   * Start retention timer
   */
  private _startRetentionTimer(): void {
    if (this._retentionTimer) {
      clearInterval(this._retentionTimer);
    }

    // Run retention policy every hour
    this._retentionTimer = window.setInterval(() => {
      this._enforceRetentionPolicy();
    }, 60 * 60 * 1000);
  }

  /**
   * Stop retention timer
   */
  private _stopRetentionTimer(): void {
    if (this._retentionTimer) {
      clearInterval(this._retentionTimer);
      this._retentionTimer = null;
    }
  }

  /**
   * Create initial snapshot
   */
  private async _createInitialSnapshot(): Promise<void> {
    try {
      await this.createSnapshot('Initial snapshot');
    } catch (error) {
      console.error('Failed to create initial snapshot:', error);
    }
  }

  /**
   * Create automatic snapshot
   */
  private async _createAutomaticSnapshot(): Promise<void> {
    try {
      // Only create snapshot if there have been changes
      if (this._changeCounter > 0) {
        await this.createSnapshot('Automatic snapshot');
        this._changeCounter = 0;
      }
    } catch (error) {
      console.error('Failed to create automatic snapshot:', error);
    }
  }

  /**
   * Generate version ID
   */
  private _generateVersionId(): string {
    return `v_${Date.now()}_${UUID.uuid4()}`;
  }

  /**
   * Determine change type from update event
   */
  private _determineChangeType(event: IDocumentUpdateEvent): ChangeType {
    // Simple heuristic based on changes
    const changes = event.changes;
    
    if (changes.length === 0) {
      return ChangeType.COLLABORATIVE_EDIT;
    }

    // Check for cell operations
    for (const change of changes) {
      if (change.target && change.target.constructor.name === 'YArray') {
        if (change.keys && change.keys.has('length')) {
          return ChangeType.CELL_ADDED;
        }
        return ChangeType.CELL_MOVED;
      }
      if (change.target && change.target.constructor.name === 'YText') {
        return ChangeType.CELL_CONTENT_CHANGED;
      }
      if (change.target && change.target.constructor.name === 'YMap') {
        return ChangeType.CELL_METADATA_CHANGED;
      }
    }

    return ChangeType.COLLABORATIVE_EDIT;
  }

  /**
   * Get affected cells from update event
   */
  private _getAffectedCells(event: IDocumentUpdateEvent): string[] {
    const affectedCells: string[] = [];
    
    // Extract cell IDs from changes
    for (const change of event.changes) {
      if (change.target && change.target.parent) {
        // Try to extract cell ID from the change target
        const target = change.target;
        if (target.parent && target.parent.get) {
          const cellId = target.parent.get('id');
          if (cellId && affectedCells.indexOf(cellId) === -1) {
            affectedCells.push(cellId);
          }
        }
      }
    }

    return affectedCells;
  }

  /**
   * Get all cell IDs from notebook
   */
  private _getAllCellIds(): string[] {
    const cellIds: string[] = [];
    
    try {
      const cells = this._yNotebook.cells;
      cells.forEach((cell: any) => {
        if (cell && cell.get) {
          const cellId = cell.get('id');
          if (cellId) {
            cellIds.push(cellId);
          }
        }
      });
    } catch (error) {
      console.warn('Failed to get all cell IDs:', error);
    }

    return cellIds;
  }

  /**
   * Generate change description
   */
  private _generateChangeDescription(changeType: ChangeType, affectedCells: string[]): string {
    const cellCount = affectedCells.length;
    const cellText = cellCount === 1 ? 'cell' : 'cells';
    
    switch (changeType) {
      case ChangeType.CELL_ADDED:
        return `Added ${cellCount} ${cellText}`;
      case ChangeType.CELL_DELETED:
        return `Deleted ${cellCount} ${cellText}`;
      case ChangeType.CELL_MOVED:
        return `Moved ${cellCount} ${cellText}`;
      case ChangeType.CELL_CONTENT_CHANGED:
        return `Modified content in ${cellCount} ${cellText}`;
      case ChangeType.CELL_METADATA_CHANGED:
        return `Modified metadata in ${cellCount} ${cellText}`;
      case ChangeType.NOTEBOOK_METADATA_CHANGED:
        return 'Modified notebook metadata';
      case ChangeType.CELL_EXECUTION:
        return `Executed ${cellCount} ${cellText}`;
      case ChangeType.CELL_OUTPUT_CHANGED:
        return `Output changed in ${cellCount} ${cellText}`;
      case ChangeType.COLLABORATIVE_EDIT:
        return `Collaborative edit affecting ${cellCount} ${cellText}`;
      default:
        return `Unknown change affecting ${cellCount} ${cellText}`;
    }
  }

  /**
   * Check if change is significant enough to create a version
   */
  private _isSignificantChange(changeType: ChangeType): boolean {
    return changeType === ChangeType.CELL_ADDED ||
           changeType === ChangeType.CELL_DELETED ||
           changeType === ChangeType.CELL_MOVED ||
           changeType === ChangeType.NOTEBOOK_METADATA_CHANGED;
  }

  /**
   * Create version from change set
   */
  private async _createVersionFromChangeSet(changeSet: IChangeSet): Promise<string> {
    const versionId = this._generateVersionId();
    
    // Create snapshot
    const stateUpdate = Y.encodeStateAsUpdate(this._yjsDocument);
    this._versionData.set(versionId, stateUpdate);

    // Create version metadata
    const metadata: IVersionMetadata = {
      version: versionId,
      timestamp: changeSet.timestamp,
      author: changeSet.author,
      changes: [changeSet.id],
      description: changeSet.description,
      parentVersion: changeSet.previousVersion
    };

    // Store version
    this._versions.set(versionId, metadata);
    this._currentVersion = versionId;

    // Emit event
    this._onVersionCreated.emit(metadata);

    // Persist if enabled
    if (this._config.persistentStorage) {
      await this._persistVersion(versionId, stateUpdate, metadata);
    }

    return versionId;
  }

  /**
   * Get recent changes for version metadata
   */
  private _getRecentChanges(): string[] {
    const recentChanges: string[] = [];
    const now = Date.now();
    const cutoff = now - this._config.snapshotInterval;

    this._changeSets.forEach((changeSet, id) => {
      if (changeSet.timestamp >= cutoff) {
        recentChanges.push(id);
      }
    });

    return recentChanges;
  }

  /**
   * Emit change event
   */
  private _emitChangeEvent(changeSet: IChangeSet): void {
    const event: IChangeEvent = {
      type: 'change',
      changeSet,
      version: this._currentVersion,
      timestamp: changeSet.timestamp,
      author: changeSet.author,
      affectedCells: changeSet.affectedCells,
      rollbackAvailable: this._versions.has(changeSet.previousVersion || ''),
      canUndo: this._canUndo(),
      canRedo: this._canRedo()
    };

    this._onChangeTracked.emit(event);
  }

  /**
   * Check if undo is available
   */
  private _canUndo(): boolean {
    return this._versions.size > 1;
  }

  /**
   * Check if redo is available
   */
  private _canRedo(): boolean {
    // Simple implementation - would need more sophisticated redo tracking
    return false;
  }

  /**
   * Enforce retention policy
   */
  private _enforceRetentionPolicy(): void {
    const now = Date.now();
    const cutoff = now - this._config.retentionPeriod;
    const versions = Array.from(this._versions.values());

    // Remove old versions
    const versionsToRemove = versions.filter(v => v.timestamp < cutoff);
    versionsToRemove.forEach(v => {
      this._versions.delete(v.version);
      this._versionData.delete(v.version);
    });

    // Enforce max versions limit
    if (versions.length > this._config.maxVersions) {
      const sortedVersions = versions.sort((a, b) => b.timestamp - a.timestamp);
      const versionsToKeep = sortedVersions.slice(0, this._config.maxVersions);
      
      // Remove excess versions
      this._versions.clear();
      this._versionData.clear();
      versionsToKeep.forEach(v => {
        this._versions.set(v.version, v);
        // Note: version data would need to be restored from persistence
      });
    }

    // Remove old change sets
    const changeSetsToRemove = Array.from(this._changeSets.values()).filter(cs => cs.timestamp < cutoff);
    changeSetsToRemove.forEach(cs => {
      this._changeSets.delete(cs.id);
    });
  }

  /**
   * Persist version data
   */
  private async _persistVersion(versionId: string, data: Uint8Array, metadata: IVersionMetadata): Promise<void> {
    try {
      if (this._config.storageBackend === 'server') {
        // Store on server
        const settings = ServerConnection.makeSettings();
        const url = '/api/notebook/history/versions';
        
        const response = await ServerConnection.makeRequest(
          url,
          {
            method: 'POST',
            body: JSON.stringify({
              versionId,
              data: Array.from(data),
              metadata
            })
          },
          settings
        );

        if (!response.ok) {
          throw new Error(`Failed to persist version: ${response.status}`);
        }
      } else if (this._config.storageBackend === 'indexeddb') {
        // Store in IndexedDB
        await this._storeInIndexedDB(versionId, data, metadata);
      }
    } catch (error) {
      console.error('Failed to persist version:', error);
    }
  }

  /**
   * Store version in IndexedDB
   */
  private async _storeInIndexedDB(versionId: string, data: Uint8Array, metadata: IVersionMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('notebook-history', 1);
      
      request.onerror = () => reject(request.error);
      
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['versions'], 'readwrite');
        const store = transaction.objectStore('versions');
        
        const versionData = {
          id: versionId,
          data: data,
          metadata: metadata,
          timestamp: Date.now()
        };
        
        const putRequest = store.put(versionData);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      };
      
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('versions')) {
          const store = db.createObjectStore('versions', { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp');
        }
      };
    });
  }

  /**
   * Load persisted data
   */
  private async _loadPersistedData(): Promise<void> {
    try {
      if (this._config.storageBackend === 'server') {
        // Load from server
        await this._loadFromServer();
      } else if (this._config.storageBackend === 'indexeddb') {
        // Load from IndexedDB
        await this._loadFromIndexedDB();
      }
    } catch (error) {
      console.error('Failed to load persisted data:', error);
    }
  }

  /**
   * Load from server
   */
  private async _loadFromServer(): Promise<void> {
    try {
      const settings = ServerConnection.makeSettings();
      const url = '/api/notebook/history/versions';
      
      const response = await ServerConnection.makeRequest(url, {}, settings);
      
      if (response.ok) {
        const data = await response.json();
        
        // Restore versions
        data.versions.forEach((item: any) => {
          this._versions.set(item.versionId, item.metadata);
          this._versionData.set(item.versionId, new Uint8Array(item.data));
        });
      }
    } catch (error) {
      console.error('Failed to load from server:', error);
    }
  }

  /**
   * Load from IndexedDB
   */
  private async _loadFromIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('notebook-history', 1);
      
      request.onerror = () => reject(request.error);
      
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['versions'], 'readonly');
        const store = transaction.objectStore('versions');
        
        const getAllRequest = store.getAll();
        getAllRequest.onsuccess = () => {
          const results = getAllRequest.result;
          
          results.forEach((item: any) => {
            this._versions.set(item.id, item.metadata);
            this._versionData.set(item.id, item.data);
          });
          
          resolve();
        };
        
        getAllRequest.onerror = () => reject(getAllRequest.error);
      };
    });
  }

  /**
   * Generate diff summary
   */
  private _generateDiffSummary(fromVersion: string, toVersion: string): string {
    const fromMetadata = this._versions.get(fromVersion);
    const toMetadata = this._versions.get(toVersion);
    
    if (!fromMetadata || !toMetadata) {
      return 'Unable to generate diff summary';
    }
    
    const timeDiff = toMetadata.timestamp - fromMetadata.timestamp;
    const timeStr = Time.formatHuman(new Date(timeDiff));
    
    return `Changes from ${fromMetadata.author} to ${toMetadata.author} over ${timeStr}`;
  }
}