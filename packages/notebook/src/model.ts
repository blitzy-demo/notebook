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

import { INotebookModel } from '@jupyterlab/notebook';
import { ICellModel } from '@jupyterlab/cells';
import { ISignal, Signal } from '@lumino/signaling';
import { ICollaborationAwareness } from './tokens';

/**
 * Interface for map change events
 */
interface IMapChange<T> {
  type: 'add' | 'remove' | 'change';
  key: string;
  oldValue?: T;
  newValue?: T;
}

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
  private _metadataChangedSignal = new Signal<this, IMapChange<any>>(this);
  private _dirtyChangedSignal = new Signal<NotebookModel, boolean>(this);
  private _readOnlyChangedSignal = new Signal<NotebookModel, boolean>(this);
  private _contentChangedSignal = new Signal<this, void>(this);
  private _stateChangedSignal = new Signal<this, any>(this);

  // Connection management
  private _connectionRetries: number = 0;
  private _maxRetries: number;

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
   * Note: Returns cells array cast to CellList interface for compatibility
   */
  get cells(): any {
    const cells: ICellModel[] = [];
    this._yjsCells.forEach((cellMap, index) => {
      const cellId = cellMap.get('id') as string;
      const cell = this._cellIdMap.get(cellId);
      if (cell) {
        cells.push(cell);
      }
    });

    // Cast to any to maintain interface compatibility while preserving functionality
    // TODO: Implement proper CellList wrapper for full collaborative features
    return cells as any;
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
   * Notebook format major version
   */
  get nbformat(): number {
    return this._yjsMetadata.get('nbformat') || 4;
  }

  /**
   * Notebook format minor version
   */
  get nbformatMinor(): number {
    return this._yjsMetadata.get('nbformat_minor') || 5;
  }

  /**
   * Default kernel name
   */
  get defaultKernelName(): string {
    return this._yjsMetadata.get('kernelspec')?.name || '';
  }

  /**
   * Default kernel language
   */
  get defaultKernelLanguage(): string {
    return this._yjsMetadata.get('kernelspec')?.language || 'python';
  }

  /**
   * Signal emitted when metadata changes
   */
  get metadataChanged(): ISignal<this, IMapChange<any>> {
    return this._metadataChangedSignal;
  }

  /**
   * Signal emitted when cells are added
   */
  get contentChanged(): ISignal<this, void> {
    return this._contentChangedSignal;
  }

  /**
   * Signal emitted when the state changes
   */
  get stateChanged(): ISignal<this, any> {
    return this._stateChangedSignal;
  }

  /**
   * List of deleted cells (tracked for collaboration)
   */
  get deletedCells(): string[] {
    return Array.from(this._deletedCells);
  }

  // Additional private property for tracking deleted cells
  private _deletedCells: Set<string> = new Set();

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
    const cells = this.cells.map((cell: ICellModel) => this._cellToJSON(cell));
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
    try {
      // Handle Yjs array event using a simplified approach
      let currentIndex = 0;

      // Process delta changes properly
      for (const deltaItem of event.changes.delta) {
        if (deltaItem.retain) {
          currentIndex += deltaItem.retain;
        } else if (deltaItem.insert) {
          // Handle insertions
          const insertedItems = Array.isArray(deltaItem.insert) ? deltaItem.insert : [deltaItem.insert];
          insertedItems.forEach((cellMap: Y.Map<any>, i: number) => {
            const cellData = this._cellMapToData(cellMap);
            const cell = this._createCellFromData(cellData);
            this._cellIdMap.set(cellData.id, cell);

            this._cellsChangedSignal.emit({
              cellId: cellData.id,
              operation: 'add',
              index: currentIndex + i,
              cell
            });
          });
          currentIndex += insertedItems.length;
        } else if (deltaItem.delete) {
          // Handle deletions
          for (let i = 0; i < deltaItem.delete; i++) {
            const cellsArray = Array.from(this._cellIdMap.values());
            if (cellsArray[currentIndex]) {
              const cell = cellsArray[currentIndex];
              const cellId = (cell as any).id;

              if (cellId) {
                this._cellIdMap.delete(cellId);
                this._cellsChangedSignal.emit({
                  cellId,
                  operation: 'remove',
                  index: currentIndex,
                  cell
                });
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Error handling cells change:', error);
    }
  }

  /**
   * Handle changes to the metadata map
   */
  private _handleMetadataChange(event: Y.YMapEvent<any>): void {
    event.changes.keys.forEach((change, key) => {
      const newValue = this._yjsMetadata.get(key);

      this._metadataChangedSignal.emit({
        type: change.action as 'add' | 'remove' | 'change',
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
    const mockCell = {
      id: cellData.id,
      type: cellData.cell_type,
      source: cellData.source || '',
      metadata: cellData.metadata || {},

      // Mock implementation of required ICellModel methods
      isDisposed: false,
      dispose: () => {},
      toJSON: () => cellData,

      // Add any other required properties/methods as needed
    } as unknown as ICellModel;

    return mockCell;
  }



  /**
   * Convert ICellModel to JSON
   */
  private _cellToJSON(cell: ICellModel): any {
    // In a real implementation, this would call cell.toJSON()
    return {
      id: cell.id,
      cell_type: cell.type,
      source: (cell as any).source,
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

  // Required methods for INotebookModel interface

  /**
   * Shared model for collaborative editing
   */
  get sharedModel(): any {
    return this._yjsDoc;
  }

  /**
   * Delete a metadata key
   */
  deleteMetadata(key: string): void {
    if (this._yjsMetadata.has(key)) {
      const oldValue = this._yjsMetadata.get(key);
      this._yjsMetadata.delete(key);
      this._metadataChangedSignal.emit({
        type: 'remove',
        key: key,
        oldValue: oldValue,
        newValue: undefined
      });
      this.dirty = true;
    }
  }

  /**
   * Get a metadata value
   */
  getMetadata(key: string): any {
    return this._yjsMetadata.get(key);
  }

  /**
   * Set a metadata value
   */
  setMetadata(key: string, value: any): void {
    const oldValue = this._yjsMetadata.get(key);
    this._yjsMetadata.set(key, value);
    this._metadataChangedSignal.emit({
      type: oldValue === undefined ? 'add' : 'change',
      key: key,
      oldValue: oldValue,
      newValue: value
    });
    this.dirty = true;
  }

  /**
   * Initialize notebook from string data
   */
  fromString(value: string): void {
    try {
      const data = JSON.parse(value);

      // Set metadata
      if (data.metadata) {
        this._yjsMetadata.clear();
        Object.entries(data.metadata).forEach(([key, val]) => {
          this._yjsMetadata.set(key, val);
        });
      }

      // Set cells
      if (data.cells && Array.isArray(data.cells)) {
        this._yjsCells.delete(0, this._yjsCells.length);
        data.cells.forEach((cellData: any) => {
          const cellMap = new Y.Map();
          Object.entries(cellData).forEach(([key, val]) => {
            cellMap.set(key, val);
          });
          this._yjsCells.push([cellMap]);
        });
      }

      this.dirty = false;
      this._contentChangedSignal.emit();
    } catch (error) {
      console.error('Error parsing notebook data:', error);
      throw new Error('Invalid notebook format');
    }
  }

  /**
   * Convert notebook to string
   */
  toString(): string {
    const data = {
      metadata: this.metadata,
      nbformat: this.nbformat,
      nbformat_minor: this.nbformatMinor,
      cells: []
    } as any;

    // Convert cells to plain objects
    this._yjsCells.forEach((cellMap) => {
      const cellData: any = {};
      cellMap.forEach((value, key) => {
        cellData[key] = value;
      });
      data.cells.push(cellData);
    });

    return JSON.stringify(data, null, 2);
  }

  /**
   * Initialize notebook model
   */
  initialize(): void {
    // Set default metadata if not present
    if (!this._yjsMetadata.has('nbformat')) {
      this._yjsMetadata.set('nbformat', 4);
    }
    if (!this._yjsMetadata.has('nbformat_minor')) {
      this._yjsMetadata.set('nbformat_minor', 5);
    }
  }

  /**
   * Clear all content
   */
  clear(wait?: boolean): void {
    this._yjsCells.delete(0, this._yjsCells.length);
    this._yjsMetadata.clear();
    this._cellIdMap.clear();
    this._deletedCells.clear();
    this.dirty = false;
    this._contentChangedSignal.emit();
  }

}
