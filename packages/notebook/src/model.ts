/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Enhanced notebook model with Yjs CRDT integration for real-time collaborative editing.
 * Extends the existing INotebookModel interface to support bidirectional synchronization
 * between Yjs document types and the notebook model, mapping cells to Y.Array, cell content
 * to Y.Text, and metadata to Y.Map for conflict-free collaborative editing.
 */

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { INotebookModel } from '@jupyterlab/notebook';
import { ICellModel } from '@jupyterlab/cells';
import { ISignal, Signal } from '@lumino/signaling';
import { ICollaborationAwareness } from './tokens';

/**
 * Interface for Yjs WebSocket provider configuration
 */
interface IWebSocketProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  destroy(): void;
}

/**
 * Configuration options for NotebookModel collaboration features
 */
interface INotebookModelOptions {
  collaborationEnabled?: boolean;
  websocketUrl?: string;
  roomName?: string;
  awareness?: ICollaborationAwareness;
  batchingEnabled?: boolean;
  batchTimeout?: number;
  maxRetries?: number;
  connectionTimeout?: number;
}

/**
 * Cell sync event details
 */
interface ICellSyncEvent {
  cellId: string;
  operation: 'add' | 'remove' | 'update' | 'move';
  index?: number;
  cell?: ICellModel;
  oldValue?: any;
  newValue?: any;
}

/**
 * Enhanced notebook model with Yjs CRDT integration for real-time collaborative editing
 */
export class NotebookModel implements INotebookModel {
  private _yjsDoc: Y.Doc;
  private _provider: IWebSocketProvider | null = null;
  private _collaborationEnabled: boolean;
  private _readOnly: boolean = false;
  private _dirty: boolean = false;
  private _isDisposed: boolean = false;
  private _awareness: ICollaborationAwareness | null = null;

  // Yjs data structures for collaborative editing
  private _yjsCells: Y.Array<Y.Map<any>>;
  private _yjsMetadata: Y.Map<any>;
  private _cellIdMap: Map<string, ICellModel> = new Map();
  private _batchTimeout: number;
  private _batchingEnabled: boolean;
  private _pendingUpdates: Set<() => void> = new Set();
  private _batchTimer: any = null;
  private _syncInProgress: boolean = false;

  // Signals for reactive updates
  private _onYjsUpdateSignal = new Signal<NotebookModel, { origin: any; update: Uint8Array }>(this);
  private _cellsChangedSignal = new Signal<NotebookModel, ICellSyncEvent>(this);
  private _metadataChangedSignal = new Signal<NotebookModel, { key: string; oldValue: any; newValue: any }>(this);
  private _dirtyChangedSignal = new Signal<NotebookModel, boolean>(this);
  private _readOnlyChangedSignal = new Signal<NotebookModel, boolean>(this);

  // Connection management
  private _connectionRetries: number = 0;
  private _maxRetries: number;
  private _connectionTimeout: number;
  private _reconnectTimer: any = null;

  /**
   * Create a new NotebookModel with optional collaboration features
   */
  constructor(options: INotebookModelOptions = {}) {
    // Initialize Yjs document and collaboration settings
    this._yjsDoc = new Y.Doc();
    this._collaborationEnabled = options.collaborationEnabled ?? false;
    this._batchingEnabled = options.batchingEnabled ?? true;
    this._batchTimeout = options.batchTimeout ?? 50;
    this._maxRetries = options.maxRetries ?? 5;
    this._connectionTimeout = options.connectionTimeout ?? 10000;
    this._awareness = options.awareness || null;

    // Initialize Yjs data structures
    this._yjsCells = this._yjsDoc.getArray('cells');
    this._yjsMetadata = this._yjsDoc.getMap('metadata');

    // Set up event handlers
    this._setupYjsEventHandlers();

    // Initialize WebSocket provider if collaboration is enabled
    if (this._collaborationEnabled && options.websocketUrl) {
      this._initializeProvider(options.websocketUrl, options.roomName);
    }
  }

  /**
   * The underlying Yjs document instance for collaborative editing
   */
  get yjsDoc(): Y.Doc {
    return this._yjsDoc;
  }

  /**
   * WebSocket provider for real-time synchronization
   */
  get provider(): IWebSocketProvider | null {
    return this._provider;
  }

  /**
   * Array of notebook cells with collaborative synchronization
   */
  get cells(): ICellModel[] {
    const cells: ICellModel[] = [];
    this._yjsCells.forEach((cellMap, index) => {
      const cellId = cellMap.get('id') as string;
      const cell = this._cellIdMap.get(cellId);
      if (cell) {
        cells.push(cell);
      }
    });
    return cells;
  }

  /**
   * Notebook metadata with collaborative synchronization
   */
  get metadata(): Record<string, any> {
    const metadata: Record<string, any> = {};
    this._yjsMetadata.forEach((value, key) => {
      metadata[key] = value;
    });
    return metadata;
  }

  /**
   * Whether the notebook is in read-only mode
   */
  get readOnly(): boolean {
    return this._readOnly;
  }

  set readOnly(value: boolean) {
    if (this._readOnly !== value) {
      this._readOnly = value;
      this._readOnlyChangedSignal.emit(value);
    }
  }

  /**
   * Whether the notebook has unsaved changes
   */
  get dirty(): boolean {
    return this._dirty;
  }

  set dirty(value: boolean) {
    if (this._dirty !== value) {
      this._dirty = value;
      this._dirtyChangedSignal.emit(value);
    }
  }

  /**
   * Whether the model has been disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Signal emitted when Yjs document updates occur
   */
  get onYjsUpdate(): ISignal<NotebookModel, { origin: any; update: Uint8Array }> {
    return this._onYjsUpdateSignal;
  }

  /**
   * Synchronize the Yjs document with the notebook model state
   */
  async syncWithYjs(notebookData?: any): Promise<void> {
    if (this._syncInProgress) {
      return;
    }

    this._syncInProgress = true;

    try {
      // Clear existing data
      this._cellIdMap.clear();

      if (notebookData) {
        // Sync from notebook data to Yjs
        await this._syncFromNotebook(notebookData);
      } else {
        // Sync from Yjs to local state
        await this._syncFromYjs();
      }

      // Mark as clean after successful sync
      this.dirty = false;
    } catch (error) {
      console.error('Error during Yjs synchronization:', error);
      throw error;
    } finally {
      this._syncInProgress = false;
    }
  }

  /**
   * Convert notebook model to JSON format
   */
  toJSON(): any {
    const cells = this.cells.map(cell => this._cellToJSON(cell));
    const metadata = { ...this.metadata };

    return {
      cells,
      metadata,
      nbformat: 4,
      nbformat_minor: 5
    };
  }

  /**
   * Load notebook model from JSON format
   */
  fromJSON(data: any): void {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid notebook data provided to fromJSON');
    }

    // Perform synchronization with the provided data
    this.syncWithYjs(data).catch(error => {
      console.error('Error loading notebook from JSON:', error);
    });
  }

  /**
   * Dispose of the model and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;

    // Clear batch timer
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }

    // Clear reconnection timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Disconnect provider
    if (this._provider && this._provider.isConnected()) {
      this._provider.disconnect().catch(console.error);
    }

    // Dispose Yjs document
    this._yjsDoc.destroy();

    // Clear maps and sets
    this._cellIdMap.clear();
    this._pendingUpdates.clear();

    // Dispose signals
    this._onYjsUpdateSignal.emit = () => {};
    this._cellsChangedSignal.emit = () => {};
    this._metadataChangedSignal.emit = () => {};
    this._dirtyChangedSignal.emit = () => {};
    this._readOnlyChangedSignal.emit = () => {};
  }

  /**
   * Initialize WebSocket provider for collaboration
   */
  private _initializeProvider(websocketUrl: string, roomName?: string): void {
    try {
      // Create provider instance (this would typically use y-websocket)
      // For now, we'll use a mock implementation that follows the interface
      this._provider = this._createMockProvider(websocketUrl, roomName);

      // Set up provider event handlers
      this._provider.on('status', this._handleProviderStatus.bind(this));
      this._provider.on('connection-error', this._handleConnectionError.bind(this));

      // Attempt initial connection
      this._connectProvider();
    } catch (error) {
      console.error('Failed to initialize WebSocket provider:', error);
    }
  }

  /**
   * Set up event handlers for Yjs document changes
   */
  private _setupYjsEventHandlers(): void {
    // Handle document updates
    this._yjsDoc.on('update', (update: Uint8Array, origin: any) => {
      this._handleYjsUpdate(update, origin);
    });

    // Handle cells array changes
    this._yjsCells.observe((event) => {
      this._handleCellsChange(event);
    });

    // Handle metadata changes
    this._yjsMetadata.observe((event) => {
      this._handleMetadataChange(event);
    });
  }

  /**
   * Handle Yjs document updates
   */
  private _handleYjsUpdate(update: Uint8Array, origin: any): void {
    // Emit update signal
    this._onYjsUpdateSignal.emit({ origin, update });

    // Mark as dirty if the update came from local changes
    if (origin !== 'remote') {
      this.dirty = true;
    }

    // Batch updates for performance
    if (this._batchingEnabled) {
      this._batchUpdate(() => {
        this._processYjsUpdate(update, origin);
      });
    } else {
      this._processYjsUpdate(update, origin);
    }
  }

  /**
   * Process Yjs update with conflict resolution
   */
  private _processYjsUpdate(update: Uint8Array, origin: any): void {
    try {
      // Apply CRDT merge algorithms for automatic conflict resolution
      // This is handled automatically by Yjs, but we can add custom logic here

      // Update awareness information if available
      if (this._awareness && origin !== 'local') {
        this._awareness.broadcastAwareness();
      }
    } catch (error) {
      console.error('Error processing Yjs update:', error);
    }
  }

  /**
   * Handle changes to the cells array
   */
  private _handleCellsChange(event: Y.YArrayEvent<Y.Map<any>>): void {
    event.changes.forEach((change, index) => {
      if (change.action === 'add') {
        change.values.forEach((cellMap, i) => {
          const cellData = this._cellMapToData(cellMap);
          const cell = this._createCellFromData(cellData);
          this._cellIdMap.set(cellData.id, cell);

          this._cellsChangedSignal.emit({
            cellId: cellData.id,
            operation: 'add',
            index: index + i,
            cell
          });
        });
      } else if (change.action === 'delete') {
        // Handle cell deletions
        for (let i = 0; i < change.oldValues.length; i++) {
          const cellMap = change.oldValues[i];
          const cellId = cellMap.get('id') as string;
          const cell = this._cellIdMap.get(cellId);

          if (cell) {
            this._cellIdMap.delete(cellId);
            this._cellsChangedSignal.emit({
              cellId,
              operation: 'remove',
              index: index + i,
              cell
            });
          }
        }
      } else if (change.action === 'retain') {
        // Handle retained cells (moves or updates)
        change.values.forEach((cellMap, i) => {
          const cellId = cellMap.get('id') as string;
          const existingCell = this._cellIdMap.get(cellId);

          if (existingCell) {
            this._syncCellFromYjs(cellMap, existingCell);
            this._cellsChangedSignal.emit({
              cellId,
              operation: 'update',
              index: index + i,
              cell: existingCell
            });
          }
        });
      }
    });
  }

  /**
   * Handle changes to the metadata map
   */
  private _handleMetadataChange(event: Y.YMapEvent<any>): void {
    event.changes.keys.forEach((change, key) => {
      const newValue = this._yjsMetadata.get(key);

      this._metadataChangedSignal.emit({
        key,
        oldValue: change.oldValue,
        newValue
      });
    });
  }

  /**
   * Synchronize from notebook data to Yjs document
   */
  private async _syncFromNotebook(notebookData: any): Promise<void> {
    // Clear existing Yjs data
    this._yjsCells.delete(0, this._yjsCells.length);
    this._yjsMetadata.clear();

    // Sync cells
    if (notebookData.cells && Array.isArray(notebookData.cells)) {
      const cellMaps = notebookData.cells.map((cellData: any) =>
        this._createCellMapFromData(cellData)
      );
      this._yjsCells.insert(0, cellMaps);

      // Update cell ID map
      notebookData.cells.forEach((cellData: any) => {
        const cell = this._createCellFromData(cellData);
        this._cellIdMap.set(cellData.id || this._generateCellId(), cell);
      });
    }

    // Sync metadata
    if (notebookData.metadata && typeof notebookData.metadata === 'object') {
      Object.entries(notebookData.metadata).forEach(([key, value]) => {
        this._yjsMetadata.set(key, value);
      });
    }
  }

  /**
   * Synchronize from Yjs document to local state
   */
  private async _syncFromYjs(): Promise<void> {
    // Sync cells from Yjs array
    this._yjsCells.forEach((cellMap, index) => {
      const cellData = this._cellMapToData(cellMap);
      const cell = this._createCellFromData(cellData);
      this._cellIdMap.set(cellData.id, cell);
    });
  }

  /**
   * Create Yjs map from cell data
   */
  private _createCellMapFromData(cellData: any): Y.Map<any> {
    const cellMap = new Y.Map();

    // Set basic cell properties
    cellMap.set('id', cellData.id || this._generateCellId());
    cellMap.set('cell_type', cellData.cell_type || 'code');
    cellMap.set('metadata', cellData.metadata || {});

    // Handle cell source content with Y.Text for collaborative editing
    const sourceText = new Y.Text();
    if (cellData.source) {
      if (Array.isArray(cellData.source)) {
        sourceText.insert(0, cellData.source.join(''));
      } else if (typeof cellData.source === 'string') {
        sourceText.insert(0, cellData.source);
      }
    }
    cellMap.set('source', sourceText);

    // Handle outputs (stored as regular data, not collaborative)
    if (cellData.outputs) {
      cellMap.set('outputs', cellData.outputs);
    }

    // Handle execution count
    if (cellData.execution_count !== undefined) {
      cellMap.set('execution_count', cellData.execution_count);
    }

    // Handle attachments for markdown cells
    if (cellData.attachments) {
      cellMap.set('attachments', cellData.attachments);
    }

    return cellMap;
  }

  /**
   * Convert Yjs cell map to plain data
   */
  private _cellMapToData(cellMap: Y.Map<any>): any {
    const cellData: any = {
      id: cellMap.get('id'),
      cell_type: cellMap.get('cell_type'),
      metadata: cellMap.get('metadata') || {}
    };

    // Extract source from Y.Text
    const sourceText = cellMap.get('source') as Y.Text;
    if (sourceText) {
      cellData.source = sourceText.toString();
    }

    // Extract outputs
    const outputs = cellMap.get('outputs');
    if (outputs) {
      cellData.outputs = outputs;
    }

    // Extract execution count
    const executionCount = cellMap.get('execution_count');
    if (executionCount !== undefined) {
      cellData.execution_count = executionCount;
    }

    // Extract attachments
    const attachments = cellMap.get('attachments');
    if (attachments) {
      cellData.attachments = attachments;
    }

    return cellData;
  }

  /**
   * Create ICellModel from cell data
   */
  private _createCellFromData(cellData: any): ICellModel {
    // This is a mock implementation - in practice, this would create actual ICellModel instances
    // using the appropriate JupyterLab factories based on cell type
    const mockCell: ICellModel = {
      id: cellData.id,
      type: cellData.cell_type,
      source: cellData.source || '',
      metadata: cellData.metadata || {},

      // Mock implementation of required ICellModel methods
      isDisposed: false,
      dispose: () => {},
      toJSON: () => cellData,

      // Add any other required properties/methods
    } as ICellModel;

    return mockCell;
  }

  /**
   * Synchronize cell from Yjs map to ICellModel
   */
  private _syncCellFromYjs(cellMap: Y.Map<any>, cell: ICellModel): void {
    // Update cell source from Y.Text
    const sourceText = cellMap.get('source') as Y.Text;
    if (sourceText && cell.source !== sourceText.toString()) {
      // In a real implementation, this would update the cell's source
      (cell as any).source = sourceText.toString();
    }

    // Update metadata
    const metadata = cellMap.get('metadata');
    if (metadata && JSON.stringify(cell.metadata) !== JSON.stringify(metadata)) {
      (cell as any).metadata = { ...metadata };
    }
  }

  /**
   * Convert ICellModel to JSON
   */
  private _cellToJSON(cell: ICellModel): any {
    // In a real implementation, this would call cell.toJSON()
    return {
      id: cell.id,
      cell_type: cell.type,
      source: cell.source,
      metadata: cell.metadata,
      // Add outputs, execution_count, etc. based on cell type
    };
  }

  /**
   * Generate unique cell ID
   */
  private _generateCellId(): string {
    return `cell-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Batch multiple updates for performance
   */
  private _batchUpdate(updateFn: () => void): void {
    this._pendingUpdates.add(updateFn);

    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
    }

    this._batchTimer = setTimeout(() => {
      const updates = Array.from(this._pendingUpdates);
      this._pendingUpdates.clear();

      // Execute all pending updates
      updates.forEach(update => {
        try {
          update();
        } catch (error) {
          console.error('Error executing batched update:', error);
        }
      });

      this._batchTimer = null;
    }, this._batchTimeout);
  }

  /**
   * Connect to collaboration provider
   */
  private async _connectProvider(): Promise<void> {
    if (!this._provider || this._isDisposed) {
      return;
    }

    try {
      await this._provider.connect();
      this._connectionRetries = 0;
      console.log('Connected to collaboration provider');
    } catch (error) {
      console.error('Failed to connect to collaboration provider:', error);
      this._scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private _scheduleReconnect(): void {
    if (this._connectionRetries >= this._maxRetries || this._isDisposed) {
      console.error('Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._connectionRetries), 30000);
    this._connectionRetries++;

    this._reconnectTimer = setTimeout(() => {
      if (!this._isDisposed) {
        console.log(`Attempting reconnection (${this._connectionRetries}/${this._maxRetries})`);
        this._connectProvider();
      }
    }, delay);
  }

  /**
   * Handle provider status changes
   */
  private _handleProviderStatus(status: string): void {
    console.log('Provider status changed:', status);

    if (status === 'connected' && this._awareness) {
      this._awareness.broadcastAwareness();
    }
  }

  /**
   * Handle provider connection errors
   */
  private _handleConnectionError(error: Error): void {
    console.error('Provider connection error:', error);

    if (!this._isDisposed) {
      this._scheduleReconnect();
    }
  }

  /**
   * Create mock WebSocket provider for development/testing
   */
  private _createMockProvider(websocketUrl: string, roomName?: string): IWebSocketProvider {
    const eventHandlers = new Map<string, Set<Function>>();
    let connected = false;

    return {
      connect: async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        connected = true;
        const handlers = eventHandlers.get('status');
        if (handlers) {
          handlers.forEach(handler => handler('connected'));
        }
      },

      disconnect: async () => {
        connected = false;
        const handlers = eventHandlers.get('status');
        if (handlers) {
          handlers.forEach(handler => handler('disconnected'));
        }
      },

      isConnected: () => connected,

      on: (event: string, handler: Function) => {
        if (!eventHandlers.has(event)) {
          eventHandlers.set(event, new Set());
        }
        eventHandlers.get(event)!.add(handler);
      },

      off: (event: string, handler: Function) => {
        const handlers = eventHandlers.get(event);
        if (handlers) {
          handlers.delete(handler);
        }
      },

      destroy: () => {
        eventHandlers.clear();
        connected = false;
      }
    };
  }
}
