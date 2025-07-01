// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { IObservableJSON, IModelDB } from '@jupyterlab/observables';
import { INotebookModel, NotebookModel } from '@jupyterlab/notebook';
import { ICellModel, ICodeCellModel, IMarkdownCellModel, CodeCellModel, MarkdownCellModel } from '@jupyterlab/cells';
import { nbformat } from '@jupyterlab/nbformat';
import { IChangedArgs } from '@jupyterlab/coreutils';
import { ICollaborator } from '@jupyterlab/docregistry';

import { ISignal, Signal } from '@lumino/signaling';

// Yjs imports for CRDT functionality
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';

/**
 * Interface for Yjs Notebook Provider that integrates with collaborative editing
 */
export interface IYjsNotebookProvider {
  /**
   * The Yjs document for collaborative editing
   */
  readonly yjsDocument: Y.Doc;

  /**
   * The WebSocket provider for real-time synchronization
   */
  readonly websocketProvider: WebsocketProvider | null;

  /**
   * The awareness instance for presence tracking
   */
  readonly awareness: Awareness | null;

  /**
   * Whether the provider is connected to the collaboration server
   */
  readonly isConnected: boolean;

  /**
   * Connect to the collaboration server
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the collaboration server
   */
  disconnect(): void;

  /**
   * Signal emitted when the connection status changes
   */
  readonly statusChanged: ISignal<this, string>;

  /**
   * Signal emitted when the document is updated
   */
  readonly documentChanged: ISignal<this, Y.YEvent<any>[]>;

  /**
   * Apply local changes to the Yjs document
   */
  applyLocalChange(change: ICollaborativeChange): void;

  /**
   * Get the current document state as notebook JSON
   */
  getDocumentState(): nbformat.INotebookContent;

  /**
   * Update the provider with new notebook content
   */
  updateDocument(content: nbformat.INotebookContent): void;
}

/**
 * Interface for collaborative changes
 */
export interface ICollaborativeChange {
  /**
   * The type of change
   */
  type: 'cell-insert' | 'cell-delete' | 'cell-modify' | 'metadata-change';

  /**
   * The cell ID (if applicable)
   */
  cellId?: string;

  /**
   * The index for insertions/deletions
   */
  index?: number;

  /**
   * The content of the change
   */
  content?: any;

  /**
   * User information for the change
   */
  user?: {
    id: string;
    name: string;
    color: string;
  };

  /**
   * Timestamp of the change
   */
  timestamp: Date;
}

/**
 * Interface for awareness information
 */
export interface IUserPresence {
  /**
   * Unique user identifier
   */
  userId: string;

  /**
   * Display name of the user
   */
  displayName: string;

  /**
   * User email address
   */
  email?: string;

  /**
   * User color for identification
   */
  color: string;

  /**
   * Current cell being edited
   */
  currentCellId?: string;

  /**
   * Cursor position within the cell
   */
  cursorPosition?: {
    line: number;
    column: number;
  };

  /**
   * Selection range within the cell
   */
  selection?: {
    anchor: { line: number; column: number };
    head: { line: number; column: number };
  };

  /**
   * Last activity timestamp
   */
  lastActivity: Date;
}

/**
 * Options for creating a collaborative notebook model
 */
export interface ICollaborativeNotebookModelOptions {
  /**
   * The WebSocket URL for collaboration
   */
  collaborationUrl?: string;

  /**
   * The document name/room for collaboration
   */
  documentName?: string;

  /**
   * User information for presence tracking
   */
  user?: {
    id: string;
    name: string;
    email?: string;
  };

  /**
   * Whether to enable collaborative editing by default
   */
  enableCollaboration?: boolean;

  /**
   * Timeout for connection attempts (in milliseconds)
   */
  connectionTimeout?: number;

  /**
   * Auto-reconnect on connection loss
   */
  autoReconnect?: boolean;
}

/**
 * Enhanced notebook model with Yjs CRDT integration for real-time collaborative editing
 */
export class CollaborativeNotebookModel extends NotebookModel implements INotebookModel {
  private _yjsProvider: IYjsNotebookProvider | null = null;
  private _collaborationOptions: ICollaborativeNotebookModelOptions;
  private _isCollaborationEnabled = false;
  private _collaborationReady = false;
  private _syncInProgress = false;
  private _pendingChanges: ICollaborativeChange[] = [];
  private _activeUsers = new Map<string, IUserPresence>();
  private _currentUser: IUserPresence | null = null;
  
  // Additional signals for collaboration
  private _collaborationStatusChanged = new Signal<this, string>(this);
  private _usersChanged = new Signal<this, IUserPresence[]>(this);
  private _remoteChangeApplied = new Signal<this, ICollaborativeChange>(this);
  private _conflictDetected = new Signal<this, { local: ICollaborativeChange; remote: ICollaborativeChange }>(this);

  /**
   * Construct a new collaborative notebook model
   */
  constructor(options: ICollaborativeNotebookModelOptions = {}) {
    super();
    
    this._collaborationOptions = {
      enableCollaboration: false,
      connectionTimeout: 5000,
      autoReconnect: true,
      ...options
    };

    this._setupCurrentUser();
    this._setupChangeTracking();

    if (this._collaborationOptions.enableCollaboration) {
      this.enableCollaboration();
    }
  }

  /**
   * Signal emitted when collaboration status changes
   */
  get collaborationStatusChanged(): ISignal<this, string> {
    return this._collaborationStatusChanged;
  }

  /**
   * Signal emitted when active users change
   */
  get usersChanged(): ISignal<this, IUserPresence[]> {
    return this._usersChanged;
  }

  /**
   * Signal emitted when a remote change is applied
   */
  get remoteChangeApplied(): ISignal<this, ICollaborativeChange> {
    return this._remoteChangeApplied;
  }

  /**
   * Signal emitted when a conflict is detected
   */
  get conflictDetected(): ISignal<this, { local: ICollaborativeChange; remote: ICollaborativeChange }> {
    return this._conflictDetected;
  }

  /**
   * Whether collaboration is currently enabled
   */
  get isCollaborationEnabled(): boolean {
    return this._isCollaborationEnabled;
  }

  /**
   * Whether the collaboration provider is ready
   */
  get isCollaborationReady(): boolean {
    return this._collaborationReady;
  }

  /**
   * The current collaboration provider
   */
  get collaborationProvider(): IYjsNotebookProvider | null {
    return this._yjsProvider;
  }

  /**
   * The active collaborative users
   */
  get activeUsers(): IUserPresence[] {
    return Array.from(this._activeUsers.values());
  }

  /**
   * The current user information
   */
  get currentUser(): IUserPresence | null {
    return this._currentUser;
  }

  /**
   * Enable collaborative editing
   */
  async enableCollaboration(): Promise<void> {
    if (this._isCollaborationEnabled) {
      return;
    }

    try {
      this._isCollaborationEnabled = true;
      this._collaborationStatusChanged.emit('enabling');

      // Create or get Yjs provider
      if (!this._yjsProvider) {
        this._yjsProvider = await this._createYjsProvider();
      }

      // Connect to collaboration server
      await this._yjsProvider.connect();
      
      // Setup bidirectional synchronization
      this._setupBidirectionalSync();
      
      this._collaborationReady = true;
      this._collaborationStatusChanged.emit('enabled');

      // Apply any pending changes
      this._applyPendingChanges();

    } catch (error) {
      console.error('Failed to enable collaboration:', error);
      this._isCollaborationEnabled = false;
      this._collaborationStatusChanged.emit('error');
      throw error;
    }
  }

  /**
   * Disable collaborative editing
   */
  async disableCollaboration(): Promise<void> {
    if (!this._isCollaborationEnabled) {
      return;
    }

    try {
      this._collaborationStatusChanged.emit('disabling');

      if (this._yjsProvider) {
        this._yjsProvider.disconnect();
      }

      this._isCollaborationEnabled = false;
      this._collaborationReady = false;
      this._activeUsers.clear();
      
      this._collaborationStatusChanged.emit('disabled');
      this._usersChanged.emit([]);

    } catch (error) {
      console.error('Failed to disable collaboration:', error);
      this._collaborationStatusChanged.emit('error');
      throw error;
    }
  }

  /**
   * Update user presence information
   */
  updateUserPresence(cellId?: string, cursorPosition?: { line: number; column: number }): void {
    if (!this._currentUser || !this._yjsProvider?.awareness) {
      return;
    }

    const updatedUser: IUserPresence = {
      ...this._currentUser,
      currentCellId: cellId,
      cursorPosition,
      lastActivity: new Date()
    };

    this._currentUser = updatedUser;
    
    // Update awareness state
    this._yjsProvider.awareness.setLocalStateField('user', updatedUser);
  }

  /**
   * Get the notebook content as standard IPYNB format
   */
  toJSON(): nbformat.INotebookContent {
    if (this._yjsProvider && this._isCollaborationEnabled) {
      // Get the collaborative document state
      return this._yjsProvider.getDocumentState();
    }
    
    // Fall back to standard model serialization
    return super.toJSON();
  }

  /**
   * Load notebook content from IPYNB format
   */
  fromJSON(value: nbformat.INotebookContent): void {
    if (this._yjsProvider && this._isCollaborationEnabled) {
      // Update the collaborative document
      this._yjsProvider.updateDocument(value);
    } else {
      // Standard model loading
      super.fromJSON(value);
    }
  }

  /**
   * Dispose of the model resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    // Disconnect collaboration before disposing
    if (this._isCollaborationEnabled) {
      this.disableCollaboration().catch(error => {
        console.error('Error during collaboration cleanup:', error);
      });
    }

    super.dispose();
  }

  /**
   * Setup current user information
   */
  private _setupCurrentUser(): void {
    const options = this._collaborationOptions;
    
    if (options.user) {
      this._currentUser = {
        userId: options.user.id,
        displayName: options.user.name,
        email: options.user.email,
        color: this._generateUserColor(options.user.id),
        lastActivity: new Date()
      };
    } else {
      // Generate a temporary user ID if none provided
      const tempUserId = `user-${Math.random().toString(36).substr(2, 9)}`;
      this._currentUser = {
        userId: tempUserId,
        displayName: 'Anonymous User',
        color: this._generateUserColor(tempUserId),
        lastActivity: new Date()
      };
    }
  }

  /**
   * Setup change tracking for collaborative features
   */
  private _setupChangeTracking(): void {
    // Track cell changes
    this.cells.changed.connect((sender, args) => {
      if (this._syncInProgress) {
        return; // Don't track changes during sync
      }

      const change = this._createChangeFromCellArgs(args);
      if (change) {
        this._handleLocalChange(change);
      }
    });

    // Track metadata changes
    this.metadata.changed.connect((sender, args) => {
      if (this._syncInProgress) {
        return;
      }

      const change: ICollaborativeChange = {
        type: 'metadata-change',
        content: args,
        user: this._currentUser || undefined,
        timestamp: new Date()
      };

      this._handleLocalChange(change);
    });
  }

  /**
   * Create Yjs provider for collaboration
   */
  private async _createYjsProvider(): Promise<IYjsNotebookProvider> {
    // This is a simplified implementation - in reality, this would be injected
    const yjsDoc = new Y.Doc();
    
    let websocketProvider: WebsocketProvider | null = null;
    let awareness: Awareness | null = null;

    if (this._collaborationOptions.collaborationUrl && this._collaborationOptions.documentName) {
      websocketProvider = new WebsocketProvider(
        this._collaborationOptions.collaborationUrl,
        this._collaborationOptions.documentName,
        yjsDoc
      );
      awareness = websocketProvider.awareness;
    }

    // Setup awareness tracking
    if (awareness && this._currentUser) {
      awareness.setLocalStateField('user', this._currentUser);
      
      awareness.on('change', () => {
        this._updateActiveUsers(awareness!);
      });
    }

    const provider: IYjsNotebookProvider = {
      yjsDocument: yjsDoc,
      websocketProvider,
      awareness,
      isConnected: false,
      statusChanged: new Signal(provider, 'statusChanged'),
      documentChanged: new Signal(provider, 'documentChanged'),

      async connect(): Promise<void> {
        // Connection logic would be here
        if (websocketProvider) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Connection timeout'));
            }, 5000);

            websocketProvider!.on('status', ({ status }: { status: string }) => {
              if (status === 'connected') {
                clearTimeout(timeout);
                (this as any).isConnected = true;
                this.statusChanged.emit('connected');
                resolve();
              }
            });
          });
        }
      },

      disconnect(): void {
        if (websocketProvider) {
          websocketProvider.disconnect();
          (this as any).isConnected = false;
          this.statusChanged.emit('disconnected');
        }
      },

      applyLocalChange(change: ICollaborativeChange): void {
        // Apply change to Yjs document
        this._applyChangeToYjsDoc(change, yjsDoc);
      },

      getDocumentState(): nbformat.INotebookContent {
        return this._getNotebookFromYjsDoc(yjsDoc);
      },

      updateDocument(content: nbformat.INotebookContent): void {
        this._updateYjsDocFromNotebook(content, yjsDoc);
      }
    };

    // Setup document change tracking
    yjsDoc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== 'local') {
        const events = Y.decodeUpdate(update);
        provider.documentChanged.emit(events as Y.YEvent<any>[]);
      }
    });

    return provider;
  }

  /**
   * Setup bidirectional synchronization between model and Yjs document
   */
  private _setupBidirectionalSync(): void {
    if (!this._yjsProvider) {
      return;
    }

    // Listen for remote changes from Yjs
    this._yjsProvider.documentChanged.connect((sender, events) => {
      this._handleRemoteChanges(events);
    });

    // Initialize with current notebook state
    const currentState = super.toJSON();
    this._yjsProvider.updateDocument(currentState);
  }

  /**
   * Handle local changes by applying them to the Yjs document
   */
  private _handleLocalChange(change: ICollaborativeChange): void {
    if (this._isCollaborationEnabled && this._yjsProvider) {
      this._yjsProvider.applyLocalChange(change);
    } else {
      // Queue changes for when collaboration is enabled
      this._pendingChanges.push(change);
    }
  }

  /**
   * Handle remote changes from the Yjs document
   */
  private _handleRemoteChanges(events: Y.YEvent<any>[]): void {
    if (!this._yjsProvider) {
      return;
    }

    this._syncInProgress = true;

    try {
      // Get the updated document state
      const updatedContent = this._yjsProvider.getDocumentState();
      
      // Apply changes to the model
      this._applyRemoteContentChanges(updatedContent);

      // Create change events for UI updates
      events.forEach(event => {
        const change = this._createChangeFromYjsEvent(event);
        if (change) {
          this._remoteChangeApplied.emit(change);
        }
      });

    } catch (error) {
      console.error('Error handling remote changes:', error);
    } finally {
      this._syncInProgress = false;
    }
  }

  /**
   * Apply pending changes that were queued before collaboration was enabled
   */
  private _applyPendingChanges(): void {
    if (this._pendingChanges.length === 0 || !this._yjsProvider) {
      return;
    }

    this._pendingChanges.forEach(change => {
      this._yjsProvider!.applyLocalChange(change);
    });

    this._pendingChanges = [];
  }

  /**
   * Update active users from awareness state
   */
  private _updateActiveUsers(awareness: Awareness): void {
    const states = awareness.getStates();
    this._activeUsers.clear();

    states.forEach((state, clientId) => {
      if (state.user && clientId !== awareness.clientID) {
        this._activeUsers.set(state.user.userId, state.user);
      }
    });

    this._usersChanged.emit(this.activeUsers);
  }

  /**
   * Create a collaborative change from cell list changes
   */
  private _createChangeFromCellArgs(args: IObservableList.IChangedArgs<ICellModel>): ICollaborativeChange | null {
    switch (args.type) {
      case 'add':
        return {
          type: 'cell-insert',
          index: args.newIndex,
          content: args.newValues.map(cell => cell.toJSON()),
          user: this._currentUser || undefined,
          timestamp: new Date()
        };

      case 'remove':
        return {
          type: 'cell-delete',
          index: args.oldIndex,
          content: args.oldValues.map(cell => cell.id),
          user: this._currentUser || undefined,
          timestamp: new Date()
        };

      case 'set':
        return {
          type: 'cell-modify',
          index: args.newIndex,
          cellId: args.newValues[0]?.id,
          content: args.newValues[0]?.toJSON(),
          user: this._currentUser || undefined,
          timestamp: new Date()
        };

      default:
        return null;
    }
  }

  /**
   * Create a collaborative change from a Yjs event
   */
  private _createChangeFromYjsEvent(event: Y.YEvent<any>): ICollaborativeChange | null {
    // This is a simplified implementation
    // In reality, we'd need to decode the Yjs event properly
    return {
      type: 'cell-modify',
      content: event,
      timestamp: new Date()
    };
  }

  /**
   * Apply remote content changes to the model
   */
  private _applyRemoteContentChanges(content: nbformat.INotebookContent): void {
    // Clear existing cells
    this.cells.clear();

    // Add cells from remote content
    content.cells.forEach(cellData => {
      let cell: ICellModel;
      
      if (cellData.cell_type === 'code') {
        cell = new CodeCellModel({
          id: cellData.id,
          cell: cellData as nbformat.ICodeCell
        });
      } else {
        cell = new MarkdownCellModel({
          id: cellData.id,
          cell: cellData as nbformat.IMarkdownCell
        });
      }
      
      this.cells.push(cell);
    });

    // Update metadata
    if (content.metadata) {
      this.metadata.clear();
      Object.keys(content.metadata).forEach(key => {
        this.metadata.set(key, content.metadata![key]);
      });
    }
  }

  /**
   * Apply a change to the Yjs document
   */
  private _applyChangeToYjsDoc(change: ICollaborativeChange, yjsDoc: Y.Doc): void {
    const cells = yjsDoc.getArray('cells');
    
    switch (change.type) {
      case 'cell-insert':
        if (typeof change.index === 'number' && change.content) {
          change.content.forEach((cellData: any, offset: number) => {
            cells.insert(change.index! + offset, [cellData]);
          });
        }
        break;

      case 'cell-delete':
        if (typeof change.index === 'number' && change.content) {
          cells.delete(change.index, change.content.length);
        }
        break;

      case 'cell-modify':
        if (typeof change.index === 'number' && change.content) {
          const existingCell = cells.get(change.index);
          if (existingCell) {
            // Update cell content
            Object.assign(existingCell, change.content);
          }
        }
        break;

      case 'metadata-change':
        const metadata = yjsDoc.getMap('metadata');
        if (change.content) {
          Object.keys(change.content).forEach(key => {
            metadata.set(key, change.content[key]);
          });
        }
        break;
    }
  }

  /**
   * Get notebook content from Yjs document
   */
  private _getNotebookFromYjsDoc(yjsDoc: Y.Doc): nbformat.INotebookContent {
    const cells = yjsDoc.getArray('cells');
    const metadata = yjsDoc.getMap('metadata');

    return {
      cells: cells.toArray() as nbformat.ICell[],
      metadata: metadata.toJSON(),
      nbformat: 4,
      nbformat_minor: 5
    };
  }

  /**
   * Update Yjs document from notebook content
   */
  private _updateYjsDocFromNotebook(content: nbformat.INotebookContent, yjsDoc: Y.Doc): void {
    const cells = yjsDoc.getArray('cells');
    const metadata = yjsDoc.getMap('metadata');

    // Clear and populate cells
    cells.delete(0, cells.length);
    cells.insert(0, content.cells);

    // Clear and populate metadata
    metadata.clear();
    if (content.metadata) {
      Object.keys(content.metadata).forEach(key => {
        metadata.set(key, content.metadata![key]);
      });
    }
  }

  /**
   * Generate a consistent color for a user ID
   */
  private _generateUserColor(userId: string): string {
    // Simple hash-based color generation
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    const hue = hash % 360;
    return `hsl(${hue}, 70%, 60%)`;
  }
}

/**
 * Namespace for CollaborativeNotebookModel statics
 */
export namespace CollaborativeNotebookModel {
  /**
   * Options for creating a collaborative notebook model
   */
  export interface IOptions extends ICollaborativeNotebookModelOptions {
    /**
     * Language preferences for the model
     */
    languagePreference?: string;

    /**
     * Model database for observables
     */
    modelDB?: IModelDB;
  }

  /**
   * Create a new collaborative notebook model
   */
  export function create(options: IOptions = {}): CollaborativeNotebookModel {
    return new CollaborativeNotebookModel(options);
  }
}