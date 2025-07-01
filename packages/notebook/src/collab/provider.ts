// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { IDisposable, DisposableDelegate } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';
import { PromiseDelegate } from '@lumino/coreutils';

import { 
  INotebookModel,
  INotebookContent 
} from '@jupyterlab/notebook';
import {
  ICellModel,
  ICodeCellModel,
  IMarkdownCellModel,
  IRawCellModel
} from '@jupyterlab/cells';
import { IObservableList, IObservableMap } from '@jupyterlab/observables';
import { PageConfig } from '@jupyterlab/coreutils';

// Yjs imports for collaborative editing
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

// Local interfaces for collaboration components
export interface IYjsProviderOptions {
  /**
   * The notebook model to bind to the Yjs document.
   */
  notebookModel: INotebookModel;

  /**
   * The room ID for the collaborative session.
   * If not provided, will be generated from the notebook path.
   */
  roomId?: string;

  /**
   * WebSocket server URL for collaboration.
   * If not provided, will be constructed from current server.
   */
  serverUrl?: string;

  /**
   * Whether to enable debug logging.
   */
  debug?: boolean;

  /**
   * Connection timeout in milliseconds.
   */
  connectionTimeout?: number;

  /**
   * Maximum number of reconnection attempts.
   */
  maxReconnectAttempts?: number;

  /**
   * Initial reconnection delay in milliseconds.
   */
  reconnectDelay?: number;
}

export interface IConnectionMetrics {
  latency: number;
  isConnected: boolean;
  lastSync: Date | null;
  updatesSent: number;
  updatesReceived: number;
  bytesTransferred: number;
}

/**
 * Core YjsNotebookProvider class that manages the Yjs document lifecycle,
 * binds notebook models to Y.Doc CRDT structures, and handles WebSocket-based
 * real-time synchronization for collaborative editing with graceful fallback
 * to single-user mode.
 */
export class YjsNotebookProvider implements IDisposable {
  private _isDisposed = false;
  private _notebookModel: INotebookModel;
  private _ydoc: Y.Doc;
  private _ycells: Y.Array<Y.Map<any>>;
  private _ymetadata: Y.Map<any>;
  private _ycomments: Y.Map<Y.Array<any>>;
  private _ylocks: Y.Map<any>;
  private _websocketProvider: WebsocketProvider | null = null;
  private _awareness: Awareness | null = null;
  
  // Connection management
  private _roomId: string;
  private _serverUrl: string;
  private _isConnected = false;
  private _isConnecting = false;
  private _connectionPromise: PromiseDelegate<void> | null = null;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts: number;
  private _reconnectDelay: number;
  private _connectionTimeout: number;
  private _reconnectTimer: any = null;
  private _connectionTimer: any = null;
  
  // Synchronization management  
  private _isInitializing = false;
  private _suppressNotebookUpdates = false;
  private _suppressYjsUpdates = false;
  private _pendingUpdates: Array<() => void> = [];
  private _updateBatchTimer: any = null;
  private _lastSyncTime: Date | null = null;
  
  // Performance tracking
  private _metrics: IConnectionMetrics = {
    latency: 0,
    isConnected: false,
    lastSync: null,
    updatesSent: 0,
    updatesReceived: 0,
    bytesTransferred: 0
  };
  
  // Feature flags and configuration
  private _debug: boolean;
  private _collaborationEnabled: boolean;
  private _gracefulDegradationActive = false;
  
  // Signals
  private _connectedSignal = new Signal<this, boolean>(this);
  private _documentSyncedSignal = new Signal<this, void>(this);
  private _metricsChangedSignal = new Signal<this, IConnectionMetrics>(this);
  private _errorSignal = new Signal<this, Error>(this);

  /**
   * Construct a new YjsNotebookProvider.
   *
   * @param options - The options for creating the provider.
   */
  constructor(options: IYjsProviderOptions) {
    this._notebookModel = options.notebookModel;
    this._debug = options.debug ?? false;
    this._connectionTimeout = options.connectionTimeout ?? 10000;
    this._maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this._reconnectDelay = options.reconnectDelay ?? 1000;

    // Initialize Yjs document
    this._ydoc = new Y.Doc();
    this._ycells = this._ydoc.getArray<Y.Map<any>>('cells');
    this._ymetadata = this._ydoc.getMap<any>('metadata');
    this._ycomments = this._ydoc.getMap<Y.Array<any>>('comments');
    this._ylocks = this._ydoc.getMap<any>('locks');

    // Generate room ID and server URL
    this._roomId = options.roomId ?? this._generateRoomId();
    this._serverUrl = options.serverUrl ?? this._constructServerUrl();

    // Check if collaboration is enabled
    this._collaborationEnabled = this._checkCollaborationEnabled();

    // Set up Yjs document event handlers
    this._setupYjsEventHandlers();

    // Set up notebook model event handlers  
    this._setupNotebookEventHandlers();

    this._log('YjsNotebookProvider initialized', {
      roomId: this._roomId,
      serverUrl: this._serverUrl,
      collaborationEnabled: this._collaborationEnabled
    });
  }

  /**
   * Whether the provider has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Get the Yjs document.
   */
  get ydoc(): Y.Doc {
    return this._ydoc;
  }

  /**
   * Get the Yjs cells array.
   */
  get ycells(): Y.Array<Y.Map<any>> {
    return this._ycells;
  }

  /**
   * Get the Yjs metadata map.
   */
  get ymetadata(): Y.Map<any> {
    return this._ymetadata;
  }

  /**
   * Get the Yjs comments map.
   */
  get ycomments(): Y.Map<Y.Array<any>> {
    return this._ycomments;
  }

  /**
   * Get the Yjs locks map.
   */
  get ylocks(): Y.Map<any> {
    return this._ylocks;
  }

  /**
   * Get the awareness instance.
   */
  get awareness(): Awareness | null {
    return this._awareness;
  }

  /**
   * Whether the provider is connected to the collaboration server.
   */
  get isConnected(): boolean {
    return this._isConnected && this._websocketProvider?.wsconnected === true;
  }

  /**
   * Whether collaboration is enabled and functioning.
   */
  get isCollaborative(): boolean {
    return this._collaborationEnabled && !this._gracefulDegradationActive;
  }

  /**
   * Get the current connection metrics.
   */
  get metrics(): IConnectionMetrics {
    return { ...this._metrics };
  }

  /**
   * Signal emitted when connection status changes.
   */
  get connectedChanged(): ISignal<this, boolean> {
    return this._connectedSignal;
  }

  /**
   * Signal emitted when document is fully synchronized.
   */
  get documentSynced(): ISignal<this, void> {
    return this._documentSyncedSignal;
  }

  /**
   * Signal emitted when metrics change.
   */
  get metricsChanged(): ISignal<this, IConnectionMetrics> {
    return this._metricsChangedSignal;
  }

  /**
   * Signal emitted when an error occurs.
   */
  get error(): ISignal<this, Error> {
    return this._errorSignal;
  }

  /**
   * Connect to the collaboration server.
   */
  async connect(): Promise<void> {
    if (this._isDisposed) {
      throw new Error('YjsNotebookProvider has been disposed');
    }

    if (!this._collaborationEnabled) {
      this._log('Collaboration disabled, skipping connection');
      return;
    }

    if (this._isConnected || this._isConnecting) {
      return this._connectionPromise?.promise;
    }

    this._isConnecting = true;
    this._connectionPromise = new PromiseDelegate<void>();

    try {
      this._log('Connecting to collaboration server', {
        roomId: this._roomId,
        serverUrl: this._serverUrl
      });

      // Create WebSocket provider
      this._websocketProvider = new WebsocketProvider(
        this._serverUrl,
        this._roomId,
        this._ydoc,
        {
          connect: true,
          disableBc: false, // Enable broadcast channel for local communication
          maxBackoffTime: 5000
        }
      );

      // Create awareness instance
      this._awareness = this._websocketProvider.awareness;

      // Set up connection event handlers
      this._setupWebSocketEventHandlers();

      // Set connection timeout
      this._connectionTimer = setTimeout(() => {
        if (!this._isConnected) {
          this._handleConnectionTimeout();
        }
      }, this._connectionTimeout);

      // Initialize document state
      await this._initializeDocumentState();

      // Wait for initial synchronization
      await this._waitForInitialSync();

      this._isConnected = true;
      this._isConnecting = false;
      this._reconnectAttempts = 0;
      this._updateMetrics({ isConnected: true });
      
      this._log('Successfully connected to collaboration server');
      this._connectedSignal.emit(true);
      this._connectionPromise.resolve();

    } catch (error) {
      this._isConnecting = false;
      this._handleConnectionError(error as Error);
      this._connectionPromise.reject(error);
      throw error;
    } finally {
      if (this._connectionTimer) {
        clearTimeout(this._connectionTimer);
        this._connectionTimer = null;
      }
    }
  }

  /**
   * Disconnect from the collaboration server.
   */
  disconnect(): void {
    if (!this._isConnected && !this._isConnecting) {
      return;
    }

    this._log('Disconnecting from collaboration server');

    // Clear timers
    if (this._connectionTimer) {
      clearTimeout(this._connectionTimer);
      this._connectionTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Disconnect WebSocket provider
    if (this._websocketProvider) {
      this._websocketProvider.disconnect();
      this._websocketProvider.destroy();
      this._websocketProvider = null;
    }

    // Clear awareness
    this._awareness = null;

    this._isConnected = false;
    this._isConnecting = false;
    this._updateMetrics({ isConnected: false });
    this._connectedSignal.emit(false);
  }

  /**
   * Force synchronization of the current notebook state to Yjs.
   */
  syncToYjs(): void {
    if (!this.isCollaborative) {
      return;
    }

    this._log('Force syncing notebook model to Yjs');
    this._suppressYjsUpdates = true;

    try {
      // Clear existing Yjs state
      this._ycells.delete(0, this._ycells.length);
      this._ymetadata.clear();

      // Sync cells
      const cellMaps = Array.from(this._notebookModel.cells).map(cell => 
        this._cellModelToYjsMap(cell)
      );
      this._ycells.insert(0, cellMaps);

      // Sync metadata
      const metadata = this._notebookModel.metadata.toJSON();
      Object.entries(metadata).forEach(([key, value]) => {
        this._ymetadata.set(key, value);
      });

      this._lastSyncTime = new Date();
      this._updateMetrics({ lastSync: this._lastSyncTime });
      this._documentSyncedSignal.emit();

    } finally {
      this._suppressYjsUpdates = false;
    }
  }

  /**
   * Force synchronization of the Yjs state to notebook model.
   */
  syncFromYjs(): void {
    if (!this.isCollaborative) {
      return;
    }

    this._log('Force syncing Yjs to notebook model');
    this._suppressNotebookUpdates = true;

    try {
      // Clear existing notebook state
      this._notebookModel.cells.clear();

      // Sync cells from Yjs
      const cells: ICellModel[] = [];
      for (let i = 0; i < this._ycells.length; i++) {
        const ycell = this._ycells.get(i);
        const cellData = this._yjsMapToCellData(ycell);
        const cell = this._createCellModelFromData(cellData);
        cells.push(cell);
      }
      this._notebookModel.cells.pushAll(cells);

      // Sync metadata from Yjs
      this._notebookModel.metadata.clear();
      this._ymetadata.forEach((value, key) => {
        this._notebookModel.metadata.set(key, value);
      });

      this._lastSyncTime = new Date();
      this._updateMetrics({ lastSync: this._lastSyncTime });
      this._documentSyncedSignal.emit();

    } finally {
      this._suppressNotebookUpdates = false;
    }
  }

  /**
   * Dispose of the provider and clean up resources.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._log('Disposing YjsNotebookProvider');

    // Disconnect from collaboration
    this.disconnect();

    // Clear batch timer
    if (this._updateBatchTimer) {
      clearTimeout(this._updateBatchTimer);
      this._updateBatchTimer = null;
    }

    // Dispose Yjs document
    this._ydoc.destroy();

    // Clear pending updates
    this._pendingUpdates = [];

    // Disconnect notebook event handlers
    this._disconnectNotebookEventHandlers();

    this._isDisposed = true;
  }

  /**
   * Set up Yjs document event handlers.
   */
  private _setupYjsEventHandlers(): void {
    // Listen for cells array changes
    this._ycells.observe(this._onYjsCellsChanged.bind(this));

    // Listen for metadata changes
    this._ymetadata.observe(this._onYjsMetadataChanged.bind(this));

    // Listen for document updates for metrics
    this._ydoc.on('update', this._onYjsDocumentUpdate.bind(this));
  }

  /**
   * Set up notebook model event handlers.
   */
  private _setupNotebookEventHandlers(): void {
    if (this._notebookModel) {
      this._notebookModel.cells.changed.connect(this._onNotebookCellsChanged, this);
      this._notebookModel.metadataChanged.connect(this._onNotebookMetadataChanged, this);
    }
  }

  /**
   * Disconnect notebook model event handlers.
   */
  private _disconnectNotebookEventHandlers(): void {
    if (this._notebookModel) {
      this._notebookModel.cells.changed.disconnect(this._onNotebookCellsChanged, this);
      this._notebookModel.metadataChanged.disconnect(this._onNotebookMetadataChanged, this);
    }
  }

  /**
   * Set up WebSocket provider event handlers.
   */
  private _setupWebSocketEventHandlers(): void {
    if (!this._websocketProvider) {
      return;
    }

    this._websocketProvider.on('status', this._onWebSocketStatus.bind(this));
    this._websocketProvider.on('connection-close', this._onWebSocketClose.bind(this));
    this._websocketProvider.on('connection-error', this._onWebSocketError.bind(this));
    this._websocketProvider.on('sync', this._onWebSocketSync.bind(this));
  }

  /**
   * Handle Yjs cells array changes and update notebook model.
   */
  private _onYjsCellsChanged(event: Y.YArrayEvent<Y.Map<any>>): void {
    if (this._suppressNotebookUpdates || this._isInitializing) {
      return;
    }

    this._log('Yjs cells changed', { event });
    this._suppressNotebookUpdates = true;

    try {
      let cellIndex = 0;

      event.changes.delta.forEach((change: any) => {
        if (change.retain) {
          cellIndex += change.retain;
        } else if (change.insert) {
          // Insert new cells
          const newCells = change.insert as Y.Map<any>[];
          const cellModels = newCells.map((ycell: Y.Map<any>) => {
            const cellData = this._yjsMapToCellData(ycell);
            return this._createCellModelFromData(cellData);
          });
          
          for (let i = 0; i < cellModels.length; i++) {
            this._notebookModel.cells.insert(cellIndex + i, cellModels[i]);
          }
          cellIndex += newCells.length;
        } else if (change.delete) {
          // Delete cells
          for (let i = 0; i < change.delete; i++) {
            if (cellIndex < this._notebookModel.cells.length) {
              this._notebookModel.cells.remove(cellIndex);
            }
          }
        }
      });

      this._updateMetrics({ updatesReceived: this._metrics.updatesReceived + 1 });

    } catch (error) {
      this._log('Error handling Yjs cells change', error);
      this._errorSignal.emit(error as Error);
    } finally {
      this._suppressNotebookUpdates = false;
    }
  }

  /**
   * Handle Yjs metadata changes and update notebook model.
   */
  private _onYjsMetadataChanged(event: Y.YMapEvent<any>): void {
    if (this._suppressNotebookUpdates || this._isInitializing) {
      return;
    }

    this._log('Yjs metadata changed', { event });
    this._suppressNotebookUpdates = true;

    try {
      event.keysChanged.forEach(key => {
        const value = event.target.get(key);
        if (value !== undefined) {
          this._notebookModel.metadata.set(key, value);
        } else {
          this._notebookModel.metadata.delete(key);
        }
      });

      this._updateMetrics({ updatesReceived: this._metrics.updatesReceived + 1 });

    } catch (error) {
      this._log('Error handling Yjs metadata change', error);
      this._errorSignal.emit(error as Error);
    } finally {
      this._suppressNotebookUpdates = false;
    }
  }

  /**
   * Handle Yjs document updates for metrics tracking.
   */
  private _onYjsDocumentUpdate(update: Uint8Array, origin: any): void {
    this._updateMetrics({ 
      bytesTransferred: this._metrics.bytesTransferred + update.length 
    });
  }

  /**
   * Handle notebook cells changes and update Yjs.
   */
  private _onNotebookCellsChanged(
    sender: IObservableList<ICellModel>,
    args: IObservableList.IChangedArgs<ICellModel>
  ): void {
    if (this._suppressYjsUpdates || !this.isCollaborative) {
      return;
    }

    this._log('Notebook cells changed', { args });
    this._batchUpdate(() => {
      this._suppressYjsUpdates = true;

      try {
        switch (args.type) {
          case 'add':
            // Insert cells into Yjs array
            const yjsCellsToInsert = args.newValues.map(cell => 
              this._cellModelToYjsMap(cell)
            );
            this._ycells.insert(args.newIndex, yjsCellsToInsert);
            break;

          case 'remove':
            // Remove cells from Yjs array
            this._ycells.delete(args.oldIndex, args.oldValues.length);
            break;

          case 'move':
            // Move cells in Yjs array
            const movedCells = this._ycells.slice(
              args.oldIndex, 
              args.oldIndex + args.newValues.length
            );
            this._ycells.delete(args.oldIndex, args.newValues.length);
            this._ycells.insert(args.newIndex, movedCells);
            break;

          case 'set':
            // Replace cells in Yjs array
            const yjsCellsToSet = args.newValues.map(cell => 
              this._cellModelToYjsMap(cell)
            );
            this._ycells.delete(args.newIndex, args.oldValues.length);
            this._ycells.insert(args.newIndex, yjsCellsToSet);
            break;
        }

        this._updateMetrics({ updatesSent: this._metrics.updatesSent + 1 });

      } catch (error) {
        this._log('Error handling notebook cells change', error);
        this._errorSignal.emit(error as Error);
      } finally {
        this._suppressYjsUpdates = false;
      }
    });
  }

  /**
   * Handle notebook metadata changes and update Yjs.
   */
  private _onNotebookMetadataChanged(
    sender: IObservableMap<any>,
    args: IObservableMap.IChangedArgs<any>
  ): void {
    if (this._suppressYjsUpdates || !this.isCollaborative) {
      return;
    }

    this._log('Notebook metadata changed', { args });
    this._batchUpdate(() => {
      this._suppressYjsUpdates = true;

      try {
        switch (args.type) {
          case 'add':
          case 'change':
            this._ymetadata.set(args.key, args.newValue);
            break;
          case 'remove':
            this._ymetadata.delete(args.key);
            break;
        }

        this._updateMetrics({ updatesSent: this._metrics.updatesSent + 1 });

      } catch (error) {
        this._log('Error handling notebook metadata change', error);
        this._errorSignal.emit(error as Error);
      } finally {
        this._suppressYjsUpdates = false;
      }
    });
  }

  /**
   * Handle WebSocket status changes.
   */
  private _onWebSocketStatus(event: { status: string }): void {
    this._log('WebSocket status changed', event);
    
    if (event.status === 'connected') {
      this._isConnected = true;
      this._updateMetrics({ isConnected: true });
      this._connectedSignal.emit(true);
    } else if (event.status === 'disconnected') {
      this._isConnected = false;
      this._updateMetrics({ isConnected: false });
      this._connectedSignal.emit(false);
      this._scheduleReconnection();
    }
  }

  /**
   * Handle WebSocket connection close.
   */
  private _onWebSocketClose(event: any): void {
    this._log('WebSocket connection closed', event);
    this._isConnected = false;
    this._updateMetrics({ isConnected: false });
    this._connectedSignal.emit(false);
    this._scheduleReconnection();
  }

  /**
   * Handle WebSocket connection errors.
   */
  private _onWebSocketError(event: any): void {
    this._log('WebSocket connection error', event);
    this._errorSignal.emit(new Error(`WebSocket error: ${event.message || 'Unknown error'}`));
    this._scheduleReconnection();
  }

  /**
   * Handle WebSocket sync events.
   */
  private _onWebSocketSync(event: { synced: boolean }): void {
    this._log('WebSocket sync event', event);
    
    if (event.synced) {
      this._lastSyncTime = new Date();
      this._updateMetrics({ lastSync: this._lastSyncTime });
      this._documentSyncedSignal.emit();
    }
  }

  /**
   * Initialize document state when connecting.
   */
  private async _initializeDocumentState(): Promise<void> {
    this._isInitializing = true;

    try {
      // Check if Yjs document is empty (first connection)
      if (this._ycells.length === 0 && this._ymetadata.size === 0) {
        this._log('Initializing empty Yjs document from notebook model');
        this.syncToYjs();
      } else {
        this._log('Syncing from existing Yjs document');
        this.syncFromYjs();
      }
    } finally {
      this._isInitializing = false;
    }
  }

  /**
   * Wait for initial synchronization to complete.
   */
  private async _waitForInitialSync(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Initial sync timeout'));
      }, this._connectionTimeout);

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
   * Convert a cell model to a Yjs Map.
   */
  private _cellModelToYjsMap(cell: ICellModel): Y.Map<any> {
    const ycell = new Y.Map();
    
    ycell.set('id', cell.id);
    ycell.set('cell_type', cell.type);
    ycell.set('source', cell.value.text);
    ycell.set('metadata', cell.metadata.toJSON());

    // Add cell-type-specific fields
    if (cell.type === 'code') {
      const codeCell = cell as ICodeCellModel;
      ycell.set('execution_count', codeCell.executionCount);
      ycell.set('outputs', codeCell.outputs.toJSON());
    }

    return ycell;
  }

  /**
   * Convert a Yjs Map to cell data object.
   */
  private _yjsMapToCellData(ycell: Y.Map<any>): any {
    const cellData: any = {
      id: ycell.get('id'),
      cell_type: ycell.get('cell_type'),
      source: ycell.get('source') || '',
      metadata: ycell.get('metadata') || {}
    };

    if (cellData.cell_type === 'code') {
      cellData.execution_count = ycell.get('execution_count') || null;
      cellData.outputs = ycell.get('outputs') || [];
    }

    return cellData;
  }

  /**
   * Create a cell model from cell data.
   */
  private _createCellModelFromData(cellData: any): ICellModel {
    const options = {
      id: cellData.id,
      contentFactory: this._notebookModel.contentFactory
    };

    let cell: ICellModel;

    switch (cellData.cell_type) {
      case 'code':
        const { CodeCellModel } = require('@jupyterlab/cells');
        cell = new CodeCellModel(options);
        const codeCell = cell as ICodeCellModel;
        if (cellData.execution_count !== undefined) {
          codeCell.executionCount = cellData.execution_count;
        }
        if (cellData.outputs) {
          codeCell.outputs.fromJSON(cellData.outputs);
        }
        break;
      case 'markdown':
        const { MarkdownCellModel } = require('@jupyterlab/cells');
        cell = new MarkdownCellModel(options);
        break;
      case 'raw':
        const { RawCellModel } = require('@jupyterlab/cells');
        cell = new RawCellModel(options);
        break;
      default:
        throw new Error(`Unknown cell type: ${cellData.cell_type}`);
    }

    // Set cell content and metadata
    cell.value.text = cellData.source || '';
    if (cellData.metadata) {
      cell.metadata.fromJSON(cellData.metadata);
    }

    return cell;
  }

  /**
   * Batch multiple updates to reduce network traffic.
   */
  private _batchUpdate(updateFn: () => void): void {
    this._pendingUpdates.push(updateFn);

    if (this._updateBatchTimer) {
      return;
    }

    this._updateBatchTimer = setTimeout(() => {
      const updates = [...this._pendingUpdates];
      this._pendingUpdates = [];
      this._updateBatchTimer = null;

      // Execute all pending updates in a single transaction
      this._ydoc.transact(() => {
        updates.forEach(update => {
          try {
            update();
          } catch (error) {
            this._log('Error in batched update', error);
          }
        });
      });
    }, 50); // 50ms batch window
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private _scheduleReconnection(): void {
    if (!this._collaborationEnabled || this._isDisposed || this._gracefulDegradationActive) {
      return;
    }

    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._log('Max reconnection attempts reached, enabling graceful degradation');
      this._enableGracefulDegradation();
      return;
    }

    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts);
    this._reconnectAttempts++;

    this._log(`Scheduling reconnection attempt ${this._reconnectAttempts} in ${delay}ms`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      
      try {
        await this.connect();
      } catch (error) {
        this._log('Reconnection attempt failed', error);
        this._scheduleReconnection();
      }
    }, delay);
  }

  /**
   * Handle connection timeout.
   */
  private _handleConnectionTimeout(): void {
    this._log('Connection timeout');
    const error = new Error('Connection timeout');
    this._errorSignal.emit(error);
    this._scheduleReconnection();
  }

  /**
   * Handle connection errors.
   */
  private _handleConnectionError(error: Error): void {
    this._log('Connection error', error);
    this._errorSignal.emit(error);
    this._isConnected = false;
    this._isConnecting = false;
    this._updateMetrics({ isConnected: false });
    this._connectedSignal.emit(false);
    this._scheduleReconnection();
  }

  /**
   * Enable graceful degradation to single-user mode.
   */
  private _enableGracefulDegradation(): void {
    this._log('Enabling graceful degradation to single-user mode');
    this._gracefulDegradationActive = true;
    this._collaborationEnabled = false;
    this.disconnect();
  }

  /**
   * Update connection metrics.
   */
  private _updateMetrics(updates: Partial<IConnectionMetrics>): void {
    Object.assign(this._metrics, updates);
    this._metricsChangedSignal.emit(this._metrics);
  }

  /**
   * Generate a room ID from the notebook path or model.
   */
  private _generateRoomId(): string {
    // Try to get a unique identifier for the notebook
    const path = (this._notebookModel as any).path || 
                 (this._notebookModel as any).context?.path ||
                 'default-notebook';
    
    // Create a room ID that's URL-safe and includes a timestamp for uniqueness
    const timestamp = Date.now();
    const roomId = `notebook-${path.replace(/[^a-zA-Z0-9-_]/g, '-')}-${timestamp}`;
    return roomId;
  }

  /**
   * Construct the WebSocket server URL for collaboration.
   */
  private _constructServerUrl(): string {
    const baseUrl = PageConfig.getBaseUrl();
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    return `${wsUrl}api/collaboration/yjs`;
  }

  /**
   * Check if collaboration is enabled via feature flags.
   */
  private _checkCollaborationEnabled(): boolean {
    // Check various sources for collaboration enablement
    if (typeof window !== 'undefined') {
      // Browser environment - check window variable
      if ((window as any).__JUPYTER_COLLABORATION_ENABLED__ === false) {
        return false;
      }
    }
    
    // Check page config
    const pageConfig = PageConfig.getOption('collaborationEnabled');
    if (pageConfig === 'false') {
      return false;
    }

    // Default to enabled
    return true;
  }

  /**
   * Log debug messages if debug mode is enabled.
   */
  private _log(message: string, data?: any): void {
    if (this._debug) {
      console.log(`[YjsNotebookProvider] ${message}`, data || '');
    }
  }
}

/**
 * The default provider factory for creating YjsNotebookProvider instances.
 */
export namespace YjsNotebookProvider {
  /**
   * Create a new YjsNotebookProvider for the given notebook model.
   *
   * @param notebookModel - The notebook model to provide collaboration for.
   * @param options - Optional configuration for the provider.
   * @returns A new YjsNotebookProvider instance.
   */
  export function createProvider(
    notebookModel: INotebookModel,
    options: Partial<IYjsProviderOptions> = {}
  ): YjsNotebookProvider {
    return new YjsNotebookProvider({
      notebookModel,
      ...options
    });
  }

  /**
   * Default configuration for YjsNotebookProvider instances.
   */
  export const defaultConfig = {
    debug: false,
    connectionTimeout: 10000,
    maxReconnectAttempts: 5,
    reconnectDelay: 1000
  };
}