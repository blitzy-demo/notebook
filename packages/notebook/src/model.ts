/**
 * @fileoverview Enhanced notebook model with Yjs CRDT integration for collaborative editing
 * 
 * This module provides comprehensive real-time collaborative editing capabilities for
 * Jupyter Notebook v7 using the Yjs CRDT framework. It enables multiple users to
 * simultaneously work on the same notebook with live updates, presence awareness,
 * and conflict resolution while maintaining application performance and stability.
 * 
 * Key features:
 * - Real-time collaborative editing using Yjs CRDT framework
 * - WebSocket provider for collaboration backend connection
 * - User presence awareness with cursor tracking
 * - Cell-level locking mechanism for conflict prevention
 * - Change history tracking and versioning
 * - Permission-based access control
 * - Cell-level comment and review system
 * - Offline editing with automatic resynchronization
 * - Performance optimization with batching and compression
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { Doc } from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Awareness } from 'y-protocols/awareness';
import { INotebookModel } from '@jupyterlab/notebook';
import { ICellModel } from '@jupyterlab/cells';
import { ISignal, Signal } from '@lumino/signaling';
import { DisposableSet } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';

import { AwarenessService } from './collab/awareness';
import { LockService } from './collab/locks';
import { HistoryService } from './collab/history';
import { CommentService } from './collab/comments';
import { PermissionService } from './collab/permissions';
import { IYjsNotebookProvider } from './tokens';

/**
 * Enumeration of document change types for collaborative editing
 */
export enum DocumentChangeType {
  /** Cell was added to the notebook */
  CELL_ADDED = 'cell_added',
  /** Cell was removed from the notebook */
  CELL_REMOVED = 'cell_removed',
  /** Cell was moved to a different position */
  CELL_MOVED = 'cell_moved',
  /** Cell content was edited */
  CELL_EDITED = 'cell_edited',
  /** Cell was executed */
  CELL_EXECUTED = 'cell_executed',
  /** Notebook or cell metadata was changed */
  METADATA_CHANGED = 'metadata_changed',
  /** Notebook was saved */
  NOTEBOOK_SAVED = 'notebook_saved',
  /** Collaborative synchronization event */
  COLLABORATIVE_SYNC = 'collaborative_sync'
}

/**
 * Interface representing a collaborative document change
 */
export interface CollaborativeDocumentChange {
  /** Type of change that occurred */
  type: DocumentChangeType;
  /** ID of the cell involved in the change (if applicable) */
  cellId?: string;
  /** Details of the change */
  change: any;
  /** Information about the user who made the change */
  user: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Timestamp when the change occurred */
  timestamp: Date;
  /** Version number for this change */
  version: number;
  /** Additional metadata for the change */
  metadata?: Record<string, any>;
}

/**
 * Interface representing the collaborative state of the notebook
 */
export interface CollaborativeState {
  /** Whether the notebook is connected to the collaboration backend */
  isConnected: boolean;
  /** List of active collaborators */
  activeCollaborators: Array<{
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
    lastSeen: Date;
  }>;
  /** Unique identifier for the collaborative session */
  sessionId: string;
  /** Current document version */
  documentVersion: number;
  /** Timestamp of last synchronization */
  lastSync: Date;
  /** Whether the document is in read-only mode */
  isReadOnly: boolean;
  /** Current lock states for cells */
  lockStates: Record<string, {
    userId: string;
    userName: string;
    lockedAt: Date;
    timeout: number;
  }>;
  /** Current conflict states */
  conflictStates: Record<string, {
    type: string;
    users: string[];
    timestamp: Date;
  }>;
}

/**
 * Interface for YjsNotebookProvider options
 */
export interface YjsNotebookProviderOptions {
  /** WebSocket URL for real-time collaboration */
  websocketUrl: string;
  /** Room name for the collaborative session */
  roomName: string;
  /** Current user information */
  userInfo: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Awareness service instance */
  awarenessService?: AwarenessService;
  /** Lock service instance */
  lockService?: LockService;
  /** History service instance */
  historyService?: HistoryService;
  /** Comment service instance */
  commentService?: CommentService;
  /** Permission service instance */
  permissionService?: PermissionService;
  /** Whether to enable client-side persistence */
  enablePersistence?: boolean;
  /** Whether to enable awareness features */
  enableAwareness?: boolean;
  /** Whether to enable cell locking */
  enableLocking?: boolean;
  /** Whether to enable history tracking */
  enableHistory?: boolean;
  /** Whether to enable comment system */
  enableComments?: boolean;
}

/**
 * Main YjsNotebookProvider class that wraps notebook model with Yjs document functionality
 * 
 * This class provides the core collaborative editing capabilities by integrating
 * a Yjs document with the notebook model, enabling real-time synchronization,
 * conflict resolution, and collaborative features.
 */
export class YjsNotebookProvider implements IYjsNotebookProvider {
  private _doc: Doc;
  private _awareness: Awareness;
  private _websocketProvider: WebsocketProvider | null = null;
  private _indexeddbProvider: IndexeddbPersistence | null = null;
  private _notebookModel: INotebookModel | null = null;
  private _disposables: DisposableSet = new DisposableSet();
  private _isConnected: boolean = false;
  private _isDisposed: boolean = false;
  private _sessionId: string;
  private _documentVersion: number = 0;
  private _lastSync: Date = new Date();
  
  // Collaborative services
  private _awarenessService: AwarenessService | null = null;
  private _lockService: LockService | null = null;
  private _historyService: HistoryService | null = null;
  private _commentService: CommentService | null = null;
  private _permissionService: PermissionService | null = null;
  
  // Signals for events
  private _documentChangeSignal = new Signal<IYjsNotebookProvider, {
    type: string;
    cellId?: string;
    changes: any;
  }>(this);
  private _awarenessChangeSignal = new Signal<IYjsNotebookProvider, {
    users: Array<{userId: string; name: string; cursor?: any}>;
  }>(this);
  private _connectionChangeSignal = new Signal<YjsNotebookProvider, boolean>(this);
  
  /**
   * Create a new YjsNotebookProvider instance
   * 
   * @param options - Configuration options for the provider
   */
  constructor(options: YjsNotebookProviderOptions) {
    this._sessionId = UUID.uuid4();
    this._doc = new Doc();
    this._awareness = new Awareness(this._doc);
    
    // Initialize Yjs document structure
    this._initializeDocumentStructure();
    
    // Set up WebSocket provider for real-time collaboration
    if (options.websocketUrl && options.roomName) {
      this._websocketProvider = new WebsocketProvider(
        options.websocketUrl,
        options.roomName,
        this._doc,
        {
          awareness: this._awareness,
          connect: false // We'll connect manually
        }
      );
      
      this._setupWebSocketEventHandlers();
    }
    
    // Set up IndexedDB persistence if enabled
    if (options.enablePersistence !== false) {
      this._indexeddbProvider = new IndexeddbPersistence(
        options.roomName,
        this._doc
      );
      
      this._setupIndexedDBEventHandlers();
    }
    
    // Initialize collaborative services
    this._initializeServices(options);
    
    // Set up document change tracking
    this._setupDocumentChangeTracking();
    
    // Set up awareness change tracking
    this._setupAwarenessChangeTracking();
  }
  
  /**
   * The Yjs document instance
   */
  get doc(): Doc {
    return this._doc;
  }
  
  /**
   * The awareness instance for user presence tracking
   */
  get awareness(): Awareness {
    return this._awareness;
  }
  
  /**
   * Whether the provider is currently connected to the collaboration backend
   */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * The last synchronization timestamp
   */
  get lastSync(): Date {
    return this._lastSync;
  }
  
  /**
   * Signal emitted when the document changes
   */
  get onDocumentChange(): ISignal<IYjsNotebookProvider, {
    type: string;
    cellId?: string;
    changes: any;
  }> {
    return this._documentChangeSignal;
  }
  
  /**
   * Signal emitted when awareness information changes
   */
  get onAwarenessChange(): ISignal<IYjsNotebookProvider, {
    users: Array<{userId: string; name: string; cursor?: any}>;
  }> {
    return this._awarenessChangeSignal;
  }
  
  /**
   * Connect to the collaboration backend
   * 
   * @returns Promise that resolves when connection is established
   */
  async connect(): Promise<void> {
    if (this._isDisposed) {
      throw new Error('Cannot connect disposed provider');
    }
    
    if (this._isConnected) {
      return;
    }
    
    try {
      // Connect WebSocket provider
      if (this._websocketProvider) {
        this._websocketProvider.connect();
        
        // Wait for connection to be established
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
          }, 10000); // 10 second timeout
          
          const onConnect = () => {
            clearTimeout(timeout);
            this._websocketProvider?.off('status', onConnect);
            resolve();
          };
          
          this._websocketProvider?.on('status', onConnect);
        });
      }
      
      // Wait for IndexedDB to be ready
      if (this._indexeddbProvider) {
        await new Promise<void>((resolve) => {
          if (this._indexeddbProvider!.synced) {
            resolve();
          } else {
            this._indexeddbProvider!.on('synced', resolve);
          }
        });
      }
      
      this._isConnected = true;
      this._lastSync = new Date();
      this._connectionChangeSignal.emit(true);
      
      // Initialize services after connection
      await this._initializeServicesAfterConnection();
      
    } catch (error) {
      console.error('Failed to connect to collaboration backend:', error);
      throw error;
    }
  }
  
  /**
   * Disconnect from the collaboration backend
   * 
   * @returns Promise that resolves when disconnection is complete
   */
  async disconnect(): Promise<void> {
    if (!this._isConnected) {
      return;
    }
    
    try {
      // Disconnect WebSocket provider
      if (this._websocketProvider) {
        this._websocketProvider.disconnect();
      }
      
      // Destroy IndexedDB provider
      if (this._indexeddbProvider) {
        this._indexeddbProvider.destroy();
      }
      
      this._isConnected = false;
      this._connectionChangeSignal.emit(false);
      
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  }
  
  /**
   * Get the underlying notebook model
   * 
   * @returns The notebook model instance
   */
  getNotebookModel(): INotebookModel | null {
    return this._notebookModel;
  }
  
  /**
   * Set the notebook model to be synchronized with Yjs
   * 
   * @param model - The notebook model to synchronize
   */
  setNotebookModel(model: INotebookModel): void {
    if (this._notebookModel) {
      // Disconnect from previous model
      this._disconnectFromNotebookModel();
    }
    
    this._notebookModel = model;
    
    if (model) {
      // Connect to new model
      this._connectToNotebookModel();
    }
  }
  
  /**
   * Synchronize the notebook model with the Yjs document
   * 
   * @returns Promise that resolves when synchronization is complete
   */
  async syncWithYjs(): Promise<void> {
    if (!this._notebookModel) {
      throw new Error('No notebook model set');
    }
    
    const cells = this._doc.getArray('cells');
    const metadata = this._doc.getMap('metadata');
    
    // Synchronize cells
    this._doc.transact(() => {
      // Clear existing cells
      cells.delete(0, cells.length);
      
      // Add all cells from the model
      for (let i = 0; i < this._notebookModel!.cells.length; i++) {
        const cell = this._notebookModel!.cells.get(i);
        const cellData = this._serializeCellModel(cell);
        cells.insert(i, [cellData]);
      }
      
      // Synchronize metadata
      metadata.clear();
      const nbMetadata = this._notebookModel!.metadata;
      Object.keys(nbMetadata).forEach(key => {
        metadata.set(key, nbMetadata[key]);
      });
    });
    
    this._documentVersion++;
    this._lastSync = new Date();
    
    // Emit document change event
    this._documentChangeSignal.emit({
      type: DocumentChangeType.COLLABORATIVE_SYNC,
      cellId: undefined,
      changes: {
        cellCount: this._notebookModel!.cells.length,
        metadata: this._notebookModel!.metadata,
        operation: 'full_sync'
      }
    });
  }
  
  /**
   * Check if the service is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  
  /**
   * Dispose of the provider and cleanup resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    this._isDisposed = true;
    
    // Disconnect from collaboration backend
    this.disconnect().catch(console.error);
    
    // Dispose of services
    this._awarenessService?.dispose();
    this._lockService?.dispose();
    this._historyService?.dispose();
    this._commentService?.dispose();
    this._permissionService?.dispose();
    
    // Dispose of providers
    this._websocketProvider?.destroy();
    this._indexeddbProvider?.destroy();
    
    // Dispose of document and awareness
    this._doc.destroy();
    this._awareness.destroy();
    
    // Dispose of all disposables
    this._disposables.dispose();
  }
  
  /**
   * Initialize the Yjs document structure
   */
  private _initializeDocumentStructure(): void {
    // Create shared arrays and maps for notebook content
    this._doc.getArray('cells'); // Array of cell data
    this._doc.getMap('metadata'); // Notebook metadata
    this._doc.getMap('locks'); // Cell locks
    this._doc.getMap('comments'); // Cell comments
    this._doc.getMap('permissions'); // User permissions
    this._doc.getArray('history'); // Change history
  }
  
  /**
   * Set up WebSocket event handlers
   */
  private _setupWebSocketEventHandlers(): void {
    if (!this._websocketProvider) {
      return;
    }
    
    this._websocketProvider.on('status', (event: any) => {
      const wasConnected = this._isConnected;
      this._isConnected = event.status === 'connected';
      
      if (wasConnected !== this._isConnected) {
        this._connectionChangeSignal.emit(this._isConnected);
      }
    });
    
    this._websocketProvider.on('connection-error', (error: any) => {
      console.error('WebSocket connection error:', error);
    });
    
    this._websocketProvider.on('connection-close', (event: any) => {
      console.log('WebSocket connection closed:', event);
    });
  }
  
  /**
   * Set up IndexedDB event handlers
   */
  private _setupIndexedDBEventHandlers(): void {
    if (!this._indexeddbProvider) {
      return;
    }
    
    this._indexeddbProvider.on('synced', () => {
      console.log('IndexedDB synchronized');
    });
    
    this._indexeddbProvider.on('error', (error: any) => {
      console.error('IndexedDB error:', error);
    });
  }
  
  /**
   * Initialize collaborative services
   */
  private _initializeServices(options: YjsNotebookProviderOptions): void {
    // Initialize awareness service
    if (options.enableAwareness !== false) {
      this._awarenessService = options.awarenessService || 
        new AwarenessService(this._doc, {
          identity: {
            username: options.userInfo.id,
            name: options.userInfo.name,
            avatar_url: options.userInfo.avatar
          }
        } as any);
    }
    
    // Initialize permission service
    this._permissionService = options.permissionService || 
      new PermissionService(this._doc, this._sessionId, this._awarenessService!);
    
    // Initialize lock service
    if (options.enableLocking !== false && this._awarenessService && this._permissionService) {
      this._lockService = options.lockService || 
        new LockService(this._doc, this._awarenessService, this._permissionService);
    }
    
    // Initialize history service
    if (options.enableHistory !== false && this._awarenessService && this._permissionService) {
      this._historyService = options.historyService || 
        new HistoryService(this, this._awarenessService, this._permissionService);
    }
    
    // Initialize comment service
    if (options.enableComments !== false && this._awarenessService && this._permissionService) {
      this._commentService = options.commentService || 
        new CommentService(this._doc, this._awarenessService, this._permissionService);
    }
  }
  
  /**
   * Initialize services after connection is established
   */
  private async _initializeServicesAfterConnection(): Promise<void> {
    // Initialize all services
    const initPromises: Promise<void>[] = [];
    
    if (this._awarenessService) {
      initPromises.push(this._awarenessService.initialize());
    }
    
    if (this._permissionService) {
      initPromises.push(this._permissionService.initialize());
    }
    
    if (this._lockService) {
      initPromises.push(this._lockService.initialize());
    }
    
    if (this._historyService) {
      initPromises.push(this._historyService.initialize());
    }
    
    if (this._commentService) {
      initPromises.push(this._commentService.initialize());
    }
    
    await Promise.all(initPromises);
  }
  
  /**
   * Set up document change tracking
   */
  private _setupDocumentChangeTracking(): void {
    this._doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin === 'local') {
        return; // Skip local updates
      }
      
      this._documentVersion++;
      this._lastSync = new Date();
      
      // Emit document change event
      this._documentChangeSignal.emit({
        type: DocumentChangeType.COLLABORATIVE_SYNC,
        cellId: undefined,
        changes: {
          update: update,
          origin: origin,
          updateSize: update.length
        }
      });
    });
  }
  
  /**
   * Set up awareness change tracking
   */
  private _setupAwarenessChangeTracking(): void {
    this._awareness.on('change', (changes: any) => {
      const users = Array.from(this._awareness.getStates().entries()).map(([clientId, state]) => ({
        userId: state.user?.id || clientId.toString(),
        name: state.user?.name || 'Anonymous',
        cursor: state.cursor
      }));
      
      this._awarenessChangeSignal.emit({ users });
    });
  }
  
  /**
   * Connect to notebook model events
   */
  private _connectToNotebookModel(): void {
    if (!this._notebookModel) {
      return;
    }
    
    // Listen for cell changes
    this._notebookModel.cells.changed.connect(this._onCellsChanged, this);
    
    // Listen for metadata changes
    if (this._notebookModel.metadata && (this._notebookModel.metadata as any).changed) {
      (this._notebookModel.metadata as any).changed.connect(this._onMetadataChanged, this);
    }
    
    // Listen for content changes
    this._notebookModel.contentChanged.connect(this._onContentChanged, this);
  }
  
  /**
   * Disconnect from notebook model events
   */
  private _disconnectFromNotebookModel(): void {
    if (!this._notebookModel) {
      return;
    }
    
    this._notebookModel.cells.changed.disconnect(this._onCellsChanged, this);
    if (this._notebookModel.metadata && (this._notebookModel.metadata as any).changed) {
      (this._notebookModel.metadata as any).changed.disconnect(this._onMetadataChanged, this);
    }
    this._notebookModel.contentChanged.disconnect(this._onContentChanged, this);
  }
  
  /**
   * Handle cell changes in the notebook model
   */
  private _onCellsChanged(sender: any, args: any): void {
    const cells = this._doc.getArray('cells');
    
    this._doc.transact(() => {
      switch (args.type) {
        case 'add':
          for (let i = 0; i < args.newValues.length; i++) {
            const cell = args.newValues[i];
            const cellData = this._serializeCellModel(cell);
            cells.insert(args.newIndex + i, [cellData]);
          }
          break;
        
        case 'remove':
          cells.delete(args.oldIndex, args.oldValues.length);
          break;
        
        case 'move':
          const cellData = cells.get(args.oldIndex);
          cells.delete(args.oldIndex, 1);
          cells.insert(args.newIndex, [cellData]);
          break;
        
        case 'set':
          for (let i = 0; i < args.newValues.length; i++) {
            const cell = args.newValues[i];
            const cellData = this._serializeCellModel(cell);
            cells.delete(args.oldIndex + i, 1);
            cells.insert(args.oldIndex + i, [cellData]);
          }
          break;
      }
    });
    
    this._documentVersion++;
    this._lastSync = new Date();
  }
  
  /**
   * Handle metadata changes in the notebook model
   */
  private _onMetadataChanged(sender: any, args: any): void {
    const metadata = this._doc.getMap('metadata');
    
    this._doc.transact(() => {
      Object.keys(args.newValue).forEach(key => {
        metadata.set(key, args.newValue[key]);
      });
    });
    
    this._documentVersion++;
    this._lastSync = new Date();
  }
  
  /**
   * Handle content changes in the notebook model
   */
  private _onContentChanged(sender: any, args: any): void {
    // Sync with Yjs document
    this.syncWithYjs().catch(console.error);
  }
  
  /**
   * Serialize a cell model to data that can be stored in Yjs
   */
  private _serializeCellModel(cell: ICellModel): any {
    return {
      id: cell.id,
      type: cell.type,
      source: (cell as any).source || '',
      metadata: cell.metadata,
      trusted: cell.trusted,
      // Add execution count for code cells
      executionCount: (cell as any).executionCount || null,
      // Add outputs for code cells
      outputs: (cell as any).outputs ? (cell as any).outputs.toJSON() : null
    };
  }

}

/**
 * Collaborative notebook model that extends standard notebook functionality
 * 
 * This class provides the collaborative features on top of the base notebook model,
 * including user presence, cell locking, comments, and history tracking.
 */
export class CollaborativeNotebookModel {
  private _yjsProvider: YjsNotebookProvider;
  private _isDisposed: boolean = false;
  
  // Signals for collaborative events
  private _collaboratorJoinedSignal = new Signal<CollaborativeNotebookModel, {
    userId: string;
    name: string;
    role: string;
  }>(this);
  
  private _collaboratorLeftSignal = new Signal<CollaborativeNotebookModel, {
    userId: string;
    name: string;
  }>(this);
  
  private _cellLockedSignal = new Signal<CollaborativeNotebookModel, {
    cellId: string;
    userId: string;
    userName: string;
  }>(this);
  
  private _cellUnlockedSignal = new Signal<CollaborativeNotebookModel, {
    cellId: string;
    userId: string;
    userName: string;
  }>(this);
  
  private _commentAddedSignal = new Signal<CollaborativeNotebookModel, {
    cellId: string;
    commentId: string;
    content: string;
    author: {userId: string; name: string};
  }>(this);
  
  /**
   * Create a new collaborative notebook model
   * 
   * @param yjsProvider - The Yjs provider for collaborative features
   */
  constructor(yjsProvider: YjsNotebookProvider) {
    this._yjsProvider = yjsProvider;
    this._setupEventHandlers();
  }
  
  /**
   * Check if the notebook is in collaborative mode
   */
  get isCollaborative(): boolean {
    return this._yjsProvider.isConnected;
  }
  
  /**
   * Get list of current collaborators
   */
  getCollaborators(): Array<{
    userId: string;
    name: string;
    role: 'view' | 'edit' | 'admin';
    isActive: boolean;
  }> {
    const users = this._yjsProvider.awareness.getStates();
    const collaborators: Array<{
      userId: string;
      name: string;
      role: 'view' | 'edit' | 'admin';
      isActive: boolean;
    }> = [];
    
    users.forEach((state, clientId) => {
      if (state.user) {
        collaborators.push({
          userId: state.user.id,
          name: state.user.name,
          role: state.user.role || 'edit',
          isActive: state.user.isActive !== false
        });
      }
    });
    
    return collaborators;
  }
  
  /**
   * Get the Yjs provider for this notebook
   */
  getYjsProvider(): YjsNotebookProvider {
    return this._yjsProvider;
  }
  
  /**
   * Lock a cell for exclusive editing
   */
  async lockCell(cellId: string): Promise<boolean> {
    const lockService = (this._yjsProvider as any)._lockService;
    if (!lockService) {
      return false;
    }
    
    return await lockService.lockCell(cellId);
  }
  
  /**
   * Unlock a cell
   */
  async unlockCell(cellId: string): Promise<void> {
    const lockService = (this._yjsProvider as any)._lockService;
    if (!lockService) {
      return;
    }
    
    await lockService.unlockCell(cellId);
  }
  
  /**
   * Add a comment to a cell
   */
  async addComment(cellId: string, content: string): Promise<{
    id: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
  }> {
    const commentService = (this._yjsProvider as any)._commentService;
    if (!commentService) {
      throw new Error('Comment service not available');
    }
    
    return await commentService.addComment(cellId, content);
  }
  
  /**
   * Get comments for a cell
   */
  async getComments(cellId: string): Promise<Array<{
    id: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    isResolved: boolean;
  }>> {
    const commentService = (this._yjsProvider as any)._commentService;
    if (!commentService) {
      return [];
    }
    
    return await commentService.getCommentsByCell(cellId);
  }
  
  /**
   * Get change history for the notebook
   */
  async getHistory(limit: number = 50): Promise<Array<{
    id: string;
    type: string;
    cellId: string;
    userId: string;
    userName: string;
    timestamp: Date;
    description: string;
  }>> {
    const historyService = (this._yjsProvider as any)._historyService;
    if (!historyService) {
      return [];
    }
    
    return await historyService.getRecentActivity(limit);
  }
  
  /**
   * Signal emitted when a collaborator joins
   */
  get onCollaboratorJoined(): ISignal<CollaborativeNotebookModel, {
    userId: string;
    name: string;
    role: string;
  }> {
    return this._collaboratorJoinedSignal;
  }
  
  /**
   * Signal emitted when a collaborator leaves
   */
  get onCollaboratorLeft(): ISignal<CollaborativeNotebookModel, {
    userId: string;
    name: string;
  }> {
    return this._collaboratorLeftSignal;
  }
  
  /**
   * Signal emitted when a cell is locked
   */
  get onCellLocked(): ISignal<CollaborativeNotebookModel, {
    cellId: string;
    userId: string;
    userName: string;
  }> {
    return this._cellLockedSignal;
  }
  
  /**
   * Signal emitted when a cell is unlocked
   */
  get onCellUnlocked(): ISignal<CollaborativeNotebookModel, {
    cellId: string;
    userId: string;
    userName: string;
  }> {
    return this._cellUnlockedSignal;
  }
  
  /**
   * Signal emitted when a comment is added
   */
  get onCommentAdded(): ISignal<CollaborativeNotebookModel, {
    cellId: string;
    commentId: string;
    content: string;
    author: {userId: string; name: string};
  }> {
    return this._commentAddedSignal;
  }
  
  /**
   * Check if the model is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  
  /**
   * Dispose of the collaborative notebook model
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    this._isDisposed = true;
    
    // The YjsProvider is disposed separately
    // We just clean up our event handlers here
  }
  
  /**
   * Set up event handlers for collaborative features
   */
  private _setupEventHandlers(): void {
    // Listen for awareness changes to track collaborators
    this._yjsProvider.onAwarenessChange.connect(this._onAwarenessChange, this);
    
    // Listen for lock changes
    const lockService = (this._yjsProvider as any)._lockService;
    if (lockService) {
      lockService.onLockChange.connect(this._onLockChange, this);
    }
    
    // Listen for comment changes
    const commentService = (this._yjsProvider as any)._commentService;
    if (commentService) {
      commentService.onNewComment.connect(this._onCommentAdded, this);
    }
  }
  
  /**
   * Handle awareness changes
   */
  private _onAwarenessChange(sender: IYjsNotebookProvider, args: {
    users: Array<{userId: string; name: string; cursor?: any}>;
  }): void {
    // Track collaborator join/leave events
    // This is a simplified implementation
    args.users.forEach(user => {
      this._collaboratorJoinedSignal.emit({
        userId: user.userId,
        name: user.name,
        role: 'edit' // Default role
      });
    });
  }
  
  /**
   * Handle lock changes
   */
  private _onLockChange(sender: any, args: {
    cellId: string;
    isLocked: boolean;
    owner?: {userId: string; name: string};
  }): void {
    if (args.isLocked && args.owner) {
      this._cellLockedSignal.emit({
        cellId: args.cellId,
        userId: args.owner.userId,
        userName: args.owner.name
      });
    } else {
      this._cellUnlockedSignal.emit({
        cellId: args.cellId,
        userId: args.owner?.userId || 'unknown',
        userName: args.owner?.name || 'Unknown'
      });
    }
  }
  
  /**
   * Handle comment additions
   */
  private _onCommentAdded(sender: any, args: {
    id: string;
    cellId: string;
    content: string;
    author: {userId: string; name: string};
  }): void {
    this._commentAddedSignal.emit({
      cellId: args.cellId,
      commentId: args.id,
      content: args.content,
      author: args.author
    });
  }
}

/**
 * Factory function to create a new YjsNotebookProvider instance
 * 
 * @param options - Configuration options for the provider
 * @returns A new YjsNotebookProvider instance
 */
export function createYjsNotebookProvider(options: YjsNotebookProviderOptions): YjsNotebookProvider {
  return new YjsNotebookProvider(options);
}