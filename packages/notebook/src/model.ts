// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { 
  DocumentRegistry, 
  IModelDB, 
  INotebookModel,
  INotebookContent,
  INotebookMetadata,
  ICell,
  ICellModel,
  ICodeCellModel,
  IMarkdownCellModel,
  IRawCellModel,
  CellType,
  nbformat
} from '@jupyterlab/docregistry';

import {
  IObservableList,
  IObservableMap,
  IObservableString,
  IObservableValue,
  ObservableList,
  ObservableMap,
  ObservableString,
  ObservableValue,
  IObservableUndoableList,
  ObservableUndoableList
} from '@jupyterlab/observables';

import { 
  ISignal, 
  Signal, 
  IDisposable,
  DisposableDelegate 
} from '@lumino/signaling';

import { 
  JSONExt,
  JSONObject,
  JSONValue,
  UUID 
} from '@lumino/coreutils';

import { 
  ISharedNotebook,
  ISharedCell,
  ISharedCodeCell,
  ISharedMarkdownCell,
  ISharedRawCell,
  ISharedAttachmentsCell,
  ISharedCellChange,
  ISharedNotebookChange,
  ISharedNotebookDelta,
  ISharedNotebookMetadata,
  ISharedCellOutput,
  ISharedCellOutputChange,
  ISharedCellOutputDelta,
  ISharedCellOutputs,
  ISharedCellOutputsChange,
  ISharedCellAttachments,
  ISharedCellAttachmentsChange,
  ISharedCellMetadata,
  ISharedCellMetadataChange,
} from '@jupyterlab/shared-models';

import { 
  IAwarenessProvider,
  ICollaborativeUser,
  IUserPresence,
  ISelectionState
} from './collab/awareness';

import { 
  ILockManager,
  ICellLock,
  ILockState
} from './collab/locks';

import { 
  IPermissionsManager,
  ICollaborator,
  IPermissionLevel
} from './collab/permissions';

/**
 * The collaborative notebook model interface extending the standard notebook model.
 */
export interface ICollaborativeNotebookModel extends INotebookModel {
  /**
   * The Yjs document for collaborative editing.
   */
  readonly yjsDocument: Y.Doc;

  /**
   * The WebSocket provider for synchronization.
   */
  readonly websocketProvider: WebsocketProvider | null;

  /**
   * The awareness provider for user presence tracking.
   */
  readonly awarenessProvider: IAwarenessProvider | null;

  /**
   * The lock manager for cell-level locking.
   */
  readonly lockManager: ILockManager | null;

  /**
   * The permissions manager for access control.
   */
  readonly permissionsManager: IPermissionsManager | null;

  /**
   * Whether the notebook is in collaborative mode.
   */
  readonly isCollaborative: boolean;

  /**
   * Whether the collaborative connection is active.
   */
  readonly isConnected: boolean;

  /**
   * Signal emitted when the collaboration connection status changes.
   */
  readonly connectionStatusChanged: ISignal<ICollaborativeNotebookModel, boolean>;

  /**
   * Signal emitted when collaborative users change.
   */
  readonly collaboratorsChanged: ISignal<ICollaborativeNotebookModel, ICollaborativeUser[]>;

  /**
   * Signal emitted when cell locks change.
   */
  readonly cellLocksChanged: ISignal<ICollaborativeNotebookModel, Map<string, ICellLock>>;

  /**
   * Enable collaborative mode for this notebook.
   */
  enableCollaboration(options: ICollaborationOptions): Promise<void>;

  /**
   * Disable collaborative mode and fall back to single-user mode.
   */
  disableCollaboration(): Promise<void>;

  /**
   * Get the current collaborative users.
   */
  getCollaborators(): ICollaborativeUser[];

  /**
   * Get the current cell locks.
   */
  getCellLocks(): Map<string, ICellLock>;

  /**
   * Check if a cell is locked by another user.
   */
  isCellLocked(cellId: string): boolean;

  /**
   * Attempt to lock a cell for editing.
   */
  lockCell(cellId: string): Promise<boolean>;

  /**
   * Release a cell lock.
   */
  unlockCell(cellId: string): Promise<void>;

  /**
   * Get the current user's permission level.
   */
  getPermissionLevel(): IPermissionLevel;

  /**
   * Check if the current user can perform a specific action.
   */
  canPerformAction(action: string): boolean;
}

/**
 * Options for enabling collaborative mode.
 */
export interface ICollaborationOptions {
  /**
   * The collaboration server URL.
   */
  serverUrl: string;

  /**
   * The room/document ID for collaboration.
   */
  roomId: string;

  /**
   * Authentication token for collaborative sessions.
   */
  authToken?: string;

  /**
   * Whether to enable awareness tracking.
   */
  enableAwareness?: boolean;

  /**
   * Whether to enable cell-level locking.
   */
  enableLocking?: boolean;

  /**
   * Whether to enable permissions management.
   */
  enablePermissions?: boolean;

  /**
   * Fallback to single-user mode on connection failure.
   */
  fallbackToSingleUser?: boolean;
}

/**
 * The collaborative notebook model implementation.
 */
export class CollaborativeNotebookModel implements ICollaborativeNotebookModel {
  /**
   * Construct a new collaborative notebook model.
   */
  constructor(options: CollaborativeNotebookModel.IOptions = {}) {
    this._defaultKernelName = options.defaultKernelName || '';
    this._defaultKernelLanguage = options.defaultKernelLanguage || '';
    this._collaborationEnabled = options.enableCollaboration || false;
    this._fallbackToSingleUser = options.fallbackToSingleUser !== false;

    // Initialize the shared notebook model
    this._sharedModel = options.sharedModel || new SharedNotebookModel();
    
    // Initialize Yjs document
    this._yjsDocument = new Y.Doc();
    this._yjsNotebook = this._yjsDocument.getMap('notebook');
    this._yjsCells = this._yjsDocument.getArray('cells');
    this._yjsMetadata = this._yjsDocument.getMap('metadata');

    // Initialize observable structures
    this._cells = new ObservableUndoableList<ICellModel>();
    this._metadata = new ObservableMap<JSONValue>();
    this._nbformat = new ObservableValue<number>(4);
    this._nbformatMinor = new ObservableValue<number>(5);

    // Initialize readonly state
    this._readOnly = false;
    this._isDisposed = false;
    this._contentChanged = new Signal<ICollaborativeNotebookModel, void>(this);
    this._stateChanged = new Signal<ICollaborativeNotebookModel, IChangedArgs<any>>(this);
    this._connectionStatusChanged = new Signal<ICollaborativeNotebookModel, boolean>(this);
    this._collaboratorsChanged = new Signal<ICollaborativeNotebookModel, ICollaborativeUser[]>(this);
    this._cellLocksChanged = new Signal<ICollaborativeNotebookModel, Map<string, ICellLock>>(this);

    // Initialize collaboration state
    this._collaborators = new Map<string, ICollaborativeUser>();
    this._cellLocks = new Map<string, ICellLock>();
    this._isConnected = false;
    this._connectionAttempts = 0;
    this._maxConnectionAttempts = 5;
    this._reconnectTimer = null;

    // Set up Yjs document observers
    this._setupYjsObservers();

    // Initialize collaborative services if enabled
    if (this._collaborationEnabled) {
      this._initializeCollaborativeServices();
    }
  }

  /**
   * The Yjs document for collaborative editing.
   */
  get yjsDocument(): Y.Doc {
    return this._yjsDocument;
  }

  /**
   * The WebSocket provider for synchronization.
   */
  get websocketProvider(): WebsocketProvider | null {
    return this._websocketProvider;
  }

  /**
   * The awareness provider for user presence tracking.
   */
  get awarenessProvider(): IAwarenessProvider | null {
    return this._awarenessProvider;
  }

  /**
   * The lock manager for cell-level locking.
   */
  get lockManager(): ILockManager | null {
    return this._lockManager;
  }

  /**
   * The permissions manager for access control.
   */
  get permissionsManager(): IPermissionsManager | null {
    return this._permissionsManager;
  }

  /**
   * Whether the notebook is in collaborative mode.
   */
  get isCollaborative(): boolean {
    return this._collaborationEnabled && this._websocketProvider !== null;
  }

  /**
   * Whether the collaborative connection is active.
   */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Signal emitted when the collaboration connection status changes.
   */
  get connectionStatusChanged(): ISignal<ICollaborativeNotebookModel, boolean> {
    return this._connectionStatusChanged;
  }

  /**
   * Signal emitted when collaborative users change.
   */
  get collaboratorsChanged(): ISignal<ICollaborativeNotebookModel, ICollaborativeUser[]> {
    return this._collaboratorsChanged;
  }

  /**
   * Signal emitted when cell locks change.
   */
  get cellLocksChanged(): ISignal<ICollaborativeNotebookModel, Map<string, ICellLock>> {
    return this._cellLocksChanged;
  }

  /**
   * Test whether the notebook model is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * A signal emitted when the notebook model content changes.
   */
  get contentChanged(): ISignal<ICollaborativeNotebookModel, void> {
    return this._contentChanged;
  }

  /**
   * A signal emitted when the notebook model state changes.
   */
  get stateChanged(): ISignal<ICollaborativeNotebookModel, IChangedArgs<any>> {
    return this._stateChanged;
  }

  /**
   * The observable list of cells in the notebook.
   */
  get cells(): IObservableUndoableList<ICellModel> {
    return this._cells;
  }

  /**
   * The observable map of notebook metadata.
   */
  get metadata(): IObservableMap<JSONValue> {
    return this._metadata;
  }

  /**
   * The major version number of the notebook format.
   */
  get nbformat(): number {
    return this._nbformat.get();
  }

  /**
   * The minor version number of the notebook format.
   */
  get nbformatMinor(): number {
    return this._nbformatMinor.get();
  }

  /**
   * The default kernel name of the notebook.
   */
  get defaultKernelName(): string {
    return this._defaultKernelName;
  }

  /**
   * The default kernel language of the notebook.
   */
  get defaultKernelLanguage(): string {
    return this._defaultKernelLanguage;
  }

  /**
   * Whether the notebook is read-only.
   */
  get readOnly(): boolean {
    return this._readOnly;
  }

  set readOnly(value: boolean) {
    if (this._readOnly !== value) {
      this._readOnly = value;
      this._stateChanged.emit({
        name: 'readOnly',
        oldValue: !value,
        newValue: value
      });
    }
  }

  /**
   * The shared notebook model for collaborative editing.
   */
  get sharedModel(): ISharedNotebook {
    return this._sharedModel;
  }

  /**
   * Enable collaborative mode for this notebook.
   */
  async enableCollaboration(options: ICollaborationOptions): Promise<void> {
    if (this._collaborationEnabled && this._websocketProvider) {
      console.warn('Collaboration is already enabled for this notebook');
      return;
    }

    try {
      // Create WebSocket provider
      this._websocketProvider = new WebsocketProvider(
        options.serverUrl,
        options.roomId,
        this._yjsDocument,
        {
          connect: true,
          WebSocketPolyfill: WebSocket,
          resyncInterval: 2000,
          maxBackoffTime: 10000,
          params: options.authToken ? { token: options.authToken } : undefined
        }
      );

      // Set up connection event handlers
      this._websocketProvider.on('status', (event: { status: string }) => {
        const wasConnected = this._isConnected;
        this._isConnected = event.status === 'connected';
        
        if (wasConnected !== this._isConnected) {
          this._connectionStatusChanged.emit(this._isConnected);
          
          if (this._isConnected) {
            console.log('Connected to collaboration server');
            this._connectionAttempts = 0;
            this._clearReconnectTimer();
          } else {
            console.log('Disconnected from collaboration server');
            this._handleDisconnection();
          }
        }
      });

      this._websocketProvider.on('connection-error', (error: any) => {
        console.error('Collaboration connection error:', error);
        this._handleConnectionError(error);
      });

      // Initialize collaborative services
      await this._initializeCollaborativeServices(options);

      this._collaborationEnabled = true;
      console.log('Collaborative mode enabled');

    } catch (error) {
      console.error('Failed to enable collaboration:', error);
      
      if (options.fallbackToSingleUser !== false) {
        await this.disableCollaboration();
        console.log('Falling back to single-user mode');
      } else {
        throw error;
      }
    }
  }

  /**
   * Disable collaborative mode and fall back to single-user mode.
   */
  async disableCollaboration(): Promise<void> {
    if (!this._collaborationEnabled) {
      return;
    }

    try {
      // Clean up collaborative services
      this._awarenessProvider?.dispose();
      this._lockManager?.dispose();
      this._permissionsManager?.dispose();

      // Disconnect WebSocket provider
      if (this._websocketProvider) {
        this._websocketProvider.disconnect();
        this._websocketProvider.destroy();
        this._websocketProvider = null;
      }

      // Clear timers
      this._clearReconnectTimer();

      // Reset state
      this._collaborationEnabled = false;
      this._isConnected = false;
      this._collaborators.clear();
      this._cellLocks.clear();

      // Emit state change signals
      this._connectionStatusChanged.emit(false);
      this._collaboratorsChanged.emit([]);
      this._cellLocksChanged.emit(new Map());

      console.log('Collaborative mode disabled');

    } catch (error) {
      console.error('Error disabling collaboration:', error);
      throw error;
    }
  }

  /**
   * Get the current collaborative users.
   */
  getCollaborators(): ICollaborativeUser[] {
    return Array.from(this._collaborators.values());
  }

  /**
   * Get the current cell locks.
   */
  getCellLocks(): Map<string, ICellLock> {
    return new Map(this._cellLocks);
  }

  /**
   * Check if a cell is locked by another user.
   */
  isCellLocked(cellId: string): boolean {
    const lock = this._cellLocks.get(cellId);
    return lock !== undefined && lock.userId !== this._getCurrentUserId();
  }

  /**
   * Attempt to lock a cell for editing.
   */
  async lockCell(cellId: string): Promise<boolean> {
    if (!this._lockManager) {
      return true; // No locking in single-user mode
    }

    try {
      const result = await this._lockManager.acquireLock(cellId);
      if (result.success) {
        this._cellLocks.set(cellId, result.lock!);
        this._cellLocksChanged.emit(this.getCellLocks());
      }
      return result.success;
    } catch (error) {
      console.error('Error locking cell:', error);
      return false;
    }
  }

  /**
   * Release a cell lock.
   */
  async unlockCell(cellId: string): Promise<void> {
    if (!this._lockManager) {
      return; // No locking in single-user mode
    }

    try {
      await this._lockManager.releaseLock(cellId);
      this._cellLocks.delete(cellId);
      this._cellLocksChanged.emit(this.getCellLocks());
    } catch (error) {
      console.error('Error unlocking cell:', error);
    }
  }

  /**
   * Get the current user's permission level.
   */
  getPermissionLevel(): IPermissionLevel {
    if (!this._permissionsManager) {
      return 'admin'; // Full permissions in single-user mode
    }

    return this._permissionsManager.getCurrentUserPermission();
  }

  /**
   * Check if the current user can perform a specific action.
   */
  canPerformAction(action: string): boolean {
    if (!this._permissionsManager) {
      return true; // All actions allowed in single-user mode
    }

    return this._permissionsManager.canPerformAction(action);
  }

  /**
   * Dispose of the model.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    // Disable collaboration and clean up resources
    this.disableCollaboration().catch(console.error);

    // Dispose of observables
    this._cells.dispose();
    this._metadata.dispose();
    this._nbformat.dispose();
    this._nbformatMinor.dispose();

    // Dispose of shared model
    this._sharedModel.dispose();

    // Dispose of Yjs document
    this._yjsDocument.destroy();

    // Clear timers
    this._clearReconnectTimer();

    // Mark as disposed
    this._isDisposed = true;
  }

  /**
   * Initialize collaborative services.
   */
  private async _initializeCollaborativeServices(options?: ICollaborationOptions): Promise<void> {
    // Initialize awareness provider
    if (options?.enableAwareness !== false) {
      const { AwarenessProvider } = await import('./collab/awareness');
      this._awarenessProvider = new AwarenessProvider(
        this._websocketProvider!.awareness,
        {
          userId: this._getCurrentUserId(),
          userName: this._getCurrentUserName(),
          userColor: this._getUserColor()
        }
      );

      // Listen for awareness changes
      this._awarenessProvider.collaboratorsChanged.connect((_, collaborators) => {
        this._collaborators.clear();
        collaborators.forEach(user => {
          this._collaborators.set(user.id, user);
        });
        this._collaboratorsChanged.emit(Array.from(this._collaborators.values()));
      });
    }

    // Initialize lock manager
    if (options?.enableLocking !== false) {
      const { LockManager } = await import('./collab/locks');
      this._lockManager = new LockManager(
        this._yjsDocument,
        this._getCurrentUserId()
      );

      // Listen for lock changes
      this._lockManager.locksChanged.connect((_, locks) => {
        this._cellLocks.clear();
        locks.forEach((lock, cellId) => {
          this._cellLocks.set(cellId, lock);
        });
        this._cellLocksChanged.emit(this.getCellLocks());
      });
    }

    // Initialize permissions manager
    if (options?.enablePermissions !== false) {
      const { PermissionsManager } = await import('./collab/permissions');
      this._permissionsManager = new PermissionsManager(
        this._yjsDocument,
        this._getCurrentUserId(),
        options?.authToken
      );
    }
  }

  /**
   * Set up Yjs document observers.
   */
  private _setupYjsObservers(): void {
    // Observer for notebook-level changes
    this._yjsNotebook.observe((event) => {
      this._handleYjsNotebookChange(event);
    });

    // Observer for cell array changes
    this._yjsCells.observe((event) => {
      this._handleYjsCellsChange(event);
    });

    // Observer for metadata changes
    this._yjsMetadata.observe((event) => {
      this._handleYjsMetadataChange(event);
    });
  }

  /**
   * Handle Yjs notebook-level changes.
   */
  private _handleYjsNotebookChange(event: Y.YMapEvent<any>): void {
    if (this._isDisposed) {
      return;
    }

    event.changes.keys.forEach((change, key) => {
      if (key === 'nbformat') {
        this._nbformat.set(this._yjsNotebook.get('nbformat') || 4);
      } else if (key === 'nbformat_minor') {
        this._nbformatMinor.set(this._yjsNotebook.get('nbformat_minor') || 5);
      }
    });

    this._contentChanged.emit();
  }

  /**
   * Handle Yjs cell array changes.
   */
  private _handleYjsCellsChange(event: Y.YArrayEvent<any>): void {
    if (this._isDisposed) {
      return;
    }

    // Handle cell insertions and deletions
    let index = 0;
    event.changes.delta.forEach((change) => {
      if (change.retain) {
        index += change.retain;
      } else if (change.insert) {
        const cells = Array.isArray(change.insert) ? change.insert : [change.insert];
        cells.forEach((cellData, i) => {
          const cell = this._createCellFromYjsData(cellData);
          this._cells.insert(index + i, cell);
        });
        index += cells.length;
      } else if (change.delete) {
        for (let i = 0; i < change.delete; i++) {
          this._cells.remove(index);
        }
      }
    });

    this._contentChanged.emit();
  }

  /**
   * Handle Yjs metadata changes.
   */
  private _handleYjsMetadataChange(event: Y.YMapEvent<any>): void {
    if (this._isDisposed) {
      return;
    }

    event.changes.keys.forEach((change, key) => {
      if (change.action === 'add' || change.action === 'update') {
        this._metadata.set(key, this._yjsMetadata.get(key));
      } else if (change.action === 'delete') {
        this._metadata.delete(key);
      }
    });

    this._contentChanged.emit();
  }

  /**
   * Create a cell model from Yjs data.
   */
  private _createCellFromYjsData(cellData: any): ICellModel {
    const cellType = cellData.cell_type as CellType;
    const cellId = cellData.id || UUID.uuid4();

    switch (cellType) {
      case 'code':
        return new CodeCellModel({
          id: cellId,
          source: cellData.source || '',
          metadata: cellData.metadata || {},
          outputs: cellData.outputs || [],
          executionCount: cellData.execution_count || null
        });

      case 'markdown':
        return new MarkdownCellModel({
          id: cellId,
          source: cellData.source || '',
          metadata: cellData.metadata || {},
          attachments: cellData.attachments || {}
        });

      case 'raw':
        return new RawCellModel({
          id: cellId,
          source: cellData.source || '',
          metadata: cellData.metadata || {},
          attachments: cellData.attachments || {}
        });

      default:
        throw new Error(`Unknown cell type: ${cellType}`);
    }
  }

  /**
   * Handle connection disconnection.
   */
  private _handleDisconnection(): void {
    if (this._fallbackToSingleUser) {
      this._scheduleReconnection();
    }
  }

  /**
   * Handle connection errors.
   */
  private _handleConnectionError(error: any): void {
    this._connectionAttempts++;
    
    if (this._connectionAttempts >= this._maxConnectionAttempts) {
      console.error('Max connection attempts reached. Falling back to single-user mode.');
      this.disableCollaboration().catch(console.error);
    } else {
      this._scheduleReconnection();
    }
  }

  /**
   * Schedule a reconnection attempt.
   */
  private _scheduleReconnection(): void {
    this._clearReconnectTimer();
    
    const delay = Math.min(1000 * Math.pow(2, this._connectionAttempts), 30000);
    this._reconnectTimer = setTimeout(() => {
      if (this._websocketProvider && !this._isConnected) {
        console.log('Attempting to reconnect to collaboration server...');
        this._websocketProvider.connect();
      }
    }, delay);
  }

  /**
   * Clear the reconnection timer.
   */
  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Get the current user ID.
   */
  private _getCurrentUserId(): string {
    // In a real implementation, this would come from authentication
    return 'user-' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Get the current user name.
   */
  private _getCurrentUserName(): string {
    // In a real implementation, this would come from authentication
    return 'User ' + this._getCurrentUserId().slice(-4);
  }

  /**
   * Get the current user's color.
   */
  private _getUserColor(): string {
    // Generate a consistent color based on user ID
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
      '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
    ];
    const userId = this._getCurrentUserId();
    const hash = userId.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    return colors[Math.abs(hash) % colors.length];
  }

  // Private fields
  private _yjsDocument: Y.Doc;
  private _yjsNotebook: Y.Map<any>;
  private _yjsCells: Y.Array<any>;
  private _yjsMetadata: Y.Map<any>;
  private _websocketProvider: WebsocketProvider | null = null;
  private _awarenessProvider: IAwarenessProvider | null = null;
  private _lockManager: ILockManager | null = null;
  private _permissionsManager: IPermissionsManager | null = null;
  private _sharedModel: ISharedNotebook;
  private _cells: ObservableUndoableList<ICellModel>;
  private _metadata: ObservableMap<JSONValue>;
  private _nbformat: ObservableValue<number>;
  private _nbformatMinor: ObservableValue<number>;
  private _defaultKernelName: string;
  private _defaultKernelLanguage: string;
  private _readOnly: boolean;
  private _isDisposed: boolean;
  private _collaborationEnabled: boolean;
  private _fallbackToSingleUser: boolean;
  private _isConnected: boolean;
  private _collaborators: Map<string, ICollaborativeUser>;
  private _cellLocks: Map<string, ICellLock>;
  private _connectionAttempts: number;
  private _maxConnectionAttempts: number;
  private _reconnectTimer: NodeJS.Timeout | null;
  private _contentChanged: Signal<ICollaborativeNotebookModel, void>;
  private _stateChanged: Signal<ICollaborativeNotebookModel, IChangedArgs<any>>;
  private _connectionStatusChanged: Signal<ICollaborativeNotebookModel, boolean>;
  private _collaboratorsChanged: Signal<ICollaborativeNotebookModel, ICollaborativeUser[]>;
  private _cellLocksChanged: Signal<ICollaborativeNotebookModel, Map<string, ICellLock>>;
}

/**
 * The namespace for the CollaborativeNotebookModel.
 */
export namespace CollaborativeNotebookModel {
  /**
   * Options for constructing a collaborative notebook model.
   */
  export interface IOptions {
    /**
     * The default kernel name for the notebook.
     */
    defaultKernelName?: string;

    /**
     * The default kernel language for the notebook.
     */
    defaultKernelLanguage?: string;

    /**
     * Whether to enable collaboration by default.
     */
    enableCollaboration?: boolean;

    /**
     * Whether to fallback to single-user mode on connection failure.
     */
    fallbackToSingleUser?: boolean;

    /**
     * The shared notebook model to use.
     */
    sharedModel?: ISharedNotebook;

    /**
     * Language preference for the notebook.
     */
    languagePreference?: string;

    /**
     * Collaborative synchronization mode.
     */
    collaborationMode?: 'realtime' | 'periodic' | 'manual';
  }
}

/**
 * Shared arguments interface for model state changes.
 */
interface IChangedArgs<T> {
  name: string;
  oldValue: T;
  newValue: T;
}

/**
 * Base class for cell models with collaborative support.
 */
abstract class BaseCellModel implements ICellModel {
  /**
   * Construct a base cell model.
   */
  constructor(options: BaseCellModel.IOptions) {
    this._id = options.id || UUID.uuid4();
    this._source = new ObservableString(options.source || '');
    this._metadata = new ObservableMap<JSONValue>(options.metadata || {});
    this._trusted = options.trusted || false;
    this._isDisposed = false;
    this._contentChanged = new Signal<ICellModel, void>(this);
    this._stateChanged = new Signal<ICellModel, IChangedArgs<any>>(this);

    // Set up observers
    this._source.changed.connect(this._onSourceChanged, this);
    this._metadata.changed.connect(this._onMetadataChanged, this);
  }

  /**
   * The unique identifier for the cell.
   */
  get id(): string {
    return this._id;
  }

  /**
   * The type of the cell.
   */
  abstract get type(): CellType;

  /**
   * The source code or text of the cell.
   */
  get source(): IObservableString {
    return this._source;
  }

  /**
   * The metadata associated with the cell.
   */
  get metadata(): IObservableMap<JSONValue> {
    return this._metadata;
  }

  /**
   * Whether the cell is trusted.
   */
  get trusted(): boolean {
    return this._trusted;
  }

  set trusted(value: boolean) {
    if (this._trusted !== value) {
      const oldValue = this._trusted;
      this._trusted = value;
      this._stateChanged.emit({
        name: 'trusted',
        oldValue,
        newValue: value
      });
    }
  }

  /**
   * Whether the cell model is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Signal emitted when the cell content changes.
   */
  get contentChanged(): ISignal<ICellModel, void> {
    return this._contentChanged;
  }

  /**
   * Signal emitted when the cell state changes.
   */
  get stateChanged(): ISignal<ICellModel, IChangedArgs<any>> {
    return this._stateChanged;
  }

  /**
   * Convert the cell to JSON.
   */
  toJSON(): nbformat.ICell {
    const json: any = {
      id: this._id,
      cell_type: this.type,
      source: this._source.text,
      metadata: this._metadata.toJSON()
    };

    return json;
  }

  /**
   * Dispose of the cell model.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    // Disconnect signals
    this._source.changed.disconnect(this._onSourceChanged, this);
    this._metadata.changed.disconnect(this._onMetadataChanged, this);

    // Dispose observables
    this._source.dispose();
    this._metadata.dispose();

    this._isDisposed = true;
  }

  /**
   * Handle source changes.
   */
  private _onSourceChanged(): void {
    this._contentChanged.emit();
  }

  /**
   * Handle metadata changes.
   */
  private _onMetadataChanged(): void {
    this._contentChanged.emit();
  }

  // Private fields
  private _id: string;
  private _source: ObservableString;
  private _metadata: ObservableMap<JSONValue>;
  private _trusted: boolean;
  private _isDisposed: boolean;
  private _contentChanged: Signal<ICellModel, void>;
  private _stateChanged: Signal<ICellModel, IChangedArgs<any>>;
}

/**
 * Namespace for BaseCellModel.
 */
namespace BaseCellModel {
  /**
   * Options for constructing a base cell model.
   */
  export interface IOptions {
    /**
     * The unique identifier for the cell.
     */
    id?: string;

    /**
     * The source code or text of the cell.
     */
    source?: string;

    /**
     * The metadata associated with the cell.
     */
    metadata?: JSONObject;

    /**
     * Whether the cell is trusted.
     */
    trusted?: boolean;
  }
}

/**
 * A model for a code cell with collaborative support.
 */
export class CodeCellModel extends BaseCellModel implements ICodeCellModel {
  /**
   * Construct a code cell model.
   */
  constructor(options: CodeCellModel.IOptions = {}) {
    super(options);
    this._outputs = new ObservableList<nbformat.IOutput>();
    this._executionCount = new ObservableValue<number | null>(options.executionCount || null);

    // Initialize outputs
    if (options.outputs) {
      options.outputs.forEach(output => {
        this._outputs.pushBack(output);
      });
    }

    // Set up observers
    this._outputs.changed.connect(this._onOutputsChanged, this);
    this._executionCount.changed.connect(this._onExecutionCountChanged, this);
  }

  /**
   * The type of the cell.
   */
  get type(): 'code' {
    return 'code';
  }

  /**
   * The code outputs.
   */
  get outputs(): IObservableList<nbformat.IOutput> {
    return this._outputs;
  }

  /**
   * The execution count of the cell.
   */
  get executionCount(): number | null {
    return this._executionCount.get();
  }

  set executionCount(value: number | null) {
    this._executionCount.set(value);
  }

  /**
   * Convert the cell to JSON.
   */
  toJSON(): nbformat.ICodeCell {
    const json = super.toJSON() as nbformat.ICodeCell;
    json.outputs = this._outputs.toArray();
    json.execution_count = this._executionCount.get();
    return json;
  }

  /**
   * Dispose of the cell model.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    // Disconnect signals
    this._outputs.changed.disconnect(this._onOutputsChanged, this);
    this._executionCount.changed.disconnect(this._onExecutionCountChanged, this);

    // Dispose observables
    this._outputs.dispose();
    this._executionCount.dispose();

    super.dispose();
  }

  /**
   * Handle outputs changes.
   */
  private _onOutputsChanged(): void {
    this.contentChanged.emit();
  }

  /**
   * Handle execution count changes.
   */
  private _onExecutionCountChanged(): void {
    this.stateChanged.emit({
      name: 'executionCount',
      oldValue: this._executionCount.get(),
      newValue: this._executionCount.get()
    });
  }

  // Private fields
  private _outputs: ObservableList<nbformat.IOutput>;
  private _executionCount: ObservableValue<number | null>;
}

/**
 * Namespace for CodeCellModel.
 */
export namespace CodeCellModel {
  /**
   * Options for constructing a code cell model.
   */
  export interface IOptions extends BaseCellModel.IOptions {
    /**
     * The code outputs.
     */
    outputs?: nbformat.IOutput[];

    /**
     * The execution count of the cell.
     */
    executionCount?: number | null;
  }
}

/**
 * A model for a markdown cell with collaborative support.
 */
export class MarkdownCellModel extends BaseCellModel implements IMarkdownCellModel {
  /**
   * Construct a markdown cell model.
   */
  constructor(options: MarkdownCellModel.IOptions = {}) {
    super(options);
    this._attachments = new ObservableMap<nbformat.IMimeBundle>(options.attachments || {});

    // Set up observers
    this._attachments.changed.connect(this._onAttachmentsChanged, this);
  }

  /**
   * The type of the cell.
   */
  get type(): 'markdown' {
    return 'markdown';
  }

  /**
   * The cell attachments.
   */
  get attachments(): IObservableMap<nbformat.IMimeBundle> {
    return this._attachments;
  }

  /**
   * Convert the cell to JSON.
   */
  toJSON(): nbformat.IMarkdownCell {
    const json = super.toJSON() as nbformat.IMarkdownCell;
    if (this._attachments.size > 0) {
      json.attachments = this._attachments.toJSON() as nbformat.IAttachments;
    }
    return json;
  }

  /**
   * Dispose of the cell model.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    // Disconnect signals
    this._attachments.changed.disconnect(this._onAttachmentsChanged, this);

    // Dispose observables
    this._attachments.dispose();

    super.dispose();
  }

  /**
   * Handle attachments changes.
   */
  private _onAttachmentsChanged(): void {
    this.contentChanged.emit();
  }

  // Private fields
  private _attachments: ObservableMap<nbformat.IMimeBundle>;
}

/**
 * Namespace for MarkdownCellModel.
 */
export namespace MarkdownCellModel {
  /**
   * Options for constructing a markdown cell model.
   */
  export interface IOptions extends BaseCellModel.IOptions {
    /**
     * The cell attachments.
     */
    attachments?: nbformat.IAttachments;
  }
}

/**
 * A model for a raw cell with collaborative support.
 */
export class RawCellModel extends BaseCellModel implements IRawCellModel {
  /**
   * Construct a raw cell model.
   */
  constructor(options: RawCellModel.IOptions = {}) {
    super(options);
    this._attachments = new ObservableMap<nbformat.IMimeBundle>(options.attachments || {});

    // Set up observers
    this._attachments.changed.connect(this._onAttachmentsChanged, this);
  }

  /**
   * The type of the cell.
   */
  get type(): 'raw' {
    return 'raw';
  }

  /**
   * The cell attachments.
   */
  get attachments(): IObservableMap<nbformat.IMimeBundle> {
    return this._attachments;
  }

  /**
   * Convert the cell to JSON.
   */
  toJSON(): nbformat.IRawCell {
    const json = super.toJSON() as nbformat.IRawCell;
    if (this._attachments.size > 0) {
      json.attachments = this._attachments.toJSON() as nbformat.IAttachments;
    }
    return json;
  }

  /**
   * Dispose of the cell model.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    // Disconnect signals
    this._attachments.changed.disconnect(this._onAttachmentsChanged, this);

    // Dispose observables
    this._attachments.dispose();

    super.dispose();
  }

  /**
   * Handle attachments changes.
   */
  private _onAttachmentsChanged(): void {
    this.contentChanged.emit();
  }

  // Private fields
  private _attachments: ObservableMap<nbformat.IMimeBundle>;
}

/**
 * Namespace for RawCellModel.
 */
export namespace RawCellModel {
  /**
   * Options for constructing a raw cell model.
   */
  export interface IOptions extends BaseCellModel.IOptions {
    /**
     * The cell attachments.
     */
    attachments?: nbformat.IAttachments;
  }
}

/**
 * A simple shared notebook model implementation.
 */
class SharedNotebookModel implements ISharedNotebook {
  /**
   * Construct a shared notebook model.
   */
  constructor() {
    this._cells = [];
    this._metadata = {};
    this._nbformat = 4;
    this._nbformatMinor = 5;
    this._isDisposed = false;
    this._changed = new Signal<ISharedNotebook, ISharedNotebookChange>(this);
  }

  /**
   * The shared cells in the notebook.
   */
  get cells(): ISharedCell[] {
    return this._cells;
  }

  /**
   * The shared metadata of the notebook.
   */
  get metadata(): ISharedNotebookMetadata {
    return this._metadata;
  }

  /**
   * The notebook format version.
   */
  get nbformat(): number {
    return this._nbformat;
  }

  /**
   * The notebook format minor version.
   */
  get nbformatMinor(): number {
    return this._nbformatMinor;
  }

  /**
   * Whether the model is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Signal emitted when the model changes.
   */
  get changed(): ISignal<ISharedNotebook, ISharedNotebookChange> {
    return this._changed;
  }

  /**
   * The document ID.
   */
  get id(): string {
    return this._id || UUID.uuid4();
  }

  /**
   * Create a standalone cell.
   */
  createStandaloneCell(init: ISharedCell): ISharedCell {
    // Simple implementation for standalone cells
    return { ...init };
  }

  /**
   * Insert cells at a specific position.
   */
  insertCells(index: number, cells: ISharedCell[]): void {
    this._cells.splice(index, 0, ...cells);
    this._changed.emit({
      cellsChange: cells.map((cell, i) => ({
        index: index + i,
        type: 'add',
        cell
      }))
    });
  }

  /**
   * Delete cells from a specific position.
   */
  deleteCells(index: number, count: number): void {
    const deleted = this._cells.splice(index, count);
    this._changed.emit({
      cellsChange: deleted.map((cell, i) => ({
        index: index + i,
        type: 'remove',
        cell
      }))
    });
  }

  /**
   * Set the notebook metadata.
   */
  setMetadata(metadata: ISharedNotebookMetadata): void {
    this._metadata = { ...metadata };
    this._changed.emit({
      metadataChange: {
        oldValue: this._metadata,
        newValue: metadata
      }
    });
  }

  /**
   * Dispose of the model.
   */
  dispose(): void {
    this._isDisposed = true;
  }

  // Private fields
  private _id: string = UUID.uuid4();
  private _cells: ISharedCell[];
  private _metadata: ISharedNotebookMetadata;
  private _nbformat: number;
  private _nbformatMinor: number;
  private _isDisposed: boolean;
  private _changed: Signal<ISharedNotebook, ISharedNotebookChange>;
}

/**
 * A model factory for collaborative notebooks.
 */
export class CollaborativeNotebookModelFactory implements DocumentRegistry.IModelFactory<ICollaborativeNotebookModel> {
  /**
   * The name of the model factory.
   */
  readonly name = 'notebook';

  /**
   * The content type for the model factory.
   */
  readonly contentType = 'notebook';

  /**
   * The file format for the model factory.
   */
  readonly fileFormat = 'json';

  /**
   * Whether the model factory is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Signal emitted when the factory is disposed.
   */
  get disposed(): ISignal<CollaborativeNotebookModelFactory, void> {
    return this._disposed;
  }

  /**
   * Create a new model for the given language preference.
   */
  createNew(languagePreference?: string, modelDB?: IModelDB, isInitialized?: boolean): ICollaborativeNotebookModel {
    const defaultKernelLanguage = languagePreference || 'python';
    const defaultKernelName = this._getDefaultKernelName(defaultKernelLanguage);

    return new CollaborativeNotebookModel({
      defaultKernelName,
      defaultKernelLanguage,
      languagePreference,
      enableCollaboration: this._enableCollaboration,
      fallbackToSingleUser: this._fallbackToSingleUser
    });
  }

  /**
   * Get the preferred language for the model.
   */
  preferredLanguage(path: string): string {
    return this._defaultKernelLanguage;
  }

  /**
   * Dispose of the model factory.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._disposed.emit();
  }

  /**
   * Get the default kernel name for a language.
   */
  private _getDefaultKernelName(language: string): string {
    // Simple mapping of languages to kernel names
    const kernelMap: { [key: string]: string } = {
      python: 'python3',
      python3: 'python3',
      python2: 'python2',
      r: 'ir',
      julia: 'julia-1.6',
      scala: 'scala',
      javascript: 'javascript',
      typescript: 'typescript'
    };

    return kernelMap[language.toLowerCase()] || 'python3';
  }

  // Configuration options
  private _defaultKernelLanguage = 'python';
  private _enableCollaboration = false;
  private _fallbackToSingleUser = true;
  private _isDisposed = false;
  private _disposed = new Signal<CollaborativeNotebookModelFactory, void>(this);
}

/**
 * Namespace for CollaborativeNotebookModelFactory.
 */
export namespace CollaborativeNotebookModelFactory {
  /**
   * Options for configuring the model factory.
   */
  export interface IOptions {
    /**
     * The default kernel language.
     */
    defaultKernelLanguage?: string;

    /**
     * Whether to enable collaboration by default.
     */
    enableCollaboration?: boolean;

    /**
     * Whether to fallback to single-user mode on connection failure.
     */
    fallbackToSingleUser?: boolean;
  }
}

/**
 * Configure the notebook model factory.
 */
export function configureNotebookModelFactory(options: CollaborativeNotebookModelFactory.IOptions = {}): void {
  const factory = new CollaborativeNotebookModelFactory();
  
  if (options.defaultKernelLanguage) {
    (factory as any)._defaultKernelLanguage = options.defaultKernelLanguage;
  }
  
  if (options.enableCollaboration !== undefined) {
    (factory as any)._enableCollaboration = options.enableCollaboration;
  }
  
  if (options.fallbackToSingleUser !== undefined) {
    (factory as any)._fallbackToSingleUser = options.fallbackToSingleUser;
  }
}

/**
 * Default notebook model factory instance.
 */
export const notebookModelFactory = new CollaborativeNotebookModelFactory();