// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DocumentRegistry } from '@jupyterlab/docregistry';
import { 
  INotebookModel, 
  NotebookModel as BaseNotebookModel,
  INotebookContent
} from '@jupyterlab/notebook';
import {
  ICellModel,
  ICodeCellModel,
  IMarkdownCellModel,
  IRawCellModel,
  CellModel,
  CodeCellModel,
  MarkdownCellModel,
  RawCellModel
} from '@jupyterlab/cells';
import { IObservableList, IObservableMap } from '@jupyterlab/observables';
import { IModelDB, ModelDB } from '@jupyterlab/observables';
import { 
  Contents,
  Session,
  ServiceManager
} from '@jupyterlab/services';
import { ISignal, Signal } from '@lumino/signaling';
import { JSONObject, JSONValue, PartialJSONObject } from '@lumino/coreutils';
import { 
  IChangedArgs as IObservableChangedArgs
} from '@jupyterlab/observables';

// Yjs imports for collaborative editing
import * as Y from 'yjs';

// Collaboration provider interfaces (will be imported once created)
interface IYjsNotebookProvider {
  readonly ydoc: Y.Doc;
  readonly ynotebook: Y.Map<any>;
  readonly ycells: Y.Array<Y.Map<any>>;
  readonly ymetadata: Y.Map<any>;
  readonly isConnected: boolean;
  readonly isCollaborative: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  dispose(): void;
}

interface IAwarenessProvider {
  readonly awareness: any;
  setLocalState(state: any): void;
  getStates(): Map<number, any>;
  on(event: string, handler: Function): void;
  off(event: string, handler: Function): void;
}

interface ILockProvider {
  acquireLock(cellId: string): Promise<boolean>;
  releaseLock(cellId: string): void;
  isLocked(cellId: string): boolean;
  getLockedBy(cellId: string): string | null;
  onLockChanged: ISignal<ILockProvider, { cellId: string; locked: boolean; lockedBy: string | null }>;
}

/**
 * Enhanced notebook model with Yjs CRDT collaborative editing capabilities.
 * 
 * This model extends the base NotebookModel to support real-time collaborative
 * editing while maintaining full backward compatibility with single-user mode.
 * When collaboration is available, it synchronizes changes through Yjs CRDT;
 * otherwise, it gracefully degrades to standard single-user functionality.
 */
export class CollaborativeNotebookModel extends BaseNotebookModel implements INotebookModel {
  private _yjsProvider: IYjsNotebookProvider | null = null;
  private _awarenessProvider: IAwarenessProvider | null = null;
  private _lockProvider: ILockProvider | null = null;
  private _isCollaborative = false;
  private _collaborationEnabled = false;
  private _collaborationMetadata: Y.Map<any> | null = null;
  private _isInitializingFromYjs = false;
  private _collaborativeSignal = new Signal<this, boolean>(this);
  private _connectionStatusSignal = new Signal<this, boolean>(this);
  private _suppressModelUpdates = false;

  /**
   * Construct a new collaborative notebook model.
   *
   * @param options - The options used to create the model.
   */
  constructor(options: INotebookModel.IOptions = {}) {
    super(options);
    
    // Initialize collaboration if feature flag is enabled
    this._collaborationEnabled = this._getCollaborationFeatureFlag();
    
    if (this._collaborationEnabled) {
      this._initializeCollaboration();
    }
  }

  /**
   * Whether the model is in collaborative mode.
   */
  get isCollaborative(): boolean {
    return this._isCollaborative;
  }

  /**
   * Signal emitted when collaborative status changes.
   */
  get collaborativeChanged(): ISignal<this, boolean> {
    return this._collaborativeSignal;
  }

  /**
   * Signal emitted when connection status changes.
   */
  get connectionStatusChanged(): ISignal<this, boolean> {
    return this._connectionStatusSignal;
  }

  /**
   * Whether the collaboration connection is active.
   */
  get isConnected(): boolean {
    return this._yjsProvider?.isConnected ?? false;
  }

  /**
   * Get the Yjs document if collaboration is active.
   */
  get yjsDocument(): Y.Doc | null {
    return this._yjsProvider?.ydoc ?? null;
  }

  /**
   * Get collaborative metadata separate from notebook metadata.
   */
  get collaborativeMetadata(): Y.Map<any> | null {
    return this._collaborationMetadata;
  }

  /**
   * Initialize collaborative editing capabilities.
   */
  private async _initializeCollaboration(): Promise<void> {
    try {
      // Dynamically import collaboration providers to avoid dependencies
      // when collaboration is disabled
      const { YjsNotebookProvider } = await import('./collab/provider');
      const { AwarenessProvider } = await import('./collab/awareness');
      const { LockProvider } = await import('./collab/locks');

      // Create Yjs provider
      this._yjsProvider = new YjsNotebookProvider({
        notebookModel: this,
        // Connection details will be configured by the application
      });

      // Create awareness provider for presence information
      this._awarenessProvider = new AwarenessProvider({
        yjsProvider: this._yjsProvider
      });

      // Create lock provider for cell-level locking
      this._lockProvider = new LockProvider({
        yjsProvider: this._yjsProvider
      });

      // Set up collaborative metadata
      this._collaborationMetadata = this._yjsProvider.ydoc.getMap('collaboration');

      // Connect to collaboration infrastructure
      await this._connectToCollaboration();

    } catch (error) {
      console.warn('Failed to initialize collaboration, falling back to single-user mode:', error);
      this._gracefulDegradation();
    }
  }

  /**
   * Connect to the collaboration infrastructure.
   */
  private async _connectToCollaboration(): Promise<void> {
    if (!this._yjsProvider) {
      return;
    }

    try {
      await this._yjsProvider.connect();
      this._isCollaborative = true;
      this._setupYjsBindings();
      this._collaborativeSignal.emit(true);
      this._connectionStatusSignal.emit(true);
    } catch (error) {
      console.warn('Failed to connect to collaboration server:', error);
      this._gracefulDegradation();
    }
  }

  /**
   * Set up bidirectional synchronization between Yjs and notebook model.
   */
  private _setupYjsBindings(): void {
    if (!this._yjsProvider) {
      return;
    }

    const ycells = this._yjsProvider.ycells;
    const ymetadata = this._yjsProvider.ymetadata;

    // Listen for Yjs changes and update notebook model
    ycells.observe(this._onYjsCellsChanged.bind(this));
    ymetadata.observe(this._onYjsMetadataChanged.bind(this));

    // Listen for notebook model changes and update Yjs
    this.cells.changed.connect(this._onCellsChanged, this);
    this.metadataChanged.connect(this._onMetadataChanged, this);

    // Sync current state to Yjs if this is the first client
    if (ycells.length === 0) {
      this._syncModelToYjs();
    } else {
      // Sync Yjs state to model if joining existing session
      this._syncYjsToModel();
    }
  }

  /**
   * Handle changes from Yjs cells array.
   */
  private _onYjsCellsChanged(event: Y.YArrayEvent<Y.Map<any>>): void {
    if (this._suppressModelUpdates) {
      return;
    }

    this._isInitializingFromYjs = true;

    try {
      // Process Yjs changes and apply to notebook model
      let cellIndex = 0;
      
      event.changes.delta.forEach((change: any) => {
        if (change.retain) {
          cellIndex += change.retain;
        } else if (change.insert) {
          // Insert new cells
          const newCells = change.insert as Y.Map<any>[];
          newCells.forEach((ycell: Y.Map<any>, i: number) => {
            const cellData = this._yjsMapToCell(ycell);
            const cell = this._createCellFromData(cellData);
            this.cells.insert(cellIndex + i, cell);
          });
          cellIndex += newCells.length;
        } else if (change.delete) {
          // Delete cells
          for (let i = 0; i < change.delete; i++) {
            if (cellIndex < this.cells.length) {
              this.cells.remove(cellIndex);
            }
          }
        }
      });
    } finally {
      this._isInitializingFromYjs = false;
    }
  }

  /**
   * Handle changes from Yjs metadata map.
   */
  private _onYjsMetadataChanged(event: Y.YMapEvent<any>): void {
    if (this._suppressModelUpdates) {
      return;
    }

    // Update notebook metadata based on Yjs changes
    event.keysChanged.forEach(key => {
      const value = event.target.get(key);
      if (value !== undefined) {
        this.metadata.set(key, value);
      } else {
        this.metadata.delete(key);
      }
    });
  }

  /**
   * Handle changes from notebook cells and sync to Yjs.
   */
  private _onCellsChanged(
    sender: IObservableList<ICellModel>,
    args: IObservableList.IChangedArgs<ICellModel>
  ): void {
    if (this._isInitializingFromYjs || !this._yjsProvider) {
      return;
    }

    this._suppressModelUpdates = true;
    
    try {
      const ycells = this._yjsProvider.ycells;
      
      switch (args.type) {
        case 'add':
          // Insert cells into Yjs array
          const ycellsToInsert = args.newValues.map(cell => this._cellToYjsMap(cell));
          ycells.insert(args.newIndex, ycellsToInsert);
          break;

        case 'remove':
          // Remove cells from Yjs array
          ycells.delete(args.oldIndex, args.oldValues.length);
          break;

        case 'move':
          // Move cells in Yjs array
          const movedCells = ycells.slice(args.oldIndex, args.oldIndex + args.newValues.length);
          ycells.delete(args.oldIndex, args.newValues.length);
          ycells.insert(args.newIndex, movedCells);
          break;

        case 'set':
          // Replace cells in Yjs array
          const ycellsToSet = args.newValues.map(cell => this._cellToYjsMap(cell));
          ycells.delete(args.newIndex, args.oldValues.length);
          ycells.insert(args.newIndex, ycellsToSet);
          break;
      }
    } finally {
      this._suppressModelUpdates = false;
    }
  }

  /**
   * Handle metadata changes and sync to Yjs.
   */
  private _onMetadataChanged(
    sender: IObservableMap<JSONValue>,
    args: IObservableMap.IChangedArgs<JSONValue>
  ): void {
    if (this._isInitializingFromYjs || !this._yjsProvider) {
      return;
    }

    const ymetadata = this._yjsProvider.ymetadata;
    
    switch (args.type) {
      case 'add':
      case 'change':
        ymetadata.set(args.key, args.newValue);
        break;
      case 'remove':
        ymetadata.delete(args.key);
        break;
    }
  }

  /**
   * Convert a cell model to a Yjs Map.
   */
  private _cellToYjsMap(cell: ICellModel): Y.Map<any> {
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
  private _yjsMapToCell(ycell: Y.Map<any>): any {
    const cellData: any = {
      id: ycell.get('id'),
      cell_type: ycell.get('cell_type'),
      source: ycell.get('source'),
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
  private _createCellFromData(cellData: any): ICellModel {
    const options = {
      id: cellData.id,
      contentFactory: this.contentFactory
    };

    let cell: ICellModel;

    switch (cellData.cell_type) {
      case 'code':
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
        cell = new MarkdownCellModel(options);
        break;
      case 'raw':
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
   * Sync the current notebook model state to Yjs.
   */
  private _syncModelToYjs(): void {
    if (!this._yjsProvider) {
      return;
    }

    this._suppressModelUpdates = true;

    try {
      // Sync cells
      const ycells = this._yjsProvider.ycells;
      const cellMaps = Array.from(this.cells).map(cell => this._cellToYjsMap(cell));
      ycells.insert(0, cellMaps);

      // Sync metadata
      const ymetadata = this._yjsProvider.ymetadata;
      const metadata = this.metadata.toJSON();
      Object.entries(metadata).forEach(([key, value]) => {
        ymetadata.set(key, value);
      });
    } finally {
      this._suppressModelUpdates = false;
    }
  }

  /**
   * Sync Yjs state to the notebook model.
   */
  private _syncYjsToModel(): void {
    if (!this._yjsProvider) {
      return;
    }

    this._isInitializingFromYjs = true;

    try {
      // Clear current cells and sync from Yjs
      this.cells.clear();
      
      const ycells = this._yjsProvider.ycells;
      const cells: ICellModel[] = [];
      
      for (let i = 0; i < ycells.length; i++) {
        const ycell = ycells.get(i);
        const cellData = this._yjsMapToCell(ycell);
        const cell = this._createCellFromData(cellData);
        cells.push(cell);
      }
      
      this.cells.pushAll(cells);

      // Sync metadata
      const ymetadata = this._yjsProvider.ymetadata;
      this.metadata.clear();
      ymetadata.forEach((value, key) => {
        this.metadata.set(key, value);
      });
    } finally {
      this._isInitializingFromYjs = false;
    }
  }

  /**
   * Check if collaboration feature flag is enabled.
   */
  private _getCollaborationFeatureFlag(): boolean {
    // Check environment variables or configuration
    if (typeof window !== 'undefined') {
      // Browser environment
      return (window as any).__JUPYTER_COLLABORATION_ENABLED__ === true;
    }
    
    // Node.js environment
    return process.env.JUPYTER_COLLABORATION_ENABLED === 'true';
  }

  /**
   * Gracefully degrade to single-user mode when collaboration fails.
   */
  private _gracefulDegradation(): void {
    console.info('Collaboration unavailable, using single-user mode');
    this._isCollaborative = false;
    this._collaborativeSignal.emit(false);
    this._connectionStatusSignal.emit(false);
    
    // Clean up collaboration providers
    if (this._yjsProvider) {
      this._yjsProvider.dispose();
      this._yjsProvider = null;
    }
    
    if (this._awarenessProvider) {
      this._awarenessProvider = null;
    }
    
    if (this._lockProvider) {
      this._lockProvider = null;
    }
    
    this._collaborationMetadata = null;
  }

  /**
   * Attempt to acquire a lock for a specific cell.
   * 
   * @param cellId - The ID of the cell to lock
   * @returns Promise that resolves to true if lock was acquired
   */
  async acquireCellLock(cellId: string): Promise<boolean> {
    if (!this._lockProvider || !this._isCollaborative) {
      // In single-user mode, locks are always granted
      return true;
    }

    try {
      return await this._lockProvider.acquireLock(cellId);
    } catch (error) {
      console.warn('Failed to acquire cell lock:', error);
      return false;
    }
  }

  /**
   * Release a lock for a specific cell.
   * 
   * @param cellId - The ID of the cell to unlock
   */
  releaseCellLock(cellId: string): void {
    if (!this._lockProvider || !this._isCollaborative) {
      return;
    }

    this._lockProvider.releaseLock(cellId);
  }

  /**
   * Check if a cell is currently locked.
   * 
   * @param cellId - The ID of the cell to check
   * @returns True if the cell is locked by another user
   */
  isCellLocked(cellId: string): boolean {
    if (!this._lockProvider || !this._isCollaborative) {
      return false;
    }

    return this._lockProvider.isLocked(cellId);
  }

  /**
   * Get the user who has locked a specific cell.
   * 
   * @param cellId - The ID of the cell to check
   * @returns The user ID who locked the cell, or null if not locked
   */
  getCellLockedBy(cellId: string): string | null {
    if (!this._lockProvider || !this._isCollaborative) {
      return null;
    }

    return this._lockProvider.getLockedBy(cellId);
  }

  /**
   * Set local user awareness state.
   * 
   * @param state - The awareness state to broadcast
   */
  setAwarenessState(state: any): void {
    if (!this._awarenessProvider || !this._isCollaborative) {
      return;
    }

    this._awarenessProvider.setLocalState(state);
  }

  /**
   * Get awareness states from all connected users.
   * 
   * @returns Map of user ID to awareness state
   */
  getAwarenessStates(): Map<number, any> {
    if (!this._awarenessProvider || !this._isCollaborative) {
      return new Map();
    }

    return this._awarenessProvider.getStates();
  }

  /**
   * Override fromJSON to handle collaborative initialization.
   */
  fromJSON(value: INotebookContent): void {
    if (!this._isCollaborative) {
      // Use base implementation for single-user mode
      super.fromJSON(value);
      return;
    }

    // In collaborative mode, sync with Yjs if connected
    if (this._yjsProvider && this._yjsProvider.ycells.length === 0) {
      // First time loading - sync to Yjs
      super.fromJSON(value);
      this._syncModelToYjs();
    } else {
      // Already has collaborative state - sync from Yjs
      this._syncYjsToModel();
    }
  }

  /**
   * Override toJSON to ensure .ipynb format integrity.
   */
  toJSON(): INotebookContent {
    // Always use base implementation to ensure standard .ipynb format
    // Collaborative metadata is stored separately and not in the file
    return super.toJSON();
  }

  /**
   * Override dispose to clean up collaborative resources.
   */
  dispose(): void {
    if (this._yjsProvider) {
      this._yjsProvider.disconnect();
      this._yjsProvider.dispose();
    }

    super.dispose();
  }

  /**
   * Manually trigger collaboration sync for testing or troubleshooting.
   */
  syncCollaboration(): void {
    if (!this._isCollaborative || !this._yjsProvider) {
      return;
    }

    this._syncModelToYjs();
  }

  /**
   * Get collaboration statistics for monitoring.
   */
  getCollaborationStats(): {
    isCollaborative: boolean;
    isConnected: boolean;
    connectedUsers: number;
    totalUpdates: number;
  } {
    return {
      isCollaborative: this._isCollaborative,
      isConnected: this.isConnected,
      connectedUsers: this._awarenessProvider?.getStates().size ?? 0,
      totalUpdates: this._yjsProvider?.ydoc.clientID ?? 0
    };
  }
}

/**
 * Create a notebook model factory that returns collaborative models.
 */
export class CollaborativeNotebookModelFactory extends DocumentRegistry.ModelFactory<INotebookModel> {
  /**
   * Create a new notebook model.
   */
  createNew(options: DocumentRegistry.IModelOptions<INotebookModel> = {}): INotebookModel {
    return new CollaborativeNotebookModel(options);
  }
}

/**
 * Default collaborative notebook model factory instance.
 */
export const collaborativeNotebookModelFactory = new CollaborativeNotebookModelFactory({
  name: 'notebook',
  contentType: 'notebook',
  fileFormat: 'json'
});