// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ReactWidget, ISessionContext } from '@jupyterlab/apputils';
import { Cell, CodeCell, ICellModel } from '@jupyterlab/cells';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { 
  Notebook, 
  NotebookPanel as BaseNotebookPanel,
  INotebookModel,
  NotebookActions 
} from '@jupyterlab/notebook';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { ArrayExt } from '@lumino/algorithm';
import { DisposableDelegate, IDisposable } from '@lumino/disposable';
import { MessageLoop } from '@lumino/messaging';
import { AttachedProperty } from '@lumino/properties';
import { ISignal, Signal } from '@lumino/signals';
import { Widget, PanelLayout, StackedPanel } from '@lumino/widgets';

import React, { useEffect, useState, useCallback, useMemo } from 'react';

// Import collaboration dependencies
import { YjsNotebookModel } from './model';
import { YjsNotebookProvider } from './collab/provider';
import { IAwarenessState, IUserPresence } from './collab/awareness';
import { ICellLock, ILockState } from './collab/locks';
import { IComment, ICommentThread } from './collab/comments';

/**
 * CSS class names for collaboration UI elements
 */
const COLLABORATION_TOOLBAR_CLASS = 'jp-NotebookCollaboration-toolbar';
const COLLABORATION_STATUS_CLASS = 'jp-NotebookCollaboration-status';
const PRESENCE_INDICATOR_CLASS = 'jp-NotebookCollaboration-presence';
const REMOTE_CURSOR_CLASS = 'jp-NotebookCollaboration-remoteCursor';
const CELL_LOCK_CLASS = 'jp-NotebookCollaboration-cellLock';
const COMMENT_ANCHOR_CLASS = 'jp-NotebookCollaboration-commentAnchor';
const PERMISSION_OVERLAY_CLASS = 'jp-NotebookCollaboration-permissionOverlay';

/**
 * User permission levels
 */
export enum UserPermission {
  VIEW = 'view',
  EDIT = 'edit', 
  ADMIN = 'admin'
}

/**
 * Connection status states
 */
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

/**
 * Interface for collaboration configuration
 */
export interface ICollaborationConfig {
  /**
   * Whether collaboration is enabled
   */
  enabled: boolean;
  
  /**
   * Current user information
   */
  user: {
    id: string;
    name: string;
    avatar?: string;
    color: string;
  };
  
  /**
   * User permission level
   */
  permission: UserPermission;
  
  /**
   * Collaboration server configuration
   */
  server: {
    url: string;
    token?: string;
  };
  
  /**
   * Feature flags
   */
  features: {
    awareness: boolean;
    locking: boolean;
    comments: boolean;
    history: boolean;
  };
}

/**
 * Interface for enhanced NotebookPanel options
 */
export interface ICollaborativeNotebookPanelOptions extends BaseNotebookPanel.IOptions {
  /**
   * Collaboration configuration
   */
  collaboration?: ICollaborationConfig;
  
  /**
   * Translator for internationalization
   */
  translator?: ITranslator;
}

/**
 * A React component for the collaboration toolbar
 */
const CollaborationToolbar = ({
  users,
  connectionStatus,
  currentUser,
  onUserClick,
  onSettingsClick,
  translator
}: {
  users: IUserPresence[];
  connectionStatus: ConnectionStatus;
  currentUser: ICollaborationConfig['user'];
  onUserClick: (userId: string) => void;
  onSettingsClick: () => void;
  translator: ITranslator;
}): JSX.Element => {
  const trans = translator.load('notebook');
  
  const statusColor = useMemo(() => {
    switch (connectionStatus) {
      case ConnectionStatus.CONNECTED:
        return '#4caf50';
      case ConnectionStatus.CONNECTING:
      case ConnectionStatus.RECONNECTING:
        return '#ff9800';
      case ConnectionStatus.ERROR:
        return '#f44336';
      default:
        return '#9e9e9e';
    }
  }, [connectionStatus]);
  
  const statusText = useMemo(() => {
    switch (connectionStatus) {
      case ConnectionStatus.CONNECTED:
        return trans.__('Connected');
      case ConnectionStatus.CONNECTING:
        return trans.__('Connecting...');
      case ConnectionStatus.RECONNECTING:
        return trans.__('Reconnecting...');
      case ConnectionStatus.ERROR:
        return trans.__('Connection Error');
      default:
        return trans.__('Disconnected');
    }
  }, [connectionStatus, trans]);

  return (
    <div className={COLLABORATION_TOOLBAR_CLASS}>
      <div className="jp-Collab-status">
        <div 
          className="jp-Collab-statusIndicator"
          style={{ backgroundColor: statusColor }}
          title={statusText}
        />
        <span className="jp-Collab-statusText">{statusText}</span>
      </div>
      
      <div className="jp-Collab-users">
        <div className="jp-Collab-userCount">
          {trans.__('%1 users', users.length + 1)}
        </div>
        
        <div className="jp-Collab-userList">
          {/* Current user */}
          <div
            className="jp-Collab-user jp-Collab-currentUser"
            style={{ backgroundColor: currentUser.color }}
            title={`${currentUser.name} (${trans.__('You')})`}
          >
            {currentUser.avatar ? (
              <img src={currentUser.avatar} alt={currentUser.name} />
            ) : (
              currentUser.name.charAt(0).toUpperCase()
            )}
          </div>
          
          {/* Remote users */}
          {users.map(user => (
            <div
              key={user.userId}
              className="jp-Collab-user"
              style={{ backgroundColor: user.color }}
              title={user.name}
              onClick={() => onUserClick(user.userId)}
            >
              {user.avatar ? (
                <img src={user.avatar} alt={user.name} />
              ) : (
                user.name.charAt(0).toUpperCase()
              )}
            </div>
          ))}
        </div>
      </div>
      
      <button
        className="jp-Collab-settingsButton"
        onClick={onSettingsClick}
        title={trans.__('Collaboration Settings')}
      >
        ⚙️
      </button>
    </div>
  );
};

/**
 * A React component for remote cursor overlay
 */
const RemoteCursorOverlay = ({
  users,
  notebook
}: {
  users: IUserPresence[];
  notebook: Notebook;
}): JSX.Element => {
  const [cursors, setCursors] = useState<Map<string, { x: number; y: number; user: IUserPresence }>>(new Map());
  
  useEffect(() => {
    const updateCursors = () => {
      const newCursors = new Map();
      
      users.forEach(user => {
        if (user.cursor && user.activeCell !== null) {
          const cellWidget = notebook.widgets[user.activeCell];
          if (cellWidget) {
            const cellNode = cellWidget.node;
            const rect = cellNode.getBoundingClientRect();
            const notebookRect = notebook.node.getBoundingClientRect();
            
            newCursors.set(user.userId, {
              x: rect.left - notebookRect.left + (user.cursor.position * 8), // Approximate char width
              y: rect.top - notebookRect.top + user.cursor.line * 20, // Approximate line height
              user
            });
          }
        }
      });
      
      setCursors(newCursors);
    };
    
    updateCursors();
    const interval = setInterval(updateCursors, 100); // Update cursor positions frequently
    
    return () => clearInterval(interval);
  }, [users, notebook]);

  return (
    <div className={REMOTE_CURSOR_CLASS}>
      {Array.from(cursors.entries()).map(([userId, { x, y, user }]) => (
        <div
          key={userId}
          className="jp-RemoteCursor"
          style={{
            position: 'absolute',
            left: x,
            top: y,
            backgroundColor: user.color,
            width: '2px',
            height: '20px',
            zIndex: 1000
          }}
        >
          <div 
            className="jp-RemoteCursor-label"
            style={{ backgroundColor: user.color }}
          >
            {user.name}
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * A React component for cell lock indicators
 */
const CellLockIndicator = ({
  lock,
  isCurrentUser,
  translator
}: {
  lock: ICellLock;
  isCurrentUser: boolean;
  translator: ITranslator;
}): JSX.Element => {
  const trans = translator.load('notebook');
  
  return (
    <div 
      className={`${CELL_LOCK_CLASS} ${isCurrentUser ? 'jp-CellLock-own' : 'jp-CellLock-other'}`}
      title={isCurrentUser 
        ? trans.__('You are editing this cell')
        : trans.__('Locked by %1', lock.userName)
      }
    >
      <div className="jp-CellLock-icon">🔒</div>
      <div className="jp-CellLock-user">{lock.userName}</div>
    </div>
  );
};

/**
 * A React component for comment anchors
 */
const CommentAnchor = ({
  thread,
  onClick,
  translator
}: {
  thread: ICommentThread;
  onClick: () => void;
  translator: ITranslator;
}): JSX.Element => {
  const trans = translator.load('notebook');
  const unresolvedCount = thread.comments.filter(c => !c.resolved).length;
  
  return (
    <div 
      className={`${COMMENT_ANCHOR_CLASS} ${thread.resolved ? 'jp-CommentAnchor-resolved' : ''}`}
      onClick={onClick}
      title={trans.__('%1 comments', thread.comments.length)}
    >
      <div className="jp-CommentAnchor-icon">💬</div>
      {unresolvedCount > 0 && (
        <div className="jp-CommentAnchor-badge">{unresolvedCount}</div>
      )}
    </div>
  );
};

/**
 * Enhanced NotebookPanel with comprehensive collaboration features
 */
export class CollaborativeNotebookPanel extends BaseNotebookPanel {
  private _collaborationConfig: ICollaborationConfig | null = null;
  private _provider: YjsNotebookProvider | null = null;
  private _translator: ITranslator;
  private _collaborationToolbar: Widget | null = null;
  private _cursorOverlay: Widget | null = null;
  private _permissionOverlay: Widget | null = null;
  
  // Signals for collaboration events
  private _connectionStatusChanged = new Signal<this, ConnectionStatus>(this);
  private _userPresenceChanged = new Signal<this, IUserPresence[]>(this);
  private _cellLockChanged = new Signal<this, { cellId: string; lock: ICellLock | null }>(this);
  private _commentThreadChanged = new Signal<this, { cellId: string; thread: ICommentThread | null }>(this);
  private _permissionChanged = new Signal<this, UserPermission>(this);
  
  // State tracking
  private _connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private _activeUsers: IUserPresence[] = [];
  private _cellLocks = new Map<string, ICellLock>();
  private _commentThreads = new Map<string, ICommentThread>();
  private _currentPermission: UserPermission = UserPermission.VIEW;

  /**
   * Construct a new collaborative notebook panel.
   */
  constructor(options: ICollaborativeNotebookPanelOptions) {
    super(options);
    
    this._translator = options.translator ?? nullTranslator;
    this._collaborationConfig = options.collaboration ?? null;
    
    this.addClass('jp-CollaborativeNotebookPanel');
    
    // Initialize collaboration if enabled
    if (this._collaborationConfig?.enabled) {
      this._initializeCollaboration();
    }
    
    // Set up permission-based UI
    this._currentPermission = this._collaborationConfig?.permission ?? UserPermission.VIEW;
    this._updatePermissionUI();
    
    // Connect to notebook events
    this._setupEventHandlers();
  }

  /**
   * Get the collaboration configuration
   */
  get collaborationConfig(): ICollaborationConfig | null {
    return this._collaborationConfig;
  }

  /**
   * Get the current connection status
   */
  get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  /**
   * Get the signal emitted when connection status changes
   */
  get connectionStatusChanged(): ISignal<this, ConnectionStatus> {
    return this._connectionStatusChanged;
  }

  /**
   * Get the signal emitted when user presence changes
   */
  get userPresenceChanged(): ISignal<this, IUserPresence[]> {
    return this._userPresenceChanged;
  }

  /**
   * Get the signal emitted when cell lock state changes
   */
  get cellLockChanged(): ISignal<this, { cellId: string; lock: ICellLock | null }> {
    return this._cellLockChanged;
  }

  /**
   * Get the signal emitted when comment threads change
   */
  get commentThreadChanged(): ISignal<this, { cellId: string; thread: ICommentThread | null }> {
    return this._commentThreadChanged;
  }

  /**
   * Get the signal emitted when user permission changes
   */
  get permissionChanged(): ISignal<this, UserPermission> {
    return this._permissionChanged;
  }

  /**
   * Get the current user permission level
   */
  get userPermission(): UserPermission {
    return this._currentPermission;
  }

  /**
   * Initialize collaboration features
   */
  private async _initializeCollaboration(): Promise<void> {
    if (!this._collaborationConfig) {
      return;
    }

    try {
      this._setConnectionStatus(ConnectionStatus.CONNECTING);
      
      // Initialize Yjs provider
      this._provider = new YjsNotebookProvider({
        model: this.content.model as YjsNotebookModel,
        serverUrl: this._collaborationConfig.server.url,
        token: this._collaborationConfig.server.token,
        user: this._collaborationConfig.user
      });

      // Connect to provider events
      this._provider.connectionStatusChanged.connect(this._onConnectionStatusChanged, this);
      
      if (this._collaborationConfig.features.awareness) {
        this._provider.awarenessChanged.connect(this._onAwarenessChanged, this);
      }
      
      if (this._collaborationConfig.features.locking) {
        this._provider.lockStateChanged.connect(this._onLockStateChanged, this);
      }
      
      if (this._collaborationConfig.features.comments) {
        this._provider.commentThreadChanged.connect(this._onCommentThreadChanged, this);
      }

      // Initialize collaboration UI
      this._initializeCollaborationUI();
      
      // Connect to server
      await this._provider.connect();
      
    } catch (error) {
      console.error('Failed to initialize collaboration:', error);
      this._setConnectionStatus(ConnectionStatus.ERROR);
      this._fallbackToSingleUserMode();
    }
  }

  /**
   * Initialize collaboration UI components
   */
  private _initializeCollaborationUI(): void {
    if (!this._collaborationConfig) {
      return;
    }

    // Create collaboration toolbar
    this._collaborationToolbar = ReactWidget.create(
      <CollaborationToolbar
        users={this._activeUsers}
        connectionStatus={this._connectionStatus}
        currentUser={this._collaborationConfig.user}
        onUserClick={this._onUserClick.bind(this)}
        onSettingsClick={this._onSettingsClick.bind(this)}
        translator={this._translator}
      />
    );
    this._collaborationToolbar.addClass(COLLABORATION_TOOLBAR_CLASS);
    
    // Insert toolbar above notebook content
    const layout = this.layout as PanelLayout;
    layout.insertWidget(0, this._collaborationToolbar);

    // Create remote cursor overlay
    if (this._collaborationConfig.features.awareness) {
      this._cursorOverlay = ReactWidget.create(
        <RemoteCursorOverlay
          users={this._activeUsers}
          notebook={this.content}
        />
      );
      this._cursorOverlay.addClass(REMOTE_CURSOR_CLASS);
      this.node.appendChild(this._cursorOverlay.node);
    }

    // Set up cell-level UI enhancements
    this._enhanceCellUI();
  }

  /**
   * Enhance cell UI with collaboration features
   */
  private _enhanceCellUI(): void {
    // Process existing cells
    this.content.widgets.forEach(cell => this._enhanceCell(cell));
    
    // Process new cells as they're added
    this.content.model?.cells.changed.connect((sender, args) => {
      if (args.type === 'add') {
        args.newValues.forEach((_, index) => {
          const cell = this.content.widgets[args.newIndex + index];
          if (cell) {
            this._enhanceCell(cell);
          }
        });
      }
    });
  }

  /**
   * Enhance an individual cell with collaboration features
   */
  private _enhanceCell(cell: Cell): void {
    const cellId = cell.model.id;
    
    // Add cell lock indicator
    if (this._collaborationConfig?.features.locking) {
      this._addCellLockIndicator(cell);
    }
    
    // Add comment anchor
    if (this._collaborationConfig?.features.comments) {
      this._addCommentAnchor(cell);
    }
    
    // Add permission overlay for read-only users
    if (this._currentPermission === UserPermission.VIEW) {
      this._addPermissionOverlay(cell);
    }
    
    // Connect to cell editing events for locking
    this._connectCellEvents(cell);
  }

  /**
   * Add cell lock indicator to a cell
   */
  private _addCellLockIndicator(cell: Cell): void {
    const cellId = cell.model.id;
    const lock = this._cellLocks.get(cellId);
    
    if (lock) {
      const isCurrentUser = lock.userId === this._collaborationConfig?.user.id;
      const indicator = ReactWidget.create(
        <CellLockIndicator
          lock={lock}
          isCurrentUser={isCurrentUser}
          translator={this._translator}
        />
      );
      
      // Position the indicator in the cell
      const cellNode = cell.node;
      const indicatorContainer = cellNode.querySelector('.jp-Cell-indicator') || 
        cellNode.querySelector('.jp-Cell-prompt');
      if (indicatorContainer) {
        indicatorContainer.appendChild(indicator.node);
      }
    }
  }

  /**
   * Add comment anchor to a cell
   */
  private _addCommentAnchor(cell: Cell): void {
    const cellId = cell.model.id;
    const thread = this._commentThreads.get(cellId);
    
    if (thread && thread.comments.length > 0) {
      const anchor = ReactWidget.create(
        <CommentAnchor
          thread={thread}
          onClick={() => this._showCommentThread(cellId)}
          translator={this._translator}
        />
      );
      
      // Position the anchor in the cell
      const cellNode = cell.node;
      const anchorContainer = document.createElement('div');
      anchorContainer.className = 'jp-Cell-commentAnchor';
      cellNode.appendChild(anchorContainer);
      anchorContainer.appendChild(anchor.node);
    }
  }

  /**
   * Add permission overlay for read-only access
   */
  private _addPermissionOverlay(cell: Cell): void {
    if (this._currentPermission !== UserPermission.VIEW) {
      return;
    }
    
    const overlay = document.createElement('div');
    overlay.className = PERMISSION_OVERLAY_CLASS;
    overlay.title = this._translator.load('notebook').__('Read-only access');
    
    cell.node.appendChild(overlay);
    
    // Disable editing
    cell.readOnly = true;
  }

  /**
   * Connect to cell events for collaboration features
   */
  private _connectCellEvents(cell: Cell): void {
    // Handle cell selection for locking
    cell.editor?.model.selections.changed.connect(() => {
      if (this._collaborationConfig?.features.locking && this._provider) {
        this._provider.requestCellLock(cell.model.id);
      }
    });
    
    // Handle cell editing for awareness
    cell.editor?.model.value.changed.connect(() => {
      if (this._collaborationConfig?.features.awareness && this._provider) {
        this._provider.updateAwareness({
          activeCell: this.content.activeCellIndex,
          cursor: {
            line: cell.editor?.getCursorPosition().line ?? 0,
            position: cell.editor?.getCursorPosition().column ?? 0
          }
        });
      }
    });
  }

  /**
   * Set up event handlers for notebook events
   */
  private _setupEventHandlers(): void {
    // Handle active cell changes
    this.content.activeCellChanged.connect((sender, cell) => {
      if (this._provider && this._collaborationConfig?.features.awareness) {
        this._provider.updateAwareness({
          activeCell: this.content.activeCellIndex,
          cursor: cell?.editor ? {
            line: cell.editor.getCursorPosition().line,
            position: cell.editor.getCursorPosition().column
          } : null
        });
      }
    });
    
    // Handle model changes
    this.content.modelChanged.connect((sender, model) => {
      if (model && this._collaborationConfig?.enabled) {
        // Reinitialize collaboration for new model
        this._initializeCollaboration();
      }
    });
  }

  /**
   * Handle connection status changes from provider
   */
  private _onConnectionStatusChanged(sender: YjsNotebookProvider, status: ConnectionStatus): void {
    this._setConnectionStatus(status);
    
    if (status === ConnectionStatus.ERROR) {
      this._fallbackToSingleUserMode();
    }
  }

  /**
   * Handle awareness changes from provider
   */
  private _onAwarenessChanged(sender: YjsNotebookProvider, users: IUserPresence[]): void {
    this._activeUsers = users;
    this._userPresenceChanged.emit(users);
    this._updateCollaborationUI();
  }

  /**
   * Handle lock state changes from provider
   */
  private _onLockStateChanged(sender: YjsNotebookProvider, state: ILockState): void {
    this._cellLocks.clear();
    Object.entries(state.locks).forEach(([cellId, lock]) => {
      this._cellLocks.set(cellId, lock);
    });
    
    // Update cell UI
    this.content.widgets.forEach(cell => {
      const cellId = cell.model.id;
      const lock = this._cellLocks.get(cellId);
      this._cellLockChanged.emit({ cellId, lock: lock || null });
    });
    
    this._updateCellLockUI();
  }

  /**
   * Handle comment thread changes from provider
   */
  private _onCommentThreadChanged(sender: YjsNotebookProvider, data: { cellId: string; thread: ICommentThread | null }): void {
    if (data.thread) {
      this._commentThreads.set(data.cellId, data.thread);
    } else {
      this._commentThreads.delete(data.cellId);
    }
    
    this._commentThreadChanged.emit(data);
    this._updateCommentUI();
  }

  /**
   * Set connection status and emit signal
   */
  private _setConnectionStatus(status: ConnectionStatus): void {
    if (this._connectionStatus !== status) {
      this._connectionStatus = status;
      this._connectionStatusChanged.emit(status);
      this._updateCollaborationUI();
    }
  }

  /**
   * Update collaboration UI components
   */
  private _updateCollaborationUI(): void {
    if (this._collaborationToolbar && this._collaborationConfig) {
      // Re-render collaboration toolbar with updated state
      const newToolbar = ReactWidget.create(
        <CollaborationToolbar
          users={this._activeUsers}
          connectionStatus={this._connectionStatus}
          currentUser={this._collaborationConfig.user}
          onUserClick={this._onUserClick.bind(this)}
          onSettingsClick={this._onSettingsClick.bind(this)}
          translator={this._translator}
        />
      );
      
      const layout = this.layout as PanelLayout;
      const index = layout.widgets.indexOf(this._collaborationToolbar);
      if (index !== -1) {
        layout.insertWidget(index, newToolbar);
        this._collaborationToolbar.dispose();
        this._collaborationToolbar = newToolbar;
      }
    }
    
    if (this._cursorOverlay) {
      // Re-render cursor overlay with updated users
      const newOverlay = ReactWidget.create(
        <RemoteCursorOverlay
          users={this._activeUsers}
          notebook={this.content}
        />
      );
      
      this.node.removeChild(this._cursorOverlay.node);
      this._cursorOverlay.dispose();
      this._cursorOverlay = newOverlay;
      this.node.appendChild(this._cursorOverlay.node);
    }
  }

  /**
   * Update cell lock UI
   */
  private _updateCellLockUI(): void {
    this.content.widgets.forEach(cell => {
      // Remove existing lock indicators
      const existingIndicators = cell.node.querySelectorAll(`.${CELL_LOCK_CLASS}`);
      existingIndicators.forEach(indicator => indicator.remove());
      
      // Add new lock indicators
      this._addCellLockIndicator(cell);
    });
  }

  /**
   * Update comment UI
   */
  private _updateCommentUI(): void {
    this.content.widgets.forEach(cell => {
      // Remove existing comment anchors
      const existingAnchors = cell.node.querySelectorAll(`.${COMMENT_ANCHOR_CLASS}`);
      existingAnchors.forEach(anchor => anchor.remove());
      
      // Add new comment anchors
      this._addCommentAnchor(cell);
    });
  }

  /**
   * Update permission-based UI
   */
  private _updatePermissionUI(): void {
    const isReadOnly = this._currentPermission === UserPermission.VIEW;
    
    // Update notebook read-only state
    this.content.readOnly = isReadOnly;
    
    // Update cells
    this.content.widgets.forEach(cell => {
      if (isReadOnly) {
        this._addPermissionOverlay(cell);
      } else {
        // Remove permission overlays
        const overlays = cell.node.querySelectorAll(`.${PERMISSION_OVERLAY_CLASS}`);
        overlays.forEach(overlay => overlay.remove());
        cell.readOnly = false;
      }
    });
  }

  /**
   * Handle user click in collaboration toolbar
   */
  private _onUserClick(userId: string): void {
    const user = this._activeUsers.find(u => u.userId === userId);
    if (user && user.activeCell !== null) {
      // Navigate to user's active cell
      this.content.activeCellIndex = user.activeCell;
      this.content.widgets[user.activeCell]?.node.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
    }
  }

  /**
   * Handle settings click in collaboration toolbar
   */
  private _onSettingsClick(): void {
    // Open collaboration settings dialog
    // This would typically open a dialog for configuring collaboration preferences
    console.log('Collaboration settings clicked');
  }

  /**
   * Show comment thread for a cell
   */
  private _showCommentThread(cellId: string): void {
    const thread = this._commentThreads.get(cellId);
    if (thread) {
      // Open comment thread dialog/panel
      // This would typically show a sidebar or dialog with the comment thread
      console.log('Show comment thread for cell:', cellId, thread);
    }
  }

  /**
   * Fallback to single-user mode when collaboration fails
   */
  private _fallbackToSingleUserMode(): void {
    console.warn('Falling back to single-user mode due to collaboration failure');
    
    // Hide collaboration UI
    if (this._collaborationToolbar) {
      this._collaborationToolbar.hide();
    }
    
    if (this._cursorOverlay) {
      this._cursorOverlay.hide();
    }
    
    // Remove collaboration features from cells
    this.content.widgets.forEach(cell => {
      const lockIndicators = cell.node.querySelectorAll(`.${CELL_LOCK_CLASS}`);
      lockIndicators.forEach(indicator => indicator.remove());
      
      const commentAnchors = cell.node.querySelectorAll(`.${COMMENT_ANCHOR_CLASS}`);
      commentAnchors.forEach(anchor => anchor.remove());
      
      cell.readOnly = false;
    });
    
    // Clear collaboration state
    this._activeUsers = [];
    this._cellLocks.clear();
    this._commentThreads.clear();
    
    this._setConnectionStatus(ConnectionStatus.DISCONNECTED);
  }

  /**
   * Dispose of the collaborative notebook panel
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    
    // Disconnect from provider
    if (this._provider) {
      this._provider.dispose();
      this._provider = null;
    }
    
    // Dispose collaboration UI
    if (this._collaborationToolbar) {
      this._collaborationToolbar.dispose();
      this._collaborationToolbar = null;
    }
    
    if (this._cursorOverlay) {
      this._cursorOverlay.dispose();
      this._cursorOverlay = null;
    }
    
    if (this._permissionOverlay) {
      this._permissionOverlay.dispose();
      this._permissionOverlay = null;
    }
    
    // Clear signals
    Signal.clearData(this);
    
    super.dispose();
  }
}

/**
 * A namespace for CollaborativeNotebookPanel statics
 */
export namespace CollaborativeNotebookPanel {
  /**
   * Factory for creating collaborative notebook panels
   */
  export interface IContentFactory extends BaseNotebookPanel.IContentFactory {
    /**
     * Create a new collaborative notebook
     */
    createNotebook(options: Notebook.IOptions): Notebook;
  }

  /**
   * Default implementation of IContentFactory
   */
  export class ContentFactory extends BaseNotebookPanel.ContentFactory implements IContentFactory {
    /**
     * Create a new collaborative notebook
     */
    createNotebook(options: Notebook.IOptions): Notebook {
      return new Notebook(options);
    }
  }

  /**
   * Default content factory instance
   */
  export const defaultContentFactory = new ContentFactory();

  /**
   * Options for creating a collaborative notebook panel
   */
  export interface IOptions extends BaseNotebookPanel.IOptions {
    /**
     * The content factory for the panel
     */
    contentFactory?: IContentFactory;
    
    /**
     * Collaboration configuration
     */
    collaboration?: ICollaborationConfig;
  }
}

/**
 * A namespace for private utilities
 */
namespace Private {
  /**
   * Attach a collaboration property to a cell
   */
  export const collaborationProperty = new AttachedProperty<Cell, {
    lockIndicator?: Widget;
    commentAnchor?: Widget;
    permissionOverlay?: HTMLElement;
  }>({
    name: 'collaboration',
    create: () => ({})
  });

  /**
   * Get user color based on user ID
   */
  export function getUserColor(userId: string): string {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
      '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
    ];
    
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * Format time for display
   */
  export function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    if (diff < 60000) { // Less than 1 minute
      return 'just now';
    } else if (diff < 3600000) { // Less than 1 hour
      return `${Math.floor(diff / 60000)}m ago`;
    } else if (diff < 86400000) { // Less than 1 day
      return `${Math.floor(diff / 3600000)}h ago`;
    } else {
      return date.toLocaleDateString();
    }
  }

  /**
   * Throttle function calls
   */
  export function throttle<T extends (...args: any[]) => void>(
    func: T,
    delay: number
  ): T {
    let timeoutId: number | null = null;
    let lastExecTime = 0;
    
    return ((...args: any[]) => {
      const currentTime = Date.now();
      
      if (currentTime - lastExecTime > delay) {
        func(...args);
        lastExecTime = currentTime;
      } else {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        
        timeoutId = setTimeout(() => {
          func(...args);
          lastExecTime = Date.now();
        }, delay - (currentTime - lastExecTime));
      }
    }) as T;
  }

  /**
   * Create a unique user session ID
   */
  export function createSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Validate collaboration configuration
   */
  export function validateCollaborationConfig(config: Partial<ICollaborationConfig>): ICollaborationConfig | null {
    if (!config.enabled) {
      return null;
    }
    
    if (!config.user?.id || !config.user?.name || !config.server?.url) {
      console.error('Invalid collaboration configuration: missing required fields');
      return null;
    }
    
    return {
      enabled: true,
      user: {
        id: config.user.id,
        name: config.user.name,
        avatar: config.user.avatar,
        color: config.user.color || getUserColor(config.user.id)
      },
      permission: config.permission || UserPermission.EDIT,
      server: {
        url: config.server.url,
        token: config.server.token
      },
      features: {
        awareness: config.features?.awareness ?? true,
        locking: config.features?.locking ?? true,
        comments: config.features?.comments ?? true,
        history: config.features?.history ?? true
      }
    };
  }
}

/**
 * Create a new collaborative notebook panel
 */
export function createCollaborativeNotebookPanel(
  options: CollaborativeNotebookPanel.IOptions
): CollaborativeNotebookPanel {
  const collaborationConfig = options.collaboration 
    ? Private.validateCollaborationConfig(options.collaboration)
    : null;
    
  return new CollaborativeNotebookPanel({
    ...options,
    collaboration: collaborationConfig,
    contentFactory: options.contentFactory || CollaborativeNotebookPanel.defaultContentFactory
  });
}