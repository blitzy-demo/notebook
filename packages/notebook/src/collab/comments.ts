/**
 * Comments system for collaborative notebooks
 * 
 * This module provides the ICommentSystem interface for creating, updating, and resolving comments,
 * as well as managing comment threads and replies. It supports rich text formatting with markdown,
 * notifications, and comment resolution tracking.
 */

import { ISignal, Signal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { UUID } from '@lumino/coreutils';
import * as Y from 'yjs';
import { INotebookModel } from '../model';
import { ICellModel } from '@jupyterlab/cells';

/**
 * Comment status enum
 */
export enum CommentStatus {
  /** Comment is open and active */
  Open = 'open',
  /** Comment has been resolved */
  Resolved = 'resolved',
  /** Comment has been archived */
  Archived = 'archived'
}

/**
 * Comment priority enum
 */
export enum CommentPriority {
  /** Low priority comment */
  Low = 'low',
  /** Medium priority comment */
  Medium = 'medium',
  /** High priority comment */
  High = 'high'
}

/**
 * User information for comment authors and mentions
 */
export interface ICommentUser {
  /** Unique user identifier */
  id: string;
  /** Display name of the user */
  displayName: string;
  /** User's avatar URL */
  avatarUrl?: string;
  /** User's email address */
  email?: string;
}

/**
 * Comment reply interface
 */
export interface ICommentReply {
  /** Unique identifier for the reply */
  id: string;
  /** Content of the reply in markdown format */
  content: string;
  /** User who created the reply */
  author: ICommentUser;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Whether the reply has been edited */
  edited: boolean;
  /** Mentioned users in the reply */
  mentions?: ICommentUser[];
}

/**
 * Comment interface
 */
export interface IComment {
  /** Unique identifier for the comment */
  id: string;
  /** Content of the comment in markdown format */
  content: string;
  /** User who created the comment */
  author: ICommentUser;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Current status of the comment */
  status: CommentStatus;
  /** Priority level of the comment */
  priority: CommentPriority;
  /** User who resolved the comment, if resolved */
  resolvedBy?: ICommentUser;
  /** Timestamp when the comment was resolved */
  resolvedAt?: number;
  /** Whether the comment has been edited */
  edited: boolean;
  /** Array of replies to this comment */
  replies: ICommentReply[];
  /** Mentioned users in the comment */
  mentions?: ICommentUser[];
  /** Tags associated with the comment */
  tags?: string[];
}

/**
 * Comment range interface for selecting text within a cell
 */
export interface ICommentRange {
  /** Start position of the comment range */
  start: number;
  /** End position of the comment range */
  end: number;
}

/**
 * Comment thread interface
 */
export interface ICommentThread {
  /** Unique identifier for the thread */
  id: string;
  /** Cell ID that this thread is attached to */
  cellId: string;
  /** Optional range within the cell that this thread is attached to */
  range?: ICommentRange;
  /** Array of comments in this thread */
  comments: IComment[];
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Comment filter options
 */
export interface ICommentFilter {
  /** Filter by status */
  status?: CommentStatus;
  /** Filter by author ID */
  authorId?: string;
  /** Filter by cell ID */
  cellId?: string;
  /** Filter by priority */
  priority?: CommentPriority;
  /** Filter by tags */
  tags?: string[];
  /** Filter by text content */
  searchText?: string;
  /** Filter by mentioned user ID */
  mentionedUserId?: string;
  /** Filter by date range (start timestamp) */
  dateRangeStart?: number;
  /** Filter by date range (end timestamp) */
  dateRangeEnd?: number;
}

/**
 * Comment notification interface
 */
export interface ICommentNotification {
  /** Unique identifier for the notification */
  id: string;
  /** Type of notification */
  type: 'new-comment' | 'new-reply' | 'mention' | 'resolved' | 'status-change';
  /** ID of the related comment */
  commentId: string;
  /** ID of the related thread */
  threadId: string;
  /** ID of the user who triggered the notification */
  userId: string;
  /** Timestamp of the notification */
  timestamp: number;
  /** Whether the notification has been read */
  read: boolean;
  /** Additional data specific to the notification type */
  data?: any;
}

/**
 * Comment system change event types
 */
export enum CommentChangeType {
  /** A new thread was added */
  ThreadAdded = 'thread-added',
  /** A thread was updated */
  ThreadUpdated = 'thread-updated',
  /** A thread was deleted */
  ThreadDeleted = 'thread-deleted',
  /** A comment was added */
  CommentAdded = 'comment-added',
  /** A comment was updated */
  CommentUpdated = 'comment-updated',
  /** A comment was deleted */
  CommentDeleted = 'comment-deleted',
  /** A reply was added */
  ReplyAdded = 'reply-added',
  /** A reply was updated */
  ReplyUpdated = 'reply-updated',
  /** A reply was deleted */
  ReplyDeleted = 'reply-deleted',
  /** A notification was added */
  NotificationAdded = 'notification-added',
  /** A notification was updated */
  NotificationUpdated = 'notification-updated',
  /** A notification was deleted */
  NotificationDeleted = 'notification-deleted'
}

/**
 * Comment system change event
 */
export interface ICommentChangeEvent {
  /** Type of change */
  type: CommentChangeType;
  /** ID of the affected thread */
  threadId?: string;
  /** ID of the affected comment */
  commentId?: string;
  /** ID of the affected reply */
  replyId?: string;
  /** ID of the affected notification */
  notificationId?: string;
  /** The thread data if relevant */
  thread?: ICommentThread;
  /** The comment data if relevant */
  comment?: IComment;
  /** The reply data if relevant */
  reply?: ICommentReply;
  /** The notification data if relevant */
  notification?: ICommentNotification;
}

/**
 * Interface for the comment system
 */
export interface ICommentSystem extends IDisposable {
  /**
   * Signal emitted when the comment system changes
   */
  readonly changed: ISignal<ICommentSystem, ICommentChangeEvent>;

  /**
   * Signal emitted when notifications are updated
   */
  readonly notificationsChanged: ISignal<ICommentSystem, ICommentNotification[]>;

  /**
   * Get all comment threads
   */
  getThreads(): ICommentThread[];

  /**
   * Get comment threads for a specific cell
   * 
   * @param cellId - The cell ID to get threads for
   */
  getThreadsForCell(cellId: string): ICommentThread[];

  /**
   * Get a specific comment thread by ID
   * 
   * @param threadId - The thread ID to get
   */
  getThread(threadId: string): ICommentThread | undefined;

  /**
   * Create a new comment thread
   * 
   * @param cellId - The cell ID to attach the thread to
   * @param content - The content of the initial comment
   * @param author - The author of the comment
   * @param range - Optional range within the cell to attach the thread to
   * @param priority - Optional priority for the comment
   * @param tags - Optional tags for the comment
   */
  createThread(
    cellId: string,
    content: string,
    author: ICommentUser,
    range?: ICommentRange,
    priority?: CommentPriority,
    tags?: string[]
  ): ICommentThread;

  /**
   * Delete a comment thread
   * 
   * @param threadId - The ID of the thread to delete
   */
  deleteThread(threadId: string): void;

  /**
   * Add a comment to an existing thread
   * 
   * @param threadId - The ID of the thread to add the comment to
   * @param content - The content of the comment
   * @param author - The author of the comment
   * @param priority - Optional priority for the comment
   * @param tags - Optional tags for the comment
   */
  addComment(
    threadId: string,
    content: string,
    author: ICommentUser,
    priority?: CommentPriority,
    tags?: string[]
  ): IComment | undefined;

  /**
   * Update an existing comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to update
   * @param content - The new content of the comment
   * @param priority - Optional new priority for the comment
   * @param tags - Optional new tags for the comment
   */
  updateComment(
    threadId: string,
    commentId: string,
    content: string,
    priority?: CommentPriority,
    tags?: string[]
  ): IComment | undefined;

  /**
   * Delete a comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to delete
   */
  deleteComment(threadId: string, commentId: string): void;

  /**
   * Resolve a comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to resolve
   * @param user - The user resolving the comment
   */
  resolveComment(threadId: string, commentId: string, user: ICommentUser): IComment | undefined;

  /**
   * Reopen a resolved comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to reopen
   */
  reopenComment(threadId: string, commentId: string): IComment | undefined;

  /**
   * Archive a comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to archive
   */
  archiveComment(threadId: string, commentId: string): IComment | undefined;

  /**
   * Add a reply to a comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to reply to
   * @param content - The content of the reply
   * @param author - The author of the reply
   */
  addReply(
    threadId: string,
    commentId: string,
    content: string,
    author: ICommentUser
  ): ICommentReply | undefined;

  /**
   * Update a reply
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment containing the reply
   * @param replyId - The ID of the reply to update
   * @param content - The new content of the reply
   */
  updateReply(
    threadId: string,
    commentId: string,
    replyId: string,
    content: string
  ): ICommentReply | undefined;

  /**
   * Delete a reply
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment containing the reply
   * @param replyId - The ID of the reply to delete
   */
  deleteReply(threadId: string, commentId: string, replyId: string): void;

  /**
   * Get all notifications
   */
  getNotifications(): ICommentNotification[];

  /**
   * Get unread notifications
   */
  getUnreadNotifications(): ICommentNotification[];

  /**
   * Mark a notification as read
   * 
   * @param notificationId - The ID of the notification to mark as read
   */
  markNotificationAsRead(notificationId: string): void;

  /**
   * Mark all notifications as read
   */
  markAllNotificationsAsRead(): void;

  /**
   * Filter comments based on criteria
   * 
   * @param filter - The filter criteria
   */
  filterComments(filter: ICommentFilter): ICommentThread[];

  /**
   * Search for comments containing specific text
   * 
   * @param searchText - The text to search for
   */
  searchComments(searchText: string): ICommentThread[];

  /**
   * Get statistics about comments
   */
  getStatistics(): {
    totalThreads: number;
    totalComments: number;
    totalReplies: number;
    openComments: number;
    resolvedComments: number;
    archivedComments: number;
  };
}

/**
 * Implementation of the comment system using Yjs
 */
export class CommentSystem implements ICommentSystem {
  /**
   * Constructor
   * 
   * @param notebookModel - The notebook model
   * @param ydoc - The Yjs document
   */
  constructor(notebookModel: INotebookModel, ydoc: Y.Doc) {
    this._notebookModel = notebookModel;
    this._ydoc = ydoc;
    
    // Initialize Yjs shared data structures
    this._yThreads = ydoc.getMap<Y.Map<any>>('comments-threads');
    this._yNotifications = ydoc.getArray<any>('comments-notifications');
    
    // Set up change observers
    this._yThreads.observe(this._onThreadsChanged.bind(this));
    this._yNotifications.observe(this._onNotificationsChanged.bind(this));
    
    // Initialize signals
    this._changed = new Signal<ICommentSystem, ICommentChangeEvent>(this);
    this._notificationsChanged = new Signal<ICommentSystem, ICommentNotification[]>(this);
  }

  /**
   * Signal emitted when the comment system changes
   */
  get changed(): ISignal<ICommentSystem, ICommentChangeEvent> {
    return this._changed;
  }

  /**
   * Signal emitted when notifications are updated
   */
  get notificationsChanged(): ISignal<ICommentSystem, ICommentNotification[]> {
    return this._notificationsChanged;
  }

  /**
   * Get all comment threads
   */
  getThreads(): ICommentThread[] {
    const threads: ICommentThread[] = [];
    this._yThreads.forEach((yThread) => {
      threads.push(this._yThreadToThread(yThread));
    });
    return threads;
  }

  /**
   * Get comment threads for a specific cell
   * 
   * @param cellId - The cell ID to get threads for
   */
  getThreadsForCell(cellId: string): ICommentThread[] {
    const threads = this.getThreads();
    return threads.filter(thread => thread.cellId === cellId);
  }

  /**
   * Get a specific comment thread by ID
   * 
   * @param threadId - The thread ID to get
   */
  getThread(threadId: string): ICommentThread | undefined {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return undefined;
    }
    return this._yThreadToThread(yThread);
  }

  /**
   * Create a new comment thread
   * 
   * @param cellId - The cell ID to attach the thread to
   * @param content - The content of the initial comment
   * @param author - The author of the comment
   * @param range - Optional range within the cell to attach the thread to
   * @param priority - Optional priority for the comment
   * @param tags - Optional tags for the comment
   */
  createThread(
    cellId: string,
    content: string,
    author: ICommentUser,
    range?: ICommentRange,
    priority: CommentPriority = CommentPriority.Medium,
    tags: string[] = []
  ): ICommentThread {
    // Generate IDs
    const threadId = UUID.uuid4();
    const commentId = UUID.uuid4();
    
    // Create timestamp
    const now = Date.now();
    
    // Create the comment
    const comment: IComment = {
      id: commentId,
      content,
      author,
      createdAt: now,
      updatedAt: now,
      status: CommentStatus.Open,
      priority,
      edited: false,
      replies: [],
      tags,
      mentions: this._extractMentions(content)
    };
    
    // Create the thread
    const thread: ICommentThread = {
      id: threadId,
      cellId,
      range,
      comments: [comment],
      createdAt: now,
      updatedAt: now
    };
    
    // Create Yjs data structures
    const yThread = new Y.Map<any>();
    yThread.set('id', threadId);
    yThread.set('cellId', cellId);
    if (range) {
      yThread.set('range', range);
    }
    yThread.set('createdAt', now);
    yThread.set('updatedAt', now);
    
    // Create comments array in the thread
    const yComments = new Y.Array<any>();
    const yComment = this._commentToYComment(comment);
    yComments.push([yComment]);
    yThread.set('comments', yComments);
    
    // Add the thread to the shared map
    this._yThreads.set(threadId, yThread);
    
    // Create notification for the new thread/comment
    this._createNotification({
      type: 'new-comment',
      commentId,
      threadId,
      userId: author.id
    });
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.ThreadAdded,
      threadId,
      commentId,
      thread
    });
    
    return thread;
  }

  /**
   * Delete a comment thread
   * 
   * @param threadId - The ID of the thread to delete
   */
  deleteThread(threadId: string): void {
    const thread = this.getThread(threadId);
    if (!thread) {
      return;
    }
    
    // Remove the thread from the shared map
    this._yThreads.delete(threadId);
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.ThreadDeleted,
      threadId,
      thread
    });
  }

  /**
   * Add a comment to an existing thread
   * 
   * @param threadId - The ID of the thread to add the comment to
   * @param content - The content of the comment
   * @param author - The author of the comment
   * @param priority - Optional priority for the comment
   * @param tags - Optional tags for the comment
   */
  addComment(
    threadId: string,
    content: string,
    author: ICommentUser,
    priority: CommentPriority = CommentPriority.Medium,
    tags: string[] = []
  ): IComment | undefined {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return undefined;
    }
    
    // Generate ID and timestamp
    const commentId = UUID.uuid4();
    const now = Date.now();
    
    // Create the comment
    const comment: IComment = {
      id: commentId,
      content,
      author,
      createdAt: now,
      updatedAt: now,
      status: CommentStatus.Open,
      priority,
      edited: false,
      replies: [],
      tags,
      mentions: this._extractMentions(content)
    };
    
    // Add the comment to the thread
    const yComments = yThread.get('comments') as Y.Array<any>;
    const yComment = this._commentToYComment(comment);
    yComments.push([yComment]);
    
    // Update thread timestamp
    yThread.set('updatedAt', now);
    
    // Create notification for the new comment
    this._createNotification({
      type: 'new-comment',
      commentId,
      threadId,
      userId: author.id
    });
    
    // Create notifications for mentions
    if (comment.mentions && comment.mentions.length > 0) {
      for (const mention of comment.mentions) {
        this._createNotification({
          type: 'mention',
          commentId,
          threadId,
          userId: author.id,
          data: { mentionedUserId: mention.id }
        });
      }
    }
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.CommentAdded,
      threadId,
      commentId,
      comment
    });
    
    return comment;
  }

  /**
   * Update an existing comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to update
   * @param content - The new content of the comment
   * @param priority - Optional new priority for the comment
   * @param tags - Optional new tags for the comment
   */
  updateComment(
    threadId: string,
    commentId: string,
    content: string,
    priority?: CommentPriority,
    tags?: string[]
  ): IComment | undefined {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return undefined;
    }
    
    const yComments = yThread.get('comments') as Y.Array<any>;
    const comments = yComments.toArray();
    
    // Find the comment to update
    let commentIndex = -1;
    for (let i = 0; i < comments.length; i++) {
      if (comments[i].get('id') === commentId) {
        commentIndex = i;
        break;
      }
    }
    
    if (commentIndex === -1) {
      return undefined;
    }
    
    const yComment = comments[commentIndex];
    const now = Date.now();
    
    // Update the comment
    yComment.set('content', content);
    yComment.set('updatedAt', now);
    yComment.set('edited', true);
    
    if (priority !== undefined) {
      yComment.set('priority', priority);
    }
    
    if (tags !== undefined) {
      yComment.set('tags', tags);
    }
    
    // Extract and update mentions
    const mentions = this._extractMentions(content);
    yComment.set('mentions', mentions);
    
    // Update thread timestamp
    yThread.set('updatedAt', now);
    
    // Get the updated comment
    const comment = this._yCommentToComment(yComment);
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.CommentUpdated,
      threadId,
      commentId,
      comment
    });
    
    return comment;
  }

  /**
   * Delete a comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to delete
   */
  deleteComment(threadId: string, commentId: string): void {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return;
    }
    
    const yComments = yThread.get('comments') as Y.Array<any>;
    const comments = yComments.toArray();
    
    // Find the comment to delete
    let commentIndex = -1;
    for (let i = 0; i < comments.length; i++) {
      if (comments[i].get('id') === commentId) {
        commentIndex = i;
        break;
      }
    }
    
    if (commentIndex === -1) {
      return;
    }
    
    // Get the comment before deleting it
    const yComment = comments[commentIndex];
    const comment = this._yCommentToComment(yComment);
    
    // Delete the comment
    yComments.delete(commentIndex, 1);
    
    // Update thread timestamp
    yThread.set('updatedAt', Date.now());
    
    // If this was the last comment, delete the thread
    if (yComments.length === 0) {
      this.deleteThread(threadId);
      return;
    }
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.CommentDeleted,
      threadId,
      commentId,
      comment
    });
  }

  /**
   * Resolve a comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to resolve
   * @param user - The user resolving the comment
   */
  resolveComment(threadId: string, commentId: string, user: ICommentUser): IComment | undefined {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return undefined;
    }
    
    const yComments = yThread.get('comments') as Y.Array<any>;
    const comments = yComments.toArray();
    
    // Find the comment to resolve
    let commentIndex = -1;
    for (let i = 0; i < comments.length; i++) {
      if (comments[i].get('id') === commentId) {
        commentIndex = i;
        break;
      }
    }
    
    if (commentIndex === -1) {
      return undefined;
    }
    
    const yComment = comments[commentIndex];
    const now = Date.now();
    
    // Update the comment status
    yComment.set('status', CommentStatus.Resolved);
    yComment.set('resolvedBy', user);
    yComment.set('resolvedAt', now);
    yComment.set('updatedAt', now);
    
    // Update thread timestamp
    yThread.set('updatedAt', now);
    
    // Get the updated comment
    const comment = this._yCommentToComment(yComment);
    
    // Create notification for the resolved comment
    this._createNotification({
      type: 'resolved',
      commentId,
      threadId,
      userId: user.id
    });
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.CommentUpdated,
      threadId,
      commentId,
      comment
    });
    
    return comment;
  }

  /**
   * Reopen a resolved comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to reopen
   */
  reopenComment(threadId: string, commentId: string): IComment | undefined {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return undefined;
    }
    
    const yComments = yThread.get('comments') as Y.Array<any>;
    const comments = yComments.toArray();
    
    // Find the comment to reopen
    let commentIndex = -1;
    for (let i = 0; i < comments.length; i++) {
      if (comments[i].get('id') === commentId) {
        commentIndex = i;
        break;
      }
    }
    
    if (commentIndex === -1) {
      return undefined;
    }
    
    const yComment = comments[commentIndex];
    const now = Date.now();
    
    // Update the comment status
    yComment.set('status', CommentStatus.Open);
    yComment.delete('resolvedBy');
    yComment.delete('resolvedAt');
    yComment.set('updatedAt', now);
    
    // Update thread timestamp
    yThread.set('updatedAt', now);
    
    // Get the updated comment
    const comment = this._yCommentToComment(yComment);
    
    // Create notification for the status change
    this._createNotification({
      type: 'status-change',
      commentId,
      threadId,
      userId: comment.author.id,
      data: { newStatus: CommentStatus.Open }
    });
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.CommentUpdated,
      threadId,
      commentId,
      comment
    });
    
    return comment;
  }

  /**
   * Archive a comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to archive
   */
  archiveComment(threadId: string, commentId: string): IComment | undefined {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return undefined;
    }
    
    const yComments = yThread.get('comments') as Y.Array<any>;
    const comments = yComments.toArray();
    
    // Find the comment to archive
    let commentIndex = -1;
    for (let i = 0; i < comments.length; i++) {
      if (comments[i].get('id') === commentId) {
        commentIndex = i;
        break;
      }
    }
    
    if (commentIndex === -1) {
      return undefined;
    }
    
    const yComment = comments[commentIndex];
    const now = Date.now();
    
    // Update the comment status
    yComment.set('status', CommentStatus.Archived);
    yComment.set('updatedAt', now);
    
    // Update thread timestamp
    yThread.set('updatedAt', now);
    
    // Get the updated comment
    const comment = this._yCommentToComment(yComment);
    
    // Create notification for the status change
    this._createNotification({
      type: 'status-change',
      commentId,
      threadId,
      userId: comment.author.id,
      data: { newStatus: CommentStatus.Archived }
    });
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.CommentUpdated,
      threadId,
      commentId,
      comment
    });
    
    return comment;
  }

  /**
   * Add a reply to a comment
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment to reply to
   * @param content - The content of the reply
   * @param author - The author of the reply
   */
  addReply(
    threadId: string,
    commentId: string,
    content: string,
    author: ICommentUser
  ): ICommentReply | undefined {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return undefined;
    }
    
    const yComments = yThread.get('comments') as Y.Array<any>;
    const comments = yComments.toArray();
    
    // Find the comment to add the reply to
    let commentIndex = -1;
    for (let i = 0; i < comments.length; i++) {
      if (comments[i].get('id') === commentId) {
        commentIndex = i;
        break;
      }
    }
    
    if (commentIndex === -1) {
      return undefined;
    }
    
    const yComment = comments[commentIndex];
    const now = Date.now();
    
    // Generate reply ID
    const replyId = UUID.uuid4();
    
    // Create the reply
    const reply: ICommentReply = {
      id: replyId,
      content,
      author,
      createdAt: now,
      updatedAt: now,
      edited: false,
      mentions: this._extractMentions(content)
    };
    
    // Add the reply to the comment
    let yReplies = yComment.get('replies') as Y.Array<any>;
    if (!yReplies) {
      yReplies = new Y.Array<any>();
      yComment.set('replies', yReplies);
    }
    
    const yReply = this._replyToYReply(reply);
    yReplies.push([yReply]);
    
    // Update timestamps
    yComment.set('updatedAt', now);
    yThread.set('updatedAt', now);
    
    // Create notification for the new reply
    this._createNotification({
      type: 'new-reply',
      commentId,
      threadId,
      userId: author.id,
      data: { replyId }
    });
    
    // Create notifications for mentions
    if (reply.mentions && reply.mentions.length > 0) {
      for (const mention of reply.mentions) {
        this._createNotification({
          type: 'mention',
          commentId,
          threadId,
          userId: author.id,
          data: { mentionedUserId: mention.id, replyId }
        });
      }
    }
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.ReplyAdded,
      threadId,
      commentId,
      replyId,
      reply
    });
    
    return reply;
  }

  /**
   * Update a reply
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment containing the reply
   * @param replyId - The ID of the reply to update
   * @param content - The new content of the reply
   */
  updateReply(
    threadId: string,
    commentId: string,
    replyId: string,
    content: string
  ): ICommentReply | undefined {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return undefined;
    }
    
    const yComments = yThread.get('comments') as Y.Array<any>;
    const comments = yComments.toArray();
    
    // Find the comment containing the reply
    let commentIndex = -1;
    for (let i = 0; i < comments.length; i++) {
      if (comments[i].get('id') === commentId) {
        commentIndex = i;
        break;
      }
    }
    
    if (commentIndex === -1) {
      return undefined;
    }
    
    const yComment = comments[commentIndex];
    const yReplies = yComment.get('replies') as Y.Array<any>;
    
    if (!yReplies) {
      return undefined;
    }
    
    const replies = yReplies.toArray();
    
    // Find the reply to update
    let replyIndex = -1;
    for (let i = 0; i < replies.length; i++) {
      if (replies[i].get('id') === replyId) {
        replyIndex = i;
        break;
      }
    }
    
    if (replyIndex === -1) {
      return undefined;
    }
    
    const yReply = replies[replyIndex];
    const now = Date.now();
    
    // Update the reply
    yReply.set('content', content);
    yReply.set('updatedAt', now);
    yReply.set('edited', true);
    
    // Extract and update mentions
    const mentions = this._extractMentions(content);
    yReply.set('mentions', mentions);
    
    // Update timestamps
    yComment.set('updatedAt', now);
    yThread.set('updatedAt', now);
    
    // Get the updated reply
    const reply = this._yReplyToReply(yReply);
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.ReplyUpdated,
      threadId,
      commentId,
      replyId,
      reply
    });
    
    return reply;
  }

  /**
   * Delete a reply
   * 
   * @param threadId - The ID of the thread containing the comment
   * @param commentId - The ID of the comment containing the reply
   * @param replyId - The ID of the reply to delete
   */
  deleteReply(threadId: string, commentId: string, replyId: string): void {
    const yThread = this._yThreads.get(threadId);
    if (!yThread) {
      return;
    }
    
    const yComments = yThread.get('comments') as Y.Array<any>;
    const comments = yComments.toArray();
    
    // Find the comment containing the reply
    let commentIndex = -1;
    for (let i = 0; i < comments.length; i++) {
      if (comments[i].get('id') === commentId) {
        commentIndex = i;
        break;
      }
    }
    
    if (commentIndex === -1) {
      return;
    }
    
    const yComment = comments[commentIndex];
    const yReplies = yComment.get('replies') as Y.Array<any>;
    
    if (!yReplies) {
      return;
    }
    
    const replies = yReplies.toArray();
    
    // Find the reply to delete
    let replyIndex = -1;
    for (let i = 0; i < replies.length; i++) {
      if (replies[i].get('id') === replyId) {
        replyIndex = i;
        break;
      }
    }
    
    if (replyIndex === -1) {
      return;
    }
    
    // Get the reply before deleting it
    const yReply = replies[replyIndex];
    const reply = this._yReplyToReply(yReply);
    
    // Delete the reply
    yReplies.delete(replyIndex, 1);
    
    // Update timestamps
    const now = Date.now();
    yComment.set('updatedAt', now);
    yThread.set('updatedAt', now);
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.ReplyDeleted,
      threadId,
      commentId,
      replyId,
      reply
    });
  }

  /**
   * Get all notifications
   */
  getNotifications(): ICommentNotification[] {
    return this._yNotifications.toArray().map(item => {
      return {
        id: item.id,
        type: item.type,
        commentId: item.commentId,
        threadId: item.threadId,
        userId: item.userId,
        timestamp: item.timestamp,
        read: item.read,
        data: item.data
      };
    });
  }

  /**
   * Get unread notifications
   */
  getUnreadNotifications(): ICommentNotification[] {
    return this.getNotifications().filter(notification => !notification.read);
  }

  /**
   * Mark a notification as read
   * 
   * @param notificationId - The ID of the notification to mark as read
   */
  markNotificationAsRead(notificationId: string): void {
    const notifications = this._yNotifications.toArray();
    
    // Find the notification to mark as read
    let notificationIndex = -1;
    for (let i = 0; i < notifications.length; i++) {
      if (notifications[i].id === notificationId) {
        notificationIndex = i;
        break;
      }
    }
    
    if (notificationIndex === -1) {
      return;
    }
    
    // Update the notification
    this._yNotifications.delete(notificationIndex, 1);
    const notification = notifications[notificationIndex];
    notification.read = true;
    this._yNotifications.insert(notificationIndex, [notification]);
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.NotificationUpdated,
      notificationId,
      notification
    });
    
    // Emit notifications changed signal
    this._notificationsChanged.emit(this.getNotifications());
  }

  /**
   * Mark all notifications as read
   */
  markAllNotificationsAsRead(): void {
    const notifications = this._yNotifications.toArray();
    
    // Update all notifications
    this._yNotifications.delete(0, notifications.length);
    
    const updatedNotifications = notifications.map(notification => {
      notification.read = true;
      return notification;
    });
    
    this._yNotifications.insert(0, updatedNotifications);
    
    // Emit notifications changed signal
    this._notificationsChanged.emit(this.getNotifications());
  }

  /**
   * Filter comments based on criteria
   * 
   * @param filter - The filter criteria
   */
  filterComments(filter: ICommentFilter): ICommentThread[] {
    const threads = this.getThreads();
    
    return threads.filter(thread => {
      // Filter by cell ID
      if (filter.cellId && thread.cellId !== filter.cellId) {
        return false;
      }
      
      // Check if any comment in the thread matches the filter criteria
      return thread.comments.some(comment => {
        // Filter by status
        if (filter.status && comment.status !== filter.status) {
          return false;
        }
        
        // Filter by author ID
        if (filter.authorId && comment.author.id !== filter.authorId) {
          return false;
        }
        
        // Filter by priority
        if (filter.priority && comment.priority !== filter.priority) {
          return false;
        }
        
        // Filter by tags
        if (filter.tags && filter.tags.length > 0) {
          if (!comment.tags || !filter.tags.every(tag => comment.tags!.includes(tag))) {
            return false;
          }
        }
        
        // Filter by search text
        if (filter.searchText && filter.searchText.length > 0) {
          const searchText = filter.searchText.toLowerCase();
          const contentMatch = comment.content.toLowerCase().includes(searchText);
          const replyMatch = comment.replies.some(reply => 
            reply.content.toLowerCase().includes(searchText)
          );
          
          if (!contentMatch && !replyMatch) {
            return false;
          }
        }
        
        // Filter by mentioned user ID
        if (filter.mentionedUserId) {
          const mentionedInComment = comment.mentions && 
            comment.mentions.some(user => user.id === filter.mentionedUserId);
          
          const mentionedInReplies = comment.replies.some(reply => 
            reply.mentions && reply.mentions.some(user => user.id === filter.mentionedUserId)
          );
          
          if (!mentionedInComment && !mentionedInReplies) {
            return false;
          }
        }
        
        // Filter by date range
        if (filter.dateRangeStart && comment.createdAt < filter.dateRangeStart) {
          return false;
        }
        
        if (filter.dateRangeEnd && comment.createdAt > filter.dateRangeEnd) {
          return false;
        }
        
        return true;
      });
    });
  }

  /**
   * Search for comments containing specific text
   * 
   * @param searchText - The text to search for
   */
  searchComments(searchText: string): ICommentThread[] {
    return this.filterComments({ searchText });
  }

  /**
   * Get statistics about comments
   */
  getStatistics(): {
    totalThreads: number;
    totalComments: number;
    totalReplies: number;
    openComments: number;
    resolvedComments: number;
    archivedComments: number;
  } {
    const threads = this.getThreads();
    let totalComments = 0;
    let totalReplies = 0;
    let openComments = 0;
    let resolvedComments = 0;
    let archivedComments = 0;
    
    for (const thread of threads) {
      totalComments += thread.comments.length;
      
      for (const comment of thread.comments) {
        totalReplies += comment.replies.length;
        
        if (comment.status === CommentStatus.Open) {
          openComments++;
        } else if (comment.status === CommentStatus.Resolved) {
          resolvedComments++;
        } else if (comment.status === CommentStatus.Archived) {
          archivedComments++;
        }
      }
    }
    
    return {
      totalThreads: threads.length,
      totalComments,
      totalReplies,
      openComments,
      resolvedComments,
      archivedComments
    };
  }

  /**
   * Dispose of the comment system
   */
  dispose(): void {
    // Clean up signals
    this._changed.disconnect();
    this._notificationsChanged.disconnect();
    
    // Remove observers
    this._yThreads.unobserve(this._onThreadsChanged);
    this._yNotifications.unobserve(this._onNotificationsChanged);
  }

  /**
   * Convert a Yjs comment to an IComment
   * 
   * @param yComment - The Yjs comment to convert
   */
  private _yCommentToComment(yComment: Y.Map<any>): IComment {
    const replies: ICommentReply[] = [];
    const yReplies = yComment.get('replies') as Y.Array<any>;
    
    if (yReplies) {
      yReplies.forEach(yReply => {
        replies.push(this._yReplyToReply(yReply));
      });
    }
    
    return {
      id: yComment.get('id'),
      content: yComment.get('content'),
      author: yComment.get('author'),
      createdAt: yComment.get('createdAt'),
      updatedAt: yComment.get('updatedAt'),
      status: yComment.get('status'),
      priority: yComment.get('priority'),
      resolvedBy: yComment.get('resolvedBy'),
      resolvedAt: yComment.get('resolvedAt'),
      edited: yComment.get('edited'),
      replies,
      mentions: yComment.get('mentions'),
      tags: yComment.get('tags')
    };
  }

  /**
   * Convert an IComment to a Yjs comment
   * 
   * @param comment - The comment to convert
   */
  private _commentToYComment(comment: IComment): Y.Map<any> {
    const yComment = new Y.Map<any>();
    yComment.set('id', comment.id);
    yComment.set('content', comment.content);
    yComment.set('author', comment.author);
    yComment.set('createdAt', comment.createdAt);
    yComment.set('updatedAt', comment.updatedAt);
    yComment.set('status', comment.status);
    yComment.set('priority', comment.priority);
    yComment.set('edited', comment.edited);
    
    if (comment.resolvedBy) {
      yComment.set('resolvedBy', comment.resolvedBy);
    }
    
    if (comment.resolvedAt) {
      yComment.set('resolvedAt', comment.resolvedAt);
    }
    
    if (comment.mentions) {
      yComment.set('mentions', comment.mentions);
    }
    
    if (comment.tags) {
      yComment.set('tags', comment.tags);
    }
    
    if (comment.replies.length > 0) {
      const yReplies = new Y.Array<any>();
      for (const reply of comment.replies) {
        yReplies.push([this._replyToYReply(reply)]);
      }
      yComment.set('replies', yReplies);
    }
    
    return yComment;
  }

  /**
   * Convert a Yjs reply to an ICommentReply
   * 
   * @param yReply - The Yjs reply to convert
   */
  private _yReplyToReply(yReply: Y.Map<any>): ICommentReply {
    return {
      id: yReply.get('id'),
      content: yReply.get('content'),
      author: yReply.get('author'),
      createdAt: yReply.get('createdAt'),
      updatedAt: yReply.get('updatedAt'),
      edited: yReply.get('edited'),
      mentions: yReply.get('mentions')
    };
  }

  /**
   * Convert an ICommentReply to a Yjs reply
   * 
   * @param reply - The reply to convert
   */
  private _replyToYReply(reply: ICommentReply): Y.Map<any> {
    const yReply = new Y.Map<any>();
    yReply.set('id', reply.id);
    yReply.set('content', reply.content);
    yReply.set('author', reply.author);
    yReply.set('createdAt', reply.createdAt);
    yReply.set('updatedAt', reply.updatedAt);
    yReply.set('edited', reply.edited);
    
    if (reply.mentions) {
      yReply.set('mentions', reply.mentions);
    }
    
    return yReply;
  }

  /**
   * Convert a Yjs thread to an ICommentThread
   * 
   * @param yThread - The Yjs thread to convert
   */
  private _yThreadToThread(yThread: Y.Map<any>): ICommentThread {
    const comments: IComment[] = [];
    const yComments = yThread.get('comments') as Y.Array<any>;
    
    yComments.forEach(yComment => {
      comments.push(this._yCommentToComment(yComment));
    });
    
    return {
      id: yThread.get('id'),
      cellId: yThread.get('cellId'),
      range: yThread.get('range'),
      comments,
      createdAt: yThread.get('createdAt'),
      updatedAt: yThread.get('updatedAt')
    };
  }

  /**
   * Extract mentions from comment content
   * 
   * @param content - The content to extract mentions from
   */
  private _extractMentions(content: string): ICommentUser[] {
    // Simple regex to extract @username mentions
    // In a real implementation, this would validate against actual users
    const mentionRegex = /@([\w-]+)/g;
    const mentions: ICommentUser[] = [];
    let match;
    
    while ((match = mentionRegex.exec(content)) !== null) {
      const username = match[1];
      // In a real implementation, this would look up the user by username
      // For now, we'll just create a placeholder user
      mentions.push({
        id: username,
        displayName: username
      });
    }
    
    return mentions;
  }

  /**
   * Create a notification
   * 
   * @param params - Notification parameters
   */
  private _createNotification(params: {
    type: 'new-comment' | 'new-reply' | 'mention' | 'resolved' | 'status-change';
    commentId: string;
    threadId: string;
    userId: string;
    data?: any;
  }): void {
    const notification: ICommentNotification = {
      id: UUID.uuid4(),
      type: params.type,
      commentId: params.commentId,
      threadId: params.threadId,
      userId: params.userId,
      timestamp: Date.now(),
      read: false,
      data: params.data
    };
    
    // Add the notification to the shared array
    this._yNotifications.push([notification]);
    
    // Emit change event
    this._emitChangeEvent({
      type: CommentChangeType.NotificationAdded,
      notificationId: notification.id,
      notification
    });
    
    // Emit notifications changed signal
    this._notificationsChanged.emit(this.getNotifications());
  }

  /**
   * Handle changes to the threads map
   */
  private _onThreadsChanged(event: Y.YMapEvent<any>): void {
    // This method is called when the threads map changes
    // We don't need to do anything here as we handle changes in the specific methods
  }

  /**
   * Handle changes to the notifications array
   */
  private _onNotificationsChanged(event: Y.YArrayEvent<any>): void {
    // This method is called when the notifications array changes
    // We don't need to do anything here as we handle changes in the specific methods
  }

  /**
   * Emit a change event
   * 
   * @param event - The change event to emit
   */
  private _emitChangeEvent(event: ICommentChangeEvent): void {
    this._changed.emit(event);
  }

  private _notebookModel: INotebookModel;
  private _ydoc: Y.Doc;
  private _yThreads: Y.Map<Y.Map<any>>;
  private _yNotifications: Y.Array<any>;
  private _changed: Signal<ICommentSystem, ICommentChangeEvent>;
  private _notificationsChanged: Signal<ICommentSystem, ICommentNotification[]>;
}