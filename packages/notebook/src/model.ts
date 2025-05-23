// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Notebook data model with Yjs CRDT integration for real-time collaborative editing.
 * 
 * This module provides the core notebook model that represents notebook structure and content,
 * enhanced with Yjs CRDT integration for real-time collaborative editing. It serves as the
 * foundation for conflict-free document synchronization, binding to shared documents, and
 * managing the notebook's cell collection with collaborative state.
 */

import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID, JSONObject, JSONValue } from '@lumino/coreutils';
import { IObservableList, ObservableList } from '@jupyterlab/observables';
import { IObservableJSON, ObservableJSON } from '@jupyterlab/observables';
import { IModelDB } from '@jupyterlab/observables';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { Cell, ICellModel } from '@jupyterlab/cells';

// Yjs imports
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

// Import from collab modules
import { IYjsAwareness, YjsAwareness } from './collab/awareness';
import { ILockManager, LockManager } from './collab/locks';
import { IHistoryManager, HistoryManager } from './collab/history';

/**
 * The default implementation of the notebook model.
 */
export interface INotebookModel extends DocumentRegistry.IModel {
  /**
   * The list of cells in the notebook.
   */
  readonly cells: IObservableList<ICellModel>;

  /**
   * The metadata associated with the notebook.
   */
  readonly metadata: IObservableJSON;

  /**
   * The Yjs document provider for collaborative editing.
   */
  readonly yjsProvider: IYjsNotebookProvider | null;

  /**
   * The awareness manager for user presence and cursor tracking.
   */
  readonly awareness: IYjsAwareness | null;

  /**
   * The lock manager for cell-level locking.
   */
  readonly lockManager: ILockManager | null;

  /**
   * The history manager for version tracking and restoration.
   */
  readonly historyManager: IHistoryManager | null;

  /**
   * A signal emitted when the notebook has been synchronized with remote changes.
   */
  readonly synchronized: ISignal<INotebookModel, void>;

  /**
   * A signal emitted when a collaborative session is established.
   */
  readonly collaborationEnabled: ISignal<INotebookModel, void>;

  /**
   * A signal emitted when a collaborative session is disconnected.
   */
  readonly collaborationDisabled: ISignal<INotebookModel, void>;

  /**
   * Whether the notebook is currently in a collaborative session.
   */
  readonly isCollaborative: boolean;

  /**
   * Enable collaborative editing for this notebook.
   * 
   * @param options - The options for enabling collaboration.
   * @returns A promise that resolves when collaboration is enabled.
   */
  enableCollaboration(options: ICollaborationOptions): Promise<void>;

  /**
   * Disable collaborative editing for this notebook.
   * 
   * @returns A promise that resolves when collaboration is disabled.
   */
  disableCollaboration(): Promise<void>;

  /**
   * Get the current collaborative state of the notebook.
   * 
   * @returns The collaborative state.
   */
  getCollaborativeState(): ICollaborativeState;

  /**
   * Update the metadata associated with the notebook.
   * 
   * @param metadata - The metadata to update.
   */
  updateMetadata(metadata: JSONObject): void;
}

/**
 * Options for enabling collaboration on a notebook.
 */
export interface ICollaborationOptions {
  /**
   * The URL of the WebSocket server for collaboration.
   */
  websocketUrl: string;

  /**
   * The room/document ID for collaboration.
   */
  roomId: string;

  /**
   * The current user's ID.
   */
  userId: string;

  /**
   * The current user's display name.
   */
  userName: string;

  /**
   * Optional user avatar URL.
   */
  userAvatar?: string;

  /**
   * Whether the current user has admin permissions.
   */
  isAdmin?: boolean;

  /**
   * Whether to enable offline persistence.
   */
  enablePersistence?: boolean;

  /**
   * Whether to enable automatic history tracking.
   */
  enableHistory?: boolean;

  /**
   * Whether to enable cell-level locking.
   */
  enableLocking?: boolean;

  /**
   * Authentication token for the WebSocket connection.
   */
  token?: string;
}

/**
 * The collaborative state of a notebook.
 */
export interface ICollaborativeState {
  /**
   * Whether collaboration is enabled.
   */
  isEnabled: boolean;

  /**
   * The connection status.
   */
  connectionStatus: 'connected' | 'connecting' | 'disconnected';

  /**
   * The room/document ID.
   */
  roomId: string;

  /**
   * The number of connected users.
   */
  connectedUsers: number;

  /**
   * The list of active users.
   */
  activeUsers: Array<{
    id: string;
    name: string;
    avatar?: string;
    color?: string;
  }>;

  /**
   * Whether offline persistence is enabled.
   */
  persistenceEnabled: boolean;

  /**
   * Whether history tracking is enabled.
   */
  historyEnabled: boolean;

  /**
   * Whether cell-level locking is enabled.
   */
  lockingEnabled: boolean;
}

/**
 * Interface for the Yjs notebook provider.
 */
export interface IYjsNotebookProvider extends IDisposable {
  /**
   * The Yjs document.
   */
  readonly ydoc: Y.Doc;

  /**
   * The WebSocket provider for real-time synchronization.
   */
  readonly websocketProvider: WebsocketProvider | null;

  /**
   * The IndexedDB provider for offline persistence.
   */
  readonly indexeddbProvider: IndexeddbPersistence | null;

  /**
   * The awareness instance for user presence.
   */
  readonly awareness: IYjsAwareness;

  /**
   * A signal emitted when the document has been synchronized.
   */
  readonly synchronized: ISignal<IYjsNotebookProvider, void>;

  /**
   * A signal emitted when the connection status changes.
   */
  readonly connectionStatusChanged: ISignal<
    IYjsNotebookProvider,
    'connected' | 'connecting' | 'disconnected'
  >;

  /**
   * The current connection status.
   */
  readonly connectionStatus: 'connected' | 'connecting' | 'disconnected';

  /**
   * Connect to the collaboration server.
   * 
   * @param options - The connection options.
   * @returns A promise that resolves when connected.
   */
  connect(options: ICollaborationOptions): Promise<void>;

  /**
   * Disconnect from the collaboration server.
   * 
   * @returns A promise that resolves when disconnected.
   */
  disconnect(): Promise<void>;

  /**
   * Get the shared cells array from the Yjs document.
   * 
   * @returns The shared cells array.
   */
  getSharedCells(): Y.Array<any>;

  /**
   * Get the shared metadata map from the Yjs document.
   * 
   * @returns The shared metadata map.
   */
  getSharedMetadata(): Y.Map<any>;

  /**
   * Bind a cell model to a shared cell.
   * 
   * @param cellModel - The cell model to bind.
   * @param sharedCell - The shared cell to bind to.
   */
  bindCell(cellModel: ICellModel, sharedCell: Y.Map<any>): void;

  /**
   * Unbind a cell model from its shared cell.
   * 
   * @param cellModel - The cell model to unbind.
   */
  unbindCell(cellModel: ICellModel): void;

  /**
   * Create a snapshot of the current document state.
   * 
   * @param description - Optional description for the snapshot.
   * @returns A promise that resolves to the snapshot ID.
   */
  createSnapshot(description?: string): Promise<string>;
}

/**
 * Implementation of the Yjs notebook provider.
 */
export class YjsNotebookProvider implements IYjsNotebookProvider {
  /**
   * Constructor
   */
  constructor() {
    this._ydoc = new Y.Doc();
    this._awareness = new YjsAwareness(this._ydoc);
    this._connectionStatus = 'disconnected';
    this._cellBindings = new Map<ICellModel, { dispose: () => void }>();
  }

  /**
   * The Yjs document.
   */
  get ydoc(): Y.Doc {
    return this._ydoc;
  }

  /**
   * The WebSocket provider for real-time synchronization.
   */
  get websocketProvider(): WebsocketProvider | null {
    return this._websocketProvider;
  }

  /**
   * The IndexedDB provider for offline persistence.
   */
  get indexeddbProvider(): IndexeddbPersistence | null {
    return this._indexeddbProvider;
  }

  /**
   * The awareness instance for user presence.
   */
  get awareness(): IYjsAwareness {
    return this._awareness;
  }

  /**
   * A signal emitted when the document has been synchronized.
   */
  get synchronized(): ISignal<IYjsNotebookProvider, void> {
    return this._synchronized;
  }

  /**
   * A signal emitted when the connection status changes.
   */
  get connectionStatusChanged(): ISignal<
    IYjsNotebookProvider,
    'connected' | 'connecting' | 'disconnected'
  > {
    return this._connectionStatusChanged;
  }

  /**
   * The current connection status.
   */
  get connectionStatus(): 'connected' | 'connecting' | 'disconnected' {
    return this._connectionStatus;
  }

  /**
   * Connect to the collaboration server.
   * 
   * @param options - The connection options.
   * @returns A promise that resolves when connected.
   */
  async connect(options: ICollaborationOptions): Promise<void> {
    if (this._connectionStatus === 'connected') {
      return;
    }

    this._setConnectionStatus('connecting');

    try {
      // Set up WebSocket provider
      const websocketOpts: any = {};
      if (options.token) {
        websocketOpts.params = { token: options.token };
      }

      this._websocketProvider = new WebsocketProvider(
        options.websocketUrl,
        options.roomId,
        this._ydoc,
        websocketOpts
      );

      // Set up offline persistence if enabled
      if (options.enablePersistence) {
        this._indexeddbProvider = new IndexeddbPersistence(
          options.roomId,
          this._ydoc
        );

        // Wait for IndexedDB to load
        await new Promise<void>((resolve) => {
          this._indexeddbProvider!.on('synced', () => {
            resolve();
          });
        });
      }

      // Set up user awareness state
      this._awareness.setLocalState({
        user: {
          id: options.userId,
          name: options.userName,
          avatar: options.userAvatar,
          color: this._getRandomColor()
        },
        cursor: null,
        activity: {
          type: 'viewing',
          timestamp: Date.now()
        }
      });

      // Wait for WebSocket connection
      await new Promise<void>((resolve) => {
        const onStatusChange = ({ status }: { status: string }) => {
          if (status === 'connected') {
            this._websocketProvider!.off('status', onStatusChange);
            resolve();
          }
        };
        this._websocketProvider!.on('status', onStatusChange);

        // If already connected, resolve immediately
        if (this._websocketProvider!.wsconnected) {
          resolve();
        }
      });

      this._setConnectionStatus('connected');
      this._synchronized.emit(void 0);
    } catch (error) {
      this._setConnectionStatus('disconnected');
      throw error;
    }
  }

  /**
   * Disconnect from the collaboration server.
   * 
   * @returns A promise that resolves when disconnected.
   */
  async disconnect(): Promise<void> {
    if (this._connectionStatus === 'disconnected') {
      return;
    }

    // Clean up WebSocket provider
    if (this._websocketProvider) {
      this._websocketProvider.disconnect();
      this._websocketProvider = null;
    }

    // Clean up IndexedDB provider
    if (this._indexeddbProvider) {
      this._indexeddbProvider.destroy();
      this._indexeddbProvider = null;
    }

    // Clear awareness state
    this._awareness.setLocalState(null);

    this._setConnectionStatus('disconnected');
    return Promise.resolve();
  }

  /**
   * Get the shared cells array from the Yjs document.
   * 
   * @returns The shared cells array.
   */
  getSharedCells(): Y.Array<any> {
    return this._ydoc.getArray('cells');
  }

  /**
   * Get the shared metadata map from the Yjs document.
   * 
   * @returns The shared metadata map.
   */
  getSharedMetadata(): Y.Map<any> {
    return this._ydoc.getMap('metadata');
  }

  /**
   * Bind a cell model to a shared cell.
   * 
   * @param cellModel - The cell model to bind.
   * @param sharedCell - The shared cell to bind to.
   */
  bindCell(cellModel: ICellModel, sharedCell: Y.Map<any>): void {
    // If already bound, unbind first
    if (this._cellBindings.has(cellModel)) {
      this.unbindCell(cellModel);
    }

    // Create a binding between the cell model and the shared cell
    const binding = this._createCellBinding(cellModel, sharedCell);
    this._cellBindings.set(cellModel, binding);
  }

  /**
   * Unbind a cell model from its shared cell.
   * 
   * @param cellModel - The cell model to unbind.
   */
  unbindCell(cellModel: ICellModel): void {
    const binding = this._cellBindings.get(cellModel);
    if (binding) {
      binding.dispose();
      this._cellBindings.delete(cellModel);
    }
  }

  /**
   * Create a snapshot of the current document state.
   * 
   * @param description - Optional description for the snapshot.
   * @returns A promise that resolves to the snapshot ID.
   */
  async createSnapshot(description?: string): Promise<string> {
    // This would typically be handled by the history manager
    // For now, we'll just return a placeholder ID
    return Promise.resolve(UUID.uuid4());
  }

  /**
   * Test whether the provider has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources held by the provider.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;

    // Disconnect from collaboration server
    if (this._websocketProvider) {
      this._websocketProvider.disconnect();
      this._websocketProvider = null;
    }

    // Clean up IndexedDB provider
    if (this._indexeddbProvider) {
      this._indexeddbProvider.destroy();
      this._indexeddbProvider = null;
    }

    // Clean up cell bindings
    for (const binding of this._cellBindings.values()) {
      binding.dispose();
    }
    this._cellBindings.clear();

    // Clean up awareness
    this._awareness.destroy();

    // Destroy Yjs document
    this._ydoc.destroy();

    Signal.clearData(this);
  }

  /**
   * Set the connection status and emit a signal.
   * 
   * @param status - The new connection status.
   */
  private _setConnectionStatus(
    status: 'connected' | 'connecting' | 'disconnected'
  ): void {
    if (this._connectionStatus !== status) {
      this._connectionStatus = status;
      this._connectionStatusChanged.emit(status);
    }
  }

  /**
   * Create a binding between a cell model and a shared cell.
   * 
   * @param cellModel - The cell model to bind.
   * @param sharedCell - The shared cell to bind to.
   * @returns An object with a dispose method.
   */
  private _createCellBinding(cellModel: ICellModel, sharedCell: Y.Map<any>): { dispose: () => void } {
    // Set up two-way binding for cell source
    const ytext = sharedCell.get('source') as Y.Text;
    if (!ytext) {
      // Create a new Y.Text for the cell source if it doesn't exist
      const newYText = new Y.Text(cellModel.value.text);
      sharedCell.set('source', newYText);
    } else if (ytext.toString() !== cellModel.value.text) {
      // Initialize cell model with the shared text if they differ
      cellModel.value.text = ytext.toString();
    }

    // Set up metadata binding
    const ymetadata = sharedCell.get('metadata') as Y.Map<any>;
    if (!ymetadata) {
      // Create a new Y.Map for the cell metadata if it doesn't exist
      const newYMetadata = new Y.Map();
      const metadata = cellModel.metadata.toJSON();
      for (const key in metadata) {
        newYMetadata.set(key, metadata[key]);
      }
      sharedCell.set('metadata', newYMetadata);
    } else {
      // Initialize cell metadata with the shared metadata
      const metadata: JSONObject = {};
      ymetadata.forEach((value, key) => {
        metadata[key] = value as JSONValue;
      });
      cellModel.metadata.clear();
      for (const key in metadata) {
        cellModel.metadata.set(key, metadata[key]);
      }
    }

    // Set up cell model change handlers
    const onCellSourceChange = (value: string) => {
      const ytext = sharedCell.get('source') as Y.Text;
      if (ytext && ytext.toString() !== value) {
        this._ydoc.transact(() => {
          ytext.delete(0, ytext.length);
          ytext.insert(0, value);
        }, 'cell-source-update');
      }
    };

    const onCellMetadataChange = (metadata: IObservableJSON) => {
      const ymetadata = sharedCell.get('metadata') as Y.Map<any>;
      if (ymetadata) {
        this._ydoc.transact(() => {
          // Update shared metadata with cell metadata changes
          const metadataJSON = metadata.toJSON();
          const keys = new Set([...ymetadata.keys(), ...Object.keys(metadataJSON)]);
          
          for (const key of keys) {
            if (key in metadataJSON) {
              if (ymetadata.get(key) !== metadataJSON[key]) {
                ymetadata.set(key, metadataJSON[key]);
              }
            } else {
              ymetadata.delete(key);
            }
          }
        }, 'cell-metadata-update');
      }
    };

    // Set up shared cell change handlers
    const onSharedSourceChange = (event: Y.YTextEvent) => {
      if (event.transaction.origin !== 'cell-source-update') {
        const ytext = sharedCell.get('source') as Y.Text;
        if (ytext && ytext.toString() !== cellModel.value.text) {
          cellModel.value.text = ytext.toString();
        }
      }
    };

    const onSharedMetadataChange = (event: Y.YMapEvent<any>) => {
      if (event.transaction.origin !== 'cell-metadata-update') {
        const ymetadata = sharedCell.get('metadata') as Y.Map<any>;
        if (ymetadata) {
          // Update cell metadata with shared metadata changes
          const metadata: JSONObject = {};
          ymetadata.forEach((value, key) => {
            metadata[key] = value as JSONValue;
          });
          
          // Only update if there are actual changes
          const currentMetadata = cellModel.metadata.toJSON();
          if (JSON.stringify(metadata) !== JSON.stringify(currentMetadata)) {
            cellModel.metadata.clear();
            for (const key in metadata) {
              cellModel.metadata.set(key, metadata[key]);
            }
          }
        }
      }
    };

    // Connect change handlers
    cellModel.value.changed.connect(onCellSourceChange);
    cellModel.metadata.changed.connect(onCellMetadataChange);
    
    const ytext = sharedCell.get('source') as Y.Text;
    const ymetadata = sharedCell.get('metadata') as Y.Map<any>;
    
    ytext.observe(onSharedSourceChange);
    ymetadata.observe(onSharedMetadataChange);

    // Return an object with a dispose method to clean up the binding
    return {
      dispose: () => {
        // Disconnect change handlers
        cellModel.value.changed.disconnect(onCellSourceChange);
        cellModel.metadata.changed.disconnect(onCellMetadataChange);
        
        ytext.unobserve(onSharedSourceChange);
        ymetadata.unobserve(onSharedMetadataChange);
      }
    };
  }

  /**
   * Generate a random color for user identification.
   * 
   * @returns A random color in hex format.
   */
  private _getRandomColor(): string {
    const colors = [
      '#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5',
      '#2196F3', '#03A9F4', '#00BCD4', '#009688', '#4CAF50',
      '#8BC34A', '#CDDC39', '#FFEB3B', '#FFC107', '#FF9800',
      '#FF5722', '#795548', '#607D8B'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  private _ydoc: Y.Doc;
  private _awareness: IYjsAwareness;
  private _websocketProvider: WebsocketProvider | null = null;
  private _indexeddbProvider: IndexeddbPersistence | null = null;
  private _connectionStatus: 'connected' | 'connecting' | 'disconnected';
  private _cellBindings: Map<ICellModel, { dispose: () => void }>;
  private _isDisposed = false;

  private _synchronized = new Signal<IYjsNotebookProvider, void>(this);
  private _connectionStatusChanged = new Signal<
    IYjsNotebookProvider,
    'connected' | 'connecting' | 'disconnected'
  >(this);
}

/**
 * The default implementation of a notebook model.
 */
export class NotebookModel implements INotebookModel {
  /**
   * Construct a new notebook model.
   */
  constructor(options: NotebookModel.IOptions = {}) {
    this.cells = new ObservableList<ICellModel>();
    this.metadata = new ObservableJSON({ values: options.metadata });
    this._dirty = false;
    this._readOnly = false;
    this._defaultLang = options.defaultLang || '';
    this._isCollaborative = false;
    this._collaborativeState = {
      isEnabled: false,
      connectionStatus: 'disconnected',
      roomId: '',
      connectedUsers: 0,
      activeUsers: [],
      persistenceEnabled: false,
      historyEnabled: false,
      lockingEnabled: false
    };

    // Set up change handlers
    this.cells.changed.connect(this._onCellsChanged, this);
    this.metadata.changed.connect(this._onMetadataChanged, this);
  }

  /**
   * A signal emitted when the notebook has been synchronized with remote changes.
   */
  get synchronized(): ISignal<INotebookModel, void> {
    return this._synchronized;
  }

  /**
   * A signal emitted when a collaborative session is established.
   */
  get collaborationEnabled(): ISignal<INotebookModel, void> {
    return this._collaborationEnabled;
  }

  /**
   * A signal emitted when a collaborative session is disconnected.
   */
  get collaborationDisabled(): ISignal<INotebookModel, void> {
    return this._collaborationDisabled;
  }

  /**
   * Whether the notebook is currently in a collaborative session.
   */
  get isCollaborative(): boolean {
    return this._isCollaborative;
  }

  /**
   * The Yjs document provider for collaborative editing.
   */
  get yjsProvider(): IYjsNotebookProvider | null {
    return this._yjsProvider;
  }

  /**
   * The awareness manager for user presence and cursor tracking.
   */
  get awareness(): IYjsAwareness | null {
    return this._yjsProvider?.awareness || null;
  }

  /**
   * The lock manager for cell-level locking.
   */
  get lockManager(): ILockManager | null {
    return this._lockManager;
  }

  /**
   * The history manager for version tracking and restoration.
   */
  get historyManager(): IHistoryManager | null {
    return this._historyManager;
  }

  /**
   * The dirty state of the model.
   */
  get dirty(): boolean {
    return this._dirty;
  }
  set dirty(value: boolean) {
    if (value === this._dirty) {
      return;
    }
    this._dirty = value;
    this.stateChanged.emit({ name: 'dirty', oldValue: !value, newValue: value });
  }

  /**
   * The read only state of the model.
   */
  get readOnly(): boolean {
    return this._readOnly;
  }
  set readOnly(value: boolean) {
    if (value === this._readOnly) {
      return;
    }
    this._readOnly = value;
    this.stateChanged.emit({ name: 'readOnly', oldValue: !value, newValue: value });
  }

  /**
   * The default language of the model.
   */
  get defaultLang(): string {
    return this._defaultLang;
  }
  set defaultLang(value: string) {
    if (value === this._defaultLang) {
      return;
    }
    const oldValue = this._defaultLang;
    this._defaultLang = value;
    this.stateChanged.emit({ name: 'defaultLang', oldValue, newValue: value });
  }

  /**
   * The default mime type of the model.
   */
  get defaultMimetype(): string {
    return 'text/plain';
  }

  /**
   * A signal emitted when the state of the model changes.
   */
  readonly stateChanged = new Signal<this, IChangedArgs<any>>(this);

  /**
   * A signal emitted when the model is disposed.
   */
  readonly disposed = new Signal<this, void>(this);

  /**
   * Enable collaborative editing for this notebook.
   * 
   * @param options - The options for enabling collaboration.
   * @returns A promise that resolves when collaboration is enabled.
   */
  async enableCollaboration(options: ICollaborationOptions): Promise<void> {
    if (this._isCollaborative) {
      return;
    }

    // Create Yjs provider if it doesn't exist
    if (!this._yjsProvider) {
      this._yjsProvider = new YjsNotebookProvider();
    }

    // Connect to the collaboration server
    await this._yjsProvider.connect(options);

    // Set up lock manager if enabled
    if (options.enableLocking) {
      this._lockManager = new LockManager({
        ydoc: this._yjsProvider.ydoc,
        awareness: this._yjsProvider.awareness.awareness,
        userId: options.userId,
        userName: options.userName,
        isAdmin: options.isAdmin || false
      });
    }

    // Set up history manager if enabled
    if (options.enableHistory) {
      this._historyManager = new HistoryManager(this._yjsProvider.ydoc);
    }

    // Bind notebook to Yjs document
    await this._bindToYjsDocument();

    // Update collaborative state
    this._isCollaborative = true;
    this._collaborativeState = {
      isEnabled: true,
      connectionStatus: this._yjsProvider.connectionStatus,
      roomId: options.roomId,
      connectedUsers: 0, // Will be updated by awareness changes
      activeUsers: [], // Will be updated by awareness changes
      persistenceEnabled: options.enablePersistence || false,
      historyEnabled: options.enableHistory || false,
      lockingEnabled: options.enableLocking || false
    };

    // Set up connection status change handler
    this._yjsProvider.connectionStatusChanged.connect(
      this._onConnectionStatusChanged,
      this
    );

    // Set up awareness change handler
    this._yjsProvider.awareness.stateChanged.connect(
      this._onAwarenessChanged,
      this
    );

    // Emit collaboration enabled signal
    this._collaborationEnabled.emit(void 0);
  }

  /**
   * Disable collaborative editing for this notebook.
   * 
   * @returns A promise that resolves when collaboration is disabled.
   */
  async disableCollaboration(): Promise<void> {
    if (!this._isCollaborative || !this._yjsProvider) {
      return;
    }

    // Unbind notebook from Yjs document
    this._unbindFromYjsDocument();

    // Disconnect from collaboration server
    await this._yjsProvider.disconnect();

    // Clean up lock manager
    if (this._lockManager) {
      this._lockManager.dispose();
      this._lockManager = null;
    }

    // Clean up history manager
    if (this._historyManager) {
      this._historyManager.dispose();
      this._historyManager = null;
    }

    // Update collaborative state
    this._isCollaborative = false;
    this._collaborativeState = {
      isEnabled: false,
      connectionStatus: 'disconnected',
      roomId: '',
      connectedUsers: 0,
      activeUsers: [],
      persistenceEnabled: false,
      historyEnabled: false,
      lockingEnabled: false
    };

    // Emit collaboration disabled signal
    this._collaborationDisabled.emit(void 0);
  }

  /**
   * Get the current collaborative state of the notebook.
   * 
   * @returns The collaborative state.
   */
  getCollaborativeState(): ICollaborativeState {
    return { ...this._collaborativeState };
  }

  /**
   * Update the metadata associated with the notebook.
   * 
   * @param metadata - The metadata to update.
   */
  updateMetadata(metadata: JSONObject): void {
    for (const key in metadata) {
      this.metadata.set(key, metadata[key]);
    }
  }

  /**
   * Serialize the model to JSON.
   * 
   * @returns The serialized model as a JSON object.
   */
  toJSON(): any {
    const cells: any[] = [];
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells.get(i);
      cells.push(cell.toJSON());
    }
    return {
      cells,
      metadata: this.metadata.toJSON(),
      nbformat: 4,
      nbformat_minor: 5
    };
  }

  /**
   * Serialize the model to a string.
   * 
   * @returns The serialized model as a string.
   */
  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  /**
   * Deserialize the model from JSON.
   * 
   * @param data - The serialized model.
   */
  fromJSON(data: any): void {
    if (data.cells) {
      this.cells.clear();
      const cells = data.cells as any[];
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const cellModel = this._createCellModel(cell);
        this.cells.push(cellModel);
      }
    }

    if (data.metadata) {
      this.metadata.clear();
      const metadata = data.metadata as JSONObject;
      for (const key in metadata) {
        this.metadata.set(key, metadata[key]);
      }
    }
  }

  /**
   * Deserialize the model from a string.
   * 
   * @param text - The serialized model as a string.
   */
  fromString(text: string): void {
    this.fromJSON(JSON.parse(text));
  }

  /**
   * Initialize the model with default values.
   */
  initialize(): void {
    // No-op for now
  }

  /**
   * Test whether the model is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources held by the model.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;
    this.disposed.emit(void 0);
    Signal.clearData(this);

    // Clean up cells
    this.cells.clear();

    // Disable collaboration if enabled
    if (this._isCollaborative) {
      this.disableCollaboration().catch(error => {
        console.error('Error disabling collaboration:', error);
      });
    }

    // Clean up Yjs provider
    if (this._yjsProvider) {
      this._yjsProvider.dispose();
      this._yjsProvider = null;
    }
  }

  /**
   * Handle a change to the cells list.
   */
  private _onCellsChanged(list: IObservableList<ICellModel>, change: IObservableList.IChangedArgs<ICellModel>): void {
    // Mark the model as dirty
    this.dirty = true;

    // If collaborative editing is enabled, sync changes to the Yjs document
    if (this._isCollaborative && this._yjsProvider) {
      this._syncCellsToYjs(change);
    }
  }

  /**
   * Handle a change to the notebook metadata.
   */
  private _onMetadataChanged(): void {
    // Mark the model as dirty
    this.dirty = true;

    // If collaborative editing is enabled, sync changes to the Yjs document
    if (this._isCollaborative && this._yjsProvider) {
      this._syncMetadataToYjs();
    }
  }

  /**
   * Handle a change to the connection status.
   */
  private _onConnectionStatusChanged(sender: IYjsNotebookProvider, status: 'connected' | 'connecting' | 'disconnected'): void {
    this._collaborativeState.connectionStatus = status;
  }

  /**
   * Handle a change to the awareness state.
   */
  private _onAwarenessChanged(): void {
    if (!this._yjsProvider) {
      return;
    }

    // Update active users list
    const states = this._yjsProvider.awareness.getStates();
    const activeUsers: Array<{
      id: string;
      name: string;
      avatar?: string;
      color?: string;
    }> = [];

    states.forEach((state) => {
      if (state.user) {
        activeUsers.push({
          id: state.user.id,
          name: state.user.name,
          avatar: state.user.avatar,
          color: state.user.color
        });
      }
    });

    this._collaborativeState.activeUsers = activeUsers;
    this._collaborativeState.connectedUsers = activeUsers.length;
  }

  /**
   * Bind the notebook model to the Yjs document.
   */
  private async _bindToYjsDocument(): Promise<void> {
    if (!this._yjsProvider) {
      return;
    }

    // Get shared cells array and metadata map
    const yCells = this._yjsProvider.getSharedCells();
    const yMetadata = this._yjsProvider.getSharedMetadata();

    // If the Yjs document is empty, initialize it with the current notebook state
    if (yCells.length === 0 && yMetadata.size === 0) {
      this._yjsProvider.ydoc.transact(() => {
        // Initialize cells
        for (let i = 0; i < this.cells.length; i++) {
          const cellModel = this.cells.get(i);
          const sharedCell = this._createSharedCell(cellModel);
          yCells.push([sharedCell]);
        }

        // Initialize metadata
        const metadata = this.metadata.toJSON();
        for (const key in metadata) {
          yMetadata.set(key, metadata[key]);
        }
      }, 'init');
    } else {
      // Otherwise, update the notebook model with the Yjs document state
      this._updateFromYjsDocument();
    }

    // Set up Yjs document change handlers
    yCells.observe(this._onSharedCellsChanged.bind(this));
    yMetadata.observe(this._onSharedMetadataChanged.bind(this));

    // Bind each cell to its shared cell
    for (let i = 0; i < this.cells.length; i++) {
      const cellModel = this.cells.get(i);
      const sharedCell = yCells.get(i);
      this._yjsProvider.bindCell(cellModel, sharedCell);
    }

    // Emit synchronized signal
    this._synchronized.emit(void 0);
  }

  /**
   * Unbind the notebook model from the Yjs document.
   */
  private _unbindFromYjsDocument(): void {
    if (!this._yjsProvider) {
      return;
    }

    // Get shared cells array and metadata map
    const yCells = this._yjsProvider.getSharedCells();
    const yMetadata = this._yjsProvider.getSharedMetadata();

    // Remove Yjs document change handlers
    yCells.unobserve(this._onSharedCellsChanged.bind(this));
    yMetadata.unobserve(this._onSharedMetadataChanged.bind(this));

    // Unbind each cell from its shared cell
    for (let i = 0; i < this.cells.length; i++) {
      const cellModel = this.cells.get(i);
      this._yjsProvider.unbindCell(cellModel);
    }
  }

  /**
   * Update the notebook model from the Yjs document.
   */
  private _updateFromYjsDocument(): void {
    if (!this._yjsProvider) {
      return;
    }

    // Get shared cells array and metadata map
    const yCells = this._yjsProvider.getSharedCells();
    const yMetadata = this._yjsProvider.getSharedMetadata();

    // Update cells
    this.cells.clear();
    for (let i = 0; i < yCells.length; i++) {
      const sharedCell = yCells.get(i);
      const cellModel = this._createCellModelFromSharedCell(sharedCell);
      this.cells.push(cellModel);
    }

    // Update metadata
    this.metadata.clear();
    yMetadata.forEach((value, key) => {
      this.metadata.set(key, value as JSONValue);
    });
  }

  /**
   * Sync changes to the cells list to the Yjs document.
   * 
   * @param change - The change to the cells list.
   */
  private _syncCellsToYjs(change: IObservableList.IChangedArgs<ICellModel>): void {
    if (!this._yjsProvider) {
      return;
    }

    const yCells = this._yjsProvider.getSharedCells();

    this._yjsProvider.ydoc.transact(() => {
      if (change.type === 'add') {
        // Handle cell addition
        for (let i = 0; i < change.newValues.length; i++) {
          const cellModel = change.newValues[i];
          const sharedCell = this._createSharedCell(cellModel);
          yCells.insert(change.newIndex + i, [sharedCell]);
          this._yjsProvider!.bindCell(cellModel, sharedCell);
        }
      } else if (change.type === 'remove') {
        // Handle cell removal
        for (let i = 0; i < change.oldValues.length; i++) {
          const cellModel = change.oldValues[i];
          this._yjsProvider!.unbindCell(cellModel);
        }
        yCells.delete(change.oldIndex, change.oldValues.length);
      } else if (change.type === 'move') {
        // Handle cell movement
        const cells = yCells.toArray().slice(change.oldIndex, change.oldIndex + 1);
        yCells.delete(change.oldIndex, 1);
        yCells.insert(change.newIndex, cells);
      } else if (change.type === 'set') {
        // Handle cell replacement
        for (let i = 0; i < change.oldValues.length; i++) {
          const oldCellModel = change.oldValues[i];
          this._yjsProvider!.unbindCell(oldCellModel);
        }
        for (let i = 0; i < change.newValues.length; i++) {
          const cellModel = change.newValues[i];
          const sharedCell = this._createSharedCell(cellModel);
          yCells.delete(change.newIndex + i, 1);
          yCells.insert(change.newIndex + i, [sharedCell]);
          this._yjsProvider!.bindCell(cellModel, sharedCell);
        }
      }
    }, 'cells-update');
  }

  /**
   * Sync changes to the notebook metadata to the Yjs document.
   */
  private _syncMetadataToYjs(): void {
    if (!this._yjsProvider) {
      return;
    }

    const yMetadata = this._yjsProvider.getSharedMetadata();
    const metadata = this.metadata.toJSON();

    this._yjsProvider.ydoc.transact(() => {
      // Update shared metadata with notebook metadata changes
      const keys = new Set([...yMetadata.keys(), ...Object.keys(metadata)]);
      
      for (const key of keys) {
        if (key in metadata) {
          if (yMetadata.get(key) !== metadata[key]) {
            yMetadata.set(key, metadata[key]);
          }
        } else {
          yMetadata.delete(key);
        }
      }
    }, 'metadata-update');
  }

  /**
   * Handle changes to the shared cells array.
   * 
   * @param event - The Y.js event.
   */
  private _onSharedCellsChanged(event: Y.YArrayEvent<any>): void {
    if (event.transaction.origin === 'cells-update') {
      return;
    }

    // Get the shared cells array
    const yCells = this._yjsProvider!.getSharedCells();

    // Handle added cells
    if (event.changes.added.size > 0) {
      for (const item of event.changes.added.values()) {
        const index = yCells.toArray().indexOf(item.content.getContent()[0]);
        if (index >= 0) {
          const sharedCell = item.content.getContent()[0];
          const cellModel = this._createCellModelFromSharedCell(sharedCell);
          
          // Check if we need to add or replace a cell
          if (index < this.cells.length) {
            this.cells.set(index, cellModel);
          } else {
            this.cells.push(cellModel);
          }
          
          this._yjsProvider!.bindCell(cellModel, sharedCell);
        }
      }
    }

    // Handle deleted cells
    if (event.changes.deleted.size > 0) {
      const deletedIndices: number[] = [];
      for (const item of event.changes.deleted.values()) {
        const deltas = item.content.getContent();
        for (const delta of deltas) {
          // Find the cell model corresponding to this shared cell
          for (let i = 0; i < this.cells.length; i++) {
            const cellModel = this.cells.get(i);
            if (!deletedIndices.includes(i) && cellModel.id === delta.get('id')) {
              deletedIndices.push(i);
              this._yjsProvider!.unbindCell(cellModel);
              break;
            }
          }
        }
      }
      
      // Sort indices in descending order to avoid shifting issues
      deletedIndices.sort((a, b) => b - a);
      for (const index of deletedIndices) {
        this.cells.remove(index);
      }
    }
  }

  /**
   * Handle changes to the shared metadata map.
   * 
   * @param event - The Y.js event.
   */
  private _onSharedMetadataChanged(event: Y.YMapEvent<any>): void {
    if (event.transaction.origin === 'metadata-update') {
      return;
    }

    const yMetadata = this._yjsProvider!.getSharedMetadata();

    // Handle added or updated metadata
    event.keysChanged.forEach(key => {
      if (yMetadata.has(key)) {
        this.metadata.set(key, yMetadata.get(key) as JSONValue);
      } else {
        this.metadata.delete(key);
      }
    });
  }

  /**
   * Create a shared cell from a cell model.
   * 
   * @param cellModel - The cell model.
   * @returns The shared cell as a Y.Map.
   */
  private _createSharedCell(cellModel: ICellModel): Y.Map<any> {
    const sharedCell = new Y.Map();

    // Set cell ID
    sharedCell.set('id', cellModel.id);

    // Set cell type
    sharedCell.set('cell_type', cellModel.type);

    // Set cell source
    const source = new Y.Text(cellModel.value.text);
    sharedCell.set('source', source);

    // Set cell metadata
    const metadata = new Y.Map();
    const cellMetadata = cellModel.metadata.toJSON();
    for (const key in cellMetadata) {
      metadata.set(key, cellMetadata[key]);
    }
    sharedCell.set('metadata', metadata);

    // Set cell outputs if it's a code cell
    if (cellModel.type === 'code') {
      const outputs = new Y.Array();
      // TODO: Handle outputs
      sharedCell.set('outputs', outputs);

      // Set execution count
      sharedCell.set('execution_count', null);
    }

    return sharedCell;
  }

  /**
   * Create a cell model from a shared cell.
   * 
   * @param sharedCell - The shared cell.
   * @returns The cell model.
   */
  private _createCellModelFromSharedCell(sharedCell: Y.Map<any>): ICellModel {
    const cellType = sharedCell.get('cell_type') as string;
    const id = sharedCell.get('id') as string || UUID.uuid4();
    const source = sharedCell.get('source') as Y.Text;
    const metadata = sharedCell.get('metadata') as Y.Map<any>;

    // Create cell data
    const cellData: any = {
      cell_type: cellType,
      source: source.toString(),
      metadata: {}
    };

    // Add metadata
    metadata.forEach((value, key) => {
      cellData.metadata[key] = value;
    });

    // Add code cell specific properties
    if (cellType === 'code') {
      cellData.outputs = [];
      cellData.execution_count = sharedCell.get('execution_count') || null;
    }

    // Create cell model
    const cellModel = this._createCellModel(cellData);
    cellModel.id = id;

    return cellModel;
  }

  /**
   * Create a cell model from cell data.
   * 
   * @param cell - The cell data.
   * @returns The cell model.
   */
  private _createCellModel(cell: any): ICellModel {
    // This is a placeholder implementation
    // In a real implementation, you would create the appropriate cell model
    // based on the cell type (code, markdown, raw)
    return {} as ICellModel;
  }

  readonly cells: IObservableList<ICellModel>;
  readonly metadata: IObservableJSON;

  private _dirty: boolean;
  private _readOnly: boolean;
  private _defaultLang: string;
  private _isDisposed = false;
  private _isCollaborative: boolean;
  private _collaborativeState: ICollaborativeState;
  private _yjsProvider: IYjsNotebookProvider | null = null;
  private _lockManager: ILockManager | null = null;
  private _historyManager: IHistoryManager | null = null;

  private _synchronized = new Signal<INotebookModel, void>(this);
  private _collaborationEnabled = new Signal<INotebookModel, void>(this);
  private _collaborationDisabled = new Signal<INotebookModel, void>(this);
}

/**
 * The namespace for the `NotebookModel` class statics.
 */
export namespace NotebookModel {
  /**
   * An options object for initializing a notebook model.
   */
  export interface IOptions {
    /**
     * The language preference for the model.
     */
    defaultLang?: string;

    /**
     * The initial metadata for the notebook.
     */
    metadata?: JSONObject;
  }
}

/**
 * An interface describing changed args for the notebook model.
 */
export interface IChangedArgs<T> {
  /**
   * The name of the changed attribute.
   */
  name: string;

  /**
   * The old value of the changed attribute.
   */
  oldValue: T;

  /**
   * The new value of the changed attribute.
   */
  newValue: T;
}