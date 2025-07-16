import { Token } from '@lumino/coreutils';

/**
 * The INotebookPathOpener interface.
 */
export interface INotebookPathOpener {
  /**
   * Open a path in the application.
   *
   * @param options - The options used to open the path.
   */
  open: (options: INotebookPathOpener.IOpenOptions) => WindowProxy | null;
}

export namespace INotebookPathOpener {
  /**
   * The options used to open a path in the application.
   */
  export interface IOpenOptions {
    /**
     * The URL prefix, which should include the base URL
     */
    prefix: string;

    /**
     * The path to open in the application, e.g `setup.py`, or `notebooks/example.ipynb`
     */
    path?: string;

    /**
     * The extra search params to use in the URL.
     */
    searchParams?: URLSearchParams;

    /**
     * Name of the browsing context the resource is being loaded into.
     * See https://developer.mozilla.org/en-US/docs/Web/API/Window/open for more details.
     */
    target?: string;

    /**
     *
     * See https://developer.mozilla.org/en-US/docs/Web/API/Window/open for more details.
     */
    features?: string;
  }
}

/**
 * The INotebookPathOpener token.
 * The main purpose of this token is to allow other extensions or downstream applications
 * to override the default behavior of opening a notebook in a new tab.
 * It also allows passing the path as a URL search parameter, or other options to the window.open call.
 */
export const INotebookPathOpener = new Token<INotebookPathOpener>(
  '@jupyter-notebook/application:INotebookPathOpener'
);

/**
 * The ICollaborationManager interface.
 */
export interface ICollaborationManager {
  /**
   * Initialize a collaborative session for a notebook.
   *
   * @param options - The options for initializing the collaboration session.
   * @returns A promise that resolves to the collaborative session object.
   */
  initializeSession(options: ICollaborationManager.ISessionOptions): Promise<ICollaborationManager.ISession>;

  /**
   * Join an existing collaborative session.
   *
   * @param sessionId - The ID of the session to join.
   * @param user - The user information.
   * @returns A promise that resolves to the joined session.
   */
  joinSession(sessionId: string, user: ICollaborationManager.IUser): Promise<ICollaborationManager.ISession>;

  /**
   * Leave a collaborative session.
   *
   * @param sessionId - The ID of the session to leave.
   * @returns A promise that resolves when the session is left.
   */
  leaveSession(sessionId: string): Promise<void>;

  /**
   * Get the current active session.
   */
  readonly currentSession: ICollaborationManager.ISession | null;

  /**
   * Whether collaboration is enabled.
   */
  readonly isEnabled: boolean;
}

export namespace ICollaborationManager {
  /**
   * Options for initializing a collaborative session.
   */
  export interface ISessionOptions {
    /**
     * The path to the notebook file.
     */
    notebookPath: string;

    /**
     * The user information.
     */
    user: IUser;

    /**
     * Whether to enable persistence.
     */
    enablePersistence?: boolean;
  }

  /**
   * Information about a collaborative session.
   */
  export interface ISession {
    /**
     * The unique session ID.
     */
    readonly id: string;

    /**
     * The notebook path.
     */
    readonly notebookPath: string;

    /**
     * The list of active users in the session.
     */
    readonly users: IUser[];

    /**
     * The connection status.
     */
    readonly connectionStatus: 'connected' | 'connecting' | 'disconnected';

    /**
     * Terminate the session.
     */
    terminate(): Promise<void>;
  }

  /**
   * User information for collaboration.
   */
  export interface IUser {
    /**
     * The unique user ID.
     */
    readonly id: string;

    /**
     * The user's display name.
     */
    readonly name: string;

    /**
     * The user's avatar URL.
     */
    readonly avatar?: string;

    /**
     * The user's color for presence indicators.
     */
    readonly color: string;
  }
}

/**
 * The ICollaborationManager token.
 */
export const ICollaborationManager = new Token<ICollaborationManager>(
  '@jupyter-notebook/application:ICollaborationManager'
);

/**
 * The IUserAwareness interface.
 */
export interface IUserAwareness {
  /**
   * Set the current user's cursor position.
   *
   * @param position - The cursor position information.
   */
  setCursorPosition(position: IUserAwareness.ICursorPosition): void;

  /**
   * Set the current user's selection.
   *
   * @param selection - The selection information.
   */
  setSelection(selection: IUserAwareness.ISelection): void;

  /**
   * Get awareness information for all users.
   *
   * @returns A map of user IDs to their awareness data.
   */
  getAwarenessStates(): Map<string, IUserAwareness.IAwarenessState>;

  /**
   * Subscribe to awareness changes.
   *
   * @param callback - The callback function to call when awareness changes.
   * @returns A disposable to unsubscribe from the changes.
   */
  onAwarenessChanged(callback: (states: Map<string, IUserAwareness.IAwarenessState>) => void): IUserAwareness.IDisposable;

  /**
   * Update the current user's local state.
   *
   * @param state - The local state to update.
   */
  updateLocalState(state: IUserAwareness.ILocalState): void;
}

export namespace IUserAwareness {
  /**
   * Cursor position information.
   */
  export interface ICursorPosition {
    /**
     * The cell ID where the cursor is located.
     */
    cellId: string;

    /**
     * The line number within the cell.
     */
    line: number;

    /**
     * The column number within the line.
     */
    column: number;
  }

  /**
   * Selection information.
   */
  export interface ISelection {
    /**
     * The cell ID where the selection is located.
     */
    cellId: string;

    /**
     * The start position of the selection.
     */
    start: {
      line: number;
      column: number;
    };

    /**
     * The end position of the selection.
     */
    end: {
      line: number;
      column: number;
    };
  }

  /**
   * Complete awareness state for a user.
   */
  export interface IAwarenessState {
    /**
     * The user information.
     */
    user: {
      id: string;
      name: string;
      avatar?: string;
      color: string;
    };

    /**
     * The current cursor position.
     */
    cursor?: ICursorPosition;

    /**
     * The current selection.
     */
    selection?: ISelection;

    /**
     * The last activity timestamp.
     */
    lastActivity: number;

    /**
     * Whether the user is currently active.
     */
    isActive: boolean;
  }

  /**
   * Local state information.
   */
  export interface ILocalState {
    /**
     * The current focus state.
     */
    hasFocus: boolean;

    /**
     * The current editing state.
     */
    isEditing: boolean;

    /**
     * The current cell ID being edited.
     */
    currentCellId?: string;
  }

  /**
   * Disposable interface for unsubscribing from events.
   */
  export interface IDisposable {
    dispose(): void;
  }
}

/**
 * The IUserAwareness token.
 */
export const IUserAwareness = new Token<IUserAwareness>(
  '@jupyter-notebook/application:IUserAwareness'
);

/**
 * The ILockManager interface.
 */
export interface ILockManager {
  /**
   * Acquire a lock for a specific cell.
   *
   * @param cellId - The ID of the cell to lock.
   * @param userId - The ID of the user requesting the lock.
   * @returns A promise that resolves to the lock information if successful.
   */
  acquireLock(cellId: string, userId: string): Promise<ILockManager.ILock | null>;

  /**
   * Release a lock for a specific cell.
   *
   * @param cellId - The ID of the cell to unlock.
   * @param userId - The ID of the user releasing the lock.
   * @returns A promise that resolves when the lock is released.
   */
  releaseLock(cellId: string, userId: string): Promise<void>;

  /**
   * Check if a cell is locked.
   *
   * @param cellId - The ID of the cell to check.
   * @returns The lock information if the cell is locked, null otherwise.
   */
  getLock(cellId: string): ILockManager.ILock | null;

  /**
   * Get all current locks.
   *
   * @returns A map of cell IDs to their lock information.
   */
  getAllLocks(): Map<string, ILockManager.ILock>;

  /**
   * Subscribe to lock changes.
   *
   * @param callback - The callback function to call when locks change.
   * @returns A disposable to unsubscribe from the changes.
   */
  onLockChanged(callback: (locks: Map<string, ILockManager.ILock>) => void): ILockManager.IDisposable;

  /**
   * Force release all locks for a specific user.
   *
   * @param userId - The ID of the user whose locks should be released.
   * @returns A promise that resolves when all locks are released.
   */
  forceReleaseUserLocks(userId: string): Promise<void>;
}

export namespace ILockManager {
  /**
   * Lock information.
   */
  export interface ILock {
    /**
     * The ID of the cell that is locked.
     */
    readonly cellId: string;

    /**
     * The ID of the user who owns the lock.
     */
    readonly userId: string;

    /**
     * The display name of the user who owns the lock.
     */
    readonly userName: string;

    /**
     * The timestamp when the lock was acquired.
     */
    readonly acquiredAt: number;

    /**
     * The timestamp when the lock expires.
     */
    readonly expiresAt: number;

    /**
     * Whether the lock is currently active.
     */
    readonly isActive: boolean;
  }

  /**
   * Disposable interface for unsubscribing from events.
   */
  export interface IDisposable {
    dispose(): void;
  }
}

/**
 * The ILockManager token.
 */
export const ILockManager = new Token<ILockManager>(
  '@jupyter-notebook/application:ILockManager'
);

/**
 * The IHistoryManager interface.
 */
export interface IHistoryManager {
  /**
   * Get the version history for a notebook.
   *
   * @param notebookPath - The path to the notebook.
   * @returns A promise that resolves to the version history.
   */
  getVersionHistory(notebookPath: string): Promise<IHistoryManager.IVersionHistory>;

  /**
   * Create a new version snapshot.
   *
   * @param notebookPath - The path to the notebook.
   * @param metadata - Additional metadata for the version.
   * @returns A promise that resolves to the created version.
   */
  createVersion(notebookPath: string, metadata?: IHistoryManager.IVersionMetadata): Promise<IHistoryManager.IVersion>;

  /**
   * Restore a notebook to a specific version.
   *
   * @param notebookPath - The path to the notebook.
   * @param versionId - The ID of the version to restore.
   * @returns A promise that resolves when the restoration is complete.
   */
  restoreVersion(notebookPath: string, versionId: string): Promise<void>;

  /**
   * Get detailed changes for a specific version.
   *
   * @param notebookPath - The path to the notebook.
   * @param versionId - The ID of the version.
   * @returns A promise that resolves to the version changes.
   */
  getVersionChanges(notebookPath: string, versionId: string): Promise<IHistoryManager.IVersionChanges>;

  /**
   * Subscribe to version changes.
   *
   * @param callback - The callback function to call when versions change.
   * @returns A disposable to unsubscribe from the changes.
   */
  onVersionChanged(callback: (version: IHistoryManager.IVersion) => void): IHistoryManager.IDisposable;

  /**
   * Get the change attribution for a specific range.
   *
   * @param notebookPath - The path to the notebook.
   * @param cellId - The ID of the cell.
   * @param startIndex - The start index of the range.
   * @param endIndex - The end index of the range.
   * @returns A promise that resolves to the attribution information.
   */
  getChangeAttribution(notebookPath: string, cellId: string, startIndex: number, endIndex: number): Promise<IHistoryManager.IAttribution[]>;
}

export namespace IHistoryManager {
  /**
   * Version history information.
   */
  export interface IVersionHistory {
    /**
     * The notebook path.
     */
    readonly notebookPath: string;

    /**
     * The list of versions.
     */
    readonly versions: IVersion[];

    /**
     * The current version ID.
     */
    readonly currentVersionId: string;
  }

  /**
   * Version information.
   */
  export interface IVersion {
    /**
     * The unique version ID.
     */
    readonly id: string;

    /**
     * The timestamp when the version was created.
     */
    readonly createdAt: number;

    /**
     * The user who created the version.
     */
    readonly createdBy: {
      id: string;
      name: string;
    };

    /**
     * The version message or description.
     */
    readonly message?: string;

    /**
     * Additional metadata for the version.
     */
    readonly metadata?: IVersionMetadata;

    /**
     * The size of the version in bytes.
     */
    readonly size: number;

    /**
     * Whether this is the current version.
     */
    readonly isCurrent: boolean;
  }

  /**
   * Version metadata.
   */
  export interface IVersionMetadata {
    /**
     * Tags associated with the version.
     */
    tags?: string[];

    /**
     * Description of the changes.
     */
    description?: string;

    /**
     * Whether this is a manual checkpoint.
     */
    isCheckpoint?: boolean;

    /**
     * Additional custom properties.
     */
    [key: string]: any;
  }

  /**
   * Version changes information.
   */
  export interface IVersionChanges {
    /**
     * The version ID.
     */
    readonly versionId: string;

    /**
     * The list of changes.
     */
    readonly changes: IChange[];

    /**
     * Statistics about the changes.
     */
    readonly statistics: {
      additions: number;
      deletions: number;
      modifications: number;
    };
  }

  /**
   * Individual change information.
   */
  export interface IChange {
    /**
     * The type of change.
     */
    readonly type: 'insert' | 'delete' | 'modify';

    /**
     * The cell ID where the change occurred.
     */
    readonly cellId: string;

    /**
     * The position of the change.
     */
    readonly position: {
      start: number;
      end: number;
    };

    /**
     * The content that was changed.
     */
    readonly content: string;

    /**
     * The user who made the change.
     */
    readonly author: {
      id: string;
      name: string;
    };

    /**
     * The timestamp of the change.
     */
    readonly timestamp: number;
  }

  /**
   * Attribution information for a range of content.
   */
  export interface IAttribution {
    /**
     * The start index of the attributed range.
     */
    readonly startIndex: number;

    /**
     * The end index of the attributed range.
     */
    readonly endIndex: number;

    /**
     * The user who authored this range.
     */
    readonly author: {
      id: string;
      name: string;
      color: string;
    };

    /**
     * The timestamp when this range was authored.
     */
    readonly timestamp: number;

    /**
     * The version ID where this range was introduced.
     */
    readonly versionId: string;
  }

  /**
   * Disposable interface for unsubscribing from events.
   */
  export interface IDisposable {
    dispose(): void;
  }
}

/**
 * The IHistoryManager token.
 */
export const IHistoryManager = new Token<IHistoryManager>(
  '@jupyter-notebook/application:IHistoryManager'
);

/**
 * The IPermissionManager interface.
 */
export interface IPermissionManager {
  /**
   * Check if a user has permission to perform an action.
   *
   * @param userId - The ID of the user.
   * @param action - The action to check.
   * @param resource - The resource to check against.
   * @returns A promise that resolves to true if the user has permission.
   */
  hasPermission(userId: string, action: IPermissionManager.IAction, resource: IPermissionManager.IResource): Promise<boolean>;

  /**
   * Grant permission to a user.
   *
   * @param userId - The ID of the user.
   * @param permission - The permission to grant.
   * @returns A promise that resolves when the permission is granted.
   */
  grantPermission(userId: string, permission: IPermissionManager.IPermission): Promise<void>;

  /**
   * Revoke permission from a user.
   *
   * @param userId - The ID of the user.
   * @param permission - The permission to revoke.
   * @returns A promise that resolves when the permission is revoked.
   */
  revokePermission(userId: string, permission: IPermissionManager.IPermission): Promise<void>;

  /**
   * Get all permissions for a user.
   *
   * @param userId - The ID of the user.
   * @returns A promise that resolves to the user's permissions.
   */
  getUserPermissions(userId: string): Promise<IPermissionManager.IPermission[]>;

  /**
   * Get all permissions for a resource.
   *
   * @param resource - The resource to get permissions for.
   * @returns A promise that resolves to the resource permissions.
   */
  getResourcePermissions(resource: IPermissionManager.IResource): Promise<IPermissionManager.IResourcePermissions>;

  /**
   * Subscribe to permission changes.
   *
   * @param callback - The callback function to call when permissions change.
   * @returns A disposable to unsubscribe from the changes.
   */
  onPermissionChanged(callback: (change: IPermissionManager.IPermissionChange) => void): IPermissionManager.IDisposable;

  /**
   * Update access control for a resource.
   *
   * @param resource - The resource to update.
   * @param permissions - The new permissions configuration.
   * @returns A promise that resolves when the update is complete.
   */
  updateResourcePermissions(resource: IPermissionManager.IResource, permissions: IPermissionManager.IResourcePermissions): Promise<void>;
}

export namespace IPermissionManager {
  /**
   * Action types for permission checking.
   */
  export type IAction = 'read' | 'write' | 'execute' | 'comment' | 'lock' | 'delete' | 'share' | 'admin';

  /**
   * Resource types for permission checking.
   */
  export interface IResource {
    /**
     * The type of resource.
     */
    type: 'notebook' | 'cell' | 'output' | 'comment';

    /**
     * The unique identifier of the resource.
     */
    id: string;

    /**
     * The path to the resource (for notebooks).
     */
    path?: string;

    /**
     * The parent resource (for cells, outputs, comments).
     */
    parent?: IResource;
  }

  /**
   * Permission information.
   */
  export interface IPermission {
    /**
     * The action this permission grants.
     */
    action: IAction;

    /**
     * The resource this permission applies to.
     */
    resource: IResource;

    /**
     * When the permission was granted.
     */
    grantedAt: number;

    /**
     * Who granted the permission.
     */
    grantedBy: string;

    /**
     * When the permission expires (optional).
     */
    expiresAt?: number;

    /**
     * Additional conditions for the permission.
     */
    conditions?: {
      timeRange?: {
        start: number;
        end: number;
      };
      ipRestriction?: string[];
      [key: string]: any;
    };
  }

  /**
   * Resource permissions configuration.
   */
  export interface IResourcePermissions {
    /**
     * The resource these permissions apply to.
     */
    resource: IResource;

    /**
     * The owner of the resource.
     */
    owner: string;

    /**
     * Default permissions for the resource.
     */
    defaultPermissions: IAction[];

    /**
     * User-specific permissions.
     */
    userPermissions: Map<string, IAction[]>;

    /**
     * Group-specific permissions.
     */
    groupPermissions: Map<string, IAction[]>;

    /**
     * Whether the resource is publicly accessible.
     */
    isPublic: boolean;

    /**
     * Whether the resource allows anonymous access.
     */
    allowAnonymous: boolean;
  }

  /**
   * Permission change notification.
   */
  export interface IPermissionChange {
    /**
     * The type of change.
     */
    type: 'grant' | 'revoke' | 'update';

    /**
     * The user affected by the change.
     */
    userId: string;

    /**
     * The permission that changed.
     */
    permission: IPermission;

    /**
     * The timestamp of the change.
     */
    timestamp: number;

    /**
     * Who made the change.
     */
    changedBy: string;
  }

  /**
   * Disposable interface for unsubscribing from events.
   */
  export interface IDisposable {
    dispose(): void;
  }
}

/**
 * The IPermissionManager token.
 */
export const IPermissionManager = new Token<IPermissionManager>(
  '@jupyter-notebook/application:IPermissionManager'
);

/**
 * The ICommentManager interface.
 */
export interface ICommentManager {
  /**
   * Create a new comment.
   *
   * @param options - The options for creating the comment.
   * @returns A promise that resolves to the created comment.
   */
  createComment(options: ICommentManager.ICreateCommentOptions): Promise<ICommentManager.IComment>;

  /**
   * Reply to an existing comment.
   *
   * @param commentId - The ID of the comment to reply to.
   * @param content - The content of the reply.
   * @param author - The author of the reply.
   * @returns A promise that resolves to the created reply.
   */
  replyToComment(commentId: string, content: string, author: ICommentManager.IAuthor): Promise<ICommentManager.IComment>;

  /**
   * Update an existing comment.
   *
   * @param commentId - The ID of the comment to update.
   * @param content - The new content.
   * @returns A promise that resolves when the comment is updated.
   */
  updateComment(commentId: string, content: string): Promise<void>;

  /**
   * Delete a comment.
   *
   * @param commentId - The ID of the comment to delete.
   * @returns A promise that resolves when the comment is deleted.
   */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Get comments for a specific resource.
   *
   * @param resource - The resource to get comments for.
   * @returns A promise that resolves to the comments.
   */
  getComments(resource: ICommentManager.ICommentResource): Promise<ICommentManager.IComment[]>;

  /**
   * Get a comment thread.
   *
   * @param commentId - The ID of the root comment.
   * @returns A promise that resolves to the comment thread.
   */
  getCommentThread(commentId: string): Promise<ICommentManager.ICommentThread>;

  /**
   * Resolve a comment thread.
   *
   * @param commentId - The ID of the comment to resolve.
   * @param userId - The ID of the user resolving the comment.
   * @returns A promise that resolves when the comment is resolved.
   */
  resolveComment(commentId: string, userId: string): Promise<void>;

  /**
   * Subscribe to comment changes.
   *
   * @param callback - The callback function to call when comments change.
   * @returns A disposable to unsubscribe from the changes.
   */
  onCommentChanged(callback: (change: ICommentManager.ICommentChange) => void): ICommentManager.IDisposable;

  /**
   * Get all unresolved comments for a resource.
   *
   * @param resource - The resource to get unresolved comments for.
   * @returns A promise that resolves to the unresolved comments.
   */
  getUnresolvedComments(resource: ICommentManager.ICommentResource): Promise<ICommentManager.IComment[]>;
}

export namespace ICommentManager {
  /**
   * Comment resource information.
   */
  export interface ICommentResource {
    /**
     * The type of resource.
     */
    type: 'notebook' | 'cell' | 'selection';

    /**
     * The unique identifier of the resource.
     */
    id: string;

    /**
     * The path to the notebook (for notebook and cell resources).
     */
    notebookPath?: string;

    /**
     * The cell ID (for cell and selection resources).
     */
    cellId?: string;

    /**
     * The selection range (for selection resources).
     */
    selection?: {
      start: number;
      end: number;
    };
  }

  /**
   * Comment author information.
   */
  export interface IAuthor {
    /**
     * The unique user ID.
     */
    readonly id: string;

    /**
     * The user's display name.
     */
    readonly name: string;

    /**
     * The user's avatar URL.
     */
    readonly avatar?: string;

    /**
     * The user's color.
     */
    readonly color: string;
  }

  /**
   * Options for creating a comment.
   */
  export interface ICreateCommentOptions {
    /**
     * The resource to comment on.
     */
    resource: ICommentResource;

    /**
     * The content of the comment.
     */
    content: string;

    /**
     * The author of the comment.
     */
    author: IAuthor;

    /**
     * The parent comment ID (for replies).
     */
    parentId?: string;

    /**
     * Additional metadata for the comment.
     */
    metadata?: {
      [key: string]: any;
    };
  }

  /**
   * Comment information.
   */
  export interface IComment {
    /**
     * The unique comment ID.
     */
    readonly id: string;

    /**
     * The resource this comment is attached to.
     */
    readonly resource: ICommentResource;

    /**
     * The content of the comment.
     */
    readonly content: string;

    /**
     * The author of the comment.
     */
    readonly author: IAuthor;

    /**
     * The timestamp when the comment was created.
     */
    readonly createdAt: number;

    /**
     * The timestamp when the comment was last updated.
     */
    readonly updatedAt: number;

    /**
     * The parent comment ID (for replies).
     */
    readonly parentId?: string;

    /**
     * The reply count.
     */
    readonly replyCount: number;

    /**
     * Whether the comment is resolved.
     */
    readonly isResolved: boolean;

    /**
     * Who resolved the comment.
     */
    readonly resolvedBy?: IAuthor;

    /**
     * When the comment was resolved.
     */
    readonly resolvedAt?: number;

    /**
     * Additional metadata for the comment.
     */
    readonly metadata?: {
      [key: string]: any;
    };
  }

  /**
   * Comment thread information.
   */
  export interface ICommentThread {
    /**
     * The root comment of the thread.
     */
    readonly rootComment: IComment;

    /**
     * All comments in the thread.
     */
    readonly comments: IComment[];

    /**
     * The total number of comments in the thread.
     */
    readonly totalCount: number;

    /**
     * Whether the thread is resolved.
     */
    readonly isResolved: boolean;

    /**
     * The resource this thread is attached to.
     */
    readonly resource: ICommentResource;
  }

  /**
   * Comment change notification.
   */
  export interface ICommentChange {
    /**
     * The type of change.
     */
    type: 'create' | 'update' | 'delete' | 'resolve' | 'unresolve';

    /**
     * The comment that changed.
     */
    comment: IComment;

    /**
     * The timestamp of the change.
     */
    timestamp: number;

    /**
     * Who made the change.
     */
    changedBy: IAuthor;
  }

  /**
   * Disposable interface for unsubscribing from events.
   */
  export interface IDisposable {
    dispose(): void;
  }
}

/**
 * The ICommentManager token.
 */
export const ICommentManager = new Token<ICommentManager>(
  '@jupyter-notebook/application:ICommentManager'
);
