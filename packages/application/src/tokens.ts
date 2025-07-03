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
 * The ICollaborationProvider interface.
 * Main collaboration provider that orchestrates all collaborative features.
 */
export interface ICollaborationProvider {
  /**
   * Initialize collaboration for a notebook.
   * 
   * @param notebookPath - The path to the notebook to collaborate on.
   * @param options - Configuration options for collaboration.
   */
  initialize(notebookPath: string, options?: ICollaborationProvider.IInitializeOptions): Promise<void>;

  /**
   * Join a collaborative session.
   * 
   * @param sessionId - The ID of the session to join.
   */
  joinSession(sessionId: string): Promise<void>;

  /**
   * Leave the current collaborative session.
   */
  leaveSession(): Promise<void>;

  /**
   * Whether collaboration is currently active.
   */
  readonly isActive: boolean;

  /**
   * The current session ID, if any.
   */
  readonly sessionId: string | null;
}

export namespace ICollaborationProvider {
  /**
   * Options for initializing collaboration.
   */
  export interface IInitializeOptions {
    /**
     * The collaboration server URL.
     */
    serverUrl?: string;

    /**
     * Authentication token for the collaboration session.
     */
    token?: string;

    /**
     * Whether to enable awareness features.
     */
    enableAwareness?: boolean;

    /**
     * Whether to enable locking features.
     */
    enableLocking?: boolean;

    /**
     * Whether to enable comment features.
     */
    enableComments?: boolean;
  }
}

/**
 * The ICollaborationProvider token.
 * Provides access to the main collaboration orchestration service.
 */
export const ICollaborationProvider = new Token<ICollaborationProvider>(
  '@jupyter-notebook/application:ICollaborationProvider'
);

/**
 * The YjsNotebookProvider interface.
 * Provides CRDT-based document synchronization for real-time collaborative editing.
 */
export interface YjsNotebookProvider {
  /**
   * Connect to a Yjs document for the given notebook path.
   * 
   * @param notebookPath - The path to the notebook.
   * @param options - Connection options.
   */
  connect(notebookPath: string, options?: YjsNotebookProvider.IConnectOptions): Promise<void>;

  /**
   * Disconnect from the current Yjs document.
   */
  disconnect(): Promise<void>;

  /**
   * Whether the provider is currently connected.
   */
  readonly isConnected: boolean;

  /**
   * The current Yjs document, if connected.
   */
  readonly document: any; // Y.Doc from yjs

  /**
   * Send updates to other clients.
   * 
   * @param update - The update to send.
   */
  sendUpdate(update: Uint8Array): void;

  /**
   * Signal emitted when updates are received from other clients.
   */
  readonly updateReceived: any; // Signal<this, Uint8Array>
}

export namespace YjsNotebookProvider {
  /**
   * Options for connecting to a Yjs document.
   */
  export interface IConnectOptions {
    /**
     * The WebSocket URL for synchronization.
     */
    websocketUrl?: string;

    /**
     * Authentication token.
     */
    token?: string;

    /**
     * Room name for the document.
     */
    room?: string;
  }
}

/**
 * The YjsNotebookProvider token.
 * Provides access to the Yjs CRDT document synchronization service.
 */
export const YjsNotebookProvider = new Token<YjsNotebookProvider>(
  '@jupyter-notebook/application:YjsNotebookProvider'
);

/**
 * The AwarenessService interface.
 * Tracks and broadcasts user presence, cursor positions, and selections.
 */
export interface AwarenessService {
  /**
   * Set the local user's awareness state.
   * 
   * @param state - The awareness state to set.
   */
  setLocalState(state: AwarenessService.IAwarenessState): void;

  /**
   * Get the awareness state for a specific user.
   * 
   * @param userId - The user ID.
   */
  getUserState(userId: string): AwarenessService.IAwarenessState | null;

  /**
   * Get all current user states.
   */
  getAllUserStates(): Map<string, AwarenessService.IAwarenessState>;

  /**
   * Whether the service is currently active.
   */
  readonly isActive: boolean;

  /**
   * Signal emitted when user states change.
   */
  readonly stateChanged: any; // Signal<this, Map<string, IAwarenessState>>
}

export namespace AwarenessService {
  /**
   * User awareness state including presence and cursor information.
   */
  export interface IAwarenessState {
    /**
     * User information.
     */
    user: {
      name: string;
      id: string;
      color: string;
      avatar?: string;
    };

    /**
     * Cursor position information.
     */
    cursor?: {
      cellId: string;
      line: number;
      column: number;
    };

    /**
     * Selection information.
     */
    selection?: {
      cellId: string;
      start: { line: number; column: number };
      end: { line: number; column: number };
    };

    /**
     * Activity status.
     */
    status: 'active' | 'idle' | 'away';

    /**
     * Last activity timestamp.
     */
    lastActivity: number;
  }
}

/**
 * The AwarenessService token.
 * Provides access to user presence and cursor tracking functionality.
 */
export const AwarenessService = new Token<AwarenessService>(
  '@jupyter-notebook/application:AwarenessService'
);

/**
 * The LockService interface.
 * Manages cell-level locking to prevent conflicting simultaneous edits.
 */
export interface LockService {
  /**
   * Acquire a lock on a cell.
   * 
   * @param cellId - The ID of the cell to lock.
   * @param options - Lock options.
   */
  acquireLock(cellId: string, options?: LockService.ILockOptions): Promise<boolean>;

  /**
   * Release a lock on a cell.
   * 
   * @param cellId - The ID of the cell to unlock.
   */
  releaseLock(cellId: string): Promise<void>;

  /**
   * Check if a cell is locked.
   * 
   * @param cellId - The ID of the cell to check.
   */
  isLocked(cellId: string): boolean;

  /**
   * Get the lock information for a cell.
   * 
   * @param cellId - The ID of the cell.
   */
  getLockInfo(cellId: string): LockService.ILockInfo | null;

  /**
   * Get all current locks.
   */
  getAllLocks(): Map<string, LockService.ILockInfo>;

  /**
   * Signal emitted when lock states change.
   */
  readonly lockChanged: any; // Signal<this, { cellId: string; lockInfo: ILockInfo | null }>
}

export namespace LockService {
  /**
   * Options for acquiring a lock.
   */
  export interface ILockOptions {
    /**
     * Lock timeout in milliseconds.
     */
    timeout?: number;

    /**
     * Whether to force acquire the lock.
     */
    force?: boolean;
  }

  /**
   * Information about a cell lock.
   */
  export interface ILockInfo {
    /**
     * The user who owns the lock.
     */
    owner: {
      id: string;
      name: string;
    };

    /**
     * When the lock was acquired.
     */
    acquiredAt: number;

    /**
     * When the lock will expire.
     */
    expiresAt: number;

    /**
     * Lock type.
     */
    type: 'edit' | 'execute';
  }
}

/**
 * The LockService token.
 * Provides access to cell-level locking functionality.
 */
export const LockService = new Token<LockService>(
  '@jupyter-notebook/application:LockService'
);

/**
 * The CommentService interface.
 * Handles creation, editing, and resolution of comments attached to notebook cells.
 */
export interface CommentService {
  /**
   * Create a new comment on a cell.
   * 
   * @param cellId - The ID of the cell to comment on.
   * @param comment - The comment to create.
   */
  createComment(cellId: string, comment: CommentService.ICommentData): Promise<CommentService.IComment>;

  /**
   * Reply to an existing comment.
   * 
   * @param commentId - The ID of the comment to reply to.
   * @param reply - The reply data.
   */
  replyToComment(commentId: string, reply: CommentService.ICommentData): Promise<CommentService.IComment>;

  /**
   * Edit an existing comment.
   * 
   * @param commentId - The ID of the comment to edit.
   * @param content - The new content.
   */
  editComment(commentId: string, content: string): Promise<void>;

  /**
   * Delete a comment.
   * 
   * @param commentId - The ID of the comment to delete.
   */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Resolve a comment thread.
   * 
   * @param commentId - The ID of the root comment.
   */
  resolveComment(commentId: string): Promise<void>;

  /**
   * Get all comments for a cell.
   * 
   * @param cellId - The ID of the cell.
   */
  getCellComments(cellId: string): CommentService.IComment[];

  /**
   * Get all comments for the notebook.
   */
  getAllComments(): CommentService.IComment[];

  /**
   * Signal emitted when comments change.
   */
  readonly commentsChanged: any; // Signal<this, { cellId: string; comments: IComment[] }>
}

export namespace CommentService {
  /**
   * Data for creating a comment.
   */
  export interface ICommentData {
    /**
     * The comment content.
     */
    content: string;

    /**
     * Optional position within the cell.
     */
    position?: {
      line: number;
      column: number;
    };

    /**
     * Optional selection range.
     */
    selection?: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
  }

  /**
   * A comment with metadata.
   */
  export interface IComment {
    /**
     * Unique comment ID.
     */
    id: string;

    /**
     * The cell this comment is attached to.
     */
    cellId: string;

    /**
     * Comment content.
     */
    content: string;

    /**
     * Author information.
     */
    author: {
      id: string;
      name: string;
    };

    /**
     * When the comment was created.
     */
    createdAt: number;

    /**
     * When the comment was last modified.
     */
    modifiedAt: number;

    /**
     * Whether the comment is resolved.
     */
    resolved: boolean;

    /**
     * Parent comment ID for replies.
     */
    parentId?: string;

    /**
     * Position within the cell.
     */
    position?: {
      line: number;
      column: number;
    };

    /**
     * Selection range.
     */
    selection?: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };

    /**
     * Replies to this comment.
     */
    replies: IComment[];
  }
}

/**
 * The CommentService token.
 * Provides access to comment creation and management functionality.
 */
export const CommentService = new Token<CommentService>(
  '@jupyter-notebook/application:CommentService'
);

/**
 * The HistoryManager interface.
 * Captures document history snapshots and enables version comparison/restoration.
 */
export interface HistoryManager {
  /**
   * Create a snapshot of the current document state.
   * 
   * @param description - Optional description for the snapshot.
   */
  createSnapshot(description?: string): Promise<HistoryManager.ISnapshot>;

  /**
   * Get all available snapshots.
   */
  getSnapshots(): HistoryManager.ISnapshot[];

  /**
   * Get a specific snapshot by ID.
   * 
   * @param snapshotId - The ID of the snapshot.
   */
  getSnapshot(snapshotId: string): HistoryManager.ISnapshot | null;

  /**
   * Restore the document to a specific snapshot.
   * 
   * @param snapshotId - The ID of the snapshot to restore.
   * @param options - Restore options.
   */
  restoreSnapshot(snapshotId: string, options?: HistoryManager.IRestoreOptions): Promise<void>;

  /**
   * Compare two snapshots.
   * 
   * @param snapshotId1 - The ID of the first snapshot.
   * @param snapshotId2 - The ID of the second snapshot.
   */
  compareSnapshots(snapshotId1: string, snapshotId2: string): HistoryManager.IDiff[];

  /**
   * Get the change history between two points in time.
   * 
   * @param fromTime - Start time.
   * @param toTime - End time.
   */
  getChangeHistory(fromTime: number, toTime: number): HistoryManager.IChangeRecord[];

  /**
   * Signal emitted when a new snapshot is created.
   */
  readonly snapshotCreated: any; // Signal<this, ISnapshot>
}

export namespace HistoryManager {
  /**
   * A document snapshot.
   */
  export interface ISnapshot {
    /**
     * Unique snapshot ID.
     */
    id: string;

    /**
     * When the snapshot was created.
     */
    timestamp: number;

    /**
     * User who created the snapshot.
     */
    author: {
      id: string;
      name: string;
    };

    /**
     * Optional description.
     */
    description?: string;

    /**
     * Document content at the time of snapshot.
     */
    content: any;

    /**
     * Metadata about the snapshot.
     */
    metadata: {
      cellCount: number;
      totalChanges: number;
    };
  }

  /**
   * Options for restoring a snapshot.
   */
  export interface IRestoreOptions {
    /**
     * Whether to create a snapshot before restoring.
     */
    createBackup?: boolean;

    /**
     * Whether to restore cell execution counts.
     */
    restoreExecutionCounts?: boolean;
  }

  /**
   * A diff between two snapshots.
   */
  export interface IDiff {
    /**
     * The type of change.
     */
    type: 'add' | 'remove' | 'modify';

    /**
     * The path to the changed element.
     */
    path: string;

    /**
     * The old value (for remove/modify).
     */
    oldValue?: any;

    /**
     * The new value (for add/modify).
     */
    newValue?: any;
  }

  /**
   * A record of a change made to the document.
   */
  export interface IChangeRecord {
    /**
     * When the change was made.
     */
    timestamp: number;

    /**
     * User who made the change.
     */
    author: {
      id: string;
      name: string;
    };

    /**
     * Description of the change.
     */
    description: string;

    /**
     * The change details.
     */
    changes: IDiff[];
  }
}

/**
 * The HistoryManager token.
 * Provides access to document history and version management functionality.
 */
export const HistoryManager = new Token<HistoryManager>(
  '@jupyter-notebook/application:HistoryManager'
);

/**
 * The PermissionsManager interface.
 * Enforces access control and editing permissions for collaborative features.
 */
export interface PermissionsManager {
  /**
   * Get the current user's permissions for the notebook.
   */
  getCurrentUserPermissions(): PermissionsManager.IPermissionLevel;

  /**
   * Get permissions for a specific user.
   * 
   * @param userId - The user ID.
   */
  getUserPermissions(userId: string): PermissionsManager.IPermissionLevel | null;

  /**
   * Set permissions for a user.
   * 
   * @param userId - The user ID.
   * @param permissions - The permissions to set.
   */
  setUserPermissions(userId: string, permissions: PermissionsManager.IPermissionLevel): Promise<void>;

  /**
   * Remove a user from the collaborative session.
   * 
   * @param userId - The user ID.
   */
  removeUser(userId: string): Promise<void>;

  /**
   * Check if the current user can perform a specific action.
   * 
   * @param action - The action to check.
   */
  canCurrentUserPerform(action: PermissionsManager.IAction): boolean;

  /**
   * Check if a user can perform a specific action.
   * 
   * @param userId - The user ID.
   * @param action - The action to check.
   */
  canUserPerform(userId: string, action: PermissionsManager.IAction): boolean;

  /**
   * Get all collaborators with their permissions.
   */
  getAllCollaborators(): PermissionsManager.ICollaborator[];

  /**
   * Signal emitted when permissions change.
   */
  readonly permissionsChanged: any; // Signal<this, { userId: string; permissions: IPermissionLevel }>
}

export namespace PermissionsManager {
  /**
   * Permission levels for collaborative features.
   */
  export interface IPermissionLevel {
    /**
     * Can view the notebook.
     */
    view: boolean;

    /**
     * Can edit cell content.
     */
    edit: boolean;

    /**
     * Can execute cells.
     */
    execute: boolean;

    /**
     * Can add/remove cells.
     */
    addRemoveCells: boolean;

    /**
     * Can manage comments.
     */
    comment: boolean;

    /**
     * Can manage other users' permissions.
     */
    managePermissions: boolean;

    /**
     * Can manage the collaborative session.
     */
    administerSession: boolean;
  }

  /**
   * Actions that can be performed in a collaborative session.
   */
  export type IAction = 
    | 'view'
    | 'edit'
    | 'execute'
    | 'addCell'
    | 'removeCell'
    | 'comment'
    | 'managePermissions'
    | 'administerSession';

  /**
   * A collaborator in the session.
   */
  export interface ICollaborator {
    /**
     * User information.
     */
    user: {
      id: string;
      name: string;
      email?: string;
      avatar?: string;
    };

    /**
     * Current permissions.
     */
    permissions: IPermissionLevel;

    /**
     * When the user joined the session.
     */
    joinedAt: number;

    /**
     * Last activity timestamp.
     */
    lastActivity: number;

    /**
     * Whether the user is currently active.
     */
    isActive: boolean;
  }
}

/**
 * The PermissionsManager token.
 * Provides access to role-based access control and permission management functionality.
 */
export const PermissionsManager = new Token<PermissionsManager>(
  '@jupyter-notebook/application:PermissionsManager'
);
