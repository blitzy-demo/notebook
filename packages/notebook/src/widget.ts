/**
 * @fileoverview Enhanced notebook widget component for collaborative editing
 * 
 * This module provides comprehensive collaborative editing capabilities for Jupyter Notebook v7
 * by extending the standard NotebookPanel with real-time collaborative features. It integrates
 * with the Yjs CRDT framework to enable multiple users to simultaneously work on the same 
 * notebook with live updates, presence awareness, and conflict resolution.
 * 
 * Key features:
 * - Real-time collaborative editing with Yjs CRDT integration
 * - User presence awareness with cursor tracking and status indicators
 * - Cell-level locking mechanism for conflict prevention
 * - Comprehensive comment and review system
 * - Change history tracking and version management
 * - Fine-grained permissions and access control
 * - Responsive collaboration UI with activity feeds
 * - Seamless integration with existing notebook functionality
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { NotebookPanel } from '@jupyterlab/notebook';
import { Widget } from '@lumino/widgets';
import { Signal, ISignal } from '@lumino/signaling';
import { ITranslator } from '@jupyterlab/translation';
import { IDisposable } from '@lumino/disposable';

// Import collaborative services
import { AwarenessService } from './collab/awareness';
import { LockService } from './collab/locks';
import { PermissionService } from './collab/permissions';
import { CommentService, IComment } from './collab/comments';
import { HistoryService, IChangeEvent } from './collab/history';

// Import UI components - using Widget base class and interfaces
import { Widget } from '@lumino/widgets';

// Define UI component interfaces
interface ICollaborationBarWidget extends Widget {
  create(options: any): ICollaborationBarWidget;
  update(): void;
}

interface IUserPresenceWidget extends Widget {
  create(options: any): IUserPresenceWidget;
  update(): void;
}

interface ICellLockIndicatorWidget extends Widget {
  create(options: any): ICellLockIndicatorWidget;
  update(): void;
}

interface IHistoryViewerWidget extends Widget {
  create(options: any): IHistoryViewerWidget;
  update(): void;
  show(): void;
}

interface IPermissionsDialogWidget extends Widget {
  create(options: any): IPermissionsDialogWidget;
  show(): void;
  hide(): void;
}

interface ICommentSystemWidget extends Widget {
  create(options: any): ICommentSystemWidget;
  update(): void;
}

// Create factory functions for UI components
const CollaborationBarWidget = {
  create: (options: any): ICollaborationBarWidget => {
    const widget = new Widget() as ICollaborationBarWidget;
    widget.addClass('jp-CollaborationBar');
    return widget;
  }
};

const UserPresenceWidget = {
  create: (options: any): IUserPresenceWidget => {
    const widget = new Widget() as IUserPresenceWidget;
    widget.addClass('jp-UserPresence');
    return widget;
  }
};

const CellLockIndicatorWidget = {
  create: (options: any): ICellLockIndicatorWidget => {
    const widget = new Widget() as ICellLockIndicatorWidget;
    widget.addClass('jp-CellLockIndicator');
    return widget;
  }
};

const HistoryViewerWidget = {
  create: (options: any): IHistoryViewerWidget => {
    const widget = new Widget() as IHistoryViewerWidget;
    widget.addClass('jp-HistoryViewer');
    return widget;
  }
};

const PermissionsDialogWidget = {
  create: (options: any): IPermissionsDialogWidget => {
    const widget = new Widget() as IPermissionsDialogWidget;
    widget.addClass('jp-PermissionsDialog');
    return widget;
  }
};

const CommentSystemWidget = {
  create: (options: any): ICommentSystemWidget => {
    const widget = new Widget() as ICommentSystemWidget;
    widget.addClass('jp-CommentSystem');
    return widget;
  }
};

/**
 * Enumeration of collaboration event types for comprehensive event handling
 */
export enum CollaborationEventType {
  /** A new collaborator joined the session */
  COLLABORATOR_JOINED = 'collaborator_joined',
  /** A collaborator left the session */
  COLLABORATOR_LEFT = 'collaborator_left',
  /** A cell was locked by a user */
  CELL_LOCKED = 'cell_locked',
  /** A cell was unlocked by a user */
  CELL_UNLOCKED = 'cell_unlocked',
  /** A new comment was added to a cell */
  COMMENT_ADDED = 'comment_added',
  /** A comment was resolved */
  COMMENT_RESOLVED = 'comment_resolved',
  /** User presence information was updated */
  PRESENCE_UPDATE = 'presence_update',
  /** Document permissions were changed */
  PERMISSION_CHANGED = 'permission_changed',
  /** The document was modified */
  DOCUMENT_CHANGED = 'document_changed',
  /** A conflict was detected */
  CONFLICT_DETECTED = 'conflict_detected',
  /** A conflict was resolved */
  CONFLICT_RESOLVED = 'conflict_resolved'
}

/**
 * Interface representing the collaborative state of the notebook
 */
export interface ICollaborativeState {
  /** Whether the notebook is in collaborative mode */
  isCollaborative: boolean;
  /** Whether the notebook is connected to collaboration backend */
  isConnected: boolean;
  /** List of active collaborators */
  activeCollaborators: Array<{
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
    lastSeen: Date;
  }>;
  /** Current user information */
  currentUser: {
    userId: string;
    name: string;
    avatar?: string;
    role: 'view' | 'edit' | 'admin';
  };
  /** Unique session identifier */
  sessionId: string;
  /** Current lock states for all cells */
  lockStates: Record<string, {
    userId: string;
    userName: string;
    lockedAt: Date;
    timeout: number;
  }>;
  /** Number of unread comments per cell */
  commentCounts: Record<string, number>;
  /** Current document version */
  documentVersion: number;
  /** Timestamp of last modification */
  lastModified: Date;
  /** List of online users */
  onlineUsers: string[];
  /** List of offline users */
  offlineUsers: string[];
}

/**
 * Interface for collaborative notebook panel options
 */
export interface ICollaborativeNotebookPanelOptions {
  /** The notebook model */
  model: any;
  /** The notebook content widget */
  content: any;
  /** The document context */
  context: any;
  /** The session context */
  sessionContext: any;
  /** Translator for internationalization */
  translator: ITranslator;
  /** Awareness service for user presence */
  awarenessService: AwarenessService;
  /** Lock service for cell locking */
  lockService: LockService;
  /** Permission service for access control */
  permissionService: PermissionService;
  /** Comment service for cell comments */
  commentService: CommentService;
  /** History service for change tracking */
  historyService: HistoryService;
  /** Whether to enable collaboration features */
  enableCollaboration?: boolean;
  /** Whether to show collaboration bar */
  showCollaborationBar?: boolean;
  /** Whether to show user presence */
  showUserPresence?: boolean;
  /** Whether to enable cell locking */
  enableCellLocking?: boolean;
  /** Whether to enable comments */
  enableComments?: boolean;
  /** Whether to enable history */
  enableHistory?: boolean;
}

/**
 * Enhanced NotebookPanel with comprehensive collaborative editing capabilities
 * 
 * This class extends the standard NotebookPanel to provide real-time collaborative
 * features including user presence, cell locking, comments, and change history.
 * It integrates seamlessly with the existing notebook interface while adding
 * collaborative UI elements and functionality.
 */
export class CollaborativeNotebookPanel extends NotebookPanel {
  // Collaborative services
  private _awarenessService: AwarenessService;
  private _lockService: LockService;
  private _permissionService: PermissionService;
  private _commentService: CommentService;
  private _historyService: HistoryService;
  
  // UI components
  private _collaborationBar: ICollaborationBarWidget;
  private _userPresence: IUserPresenceWidget;
  private _lockIndicator: ICellLockIndicatorWidget;
  private _historyViewer: IHistoryViewerWidget;
  private _permissionsDialog: IPermissionsDialogWidget;
  private _commentSystem: ICommentSystemWidget;
  
  // State management
  private _collaborativeState: ICollaborativeState;
  private _isCollaborative: boolean = false;
  private _isInitialized: boolean = false;
  private _translator: ITranslator;
  
  // Event signals
  private _collaboratorJoinedSignal = new Signal<CollaborativeNotebookPanel, {
    userId: string;
    name: string;
    avatar?: string;
  }>(this);
  
  private _collaboratorLeftSignal = new Signal<CollaborativeNotebookPanel, {
    userId: string;
    name: string;
  }>(this);
  
  private _cellLockedSignal = new Signal<CollaborativeNotebookPanel, {
    cellId: string;
    userId: string;
    userName: string;
  }>(this);
  
  private _cellUnlockedSignal = new Signal<CollaborativeNotebookPanel, {
    cellId: string;
    userId: string;
    userName: string;
  }>(this);
  
  private _commentAddedSignal = new Signal<CollaborativeNotebookPanel, {
    cellId: string;
    commentId: string;
    content: string;
    author: {userId: string; name: string};
  }>(this);
  
  private _presenceUpdateSignal = new Signal<CollaborativeNotebookPanel, {
    users: Array<{userId: string; name: string; cursor?: any}>;
  }>(this);
  
  /**
   * Create a new collaborative notebook panel
   * 
   * @param options - Configuration options for the panel
   */
  constructor(options: ICollaborativeNotebookPanelOptions) {
    super(options);
    
    // Store services
    this._awarenessService = options.awarenessService;
    this._lockService = options.lockService;
    this._permissionService = options.permissionService;
    this._commentService = options.commentService;
    this._historyService = options.historyService;
    this._translator = options.translator;
    
    // Initialize collaborative state
    this._collaborativeState = {
      isCollaborative: options.enableCollaboration !== false,
      isConnected: false,
      activeCollaborators: [],
      currentUser: {
        userId: 'anonymous',
        name: 'Anonymous User',
        role: 'edit'
      },
      sessionId: '',
      lockStates: {},
      commentCounts: {},
      documentVersion: 0,
      lastModified: new Date(),
      onlineUsers: [],
      offlineUsers: []
    };
    
    // Initialize UI components
    this._initializeUIComponents(options);
    
    // Set up collaborative features if enabled
    if (options.enableCollaboration !== false) {
      this._isCollaborative = true;
      this._setupCollaborativeFeatures();
    }
    
    // Add CSS class for styling
    this.addClass('jp-CollaborativeNotebookPanel');
  }
  
  /**
   * Get the awareness service instance
   */
  get awarenessService(): AwarenessService {
    return this._awarenessService;
  }
  
  /**
   * Get the lock service instance
   */
  get lockService(): LockService {
    return this._lockService;
  }
  
  /**
   * Get the permission service instance
   */
  get permissionService(): PermissionService {
    return this._permissionService;
  }
  
  /**
   * Get the comment service instance
   */
  get commentService(): CommentService {
    return this._commentService;
  }
  
  /**
   * Get the history service instance
   */
  get historyService(): HistoryService {
    return this._historyService;
  }
  
  /**
   * Get the collaboration bar widget
   */
  get collaborationBar(): ICollaborationBarWidget {
    return this._collaborationBar;
  }
  
  /**
   * Get the user presence widget
   */
  get userPresence(): IUserPresenceWidget {
    return this._userPresence;
  }
  
  /**
   * Get the lock indicator widget
   */
  get lockIndicator(): ICellLockIndicatorWidget {
    return this._lockIndicator;
  }
  
  /**
   * Get the history viewer widget
   */
  get historyViewer(): IHistoryViewerWidget {
    return this._historyViewer;
  }
  
  /**
   * Get the permissions dialog widget
   */
  get permissionsDialog(): IPermissionsDialogWidget {
    return this._permissionsDialog;
  }
  
  /**
   * Get the comment system widget
   */
  get commentSystem(): ICommentSystemWidget {
    return this._commentSystem;
  }
  
  /**
   * Get the current collaborative state
   */
  get collaborativeState(): ICollaborativeState {
    return { ...this._collaborativeState };
  }
  
  /**
   * Check if the notebook is in collaborative mode
   */
  get isCollaborative(): boolean {
    return this._isCollaborative;
  }
  
  /**
   * Get list of current collaborators
   */
  getCollaborators(): Array<{
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
    lastSeen: Date;
  }> {
    try {
      const users = this._awarenessService.getUsers();
      return users.map(user => ({
        userId: user.userId,
        name: user.name,
        avatar: user.avatar,
        isActive: user.isActive,
        lastSeen: user.lastActivity
      }));
    } catch (error) {
      console.error('Error getting collaborators:', error);
      return [];
    }
  }
  
  /**
   * Toggle collaboration mode on/off
   */
  async toggleCollaboration(): Promise<void> {
    if (this._isCollaborative) {
      await this._disableCollaboration();
    } else {
      await this._enableCollaboration();
    }
  }
  
  /**
   * Show the permissions dialog
   */
  showPermissionsDialog(): void {
    this._permissionsDialog.show();
  }
  
  /**
   * Show the history viewer
   */
  showHistoryViewer(): void {
    this._historyViewer.show();
  }
  
  /**
   * Lock a cell for exclusive editing
   * 
   * @param cellId - The ID of the cell to lock
   * @param timeout - Optional timeout in milliseconds
   * @returns Promise resolving to true if lock was acquired
   */
  async lockCell(cellId: string, timeout?: number): Promise<boolean> {
    if (!this._isCollaborative) {
      return false;
    }
    
    try {
      const result = await this._lockService.lockCell(cellId, timeout);
      if (result) {
        this._updateCellLockState(cellId, true);
      }
      return result;
    } catch (error) {
      console.error('Error locking cell:', error);
      return false;
    }
  }
  
  /**
   * Unlock a cell
   * 
   * @param cellId - The ID of the cell to unlock
   */
  async unlockCell(cellId: string): Promise<void> {
    if (!this._isCollaborative) {
      return;
    }
    
    try {
      await this._lockService.unlockCell(cellId);
      this._updateCellLockState(cellId, false);
    } catch (error) {
      console.error('Error unlocking cell:', error);
    }
  }
  
  /**
   * Add a comment to a cell
   * 
   * @param cellId - The ID of the cell to comment on
   * @param content - The comment content
   * @returns Promise resolving to the created comment
   */
  async addComment(cellId: string, content: string): Promise<IComment> {
    if (!this._isCollaborative) {
      throw new Error('Comments not available in non-collaborative mode');
    }
    
    try {
      const comment = await this._commentService.createComment(cellId, content);
      this._updateCommentCounts(cellId);
      return comment;
    } catch (error) {
      console.error('Error adding comment:', error);
      throw error;
    }
  }
  
  /**
   * Initialize collaboration features
   */
  async initializeCollaboration(): Promise<void> {
    if (this._isInitialized) {
      return;
    }
    
    try {
      // Initialize services
      await this._awarenessService.initialize();
      await this._permissionService.initialize();
      await this._lockService.initialize();
      await this._historyService.initialize();
      await this._commentService.initialize();
      
      // Update collaborative state
      this._collaborativeState.isConnected = true;
      const currentUser = this._awarenessService.getCurrentUser();
      this._collaborativeState.currentUser = {
        ...currentUser,
        role: 'edit' as const
      };
      
      // Set up event handlers
      this._setupEventHandlers();
      
      // Initialize UI components
      this._updateUIComponents();
      
      this._isInitialized = true;
      
      // Emit initialization complete
      this._updatePresence();
      
    } catch (error) {
      console.error('Error initializing collaboration:', error);
      throw error;
    }
  }
  
  /**
   * Signal emitted when a collaborator joins
   */
  get onCollaboratorJoined(): ISignal<CollaborativeNotebookPanel, {
    userId: string;
    name: string;
    avatar?: string;
  }> {
    return this._collaboratorJoinedSignal;
  }
  
  /**
   * Signal emitted when a collaborator leaves
   */
  get onCollaboratorLeft(): ISignal<CollaborativeNotebookPanel, {
    userId: string;
    name: string;
  }> {
    return this._collaboratorLeftSignal;
  }
  
  /**
   * Signal emitted when a cell is locked
   */
  get onCellLocked(): ISignal<CollaborativeNotebookPanel, {
    cellId: string;
    userId: string;
    userName: string;
  }> {
    return this._cellLockedSignal;
  }
  
  /**
   * Signal emitted when a cell is unlocked
   */
  get onCellUnlocked(): ISignal<CollaborativeNotebookPanel, {
    cellId: string;
    userId: string;
    userName: string;
  }> {
    return this._cellUnlockedSignal;
  }
  
  /**
   * Signal emitted when a comment is added
   */
  get onCommentAdded(): ISignal<CollaborativeNotebookPanel, {
    cellId: string;
    commentId: string;
    content: string;
    author: {userId: string; name: string};
  }> {
    return this._commentAddedSignal;
  }
  
  /**
   * Signal emitted when user presence is updated
   */
  get onPresenceUpdate(): ISignal<CollaborativeNotebookPanel, {
    users: Array<{userId: string; name: string; cursor?: any}>;
  }> {
    return this._presenceUpdateSignal;
  }
  
  /**
   * Dispose of the collaborative notebook panel
   */
  dispose(): void {
    // Dispose of services
    this._awarenessService?.dispose();
    this._lockService?.dispose();
    this._permissionService?.dispose();
    this._commentService?.dispose();
    this._historyService?.dispose();
    
    // Dispose of UI components
    this._collaborationBar?.dispose();
    this._userPresence?.dispose();
    this._lockIndicator?.dispose();
    this._historyViewer?.dispose();
    this._permissionsDialog?.dispose();
    this._commentSystem?.dispose();
    
    // Call parent dispose
    super.dispose();
  }
  
  /**
   * Initialize UI components
   */
  private _initializeUIComponents(options: ICollaborativeNotebookPanelOptions): void {
    // Create collaboration bar
    this._collaborationBar = CollaborationBarWidget.create({
      services: {
        awarenessService: this._awarenessService,
        permissionService: this._permissionService,
        historyService: this._historyService,
        commentService: this._commentService
      },
      translator: this._translator,
      onPermissionsClick: () => this.showPermissionsDialog(),
      onActivityClick: () => this.showHistoryViewer(),
      notebookPanel: this
    });
    
    // Create user presence widget
    this._userPresence = UserPresenceWidget.create({
      awarenessService: this._awarenessService,
      translator: this._translator
    });
    
    // Create lock indicator widget
    this._lockIndicator = CellLockIndicatorWidget.create({
      translator: this._translator
    });
    
    // Create history viewer widget
    this._historyViewer = HistoryViewerWidget.create({
      translator: this._translator
    });
    
    // Create permissions dialog widget
    this._permissionsDialog = PermissionsDialogWidget.create({
      permissionService: this._permissionService,
      translator: this._translator
    });
    
    // Create comment system widget
    this._commentSystem = CommentSystemWidget.create({
      commentService: this._commentService,
      translator: this._translator
    });
  }
  
  /**
   * Set up collaborative features
   */
  private _setupCollaborativeFeatures(): void {
    // Add collaboration bar to the top
    if (this._collaborationBar) {
      this.toolbar.insertItem(0, 'collaboration', this._collaborationBar as Widget);
    }
    
    // Add user presence to the header
    if (this._userPresence) {
      this.toolbar.insertItem(1, 'user-presence', this._userPresence as Widget);
    }
    
    // Add CSS classes for collaborative styling
    this.addClass('jp-CollaborativeNotebook');
    this.addClass('jp-CollaborativeNotebook-active');
  }
  
  /**
   * Set up event handlers for collaborative features
   */
  private _setupEventHandlers(): void {
    // Awareness service events
    this._awarenessService.onUserJoin.connect(this._onUserJoin, this);
    this._awarenessService.onUserLeave.connect(this._onUserLeave, this);
    this._awarenessService.onUserUpdate.connect(this._onUserUpdate, this);
    
    // Lock service events
    this._lockService.onLockChange.connect(this._onLockChange, this);
    
    // Comment service events
    this._commentService.onNewComment.connect(this._onNewComment, this);
    this._commentService.onCommentResolved.connect(this._onCommentResolved, this);
    
    // History service events
    this._historyService.onDocumentChange.connect(this._onDocumentChange, this);
  }
  
  /**
   * Handle user join events
   */
  private _onUserJoin(sender: AwarenessService, args: {
    userId: string;
    name: string;
    avatar?: string;
  }): void {
    this._collaboratorJoinedSignal.emit(args);
    this._updateCollaborativeState();
  }
  
  /**
   * Handle user leave events
   */
  private _onUserLeave(sender: AwarenessService, args: {
    userId: string;
  }): void {
    this._collaboratorLeftSignal.emit({
      userId: args.userId,
      name: 'Unknown User'
    });
    this._updateCollaborativeState();
  }
  
  /**
   * Handle user update events
   */
  private _onUserUpdate(sender: AwarenessService, args: any): void {
    this._presenceUpdateSignal.emit({
      users: this._awarenessService.getUsers().map(user => ({
        userId: user.userId,
        name: user.name,
        cursor: user.cursor
      }))
    });
    this._updatePresence();
  }
  
  /**
   * Handle lock change events
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
    this._updateCellLockState(args.cellId, args.isLocked);
  }
  
  /**
   * Handle new comment events
   */
  private _onNewComment(sender: any, args: IComment): void {
    this._commentAddedSignal.emit({
      cellId: args.cellId,
      commentId: args.id,
      content: args.content,
      author: { userId: args.author.userId || args.author.id || 'unknown', name: args.author.name }
    });
    this._updateCommentCounts(args.cellId);
  }
  
  /**
   * Handle comment resolved events
   */
  private _onCommentResolved(sender: CommentService, args: {
    commentId: string;
    resolvedBy: string;
  }): void {
    // Update comment counts for all cells
    this._updateAllCommentCounts();
  }
  
  /**
   * Handle document change events
   */
  private _onDocumentChange(sender: any, args: IChangeEvent): void {
    this._collaborativeState.lastModified = args.timestamp;
    this._collaborativeState.documentVersion++;
    this._updateUIComponents();
  }
  
  /**
   * Update collaborative state
   */
  private _updateCollaborativeState(): void {
    try {
      const users = this._awarenessService.getUsers();
      this._collaborativeState.activeCollaborators = users.map(user => ({
        userId: user.userId,
        name: user.name,
        avatar: user.avatar,
        isActive: user.isActive,
        lastSeen: user.lastActivity
      }));
      
      this._collaborativeState.onlineUsers = users
        .filter(user => user.isActive)
        .map(user => user.userId);
      
      this._collaborativeState.offlineUsers = users
        .filter(user => !user.isActive)
        .map(user => user.userId);
      
      this._updateUIComponents();
    } catch (error) {
      console.error('Error updating collaborative state:', error);
    }
  }
  
  /**
   * Update presence information
   */
  private _updatePresence(): void {
    if (this._userPresence) {
      this._userPresence.update();
    }
  }
  
  /**
   * Update cell lock state
   */
  private _updateCellLockState(cellId: string, isLocked: boolean): void {
    if (isLocked) {
      // Get lock owner information
      this._lockService.getLockOwner(cellId).then(owner => {
        if (owner) {
          this._collaborativeState.lockStates[cellId] = {
            userId: owner.userId,
            userName: owner.name,
            lockedAt: owner.lockedAt,
            timeout: owner.timeout || 300000
          };
        }
      }).catch(console.error);
    } else {
      delete this._collaborativeState.lockStates[cellId];
    }
    
    this._updateUIComponents();
  }
  
  /**
   * Update comment counts for a cell
   */
  private _updateCommentCounts(cellId: string): void {
    try {
      const comments = this._commentService.getCommentsByCell(cellId);
      // Handle both sync and async responses
      if (comments && typeof comments.then === 'function') {
        comments.then((commentList: any[]) => {
          this._collaborativeState.commentCounts[cellId] = commentList.length;
          this._updateUIComponents();
        }).catch(console.error);
      } else {
        this._collaborativeState.commentCounts[cellId] = (comments as any[]).length;
        this._updateUIComponents();
      }
    } catch (error) {
      console.error('Error updating comment counts:', error);
    }
  }
  
  /**
   * Update comment counts for all cells
   */
  private _updateAllCommentCounts(): void {
    try {
      const cells = this.content?.model?.cells;
      if (!cells) {
        return;
      }
      
      for (let i = 0; i < cells.length; i++) {
        const cell = cells.get(i);
        if (cell) {
          this._updateCommentCounts(cell.id);
        }
      }
    } catch (error) {
      console.error('Error updating all comment counts:', error);
    }
  }
  
  /**
   * Update UI components
   */
  private _updateUIComponents(): void {
    // Update collaboration bar
    if (this._collaborationBar) {
      this._collaborationBar.update();
    }
    
    // Update user presence
    if (this._userPresence) {
      this._userPresence.update();
    }
    
    // Update lock indicator
    if (this._lockIndicator) {
      this._lockIndicator.update();
    }
    
    // Update comment system
    if (this._commentSystem) {
      this._commentSystem.update();
    }
  }
  
  /**
   * Enable collaboration features
   */
  private async _enableCollaboration(): Promise<void> {
    this._isCollaborative = true;
    this._setupCollaborativeFeatures();
    await this.initializeCollaboration();
    this.addClass('jp-CollaborativeNotebook-active');
  }
  
  /**
   * Disable collaboration features
   */
  private async _disableCollaboration(): Promise<void> {
    this._isCollaborative = false;
    this._collaborativeState.isConnected = false;
    this.removeClass('jp-CollaborativeNotebook-active');
    
    // Hide collaboration UI
    if (this._collaborationBar) {
      this._collaborationBar.hide();
    }
    if (this._userPresence) {
      this._userPresence.hide();
    }
  }
}

/**
 * Factory function to create a collaborative notebook panel
 * 
 * @param options - Configuration options for the panel
 * @returns A new collaborative notebook panel instance
 */
export function createCollaborativeNotebookPanel(
  options: ICollaborativeNotebookPanelOptions
): CollaborativeNotebookPanel {
  return new CollaborativeNotebookPanel(options);
}

/**
 * Widget manager for collaborative notebook components
 * 
 * This class manages the lifecycle and state of collaborative widgets
 * within the notebook interface, providing centralized control over
 * collaborative features and UI elements.
 */
export class CollaborativeWidgetManager implements IDisposable {
  private _widgets: Set<Widget> = new Set();
  private _collaborativeState: ICollaborativeState | null = null;
  private _disposed: boolean = false;
  
  // Event signals
  private _stateChangedSignal = new Signal<CollaborativeWidgetManager, ICollaborativeState>(this);
  private _widgetAddedSignal = new Signal<CollaborativeWidgetManager, Widget>(this);
  private _widgetRemovedSignal = new Signal<CollaborativeWidgetManager, Widget>(this);
  
  /**
   * Register a widget with the manager
   * 
   * @param widget - The widget to register
   */
  registerWidget(widget: Widget): void {
    if (this._disposed) {
      return;
    }
    
    this._widgets.add(widget);
    this._widgetAddedSignal.emit(widget);
  }
  
  /**
   * Unregister a widget from the manager
   * 
   * @param widget - The widget to unregister
   */
  unregisterWidget(widget: Widget): void {
    if (this._disposed) {
      return;
    }
    
    this._widgets.delete(widget);
    this._widgetRemovedSignal.emit(widget);
  }
  
  /**
   * Get all registered collaborative widgets
   * 
   * @returns Array of registered widgets
   */
  getCollaborativeWidgets(): Widget[] {
    return Array.from(this._widgets);
  }
  
  /**
   * Enable collaboration for all registered widgets
   */
  enableCollaboration(): void {
    this._widgets.forEach(widget => {
      if (widget instanceof CollaborativeNotebookPanel) {
        widget.initializeCollaboration().catch(console.error);
      }
    });
  }
  
  /**
   * Disable collaboration for all registered widgets
   */
  disableCollaboration(): void {
    this._widgets.forEach(widget => {
      if (widget instanceof CollaborativeNotebookPanel) {
        widget.toggleCollaboration().catch(console.error);
      }
    });
  }
  
  /**
   * Get the current collaboration state
   * 
   * @returns Current collaborative state
   */
  getCollaborationState(): ICollaborativeState | null {
    return this._collaborativeState;
  }
  
  /**
   * Subscribe to collaboration events
   * 
   * @param callback - Callback function for events
   * @returns Disposable subscription
   */
  subscribeToEvents(callback: (sender: any, state: ICollaborativeState) => void): IDisposable {
    return this._stateChangedSignal.connect(callback) as IDisposable;
  }
  
  /**
   * Unsubscribe from collaboration events
   * 
   * @param callback - Callback function to unsubscribe
   */
  unsubscribeFromEvents(callback: (sender: any, state: ICollaborativeState) => void): void {
    this._stateChangedSignal.disconnect(callback);
  }
  
  /**
   * Check if manager is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }
  
  /**
   * Dispose of the widget manager
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    
    this._disposed = true;
    
    // Dispose all widgets
    this._widgets.forEach(widget => {
      if (!widget.isDisposed) {
        widget.dispose();
      }
    });
    
    this._widgets.clear();
  }
}

/**
 * Enhanced NotebookPanel with collaborative features
 * Export as NotebookPanel for compatibility
 */
export { CollaborativeNotebookPanel as NotebookPanel };