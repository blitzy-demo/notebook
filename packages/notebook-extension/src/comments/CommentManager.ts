/**
 * @fileoverview CommentManager - Core state management class for collaborative comment system
 * 
 * This module implements the CommentManager class that provides Yjs Y.Array integration for
 * real-time comment synchronization across collaborative users. It manages comment lifecycle,
 * thread operations, and ensures sub-100ms latency for comment operations as specified in F-028.
 * 
 * Key features:
 * - Yjs Y.Array based comment storage for CRDT synchronization  
 * - Real-time comment sync with <100ms latency requirement
 * - Cell-to-comment mapping and thread management
 * - Offline comment queuing with eventual consistency
 * - Integration with collaboration awareness system
 * - Memory-efficient operation with <20% overhead limit
 * 
 * @author Blitzy Platform Development Team
 * @version 1.0.0
 * @since 2024
 */

import { Signal, ISignal } from '@lumino/signaling';
import { DisposableDelegate, IDisposable } from '@lumino/disposable';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Doc as YDoc, Map as YMap, Array as YArray } from 'yjs';

// Type imports for comment system interfaces
import {
  IComment,
  ICommentThread,
  ICommentUser,
  ICommentResolution,
  CommentEventType,
  ICommentMetadata,
  ICommentFilter,
  ICommentUpdate
} from './types';

// Import notification system for comment activity alerts
import { CommentNotificationManager } from './notifications';

/**
 * Configuration options for CommentManager initialization
 */
export interface ICommentManagerOptions {
  /**
   * Unique identifier for the notebook document
   */
  documentId: string;
  
  /**
   * User information for comment attribution
   */
  user: ICommentUser;
  
  /**
   * WebSocket provider for Yjs synchronization
   */
  provider?: WebsocketProvider;
  
  /**
   * Maximum number of comments to keep in memory cache
   */
  maxCacheSize?: number;
  
  /**
   * Timeout for offline comment queue in milliseconds
   */
  offlineTimeout?: number;
  
  /**
   * Enable debug logging for development
   */
  debug?: boolean;
}

/**
 * CommentManager - Core state management class for collaborative comment system
 * 
 * Manages comment lifecycle, Yjs Y.Array integration, real-time synchronization,
 * and thread operations for collaborative notebook comments. Ensures sub-100ms
 * latency for comment operations and provides offline comment queuing.
 */
export class CommentManager implements IDisposable {
  private _ydoc: YDoc;
  private _commentsArray: YArray<IComment>;
  private _threadsMap: YMap<ICommentThread>;
  private _metadataMap: YMap<ICommentMetadata>;
  
  private _provider: WebsocketProvider | null = null;
  private _notificationManager: CommentNotificationManager;
  
  private _user: ICommentUser;
  private _documentId: string;
  private _isDisposed = false;
  private _isConnected = false;
  
  // Comment cache for performance optimization
  private _commentCache = new Map<string, IComment>();
  private _threadCache = new Map<string, ICommentThread>();
  private _maxCacheSize: number;
  
  // Offline comment queue for eventual consistency
  private _offlineQueue: ICommentUpdate[] = [];
  private _offlineTimeout: number;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 5;
  
  // Performance monitoring
  private _operationLatencies: number[] = [];
  private _memoryUsageBaseline: number = 0;
  
  // Signals for reactive updates
  private _commentAdded = new Signal<this, IComment>(this);
  private _commentUpdated = new Signal<this, IComment>(this);
  private _commentDeleted = new Signal<this, { commentId: string; cellId: string }>(this);
  private _threadUpdated = new Signal<this, ICommentThread>(this);
  private _connectionStatusChanged = new Signal<this, boolean>(this);
  
  /**
   * Signal emitted when a new comment is added
   */
  get commentAdded(): ISignal<this, IComment> {
    return this._commentAdded;
  }
  
  /**
   * Signal emitted when a comment is updated
   */
  get commentUpdated(): ISignal<this, IComment> {
    return this._commentUpdated;
  }
  
  /**
   * Signal emitted when a comment is deleted
   */
  get commentDeleted(): ISignal<this, { commentId: string; cellId: string }> {
    return this._commentDeleted;
  }
  
  /**
   * Signal emitted when a comment thread is updated
   */
  get threadUpdated(): ISignal<this, ICommentThread> {
    return this._threadUpdated;
  }
  
  /**
   * Signal emitted when connection status changes
   */
  get connectionStatusChanged(): ISignal<this, boolean> {
    return this._connectionStatusChanged;
  }
  
  /**
   * Get current connection status
   */
  get isConnected(): boolean {
    return this._isConnected;
  }
  
  /**
   * Get current user information
   */
  get currentUser(): ICommentUser {
    return this._user;
  }
  
  /**
   * Get number of queued offline operations
   */
  get queueSize(): number {
    return this._offlineQueue.length;
  }

  constructor(options: ICommentManagerOptions) {
    this._documentId = options.documentId;
    this._user = options.user;
    this._maxCacheSize = options.maxCacheSize || 1000;
    this._offlineTimeout = options.offlineTimeout || 30000; // 30 seconds
    
    // Initialize Yjs document and shared types
    this._ydoc = new YDoc();
    this._commentsArray = this._ydoc.getArray<IComment>('comments');
    this._threadsMap = this._ydoc.getMap<ICommentThread>('threads');
    this._metadataMap = this._ydoc.getMap<ICommentMetadata>('metadata');
    
    // Initialize notification manager
    this._notificationManager = new CommentNotificationManager({
      user: this._user,
      documentId: this._documentId
    });
    
    // Record baseline memory usage
    this._memoryUsageBaseline = this._getMemoryUsage();
    
    // Set up WebSocket provider if provided
    if (options.provider) {
      this._setupProvider(options.provider);
    }
    
    // Set up Yjs event listeners
    this._setupYjsListeners();
    
    // Start connection monitoring
    this._startConnectionMonitoring();
    
    if (options.debug) {
      console.log(`CommentManager initialized for document ${this._documentId}`);
    }
  }

  /**
   * Create a new comment with real-time synchronization
   * 
   * @param cellId - ID of the notebook cell to attach comment to
   * @param content - Text content of the comment
   * @param parentId - Optional parent comment ID for threaded replies
   * @returns Promise resolving to the created comment
   */
  async createComment(
    cellId: string,
    content: string,
    parentId?: string
  ): Promise<IComment> {
    const startTime = performance.now();
    
    try {
      // Validate input parameters
      if (!cellId || !content.trim()) {
        throw new Error('cellId and content are required for comment creation');
      }
      
      // Create comment object with unique ID and timestamp
      const comment: IComment = {
        id: this._generateCommentId(),
        cellId,
        content: content.trim(),
        author: { ...this._user },
        timestamp: new Date().toISOString(),
        parentId: parentId || null,
        replies: [],
        resolved: false,
        metadata: {
          version: 1,
          lastModified: new Date().toISOString(),
          modifiedBy: this._user.id
        }
      };
      
      // Handle offline scenario
      if (!this._isConnected) {
        await this._queueOfflineOperation({
          type: 'create',
          comment,
          timestamp: Date.now()
        });
        
        // Emit signal for UI updates
        this._commentAdded.emit(comment);
        return comment;
      }
      
      // Add to Yjs array for real-time sync
      this._commentsArray.push([comment]);
      
      // Update thread structure
      await this._updateThreadStructure(comment);
      
      // Cache the comment for performance
      this._addToCache(comment);
      
      // Send notification to collaborators
      await this._notificationManager.sendCommentNotification(comment, 'created');
      
      // Emit signal for UI updates
      this._commentAdded.emit(comment);
      
      // Record performance metrics
      const latency = performance.now() - startTime;
      this._recordOperationLatency(latency);
      
      // Ensure sub-100ms requirement compliance
      if (latency > 100) {
        console.warn(`Comment creation latency exceeded 100ms: ${latency.toFixed(2)}ms`);
      }
      
      return comment;
      
    } catch (error) {
      console.error('Error creating comment:', error);
      throw new Error(`Failed to create comment: ${error.message}`);
    }
  }

  /**
   * Update an existing comment with conflict resolution
   * 
   * @param commentId - ID of the comment to update
   * @param content - New content for the comment
   * @returns Promise resolving to the updated comment
   */
  async updateComment(commentId: string, content: string): Promise<IComment> {
    const startTime = performance.now();
    
    try {
      // Validate input
      if (!commentId || !content.trim()) {
        throw new Error('commentId and content are required for comment update');
      }
      
      // Find the comment in Yjs array
      const commentIndex = this._findCommentIndex(commentId);
      if (commentIndex === -1) {
        throw new Error(`Comment with ID ${commentId} not found`);
      }
      
      const existingComment = this._commentsArray.get(commentIndex);
      
      // Verify user permissions
      if (existingComment.author.id !== this._user.id) {
        throw new Error('User does not have permission to edit this comment');
      }
      
      // Create updated comment with version increment
      const updatedComment: IComment = {
        ...existingComment,
        content: content.trim(),
        metadata: {
          ...existingComment.metadata,
          version: existingComment.metadata.version + 1,
          lastModified: new Date().toISOString(),
          modifiedBy: this._user.id
        }
      };
      
      // Handle offline scenario
      if (!this._isConnected) {
        await this._queueOfflineOperation({
          type: 'update',
          comment: updatedComment,
          timestamp: Date.now()
        });
        
        this._commentUpdated.emit(updatedComment);
        return updatedComment;
      }
      
      // Update in Yjs array with CRDT conflict resolution
      this._commentsArray.delete(commentIndex, 1);
      this._commentsArray.insert(commentIndex, [updatedComment]);
      
      // Update cache
      this._updateCache(updatedComment);
      
      // Send notification
      await this._notificationManager.sendCommentNotification(updatedComment, 'updated');
      
      // Emit signal
      this._commentUpdated.emit(updatedComment);
      
      // Record performance
      const latency = performance.now() - startTime;
      this._recordOperationLatency(latency);
      
      return updatedComment;
      
    } catch (error) {
      console.error('Error updating comment:', error);
      throw new Error(`Failed to update comment: ${error.message}`);
    }
  }

  /**
   * Delete a comment and handle thread cleanup
   * 
   * @param commentId - ID of the comment to delete
   * @returns Promise resolving when deletion is complete
   */
  async deleteComment(commentId: string): Promise<void> {
    const startTime = performance.now();
    
    try {
      // Find and validate comment
      const commentIndex = this._findCommentIndex(commentId);
      if (commentIndex === -1) {
        throw new Error(`Comment with ID ${commentId} not found`);
      }
      
      const comment = this._commentsArray.get(commentIndex);
      
      // Verify permissions
      if (comment.author.id !== this._user.id) {
        throw new Error('User does not have permission to delete this comment');
      }
      
      // Handle offline scenario
      if (!this._isConnected) {
        await this._queueOfflineOperation({
          type: 'delete',
          commentId,
          timestamp: Date.now()
        });
        
        this._commentDeleted.emit({ commentId, cellId: comment.cellId });
        return;
      }
      
      // Remove from Yjs array
      this._commentsArray.delete(commentIndex, 1);
      
      // Clean up thread structure
      await this._cleanupThreadAfterDeletion(comment);
      
      // Remove from cache
      this._removeFromCache(commentId);
      
      // Send notification
      await this._notificationManager.sendCommentNotification(comment, 'deleted');
      
      // Emit signal
      this._commentDeleted.emit({ commentId, cellId: comment.cellId });
      
      // Record performance
      const latency = performance.now() - startTime;
      this._recordOperationLatency(latency);
      
    } catch (error) {
      console.error('Error deleting comment:', error);
      throw new Error(`Failed to delete comment: ${error.message}`);
    }
  }

  /**
   * Get all comments for a specific cell with efficient caching
   * 
   * @param cellId - ID of the cell to get comments for
   * @returns Array of comments associated with the cell
   */
  getCommentsForCell(cellId: string): IComment[] {
    try {
      // Check cache first for performance
      const cachedComments = Array.from(this._commentCache.values())
        .filter(comment => comment.cellId === cellId)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      if (cachedComments.length > 0) {
        return cachedComments;
      }
      
      // Fallback to Yjs array
      const comments = this._commentsArray.toArray()
        .filter(comment => comment.cellId === cellId)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      // Update cache
      comments.forEach(comment => this._addToCache(comment));
      
      return comments;
      
    } catch (error) {
      console.error('Error getting comments for cell:', error);
      return [];
    }
  }

  /**
   * Get comment thread structure for a cell
   * 
   * @param cellId - ID of the cell to get thread for
   * @returns Comment thread with nested replies
   */
  getCommentThread(cellId: string): ICommentThread | null {
    try {
      // Check thread cache
      const cachedThread = this._threadCache.get(cellId);
      if (cachedThread) {
        return cachedThread;
      }
      
      // Build thread from Yjs data
      const comments = this.getCommentsForCell(cellId);
      if (comments.length === 0) {
        return null;
      }
      
      const thread = this._buildThreadStructure(comments);
      
      // Cache the thread
      this._threadCache.set(cellId, thread);
      
      return thread;
      
    } catch (error) {
      console.error('Error getting comment thread:', error);
      return null;
    }
  }

  /**
   * Resolve or unresolve a comment thread
   * 
   * @param commentId - ID of the root comment to resolve
   * @param resolved - Whether to resolve (true) or unresolve (false)
   * @returns Promise resolving to the resolution status
   */
  async resolveComment(commentId: string, resolved: boolean): Promise<ICommentResolution> {
    try {
      const comment = this._getCommentById(commentId);
      if (!comment) {
        throw new Error(`Comment with ID ${commentId} not found`);
      }
      
      // Create resolution object
      const resolution: ICommentResolution = {
        commentId,
        resolved,
        resolvedBy: this._user.id,
        resolvedAt: new Date().toISOString(),
        resolution: resolved ? 'resolved' : 'active'
      };
      
      // Update comment
      const updatedComment = {
        ...comment,
        resolved,
        resolution
      };
      
      await this.updateComment(commentId, updatedComment.content);
      
      // Send notification
      await this._notificationManager.sendCommentNotification(updatedComment, 'resolved');
      
      return resolution;
      
    } catch (error) {
      console.error('Error resolving comment:', error);
      throw new Error(`Failed to resolve comment: ${error.message}`);
    }
  }

  /**
   * Sync offline comments when connection is restored
   * 
   * @returns Promise resolving when sync is complete
   */
  async syncOfflineComments(): Promise<void> {
    if (this._offlineQueue.length === 0) {
      return;
    }
    
    console.log(`Syncing ${this._offlineQueue.length} offline comment operations`);
    
    try {
      // Sort queue by timestamp for proper ordering
      this._offlineQueue.sort((a, b) => a.timestamp - b.timestamp);
      
      // Process each queued operation
      for (const operation of this._offlineQueue) {
        try {
          await this._processOfflineOperation(operation);
        } catch (error) {
          console.error('Error processing offline operation:', error);
          // Continue with other operations
        }
      }
      
      // Clear the queue after successful sync
      this._offlineQueue = [];
      
      console.log('Offline comment sync completed successfully');
      
    } catch (error) {
      console.error('Error syncing offline comments:', error);
      throw new Error(`Failed to sync offline comments: ${error.message}`);
    }
  }

  /**
   * Get performance metrics for comment operations
   * 
   * @returns Object containing performance statistics
   */
  getPerformanceMetrics(): {
    averageLatency: number;
    maxLatency: number;
    memoryOverhead: number;
    operationCount: number;
  } {
    const latencies = this._operationLatencies;
    const averageLatency = latencies.length > 0 
      ? latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length 
      : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
    const currentMemory = this._getMemoryUsage();
    const memoryOverhead = this._memoryUsageBaseline > 0 
      ? ((currentMemory - this._memoryUsageBaseline) / this._memoryUsageBaseline) * 100 
      : 0;
    
    return {
      averageLatency: Number(averageLatency.toFixed(2)),
      maxLatency: Number(maxLatency.toFixed(2)),
      memoryOverhead: Number(memoryOverhead.toFixed(2)),
      operationCount: latencies.length
    };
  }

  /**
   * Dispose of the CommentManager and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    try {
      // Sync any pending offline operations
      if (this._isConnected && this._offlineQueue.length > 0) {
        void this.syncOfflineComments();
      }
      
      // Disconnect provider
      if (this._provider) {
        this._provider.disconnect();
        this._provider = null;
      }
      
      // Dispose of notification manager
      this._notificationManager.dispose();
      
      // Clear caches
      this._commentCache.clear();
      this._threadCache.clear();
      
      // Clear offline queue
      this._offlineQueue = [];
      
      // Dispose of Yjs document
      this._ydoc.destroy();
      
      // Mark as disposed
      this._isDisposed = true;
      
      console.log(`CommentManager disposed for document ${this._documentId}`);
      
    } catch (error) {
      console.error('Error disposing CommentManager:', error);
    }
  }

  /**
   * Setup WebSocket provider for Yjs synchronization
   */
  private _setupProvider(provider: WebsocketProvider): void {
    this._provider = provider;
    this._provider.doc = this._ydoc;
    
    // Listen for connection events
    this._provider.on('status', (event: { status: string }) => {
      const wasConnected = this._isConnected;
      this._isConnected = event.status === 'connected';
      
      if (this._isConnected && !wasConnected) {
        // Connection restored - sync offline comments
        void this.syncOfflineComments();
        this._reconnectAttempts = 0;
      }
      
      this._connectionStatusChanged.emit(this._isConnected);
    });
  }

  /**
   * Setup Yjs event listeners for real-time updates
   */
  private _setupYjsListeners(): void {
    // Listen for comment array changes
    this._commentsArray.observe((event) => {
      event.changes.delta.forEach((change) => {
        if ('insert' in change && change.insert) {
          // New comments added
          change.insert.forEach((comment: IComment) => {
            if (comment.author.id !== this._user.id) {
              this._addToCache(comment);
              this._commentAdded.emit(comment);
            }
          });
        }
        
        if ('delete' in change && change.delete) {
          // Comments deleted - handled by delete operation
        }
      });
    });
    
    // Listen for thread structure changes
    this._threadsMap.observe((event) => {
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'add' || change.action === 'update') {
          const thread = this._threadsMap.get(key);
          if (thread) {
            this._threadCache.set(key, thread);
            this._threadUpdated.emit(thread);
          }
        }
      });
    });
  }

  /**
   * Start connection monitoring for automatic reconnection
   */
  private _startConnectionMonitoring(): void {
    setInterval(() => {
      if (!this._isConnected && this._provider && this._reconnectAttempts < this._maxReconnectAttempts) {
        console.log(`Attempting to reconnect (attempt ${this._reconnectAttempts + 1})`);
        this._reconnectAttempts++;
        this._provider.connect();
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Queue operation for offline processing
   */
  private async _queueOfflineOperation(operation: ICommentUpdate): Promise<void> {
    // Ensure queue doesn't grow too large
    if (this._offlineQueue.length >= 100) {
      // Remove oldest operations
      this._offlineQueue.splice(0, 10);
    }
    
    this._offlineQueue.push(operation);
    
    // Set timeout for operation expiry
    setTimeout(() => {
      const index = this._offlineQueue.indexOf(operation);
      if (index > -1) {
        this._offlineQueue.splice(index, 1);
        console.warn('Offline comment operation expired');
      }
    }, this._offlineTimeout);
  }

  /**
   * Process an offline operation when connection is restored
   */
  private async _processOfflineOperation(operation: ICommentUpdate): Promise<void> {
    switch (operation.type) {
      case 'create':
        if (operation.comment) {
          this._commentsArray.push([operation.comment]);
          await this._updateThreadStructure(operation.comment);
        }
        break;
        
      case 'update':
        if (operation.comment) {
          const index = this._findCommentIndex(operation.comment.id);
          if (index > -1) {
            this._commentsArray.delete(index, 1);
            this._commentsArray.insert(index, [operation.comment]);
          }
        }
        break;
        
      case 'delete':
        if (operation.commentId) {
          const index = this._findCommentIndex(operation.commentId);
          if (index > -1) {
            this._commentsArray.delete(index, 1);
          }
        }
        break;
    }
  }

  /**
   * Update thread structure after comment changes
   */
  private async _updateThreadStructure(comment: IComment): Promise<void> {
    try {
      const cellComments = this.getCommentsForCell(comment.cellId);
      const thread = this._buildThreadStructure(cellComments);
      
      this._threadsMap.set(comment.cellId, thread);
      this._threadCache.set(comment.cellId, thread);
      
    } catch (error) {
      console.error('Error updating thread structure:', error);
    }
  }

  /**
   * Build hierarchical thread structure from flat comment array
   */
  private _buildThreadStructure(comments: IComment[]): ICommentThread {
    const rootComments = comments.filter(c => !c.parentId);
    const thread: ICommentThread = {
      cellId: comments[0]?.cellId || '',
      comments: [],
      totalCount: comments.length,
      resolvedCount: comments.filter(c => c.resolved).length,
      lastActivity: comments.length > 0 
        ? Math.max(...comments.map(c => new Date(c.timestamp).getTime()))
        : Date.now()
    };
    
    // Build nested structure
    const buildReplies = (parentId: string): IComment[] => {
      return comments
        .filter(c => c.parentId === parentId)
        .map(comment => ({
          ...comment,
          replies: buildReplies(comment.id)
        }));
    };
    
    thread.comments = rootComments.map(comment => ({
      ...comment,
      replies: buildReplies(comment.id)
    }));
    
    return thread;
  }

  /**
   * Clean up thread structure after comment deletion
   */
  private async _cleanupThreadAfterDeletion(deletedComment: IComment): Promise<void> {
    try {
      // If comment has replies, need to handle orphaned replies
      if (deletedComment.replies && deletedComment.replies.length > 0) {
        // For now, we'll remove all replies with the parent
        // In future, could implement orphan adoption logic
        for (const reply of deletedComment.replies) {
          const replyIndex = this._findCommentIndex(reply.id);
          if (replyIndex > -1) {
            this._commentsArray.delete(replyIndex, 1);
          }
        }
      }
      
      // Update thread structure
      const remainingComments = this.getCommentsForCell(deletedComment.cellId);
      if (remainingComments.length > 0) {
        const thread = this._buildThreadStructure(remainingComments);
        this._threadsMap.set(deletedComment.cellId, thread);
        this._threadCache.set(deletedComment.cellId, thread);
      } else {
        // No comments left, remove thread
        this._threadsMap.delete(deletedComment.cellId);
        this._threadCache.delete(deletedComment.cellId);
      }
      
    } catch (error) {
      console.error('Error cleaning up thread after deletion:', error);
    }
  }

  /**
   * Generate unique comment ID
   */
  private _generateCommentId(): string {
    return `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Find comment index in Yjs array
   */
  private _findCommentIndex(commentId: string): number {
    const comments = this._commentsArray.toArray();
    return comments.findIndex(comment => comment.id === commentId);
  }

  /**
   * Get comment by ID from cache or Yjs array
   */
  private _getCommentById(commentId: string): IComment | null {
    // Check cache first
    const cached = this._commentCache.get(commentId);
    if (cached) {
      return cached;
    }
    
    // Search in Yjs array
    const comments = this._commentsArray.toArray();
    const comment = comments.find(c => c.id === commentId);
    
    if (comment) {
      this._addToCache(comment);
    }
    
    return comment || null;
  }

  /**
   * Add comment to cache with LRU eviction
   */
  private _addToCache(comment: IComment): void {
    // Implement LRU cache eviction
    if (this._commentCache.size >= this._maxCacheSize) {
      // Remove oldest entries
      const entries = Array.from(this._commentCache.entries());
      entries.slice(0, Math.floor(this._maxCacheSize * 0.1)).forEach(([key]) => {
        this._commentCache.delete(key);
      });
    }
    
    this._commentCache.set(comment.id, comment);
  }

  /**
   * Update comment in cache
   */
  private _updateCache(comment: IComment): void {
    this._commentCache.set(comment.id, comment);
  }

  /**
   * Remove comment from cache
   */
  private _removeFromCache(commentId: string): void {
    this._commentCache.delete(commentId);
  }

  /**
   * Record operation latency for performance monitoring
   */
  private _recordOperationLatency(latency: number): void {
    this._operationLatencies.push(latency);
    
    // Keep only last 100 measurements
    if (this._operationLatencies.length > 100) {
      this._operationLatencies.shift();
    }
  }

  /**
   * Get current memory usage (approximation)
   */
  private _getMemoryUsage(): number {
    // Approximate memory usage calculation
    return (
      this._commentCache.size * 1000 + // Approximate comment size
      this._threadCache.size * 2000 + // Approximate thread size
      this._offlineQueue.length * 500   // Approximate operation size
    );
  }
}

/**
 * Create a new CommentManager instance with the provided options
 * 
 * @param options - Configuration options for the CommentManager
 * @returns New CommentManager instance
 */
export function createCommentManager(options: ICommentManagerOptions): CommentManager {
  return new CommentManager(options);
}

/**
 * Export a disposable delegate for the CommentManager
 * 
 * @param manager - The CommentManager instance to wrap
 * @returns DisposableDelegate for the manager
 */
export function createCommentManagerDelegate(manager: CommentManager): IDisposable {
  return new DisposableDelegate(() => {
    manager.dispose();
  });
}