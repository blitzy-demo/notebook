// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';

import { Signal, ISignal, IDisposable } from '@lumino/signaling';

import { UUID } from '@lumino/coreutils';

import { 
  ICollaborativeNotebookModel 
} from '../model';

/**
 * Comment interface representing a single comment in the thread
 */
export interface IComment {
  id: string;
  cellId: string;
  author: {
    id: string;
    name: string;
    avatar?: string;
  };
  content: string;
  timestamp: Date;
  parentId?: string; // For threaded replies
  resolved: boolean;
  reactions?: { [emoji: string]: string[] }; // emoji -> list of user IDs
  selection?: {
    start: number;
    end: number;
    text: string;
  };
}

/**
 * Comment thread interface representing a collection of related comments
 */
export interface ICommentThread {
  id: string;
  cellId: string;
  anchor: {
    type: 'cell' | 'selection';
    cellId: string;
    selection?: {
      start: number;
      end: number;
      text: string;
    };
  };
  comments: IComment[];
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Comment service interface for managing comments
 */
export interface ICommentService extends IDisposable {
  readonly commentThreadsChanged: ISignal<ICommentService, ICommentThread[]>;
  readonly activeThread: ICommentThread | null;
  readonly threadsForCell: (cellId: string) => ICommentThread[];
  readonly allThreads: ICommentThread[];
  
  createThread(cellId: string, content: string, selection?: IComment['selection']): Promise<ICommentThread>;
  addComment(threadId: string, content: string, parentId?: string): Promise<IComment>;
  resolveThread(threadId: string): Promise<void>;
  unresolveThread(threadId: string): Promise<void>;
  editComment(commentId: string, content: string): Promise<void>;
  deleteComment(commentId: string): Promise<void>;
  addReaction(commentId: string, emoji: string): Promise<void>;
  removeReaction(commentId: string, emoji: string): Promise<void>;
  setActiveThread(threadId: string | null): void;
}

/**
 * Internal comment data structure for Yjs storage
 */
interface ICommentData {
  id: string;
  cellId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  timestamp: number;
  parentId?: string;
  resolved: boolean;
  reactions?: { [emoji: string]: string[] };
  selection?: {
    start: number;
    end: number;
    text: string;
  };
}

/**
 * Internal thread data structure for Yjs storage
 */
interface ICommentThreadData {
  id: string;
  cellId: string;
  anchorType: 'cell' | 'selection';
  anchorSelection?: {
    start: number;
    end: number;
    text: string;
  };
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Options for creating a comment manager
 */
export interface ICommentManagerOptions {
  /**
   * The collaborative notebook model to attach to
   */
  notebookModel: ICollaborativeNotebookModel;

  /**
   * Current user information provider
   */
  userProvider?: () => {
    id: string;
    name: string;
    avatar?: string;
  };

  /**
   * Maximum number of comments per thread
   */
  maxCommentsPerThread?: number;

  /**
   * Maximum comment content length
   */
  maxCommentLength?: number;

  /**
   * Auto-save interval for comment persistence
   */
  autoSaveInterval?: number;
}

/**
 * Comment manager implementing threaded comments with Yjs synchronization
 */
export class CommentManager implements ICommentService {
  /**
   * Construct a new comment manager
   */
  constructor(options: ICommentManagerOptions) {
    this._notebookModel = options.notebookModel;
    this._userProvider = options.userProvider || this._defaultUserProvider;
    this._maxCommentsPerThread = options.maxCommentsPerThread || 1000;
    this._maxCommentLength = options.maxCommentLength || 10000;
    this._autoSaveInterval = options.autoSaveInterval || 5000;

    // Initialize state
    this._isDisposed = false;
    this._activeThread = null;
    this._commentThreadsChanged = new Signal<ICommentService, ICommentThread[]>(this);

    // Get Yjs document from the notebook model
    this._yjsDocument = this._notebookModel.yjsDocument;
    
    // Initialize Yjs shared structures for comments
    this._yjsComments = this._yjsDocument.getMap('comments');
    this._yjsThreads = this._yjsDocument.getMap('comment_threads');
    this._yjsThreadComments = this._yjsDocument.getMap('thread_comments'); // threadId -> commentId[]

    // Initialize local caches
    this._threads = new Map<string, ICommentThread>();
    this._comments = new Map<string, IComment>();
    this._threadsByCell = new Map<string, Set<string>>();

    // Set up observers for Yjs changes
    this._setupYjsObservers();

    // Initialize from existing data
    this._loadExistingData();

    // Set up auto-save timer
    this._setupAutoSave();

    console.log('CommentManager initialized');
  }

  /**
   * Signal emitted when comment threads change
   */
  get commentThreadsChanged(): ISignal<ICommentService, ICommentThread[]> {
    return this._commentThreadsChanged;
  }

  /**
   * The currently active thread
   */
  get activeThread(): ICommentThread | null {
    return this._activeThread;
  }

  /**
   * Get all comment threads
   */
  get allThreads(): ICommentThread[] {
    return Array.from(this._threads.values()).sort((a, b) => 
      b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  }

  /**
   * Get threads for a specific cell
   */
  threadsForCell = (cellId: string): ICommentThread[] => {
    const threadIds = this._threadsByCell.get(cellId) || new Set();
    return Array.from(threadIds)
      .map(id => this._threads.get(id))
      .filter((thread): thread is ICommentThread => thread !== undefined)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  };

  /**
   * Create a new comment thread
   */
  async createThread(
    cellId: string, 
    content: string, 
    selection?: IComment['selection']
  ): Promise<ICommentThread> {
    if (this._isDisposed) {
      throw new Error('CommentManager has been disposed');
    }

    if (!content.trim()) {
      throw new Error('Comment content cannot be empty');
    }

    if (content.length > this._maxCommentLength) {
      throw new Error(`Comment content exceeds maximum length of ${this._maxCommentLength} characters`);
    }

    const currentUser = this._userProvider();
    const now = Date.now();
    const threadId = UUID.uuid4();
    const commentId = UUID.uuid4();

    try {
      // Create thread data
      const threadData: ICommentThreadData = {
        id: threadId,
        cellId,
        anchorType: selection ? 'selection' : 'cell',
        anchorSelection: selection,
        resolved: false,
        createdAt: now,
        updatedAt: now
      };

      // Create initial comment data
      const commentData: ICommentData = {
        id: commentId,
        cellId,
        authorId: currentUser.id,
        authorName: currentUser.name,
        authorAvatar: currentUser.avatar,
        content: content.trim(),
        timestamp: now,
        resolved: false,
        reactions: {}
      };

      // Transactionally update Yjs document
      this._yjsDocument.transact(() => {
        // Add thread
        this._yjsThreads.set(threadId, threadData);
        
        // Add comment
        this._yjsComments.set(commentId, commentData);
        
        // Link comment to thread
        this._yjsThreadComments.set(threadId, [commentId]);
      });

      // Get the created thread
      const thread = this._threads.get(threadId);
      if (!thread) {
        throw new Error('Failed to retrieve created thread');
      }

      console.log(`Created comment thread ${threadId} on cell ${cellId}`);
      return thread;

    } catch (error) {
      console.error('Error creating comment thread:', error);
      throw new Error(`Failed to create comment thread: ${error.message}`);
    }
  }

  /**
   * Add a comment to an existing thread
   */
  async addComment(
    threadId: string, 
    content: string, 
    parentId?: string
  ): Promise<IComment> {
    if (this._isDisposed) {
      throw new Error('CommentManager has been disposed');
    }

    if (!content.trim()) {
      throw new Error('Comment content cannot be empty');
    }

    if (content.length > this._maxCommentLength) {
      throw new Error(`Comment content exceeds maximum length of ${this._maxCommentLength} characters`);
    }

    const thread = this._threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    if (thread.resolved) {
      throw new Error('Cannot add comments to a resolved thread');
    }

    if (thread.comments.length >= this._maxCommentsPerThread) {
      throw new Error(`Thread has reached maximum of ${this._maxCommentsPerThread} comments`);
    }

    // Validate parent comment if specified
    if (parentId) {
      const parentComment = this._comments.get(parentId);
      if (!parentComment || parentComment.cellId !== thread.cellId) {
        throw new Error('Invalid parent comment');
      }
    }

    const currentUser = this._userProvider();
    const now = Date.now();
    const commentId = UUID.uuid4();

    try {
      const commentData: ICommentData = {
        id: commentId,
        cellId: thread.cellId,
        authorId: currentUser.id,
        authorName: currentUser.name,
        authorAvatar: currentUser.avatar,
        content: content.trim(),
        timestamp: now,
        parentId,
        resolved: false,
        reactions: {}
      };

      // Transactionally update Yjs document
      this._yjsDocument.transact(() => {
        // Add comment
        this._yjsComments.set(commentId, commentData);
        
        // Update thread comment list
        const threadComments = this._yjsThreadComments.get(threadId) || [];
        this._yjsThreadComments.set(threadId, [...threadComments, commentId]);
        
        // Update thread timestamp
        const threadData = this._yjsThreads.get(threadId);
        if (threadData) {
          this._yjsThreads.set(threadId, { ...threadData, updatedAt: now });
        }
      });

      // Get the created comment
      const comment = this._comments.get(commentId);
      if (!comment) {
        throw new Error('Failed to retrieve created comment');
      }

      console.log(`Added comment ${commentId} to thread ${threadId}`);
      return comment;

    } catch (error) {
      console.error('Error adding comment:', error);
      throw new Error(`Failed to add comment: ${error.message}`);
    }
  }

  /**
   * Resolve a comment thread
   */
  async resolveThread(threadId: string): Promise<void> {
    if (this._isDisposed) {
      throw new Error('CommentManager has been disposed');
    }

    const thread = this._threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    if (thread.resolved) {
      return; // Already resolved
    }

    try {
      const threadData = this._yjsThreads.get(threadId);
      if (threadData) {
        this._yjsThreads.set(threadId, {
          ...threadData,
          resolved: true,
          updatedAt: Date.now()
        });
      }

      console.log(`Resolved thread ${threadId}`);

    } catch (error) {
      console.error('Error resolving thread:', error);
      throw new Error(`Failed to resolve thread: ${error.message}`);
    }
  }

  /**
   * Unresolve a comment thread
   */
  async unresolveThread(threadId: string): Promise<void> {
    if (this._isDisposed) {
      throw new Error('CommentManager has been disposed');
    }

    const thread = this._threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    if (!thread.resolved) {
      return; // Already unresolved
    }

    try {
      const threadData = this._yjsThreads.get(threadId);
      if (threadData) {
        this._yjsThreads.set(threadId, {
          ...threadData,
          resolved: false,
          updatedAt: Date.now()
        });
      }

      console.log(`Unresolved thread ${threadId}`);

    } catch (error) {
      console.error('Error unresolving thread:', error);
      throw new Error(`Failed to unresolve thread: ${error.message}`);
    }
  }

  /**
   * Edit an existing comment
   */
  async editComment(commentId: string, content: string): Promise<void> {
    if (this._isDisposed) {
      throw new Error('CommentManager has been disposed');
    }

    if (!content.trim()) {
      throw new Error('Comment content cannot be empty');
    }

    if (content.length > this._maxCommentLength) {
      throw new Error(`Comment content exceeds maximum length of ${this._maxCommentLength} characters`);
    }

    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found`);
    }

    const currentUser = this._userProvider();
    if (comment.author.id !== currentUser.id) {
      throw new Error('You can only edit your own comments');
    }

    try {
      const commentData = this._yjsComments.get(commentId);
      if (commentData) {
        this._yjsComments.set(commentId, {
          ...commentData,
          content: content.trim(),
          timestamp: Date.now() // Update timestamp for edited comments
        });
      }

      console.log(`Edited comment ${commentId}`);

    } catch (error) {
      console.error('Error editing comment:', error);
      throw new Error(`Failed to edit comment: ${error.message}`);
    }
  }

  /**
   * Delete a comment
   */
  async deleteComment(commentId: string): Promise<void> {
    if (this._isDisposed) {
      throw new Error('CommentManager has been disposed');
    }

    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found`);
    }

    const currentUser = this._userProvider();
    if (comment.author.id !== currentUser.id) {
      throw new Error('You can only delete your own comments');
    }

    try {
      // Find the thread containing this comment
      let threadId: string | null = null;
      for (const [tid, commentIds] of this._yjsThreadComments.entries()) {
        if (commentIds.includes(commentId)) {
          threadId = tid;
          break;
        }
      }

      if (!threadId) {
        throw new Error('Could not find thread for comment');
      }

      this._yjsDocument.transact(() => {
        // Remove comment
        this._yjsComments.delete(commentId);
        
        // Update thread comment list
        const threadComments = this._yjsThreadComments.get(threadId!) || [];
        const updatedComments = threadComments.filter(id => id !== commentId);
        
        if (updatedComments.length === 0) {
          // If this was the last comment, delete the entire thread
          this._yjsThreads.delete(threadId!);
          this._yjsThreadComments.delete(threadId!);
        } else {
          this._yjsThreadComments.set(threadId!, updatedComments);
          
          // Update thread timestamp
          const threadData = this._yjsThreads.get(threadId!);
          if (threadData) {
            this._yjsThreads.set(threadId!, { ...threadData, updatedAt: Date.now() });
          }
        }
      });

      console.log(`Deleted comment ${commentId}`);

    } catch (error) {
      console.error('Error deleting comment:', error);
      throw new Error(`Failed to delete comment: ${error.message}`);
    }
  }

  /**
   * Add a reaction to a comment
   */
  async addReaction(commentId: string, emoji: string): Promise<void> {
    if (this._isDisposed) {
      throw new Error('CommentManager has been disposed');
    }

    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found`);
    }

    const currentUser = this._userProvider();

    try {
      const commentData = this._yjsComments.get(commentId);
      if (commentData) {
        const reactions = { ...commentData.reactions } || {};
        const emojiReactions = reactions[emoji] || [];
        
        // Add user to reaction if not already present
        if (!emojiReactions.includes(currentUser.id)) {
          reactions[emoji] = [...emojiReactions, currentUser.id];
          
          this._yjsComments.set(commentId, {
            ...commentData,
            reactions
          });
        }
      }

      console.log(`Added reaction ${emoji} to comment ${commentId}`);

    } catch (error) {
      console.error('Error adding reaction:', error);
      throw new Error(`Failed to add reaction: ${error.message}`);
    }
  }

  /**
   * Remove a reaction from a comment
   */
  async removeReaction(commentId: string, emoji: string): Promise<void> {
    if (this._isDisposed) {
      throw new Error('CommentManager has been disposed');
    }

    const comment = this._comments.get(commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found`);
    }

    const currentUser = this._userProvider();

    try {
      const commentData = this._yjsComments.get(commentId);
      if (commentData) {
        const reactions = { ...commentData.reactions } || {};
        const emojiReactions = reactions[emoji] || [];
        
        // Remove user from reaction
        const updatedReactions = emojiReactions.filter(userId => userId !== currentUser.id);
        
        if (updatedReactions.length === 0) {
          delete reactions[emoji];
        } else {
          reactions[emoji] = updatedReactions;
        }
        
        this._yjsComments.set(commentId, {
          ...commentData,
          reactions
        });
      }

      console.log(`Removed reaction ${emoji} from comment ${commentId}`);

    } catch (error) {
      console.error('Error removing reaction:', error);
      throw new Error(`Failed to remove reaction: ${error.message}`);
    }
  }

  /**
   * Set the currently active thread
   */
  setActiveThread(threadId: string | null): void {
    if (this._isDisposed) {
      return;
    }

    const previousActive = this._activeThread;
    
    if (threadId === null) {
      this._activeThread = null;
    } else {
      const thread = this._threads.get(threadId);
      this._activeThread = thread || null;
    }

    // Emit change signal if the active thread changed
    if (previousActive?.id !== this._activeThread?.id) {
      console.log(`Active thread changed to: ${this._activeThread?.id || 'none'}`);
    }
  }

  /**
   * Test whether the manager has been disposed
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the comment manager
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    console.log('Disposing CommentManager');

    // Clear auto-save timer
    if (this._autoSaveTimer) {
      clearInterval(this._autoSaveTimer);
      this._autoSaveTimer = null;
    }

    // Disconnect Yjs observers
    if (this._yjsComments) {
      this._yjsComments.unobserve(this._handleCommentsChange);
    }
    if (this._yjsThreads) {
      this._yjsThreads.unobserve(this._handleThreadsChange);
    }
    if (this._yjsThreadComments) {
      this._yjsThreadComments.unobserve(this._handleThreadCommentsChange);
    }

    // Clear local state
    this._threads.clear();
    this._comments.clear();
    this._threadsByCell.clear();
    this._activeThread = null;

    // Mark as disposed
    this._isDisposed = true;
  }

  /**
   * Set up Yjs observers for real-time synchronization
   */
  private _setupYjsObservers(): void {
    // Observe changes to comments
    this._yjsComments.observe(this._handleCommentsChange);
    
    // Observe changes to threads
    this._yjsThreads.observe(this._handleThreadsChange);
    
    // Observe changes to thread-comment relationships
    this._yjsThreadComments.observe(this._handleThreadCommentsChange);
  }

  /**
   * Handle changes to the comments Yjs map
   */
  private _handleCommentsChange = (event: Y.YMapEvent<ICommentData>): void => {
    if (this._isDisposed) {
      return;
    }

    let hasChanges = false;

    event.changes.keys.forEach((change, commentId) => {
      if (change.action === 'add' || change.action === 'update') {
        const commentData = this._yjsComments.get(commentId);
        if (commentData) {
          const comment = this._convertCommentDataToComment(commentData);
          this._comments.set(commentId, comment);
          hasChanges = true;
        }
      } else if (change.action === 'delete') {
        this._comments.delete(commentId);
        hasChanges = true;
      }
    });

    if (hasChanges) {
      this._rebuildThreads();
      this._emitThreadsChanged();
    }
  };

  /**
   * Handle changes to the threads Yjs map
   */
  private _handleThreadsChange = (event: Y.YMapEvent<ICommentThreadData>): void => {
    if (this._isDisposed) {
      return;
    }

    let hasChanges = false;

    event.changes.keys.forEach((change, threadId) => {
      if (change.action === 'add' || change.action === 'update') {
        hasChanges = true;
      } else if (change.action === 'delete') {
        this._threads.delete(threadId);
        // Update cell index
        for (const [cellId, threadIds] of this._threadsByCell.entries()) {
          if (threadIds.has(threadId)) {
            threadIds.delete(threadId);
            if (threadIds.size === 0) {
              this._threadsByCell.delete(cellId);
            }
            break;
          }
        }
        hasChanges = true;
      }
    });

    if (hasChanges) {
      this._rebuildThreads();
      this._emitThreadsChanged();
    }
  };

  /**
   * Handle changes to the thread-comments Yjs map
   */
  private _handleThreadCommentsChange = (event: Y.YMapEvent<string[]>): void => {
    if (this._isDisposed) {
      return;
    }

    let hasChanges = false;

    event.changes.keys.forEach((change, threadId) => {
      if (change.action === 'add' || change.action === 'update' || change.action === 'delete') {
        hasChanges = true;
      }
    });

    if (hasChanges) {
      this._rebuildThreads();
      this._emitThreadsChanged();
    }
  };

  /**
   * Rebuild thread objects from Yjs data
   */
  private _rebuildThreads(): void {
    const newThreads = new Map<string, ICommentThread>();
    const newThreadsByCell = new Map<string, Set<string>>();

    // Iterate through all threads
    for (const [threadId, threadData] of this._yjsThreads.entries()) {
      const commentIds = this._yjsThreadComments.get(threadId) || [];
      
      // Get all comments for this thread
      const comments: IComment[] = [];
      for (const commentId of commentIds) {
        const commentData = this._yjsComments.get(commentId);
        if (commentData) {
          comments.push(this._convertCommentDataToComment(commentData));
        }
      }

      // Sort comments by timestamp
      comments.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Create thread object
      const thread: ICommentThread = {
        id: threadData.id,
        cellId: threadData.cellId,
        anchor: {
          type: threadData.anchorType,
          cellId: threadData.cellId,
          selection: threadData.anchorSelection
        },
        comments,
        resolved: threadData.resolved,
        createdAt: new Date(threadData.createdAt),
        updatedAt: new Date(threadData.updatedAt)
      };

      newThreads.set(threadId, thread);

      // Update cell index
      if (!newThreadsByCell.has(threadData.cellId)) {
        newThreadsByCell.set(threadData.cellId, new Set());
      }
      newThreadsByCell.get(threadData.cellId)!.add(threadId);
    }

    this._threads = newThreads;
    this._threadsByCell = newThreadsByCell;
  }

  /**
   * Convert comment data to comment interface
   */
  private _convertCommentDataToComment(data: ICommentData): IComment {
    return {
      id: data.id,
      cellId: data.cellId,
      author: {
        id: data.authorId,
        name: data.authorName,
        avatar: data.authorAvatar
      },
      content: data.content,
      timestamp: new Date(data.timestamp),
      parentId: data.parentId,
      resolved: data.resolved,
      reactions: data.reactions,
      selection: data.selection
    };
  }

  /**
   * Load existing comment data from Yjs document
   */
  private _loadExistingData(): void {
    console.log('Loading existing comment data...');
    
    // Load comments into cache
    for (const [commentId, commentData] of this._yjsComments.entries()) {
      const comment = this._convertCommentDataToComment(commentData);
      this._comments.set(commentId, comment);
    }

    // Rebuild threads from loaded data
    this._rebuildThreads();

    console.log(`Loaded ${this._comments.size} comments in ${this._threads.size} threads`);
  }

  /**
   * Set up auto-save timer for periodic persistence
   */
  private _setupAutoSave(): void {
    if (this._autoSaveInterval > 0) {
      this._autoSaveTimer = setInterval(() => {
        this._performAutoSave();
      }, this._autoSaveInterval);
    }
  }

  /**
   * Perform auto-save operation
   */
  private _performAutoSave(): void {
    if (this._isDisposed || !this._notebookModel.isConnected) {
      return;
    }

    try {
      // The Yjs document automatically handles persistence through the notebook model
      // This is mainly for logging and monitoring purposes
      const threadCount = this._threads.size;
      const commentCount = this._comments.size;
      
      if (threadCount > 0 || commentCount > 0) {
        console.log(`Auto-save: ${commentCount} comments in ${threadCount} threads`);
      }
    } catch (error) {
      console.error('Error during auto-save:', error);
    }
  }

  /**
   * Emit threads changed signal
   */
  private _emitThreadsChanged(): void {
    if (!this._isDisposed) {
      this._commentThreadsChanged.emit(this.allThreads);
    }
  }

  /**
   * Default user provider when none is specified
   */
  private _defaultUserProvider = (): { id: string; name: string; avatar?: string } => {
    // In a real implementation, this would come from the awareness service
    const userId = 'user-' + Math.random().toString(36).substr(2, 9);
    return {
      id: userId,
      name: 'Anonymous User',
      avatar: undefined
    };
  };

  // Private fields
  private _notebookModel: ICollaborativeNotebookModel;
  private _userProvider: () => { id: string; name: string; avatar?: string };
  private _maxCommentsPerThread: number;
  private _maxCommentLength: number;
  private _autoSaveInterval: number;
  private _isDisposed: boolean;
  private _activeThread: ICommentThread | null;
  private _commentThreadsChanged: Signal<ICommentService, ICommentThread[]>;
  private _yjsDocument: Y.Doc;
  private _yjsComments: Y.Map<ICommentData>;
  private _yjsThreads: Y.Map<ICommentThreadData>;
  private _yjsThreadComments: Y.Map<string[]>;
  private _threads: Map<string, ICommentThread>;
  private _comments: Map<string, IComment>;
  private _threadsByCell: Map<string, Set<string>>;
  private _autoSaveTimer: NodeJS.Timeout | null = null;
}

/**
 * Create a comment manager for a collaborative notebook
 */
export function createCommentManager(
  notebookModel: ICollaborativeNotebookModel,
  options: Partial<ICommentManagerOptions> = {}
): CommentManager {
  return new CommentManager({
    notebookModel,
    ...options
  });
}

/**
 * Get user information from awareness provider if available
 */
export function getUserFromAwareness(notebookModel: ICollaborativeNotebookModel): { id: string; name: string; avatar?: string } | null {
  try {
    if (notebookModel.awarenessProvider) {
      const currentUser = notebookModel.awarenessProvider.getLocalUser();
      if (currentUser) {
        return {
          id: currentUser.id,
          name: currentUser.name,
          avatar: currentUser.avatar
        };
      }
    }
  } catch (error) {
    console.warn('Could not get user from awareness provider:', error);
  }
  
  return null;
}

/**
 * Utility function to create a user provider from awareness
 */
export function createUserProviderFromAwareness(notebookModel: ICollaborativeNotebookModel) {
  return (): { id: string; name: string; avatar?: string } => {
    const user = getUserFromAwareness(notebookModel);
    if (user) {
      return user;
    }
    
    // Fallback to default user
    const userId = 'user-' + Math.random().toString(36).substr(2, 9);
    return {
      id: userId,
      name: `User ${userId.slice(-4)}`,
      avatar: undefined
    };
  };
}