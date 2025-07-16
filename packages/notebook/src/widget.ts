// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as React from 'react';
import * as Y from 'yjs';
import { YNotebook } from '@jupyter/ydoc';

import { Widget } from '@lumino/widgets';
import { Signal, ISignal } from '@lumino/signaling';

import { NotebookPanel as BaseNotebookPanel } from '@jupyterlab/notebook';
import { Cell } from '@jupyterlab/cells';
import { Toolbar } from '@jupyterlab/apputils';
import { LabIcon } from '@jupyterlab/ui-components';

import NotebookModel from './model';
import YjsNotebookProvider from './collab/provider';
import UserAwareness from './collab/awareness';
import CellLocking from './collab/locks';
import CommentSystem from './collab/comments';
import { IChangeHistory } from './collab/history';
import { ICollaborativeRole } from './collab/permissions';
import { CollaborativeCell } from './default-cell';

/**
 * Enumeration of collaboration connection states
 */
export enum CollaborationConnectionState {
  /** No collaboration active */
  DISCONNECTED = 'disconnected',
  /** Attempting to connect */
  CONNECTING = 'connecting',
  /** Connected and synchronized */
  CONNECTED = 'connected',
  /** Connected but experiencing issues */
  DEGRADED = 'degraded',
  /** Connection failed */
  ERROR = 'error',
  /** Offline mode */
  OFFLINE = 'offline'
}

/**
 * Enumeration of synchronization states
 */
export enum SyncState {
  /** No synchronization needed */
  IDLE = 'idle',
  /** Synchronizing changes */
  SYNCING = 'syncing',
  /** All changes synchronized */
  SYNCED = 'synced',
  /** Synchronization conflicts detected */
  CONFLICT = 'conflict',
  /** Synchronization error */
  ERROR = 'error'
}

/**
 * Interface for collaboration status information
 */
export interface ICollaborationStatus {
  /** Current connection state */
  connectionState: CollaborationConnectionState;
  /** Current synchronization state */
  syncState: SyncState;
  /** Whether collaboration is enabled */
  enabled: boolean;
  /** Number of active collaborators */
  activeUsers: number;
  /** Current user information */
  currentUser: any;
  /** Last synchronization timestamp */
  lastSyncTime: number;
  /** Connection health metrics */
  connectionHealth: {
    latency: number;
    packetLoss: number;
    bandwidth: number;
  };
}

/**
 * Interface for collaboration bar configuration
 */
export interface ICollaborationBarConfig {
  /** Whether to show user avatars */
  showAvatars: boolean;
  /** Whether to show connection status */
  showConnectionStatus: boolean;
  /** Whether to show sync status */
  showSyncStatus: boolean;
  /** Whether to show user count */
  showUserCount: boolean;
  /** Maximum number of avatars to display */
  maxAvatars: number;
  /** Whether to enable collaboration controls */
  enableControls: boolean;
}

/**
 * Interface for notebook collaboration features
 */
export interface INotebookCollaborationFeatures {
  /** User awareness system */
  userAwareness: UserAwareness | null;
  /** Cell locking system */
  cellLocking: CellLocking | null;
  /** Comment system */
  commentSystem: CommentSystem | null;
  /** Change history system */
  changeHistory: IChangeHistory | null;
  /** Collaboration provider */
  collaborationProvider: YjsNotebookProvider | null;
  /** Current collaboration status */
  collaborationStatus: ICollaborationStatus;
  /** Whether collaboration is enabled */
  collaborationEnabled: boolean;
  /** Current sync status */
  syncStatus: SyncState;
}

/**
 * Interface for user presence visual indicators
 */
export interface IUserPresenceIndicator {
  /** User information */
  user: any;
  /** Visual indicator element */
  element: HTMLElement;
  /** Whether indicator is visible */
  visible: boolean;
  /** Cursor position */
  cursorPosition?: { line: number; column: number };
  /** Selection range */
  selection?: { start: any; end: any };
}

/**
 * Interface for cell lock indicators
 */
export interface ICellLockIndicator {
  /** Cell ID */
  cellId: string;
  /** Lock owner */
  lockOwner: string;
  /** Lock status */
  isLocked: boolean;
  /** Visual indicator element */
  element: HTMLElement;
  /** Lock timeout */
  timeout: number;
}

/**
 * Interface for comment thread indicators
 */
export interface ICommentThreadIndicator {
  /** Cell ID */
  cellId: string;
  /** Number of comments */
  commentCount: number;
  /** Number of unresolved comments */
  unresolvedCount: number;
  /** Visual indicator element */
  element: HTMLElement;
  /** Whether comments are visible */
  visible: boolean;
}

/**
 * Default collaboration bar configuration
 */
const DEFAULT_COLLABORATION_BAR_CONFIG: ICollaborationBarConfig = {
  showAvatars: true,
  showConnectionStatus: true,
  showSyncStatus: true,
  showUserCount: true,
  maxAvatars: 5,
  enableControls: true
};

/**
 * CollaborationBar: React component for displaying collaboration status and controls
 */
const CollaborationBar: React.FC<{
  status: ICollaborationStatus;
  config: ICollaborationBarConfig;
  onToggleCollaboration: () => void;
  onShowUserList: () => void;
  onShowPermissions: () => void;
  onShowHistory: () => void;
}> = ({ status, config, onToggleCollaboration, onShowUserList, onShowPermissions, onShowHistory }) => {
  const { connectionState, syncState, activeUsers, currentUser, connectionHealth } = status;

  /**
   * Get connection status icon and color
   */
  const getConnectionIcon = (): { icon: string; color: string; title: string } => {
    switch (connectionState) {
      case CollaborationConnectionState.CONNECTED:
        return { icon: '●', color: '#28a745', title: 'Connected' };
      case CollaborationConnectionState.CONNECTING:
        return { icon: '◐', color: '#ffc107', title: 'Connecting...' };
      case CollaborationConnectionState.DEGRADED:
        return { icon: '◑', color: '#fd7e14', title: 'Connection degraded' };
      case CollaborationConnectionState.ERROR:
        return { icon: '●', color: '#dc3545', title: 'Connection error' };
      case CollaborationConnectionState.OFFLINE:
        return { icon: '○', color: '#6c757d', title: 'Offline' };
      default:
        return { icon: '○', color: '#6c757d', title: 'Disconnected' };
    }
  };

  /**
   * Get sync status icon and color
   */
  const getSyncIcon = (): { icon: string; color: string; title: string } => {
    switch (syncState) {
      case SyncState.SYNCED:
        return { icon: '✓', color: '#28a745', title: 'Synchronized' };
      case SyncState.SYNCING:
        return { icon: '↻', color: '#007bff', title: 'Synchronizing...' };
      case SyncState.CONFLICT:
        return { icon: '⚠', color: '#ffc107', title: 'Conflicts detected' };
      case SyncState.ERROR:
        return { icon: '✗', color: '#dc3545', title: 'Sync error' };
      default:
        return { icon: '−', color: '#6c757d', title: 'Idle' };
    }
  };

  /**
   * Format connection health metrics
   */
  const formatHealth = (): string => {
    const { latency, packetLoss, bandwidth } = connectionHealth;
    return `Latency: ${latency}ms, Loss: ${packetLoss.toFixed(1)}%, Bandwidth: ${(bandwidth / 1024).toFixed(1)}KB/s`;
  };

  const connectionIcon = getConnectionIcon();
  const syncIcon = getSyncIcon();

  return React.createElement('div', {
    className: 'jp-CollaborationBar',
    style: {
      display: 'flex',
      alignItems: 'center',
      padding: '4px 8px',
      backgroundColor: '#f8f9fa',
      borderBottom: '1px solid #dee2e6',
      fontSize: '12px',
      gap: '12px'
    }
  }, [
    // Connection Status
    config.showConnectionStatus && React.createElement('div', {
      key: 'connection-status',
      className: 'jp-CollaborationBar-connectionStatus',
      style: { display: 'flex', alignItems: 'center', gap: '4px' },
      title: `${connectionIcon.title} - ${formatHealth()}`
    }, [
      React.createElement('span', {
        key: 'connection-icon',
        style: { color: connectionIcon.color }
      }, connectionIcon.icon),
      React.createElement('span', {
        key: 'connection-text'
      }, connectionIcon.title)
    ]),

    // Sync Status
    config.showSyncStatus && React.createElement('div', {
      key: 'sync-status',
      className: 'jp-CollaborationBar-syncStatus',
      style: { display: 'flex', alignItems: 'center', gap: '4px' },
      title: syncIcon.title
    }, [
      React.createElement('span', {
        key: 'sync-icon',
        style: { color: syncIcon.color }
      }, syncIcon.icon),
      React.createElement('span', {
        key: 'sync-text'
      }, syncIcon.title)
    ]),

    // User Count
    config.showUserCount && React.createElement('div', {
      key: 'user-count',
      className: 'jp-CollaborationBar-userCount',
      style: { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
      onClick: onShowUserList,
      title: 'Show active users'
    }, [
      React.createElement('span', {
        key: 'user-icon'
      }, '👥'),
      React.createElement('span', {
        key: 'user-count-text'
      }, `${activeUsers} user${activeUsers !== 1 ? 's' : ''}`)
    ]),

    // User Avatars
    config.showAvatars && React.createElement('div', {
      key: 'user-avatars',
      className: 'jp-CollaborationBar-userAvatars',
      style: { display: 'flex', alignItems: 'center', gap: '2px' }
    }, [
      React.createElement('div', {
        key: 'current-user-avatar',
        style: {
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          backgroundColor: currentUser?.color || '#007bff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '10px',
          color: 'white',
          border: '2px solid #fff'
        },
        title: currentUser?.displayName || 'You'
      }, currentUser?.displayName?.charAt(0) || 'U')
    ]),

    // Collaboration Controls
    config.enableControls && React.createElement('div', {
      key: 'collaboration-controls',
      className: 'jp-CollaborationBar-controls',
      style: { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }
    }, [
      React.createElement('button', {
        key: 'permissions-button',
        className: 'jp-CollaborationBar-button',
        onClick: onShowPermissions,
        title: 'Manage permissions',
        style: {
          padding: '4px 8px',
          border: '1px solid #dee2e6',
          borderRadius: '4px',
          backgroundColor: '#fff',
          cursor: 'pointer',
          fontSize: '12px'
        }
      }, '🔒 Permissions'),
      React.createElement('button', {
        key: 'history-button',
        className: 'jp-CollaborationBar-button',
        onClick: onShowHistory,
        title: 'View history',
        style: {
          padding: '4px 8px',
          border: '1px solid #dee2e6',
          borderRadius: '4px',
          backgroundColor: '#fff',
          cursor: 'pointer',
          fontSize: '12px'
        }
      }, '📜 History'),
      React.createElement('button', {
        key: 'toggle-collaboration',
        className: 'jp-CollaborationBar-toggle',
        onClick: onToggleCollaboration,
        title: status.enabled ? 'Disable collaboration' : 'Enable collaboration',
        style: {
          padding: '4px 8px',
          border: '1px solid #dee2e6',
          borderRadius: '4px',
          backgroundColor: status.enabled ? '#28a745' : '#6c757d',
          color: 'white',
          cursor: 'pointer',
          fontSize: '12px'
        }
      }, status.enabled ? '🔗 Enabled' : '🔗 Disabled')
    ])
  ]);
};

/**
 * Enhanced NotebookPanel with comprehensive collaborative editing capabilities
 * 
 * Extends the base NotebookPanel to provide real-time collaboration features including:
 * - User presence awareness and visual indicators
 * - Cell-level locking for exclusive editing
 * - Comment system integration for discussions
 * - Change history and version control
 * - Permissions management
 * - Connection status monitoring
 * - Synchronization health tracking
 */
export default class NotebookPanel extends BaseNotebookPanel implements INotebookCollaborationFeatures {
  private _model: NotebookModel;
  private _collaborationBar: Widget | null = null;
  private _collaborationBarConfig: ICollaborationBarConfig = DEFAULT_COLLABORATION_BAR_CONFIG;
  private _collaborationStatus: ICollaborationStatus;
  private _userPresenceIndicators = new Map<string, IUserPresenceIndicator>();
  private _cellLockIndicators = new Map<string, ICellLockIndicator>();
  private _commentThreadIndicators = new Map<string, ICommentThreadIndicator>();

  // Collaboration system references
  private _userAwareness: UserAwareness | null = null;
  private _cellLocking: CellLocking | null = null;
  private _commentSystem: CommentSystem | null = null;
  private _changeHistory: IChangeHistory | null = null;
  private _collaborationProvider: YjsNotebookProvider | null = null;

  // Signals for collaboration events
  private _onActiveCellChanged = new Signal<this, any>(this);
  private _onCellsChanged = new Signal<this, void>(this);
  private _onCollaborationStatusChanged = new Signal<this, ICollaborationStatus>(this);
  private _onUserPresenceChanged = new Signal<this, any>(this);
  private _onCellLockChanged = new Signal<this, any>(this);
  private _onCommentChanged = new Signal<this, any>(this);

  // Event handlers
  private _updateStatusTimer: number | null = null;
  private _presenceUpdateTimer: number | null = null;

  /**
   * Construct a new NotebookPanel with collaboration features
   */
  constructor(options: any) {
    super(options);

    this._model = options.model as NotebookModel;
    
    // Initialize collaboration status
    this._collaborationStatus = {
      connectionState: CollaborationConnectionState.DISCONNECTED,
      syncState: SyncState.IDLE,
      enabled: false,
      activeUsers: 0,
      currentUser: null,
      lastSyncTime: 0,
      connectionHealth: {
        latency: 0,
        packetLoss: 0,
        bandwidth: 0
      }
    };

    // Initialize collaboration systems
    this._initializeCollaborationSystems();

    // Set up collaboration UI
    this._setupCollaborationUI();

    // Set up event handlers
    this._setupEventHandlers();

    // Start periodic updates
    this._startPeriodicUpdates();

    // Add CSS classes
    this.addClass('jp-NotebookPanel-collaborative');
  }

  /**
   * Get the collaborative notebook model
   */
  get collaborativeModel(): NotebookModel {
    return this._model;
  }

  /**
   * Get the notebook model (base class compatibility)
   */
  get model(): any {
    return this._model as any;
  }

  /**
   * Get the collaboration bar widget
   */
  get collaborationBar(): Widget | null {
    return this._collaborationBar;
  }

  /**
   * Get the active cell index
   */
  get activeCellIndex(): number {
    return this.content.activeCellIndex;
  }

  /**
   * Set the active cell index
   */
  set activeCellIndex(index: number) {
    this.content.activeCellIndex = index;
  }

  /**
   * Get the active cell
   */
  get activeCell(): Cell | null {
    return this.content.activeCell;
  }

  /**
   * Get the cells
   */
  get cells(): readonly Cell[] {
    return this.content.widgets;
  }

  /**
   * Get the user awareness system
   */
  get userAwareness(): UserAwareness | null {
    return this._userAwareness;
  }

  /**
   * Get the cell locking system
   */
  get cellLocking(): CellLocking | null {
    return this._cellLocking;
  }

  /**
   * Get the comment system
   */
  get commentSystem(): CommentSystem | null {
    return this._commentSystem;
  }

  /**
   * Get the change history system
   */
  get changeHistory(): IChangeHistory | null {
    return this._changeHistory;
  }

  /**
   * Get the collaboration provider
   */
  get collaborationProvider(): YjsNotebookProvider | null {
    return this._collaborationProvider;
  }

  /**
   * Get the collaboration status
   */
  get collaborationStatus(): ICollaborationStatus {
    return { ...this._collaborationStatus };
  }

  /**
   * Get whether collaboration is enabled
   */
  get collaborationEnabled(): boolean {
    return this._collaborationStatus.enabled;
  }

  /**
   * Get the current sync status
   */
  get syncStatus(): SyncState {
    return this._collaborationStatus.syncState;
  }

  /**
   * Signal emitted when the active cell changes
   */
  get onActiveCellChanged(): ISignal<this, any> {
    return this._onActiveCellChanged;
  }

  /**
   * Signal emitted when cells change
   */
  get onCellsChanged(): ISignal<this, void> {
    return this._onCellsChanged;
  }

  /**
   * Signal emitted when collaboration status changes
   */
  get onCollaborationStatusChanged(): ISignal<this, ICollaborationStatus> {
    return this._onCollaborationStatusChanged;
  }

  /**
   * Signal emitted when user presence changes
   */
  get onUserPresenceChanged(): ISignal<this, any> {
    return this._onUserPresenceChanged;
  }

  /**
   * Signal emitted when cell lock changes
   */
  get onCellLockChanged(): ISignal<this, any> {
    return this._onCellLockChanged;
  }

  /**
   * Signal emitted when comment changes
   */
  get onCommentChanged(): ISignal<this, any> {
    return this._onCommentChanged;
  }

  /**
   * Add a cell to the notebook
   */
  addCell(type: string, index?: number): Cell {
    const cellModel = this._model.createCell(type, {});
    
    // Find the corresponding cell widget
    const cellWidget = this.content.widgets.find(w => (w as any).model?.id === cellModel.id);
    
    // Update collaboration status
    this._updateCollaborationStatus();
    this._onCellsChanged.emit();
    
    return cellWidget || this.content.activeCell;
  }

  /**
   * Delete a cell from the notebook
   */
  deleteCell(cell: Cell): void {
    const cellId = (cell.model as any)?.id;
    if (cellId) {
      this._model.deleteCell(cellId);
      this._updateCollaborationStatus();
      this._onCellsChanged.emit();
    }
  }

  /**
   * Select a cell
   */
  selectCell(cell: Cell): void {
    const index = this.content.widgets.indexOf(cell);
    if (index !== -1) {
      this.content.activeCellIndex = index;
      this._onActiveCellChanged.emit(cell);
    }
  }

  /**
   * Initialize collaboration systems
   */
  private _initializeCollaborationSystems(): void {
    if (!this._model.collaborationEnabled) {
      return;
    }

    // Get collaboration components from model
    this._collaborationProvider = this._model.provider;
    this._userAwareness = this._model.awareness;
    this._cellLocking = (this._model as any)._cellLocking;
    this._commentSystem = (this._model as any)._commentSystem;
    this._changeHistory = this._model.changeHistory;

    // Update collaboration status
    this._collaborationStatus.enabled = true;
    this._collaborationStatus.currentUser = this._userAwareness?.getCurrentUser() || null;
    this._updateCollaborationStatus();
  }

  /**
   * Set up collaboration UI
   */
  private _setupCollaborationUI(): void {
    // Create collaboration bar
    this._collaborationBar = new Widget();
    this._collaborationBar.addClass('jp-NotebookPanel-collaborationBar');
    this._collaborationBar.id = 'collaboration-bar';

    // Render collaboration bar
    this._renderCollaborationBar();

    // Add collaboration bar to the layout
    this.toolbar.insertItem(0, 'collaboration-bar', this._collaborationBar);

    // Set up cell indicators
    this._setupCellIndicators();
  }

  /**
   * Set up cell indicators for collaboration features
   */
  private _setupCellIndicators(): void {
    // Add indicators to existing cells
    this.content.widgets.forEach(cell => {
      this._setupCellCollaborationFeatures(cell);
    });

    // Listen for new cells
    this.content.model?.cells.changed.connect((sender, args) => {
      if (args.type === 'add') {
        args.newValues.forEach(cell => {
          const cellWidget = this.content.widgets.find(w => (w as any).model === cell);
          if (cellWidget) {
            this._setupCellCollaborationFeatures(cellWidget);
          }
        });
      }
    });
  }

  /**
   * Set up collaboration features for a cell
   */
  private _setupCellCollaborationFeatures(cell: Cell): void {
    if (!this._collaborationStatus.enabled) {
      return;
    }

    const cellId = cell.model.id;
    
    // Set up user presence indicators
    this._setupUserPresenceIndicators(cellId, cell);
    
    // Set up lock indicators
    this._setupCellLockIndicators(cellId, cell);
    
    // Set up comment indicators
    this._setupCommentIndicators(cellId, cell);

    // Convert to collaborative cell if needed
    if (cell instanceof CollaborativeCell) {
      this._setupCollaborativeCellFeatures(cell);
    }
  }

  /**
   * Set up user presence indicators for a cell
   */
  private _setupUserPresenceIndicators(cellId: string, cell: Cell): void {
    if (!this._userAwareness) {
      return;
    }

    // Create presence indicator container
    const presenceContainer = document.createElement('div');
    presenceContainer.className = 'jp-Cell-presenceIndicators';
    presenceContainer.style.cssText = `
      position: absolute;
      top: 0;
      right: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px;
      pointer-events: none;
      z-index: 1000;
    `;

    // Add to cell
    cell.node.style.position = 'relative';
    cell.node.appendChild(presenceContainer);

    // Update presence indicators
    this._updateUserPresenceIndicators(cellId, presenceContainer);
  }

  /**
   * Set up cell lock indicators
   */
  private _setupCellLockIndicators(cellId: string, cell: Cell): void {
    if (!this._cellLocking) {
      return;
    }

    // Create lock indicator
    const lockIndicator = document.createElement('div');
    lockIndicator.className = 'jp-Cell-lockIndicator';
    lockIndicator.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(255, 107, 107, 0.1);
      border: 2px solid #ff6b6b;
      border-radius: 4px;
      display: none;
      pointer-events: none;
      z-index: 999;
    `;

    // Add to cell
    cell.node.appendChild(lockIndicator);

    // Store reference
    this._cellLockIndicators.set(cellId, {
      cellId,
      lockOwner: '',
      isLocked: false,
      element: lockIndicator,
      timeout: 0
    });

    // Update lock status
    this._updateCellLockIndicator(cellId);
  }

  /**
   * Set up comment indicators
   */
  private _setupCommentIndicators(cellId: string, cell: Cell): void {
    if (!this._commentSystem) {
      return;
    }

    // Create comment indicator
    const commentIndicator = document.createElement('div');
    commentIndicator.className = 'jp-Cell-commentIndicator';
    commentIndicator.style.cssText = `
      position: absolute;
      top: 0;
      right: 30px;
      width: 20px;
      height: 20px;
      background: #ffc107;
      border: 1px solid #fd7e14;
      border-radius: 50%;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: #212529;
      cursor: pointer;
      z-index: 1001;
    `;

    // Add click handler
    commentIndicator.addEventListener('click', () => {
      this._showCommentsForCell(cellId);
    });

    // Add to cell
    cell.node.appendChild(commentIndicator);

    // Store reference
    this._commentThreadIndicators.set(cellId, {
      cellId,
      commentCount: 0,
      unresolvedCount: 0,
      element: commentIndicator,
      visible: false
    });

    // Update comment status
    this._updateCommentIndicator(cellId);
  }

  /**
   * Set up collaborative cell features
   */
  private _setupCollaborativeCellFeatures(cell: CollaborativeCell): void {
    // Connect to cell collaboration signals
    cell.onLockStateChanged.connect((sender, lockStatus) => {
      this._updateCellLockIndicator(cell.cellId);
      this._onCellLockChanged.emit({ cellId: cell.cellId, lockStatus });
    });

    cell.onUserPresenceChanged.connect((sender, presence) => {
      this._updateUserPresenceIndicators(cell.cellId);
      this._onUserPresenceChanged.emit({ cellId: cell.cellId, presence });
    });

    cell.onCommentAdded.connect((sender, comment) => {
      this._updateCommentIndicator(cell.cellId);
      this._onCommentChanged.emit({ cellId: cell.cellId, comment });
    });
  }

  /**
   * Set up event handlers
   */
  private _setupEventHandlers(): void {
    // Model events
    this._model.onConnectionStateChanged.connect((sender, state) => {
      this._updateConnectionState(state);
    });

    this._model.onSyncStateChanged.connect((sender, state) => {
      this._updateSyncState(state);
    });

    // User awareness events
    if (this._userAwareness) {
      this._userAwareness.onUsersChanged.connect((sender, users) => {
        this._updateUserCount(users.size);
        this._updateAllUserPresenceIndicators();
      });
    }

    // Cell locking events
    if (this._cellLocking) {
      this._cellLocking.onLockStateChanged.connect((sender, event) => {
        this._updateCellLockIndicator(event.cellId);
      });
    }

    // Comment system events
    if (this._commentSystem) {
      this._commentSystem.onCommentCreated.connect((sender, comment) => {
        this._updateCommentIndicator(comment.cellId);
      });

      this._commentSystem.onCommentResolved.connect((sender, comment) => {
        this._updateCommentIndicator(comment.cellId);
      });
    }

    // Notebook content events
    this.content.activeCellChanged.connect((sender, cell) => {
      this._onActiveCellChanged.emit(cell);
      this._updateUserActivity(cell);
    });

    this.content.model?.cells.changed.connect(() => {
      this._onCellsChanged.emit();
    });
  }

  /**
   * Start periodic updates
   */
  private _startPeriodicUpdates(): void {
    // Update collaboration status every 5 seconds
    this._updateStatusTimer = window.setInterval(() => {
      this._updateCollaborationStatus();
    }, 5000);

    // Update user presence every 2 seconds
    this._presenceUpdateTimer = window.setInterval(() => {
      this._updateAllUserPresenceIndicators();
    }, 2000);
  }

  /**
   * Stop periodic updates
   */
  private _stopPeriodicUpdates(): void {
    if (this._updateStatusTimer) {
      clearInterval(this._updateStatusTimer);
      this._updateStatusTimer = null;
    }

    if (this._presenceUpdateTimer) {
      clearInterval(this._presenceUpdateTimer);
      this._presenceUpdateTimer = null;
    }
  }

  /**
   * Update collaboration status
   */
  private _updateCollaborationStatus(): void {
    if (!this._collaborationStatus.enabled) {
      return;
    }

    try {
      // Update connection health
      if (this._collaborationProvider) {
        const health = this._collaborationProvider.getConnectionHealth();
        this._collaborationStatus.connectionHealth = health;
      }

      // Update last sync time
      this._collaborationStatus.lastSyncTime = Date.now();

      // Update current user
      this._collaborationStatus.currentUser = this._userAwareness?.getCurrentUser() || null;

      // Emit status change
      this._onCollaborationStatusChanged.emit(this._collaborationStatus);

      // Re-render collaboration bar
      this._renderCollaborationBar();
    } catch (error) {
      console.error('Failed to update collaboration status:', error);
    }
  }

  /**
   * Update connection state
   */
  private _updateConnectionState(state: string): void {
    let connectionState: CollaborationConnectionState;
    
    switch (state) {
      case 'connected':
        connectionState = CollaborationConnectionState.CONNECTED;
        break;
      case 'connecting':
        connectionState = CollaborationConnectionState.CONNECTING;
        break;
      case 'error':
        connectionState = CollaborationConnectionState.ERROR;
        break;
      case 'offline':
        connectionState = CollaborationConnectionState.OFFLINE;
        break;
      default:
        connectionState = CollaborationConnectionState.DISCONNECTED;
    }

    this._collaborationStatus.connectionState = connectionState;
    this._updateCollaborationStatus();
  }

  /**
   * Update sync state
   */
  private _updateSyncState(state: any): void {
    this._collaborationStatus.syncState = state;
    this._updateCollaborationStatus();
  }

  /**
   * Update user count
   */
  private _updateUserCount(count: number): void {
    this._collaborationStatus.activeUsers = count;
    this._updateCollaborationStatus();
  }

  /**
   * Update user activity
   */
  private _updateUserActivity(cell: Cell | null): void {
    if (!this._userAwareness || !cell) {
      return;
    }

    const currentUser = this._userAwareness.getCurrentUser();
    if (currentUser) {
      this._userAwareness.trackUserActivity(currentUser.id, {
        userId: currentUser.id,
        activity: 'editing' as any,
        cellId: cell.model.id,
        timestamp: Date.now(),
        type: 'editing',
        isActive: true
      });
    }
  }

  /**
   * Update user presence indicators for all cells
   */
  private _updateAllUserPresenceIndicators(): void {
    this._userPresenceIndicators.forEach((indicator, cellId) => {
      this._updateUserPresenceIndicators(cellId);
    });
  }

  /**
   * Update user presence indicators for a specific cell
   */
  private _updateUserPresenceIndicators(cellId: string, container?: HTMLElement): void {
    if (!this._userAwareness) {
      return;
    }

    const users = this._userAwareness.getUsersByCell(cellId);
    const currentUser = this._userAwareness.getCurrentUser();

    if (!container) {
      const indicator = this._userPresenceIndicators.get(cellId);
      if (!indicator) {
        return;
      }
      container = indicator.element.parentElement as HTMLElement;
    }

    // Clear existing indicators
    container.innerHTML = '';

    // Add indicators for each user
    users.forEach(user => {
      if (user.id === currentUser?.id) {
        return; // Skip current user
      }

      const userIndicator = document.createElement('div');
      userIndicator.className = 'jp-Cell-userPresence';
      userIndicator.style.cssText = `
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: ${user.color || '#007bff'};
        border: 2px solid white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: white;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      `;
      userIndicator.textContent = user.displayName?.charAt(0) || 'U';
      userIndicator.title = `${user.displayName || user.username} is ${user.activity || 'active'}`;

      container.appendChild(userIndicator);
    });
  }

  /**
   * Update cell lock indicator
   */
  private _updateCellLockIndicator(cellId: string): void {
    const indicator = this._cellLockIndicators.get(cellId);
    if (!indicator || !this._cellLocking) {
      return;
    }

    const isLocked = this._cellLocking.isLocked(cellId);
    const lockOwner = this._cellLocking.getLockOwner(cellId);

    indicator.isLocked = isLocked;
    indicator.lockOwner = lockOwner || '';

    if (isLocked) {
      indicator.element.style.display = 'block';
      indicator.element.title = `Locked by ${lockOwner}`;
    } else {
      indicator.element.style.display = 'none';
    }
  }

  /**
   * Update comment indicator
   */
  private async _updateCommentIndicator(cellId: string): Promise<void> {
    const indicator = this._commentThreadIndicators.get(cellId);
    if (!indicator || !this._commentSystem) {
      return;
    }

    const comments = await this._commentSystem.getCommentsForCell(cellId);
    const unresolvedComments = comments.filter(c => !c.resolved);

    indicator.commentCount = comments.length;
    indicator.unresolvedCount = unresolvedComments.length;

    if (comments.length > 0) {
      indicator.element.style.display = 'flex';
      indicator.element.textContent = unresolvedComments.length.toString();
      indicator.element.title = `${comments.length} comment${comments.length !== 1 ? 's' : ''} (${unresolvedComments.length} unresolved)`;
      indicator.visible = true;
    } else {
      indicator.element.style.display = 'none';
      indicator.visible = false;
    }
  }

  /**
   * Render collaboration bar
   */
  private _renderCollaborationBar(): void {
    if (!this._collaborationBar) {
      return;
    }

    const element = React.createElement(CollaborationBar, {
      status: this._collaborationStatus,
      config: this._collaborationBarConfig,
      onToggleCollaboration: () => this._toggleCollaboration(),
      onShowUserList: () => this._showUserList(),
      onShowPermissions: () => this._showPermissions(),
      onShowHistory: () => this._showHistory()
    });

    // Use React to render the element
    const container = this._collaborationBar.node;
    container.innerHTML = '';
    
    // Create a temporary div to render React component
    const tempDiv = document.createElement('div');
    const reactElement = React.createElement('div', {}, element);
    
    // Simple rendering without ReactDOM (since we're not importing it)
    // Instead, we'll create the element manually
    this._renderCollaborationBarManually(container);
  }

  /**
   * Render collaboration bar manually (without ReactDOM)
   */
  private _renderCollaborationBarManually(container: HTMLElement): void {
    const { connectionState, syncState, activeUsers, currentUser, connectionHealth } = this._collaborationStatus;

    // Create main container
    const mainDiv = document.createElement('div');
    mainDiv.className = 'jp-CollaborationBar';
    mainDiv.style.cssText = `
      display: flex;
      align-items: center;
      padding: 4px 8px;
      background-color: #f8f9fa;
      border-bottom: 1px solid #dee2e6;
      font-size: 12px;
      gap: 12px;
    `;

    // Connection status
    const connectionDiv = document.createElement('div');
    connectionDiv.className = 'jp-CollaborationBar-connectionStatus';
    connectionDiv.style.cssText = 'display: flex; align-items: center; gap: 4px;';
    
    const connectionIcon = document.createElement('span');
    connectionIcon.textContent = connectionState === CollaborationConnectionState.CONNECTED ? '●' : '○';
    connectionIcon.style.color = connectionState === CollaborationConnectionState.CONNECTED ? '#28a745' : '#6c757d';
    
    const connectionText = document.createElement('span');
    connectionText.textContent = connectionState;
    
    connectionDiv.appendChild(connectionIcon);
    connectionDiv.appendChild(connectionText);
    mainDiv.appendChild(connectionDiv);

    // Sync status
    const syncDiv = document.createElement('div');
    syncDiv.className = 'jp-CollaborationBar-syncStatus';
    syncDiv.style.cssText = 'display: flex; align-items: center; gap: 4px;';
    
    const syncIcon = document.createElement('span');
    syncIcon.textContent = syncState === SyncState.SYNCED ? '✓' : '−';
    syncIcon.style.color = syncState === SyncState.SYNCED ? '#28a745' : '#6c757d';
    
    const syncText = document.createElement('span');
    syncText.textContent = syncState;
    
    syncDiv.appendChild(syncIcon);
    syncDiv.appendChild(syncText);
    mainDiv.appendChild(syncDiv);

    // User count
    const userDiv = document.createElement('div');
    userDiv.className = 'jp-CollaborationBar-userCount';
    userDiv.style.cssText = 'display: flex; align-items: center; gap: 4px; cursor: pointer;';
    userDiv.onclick = () => this._showUserList();
    
    const userIcon = document.createElement('span');
    userIcon.textContent = '👥';
    
    const userText = document.createElement('span');
    userText.textContent = `${activeUsers} user${activeUsers !== 1 ? 's' : ''}`;
    
    userDiv.appendChild(userIcon);
    userDiv.appendChild(userText);
    mainDiv.appendChild(userDiv);

    // Controls
    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'jp-CollaborationBar-controls';
    controlsDiv.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-left: auto;';

    // Permissions button
    const permissionsBtn = document.createElement('button');
    permissionsBtn.textContent = '🔒 Permissions';
    permissionsBtn.className = 'jp-CollaborationBar-button';
    permissionsBtn.onclick = () => this._showPermissions();
    permissionsBtn.style.cssText = 'padding: 4px 8px; border: 1px solid #dee2e6; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px;';

    // History button
    const historyBtn = document.createElement('button');
    historyBtn.textContent = '📜 History';
    historyBtn.className = 'jp-CollaborationBar-button';
    historyBtn.onclick = () => this._showHistory();
    historyBtn.style.cssText = 'padding: 4px 8px; border: 1px solid #dee2e6; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px;';

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = this._collaborationStatus.enabled ? '🔗 Enabled' : '🔗 Disabled';
    toggleBtn.className = 'jp-CollaborationBar-toggle';
    toggleBtn.onclick = () => this._toggleCollaboration();
    toggleBtn.style.cssText = `padding: 4px 8px; border: 1px solid #dee2e6; border-radius: 4px; background: ${this._collaborationStatus.enabled ? '#28a745' : '#6c757d'}; color: white; cursor: pointer; font-size: 12px;`;

    controlsDiv.appendChild(permissionsBtn);
    controlsDiv.appendChild(historyBtn);
    controlsDiv.appendChild(toggleBtn);
    mainDiv.appendChild(controlsDiv);

    // Clear container and add new content
    container.innerHTML = '';
    container.appendChild(mainDiv);
  }

  /**
   * Toggle collaboration
   */
  private async _toggleCollaboration(): Promise<void> {
    try {
      if (this._collaborationStatus.enabled) {
        await this._model.disableCollaboration();
        this._collaborationStatus.enabled = false;
        this._collaborationStatus.connectionState = CollaborationConnectionState.DISCONNECTED;
      } else {
        await this._model.enableCollaboration();
        this._collaborationStatus.enabled = true;
        this._initializeCollaborationSystems();
      }
      
      this._updateCollaborationStatus();
    } catch (error) {
      console.error('Failed to toggle collaboration:', error);
      this._collaborationStatus.connectionState = CollaborationConnectionState.ERROR;
      this._updateCollaborationStatus();
    }
  }

  /**
   * Show user list
   */
  private _showUserList(): void {
    if (!this._userAwareness) {
      return;
    }

    const users = this._userAwareness.getActiveUsers();
    const userList = users.map(u => `${u.displayName || u.username} (${u.activity || 'active'})`).join('\n');
    
    // Simple alert for now - in a real implementation, this would be a proper dialog
    alert(`Active Users (${users.length}):\n\n${userList}`);
  }

  /**
   * Show permissions dialog
   */
  private _showPermissions(): void {
    // Simple alert for now - in a real implementation, this would be a proper dialog
    alert('Permissions management would be implemented here');
  }

  /**
   * Show history viewer
   */
  private _showHistory(): void {
    // Simple alert for now - in a real implementation, this would be a proper dialog
    alert('History viewer would be implemented here');
  }

  /**
   * Show comments for a cell
   */
  private async _showCommentsForCell(cellId: string): Promise<void> {
    if (!this._commentSystem) {
      return;
    }

    const comments = await this._commentSystem.getCommentsForCell(cellId);
    const commentList = comments.map(c => `${c.author.displayName}: ${c.content} ${c.resolved ? '(resolved)' : ''}`).join('\n\n');
    
    // Simple alert for now - in a real implementation, this would be a proper dialog
    alert(`Comments for cell:\n\n${commentList}`);
  }

  /**
   * Dispose of the widget
   */
  dispose(): void {
    this._stopPeriodicUpdates();
    
    // Clean up indicators
    this._userPresenceIndicators.clear();
    this._cellLockIndicators.clear();
    this._commentThreadIndicators.clear();
    
    // Clean up collaboration bar
    if (this._collaborationBar) {
      this._collaborationBar.dispose();
      this._collaborationBar = null;
    }
    
    // Call parent dispose
    super.dispose();
  }
}