/**
 * @fileoverview Enhanced token definitions for collaborative notebook architecture
 * 
 * This file defines dependency injection tokens and interfaces for the collaborative
 * editing system in Jupyter Notebook v7, enabling real-time collaborative editing
 * through the Yjs CRDT framework with user awareness, cell locking, permissions,
 * change history, and comment systems.
 */

import { Token } from '@lumino/coreutils';
import { ISignal } from '@lumino/signaling';
import { IDisposable } from '@lumino/disposable';
import { Doc } from 'yjs';
import { Awareness } from 'y-protocols/awareness';

/**
 * Interface for managing permissions in collaborative notebook sessions.
 * Provides fine-grained access control with support for view, edit, and admin roles.
 */
export interface IPermissionService extends IDisposable {
  /**
   * Check if the current user can edit the document or specific cells.
   * @param cellId Optional cell identifier for cell-level permissions
   * @returns Promise resolving to true if user has edit permissions
   */
  canEdit(cellId?: string): Promise<boolean>;

  /**
   * Check if the current user can view the document or specific cells.
   * @param cellId Optional cell identifier for cell-level permissions
   * @returns Promise resolving to true if user has view permissions
   */
  canView(cellId?: string): Promise<boolean>;

  /**
   * Check if the current user has admin permissions for the document.
   * @returns Promise resolving to true if user has admin permissions
   */
  canAdmin(): Promise<boolean>;

  /**
   * Get the role of the current user for the document.
   * @returns Promise resolving to the user's role (view, edit, admin)
   */
  getUserRole(): Promise<'view' | 'edit' | 'admin'>;

  /**
   * Check if the current user has a specific permission.
   * @param permission The permission to check
   * @param context Optional context for the permission check
   * @returns Promise resolving to true if user has the permission
   */
  checkPermission(permission: string, context?: any): Promise<boolean>;

  /**
   * Update permissions for a user in the document.
   * @param userId The user ID to update permissions for
   * @param role The new role to assign
   * @returns Promise resolving when permissions are updated
   */
  updatePermissions(userId: string, role: 'view' | 'edit' | 'admin'): Promise<void>;

  /**
   * Get list of all collaborators and their roles.
   * @returns Promise resolving to array of collaborators with their roles
   */
  getCollaborators(): Promise<Array<{userId: string; role: 'view' | 'edit' | 'admin'; name: string}>>;

  /**
   * Set the role for a specific user.
   * @param userId The user ID
   * @param role The role to assign
   * @returns Promise resolving when role is set
   */
  setUserRole(userId: string, role: 'view' | 'edit' | 'admin'): Promise<void>;

  /**
   * Check if the current user can lock cells.
   * @returns Promise resolving to true if user can lock cells
   */
  canLock(): Promise<boolean>;

  /**
   * Create a new permission service instance.
   * @param documentId The document ID to manage permissions for
   * @returns Promise resolving to the created service instance
   */
  create(documentId: string): Promise<IPermissionService>;

  /**
   * Initialize the permission service for the current document.
   * @param options Initialization options
   * @returns Promise resolving when service is initialized
   */
  initialize(options?: any): Promise<void>;

  /**
   * Dispose of the permission service and cleanup resources.
   */
  dispose(): void;
}

/**
 * Token for injecting the IPermissionService dependency.
 */
export const IPermissionToken = new Token<IPermissionService>(
  '@jupyter-notebook/notebook:IPermissionService',
  'Service for managing collaborative permissions and access control.'
);

/**
 * Interface for tracking user awareness and presence in collaborative sessions.
 * Manages user presence, cursor positions, and activity status.
 */
export interface IAwarenessService extends IDisposable {
  /**
   * Get information about all users currently in the collaborative session.
   * @returns Array of user information including presence data
   */
  getUsers(): Array<{
    userId: string;
    name: string;
    avatar?: string;
    cursor?: {cellId: string; position: number};
    selection?: {cellId: string; start: number; end: number};
    isActive: boolean;
    lastActivity: Date;
  }>;

  /**
   * Get information about the current user.
   * @returns Current user information
   */
  getCurrentUser(): {
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
  };

  /**
   * Get presence information for a specific user.
   * @param userId The user ID to get presence for
   * @returns User presence information or null if not found
   */
  getUserPresence(userId: string): {
    cursor?: {cellId: string; position: number};
    selection?: {cellId: string; start: number; end: number};
    isActive: boolean;
    lastActivity: Date;
  } | null;

  /**
   * Signal emitted when a user joins the collaborative session.
   */
  onUserJoin: ISignal<IAwarenessService, {userId: string; name: string; avatar?: string}>;

  /**
   * Signal emitted when a user leaves the collaborative session.
   */
  onUserLeave: ISignal<IAwarenessService, {userId: string}>;
}

/**
 * Token for injecting the IAwarenessService dependency.
 */
export const IAwarenessToken = new Token<IAwarenessService>(
  '@jupyter-notebook/notebook:IAwarenessService',
  'Service for tracking user awareness and presence in collaborative sessions.'
);

/**
 * Interface for opening collaborative notebook paths with proper permissions.
 * Extends the basic path opener to support collaborative features.
 */
export interface ICollaborativeNotebookPathOpener extends IDisposable {
  /**
   * Open a notebook path in collaborative mode.
   * @param options Options for opening the collaborative notebook
   * @returns Promise resolving to the opened window or null
   */
  open(options: {
    prefix: string;
    path?: string;
    searchParams?: URLSearchParams;
    target?: string;
    features?: string;
    collaborative?: boolean;
  }): Promise<WindowProxy | null>;

  /**
   * Open a notebook specifically in collaborative mode.
   * @param options Collaborative opening options
   * @returns Promise resolving to the opened window or null
   */
  openCollaborative(options: {
    prefix: string;
    path: string;
    sessionId?: string;
    permissions?: 'view' | 'edit' | 'admin';
    target?: string;
    features?: string;
  }): Promise<WindowProxy | null>;

  /**
   * Check permissions before opening a collaborative notebook.
   * @param path The notebook path to check
   * @returns Promise resolving to permission check result
   */
  checkPermissions(path: string): Promise<{
    canOpen: boolean;
    role: 'view' | 'edit' | 'admin';
    reason?: string;
  }>;
}

/**
 * Token for injecting the ICollaborativeNotebookPathOpener dependency.
 */
export const ICollaborativeNotebookPathOpenerToken = new Token<ICollaborativeNotebookPathOpener>(
  '@jupyter-notebook/notebook:ICollaborativeNotebookPathOpener',
  'Service for opening collaborative notebook paths with permission checks.'
);

/**
 * Interface for managing cell-level locking in collaborative editing.
 * Provides conflict resolution through exclusive cell access.
 */
export interface ILockService extends IDisposable {
  /**
   * Check if a cell is currently locked by another user.
   * @param cellId The cell ID to check
   * @returns Promise resolving to true if cell is locked
   */
  isLocked(cellId: string): Promise<boolean>;

  /**
   * Attempt to lock a cell for exclusive editing.
   * @param cellId The cell ID to lock
   * @param timeout Optional timeout in milliseconds
   * @returns Promise resolving to true if lock was acquired
   */
  lockCell(cellId: string, timeout?: number): Promise<boolean>;

  /**
   * Release a lock on a cell.
   * @param cellId The cell ID to unlock
   * @returns Promise resolving when lock is released
   */
  unlockCell(cellId: string): Promise<void>;

  /**
   * Get information about who owns a cell lock.
   * @param cellId The cell ID to check
   * @returns Promise resolving to lock owner information or null
   */
  getLockOwner(cellId: string): Promise<{
    userId: string;
    name: string;
    lockedAt: Date;
    timeout?: number;
  } | null>;

  /**
   * Signal emitted when a cell lock state changes.
   */
  onLockChange: ISignal<ILockService, {
    cellId: string;
    isLocked: boolean;
    owner?: {userId: string; name: string};
  }>;

  /**
   * Check if the current user can lock cells.
   * @returns Promise resolving to true if user can lock cells
   */
  canLock(): Promise<boolean>;

  /**
   * Get the default lock timeout for cells.
   * @returns Lock timeout in milliseconds
   */
  getLockTimeout(): number;

  /**
   * Subscribe to lock changes for a specific cell.
   * @param cellId The cell ID to monitor
   * @param callback Callback function for lock changes
   * @returns Disposable subscription
   */
  subscribeToLockChanges(cellId: string, callback: (isLocked: boolean, owner?: {userId: string; name: string}) => void): IDisposable;
}

/**
 * Token for injecting the ILockService dependency.
 */
export const ILockToken = new Token<ILockService>(
  '@jupyter-notebook/notebook:ILockService',
  'Service for managing cell-level locking in collaborative editing.'
);

/**
 * Interface for tracking and managing document change history.
 * Provides version control and change tracking for collaborative documents.
 */
export interface IHistoryService extends IDisposable {
  /**
   * Get recent activity in the document.
   * @param limit Maximum number of activities to return
   * @returns Promise resolving to recent activities
   */
  getRecentActivity(limit?: number): Promise<Array<{
    id: string;
    type: 'cell_added' | 'cell_deleted' | 'cell_modified' | 'cell_moved';
    cellId: string;
    userId: string;
    userName: string;
    timestamp: Date;
    description: string;
    changes?: any;
  }>>;

  /**
   * Signal emitted when the document changes.
   */
  onDocumentChange: ISignal<IHistoryService, {
    type: 'cell_added' | 'cell_deleted' | 'cell_modified' | 'cell_moved';
    cellId: string;
    userId: string;
    timestamp: Date;
    changes: any;
  }>;

  /**
   * Get the timeline of changes for the document.
   * @param startTime Optional start time for the timeline
   * @param endTime Optional end time for the timeline
   * @returns Promise resolving to change timeline
   */
  getChangeTimeline(startTime?: Date, endTime?: Date): Promise<Array<{
    timestamp: Date;
    changes: Array<{
      type: string;
      cellId: string;
      userId: string;
      userName: string;
      description: string;
    }>;
  }>>;

  /**
   * Get changes made by a specific user.
   * @param userId The user ID to get changes for
   * @param limit Maximum number of changes to return
   * @returns Promise resolving to user's changes
   */
  getChangesByUser(userId: string, limit?: number): Promise<Array<{
    id: string;
    type: string;
    cellId: string;
    timestamp: Date;
    description: string;
    changes?: any;
  }>>;

  /**
   * Subscribe to document changes.
   * @param callback Callback function for changes
   * @returns Disposable subscription
   */
  subscribeToChanges(callback: (change: any) => void): IDisposable;

  /**
   * Get version history for the document.
   * @param limit Maximum number of versions to return
   * @returns Promise resolving to version history
   */
  getVersionHistory(limit?: number): Promise<Array<{
    version: number;
    timestamp: Date;
    userId: string;
    userName: string;
    description: string;
    changes: any;
  }>>;
}

/**
 * Token for injecting the IHistoryService dependency.
 */
export const IHistoryToken = new Token<IHistoryService>(
  '@jupyter-notebook/notebook:IHistoryService',
  'Service for tracking and managing document change history.'
);

/**
 * Interface for managing comments and review workflows in collaborative notebooks.
 * Provides cell-level commenting with threading and resolution capabilities.
 */
export interface ICommentService extends IDisposable {
  /**
   * Get unread comments for the current user.
   * @returns Promise resolving to array of unread comments
   */
  getUnreadComments(): Promise<Array<{
    id: string;
    cellId: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    isResolved: boolean;
    parentId?: string;
  }>>;

  /**
   * Signal emitted when a new comment is added.
   */
  onNewComment: ISignal<ICommentService, {
    id: string;
    cellId: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    parentId?: string;
  }>;

  /**
   * Signal emitted when a comment is resolved.
   */
  onCommentResolved: ISignal<ICommentService, {
    id: string;
    cellId: string;
    resolvedBy: {userId: string; name: string};
    timestamp: Date;
  }>;

  /**
   * Get notifications for comments.
   * @param limit Maximum number of notifications to return
   * @returns Promise resolving to comment notifications
   */
  getCommentNotifications(limit?: number): Promise<Array<{
    id: string;
    type: 'new_comment' | 'comment_reply' | 'comment_resolved';
    commentId: string;
    cellId: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    isRead: boolean;
  }>>;

  /**
   * Create a new comment thread.
   * @param cellId The cell ID to comment on
   * @param content The comment content
   * @param options Additional options
   * @returns Promise resolving to the created comment
   */
  createComment(cellId: string, content: string, options?: {
    position?: number;
    type?: 'general' | 'suggestion' | 'question';
  }): Promise<{
    id: string;
    cellId: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    position?: number;
    type: string;
  }>;

  /**
   * Resolve a comment thread.
   * @param commentId The comment ID to resolve
   * @returns Promise resolving when comment is resolved
   */
  resolveComment(commentId: string): Promise<void>;

  /**
   * Add a comment to a cell.
   * @param cellId The cell ID
   * @param content The comment content
   * @param options Additional options
   * @returns Promise resolving to the added comment
   */
  addComment(cellId: string, content: string, options?: any): Promise<{
    id: string;
    cellId: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
  }>;

  /**
   * Reply to an existing comment.
   * @param parentId The parent comment ID
   * @param content The reply content
   * @returns Promise resolving to the reply comment
   */
  replyToComment(parentId: string, content: string): Promise<{
    id: string;
    cellId: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    parentId: string;
  }>;

  /**
   * Update an existing comment.
   * @param commentId The comment ID to update
   * @param content The new content
   * @returns Promise resolving when comment is updated
   */
  updateComment(commentId: string, content: string): Promise<void>;

  /**
   * Delete a comment.
   * @param commentId The comment ID to delete
   * @returns Promise resolving when comment is deleted
   */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Get all comments for a specific cell.
   * @param cellId The cell ID
   * @returns Promise resolving to cell comments
   */
  getCommentsByCell(cellId: string): Promise<Array<{
    id: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    isResolved: boolean;
    parentId?: string;
    replies?: Array<any>;
  }>>;

  /**
   * Subscribe to comment updates.
   * @param callback Callback function for comment updates
   * @returns Disposable subscription
   */
  subscribeToComments(callback: (comment: any) => void): IDisposable;

  /**
   * Get a complete comment thread.
   * @param commentId The root comment ID
   * @returns Promise resolving to the comment thread
   */
  getCommentThread(commentId: string): Promise<{
    id: string;
    cellId: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    isResolved: boolean;
    replies: Array<{
      id: string;
      content: string;
      author: {userId: string; name: string};
      timestamp: Date;
    }>;
  }>;

  /**
   * Mark a comment as read.
   * @param commentId The comment ID to mark as read
   * @returns Promise resolving when comment is marked as read
   */
  markCommentAsRead(commentId: string): Promise<void>;

  /**
   * Get comments by a specific user.
   * @param userId The user ID
   * @param limit Maximum number of comments to return
   * @returns Promise resolving to user's comments
   */
  getCommentsByUser(userId: string, limit?: number): Promise<Array<{
    id: string;
    cellId: string;
    content: string;
    timestamp: Date;
    isResolved: boolean;
  }>>;
}

/**
 * Token for injecting the ICommentService dependency.
 */
export const ICommentToken = new Token<ICommentService>(
  '@jupyter-notebook/notebook:ICommentService',
  'Service for managing comments and review workflows in collaborative notebooks.'
);

/**
 * Interface for the Yjs-based notebook provider that enables collaborative editing.
 * Wraps the notebook model with Yjs document structure for real-time synchronization.
 */
export interface IYjsNotebookProvider extends IDisposable {
  /**
   * The Yjs document instance for collaborative editing.
   */
  doc: Doc;

  /**
   * The awareness instance for user presence tracking.
   */
  awareness: Awareness;

  /**
   * Connect to the collaboration backend.
   * @returns Promise resolving when connection is established
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the collaboration backend.
   * @returns Promise resolving when disconnection is complete
   */
  disconnect(): Promise<void>;

  /**
   * Check if the provider is currently connected.
   */
  isConnected: boolean;

  /**
   * Signal emitted when the document changes.
   */
  onDocumentChange: ISignal<IYjsNotebookProvider, {
    type: string;
    cellId?: string;
    changes: any;
  }>;

  /**
   * Signal emitted when awareness information changes.
   */
  onAwarenessChange: ISignal<IYjsNotebookProvider, {
    users: Array<{userId: string; name: string; cursor?: any}>;
  }>;

  /**
   * Get the underlying notebook model.
   * @returns The notebook model instance
   */
  getNotebookModel(): any;

  /**
   * Synchronize the notebook model with the Yjs document.
   * @returns Promise resolving when synchronization is complete
   */
  syncWithYjs(): Promise<void>;

  /**
   * Dispose of the provider and cleanup resources.
   */
  dispose(): void;
}

/**
 * Token for injecting the IYjsNotebookProvider dependency.
 */
export const IYjsNotebookProviderToken = new Token<IYjsNotebookProvider>(
  '@jupyter-notebook/notebook:IYjsNotebookProvider',
  'Provider for Yjs-based collaborative notebook editing.'
);

/**
 * Interface for managing collaborative editing sessions.
 * Handles session creation, joining, and participant management.
 */
export interface ICollaborativeSessionManager extends IDisposable {
  /**
   * Create a new collaborative session.
   * @param options Session creation options
   * @returns Promise resolving to the created session
   */
  createSession(options: {
    notebookPath: string;
    sessionId?: string;
    permissions?: {[userId: string]: 'view' | 'edit' | 'admin'};
  }): Promise<{
    sessionId: string;
    notebookPath: string;
    createdAt: Date;
    createdBy: string;
  }>;

  /**
   * Join an existing collaborative session.
   * @param sessionId The session ID to join
   * @returns Promise resolving to session information
   */
  joinSession(sessionId: string): Promise<{
    sessionId: string;
    notebookPath: string;
    participants: Array<{userId: string; name: string; role: string}>;
    joinedAt: Date;
  }>;

  /**
   * Leave a collaborative session.
   * @param sessionId The session ID to leave
   * @returns Promise resolving when session is left
   */
  leaveSession(sessionId: string): Promise<void>;

  /**
   * Get information about the active session.
   * @returns Promise resolving to active session information or null
   */
  getActiveSession(): Promise<{
    sessionId: string;
    notebookPath: string;
    participants: Array<{userId: string; name: string; role: string}>;
    isActive: boolean;
  } | null>;

  /**
   * Get participants in a session.
   * @param sessionId The session ID
   * @returns Promise resolving to session participants
   */
  getSessionParticipants(sessionId: string): Promise<Array<{
    userId: string;
    name: string;
    role: 'view' | 'edit' | 'admin';
    joinedAt: Date;
    isActive: boolean;
  }>>;

  /**
   * Signal emitted when a session is created.
   */
  onSessionCreated: ISignal<ICollaborativeSessionManager, {
    sessionId: string;
    notebookPath: string;
    createdBy: string;
  }>;

  /**
   * Signal emitted when a session is joined.
   */
  onSessionJoined: ISignal<ICollaborativeSessionManager, {
    sessionId: string;
    userId: string;
    userName: string;
  }>;

  /**
   * Signal emitted when a session is left.
   */
  onSessionLeft: ISignal<ICollaborativeSessionManager, {
    sessionId: string;
    userId: string;
    userName: string;
  }>;

  /**
   * Signal emitted when a participant joins a session.
   */
  onParticipantJoined: ISignal<ICollaborativeSessionManager, {
    sessionId: string;
    userId: string;
    userName: string;
    role: string;
  }>;

  /**
   * Signal emitted when a participant leaves a session.
   */
  onParticipantLeft: ISignal<ICollaborativeSessionManager, {
    sessionId: string;
    userId: string;
    userName: string;
  }>;

  /**
   * Dispose of the session manager and cleanup resources.
   */
  dispose(): void;
}

/**
 * Token for injecting the ICollaborativeSessionManager dependency.
 */
export const ICollaborativeSessionManagerToken = new Token<ICollaborativeSessionManager>(
  '@jupyter-notebook/notebook:ICollaborativeSessionManager',
  'Service for managing collaborative editing sessions.'
);

/**
 * Interface for collaborative notebook models that extend standard notebook functionality.
 * Provides collaborative features on top of the base notebook model.
 */
export interface ICollaborativeNotebookModel extends IDisposable {
  /**
   * Check if the notebook is in collaborative mode.
   */
  isCollaborative: boolean;

  /**
   * Get list of current collaborators.
   * @returns Array of collaborator information
   */
  getCollaborators(): Array<{
    userId: string;
    name: string;
    role: 'view' | 'edit' | 'admin';
    isActive: boolean;
  }>;

  /**
   * Get the Yjs provider for this notebook.
   * @returns The Yjs provider instance
   */
  getYjsProvider(): IYjsNotebookProvider;

  /**
   * Lock a cell for exclusive editing.
   * @param cellId The cell ID to lock
   * @returns Promise resolving to true if lock was acquired
   */
  lockCell(cellId: string): Promise<boolean>;

  /**
   * Unlock a cell.
   * @param cellId The cell ID to unlock
   * @returns Promise resolving when cell is unlocked
   */
  unlockCell(cellId: string): Promise<void>;

  /**
   * Add a comment to a cell.
   * @param cellId The cell ID
   * @param content The comment content
   * @returns Promise resolving to the added comment
   */
  addComment(cellId: string, content: string): Promise<{
    id: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
  }>;

  /**
   * Get comments for a cell.
   * @param cellId The cell ID
   * @returns Promise resolving to cell comments
   */
  getComments(cellId: string): Promise<Array<{
    id: string;
    content: string;
    author: {userId: string; name: string};
    timestamp: Date;
    isResolved: boolean;
  }>>;

  /**
   * Get change history for the notebook.
   * @param limit Maximum number of history entries to return
   * @returns Promise resolving to change history
   */
  getHistory(limit?: number): Promise<Array<{
    id: string;
    type: string;
    cellId: string;
    userId: string;
    userName: string;
    timestamp: Date;
    description: string;
  }>>;

  /**
   * Signal emitted when a collaborator joins.
   */
  onCollaboratorJoined: ISignal<ICollaborativeNotebookModel, {
    userId: string;
    name: string;
    role: string;
  }>;

  /**
   * Signal emitted when a collaborator leaves.
   */
  onCollaboratorLeft: ISignal<ICollaborativeNotebookModel, {
    userId: string;
    name: string;
  }>;

  /**
   * Signal emitted when a cell is locked.
   */
  onCellLocked: ISignal<ICollaborativeNotebookModel, {
    cellId: string;
    userId: string;
    userName: string;
  }>;

  /**
   * Signal emitted when a cell is unlocked.
   */
  onCellUnlocked: ISignal<ICollaborativeNotebookModel, {
    cellId: string;
    userId: string;
    userName: string;
  }>;

  /**
   * Signal emitted when a comment is added.
   */
  onCommentAdded: ISignal<ICollaborativeNotebookModel, {
    cellId: string;
    commentId: string;
    content: string;
    author: {userId: string; name: string};
  }>;
}

/**
 * Token for injecting the ICollaborativeNotebookModel dependency.
 */
export const ICollaborativeNotebookModelToken = new Token<ICollaborativeNotebookModel>(
  '@jupyter-notebook/notebook:ICollaborativeNotebookModel',
  'Model for collaborative notebook functionality.'
);

/**
 * Interface for creating collaborative notebook models.
 * Factory for instantiating collaborative notebook models with proper configuration.
 */
export interface ICollaborativeNotebookModelFactory extends IDisposable {
  /**
   * Create a standard notebook model.
   * @param options Model creation options
   * @returns Promise resolving to the created model
   */
  createModel(options?: any): Promise<any>;

  /**
   * Create a collaborative notebook model.
   * @param options Collaborative model creation options
   * @returns Promise resolving to the created collaborative model
   */
  createCollaborativeModel(options: {
    path: string;
    sessionId?: string;
    permissions?: {[userId: string]: 'view' | 'edit' | 'admin'};
    collaborative?: boolean;
  }): Promise<ICollaborativeNotebookModel>;

  /**
   * Supported content types for this factory.
   */
  supportedTypes: string[];

  /**
   * The name of this factory.
   */
  name: string;

  /**
   * The file type this factory handles.
   */
  fileType: string;

  /**
   * The widget name for notebooks created by this factory.
   */
  widgetName: string;

  /**
   * The file format this factory handles.
   */
  fileFormat: string;

  /**
   * Whether this factory can start kernels.
   */
  canStartKernel: boolean;

  /**
   * Whether this factory is disposed.
   */
  isDisposed: boolean;

  /**
   * Dispose of the factory and cleanup resources.
   */
  dispose(): void;
}

/**
 * Token for injecting the ICollaborativeNotebookModelFactory dependency.
 */
export const ICollaborativeNotebookModelFactoryToken = new Token<ICollaborativeNotebookModelFactory>(
  '@jupyter-notebook/notebook:ICollaborativeNotebookModelFactory',
  'Factory for creating collaborative notebook models.'
);