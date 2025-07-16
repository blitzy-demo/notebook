// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Widget } from '@lumino/widgets';
import { Signal, ISignal } from '@lumino/signaling';

import NotebookModel from './model';
import CellLocking, { ICellLock } from './collab/locks';
import UserAwareness, { IUser, UserActivityType } from './collab/awareness';
import CommentSystem, { IComment } from './collab/comments';
import { ICollaborativeRole, PermissionAction } from './collab/permissions';

/**
 * Enumeration of collaborative cell states
 */
export enum CollaborativeCellState {
  IDLE = 'idle',
  EDITING = 'editing',
  LOCKED = 'locked',
  LOCKED_BY_OTHER = 'locked_by_other',
  EXECUTING = 'executing',
  ERROR = 'error',
  COMMENTING = 'commenting',
  OFFLINE = 'offline'
}

/**
 * Interface for collaborative cell lock status
 */
export interface ICellLockStatus {
  /** Whether the cell is currently locked */
  isLocked: boolean;
  /** User who owns the lock */
  lockOwner: string | null;
  /** Lock owner's user ID */
  lockOwnerId: string | null;
  /** Timestamp when lock expires */
  lockTimeout: number | null;
  /** Whether current user owns the lock */
  isOwnedByCurrentUser: boolean;
  /** Lock acquisition time */
  lockAcquiredAt: number | null;
  /** Session ID of lock owner */
  lockSessionId: string | null;
}

/**
 * Interface for user presence information in cells
 */
export interface ICellUserPresence {
  /** List of users currently active in this cell */
  activeUsers: IUser[];
  /** Current user information */
  currentUser: IUser | null;
  /** Users currently editing this cell */
  editingUsers: IUser[];
  /** Users currently viewing this cell */
  viewingUsers: IUser[];
  /** Total number of active users in this cell */
  userCount: number;
}

/**
 * Interface for cell comment information
 */
export interface ICellComments {
  /** List of comments attached to this cell */
  comments: IComment[];
  /** Number of unresolved comments */
  unresolvedCount: number;
  /** Number of total comments */
  totalCount: number;
  /** Whether comments are currently visible */
  isVisible: boolean;
  /** Whether current user can add comments */
  canComment: boolean;
}

/**
 * Interface for cell collaboration permissions
 */
export interface ICellPermissions {
  /** User's role for this cell */
  role: ICollaborativeRole;
  /** Whether user can view this cell */
  canView: boolean;
  /** Whether user can edit this cell */
  canEdit: boolean;
  /** Whether user can execute this cell */
  canExecute: boolean;
  /** Whether user can comment on this cell */
  canComment: boolean;
  /** Whether user can manage permissions for this cell */
  canManagePermissions: boolean;
  /** Whether user can lock this cell */
  canLock: boolean;
}

/**
 * Interface for collaborative cell collaboration state
 */
export interface ICellCollaborationState {
  /** Cell identifier */
  cellId: string;
  /** Whether cell is locked */
  isLocked: boolean;
  /** Lock owner information */
  lockOwner: string | null;
  /** Lock timeout timestamp */
  lockTimeout: number | null;
  /** Active users in this cell */
  activeUsers: IUser[];
  /** Current user permissions */
  permissions: ICellPermissions;
  /** Cell comments */
  comments: IComment[];
  /** Last modification timestamp */
  lastModified: number;
  /** Whether collaboration is enabled */
  collaborationEnabled: boolean;
}

/**
 * Interface for collaborative cell features
 */
export interface ICellCollaborationFeatures {
  /** Lock status information */
  lockStatus: ICellLockStatus;
  /** User presence information */
  userPresence: ICellUserPresence;
  /** Comment information */
  comments: ICellComments;
  /** Permission information */
  permissions: ICellPermissions;
  /** Acquire lock for exclusive editing */
  acquireLock(): Promise<boolean>;
  /** Release lock */
  releaseLock(): Promise<boolean>;
  /** Check if cell is locked */
  isLocked(): boolean;
  /** Check if user can edit */
  canEdit(): boolean;
  /** Check if user can execute */
  canExecute(): boolean;
  /** Add comment to cell */
  addComment(content: string): Promise<IComment>;
  /** Get comments for cell */
  getComments(): Promise<IComment[]>;
  /** Update user presence */
  updateUserPresence(activity: UserActivityType): void;
  /** Check permission for action */
  checkPermission(action: PermissionAction): boolean;
  /** Signal emitted when lock state changes */
  onLockStateChanged: ISignal<ICellCollaborationFeatures, ICellLockStatus>;
  /** Signal emitted when user presence changes */
  onUserPresenceChanged: ISignal<ICellCollaborationFeatures, ICellUserPresence>;
  /** Signal emitted when comment is added */
  onCommentAdded: ISignal<ICellCollaborationFeatures, IComment>;
  /** Signal emitted when permissions change */
  onPermissionChanged: ISignal<ICellCollaborationFeatures, ICellPermissions>;
}

/**
 * Base class for collaborative cells with locking, presence, and comment features
 */
export class CollaborativeCell extends Widget implements ICellCollaborationFeatures {
  private _model: NotebookModel;
  protected _cellId: string;
  private _cellLocking: CellLocking;
  private _userAwareness: UserAwareness | null;
  private _commentSystem: CommentSystem;
  private _editor: any = null;
  private _collaborationDisposed = false;

  // Collaboration state
  private _lockStatus!: ICellLockStatus;
  private _userPresence!: ICellUserPresence;
  private _comments!: ICellComments;
  private _permissions!: ICellPermissions;
  private _collaborationState: CollaborativeCellState = CollaborativeCellState.IDLE;

  // Visual indicators
  private _lockIndicator!: CellLockIndicator;
  private _presenceIndicator!: UserPresenceIndicator;
  private _commentPanel!: CellCommentPanel;

  // Signals
  private _onLockStateChanged = new Signal<ICellCollaborationFeatures, ICellLockStatus>(this);
  private _onUserPresenceChanged = new Signal<ICellCollaborationFeatures, ICellUserPresence>(this);
  private _onCommentAdded = new Signal<ICellCollaborationFeatures, IComment>(this);
  private _onPermissionChanged = new Signal<ICellCollaborationFeatures, ICellPermissions>(this);

  /**
   * Construct a new CollaborativeCell
   *
   * @param model - The notebook model
   * @param cellId - The cell identifier
   * @param options - Additional options
   */
  constructor(model: NotebookModel, cellId: string, options: any = {}) {
    super();
    
    this._model = model;
    this._cellId = cellId;
    this._cellLocking = (model as any)._cellLocking || null;
    this._userAwareness = model.awareness || null;
    this._commentSystem = (model as any)._commentSystem || null;

    // Initialize collaboration state
    this._initializeCollaborationState();

    // Initialize visual indicators
    this._initializeVisualIndicators();

    // Set up event handlers
    this._setupEventHandlers();

    // Add CSS classes
    this.addClass('jp-CollaborativeCell');
    this.addClass('jp-Cell');
  }

  /**
   * Get the cell model
   */
  get model(): NotebookModel {
    return this._model;
  }

  /**
   * Get the cell ID
   */
  get cellId(): string {
    return this._cellId;
  }

  /**
   * Get the cell editor
   */
  get editor(): any {
    return this._editor;
  }

  /**
   * Set the cell editor
   */
  set editor(editor: any) {
    this._editor = editor;
    if (editor) {
      this._setupEditorIntegration();
    }
  }

  /**
   * Get current lock status
   */
  get lockStatus(): ICellLockStatus {
    return { ...this._lockStatus };
  }

  /**
   * Get current collaboration state
   */
  get collaborationState(): CollaborativeCellState {
    return this._collaborationState;
  }

  /**
   * Get current user presence
   */
  get userPresence(): ICellUserPresence {
    return { ...this._userPresence };
  }

  /**
   * Get current comments
   */
  get comments(): ICellComments {
    return { ...this._comments };
  }

  /**
   * Get current permissions
   */
  get permissions(): ICellPermissions {
    return { ...this._permissions };
  }

  /**
   * Signal emitted when lock state changes
   */
  get onLockStateChanged(): ISignal<ICellCollaborationFeatures, ICellLockStatus> {
    return this._onLockStateChanged;
  }

  /**
   * Signal emitted when user presence changes
   */
  get onUserPresenceChanged(): ISignal<ICellCollaborationFeatures, ICellUserPresence> {
    return this._onUserPresenceChanged;
  }

  /**
   * Signal emitted when comment is added
   */
  get onCommentAdded(): ISignal<ICellCollaborationFeatures, IComment> {
    return this._onCommentAdded;
  }

  /**
   * Signal emitted when permissions change
   */
  get onPermissionChanged(): ISignal<ICellCollaborationFeatures, ICellPermissions> {
    return this._onPermissionChanged;
  }

  /**
   * Acquire lock for exclusive editing
   */
  async acquireLock(): Promise<boolean> {
    if (!this._cellLocking || this._collaborationDisposed) {
      return false;
    }

    try {
      const lock = await this._cellLocking.acquireLock(this._cellId, {
        timeout: 300000, // 5 minutes
        heartbeatInterval: 30000, // 30 seconds
        enableVisualIndicators: true
      });

      if (lock) {
        this._updateLockStatus(lock);
        this._updateCollaborationState(CollaborativeCellState.LOCKED);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      return false;
    }
  }

  /**
   * Release lock
   */
  async releaseLock(): Promise<boolean> {
    if (!this._cellLocking || this._collaborationDisposed) {
      return false;
    }

    try {
      const success = await this._cellLocking.releaseLock(this._cellId);
      if (success) {
        this._updateLockStatus(null);
        this._updateCollaborationState(CollaborativeCellState.IDLE);
      }
      return success;
    } catch (error) {
      console.error('Failed to release lock:', error);
      return false;
    }
  }

  /**
   * Check if cell is locked
   */
  isLocked(): boolean {
    return this._lockStatus.isLocked;
  }

  /**
   * Check if user can edit
   */
  canEdit(): boolean {
    return this._permissions.canEdit && (!this.isLocked() || this._lockStatus.isOwnedByCurrentUser);
  }

  /**
   * Check if user can execute
   */
  canExecute(): boolean {
    return this._permissions.canExecute && (!this.isLocked() || this._lockStatus.isOwnedByCurrentUser);
  }

  /**
   * Add comment to cell
   */
  async addComment(content: string): Promise<IComment> {
    if (!this._commentSystem || !this._permissions.canComment) {
      throw new Error('Cannot add comment: insufficient permissions');
    }

    const comment = await this._commentSystem.createComment(
      this._cellId,
      content,
      this._userAwareness?.getCurrentUser()?.displayName || 'Anonymous'
    );

    await this._updateComments();
    this._onCommentAdded.emit(comment);
    return comment;
  }

  /**
   * Get comments for cell
   */
  async getComments(): Promise<IComment[]> {
    if (!this._commentSystem) {
      return [];
    }
    return await this._commentSystem.getCommentsForCell(this._cellId);
  }

  /**
   * Update user presence
   */
  updateUserPresence(activity: UserActivityType): void {
    if (!this._userAwareness) {
      return;
    }

    const currentUser = this._userAwareness.getCurrentUser();
    if (!currentUser) {
      return;
    }

    this._userAwareness.trackUserActivity(currentUser.id, {
      userId: currentUser.id,
      activity,
      cellId: this._cellId,
      timestamp: Date.now(),
      type: activity,
      isActive: true
    });

    this._updateUserPresence();
  }

  /**
   * Check permission for action
   */
  checkPermission(action: PermissionAction): boolean {
    switch (action) {
      case PermissionAction.VIEW:
        return this._permissions.canView;
      case PermissionAction.EDIT:
        return this.canEdit();
      case PermissionAction.EXECUTE:
        return this.canExecute();
      case PermissionAction.COMMENT:
        return this._permissions.canComment;
      case PermissionAction.MANAGE_PERMISSIONS:
        return this._permissions.canManagePermissions;
      case PermissionAction.LOCK_CELL:
        return this._permissions.canLock;
      default:
        return false;
    }
  }

  /**
   * Show comments panel
   */
  showComments(): void {
    if (this._commentPanel) {
      this._commentPanel.show();
    }
  }

  /**
   * Hide comments panel
   */
  hideComments(): void {
    if (this._commentPanel) {
      this._commentPanel.hide();
    }
  }

  /**
   * Check if disposed
   */
  get isDisposed(): boolean {
    return this._collaborationDisposed || Boolean(this.disposed);
  }

  /**
   * Dispose of the cell
   */
  dispose(): void {
    if (this._collaborationDisposed) {
      return;
    }

    this._collaborationDisposed = true;

    // Release any held locks
    if (this._lockStatus.isOwnedByCurrentUser) {
      this.releaseLock().catch(console.error);
    }

    // Dispose visual indicators
    if (this._lockIndicator) {
      this._lockIndicator.dispose();
    }
    if (this._presenceIndicator) {
      this._presenceIndicator.dispose();
    }
    if (this._commentPanel) {
      this._commentPanel.dispose();
    }

    // Clean up event handlers
    this._cleanupEventHandlers();

    // Clear signals
    Signal.clearData(this);
    
    // Note: Widget's dispose method is private, so we don't call super.dispose()
    // The Widget class will handle its own disposal when needed
  }

  /**
   * Initialize collaboration state
   */
  private _initializeCollaborationState(): void {
    // Initialize lock status
    this._lockStatus = {
      isLocked: false,
      lockOwner: null,
      lockOwnerId: null,
      lockTimeout: null,
      isOwnedByCurrentUser: false,
      lockAcquiredAt: null,
      lockSessionId: null
    };

    // Initialize user presence
    this._userPresence = {
      activeUsers: [],
      currentUser: this._userAwareness?.getCurrentUser() || null,
      editingUsers: [],
      viewingUsers: [],
      userCount: 0
    };

    // Initialize comments
    this._comments = {
      comments: [],
      unresolvedCount: 0,
      totalCount: 0,
      isVisible: false,
      canComment: true
    };

    // Initialize permissions
    this._permissions = {
      role: {
        role: 'editor',
        permissions: [PermissionAction.VIEW, PermissionAction.EDIT, PermissionAction.EXECUTE, PermissionAction.COMMENT],
        canView: true,
        canEdit: true,
        canExecute: true,
        canComment: true,
        canInvite: false,
        canManagePermissions: false
      },
      canView: true,
      canEdit: true,
      canExecute: true,
      canComment: true,
      canManagePermissions: false,
      canLock: true
    };

    // Update initial state
    this._updateLockStatus(null);
    this._updateUserPresence();
    this._updateComments().catch(console.error);
  }

  /**
   * Initialize visual indicators
   */
  private _initializeVisualIndicators(): void {
    // Create lock indicator
    this._lockIndicator = new CellLockIndicator(this);
    this.node.appendChild(this._lockIndicator.node);

    // Create presence indicator
    this._presenceIndicator = new UserPresenceIndicator(this);
    this.node.appendChild(this._presenceIndicator.node);

    // Create comment panel
    this._commentPanel = new CellCommentPanel(this);
    this.node.appendChild(this._commentPanel.node);
  }

  /**
   * Set up event handlers
   */
  private _setupEventHandlers(): void {
    // Lock state change handler
    if (this._cellLocking) {
      this._cellLocking.onLockStateChanged.connect(this._onLockStateChangedHandler, this);
    }

    // User presence change handler
    if (this._userAwareness) {
      this._userAwareness.onUsersChanged.connect(this._onUsersChangedHandler, this);
    }

    // Comment system handler
    if (this._commentSystem) {
      this._commentSystem.subscribeToComments(this._onCommentChangedHandler.bind(this));
    }
  }

  /**
   * Clean up event handlers
   */
  private _cleanupEventHandlers(): void {
    if (this._cellLocking) {
      this._cellLocking.onLockStateChanged.disconnect(this._onLockStateChangedHandler, this);
    }

    if (this._userAwareness) {
      this._userAwareness.onUsersChanged.disconnect(this._onUsersChangedHandler, this);
    }
  }

  /**
   * Set up editor integration
   */
  private _setupEditorIntegration(): void {
    if (!this._editor) {
      return;
    }

    // Set up editor event handlers for collaboration
    this._editor.model.value.changed.connect(() => {
      this.updateUserPresence(UserActivityType.EDITING);
    });

    // Set up cursor tracking
    this._editor.model.selections.changed.connect(() => {
      if (this._userAwareness) {
        // Update cursor position in awareness system
        const currentUser = this._userAwareness.getCurrentUser();
        if (currentUser) {
          this._userAwareness.updateUserCursor(currentUser.id, {
            cellId: this._cellId,
            line: 0, // Would need to get from editor
            column: 0, // Would need to get from editor
            character: 0, // Would need to get from editor
            offset: 0, // Would need to get from editor
            timestamp: Date.now(),
            userId: currentUser.id,
            isVisible: true
          });
        }
      }
    });
  }

  /**
   * Handle lock state changes
   */
  private _onLockStateChangedHandler(sender: any, event: any): void {
    if (event.cellId === this._cellId) {
      this._updateLockStatus(event.lock);
    }
  }

  /**
   * Handle user presence changes
   */
  private _onUsersChangedHandler(sender: any, users: any): void {
    this._updateUserPresence();
  }

  /**
   * Handle comment changes
   */
  private _onCommentChangedHandler(eventType: any, comment: any): void {
    this._updateComments().catch(console.error);
  }

  /**
   * Update lock status
   */
  private _updateLockStatus(lock: ICellLock | null): void {
    const currentUser = this._userAwareness?.getCurrentUser();
    
    if (lock) {
      this._lockStatus = {
        isLocked: true,
        lockOwner: lock.owner,
        lockOwnerId: lock.ownerId,
        lockTimeout: lock.expiresAt,
        isOwnedByCurrentUser: currentUser ? lock.ownerId === currentUser.id : false,
        lockAcquiredAt: lock.acquiredAt,
        lockSessionId: lock.sessionId
      };
    } else {
      this._lockStatus = {
        isLocked: false,
        lockOwner: null,
        lockOwnerId: null,
        lockTimeout: null,
        isOwnedByCurrentUser: false,
        lockAcquiredAt: null,
        lockSessionId: null
      };
    }

    // Update visual indicators
    if (this._lockIndicator) {
      this._lockIndicator.update();
    }

    // Update editor state
    if (this._editor) {
      this._editor.setOption('readOnly', this._lockStatus.isLocked && !this._lockStatus.isOwnedByCurrentUser);
    }

    // Emit signal
    this._onLockStateChanged.emit(this._lockStatus);
  }

  /**
   * Update user presence
   */
  private _updateUserPresence(): void {
    if (!this._userAwareness) {
      return;
    }

    const cellUsers = this._userAwareness.getUsersByCell(this._cellId);
    const currentUser = this._userAwareness.getCurrentUser();

    this._userPresence = {
      activeUsers: cellUsers,
      currentUser,
      editingUsers: cellUsers.filter(user => user.activity === UserActivityType.EDITING),
      viewingUsers: cellUsers.filter(user => user.activity === UserActivityType.VIEWING),
      userCount: cellUsers.length
    };

    // Update visual indicators
    if (this._presenceIndicator) {
      this._presenceIndicator.update();
    }

    // Emit signal
    this._onUserPresenceChanged.emit(this._userPresence);
  }

  /**
   * Update comments
   */
  private async _updateComments(): Promise<void> {
    if (!this._commentSystem) {
      return;
    }

    const comments = await this._commentSystem.getCommentsForCell(this._cellId);
    const unresolvedComments = comments.filter(comment => !comment.resolved);

    this._comments = {
      comments,
      unresolvedCount: unresolvedComments.length,
      totalCount: comments.length,
      isVisible: this._commentPanel ? this._commentPanel.isVisible : false,
      canComment: this._permissions.canComment
    };

    // Update visual indicators
    if (this._commentPanel) {
      this._commentPanel.update();
    }
  }

  /**
   * Update collaboration state
   */
  private _updateCollaborationState(state: CollaborativeCellState): void {
    this._collaborationState = state;
    
    // Update CSS classes based on state
    this.removeClass('jp-CollaborativeCell-idle');
    this.removeClass('jp-CollaborativeCell-editing');
    this.removeClass('jp-CollaborativeCell-locked');
    this.removeClass('jp-CollaborativeCell-locked-by-other');
    this.removeClass('jp-CollaborativeCell-executing');
    this.removeClass('jp-CollaborativeCell-error');
    this.removeClass('jp-CollaborativeCell-commenting');
    this.removeClass('jp-CollaborativeCell-offline');
    
    this.addClass(`jp-CollaborativeCell-${state}`);
  }
}

/**
 * Visual indicator for cell lock status
 */
export class CellLockIndicator extends Widget {
  private _cell: CollaborativeCell;
  private _isLocked = false;
  private _lockOwner: string | null = null;
  private _lockTimeout: number | null = null;

  /**
   * Construct a new CellLockIndicator
   */
  constructor(cell: CollaborativeCell) {
    super();
    this._cell = cell;
    this.addClass('jp-CellLockIndicator');
    this.hide();
  }

  /**
   * Get whether the cell is locked
   */
  get isLocked(): boolean {
    return this._isLocked;
  }

  /**
   * Get the lock owner
   */
  get lockOwner(): string | null {
    return this._lockOwner;
  }

  /**
   * Get the lock timeout
   */
  get lockTimeout(): number | null {
    return this._lockTimeout;
  }

  /**
   * Show the lock indicator
   */
  show(): void {
    this.removeClass('jp-mod-hidden');
  }

  /**
   * Hide the lock indicator
   */
  hide(): void {
    this.addClass('jp-mod-hidden');
  }

  /**
   * Update the lock indicator
   */
  update(): void {
    const lockStatus = this._cell.lockStatus;
    this._isLocked = lockStatus.isLocked;
    this._lockOwner = lockStatus.lockOwner;
    this._lockTimeout = lockStatus.lockTimeout;

    if (this._isLocked) {
      this.show();
      this.render();
    } else {
      this.hide();
    }
  }

  /**
   * Render the lock indicator
   */
  render(): void {
    const lockStatus = this._cell.lockStatus;
    
    if (!lockStatus.isLocked) {
      this.node.innerHTML = '';
      return;
    }

    const isOwnLock = lockStatus.isOwnedByCurrentUser;
    const ownerName = lockStatus.lockOwner || 'Unknown';
    const timeoutStr = lockStatus.lockTimeout ? 
      new Date(lockStatus.lockTimeout).toLocaleTimeString() : 'No timeout';

    const lockIcon = isOwnLock ? '🔒' : '🔐';
    const lockClass = isOwnLock ? 'jp-CellLockIndicator-own' : 'jp-CellLockIndicator-other';

    this.node.innerHTML = `
      <div class="jp-CellLockIndicator-content ${lockClass}">
        <span class="jp-CellLockIndicator-icon">${lockIcon}</span>
        <span class="jp-CellLockIndicator-owner">${ownerName}</span>
        <span class="jp-CellLockIndicator-timeout">${timeoutStr}</span>
      </div>
    `;

    // Add event listeners for lock management
    if (isOwnLock) {
      const releaseButton = document.createElement('button');
      releaseButton.className = 'jp-CellLockIndicator-release';
      releaseButton.textContent = 'Release';
      releaseButton.onclick = () => {
        this._cell.releaseLock();
      };
      this.node.appendChild(releaseButton);
    }
  }

  /**
   * Handle lock state changes
   */
  onLockStateChanged(lockStatus: ICellLockStatus): void {
    this.update();
  }
}

/**
 * Visual indicator for user presence in cells
 */
export class UserPresenceIndicator extends Widget {
  private _cell: CollaborativeCell;
  private _activeUsers: IUser[] = [];
  private _currentUser: IUser | null = null;

  /**
   * Construct a new UserPresenceIndicator
   */
  constructor(cell: CollaborativeCell) {
    super();
    this._cell = cell;
    this.addClass('jp-UserPresenceIndicator');
  }

  /**
   * Get active users
   */
  get activeUsers(): IUser[] {
    return [...this._activeUsers];
  }

  /**
   * Get current user
   */
  get currentUser(): IUser | null {
    return this._currentUser;
  }

  /**
   * Show the presence indicator
   */
  show(): void {
    this.removeClass('jp-mod-hidden');
  }

  /**
   * Hide the presence indicator
   */
  hide(): void {
    this.addClass('jp-mod-hidden');
  }

  /**
   * Update the presence indicator
   */
  update(): void {
    const userPresence = this._cell.userPresence;
    this._activeUsers = userPresence.activeUsers;
    this._currentUser = userPresence.currentUser;
    this.render();
  }

  /**
   * Render the presence indicator
   */
  render(): void {
    const userPresence = this._cell.userPresence;
    
    if (userPresence.userCount === 0) {
      this.node.innerHTML = '';
      return;
    }

    const activeUsers = userPresence.activeUsers.slice(0, 5); // Show max 5 users
    const additionalCount = Math.max(0, userPresence.userCount - 5);

    this.node.innerHTML = `
      <div class="jp-UserPresenceIndicator-content">
        <div class="jp-UserPresenceIndicator-users">
          ${activeUsers.map(user => this._renderUserAvatar(user)).join('')}
          ${additionalCount > 0 ? `<span class="jp-UserPresenceIndicator-more">+${additionalCount}</span>` : ''}
        </div>
        <div class="jp-UserPresenceIndicator-count">${userPresence.userCount} active</div>
      </div>
    `;
  }

  /**
   * Render user avatar
   */
  private _renderUserAvatar(user: IUser): string {
    const avatar = user.avatar || this._generateAvatar(user.displayName);
    const activity = this._getActivityIcon(user.activity);
    
    return `
      <div class="jp-UserPresenceIndicator-user" title="${user.displayName} (${user.activity})" style="border-color: ${user.color}">
        <img src="${avatar}" alt="${user.displayName}" class="jp-UserPresenceIndicator-avatar" />
        <span class="jp-UserPresenceIndicator-activity">${activity}</span>
      </div>
    `;
  }

  /**
   * Generate avatar for user
   */
  private _generateAvatar(name: string): string {
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase();
    return `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#ccc"/><text x="12" y="17" text-anchor="middle" fill="white" font-size="10">${initials}</text></svg>`;
  }

  /**
   * Get activity icon
   */
  private _getActivityIcon(activity: UserActivityType): string {
    switch (activity) {
      case UserActivityType.EDITING: return '✏️';
      case UserActivityType.EXECUTING: return '▶️';
      case UserActivityType.VIEWING: return '👀';
      case UserActivityType.COMMENTING: return '💬';
      case UserActivityType.TYPING: return '⌨️';
      default: return '•';
    }
  }

  /**
   * Add user to presence
   */
  addUser(user: IUser): void {
    if (!this._activeUsers.find(u => u.id === user.id)) {
      this._activeUsers.push(user);
      this.render();
    }
  }

  /**
   * Remove user from presence
   */
  removeUser(userId: string): void {
    const index = this._activeUsers.findIndex(u => u.id === userId);
    if (index >= 0) {
      this._activeUsers.splice(index, 1);
      this.render();
    }
  }

  /**
   * Update user activity
   */
  updateUserActivity(userId: string, activity: UserActivityType): void {
    const user = this._activeUsers.find(u => u.id === userId);
    if (user) {
      user.activity = activity;
      this.render();
    }
  }

  /**
   * Handle user presence changes
   */
  onUserPresenceChanged(userPresence: ICellUserPresence): void {
    this.update();
  }
}

/**
 * Panel for displaying and managing cell comments
 */
export class CellCommentPanel extends Widget {
  private _cell: CollaborativeCell;
  private _comments: IComment[] = [];
  private _isVisible = false;

  /**
   * Construct a new CellCommentPanel
   */
  constructor(cell: CollaborativeCell) {
    super();
    this._cell = cell;
    this.addClass('jp-CellCommentPanel');
    this.hide();
  }

  /**
   * Get comments
   */
  get comments(): IComment[] {
    return [...this._comments];
  }

  /**
   * Get whether panel is visible
   */
  get isVisible(): boolean {
    return this._isVisible;
  }

  /**
   * Show the comment panel
   */
  show(): void {
    this._isVisible = true;
    this.removeClass('jp-mod-hidden');
  }

  /**
   * Hide the comment panel
   */
  hide(): void {
    this._isVisible = false;
    this.addClass('jp-mod-hidden');
  }

  /**
   * Toggle comment panel visibility
   */
  toggle(): void {
    if (this._isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Update the comment panel
   */
  update(): void {
    const cellComments = this._cell.comments;
    this._comments = cellComments.comments;
    this.render();
  }

  /**
   * Add comment to cell
   */
  async addComment(content: string): Promise<void> {
    try {
      await this._cell.addComment(content);
      this.update();
    } catch (error) {
      console.error('Failed to add comment:', error);
    }
  }

  /**
   * Update comment
   */
  async updateComment(commentId: string, content: string): Promise<void> {
    // Implementation would call comment system update method
    console.log('Update comment:', commentId, content);
  }

  /**
   * Delete comment
   */
  async deleteComment(commentId: string): Promise<void> {
    // Implementation would call comment system delete method
    console.log('Delete comment:', commentId);
  }

  /**
   * Resolve comment
   */
  async resolveComment(commentId: string): Promise<void> {
    // Implementation would call comment system resolve method
    console.log('Resolve comment:', commentId);
  }

  /**
   * Render the comment panel
   */
  render(): void {
    const cellComments = this._cell.comments;
    
    this.node.innerHTML = `
      <div class="jp-CellCommentPanel-header">
        <span class="jp-CellCommentPanel-title">Comments (${cellComments.totalCount})</span>
        <button class="jp-CellCommentPanel-toggle" onclick="this.parentElement.parentElement.parentElement.hide()">×</button>
      </div>
      <div class="jp-CellCommentPanel-content">
        ${cellComments.comments.map(comment => this._renderComment(comment)).join('')}
      </div>
      <div class="jp-CellCommentPanel-input">
        <textarea class="jp-CellCommentPanel-textarea" placeholder="Add a comment..."></textarea>
        <button class="jp-CellCommentPanel-submit" onclick="this.parentElement.parentElement.addComment(this.parentElement.querySelector('textarea').value)">Add Comment</button>
      </div>
    `;
  }

  /**
   * Render individual comment
   */
  private _renderComment(comment: IComment): string {
    const timestamp = new Date(comment.timestamp).toLocaleString();
    const resolvedClass = comment.resolved ? 'jp-Comment-resolved' : '';
    
    return `
      <div class="jp-Comment ${resolvedClass}" data-comment-id="${comment.id}">
        <div class="jp-Comment-header">
          <span class="jp-Comment-author">${comment.author.displayName}</span>
          <span class="jp-Comment-timestamp">${timestamp}</span>
          ${comment.resolved ? '<span class="jp-Comment-resolved-badge">Resolved</span>' : ''}
        </div>
        <div class="jp-Comment-content">${comment.content}</div>
        <div class="jp-Comment-actions">
          <button class="jp-Comment-reply" onclick="this.parentElement.parentElement.parentElement.parentElement.replyToComment('${comment.id}')">Reply</button>
          ${!comment.resolved ? `<button class="jp-Comment-resolve" onclick="this.parentElement.parentElement.parentElement.parentElement.resolveComment('${comment.id}')">Resolve</button>` : ''}
          <button class="jp-Comment-delete" onclick="this.parentElement.parentElement.parentElement.parentElement.deleteComment('${comment.id}')">Delete</button>
        </div>
        ${comment.replies.length > 0 ? `<div class="jp-Comment-replies">${comment.replies.map(replyId => this._renderReply(replyId)).join('')}</div>` : ''}
      </div>
    `;
  }

  /**
   * Render comment reply
   */
  private _renderReply(replyId: string): string {
    // Implementation would fetch reply from comment system
    return `<div class="jp-Comment-reply">Reply ${replyId}</div>`;
  }

  /**
   * Handle comment events
   */
  onCommentAdded(comment: IComment): void {
    this.update();
  }

  onCommentUpdated(comment: IComment): void {
    this.update();
  }

  onCommentDeleted(commentId: string): void {
    this.update();
  }

  onCommentResolved(commentId: string): void {
    this.update();
  }
}

/**
 * Collaborative code cell implementation
 */
export class CollaborativeCodeCell extends CollaborativeCell {
  private _executed = false;
  private _executing = false;

  /**
   * Construct a new CollaborativeCodeCell
   */
  constructor(model: NotebookModel, cellId: string, options: any = {}) {
    super(model, cellId, options);
    this.addClass('jp-CollaborativeCodeCell');
    this.addClass('jp-CodeCell');
  }

  /**
   * Execute the code cell
   */
  async execute(): Promise<void> {
    if (!this.canExecute() || this._executing) {
      return;
    }

    this._executing = true;
    this.updateUserPresence(UserActivityType.EXECUTING);

    try {
      // Implementation would execute the cell
      console.log('Executing code cell:', this._cellId);
      
      // Simulate execution delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      this._executed = true;
      this.updateUserPresence(UserActivityType.VIEWING);
    } catch (error) {
      console.error('Failed to execute cell:', error);
      this.updateUserPresence(UserActivityType.VIEWING);
    } finally {
      this._executing = false;
    }
  }

  /**
   * Check if cell is executing
   */
  get isExecuting(): boolean {
    return this._executing;
  }

  /**
   * Check if cell has been executed
   */
  get executed(): boolean {
    return this._executed;
  }
}

/**
 * Collaborative markdown cell implementation
 */
export class CollaborativeMarkdownCell extends CollaborativeCell {
  private _rendered = false;

  /**
   * Construct a new CollaborativeMarkdownCell
   */
  constructor(model: NotebookModel, cellId: string, options: any = {}) {
    super(model, cellId, options);
    this.addClass('jp-CollaborativeMarkdownCell');
    this.addClass('jp-MarkdownCell');
  }

  /**
   * Get rendered state
   */
  get rendered(): boolean {
    return this._rendered;
  }

  /**
   * Render the markdown cell
   */
  async render(): Promise<void> {
    if (!this.canEdit()) {
      return;
    }

    try {
      // Implementation would render markdown
      console.log('Rendering markdown cell:', this._cellId);
      this._rendered = true;
      this.updateUserPresence(UserActivityType.VIEWING);
    } catch (error) {
      console.error('Failed to render markdown cell:', error);
    }
  }

  /**
   * Unrender the markdown cell
   */
  async unrender(): Promise<void> {
    if (!this.canEdit()) {
      return;
    }

    try {
      // Implementation would unrender markdown
      console.log('Unrendering markdown cell:', this._cellId);
      this._rendered = false;
      this.updateUserPresence(UserActivityType.EDITING);
    } catch (error) {
      console.error('Failed to unrender markdown cell:', error);
    }
  }
}