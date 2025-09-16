/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Extended notebook interfaces and dependency injection tokens for collaboration features.
 * Defines new interfaces for collaborative notebooks, extends INotebookTracker for collaboration events,
 * and provides tokens for the collaborative services to be injected via Lumino's dependency injection system.
 */

import { Token } from '@lumino/coreutils';
import { ISignal } from '@lumino/signaling';
import { INotebookTracker } from '@jupyterlab/notebook';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

/**
 * Collaborative Role enumeration defining access levels for users
 */
export enum CollaborativeRole {
  VIEWER = 'viewer',
  EDITOR = 'editor',
  ADMIN = 'admin'
}

/**
 * Interface representing a collaborative user in the session
 */
export interface ICollaborativeUser {
  /**
   * Unique identifier for the user
   */
  readonly userId: string;

  /**
   * Username for display purposes
   */
  readonly username: string;

  /**
   * Display name for the user (may differ from username)
   */
  readonly displayName: string;

  /**
   * Avatar URL or identifier for the user
   */
  readonly avatar: string;

  /**
   * Assigned color for user identification in UI
   */
  readonly color: string;

  /**
   * Current cursor position in the document
   */
  readonly cursorPosition: { cellId: string; offset: number } | null;

  /**
   * List of currently selected cells
   */
  readonly selectedCells: string[];

  /**
   * Whether the user is currently active/online
   */
  readonly isActive: boolean;

  /**
   * Timestamp of last user activity
   */
  readonly lastActivity: Date;
}

/**
 * Interface representing a collaborative session
 */
export interface ICollaborativeSession {
  /**
   * Unique identifier for the collaboration session
   */
  readonly sessionId: string;

  /**
   * Path to the notebook being collaborated on
   */
  readonly notebookPath: string;

  /**
   * List of active users in the session
   */
  readonly activeUsers: ICollaborativeUser[];

  /**
   * Timestamp when the session started
   */
  readonly startTime: Date;

  /**
   * Current permission settings for the session
   */
  readonly permissions: Record<string, CollaborativeRole>;

  /**
   * Current lock states for cells
   */
  readonly lockStates: Record<string, ICellLockStatus>;

  /**
   * Whether the session is currently active
   */
  readonly isActive: boolean;
}

/**
 * Interface representing cell lock status
 */
export interface ICellLockStatus {
  /**
   * ID of the cell that is locked
   */
  readonly cellId: string;

  /**
   * User ID of who currently holds the lock
   */
  readonly lockedBy: string | null;

  /**
   * Timestamp when the lock was acquired
   */
  readonly lockTime: Date | null;

  /**
   * Lock timeout duration in milliseconds
   */
  readonly timeout: number;

  /**
   * Whether the cell is currently locked
   */
  readonly isLocked: boolean;

  /**
   * Queue of users waiting for lock
   */
  readonly queuedUsers: string[];
}

/**
 * Interface representing a comment in the collaboration system
 */
export interface IComment {
  /**
   * Unique identifier for the comment
   */
  readonly id: string;

  /**
   * Author of the comment
   */
  readonly author: ICollaborativeUser;

  /**
   * Content/text of the comment
   */
  readonly content: string;

  /**
   * ID of the cell this comment is attached to
   */
  readonly cellId: string;

  /**
   * Timestamp when comment was created
   */
  readonly timestamp: Date;

  /**
   * Parent comment ID for threaded discussions
   */
  readonly parentId: string | null;

  /**
   * Replies to this comment
   */
  readonly replies: IComment[];

  /**
   * Whether the comment has been resolved
   */
  readonly isResolved: boolean;

  /**
   * List of user mentions in the comment
   */
  readonly mentions: string[];
}

/**
 * Interface representing a version snapshot
 */
export interface IVersionSnapshot {
  /**
   * Unique identifier for the version
   */
  readonly id: string;

  /**
   * Timestamp when version was captured
   */
  readonly timestamp: Date;

  /**
   * Author of the changes in this version
   */
  readonly author: ICollaborativeUser;

  /**
   * Summary of changes in this version
   */
  readonly changeSummary: string;

  /**
   * Cell-level changes in this version
   */
  readonly cellChanges: Record<string, any>;

  /**
   * Metadata associated with this version
   */
  readonly metadata: Record<string, any>;

  /**
   * Size of the version data in bytes
   */
  readonly size: number;
}

/**
 * Core collaboration provider interface for managing Yjs document integration
 */
export interface ICollaborationProvider {
  /**
   * The underlying Yjs document instance
   */
  readonly yjsDoc: Y.Doc;

  /**
   * WebSocket provider for real-time synchronization
   */
  readonly websocketProvider: any;

  /**
   * Establish connection to collaboration server
   */
  connect(): Promise<void>;

  /**
   * Disconnect from collaboration server
   */
  disconnect(): Promise<void>;

  /**
   * Synchronize Yjs document with notebook model
   */
  syncWithModel(model: any): Promise<void>;

  /**
   * Register handler for document updates
   */
  onUpdate(handler: (update: Uint8Array) => void): void;

  /**
   * Enable or disable collaboration features
   */
  enableCollaboration(enabled: boolean): void;

  /**
   * Check if currently connected to collaboration server
   */
  isConnected(): boolean;

  /**
   * Configure update batching for performance optimization
   */
  batching(enabled: boolean, timeout?: number): void;

  /**
   * Get telemetry data for monitoring collaboration performance
   */
  telemetry(): Record<string, any>;
}

/**
 * User awareness and presence management interface
 */
export interface ICollaborationAwareness {
  /**
   * The underlying Yjs awareness instance
   */
  readonly awareness: Awareness;

  /**
   * Update local user information
   */
  updateLocalUser(user: Partial<ICollaborativeUser>): void;

  /**
   * Get information for a specific user
   */
  getUserInfo(userId: string): ICollaborativeUser | null;

  /**
   * Get current cursor position for a user
   */
  getCursorPosition(userId: string): { cellId: string; offset: number } | null;

  /**
   * Get selected cells for a user
   */
  getSelectedCells(userId: string): string[];

  /**
   * Set presence timeout for inactive users
   */
  setPresenceTimeout(timeout: number): void;

  /**
   * Broadcast awareness update to all clients
   */
  broadcastAwareness(): void;

  /**
   * Signal emitted when a user joins the session
   */
  readonly onUserJoin: ISignal<ICollaborationAwareness, ICollaborativeUser>;

  /**
   * Signal emitted when a user leaves the session
   */
  readonly onUserLeave: ISignal<ICollaborationAwareness, ICollaborativeUser>;

  /**
   * Get list of all currently active users
   */
  readonly activeUsers: ICollaborativeUser[];
}

/**
 * Cell-level locking management interface
 */
export interface ICellLockManager {
  /**
   * Acquire exclusive lock on a cell
   */
  acquireLock(cellId: string, userId: string): Promise<boolean>;

  /**
   * Release lock on a cell
   */
  releaseLock(cellId: string, userId: string): Promise<void>;

  /**
   * Check if a cell is currently locked
   */
  isLocked(cellId: string): boolean;

  /**
   * Get detailed lock status for a cell
   */
  lockStatus(cellId: string): ICellLockStatus | null;

  /**
   * Transfer lock ownership to another user
   */
  transferLock(cellId: string, fromUserId: string, toUserId: string): Promise<boolean>;

  /**
   * Add user to lock acquisition queue
   */
  queueLock(cellId: string, userId: string): Promise<void>;

  /**
   * Set timeout for automatic lock release
   */
  setLockTimeout(timeout: number): void;

  /**
   * Signal emitted when lock state changes
   */
  readonly onLockChange: ISignal<ICellLockManager, { cellId: string; status: ICellLockStatus }>;

  /**
   * Clean up stale or expired locks
   */
  cleanupLocks(): Promise<void>;
}

/**
 * Version history and change tracking interface
 */
export interface IHistoryTracker {
  /**
   * Capture a snapshot of the current document state
   */
  captureSnapshot(metadata?: Record<string, any>): Promise<string>;

  /**
   * Get version history for the document
   */
  getHistory(limit?: number): Promise<IVersionSnapshot[]>;

  /**
   * Restore document to a specific version
   */
  restoreVersion(versionId: string): Promise<void>;

  /**
   * Get diff between two versions
   */
  getDiff(fromVersion: string, toVersion: string): Promise<any>;

  /**
   * Browse available versions with pagination
   */
  browseVersions(offset?: number, limit?: number): Promise<{ versions: IVersionSnapshot[]; total: number }>;

  /**
   * Export version history as downloadable format
   */
  exportHistory(format?: 'json' | 'csv'): Promise<Blob>;

  /**
   * Signal emitted when a new version is created
   */
  readonly onVersionChange: ISignal<IHistoryTracker, IVersionSnapshot>;

  /**
   * Get metadata for a specific version
   */
  getVersionMetadata(versionId: string): Promise<Record<string, any>>;

  /**
   * Compress old snapshots to save storage space
   */
  compressSnapshots(): Promise<void>;
}

/**
 * Permission and access control management interface
 */
export interface IPermissionManager {
  /**
   * Check if a user has specific permission
   */
  checkPermission(userId: string, permission: string): Promise<boolean>;

  /**
   * Set permission for a user
   */
  setPermission(userId: string, permission: string, granted: boolean): Promise<void>;

  /**
   * Revoke all permissions for a user
   */
  revokePermission(userId: string): Promise<void>;

  /**
   * Get role for a specific user
   */
  getUserRole(userId: string): Promise<CollaborativeRole>;

  /**
   * Check if user is in view-only mode
   */
  isViewOnly(userId: string): Promise<boolean>;

  /**
   * Check if user can edit the document
   */
  canEdit(userId: string): Promise<boolean>;

  /**
   * Check if user has admin privileges
   */
  isAdmin(userId: string): Promise<boolean>;

  /**
   * Update multiple permissions at once
   */
  updatePermissions(permissions: Record<string, CollaborativeRole>): Promise<void>;

  /**
   * Get audit log of permission changes
   */
  auditLog(): Promise<Array<{ userId: string; permission: string; timestamp: Date; action: string }>>;
}

/**
 * Comment and review system interface
 */
export interface ICommentStore {
  /**
   * Create a new comment
   */
  create(content: string, cellId: string, parentId?: string): Promise<IComment>;

  /**
   * Read/retrieve a specific comment
   */
  read(commentId: string): Promise<IComment | null>;

  /**
   * Update an existing comment
   */
  update(commentId: string, content: string): Promise<IComment>;

  /**
   * Delete a comment
   */
  delete(commentId: string): Promise<void>;

  /**
   * Add a reply to an existing comment
   */
  addReply(parentId: string, content: string): Promise<IComment>;

  /**
   * Mark a comment as resolved
   */
  resolveComment(commentId: string): Promise<void>;

  /**
   * Subscribe to comment notifications
   */
  subscribeToNotifications(callback: (comment: IComment, action: string) => void): void;

  /**
   * Get threaded comments for better organization
   */
  getThreadedComments(cellId: string): Promise<IComment[]>;

  /**
   * Export comments to external format
   */
  exportComments(format?: 'json' | 'csv'): Promise<Blob>;

  /**
   * Get specific comment by ID
   */
  getCommentById(id: string): Promise<IComment | null>;

  /**
   * Get all comments for a specific cell
   */
  getCommentsByCell(cellId: string): Promise<IComment[]>;

  /**
   * Get all comments by a specific user
   */
  getCommentsByUser(userId: string): Promise<IComment[]>;

  /**
   * Mark comment as read by current user
   */
  markAsRead(commentId: string): Promise<void>;

  /**
   * Get count of unread notifications
   */
  getNotificationCount(): Promise<number>;
}

/**
 * Extended notebook tracker interface for collaboration events and session management
 */
export interface ICollaborativeNotebookTracker extends INotebookTracker {
  /**
   * Active collaborative sessions mapped by notebook path
   */
  readonly collaborativeSessions: Map<string, ICollaborativeSession>;

  /**
   * Signal emitted when a collaborative session is started
   */
  readonly onSessionStarted: ISignal<ICollaborativeNotebookTracker, ICollaborativeSession>;

  /**
   * Signal emitted when a collaborative session is ended
   */
  readonly onSessionEnded: ISignal<ICollaborativeNotebookTracker, ICollaborativeSession>;

  /**
   * Signal emitted when a user joins a session
   */
  readonly onUserJoined: ISignal<ICollaborativeNotebookTracker, { session: ICollaborativeSession; user: ICollaborativeUser }>;

  /**
   * Signal emitted when a user leaves a session
   */
  readonly onUserLeft: ISignal<ICollaborativeNotebookTracker, { session: ICollaborativeSession; user: ICollaborativeUser }>;

  /**
   * Signal emitted when user presence information changes
   */
  readonly onPresenceChanged: ISignal<ICollaborativeNotebookTracker, { session: ICollaborativeSession; user: ICollaborativeUser }>;

  /**
   * Get list of all active users across all sessions
   */
  readonly activeUsers: ICollaborativeUser[];

  /**
   * Get collaborative session for a specific notebook
   */
  getCollaborativeSession(notebookPath: string): ICollaborativeSession | null;
}

// Dependency Injection Tokens for Lumino DI System

/**
 * Token for the collaboration provider service
 */
export const ICollaborationProviderToken = new Token<ICollaborationProvider>(
  '@jupyterlab/notebook:ICollaborationProvider',
  'Service for managing Yjs document integration and real-time synchronization'
);

/**
 * Token for the collaboration awareness service
 */
export const ICollaborationAwarenessToken = new Token<ICollaborationAwareness>(
  '@jupyterlab/notebook:ICollaborationAwareness',
  'Service for managing user presence and awareness in collaborative sessions'
);

/**
 * Token for the cell lock manager service
 */
export const ICellLockManagerToken = new Token<ICellLockManager>(
  '@jupyterlab/notebook:ICellLockManager',
  'Service for managing cell-level locking in collaborative editing'
);

/**
 * Token for the history tracker service
 */
export const IHistoryTrackerToken = new Token<IHistoryTracker>(
  '@jupyterlab/notebook:IHistoryTracker',
  'Service for version history tracking and management'
);

/**
 * Token for the permission manager service
 */
export const IPermissionManagerToken = new Token<IPermissionManager>(
  '@jupyterlab/notebook:IPermissionManager',
  'Service for managing permissions and access control in collaborative sessions'
);

/**
 * Token for the comment store service
 */
export const ICommentStoreToken = new Token<ICommentStore>(
  '@jupyterlab/notebook:ICommentStore',
  'Service for managing comments and review workflows in collaborative notebooks'
);
