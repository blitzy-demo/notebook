/**
 * @fileoverview In-notebook comment and review system that enables collaborative annotation 
 * with threaded discussions, real-time synchronization, and comprehensive notification workflows.
 * This module provides comment threading, resolution workflows, and integration with the 
 * collaborative editing infrastructure.
 * 
 * Key Features:
 * - MongoDB-backed persistent storage for threaded discussions
 * - Real-time comment synchronization via WebSocket broadcasting
 * - Precise cell and line-level comment anchoring
 * - Threaded discussion support with nested replies
 * - Comment resolution workflows and status management
 * - Full-text search and filtering capabilities
 * - Configurable notification policies
 * - Comment export/import for workflow integration
 * 
 * @author Jupyter Notebook Collaboration Team
 * @version 7.5.0-alpha.0
 * @since 2024-06-06
 */

import { IDisposable, DisposableDelegate } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';
import { PartialJSONObject, JSONValue, UUID } from '@lumino/coreutils';
import { IObservableMap, ObservableMap } from '@jupyterlab/observables';
import { INotebookModel } from '@jupyterlab/notebook';
import { ICollaborationProvider } from './YjsNotebookProvider';
import { IAwarenessProvider } from './awareness';

/**
 * Namespace for comment system types and interfaces
 */
export namespace ICommentSystem {
  /**
   * Comment status enumeration for workflow management
   */
  export enum CommentStatus {
    OPEN = 'open',
    RESOLVED = 'resolved',
    ARCHIVED = 'archived',
    PENDING = 'pending'
  }

  /**
   * Comment priority levels for notification routing
   */
  export enum CommentPriority {
    LOW = 'low',
    NORMAL = 'normal',
    HIGH = 'high',
    URGENT = 'urgent'
  }

  /**
   * Comment anchor types for precise positioning
   */
  export enum AnchorType {
    CELL = 'cell',
    LINE = 'line',
    RANGE = 'range',
    OUTPUT = 'output'
  }

  /**
   * Position interface for comment anchoring
   */
  export interface ICommentAnchor {
    /** Type of anchor (cell, line, range, output) */
    type: AnchorType;
    /** Target cell ID for the comment */
    cellId: string;
    /** Line number (for line/range anchors) */
    lineNumber?: number;
    /** Character start position (for range anchors) */
    startChar?: number;
    /** Character end position (for range anchors) */
    endChar?: number;
    /** Output index (for output anchors) */
    outputIndex?: number;
    /** Selected text content for context */
    selectedText?: string;
  }

  /**
   * Core comment data structure
   */
  export interface IComment {
    /** Unique comment identifier */
    id: string;
    /** Parent comment ID for threading */
    parentId?: string;
    /** Notebook document ID */
    notebookId: string;
    /** Author user information */
    author: {
      id: string;
      name: string;
      avatar?: string;
      email?: string;
    };
    /** Comment content in Markdown format */
    content: string;
    /** Comment position and anchoring */
    anchor: ICommentAnchor;
    /** Comment status and workflow state */
    status: CommentStatus;
    /** Priority level for notifications */
    priority: CommentPriority;
    /** Creation timestamp */
    createdAt: Date;
    /** Last modified timestamp */
    updatedAt: Date;
    /** Resolved timestamp and resolver */
    resolvedAt?: Date;
    resolvedBy?: string;
    /** Comment tags for categorization */
    tags: string[];
    /** Thread-level metadata */
    threadMetadata: {
      replyCount: number;
      participantIds: string[];
      lastActivity: Date;
    };
    /** Collaboration metadata */
    collaborationMetadata: {
      documentVersion: number;
      syncTimestamp: Date;
      conflictResolved?: boolean;
    };
  }

  /**
   * Comment thread aggregation interface
   */
  export interface ICommentThread {
    /** Root comment of the thread */
    rootComment: IComment;
    /** All replies in chronological order */
    replies: IComment[];
    /** Thread statistics */
    stats: {
      totalComments: number;
      uniqueParticipants: number;
      lastActivity: Date;
      averageResponseTime?: number;
    };
    /** Thread status derived from comments */
    threadStatus: CommentStatus;
  }

  /**
   * Comment notification configuration
   */
  export interface INotificationConfig {
    /** Enable real-time notifications */
    enableRealTime: boolean;
    /** Email notification settings */
    email: {
      enabled: boolean;
      frequency: 'immediate' | 'hourly' | 'daily';
      includeContent: boolean;
    };
    /** In-app notification preferences */
    inApp: {
      enabled: boolean;
      soundEnabled: boolean;
      persistentNotifications: boolean;
    };
    /** Notification filters */
    filters: {
      priorities: CommentPriority[];
      mentionsOnly: boolean;
      ownCommentsOnly: boolean;
      excludeResolved: boolean;
    };
  }

  /**
   * Search and filtering interface
   */
  export interface ICommentSearchOptions {
    /** Full-text search query */
    query?: string;
    /** Filter by author */
    authorId?: string;
    /** Filter by status */
    status?: CommentStatus[];
    /** Filter by priority */
    priority?: CommentPriority[];
    /** Filter by tags */
    tags?: string[];
    /** Date range filtering */
    dateRange?: {
      start: Date;
      end: Date;
    };
    /** Cell-specific filtering */
    cellId?: string;
    /** Sort options */
    sortBy?: 'createdAt' | 'updatedAt' | 'priority' | 'author';
    sortOrder?: 'asc' | 'desc';
    /** Pagination */
    limit?: number;
    offset?: number;
  }

  /**
   * Comment export format options
   */
  export interface IExportOptions {
    /** Export format */
    format: 'json' | 'markdown' | 'html' | 'csv';
    /** Include resolved comments */
    includeResolved: boolean;
    /** Include thread metadata */
    includeMetadata: boolean;
    /** Filter options */
    filters?: ICommentSearchOptions;
    /** Export template for formatting */
    template?: string;
  }

  /**
   * Comment import validation result
   */
  export interface IImportResult {
    /** Successfully imported comments */
    successful: IComment[];
    /** Failed imports with errors */
    failed: Array<{
      data: PartialJSONObject;
      error: string;
    }>;
    /** Import statistics */
    stats: {
      totalProcessed: number;
      successCount: number;
      failureCount: number;
      duplicatesSkipped: number;
    };
  }

  /**
   * Comment change event data
   */
  export interface ICommentChangeEvent {
    /** Type of change */
    type: 'created' | 'updated' | 'deleted' | 'resolved' | 'archived';
    /** Affected comment */
    comment: IComment;
    /** Previous state (for updates) */
    previousState?: Partial<IComment>;
    /** Change author */
    changedBy: string;
    /** Change timestamp */
    timestamp: Date;
  }

  /**
   * Real-time sync event interface
   */
  export interface ISyncEvent {
    /** Event type */
    type: 'comment_added' | 'comment_updated' | 'comment_removed' | 'thread_resolved';
    /** Affected notebook ID */
    notebookId: string;
    /** Comment data */
    data: IComment | Partial<IComment>;
    /** Source user */
    userId: string;
    /** Sync timestamp */
    timestamp: Date;
    /** Conflict resolution data */
    conflictData?: {
      resolved: boolean;
      strategy: string;
      previousVersion?: PartialJSONObject;
    };
  }
}

/**
 * MongoDB-backed comment storage provider interface
 */
export interface ICommentStorageProvider {
  /**
   * Store a comment in persistent storage
   */
  storeComment(comment: ICommentSystem.IComment): Promise<void>;

  /**
   * Retrieve comments with filtering and pagination
   */
  getComments(
    notebookId: string, 
    options?: ICommentSystem.ICommentSearchOptions
  ): Promise<ICommentSystem.IComment[]>;

  /**
   * Update an existing comment
   */
  updateComment(
    commentId: string, 
    updates: Partial<ICommentSystem.IComment>
  ): Promise<ICommentSystem.IComment>;

  /**
   * Delete a comment and its replies
   */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Search comments with full-text indexing
   */
  searchComments(
    notebookId: string,
    query: string,
    options?: ICommentSystem.ICommentSearchOptions
  ): Promise<ICommentSystem.IComment[]>;

  /**
   * Get comment thread by root comment ID
   */
  getCommentThread(rootCommentId: string): Promise<ICommentSystem.ICommentThread>;

  /**
   * Bulk operations for import/export
   */
  bulkInsert(comments: ICommentSystem.IComment[]): Promise<ICommentSystem.IImportResult>;
  bulkExport(
    notebookId: string, 
    options: ICommentSystem.IExportOptions
  ): Promise<JSONValue>;
}

/**
 * WebSocket-based real-time synchronization provider
 */
export interface ICommentSyncProvider {
  /**
   * Broadcast comment changes to all participants
   */
  broadcastChange(event: ICommentSystem.ISyncEvent): Promise<void>;

  /**
   * Subscribe to comment changes
   */
  onCommentChange: ISignal<this, ICommentSystem.ISyncEvent>;

  /**
   * Handle incoming sync events
   */
  handleSyncEvent(event: ICommentSystem.ISyncEvent): Promise<void>;

  /**
   * Get current sync status
   */
  getSyncStatus(): {
    connected: boolean;
    lastSync: Date;
    pendingEvents: number;
  };
}

/**
 * Core comment system implementation providing comprehensive collaborative annotation
 * capabilities with MongoDB persistence and real-time synchronization
 */
export class CommentSystem implements IDisposable {
  private _isDisposed = false;
  private _notebookId: string;
  private _comments = new ObservableMap<ICommentSystem.IComment>();
  private _threads = new Map<string, ICommentSystem.ICommentThread>();
  private _notificationConfig: ICommentSystem.INotificationConfig;
  private _storageProvider: ICommentStorageProvider;
  private _syncProvider: ICommentSyncProvider;
  private _collaborationProvider: ICollaborationProvider;
  private _awarenessProvider: IAwarenessProvider;

  // Signals for event handling
  private _commentAdded = new Signal<this, ICommentSystem.IComment>(this);
  private _commentUpdated = new Signal<this, ICommentSystem.ICommentChangeEvent>(this);
  private _commentDeleted = new Signal<this, string>(this);
  private _threadResolved = new Signal<this, ICommentSystem.ICommentThread>(this);
  private _syncStatusChanged = new Signal<this, boolean>(this);

  constructor(options: {
    notebookId: string;
    storageProvider: ICommentStorageProvider;
    syncProvider: ICommentSyncProvider;
    collaborationProvider: ICollaborationProvider;
    awarenessProvider: IAwarenessProvider;
    notificationConfig?: ICommentSystem.INotificationConfig;
  }) {
    this._notebookId = options.notebookId;
    this._storageProvider = options.storageProvider;
    this._syncProvider = options.syncProvider;
    this._collaborationProvider = options.collaborationProvider;
    this._awarenessProvider = options.awarenessProvider;
    
    // Default notification configuration
    this._notificationConfig = options.notificationConfig || {
      enableRealTime: true,
      email: {
        enabled: false,
        frequency: 'immediate',
        includeContent: true
      },
      inApp: {
        enabled: true,
        soundEnabled: true,
        persistentNotifications: false
      },
      filters: {
        priorities: [
          ICommentSystem.CommentPriority.NORMAL, 
          ICommentSystem.CommentPriority.HIGH, 
          ICommentSystem.CommentPriority.URGENT
        ],
        mentionsOnly: false,
        ownCommentsOnly: false,
        excludeResolved: true
      }
    };

    // Initialize real-time synchronization
    this._initializeSync();
    
    // Load existing comments
    this._loadComments();
  }

  /**
   * Initialize real-time synchronization with WebSocket provider
   */
  private async _initializeSync(): Promise<void> {
    try {
      // Connect to sync provider and listen for changes
      this._syncProvider.onCommentChange.connect(this._handleRemoteChange, this);
      
      // Monitor collaboration provider for document changes
      this._collaborationProvider.onDocumentChange?.connect(this._handleDocumentChange, this);
      
      // Track user awareness for comment attribution
      this._awarenessProvider.onUserPresenceChanged?.connect(this._handlePresenceChange, this);
      
      this._syncStatusChanged.emit(true);
    } catch (error) {
      console.error('Failed to initialize comment sync:', error);
      this._syncStatusChanged.emit(false);
    }
  }

  /**
   * Load existing comments from storage provider
   */
  private async _loadComments(): Promise<void> {
    try {
      const comments = await this._storageProvider.getComments(this._notebookId);
      
      // Build comment map and thread structure
      this._comments.clear();
      this._threads.clear();
      
      for (const comment of comments) {
        this._comments.set(comment.id, comment);
        this._buildThreadStructure(comment);
      }
    } catch (error) {
      console.error('Failed to load comments:', error);
    }
  }

  /**
   * Build thread structure from individual comments
   */
  private _buildThreadStructure(comment: ICommentSystem.IComment): void {
    if (!comment.parentId) {
      // Root comment - create new thread
      const thread: ICommentSystem.ICommentThread = {
        rootComment: comment,
        replies: [],
        stats: {
          totalComments: 1,
          uniqueParticipants: 1,
          lastActivity: comment.updatedAt
        },
        threadStatus: comment.status
      };
      this._threads.set(comment.id, thread);
    } else {
      // Reply comment - add to existing thread
      const rootCommentId = this._findRootComment(comment);
      const thread = this._threads.get(rootCommentId);
      
      if (thread) {
        thread.replies.push(comment);
        thread.stats.totalComments++;
        
        // Update unique participants
        const participantIds = new Set([
          thread.rootComment.author.id,
          ...thread.replies.map(r => r.author.id)
        ]);
        thread.stats.uniqueParticipants = participantIds.size;
        
        // Update last activity
        if (comment.updatedAt > thread.stats.lastActivity) {
          thread.stats.lastActivity = comment.updatedAt;
        }
        
        // Update thread status (resolved if all comments resolved)
        const allResolved = [thread.rootComment, ...thread.replies]
          .every(c => c.status === ICommentSystem.CommentStatus.RESOLVED);
        thread.threadStatus = allResolved 
          ? ICommentSystem.CommentStatus.RESOLVED 
          : ICommentSystem.CommentStatus.OPEN;
      }
    }
  }

  /**
   * Find root comment ID for a reply
   */
  private _findRootComment(comment: ICommentSystem.IComment): string {
    let current = comment;
    while (current.parentId) {
      const parent = this._comments.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  /**
   * Handle remote comment changes from WebSocket
   */
  private async _handleRemoteChange(
    sender: ICommentSyncProvider,
    event: ICommentSystem.ISyncEvent
  ): Promise<void> {
    try {
      switch (event.type) {
        case 'comment_added':
          await this._handleRemoteCommentAdded(event.data as ICommentSystem.IComment);
          break;
        case 'comment_updated':
          await this._handleRemoteCommentUpdated(event.data as ICommentSystem.IComment);
          break;
        case 'comment_removed':
          await this._handleRemoteCommentDeleted(event.data as ICommentSystem.IComment);
          break;
        case 'thread_resolved':
          await this._handleRemoteThreadResolved(event.data as ICommentSystem.IComment);
          break;
      }
    } catch (error) {
      console.error('Failed to handle remote comment change:', error);
    }
  }

  /**
   * Handle remote comment addition
   */
  private async _handleRemoteCommentAdded(comment: ICommentSystem.IComment): Promise<void> {
    if (!this._comments.has(comment.id)) {
      this._comments.set(comment.id, comment);
      this._buildThreadStructure(comment);
      this._commentAdded.emit(comment);
      
      // Process notifications if enabled
      if (this._shouldNotify(comment)) {
        await this._processNotification(comment, 'added');
      }
    }
  }

  /**
   * Handle remote comment update
   */
  private async _handleRemoteCommentUpdated(updatedComment: ICommentSystem.IComment): Promise<void> {
    const existing = this._comments.get(updatedComment.id);
    if (existing) {
      const changeEvent: ICommentSystem.ICommentChangeEvent = {
        type: 'updated',
        comment: updatedComment,
        previousState: { ...existing },
        changedBy: updatedComment.author.id,
        timestamp: updatedComment.updatedAt
      };
      
      this._comments.set(updatedComment.id, updatedComment);
      this._buildThreadStructure(updatedComment);
      this._commentUpdated.emit(changeEvent);
      
      if (this._shouldNotify(updatedComment)) {
        await this._processNotification(updatedComment, 'updated');
      }
    }
  }

  /**
   * Handle remote comment deletion
   */
  private async _handleRemoteCommentDeleted(deletedComment: ICommentSystem.IComment): Promise<void> {
    if (this._comments.has(deletedComment.id)) {
      this._comments.delete(deletedComment.id);
      
      // Remove from thread structure
      const rootCommentId = this._findRootComment(deletedComment);
      const thread = this._threads.get(rootCommentId);
      if (thread) {
        if (thread.rootComment.id === deletedComment.id) {
          // Deleting root comment - remove entire thread
          this._threads.delete(rootCommentId);
        } else {
          // Deleting reply - remove from replies array
          thread.replies = thread.replies.filter(r => r.id !== deletedComment.id);
          thread.stats.totalComments--;
        }
      }
      
      this._commentDeleted.emit(deletedComment.id);
    }
  }

  /**
   * Handle remote thread resolution
   */
  private async _handleRemoteThreadResolved(comment: ICommentSystem.IComment): Promise<void> {
    const rootCommentId = this._findRootComment(comment);
    const thread = this._threads.get(rootCommentId);
    
    if (thread) {
      thread.threadStatus = ICommentSystem.CommentStatus.RESOLVED;
      this._threadResolved.emit(thread);
    }
  }

  /**
   * Handle document changes that might affect comment anchors
   */
  private async _handleDocumentChange(
    sender: ICollaborationProvider,
    change: any
  ): Promise<void> {
    // Update comment anchors if cells are moved, deleted, or modified
    // This is critical for maintaining comment positioning accuracy
    
    if (change.type === 'cell_deleted') {
      await this._handleCellDeleted(change.cellId);
    } else if (change.type === 'cell_moved') {
      await this._handleCellMoved(change.oldIndex, change.newIndex);
    }
  }

  /**
   * Handle cell deletion - update or remove affected comments
   */
  private async _handleCellDeleted(deletedCellId: string): Promise<void> {
    const affectedComments = Array.from(this._comments.values())
      .filter(comment => comment.anchor.cellId === deletedCellId);
    
    for (const comment of affectedComments) {
      // Mark comment as archived due to cell deletion
      const updatedComment = {
        ...comment,
        status: ICommentSystem.CommentStatus.ARCHIVED,
        updatedAt: new Date()
      };
      
      await this.updateComment(comment.id, updatedComment);
    }
  }

  /**
   * Handle cell movement - update comment anchors
   */
  private async _handleCellMoved(oldIndex: number, newIndex: number): Promise<void> {
    // Cell movement typically doesn't require anchor updates since we use cell IDs
    // But we could implement additional logic here for index-based positioning
  }

  /**
   * Handle user presence changes for comment attribution
   */
  private _handlePresenceChange(
    sender: IAwarenessProvider,
    presence: any
  ): void {
    // Update comment author presence indicators
    // This helps show which comment authors are currently active
  }

  /**
   * Determine if a comment should trigger notifications
   */
  private _shouldNotify(comment: ICommentSystem.IComment): boolean {
    const config = this._notificationConfig;
    
    // Check if notifications are enabled
    if (!config.enableRealTime && !config.inApp.enabled) {
      return false;
    }
    
    // Apply filters
    if (config.filters.excludeResolved && 
        comment.status === ICommentSystem.CommentStatus.RESOLVED) {
      return false;
    }
    
    if (config.filters.priorities.length > 0 && 
        !config.filters.priorities.includes(comment.priority)) {
      return false;
    }
    
    // Additional filter logic can be added here
    
    return true;
  }

  /**
   * Process notification for comment changes
   */
  private async _processNotification(
    comment: ICommentSystem.IComment,
    action: 'added' | 'updated' | 'resolved'
  ): Promise<void> {
    // Implement notification logic here
    // This could include:
    // - In-app notification display
    // - Email notification queuing
    // - Push notification triggering
    // - Integration with external notification services
    
    console.log(`Processing notification: ${action} comment`, comment);
  }

  // Public API methods

  /**
   * Add a new comment to the notebook
   */
  async addComment(
    content: string,
    anchor: ICommentSystem.ICommentAnchor,
    options: {
      priority?: ICommentSystem.CommentPriority;
      tags?: string[];
      parentId?: string;
    } = {}
  ): Promise<ICommentSystem.IComment> {
    // Get current user from awareness provider
    const currentUser = this._awarenessProvider.getCurrentUser();
    
    const comment: ICommentSystem.IComment = {
      id: UUID.uuid4(),
      parentId: options.parentId,
      notebookId: this._notebookId,
      author: {
        id: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar,
        email: currentUser.email
      },
      content,
      anchor,
      status: ICommentSystem.CommentStatus.OPEN,
      priority: options.priority || ICommentSystem.CommentPriority.NORMAL,
      createdAt: new Date(),
      updatedAt: new Date(),
      tags: options.tags || [],
      threadMetadata: {
        replyCount: 0,
        participantIds: [currentUser.id],
        lastActivity: new Date()
      },
      collaborationMetadata: {
        documentVersion: this._collaborationProvider.getDocumentVersion(),
        syncTimestamp: new Date(),
        conflictResolved: false
      }
    };
    
    // Store in persistent storage
    await this._storageProvider.storeComment(comment);
    
    // Update local state
    this._comments.set(comment.id, comment);
    this._buildThreadStructure(comment);
    
    // Broadcast to other users
    const syncEvent: ICommentSystem.ISyncEvent = {
      type: 'comment_added',
      notebookId: this._notebookId,
      data: comment,
      userId: currentUser.id,
      timestamp: new Date()
    };
    await this._syncProvider.broadcastChange(syncEvent);
    
    // Emit local event
    this._commentAdded.emit(comment);
    
    return comment;
  }

  /**
   * Update an existing comment
   */
  async updateComment(
    commentId: string,
    updates: Partial<ICommentSystem.IComment>
  ): Promise<ICommentSystem.IComment> {
    const existing = this._comments.get(commentId);
    if (!existing) {
      throw new Error(`Comment ${commentId} not found`);
    }
    
    const updatedComment = {
      ...existing,
      ...updates,
      updatedAt: new Date()
    };
    
    // Store in persistent storage
    const stored = await this._storageProvider.updateComment(commentId, updatedComment);
    
    // Update local state
    this._comments.set(commentId, stored);
    this._buildThreadStructure(stored);
    
    // Broadcast to other users
    const syncEvent: ICommentSystem.ISyncEvent = {
      type: 'comment_updated',
      notebookId: this._notebookId,
      data: stored,
      userId: this._awarenessProvider.getCurrentUser().id,
      timestamp: new Date()
    };
    await this._syncProvider.broadcastChange(syncEvent);
    
    // Emit local event
    const changeEvent: ICommentSystem.ICommentChangeEvent = {
      type: 'updated',
      comment: stored,
      previousState: existing,
      changedBy: this._awarenessProvider.getCurrentUser().id,
      timestamp: new Date()
    };
    this._commentUpdated.emit(changeEvent);
    
    return stored;
  }

  /**
   * Delete a comment and all its replies
   */
  async deleteComment(commentId: string): Promise<void> {
    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found`);
    }
    
    // Delete from persistent storage (cascades to replies)
    await this._storageProvider.deleteComment(commentId);
    
    // Remove from local state
    this._comments.delete(commentId);
    
    // Remove from thread structure
    const rootCommentId = this._findRootComment(comment);
    const thread = this._threads.get(rootCommentId);
    if (thread) {
      if (thread.rootComment.id === commentId) {
        this._threads.delete(rootCommentId);
      } else {
        thread.replies = thread.replies.filter(r => r.id !== commentId);
        thread.stats.totalComments--;
      }
    }
    
    // Broadcast to other users
    const syncEvent: ICommentSystem.ISyncEvent = {
      type: 'comment_removed',
      notebookId: this._notebookId,
      data: comment,
      userId: this._awarenessProvider.getCurrentUser().id,
      timestamp: new Date()
    };
    await this._syncProvider.broadcastChange(syncEvent);
    
    // Emit local event
    this._commentDeleted.emit(commentId);
  }

  /**
   * Resolve a comment thread
   */
  async resolveThread(rootCommentId: string): Promise<void> {
    const thread = this._threads.get(rootCommentId);
    if (!thread) {
      throw new Error(`Thread ${rootCommentId} not found`);
    }
    
    const currentUser = this._awarenessProvider.getCurrentUser();
    const resolvedAt = new Date();
    
    // Resolve root comment and all replies
    const commentsToResolve = [thread.rootComment, ...thread.replies];
    
    for (const comment of commentsToResolve) {
      await this.updateComment(comment.id, {
        status: ICommentSystem.CommentStatus.RESOLVED,
        resolvedAt,
        resolvedBy: currentUser.id
      });
    }
    
    // Update thread status
    thread.threadStatus = ICommentSystem.CommentStatus.RESOLVED;
    
    // Broadcast thread resolution
    const syncEvent: ICommentSystem.ISyncEvent = {
      type: 'thread_resolved',
      notebookId: this._notebookId,
      data: thread.rootComment,
      userId: currentUser.id,
      timestamp: resolvedAt
    };
    await this._syncProvider.broadcastChange(syncEvent);
    
    // Emit local event
    this._threadResolved.emit(thread);
  }

  /**
   * Search comments with full-text indexing
   */
  async searchComments(
    query: string,
    options?: ICommentSystem.ICommentSearchOptions
  ): Promise<ICommentSystem.IComment[]> {
    return this._storageProvider.searchComments(this._notebookId, query, options);
  }

  /**
   * Get all comments for the notebook
   */
  async getComments(
    options?: ICommentSystem.ICommentSearchOptions
  ): Promise<ICommentSystem.IComment[]> {
    return this._storageProvider.getComments(this._notebookId, options);
  }

  /**
   * Get a specific comment thread
   */
  async getCommentThread(rootCommentId: string): Promise<ICommentSystem.ICommentThread | null> {
    return this._threads.get(rootCommentId) || null;
  }

  /**
   * Get all comment threads
   */
  getCommentThreads(): ICommentSystem.ICommentThread[] {
    return Array.from(this._threads.values());
  }

  /**
   * Export comments in specified format
   */
  async exportComments(
    options: ICommentSystem.IExportOptions
  ): Promise<JSONValue> {
    return this._storageProvider.bulkExport(this._notebookId, options);
  }

  /**
   * Import comments from external data
   */
  async importComments(
    comments: ICommentSystem.IComment[]
  ): Promise<ICommentSystem.IImportResult> {
    const result = await this._storageProvider.bulkInsert(comments);
    
    // Update local state with successfully imported comments
    for (const comment of result.successful) {
      this._comments.set(comment.id, comment);
      this._buildThreadStructure(comment);
    }
    
    return result;
  }

  /**
   * Update notification configuration
   */
  updateNotificationConfig(
    config: Partial<ICommentSystem.INotificationConfig>
  ): void {
    this._notificationConfig = {
      ...this._notificationConfig,
      ...config
    };
  }

  /**
   * Get current notification configuration
   */
  getNotificationConfig(): ICommentSystem.INotificationConfig {
    return { ...this._notificationConfig };
  }

  /**
   * Get sync status
   */
  getSyncStatus(): {
    connected: boolean;
    lastSync: Date;
    pendingEvents: number;
    commentsCount: number;
    threadsCount: number;
  } {
    const syncStatus = this._syncProvider.getSyncStatus();
    
    return {
      ...syncStatus,
      commentsCount: this._comments.size,
      threadsCount: this._threads.size
    };
  }

  // Event signals for external subscribers

  /**
   * Signal emitted when a comment is added
   */
  get commentAdded(): ISignal<this, ICommentSystem.IComment> {
    return this._commentAdded;
  }

  /**
   * Signal emitted when a comment is updated
   */
  get commentUpdated(): ISignal<this, ICommentSystem.ICommentChangeEvent> {
    return this._commentUpdated;
  }

  /**
   * Signal emitted when a comment is deleted
   */
  get commentDeleted(): ISignal<this, string> {
    return this._commentDeleted;
  }

  /**
   * Signal emitted when a thread is resolved
   */
  get threadResolved(): ISignal<this, ICommentSystem.ICommentThread> {
    return this._threadResolved;
  }

  /**
   * Signal emitted when sync status changes
   */
  get syncStatusChanged(): ISignal<this, boolean> {
    return this._syncStatusChanged;
  }

  /**
   * Clean up resources and dispose of the comment system
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    // Disconnect from providers
    this._syncProvider.onCommentChange.disconnect(this._handleRemoteChange, this);
    this._collaborationProvider.onDocumentChange?.disconnect(this._handleDocumentChange, this);
    this._awarenessProvider.onUserPresenceChanged?.disconnect(this._handlePresenceChange, this);
    
    // Clear data structures
    this._comments.dispose();
    this._threads.clear();
    
    // Dispose signals
    Signal.disconnectAll(this);
    
    this._isDisposed = true;
  }

  /**
   * Test if the comment system is disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }
}

/**
 * MongoDB-based comment storage implementation
 * Provides persistent storage with full-text search capabilities
 */
export class MongoCommentStorageProvider implements ICommentStorageProvider {
  private _mongoClient: any; // MongoDB client instance
  private _database: string;
  private _collection: string;

  constructor(options: {
    mongoClient: any;
    database: string;
    collection?: string;
  }) {
    this._mongoClient = options.mongoClient;
    this._database = options.database;
    this._collection = options.collection || 'comments';
  }

  async storeComment(comment: ICommentSystem.IComment): Promise<void> {
    const db = this._mongoClient.db(this._database);
    const collection = db.collection(this._collection);
    
    await collection.insertOne({
      ...comment,
      _id: comment.id // Use comment ID as MongoDB _id
    });
  }

  async getComments(
    notebookId: string,
    options?: ICommentSystem.ICommentSearchOptions
  ): Promise<ICommentSystem.IComment[]> {
    const db = this._mongoClient.db(this._database);
    const collection = db.collection(this._collection);
    
    // Build query
    const query: any = { notebookId };
    
    if (options?.status) {
      query.status = { $in: options.status };
    }
    
    if (options?.authorId) {
      query['author.id'] = options.authorId;
    }
    
    if (options?.priority) {
      query.priority = { $in: options.priority };
    }
    
    if (options?.tags && options.tags.length > 0) {
      query.tags = { $in: options.tags };
    }
    
    if (options?.cellId) {
      query['anchor.cellId'] = options.cellId;
    }
    
    if (options?.dateRange) {
      query.createdAt = {
        $gte: options.dateRange.start,
        $lte: options.dateRange.end
      };
    }
    
    // Build sort
    const sort: any = {};
    if (options?.sortBy) {
      sort[options.sortBy] = options.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1; // Default to newest first
    }
    
    // Execute query with pagination
    const cursor = collection
      .find(query)
      .sort(sort);
    
    if (options?.limit) {
      cursor.limit(options.limit);
    }
    
    if (options?.offset) {
      cursor.skip(options.offset);
    }
    
    const documents = await cursor.toArray();
    
    return documents.map(doc => ({
      ...doc,
      id: doc._id,
      createdAt: new Date(doc.createdAt),
      updatedAt: new Date(doc.updatedAt),
      resolvedAt: doc.resolvedAt ? new Date(doc.resolvedAt) : undefined
    }));
  }

  async updateComment(
    commentId: string,
    updates: Partial<ICommentSystem.IComment>
  ): Promise<ICommentSystem.IComment> {
    const db = this._mongoClient.db(this._database);
    const collection = db.collection(this._collection);
    
    const result = await collection.findOneAndUpdate(
      { _id: commentId },
      { $set: updates },
      { returnDocument: 'after' }
    );
    
    if (!result.value) {
      throw new Error(`Comment ${commentId} not found`);
    }
    
    return {
      ...result.value,
      id: result.value._id,
      createdAt: new Date(result.value.createdAt),
      updatedAt: new Date(result.value.updatedAt),
      resolvedAt: result.value.resolvedAt ? new Date(result.value.resolvedAt) : undefined
    };
  }

  async deleteComment(commentId: string): Promise<void> {
    const db = this._mongoClient.db(this._database);
    const collection = db.collection(this._collection);
    
    // Delete comment and all its replies (cascade delete)
    await collection.deleteMany({
      $or: [
        { _id: commentId },
        { parentId: commentId }
      ]
    });
  }

  async searchComments(
    notebookId: string,
    query: string,
    options?: ICommentSystem.ICommentSearchOptions
  ): Promise<ICommentSystem.IComment[]> {
    const db = this._mongoClient.db(this._database);
    const collection = db.collection(this._collection);
    
    // Full-text search query
    const searchQuery: any = {
      notebookId,
      $text: { $search: query }
    };
    
    // Apply additional filters
    if (options?.status) {
      searchQuery.status = { $in: options.status };
    }
    
    if (options?.authorId) {
      searchQuery['author.id'] = options.authorId;
    }
    
    // Execute search with text score sorting
    const documents = await collection
      .find(searchQuery, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(options?.limit || 50)
      .toArray();
    
    return documents.map(doc => ({
      ...doc,
      id: doc._id,
      createdAt: new Date(doc.createdAt),
      updatedAt: new Date(doc.updatedAt),
      resolvedAt: doc.resolvedAt ? new Date(doc.resolvedAt) : undefined
    }));
  }

  async getCommentThread(rootCommentId: string): Promise<ICommentSystem.ICommentThread> {
    const db = this._mongoClient.db(this._database);
    const collection = db.collection(this._collection);
    
    // Get root comment
    const rootComment = await collection.findOne({ _id: rootCommentId });
    if (!rootComment) {
      throw new Error(`Root comment ${rootCommentId} not found`);
    }
    
    // Get all replies
    const replies = await collection
      .find({ parentId: rootCommentId })
      .sort({ createdAt: 1 })
      .toArray();
    
    // Calculate statistics
    const allComments = [rootComment, ...replies];
    const participantIds = new Set(allComments.map(c => c.author.id));
    const lastActivity = new Date(Math.max(...allComments.map(c => c.updatedAt.getTime())));
    
    // Determine thread status
    const allResolved = allComments.every(c => c.status === ICommentSystem.CommentStatus.RESOLVED);
    const threadStatus = allResolved 
      ? ICommentSystem.CommentStatus.RESOLVED 
      : ICommentSystem.CommentStatus.OPEN;
    
    return {
      rootComment: {
        ...rootComment,
        id: rootComment._id,
        createdAt: new Date(rootComment.createdAt),
        updatedAt: new Date(rootComment.updatedAt),
        resolvedAt: rootComment.resolvedAt ? new Date(rootComment.resolvedAt) : undefined
      },
      replies: replies.map(doc => ({
        ...doc,
        id: doc._id,
        createdAt: new Date(doc.createdAt),
        updatedAt: new Date(doc.updatedAt),
        resolvedAt: doc.resolvedAt ? new Date(doc.resolvedAt) : undefined
      })),
      stats: {
        totalComments: allComments.length,
        uniqueParticipants: participantIds.size,
        lastActivity
      },
      threadStatus
    };
  }

  async bulkInsert(comments: ICommentSystem.IComment[]): Promise<ICommentSystem.IImportResult> {
    const db = this._mongoClient.db(this._database);
    const collection = db.collection(this._collection);
    
    const successful: ICommentSystem.IComment[] = [];
    const failed: Array<{ data: PartialJSONObject; error: string; }> = [];
    let duplicatesSkipped = 0;
    
    for (const comment of comments) {
      try {
        // Check for duplicates
        const existing = await collection.findOne({ _id: comment.id });
        if (existing) {
          duplicatesSkipped++;
          continue;
        }
        
        await collection.insertOne({
          ...comment,
          _id: comment.id
        });
        
        successful.push(comment);
      } catch (error) {
        failed.push({
          data: comment as PartialJSONObject,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    return {
      successful,
      failed,
      stats: {
        totalProcessed: comments.length,
        successCount: successful.length,
        failureCount: failed.length,
        duplicatesSkipped
      }
    };
  }

  async bulkExport(
    notebookId: string,
    options: ICommentSystem.IExportOptions
  ): Promise<JSONValue> {
    const comments = await this.getComments(notebookId, options.filters);
    
    switch (options.format) {
      case 'json':
        return comments;
      
      case 'markdown':
        return this._exportAsMarkdown(comments, options);
      
      case 'html':
        return this._exportAsHTML(comments, options);
      
      case 'csv':
        return this._exportAsCSV(comments, options);
      
      default:
        throw new Error(`Unsupported export format: ${options.format}`);
    }
  }

  private _exportAsMarkdown(
    comments: ICommentSystem.IComment[],
    options: ICommentSystem.IExportOptions
  ): string {
    let markdown = '# Comments Export\n\n';
    
    const threads = this._groupCommentsIntoThreads(comments);
    
    for (const thread of threads) {
      markdown += `## ${thread.rootComment.content.substring(0, 50)}...\n\n`;
      markdown += `**Author:** ${thread.rootComment.author.name}\n`;
      markdown += `**Created:** ${thread.rootComment.createdAt.toISOString()}\n`;
      markdown += `**Status:** ${thread.rootComment.status}\n\n`;
      markdown += `${thread.rootComment.content}\n\n`;
      
      if (thread.replies.length > 0) {
        markdown += '### Replies\n\n';
        for (const reply of thread.replies) {
          markdown += `- **${reply.author.name}** (${reply.createdAt.toISOString()}): ${reply.content}\n`;
        }
        markdown += '\n';
      }
      
      markdown += '---\n\n';
    }
    
    return markdown;
  }

  private _exportAsHTML(
    comments: ICommentSystem.IComment[],
    options: ICommentSystem.IExportOptions
  ): string {
    // HTML export implementation
    return '<html><body>HTML export not yet implemented</body></html>';
  }

  private _exportAsCSV(
    comments: ICommentSystem.IComment[],
    options: ICommentSystem.IExportOptions
  ): string {
    const headers = [
      'ID', 'Parent ID', 'Author', 'Content', 'Status', 'Priority',
      'Created At', 'Updated At', 'Cell ID', 'Tags'
    ];
    
    let csv = headers.join(',') + '\n';
    
    for (const comment of comments) {
      const row = [
        comment.id,
        comment.parentId || '',
        comment.author.name,
        `"${comment.content.replace(/"/g, '""')}"`, // Escape quotes
        comment.status,
        comment.priority,
        comment.createdAt.toISOString(),
        comment.updatedAt.toISOString(),
        comment.anchor.cellId,
        comment.tags.join(';')
      ];
      
      csv += row.join(',') + '\n';
    }
    
    return csv;
  }

  private _groupCommentsIntoThreads(comments: ICommentSystem.IComment[]): ICommentSystem.ICommentThread[] {
    const threads: ICommentSystem.ICommentThread[] = [];
    const commentMap = new Map(comments.map(c => [c.id, c]));
    
    // Find root comments
    const rootComments = comments.filter(c => !c.parentId);
    
    for (const rootComment of rootComments) {
      const replies = comments.filter(c => c.parentId === rootComment.id);
      
      threads.push({
        rootComment,
        replies,
        stats: {
          totalComments: 1 + replies.length,
          uniqueParticipants: new Set([rootComment.author.id, ...replies.map(r => r.author.id)]).size,
          lastActivity: new Date(Math.max(
            rootComment.updatedAt.getTime(),
            ...replies.map(r => r.updatedAt.getTime())
          ))
        },
        threadStatus: [rootComment, ...replies].every(c => c.status === ICommentSystem.CommentStatus.RESOLVED)
          ? ICommentSystem.CommentStatus.RESOLVED
          : ICommentSystem.CommentStatus.OPEN
      });
    }
    
    return threads;
  }
}

/**
 * Default export for the comment system module
 */
export default CommentSystem;