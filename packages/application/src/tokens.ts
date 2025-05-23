import { Token } from '@lumino/coreutils';
import { ISignal } from '@lumino/signaling';

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
 * The ICollaborationService interface.
 * Manages the overall collaboration state and lifecycle for collaborative editing.
 */
export interface ICollaborationService {
  /**
   * Signal emitted when the collaboration state changes.
   */
  readonly stateChanged: ISignal<ICollaborationService, void>;

  /**
   * Whether collaboration is enabled for the current session.
   */
  readonly isEnabled: boolean;

  /**
   * Whether the current session is connected to the collaboration server.
   */
  readonly isConnected: boolean;

  /**
   * The number of active collaborators in the current session.
   */
  readonly collaboratorCount: number;

  /**
   * Initialize collaboration for a document.
   * 
   * @param documentPath - The path to the document to collaborate on.
   * @param options - Additional options for collaboration initialization.
   * @returns A promise that resolves when collaboration is initialized.
   */
  initialize(documentPath: string, options?: ICollaborationService.IOptions): Promise<void>;

  /**
   * Disconnect from the collaboration session.
   * 
   * @returns A promise that resolves when disconnected.
   */
  disconnect(): Promise<void>;

  /**
   * Reconnect to the collaboration session.
   * 
   * @returns A promise that resolves when reconnected.
   */
  reconnect(): Promise<void>;

  /**
   * Get the current collaboration status.
   * 
   * @returns The current collaboration status.
   */
  getStatus(): ICollaborationService.Status;
}

/**
 * Namespace for ICollaborationService.
 */
export namespace ICollaborationService {
  /**
   * Options for initializing collaboration.
   */
  export interface IOptions {
    /**
     * Whether to automatically connect to the collaboration server.
     */
    autoConnect?: boolean;

    /**
     * The URL of the collaboration server.
     */
    serverUrl?: string;

    /**
     * Additional configuration options for the collaboration provider.
     */
    providerOptions?: { [key: string]: any };
  }

  /**
   * Collaboration status enum.
   */
  export enum Status {
    /**
     * Collaboration is disabled.
     */
    Disabled = 'disabled',

    /**
     * Collaboration is connecting.
     */
    Connecting = 'connecting',

    /**
     * Collaboration is connected.
     */
    Connected = 'connected',

    /**
     * Collaboration is disconnected.
     */
    Disconnected = 'disconnected',

    /**
     * Collaboration encountered an error.
     */
    Error = 'error'
  }
}

/**
 * The ICollaborationService token.
 */
export const ICollaborationService = new Token<ICollaborationService>(
  '@jupyter-notebook/application:ICollaborationService'
);

/**
 * The IAwarenessService interface.
 * Manages user presence and cursor synchronization using the Yjs awareness protocol.
 */
export interface IAwarenessService {
  /**
   * Signal emitted when the awareness state changes.
   */
  readonly stateChanged: ISignal<IAwarenessService, IAwarenessService.IChangeEvent>;

  /**
   * The unique client ID for this user.
   */
  readonly clientID: number;

  /**
   * Get the local user's awareness state.
   * 
   * @returns The local awareness state or null if not set.
   */
  getLocalState(): IAwarenessService.IState | null;

  /**
   * Set the local user's awareness state.
   * 
   * @param state - The awareness state to set, or null to mark as offline.
   */
  setLocalState(state: IAwarenessService.IState | null): void;

  /**
   * Update a specific field in the local user's awareness state.
   * 
   * @param field - The field to update.
   * @param value - The new value for the field.
   */
  setLocalStateField(field: string, value: any): void;

  /**
   * Get all client awareness states (remote and local).
   * 
   * @returns A map from client ID to awareness state.
   */
  getStates(): Map<number, IAwarenessService.IState>;

  /**
   * Get a specific client's awareness state.
   * 
   * @param clientID - The client ID to get the state for.
   * @returns The client's awareness state or null if not found.
   */
  getState(clientID: number): IAwarenessService.IState | null;
}

/**
 * Namespace for IAwarenessService.
 */
export namespace IAwarenessService {
  /**
   * Awareness state interface.
   */
  export interface IState {
    /**
     * User information.
     */
    user?: {
      /**
       * User name.
       */
      name?: string;

      /**
       * User color (CSS color string).
       */
      color?: string;

      /**
       * User avatar URL.
       */
      avatar?: string;

      /**
       * Additional user metadata.
       */
      [key: string]: any;
    };

    /**
     * Cursor information.
     */
    cursor?: {
      /**
       * Cursor position.
       */
      position?: number;

      /**
       * Selection range.
       */
      selection?: {
        /**
         * Selection start position.
         */
        start: number;

        /**
         * Selection end position.
         */
        end: number;
      };

      /**
       * Active cell ID.
       */
      cellId?: string;

      /**
       * Additional cursor metadata.
       */
      [key: string]: any;
    };

    /**
     * Additional awareness state fields.
     */
    [key: string]: any;
  }

  /**
   * Awareness change event interface.
   */
  export interface IChangeEvent {
    /**
     * Client IDs that were added.
     */
    added: number[];

    /**
     * Client IDs that were updated.
     */
    updated: number[];

    /**
     * Client IDs that were removed.
     */
    removed: number[];

    /**
     * The origin of the change.
     */
    origin: any;
  }
}

/**
 * The IAwarenessService token.
 */
export const IAwarenessService = new Token<IAwarenessService>(
  '@jupyter-notebook/application:IAwarenessService'
);

/**
 * The ILockService interface.
 * Manages cell-level locking protocol to prevent concurrent editing conflicts.
 */
export interface ILockService {
  /**
   * Signal emitted when the lock state changes.
   */
  readonly stateChanged: ISignal<ILockService, ILockService.IChangeEvent>;

  /**
   * Acquire a lock on a cell.
   * 
   * @param cellId - The ID of the cell to lock.
   * @param options - Additional options for acquiring the lock.
   * @returns A promise that resolves to true if the lock was acquired, false otherwise.
   */
  acquireLock(cellId: string, options?: ILockService.ILockOptions): Promise<boolean>;

  /**
   * Release a lock on a cell.
   * 
   * @param cellId - The ID of the cell to unlock.
   * @returns A promise that resolves when the lock is released.
   */
  releaseLock(cellId: string): Promise<void>;

  /**
   * Check if a cell is locked.
   * 
   * @param cellId - The ID of the cell to check.
   * @returns True if the cell is locked, false otherwise.
   */
  isLocked(cellId: string): boolean;

  /**
   * Check if a cell is locked by the current user.
   * 
   * @param cellId - The ID of the cell to check.
   * @returns True if the cell is locked by the current user, false otherwise.
   */
  isLockedByMe(cellId: string): boolean;

  /**
   * Get the client ID of the user who has locked a cell.
   * 
   * @param cellId - The ID of the cell to check.
   * @returns The client ID of the user who has locked the cell, or null if the cell is not locked.
   */
  getLockOwner(cellId: string): number | null;

  /**
   * Get all currently locked cells.
   * 
   * @returns A map from cell ID to lock information.
   */
  getAllLocks(): Map<string, ILockService.ILockInfo>;
}

/**
 * Namespace for ILockService.
 */
export namespace ILockService {
  /**
   * Options for acquiring a lock.
   */
  export interface ILockOptions {
    /**
     * The timeout in milliseconds for acquiring the lock.
     */
    timeout?: number;

    /**
     * Whether to force acquire the lock, even if it's already locked by another user.
     */
    force?: boolean;
  }

  /**
   * Lock information interface.
   */
  export interface ILockInfo {
    /**
     * The client ID of the user who has the lock.
     */
    clientId: number;

    /**
     * The timestamp when the lock was acquired.
     */
    timestamp: number;

    /**
     * Additional lock metadata.
     */
    metadata?: { [key: string]: any };
  }

  /**
   * Lock change event interface.
   */
  export interface IChangeEvent {
    /**
     * The type of change.
     */
    type: 'acquired' | 'released' | 'expired' | 'stolen';

    /**
     * The ID of the cell that changed.
     */
    cellId: string;

    /**
     * The client ID of the user who caused the change.
     */
    clientId: number;

    /**
     * The previous lock owner's client ID, if applicable.
     */
    previousOwner?: number;
  }
}

/**
 * The ILockService token.
 */
export const ILockService = new Token<ILockService>(
  '@jupyter-notebook/application:ILockService'
);

/**
 * The IHistoryService interface.
 * Manages change history and versioning for collaborative documents.
 */
export interface IHistoryService {
  /**
   * Signal emitted when the history state changes.
   */
  readonly stateChanged: ISignal<IHistoryService, void>;

  /**
   * Get the version history of the document.
   * 
   * @returns A promise that resolves to an array of version information.
   */
  getVersionHistory(): Promise<IHistoryService.IVersion[]>;

  /**
   * Create a new version snapshot.
   * 
   * @param options - Options for creating the snapshot.
   * @returns A promise that resolves to the created version information.
   */
  createSnapshot(options?: IHistoryService.ISnapshotOptions): Promise<IHistoryService.IVersion>;

  /**
   * Restore the document to a specific version.
   * 
   * @param versionId - The ID of the version to restore to.
   * @returns A promise that resolves when the document is restored.
   */
  restoreVersion(versionId: string): Promise<void>;

  /**
   * Get the changes between two versions.
   * 
   * @param fromVersion - The starting version ID.
   * @param toVersion - The ending version ID.
   * @returns A promise that resolves to the diff between the versions.
   */
  getDiff(fromVersion: string, toVersion: string): Promise<IHistoryService.IDiff>;

  /**
   * Get the changes made by a specific user.
   * 
   * @param clientId - The client ID of the user.
   * @param options - Options for filtering the changes.
   * @returns A promise that resolves to an array of changes made by the user.
   */
  getUserChanges(clientId: number, options?: IHistoryService.IChangeOptions): Promise<IHistoryService.IChange[]>;
}

/**
 * Namespace for IHistoryService.
 */
export namespace IHistoryService {
  /**
   * Version information interface.
   */
  export interface IVersion {
    /**
     * The unique ID of the version.
     */
    id: string;

    /**
     * The timestamp when the version was created.
     */
    timestamp: number;

    /**
     * The client ID of the user who created the version.
     */
    clientId: number;

    /**
     * The user-provided label for the version.
     */
    label?: string;

    /**
     * The user-provided description for the version.
     */
    description?: string;
  }

  /**
   * Options for creating a snapshot.
   */
  export interface ISnapshotOptions {
    /**
     * The label for the snapshot.
     */
    label?: string;

    /**
     * The description for the snapshot.
     */
    description?: string;
  }

  /**
   * Diff information interface.
   */
  export interface IDiff {
    /**
     * The starting version ID.
     */
    fromVersion: string;

    /**
     * The ending version ID.
     */
    toVersion: string;

    /**
     * The changes between the versions.
     */
    changes: IChange[];
  }

  /**
   * Change information interface.
   */
  export interface IChange {
    /**
     * The type of change.
     */
    type: 'insert' | 'delete' | 'update';

    /**
     * The path to the changed element.
     */
    path: string;

    /**
     * The old value, if applicable.
     */
    oldValue?: any;

    /**
     * The new value, if applicable.
     */
    newValue?: any;

    /**
     * The client ID of the user who made the change.
     */
    clientId: number;

    /**
     * The timestamp when the change was made.
     */
    timestamp: number;
  }

  /**
   * Options for filtering changes.
   */
  export interface IChangeOptions {
    /**
     * The starting timestamp for filtering changes.
     */
    startTime?: number;

    /**
     * The ending timestamp for filtering changes.
     */
    endTime?: number;

    /**
     * The maximum number of changes to return.
     */
    limit?: number;
  }
}

/**
 * The IHistoryService token.
 */
export const IHistoryService = new Token<IHistoryService>(
  '@jupyter-notebook/application:IHistoryService'
);

/**
 * The IPermissionsService interface.
 * Manages permissions and access control for collaborative documents.
 */
export interface IPermissionsService {
  /**
   * Signal emitted when permissions change.
   */
  readonly permissionsChanged: ISignal<IPermissionsService, IPermissionsService.IChangeEvent>;

  /**
   * Get the permissions for a document.
   * 
   * @param documentPath - The path to the document.
   * @returns A promise that resolves to the document permissions.
   */
  getDocumentPermissions(documentPath: string): Promise<IPermissionsService.IDocumentPermissions>;

  /**
   * Set the permissions for a document.
   * 
   * @param documentPath - The path to the document.
   * @param permissions - The permissions to set.
   * @returns A promise that resolves when the permissions are set.
   */
  setDocumentPermissions(documentPath: string, permissions: IPermissionsService.IDocumentPermissions): Promise<void>;

  /**
   * Get the permissions for a user on a document.
   * 
   * @param documentPath - The path to the document.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to the user's permissions.
   */
  getUserPermissions(documentPath: string, userId: string): Promise<IPermissionsService.IUserPermissions>;

  /**
   * Set the permissions for a user on a document.
   * 
   * @param documentPath - The path to the document.
   * @param userId - The ID of the user.
   * @param permissions - The permissions to set.
   * @returns A promise that resolves when the permissions are set.
   */
  setUserPermissions(documentPath: string, userId: string, permissions: IPermissionsService.IUserPermissions): Promise<void>;

  /**
   * Check if the current user has a specific permission on a document.
   * 
   * @param documentPath - The path to the document.
   * @param permission - The permission to check.
   * @returns A promise that resolves to true if the user has the permission, false otherwise.
   */
  hasPermission(documentPath: string, permission: IPermissionsService.Permission): Promise<boolean>;

  /**
   * Get all users with access to a document.
   * 
   * @param documentPath - The path to the document.
   * @returns A promise that resolves to a map from user ID to user permissions.
   */
  getDocumentUsers(documentPath: string): Promise<Map<string, IPermissionsService.IUserPermissions>>;
}

/**
 * Namespace for IPermissionsService.
 */
export namespace IPermissionsService {
  /**
   * Permission enum.
   */
  export enum Permission {
    /**
     * Permission to read the document.
     */
    Read = 'read',

    /**
     * Permission to write to the document.
     */
    Write = 'write',

    /**
     * Permission to comment on the document.
     */
    Comment = 'comment',

    /**
     * Permission to manage document permissions.
     */
    Manage = 'manage'
  }

  /**
   * Document permissions interface.
   */
  export interface IDocumentPermissions {
    /**
     * The owner of the document.
     */
    owner: string;

    /**
     * The access mode for the document.
     */
    accessMode: 'private' | 'shared' | 'public';

    /**
     * The default permissions for users with access to the document.
     */
    defaultPermissions: IUserPermissions;
  }

  /**
   * User permissions interface.
   */
  export interface IUserPermissions {
    /**
     * Whether the user can read the document.
     */
    read: boolean;

    /**
     * Whether the user can write to the document.
     */
    write: boolean;

    /**
     * Whether the user can comment on the document.
     */
    comment: boolean;

    /**
     * Whether the user can manage document permissions.
     */
    manage: boolean;
  }

  /**
   * Permissions change event interface.
   */
  export interface IChangeEvent {
    /**
     * The path to the document that changed.
     */
    documentPath: string;

    /**
     * The user ID that changed, if applicable.
     */
    userId?: string;

    /**
     * The new permissions.
     */
    permissions: IDocumentPermissions | IUserPermissions;
  }
}

/**
 * The IPermissionsService token.
 */
export const IPermissionsService = new Token<IPermissionsService>(
  '@jupyter-notebook/application:IPermissionsService'
);

/**
 * The ICommentService interface.
 * Manages comments and review system for collaborative documents.
 */
export interface ICommentService {
  /**
   * Signal emitted when comments change.
   */
  readonly commentsChanged: ISignal<ICommentService, ICommentService.IChangeEvent>;

  /**
   * Add a comment to a document.
   * 
   * @param documentPath - The path to the document.
   * @param comment - The comment to add.
   * @returns A promise that resolves to the added comment with its ID.
   */
  addComment(documentPath: string, comment: ICommentService.IComment): Promise<ICommentService.IComment>;

  /**
   * Update a comment.
   * 
   * @param documentPath - The path to the document.
   * @param commentId - The ID of the comment to update.
   * @param updates - The updates to apply to the comment.
   * @returns A promise that resolves to the updated comment.
   */
  updateComment(documentPath: string, commentId: string, updates: Partial<ICommentService.IComment>): Promise<ICommentService.IComment>;

  /**
   * Delete a comment.
   * 
   * @param documentPath - The path to the document.
   * @param commentId - The ID of the comment to delete.
   * @returns A promise that resolves when the comment is deleted.
   */
  deleteComment(documentPath: string, commentId: string): Promise<void>;

  /**
   * Get all comments for a document.
   * 
   * @param documentPath - The path to the document.
   * @returns A promise that resolves to an array of comments.
   */
  getComments(documentPath: string): Promise<ICommentService.IComment[]>;

  /**
   * Get comments for a specific cell.
   * 
   * @param documentPath - The path to the document.
   * @param cellId - The ID of the cell.
   * @returns A promise that resolves to an array of comments for the cell.
   */
  getCellComments(documentPath: string, cellId: string): Promise<ICommentService.IComment[]>;

  /**
   * Add a reply to a comment.
   * 
   * @param documentPath - The path to the document.
   * @param commentId - The ID of the parent comment.
   * @param reply - The reply to add.
   * @returns A promise that resolves to the added reply with its ID.
   */
  addReply(documentPath: string, commentId: string, reply: ICommentService.IReply): Promise<ICommentService.IReply>;

  /**
   * Update a reply.
   * 
   * @param documentPath - The path to the document.
   * @param commentId - The ID of the parent comment.
   * @param replyId - The ID of the reply to update.
   * @param updates - The updates to apply to the reply.
   * @returns A promise that resolves to the updated reply.
   */
  updateReply(documentPath: string, commentId: string, replyId: string, updates: Partial<ICommentService.IReply>): Promise<ICommentService.IReply>;

  /**
   * Delete a reply.
   * 
   * @param documentPath - The path to the document.
   * @param commentId - The ID of the parent comment.
   * @param replyId - The ID of the reply to delete.
   * @returns A promise that resolves when the reply is deleted.
   */
  deleteReply(documentPath: string, commentId: string, replyId: string): Promise<void>;

  /**
   * Resolve or unresolve a comment.
   * 
   * @param documentPath - The path to the document.
   * @param commentId - The ID of the comment to resolve or unresolve.
   * @param resolved - Whether the comment should be resolved.
   * @returns A promise that resolves to the updated comment.
   */
  resolveComment(documentPath: string, commentId: string, resolved: boolean): Promise<ICommentService.IComment>;
}

/**
 * Namespace for ICommentService.
 */
export namespace ICommentService {
  /**
   * Comment interface.
   */
  export interface IComment {
    /**
     * The unique ID of the comment.
     */
    id?: string;

    /**
     * The ID of the cell the comment is attached to.
     */
    cellId: string;

    /**
     * The content of the comment.
     */
    content: string;

    /**
     * The user ID of the comment author.
     */
    userId: string;

    /**
     * The user name of the comment author.
     */
    userName: string;

    /**
     * The timestamp when the comment was created.
     */
    createdAt: number;

    /**
     * The timestamp when the comment was last updated.
     */
    updatedAt?: number;

    /**
     * Whether the comment is resolved.
     */
    resolved?: boolean;

    /**
     * The user ID of the user who resolved the comment, if applicable.
     */
    resolvedBy?: string;

    /**
     * The timestamp when the comment was resolved, if applicable.
     */
    resolvedAt?: number;

    /**
     * The range in the cell the comment is attached to, if applicable.
     */
    range?: {
      /**
       * The start position of the range.
       */
      start: number;

      /**
       * The end position of the range.
       */
      end: number;
    };

    /**
     * The replies to the comment.
     */
    replies?: IReply[];
  }

  /**
   * Reply interface.
   */
  export interface IReply {
    /**
     * The unique ID of the reply.
     */
    id?: string;

    /**
     * The content of the reply.
     */
    content: string;

    /**
     * The user ID of the reply author.
     */
    userId: string;

    /**
     * The user name of the reply author.
     */
    userName: string;

    /**
     * The timestamp when the reply was created.
     */
    createdAt: number;

    /**
     * The timestamp when the reply was last updated.
     */
    updatedAt?: number;
  }

  /**
   * Comment change event interface.
   */
  export interface IChangeEvent {
    /**
     * The type of change.
     */
    type: 'added' | 'updated' | 'deleted' | 'resolved' | 'reply-added' | 'reply-updated' | 'reply-deleted';

    /**
     * The path to the document that changed.
     */
    documentPath: string;

    /**
     * The ID of the comment that changed.
     */
    commentId: string;

    /**
     * The ID of the reply that changed, if applicable.
     */
    replyId?: string;

    /**
     * The comment data, if applicable.
     */
    comment?: IComment;

    /**
     * The reply data, if applicable.
     */
    reply?: IReply;
  }
}

/**
 * The ICommentService token.
 */
export const ICommentService = new Token<ICommentService>(
  '@jupyter-notebook/application:ICommentService'
);