// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISignal, Signal } from '@lumino/signaling';
import { DocumentRegistry, IDocumentModel } from '@jupyterlab/docregistry';
import { IObservableList, ObservableList } from '@jupyterlab/observables';
import { INotebookModel, ICellModel, ICell } from '@jupyterlab/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { IChangedArgs } from '@jupyterlab/coreutils';

// Yjs imports for CRDT-based collaborative editing
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

// Import collaboration modules
import { YjsAwareness } from './collab/awareness';
import { ILockManager } from './collab/locks';
import { IHistoryManager } from './collab/history';
import { IPermissionsManager } from './collab/permissions';
import { ICommentSystem } from './collab/comments';

/**
 * An interface describing the YjsNotebookProvider.
 */
export interface IYjsNotebookProvider {
  /**
   * The Yjs document used for collaboration.
   */
  readonly ydoc: Y.Doc;

  /**
   * The WebSocket provider for real-time synchronization.
   */
  readonly provider: WebsocketProvider | null;

  /**
   * The IndexedDB persistence provider for offline support.
   */
  readonly persistence: IndexeddbPersistence | null;

  /**
   * Connect to the collaboration server.
   */
  connect(): void;

  /**
   * Disconnect from the collaboration server.
   */
  disconnect(): void;

  /**
   * A signal emitted when the connection status changes.
   */
  readonly connectionStatusChanged: ISignal<IYjsNotebookProvider, boolean>;

  /**
   * Whether the provider is connected to the collaboration server.
   */
  readonly connected: boolean;

  /**
   * Bind a notebook model to the Yjs document.
   * 
   * @param model - The notebook model to bind.
   */
  bindNotebook(model: NotebookModel): void;

  /**
   * Unbind a notebook model from the Yjs document.
   * 
   * @param model - The notebook model to unbind.
   */
  unbindNotebook(model: NotebookModel): void;

  /**
   * Get the shared notebook data from the Yjs document.
   */
  getSharedNotebook(): Y.Map<any>;

  /**
   * Get the shared cells array from the Yjs document.
   */
  getSharedCells(): Y.Array<any>;

  /**
   * Get the awareness instance for user presence tracking.
   */
  readonly awareness: YjsAwareness;
}

/**
 * A class that provides Yjs CRDT integration for notebook models.
 */
export class YjsNotebookProvider implements IYjsNotebookProvider {
  /**
   * Construct a new YjsNotebookProvider.
   * 
   * @param options - The options for creating the provider.
   */
  constructor(options: YjsNotebookProvider.IOptions) {
    this._ydoc = new Y.Doc();
    this._notebookId = options.notebookId;
    this._url = options.url || 'ws://localhost:1234';
    this._awareness = options.awareness || new YjsAwareness({
      ydoc: this._ydoc,
      clientID: this._ydoc.clientID
    });

    // Initialize the shared notebook data structure
    this._sharedNotebook = this._ydoc.getMap('notebook');
    this._sharedCells = this._ydoc.getArray('cells');

    // Set up persistence if enabled
    if (options.enablePersistence !== false) {
      try {
        this._persistence = new IndexeddbPersistence(
          `jupyter-notebook-${this._notebookId}`,
          this._ydoc
        );
      } catch (e) {
        console.warn('Failed to initialize IndexedDB persistence:', e);
        this._persistence = null;
      }
    }

    // Connect to the collaboration server if autoConnect is enabled
    if (options.autoConnect !== false) {
      this.connect();
    }
  }

  /**
   * The Yjs document used for collaboration.
   */
  get ydoc(): Y.Doc {
    return this._ydoc;
  }

  /**
   * The WebSocket provider for real-time synchronization.
   */
  get provider(): WebsocketProvider | null {
    return this._provider;
  }

  /**
   * The IndexedDB persistence provider for offline support.
   */
  get persistence(): IndexeddbPersistence | null {
    return this._persistence;
  }

  /**
   * The awareness instance for user presence tracking.
   */
  get awareness(): YjsAwareness {
    return this._awareness;
  }

  /**
   * Whether the provider is connected to the collaboration server.
   */
  get connected(): boolean {
    return this._provider?.wsconnected || false;
  }

  /**
   * A signal emitted when the connection status changes.
   */
  get connectionStatusChanged(): ISignal<IYjsNotebookProvider, boolean> {
    return this._connectionStatusChanged;
  }

  /**
   * Connect to the collaboration server.
   */
  connect(): void {
    if (this._provider) {
      // Already connected or connecting
      return;
    }

    try {
      this._provider = new WebsocketProvider(this._url, this._notebookId, this._ydoc, {
        awareness: this._awareness.awareness
      });

      // Listen for connection status changes
      this._provider.on('status', (event: { status: string }) => {
        const connected = event.status === 'connected';
        this._connectionStatusChanged.emit(connected);
      });

      // Handle connection errors
      this._provider.on('connection-error', (error: Error) => {
        console.error('Collaboration server connection error:', error);
      });
    } catch (e) {
      console.error('Failed to connect to collaboration server:', e);
    }
  }

  /**
   * Disconnect from the collaboration server.
   */
  disconnect(): void {
    if (this._provider) {
      this._provider.disconnect();
      this._provider = null;
      this._connectionStatusChanged.emit(false);
    }
  }

  /**
   * Bind a notebook model to the Yjs document.
   * 
   * @param model - The notebook model to bind.
   */
  bindNotebook(model: NotebookModel): void {
    if (this._boundModel === model) {
      return;
    }

    // Unbind previous model if any
    if (this._boundModel) {
      this.unbindNotebook(this._boundModel);
    }

    this._boundModel = model;

    // Initialize the shared notebook with the model's metadata
    this._sharedNotebook.set('metadata', model.metadata.toJSON());

    // Set up metadata synchronization
    this._sharedNotebook.observe(event => {
      if (event.keysChanged.has('metadata')) {
        const metadata = this._sharedNotebook.get('metadata');
        if (metadata) {
          // Update the model's metadata without triggering a change event
          model.metadata.fromJSON(metadata);
        }
      }
    });

    // Listen for metadata changes in the model
    model.metadata.changed.connect((metadata, changes) => {
      // Update the shared notebook metadata
      this._sharedNotebook.set('metadata', metadata.toJSON());
    });

    // Set up cell synchronization
    this._bindCells(model);
  }

  /**
   * Unbind a notebook model from the Yjs document.
   * 
   * @param model - The notebook model to unbind.
   */
  unbindNotebook(model: NotebookModel): void {
    if (this._boundModel !== model) {
      return;
    }

    // Clean up cell bindings
    this._unbindCells(model);

    // Clean up metadata bindings
    model.metadata.changed.disconnect(this._onMetadataChanged, this);

    this._boundModel = null;
  }

  /**
   * Get the shared notebook data from the Yjs document.
   */
  getSharedNotebook(): Y.Map<any> {
    return this._sharedNotebook;
  }

  /**
   * Get the shared cells array from the Yjs document.
   */
  getSharedCells(): Y.Array<any> {
    return this._sharedCells;
  }

  /**
   * Bind the cells of a notebook model to the Yjs document.
   * 
   * @param model - The notebook model to bind cells for.
   */
  private _bindCells(model: NotebookModel): void {
    // Initialize the shared cells with the model's cells
    this._sharedCells.delete(0, this._sharedCells.length);
    model.cells.forEach((cell, index) => {
      const cellData = {
        cell_type: cell.type,
        source: cell.value.text,
        metadata: cell.metadata.toJSON()
      };
      this._sharedCells.insert(index, [cellData]);
    });

    // Listen for changes to the shared cells
    this._sharedCells.observe(event => {
      // Handle cell additions, deletions, and updates
      this._updatingCells = true;
      try {
        // Handle deletions
        if (event.deleteCount > 0) {
          model.cells.removeRange(event.index, event.index + event.deleteCount);
        }

        // Handle insertions
        if (event.insert && event.insert.length > 0) {
          const cells = event.insert.map((cellData: any) => {
            return model.contentFactory.createCell(cellData.cell_type, {
              value: cellData.source,
              metadata: cellData.metadata
            });
          });
          model.cells.insertAll(event.index, cells);
        }
      } finally {
        this._updatingCells = false;
      }
    });

    // Listen for changes to the model's cells
    model.cells.changed.connect(this._onCellsChanged, this);
  }

  /**
   * Unbind the cells of a notebook model from the Yjs document.
   * 
   * @param model - The notebook model to unbind cells for.
   */
  private _unbindCells(model: NotebookModel): void {
    model.cells.changed.disconnect(this._onCellsChanged, this);
  }

  /**
   * Handle changes to the model's cells.
   */
  private _onCellsChanged(cells: IObservableList<ICellModel>, args: IObservableList.IChangedArgs<ICellModel>): void {
    if (this._updatingCells) {
      return; // Avoid feedback loop
    }

    this._updatingCells = true;
    try {
      switch (args.type) {
        case 'add': {
          const cellsData = args.newValues.map(cell => ({
            cell_type: cell.type,
            source: cell.value.text,
            metadata: cell.metadata.toJSON()
          }));
          this._sharedCells.insert(args.newIndex, cellsData);
          break;
        }
        case 'remove': {
          this._sharedCells.delete(args.oldIndex, args.oldValues.length);
          break;
        }
        case 'move': {
          // Handle move by removing and inserting
          const cellsData = args.newValues.map(cell => ({
            cell_type: cell.type,
            source: cell.value.text,
            metadata: cell.metadata.toJSON()
          }));
          this._sharedCells.delete(args.oldIndex, args.oldValues.length);
          this._sharedCells.insert(args.newIndex, cellsData);
          break;
        }
        case 'set': {
          // Replace cells at the specified index
          const cellsData = args.newValues.map(cell => ({
            cell_type: cell.type,
            source: cell.value.text,
            metadata: cell.metadata.toJSON()
          }));
          this._sharedCells.delete(args.newIndex, args.oldValues.length);
          this._sharedCells.insert(args.newIndex, cellsData);
          break;
        }
      }
    } finally {
      this._updatingCells = false;
    }
  }

  /**
   * Handle changes to the model's metadata.
   */
  private _onMetadataChanged(metadata: any, changes: IChangedArgs<any>): void {
    this._sharedNotebook.set('metadata', metadata.toJSON());
  }

  private _ydoc: Y.Doc;
  private _notebookId: string;
  private _url: string;
  private _provider: WebsocketProvider | null = null;
  private _persistence: IndexeddbPersistence | null = null;
  private _awareness: YjsAwareness;
  private _sharedNotebook: Y.Map<any>;
  private _sharedCells: Y.Array<any>;
  private _boundModel: NotebookModel | null = null;
  private _updatingCells = false;
  private _connectionStatusChanged = new Signal<IYjsNotebookProvider, boolean>(this);
}

/**
 * The namespace for YjsNotebookProvider class statics.
 */
export namespace YjsNotebookProvider {
  /**
   * The options used to create a YjsNotebookProvider.
   */
  export interface IOptions {
    /**
     * The unique ID for the notebook document.
     */
    notebookId: string;

    /**
     * The WebSocket URL for the collaboration server.
     */
    url?: string;

    /**
     * Whether to automatically connect to the collaboration server.
     */
    autoConnect?: boolean;

    /**
     * Whether to enable IndexedDB persistence for offline support.
     */
    enablePersistence?: boolean;

    /**
     * The awareness instance to use for user presence tracking.
     */
    awareness?: YjsAwareness;
  }
}

/**
 * An implementation of a notebook model.
 */
export class NotebookModel implements INotebookModel {
  /**
   * Construct a new notebook model.
   */
  constructor(options: NotebookModel.IOptions) {
    this.contentFactory =
      options.contentFactory || NotebookModel.defaultContentFactory;
    this._rendermime = options.rendermime;
    this._collaborative = options.collaborative !== false;
    this._cells = new ObservableList<ICellModel>();
    this._metadata = options.languagePreference
      ? { kernelspec: { name: options.languagePreference, display_name: options.languagePreference } }
      : {};

    // Initialize the Yjs provider if collaborative mode is enabled
    if (this._collaborative && options.collaborationOptions) {
      this._initializeCollaboration(options.collaborationOptions);
    }

    // Set up cell change tracking
    this._cells.changed.connect(this._onCellsChanged, this);
  }

  /**
   * The list of cell models in the notebook.
   */
  get cells(): IObservableList<ICellModel> {
    return this._cells;
  }

  /**
   * The metadata associated with the notebook.
   */
  get metadata(): IObservableJSON {
    return this._metadata;
  }

  /**
   * The dirty state of the notebook.
   */
  get dirty(): boolean {
    return this._dirty;
  }
  set dirty(value: boolean) {
    if (value === this._dirty) {
      return;
    }
    this._dirty = value;
    this._dirtyChanged.emit(value);
  }

  /**
   * The read-only state of the notebook.
   */
  get readOnly(): boolean {
    return this._readOnly;
  }
  set readOnly(value: boolean) {
    if (value === this._readOnly) {
      return;
    }
    this._readOnly = value;
    this._readOnlyChanged.emit(value);
    this.cells.forEach(cell => {
      cell.readOnly = value;
    });
  }

  /**
   * The default kernel name of the notebook.
   */
  get defaultKernelName(): string {
    const spec = this._metadata.get('kernelspec') as JSONObject;
    return spec ? (spec.name as string) : '';
  }

  /**
   * The default kernel language of the notebook.
   */
  get defaultKernelLanguage(): string {
    const spec = this._metadata.get('kernelspec') as JSONObject;
    const language = spec ? (spec.language as string) : '';
    return language || this._metadata.get('language') as string || '';
  }

  /**
   * Whether the model is collaborative.
   */
  get collaborative(): boolean {
    return this._collaborative;
  }

  /**
   * The Yjs notebook provider for collaborative editing.
   */
  get yjsProvider(): IYjsNotebookProvider | null {
    return this._yjsProvider;
  }

  /**
   * A signal emitted when the notebook content changes.
   */
  get contentChanged(): ISignal<NotebookModel, void> {
    return this._contentChanged;
  }

  /**
   * A signal emitted when the dirty state changes.
   */
  get dirtyChanged(): ISignal<NotebookModel, boolean> {
    return this._dirtyChanged;
  }

  /**
   * A signal emitted when the read-only state changes.
   */
  get readOnlyChanged(): ISignal<NotebookModel, boolean> {
    return this._readOnlyChanged;
  }

  /**
   * The content factory used by the model.
   */
  readonly contentFactory: NotebookModel.IContentFactory;

  /**
   * The rendermime instance used by the model.
   */
  get rendermime(): IRenderMimeRegistry | null {
    return this._rendermime;
  }

  /**
   * Initialize the model with a new document.
   */
  initialize(): void {
    // No-op, initialization happens in constructor
  }

  /**
   * Serialize the model to JSON.
   */
  toJSON(): any {
    const cells: any[] = [];
    for (let i = 0; i < this._cells.length; i++) {
      const cell = this._cells.get(i);
      cells.push(cell.toJSON());
    }
    return {
      cells,
      metadata: this._metadata.toJSON(),
      nbformat: 4,
      nbformat_minor: 5
    };
  }

  /**
   * Deserialize the model from JSON.
   *
   * @param content - The JSON representation of the notebook model.
   */
  fromJSON(content: any): void {
    const cells: ICellModel[] = [];
    const factory = this.contentFactory;

    // Extract the metadata
    this._metadata.fromJSON(content.metadata);

    // Extract the cells
    if (Array.isArray(content.cells)) {
      for (const cellData of content.cells) {
        const cell = factory.createCell(cellData.cell_type, {
          value: cellData.source,
          metadata: cellData.metadata
        });
        cells.push(cell);
      }
    }

    // Update the cells list
    this._cells.clear();
    this._cells.pushAll(cells);

    // Reset the dirty state
    this.dirty = false;
  }

  /**
   * Dispose of the resources held by the model.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._cells.dispose();
    this._metadata.dispose();

    // Clean up collaboration resources
    if (this._yjsProvider) {
      this._yjsProvider.unbindNotebook(this);
      this._yjsProvider.disconnect();
      this._yjsProvider = null;
    }

    Signal.clearData(this);
  }

  /**
   * Whether the model has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Enable collaborative editing for this notebook model.
   * 
   * @param options - The options for collaborative editing.
   */
  enableCollaboration(options: NotebookModel.ICollaborationOptions): void {
    if (this._collaborative && this._yjsProvider) {
      // Already in collaborative mode
      return;
    }

    this._collaborative = true;
    this._initializeCollaboration(options);
  }

  /**
   * Disable collaborative editing for this notebook model.
   */
  disableCollaboration(): void {
    if (!this._collaborative || !this._yjsProvider) {
      // Not in collaborative mode
      return;
    }

    // Clean up collaboration resources
    this._yjsProvider.unbindNotebook(this);
    this._yjsProvider.disconnect();
    this._yjsProvider = null;
    this._collaborative = false;
  }

  /**
   * Initialize the collaborative editing functionality.
   * 
   * @param options - The options for collaborative editing.
   */
  private _initializeCollaboration(options: NotebookModel.ICollaborationOptions): void {
    // Create the Yjs provider
    this._yjsProvider = new YjsNotebookProvider({
      notebookId: options.documentId || this._generateDocumentId(),
      url: options.url,
      autoConnect: options.autoConnect !== false,
      enablePersistence: options.enablePersistence !== false,
      awareness: options.awareness
    });

    // Bind the notebook model to the Yjs document
    this._yjsProvider.bindNotebook(this);

    // Listen for connection status changes
    this._yjsProvider.connectionStatusChanged.connect((_, connected) => {
      // Update UI or trigger events based on connection status
      console.log(`Collaboration connection status: ${connected ? 'connected' : 'disconnected'}`);
    });
  }

  /**
   * Generate a unique document ID for collaboration.
   */
  private _generateDocumentId(): string {
    return `notebook-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  }

  /**
   * Handle changes to the cells list.
   */
  private _onCellsChanged(cells: IObservableList<ICellModel>, args: IObservableList.IChangedArgs<ICellModel>): void {
    // Mark the notebook as dirty
    this.dirty = true;

    // Emit the content changed signal
    this._contentChanged.emit();

    // Set up change tracking for new cells
    if (args.type === 'add') {
      args.newValues.forEach(cell => {
        cell.contentChanged.connect(this._onCellContentChanged, this);
        cell.metadataChanged.connect(this._onCellMetadataChanged, this);
      });
    }
  }

  /**
   * Handle changes to a cell's content.
   */
  private _onCellContentChanged(cell: ICellModel): void {
    this.dirty = true;
    this._contentChanged.emit();
  }

  /**
   * Handle changes to a cell's metadata.
   */
  private _onCellMetadataChanged(cell: ICellModel): void {
    this.dirty = true;
    this._contentChanged.emit();
  }

  private _cells: ObservableList<ICellModel>;
  private _metadata: IObservableJSON;
  private _dirty = false;
  private _readOnly = false;
  private _isDisposed = false;
  private _rendermime: IRenderMimeRegistry | null;
  private _collaborative: boolean;
  private _yjsProvider: IYjsNotebookProvider | null = null;
  private _contentChanged = new Signal<NotebookModel, void>(this);
  private _dirtyChanged = new Signal<NotebookModel, boolean>(this);
  private _readOnlyChanged = new Signal<NotebookModel, boolean>(this);
}

/**
 * The namespace for NotebookModel class statics.
 */
export namespace NotebookModel {
  /**
   * An interface for the notebook model options.
   */
  export interface IOptions {
    /**
     * The language preference for the model.
     */
    languagePreference?: string;

    /**
     * The content factory used by the model.
     */
    contentFactory?: IContentFactory;

    /**
     * The rendermime instance used by the model.
     */
    rendermime?: IRenderMimeRegistry;

    /**
     * Whether the model should be collaborative.
     */
    collaborative?: boolean;

    /**
     * The options for collaborative editing.
     */
    collaborationOptions?: ICollaborationOptions;
  }

  /**
   * An interface for the notebook model collaborative options.
   */
  export interface ICollaborationOptions {
    /**
     * The unique ID for the document.
     */
    documentId?: string;

    /**
     * The WebSocket URL for the collaboration server.
     */
    url?: string;

    /**
     * Whether to automatically connect to the collaboration server.
     */
    autoConnect?: boolean;

    /**
     * Whether to enable IndexedDB persistence for offline support.
     */
    enablePersistence?: boolean;

    /**
     * The awareness instance to use for user presence tracking.
     */
    awareness?: YjsAwareness;
  }

  /**
   * A factory for creating notebook content.
   */
  export interface IContentFactory {
    /**
     * Create a new cell model.
     *
     * @param type - The cell type.
     * @param options - The options used to create the cell.
     *
     * @returns A new cell model.
     */
    createCell(type: string, options?: ICell.IOptions): ICellModel;
  }

  /**
   * The default implementation of an `IContentFactory`.
   */
  export class ContentFactory implements IContentFactory {
    /**
     * Create a new cell model.
     *
     * @param type - The cell type.
     * @param options - The options used to create the cell.
     *
     * @returns A new cell model.
     */
    createCell(type: string, options?: ICell.IOptions): ICellModel {
      switch (type) {
        case 'code':
          return new CodeCellModel(options);
        case 'markdown':
          return new MarkdownCellModel(options);
        default:
          return new RawCellModel(options);
      }
    }
  }

  /**
   * The default `ContentFactory` instance.
   */
  export const defaultContentFactory = new ContentFactory();
}

/**
 * A namespace for private data.
 */
namespace Private {
  /**
   * A type alias for a JSON object.
   */
  export type JSONObject = { [key: string]: any };

  /**
   * A type alias for a JSON array.
   */
  export type JSONArray = any[];

  /**
   * A type definition for an observable JSON value.
   */
  export interface IObservableJSON extends IObservable {
    /**
     * Get a value for a specific key.
     *
     * @param key - The key of interest.
     *
     * @returns The value for the key.
     */
    get(key: string): any;

    /**
     * Set a value for a specific key.
     *
     * @param key - The key of interest.
     * @param value - The new value.
     */
    set(key: string, value: any): void;

    /**
     * Remove a key from the observable object.
     *
     * @param key - The key of interest.
     */
    delete(key: string): void;

    /**
     * Serialize the model to JSON.
     */
    toJSON(): JSONObject;

    /**
     * Deserialize the model from JSON.
     *
     * @param values - The serialized values.
     */
    fromJSON(values: JSONObject): void;
  }

  /**
   * A type definition for an observable.
   */
  export interface IObservable {
    /**
     * A signal emitted when the observable changes.
     */
    readonly changed: ISignal<any, IChangedArgs<any>>;
  }
}

// Import these classes to satisfy TypeScript, but they would be defined elsewhere
class CodeCellModel implements ICellModel {
  constructor(options?: ICell.IOptions) {}
  get type(): string { return 'code'; }
  get readOnly(): boolean { return false; }
  set readOnly(value: boolean) {}
  get value(): IObservableString { return null as any; }
  get metadata(): IObservableJSON { return null as any; }
  get contentChanged(): ISignal<ICellModel, void> { return null as any; }
  get metadataChanged(): ISignal<ICellModel, void> { return null as any; }
  dispose(): void {}
  get isDisposed(): boolean { return false; }
  toJSON(): any { return {}; }
}

class MarkdownCellModel implements ICellModel {
  constructor(options?: ICell.IOptions) {}
  get type(): string { return 'markdown'; }
  get readOnly(): boolean { return false; }
  set readOnly(value: boolean) {}
  get value(): IObservableString { return null as any; }
  get metadata(): IObservableJSON { return null as any; }
  get contentChanged(): ISignal<ICellModel, void> { return null as any; }
  get metadataChanged(): ISignal<ICellModel, void> { return null as any; }
  dispose(): void {}
  get isDisposed(): boolean { return false; }
  toJSON(): any { return {}; }
}

class RawCellModel implements ICellModel {
  constructor(options?: ICell.IOptions) {}
  get type(): string { return 'raw'; }
  get readOnly(): boolean { return false; }
  set readOnly(value: boolean) {}
  get value(): IObservableString { return null as any; }
  get metadata(): IObservableJSON { return null as any; }
  get contentChanged(): ISignal<ICellModel, void> { return null as any; }
  get metadataChanged(): ISignal<ICellModel, void> { return null as any; }
  dispose(): void {}
  get isDisposed(): boolean { return false; }
  toJSON(): any { return {}; }
}

interface IObservableString extends Private.IObservable {
  text: string;
}

interface IObservableJSON extends Private.IObservableJSON {}