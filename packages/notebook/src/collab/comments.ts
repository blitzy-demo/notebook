// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { IDisposable, DisposableDelegate } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';

import { 
  JSONExt, 
  JSONObject, 
  JSONValue, 
  PartialJSONObject 
} from '@lumino/coreutils';

import { 
  IObservableMap, 
  ObservableMap 
} from '@jupyterlab/observables';

import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { User } from '@jupyterlab/services';

// Import collaboration dependencies (will be available from other collab files)
import { IYjsNotebookProvider } from './provider';
import { IPermissionsManager, PermissionLevel } from './permissions';

/**
 * Comment status enumeration
 */
export enum CommentStatus {
  /**
   * Comment is active and visible
   */
  Active = 'active',
  
  /**
   * Comment has been read by the current user
   */
  Read = 'read',
  
  /**
   * Comment is unread by the current user
   */
  Unread = 'unread',
  
  /**
   * Comment has been edited
   */
  Edited = 'edited',
  
  /**
   * Comment has been deleted
   */
  Deleted = 'deleted',
  
  /**
   * Comment is marked as resolved
   */
  Resolved = 'resolved'
}

/**
 * Comment visibility level
 */
export enum CommentVisibility {
  /**
   * Visible to all collaborators
   */
  Public = 'public',
  
  /**
   * Visible only to specific users
   */
  Private = 'private',
  
  /**
   * Visible only to editors and admins
   */
  Restricted = 'restricted'
}

/**
 * Comment reaction types
 */
export enum CommentReaction {
  Like = 'like',
  Dislike = 'dislike',
  Approve = 'approve',
  Question = 'question',
  Important = 'important'
}

/**
 * Interface for a comment reaction
 */
export interface ICommentReactionData {
  /**
   * The user who made the reaction
   */
  userId: string;
  
  /**
   * The user's display name
   */
  userName: string;
  
  /**
   * The type of reaction
   */
  reaction: CommentReaction;
  
  /**
   * When the reaction was added
   */
  timestamp: Date;
}

/**
 * Interface for comment positioning within a cell
 */
export interface ICommentPosition {
  /**
   * The cell ID this comment is attached to
   */
  cellId: string;
  
  /**
   * Optional line number within the cell (for code cells)
   */
  lineNumber?: number;
  
  /**
   * Optional character offset within the line
   */
  characterOffset?: number;
  
  /**
   * Optional selection range
   */
  selectionStart?: number;
  
  /**
   * Optional selection range end
   */
  selectionEnd?: number;
  
  /**
   * Optional anchor text for context
   */
  anchorText?: string;
}

/**
 * Interface for a single comment
 */
export interface IComment {
  /**
   * Unique identifier for the comment
   */
  id: string;
  
  /**
   * The cell ID this comment is associated with
   */
  cellId: string;
  
  /**
   * User ID who created the comment
   */
  userId: string;
  
  /**
   * Display name of the comment author
   */
  userName: string;
  
  /**
   * User email (optional)
   */
  userEmail?: string;
  
  /**
   * Avatar URL or color for the user
   */
  userAvatar?: string;
  
  /**
   * The comment content (supports markdown)
   */
  content: string;
  
  /**
   * When the comment was created
   */
  timestamp: Date;
  
  /**
   * When the comment was last modified
   */
  lastModified?: Date;
  
  /**
   * Current status of the comment
   */
  status: CommentStatus;
  
  /**
   * Visibility level of the comment
   */
  visibility: CommentVisibility;
  
  /**
   * Position within the cell (optional for cell-level comments)
   */
  position?: ICommentPosition;
  
  /**
   * Parent comment ID for replies
   */
  parentId?: string;
  
  /**
   * Thread ID that groups related comments
   */
  threadId: string;
  
  /**
   * List of user reactions to this comment
   */
  reactions: ICommentReactionData[];
  
  /**
   * Tags or labels for categorization
   */
  tags: string[];
  
  /**
   * Mentions of other users in the comment
   */
  mentions: string[];
  
  /**
   * Whether this comment is pinned
   */
  pinned: boolean;
  
  /**
   * Custom metadata for extensions
   */
  metadata: JSONObject;
  
  /**
   * Edit history for tracking changes
   */
  editHistory?: ICommentEditEntry[];
}

/**
 * Interface for comment edit history entry
 */
export interface ICommentEditEntry {
  /**
   * Previous content
   */
  previousContent: string;
  
  /**
   * User who made the edit
   */
  editedBy: string;
  
  /**
   * When the edit was made
   */
  editedAt: Date;
  
  /**
   * Reason for the edit (optional)
   */
  reason?: string;
}

/**
 * Interface for a comment thread
 */
export interface ICommentThread {
  /**
   * Unique identifier for the thread
   */
  id: string;
  
  /**
   * The cell ID this thread is associated with
   */
  cellId: string;
  
  /**
   * List of comments in this thread (hierarchical)
   */
  comments: IComment[];
  
  /**
   * Whether the thread is resolved
   */
  resolved: boolean;
  
  /**
   * User who resolved the thread
   */
  resolvedBy?: string;
  
  /**
   * When the thread was resolved
   */
  resolvedAt?: Date;
  
  /**
   * Reason for resolution
   */
  resolutionReason?: string;
  
  /**
   * Whether the thread is locked (no new comments)
   */
  locked: boolean;
  
  /**
   * Priority level for the thread
   */
  priority: 'low' | 'medium' | 'high' | 'critical';
  
  /**
   * Labels for categorization
   */
  labels: string[];
  
  /**
   * Users assigned to this thread
   */
  assignees: string[];
  
  /**
   * Due date for resolution (optional)
   */
  dueDate?: Date;
  
  /**
   * Thread creation timestamp
   */
  createdAt: Date;
  
  /**
   * Last activity timestamp
   */
  lastActivity: Date;
  
  /**
   * Custom metadata
   */
  metadata: JSONObject;
}

/**
 * Interface for comment notification
 */
export interface ICommentNotification {
  /**
   * Notification ID
   */
  id: string;
  
  /**
   * Type of notification
   */
  type: 'comment_added' | 'comment_replied' | 'comment_edited' | 'comment_resolved' | 'comment_mentioned';
  
  /**
   * The comment that triggered the notification
   */
  comment: IComment;
  
  /**
   * The thread the comment belongs to
   */
  thread: ICommentThread;
  
  /**
   * Target user for the notification
   */
  targetUserId: string;
  
  /**
   * When the notification was created
   */
  timestamp: Date;
  
  /**
   * Whether the notification has been read
   */
  read: boolean;
  
  /**
   * When the notification was read
   */
  readAt?: Date;
  
  /**
   * Additional context data
   */
  context?: JSONObject;
}

/**
 * Interface for comment filtering options
 */
export interface ICommentFilter {
  /**
   * Filter by cell ID
   */
  cellId?: string;
  
  /**
   * Filter by author
   */
  authorId?: string;
  
  /**
   * Filter by status
   */
  status?: CommentStatus | CommentStatus[];
  
  /**
   * Filter by visibility
   */
  visibility?: CommentVisibility;
  
  /**
   * Filter by resolved status
   */
  resolved?: boolean;
  
  /**
   * Filter by date range
   */
  dateRange?: {
    start: Date;
    end: Date;
  };
  
  /**
   * Filter by tags
   */
  tags?: string[];
  
  /**
   * Filter by priority
   */
  priority?: string[];
  
  /**
   * Text search in comment content
   */
  searchText?: string;
  
  /**
   * Filter by mentions
   */
  mentions?: string[];
  
  /**
   * Only show pinned comments
   */
  pinnedOnly?: boolean;
}

/**
 * Interface for comment sorting options
 */
export interface ICommentSort {
  /**
   * Field to sort by
   */
  field: 'timestamp' | 'lastModified' | 'author' | 'priority' | 'status';
  
  /**
   * Sort direction
   */
  direction: 'asc' | 'desc';
}

/**
 * Interface for comment events
 */
export interface ICommentEvent {
  /**
   * The type of event
   */
  type: 'added' | 'updated' | 'deleted' | 'resolved' | 'unresolved';
  
  /**
   * The comment that changed
   */
  comment: IComment;
  
  /**
   * The thread the comment belongs to
   */
  thread: ICommentThread;
  
  /**
   * The user who triggered the event
   */
  userId: string;
  
  /**
   * When the event occurred
   */
  timestamp: Date;
  
  /**
   * Additional event data
   */
  data?: JSONObject;
}

/**
 * Interface for comment statistics
 */
export interface ICommentStatistics {
  /**
   * Total number of comments
   */
  totalComments: number;
  
  /**
   * Number of active threads
   */
  activeThreads: number;
  
  /**
   * Number of resolved threads
   */
  resolvedThreads: number;
  
  /**
   * Number of unread comments for current user
   */
  unreadComments: number;
  
  /**
   * Comments by status
   */
  commentsByStatus: Record<CommentStatus, number>;
  
  /**
   * Comments by user
   */
  commentsByUser: Record<string, number>;
  
  /**
   * Average resolution time
   */
  averageResolutionTime?: number;
  
  /**
   * Most active cells (by comment count)
   */
  mostActiveCells: Array<{ cellId: string; count: number }>;
}

/**
 * Interface for comment manager events
 */
export interface ICommentManagerEvents {
  /**
   * Emitted when a comment is added
   */
  commentAdded: { cellId: string; comment: IComment; thread: ICommentThread };
  
  /**
   * Emitted when a comment is updated
   */
  commentUpdated: { cellId: string; comment: IComment; thread: ICommentThread };
  
  /**
   * Emitted when a comment is deleted
   */
  commentDeleted: { cellId: string; commentId: string; thread: ICommentThread };
  
  /**
   * Emitted when a thread is resolved
   */
  threadResolved: { cellId: string; thread: ICommentThread };
  
  /**
   * Emitted when a thread is unresolved
   */
  threadUnresolved: { cellId: string; thread: ICommentThread };
  
  /**
   * Emitted when comments change for a cell
   */
  commentsChanged: { cellId: string; threads: ICommentThread[] };
  
  /**
   * Emitted when a notification is created
   */
  notificationCreated: ICommentNotification;
  
  /**
   * Emitted when the comment system synchronizes
   */
  synchronized: { timestamp: Date };
}

/**
 * Main interface for the comment manager
 */
export interface ICommentManager extends IDisposable {
  /**
   * The current user information
   */
  readonly currentUser: User.IUser | null;
  
  /**
   * Signal emitted when a comment is added
   */
  readonly commentAdded: ISignal<this, ICommentManagerEvents['commentAdded']>;
  
  /**
   * Signal emitted when a comment is updated
   */
  readonly commentUpdated: ISignal<this, ICommentManagerEvents['commentUpdated']>;
  
  /**
   * Signal emitted when a comment is deleted
   */
  readonly commentDeleted: ISignal<this, ICommentManagerEvents['commentDeleted']>;
  
  /**
   * Signal emitted when a thread is resolved
   */
  readonly threadResolved: ISignal<this, ICommentManagerEvents['threadResolved']>;
  
  /**
   * Signal emitted when a thread is unresolved
   */
  readonly threadUnresolved: ISignal<this, ICommentManagerEvents['threadUnresolved']>;
  
  /**
   * Signal emitted when comments change for a cell
   */
  readonly commentsChanged: ISignal<this, ICommentManagerEvents['commentsChanged']>;
  
  /**
   * Signal emitted when a notification is created
   */
  readonly notificationCreated: ISignal<this, ICommentManagerEvents['notificationCreated']>;
  
  /**
   * Signal emitted when the comment system synchronizes
   */
  readonly synchronized: ISignal<this, ICommentManagerEvents['synchronized']>;
  
  /**
   * Whether the comment manager is connected and ready
   */
  readonly isReady: boolean;
  
  /**
   * Whether comments are enabled
   */
  readonly isEnabled: boolean;
  
  /**
   * Current collaboration document ID
   */
  readonly documentId: string | null;
  
  /**
   * Add a comment to a specific cell
   * 
   * @param cellId - The cell to comment on
   * @param content - The comment content
   * @param options - Additional comment options
   * @returns Promise resolving to the created comment
   */
  addComment(
    cellId: string, 
    content: string, 
    options?: Partial<IComment>
  ): Promise<IComment>;
  
  /**
   * Reply to an existing comment
   * 
   * @param parentCommentId - The comment to reply to
   * @param content - The reply content
   * @param options - Additional reply options
   * @returns Promise resolving to the created reply
   */
  replyToComment(
    parentCommentId: string, 
    content: string,
    options?: Partial<IComment>
  ): Promise<IComment>;
  
  /**
   * Update an existing comment
   * 
   * @param commentId - The comment to update
   * @param updates - Fields to update
   * @returns Promise resolving to the updated comment
   */
  updateComment(commentId: string, updates: Partial<IComment>): Promise<IComment>;
  
  /**
   * Delete a comment
   * 
   * @param commentId - The comment to delete
   * @param soft - Whether to soft delete (mark as deleted) or hard delete
   * @returns Promise resolving when deletion is complete
   */
  deleteComment(commentId: string, soft?: boolean): Promise<void>;
  
  /**
   * Get all comments for a specific cell
   * 
   * @param cellId - The cell ID
   * @param filter - Optional filter options
   * @param sort - Optional sort options
   * @returns Array of comment threads
   */
  getCommentsForCell(
    cellId: string,
    filter?: ICommentFilter,
    sort?: ICommentSort
  ): ICommentThread[];
  
  /**
   * Get all comments in the notebook
   * 
   * @param filter - Optional filter options
   * @param sort - Optional sort options
   * @returns Array of comment threads
   */
  getAllComments(filter?: ICommentFilter, sort?: ICommentSort): ICommentThread[];
  
  /**
   * Get a specific comment by ID
   * 
   * @param commentId - The comment ID
   * @returns The comment or null if not found
   */
  getComment(commentId: string): IComment | null;
  
  /**
   * Get a specific thread by ID
   * 
   * @param threadId - The thread ID
   * @returns The thread or null if not found
   */
  getThread(threadId: string): ICommentThread | null;
  
  /**
   * Resolve a comment thread
   * 
   * @param threadId - The thread to resolve
   * @param reason - Optional reason for resolution
   * @returns Promise resolving when thread is resolved
   */
  resolveThread(threadId: string, reason?: string): Promise<void>;
  
  /**
   * Unresolve a comment thread
   * 
   * @param threadId - The thread to unresolve
   * @returns Promise resolving when thread is unresolved
   */
  unresolveThread(threadId: string): Promise<void>;
  
  /**
   * Add a reaction to a comment
   * 
   * @param commentId - The comment to react to
   * @param reaction - The reaction type
   * @returns Promise resolving when reaction is added
   */
  addReaction(commentId: string, reaction: CommentReaction): Promise<void>;
  
  /**
   * Remove a reaction from a comment
   * 
   * @param commentId - The comment to remove reaction from
   * @param reaction - The reaction type to remove
   * @returns Promise resolving when reaction is removed
   */
  removeReaction(commentId: string, reaction: CommentReaction): Promise<void>;
  
  /**
   * Mark comments as read
   * 
   * @param commentIds - Array of comment IDs to mark as read
   * @returns Promise resolving when comments are marked as read
   */
  markAsRead(commentIds: string[]): Promise<void>;
  
  /**
   * Get unread notifications for the current user
   * 
   * @returns Array of unread notifications
   */
  getUnreadNotifications(): ICommentNotification[];
  
  /**
   * Mark notifications as read
   * 
   * @param notificationIds - Array of notification IDs to mark as read
   * @returns Promise resolving when notifications are marked as read
   */
  markNotificationsAsRead(notificationIds: string[]): Promise<void>;
  
  /**
   * Get comment statistics
   * 
   * @returns Current comment statistics
   */
  getStatistics(): ICommentStatistics;
  
  /**
   * Search comments by content
   * 
   * @param query - Search query
   * @param options - Search options
   * @returns Array of matching comments
   */
  searchComments(
    query: string, 
    options?: {
      cellId?: string;
      includeResolved?: boolean;
      maxResults?: number;
    }
  ): IComment[];
  
  /**
   * Export comments to a specific format
   * 
   * @param format - Export format ('json' | 'csv' | 'markdown')
   * @param filter - Optional filter for export
   * @returns Promise resolving to exported data
   */
  exportComments(
    format: 'json' | 'csv' | 'markdown',
    filter?: ICommentFilter
  ): Promise<string>;
  
  /**
   * Import comments from external data
   * 
   * @param data - Comment data to import
   * @param format - Data format
   * @returns Promise resolving when import is complete
   */
  importComments(
    data: string,
    format: 'json' | 'csv'
  ): Promise<void>;
  
  /**
   * Enable or disable the comment system
   * 
   * @param enabled - Whether comments should be enabled
   */
  setEnabled(enabled: boolean): void;
  
  /**
   * Force synchronization with the backend
   * 
   * @returns Promise resolving when synchronization is complete
   */
  synchronize(): Promise<void>;
}

/**
 * Implementation of the comment manager
 */
export class CommentManager implements ICommentManager {
  private _isDisposed = false;
  private _isReady = false;
  private _isEnabled = true;
  private _documentId: string | null = null;
  private _currentUser: User.IUser | null = null;
  private _translator: ITranslator;
  
  // Storage for comments and threads
  private _threads = new ObservableMap<ICommentThread>();
  private _comments = new ObservableMap<IComment>();
  private _notifications = new ObservableMap<ICommentNotification>();
  
  // Collaboration integration
  private _yjsProvider: IYjsNotebookProvider | null = null;
  private _permissionsManager: IPermissionsManager | null = null;
  
  // Signals
  private _commentAdded = new Signal<this, ICommentManagerEvents['commentAdded']>(this);
  private _commentUpdated = new Signal<this, ICommentManagerEvents['commentUpdated']>(this);
  private _commentDeleted = new Signal<this, ICommentManagerEvents['commentDeleted']>(this);
  private _threadResolved = new Signal<this, ICommentManagerEvents['threadResolved']>(this);
  private _threadUnresolved = new Signal<this, ICommentManagerEvents['threadUnresolved']>(this);
  private _commentsChanged = new Signal<this, ICommentManagerEvents['commentsChanged']>(this);
  private _notificationCreated = new Signal<this, ICommentManagerEvents['notificationCreated']>(this);
  private _synchronized = new Signal<this, ICommentManagerEvents['synchronized']>(this);
  
  // Synchronization state
  private _syncTimer: any = null;
  private _syncInterval = 5000; // 5 seconds
  private _pendingUpdates = new Set<string>();
  
  constructor(options: {
    yjsProvider?: IYjsNotebookProvider;
    permissionsManager?: IPermissionsManager;
    translator?: ITranslator;
    currentUser?: User.IUser;
    enabled?: boolean;
  } = {}) {
    this._yjsProvider = options.yjsProvider || null;
    this._permissionsManager = options.permissionsManager || null;
    this._translator = options.translator || nullTranslator;
    this._currentUser = options.currentUser || null;
    this._isEnabled = options.enabled !== false;
    
    this._initialize();
  }
  
  /**
   * Initialize the comment manager
   */
  private async _initialize(): Promise<void> {
    try {
      // Connect to Yjs provider if available
      if (this._yjsProvider) {
        this._documentId = this._yjsProvider.documentId;
        this._setupYjsIntegration();
      }
      
      // Set up permissions integration
      if (this._permissionsManager) {
        this._setupPermissionsIntegration();
      }
      
      // Start synchronization
      this._startSynchronization();
      
      this._isReady = true;
      
      // Emit initial synchronization event
      this._synchronized.emit({ timestamp: new Date() });
      
    } catch (error) {
      console.error('Failed to initialize comment manager:', error);
      this._isReady = false;
    }
  }
  
  /**
   * Set up integration with Yjs provider
   */
  private _setupYjsIntegration(): void {
    if (!this._yjsProvider) {
      return;
    }
    
    // Listen for document changes to synchronize comments
    this._yjsProvider.documentChanged.connect(() => {
      this._handleYjsUpdate();
    });
    
    // Listen for connection status changes
    this._yjsProvider.statusChanged.connect((sender, status) => {
      if (status === 'connected') {
        this._loadCommentsFromYjs();
      }
    });
    
    // Load initial comments if already connected
    if (this._yjsProvider.isConnected) {
      this._loadCommentsFromYjs();
    }
  }
  
  /**
   * Set up integration with permissions manager
   */
  private _setupPermissionsIntegration(): void {
    if (!this._permissionsManager) {
      return;
    }
    
    // Listen for permission changes that might affect comment visibility
    this._permissionsManager.permissionsChanged?.connect(() => {
      this._updateCommentVisibility();
    });
  }
  
  /**
   * Start synchronization timer
   */
  private _startSynchronization(): void {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
    }
    
    this._syncTimer = setInterval(() => {
      this._performSynchronization();
    }, this._syncInterval);
  }
  
  /**
   * Stop synchronization timer
   */
  private _stopSynchronization(): void {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }
  
  /**
   * Handle Yjs document updates
   */
  private _handleYjsUpdate(): void {
    if (!this._yjsProvider || !this._isReady) {
      return;
    }
    
    // Schedule synchronization
    if (this._pendingUpdates.size === 0) {
      setTimeout(() => {
        this._loadCommentsFromYjs();
      }, 100); // Debounce rapid updates
    }
  }
  
  /**
   * Load comments from Yjs document
   */
  private _loadCommentsFromYjs(): void {
    if (!this._yjsProvider) {
      return;
    }
    
    try {
      // Get comments data from Yjs shared map
      const commentsMap = this._yjsProvider.getSharedMap('comments');
      if (!commentsMap) {
        return;
      }
      
      // Load threads
      const threadsData = commentsMap.get('threads') as any;
      if (threadsData) {
        this._loadThreadsFromData(threadsData);
      }
      
      // Load comments
      const commentsData = commentsMap.get('comments') as any;
      if (commentsData) {
        this._loadCommentsFromData(commentsData);
      }
      
      // Load notifications
      const notificationsData = commentsMap.get('notifications') as any;
      if (notificationsData) {
        this._loadNotificationsFromData(notificationsData);
      }
      
    } catch (error) {
      console.error('Failed to load comments from Yjs:', error);
    }
  }
  
  /**
   * Save comments to Yjs document
   */
  private _saveCommentsToYjs(): void {
    if (!this._yjsProvider) {
      return;
    }
    
    try {
      const commentsMap = this._yjsProvider.getSharedMap('comments') || 
                          this._yjsProvider.createSharedMap('comments');
      
      // Save threads
      const threadsData = Array.from(this._threads.values()).map(thread => 
        this._serializeThread(thread)
      );
      commentsMap.set('threads', threadsData);
      
      // Save comments
      const commentsData = Array.from(this._comments.values()).map(comment =>
        this._serializeComment(comment)
      );
      commentsMap.set('comments', commentsData);
      
      // Save notifications (only for current user)
      const userNotifications = Array.from(this._notifications.values())
        .filter(notif => notif.targetUserId === this._currentUser?.username)
        .map(notif => this._serializeNotification(notif));
      commentsMap.set('notifications', userNotifications);
      
    } catch (error) {
      console.error('Failed to save comments to Yjs:', error);
    }
  }
  
  /**
   * Load threads from serialized data
   */
  private _loadThreadsFromData(data: any[]): void {
    for (const threadData of data) {
      try {
        const thread = this._deserializeThread(threadData);
        this._threads.set(thread.id, thread);
      } catch (error) {
        console.error('Failed to deserialize thread:', error);
      }
    }
  }
  
  /**
   * Load comments from serialized data
   */
  private _loadCommentsFromData(data: any[]): void {
    for (const commentData of data) {
      try {
        const comment = this._deserializeComment(commentData);
        this._comments.set(comment.id, comment);
      } catch (error) {
        console.error('Failed to deserialize comment:', error);
      }
    }
  }
  
  /**
   * Load notifications from serialized data
   */
  private _loadNotificationsFromData(data: any[]): void {
    for (const notifData of data) {
      try {
        const notification = this._deserializeNotification(notifData);
        this._notifications.set(notification.id, notification);
      } catch (error) {
        console.error('Failed to deserialize notification:', error);
      }
    }
  }
  
  /**
   * Serialize a thread for storage
   */
  private _serializeThread(thread: ICommentThread): JSONValue {
    return {
      id: thread.id,
      cellId: thread.cellId,
      comments: thread.comments.map(c => c.id), // Store only IDs
      resolved: thread.resolved,
      resolvedBy: thread.resolvedBy,
      resolvedAt: thread.resolvedAt?.toISOString(),
      resolutionReason: thread.resolutionReason,
      locked: thread.locked,
      priority: thread.priority,
      labels: thread.labels,
      assignees: thread.assignees,
      dueDate: thread.dueDate?.toISOString(),
      createdAt: thread.createdAt.toISOString(),
      lastActivity: thread.lastActivity.toISOString(),
      metadata: thread.metadata
    };
  }
  
  /**
   * Deserialize a thread from storage
   */
  private _deserializeThread(data: any): ICommentThread {
    return {
      id: data.id,
      cellId: data.cellId,
      comments: [], // Will be populated separately
      resolved: data.resolved,
      resolvedBy: data.resolvedBy,
      resolvedAt: data.resolvedAt ? new Date(data.resolvedAt) : undefined,
      resolutionReason: data.resolutionReason,
      locked: data.locked,
      priority: data.priority,
      labels: data.labels || [],
      assignees: data.assignees || [],
      dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
      createdAt: new Date(data.createdAt),
      lastActivity: new Date(data.lastActivity),
      metadata: data.metadata || {}
    };
  }
  
  /**
   * Serialize a comment for storage
   */
  private _serializeComment(comment: IComment): JSONValue {
    return {
      id: comment.id,
      cellId: comment.cellId,
      userId: comment.userId,
      userName: comment.userName,
      userEmail: comment.userEmail,
      userAvatar: comment.userAvatar,
      content: comment.content,
      timestamp: comment.timestamp.toISOString(),
      lastModified: comment.lastModified?.toISOString(),
      status: comment.status,
      visibility: comment.visibility,
      position: comment.position,
      parentId: comment.parentId,
      threadId: comment.threadId,
      reactions: comment.reactions.map(r => ({
        ...r,
        timestamp: r.timestamp.toISOString()
      })),
      tags: comment.tags,
      mentions: comment.mentions,
      pinned: comment.pinned,
      metadata: comment.metadata,
      editHistory: comment.editHistory?.map(e => ({
        ...e,
        editedAt: e.editedAt.toISOString()
      }))
    };
  }
  
  /**
   * Deserialize a comment from storage
   */
  private _deserializeComment(data: any): IComment {
    return {
      id: data.id,
      cellId: data.cellId,
      userId: data.userId,
      userName: data.userName,
      userEmail: data.userEmail,
      userAvatar: data.userAvatar,
      content: data.content,
      timestamp: new Date(data.timestamp),
      lastModified: data.lastModified ? new Date(data.lastModified) : undefined,
      status: data.status,
      visibility: data.visibility,
      position: data.position,
      parentId: data.parentId,
      threadId: data.threadId,
      reactions: (data.reactions || []).map((r: any) => ({
        ...r,
        timestamp: new Date(r.timestamp)
      })),
      tags: data.tags || [],
      mentions: data.mentions || [],
      pinned: data.pinned || false,
      metadata: data.metadata || {},
      editHistory: (data.editHistory || []).map((e: any) => ({
        ...e,
        editedAt: new Date(e.editedAt)
      }))
    };
  }
  
  /**
   * Serialize a notification for storage
   */
  private _serializeNotification(notification: ICommentNotification): JSONValue {
    return {
      id: notification.id,
      type: notification.type,
      commentId: notification.comment.id,
      threadId: notification.thread.id,
      targetUserId: notification.targetUserId,
      timestamp: notification.timestamp.toISOString(),
      read: notification.read,
      readAt: notification.readAt?.toISOString(),
      context: notification.context
    };
  }
  
  /**
   * Deserialize a notification from storage
   */
  private _deserializeNotification(data: any): ICommentNotification {
    const comment = this._comments.get(data.commentId);
    const thread = this._threads.get(data.threadId);
    
    if (!comment || !thread) {
      throw new Error('Invalid notification: missing comment or thread');
    }
    
    return {
      id: data.id,
      type: data.type,
      comment,
      thread,
      targetUserId: data.targetUserId,
      timestamp: new Date(data.timestamp),
      read: data.read,
      readAt: data.readAt ? new Date(data.readAt) : undefined,
      context: data.context
    };
  }
  
  /**
   * Perform synchronization with backend
   */
  private async _performSynchronization(): Promise<void> {
    if (!this._isReady || this._pendingUpdates.size === 0) {
      return;
    }
    
    try {
      // Save pending changes to Yjs
      this._saveCommentsToYjs();
      
      // Clear pending updates
      this._pendingUpdates.clear();
      
      // Emit synchronization event
      this._synchronized.emit({ timestamp: new Date() });
      
    } catch (error) {
      console.error('Synchronization failed:', error);
    }
  }
  
  /**
   * Update comment visibility based on permissions
   */
  private _updateCommentVisibility(): void {
    if (!this._permissionsManager || !this._currentUser) {
      return;
    }
    
    // Update visibility of comments based on current user permissions
    for (const thread of this._threads.values()) {
      this._commentsChanged.emit({
        cellId: thread.cellId,
        threads: this.getCommentsForCell(thread.cellId)
      });
    }
  }
  
  /**
   * Check if user has permission for an action
   */
  private async _checkPermission(action: string, target?: string): Promise<boolean> {
    if (!this._permissionsManager || !this._currentUser) {
      return true; // Default to allow if no permissions system
    }
    
    try {
      const permission = await this._permissionsManager.checkPermission(
        this._currentUser.username,
        action,
        target
      );
      return permission.level !== PermissionLevel.None;
    } catch (error) {
      console.warn('Permission check failed:', error);
      return false;
    }
  }
  
  /**
   * Generate a unique ID
   */
  private _generateId(): string {
    return `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Generate a unique thread ID
   */
  private _generateThreadId(): string {
    return `thread_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Create a notification
   */
  private _createNotification(
    type: ICommentNotification['type'],
    comment: IComment,
    thread: ICommentThread,
    targetUserId?: string
  ): void {
    // Determine target users for notification
    const targetUsers = new Set<string>();
    
    if (targetUserId) {
      targetUsers.add(targetUserId);
    } else {
      // Add thread participants
      for (const c of thread.comments) {
        if (c.userId !== comment.userId) {
          targetUsers.add(c.userId);
        }
      }
      
      // Add mentioned users
      for (const mention of comment.mentions) {
        targetUsers.add(mention);
      }
      
      // Add assignees
      for (const assignee of thread.assignees) {
        targetUsers.add(assignee);
      }
    }
    
    // Create notifications for each target user
    for (const userId of targetUsers) {
      const notification: ICommentNotification = {
        id: this._generateId(),
        type,
        comment,
        thread,
        targetUserId: userId,
        timestamp: new Date(),
        read: false
      };
      
      this._notifications.set(notification.id, notification);
      this._notificationCreated.emit(notification);
    }
    
    this._pendingUpdates.add('notifications');
  }
  
  // Public API Implementation
  
  get currentUser(): User.IUser | null {
    return this._currentUser;
  }
  
  get commentAdded(): ISignal<this, ICommentManagerEvents['commentAdded']> {
    return this._commentAdded;
  }
  
  get commentUpdated(): ISignal<this, ICommentManagerEvents['commentUpdated']> {
    return this._commentUpdated;
  }
  
  get commentDeleted(): ISignal<this, ICommentManagerEvents['commentDeleted']> {
    return this._commentDeleted;
  }
  
  get threadResolved(): ISignal<this, ICommentManagerEvents['threadResolved']> {
    return this._threadResolved;
  }
  
  get threadUnresolved(): ISignal<this, ICommentManagerEvents['threadUnresolved']> {
    return this._threadUnresolved;
  }
  
  get commentsChanged(): ISignal<this, ICommentManagerEvents['commentsChanged']> {
    return this._commentsChanged;
  }
  
  get notificationCreated(): ISignal<this, ICommentManagerEvents['notificationCreated']> {
    return this._notificationCreated;
  }
  
  get synchronized(): ISignal<this, ICommentManagerEvents['synchronized']> {
    return this._synchronized;
  }
  
  get isReady(): boolean {
    return this._isReady;
  }
  
  get isEnabled(): boolean {
    return this._isEnabled;
  }
  
  get documentId(): string | null {
    return this._documentId;
  }
  
  async addComment(
    cellId: string,
    content: string,
    options: Partial<IComment> = {}
  ): Promise<IComment> {
    if (!this._isEnabled || !this._currentUser) {
      throw new Error('Comments are not enabled or user not authenticated');
    }
    
    // Check permission
    const canComment = await this._checkPermission('comment.create', cellId);
    if (!canComment) {
      throw new Error('Insufficient permissions to add comment');
    }
    
    // Create new comment
    const commentId = this._generateId();
    const threadId = options.threadId || this._generateThreadId();
    const now = new Date();
    
    const comment: IComment = {
      id: commentId,
      cellId,
      userId: this._currentUser.username,
      userName: this._currentUser.display_name || this._currentUser.username,
      userEmail: this._currentUser.email,
      userAvatar: options.userAvatar,
      content,
      timestamp: now,
      status: CommentStatus.Active,
      visibility: options.visibility || CommentVisibility.Public,
      position: options.position,
      parentId: options.parentId,
      threadId,
      reactions: [],
      tags: options.tags || [],
      mentions: options.mentions || [],
      pinned: options.pinned || false,
      metadata: options.metadata || {},
      ...options
    };
    
    // Store comment
    this._comments.set(commentId, comment);
    
    // Create or update thread
    let thread = this._threads.get(threadId);
    if (!thread) {
      thread = {
        id: threadId,
        cellId,
        comments: [comment],
        resolved: false,
        locked: false,
        priority: 'medium',
        labels: [],
        assignees: [],
        createdAt: now,
        lastActivity: now,
        metadata: {}
      };
      this._threads.set(threadId, thread);
    } else {
      thread.comments.push(comment);
      thread.lastActivity = now;
    }
    
    // Mark updates as pending
    this._pendingUpdates.add('comments');
    this._pendingUpdates.add('threads');
    
    // Create notification
    this._createNotification('comment_added', comment, thread);
    
    // Emit events
    this._commentAdded.emit({ cellId, comment, thread });
    this._commentsChanged.emit({
      cellId,
      threads: this.getCommentsForCell(cellId)
    });
    
    return comment;
  }
  
  async replyToComment(
    parentCommentId: string,
    content: string,
    options: Partial<IComment> = {}
  ): Promise<IComment> {
    const parentComment = this._comments.get(parentCommentId);
    if (!parentComment) {
      throw new Error('Parent comment not found');
    }
    
    return this.addComment(parentComment.cellId, content, {
      ...options,
      parentId: parentCommentId,
      threadId: parentComment.threadId
    });
  }
  
  async updateComment(commentId: string, updates: Partial<IComment>): Promise<IComment> {
    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error('Comment not found');
    }
    
    // Check permission
    const canEdit = comment.userId === this._currentUser?.username ||
                   await this._checkPermission('comment.edit', commentId);
    if (!canEdit) {
      throw new Error('Insufficient permissions to edit comment');
    }
    
    // Create edit history entry
    const editEntry: ICommentEditEntry = {
      previousContent: comment.content,
      editedBy: this._currentUser?.username || 'unknown',
      editedAt: new Date(),
      reason: updates.metadata?.editReason as string
    };
    
    // Update comment
    const updatedComment: IComment = {
      ...comment,
      ...updates,
      lastModified: new Date(),
      status: CommentStatus.Edited,
      editHistory: [...(comment.editHistory || []), editEntry]
    };
    
    this._comments.set(commentId, updatedComment);
    
    // Update thread
    const thread = this._threads.get(comment.threadId);
    if (thread) {
      const commentIndex = thread.comments.findIndex(c => c.id === commentId);
      if (commentIndex !== -1) {
        thread.comments[commentIndex] = updatedComment;
        thread.lastActivity = new Date();
      }
    }
    
    // Mark updates as pending
    this._pendingUpdates.add('comments');
    this._pendingUpdates.add('threads');
    
    // Create notification
    if (thread) {
      this._createNotification('comment_edited', updatedComment, thread);
    }
    
    // Emit events
    if (thread) {
      this._commentUpdated.emit({
        cellId: comment.cellId,
        comment: updatedComment,
        thread
      });
      this._commentsChanged.emit({
        cellId: comment.cellId,
        threads: this.getCommentsForCell(comment.cellId)
      });
    }
    
    return updatedComment;
  }
  
  async deleteComment(commentId: string, soft = true): Promise<void> {
    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error('Comment not found');
    }
    
    // Check permission
    const canDelete = comment.userId === this._currentUser?.username ||
                     await this._checkPermission('comment.delete', commentId);
    if (!canDelete) {
      throw new Error('Insufficient permissions to delete comment');
    }
    
    const thread = this._threads.get(comment.threadId);
    if (!thread) {
      throw new Error('Thread not found');
    }
    
    if (soft) {
      // Soft delete - mark as deleted
      const deletedComment: IComment = {
        ...comment,
        status: CommentStatus.Deleted,
        content: '[deleted]',
        lastModified: new Date()
      };
      this._comments.set(commentId, deletedComment);
      
      // Update thread
      const commentIndex = thread.comments.findIndex(c => c.id === commentId);
      if (commentIndex !== -1) {
        thread.comments[commentIndex] = deletedComment;
        thread.lastActivity = new Date();
      }
    } else {
      // Hard delete - remove completely
      this._comments.delete(commentId);
      
      // Remove from thread
      thread.comments = thread.comments.filter(c => c.id !== commentId);
      thread.lastActivity = new Date();
      
      // Remove thread if no comments remain
      if (thread.comments.length === 0) {
        this._threads.delete(thread.id);
      }
    }
    
    // Mark updates as pending
    this._pendingUpdates.add('comments');
    this._pendingUpdates.add('threads');
    
    // Emit events
    this._commentDeleted.emit({
      cellId: comment.cellId,
      commentId,
      thread
    });
    this._commentsChanged.emit({
      cellId: comment.cellId,
      threads: this.getCommentsForCell(comment.cellId)
    });
  }
  
  getCommentsForCell(
    cellId: string,
    filter?: ICommentFilter,
    sort?: ICommentSort
  ): ICommentThread[] {
    let threads = Array.from(this._threads.values())
      .filter(thread => thread.cellId === cellId);
    
    // Apply filter
    if (filter) {
      threads = this._applyThreadFilter(threads, filter);
    }
    
    // Apply sort
    if (sort) {
      threads = this._applyThreadSort(threads, sort);
    }
    
    // Populate comments for each thread
    return threads.map(thread => ({
      ...thread,
      comments: this._getCommentsForThread(thread.id, filter, sort)
    }));
  }
  
  getAllComments(filter?: ICommentFilter, sort?: ICommentSort): ICommentThread[] {
    let threads = Array.from(this._threads.values());
    
    // Apply filter
    if (filter) {
      threads = this._applyThreadFilter(threads, filter);
    }
    
    // Apply sort
    if (sort) {
      threads = this._applyThreadSort(threads, sort);
    }
    
    // Populate comments for each thread
    return threads.map(thread => ({
      ...thread,
      comments: this._getCommentsForThread(thread.id, filter, sort)
    }));
  }
  
  getComment(commentId: string): IComment | null {
    return this._comments.get(commentId) || null;
  }
  
  getThread(threadId: string): ICommentThread | null {
    const thread = this._threads.get(threadId);
    if (!thread) {
      return null;
    }
    
    return {
      ...thread,
      comments: this._getCommentsForThread(threadId)
    };
  }
  
  async resolveThread(threadId: string, reason?: string): Promise<void> {
    const thread = this._threads.get(threadId);
    if (!thread) {
      throw new Error('Thread not found');
    }
    
    // Check permission
    const canResolve = await this._checkPermission('comment.resolve', threadId);
    if (!canResolve) {
      throw new Error('Insufficient permissions to resolve thread');
    }
    
    // Update thread
    const resolvedThread: ICommentThread = {
      ...thread,
      resolved: true,
      resolvedBy: this._currentUser?.username,
      resolvedAt: new Date(),
      resolutionReason: reason,
      lastActivity: new Date()
    };
    
    this._threads.set(threadId, resolvedThread);
    
    // Mark updates as pending
    this._pendingUpdates.add('threads');
    
    // Create notification
    const firstComment = this._comments.get(thread.comments[0]?.id);
    if (firstComment) {
      this._createNotification('comment_resolved', firstComment, resolvedThread);
    }
    
    // Emit events
    this._threadResolved.emit({
      cellId: thread.cellId,
      thread: resolvedThread
    });
    this._commentsChanged.emit({
      cellId: thread.cellId,
      threads: this.getCommentsForCell(thread.cellId)
    });
  }
  
  async unresolveThread(threadId: string): Promise<void> {
    const thread = this._threads.get(threadId);
    if (!thread) {
      throw new Error('Thread not found');
    }
    
    // Check permission
    const canResolve = await this._checkPermission('comment.resolve', threadId);
    if (!canResolve) {
      throw new Error('Insufficient permissions to unresolve thread');
    }
    
    // Update thread
    const unresolvedThread: ICommentThread = {
      ...thread,
      resolved: false,
      resolvedBy: undefined,
      resolvedAt: undefined,
      resolutionReason: undefined,
      lastActivity: new Date()
    };
    
    this._threads.set(threadId, unresolvedThread);
    
    // Mark updates as pending
    this._pendingUpdates.add('threads');
    
    // Emit events
    this._threadUnresolved.emit({
      cellId: thread.cellId,
      thread: unresolvedThread
    });
    this._commentsChanged.emit({
      cellId: thread.cellId,
      threads: this.getCommentsForCell(thread.cellId)
    });
  }
  
  async addReaction(commentId: string, reaction: CommentReaction): Promise<void> {
    const comment = this._comments.get(commentId);
    if (!comment || !this._currentUser) {
      throw new Error('Comment not found or user not authenticated');
    }
    
    // Check if user already has this reaction
    const existingReaction = comment.reactions.find(
      r => r.userId === this._currentUser!.username && r.reaction === reaction
    );
    
    if (existingReaction) {
      return; // Already has this reaction
    }
    
    // Add reaction
    const reactionData: ICommentReactionData = {
      userId: this._currentUser.username,
      userName: this._currentUser.display_name || this._currentUser.username,
      reaction,
      timestamp: new Date()
    };
    
    const updatedComment: IComment = {
      ...comment,
      reactions: [...comment.reactions, reactionData]
    };
    
    this._comments.set(commentId, updatedComment);
    
    // Update thread
    const thread = this._threads.get(comment.threadId);
    if (thread) {
      const commentIndex = thread.comments.findIndex(c => c.id === commentId);
      if (commentIndex !== -1) {
        thread.comments[commentIndex] = updatedComment;
        thread.lastActivity = new Date();
      }
    }
    
    // Mark updates as pending
    this._pendingUpdates.add('comments');
    this._pendingUpdates.add('threads');
    
    // Emit events
    if (thread) {
      this._commentUpdated.emit({
        cellId: comment.cellId,
        comment: updatedComment,
        thread
      });
    }
  }
  
  async removeReaction(commentId: string, reaction: CommentReaction): Promise<void> {
    const comment = this._comments.get(commentId);
    if (!comment || !this._currentUser) {
      throw new Error('Comment not found or user not authenticated');
    }
    
    // Remove reaction
    const updatedComment: IComment = {
      ...comment,
      reactions: comment.reactions.filter(
        r => !(r.userId === this._currentUser!.username && r.reaction === reaction)
      )
    };
    
    this._comments.set(commentId, updatedComment);
    
    // Update thread
    const thread = this._threads.get(comment.threadId);
    if (thread) {
      const commentIndex = thread.comments.findIndex(c => c.id === commentId);
      if (commentIndex !== -1) {
        thread.comments[commentIndex] = updatedComment;
        thread.lastActivity = new Date();
      }
    }
    
    // Mark updates as pending
    this._pendingUpdates.add('comments');
    this._pendingUpdates.add('threads');
    
    // Emit events
    if (thread) {
      this._commentUpdated.emit({
        cellId: comment.cellId,
        comment: updatedComment,
        thread
      });
    }
  }
  
  async markAsRead(commentIds: string[]): Promise<void> {
    if (!this._currentUser) {
      return;
    }
    
    let hasChanges = false;
    
    for (const commentId of commentIds) {
      const comment = this._comments.get(commentId);
      if (comment && comment.status === CommentStatus.Unread) {
        const updatedComment: IComment = {
          ...comment,
          status: CommentStatus.Read
        };
        
        this._comments.set(commentId, updatedComment);
        hasChanges = true;
        
        // Update thread
        const thread = this._threads.get(comment.threadId);
        if (thread) {
          const commentIndex = thread.comments.findIndex(c => c.id === commentId);
          if (commentIndex !== -1) {
            thread.comments[commentIndex] = updatedComment;
          }
        }
      }
    }
    
    if (hasChanges) {
      this._pendingUpdates.add('comments');
      this._pendingUpdates.add('threads');
    }
  }
  
  getUnreadNotifications(): ICommentNotification[] {
    if (!this._currentUser) {
      return [];
    }
    
    return Array.from(this._notifications.values())
      .filter(notif => 
        notif.targetUserId === this._currentUser!.username && !notif.read
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }
  
  async markNotificationsAsRead(notificationIds: string[]): Promise<void> {
    if (!this._currentUser) {
      return;
    }
    
    let hasChanges = false;
    const now = new Date();
    
    for (const notifId of notificationIds) {
      const notification = this._notifications.get(notifId);
      if (notification && 
          notification.targetUserId === this._currentUser.username && 
          !notification.read) {
        
        const updatedNotification: ICommentNotification = {
          ...notification,
          read: true,
          readAt: now
        };
        
        this._notifications.set(notifId, updatedNotification);
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      this._pendingUpdates.add('notifications');
    }
  }
  
  getStatistics(): ICommentStatistics {
    const allComments = Array.from(this._comments.values());
    const allThreads = Array.from(this._threads.values());
    
    // Count by status
    const commentsByStatus: Record<CommentStatus, number> = {
      [CommentStatus.Active]: 0,
      [CommentStatus.Read]: 0,
      [CommentStatus.Unread]: 0,
      [CommentStatus.Edited]: 0,
      [CommentStatus.Deleted]: 0,
      [CommentStatus.Resolved]: 0
    };
    
    // Count by user
    const commentsByUser: Record<string, number> = {};
    
    // Count unread for current user
    let unreadComments = 0;
    
    for (const comment of allComments) {
      commentsByStatus[comment.status]++;
      commentsByUser[comment.userId] = (commentsByUser[comment.userId] || 0) + 1;
      
      if (comment.status === CommentStatus.Unread && 
          this._currentUser?.username !== comment.userId) {
        unreadComments++;
      }
    }
    
    // Count threads
    const activeThreads = allThreads.filter(t => !t.resolved).length;
    const resolvedThreads = allThreads.filter(t => t.resolved).length;
    
    // Most active cells
    const cellCounts: Record<string, number> = {};
    for (const thread of allThreads) {
      cellCounts[thread.cellId] = (cellCounts[thread.cellId] || 0) + thread.comments.length;
    }
    
    const mostActiveCells = Object.entries(cellCounts)
      .map(([cellId, count]) => ({ cellId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    // Calculate average resolution time
    const resolvedThreadsWithTime = allThreads.filter(t => t.resolved && t.resolvedAt);
    const averageResolutionTime = resolvedThreadsWithTime.length > 0
      ? resolvedThreadsWithTime.reduce((sum, thread) => {
          const resolutionTime = thread.resolvedAt!.getTime() - thread.createdAt.getTime();
          return sum + resolutionTime;
        }, 0) / resolvedThreadsWithTime.length
      : undefined;
    
    return {
      totalComments: allComments.length,
      activeThreads,
      resolvedThreads,
      unreadComments,
      commentsByStatus,
      commentsByUser,
      averageResolutionTime,
      mostActiveCells
    };
  }
  
  searchComments(
    query: string,
    options: {
      cellId?: string;
      includeResolved?: boolean;
      maxResults?: number;
    } = {}
  ): IComment[] {
    const searchTerms = query.toLowerCase().split(/\s+/);
    const results: IComment[] = [];
    
    for (const comment of this._comments.values()) {
      // Skip if cell filter doesn't match
      if (options.cellId && comment.cellId !== options.cellId) {
        continue;
      }
      
      // Skip resolved comments if not included
      if (!options.includeResolved) {
        const thread = this._threads.get(comment.threadId);
        if (thread?.resolved) {
          continue;
        }
      }
      
      // Check if comment content matches search terms
      const contentLower = comment.content.toLowerCase();
      const matches = searchTerms.every(term => 
        contentLower.includes(term) ||
        comment.userName.toLowerCase().includes(term) ||
        comment.tags.some(tag => tag.toLowerCase().includes(term))
      );
      
      if (matches) {
        results.push(comment);
      }
      
      // Respect max results limit
      if (options.maxResults && results.length >= options.maxResults) {
        break;
      }
    }
    
    // Sort by relevance (timestamp for now)
    return results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }
  
  async exportComments(
    format: 'json' | 'csv' | 'markdown',
    filter?: ICommentFilter
  ): Promise<string> {
    let threads = this.getAllComments(filter);
    
    switch (format) {
      case 'json':
        return JSON.stringify(threads, null, 2);
        
      case 'csv':
        return this._exportCommentsAsCSV(threads);
        
      case 'markdown':
        return this._exportCommentsAsMarkdown(threads);
        
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }
  
  async importComments(data: string, format: 'json' | 'csv'): Promise<void> {
    // Check permission
    const canImport = await this._checkPermission('comment.import');
    if (!canImport) {
      throw new Error('Insufficient permissions to import comments');
    }
    
    switch (format) {
      case 'json':
        await this._importCommentsFromJSON(data);
        break;
        
      case 'csv':
        await this._importCommentsFromCSV(data);
        break;
        
      default:
        throw new Error(`Unsupported import format: ${format}`);
    }
  }
  
  setEnabled(enabled: boolean): void {
    this._isEnabled = enabled;
    
    if (enabled) {
      this._startSynchronization();
    } else {
      this._stopSynchronization();
    }
  }
  
  async synchronize(): Promise<void> {
    await this._performSynchronization();
  }
  
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    this._isDisposed = true;
    this._stopSynchronization();
    
    // Clear all signals
    Signal.clearData(this);
    
    // Clear all data
    this._threads.clear();
    this._comments.clear();
    this._notifications.clear();
  }
  
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  
  // Helper methods
  
  /**
   * Get comments for a specific thread
   */
  private _getCommentsForThread(
    threadId: string,
    filter?: ICommentFilter,
    sort?: ICommentSort
  ): IComment[] {
    let comments = Array.from(this._comments.values())
      .filter(comment => comment.threadId === threadId);
    
    // Apply filter
    if (filter) {
      comments = this._applyCommentFilter(comments, filter);
    }
    
    // Apply sort
    if (sort) {
      comments = this._applyCommentSort(comments, sort);
    }
    
    return comments;
  }
  
  /**
   * Apply filter to threads
   */
  private _applyThreadFilter(threads: ICommentThread[], filter: ICommentFilter): ICommentThread[] {
    return threads.filter(thread => {
      // Cell ID filter
      if (filter.cellId && thread.cellId !== filter.cellId) {
        return false;
      }
      
      // Resolved filter
      if (filter.resolved !== undefined && thread.resolved !== filter.resolved) {
        return false;
      }
      
      // Date range filter
      if (filter.dateRange) {
        if (thread.createdAt < filter.dateRange.start || 
            thread.createdAt > filter.dateRange.end) {
          return false;
        }
      }
      
      // Priority filter
      if (filter.priority && filter.priority.length > 0) {
        if (!filter.priority.includes(thread.priority)) {
          return false;
        }
      }
      
      // Tags filter
      if (filter.tags && filter.tags.length > 0) {
        const hasMatchingTag = filter.tags.some(tag => 
          thread.labels.includes(tag)
        );
        if (!hasMatchingTag) {
          return false;
        }
      }
      
      return true;
    });
  }
  
  /**
   * Apply filter to comments
   */
  private _applyCommentFilter(comments: IComment[], filter: ICommentFilter): IComment[] {
    return comments.filter(comment => {
      // Author filter
      if (filter.authorId && comment.userId !== filter.authorId) {
        return false;
      }
      
      // Status filter
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(comment.status)) {
          return false;
        }
      }
      
      // Visibility filter
      if (filter.visibility && comment.visibility !== filter.visibility) {
        return false;
      }
      
      // Date range filter
      if (filter.dateRange) {
        if (comment.timestamp < filter.dateRange.start || 
            comment.timestamp > filter.dateRange.end) {
          return false;
        }
      }
      
      // Search text filter
      if (filter.searchText) {
        const searchLower = filter.searchText.toLowerCase();
        if (!comment.content.toLowerCase().includes(searchLower) &&
            !comment.userName.toLowerCase().includes(searchLower)) {
          return false;
        }
      }
      
      // Mentions filter
      if (filter.mentions && filter.mentions.length > 0) {
        const hasMatchingMention = filter.mentions.some(mention =>
          comment.mentions.includes(mention)
        );
        if (!hasMatchingMention) {
          return false;
        }
      }
      
      // Pinned filter
      if (filter.pinnedOnly && !comment.pinned) {
        return false;
      }
      
      return true;
    });
  }
  
  /**
   * Apply sort to threads
   */
  private _applyThreadSort(threads: ICommentThread[], sort: ICommentSort): ICommentThread[] {
    return threads.sort((a, b) => {
      let comparison = 0;
      
      switch (sort.field) {
        case 'timestamp':
          comparison = a.createdAt.getTime() - b.createdAt.getTime();
          break;
        case 'lastModified':
          comparison = a.lastActivity.getTime() - b.lastActivity.getTime();
          break;
        case 'priority':
          const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
          comparison = priorityOrder[a.priority] - priorityOrder[b.priority];
          break;
        default:
          comparison = 0;
      }
      
      return sort.direction === 'desc' ? -comparison : comparison;
    });
  }
  
  /**
   * Apply sort to comments
   */
  private _applyCommentSort(comments: IComment[], sort: ICommentSort): IComment[] {
    return comments.sort((a, b) => {
      let comparison = 0;
      
      switch (sort.field) {
        case 'timestamp':
          comparison = a.timestamp.getTime() - b.timestamp.getTime();
          break;
        case 'lastModified':
          const aModified = a.lastModified || a.timestamp;
          const bModified = b.lastModified || b.timestamp;
          comparison = aModified.getTime() - bModified.getTime();
          break;
        case 'author':
          comparison = a.userName.localeCompare(b.userName);
          break;
        case 'status':
          comparison = a.status.localeCompare(b.status);
          break;
        default:
          comparison = 0;
      }
      
      return sort.direction === 'desc' ? -comparison : comparison;
    });
  }
  
  /**
   * Export comments as CSV
   */
  private _exportCommentsAsCSV(threads: ICommentThread[]): string {
    const headers = [
      'Thread ID', 'Cell ID', 'Comment ID', 'Author', 'Content', 
      'Timestamp', 'Status', 'Resolved', 'Tags'
    ];
    
    const rows = [headers.join(',')];
    
    for (const thread of threads) {
      for (const comment of thread.comments) {
        const row = [
          thread.id,
          comment.cellId,
          comment.id,
          comment.userName,
          `"${comment.content.replace(/"/g, '""')}"`,
          comment.timestamp.toISOString(),
          comment.status,
          thread.resolved.toString(),
          comment.tags.join(';')
        ];
        rows.push(row.join(','));
      }
    }
    
    return rows.join('\n');
  }
  
  /**
   * Export comments as Markdown
   */
  private _exportCommentsAsMarkdown(threads: ICommentThread[]): string {
    const lines: string[] = [];
    lines.push('# Comments Export');
    lines.push('');
    
    for (const thread of threads) {
      lines.push(`## Thread: ${thread.id}`);
      lines.push(`**Cell:** ${thread.cellId}`);
      lines.push(`**Status:** ${thread.resolved ? 'Resolved' : 'Open'}`);
      lines.push(`**Created:** ${thread.createdAt.toLocaleString()}`);
      lines.push('');
      
      for (const comment of thread.comments) {
        lines.push(`### ${comment.userName} - ${comment.timestamp.toLocaleString()}`);
        lines.push('');
        lines.push(comment.content);
        lines.push('');
        
        if (comment.tags.length > 0) {
          lines.push(`**Tags:** ${comment.tags.join(', ')}`);
          lines.push('');
        }
      }
      
      lines.push('---');
      lines.push('');
    }
    
    return lines.join('\n');
  }
  
  /**
   * Import comments from JSON
   */
  private async _importCommentsFromJSON(data: string): Promise<void> {
    try {
      const threads: ICommentThread[] = JSON.parse(data);
      
      for (const threadData of threads) {
        // Validate and import thread
        const thread = this._deserializeThread(threadData);
        this._threads.set(thread.id, thread);
        
        // Import comments
        for (const commentData of threadData.comments) {
          const comment = this._deserializeComment(commentData);
          this._comments.set(comment.id, comment);
        }
      }
      
      this._pendingUpdates.add('threads');
      this._pendingUpdates.add('comments');
      
    } catch (error) {
      throw new Error(`Failed to import JSON comments: ${error}`);
    }
  }
  
  /**
   * Import comments from CSV
   */
  private async _importCommentsFromCSV(data: string): Promise<void> {
    const lines = data.split('\n');
    if (lines.length < 2) {
      throw new Error('Invalid CSV format');
    }
    
    // Skip header row
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      try {
        const columns = this._parseCSVLine(line);
        if (columns.length < 9) continue;
        
        const [threadId, cellId, commentId, author, content, timestamp, status, resolved, tags] = columns;
        
        // Create or get thread
        let thread = this._threads.get(threadId);
        if (!thread) {
          thread = {
            id: threadId,
            cellId,
            comments: [],
            resolved: resolved === 'true',
            locked: false,
            priority: 'medium',
            labels: [],
            assignees: [],
            createdAt: new Date(timestamp),
            lastActivity: new Date(timestamp),
            metadata: {}
          };
          this._threads.set(threadId, thread);
        }
        
        // Create comment
        const comment: IComment = {
          id: commentId,
          cellId,
          userId: 'imported',
          userName: author,
          content: content.replace(/""/g, '"'), // Unescape quotes
          timestamp: new Date(timestamp),
          status: status as CommentStatus,
          visibility: CommentVisibility.Public,
          threadId,
          reactions: [],
          tags: tags.split(';').filter(t => t),
          mentions: [],
          pinned: false,
          metadata: { imported: true }
        };
        
        this._comments.set(commentId, comment);
        
        if (!thread.comments.find(c => c.id === commentId)) {
          thread.comments.push(comment);
        }
        
      } catch (error) {
        console.warn(`Failed to import CSV line ${i}:`, error);
      }
    }
    
    this._pendingUpdates.add('threads');
    this._pendingUpdates.add('comments');
  }
  
  /**
   * Parse a CSV line handling quoted fields
   */
  private _parseCSVLine(line: string): string[] {
    const columns: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        columns.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    columns.push(current.trim());
    return columns;
  }
}

/**
 * Create a new comment manager instance
 */
export function createCommentManager(options: {
  yjsProvider?: IYjsNotebookProvider;
  permissionsManager?: IPermissionsManager;
  translator?: ITranslator;
  currentUser?: User.IUser;
  enabled?: boolean;
} = {}): ICommentManager {
  return new CommentManager(options);
}

/**
 * Token for the comment manager
 */
export const ICommentManagerToken = Symbol('ICommentManagerToken');