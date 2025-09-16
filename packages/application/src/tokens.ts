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
 * The ICollaborationBar interface for managing user presence display.
 */
export interface ICollaborationBar {
  /**
   * Update the presence information for active users.
   *
   * @param users - Array of active users to display
   */
  updatePresence(users: any[]): void;

  /**
   * Show the current connection status.
   *
   * @param connected - Whether the collaboration service is connected
   */
  showConnectionStatus(connected: boolean): void;

  /**
   * Add a new user to the presence display.
   *
   * @param user - The user information to add
   */
  addUser(user: any): void;

  /**
   * Remove a user from the presence display.
   *
   * @param userId - The ID of the user to remove
   */
  removeUser(userId: string): void;

  /**
   * Get the list of currently active users.
   *
   * @returns Array of active users
   */
  getActiveUsers(): any[];
}

/**
 * The ICollaborationBar token for managing collaboration user presence display.
 */
export const ICollaborationBar = new Token<ICollaborationBar>(
  '@jupyter-notebook/application:ICollaborationBar'
);

/**
 * The ICollaborationAwareness interface for tracking user awareness and state.
 */
export interface ICollaborationAwareness {
  /**
   * Get the cursor position for a specific user.
   *
   * @param userId - The ID of the user
   * @returns The cursor position information
   */
  getCursorPosition(userId: string): any;

  /**
   * Get the selection information for a specific user.
   *
   * @param userId - The ID of the user
   * @returns The selection information
   */
  getSelection(userId: string): any;

  /**
   * Get the current state for a specific user.
   *
   * @param userId - The ID of the user
   * @returns The user state information
   */
  getUserState(userId: string): any;

  /**
   * Broadcast the current user's state to other collaborators.
   *
   * @param state - The state information to broadcast
   */
  broadcastState(state: any): void;
}

/**
 * The ICollaborationAwareness token for tracking user awareness in collaboration.
 */
export const ICollaborationAwareness = new Token<ICollaborationAwareness>(
  '@jupyter-notebook/application:ICollaborationAwareness'
);

/**
 * The ICollaborationLocks interface for managing distributed cell locking.
 */
export interface ICollaborationLocks {
  /**
   * Acquire a lock on a specific cell for a user.
   *
   * @param cellId - The ID of the cell to lock
   * @param userId - The ID of the user acquiring the lock
   * @returns Promise resolving to whether the lock was acquired
   */
  acquireLock(cellId: string, userId: string): Promise<boolean>;

  /**
   * Release a lock on a specific cell.
   *
   * @param cellId - The ID of the cell to unlock
   */
  releaseLock(cellId: string): void;

  /**
   * Check if a cell is currently locked.
   *
   * @param cellId - The ID of the cell to check
   * @returns Whether the cell is locked
   */
  isLocked(cellId: string): boolean;

  /**
   * Get the owner of a lock for a specific cell.
   *
   * @param cellId - The ID of the cell
   * @returns The user ID of the lock owner, or null if not locked
   */
  getLockOwner(cellId: string): string | null;

  /**
   * Handle timeout for a locked cell.
   *
   * @param cellId - The ID of the cell to handle timeout for
   */
  handleTimeout(cellId: string): void;
}

/**
 * The ICollaborationLocks token for managing distributed cell locking in collaboration.
 */
export const ICollaborationLocks = new Token<ICollaborationLocks>(
  '@jupyter-notebook/application:ICollaborationLocks'
);

/**
 * The ICollaborationHistory interface for managing version history and changes.
 */
export interface ICollaborationHistory {
  /**
   * Capture a snapshot of the current document state.
   */
  captureSnapshot(): void;

  /**
   * Get the history for a specific cell or the entire document.
   *
   * @param cellId - Optional cell ID to get history for, or undefined for entire document
   * @returns Array of historical versions
   */
  getHistory(cellId?: string): any[];

  /**
   * Get the differences between two versions.
   *
   * @param versionA - The first version to compare
   * @param versionB - The second version to compare
   * @returns The diff information between versions
   */
  getDiff(versionA: any, versionB: any): any;

  /**
   * Restore a specific version of the document or cell.
   *
   * @param versionId - The ID of the version to restore
   */
  restoreVersion(versionId: string): void;
}

/**
 * The ICollaborationHistory token for managing version history in collaboration.
 */
export const ICollaborationHistory = new Token<ICollaborationHistory>(
  '@jupyter-notebook/application:ICollaborationHistory'
);

/**
 * The ICollaborationComments interface for managing collaborative comments and discussions.
 */
export interface ICollaborationComments {
  /**
   * Add a new comment to a specific cell.
   *
   * @param cellId - The ID of the cell to comment on
   * @param text - The comment text
   * @param parentId - Optional parent comment ID for threaded replies
   * @returns The ID of the created comment
   */
  addComment(cellId: string, text: string, parentId?: string): string;

  /**
   * Get all comments for a specific cell.
   *
   * @param cellId - The ID of the cell to get comments for
   * @returns Array of comments for the cell
   */
  getComments(cellId: string): any[];

  /**
   * Mark a comment as resolved.
   *
   * @param commentId - The ID of the comment to resolve
   */
  resolveComment(commentId: string): void;

  /**
   * Subscribe to notifications for new comments.
   *
   * @param callback - Function to call when new comments are added
   */
  subscribeToNotifications(callback: (comment: any) => void): void;
}

/**
 * The ICollaborationComments token for managing collaborative comments and discussions.
 */
export const ICollaborationComments = new Token<ICollaborationComments>(
  '@jupyter-notebook/application:ICollaborationComments'
);
