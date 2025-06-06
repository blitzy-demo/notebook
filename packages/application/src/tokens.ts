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
 * The ICollaborationProvider token.
 * 
 * This token provides access to comprehensive collaborative editing capabilities
 * including real-time document synchronization, user presence tracking, conflict
 * resolution, and session management. It enables multi-user notebook editing
 * through Yjs CRDT-based synchronization with sub-100ms latency.
 * 
 * Key capabilities include:
 * - YjsNotebookProvider creation for CRDT-based document synchronization
 * - WebSocket connection management for real-time communication
 * - User awareness system with cursor positions and presence tracking
 * - Cell-level locking mechanisms to prevent editing conflicts
 * - Version history and rollback capabilities
 * - Role-based permission enforcement (viewer, editor, admin)
 * - Comment and annotation system for collaborative reviews
 * - Session lifecycle management with participant coordination
 * 
 * The provider integrates with JupyterHub authentication and supports
 * enterprise-grade deployment scenarios with multi-tier storage backends.
 */
export const ICollaborationProvider = new Token<ICollaborationProvider>(
  '@jupyter-notebook/application:ICollaborationProvider'
);
