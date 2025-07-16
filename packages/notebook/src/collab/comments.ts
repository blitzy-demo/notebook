// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';
import { YNotebook } from '@jupyter/ydoc';
import { Signal, ISignal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import { ICellModel } from '@jupyterlab/cells';
import { MarkdownRenderer } from '@jupyterlab/rendermime';
import { Time } from '@jupyterlab/coreutils';
import YjsNotebookProvider from './provider';
import UserAwareness from './awareness';
import { IPermissionsManager, PermissionAction } from './permissions';

/**
 * Enumeration of comment status states
 */
export enum CommentStatus {
  /** Comment is active and visible */
  ACTIVE = 'active',
  /** Comment has been resolved */
  RESOLVED = 'resolved',
  /** Comment has been deleted */
  DELETED = 'deleted',
  /** Comment is in draft state */
  DRAFT = 'draft'
}

/**
 * Enumeration of comment permission levels
 */
export enum CommentPermission {
  /** Permission to create new comments */
  CREATE = 'create',
  /** Permission to read comments */
  READ = 'read',
  /** Permission to update/edit comments */
  UPDATE = 'update',
  /** Permission to delete comments */
  DELETE = 'delete',
  /** Permission to resolve comments */
  RESOLVE = 'resolve',
  /** Permission to reply to comments */
  REPLY = 'reply'
}

/**
 * Enumeration of comment event types
 */
export enum CommentEventType {
  /** Comment was created */
  COMMENT_CREATED = 'comment_created',
  /** Comment was updated */
  COMMENT_UPDATED = 'comment_updated',
  /** Comment was deleted */
  COMMENT_DELETED = 'comment_deleted',
  /** Comment was resolved */
  COMMENT_RESOLVED = 'comment_resolved',
  /** Comment was unresolved */
  COMMENT_UNRESOLVED = 'comment_unresolved',
  /** Reply was added to comment */
  REPLY_ADDED = 'reply_added',
  /** New comment thread was created */
  THREAD_CREATED = 'thread_created',
  /** Comment thread was resolved */
  THREAD_RESOLVED = 'thread_resolved'
}

/**
 * Interface representing a comment in the system
 */
export interface IComment {
  /** Unique comment identifier */
  id: string;
  /** Cell ID that this comment is attached to */
  cellId: string;
  /** Parent comment ID for threaded discussions */
  parentId?: string;
  /** Comment author information */
  author: {
    userId: string;
    username: string;
    displayName: string;
    avatar?: string;
  };
  /** Comment content in markdown format */
  content: string;
  /** Timestamp when comment was created */
  timestamp: number;
  /** Timestamp when comment was last modified */
  lastModified: number;
  /** Whether the comment is resolved */
  resolved: boolean;
  /** User who resolved the comment */
  resolvedBy?: string;
  /** Timestamp when comment was resolved */
  resolvedAt?: number;
  /** Array of reply comment IDs */
  replies: string[];
  /** Additional metadata */
  metadata?: { [key: string]: any };
  /** Comment permissions */
  permissions?: CommentPermission[];
  /** Whether this is a reply to another comment */
  isReply: boolean;
  /** Depth in the thread hierarchy */
  depth: number;
}

/**
 * Interface representing a comment thread
 */
export interface ICommentThread {
  /** Unique thread identifier */
  id: string;
  /** Cell ID that this thread is attached to */
  cellId: string;
  /** Parent comment ID for nested threads */
  parentId?: string;
  /** Thread author information */
  author: {
    userId: string;
    username: string;
    displayName: string;
    avatar?: string;
  };
  /** Thread content in markdown format */
  content: string;
  /** Timestamp when thread was created */
  timestamp: number;
  /** Timestamp when thread was last modified */
  lastModified: number;
  /** Whether the thread is resolved */
  resolved: boolean;
  /** User who resolved the thread */
  resolvedBy?: string;
  /** Timestamp when thread was resolved */
  resolvedAt?: number;
  /** Array of reply comment IDs */
  replies: string[];
  /** Additional metadata */
  metadata?: { [key: string]: any };
  /** Thread permissions */
  permissions?: CommentPermission[];
  /** Whether this is a reply to another comment */
  isReply: boolean;
  /** Depth in the thread hierarchy */
  depth: number;
  
  /** Render the comment content as HTML */
  renderContent(): Promise<string>;
  /** Add a reply to this thread */
  addReply(reply: IComment): void;
  /** Mark thread as resolved */
  resolve(): void;
  /** Mark thread as unresolved */
  unresolve(): void;
}

/**
 * Interface for comment filtering options
 */
export interface ICommentFilter {
  /** Filter by specific cell ID */
  cellId?: string;
  /** Filter by comment author */
  author?: string;
  /** Filter by comment status */
  status?: CommentStatus;
  /** Filter by date range */
  dateRange?: {
    start: number;
    end: number;
  };
  /** Filter by search text in content */
  searchText?: string;
  /** Filter by resolved status */
  resolved?: boolean;
  /** Filter comments that have replies */
  hasReplies?: boolean;
  /** Include replies in results */
  includeReplies?: boolean;
  /** Sort by field */
  sortBy?: 'timestamp' | 'author' | 'resolved' | 'cellId';
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
  /** Limit number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Interface for comment notifications
 */
export interface ICommentNotification {
  /** Unique notification identifier */
  id: string;
  /** Comment ID that triggered the notification */
  commentId: string;
  /** Notification type */
  type: CommentEventType;
  /** Recipient user ID */
  recipient: string;
  /** Sender user ID */
  sender: string;
  /** Notification message */
  message: string;
  /** Timestamp when notification was created */
  timestamp: number;
  /** Whether notification has been read */
  read: boolean;
  /** Cell ID associated with the notification */
  cellId: string;
  /** Notebook ID associated with the notification */
  notebookId: string;
  
  /** Mark notification as read */
  markAsRead(): void;
  /** Dismiss the notification */
  dismiss(): void;
}

/**
 * Interface for comment registry functionality
 */
export interface ICommentRegistry {
  /** Register a comment in the system */
  register(comment: IComment): void;
  /** Unregister a comment from the system */
  unregister(commentId: string): void;
  /** Get comments for a specific cell */
  getCommentsForCell(cellId: string): IComment[];
  /** Get comment by ID */
  getCommentById(commentId: string): IComment | null;
  /** Get all comments */
  getAllComments(): IComment[];
  /** Get comments by author */
  getCommentsByAuthor(authorId: string): IComment[];
  /** Get resolved comments */
  getResolvedComments(): IComment[];
  /** Get unresolved comments */
  getUnresolvedComments(): IComment[];
  /** Clear all comments */
  clear(): void;
  /** Number of comments in registry */
  size: number;
  
  /** Signal emitted when comment is added */
  onCommentAdded: ISignal<ICommentRegistry, IComment>;
  /** Signal emitted when comment is removed */
  onCommentRemoved: ISignal<ICommentRegistry, IComment>;
  /** Signal emitted when comment is changed */
  onCommentChanged: ISignal<ICommentRegistry, IComment>;
}

/**
 * Interface for comment manager functionality
 */
export interface ICommentManager {
  /** Create a new comment */
  createComment(cellId: string, content: string, parentId?: string): Promise<IComment>;
  /** Update an existing comment */
  updateComment(commentId: string, content: string): Promise<IComment>;
  /** Delete a comment */
  deleteComment(commentId: string): Promise<void>;
  /** Resolve a comment */
  resolveComment(commentId: string): Promise<void>;
  /** Get all comments */
  getComments(filter?: ICommentFilter): Promise<IComment[]>;
  /** Get comments for a specific cell */
  getCommentsForCell(cellId: string): Promise<IComment[]>;
  /** Subscribe to comment updates */
  subscribeToComments(callback: (event: CommentEventType, comment: IComment) => void): IDisposable;
  /** Unsubscribe from comment updates */
  unsubscribeFromComments(subscription: IDisposable): void;
  /** Get comment thread */
  getCommentThread(commentId: string): Promise<ICommentThread>;
  /** Get comments by user */
  getUserComments(userId: string): Promise<IComment[]>;
  
  /** Signal emitted when comment is created */
  onCommentCreated: ISignal<ICommentManager, IComment>;
  /** Signal emitted when comment is updated */
  onCommentUpdated: ISignal<ICommentManager, IComment>;
  /** Signal emitted when comment is deleted */
  onCommentDeleted: ISignal<ICommentManager, IComment>;
  /** Signal emitted when comment is resolved */
  onCommentResolved: ISignal<ICommentManager, IComment>;
}

/**
 * Interface for comment configuration
 */
interface ICommentConfig {
  /** Maximum depth for threaded discussions */
  maxDepth: number;
  /** Page size for pagination */
  pageSize: number;
  /** Enable real-time synchronization */
  enableRealtimeSync: boolean;
  /** Enable markdown rendering */
  enableMarkdownRendering: boolean;
  /** Enable notifications */
  enableNotifications: boolean;
  /** Auto-resolve timeout in milliseconds */
  autoResolveTimeout?: number;
  /** Maximum comment length */
  maxCommentLength: number;
  /** Allowed markdown features */
  allowedMarkdownFeatures: string[];
}

/**
 * Default comment configuration
 */
const DEFAULT_COMMENT_CONFIG: ICommentConfig = {
  maxDepth: 5,
  pageSize: 20,
  enableRealtimeSync: true,
  enableMarkdownRendering: true,
  enableNotifications: true,
  maxCommentLength: 5000,
  allowedMarkdownFeatures: ['emphasis', 'strong', 'code', 'codeBlock', 'link', 'list']
};

/**
 * Implementation of comment registry
 */
class CommentRegistry implements ICommentRegistry {
  private _comments = new Map<string, IComment>();
  private _commentsByCell = new Map<string, Set<string>>();
  private _commentsByAuthor = new Map<string, Set<string>>();
  
  // Signals
  private _onCommentAdded = new Signal<ICommentRegistry, IComment>(this);
  private _onCommentRemoved = new Signal<ICommentRegistry, IComment>(this);
  private _onCommentChanged = new Signal<ICommentRegistry, IComment>(this);

  /**
   * Register a comment in the system
   */
  register(comment: IComment): void {
    const existing = this._comments.get(comment.id);
    this._comments.set(comment.id, comment);
    
    // Index by cell
    if (!this._commentsByCell.has(comment.cellId)) {
      this._commentsByCell.set(comment.cellId, new Set());
    }
    this._commentsByCell.get(comment.cellId)!.add(comment.id);
    
    // Index by author
    if (!this._commentsByAuthor.has(comment.author.userId)) {
      this._commentsByAuthor.set(comment.author.userId, new Set());
    }
    this._commentsByAuthor.get(comment.author.userId)!.add(comment.id);
    
    // Emit appropriate signal
    if (!existing) {
      this._onCommentAdded.emit(comment);
    } else {
      this._onCommentChanged.emit(comment);
    }
  }

  /**
   * Unregister a comment from the system
   */
  unregister(commentId: string): void {
    const comment = this._comments.get(commentId);
    if (!comment) {
      return;
    }
    
    // Remove from main map
    this._comments.delete(commentId);
    
    // Remove from cell index
    const cellComments = this._commentsByCell.get(comment.cellId);
    if (cellComments) {
      cellComments.delete(commentId);
      if (cellComments.size === 0) {
        this._commentsByCell.delete(comment.cellId);
      }
    }
    
    // Remove from author index
    const authorComments = this._commentsByAuthor.get(comment.author.userId);
    if (authorComments) {
      authorComments.delete(commentId);
      if (authorComments.size === 0) {
        this._commentsByAuthor.delete(comment.author.userId);
      }
    }
    
    this._onCommentRemoved.emit(comment);
  }

  /**
   * Get comments for a specific cell
   */
  getCommentsForCell(cellId: string): IComment[] {
    const commentIds = this._commentsByCell.get(cellId);
    if (!commentIds) {
      return [];
    }
    
    const comments: IComment[] = [];
    commentIds.forEach(id => {
      const comment = this._comments.get(id);
      if (comment) {
        comments.push(comment);
      }
    });
    
    return comments.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get comment by ID
   */
  getCommentById(commentId: string): IComment | null {
    return this._comments.get(commentId) || null;
  }

  /**
   * Get all comments
   */
  getAllComments(): IComment[] {
    return Array.from(this._comments.values());
  }

  /**
   * Get comments by author
   */
  getCommentsByAuthor(authorId: string): IComment[] {
    const commentIds = this._commentsByAuthor.get(authorId);
    if (!commentIds) {
      return [];
    }
    
    const comments: IComment[] = [];
    commentIds.forEach(id => {
      const comment = this._comments.get(id);
      if (comment) {
        comments.push(comment);
      }
    });
    
    return comments.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get resolved comments
   */
  getResolvedComments(): IComment[] {
    return Array.from(this._comments.values()).filter(comment => comment.resolved);
  }

  /**
   * Get unresolved comments
   */
  getUnresolvedComments(): IComment[] {
    return Array.from(this._comments.values()).filter(comment => !comment.resolved);
  }

  /**
   * Clear all comments
   */
  clear(): void {
    this._comments.clear();
    this._commentsByCell.clear();
    this._commentsByAuthor.clear();
  }

  /**
   * Number of comments in registry
   */
  get size(): number {
    return this._comments.size;
  }

  /**
   * Signal emitted when comment is added
   */
  get onCommentAdded(): ISignal<ICommentRegistry, IComment> {
    return this._onCommentAdded;
  }

  /**
   * Signal emitted when comment is removed
   */
  get onCommentRemoved(): ISignal<ICommentRegistry, IComment> {
    return this._onCommentRemoved;
  }

  /**
   * Signal emitted when comment is changed
   */
  get onCommentChanged(): ISignal<ICommentRegistry, IComment> {
    return this._onCommentChanged;
  }
}

/**
 * Implementation of comment thread
 */
class CommentThread implements ICommentThread {
  private _comment: IComment;
  private _renderer: MarkdownRenderer;

  constructor(comment: IComment, renderer: MarkdownRenderer) {
    this._comment = comment;
    this._renderer = renderer;
  }

  get id(): string {
    return this._comment.id;
  }

  get cellId(): string {
    return this._comment.cellId;
  }

  get parentId(): string | undefined {
    return this._comment.parentId;
  }

  get author(): { userId: string; username: string; displayName: string; avatar?: string } {
    return this._comment.author;
  }

  get content(): string {
    return this._comment.content;
  }

  get timestamp(): number {
    return this._comment.timestamp;
  }

  get lastModified(): number {
    return this._comment.lastModified;
  }

  get resolved(): boolean {
    return this._comment.resolved;
  }

  get resolvedBy(): string | undefined {
    return this._comment.resolvedBy;
  }

  get resolvedAt(): number | undefined {
    return this._comment.resolvedAt;
  }

  get replies(): string[] {
    return this._comment.replies;
  }

  get metadata(): { [key: string]: any } | undefined {
    return this._comment.metadata;
  }

  get permissions(): CommentPermission[] | undefined {
    return this._comment.permissions;
  }

  get isReply(): boolean {
    return this._comment.isReply;
  }

  get depth(): number {
    return this._comment.depth;
  }

  /**
   * Render the comment content as HTML
   */
  async renderContent(): Promise<string> {
    if (!this._renderer) {
      return this._comment.content;
    }
    
    try {
      const renderer = this._renderer.createRenderer('text/markdown');
      const model = renderer.createModel({
        data: { 'text/markdown': this._comment.content }
      });
      await renderer.renderModel(model);
      return model.data['text/html'] || this._comment.content;
    } catch (error) {
      console.error('Failed to render comment content:', error);
      return this._comment.content;
    }
  }

  /**
   * Add a reply to this thread
   */
  addReply(reply: IComment): void {
    if (!this._comment.replies.includes(reply.id)) {
      this._comment.replies.push(reply.id);
      this._comment.lastModified = Date.now();
    }
  }

  /**
   * Mark thread as resolved
   */
  resolve(): void {
    this._comment.resolved = true;
    this._comment.resolvedAt = Date.now();
    this._comment.lastModified = Date.now();
  }

  /**
   * Mark thread as unresolved
   */
  unresolve(): void {
    this._comment.resolved = false;
    this._comment.resolvedBy = undefined;
    this._comment.resolvedAt = undefined;
    this._comment.lastModified = Date.now();
  }
}

/**
 * CommentSystem: Comprehensive comment and review system for collaborative notebook editing
 * 
 * This system enables threaded discussions and review workflows attached to specific cells,
 * with real-time synchronization via Yjs, markdown rendering, and permission-based access control.
 */
export default class CommentSystem implements ICommentManager, IDisposable {
  private _provider: YjsNotebookProvider;
  private _awareness: UserAwareness;
  private _permissions: IPermissionsManager;
  private _commentsMap: Y.Map<any>;
  private _threadsMap: Y.Map<any>;
  private _notificationsMap: Y.Map<any>;
  private _commentRegistry: CommentRegistry;
  private _config: ICommentConfig;
  private _renderer: MarkdownRenderer;
  private _disposed = false;
  private _subscriptions = new Map<string, IDisposable>();
  private _notificationQueue: ICommentNotification[] = [];

  // Signals for comment events
  private _onCommentCreated = new Signal<CommentSystem, IComment>(this);
  private _onCommentUpdated = new Signal<CommentSystem, IComment>(this);
  private _onCommentDeleted = new Signal<CommentSystem, IComment>(this);
  private _onCommentResolved = new Signal<CommentSystem, IComment>(this);
  private _onCommentUnresolved = new Signal<CommentSystem, IComment>(this);
  private _onThreadCreated = new Signal<CommentSystem, ICommentThread>(this);

  /**
   * Construct a new CommentSystem
   * 
   * @param provider - Yjs notebook provider for real-time synchronization
   * @param awareness - User awareness system for user context
   * @param permissions - Permissions manager for access control
   * @param config - Configuration options
   */
  constructor(
    provider: YjsNotebookProvider,
    awareness: UserAwareness,
    permissions: IPermissionsManager,
    config: Partial<ICommentConfig> = {}
  ) {
    this._provider = provider;
    this._awareness = awareness;
    this._permissions = permissions;
    this._config = { ...DEFAULT_COMMENT_CONFIG, ...config };
    this._commentRegistry = new CommentRegistry();
    
    // Initialize Yjs maps for shared comment state
    this._commentsMap = provider.yjsDocument.getMap('comments');
    this._threadsMap = provider.yjsDocument.getMap('threads');
    this._notificationsMap = provider.yjsDocument.getMap('notifications');
    
    // Initialize markdown renderer
    this._renderer = new MarkdownRenderer();
    
    // Set up real-time synchronization
    if (this._config.enableRealtimeSync) {
      this._setupRealtimeSync();
    }
    
    // Set up comment registry observers
    this._setupRegistryObservers();
    
    // Set up provider observers
    this._setupProviderObservers();
    
    // Load existing comments from shared state
    this._loadExistingComments();
  }

  /**
   * Get the comment registry
   */
  get commentRegistry(): ICommentRegistry {
    return this._commentRegistry;
  }

  /**
   * Check if comment system is enabled
   */
  get isEnabled(): boolean {
    return !this._disposed && this._provider.isConnected;
  }

  /**
   * Get the permissions manager
   */
  get permissions(): IPermissionsManager {
    return this._permissions;
  }

  /**
   * Signal emitted when comment is created
   */
  get onCommentCreated(): ISignal<CommentSystem, IComment> {
    return this._onCommentCreated;
  }

  /**
   * Signal emitted when comment is updated
   */
  get onCommentUpdated(): ISignal<CommentSystem, IComment> {
    return this._onCommentUpdated;
  }

  /**
   * Signal emitted when comment is deleted
   */
  get onCommentDeleted(): ISignal<CommentSystem, IComment> {
    return this._onCommentDeleted;
  }

  /**
   * Signal emitted when comment is resolved
   */
  get onCommentResolved(): ISignal<CommentSystem, IComment> {
    return this._onCommentResolved;
  }

  /**
   * Signal emitted when comment is unresolved
   */
  get onCommentUnresolved(): ISignal<CommentSystem, IComment> {
    return this._onCommentUnresolved;
  }

  /**
   * Signal emitted when thread is created
   */
  get onThreadCreated(): ISignal<CommentSystem, ICommentThread> {
    return this._onThreadCreated;
  }

  /**
   * Create a new comment
   */
  async createComment(cellId: string, content: string, parentId?: string): Promise<IComment> {
    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser) {
      throw new Error('No current user available');
    }
    
    // Check permissions
    const canCreate = await this._permissions.checkPermission(
      currentUser.id,
      PermissionAction.COMMENT,
      cellId
    );
    
    if (!canCreate) {
      throw new Error('Insufficient permissions to create comment');
    }
    
    // Validate content length
    if (content.length > this._config.maxCommentLength) {
      throw new Error(`Comment content exceeds maximum length of ${this._config.maxCommentLength} characters`);
    }
    
    // Calculate depth for threaded discussions
    let depth = 0;
    if (parentId) {
      const parentComment = this._commentRegistry.getCommentById(parentId);
      if (parentComment) {
        depth = parentComment.depth + 1;
        if (depth > this._config.maxDepth) {
          throw new Error(`Maximum thread depth of ${this._config.maxDepth} exceeded`);
        }
      }
    }
    
    // Create comment object
    const comment: IComment = {
      id: UUID.uuid4(),
      cellId,
      parentId,
      author: {
        userId: currentUser.id,
        username: currentUser.username,
        displayName: currentUser.displayName,
        avatar: currentUser.metadata?.avatar
      },
      content,
      timestamp: Date.now(),
      lastModified: Date.now(),
      resolved: false,
      replies: [],
      metadata: {
        userAgent: navigator.userAgent,
        cellType: 'code' // Could be determined from cell model
      },
      permissions: [
        CommentPermission.READ,
        CommentPermission.UPDATE,
        CommentPermission.DELETE
      ],
      isReply: !!parentId,
      depth
    };
    
    // Store in shared state
    this._commentsMap.set(comment.id, comment);
    
    // Register in local registry
    this._commentRegistry.register(comment);
    
    // Update parent comment if this is a reply
    if (parentId) {
      const parentComment = this._commentRegistry.getCommentById(parentId);
      if (parentComment) {
        parentComment.replies.push(comment.id);
        parentComment.lastModified = Date.now();
        this._commentsMap.set(parentId, parentComment);
        this._commentRegistry.register(parentComment);
      }
    }
    
    // Create notification
    if (this._config.enableNotifications) {
      await this._createNotification(comment, CommentEventType.COMMENT_CREATED);
    }
    
    // Emit signal
    this._onCommentCreated.emit(comment);
    
    return comment;
  }

  /**
   * Update an existing comment
   */
  async updateComment(commentId: string, content: string): Promise<IComment> {
    const comment = this._commentRegistry.getCommentById(commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${commentId}`);
    }
    
    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser) {
      throw new Error('No current user available');
    }
    
    // Check permissions - user can update their own comments or have UPDATE permission
    const canUpdate = comment.author.userId === currentUser.id ||
                     await this._permissions.checkPermission(
                       currentUser.id,
                       PermissionAction.COMMENT,
                       comment.cellId
                     );
    
    if (!canUpdate) {
      throw new Error('Insufficient permissions to update comment');
    }
    
    // Validate content length
    if (content.length > this._config.maxCommentLength) {
      throw new Error(`Comment content exceeds maximum length of ${this._config.maxCommentLength} characters`);
    }
    
    // Update comment
    const updatedComment: IComment = {
      ...comment,
      content,
      lastModified: Date.now()
    };
    
    // Store in shared state
    this._commentsMap.set(commentId, updatedComment);
    
    // Update in local registry
    this._commentRegistry.register(updatedComment);
    
    // Create notification
    if (this._config.enableNotifications) {
      await this._createNotification(updatedComment, CommentEventType.COMMENT_UPDATED);
    }
    
    // Emit signal
    this._onCommentUpdated.emit(updatedComment);
    
    return updatedComment;
  }

  /**
   * Delete a comment
   */
  async deleteComment(commentId: string): Promise<void> {
    const comment = this._commentRegistry.getCommentById(commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${commentId}`);
    }
    
    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser) {
      throw new Error('No current user available');
    }
    
    // Check permissions - user can delete their own comments or have DELETE permission
    const canDelete = comment.author.userId === currentUser.id ||
                     await this._permissions.checkPermission(
                       currentUser.id,
                       PermissionAction.DELETE,
                       comment.cellId
                     );
    
    if (!canDelete) {
      throw new Error('Insufficient permissions to delete comment');
    }
    
    // Remove from shared state
    this._commentsMap.delete(commentId);
    
    // Remove from local registry
    this._commentRegistry.unregister(commentId);
    
    // Remove from parent comment replies if this is a reply
    if (comment.parentId) {
      const parentComment = this._commentRegistry.getCommentById(comment.parentId);
      if (parentComment) {
        const replyIndex = parentComment.replies.indexOf(commentId);
        if (replyIndex !== -1) {
          parentComment.replies.splice(replyIndex, 1);
          parentComment.lastModified = Date.now();
          this._commentsMap.set(comment.parentId, parentComment);
          this._commentRegistry.register(parentComment);
        }
      }
    }
    
    // Recursively delete replies
    for (const replyId of comment.replies) {
      await this.deleteComment(replyId);
    }
    
    // Create notification
    if (this._config.enableNotifications) {
      await this._createNotification(comment, CommentEventType.COMMENT_DELETED);
    }
    
    // Emit signal
    this._onCommentDeleted.emit(comment);
  }

  /**
   * Resolve a comment
   */
  async resolveComment(commentId: string): Promise<void> {
    const comment = this._commentRegistry.getCommentById(commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${commentId}`);
    }
    
    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser) {
      throw new Error('No current user available');
    }
    
    // Check permissions
    const canResolve = await this._permissions.checkPermission(
      currentUser.id,
      PermissionAction.COMMENT,
      comment.cellId
    );
    
    if (!canResolve) {
      throw new Error('Insufficient permissions to resolve comment');
    }
    
    // Update comment
    const resolvedComment: IComment = {
      ...comment,
      resolved: true,
      resolvedBy: currentUser.id,
      resolvedAt: Date.now(),
      lastModified: Date.now()
    };
    
    // Store in shared state
    this._commentsMap.set(commentId, resolvedComment);
    
    // Update in local registry
    this._commentRegistry.register(resolvedComment);
    
    // Create notification
    if (this._config.enableNotifications) {
      await this._createNotification(resolvedComment, CommentEventType.COMMENT_RESOLVED);
    }
    
    // Emit signal
    this._onCommentResolved.emit(resolvedComment);
  }

  /**
   * Unresolve a comment
   */
  async unresolveComment(commentId: string): Promise<void> {
    const comment = this._commentRegistry.getCommentById(commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${commentId}`);
    }
    
    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser) {
      throw new Error('No current user available');
    }
    
    // Check permissions
    const canUnresolve = await this._permissions.checkPermission(
      currentUser.id,
      PermissionAction.COMMENT,
      comment.cellId
    );
    
    if (!canUnresolve) {
      throw new Error('Insufficient permissions to unresolve comment');
    }
    
    // Update comment
    const unresolvedComment: IComment = {
      ...comment,
      resolved: false,
      resolvedBy: undefined,
      resolvedAt: undefined,
      lastModified: Date.now()
    };
    
    // Store in shared state
    this._commentsMap.set(commentId, unresolvedComment);
    
    // Update in local registry
    this._commentRegistry.register(unresolvedComment);
    
    // Create notification
    if (this._config.enableNotifications) {
      await this._createNotification(unresolvedComment, CommentEventType.COMMENT_UNRESOLVED);
    }
    
    // Emit signal
    this._onCommentUnresolved.emit(unresolvedComment);
  }

  /**
   * Get all comments with optional filtering
   */
  async getComments(filter?: ICommentFilter): Promise<IComment[]> {
    let comments = this._commentRegistry.getAllComments();
    
    if (!filter) {
      return comments;
    }
    
    // Apply filters
    if (filter.cellId) {
      comments = comments.filter(comment => comment.cellId === filter.cellId);
    }
    
    if (filter.author) {
      comments = comments.filter(comment => comment.author.userId === filter.author);
    }
    
    if (filter.resolved !== undefined) {
      comments = comments.filter(comment => comment.resolved === filter.resolved);
    }
    
    if (filter.searchText) {
      const searchLower = filter.searchText.toLowerCase();
      comments = comments.filter(comment => 
        comment.content.toLowerCase().includes(searchLower) ||
        comment.author.displayName.toLowerCase().includes(searchLower)
      );
    }
    
    if (filter.dateRange) {
      comments = comments.filter(comment => 
        comment.timestamp >= filter.dateRange!.start &&
        comment.timestamp <= filter.dateRange!.end
      );
    }
    
    if (filter.hasReplies !== undefined) {
      comments = comments.filter(comment => 
        (comment.replies.length > 0) === filter.hasReplies
      );
    }
    
    if (!filter.includeReplies) {
      comments = comments.filter(comment => !comment.isReply);
    }
    
    // Apply sorting
    if (filter.sortBy) {
      comments.sort((a, b) => {
        let aValue: any;
        let bValue: any;
        
        switch (filter.sortBy) {
          case 'timestamp':
            aValue = a.timestamp;
            bValue = b.timestamp;
            break;
          case 'author':
            aValue = a.author.displayName;
            bValue = b.author.displayName;
            break;
          case 'resolved':
            aValue = a.resolved;
            bValue = b.resolved;
            break;
          case 'cellId':
            aValue = a.cellId;
            bValue = b.cellId;
            break;
          default:
            aValue = a.timestamp;
            bValue = b.timestamp;
        }
        
        if (filter.sortOrder === 'desc') {
          return bValue < aValue ? -1 : bValue > aValue ? 1 : 0;
        } else {
          return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
        }
      });
    }
    
    // Apply pagination
    if (filter.offset !== undefined || filter.limit !== undefined) {
      const offset = filter.offset || 0;
      const limit = filter.limit || comments.length;
      comments = comments.slice(offset, offset + limit);
    }
    
    return comments;
  }

  /**
   * Get comments for a specific cell
   */
  async getCommentsForCell(cellId: string): Promise<IComment[]> {
    return this._commentRegistry.getCommentsForCell(cellId);
  }

  /**
   * Get comment by ID
   */
  async getCommentById(commentId: string): Promise<IComment | null> {
    return this._commentRegistry.getCommentById(commentId);
  }

  /**
   * Get comment thread
   */
  async getCommentThread(commentId: string): Promise<ICommentThread> {
    const comment = this._commentRegistry.getCommentById(commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${commentId}`);
    }
    
    return new CommentThread(comment, this._renderer);
  }

  /**
   * Get comments by user
   */
  async getUserComments(userId: string): Promise<IComment[]> {
    return this._commentRegistry.getCommentsByAuthor(userId);
  }

  /**
   * Subscribe to comment updates
   */
  subscribeToComments(callback: (event: CommentEventType, comment: IComment) => void): IDisposable {
    const subscriptionId = UUID.uuid4();
    
    const disposable = {
      dispose: () => {
        this._subscriptions.delete(subscriptionId);
      }
    };
    
    this._subscriptions.set(subscriptionId, disposable);
    
    // Connect to all relevant signals
    this._onCommentCreated.connect((sender, comment) => {
      callback(CommentEventType.COMMENT_CREATED, comment);
    });
    
    this._onCommentUpdated.connect((sender, comment) => {
      callback(CommentEventType.COMMENT_UPDATED, comment);
    });
    
    this._onCommentDeleted.connect((sender, comment) => {
      callback(CommentEventType.COMMENT_DELETED, comment);
    });
    
    this._onCommentResolved.connect((sender, comment) => {
      callback(CommentEventType.COMMENT_RESOLVED, comment);
    });
    
    this._onCommentUnresolved.connect((sender, comment) => {
      callback(CommentEventType.COMMENT_UNRESOLVED, comment);
    });
    
    return disposable;
  }

  /**
   * Unsubscribe from comment updates
   */
  unsubscribeFromComments(subscription: IDisposable): void {
    subscription.dispose();
  }

  /**
   * Filter comments with advanced options
   */
  async filterComments(filter: ICommentFilter): Promise<IComment[]> {
    return this.getComments(filter);
  }

  /**
   * Search comments by content
   */
  async searchComments(searchText: string): Promise<IComment[]> {
    return this.getComments({
      searchText,
      includeReplies: true,
      sortBy: 'timestamp',
      sortOrder: 'desc'
    });
  }

  /**
   * Get comment history for a cell
   */
  async getCommentHistory(cellId: string): Promise<IComment[]> {
    const comments = await this.getCommentsForCell(cellId);
    return comments.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Export comments to JSON
   */
  async exportComments(cellId?: string): Promise<string> {
    const comments = cellId
      ? await this.getCommentsForCell(cellId)
      : this._commentRegistry.getAllComments();
    
    const exportData = {
      version: '1.0',
      timestamp: Date.now(),
      comments: comments.map(comment => ({
        ...comment,
        exportedAt: Date.now()
      }))
    };
    
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import comments from JSON
   */
  async importComments(jsonData: string): Promise<void> {
    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser) {
      throw new Error('No current user available');
    }
    
    try {
      const importData = JSON.parse(jsonData);
      
      if (!importData.comments || !Array.isArray(importData.comments)) {
        throw new Error('Invalid import data format');
      }
      
      for (const commentData of importData.comments) {
        // Validate comment data
        if (!commentData.id || !commentData.cellId || !commentData.content) {
          console.warn('Skipping invalid comment data:', commentData);
          continue;
        }
        
        // Check if comment already exists
        const existingComment = this._commentRegistry.getCommentById(commentData.id);
        if (existingComment) {
          console.warn(`Comment ${commentData.id} already exists, skipping`);
          continue;
        }
        
        // Check permissions for target cell
        const canCreate = await this._permissions.checkPermission(
          currentUser.id,
          PermissionAction.COMMENT,
          commentData.cellId
        );
        
        if (!canCreate) {
          console.warn(`Insufficient permissions for cell ${commentData.cellId}, skipping comment`);
          continue;
        }
        
        // Create comment
        const comment: IComment = {
          ...commentData,
          timestamp: commentData.timestamp || Date.now(),
          lastModified: Date.now()
        };
        
        // Store in shared state
        this._commentsMap.set(comment.id, comment);
        
        // Register in local registry
        this._commentRegistry.register(comment);
        
        // Emit signal
        this._onCommentCreated.emit(comment);
      }
      
    } catch (error) {
      throw new Error(`Failed to import comments: ${error.message}`);
    }
  }

  /**
   * Clear all comments
   */
  async clearComments(): Promise<void> {
    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser) {
      throw new Error('No current user available');
    }
    
    // Check if user has permissions to clear comments
    const canManage = await this._permissions.checkPermission(
      currentUser.id,
      PermissionAction.DELETE,
      '*' // Global permission
    );
    
    if (!canManage) {
      throw new Error('Insufficient permissions to clear comments');
    }
    
    // Clear shared state
    this._commentsMap.clear();
    
    // Clear local registry
    this._commentRegistry.clear();
    
    // Clear notifications
    this._notificationsMap.clear();
    this._notificationQueue.length = 0;
  }

  /**
   * Check if comment system is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the comment system
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    
    this._disposed = true;
    
    // Dispose all subscriptions
    this._subscriptions.forEach(subscription => {
      subscription.dispose();
    });
    this._subscriptions.clear();
    
    // Clear registry
    this._commentRegistry.clear();
    
    // Clear notification queue
    this._notificationQueue.length = 0;
    
    // Clear signals
    Signal.clearData(this);
  }

  /**
   * Set up real-time synchronization
   */
  private _setupRealtimeSync(): void {
    // Observe comments map changes
    this._commentsMap.observe((event: Y.YMapEvent<any>) => {
      this._handleCommentsMapChange(event);
    });
    
    // Observe notifications map changes
    this._notificationsMap.observe((event: Y.YMapEvent<any>) => {
      this._handleNotificationsMapChange(event);
    });
  }

  /**
   * Set up comment registry observers
   */
  private _setupRegistryObservers(): void {
    // Forward registry events to system signals
    this._commentRegistry.onCommentAdded.connect((sender, comment) => {
      // Additional processing if needed
    });
    
    this._commentRegistry.onCommentRemoved.connect((sender, comment) => {
      // Additional processing if needed
    });
    
    this._commentRegistry.onCommentChanged.connect((sender, comment) => {
      // Additional processing if needed
    });
  }

  /**
   * Set up provider observers
   */
  private _setupProviderObservers(): void {
    // Monitor connection state
    this._provider.onConnectionStateChanged.connect((sender, state) => {
      if (state.connected) {
        this._loadExistingComments();
      }
    });
    
    // Monitor document changes
    this._provider.onDocumentChanged.connect((sender, event) => {
      // Handle document changes that might affect comments
      this._handleDocumentChange(event);
    });
  }

  /**
   * Load existing comments from shared state
   */
  private _loadExistingComments(): void {
    // Load comments from shared state
    this._commentsMap.forEach((comment, commentId) => {
      if (comment && typeof comment === 'object') {
        this._commentRegistry.register(comment);
      }
    });
  }

  /**
   * Handle comments map changes
   */
  private _handleCommentsMapChange(event: Y.YMapEvent<any>): void {
    const changes = event.changes.keys;
    
    changes.forEach((change, commentId) => {
      if (change.action === 'add' || change.action === 'update') {
        const comment = this._commentsMap.get(commentId);
        if (comment) {
          this._commentRegistry.register(comment);
        }
      } else if (change.action === 'delete') {
        this._commentRegistry.unregister(commentId);
      }
    });
  }

  /**
   * Handle notifications map changes
   */
  private _handleNotificationsMapChange(event: Y.YMapEvent<any>): void {
    const changes = event.changes.keys;
    
    changes.forEach((change, notificationId) => {
      if (change.action === 'add') {
        const notification = this._notificationsMap.get(notificationId);
        if (notification) {
          this._notificationQueue.push(notification);
        }
      }
    });
  }

  /**
   * Handle document changes
   */
  private _handleDocumentChange(event: any): void {
    // Handle document changes that might affect comments
    // For example, if a cell is deleted, we might want to handle associated comments
    if (event.changes && event.changes.length > 0) {
      // Process document changes
      event.changes.forEach((change: any) => {
        if (change.type === 'delete' && change.key) {
          // Handle cell deletion
          this._handleCellDeletion(change.key);
        }
      });
    }
  }

  /**
   * Handle cell deletion
   */
  private _handleCellDeletion(cellId: string): void {
    // Get comments for the deleted cell
    const cellComments = this._commentRegistry.getCommentsForCell(cellId);
    
    // Archive or delete comments based on configuration
    cellComments.forEach(comment => {
      // For now, we'll mark them as deleted but keep them for audit purposes
      const deletedComment: IComment = {
        ...comment,
        metadata: {
          ...comment.metadata,
          deletedWithCell: true,
          deletedAt: Date.now()
        }
      };
      
      this._commentsMap.set(comment.id, deletedComment);
      this._commentRegistry.register(deletedComment);
    });
  }

  /**
   * Create a notification for a comment event
   */
  private async _createNotification(comment: IComment, eventType: CommentEventType): Promise<void> {
    if (!this._config.enableNotifications) {
      return;
    }
    
    const currentUser = this._awareness.getCurrentUser();
    if (!currentUser) {
      return;
    }
    
    // Get users who should be notified
    const notificationRecipients = await this._getNotificationRecipients(comment, eventType);
    
    for (const recipient of notificationRecipients) {
      const notification: ICommentNotification = {
        id: UUID.uuid4(),
        commentId: comment.id,
        type: eventType,
        recipient: recipient.id,
        sender: currentUser.id,
        message: this._createNotificationMessage(comment, eventType),
        timestamp: Date.now(),
        read: false,
        cellId: comment.cellId,
        notebookId: '', // Would be set based on notebook context
        markAsRead: () => {
          notification.read = true;
          this._notificationsMap.set(notification.id, notification);
        },
        dismiss: () => {
          this._notificationsMap.delete(notification.id);
        }
      };
      
      this._notificationsMap.set(notification.id, notification);
    }
  }

  /**
   * Get recipients for a comment notification
   */
  private async _getNotificationRecipients(comment: IComment, eventType: CommentEventType): Promise<any[]> {
    const recipients: any[] = [];
    const activeUsers = this._awareness.getActiveUsers();
    
    // Notify users working on the same cell
    const cellUsers = this._awareness.getUsersByCell(comment.cellId);
    recipients.push(...cellUsers);
    
    // Notify users involved in the thread
    if (comment.parentId) {
      const parentComment = this._commentRegistry.getCommentById(comment.parentId);
      if (parentComment) {
        const parentUser = activeUsers.find(user => user.id === parentComment.author.userId);
        if (parentUser) {
          recipients.push(parentUser);
        }
      }
    }
    
    // Remove duplicates and current user
    const currentUser = this._awareness.getCurrentUser();
    const uniqueRecipients = recipients.filter((recipient, index, self) => 
      self.findIndex(r => r.id === recipient.id) === index &&
      recipient.id !== currentUser?.id
    );
    
    return uniqueRecipients;
  }

  /**
   * Create notification message
   */
  private _createNotificationMessage(comment: IComment, eventType: CommentEventType): string {
    const authorName = comment.author.displayName;
    
    switch (eventType) {
      case CommentEventType.COMMENT_CREATED:
        return `${authorName} added a comment`;
      case CommentEventType.COMMENT_UPDATED:
        return `${authorName} updated a comment`;
      case CommentEventType.COMMENT_DELETED:
        return `${authorName} deleted a comment`;
      case CommentEventType.COMMENT_RESOLVED:
        return `${authorName} resolved a comment`;
      case CommentEventType.COMMENT_UNRESOLVED:
        return `${authorName} unresolved a comment`;
      case CommentEventType.REPLY_ADDED:
        return `${authorName} replied to a comment`;
      default:
        return `${authorName} performed an action on a comment`;
    }
  }
}