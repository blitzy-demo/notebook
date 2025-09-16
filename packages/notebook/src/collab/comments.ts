/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * CommentStore class managing collaborative commenting and review system.
 * Implements threaded discussions with Yjs persistence, notification mechanisms,
 * resolution workflows, and seamless integration with the notebook UI for code review capabilities.
 * Provides comprehensive comment management including CRUD operations, threading, mentions,
 * search/filtering, and export functionality with full permission integration.
 */

import * as Y from 'yjs';
import { Signal } from '@lumino/signaling';
import { UUID } from '@lumino/coreutils';
import { marked } from 'marked';
import * as _ from 'lodash';
import { ICellModel } from '@jupyterlab/cells';

import { YjsNotebookProvider } from './provider';
import { PermissionManager } from './permissions';
import { CollaborationAwareness } from './awareness';
import { ICollaborativeSession, IComment, ICollaborativeUser, CollaborativeRole } from '../tokens';

/**
 * Default timeout for comment operations in milliseconds
 */
export const DEFAULT_COMMENT_TIMEOUT_MS = 30000;

/**
 * Comment status enumeration for workflow tracking
 */
export enum CommentStatus {
  OPEN = 'open',
  RESOLVED = 'resolved',
  ARCHIVED = 'archived'
}

/**
 * Configuration interface for CommentStore initialization
 */
export interface ICommentConfig {
  /**
   * Enable/disable comment notifications
   */
  enableNotifications?: boolean;

  /**
   * Maximum comment depth for threading
   */
  maxThreadDepth?: number;

  /**
   * Comment operation timeout in milliseconds
   */
  operationTimeout?: number;

  /**
   * Enable markdown formatting in comments
   */
  enableMarkdown?: boolean;

  /**
   * Enable @-mention functionality
   */
  enableMentions?: boolean;

  /**
   * Auto-resolve threads after period of inactivity
   */
  autoResolveTimeout?: number;

  /**
   * Maximum comments per cell
   */
  maxCommentsPerCell?: number;

  /**
   * Enable comment moderation
   */
  enableModeration?: boolean;

  /**
   * Notification email settings
   */
  emailNotifications?: boolean;
}

/**
 * Comment notification interface
 */
export interface ICommentNotification {
  /**
   * Unique notification ID
   */
  readonly id: string;

  /**
   * Comment that triggered the notification
   */
  readonly comment: IComment;

  /**
   * User being notified
   */
  readonly targetUserId: string;

  /**
   * Type of notification
   */
  readonly type: 'reply' | 'mention' | 'resolution' | 'new_comment';

  /**
   * Timestamp when notification was created
   */
  readonly timestamp: Date;

  /**
   * Whether notification has been read
   */
  readonly isRead: boolean;

  /**
   * Additional notification metadata
   */
  readonly metadata?: Record<string, any>;
}

/**
 * Comment thread interface for organized discussion
 */
export interface ICommentThread {
  /**
   * Root comment of the thread
   */
  readonly rootComment: IComment;

  /**
   * All comments in the thread including root
   */
  readonly comments: IComment[];

  /**
   * Cell this thread is attached to
   */
  readonly cellId: string;

  /**
   * Thread status
   */
  readonly status: CommentStatus;

  /**
   * Total number of comments in thread
   */
  readonly commentCount: number;

  /**
   * Last activity timestamp
   */
  readonly lastActivity: Date;

  /**
   * Users participating in this thread
   */
  readonly participants: string[];
}

/**
 * Comment search result interface
 */
export interface ICommentSearchResult {
  /**
   * Matching comment
   */
  readonly comment: IComment;

  /**
   * Relevance score (0-1)
   */
  readonly score: number;

  /**
   * Highlighted text matches
   */
  readonly highlights: string[];

  /**
   * Context information
   */
  readonly context: {
    cellIndex: number;
    threadPosition: number;
  };
}

/**
 * Comment export options interface
 */
export interface ICommentExportOptions {
  /**
   * Export format
   */
  format?: 'markdown' | 'json' | 'html' | 'csv';

  /**
   * Include resolved comments
   */
  includeResolved?: boolean;

  /**
   * Include archived comments
   */
  includeArchived?: boolean;

  /**
   * Filter by cell IDs
   */
  cellIds?: string[];

  /**
   * Filter by user IDs
   */
  userIds?: string[];

  /**
   * Date range filter
   */
  dateRange?: {
    start: Date;
    end: Date;
  };

  /**
   * Include thread structure
   */
  includeThreading?: boolean;

  /**
   * Include user information
   */
  includeUserInfo?: boolean;
}

/**
 * Custom error class for comment operations
 */
export class CommentError extends Error {
  /**
   * Error code for categorization
   */
  public readonly code: string;

  /**
   * Comment ID associated with the error
   */
  public readonly commentId?: string;

  /**
   * Operation that failed
   */
  public readonly operation: string;

  /**
   * Error message
   */
  public readonly message: string;

  /**
   * Additional context information
   */
  public readonly context?: Record<string, any>;

  constructor(
    code: string,
    operation: string,
    message: string,
    commentId?: string,
    context?: Record<string, any>
  ) {
    super(message);
    this.name = 'CommentError';
    this.code = code;
    this.operation = operation;
    this.message = message;
    this.commentId = commentId;
    this.context = context;
  }
}

/**
 * Internal comment data interface for Yjs storage
 */
interface ICommentData {
  id: string;
  authorId: string;
  content: string;
  cellId: string;
  timestamp: number;
  parentId: string | null;
  status: CommentStatus;
  mentions: string[];
  metadata: Record<string, any>;
}

/**
 * CommentStore class implementing comprehensive collaborative commenting system
 */
export class CommentStore {
  private _provider: YjsNotebookProvider;
  private _permissionManager: PermissionManager;
  private _awareness: CollaborationAwareness;
  private _session: ICollaborativeSession | null = null;
  private _config: Required<ICommentConfig>;

  // Yjs shared data structures
  private _commentsMap: Y.Map<string> | null = null;
  private _threadsMap: Y.Map<string> | null = null;
  private _notificationsMap: Y.Map<string> | null = null;

  // Local state management
  private _disposed: boolean = false;
  private _notificationsEnabled: boolean = true;
  private _notifications: Map<string, ICommentNotification> = new Map();
  private _operationTimeouts: Map<string, any> = new Map();

  // Search and filtering
  private _searchIndex: Map<string, string[]> = new Map();
  private _debouncedReindex = _.debounce(this._rebuildSearchIndex.bind(this), 500);

  // Signals for reactive updates
  private _commentCreatedSignal = new Signal<CommentStore, IComment>(this);
  private _commentUpdatedSignal = new Signal<CommentStore, IComment>(this);
  private _commentDeletedSignal = new Signal<CommentStore, { commentId: string; cellId: string }>(this);
  private _commentResolvedSignal = new Signal<CommentStore, IComment>(this);
  private _notificationSignal = new Signal<CommentStore, ICommentNotification>(this);

  /**
   * Create a new CommentStore instance
   */
  constructor(
    provider: YjsNotebookProvider,
    permissionManager: PermissionManager,
    awareness: CollaborationAwareness,
    config: ICommentConfig = {}
  ) {
    this._provider = provider;
    this._permissionManager = permissionManager;
    this._awareness = awareness;

    // Initialize configuration with defaults
    this._config = {
      enableNotifications: config.enableNotifications ?? true,
      maxThreadDepth: config.maxThreadDepth ?? 10,
      operationTimeout: config.operationTimeout ?? DEFAULT_COMMENT_TIMEOUT_MS,
      enableMarkdown: config.enableMarkdown ?? true,
      enableMentions: config.enableMentions ?? true,
      autoResolveTimeout: config.autoResolveTimeout ?? 7 * 24 * 60 * 60 * 1000, // 7 days
      maxCommentsPerCell: config.maxCommentsPerCell ?? 100,
      enableModeration: config.enableModeration ?? true,
      emailNotifications: config.emailNotifications ?? false
    };

    this._notificationsEnabled = this._config.enableNotifications;

    // Initialize Yjs shared data structures if provider is available
    if (this._provider?.yjsDoc) {
      this._initializeYjsStructures();
    }

    console.log('CommentStore initialized with configuration:', this._config);
  }

  /**
   * Create a new comment
   */
  async create(
    cellId: string,
    content: string,
    parentId?: string,
    mentions?: string[]
  ): Promise<IComment> {
    if (this._disposed) {
      throw new CommentError('DISPOSED', 'create', 'CommentStore has been disposed');
    }

    // Validate permissions
    const currentUser = this._getCurrentUser();
    if (!currentUser) {
      throw new CommentError('NO_USER', 'create', 'No current user available');
    }

    const canEdit = await this._permissionManager.canEdit(currentUser.userId);
    if (!canEdit) {
      throw new CommentError('PERMISSION_DENIED', 'create', 'User does not have permission to create comments');
    }

    // Validate content
    if (!content || content.trim().length === 0) {
      throw new CommentError('INVALID_CONTENT', 'create', 'Comment content cannot be empty');
    }

    // Check comment limits
    const existingComments = await this.getCommentsByCell(cellId);
    if (existingComments.length >= this._config.maxCommentsPerCell) {
      throw new CommentError('COMMENT_LIMIT_EXCEEDED', 'create', `Maximum ${this._config.maxCommentsPerCell} comments per cell exceeded`);
    }

    // Validate parent comment if provided
    if (parentId) {
      const parentComment = await this.getCommentById(parentId);
      if (!parentComment) {
        throw new CommentError('PARENT_NOT_FOUND', 'create', 'Parent comment not found', parentId);
      }
      if (parentComment.cellId !== cellId) {
        throw new CommentError('PARENT_CELL_MISMATCH', 'create', 'Parent comment is not on the same cell');
      }
    }

    try {
      // Generate unique comment ID
      const commentId = `comment_${UUID.uuid4()}`;

      // Process mentions
      const processedMentions = mentions ? this._processMentions(mentions, content) : [];

      // Create comment data
      const commentData: ICommentData = {
        id: commentId,
        authorId: currentUser.userId,
        content: this._config.enableMarkdown ? content : this._stripMarkdown(content),
        cellId,
        timestamp: Date.now(),
        parentId: parentId || null,
        status: CommentStatus.OPEN,
        mentions: processedMentions,
        metadata: {
          createdBy: currentUser.userId,
          editHistory: []
        }
      };

      // Store in Yjs for real-time sync
      if (this._commentsMap && this._provider.isConnected()) {
        this._commentsMap.set(commentId, JSON.stringify(commentData));
      }

      // Create comment object
      const comment = await this._buildCommentFromData(commentData);

      // Update search index
      this._debouncedReindex();

      // Handle notifications
      if (this._notificationsEnabled) {
        await this._handleCommentCreatedNotifications(comment);
      }

      // Emit signal
      this._commentCreatedSignal.emit(comment);

      console.log('Comment created:', commentId, 'on cell:', cellId);
      return comment;

    } catch (error) {
      console.error('Error creating comment:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new CommentError('CREATE_FAILED', 'create', `Failed to create comment: ${errorMessage}`, undefined, { error });
    }
  }

  /**
   * Read/retrieve a comment by ID
   */
  async read(commentId: string): Promise<IComment | null> {
    return await this.getCommentById(commentId);
  }

  /**
   * Update an existing comment
   */
  async update(
    commentId: string,
    content?: string,
    status?: CommentStatus
  ): Promise<IComment> {
    if (this._disposed) {
      throw new CommentError('DISPOSED', 'update', 'CommentStore has been disposed');
    }

    // Get existing comment
    const existingComment = await this.getCommentById(commentId);
    if (!existingComment) {
      throw new CommentError('NOT_FOUND', 'update', 'Comment not found', commentId);
    }

    // Validate permissions
    const currentUser = this._getCurrentUser();
    if (!currentUser) {
      throw new CommentError('NO_USER', 'update', 'No current user available');
    }

    const canEdit = await this._canModifyComment(existingComment, currentUser.userId);
    if (!canEdit) {
      throw new CommentError('PERMISSION_DENIED', 'update', 'User does not have permission to update this comment');
    }

    try {
      // Get comment data from Yjs
      const commentDataStr = this._commentsMap?.get(commentId);
      if (!commentDataStr) {
        throw new CommentError('DATA_NOT_FOUND', 'update', 'Comment data not found in storage');
      }

      const commentData: ICommentData = JSON.parse(commentDataStr);

      // Update fields
      if (content !== undefined) {
        commentData.content = this._config.enableMarkdown ? content : this._stripMarkdown(content);
        commentData.metadata.editHistory = commentData.metadata.editHistory || [];
        commentData.metadata.editHistory.push({
          editedBy: currentUser.userId,
          editedAt: Date.now(),
          previousContent: existingComment.content
        });
      }

      if (status !== undefined) {
        commentData.status = status;
        commentData.metadata.statusChangedBy = currentUser.userId;
        commentData.metadata.statusChangedAt = Date.now();
      }

      // Store updated data
      if (this._commentsMap && this._provider.isConnected()) {
        this._commentsMap.set(commentId, JSON.stringify(commentData));
      }

      // Create updated comment object
      const updatedComment = await this._buildCommentFromData(commentData);

      // Update search index
      this._debouncedReindex();

      // Handle notifications for status changes
      if (status !== undefined && this._notificationsEnabled) {
        await this._handleCommentStatusNotifications(updatedComment, existingComment.isResolved);
      }

      // Emit signals
      this._commentUpdatedSignal.emit(updatedComment);
      if (status === CommentStatus.RESOLVED) {
        this._commentResolvedSignal.emit(updatedComment);
      }

      console.log('Comment updated:', commentId);
      return updatedComment;

    } catch (error) {
      console.error('Error updating comment:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new CommentError('UPDATE_FAILED', 'update', `Failed to update comment: ${errorMessage}`, commentId, { error });
    }
  }

  /**
   * Delete a comment and all its replies
   */
  async delete(commentId: string): Promise<void> {
    if (this._disposed) {
      throw new CommentError('DISPOSED', 'delete', 'CommentStore has been disposed');
    }

    // Get existing comment
    const existingComment = await this.getCommentById(commentId);
    if (!existingComment) {
      throw new CommentError('NOT_FOUND', 'delete', 'Comment not found', commentId);
    }

    // Validate permissions
    const currentUser = this._getCurrentUser();
    if (!currentUser) {
      throw new CommentError('NO_USER', 'delete', 'No current user available');
    }

    const canDelete = await this._canDeleteComment(existingComment, currentUser.userId);
    if (!canDelete) {
      throw new CommentError('PERMISSION_DENIED', 'delete', 'User does not have permission to delete this comment');
    }

    try {
      // Collect all comments to delete (including replies)
      const commentsToDelete = await this._collectCommentTree(commentId);

      // Delete from Yjs storage
      if (this._commentsMap && this._provider.isConnected()) {
        for (const comment of commentsToDelete) {
          this._commentsMap.delete(comment.id);
        }
      }

      // Clear notifications for deleted comments
      for (const comment of commentsToDelete) {
        await this._clearNotificationsForComment(comment.id);
      }

      // Update search index
      this._debouncedReindex();

      // Emit signal
      this._commentDeletedSignal.emit({
        commentId,
        cellId: existingComment.cellId
      });

      console.log(`Deleted comment tree: ${commentsToDelete.length} comments starting from ${commentId}`);

    } catch (error) {
      console.error('Error deleting comment:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new CommentError('DELETE_FAILED', 'delete', `Failed to delete comment: ${errorMessage}`, commentId, { error });
    }
  }

  /**
   * Add a reply to an existing comment
   */
  async addReply(
    parentCommentId: string,
    content: string,
    mentions?: string[]
  ): Promise<IComment> {
    // Get parent comment to extract cell ID
    const parentComment = await this.getCommentById(parentCommentId);
    if (!parentComment) {
      throw new CommentError('PARENT_NOT_FOUND', 'addReply', 'Parent comment not found', parentCommentId);
    }

    // Check thread depth
    const threadDepth = await this._getThreadDepth(parentCommentId);
    if (threadDepth >= this._config.maxThreadDepth) {
      throw new CommentError('MAX_DEPTH_EXCEEDED', 'addReply', `Maximum thread depth of ${this._config.maxThreadDepth} exceeded`);
    }

    // Create reply as a regular comment with parent ID
    return await this.create(parentComment.cellId, content, parentCommentId, mentions);
  }

  /**
   * Resolve a comment or thread
   */
  async resolveComment(commentId: string): Promise<IComment> {
    return await this.update(commentId, undefined, CommentStatus.RESOLVED);
  }

  /**
   * Subscribe to comment notifications
   */
  subscribeToNotifications(callback: (notification: ICommentNotification) => void): () => void {
    const handler = (sender: CommentStore, notification: ICommentNotification) => {
      callback(notification);
    };

    this._notificationSignal.connect(handler);

    // Return unsubscribe function
    return () => {
      this._notificationSignal.disconnect(handler);
    };
  }

  /**
   * Get threaded comments for a cell
   */
  async getThreadedComments(cellId: string): Promise<ICommentThread[]> {
    try {
      const allComments = await this.getCommentsByCell(cellId);
      const threads: Map<string, ICommentThread> = new Map();

      // Group comments by thread (root comment)
      for (const comment of allComments) {
        const rootId = await this._findThreadRoot(comment);

        if (!threads.has(rootId)) {
          const rootComment = await this.getCommentById(rootId);
          if (rootComment) {
            threads.set(rootId, {
              rootComment,
              comments: [] as IComment[],
              cellId,
              status: CommentStatus.OPEN as CommentStatus,
              commentCount: 0,
              lastActivity: rootComment.timestamp,
              participants: [] as string[]
            } as ICommentThread);
          }
        }

        const thread = threads.get(rootId);
        if (thread) {
          // Create mutable copy for modifications
          const mutableThread = thread as any;
          mutableThread.comments.push(comment);
          mutableThread.commentCount++;

          // Update last activity
          if (comment.timestamp > mutableThread.lastActivity) {
            mutableThread.lastActivity = comment.timestamp;
          }

          // Add to participants
          if (!mutableThread.participants.includes(comment.author.userId)) {
            mutableThread.participants.push(comment.author.userId);
          }

          // Update thread status (resolved if all comments resolved)
          if (mutableThread.status === CommentStatus.OPEN && comment.isResolved) {
            const allResolved = mutableThread.comments.every((c: IComment) => c.isResolved);
            if (allResolved) {
              mutableThread.status = CommentStatus.RESOLVED;
            }
          }
        }
      }

      // Sort threads by last activity
      return Array.from(threads.values()).sort((a, b) =>
        b.lastActivity.getTime() - a.lastActivity.getTime()
      );

    } catch (error) {
      console.error('Error getting threaded comments:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new CommentError('GET_THREADS_FAILED', 'getThreadedComments', `Failed to get threaded comments: ${errorMessage}`, undefined, { cellId });
    }
  }

  /**
   * Export comments in various formats
   */
  async exportComments(options: ICommentExportOptions = {}): Promise<string> {
    const {
      format = 'markdown',
      includeResolved = true,
      includeArchived = false,
      cellIds,
      userIds,
      dateRange,
      includeThreading = true,
      includeUserInfo = true
    } = options;

    try {
      // Get all comments matching filters
      let comments = await this._getAllComments();

      // Apply filters
      if (cellIds && cellIds.length > 0) {
        comments = comments.filter(c => cellIds.includes(c.cellId));
      }

      if (userIds && userIds.length > 0) {
        comments = comments.filter(c => userIds.includes(c.author.userId));
      }

      if (!includeResolved) {
        comments = comments.filter(c => !c.isResolved);
      }

      if (!includeArchived) {
        comments = comments.filter(c => !c.content.includes('[ARCHIVED]'));
      }

      if (dateRange) {
        comments = comments.filter(c =>
          c.timestamp >= dateRange.start && c.timestamp <= dateRange.end
        );
      }

      // Export based on format
      switch (format) {
        case 'markdown':
          return this._exportToMarkdown(comments, includeThreading, includeUserInfo);
        case 'json':
          return this._exportToJson(comments, includeUserInfo);
        case 'html':
          return this._exportToHtml(comments, includeThreading, includeUserInfo);
        case 'csv':
          return this._exportToCsv(comments, includeUserInfo);
        default:
          throw new CommentError('INVALID_FORMAT', 'exportComments', `Unsupported export format: ${format}`);
      }

    } catch (error) {
      console.error('Error exporting comments:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new CommentError('EXPORT_FAILED', 'exportComments', `Failed to export comments: ${errorMessage}`, undefined, { options });
    }
  }

  /**
   * Get comment by ID
   */
  async getCommentById(commentId: string): Promise<IComment | null> {
    if (this._disposed) {
      return null;
    }

    try {
      const commentDataStr = this._commentsMap?.get(commentId);
      if (!commentDataStr) {
        return null;
      }

      const commentData: ICommentData = JSON.parse(commentDataStr);
      return await this._buildCommentFromData(commentData);

    } catch (error) {
      console.error('Error getting comment by ID:', error);
      return null;
    }
  }

  /**
   * Get all comments for a specific cell
   */
  async getCommentsByCell(cellId: string): Promise<IComment[]> {
    if (this._disposed) {
      return [];
    }

    try {
      const comments: IComment[] = [];

      if (this._commentsMap) {
        this._commentsMap.forEach((commentDataStr, commentId) => {
          try {
            const commentData: ICommentData = JSON.parse(commentDataStr);
            if (commentData.cellId === cellId) {
              this._buildCommentFromData(commentData).then(comment => {
                comments.push(comment);
              }).catch(console.error);
            }
          } catch (error) {
            console.error('Error parsing comment data:', error);
          }
        });
      }

      // Wait for all comment building to complete
      await Promise.all(comments);

      // Sort by timestamp
      return comments.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    } catch (error) {
      console.error('Error getting comments by cell:', error);
      return [];
    }
  }

  /**
   * Get all comments by a specific user
   */
  async getCommentsByUser(userId: string): Promise<IComment[]> {
    if (this._disposed) {
      return [];
    }

    try {
      const comments: IComment[] = [];

      if (this._commentsMap) {
        this._commentsMap.forEach((commentDataStr, commentId) => {
          try {
            const commentData: ICommentData = JSON.parse(commentDataStr);
            if (commentData.authorId === userId) {
              this._buildCommentFromData(commentData).then(comment => {
                comments.push(comment);
              }).catch(console.error);
            }
          } catch (error) {
            console.error('Error parsing comment data:', error);
          }
        });
      }

      // Wait for all comment building to complete
      await Promise.all(comments);

      // Sort by timestamp
      return comments.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    } catch (error) {
      console.error('Error getting comments by user:', error);
      return [];
    }
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string): Promise<void> {
    try {
      const notification = this._notifications.get(notificationId);
      if (notification) {
        const updatedNotification: ICommentNotification = {
          ...notification,
          isRead: true
        };

        this._notifications.set(notificationId, updatedNotification);

        // Update in Yjs
        if (this._notificationsMap && this._provider.isConnected()) {
          this._notificationsMap.set(notificationId, JSON.stringify(updatedNotification));
        }
      }
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  }

  /**
   * Get count of unread notifications
   */
  getNotificationCount(): number {
    let count = 0;
    const notifications = Array.from(this._notifications.values());
    for (const notification of notifications) {
      if (!notification.isRead) {
        count++;
      }
    }
    return count;
  }

  /**
   * Search comments by content and metadata
   */
  async searchComments(
    query: string,
    options?: {
      cellIds?: string[];
      userIds?: string[];
      dateRange?: { start: Date; end: Date };
      includeResolved?: boolean;
    }
  ): Promise<ICommentSearchResult[]> {
    try {
      const searchTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 0);
      const results: ICommentSearchResult[] = [];

      // Get all comments matching basic filters
      let comments = await this._getAllComments();

      // Apply filters
      if (options?.cellIds) {
        comments = comments.filter(c => options.cellIds!.includes(c.cellId));
      }
      if (options?.userIds) {
        comments = comments.filter(c => options.userIds!.includes(c.author.userId));
      }
      if (options?.dateRange) {
        comments = comments.filter(c =>
          c.timestamp >= options.dateRange!.start && c.timestamp <= options.dateRange!.end
        );
      }
      if (!options?.includeResolved) {
        comments = comments.filter(c => !c.isResolved);
      }

      // Search through comments
      for (const comment of comments) {
        const searchText = `${comment.content} ${comment.author.displayName}`.toLowerCase();
        const highlights: string[] = [];
        let score = 0;

        // Calculate relevance score and extract highlights
        for (const term of searchTerms) {
          const regex = new RegExp(`\\b${_.escapeRegExp(term)}\\w*`, 'gi');
          const matches = searchText.match(regex);
          if (matches) {
            score += matches.length / searchTerms.length;
            highlights.push(...matches);
          }
        }

        if (score > 0) {
          results.push({
            comment,
            score,
            highlights: _.uniq(highlights),
            context: {
              cellIndex: 0, // Would need cell index lookup
              threadPosition: comment.parentId ? 1 : 0
            }
          });
        }
      }

      // Sort by relevance score
      return results.sort((a, b) => b.score - a.score);

    } catch (error) {
      console.error('Error searching comments:', error);
      return [];
    }
  }

  /**
   * Filter comments by criteria
   */
  async filterComments(criteria: {
    status?: CommentStatus;
    cellIds?: string[];
    userIds?: string[];
    hasReplies?: boolean;
    hasMentions?: boolean;
    dateRange?: { start: Date; end: Date };
  }): Promise<IComment[]> {
    try {
      let comments = await this._getAllComments();

      if (criteria.status) {
        comments = comments.filter(c =>
          c.isResolved === (criteria.status === CommentStatus.RESOLVED)
        );
      }

      if (criteria.cellIds) {
        comments = comments.filter(c => criteria.cellIds!.includes(c.cellId));
      }

      if (criteria.userIds) {
        comments = comments.filter(c => criteria.userIds!.includes(c.author.userId));
      }

      if (criteria.hasReplies !== undefined) {
        comments = comments.filter(c =>
          (c.replies.length > 0) === criteria.hasReplies
        );
      }

      if (criteria.hasMentions !== undefined) {
        comments = comments.filter(c =>
          (c.mentions.length > 0) === criteria.hasMentions
        );
      }

      if (criteria.dateRange) {
        comments = comments.filter(c =>
          c.timestamp >= criteria.dateRange!.start && c.timestamp <= criteria.dateRange!.end
        );
      }

      return comments.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    } catch (error) {
      console.error('Error filtering comments:', error);
      return [];
    }
  }

  /**
   * Get mentions for a specific user
   */
  async getMentions(userId: string): Promise<IComment[]> {
    try {
      const comments = await this._getAllComments();
      return comments.filter(comment =>
        comment.mentions.includes(userId)
      ).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (error) {
      console.error('Error getting mentions:', error);
      return [];
    }
  }

  /**
   * Resolve an entire comment thread
   */
  async resolveThread(rootCommentId: string): Promise<IComment[]> {
    try {
      const commentsInThread = await this._collectCommentTree(rootCommentId);
      const resolvedComments: IComment[] = [];

      for (const comment of commentsInThread) {
        if (!comment.isResolved) {
          const resolvedComment = await this.resolveComment(comment.id);
          resolvedComments.push(resolvedComment);
        }
      }

      return resolvedComments;
    } catch (error) {
      console.error('Error resolving thread:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new CommentError('RESOLVE_THREAD_FAILED', 'resolveThread', `Failed to resolve thread: ${errorMessage}`, rootCommentId);
    }
  }

  /**
   * Add a mention to a comment
   */
  async addMention(commentId: string, userId: string): Promise<IComment> {
    const comment = await this.getCommentById(commentId);
    if (!comment) {
      throw new CommentError('NOT_FOUND', 'addMention', 'Comment not found', commentId);
    }

    if (comment.mentions.includes(userId)) {
      return comment; // Already mentioned
    }

    // Update comment content to include mention
    const updatedContent = `${comment.content}\n@${userId}`;
    const updatedMentions = [...comment.mentions, userId];

    // Update the comment data in Yjs
    const commentDataStr = this._commentsMap?.get(commentId);
    if (commentDataStr) {
      const commentData: ICommentData = JSON.parse(commentDataStr);
      commentData.content = updatedContent;
      commentData.mentions = updatedMentions;

      if (this._commentsMap && this._provider.isConnected()) {
        this._commentsMap.set(commentId, JSON.stringify(commentData));
      }

      // Create notification for mentioned user
      if (this._notificationsEnabled) {
        await this._createMentionNotification(comment, userId);
      }

      return await this._buildCommentFromData(commentData);
    }

    return comment;
  }

  /**
   * Enable notifications for the current session
   */
  enableNotifications(): void {
    this._notificationsEnabled = true;
    console.log('Comment notifications enabled');
  }

  /**
   * Disable notifications for the current session
   */
  disableNotifications(): void {
    this._notificationsEnabled = false;
    console.log('Comment notifications disabled');
  }

  /**
   * Dispose of the comment store and clean up resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Clear operation timeouts
    Array.from(this._operationTimeouts.values()).forEach(timeout => {
      clearTimeout(timeout);
    });
    this._operationTimeouts.clear();

    // Clear local data
    this._notifications.clear();
    this._searchIndex.clear();

    // Clean up Yjs references
    this._commentsMap = null;
    this._threadsMap = null;
    this._notificationsMap = null;

    console.log('CommentStore disposed');
  }

  // Private helper methods

  /**
   * Initialize Yjs shared data structures
   */
  private _initializeYjsStructures(): void {
    if (!this._provider.yjsDoc) {
      return;
    }

    this._commentsMap = this._provider.yjsDoc.getMap('comments');
    this._threadsMap = this._provider.yjsDoc.getMap('threads');
    this._notificationsMap = this._provider.yjsDoc.getMap('notifications');

    // Set up Yjs event handlers
    this._setupYjsEventHandlers();

    console.log('Yjs comment structures initialized');
  }

  /**
   * Set up Yjs event handlers for real-time updates
   */
  private _setupYjsEventHandlers(): void {
    if (!this._commentsMap || !this._notificationsMap) {
      return;
    }

    // Listen for comment changes
    this._commentsMap.observe((event) => {
      event.changes.keys.forEach((change, commentId) => {
        if (change.action === 'add' || change.action === 'update') {
          this._handleRemoteCommentChange(commentId);
        } else if (change.action === 'delete') {
          this._handleRemoteCommentDelete(commentId);
        }
      });
    });

    // Listen for notification changes
    this._notificationsMap.observe((event) => {
      event.changes.keys.forEach((change, notificationId) => {
        if (change.action === 'add') {
          this._handleRemoteNotification(notificationId);
        }
      });
    });
  }

  /**
   * Handle remote comment changes from other users
   */
  private async _handleRemoteCommentChange(commentId: string): Promise<void> {
    try {
      const comment = await this.getCommentById(commentId);
      if (comment) {
        this._commentUpdatedSignal.emit(comment);
        this._debouncedReindex();
      }
    } catch (error) {
      console.error('Error handling remote comment change:', error);
    }
  }

  /**
   * Handle remote comment deletion from other users
   */
  private _handleRemoteCommentDelete(commentId: string): void {
    this._commentDeletedSignal.emit({
      commentId,
      cellId: 'unknown' // We don't have cell context in delete event
    });
    this._debouncedReindex();
  }

  /**
   * Handle remote notifications from other users
   */
  private async _handleRemoteNotification(notificationId: string): Promise<void> {
    try {
      const notificationDataStr = this._notificationsMap?.get(notificationId);
      if (notificationDataStr) {
        const notification: ICommentNotification = JSON.parse(notificationDataStr);
        this._notifications.set(notificationId, notification);
        this._notificationSignal.emit(notification);
      }
    } catch (error) {
      console.error('Error handling remote notification:', error);
    }
  }

  /**
   * Get current user from awareness
   */
  private _getCurrentUser(): ICollaborativeUser | null {
    const activeUsers = this._awareness.activeUsers;
    return activeUsers.length > 0 ? activeUsers[0] : null;
  }

  /**
   * Build IComment object from comment data
   */
  private async _buildCommentFromData(commentData: ICommentData): Promise<IComment> {
    const author = this._awareness.getUserById(commentData.authorId) || {
      userId: commentData.authorId,
      username: 'Unknown User',
      displayName: 'Unknown User',
      avatar: '',
      color: '#999999',
      cursorPosition: null,
      selectedCells: [],
      isActive: false,
      lastActivity: new Date(commentData.timestamp)
    };

    // Get replies
    const replies = await this._getReplies(commentData.id);

    const comment: IComment = {
      id: commentData.id,
      author,
      content: commentData.content,
      cellId: commentData.cellId,
      timestamp: new Date(commentData.timestamp),
      parentId: commentData.parentId,
      replies,
      isResolved: commentData.status === CommentStatus.RESOLVED,
      mentions: commentData.mentions
    };

    return comment;
  }

  /**
   * Get replies for a comment
   */
  private async _getReplies(commentId: string): Promise<IComment[]> {
    const replies: IComment[] = [];

    if (this._commentsMap) {
      this._commentsMap.forEach((commentDataStr, id) => {
        try {
          const commentData: ICommentData = JSON.parse(commentDataStr);
          if (commentData.parentId === commentId) {
            this._buildCommentFromData(commentData).then(reply => {
              replies.push(reply);
            }).catch(console.error);
          }
        } catch (error) {
          console.error('Error parsing comment data for replies:', error);
        }
      });
    }

    // Wait for all replies to be built
    await Promise.all(replies);

    return replies.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Get all comments from storage
   */
  private async _getAllComments(): Promise<IComment[]> {
    const comments: IComment[] = [];

    if (this._commentsMap) {
      const promises: Promise<IComment>[] = [];

      this._commentsMap.forEach((commentDataStr, commentId) => {
        try {
          const commentData: ICommentData = JSON.parse(commentDataStr);
          promises.push(this._buildCommentFromData(commentData));
        } catch (error) {
          console.error('Error parsing comment data:', error);
        }
      });

      const resolvedComments = await Promise.all(promises);
      comments.push(...resolvedComments);
    }

    return comments.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Process mentions in comment content
   */
  private _processMentions(mentions: string[], content: string): string[] {
    const processedMentions: string[] = [];

    // Extract mentions from content
    const mentionRegex = /@(\w+)/g;
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      const mentionedUser = match[1];
      if (!processedMentions.includes(mentionedUser)) {
        processedMentions.push(mentionedUser);
      }
    }

    // Add explicitly provided mentions
    mentions.forEach(mention => {
      if (!processedMentions.includes(mention)) {
        processedMentions.push(mention);
      }
    });

    return processedMentions;
  }

  /**
   * Strip markdown from content if markdown is disabled
   */
  private _stripMarkdown(content: string): string {
    return content
      .replace(/(\*\*|__)(.*?)\1/g, '$2') // Bold
      .replace(/(\*|_)(.*?)\1/g, '$2') // Italic
      .replace(/`([^`]+)`/g, '$1') // Inline code
      .replace(/^#+\s/gm, '') // Headers
      .replace(/^\s*[-*+]\s/gm, '') // Lists
      .replace(/^\s*\d+\.\s/gm, '') // Numbered lists
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // Links
  }

  /**
   * Check if user can modify a comment
   */
  private async _canModifyComment(comment: IComment, userId: string): Promise<boolean> {
    // User can modify their own comments
    if (comment.author.userId === userId) {
      return true;
    }

    // Admin users can modify any comment
    const userRole = await this._permissionManager.getUserRole(userId);
    return userRole === CollaborativeRole.ADMIN;
  }

  /**
   * Check if user can delete a comment
   */
  private async _canDeleteComment(comment: IComment, userId: string): Promise<boolean> {
    // Check moderation settings
    if (this._config.enableModeration) {
      const userRole = await this._permissionManager.getUserRole(userId);
      if (userRole !== CollaborativeRole.ADMIN) {
        return comment.author.userId === userId;
      }
    }

    return await this._canModifyComment(comment, userId);
  }

  /**
   * Get thread depth for a comment
   */
  private async _getThreadDepth(commentId: string): Promise<number> {
    let depth = 0;
    let currentId: string | null = commentId;

    while (currentId) {
      const comment = await this.getCommentById(currentId);
      if (!comment) break;

      currentId = comment.parentId;
      depth++;

      if (depth > this._config.maxThreadDepth) {
        break;
      }
    }

    return depth;
  }

  /**
   * Find the root comment of a thread
   */
  private async _findThreadRoot(comment: IComment): Promise<string> {
    let currentComment = comment;

    while (currentComment.parentId) {
      const parentComment = await this.getCommentById(currentComment.parentId);
      if (!parentComment) break;
      currentComment = parentComment;
    }

    return currentComment.id;
  }

  /**
   * Collect all comments in a tree (for deletion)
   */
  private async _collectCommentTree(rootId: string): Promise<IComment[]> {
    const comments: IComment[] = [];
    const rootComment = await this.getCommentById(rootId);

    if (rootComment) {
      comments.push(rootComment);

      // Recursively collect replies
      for (const reply of rootComment.replies) {
        const replyTree = await this._collectCommentTree(reply.id);
        comments.push(...replyTree);
      }
    }

    return comments;
  }

  /**
   * Handle notifications when a comment is created
   */
  private async _handleCommentCreatedNotifications(comment: IComment): Promise<void> {
    try {
      // Notify mentioned users
      for (const mentionedUserId of comment.mentions) {
        await this._createMentionNotification(comment, mentionedUserId);
      }

      // Notify participants in the thread if this is a reply
      if (comment.parentId) {
        const participants = await this._getThreadParticipants(comment.parentId);
        for (const participantId of participants) {
          if (participantId !== comment.author.userId) {
            await this._createReplyNotification(comment, participantId);
          }
        }
      }
    } catch (error) {
      console.error('Error handling comment created notifications:', error);
    }
  }

  /**
   * Handle notifications when comment status changes
   */
  private async _handleCommentStatusNotifications(comment: IComment, wasResolved: boolean): Promise<void> {
    try {
      if (comment.isResolved && !wasResolved) {
        // Comment was resolved
        const participants = await this._getThreadParticipants(comment.id);
        for (const participantId of participants) {
          if (participantId !== comment.author.userId) {
            await this._createResolutionNotification(comment, participantId);
          }
        }
      }
    } catch (error) {
      console.error('Error handling comment status notifications:', error);
    }
  }

  /**
   * Get all participants in a comment thread
   */
  private async _getThreadParticipants(commentId: string): Promise<string[]> {
    const participants = new Set<string>();
    const commentsInThread = await this._collectCommentTree(commentId);

    commentsInThread.forEach(comment => {
      participants.add(comment.author.userId);
    });

    return Array.from(participants);
  }

  /**
   * Create a mention notification
   */
  private async _createMentionNotification(comment: IComment, mentionedUserId: string): Promise<void> {
    const notification: ICommentNotification = {
      id: `mention_${UUID.uuid4()}`,
      comment,
      targetUserId: mentionedUserId,
      type: 'mention',
      timestamp: new Date(),
      isRead: false,
      metadata: {
        mentionedBy: comment.author.userId
      }
    };

    await this._storeNotification(notification);
  }

  /**
   * Create a reply notification
   */
  private async _createReplyNotification(comment: IComment, participantId: string): Promise<void> {
    const notification: ICommentNotification = {
      id: `reply_${UUID.uuid4()}`,
      comment,
      targetUserId: participantId,
      type: 'reply',
      timestamp: new Date(),
      isRead: false,
      metadata: {
        repliedBy: comment.author.userId,
        parentId: comment.parentId
      }
    };

    await this._storeNotification(notification);
  }

  /**
   * Create a resolution notification
   */
  private async _createResolutionNotification(comment: IComment, participantId: string): Promise<void> {
    const notification: ICommentNotification = {
      id: `resolution_${UUID.uuid4()}`,
      comment,
      targetUserId: participantId,
      type: 'resolution',
      timestamp: new Date(),
      isRead: false,
      metadata: {
        resolvedBy: comment.author.userId
      }
    };

    await this._storeNotification(notification);
  }

  /**
   * Store notification in local cache and Yjs
   */
  private async _storeNotification(notification: ICommentNotification): Promise<void> {
    this._notifications.set(notification.id, notification);

    if (this._notificationsMap && this._provider.isConnected()) {
      this._notificationsMap.set(notification.id, JSON.stringify(notification));
    }

    this._notificationSignal.emit(notification);
  }

  /**
   * Clear notifications for a deleted comment
   */
  private async _clearNotificationsForComment(commentId: string): Promise<void> {
    const toDelete: string[] = [];

    this._notifications.forEach((notification, notificationId) => {
      if (notification.comment.id === commentId) {
        toDelete.push(notificationId);
      }
    });

    toDelete.forEach(notificationId => {
      this._notifications.delete(notificationId);
      if (this._notificationsMap && this._provider.isConnected()) {
        this._notificationsMap.delete(notificationId);
      }
    });
  }

  /**
   * Rebuild search index for comments
   */
  private _rebuildSearchIndex(): void {
    this._searchIndex.clear();

    if (this._commentsMap) {
      this._commentsMap.forEach((commentDataStr, commentId) => {
        try {
          const commentData: ICommentData = JSON.parse(commentDataStr);
          const searchTerms = commentData.content
            .toLowerCase()
            .split(/\W+/)
            .filter(term => term.length > 2);

          this._searchIndex.set(commentId, searchTerms);
        } catch (error) {
          console.error('Error rebuilding search index:', error);
        }
      });
    }
  }

  /**
   * Export comments to Markdown format
   */
  private _exportToMarkdown(
    comments: IComment[],
    includeThreading: boolean,
    includeUserInfo: boolean
  ): string {
    let markdown = '# Comments Export\n\n';

    if (includeThreading) {
      // Group by threads
      const threads = _.groupBy(comments, (comment: IComment) =>
        comment.parentId ? this._findThreadRoot(comment) : comment.id
      );

      Object.values(threads).forEach((threadComments: IComment[]) => {
        const sortedComments = _.sortBy(threadComments, 'timestamp');
        sortedComments.forEach((comment: IComment, index: number) => {
          const indent = comment.parentId ? '  ' : '';
          const userInfo = includeUserInfo ? ` - ${comment.author.displayName}` : '';
          const timestamp = comment.timestamp.toISOString();

          markdown += `${indent}## Comment ${index + 1}${userInfo}\n`;
          markdown += `${indent}*${timestamp}*\n\n`;
          markdown += `${indent}${comment.content}\n\n`;

          if (comment.mentions.length > 0) {
            markdown += `${indent}**Mentions:** ${comment.mentions.join(', ')}\n\n`;
          }
        });
        markdown += '---\n\n';
      });
    } else {
      // Simple chronological list
      comments.forEach((comment: IComment, index: number) => {
        const userInfo = includeUserInfo ? ` - ${comment.author.displayName}` : '';
        const timestamp = comment.timestamp.toISOString();

        markdown += `## Comment ${index + 1}${userInfo}\n`;
        markdown += `*${timestamp}*\n\n`;
        markdown += `${comment.content}\n\n`;

        if (comment.mentions.length > 0) {
          markdown += `**Mentions:** ${comment.mentions.join(', ')}\n\n`;
        }
        markdown += '---\n\n';
      });
    }

    return markdown;
  }

  /**
   * Export comments to JSON format
   */
  private _exportToJson(comments: IComment[], includeUserInfo: boolean): string {
    const exportData = comments.map(comment => ({
      id: comment.id,
      content: comment.content,
      cellId: comment.cellId,
      timestamp: comment.timestamp.toISOString(),
      parentId: comment.parentId,
      isResolved: comment.isResolved,
      mentions: comment.mentions,
      author: includeUserInfo ? comment.author : { userId: comment.author.userId }
    }));

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Export comments to HTML format
   */
  private _exportToHtml(
    comments: IComment[],
    includeThreading: boolean,
    includeUserInfo: boolean
  ): string {
    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Comments Export</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          .comment { border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .comment-header { color: #666; font-size: 0.9em; margin-bottom: 10px; }
          .comment-content { line-height: 1.6; }
          .mentions { color: #007acc; font-size: 0.9em; margin-top: 10px; }
          .reply { margin-left: 30px; }
          .resolved { opacity: 0.7; border-left: 4px solid #28a745; }
        </style>
      </head>
      <body>
        <h1>Comments Export</h1>
    `;

    comments.forEach(comment => {
      const userInfo = includeUserInfo ? comment.author.displayName : 'User';
      const timestamp = comment.timestamp.toLocaleString();
      const resolvedClass = comment.isResolved ? ' resolved' : '';
      const replyClass = comment.parentId ? ' reply' : '';

      // Convert markdown to HTML if enabled
      const content = this._config.enableMarkdown ?
        marked(comment.content) :
        comment.content.replace(/\n/g, '<br>');

      html += `
        <div class="comment${resolvedClass}${replyClass}">
          <div class="comment-header">
            <strong>${userInfo}</strong> - ${timestamp}
            ${comment.isResolved ? ' <span style="color: #28a745;">[RESOLVED]</span>' : ''}
          </div>
          <div class="comment-content">${content}</div>
          ${comment.mentions.length > 0 ?
            `<div class="mentions"><strong>Mentions:</strong> ${comment.mentions.join(', ')}</div>` :
            ''
          }
        </div>
      `;
    });

    html += `
      </body>
      </html>
    `;

    return html;
  }

  /**
   * Export comments to CSV format
   */
  private _exportToCsv(comments: IComment[], includeUserInfo: boolean): string {
    const headers = [
      'ID',
      'Content',
      'Cell ID',
      'Timestamp',
      'Parent ID',
      'Is Resolved',
      'Mentions'
    ];

    if (includeUserInfo) {
      headers.push('Author ID', 'Author Name');
    }

    const rows = [headers];

    comments.forEach(comment => {
      const row = [
        comment.id,
        `"${comment.content.replace(/"/g, '""')}"`, // Escape quotes
        comment.cellId,
        comment.timestamp.toISOString(),
        comment.parentId || '',
        comment.isResolved.toString(),
        comment.mentions.join(';')
      ];

      if (includeUserInfo) {
        row.push(comment.author.userId, `"${comment.author.displayName.replace(/"/g, '""')}"`);
      }

      rows.push(row);
    });

    return rows.map(row => row.join(',')).join('\n');
  }
}
