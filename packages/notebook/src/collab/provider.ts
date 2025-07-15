// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Y } from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { YNotebook } from '@jupyter/ydoc';
import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * Connection status enumeration for collaboration state tracking
 */
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  SYNCING = 'syncing',
  SYNCED = 'synced',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
  OFFLINE = 'offline'
}

/**
 * Synchronization status enumeration for tracking sync operations
 */
export enum SyncStatus {
  IDLE = 'idle',
  SYNCING = 'syncing',
  SYNCED = 'synced',
  CONFLICT = 'conflict',
  ERROR = 'error',
  OFFLINE = 'offline',
  PAUSED = 'paused'
}

/**
 * Interface representing document update events
 */
export interface IDocumentUpdateEvent {
  /** Binary update data from Yjs */
  update: Uint8Array;
  /** Origin of the update (local, remote, or system) */
  origin: string;
  /** Yjs transaction object */
  transaction: Y.Transaction;
  /** Timestamp of the update */
  timestamp: number;
  /** Author of the update */
  author: string;
  /** Detailed changes in the update */
  changes: Y.YEvent<any>[];
  /** Current document state vector */
  stateVector: Uint8Array;
}

/**
 * Interface representing connection state information
 */
export interface IConnectionState {
  /** Current connection status */
  status: ConnectionStatus;
  /** Whether the connection is established */
  connected: boolean;
  /** Whether the document is synchronized */
  synced: boolean;
  /** Last successful synchronization time */
  lastSyncTime: number;
  /** Unique session identifier */
  sessionId: string;
  /** Current error message, if any */
  errorMessage?: string;
  /** Current retry count for reconnection */
  retryCount: number;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Current reconnection delay in milliseconds */
  reconnectDelay: number;
}

/**
 * Interface representing synchronization status information
 */
export interface ISyncStatus {
  /** Current sync status */
  status: SyncStatus;
  /** Synchronization progress percentage */
  progress: number;
  /** Timestamp of last update */
  lastUpdate: number;
  /** Number of pending updates */
  pendingUpdates: number;
  /** Number of conflicts detected */
  conflictCount: number;
  /** Number of resolved conflicts */
  resolvedConflicts: number;
  /** Number of sync errors */
  errorCount: number;
  /** Current bandwidth usage in bytes per second */
  bandwidth: number;
}

/**
 * Interface for provider configuration options
 */
export interface IProviderConfig {
  /** WebSocket URL for collaboration server */
  websocketUrl: string;
  /** Room name for collaboration session */
  roomName: string;
  /** Enable offline mode with persistence */
  enableOfflineMode: boolean;
  /** Reconnection delay in milliseconds */
  reconnectDelay: number;
  /** Maximum reconnection attempts */
  maxRetries: number;
  /** Heartbeat interval in milliseconds */
  heartbeatInterval: number;
  /** Enable awareness protocol */
  enableAwareness: boolean;
  /** Enable IndexedDB persistence */
  enablePersistence: boolean;
  /** Persistence configuration options */
  persistenceConfig?: {
    /** IndexedDB database name */
    dbName?: string;
    /** Clear data on disconnect */
    clearOnDisconnect?: boolean;
  };
}

/**
 * Interface for collaboration manager functionality
 */
export interface ICollaborationManager {
  /** Connect to collaboration server */
  connect(): Promise<void>;
  /** Disconnect from collaboration server */
  disconnect(): Promise<void>;
  /** Check if connected to collaboration server */
  isConnected: boolean;
  /** Get list of active users */
  getActiveUsers(): any[];
  /** Get user awareness information */
  getUserAwareness(): any;
  /** Get change history */
  getChangeHistory(): any[];
  /** Get the collaboration provider instance */
  getProvider(): YjsNotebookProvider;
  /** Current connection state */
  connectionState: IConnectionState;
  /** Current sync status */
  syncStatus: ISyncStatus;
  /** Signal emitted when connection state changes */
  onConnectionStateChanged: ISignal<ICollaborationManager, IConnectionState>;
  /** Signal emitted when sync state changes */
  onSyncStateChanged: ISignal<ICollaborationManager, ISyncStatus>;
}

/**
 * YjsNotebookProvider: Core document synchronization component for real-time collaborative editing
 *
 * This provider manages Yjs CRDT document synchronization between clients, handles WebSocket
 * connections for real-time updates, and provides offline editing capabilities through IndexedDB persistence.
 */
export default class YjsNotebookProvider implements IDisposable {
  private _yjsDocument: Y.Doc;
  private _yNotebook: YNotebook;
  private _websocketProvider: WebsocketProvider | null = null;
  private _indexedDBProvider: IndexeddbPersistence | null = null;
  private _config: IProviderConfig;
  private _sessionId: string;
  private _disposed = false;
  private _connectionState: IConnectionState;
  private _syncStatus: ISyncStatus;
  private _reconnectTimer: number | null = null;
  private _heartbeatTimer: number | null = null;
  private _updateCount = 0;
  private _lastUpdateTime = 0;
  private _bandwidthTracker: number[] = [];

  // Signals for state change notifications
  private _onConnectionStateChanged = new Signal<YjsNotebookProvider, IConnectionState>(this);
  private _onSyncStateChanged = new Signal<YjsNotebookProvider, ISyncStatus>(this);
  private _onDocumentChanged = new Signal<YjsNotebookProvider, IDocumentUpdateEvent>(this);

  /**
   * Construct a new YjsNotebookProvider
   *
   * @param config - Configuration options for the provider
   * @param initialNotebookData - Initial notebook data to load
   */
  constructor(config: IProviderConfig, initialNotebookData?: any) {
    this._config = { ...config };
    this._sessionId = UUID.uuid4();
    
    // Initialize Yjs document
    this._yjsDocument = new Y.Doc();
    this._yNotebook = new YNotebook();
    
    // Initialize connection state
    this._connectionState = {
      status: ConnectionStatus.DISCONNECTED,
      connected: false,
      synced: false,
      lastSyncTime: 0,
      sessionId: this._sessionId,
      retryCount: 0,
      maxRetries: config.maxRetries,
      reconnectDelay: config.reconnectDelay
    };

    // Initialize sync status
    this._syncStatus = {
      status: SyncStatus.IDLE,
      progress: 0,
      lastUpdate: 0,
      pendingUpdates: 0,
      conflictCount: 0,
      resolvedConflicts: 0,
      errorCount: 0,
      bandwidth: 0
    };

    // Set up document event handlers
    this._setupDocumentObservers();
    
    // Load initial notebook data if provided
    if (initialNotebookData) {
      this._loadInitialData(initialNotebookData);
    }

    // Initialize persistence if enabled
    if (config.enablePersistence) {
      this._initializePersistence();
    }
  }

  /**
   * Get the current connection state
   */
  get connectionState(): IConnectionState {
    return { ...this._connectionState };
  }

  /**
   * Get the unique session identifier
   */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Check if the provider is connected
   */
  get isConnected(): boolean {
    return this._connectionState.connected;
  }

  /**
   * Signal emitted when connection state changes
   */
  get onConnectionStateChanged(): ISignal<YjsNotebookProvider, IConnectionState> {
    return this._onConnectionStateChanged;
  }

  /**
   * Get the current synchronization status
   */
  get synchronizationStatus(): ISyncStatus {
    return { ...this._syncStatus };
  }

  /**
   * Signal emitted when sync state changes
   */
  get onSyncStateChanged(): ISignal<YjsNotebookProvider, ISyncStatus> {
    return this._onSyncStateChanged;
  }

  /**
   * Get the underlying Yjs document
   */
  get yjsDocument(): Y.Doc {
    return this._yjsDocument;
  }

  /**
   * Signal emitted when document changes
   */
  get onDocumentChanged(): ISignal<YjsNotebookProvider, IDocumentUpdateEvent> {
    return this._onDocumentChanged;
  }

  /**
   * Get the current state vector of the document
   */
  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this._yjsDocument);
  }

  /**
   * Get updates since the given state vector
   */
  getUpdates(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this._yjsDocument, stateVector);
  }

  /**
   * Apply an update to the document
   */
  applyUpdate(update: Uint8Array, origin?: string): void {
    try {
      Y.applyUpdate(this._yjsDocument, update, origin || 'remote');
      this._updateSyncStatus({
        ...this._syncStatus,
        lastUpdate: Date.now()
      });
    } catch (error) {
      console.error('Failed to apply update:', error);
      this._updateSyncStatus({
        ...this._syncStatus,
        errorCount: this._syncStatus.errorCount + 1,
        status: SyncStatus.ERROR
      });
    }
  }

  /**
   * Create a snapshot of the current document state
   */
  createSnapshot(): Uint8Array {
    return Y.encodeStateAsUpdate(this._yjsDocument);
  }

  /**
   * Get the awareness instance for user presence tracking
   */
  get awareness(): any {
    return this._websocketProvider?.awareness || null;
  }

  /**
   * Get the WebSocket provider instance
   */
  get websocketProvider(): WebsocketProvider | null {
    return this._websocketProvider;
  }

  /**
   * Get the IndexedDB provider instance
   */
  get indexedDBProvider(): IndexeddbPersistence | null {
    return this._indexedDBProvider;
  }

  /**
   * Get the YNotebook instance
   */
  get yNotebook(): YNotebook {
    return this._yNotebook;
  }

  /**
   * Get the provider configuration
   */
  get config(): IProviderConfig {
    return { ...this._config };
  }

  /**
   * Connect to the collaboration server
   */
  async connect(): Promise<void> {
    if (this._disposed) {
      throw new Error('Provider has been disposed');
    }

    if (this._connectionState.connected) {
      return;
    }

    this._updateConnectionState({
      ...this._connectionState,
      status: ConnectionStatus.CONNECTING
    });

    try {
      // Initialize WebSocket provider
      this._websocketProvider = new WebsocketProvider(
        this._config.websocketUrl,
        this._config.roomName,
        this._yjsDocument,
        {
          // Configure WebSocket options
          connect: true,
          awareness: this._config.enableAwareness ? undefined : null,
          params: {
            sessionId: this._sessionId
          }
        }
      );

      // Set up WebSocket event handlers
      this._setupWebSocketObservers();

      // Start heartbeat if configured
      if (this._config.heartbeatInterval > 0) {
        this._startHeartbeat();
      }

      // Wait for initial sync
      await this._waitForInitialSync();

      this._updateConnectionState({
        ...this._connectionState,
        status: ConnectionStatus.CONNECTED,
        connected: true,
        lastSyncTime: Date.now(),
        retryCount: 0
      });

      this._updateSyncStatus({
        ...this._syncStatus,
        status: SyncStatus.SYNCED
      });

    } catch (error) {
      console.error('Failed to connect:', error);
      this._updateConnectionState({
        ...this._connectionState,
        status: ConnectionStatus.ERROR,
        errorMessage: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Disconnect from the collaboration server
   */
  async disconnect(): Promise<void> {
    if (!this._connectionState.connected) {
      return;
    }

    this._updateConnectionState({
      ...this._connectionState,
      status: ConnectionStatus.DISCONNECTED,
      connected: false,
      synced: false
    });

    // Stop heartbeat
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // Stop reconnection timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Destroy WebSocket provider
    if (this._websocketProvider) {
      this._websocketProvider.destroy();
      this._websocketProvider = null;
    }

    this._updateSyncStatus({
      ...this._syncStatus,
      status: SyncStatus.IDLE
    });
  }

  /**
   * Get connection health information
   */
  getConnectionHealth(): {
    healthy: boolean;
    latency: number;
    packetLoss: number;
    bandwidth: number;
  } {
    const isHealthy = this._connectionState.connected && 
                     this._connectionState.synced && 
                     this._syncStatus.errorCount < 5;

    return {
      healthy: isHealthy,
      latency: this._calculateLatency(),
      packetLoss: this._calculatePacketLoss(),
      bandwidth: this._syncStatus.bandwidth
    };
  }

  /**
   * Get session information
   */
  getSessionInfo(): {
    sessionId: string;
    roomName: string;
    connectedUsers: number;
    uptime: number;
    documentSize: number;
  } {
    return {
      sessionId: this._sessionId,
      roomName: this._config.roomName,
      connectedUsers: this._websocketProvider?.awareness?.getStates().size || 0,
      uptime: this._connectionState.lastSyncTime > 0 ? Date.now() - this._connectionState.lastSyncTime : 0,
      documentSize: this._yjsDocument.toUint8Array().length
    };
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): ConnectionStatus {
    return this._connectionState.status;
  }

  /**
   * Get synchronization status
   */
  getSyncStatus(): SyncStatus {
    return this._syncStatus.status;
  }

  /**
   * Reconnect to the collaboration server
   */
  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  /**
   * Set offline mode
   */
  setOfflineMode(enabled: boolean): void {
    if (enabled) {
      this._updateConnectionState({
        ...this._connectionState,
        status: ConnectionStatus.OFFLINE
      });
      this._updateSyncStatus({
        ...this._syncStatus,
        status: SyncStatus.OFFLINE
      });
    } else {
      this.reconnect().catch(console.error);
    }
  }

  /**
   * Enable persistence
   */
  enablePersistence(): void {
    if (!this._indexedDBProvider) {
      this._initializePersistence();
    }
  }

  /**
   * Disable persistence
   */
  disablePersistence(): void {
    if (this._indexedDBProvider) {
      this._indexedDBProvider.destroy();
      this._indexedDBProvider = null;
    }
  }

  /**
   * Clear local data
   */
  async clearLocalData(): Promise<void> {
    if (this._indexedDBProvider) {
      await this._indexedDBProvider.clearData();
    }
  }

  /**
   * Check if the provider is disposed
   */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the provider and clean up resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Disconnect from collaboration server
    this.disconnect().catch(console.error);

    // Clean up persistence
    if (this._indexedDBProvider) {
      this._indexedDBProvider.destroy();
      this._indexedDBProvider = null;
    }

    // Clean up Yjs document
    this._yjsDocument.destroy();

    // Clean up signals
    Signal.clearData(this);
  }

  /**
   * Initialize IndexedDB persistence
   */
  private _initializePersistence(): void {
    const dbName = this._config.persistenceConfig?.dbName || `jupyter-notebook-${this._config.roomName}`;
    
    this._indexedDBProvider = new IndexeddbPersistence(dbName, this._yjsDocument);
    
    // Set up persistence event handlers
    this._indexedDBProvider.whenSynced.then(() => {
      console.log('IndexedDB persistence synced');
    });
  }

  /**
   * Set up document observers for change tracking
   */
  private _setupDocumentObservers(): void {
    // Observe document updates
    this._yjsDocument.on('update', (update: Uint8Array, origin: string, doc: Y.Doc, transaction: Y.Transaction) => {
      this._handleDocumentUpdate(update, origin, transaction);
    });

    // Observe document changes
    this._yjsDocument.on('subdocs', (subdocs: Y.Doc[]) => {
      // Handle subdocument changes if needed
    });
  }

  /**
   * Set up WebSocket provider observers
   */
  private _setupWebSocketObservers(): void {
    if (!this._websocketProvider) return;

    // Connection status events
    this._websocketProvider.on('status', (event: { status: string }) => {
      this._handleWebSocketStatus(event.status);
    });

    // Sync events
    this._websocketProvider.on('sync', (isSynced: boolean) => {
      this._handleSyncState(isSynced);
    });

    // Connection events
    this._websocketProvider.on('connection-close', () => {
      this._handleConnectionClose();
    });

    this._websocketProvider.on('connection-error', (error: Error) => {
      this._handleConnectionError(error);
    });
  }

  /**
   * Handle document update events
   */
  private _handleDocumentUpdate(update: Uint8Array, origin: string, transaction: Y.Transaction): void {
    const now = Date.now();
    this._updateCount++;
    this._lastUpdateTime = now;

    // Track bandwidth
    this._bandwidthTracker.push(update.length);
    this._updateBandwidthMetrics();

    // Create document update event
    const updateEvent: IDocumentUpdateEvent = {
      update,
      origin,
      transaction,
      timestamp: now,
      author: this._sessionId,
      changes: transaction.changedParentTypes.values() as Y.YEvent<any>[],
      stateVector: this.getStateVector()
    };

    // Emit document change signal
    this._onDocumentChanged.emit(updateEvent);

    // Update sync status
    this._updateSyncStatus({
      ...this._syncStatus,
      lastUpdate: now,
      status: SyncStatus.SYNCING
    });
  }

  /**
   * Handle WebSocket status changes
   */
  private _handleWebSocketStatus(status: string): void {
    let connectionStatus: ConnectionStatus;
    
    switch (status) {
      case 'connecting':
        connectionStatus = ConnectionStatus.CONNECTING;
        break;
      case 'connected':
        connectionStatus = ConnectionStatus.CONNECTED;
        break;
      case 'disconnected':
        connectionStatus = ConnectionStatus.DISCONNECTED;
        break;
      default:
        connectionStatus = ConnectionStatus.ERROR;
    }

    this._updateConnectionState({
      ...this._connectionState,
      status: connectionStatus,
      connected: status === 'connected'
    });
  }

  /**
   * Handle sync state changes
   */
  private _handleSyncState(isSynced: boolean): void {
    this._updateConnectionState({
      ...this._connectionState,
      synced: isSynced,
      lastSyncTime: isSynced ? Date.now() : this._connectionState.lastSyncTime
    });

    this._updateSyncStatus({
      ...this._syncStatus,
      status: isSynced ? SyncStatus.SYNCED : SyncStatus.SYNCING
    });
  }

  /**
   * Handle connection close events
   */
  private _handleConnectionClose(): void {
    this._updateConnectionState({
      ...this._connectionState,
      connected: false,
      synced: false
    });

    // Attempt reconnection with exponential backoff
    this._scheduleReconnection();
  }

  /**
   * Handle connection error events
   */
  private _handleConnectionError(error: Error): void {
    console.error('WebSocket connection error:', error);
    
    this._updateConnectionState({
      ...this._connectionState,
      status: ConnectionStatus.ERROR,
      errorMessage: error.message
    });

    this._updateSyncStatus({
      ...this._syncStatus,
      status: SyncStatus.ERROR,
      errorCount: this._syncStatus.errorCount + 1
    });

    // Attempt reconnection with exponential backoff
    this._scheduleReconnection();
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private _scheduleReconnection(): void {
    if (this._disposed || this._connectionState.retryCount >= this._connectionState.maxRetries) {
      return;
    }

    const delay = Math.min(
      this._connectionState.reconnectDelay * Math.pow(2, this._connectionState.retryCount),
      30000 // Max delay of 30 seconds
    );

    this._updateConnectionState({
      ...this._connectionState,
      status: ConnectionStatus.RECONNECTING,
      retryCount: this._connectionState.retryCount + 1,
      reconnectDelay: delay
    });

    this._reconnectTimer = window.setTimeout(() => {
      this.reconnect().catch(console.error);
    }, delay);
  }

  /**
   * Start heartbeat monitoring
   */
  private _startHeartbeat(): void {
    this._heartbeatTimer = window.setInterval(() => {
      if (this._websocketProvider?.wsconnected) {
        // Send heartbeat ping
        this._websocketProvider.awareness?.setLocalStateField('heartbeat', Date.now());
      }
    }, this._config.heartbeatInterval);
  }

  /**
   * Wait for initial synchronization
   */
  private async _waitForInitialSync(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Initial sync timeout'));
      }, 10000);

      const checkSync = () => {
        if (this._websocketProvider?.synced) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkSync, 100);
        }
      };

      checkSync();
    });
  }

  /**
   * Load initial notebook data
   */
  private _loadInitialData(data: any): void {
    try {
      // Load data into YNotebook
      this._yNotebook.fromJSON(data);
      
      // Sync with Yjs document
      this._yjsDocument.getMap('notebook').set('data', this._yNotebook.getState());
    } catch (error) {
      console.error('Failed to load initial data:', error);
    }
  }

  /**
   * Update connection state and emit signal
   */
  private _updateConnectionState(newState: IConnectionState): void {
    this._connectionState = newState;
    this._onConnectionStateChanged.emit(newState);
  }

  /**
   * Update sync status and emit signal
   */
  private _updateSyncStatus(newStatus: ISyncStatus): void {
    this._syncStatus = newStatus;
    this._onSyncStateChanged.emit(newStatus);
  }

  /**
   * Calculate network latency
   */
  private _calculateLatency(): number {
    // Simplified latency calculation
    return Date.now() - this._lastUpdateTime;
  }

  /**
   * Calculate packet loss percentage
   */
  private _calculatePacketLoss(): number {
    // Simplified packet loss calculation
    return Math.max(0, (this._syncStatus.errorCount / Math.max(1, this._updateCount)) * 100);
  }

  /**
   * Update bandwidth metrics
   */
  private _updateBandwidthMetrics(): void {
    const now = Date.now();
    const windowSize = 5000; // 5 second window
    
    // Remove old entries
    this._bandwidthTracker = this._bandwidthTracker.filter(
      (_, index) => now - (index * 100) < windowSize
    );
    
    // Calculate bandwidth
    const totalBytes = this._bandwidthTracker.reduce((sum, bytes) => sum + bytes, 0);
    const bandwidth = totalBytes / (windowSize / 1000); // bytes per second
    
    this._updateSyncStatus({
      ...this._syncStatus,
      bandwidth
    });
  }
}