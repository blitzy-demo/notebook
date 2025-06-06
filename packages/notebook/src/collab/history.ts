/**
 * @fileoverview Version tracking infrastructure that maintains comprehensive change logs,
 * document snapshots, and diff-based rollback capabilities for collaborative documents.
 * 
 * This service provides CRDT operation logging, automated snapshot generation, and version
 * control interfaces for collaborative audit trails. The implementation includes:
 * 
 * - Integration with yjs-history for CRDT operation tracking
 * - MongoDB persistence for CRDT document snapshots and operation logs
 * - PostgreSQL metadata storage for structured version queries
 * - S3-compatible storage for long-term snapshot archival
 * - Automatic snapshot generation with configurable interval policies
 * - Document timeline visualization with change attribution
 * - Diff-based rollback capabilities with selective version recovery
 * 
 * @author Jupyter Collaboration Team
 * @version 1.0.0
 * @since 2024-12-15
 */

import { 
    IDisposable, 
    ISignal, 
    Signal 
} from '@lumino/signaling';
import { 
    IObservableDisposable 
} from '@lumino/disposable';
import { 
    ReadonlyJSONObject, 
    ReadonlyJSONValue, 
    JSONObject 
} from '@lumino/coreutils';

// Yjs and history-related imports
import * as Y from 'yjs';
import { UndoManager } from 'yjs';

/**
 * Core interfaces and types for the history service
 */

/**
 * Represents a single version snapshot in the document history
 */
export interface IVersionSnapshot {
    /**
     * Unique identifier for this snapshot
     */
    readonly snapshotId: string;
    
    /**
     * Sequential version number for ordering
     */
    readonly version: number;
    
    /**
     * Timestamp when snapshot was created
     */
    readonly timestamp: Date;
    
    /**
     * User who contributed to this version
     */
    readonly contributorId: string;
    
    /**
     * Human-readable summary of changes
     */
    readonly changeSummary: string;
    
    /**
     * Size of the snapshot data in bytes
     */
    readonly snapshotSizeBytes: number;
    
    /**
     * Storage backend where snapshot is persisted
     */
    readonly storageBackend: 'redis' | 'mongodb' | 's3';
    
    /**
     * Location/path where snapshot is stored
     */
    readonly storageLocation: string;
    
    /**
     * Metadata about the snapshot
     */
    readonly metadata: ReadonlyJSONObject;
}

/**
 * Represents a CRDT operation in the change log
 */
export interface ICRDTOperation {
    /**
     * Unique operation identifier
     */
    readonly operationId: string;
    
    /**
     * Sequence number for ordering operations
     */
    readonly sequenceNumber: number;
    
    /**
     * Document ID this operation affects
     */
    readonly documentId: string;
    
    /**
     * User who performed the operation
     */
    readonly userId: string;
    
    /**
     * Timestamp when operation occurred
     */
    readonly timestamp: Date;
    
    /**
     * Type of operation (insert, delete, retain, etc.)
     */
    readonly operationType: string;
    
    /**
     * Encoded CRDT operation data
     */
    readonly operationData: Uint8Array;
    
    /**
     * Vector clock information for conflict resolution
     */
    readonly vectorClock: ReadonlyJSONObject;
    
    /**
     * Change attribution metadata
     */
    readonly attribution: {
        cellId?: string;
        lineNumber?: number;
        characterOffset?: number;
        changeType: 'insert' | 'delete' | 'format' | 'structure';
    };
}

/**
 * Configuration for snapshot generation policies
 */
export interface ISnapshotPolicy {
    /**
     * Interval between snapshots during active editing (minutes)
     */
    readonly activeInterval: number;
    
    /**
     * Interval between snapshots during inactive periods (minutes)
     */
    readonly inactiveInterval: number;
    
    /**
     * Maximum number of operations before forcing a snapshot
     */
    readonly maxOperations: number;
    
    /**
     * Maximum document size (MB) before forcing a snapshot
     */
    readonly maxDocumentSize: number;
    
    /**
     * Retention policy for snapshots
     */
    readonly retentionPolicy: {
        hotStorageDays: number;
        warmStorageDays: number;
        archivalDays: number;
    };
}

/**
 * Storage configuration for different backends
 */
export interface IStorageConfig {
    /**
     * Redis configuration for real-time operations
     */
    readonly redis: {
        url: string;
        keyPrefix: string;
        ttlSeconds: number;
    };
    
    /**
     * MongoDB configuration for document storage
     */
    readonly mongodb: {
        connectionString: string;
        database: string;
        snapshotsCollection: string;
        operationsCollection: string;
    };
    
    /**
     * PostgreSQL configuration for metadata
     */
    readonly postgresql: {
        connectionString: string;
        schema: string;
        historyTable: string;
    };
    
    /**
     * S3-compatible storage for archival
     */
    readonly s3: {
        endpoint: string;
        bucket: string;
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
        pathPrefix: string;
    };
}

/**
 * History service events
 */
export interface IHistoryServiceEvents {
    /**
     * Emitted when a new snapshot is created
     */
    readonly snapshotCreated: ISignal<IHistoryService, IVersionSnapshot>;
    
    /**
     * Emitted when an operation is logged
     */
    readonly operationLogged: ISignal<IHistoryService, ICRDTOperation>;
    
    /**
     * Emitted when a rollback operation completes
     */
    readonly rollbackCompleted: ISignal<IHistoryService, { 
        targetVersion: number; 
        affectedOperations: number;
    }>;
    
    /**
     * Emitted when storage tier migration occurs
     */
    readonly storageMigrated: ISignal<IHistoryService, {
        snapshotId: string;
        fromTier: string;
        toTier: string;
    }>;
}

/**
 * Interface for the History Service
 */
export interface IHistoryService extends IObservableDisposable {
    /**
     * Document ID this service tracks
     */
    readonly documentId: string;
    
    /**
     * Current version number
     */
    readonly currentVersion: number;
    
    /**
     * Service events
     */
    readonly events: IHistoryServiceEvents;
    
    /**
     * Initialize the history service with a Yjs document
     */
    initialize(yjsDocument: Y.Doc, config: IStorageConfig): Promise<void>;
    
    /**
     * Create a manual snapshot of the current document state
     */
    createSnapshot(
        contributorId: string, 
        changeSummary: string,
        metadata?: ReadonlyJSONObject
    ): Promise<IVersionSnapshot>;
    
    /**
     * Log a CRDT operation to the change history
     */
    logOperation(operation: ICRDTOperation): Promise<void>;
    
    /**
     * Get version history with pagination
     */
    getVersionHistory(options?: {
        limit?: number;
        offset?: number;
        contributorId?: string;
        fromDate?: Date;
        toDate?: Date;
    }): Promise<IVersionSnapshot[]>;
    
    /**
     * Get detailed operation log for a version range
     */
    getOperationLog(options: {
        fromVersion: number;
        toVersion: number;
        contributorId?: string;
        operationType?: string;
    }): Promise<ICRDTOperation[]>;
    
    /**
     * Roll back document to a specific version
     */
    rollbackToVersion(
        targetVersion: number,
        options?: {
            preserveAfter?: boolean;
            createCheckpoint?: boolean;
        }
    ): Promise<void>;
    
    /**
     * Get a diff between two versions
     */
    getDiff(
        fromVersion: number,
        toVersion: number
    ): Promise<{
        operations: ICRDTOperation[];
        summary: {
            insertions: number;
            deletions: number;
            modifications: number;
        };
    }>;
    
    /**
     * Migrate old snapshots to archival storage
     */
    migrateToArchival(cutoffDate: Date): Promise<number>;
    
    /**
     * Clean up expired snapshots and operations
     */
    cleanup(retentionPolicy: ISnapshotPolicy['retentionPolicy']): Promise<{
        snapshotsRemoved: number;
        operationsArchived: number;
    }>;
    
    /**
     * Get storage utilization statistics
     */
    getStorageStats(): Promise<{
        redis: { keyCount: number; memoryUsage: number };
        mongodb: { documentCount: number; storageSize: number };
        postgresql: { recordCount: number; tableSize: number };
        s3: { objectCount: number; totalSize: number };
    }>;
}

/**
 * Default snapshot policy configuration
 */
export const DEFAULT_SNAPSHOT_POLICY: ISnapshotPolicy = {
    activeInterval: 5, // 5 minutes during active editing
    inactiveInterval: 30, // 30 minutes during inactive periods
    maxOperations: 1000, // Force snapshot after 1000 operations
    maxDocumentSize: 10, // Force snapshot at 10MB document size
    retentionPolicy: {
        hotStorageDays: 7, // Keep in Redis for 7 days
        warmStorageDays: 90, // Keep in MongoDB for 90 days
        archivalDays: 365 // Archive to S3 for 1 year
    }
};

/**
 * Implementation of the History Service
 */
export class HistoryService implements IHistoryService {
    private _isDisposed = false;
    private _disposed = new Signal<this, void>(this);
    private _documentId: string;
    private _currentVersion = 0;
    private _yjsDocument: Y.Doc | null = null;
    private _undoManager: UndoManager | null = null;
    private _storageConfig: IStorageConfig | null = null;
    private _snapshotPolicy: ISnapshotPolicy = DEFAULT_SNAPSHOT_POLICY;
    private _lastSnapshotTime = new Date();
    private _operationsSinceSnapshot = 0;
    private _snapshotTimer: any = null;
    
    // Event signals
    private _snapshotCreated = new Signal<this, IVersionSnapshot>(this);
    private _operationLogged = new Signal<this, ICRDTOperation>(this);
    private _rollbackCompleted = new Signal<this, { targetVersion: number; affectedOperations: number }>(this);
    private _storageMigrated = new Signal<this, { snapshotId: string; fromTier: string; toTier: string }>(this);
    
    /**
     * Create a new History Service instance
     */
    constructor(documentId: string, snapshotPolicy?: Partial<ISnapshotPolicy>) {
        this._documentId = documentId;
        
        if (snapshotPolicy) {
            this._snapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, ...snapshotPolicy };
        }
    }
    
    /**
     * Get the document ID
     */
    get documentId(): string {
        return this._documentId;
    }
    
    /**
     * Get the current version number
     */
    get currentVersion(): number {
        return this._currentVersion;
    }
    
    /**
     * Get service events
     */
    get events(): IHistoryServiceEvents {
        return {
            snapshotCreated: this._snapshotCreated,
            operationLogged: this._operationLogged,
            rollbackCompleted: this._rollbackCompleted,
            storageMigrated: this._storageMigrated
        };
    }
    
    /**
     * Check if the service is disposed
     */
    get isDisposed(): boolean {
        return this._isDisposed;
    }
    
    /**
     * Signal emitted when the service is disposed
     */
    get disposed(): ISignal<this, void> {
        return this._disposed;
    }
    
    /**
     * Initialize the history service
     */
    async initialize(yjsDocument: Y.Doc, config: IStorageConfig): Promise<void> {
        if (this._isDisposed) {
            throw new Error('Cannot initialize disposed HistoryService');
        }
        
        this._yjsDocument = yjsDocument;
        this._storageConfig = config;
        
        // Create undo manager for tracking changes
        this._undoManager = new UndoManager(yjsDocument.getMap('notebook'));
        
        // Set up CRDT operation logging
        yjsDocument.on('update', this._onDocumentUpdate.bind(this));
        
        // Initialize storage backends
        await this._initializeStorageBackends();
        
        // Load current version from metadata
        this._currentVersion = await this._loadCurrentVersion();
        
        // Start automatic snapshot timer
        this._startSnapshotTimer();
        
        console.log(`HistoryService initialized for document ${this._documentId} at version ${this._currentVersion}`);
    }
    
    /**
     * Create a manual snapshot
     */
    async createSnapshot(
        contributorId: string, 
        changeSummary: string,
        metadata?: ReadonlyJSONObject
    ): Promise<IVersionSnapshot> {
        if (this._isDisposed || !this._yjsDocument || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        const snapshotId = this._generateSnapshotId();
        const version = ++this._currentVersion;
        const timestamp = new Date();
        
        // Encode current Yjs document state
        const documentState = Y.encodeStateAsUpdate(this._yjsDocument);
        const snapshotSizeBytes = documentState.byteLength;
        
        // Create snapshot metadata
        const snapshotMetadata: JSONObject = {
            documentId: this._documentId,
            version,
            contributor: contributorId,
            operationCount: this._operationsSinceSnapshot,
            documentSize: snapshotSizeBytes,
            compressionRatio: await this._calculateCompressionRatio(documentState),
            ...metadata
        };
        
        // Determine storage backend based on size and recency
        const storageBackend = this._selectStorageBackend(snapshotSizeBytes, timestamp);
        const storageLocation = await this._persistSnapshot(
            snapshotId,
            documentState,
            snapshotMetadata,
            storageBackend
        );
        
        // Create version snapshot record
        const snapshot: IVersionSnapshot = {
            snapshotId,
            version,
            timestamp,
            contributorId,
            changeSummary,
            snapshotSizeBytes,
            storageBackend,
            storageLocation,
            metadata: snapshotMetadata
        };
        
        // Store metadata in PostgreSQL
        await this._storeSnapshotMetadata(snapshot);
        
        // Reset operation counter
        this._operationsSinceSnapshot = 0;
        this._lastSnapshotTime = timestamp;
        
        // Emit event
        this._snapshotCreated.emit(snapshot);
        
        console.log(`Created snapshot ${snapshotId} (version ${version}) for document ${this._documentId}`);
        return snapshot;
    }
    
    /**
     * Log a CRDT operation
     */
    async logOperation(operation: ICRDTOperation): Promise<void> {
        if (this._isDisposed || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        // Store operation in MongoDB
        await this._persistOperation(operation);
        
        // Update operation counter
        this._operationsSinceSnapshot++;
        
        // Check if we need to create an automatic snapshot
        await this._checkSnapshotTriggers(operation.userId);
        
        // Emit event
        this._operationLogged.emit(operation);
    }
    
    /**
     * Get version history with pagination
     */
    async getVersionHistory(options: {
        limit?: number;
        offset?: number;
        contributorId?: string;
        fromDate?: Date;
        toDate?: Date;
    } = {}): Promise<IVersionSnapshot[]> {
        if (this._isDisposed || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        return await this._querySnapshotMetadata(options);
    }
    
    /**
     * Get operation log for version range
     */
    async getOperationLog(options: {
        fromVersion: number;
        toVersion: number;
        contributorId?: string;
        operationType?: string;
    }): Promise<ICRDTOperation[]> {
        if (this._isDisposed || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        return await this._queryOperationLog(options);
    }
    
    /**
     * Roll back to a specific version
     */
    async rollbackToVersion(
        targetVersion: number,
        options: {
            preserveAfter?: boolean;
            createCheckpoint?: boolean;
        } = {}
    ): Promise<void> {
        if (this._isDisposed || !this._yjsDocument || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        if (targetVersion > this._currentVersion) {
            throw new Error(`Target version ${targetVersion} is greater than current version ${this._currentVersion}`);
        }
        
        // Create checkpoint if requested
        if (options.createCheckpoint) {
            await this.createSnapshot(
                'system',
                `Checkpoint before rollback to version ${targetVersion}`
            );
        }
        
        // Load target snapshot
        const targetSnapshot = await this._loadSnapshot(targetVersion);
        if (!targetSnapshot) {
            throw new Error(`Snapshot for version ${targetVersion} not found`);
        }
        
        // Apply the target state to the Yjs document
        const snapshotState = await this._loadSnapshotData(targetSnapshot);
        Y.applyUpdate(this._yjsDocument, snapshotState);
        
        // Handle subsequent versions
        if (!options.preserveAfter) {
            await this._removeVersionsAfter(targetVersion);
        }
        
        // Update current version
        this._currentVersion = targetVersion;
        
        // Calculate affected operations
        const affectedOperations = await this._countOperationsAfterVersion(targetVersion);
        
        // Emit rollback event
        this._rollbackCompleted.emit({ targetVersion, affectedOperations });
        
        console.log(`Rolled back document ${this._documentId} to version ${targetVersion}`);
    }
    
    /**
     * Get diff between two versions
     */
    async getDiff(fromVersion: number, toVersion: number): Promise<{
        operations: ICRDTOperation[];
        summary: {
            insertions: number;
            deletions: number;
            modifications: number;
        };
    }> {
        if (this._isDisposed || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        const operations = await this.getOperationLog({
            fromVersion: Math.min(fromVersion, toVersion),
            toVersion: Math.max(fromVersion, toVersion)
        });
        
        // Calculate summary statistics
        const summary = {
            insertions: operations.filter(op => op.attribution.changeType === 'insert').length,
            deletions: operations.filter(op => op.attribution.changeType === 'delete').length,
            modifications: operations.filter(op => op.attribution.changeType === 'format').length
        };
        
        return { operations, summary };
    }
    
    /**
     * Migrate snapshots to archival storage
     */
    async migrateToArchival(cutoffDate: Date): Promise<number> {
        if (this._isDisposed || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        // Find snapshots older than cutoff date in warm storage
        const candidateSnapshots = await this._findSnapshotsForMigration(cutoffDate);
        let migratedCount = 0;
        
        for (const snapshot of candidateSnapshots) {
            try {
                // Load snapshot data from current storage
                const snapshotData = await this._loadSnapshotData(snapshot);
                
                // Store in S3
                const archivalLocation = await this._storeInS3(
                    snapshot.snapshotId,
                    snapshotData,
                    snapshot.metadata
                );
                
                // Update metadata to point to S3
                await this._updateSnapshotLocation(
                    snapshot.snapshotId,
                    's3',
                    archivalLocation
                );
                
                // Remove from previous storage tier
                await this._removeFromStorage(snapshot.storageBackend, snapshot.storageLocation);
                
                // Emit migration event
                this._storageMigrated.emit({
                    snapshotId: snapshot.snapshotId,
                    fromTier: snapshot.storageBackend,
                    toTier: 's3'
                });
                
                migratedCount++;
            } catch (error) {
                console.error(`Failed to migrate snapshot ${snapshot.snapshotId}:`, error);
            }
        }
        
        console.log(`Migrated ${migratedCount} snapshots to archival storage`);
        return migratedCount;
    }
    
    /**
     * Clean up expired data
     */
    async cleanup(retentionPolicy: ISnapshotPolicy['retentionPolicy']): Promise<{
        snapshotsRemoved: number;
        operationsArchived: number;
    }> {
        if (this._isDisposed || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        const now = new Date();
        const archivalCutoff = new Date(now.getTime() - retentionPolicy.archivalDays * 24 * 60 * 60 * 1000);
        
        // Remove expired snapshots
        const expiredSnapshots = await this._findExpiredSnapshots(archivalCutoff);
        let snapshotsRemoved = 0;
        
        for (const snapshot of expiredSnapshots) {
            try {
                await this._removeSnapshot(snapshot);
                snapshotsRemoved++;
            } catch (error) {
                console.error(`Failed to remove expired snapshot ${snapshot.snapshotId}:`, error);
            }
        }
        
        // Archive old operations
        const warmCutoff = new Date(now.getTime() - retentionPolicy.warmStorageDays * 24 * 60 * 60 * 1000);
        const operationsArchived = await this._archiveOldOperations(warmCutoff);
        
        console.log(`Cleanup completed: ${snapshotsRemoved} snapshots removed, ${operationsArchived} operations archived`);
        return { snapshotsRemoved, operationsArchived };
    }
    
    /**
     * Get storage utilization statistics
     */
    async getStorageStats(): Promise<{
        redis: { keyCount: number; memoryUsage: number };
        mongodb: { documentCount: number; storageSize: number };
        postgresql: { recordCount: number; tableSize: number };
        s3: { objectCount: number; totalSize: number };
    }> {
        if (this._isDisposed || !this._storageConfig) {
            throw new Error('HistoryService not properly initialized');
        }
        
        // Gather statistics from each storage backend
        const [redisStats, mongoStats, pgStats, s3Stats] = await Promise.all([
            this._getRedisStats(),
            this._getMongoStats(),
            this._getPostgreSQLStats(),
            this._getS3Stats()
        ]);
        
        return {
            redis: redisStats,
            mongodb: mongoStats,
            postgresql: pgStats,
            s3: s3Stats
        };
    }
    
    /**
     * Dispose of the service
     */
    dispose(): void {
        if (this._isDisposed) {
            return;
        }
        
        // Clear snapshot timer
        if (this._snapshotTimer) {
            clearInterval(this._snapshotTimer);
            this._snapshotTimer = null;
        }
        
        // Disconnect from Yjs document
        if (this._yjsDocument) {
            this._yjsDocument.off('update', this._onDocumentUpdate);
            this._yjsDocument = null;
        }
        
        // Clean up undo manager
        if (this._undoManager) {
            this._undoManager.destroy();
            this._undoManager = null;
        }
        
        // Clear storage config
        this._storageConfig = null;
        
        // Mark as disposed
        this._isDisposed = true;
        this._disposed.emit();
        
        // Clear all signals
        Signal.clearData(this);
    }
    
    // Private implementation methods
    
    /**
     * Handle Yjs document updates
     */
    private _onDocumentUpdate(update: Uint8Array, origin: any, doc: Y.Doc): void {
        if (this._isDisposed || origin === 'history-service') {
            return;
        }
        
        // Create CRDT operation record
        const operation: ICRDTOperation = {
            operationId: this._generateOperationId(),
            sequenceNumber: this._operationsSinceSnapshot + 1,
            documentId: this._documentId,
            userId: origin?.userId || 'unknown',
            timestamp: new Date(),
            operationType: this._classifyOperation(update),
            operationData: update,
            vectorClock: this._getVectorClock(doc),
            attribution: this._extractAttribution(update, origin)
        };
        
        // Log operation asynchronously
        this.logOperation(operation).catch(error => {
            console.error('Failed to log CRDT operation:', error);
        });
    }
    
    /**
     * Initialize storage backends
     */
    private async _initializeStorageBackends(): Promise<void> {
        if (!this._storageConfig) {
            throw new Error('Storage configuration not provided');
        }
        
        // Initialize Redis connection
        await this._initializeRedis();
        
        // Initialize MongoDB connection
        await this._initializeMongoDB();
        
        // Initialize PostgreSQL connection
        await this._initializePostgreSQL();
        
        // Initialize S3 connection
        await this._initializeS3();
    }
    
    /**
     * Generate unique snapshot ID
     */
    private _generateSnapshotId(): string {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2);
        return `snap_${this._documentId}_${timestamp}_${random}`;
    }
    
    /**
     * Generate unique operation ID
     */
    private _generateOperationId(): string {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2);
        return `op_${this._documentId}_${timestamp}_${random}`;
    }
    
    /**
     * Classify operation type from update data
     */
    private _classifyOperation(update: Uint8Array): string {
        // This is a simplified classification - in practice, would decode
        // the Yjs update to determine the actual operation type
        if (update.length < 10) {
            return 'delete';
        } else if (update.length > 100) {
            return 'insert';
        } else {
            return 'retain';
        }
    }
    
    /**
     * Get vector clock from Yjs document
     */
    private _getVectorClock(doc: Y.Doc): ReadonlyJSONObject {
        const stateVector = Y.encodeStateVector(doc);
        return {
            version: this._currentVersion,
            stateVector: Array.from(stateVector),
            clientId: doc.clientID
        };
    }
    
    /**
     * Extract attribution information from operation
     */
    private _extractAttribution(update: Uint8Array, origin: any): ICRDTOperation['attribution'] {
        // Extract attribution from origin metadata
        return {
            cellId: origin?.cellId,
            lineNumber: origin?.lineNumber,
            characterOffset: origin?.characterOffset,
            changeType: origin?.changeType || 'insert'
        };
    }
    
    /**
     * Select appropriate storage backend based on size and recency
     */
    private _selectStorageBackend(size: number, timestamp: Date): 'redis' | 'mongodb' | 's3' {
        const now = new Date();
        const ageHours = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);
        
        // Hot storage: Recent and small
        if (ageHours < 24 && size < 1024 * 1024) { // 1MB
            return 'redis';
        }
        
        // Warm storage: Recent or medium-sized
        if (ageHours < 24 * 7 && size < 10 * 1024 * 1024) { // 10MB, 1 week
            return 'mongodb';
        }
        
        // Cold storage: Everything else
        return 's3';
    }
    
    /**
     * Check if automatic snapshot should be triggered
     */
    private async _checkSnapshotTriggers(userId: string): Promise<void> {
        const now = new Date();
        const timeSinceSnapshot = now.getTime() - this._lastSnapshotTime.getTime();
        const intervalMs = this._snapshotPolicy.activeInterval * 60 * 1000;
        
        // Check triggers
        const timeExpired = timeSinceSnapshot > intervalMs;
        const operationLimit = this._operationsSinceSnapshot >= this._snapshotPolicy.maxOperations;
        const sizeLimit = this._yjsDocument ? 
            Y.encodeStateAsUpdate(this._yjsDocument).byteLength > this._snapshotPolicy.maxDocumentSize * 1024 * 1024 :
            false;
        
        if (timeExpired || operationLimit || sizeLimit) {
            const reason = timeExpired ? 'time' : operationLimit ? 'operations' : 'size';
            await this.createSnapshot(
                userId,
                `Automatic snapshot triggered by ${reason} threshold`
            );
        }
    }
    
    /**
     * Start automatic snapshot timer
     */
    private _startSnapshotTimer(): void {
        if (this._snapshotTimer) {
            clearInterval(this._snapshotTimer);
        }
        
        // Check every minute for snapshot triggers
        this._snapshotTimer = setInterval(() => {
            if (this._operationsSinceSnapshot > 0) {
                this._checkSnapshotTriggers('system').catch(error => {
                    console.error('Failed to create automatic snapshot:', error);
                });
            }
        }, 60 * 1000);
    }
    
    /**
     * Calculate compression ratio for snapshot data
     */
    private async _calculateCompressionRatio(data: Uint8Array): Promise<number> {
        // Simulate compression ratio calculation
        // In practice, would use actual compression library
        return Math.max(0.3, Math.min(0.9, 1 - (data.length / (data.length + 1000))));
    }
    
    // Storage backend implementation stubs
    // These would be implemented with actual database/storage clients
    
    private async _initializeRedis(): Promise<void> {
        // Initialize Redis client connection
        console.log('Initializing Redis connection for history service');
    }
    
    private async _initializeMongoDB(): Promise<void> {
        // Initialize MongoDB client connection
        console.log('Initializing MongoDB connection for history service');
    }
    
    private async _initializePostgreSQL(): Promise<void> {
        // Initialize PostgreSQL client connection
        console.log('Initializing PostgreSQL connection for history service');
    }
    
    private async _initializeS3(): Promise<void> {
        // Initialize S3 client connection
        console.log('Initializing S3 connection for history service');
    }
    
    private async _loadCurrentVersion(): Promise<number> {
        // Load current version from PostgreSQL metadata
        return 0;
    }
    
    private async _persistSnapshot(
        snapshotId: string,
        data: Uint8Array,
        metadata: JSONObject,
        backend: 'redis' | 'mongodb' | 's3'
    ): Promise<string> {
        // Persist snapshot to specified backend
        return `${backend}://${snapshotId}`;
    }
    
    private async _persistOperation(operation: ICRDTOperation): Promise<void> {
        // Persist operation to MongoDB
    }
    
    private async _storeSnapshotMetadata(snapshot: IVersionSnapshot): Promise<void> {
        // Store snapshot metadata in PostgreSQL
    }
    
    private async _querySnapshotMetadata(options: any): Promise<IVersionSnapshot[]> {
        // Query snapshot metadata from PostgreSQL
        return [];
    }
    
    private async _queryOperationLog(options: any): Promise<ICRDTOperation[]> {
        // Query operation log from MongoDB
        return [];
    }
    
    private async _loadSnapshot(version: number): Promise<IVersionSnapshot | null> {
        // Load snapshot metadata by version
        return null;
    }
    
    private async _loadSnapshotData(snapshot: IVersionSnapshot): Promise<Uint8Array> {
        // Load snapshot data from storage backend
        return new Uint8Array();
    }
    
    private async _removeVersionsAfter(version: number): Promise<void> {
        // Remove versions after specified version
    }
    
    private async _countOperationsAfterVersion(version: number): Promise<number> {
        // Count operations after specified version
        return 0;
    }
    
    private async _findSnapshotsForMigration(cutoffDate: Date): Promise<IVersionSnapshot[]> {
        // Find snapshots eligible for migration
        return [];
    }
    
    private async _storeInS3(snapshotId: string, data: Uint8Array, metadata: ReadonlyJSONObject): Promise<string> {
        // Store snapshot in S3
        return `s3://bucket/${snapshotId}`;
    }
    
    private async _updateSnapshotLocation(snapshotId: string, backend: string, location: string): Promise<void> {
        // Update snapshot location in metadata
    }
    
    private async _removeFromStorage(backend: string, location: string): Promise<void> {
        // Remove data from specified storage backend
    }
    
    private async _findExpiredSnapshots(cutoffDate: Date): Promise<IVersionSnapshot[]> {
        // Find expired snapshots
        return [];
    }
    
    private async _removeSnapshot(snapshot: IVersionSnapshot): Promise<void> {
        // Remove snapshot and its data
    }
    
    private async _archiveOldOperations(cutoffDate: Date): Promise<number> {
        // Archive old operations
        return 0;
    }
    
    private async _getRedisStats(): Promise<{ keyCount: number; memoryUsage: number }> {
        // Get Redis statistics
        return { keyCount: 0, memoryUsage: 0 };
    }
    
    private async _getMongoStats(): Promise<{ documentCount: number; storageSize: number }> {
        // Get MongoDB statistics
        return { documentCount: 0, storageSize: 0 };
    }
    
    private async _getPostgreSQLStats(): Promise<{ recordCount: number; tableSize: number }> {
        // Get PostgreSQL statistics
        return { recordCount: 0, tableSize: 0 };
    }
    
    private async _getS3Stats(): Promise<{ objectCount: number; totalSize: number }> {
        // Get S3 statistics
        return { objectCount: 0, totalSize: 0 };
    }
}

/**
 * Create a new history service instance
 */
export function createHistoryService(
    documentId: string,
    snapshotPolicy?: Partial<ISnapshotPolicy>
): IHistoryService {
    return new HistoryService(documentId, snapshotPolicy);
}

/**
 * Utility functions for history management
 */
export namespace HistoryUtils {
    /**
     * Format a version snapshot for display
     */
    export function formatSnapshot(snapshot: IVersionSnapshot): string {
        const date = snapshot.timestamp.toLocaleString();
        const size = (snapshot.snapshotSizeBytes / 1024).toFixed(1) + ' KB';
        return `Version ${snapshot.version} by ${snapshot.contributorId} at ${date} (${size})`;
    }
    
    /**
     * Calculate time since snapshot
     */
    export function getSnapshotAge(snapshot: IVersionSnapshot): string {
        const now = new Date();
        const diff = now.getTime() - snapshot.timestamp.getTime();
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const days = Math.floor(hours / 24);
        
        if (days > 0) {
            return `${days} day${days > 1 ? 's' : ''} ago`;
        } else if (hours > 0) {
            return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        } else {
            const minutes = Math.floor(diff / (1000 * 60));
            return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        }
    }
    
    /**
     * Validate storage configuration
     */
    export function validateStorageConfig(config: IStorageConfig): string[] {
        const errors: string[] = [];
        
        if (!config.redis.url) {
            errors.push('Redis URL is required');
        }
        
        if (!config.mongodb.connectionString) {
            errors.push('MongoDB connection string is required');
        }
        
        if (!config.postgresql.connectionString) {
            errors.push('PostgreSQL connection string is required');
        }
        
        if (!config.s3.bucket) {
            errors.push('S3 bucket is required');
        }
        
        return errors;
    }
}