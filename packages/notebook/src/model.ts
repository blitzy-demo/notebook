// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { YNotebook } from '@jupyter/ydoc';

import { INotebookModel } from '@jupyterlab/notebook';
import { INotebookContent } from '@jupyterlab/nbformat';
import { ICellModel } from '@jupyterlab/cells';
import { ISharedDocument } from '@jupyterlab/docregistry';

import { Signal, ISignal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';

import YjsNotebookProvider from './collab/provider';
import UserAwareness from './collab/awareness';
import { IChangeHistory } from './collab/history';
import CellLocking from './collab/locks';
import PermissionsSystem from './collab/permissions';
import CommentSystem from './collab/comments';

/**
 * Enumeration of collaboration states for tracking collaboration status
 */
export enum CollaborationState {
  DISABLED = 'disabled',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  SYNCING = 'syncing',
  SYNCED = 'synced',
  OFFLINE = 'offline',
  ERROR = 'error'
}

/**
 * Enumeration of synchronization states for tracking document sync
 */
export enum SyncState {
  IDLE = 'idle',
  SYNCING = 'syncing',
  SYNCED = 'synced',
  CONFLICT = 'conflict',
  ERROR = 'error'
}

/**
 * Interface for collaborative notebook functionality
 */
export interface ICollaborativeNotebook {
  /** Whether collaboration is enabled */
  collaborationEnabled: boolean;
  /** The collaboration provider instance */
  collaborationProvider: YjsNotebookProvider | null;
  /** User awareness system */
  userAwareness: UserAwareness | null;
  /** Change history system */
  changeHistory: IChangeHistory | null;
  /** Current connection state */
  connectionState: string;
  /** Current sync state */
  syncState: SyncState;
  /** Whether the notebook is in collaborative mode */
  isCollaborative: boolean;
  /** The underlying Yjs document */
  yjsDocument: Y.Doc | null;
  /** The collaboration provider */
  provider: YjsNotebookProvider | null;
  /** The awareness system */
  awareness: UserAwareness | null;
  /** Enable collaboration */
  enableCollaboration(): Promise<void>;
  /** Disable collaboration */
  disableCollaboration(): Promise<void>;
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
  getUserAwareness(): UserAwareness | null;
  /** Get change history */
  getChangeHistory(): IChangeHistory | null;
  /** Get the collaboration provider instance */
  getProvider(): YjsNotebookProvider | null;
  /** Current connection state */
  connectionState: string;
  /** Current sync status */
  syncStatus: SyncState;
  /** Signal emitted when connection state changes */
  onConnectionStateChanged: ISignal<ICollaborationManager, string>;
  /** Signal emitted when sync state changes */
  onSyncStateChanged: ISignal<ICollaborationManager, SyncState>;
}

/**
 * Interface for collaboration state tracking
 */
export interface ICollaborationState {
  /** Whether connected to collaboration server */
  isConnected: boolean;
  /** Current connection state */
  connectionState: string;
  /** Current sync status */
  syncStatus: SyncState;
  /** Current session ID */
  sessionId: string;
  /** List of active users */
  activeUsers: any[];
  /** Last synchronization timestamp */
  lastSyncTime: number;
  /** Signal emitted when connection state changes */
  onConnectionStateChanged: ISignal<ICollaborationState, string>;
  /** Signal emitted when sync state changes */
  onSyncStateChanged: ISignal<ICollaborationState, SyncState>;
  /** Signal emitted when active users change */
  onActiveUsersChanged: ISignal<ICollaborationState, any[]>;
}

/**
 * Configuration interface for collaboration settings
 */
interface ICollaborationConfig {
  /** WebSocket URL for collaboration server */
  websocketUrl: string;
  /** Room name for collaboration session */
  roomName: string;
  /** Enable offline mode */
  enableOfflineMode: boolean;
  /** Enable user awareness */
  enableAwareness: boolean;
  /** Enable change history */
  enableHistory: boolean;
  /** Enable cell locking */
  enableLocking: boolean;
  /** Enable permissions system */
  enablePermissions: boolean;
  /** Enable comment system */
  enableComments: boolean;
  /** Auto-connect on initialization */
  autoConnect: boolean;
}

/**
 * Default collaboration configuration
 */
const DEFAULT_COLLABORATION_CONFIG: ICollaborationConfig = {
  websocketUrl: 'ws://localhost:8888/api/collaboration',
  roomName: 'default',
  enableOfflineMode: true,
  enableAwareness: true,
  enableHistory: true,
  enableLocking: true,
  enablePermissions: true,
  enableComments: true,
  autoConnect: true
};

/**
 * NotebookModel: Enhanced collaborative notebook model with CRDT-based real-time editing
 * 
 * This model extends the standard notebook model to support real-time collaborative editing
 * using Yjs CRDT framework. It maintains backward compatibility with existing .ipynb files
 * while providing advanced collaboration features including user awareness, change history,
 * cell locking, permissions, and commenting.
 */
export default class NotebookModel implements INotebookModel, ICollaborativeNotebook, ICollaborationManager, ICollaborationState, IDisposable {
  private _disposed = false;
  private _collaborationEnabled = false;
  private _isCollaborative = false;
  private _collaborationConfig: ICollaborationConfig;
  
  // Core notebook data
  private _cells: ICellModel[] = [];
  private _metadata: any = {};
  private _sharedModel: ISharedDocument | null = null;
  
  // Yjs and collaboration components
  private _yjsDocument: Y.Doc | null = null;
  private _yNotebook: YNotebook | null = null;
  private _provider: YjsNotebookProvider | null = null;
  private _awareness: UserAwareness | null = null;
  private _changeHistory: IChangeHistory | null = null;
  private _cellLocking: CellLocking | null = null;
  private _permissions: PermissionsSystem | null = null;
  private _commentSystem: CommentSystem | null = null;
  
  // State tracking
  private _connectionState = CollaborationState.DISABLED;
  private _syncState = SyncState.IDLE;
  private _sessionId = '';
  private _activeUsers: any[] = [];
  private _lastSyncTime = 0;
  
  // Signals for model events
  private _contentChanged = new Signal<INotebookModel, void>(this);
  private _stateChanged = new Signal<INotebookModel, any>(this);
  private _onCellsChanged = new Signal<NotebookModel, void>(this);
  private _onMetadataChanged = new Signal<NotebookModel, void>(this);
  private _onConnectionStateChanged = new Signal<ICollaborationManager, string>(this);
  private _onSyncStateChanged = new Signal<ICollaborationManager, SyncState>(this);
  private _onActiveUsersChanged = new Signal<ICollaborationState, any[]>(this);
  
  // Synchronization management
  private _syncInProgress = false;
  private _pendingUpdates = new Set<string>();
  private _updateThrottleTimer: number | null = null;
  private _reconnectTimer: number | null = null;

  /**
   * Construct a new NotebookModel
   * 
   * @param config - Configuration options for collaboration
   */
  constructor(config: Partial<ICollaborationConfig> = {}) {
    this._collaborationConfig = { ...DEFAULT_COLLABORATION_CONFIG, ...config };
    this._sessionId = UUID.uuid4();
    
    // Initialize collaboration if enabled
    if (this._collaborationConfig.autoConnect) {
      this.enableCollaboration().catch(console.error);
    }
  }

  /**
   * Get the array of cells in the notebook
   */
  get cells(): ICellModel[] {
    return [...this._cells];
  }

  /**
   * Get the notebook metadata
   */
  get metadata(): any {
    return { ...this._metadata };
  }

  /**
   * Get the shared document model
   */
  get sharedModel(): ISharedDocument | null {
    return this._sharedModel;
  }

  /**
   * Set the shared document model
   */
  set sharedModel(model: ISharedDocument | null) {
    this._sharedModel = model;
    this._stateChanged.emit({ name: 'sharedModel', oldValue: this._sharedModel, newValue: model });
  }

  /**
   * Whether collaboration is enabled
   */
  get collaborationEnabled(): boolean {
    return this._collaborationEnabled;
  }

  /**
   * Get the collaboration provider instance
   */
  get collaborationProvider(): YjsNotebookProvider | null {
    return this._provider;
  }

  /**
   * Get the user awareness system
   */
  get userAwareness(): UserAwareness | null {
    return this._awareness;
  }

  /**
   * Get the change history system
   */
  get changeHistory(): IChangeHistory | null {
    return this._changeHistory;
  }

  /**
   * Get the current connection state
   */
  get connectionState(): string {
    return this._connectionState;
  }

  /**
   * Get the current sync state
   */
  get syncState(): SyncState {
    return this._syncState;
  }

  /**
   * Whether the notebook is in collaborative mode
   */
  get isCollaborative(): boolean {
    return this._isCollaborative;
  }

  /**
   * Get the underlying Yjs document
   */
  get yjsDocument(): Y.Doc | null {
    return this._yjsDocument;
  }

  /**
   * Get the collaboration provider
   */
  get provider(): YjsNotebookProvider | null {
    return this._provider;
  }

  /**
   * Get the awareness system
   */
  get awareness(): UserAwareness | null {
    return this._awareness;
  }

  /**
   * Signal emitted when notebook content changes
   */
  get contentChanged(): ISignal<INotebookModel, void> {
    return this._contentChanged;
  }

  /**
   * Signal emitted when notebook state changes
   */
  get stateChanged(): ISignal<INotebookModel, any> {
    return this._stateChanged;
  }

  /**
   * Signal emitted when cells change
   */
  get onCellsChanged(): ISignal<NotebookModel, void> {
    return this._onCellsChanged;
  }

  /**
   * Signal emitted when metadata changes
   */
  get onMetadataChanged(): ISignal<NotebookModel, void> {
    return this._onMetadataChanged;
  }

  /**
   * Whether connected to collaboration server
   */
  get isConnected(): boolean {
    return this._connectionState === CollaborationState.CONNECTED || 
           this._connectionState === CollaborationState.SYNCED;
  }

  /**
   * Get the session ID
   */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Get the list of active users
   */
  get activeUsers(): any[] {
    return [...this._activeUsers];
  }

  /**
   * Get the last synchronization timestamp
   */
  get lastSyncTime(): number {
    return this._lastSyncTime;
  }

  /**
   * Current sync status
   */
  get syncStatus(): SyncState {
    return this._syncState;
  }

  /**
   * Signal emitted when connection state changes
   */
  get onConnectionStateChanged(): ISignal<ICollaborationManager, string> {
    return this._onConnectionStateChanged;
  }

  /**
   * Signal emitted when sync state changes
   */
  get onSyncStateChanged(): ISignal<ICollaborationManager, SyncState> {
    return this._onSyncStateChanged;
  }

  /**
   * Signal emitted when active users change
   */
  get onActiveUsersChanged(): ISignal<ICollaborationState, any[]> {
    return this._onActiveUsersChanged;
  }

  /**
   * Enable collaboration mode
   */
  async enableCollaboration(): Promise<void> {
    if (this._collaborationEnabled) {
      return;
    }

    try {
      await this._initializeCollaboration();
      this._collaborationEnabled = true;
      this._isCollaborative = true;
      this._updateConnectionState(CollaborationState.CONNECTING);
      
      // Connect to collaboration server
      await this.connect();
      
      console.log('Collaboration enabled successfully');
    } catch (error) {
      console.error('Failed to enable collaboration:', error);
      this._updateConnectionState(CollaborationState.ERROR);
      throw error;
    }
  }

  /**
   * Disable collaboration mode
   */
  async disableCollaboration(): Promise<void> {
    if (!this._collaborationEnabled) {
      return;
    }

    try {
      // Disconnect from collaboration server
      await this.disconnect();
      
      // Clean up collaboration components
      this._cleanupCollaboration();
      
      this._collaborationEnabled = false;
      this._isCollaborative = false;
      this._updateConnectionState(CollaborationState.DISABLED);
      
      console.log('Collaboration disabled successfully');
    } catch (error) {
      console.error('Failed to disable collaboration:', error);
      throw error;
    }
  }

  /**
   * Connect to collaboration server
   */
  async connect(): Promise<void> {
    if (!this._collaborationEnabled || !this._provider) {
      throw new Error('Collaboration not enabled');
    }

    try {
      this._updateConnectionState(CollaborationState.CONNECTING);
      await this._provider.connect();
      this._updateConnectionState(CollaborationState.CONNECTED);
      this._updateSyncState(SyncState.SYNCED);
      this._lastSyncTime = Date.now();
      
      // Set up awareness and other systems
      await this._initializeAwareness();
      
      console.log('Connected to collaboration server');
    } catch (error) {
      console.error('Failed to connect to collaboration server:', error);
      this._updateConnectionState(CollaborationState.ERROR);
      throw error;
    }
  }

  /**
   * Disconnect from collaboration server
   */
  async disconnect(): Promise<void> {
    if (!this._provider) {
      return;
    }

    try {
      await this._provider.disconnect();
      this._updateConnectionState(CollaborationState.OFFLINE);
      this._updateSyncState(SyncState.IDLE);
      
      console.log('Disconnected from collaboration server');
    } catch (error) {
      console.error('Failed to disconnect from collaboration server:', error);
      throw error;
    }
  }

  /**
   * Get list of active users
   */
  getActiveUsers(): any[] {
    if (!this._awareness) {
      return [];
    }
    return this._awareness.getActiveUsers();
  }

  /**
   * Get user awareness information
   */
  getUserAwareness(): UserAwareness | null {
    return this._awareness;
  }

  /**
   * Get change history
   */
  getChangeHistory(): IChangeHistory | null {
    return this._changeHistory;
  }

  /**
   * Get the collaboration provider instance
   */
  getProvider(): YjsNotebookProvider | null {
    return this._provider;
  }

  /**
   * Convert notebook to JSON format
   */
  toJSON(): INotebookContent {
    const cellData = this._cells.map(cell => cell.toJSON());
    
    return {
      cells: cellData,
      metadata: this._metadata,
      nbformat: 4,
      nbformat_minor: 5
    };
  }

  /**
   * Load notebook from JSON format
   */
  fromJSON(data: INotebookContent): void {
    try {
      // Update metadata
      this._metadata = data.metadata || {};
      
      // Update cells
      this._cells = data.cells.map(cellData => {
        // Create cell model from cell data
        // This is a simplified implementation - in reality, this would
        // create proper ICellModel instances based on cell type
        return {
          id: cellData.id || UUID.uuid4(),
          type: cellData.cell_type,
          source: cellData.source,
          metadata: cellData.metadata || {},
          toJSON: () => cellData,
          fromJSON: (json: any) => { /* implementation */ },
          contentChanged: new Signal(this),
          stateChanged: new Signal(this)
        } as ICellModel;
      });
      
      // Sync with Yjs document if collaboration is enabled
      if (this._collaborationEnabled && this._yNotebook) {
        this._syncToYjs();
      }
      
      // Emit change events
      this._contentChanged.emit();
      this._stateChanged.emit({ name: 'notebook', oldValue: null, newValue: data });
      this._onCellsChanged.emit();
      this._onMetadataChanged.emit();
      
    } catch (error) {
      console.error('Failed to load notebook from JSON:', error);
      throw error;
    }
  }

  /**
   * Create a new cell
   */
  createCell(type: string, options: any = {}): ICellModel {
    const cellId = UUID.uuid4();
    const cell: ICellModel = {
      id: cellId,
      type: type,
      source: options.source || '',
      metadata: options.metadata || {},
      toJSON: () => ({
        id: cellId,
        cell_type: type,
        source: options.source || '',
        metadata: options.metadata || {}
      }),
      fromJSON: (json: any) => { /* implementation */ },
      contentChanged: new Signal(this),
      stateChanged: new Signal(this)
    };
    
    // Add to cells array
    this._cells.push(cell);
    
    // Sync with Yjs document if collaboration is enabled
    if (this._collaborationEnabled && this._yNotebook) {
      this._syncCellToYjs(cell);
    }
    
    // Emit change events
    this._contentChanged.emit();
    this._onCellsChanged.emit();
    
    return cell;
  }

  /**
   * Delete a cell
   */
  deleteCell(cellId: string): boolean {
    const index = this._cells.findIndex(cell => cell.id === cellId);
    if (index === -1) {
      return false;
    }
    
    // Remove from cells array
    this._cells.splice(index, 1);
    
    // Sync with Yjs document if collaboration is enabled
    if (this._collaborationEnabled && this._yNotebook) {
      this._removeCellFromYjs(cellId);
    }
    
    // Emit change events
    this._contentChanged.emit();
    this._onCellsChanged.emit();
    
    return true;
  }

  /**
   * Move a cell to a new position
   */
  moveCell(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this._cells.length || 
        toIndex < 0 || toIndex >= this._cells.length) {
      return false;
    }
    
    // Move cell in array
    const cell = this._cells.splice(fromIndex, 1)[0];
    this._cells.splice(toIndex, 0, cell);
    
    // Sync with Yjs document if collaboration is enabled
    if (this._collaborationEnabled && this._yNotebook) {
      this._syncCellOrderToYjs();
    }
    
    // Emit change events
    this._contentChanged.emit();
    this._onCellsChanged.emit();
    
    return true;
  }

  /**
   * Check if the model is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the model and clean up resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    
    this._disposed = true;
    
    // Clean up collaboration components
    this._cleanupCollaboration();
    
    // Clean up timers
    if (this._updateThrottleTimer) {
      clearTimeout(this._updateThrottleTimer);
      this._updateThrottleTimer = null;
    }
    
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    
    // Clean up signals
    Signal.clearData(this);
    
    // Clean up cells
    this._cells = [];
    this._metadata = {};
  }

  /**
   * Initialize collaboration components
   */
  private async _initializeCollaboration(): Promise<void> {
    try {
      // Initialize Yjs document
      this._yjsDocument = new Y.Doc();
      this._yNotebook = new YNotebook();
      
      // Initialize collaboration provider
      this._provider = new YjsNotebookProvider({
        websocketUrl: this._collaborationConfig.websocketUrl,
        roomName: this._collaborationConfig.roomName,
        enableOfflineMode: this._collaborationConfig.enableOfflineMode,
        enableAwareness: this._collaborationConfig.enableAwareness,
        enablePersistence: true,
        reconnectDelay: 1000,
        maxRetries: 10,
        heartbeatInterval: 30000
      });
      
      // Set up provider event handlers
      this._setupProviderEventHandlers();
      
      // Initialize other collaboration components
      if (this._collaborationConfig.enableAwareness) {
        this._awareness = new UserAwareness(this._provider);
      }
      
      if (this._collaborationConfig.enableLocking) {
        this._cellLocking = new CellLocking(this._provider, this._awareness!);
      }
      
      if (this._collaborationConfig.enablePermissions) {
        this._permissions = new PermissionsSystem(this._provider, this._awareness!);
      }
      
      if (this._collaborationConfig.enableComments) {
        this._commentSystem = new CommentSystem(this._provider, this._awareness!, this._permissions!);
      }
      
      console.log('Collaboration components initialized successfully');
    } catch (error) {
      console.error('Failed to initialize collaboration components:', error);
      throw error;
    }
  }

  /**
   * Initialize awareness system
   */
  private async _initializeAwareness(): Promise<void> {
    if (!this._awareness) {
      return;
    }
    
    try {
      // Update active users when awareness changes
      this._awareness.onUsersChanged.connect((sender, users) => {
        this._activeUsers = Array.from(users.values());
        this._onActiveUsersChanged.emit(this._activeUsers);
      });
      
      console.log('Awareness system initialized successfully');
    } catch (error) {
      console.error('Failed to initialize awareness system:', error);
      throw error;
    }
  }

  /**
   * Set up provider event handlers
   */
  private _setupProviderEventHandlers(): void {
    if (!this._provider) {
      return;
    }
    
    // Handle connection state changes
    this._provider.onConnectionStateChanged.connect((sender, state) => {
      if (state.connected) {
        this._updateConnectionState(CollaborationState.CONNECTED);
      } else {
        this._updateConnectionState(CollaborationState.OFFLINE);
      }
    });
    
    // Handle sync state changes
    this._provider.onSyncStateChanged.connect((sender, syncStatus) => {
      switch (syncStatus.status) {
        case 'syncing':
          this._updateSyncState(SyncState.SYNCING);
          break;
        case 'synced':
          this._updateSyncState(SyncState.SYNCED);
          this._lastSyncTime = Date.now();
          break;
        case 'error':
          this._updateSyncState(SyncState.ERROR);
          break;
        default:
          this._updateSyncState(SyncState.IDLE);
      }
    });
    
    // Handle document changes
    this._provider.onDocumentChanged.connect((sender, event) => {
      if (event.origin !== 'local') {
        this._handleRemoteDocumentChange(event);
      }
    });
  }

  /**
   * Handle remote document changes
   */
  private _handleRemoteDocumentChange(event: any): void {
    if (!this._yNotebook) {
      return;
    }
    
    try {
      // Update local model from Yjs document
      this._syncFromYjs();
      
      // Emit content changed signal
      this._contentChanged.emit();
      
    } catch (error) {
      console.error('Failed to handle remote document change:', error);
    }
  }

  /**
   * Sync local model to Yjs document
   */
  private _syncToYjs(): void {
    if (!this._yNotebook || !this._yjsDocument) {
      return;
    }
    
    try {
      // Convert current state to JSON and sync to Yjs
      const notebookData = this.toJSON();
      this._yNotebook.fromJSON(notebookData);
      
      // Mark as local origin to prevent feedback loops
      this._yjsDocument.transact(() => {
        this._yjsDocument!.getMap('notebook').set('data', this._yNotebook!.toJSON());
      }, 'local');
      
    } catch (error) {
      console.error('Failed to sync to Yjs document:', error);
    }
  }

  /**
   * Sync from Yjs document to local model
   */
  private _syncFromYjs(): void {
    if (!this._yNotebook || !this._yjsDocument) {
      return;
    }
    
    try {
      // Get current state from Yjs document
      const notebookData = this._yjsDocument.getMap('notebook').get('data');
      if (notebookData) {
        this.fromJSON(notebookData);
      }
      
    } catch (error) {
      console.error('Failed to sync from Yjs document:', error);
    }
  }

  /**
   * Sync a cell to Yjs document
   */
  private _syncCellToYjs(cell: ICellModel): void {
    if (!this._yNotebook || !this._yjsDocument) {
      return;
    }
    
    try {
      // Add cell to Yjs document
      this._yjsDocument.transact(() => {
        const cellsArray = this._yNotebook!.cells;
        cellsArray.push([cell.toJSON()]);
      }, 'local');
      
    } catch (error) {
      console.error('Failed to sync cell to Yjs document:', error);
    }
  }

  /**
   * Remove a cell from Yjs document
   */
  private _removeCellFromYjs(cellId: string): void {
    if (!this._yNotebook || !this._yjsDocument) {
      return;
    }
    
    try {
      // Remove cell from Yjs document
      this._yjsDocument.transact(() => {
        const cellsArray = this._yNotebook!.cells;
        const cellIndex = cellsArray.toArray().findIndex((cell: any) => cell.id === cellId);
        if (cellIndex !== -1) {
          cellsArray.delete(cellIndex, 1);
        }
      }, 'local');
      
    } catch (error) {
      console.error('Failed to remove cell from Yjs document:', error);
    }
  }

  /**
   * Sync cell order to Yjs document
   */
  private _syncCellOrderToYjs(): void {
    if (!this._yNotebook || !this._yjsDocument) {
      return;
    }
    
    try {
      // Update cell order in Yjs document
      this._yjsDocument.transact(() => {
        const cellsArray = this._yNotebook!.cells;
        cellsArray.delete(0, cellsArray.length);
        
        // Add cells in new order
        const cellData = this._cells.map(cell => cell.toJSON());
        cellsArray.insert(0, cellData);
      }, 'local');
      
    } catch (error) {
      console.error('Failed to sync cell order to Yjs document:', error);
    }
  }

  /**
   * Update connection state and emit signal
   */
  private _updateConnectionState(state: CollaborationState): void {
    if (this._connectionState !== state) {
      const oldState = this._connectionState;
      this._connectionState = state;
      this._onConnectionStateChanged.emit(state);
      this._stateChanged.emit({ name: 'connectionState', oldValue: oldState, newValue: state });
    }
  }

  /**
   * Update sync state and emit signal
   */
  private _updateSyncState(state: SyncState): void {
    if (this._syncState !== state) {
      const oldState = this._syncState;
      this._syncState = state;
      this._onSyncStateChanged.emit(state);
      this._stateChanged.emit({ name: 'syncState', oldValue: oldState, newValue: state });
    }
  }

  /**
   * Clean up collaboration components
   */
  private _cleanupCollaboration(): void {
    // Dispose of collaboration components
    if (this._provider) {
      this._provider.dispose();
      this._provider = null;
    }
    
    if (this._awareness) {
      this._awareness.dispose();
      this._awareness = null;
    }
    
    if (this._cellLocking) {
      this._cellLocking.dispose();
      this._cellLocking = null;
    }
    
    if (this._permissions) {
      this._permissions.dispose();
      this._permissions = null;
    }
    
    if (this._commentSystem) {
      this._commentSystem.dispose();
      this._commentSystem = null;
    }
    
    // Clean up Yjs components
    if (this._yjsDocument) {
      this._yjsDocument.destroy();
      this._yjsDocument = null;
    }
    
    this._yNotebook = null;
    
    // Reset state
    this._activeUsers = [];
    this._lastSyncTime = 0;
  }
}