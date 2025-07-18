/**
 * @fileoverview Comment system for collaborative notebook editing
 * 
 * This module provides comprehensive comment and review functionality for collaborative
 * notebook editing, including cell-level comments, inline comments, threading, 
 * notifications, and real-time synchronization using Yjs CRDT framework.
 * 
 * Key features:
 * - Cell-level and inline comments with real-time synchronization
 * - Comment threading and reply system
 * - Notification system for new comments and resolutions
 * - Comment resolution workflow with status tracking
 * - Integration with user presence and permissions systems
 * - @mentions functionality for user notifications
 * - Comment reactions and engagement tracking
 * - Contextual discussions attached to specific cells
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { Doc } from 'yjs';
import { ISignal, Signal } from '@lumino/signaling';
import { DisposableSet } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import { ICellModel } from '@jupyterlab/cells';
import { INotebookModel } from '@jupyterlab/notebook';

import { AwarenessService } from './awareness';
import { PermissionService } from './permissions';

/**
 * Enumeration of comment status states
 */
export enum CommentStatus {
  /** Comment is open and active */
  OPEN = 'open',
  /** Comment has been resolved */
  RESOLVED = 'resolved',
  /** Comment has been deleted */
  DELETED = 'deleted',
  /** Comment has been archived */
  ARCHIVED = 'archived'
}

/**
 * Enumeration of comment types
 */
export enum CommentType {
  /** General comment on a cell */
  CELL_COMMENT = 'cell_comment',
  /** Inline comment on specific text */
  INLINE_COMMENT = 'inline_comment',
  /** General notebook comment */
  GENERAL_COMMENT = 'general_comment',
  /** Review comment for code review */
  REVIEW_COMMENT = 'review_comment',
  /** Suggestion for improvement */
  SUGGESTION = 'suggestion'
}

/**
 * Interface representing a comment with all its properties
 */
export interface IComment {
  /** Unique identifier for the comment */
  id: string;
  /** ID of the cell the comment is attached to */
  cellId: string;
  /** Author information */
  author: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Comment content in markdown format */
  content: string;
  /** Timestamp when the comment was created */
  timestamp: Date;
  /** ID of parent comment if this is a reply */
  parentId?: string;
  /** Whether the comment is resolved */
  resolved: boolean;
  /** List of mentioned users */
  mentions: string[];
  /** Reactions to the comment */
  reactions: {
    [emoji: string]: string[]; // emoji -> array of user IDs
  };
  /** Position information for inline comments */
  position?: {
    line: number;
    column: number;
    length?: number;
  };
  /** Type of comment */
  type: CommentType;
}

/**
 * Interface representing a comment thread
 */
export interface ICommentThread {
  /** Unique identifier for the thread */
  id: string;
  /** ID of the cell the thread is attached to */
  cellId: string;
  /** Root comment that started the thread */
  rootComment: IComment;
  /** Array of reply comments */
  replies: IComment[];
  /** Whether the thread is resolved */
  resolved: boolean;
  /** List of users who have participated in the thread */
  participants: string[];
  /** Timestamp of the last activity in the thread */
  lastActivity: Date;
  /** Count of unresolved comments in the thread */
  unresolvedCount: number;
}

/**
 * Interface representing a comment notification
 */
export interface ICommentNotification {
  /** Unique identifier for the notification */
  id: string;
  /** ID of the comment that triggered the notification */
  commentId: string;
  /** Type of notification */
  type: 'new_comment' | 'mention' | 'reply' | 'resolution' | 'reaction';
  /** User the notification is for */
  user: string;
  /** Timestamp when the notification was created */
  timestamp: Date;
  /** Whether the notification has been read */
  read: boolean;
  /** Notification message */
  message: string;
  /** ID of the cell related to the notification */
  cellId: string;
  /** ID of the thread related to the notification */
  threadId: string;
}

/**
 * Main comment service class that manages comments and threading for collaborative notebooks
 * 
 * This service provides comprehensive comment management including real-time synchronization,
 * threading, notifications, and integration with user presence and permissions systems.
 */
export class CommentService {
  private _doc: Doc;
  private _awarenessService: AwarenessService;
  private _permissionService: PermissionService;
  private _disposed: boolean = false;
  private _disposables: DisposableSet = new DisposableSet();
  private _comments: Map<string, IComment> = new Map();
  private _threads: Map<string, ICommentThread> = new Map();
  private _notifications: Map<string, ICommentNotification> = new Map();
  private _notebookModel: INotebookModel | null = null;

  // Signals for comment events
  private _newCommentSignal = new Signal<CommentService, IComment>(this);
  private _commentResolvedSignal = new Signal<CommentService, { commentId: string; resolvedBy: string }>(this);
  private _commentUpdatedSignal = new Signal<CommentService, IComment>(this);
  private _commentDeletedSignal = new Signal<CommentService, { commentId: string }>(this);
  private _threadUpdatedSignal = new Signal<CommentService, ICommentThread>(this);
  private _notificationSignal = new Signal<CommentService, ICommentNotification>(this);

  /**
   * Creates a new comment service instance
   * 
   * @param doc - The Yjs document for collaborative editing
   * @param awarenessService - Service for user presence and information
   * @param permissionService - Service for access control
   */
  constructor(
    doc: Doc,
    awarenessService: AwarenessService,
    permissionService: PermissionService
  ) {
    this._doc = doc;
    this._awarenessService = awarenessService;
    this._permissionService = permissionService;
    
    this._initializeCommentData();
    this._setupEventListeners();
  }

  /**
   * Signal emitted when a new comment is created
   */
  get onNewComment(): ISignal<CommentService, IComment> {
    return this._newCommentSignal;
  }

  /**
   * Signal emitted when a comment is resolved
   */
  get onCommentResolved(): ISignal<CommentService, { commentId: string; resolvedBy: string }> {
    return this._commentResolvedSignal;
  }

  /**
   * Signal emitted when a comment is updated
   */
  get onCommentUpdated(): ISignal<CommentService, IComment> {
    return this._commentUpdatedSignal;
  }

  /**
   * Signal emitted when a comment is deleted
   */
  get onCommentDeleted(): ISignal<CommentService, { commentId: string }> {
    return this._commentDeletedSignal;
  }

  /**
   * Signal emitted when a thread is updated
   */
  get onThreadUpdated(): ISignal<CommentService, ICommentThread> {
    return this._threadUpdatedSignal;
  }

  /**
   * Signal emitted when a notification is created
   */
  get onNotification(): ISignal<CommentService, ICommentNotification> {
    return this._notificationSignal;
  }

  /**
   * Create a new comment on a cell
   * 
   * @param cellId - ID of the cell to comment on
   * @param content - Content of the comment
   * @param type - Type of comment
   * @param position - Position information for inline comments
   * @param parentId - ID of parent comment if this is a reply
   * @returns The created comment
   */
  async createComment(
    cellId: string,
    content: string,
    type: CommentType = CommentType.CELL_COMMENT,
    position?: { line: number; column: number; length?: number },
    parentId?: string
  ): Promise<IComment> {
    // Check permissions
    if (!await this._permissionService.canEdit(cellId)) {
      throw new Error('Insufficient permissions to create comments');
    }

    const currentUser = this._awarenessService.getCurrentUser();
    const commentId = UUID.uuid4();
    const timestamp = new Date();

    // Extract mentions from content
    const mentions = this._extractMentions(content);

    const comment: IComment = {
      id: commentId,
      cellId,
      author: {
        id: currentUser.userId,
        name: currentUser.name,
        avatar: currentUser.avatar
      },
      content,
      timestamp,
      parentId,
      resolved: false,
      mentions,
      reactions: {},
      position,
      type
    };

    // Store comment in Yjs document
    this._doc.transact(() => {
      const comments = this._doc.getMap('comments');
      comments.set(commentId, comment);
    });

    // Update local state
    this._comments.set(commentId, comment);

    // Update or create thread
    if (parentId) {
      await this._addReplyToThread(parentId, comment);
    } else {
      await this._createThread(comment);
    }

    // Create notifications for mentions
    await this._createMentionNotifications(comment);

    // Emit signal
    this._newCommentSignal.emit(comment);

    return comment;
  }

  /**
   * Add a comment to a cell (alias for createComment)
   * 
   * @param cellId - ID of the cell to comment on
   * @param content - Content of the comment
   * @param type - Type of comment
   * @returns The created comment
   */
  async addComment(
    cellId: string,
    content: string,
    type: CommentType = CommentType.CELL_COMMENT
  ): Promise<IComment> {
    return this.createComment(cellId, content, type);
  }

  /**
   * Reply to an existing comment
   * 
   * @param parentId - ID of the parent comment
   * @param content - Content of the reply
   * @returns The created reply comment
   */
  async replyToComment(parentId: string, content: string): Promise<IComment> {
    const parentComment = this._comments.get(parentId);
    if (!parentComment) {
      throw new Error('Parent comment not found');
    }

    return this.createComment(
      parentComment.cellId,
      content,
      CommentType.CELL_COMMENT,
      undefined,
      parentId
    );
  }

  /**
   * Update an existing comment
   * 
   * @param commentId - ID of the comment to update
   * @param content - New content for the comment
   * @returns The updated comment
   */
  async updateComment(commentId: string, content: string): Promise<IComment> {
    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error('Comment not found');
    }

    // Check permissions
    const currentUser = this._awarenessService.getCurrentUser();
    if (comment.author.id !== currentUser.userId && !await this._permissionService.canAdmin()) {
      throw new Error('Insufficient permissions to update comment');
    }

    // Extract mentions from updated content
    const mentions = this._extractMentions(content);

    const updatedComment: IComment = {
      ...comment,
      content,
      mentions,
      timestamp: new Date() // Update timestamp for edits
    };

    // Update in Yjs document
    this._doc.transact(() => {
      const comments = this._doc.getMap('comments');
      comments.set(commentId, updatedComment);
    });

    // Update local state
    this._comments.set(commentId, updatedComment);

    // Update thread
    await this._updateThreadForComment(updatedComment);

    // Create notifications for new mentions
    await this._createMentionNotifications(updatedComment);

    // Emit signal
    this._commentUpdatedSignal.emit(updatedComment);

    return updatedComment;
  }

  /**
   * Delete a comment
   * 
   * @param commentId - ID of the comment to delete
   * @returns Promise resolving when comment is deleted
   */
  async deleteComment(commentId: string): Promise<void> {
    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error('Comment not found');
    }

    // Check permissions
    const currentUser = this._awarenessService.getCurrentUser();
    if (comment.author.id !== currentUser.userId && !await this._permissionService.canAdmin()) {
      throw new Error('Insufficient permissions to delete comment');
    }

    // Mark as deleted in Yjs document
    this._doc.transact(() => {
      const comments = this._doc.getMap('comments');
      const deletedComment = { ...comment, resolved: true };
      comments.set(commentId, deletedComment);
    });

    // Remove from local state
    this._comments.delete(commentId);

    // Update thread
    await this._removeCommentFromThread(commentId);

    // Emit signal
    this._commentDeletedSignal.emit({ commentId });
  }

  /**
   * Resolve a comment
   * 
   * @param commentId - ID of the comment to resolve
   * @returns Promise resolving when comment is resolved
   */
  async resolveComment(commentId: string): Promise<void> {
    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error('Comment not found');
    }

    // Check permissions
    if (!await this._permissionService.canEdit(comment.cellId)) {
      throw new Error('Insufficient permissions to resolve comment');
    }

    const currentUser = this._awarenessService.getCurrentUser();
    const resolvedComment: IComment = {
      ...comment,
      resolved: true
    };

    // Update in Yjs document
    this._doc.transact(() => {
      const comments = this._doc.getMap('comments');
      comments.set(commentId, resolvedComment);
    });

    // Update local state
    this._comments.set(commentId, resolvedComment);

    // Update thread
    await this._updateThreadForComment(resolvedComment);

    // Create resolution notification
    await this._createResolutionNotification(resolvedComment, currentUser.userId);

    // Emit signal
    this._commentResolvedSignal.emit({ commentId, resolvedBy: currentUser.userId });
  }

  /**
   * Get all comments for a specific cell
   * 
   * @param cellId - ID of the cell
   * @returns Array of comments for the cell
   */
  getCommentsByCell(cellId: string): IComment[] {
    return Array.from(this._comments.values())
      .filter(comment => comment.cellId === cellId && !comment.resolved)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Get all comments by a specific user
   * 
   * @param userId - ID of the user
   * @returns Array of comments by the user
   */
  getCommentsByUser(userId: string): IComment[] {
    return Array.from(this._comments.values())
      .filter(comment => comment.author.id === userId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get a comment thread by ID
   * 
   * @param threadId - ID of the thread
   * @returns The comment thread or null if not found
   */
  getCommentThread(threadId: string): ICommentThread | null {
    return this._threads.get(threadId) || null;
  }

  /**
   * Subscribe to comment updates for a specific cell
   * 
   * @param cellId - ID of the cell to subscribe to
   * @param callback - Callback function to call when comments are updated
   * @returns Disposable to unsubscribe
   */
  subscribeToComments(cellId: string, callback: (comments: IComment[]) => void): { dispose: () => void } {
    const handler = () => {
      const comments = this.getCommentsByCell(cellId);
      callback(comments);
    };

    this._newCommentSignal.connect(handler);
    this._commentUpdatedSignal.connect(handler);
    this._commentDeletedSignal.connect(handler);
    this._commentResolvedSignal.connect(handler);

    // Call immediately with current comments
    handler();

    return {
      dispose: () => {
        this._newCommentSignal.disconnect(handler);
        this._commentUpdatedSignal.disconnect(handler);
        this._commentDeletedSignal.disconnect(handler);
        this._commentResolvedSignal.disconnect(handler);
      }
    };
  }

  /**
   * Mark a comment as read
   * 
   * @param commentId - ID of the comment to mark as read
   * @returns Promise resolving when comment is marked as read
   */
  async markCommentAsRead(commentId: string): Promise<void> {
    const currentUser = this._awarenessService.getCurrentUser();
    
    // Find and update notifications for this comment
    for (const [notificationId, notification] of this._notifications) {
      if (notification.commentId === commentId && notification.user === currentUser.userId) {
        const updatedNotification = { ...notification, read: true };
        
        // Update in Yjs document
        this._doc.transact(() => {
          const notifications = this._doc.getMap('notifications');
          notifications.set(notificationId, updatedNotification);
        });
        
        // Update local state
        this._notifications.set(notificationId, updatedNotification);
      }
    }
  }

  /**
   * Get unread comments for the current user
   * 
   * @returns Array of unread comment notifications
   */
  getUnreadComments(): ICommentNotification[] {
    const currentUser = this._awarenessService.getCurrentUser();
    return Array.from(this._notifications.values())
      .filter(notification => notification.user === currentUser.userId && !notification.read)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get all comment notifications for the current user
   * 
   * @returns Array of comment notifications
   */
  getCommentNotifications(): ICommentNotification[] {
    const currentUser = this._awarenessService.getCurrentUser();
    return Array.from(this._notifications.values())
      .filter(notification => notification.user === currentUser.userId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Create a new comment service instance
   * 
   * @param doc - The Yjs document for collaborative editing
   * @param awarenessService - Service for user presence and information
   * @param permissionService - Service for access control
   * @returns A new comment service instance
   */
  create(
    doc: Doc,
    awarenessService: AwarenessService,
    permissionService: PermissionService
  ): CommentService {
    return new CommentService(doc, awarenessService, permissionService);
  }

  /**
   * Initialize the comment service
   * 
   * @param notebookModel - The notebook model to attach to
   * @returns Promise resolving when service is initialized
   */
  async initialize(notebookModel?: INotebookModel): Promise<void> {
    if (this._disposed) {
      throw new Error('Cannot initialize disposed comment service');
    }

    this._notebookModel = notebookModel || null;
    
    // Sync with existing comment data
    await this._syncCommentData();
  }

  /**
   * Check if the service is disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose of the comment service and cleanup resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;
    this._disposables.dispose();
    this._comments.clear();
    this._threads.clear();
    this._notifications.clear();
    this._notebookModel = null;
  }

  /**
   * Initialize comment data structures in the Yjs document
   */
  private _initializeCommentData(): void {
    // Initialize comments map
    if (!this._doc.getMap('comments')) {
      this._doc.getMap('comments');
    }

    // Initialize threads map
    if (!this._doc.getMap('threads')) {
      this._doc.getMap('threads');
    }

    // Initialize notifications map
    if (!this._doc.getMap('notifications')) {
      this._doc.getMap('notifications');
    }
  }

  /**
   * Set up event listeners for comment data changes
   */
  private _setupEventListeners(): void {
    // Listen for comment changes
    const comments = this._doc.getMap('comments');
    const onCommentUpdate = () => {
      this._syncCommentData();
    };

    comments.observe(onCommentUpdate);
    this._disposables.add({ dispose: () => comments.unobserve(onCommentUpdate) });

    // Listen for thread changes
    const threads = this._doc.getMap('threads');
    const onThreadUpdate = () => {
      this._syncThreadData();
    };

    threads.observe(onThreadUpdate);
    this._disposables.add({ dispose: () => threads.unobserve(onThreadUpdate) });

    // Listen for notification changes
    const notifications = this._doc.getMap('notifications');
    const onNotificationUpdate = () => {
      this._syncNotificationData();
    };

    notifications.observe(onNotificationUpdate);
    this._disposables.add({ dispose: () => notifications.unobserve(onNotificationUpdate) });
  }

  /**
   * Sync local comment data with Yjs document
   */
  private async _syncCommentData(): Promise<void> {
    const comments = this._doc.getMap('comments');
    
    // Update local state with Yjs data
    this._comments.clear();
    for (const [id, comment] of comments) {
      this._comments.set(id, comment as IComment);
    }
  }

  /**
   * Sync local thread data with Yjs document
   */
  private async _syncThreadData(): Promise<void> {
    const threads = this._doc.getMap('threads');
    
    // Update local state with Yjs data
    this._threads.clear();
    for (const [id, thread] of threads) {
      this._threads.set(id, thread as ICommentThread);
    }
  }

  /**
   * Sync local notification data with Yjs document
   */
  private async _syncNotificationData(): Promise<void> {
    const notifications = this._doc.getMap('notifications');
    
    // Update local state with Yjs data
    this._notifications.clear();
    for (const [id, notification] of notifications) {
      this._notifications.set(id, notification as ICommentNotification);
    }
  }

  /**
   * Create a new comment thread
   * 
   * @param rootComment - The root comment for the thread
   * @returns The created thread
   */
  private async _createThread(rootComment: IComment): Promise<ICommentThread> {
    const threadId = UUID.uuid4();
    const thread: ICommentThread = {
      id: threadId,
      cellId: rootComment.cellId,
      rootComment,
      replies: [],
      resolved: false,
      participants: [rootComment.author.id],
      lastActivity: rootComment.timestamp,
      unresolvedCount: 1
    };

    // Store thread in Yjs document
    this._doc.transact(() => {
      const threads = this._doc.getMap('threads');
      threads.set(threadId, thread);
    });

    // Update local state
    this._threads.set(threadId, thread);

    // Emit signal
    this._threadUpdatedSignal.emit(thread);

    return thread;
  }

  /**
   * Add a reply to an existing thread
   * 
   * @param parentId - ID of the parent comment
   * @param reply - The reply comment
   * @returns Promise resolving when reply is added
   */
  private async _addReplyToThread(parentId: string, reply: IComment): Promise<void> {
    // Find the thread containing the parent comment
    let targetThread: ICommentThread | null = null;
    
    for (const thread of this._threads.values()) {
      if (thread.rootComment.id === parentId || thread.replies.some(r => r.id === parentId)) {
        targetThread = thread;
        break;
      }
    }

    if (!targetThread) {
      throw new Error('Parent comment thread not found');
    }

    // Add reply to thread
    const updatedThread: ICommentThread = {
      ...targetThread,
      replies: [...targetThread.replies, reply],
      participants: [...new Set([...targetThread.participants, reply.author.id])],
      lastActivity: reply.timestamp,
      unresolvedCount: targetThread.unresolvedCount + (reply.resolved ? 0 : 1)
    };

    // Update in Yjs document
    this._doc.transact(() => {
      const threads = this._doc.getMap('threads');
      threads.set(targetThread.id, updatedThread);
    });

    // Update local state
    this._threads.set(targetThread.id, updatedThread);

    // Emit signal
    this._threadUpdatedSignal.emit(updatedThread);
  }

  /**
   * Update a thread when a comment is modified
   * 
   * @param comment - The modified comment
   * @returns Promise resolving when thread is updated
   */
  private async _updateThreadForComment(comment: IComment): Promise<void> {
    // Find the thread containing the comment
    let targetThread: ICommentThread | null = null;
    
    for (const thread of this._threads.values()) {
      if (thread.rootComment.id === comment.id) {
        targetThread = { ...thread, rootComment: comment };
        break;
      } else if (thread.replies.some(r => r.id === comment.id)) {
        const updatedReplies = thread.replies.map(r => r.id === comment.id ? comment : r);
        targetThread = { ...thread, replies: updatedReplies };
        break;
      }
    }

    if (!targetThread) {
      return;
    }

    // Recalculate unresolved count
    const unresolvedCount = [targetThread.rootComment, ...targetThread.replies]
      .filter(c => !c.resolved).length;

    const updatedThread: ICommentThread = {
      ...targetThread,
      resolved: unresolvedCount === 0,
      lastActivity: new Date(),
      unresolvedCount
    };

    // Update in Yjs document
    this._doc.transact(() => {
      const threads = this._doc.getMap('threads');
      threads.set(targetThread.id, updatedThread);
    });

    // Update local state
    this._threads.set(targetThread.id, updatedThread);

    // Emit signal
    this._threadUpdatedSignal.emit(updatedThread);
  }

  /**
   * Remove a comment from its thread
   * 
   * @param commentId - ID of the comment to remove
   * @returns Promise resolving when comment is removed
   */
  private async _removeCommentFromThread(commentId: string): Promise<void> {
    // Find the thread containing the comment
    let targetThread: ICommentThread | null = null;
    
    for (const thread of this._threads.values()) {
      if (thread.rootComment.id === commentId) {
        // If root comment is deleted, delete the entire thread
        this._doc.transact(() => {
          const threads = this._doc.getMap('threads');
          threads.delete(thread.id);
        });
        
        this._threads.delete(thread.id);
        return;
      } else if (thread.replies.some(r => r.id === commentId)) {
        const updatedReplies = thread.replies.filter(r => r.id !== commentId);
        targetThread = { ...thread, replies: updatedReplies };
        break;
      }
    }

    if (!targetThread) {
      return;
    }

    // Recalculate unresolved count
    const unresolvedCount = [targetThread.rootComment, ...targetThread.replies]
      .filter(c => !c.resolved).length;

    const updatedThread: ICommentThread = {
      ...targetThread,
      resolved: unresolvedCount === 0,
      lastActivity: new Date(),
      unresolvedCount
    };

    // Update in Yjs document
    this._doc.transact(() => {
      const threads = this._doc.getMap('threads');
      threads.set(targetThread.id, updatedThread);
    });

    // Update local state
    this._threads.set(targetThread.id, updatedThread);

    // Emit signal
    this._threadUpdatedSignal.emit(updatedThread);
  }

  /**
   * Extract @mentions from comment content
   * 
   * @param content - The comment content
   * @returns Array of mentioned user IDs
   */
  private _extractMentions(content: string): string[] {
    const mentionRegex = /@(\w+)/g;
    const mentions: string[] = [];
    let match;
    
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }
    
    return [...new Set(mentions)]; // Remove duplicates
  }

  /**
   * Create mention notifications for a comment
   * 
   * @param comment - The comment containing mentions
   * @returns Promise resolving when notifications are created
   */
  private async _createMentionNotifications(comment: IComment): Promise<void> {
    for (const mentionedUser of comment.mentions) {
      const notificationId = UUID.uuid4();
      const notification: ICommentNotification = {
        id: notificationId,
        commentId: comment.id,
        type: 'mention',
        user: mentionedUser,
        timestamp: new Date(),
        read: false,
        message: `${comment.author.name} mentioned you in a comment`,
        cellId: comment.cellId,
        threadId: this._findThreadForComment(comment.id)?.id || ''
      };

      // Store notification in Yjs document
      this._doc.transact(() => {
        const notifications = this._doc.getMap('notifications');
        notifications.set(notificationId, notification);
      });

      // Update local state
      this._notifications.set(notificationId, notification);

      // Emit signal
      this._notificationSignal.emit(notification);
    }
  }

  /**
   * Create a resolution notification for a comment
   * 
   * @param comment - The resolved comment
   * @param resolvedBy - ID of the user who resolved the comment
   * @returns Promise resolving when notification is created
   */
  private async _createResolutionNotification(comment: IComment, resolvedBy: string): Promise<void> {
    const notificationId = UUID.uuid4();
    const notification: ICommentNotification = {
      id: notificationId,
      commentId: comment.id,
      type: 'resolution',
      user: comment.author.id,
      timestamp: new Date(),
      read: false,
      message: `Your comment was resolved by ${resolvedBy}`,
      cellId: comment.cellId,
      threadId: this._findThreadForComment(comment.id)?.id || ''
    };

    // Store notification in Yjs document
    this._doc.transact(() => {
      const notifications = this._doc.getMap('notifications');
      notifications.set(notificationId, notification);
    });

    // Update local state
    this._notifications.set(notificationId, notification);

    // Emit signal
    this._notificationSignal.emit(notification);
  }

  /**
   * Find the thread containing a specific comment
   * 
   * @param commentId - ID of the comment
   * @returns The thread containing the comment or null if not found
   */
  private _findThreadForComment(commentId: string): ICommentThread | null {
    for (const thread of this._threads.values()) {
      if (thread.rootComment.id === commentId || thread.replies.some(r => r.id === commentId)) {
        return thread;
      }
    }
    return null;
  }
}

/**
 * Factory function to create a new comment service instance
 * 
 * @param doc - The Yjs document for collaborative editing
 * @param awarenessService - Service for user presence and information
 * @param permissionService - Service for access control
 * @returns A new comment service instance
 */
export function createCommentService(
  doc: Doc,
  awarenessService: AwarenessService,
  permissionService: PermissionService
): CommentService {
  return new CommentService(doc, awarenessService, permissionService);
}