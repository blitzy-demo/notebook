import { Token } from '@lumino/coreutils';
import { IDisposable } from '@lumino/disposable';
import { ISignal } from '@lumino/signaling';
import { INotebookModel } from '@jupyterlab/notebook';
import * as Y from 'yjs';

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
 * The IYjsNotebookProvider interface.
 * Manages Yjs document lifecycle and binds NotebookModel to Y.Doc for real-time synchronization.
 */
export interface IYjsNotebookProvider extends IDisposable {
  /**
   * Get the Yjs document for a notebook model.
   *
   * @param model - The notebook model to get the Yjs document for.
   * @returns The Yjs document for the notebook model.
   */
  getYjsDocument(model: INotebookModel): Y.Doc;

  /**
   * Create a collaborative notebook model wrapper.
   *
   * @param model - The notebook model to wrap.
   * @returns A collaborative notebook model that synchronizes with Yjs.
   */
  createCollaborativeModel(model: INotebookModel): INotebookModel;

  /**
   * Get the connection status for a notebook model.
   *
   * @param model - The notebook model to check.
   * @returns The connection status.
   */
  getConnectionStatus(model: INotebookModel): 'connected' | 'connecting' | 'disconnected';

  /**
   * Enable collaboration for a notebook model.
   *
   * @param model - The notebook model to enable collaboration for.
   * @param roomId - The room ID for the collaborative session.
   */
  enableCollaboration(model: INotebookModel, roomId: string): Promise<void>;

  /**
   * Disable collaboration for a notebook model.
   *
   * @param model - The notebook model to disable collaboration for.
   */
  disableCollaboration(model: INotebookModel): void;
}

/**
 * The IAwarenessSystem interface.
 * Manages user presence, cursors, and remote selections during collaborative editing.
 */
export interface IAwarenessSystem extends IDisposable {
  /**
   * Get the current user's awareness state.
   */
  getLocalUser(): IAwarenessSystem.IUserState;

  /**
   * Get all remote users' awareness states.
   */
  getRemoteUsers(): ReadonlyArray<IAwarenessSystem.IUserState>;

  /**
   * Set the local user's cursor position.
   *
   * @param cellId - The ID of the cell containing the cursor.
   * @param position - The cursor position within the cell.
   */
  setCursorPosition(cellId: string, position: number): void;

  /**
   * Set the local user's text selection.
   *
   * @param cellId - The ID of the cell containing the selection.
   * @param start - The start position of the selection.
   * @param end - The end position of the selection.
   */
  setSelection(cellId: string, start: number, end: number): void;

  /**
   * Set the local user's active cell.
   *
   * @param cellId - The ID of the active cell.
   */
  setActiveCell(cellId: string): void;

  /**
   * Signal emitted when awareness state changes.
   */
  readonly awarenessChanged: ISignal<IAwarenessSystem, IAwarenessSystem.IUserState[]>;
}

export namespace IAwarenessSystem {
  /**
   * User state information for awareness.
   */
  export interface IUserState {
    /**
     * The user's unique identifier.
     */
    userId: string;

    /**
     * The user's display name.
     */
    userName: string;

    /**
     * The user's avatar URL.
     */
    userAvatar?: string;

    /**
     * The user's assigned color for visual indicators.
     */
    userColor: string;

    /**
     * The ID of the cell where the user's cursor is located.
     */
    activeCellId?: string;

    /**
     * The cursor position within the active cell.
     */
    cursorPosition?: number;

    /**
     * The selection start position within the active cell.
     */
    selectionStart?: number;

    /**
     * The selection end position within the active cell.
     */
    selectionEnd?: number;

    /**
     * The user's current activity status.
     */
    status: 'active' | 'idle' | 'away';

    /**
     * The timestamp of the last activity.
     */
    lastActivity: number;
  }
}

/**
 * The ICollaborationPermissions interface.
 * Validates collaborative operations against user roles and enforces access control policies.
 */
export interface ICollaborationPermissions {
  /**
   * Check if the current user has a specific permission.
   *
   * @param permission - The permission to check.
   * @returns True if the user has the permission, false otherwise.
   */
  hasPermission(permission: ICollaborationPermissions.Permission): boolean;

  /**
   * Get the current user's role.
   *
   * @returns The user's role.
   */
  getUserRole(): ICollaborationPermissions.Role;

  /**
   * Set permissions for a user.
   *
   * @param userId - The user ID to set permissions for.
   * @param role - The role to assign to the user.
   */
  setUserRole(userId: string, role: ICollaborationPermissions.Role): Promise<void>;

  /**
   * Get all users and their roles.
   *
   * @returns A map of user IDs to roles.
   */
  getUserRoles(): Promise<Map<string, ICollaborationPermissions.Role>>;

  /**
   * Check if an operation is allowed for the current user.
   *
   * @param operation - The operation to check.
   * @returns True if the operation is allowed, false otherwise.
   */
  canPerformOperation(operation: ICollaborationPermissions.Operation): boolean;
}

export namespace ICollaborationPermissions {
  /**
   * User roles in the collaboration system.
   */
  export type Role = 'view' | 'edit' | 'admin';

  /**
   * Permissions available in the collaboration system.
   */
  export type Permission = 'read' | 'write' | 'execute' | 'manage_permissions' | 'manage_comments';

  /**
   * Operations that can be performed in the collaboration system.
   */
  export type Operation = 'edit_cell' | 'add_cell' | 'delete_cell' | 'move_cell' | 'execute_cell' | 'add_comment' | 'resolve_comment' | 'manage_users';
}

/**
 * The ICollaborationService interface.
 * Main collaboration service that coordinates all collaborative features and manages feature flag state.
 */
export interface ICollaborationService extends IDisposable {
  /**
   * Check if collaboration is enabled.
   *
   * @returns True if collaboration is enabled, false otherwise.
   */
  isCollaborationEnabled(): boolean;

  /**
   * Enable collaboration for the application.
   */
  enableCollaboration(): Promise<void>;

  /**
   * Disable collaboration for the application.
   */
  disableCollaboration(): void;

  /**
   * Get the collaboration status.
   *
   * @returns The collaboration status.
   */
  getStatus(): ICollaborationService.Status;

  /**
   * Join a collaborative session.
   *
   * @param roomId - The room ID to join.
   * @param model - The notebook model to use for collaboration.
   */
  joinSession(roomId: string, model: INotebookModel): Promise<void>;

  /**
   * Leave the current collaborative session.
   */
  leaveSession(): void;

  /**
   * Get the current session information.
   *
   * @returns The current session information, or null if not in a session.
   */
  getCurrentSession(): ICollaborationService.ISessionInfo | null;
}

export namespace ICollaborationService {
  /**
   * Collaboration service status.
   */
  export type Status = 'enabled' | 'disabled' | 'connecting' | 'connected' | 'error';

  /**
   * Collaborative session information.
   */
  export interface ISessionInfo {
    /**
     * The session room ID.
     */
    roomId: string;

    /**
     * The notebook model being collaborated on.
     */
    model: INotebookModel;

    /**
     * The number of active users in the session.
     */
    userCount: number;

    /**
     * The session start time.
     */
    startTime: Date;
  }
}

/**
 * The ICollaborationToolbar interface.
 * Collaboration toolbar component that displays active users, connection status, and collaboration controls.
 */
export interface ICollaborationToolbar extends IDisposable {
  /**
   * Show the collaboration toolbar.
   */
  show(): void;

  /**
   * Hide the collaboration toolbar.
   */
  hide(): void;

  /**
   * Check if the toolbar is visible.
   *
   * @returns True if the toolbar is visible, false otherwise.
   */
  isVisible(): boolean;

  /**
   * Update the user list display.
   *
   * @param users - The list of users to display.
   */
  updateUsers(users: ReadonlyArray<IAwarenessSystem.IUserState>): void;

  /**
   * Update the connection status display.
   *
   * @param status - The connection status.
   */
  updateConnectionStatus(status: 'connected' | 'connecting' | 'disconnected'): void;

  /**
   * Set the current user's role display.
   *
   * @param role - The user's role.
   */
  setUserRole(role: ICollaborationPermissions.Role): void;
}

/**
 * The ILockManager interface.
 * Lock manager service that enforces cell-level locks via Yjs shared map and prevents editing conflicts.
 */
export interface ILockManager extends IDisposable {
  /**
   * Acquire a lock on a cell.
   *
   * @param cellId - The ID of the cell to lock.
   * @returns A promise that resolves to true if the lock was acquired, false otherwise.
   */
  acquireLock(cellId: string): Promise<boolean>;

  /**
   * Release a lock on a cell.
   *
   * @param cellId - The ID of the cell to unlock.
   */
  releaseLock(cellId: string): void;

  /**
   * Check if a cell is locked.
   *
   * @param cellId - The ID of the cell to check.
   * @returns True if the cell is locked, false otherwise.
   */
  isLocked(cellId: string): boolean;

  /**
   * Get the user who has locked a cell.
   *
   * @param cellId - The ID of the cell to check.
   * @returns The user ID who has locked the cell, or null if not locked.
   */
  getLockOwner(cellId: string): string | null;

  /**
   * Get all currently locked cells.
   *
   * @returns A map of cell IDs to the user IDs who have locked them.
   */
  getLockedCells(): Map<string, string>;

  /**
   * Set the lock timeout duration.
   *
   * @param timeout - The timeout duration in milliseconds.
   */
  setLockTimeout(timeout: number): void;

  /**
   * Release all locks held by the current user.
   */
  releaseAllLocks(): void;
}

/**
 * The ICommentSystem interface.
 * Comment system that enables threaded comments attached to notebook cells for collaborative review.
 */
export interface ICommentSystem extends IDisposable {
  /**
   * Add a comment to a cell.
   *
   * @param cellId - The ID of the cell to add the comment to.
   * @param content - The comment content.
   * @param parentId - The ID of the parent comment for replies.
   * @returns The created comment.
   */
  addComment(cellId: string, content: string, parentId?: string): Promise<ICommentSystem.IComment>;

  /**
   * Get all comments for a cell.
   *
   * @param cellId - The ID of the cell to get comments for.
   * @returns An array of comments for the cell.
   */
  getComments(cellId: string): ReadonlyArray<ICommentSystem.IComment>;

  /**
   * Get all comments for the entire notebook.
   *
   * @returns A map of cell IDs to arrays of comments.
   */
  getAllComments(): Map<string, ReadonlyArray<ICommentSystem.IComment>>;

  /**
   * Resolve a comment thread.
   *
   * @param commentId - The ID of the comment to resolve.
   */
  resolveComment(commentId: string): Promise<void>;

  /**
   * Unresolve a comment thread.
   *
   * @param commentId - The ID of the comment to unresolve.
   */
  unresolveComment(commentId: string): Promise<void>;

  /**
   * Delete a comment.
   *
   * @param commentId - The ID of the comment to delete.
   */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Edit a comment.
   *
   * @param commentId - The ID of the comment to edit.
   * @param content - The new comment content.
   */
  editComment(commentId: string, content: string): Promise<void>;

  /**
   * Get the number of unresolved comments for a cell.
   *
   * @param cellId - The ID of the cell to check.
   * @returns The number of unresolved comments.
   */
  getUnresolvedCommentCount(cellId: string): number;
}

export namespace ICommentSystem {
  /**
   * A comment in the comment system.
   */
  export interface IComment {
    /**
     * The unique ID of the comment.
     */
    id: string;

    /**
     * The ID of the cell this comment is attached to.
     */
    cellId: string;

    /**
     * The content of the comment.
     */
    content: string;

    /**
     * The ID of the user who created the comment.
     */
    authorId: string;

    /**
     * The display name of the author.
     */
    authorName: string;

    /**
     * The creation timestamp.
     */
    createdAt: Date;

    /**
     * The last modification timestamp.
     */
    modifiedAt: Date;

    /**
     * Whether the comment is resolved.
     */
    resolved: boolean;

    /**
     * The ID of the parent comment for replies.
     */
    parentId?: string;

    /**
     * The replies to this comment.
     */
    replies: ReadonlyArray<IComment>;
  }
}

/**
 * The IYjsNotebookProvider token.
 * Manages Yjs document lifecycle and binds NotebookModel to Y.Doc for real-time synchronization.
 */
export const IYjsNotebookProvider = new Token<IYjsNotebookProvider>(
  '@jupyter-notebook/application:IYjsNotebookProvider'
);

/**
 * The IAwarenessSystem token.
 * Manages user presence, cursors, and remote selections during collaborative editing.
 */
export const IAwarenessSystem = new Token<IAwarenessSystem>(
  '@jupyter-notebook/application:IAwarenessSystem'
);

/**
 * The ICollaborationPermissions token.
 * Validates collaborative operations against user roles and enforces access control policies.
 */
export const ICollaborationPermissions = new Token<ICollaborationPermissions>(
  '@jupyter-notebook/application:ICollaborationPermissions'
);

/**
 * The ICollaborationService token.
 * Main collaboration service that coordinates all collaborative features and manages feature flag state.
 */
export const ICollaborationService = new Token<ICollaborationService>(
  '@jupyter-notebook/application:ICollaborationService'
);

/**
 * The ICollaborationToolbar token.
 * Collaboration toolbar component that displays active users, connection status, and collaboration controls.
 */
export const ICollaborationToolbar = new Token<ICollaborationToolbar>(
  '@jupyter-notebook/application:ICollaborationToolbar'
);

/**
 * The ILockManager token.
 * Lock manager service that enforces cell-level locks via Yjs shared map and prevents editing conflicts.
 */
export const ILockManager = new Token<ILockManager>(
  '@jupyter-notebook/application:ILockManager'
);

/**
 * The ICommentSystem token.
 * Comment system that enables threaded comments attached to notebook cells for collaborative review.
 */
export const ICommentSystem = new Token<ICommentSystem>(
  '@jupyter-notebook/application:ICommentSystem'
);
