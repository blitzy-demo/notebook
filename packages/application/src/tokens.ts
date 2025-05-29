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

// ============================================================================
// COLLABORATION INTERFACES AND TOKENS
// ============================================================================

/**
 * Interface for the core Yjs notebook provider that manages CRDT document synchronization.
 */
export interface IYjsNotebookProvider {
  /**
   * Connect to a collaborative notebook session.
   * 
   * @param notebookPath - The path to the notebook file
   * @param options - Connection options including server endpoint and authentication
   * @returns Promise that resolves when connection is established
   */
  connect(notebookPath: string, options?: IYjsNotebookProvider.IConnectOptions): Promise<void>;

  /**
   * Disconnect from the collaborative session.
   */
  disconnect(): Promise<void>;

  /**
   * Get the current collaboration status.
   */
  readonly isConnected: boolean;

  /**
   * Get the Yjs document instance.
   */
  readonly yjsDocument: any; // Y.Doc type

  /**
   * Apply a document update from the network.
   * 
   * @param update - The Yjs document update
   */
  applyUpdate(update: Uint8Array): void;

  /**
   * Get the current document state as an update.
   */
  getDocumentState(): Uint8Array;
}

export namespace IYjsNotebookProvider {
  /**
   * Options for connecting to a collaborative session.
   */
  export interface IConnectOptions {
    /**
     * WebSocket server URL for collaboration.
     */
    serverUrl?: string;

    /**
     * Authentication token for the session.
     */
    authToken?: string;

    /**
     * Room or session identifier.
     */
    roomId?: string;

    /**
     * User identification for the session.
     */
    userId?: string;
  }
}

/**
 * Registry interface for managing user awareness states.
 */
export interface IAwarenessRegistry {
  /**
   * Register a new user's awareness state.
   * 
   * @param userId - Unique identifier for the user
   * @param state - Initial awareness state
   */
  registerUser(userId: string, state: IAwarenessRegistry.IAwarenessState): void;

  /**
   * Update awareness state for a user.
   * 
   * @param userId - User identifier
   * @param state - Updated awareness state
   */
  updateUserState(userId: string, state: Partial<IAwarenessRegistry.IAwarenessState>): void;

  /**
   * Remove a user from the awareness registry.
   * 
   * @param userId - User identifier to remove
   */
  removeUser(userId: string): void;

  /**
   * Get all active users in the session.
   */
  getActiveUsers(): Map<string, IAwarenessRegistry.IAwarenessState>;

  /**
   * Get awareness state for a specific user.
   * 
   * @param userId - User identifier
   */
  getUserState(userId: string): IAwarenessRegistry.IAwarenessState | undefined;
}

export namespace IAwarenessRegistry {
  /**
   * User awareness state information.
   */
  export interface IAwarenessState {
    /**
     * User's display name.
     */
    name: string;

    /**
     * User's avatar URL or identifier.
     */
    avatar?: string;

    /**
     * User's assigned color for cursors and selections.
     */
    color: string;

    /**
     * Current cursor position in the document.
     */
    cursor?: {
      cellId: string;
      position: number;
    };

    /**
     * Current text selection range.
     */
    selection?: {
      cellId: string;
      start: number;
      end: number;
    };

    /**
     * User's current status.
     */
    status: 'active' | 'idle' | 'away';

    /**
     * Timestamp of last activity.
     */
    lastSeen: number;
  }
}

/**
 * Manager interface for handling awareness protocol operations.
 */
export interface IAwarenessManager {
  /**
   * Initialize awareness for the current user.
   * 
   * @param userInfo - Current user's information
   */
  initialize(userInfo: IAwarenessRegistry.IAwarenessState): void;

  /**
   * Update the current user's awareness state.
   * 
   * @param updates - Partial state updates
   */
  updateLocalState(updates: Partial<IAwarenessRegistry.IAwarenessState>): void;

  /**
   * Handle awareness updates from other users.
   * 
   * @param update - Awareness update message
   */
  handleRemoteUpdate(update: Uint8Array): void;

  /**
   * Get awareness updates to send to other clients.
   */
  getLocalUpdate(): Uint8Array | null;

  /**
   * Subscribe to awareness state changes.
   * 
   * @param callback - Function to call when awareness changes
   */
  onAwarenessChange(callback: (users: Map<string, IAwarenessRegistry.IAwarenessState>) => void): void;

  /**
   * Clean up inactive users.
   * 
   * @param timeoutMs - Milliseconds after which to consider users inactive
   */
  cleanupInactiveUsers(timeoutMs?: number): void;
}

/**
 * Manager interface for cell-level locking operations.
 */
export interface ILockManager {
  /**
   * Attempt to acquire a lock on a cell.
   * 
   * @param cellId - Identifier of the cell to lock
   * @param userId - User attempting to acquire the lock
   * @param options - Lock acquisition options
   * @returns Promise that resolves to lock acquisition result
   */
  acquireLock(cellId: string, userId: string, options?: ILockManager.ILockOptions): Promise<ILockAcquisition>;

  /**
   * Release a lock on a cell.
   * 
   * @param cellId - Identifier of the cell to unlock
   * @param userId - User releasing the lock
   * @returns Promise that resolves when lock is released
   */
  releaseLock(cellId: string, userId: string): Promise<void>;

  /**
   * Check if a cell is currently locked.
   * 
   * @param cellId - Identifier of the cell to check
   */
  isLocked(cellId: string): boolean;

  /**
   * Get the current lock holder for a cell.
   * 
   * @param cellId - Identifier of the cell
   */
  getLockHolder(cellId: string): string | null;

  /**
   * Get all currently locked cells.
   */
  getLockedCells(): Map<string, ILockManager.ILockState>;

  /**
   * Subscribe to lock state changes.
   * 
   * @param callback - Function to call when lock states change
   */
  onLockStateChange(callback: (cellId: string, state: ILockManager.ILockState | null) => void): void;
}

export namespace ILockManager {
  /**
   * Options for lock acquisition.
   */
  export interface ILockOptions {
    /**
     * Priority level for the lock request.
     */
    priority?: 'low' | 'normal' | 'high';

    /**
     * Maximum time to wait for lock acquisition (ms).
     */
    timeoutMs?: number;

    /**
     * Whether to queue the request if lock is unavailable.
     */
    queue?: boolean;
  }

  /**
   * Current state of a cell lock.
   */
  export interface ILockState {
    /**
     * ID of the user holding the lock.
     */
    userId: string;

    /**
     * Timestamp when lock was acquired.
     */
    acquiredAt: number;

    /**
     * Optional expiration time for the lock.
     */
    expiresAt?: number;

    /**
     * Lock priority level.
     */
    priority: 'low' | 'normal' | 'high';
  }
}

/**
 * Registry interface for managing lock states across cells.
 */
export interface ILockRegistry {
  /**
   * Register a new lock state.
   * 
   * @param cellId - Cell identifier
   * @param lockState - Lock state information
   */
  setLockState(cellId: string, lockState: ILockManager.ILockState): void;

  /**
   * Remove lock state for a cell.
   * 
   * @param cellId - Cell identifier
   */
  removeLockState(cellId: string): void;

  /**
   * Get lock state for a specific cell.
   * 
   * @param cellId - Cell identifier
   */
  getLockState(cellId: string): ILockManager.ILockState | null;

  /**
   * Get all current lock states.
   */
  getAllLockStates(): Map<string, ILockManager.ILockState>;

  /**
   * Clear all lock states.
   */
  clearAllLocks(): void;

  /**
   * Subscribe to lock registry changes.
   * 
   * @param callback - Function to call when registry changes
   */
  onRegistryChange(callback: (cellId: string, state: ILockManager.ILockState | null) => void): void;
}

/**
 * Interface representing the result of a lock acquisition attempt.
 */
export interface ILockAcquisition {
  /**
   * Whether the lock was successfully acquired.
   */
  success: boolean;

  /**
   * Cell ID that was locked.
   */
  cellId: string;

  /**
   * User ID that acquired the lock.
   */
  userId: string;

  /**
   * Error message if acquisition failed.
   */
  error?: string;

  /**
   * Position in queue if lock was not immediately available.
   */
  queuePosition?: number;

  /**
   * Estimated wait time if queued (ms).
   */
  estimatedWaitTime?: number;
}

/**
 * Manager interface for handling change history and versioning.
 */
export interface IHistoryManager {
  /**
   * Create a snapshot of the current document state.
   * 
   * @param metadata - Optional metadata for the snapshot
   * @returns Snapshot identifier
   */
  createSnapshot(metadata?: IHistoryManager.ISnapshotMetadata): string;

  /**
   * Get a specific snapshot by ID.
   * 
   * @param snapshotId - Identifier of the snapshot
   */
  getSnapshot(snapshotId: string): IHistoryManager.ISnapshot | null;

  /**
   * Get all available snapshots for the current document.
   */
  getAllSnapshots(): IHistoryManager.ISnapshot[];

  /**
   * Restore document to a specific snapshot.
   * 
   * @param snapshotId - Identifier of the snapshot to restore
   * @returns Promise that resolves when restore is complete
   */
  restoreSnapshot(snapshotId: string): Promise<void>;

  /**
   * Get changes between two snapshots.
   * 
   * @param fromSnapshotId - Starting snapshot ID
   * @param toSnapshotId - Ending snapshot ID (or current state if null)
   */
  getChangesBetween(fromSnapshotId: string, toSnapshotId?: string): IHistoryManager.IChangeRecord[];

  /**
   * Track a new change in the document.
   * 
   * @param change - Change record to track
   */
  trackChange(change: IHistoryManager.IChangeRecord): void;

  /**
   * Get the change history for a specific cell.
   * 
   * @param cellId - Cell identifier
   */
  getCellHistory(cellId: string): IHistoryManager.IChangeRecord[];

  /**
   * Subscribe to history events.
   * 
   * @param callback - Function to call when history changes
   */
  onHistoryChange(callback: (event: IHistoryManager.IHistoryEvent) => void): void;
}

export namespace IHistoryManager {
  /**
   * Metadata for a document snapshot.
   */
  export interface ISnapshotMetadata {
    /**
     * Human-readable description of the snapshot.
     */
    description?: string;

    /**
     * User who created the snapshot.
     */
    createdBy?: string;

    /**
     * Tags associated with the snapshot.
     */
    tags?: string[];

    /**
     * Custom metadata properties.
     */
    custom?: Record<string, any>;
  }

  /**
   * A document snapshot.
   */
  export interface ISnapshot {
    /**
     * Unique identifier for the snapshot.
     */
    id: string;

    /**
     * Timestamp when snapshot was created.
     */
    timestamp: number;

    /**
     * Document state at the time of snapshot.
     */
    documentState: Uint8Array;

    /**
     * Metadata associated with the snapshot.
     */
    metadata: ISnapshotMetadata;

    /**
     * Size of the snapshot in bytes.
     */
    size: number;
  }

  /**
   * Record of a change made to the document.
   */
  export interface IChangeRecord {
    /**
     * Unique identifier for the change.
     */
    id: string;

    /**
     * Timestamp when change occurred.
     */
    timestamp: number;

    /**
     * User who made the change.
     */
    userId: string;

    /**
     * Type of change made.
     */
    type: 'cell-add' | 'cell-delete' | 'cell-modify' | 'cell-move' | 'metadata-change';

    /**
     * Cell ID affected by the change (if applicable).
     */
    cellId?: string;

    /**
     * Description of the change.
     */
    description: string;

    /**
     * Delta representing the change.
     */
    delta: any; // Yjs delta format

    /**
     * Previous state before the change.
     */
    previousState?: any;

    /**
     * New state after the change.
     */
    newState?: any;
  }

  /**
   * History event types.
   */
  export interface IHistoryEvent {
    /**
     * Type of history event.
     */
    type: 'snapshot-created' | 'change-tracked' | 'snapshot-restored';

    /**
     * Event timestamp.
     */
    timestamp: number;

    /**
     * Snapshot ID (for snapshot events).
     */
    snapshotId?: string;

    /**
     * Change record (for change events).
     */
    change?: IChangeRecord;
  }
}

/**
 * Registry interface for managing document snapshots.
 */
export interface ISnapshotRegistry {
  /**
   * Register a new snapshot.
   * 
   * @param snapshot - Snapshot to register
   */
  registerSnapshot(snapshot: IHistoryManager.ISnapshot): void;

  /**
   * Remove a snapshot from the registry.
   * 
   * @param snapshotId - ID of snapshot to remove
   */
  removeSnapshot(snapshotId: string): void;

  /**
   * Get a snapshot by ID.
   * 
   * @param snapshotId - Snapshot identifier
   */
  getSnapshot(snapshotId: string): IHistoryManager.ISnapshot | null;

  /**
   * Get all snapshots ordered by timestamp.
   * 
   * @param ascending - Whether to sort in ascending order (default: false)
   */
  getAllSnapshots(ascending?: boolean): IHistoryManager.ISnapshot[];

  /**
   * Clear all snapshots.
   */
  clearSnapshots(): void;

  /**
   * Get snapshots within a time range.
   * 
   * @param startTime - Start timestamp
   * @param endTime - End timestamp
   */
  getSnapshotsInRange(startTime: number, endTime: number): IHistoryManager.ISnapshot[];

  /**
   * Subscribe to snapshot registry changes.
   * 
   * @param callback - Function to call when registry changes
   */
  onRegistryChange(callback: (event: { type: 'added' | 'removed'; snapshot: IHistoryManager.ISnapshot }) => void): void;
}

/**
 * Manager interface for handling access control and permissions.
 */
export interface IPermissionsManager {
  /**
   * Check if a user has a specific permission.
   * 
   * @param userId - User identifier
   * @param permission - Permission to check
   * @param resourceId - Optional resource identifier (e.g., cell ID)
   */
  hasPermission(userId: string, permission: IPermissionsManager.Permission, resourceId?: string): boolean;

  /**
   * Grant a permission to a user.
   * 
   * @param userId - User identifier
   * @param permission - Permission to grant
   * @param resourceId - Optional resource identifier
   */
  grantPermission(userId: string, permission: IPermissionsManager.Permission, resourceId?: string): Promise<void>;

  /**
   * Revoke a permission from a user.
   * 
   * @param userId - User identifier
   * @param permission - Permission to revoke
   * @param resourceId - Optional resource identifier
   */
  revokePermission(userId: string, permission: IPermissionsManager.Permission, resourceId?: string): Promise<void>;

  /**
   * Get all permissions for a user.
   * 
   * @param userId - User identifier
   */
  getUserPermissions(userId: string): IPermissionsManager.IUserPermissions;

  /**
   * Set the role for a user.
   * 
   * @param userId - User identifier
   * @param role - Role to assign
   */
  setUserRole(userId: string, role: IPermissionsManager.Role): Promise<void>;

  /**
   * Get the role for a user.
   * 
   * @param userId - User identifier
   */
  getUserRole(userId: string): IPermissionsManager.Role;

  /**
   * Get all users with access to the resource.
   */
  getAllUsers(): IPermissionsManager.IUserInfo[];

  /**
   * Subscribe to permission changes.
   * 
   * @param callback - Function to call when permissions change
   */
  onPermissionChange(callback: (event: IPermissionsManager.IPermissionEvent) => void): void;
}

export namespace IPermissionsManager {
  /**
   * Available permission types.
   */
  export type Permission = 
    | 'read'           // View notebook content
    | 'write'          // Edit notebook content
    | 'execute'        // Execute cells
    | 'comment'        // Add/edit comments
    | 'manage'         // Manage permissions and settings
    | 'lock'           // Acquire cell locks
    | 'history'        // View and manage history
    | 'share';         // Share notebook with others

  /**
   * Available user roles.
   */
  export type Role = 
    | 'viewer'         // Read-only access
    | 'editor'         // Read/write access
    | 'collaborator'   // Full collaboration features
    | 'admin';         // Administrative access

  /**
   * User permission information.
   */
  export interface IUserPermissions {
    /**
     * User identifier.
     */
    userId: string;

    /**
     * User's assigned role.
     */
    role: Role;

    /**
     * Explicit permissions granted to the user.
     */
    permissions: Permission[];

    /**
     * Resource-specific permissions.
     */
    resourcePermissions?: Record<string, Permission[]>;
  }

  /**
   * User information.
   */
  export interface IUserInfo {
    /**
     * User identifier.
     */
    userId: string;

    /**
     * User's display name.
     */
    name: string;

    /**
     * User's email address.
     */
    email?: string;

    /**
     * User's avatar URL.
     */
    avatar?: string;

    /**
     * User's assigned role.
     */
    role: Role;

    /**
     * When user was added to the notebook.
     */
    addedAt: number;
  }

  /**
   * Permission change event.
   */
  export interface IPermissionEvent {
    /**
     * Type of permission event.
     */
    type: 'granted' | 'revoked' | 'role-changed';

    /**
     * User affected by the change.
     */
    userId: string;

    /**
     * Permission involved (for grant/revoke events).
     */
    permission?: Permission;

    /**
     * New role (for role change events).
     */
    newRole?: Role;

    /**
     * Previous role (for role change events).
     */
    previousRole?: Role;

    /**
     * Resource ID if permission is resource-specific.
     */
    resourceId?: string;

    /**
     * Timestamp of the event.
     */
    timestamp: number;
  }
}

/**
 * Access Control List interface for managing resource permissions.
 */
export interface IAccessControlList {
  /**
   * Add an access control entry.
   * 
   * @param entry - Access control entry to add
   */
  addEntry(entry: IAccessControlList.IAccessEntry): void;

  /**
   * Remove an access control entry.
   * 
   * @param userId - User identifier
   * @param resourceId - Optional resource identifier
   */
  removeEntry(userId: string, resourceId?: string): void;

  /**
   * Get access control entry for a user.
   * 
   * @param userId - User identifier
   * @param resourceId - Optional resource identifier
   */
  getEntry(userId: string, resourceId?: string): IAccessControlList.IAccessEntry | null;

  /**
   * Get all access control entries.
   */
  getAllEntries(): IAccessControlList.IAccessEntry[];

  /**
   * Check if a user has access to a resource.
   * 
   * @param userId - User identifier
   * @param resourceId - Optional resource identifier
   */
  hasAccess(userId: string, resourceId?: string): boolean;

  /**
   * Clear all access control entries.
   */
  clearAll(): void;

  /**
   * Subscribe to ACL changes.
   * 
   * @param callback - Function to call when ACL changes
   */
  onAclChange(callback: (event: IAccessControlList.IAclEvent) => void): void;
}

export namespace IAccessControlList {
  /**
   * Access control entry.
   */
  export interface IAccessEntry {
    /**
     * User identifier.
     */
    userId: string;

    /**
     * Resource identifier (optional for global permissions).
     */
    resourceId?: string;

    /**
     * Granted permissions.
     */
    permissions: IPermissionsManager.Permission[];

    /**
     * When the entry was created.
     */
    createdAt: number;

    /**
     * When the entry was last modified.
     */
    modifiedAt: number;

    /**
     * Optional expiration time for the entry.
     */
    expiresAt?: number;
  }

  /**
   * ACL change event.
   */
  export interface IAclEvent {
    /**
     * Type of ACL event.
     */
    type: 'entry-added' | 'entry-removed' | 'entry-modified';

    /**
     * Access entry involved in the event.
     */
    entry: IAccessEntry;

    /**
     * Timestamp of the event.
     */
    timestamp: number;
  }
}

/**
 * Manager interface for handling comments and review workflows.
 */
export interface ICommentManager {
  /**
   * Create a new comment.
   * 
   * @param comment - Comment data
   * @returns Promise that resolves to the created comment
   */
  createComment(comment: ICommentManager.ICreateCommentData): Promise<ICommentManager.IComment>;

  /**
   * Update an existing comment.
   * 
   * @param commentId - Comment identifier
   * @param updates - Partial comment updates
   * @returns Promise that resolves to the updated comment
   */
  updateComment(commentId: string, updates: Partial<ICommentManager.IComment>): Promise<ICommentManager.IComment>;

  /**
   * Delete a comment.
   * 
   * @param commentId - Comment identifier
   * @returns Promise that resolves when comment is deleted
   */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Get a specific comment by ID.
   * 
   * @param commentId - Comment identifier
   */
  getComment(commentId: string): ICommentManager.IComment | null;

  /**
   * Get all comments for a cell.
   * 
   * @param cellId - Cell identifier
   */
  getCellComments(cellId: string): ICommentManager.IComment[];

  /**
   * Get all comments for the notebook.
   */
  getAllComments(): ICommentManager.IComment[];

  /**
   * Reply to an existing comment.
   * 
   * @param parentCommentId - Parent comment identifier
   * @param reply - Reply data
   * @returns Promise that resolves to the created reply
   */
  replyToComment(parentCommentId: string, reply: ICommentManager.ICreateReplyData): Promise<ICommentManager.IComment>;

  /**
   * Resolve a comment thread.
   * 
   * @param commentId - Root comment identifier
   * @param resolvedBy - User who resolved the comment
   * @returns Promise that resolves when comment is resolved
   */
  resolveComment(commentId: string, resolvedBy: string): Promise<void>;

  /**
   * Unresolve a comment thread.
   * 
   * @param commentId - Root comment identifier
   * @returns Promise that resolves when comment is unresolved
   */
  unresolveComment(commentId: string): Promise<void>;

  /**
   * Subscribe to comment events.
   * 
   * @param callback - Function to call when comments change
   */
  onCommentChange(callback: (event: ICommentManager.ICommentEvent) => void): void;

  /**
   * Get comments within a specific time range.
   * 
   * @param startTime - Start timestamp
   * @param endTime - End timestamp
   */
  getCommentsInRange(startTime: number, endTime: number): ICommentManager.IComment[];
}

export namespace ICommentManager {
  /**
   * Data for creating a new comment.
   */
  export interface ICreateCommentData {
    /**
     * Cell ID the comment is attached to.
     */
    cellId: string;

    /**
     * Comment text content.
     */
    content: string;

    /**
     * User creating the comment.
     */
    authorId: string;

    /**
     * Optional position within the cell (character offset).
     */
    position?: number;

    /**
     * Optional selection range within the cell.
     */
    selection?: {
      start: number;
      end: number;
    };

    /**
     * Comment priority or type.
     */
    type?: 'comment' | 'suggestion' | 'issue' | 'question';

    /**
     * Optional tags for categorization.
     */
    tags?: string[];
  }

  /**
   * Data for creating a reply to a comment.
   */
  export interface ICreateReplyData {
    /**
     * Reply text content.
     */
    content: string;

    /**
     * User creating the reply.
     */
    authorId: string;

    /**
     * Reply type.
     */
    type?: 'reply' | 'suggestion';
  }

  /**
   * A comment object.
   */
  export interface IComment {
    /**
     * Unique identifier for the comment.
     */
    id: string;

    /**
     * Cell ID the comment is attached to.
     */
    cellId: string;

    /**
     * Comment text content.
     */
    content: string;

    /**
     * Author user ID.
     */
    authorId: string;

    /**
     * Author display name.
     */
    authorName: string;

    /**
     * Optional author avatar.
     */
    authorAvatar?: string;

    /**
     * When the comment was created.
     */
    createdAt: number;

    /**
     * When the comment was last modified.
     */
    modifiedAt: number;

    /**
     * Position within the cell (character offset).
     */
    position?: number;

    /**
     * Selection range within the cell.
     */
    selection?: {
      start: number;
      end: number;
    };

    /**
     * Comment type.
     */
    type: 'comment' | 'suggestion' | 'issue' | 'question' | 'reply';

    /**
     * Whether the comment thread is resolved.
     */
    isResolved: boolean;

    /**
     * User who resolved the comment (if resolved).
     */
    resolvedBy?: string;

    /**
     * When the comment was resolved.
     */
    resolvedAt?: number;

    /**
     * Parent comment ID (for replies).
     */
    parentId?: string;

    /**
     * Reply comments.
     */
    replies: IComment[];

    /**
     * Comment tags.
     */
    tags: string[];

    /**
     * Number of reactions/likes.
     */
    reactions?: Record<string, number>;

    /**
     * Users who have reacted to this comment.
     */
    reactedUsers?: Record<string, string[]>; // reaction -> userIds
  }

  /**
   * Comment change event.
   */
  export interface ICommentEvent {
    /**
     * Type of comment event.
     */
    type: 'created' | 'updated' | 'deleted' | 'resolved' | 'unresolved' | 'reply-added';

    /**
     * Comment involved in the event.
     */
    comment: IComment;

    /**
     * Previous state (for update events).
     */
    previousState?: Partial<IComment>;

    /**
     * Timestamp of the event.
     */
    timestamp: number;

    /**
     * User who triggered the event.
     */
    userId: string;
  }
}

/**
 * Registry interface for managing comment storage and retrieval.
 */
export interface ICommentRegistry {
  /**
   * Register a new comment.
   * 
   * @param comment - Comment to register
   */
  registerComment(comment: ICommentManager.IComment): void;

  /**
   * Update a registered comment.
   * 
   * @param commentId - Comment identifier
   * @param updates - Partial comment updates
   */
  updateComment(commentId: string, updates: Partial<ICommentManager.IComment>): void;

  /**
   * Remove a comment from the registry.
   * 
   * @param commentId - Comment identifier
   */
  removeComment(commentId: string): void;

  /**
   * Get a comment by ID.
   * 
   * @param commentId - Comment identifier
   */
  getComment(commentId: string): ICommentManager.IComment | null;

  /**
   * Get all comments for a specific cell.
   * 
   * @param cellId - Cell identifier
   */
  getCommentsByCell(cellId: string): ICommentManager.IComment[];

  /**
   * Get all comments in the registry.
   */
  getAllComments(): ICommentManager.IComment[];

  /**
   * Get comments by type.
   * 
   * @param type - Comment type to filter by
   */
  getCommentsByType(type: ICommentManager.IComment['type']): ICommentManager.IComment[];

  /**
   * Get comments by author.
   * 
   * @param authorId - Author user ID
   */
  getCommentsByAuthor(authorId: string): ICommentManager.IComment[];

  /**
   * Get unresolved comments.
   */
  getUnresolvedComments(): ICommentManager.IComment[];

  /**
   * Clear all comments.
   */
  clearComments(): void;

  /**
   * Subscribe to registry changes.
   * 
   * @param callback - Function to call when registry changes
   */
  onRegistryChange(callback: (event: ICommentRegistry.IRegistryEvent) => void): void;

  /**
   * Search comments by content.
   * 
   * @param query - Search query
   */
  searchComments(query: string): ICommentManager.IComment[];
}

export namespace ICommentRegistry {
  /**
   * Registry change event.
   */
  export interface IRegistryEvent {
    /**
     * Type of registry event.
     */
    type: 'comment-added' | 'comment-updated' | 'comment-removed';

    /**
     * Comment involved in the event.
     */
    comment: ICommentManager.IComment;

    /**
     * Previous state (for update events).
     */
    previousState?: Partial<ICommentManager.IComment>;

    /**
     * Timestamp of the event.
     */
    timestamp: number;
  }
}

// ============================================================================
// COLLABORATION TOKENS
// ============================================================================

/**
 * Token for the core Yjs notebook provider service.
 * Provides CRDT-based document synchronization for real-time collaboration.
 */
export const IYjsNotebookProvider = new Token<IYjsNotebookProvider>(
  '@jupyter-notebook/application:IYjsNotebookProvider'
);

/**
 * Token for the awareness registry service.
 * Manages user awareness states in collaborative sessions.
 */
export const IAwarenessRegistry = new Token<IAwarenessRegistry>(
  '@jupyter-notebook/application:IAwarenessRegistry'
);

/**
 * Token for the awareness manager service.
 * Handles awareness protocol operations and state synchronization.
 */
export const IAwarenessManager = new Token<IAwarenessManager>(
  '@jupyter-notebook/application:IAwarenessManager'
);

/**
 * Token for the lock manager service.
 * Manages cell-level locking for conflict resolution.
 */
export const ILockManager = new Token<ILockManager>(
  '@jupyter-notebook/application:ILockManager'
);

/**
 * Token for the lock registry service.
 * Maintains registry of current lock states across cells.
 */
export const ILockRegistry = new Token<ILockRegistry>(
  '@jupyter-notebook/application:ILockRegistry'
);

/**
 * Token for lock acquisition results.
 * Represents the outcome of lock acquisition attempts.
 */
export const ILockAcquisition = new Token<ILockAcquisition>(
  '@jupyter-notebook/application:ILockAcquisition'
);

/**
 * Token for the history manager service.
 * Manages change history and document versioning.
 */
export const IHistoryManager = new Token<IHistoryManager>(
  '@jupyter-notebook/application:IHistoryManager'
);

/**
 * Token for the snapshot registry service.
 * Maintains registry of document snapshots for versioning.
 */
export const ISnapshotRegistry = new Token<ISnapshotRegistry>(
  '@jupyter-notebook/application:ISnapshotRegistry'
);

/**
 * Token for the permissions manager service.
 * Handles access control and user permissions.
 */
export const IPermissionsManager = new Token<IPermissionsManager>(
  '@jupyter-notebook/application:IPermissionsManager'
);

/**
 * Token for the access control list service.
 * Manages fine-grained resource permissions.
 */
export const IAccessControlList = new Token<IAccessControlList>(
  '@jupyter-notebook/application:IAccessControlList'
);

/**
 * Token for the comment manager service.
 * Handles comment creation, management, and review workflows.
 */
export const ICommentManager = new Token<ICommentManager>(
  '@jupyter-notebook/application:ICommentManager'
);

/**
 * Token for the comment registry service.
 * Maintains storage and retrieval of notebook comments.
 */
export const ICommentRegistry = new Token<ICommentRegistry>(
  '@jupyter-notebook/application:ICommentRegistry'
);
