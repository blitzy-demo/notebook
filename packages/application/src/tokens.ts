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
 * The ICollaborationStatusManager interface.
 */
export interface ICollaborationStatusManager {
  /**
   * Check if collaboration is enabled in the current environment.
   */
  readonly isEnabled: boolean;

  /**
   * Get the current collaboration connection status.
   */
  readonly connectionStatus: ICollaborationStatusManager.ConnectionStatus;

  /**
   * Get the current user's role in the collaborative session.
   */
  readonly userRole: ICollaborationStatusManager.UserRole;

  /**
   * Signal emitted when collaboration status changes.
   */
  readonly statusChanged: ISignal<ICollaborationStatusManager, ICollaborationStatusManager.IStatusChangedArgs>;

  /**
   * Update the collaboration connection status.
   */
  updateConnectionStatus(status: ICollaborationStatusManager.ConnectionStatus): void;

  /**
   * Update the current user's role.
   */
  updateUserRole(role: ICollaborationStatusManager.UserRole): void;
}

export namespace ICollaborationStatusManager {
  /**
   * Connection status enumeration.
   */
  export enum ConnectionStatus {
    Connecting = 'connecting',
    Connected = 'connected',
    Disconnected = 'disconnected',
    Error = 'error'
  }

  /**
   * User role enumeration.
   */
  export enum UserRole {
    Viewer = 'viewer',
    Editor = 'editor',
    Admin = 'admin'
  }

  /**
   * Status changed event arguments.
   */
  export interface IStatusChangedArgs {
    /**
     * The previous connection status.
     */
    oldConnectionStatus: ConnectionStatus;

    /**
     * The new connection status.
     */
    newConnectionStatus: ConnectionStatus;

    /**
     * The previous user role.
     */
    oldUserRole: UserRole;

    /**
     * The new user role.
     */
    newUserRole: UserRole;
  }
}

/**
 * The ICollaborationAwareness interface for managing user presence.
 */
export interface ICollaborationAwareness {
  /**
   * Get the list of currently active users.
   */
  readonly activeUsers: ReadonlyArray<ICollaborationAwareness.IUser>;

  /**
   * Get the current user information.
   */
  readonly currentUser: ICollaborationAwareness.IUser | null;

  /**
   * Signal emitted when active users change.
   */
  readonly usersChanged: ISignal<ICollaborationAwareness, ICollaborationAwareness.IUsersChangedArgs>;

  /**
   * Update user presence information.
   */
  updateUserPresence(user: ICollaborationAwareness.IUser): void;

  /**
   * Remove user from active users.
   */
  removeUser(userId: string): void;
}

export namespace ICollaborationAwareness {
  /**
   * User information interface.
   */
  export interface IUser {
    /**
     * Unique user identifier.
     */
    id: string;

    /**
     * Display name for the user.
     */
    name: string;

    /**
     * Avatar URL or initials.
     */
    avatar?: string;

    /**
     * User's assigned color for presence indicators.
     */
    color: string;

    /**
     * Current cursor position.
     */
    cursor?: {
      cellId: string;
      line: number;
      column: number;
    };

    /**
     * Currently selected cell.
     */
    activeCell?: string;

    /**
     * Last activity timestamp.
     */
    lastActivity: number;
  }

  /**
   * Users changed event arguments.
   */
  export interface IUsersChangedArgs {
    /**
     * Users that were added.
     */
    added: ReadonlyArray<IUser>;

    /**
     * Users that were removed.
     */
    removed: ReadonlyArray<IUser>;

    /**
     * Users that were updated.
     */
    updated: ReadonlyArray<IUser>;
  }
}

/**
 * The ICollaborationStatusManager token.
 */
export const ICollaborationStatusManager = new Token<ICollaborationStatusManager>(
  '@jupyter-notebook/application:ICollaborationStatusManager'
);

/**
 * The ICollaborationAwareness token.
 */
export const ICollaborationAwareness = new Token<ICollaborationAwareness>(
  '@jupyter-notebook/application:ICollaborationAwareness'
);
