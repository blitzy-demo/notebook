// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISessionContext } from '@jupyterlab/apputils';
import { Cell, ICellModel } from '@jupyterlab/cells';
import { IChangedArgs } from '@jupyterlab/coreutils';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { INotebookShell } from '@jupyter-notebook/application';
import { ISignal, Signal } from '@lumino/signaling';
import { Panel, Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import { UUID } from '@lumino/coreutils';

// Yjs imports for collaborative editing
import * as Y from 'yjs';

// Import collaboration modules
import { YjsAwareness, IAwarenessState, ICursorPosition } from './collab/awareness';
import { ILockManager, ILockInfo, LockManagerStatus } from './collab/locks';
import { ICommentSystem, ICommentThread, CommentStatus } from './collab/comments';

// Import the notebook model
import { NotebookModel, IYjsNotebookProvider } from './model';

/**
 * The CSS class added to notebook widgets.
 */
const NOTEBOOK_CLASS = 'jp-Notebook';

/**
 * The CSS class added to notebook widgets in collaborative mode.
 */
const COLLABORATIVE_CLASS = 'jp-Notebook-collaborative';

/**
 * The CSS class added to the collaborative user presence panel.
 */
const COLLAB_PRESENCE_CLASS = 'jp-Notebook-collaborativePresence';

/**
 * The CSS class added to the collaborative user avatar.
 */
const COLLAB_AVATAR_CLASS = 'jp-Notebook-collaborativeAvatar';

/**
 * The CSS class added to the collaborative user cursor.
 */
const COLLAB_CURSOR_CLASS = 'jp-Notebook-collaborativeCursor';

/**
 * The CSS class added to the collaborative user selection.
 */
const COLLAB_SELECTION_CLASS = 'jp-Notebook-collaborativeSelection';

/**
 * The CSS class added to the collaborative cell lock indicator.
 */
const COLLAB_LOCK_CLASS = 'jp-Notebook-collaborativeLock';

/**
 * The CSS class added to the collaborative comment indicator.
 */
const COLLAB_COMMENT_CLASS = 'jp-Notebook-collaborativeComment';

/**
 * The CSS class added to the collaborative status bar.
 */
const COLLAB_STATUS_CLASS = 'jp-Notebook-collaborativeStatus';

/**
 * The notebook widget.
 */
export class NotebookPanel extends Panel {
  /**
   * Construct a new notebook widget.
   */
  constructor(options: NotebookPanel.IOptions) {
    super();
    this.addClass('jp-NotebookPanel');

    // Create the notebook content widget
    this.content = new Notebook({
      rendermime: options.rendermime,
      contentFactory: options.contentFactory,
      translator: options.translator || nullTranslator
    });

    // Add the notebook content to the panel
    this.addWidget(this.content);

    // Create the model
    this._model = options.model;
    this._context = options.context;

    // Set up collaborative features if enabled
    if (this._model.collaborative) {
      this._initializeCollaboration();
    }

    // Connect to model signals
    this._model.contentChanged.connect(this._onContentChanged, this);

    // Create the toolbar if needed
    if (options.toolbar) {
      this._toolbar = options.toolbar;
      this.addWidget(this._toolbar);
    }

    // Create the collaborative status bar if in collaborative mode
    if (this._model.collaborative) {
      this._createCollaborativeStatusBar();
    }

    // Set up session context
    this.sessionContext = options.sessionContext;
    this.sessionContext.kernelChanged.connect(this._onKernelChanged, this);
  }

  /**
   * The notebook content widget.
   */
  readonly content: Notebook;

  /**
   * The session context for the notebook.
   */
  readonly sessionContext: ISessionContext;

  /**
   * The model for the widget.
   */
  get model(): NotebookModel {
    return this._model;
  }

  /**
   * The toolbar for the widget.
   */
  get toolbar(): Widget | null {
    return this._toolbar;
  }

  /**
   * The document context for the widget.
   */
  get context(): DocumentRegistry.IContext<NotebookModel> | null {
    return this._context;
  }

  /**
   * The lock manager for collaborative editing.
   */
  get lockManager(): ILockManager | null {
    return this._lockManager;
  }

  /**
   * The comment system for collaborative editing.
   */
  get commentSystem(): ICommentSystem | null {
    return this._commentSystem;
  }

  /**
   * The awareness provider for collaborative editing.
   */
  get awareness(): YjsAwareness | null {
    return this._awareness;
  }

  /**
   * A signal emitted when the widget's context changes.
   */
  get contextChanged(): ISignal<NotebookPanel, void> {
    return this._contextChanged;
  }

  /**
   * A signal emitted when the collaborative status changes.
   */
  get collaborativeStatusChanged(): ISignal<NotebookPanel, boolean> {
    return this._collaborativeStatusChanged;
  }

  /**
   * Handle `'activate-request'` messages.
   */
  protected onActivateRequest(msg: Message): void {
    this.content.activate();
  }

  /**
   * Handle `'close-request'` messages.
   */
  protected onCloseRequest(msg: Message): void {
    // Clean up collaborative resources
    this._cleanupCollaboration();
    super.onCloseRequest(msg);
  }

  /**
   * Handle a change to the notebook content.
   */
  private _onContentChanged(): void {
    // Update the collaborative status if needed
    if (this._model.collaborative && this._yjsProvider) {
      this._updateCollaborativeStatus();
    }
  }

  /**
   * Handle a change to the kernel.
   */
  private _onKernelChanged(): void {
    // No-op for now
  }

  /**
   * Initialize collaborative editing features.
   */
  private _initializeCollaboration(): void {
    // Get the Yjs provider from the model
    this._yjsProvider = this._model.yjsProvider;
    if (!this._yjsProvider) {
      console.warn('Collaborative mode enabled but no Yjs provider available');
      return;
    }

    // Get the awareness provider
    this._awareness = this._yjsProvider.awareness;

    // Add the collaborative class to the notebook
    this.content.addClass(COLLABORATIVE_CLASS);

    // Create the lock manager if not already created
    if (!this._lockManager && this._yjsProvider) {
      this._createLockManager();
    }

    // Create the comment system if not already created
    if (!this._commentSystem && this._yjsProvider) {
      this._createCommentSystem();
    }

    // Set up awareness state
    this._setupAwareness();

    // Set up collaborative UI elements
    this._setupCollaborativeUI();

    // Update the collaborative status
    this._updateCollaborativeStatus();

    // Emit the collaborative status changed signal
    this._collaborativeStatusChanged.emit(true);
  }

  /**
   * Clean up collaborative editing resources.
   */
  private _cleanupCollaboration(): void {
    // Clean up lock manager
    if (this._lockManager) {
      this._lockManager.dispose();
      this._lockManager = null;
    }

    // Clean up comment system
    if (this._commentSystem) {
      this._commentSystem.dispose();
      this._commentSystem = null;
    }

    // Clean up awareness
    if (this._awareness) {
      this._awareness.destroy();
      this._awareness = null;
    }

    // Clean up UI elements
    this._cleanupCollaborativeUI();

    // Remove the collaborative class from the notebook
    this.content.removeClass(COLLABORATIVE_CLASS);

    // Emit the collaborative status changed signal
    this._collaborativeStatusChanged.emit(false);
  }

  /**
   * Create the lock manager for collaborative editing.
   */
  private _createLockManager(): void {
    if (!this._yjsProvider) {
      return;
    }

    // Import the lock manager dynamically to avoid circular dependencies
    import('./collab/locks').then(module => {
      // Create the lock manager
      this._lockManager = module.createLockManager({
        ydoc: this._yjsProvider!.ydoc,
        awareness: this._awareness!.awareness,
        userId: this._getUserId(),
        userName: this._getUserName()
      });

      // Connect to lock manager signals
      this._lockManager.lockAcquired.connect(this._onLockAcquired, this);
      this._lockManager.lockReleased.connect(this._onLockReleased, this);
      this._lockManager.lockFailed.connect(this._onLockFailed, this);
      this._lockManager.statusChanged.connect(this._onLockManagerStatusChanged, this);

      // Update the UI to reflect initial lock state
      this._updateLockUI();
    });
  }

  /**
   * Create the comment system for collaborative editing.
   */
  private _createCommentSystem(): void {
    if (!this._yjsProvider) {
      return;
    }

    // Import the comment system dynamically to avoid circular dependencies
    import('./collab/comments').then(module => {
      // Create the comment system
      this._commentSystem = new module.CommentSystem(this._model, this._yjsProvider!.ydoc);

      // Connect to comment system signals
      this._commentSystem.changed.connect(this._onCommentsChanged, this);
      this._commentSystem.notificationsChanged.connect(this._onNotificationsChanged, this);

      // Update the UI to reflect initial comment state
      this._updateCommentUI();
    });
  }

  /**
   * Set up awareness for collaborative editing.
   */
  private _setupAwareness(): void {
    if (!this._awareness) {
      return;
    }

    // Set initial local state
    const initialState: IAwarenessState = {
      user: {
        name: this._getUserName(),
        id: this._getUserId(),
        // Generate a random color for the user
        color: this._getRandomColor()
      },
      activity: {
        type: 'viewing',
        timestamp: Date.now()
      }
    };

    this._awareness.setLocalState(initialState);

    // Connect to awareness state changes
    this._awareness.stateChanged.connect(this._onAwarenessChanged, this);

    // Set up cursor tracking
    this.content.activeCellChanged.connect(this._onActiveCellChanged, this);
  }

  /**
   * Set up collaborative UI elements.
   */
  private _setupCollaborativeUI(): void {
    // Create the presence panel
    this._presencePanel = new Widget();
    this._presencePanel.addClass(COLLAB_PRESENCE_CLASS);
    this.addWidget(this._presencePanel);

    // Update the presence panel with current users
    this._updatePresencePanel();
  }

  /**
   * Clean up collaborative UI elements.
   */
  private _cleanupCollaborativeUI(): void {
    // Remove the presence panel
    if (this._presencePanel) {
      this.removeWidget(this._presencePanel);
      this._presencePanel.dispose();
      this._presencePanel = null;
    }

    // Remove the status bar
    if (this._statusBar) {
      this.removeWidget(this._statusBar);
      this._statusBar.dispose();
      this._statusBar = null;
    }

    // Remove all cursor and selection elements
    this._removeAllCursors();
  }

  /**
   * Create the collaborative status bar.
   */
  private _createCollaborativeStatusBar(): void {
    this._statusBar = new Widget();
    this._statusBar.addClass(COLLAB_STATUS_CLASS);
    this.addWidget(this._statusBar);
    this._updateCollaborativeStatus();
  }

  /**
   * Update the collaborative status bar.
   */
  private _updateCollaborativeStatus(): void {
    if (!this._statusBar || !this._yjsProvider) {
      return;
    }

    const connected = this._yjsProvider.connected;
    const userCount = this._awareness ? this._awareness.getStates().size : 0;

    let statusText = '';
    if (connected) {
      statusText = `Connected | ${userCount} user${userCount !== 1 ? 's' : ''} online`;
      this._statusBar.removeClass('jp-mod-disconnected');
    } else {
      statusText = 'Disconnected | Changes will sync when reconnected';
      this._statusBar.addClass('jp-mod-disconnected');
    }

    this._statusBar.node.textContent = statusText;
  }

  /**
   * Update the presence panel with current users.
   */
  private _updatePresencePanel(): void {
    if (!this._presencePanel || !this._awareness) {
      return;
    }

    // Clear the current content
    this._presencePanel.node.innerHTML = '';

    // Get all awareness states
    const states = this._awareness.getStates();
    const users = new Map<string, IAwarenessState>();

    // Group by user ID to avoid duplicates
    states.forEach(state => {
      if (state.user && state.user.id) {
        users.set(state.user.id, state);
      }
    });

    // Create avatar elements for each user
    users.forEach(state => {
      const user = state.user;
      if (!user) {
        return;
      }

      const avatarElement = document.createElement('div');
      avatarElement.className = COLLAB_AVATAR_CLASS;
      avatarElement.style.backgroundColor = user.color || '#ccc';
      avatarElement.title = user.name || 'Unknown user';
      avatarElement.textContent = this._getInitials(user.name || 'Unknown');

      // Add activity indicator if available
      if (state.activity) {
        avatarElement.setAttribute('data-activity', state.activity.type);
      }

      this._presencePanel.node.appendChild(avatarElement);
    });
  }

  /**
   * Update the lock UI to reflect the current lock state.
   */
  private _updateLockUI(): void {
    if (!this._lockManager) {
      return;
    }

    // Get all active locks
    const locks = this._lockManager.getAllLocks();

    // Update the UI for each cell
    this.content.widgets.forEach((cell: Cell) => {
      const cellId = cell.model.id;
      const lock = this._lockManager!.getLock(cellId);

      // Remove existing lock indicator
      const existingIndicator = cell.node.querySelector(`.${COLLAB_LOCK_CLASS}`);
      if (existingIndicator) {
        existingIndicator.remove();
      }

      // Add lock indicator if the cell is locked
      if (lock) {
        const lockIndicator = document.createElement('div');
        lockIndicator.className = COLLAB_LOCK_CLASS;
        lockIndicator.title = `Locked by ${lock.userName}`;

        // Style the indicator based on whether the current user owns the lock
        if (lock.userId === this._getUserId()) {
          lockIndicator.classList.add('jp-mod-owned');
        } else {
          lockIndicator.classList.add('jp-mod-locked');
          // Make the cell read-only if locked by another user
          cell.setReadOnly(true);
        }

        // Add the lock indicator to the cell
        cell.node.appendChild(lockIndicator);
      } else {
        // Reset read-only state if not locked
        cell.setReadOnly(this._model.readOnly);
      }
    });
  }

  /**
   * Update the comment UI to reflect the current comment state.
   */
  private _updateCommentUI(): void {
    if (!this._commentSystem) {
      return;
    }

    // Get all comment threads
    const threads = this._commentSystem.getThreads();

    // Update the UI for each cell
    this.content.widgets.forEach((cell: Cell) => {
      const cellId = cell.model.id;
      const cellThreads = this._commentSystem!.getThreadsForCell(cellId);

      // Remove existing comment indicators
      const existingIndicators = cell.node.querySelectorAll(`.${COLLAB_COMMENT_CLASS}`);
      existingIndicators.forEach(indicator => indicator.remove());

      // Add comment indicators if the cell has comments
      if (cellThreads.length > 0) {
        const commentIndicator = document.createElement('div');
        commentIndicator.className = COLLAB_COMMENT_CLASS;

        // Count open comments
        const openComments = cellThreads.reduce((count, thread) => {
          return count + thread.comments.filter(c => c.status === CommentStatus.Open).length;
        }, 0);

        commentIndicator.title = `${cellThreads.length} comment thread${cellThreads.length !== 1 ? 's' : ''}, ${openComments} open`;
        commentIndicator.textContent = `${cellThreads.length}`;

        // Style the indicator based on whether there are open comments
        if (openComments > 0) {
          commentIndicator.classList.add('jp-mod-hasOpen');
        }

        // Add the comment indicator to the cell
        cell.node.appendChild(commentIndicator);

        // Add click handler to show comments
        commentIndicator.addEventListener('click', () => {
          this._showCommentsForCell(cellId);
        });
      }
    });
  }

  /**
   * Show comments for a specific cell.
   */
  private _showCommentsForCell(cellId: string): void {
    // This would be implemented to show a comment panel or dialog
    // For now, just log the comments
    if (this._commentSystem) {
      const threads = this._commentSystem.getThreadsForCell(cellId);
      console.log('Comments for cell', cellId, threads);
    }
  }

  /**
   * Update the cursor and selection UI for all users.
   */
  private _updateCursorsAndSelections(): void {
    if (!this._awareness) {
      return;
    }

    // Remove all existing cursors and selections
    this._removeAllCursors();

    // Get all awareness states
    const states = this._awareness.getStates();
    const localClientId = this._awareness.clientID;

    // Create cursor and selection elements for each user
    states.forEach((state, clientId) => {
      // Skip the local user
      if (clientId === localClientId) {
        return;
      }

      // Skip users without cursor information
      if (!state.user || !state.cursor) {
        return;
      }

      const user = state.user;
      const cursor = state.cursor;

      // Find the cell containing the cursor
      const cell = this._getCellAtIndex(cursor.cellIndex);
      if (!cell) {
        return;
      }

      // Create cursor element
      this._createCursorElement(cell, cursor, user);

      // Create selection element if there's a selection
      if (cursor.selection) {
        this._createSelectionElement(cell, cursor, user);
      }
    });
  }

  /**
   * Create a cursor element for a remote user.
   */
  private _createCursorElement(cell: Cell, cursor: ICursorPosition, user: any): void {
    const cursorElement = document.createElement('div');
    cursorElement.className = COLLAB_CURSOR_CLASS;
    cursorElement.style.backgroundColor = user.color || '#ccc';
    cursorElement.setAttribute('data-user-id', user.id);
    cursorElement.setAttribute('data-client-id', String(this._awareness!.clientID));

    // Add user name tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'jp-Notebook-collaborativeCursor-tooltip';
    tooltip.textContent = user.name || 'Unknown user';
    tooltip.style.backgroundColor = user.color || '#ccc';
    cursorElement.appendChild(tooltip);

    // Position the cursor element
    // This is a simplified positioning - in a real implementation,
    // you would need to calculate the exact position based on the cursor offset
    const editorNode = cell.node.querySelector('.CodeMirror');
    if (editorNode) {
      editorNode.appendChild(cursorElement);
      // Store the cursor element for later cleanup
      this._cursorElements.push(cursorElement);
    }
  }

  /**
   * Create a selection element for a remote user.
   */
  private _createSelectionElement(cell: Cell, cursor: ICursorPosition, user: any): void {
    if (!cursor.selection) {
      return;
    }

    const selectionElement = document.createElement('div');
    selectionElement.className = COLLAB_SELECTION_CLASS;
    selectionElement.style.backgroundColor = `${user.color}33`; // Add transparency
    selectionElement.style.borderColor = user.color || '#ccc';
    selectionElement.setAttribute('data-user-id', user.id);
    selectionElement.setAttribute('data-client-id', String(this._awareness!.clientID));

    // Position the selection element
    // This is a simplified positioning - in a real implementation,
    // you would need to calculate the exact position based on the selection range
    const editorNode = cell.node.querySelector('.CodeMirror');
    if (editorNode) {
      editorNode.appendChild(selectionElement);
      // Store the selection element for later cleanup
      this._selectionElements.push(selectionElement);
    }
  }

  /**
   * Remove all cursor and selection elements.
   */
  private _removeAllCursors(): void {
    // Remove cursor elements
    this._cursorElements.forEach(element => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    });
    this._cursorElements = [];

    // Remove selection elements
    this._selectionElements.forEach(element => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    });
    this._selectionElements = [];
  }

  /**
   * Handle awareness state changes.
   */
  private _onAwarenessChanged(sender: YjsAwareness, changes: any): void {
    // Update the presence panel
    this._updatePresencePanel();

    // Update cursors and selections
    this._updateCursorsAndSelections();
  }

  /**
   * Handle active cell changes.
   */
  private _onActiveCellChanged(sender: any, args: any): void {
    if (!this._awareness) {
      return;
    }

    // Update the local awareness state with the new active cell
    const activeCell = this.content.activeCell;
    if (activeCell) {
      const state = this._awareness.getLocalState() || {};
      const cellIndex = this.content.widgets.indexOf(activeCell);

      // Update the cursor position
      state.cursor = {
        cellIndex,
        offset: 0, // This would be the actual cursor position within the cell
        active: true
      };

      // Update the activity
      state.activity = {
        type: 'editing',
        timestamp: Date.now()
      };

      this._awareness.setLocalState(state);
    }
  }

  /**
   * Handle lock acquisition.
   */
  private _onLockAcquired(sender: ILockManager, lock: ILockInfo): void {
    // Update the lock UI
    this._updateLockUI();
  }

  /**
   * Handle lock release.
   */
  private _onLockReleased(sender: ILockManager, lock: ILockInfo): void {
    // Update the lock UI
    this._updateLockUI();
  }

  /**
   * Handle lock acquisition failure.
   */
  private _onLockFailed(sender: ILockManager, result: any): void {
    // Show a notification to the user
    console.warn('Failed to acquire lock:', result.error);
  }

  /**
   * Handle lock manager status changes.
   */
  private _onLockManagerStatusChanged(sender: ILockManager, status: LockManagerStatus): void {
    // Update the UI based on the lock manager status
    console.log('Lock manager status changed:', status);
  }

  /**
   * Handle comment changes.
   */
  private _onCommentsChanged(sender: ICommentSystem, event: any): void {
    // Update the comment UI
    this._updateCommentUI();
  }

  /**
   * Handle notification changes.
   */
  private _onNotificationsChanged(sender: ICommentSystem, notifications: any[]): void {
    // Update the notification UI
    console.log('Notifications changed:', notifications);
  }

  /**
   * Get the cell at the specified index.
   */
  private _getCellAtIndex(index: number): Cell | null {
    if (index < 0 || index >= this.content.widgets.length) {
      return null;
    }
    return this.content.widgets[index] as Cell;
  }

  /**
   * Get the current user ID.
   */
  private _getUserId(): string {
    // In a real implementation, this would come from the authentication system
    return this._userId || (this._userId = UUID.uuid4());
  }

  /**
   * Get the current user name.
   */
  private _getUserName(): string {
    // In a real implementation, this would come from the authentication system
    return this._userName || 'Anonymous';
  }

  /**
   * Get initials from a name.
   */
  private _getInitials(name: string): string {
    return name
      .split(' ')
      .map(part => part.charAt(0))
      .join('')
      .toUpperCase()
      .substring(0, 2);
  }

  /**
   * Generate a random color for a user.
   */
  private _getRandomColor(): string {
    const colors = [
      '#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5',
      '#2196F3', '#03A9F4', '#00BCD4', '#009688', '#4CAF50',
      '#8BC34A', '#CDDC39', '#FFEB3B', '#FFC107', '#FF9800',
      '#FF5722', '#795548', '#9E9E9E', '#607D8B'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  private _model: NotebookModel;
  private _context: DocumentRegistry.IContext<NotebookModel> | null;
  private _toolbar: Widget | null = null;
  private _statusBar: Widget | null = null;
  private _presencePanel: Widget | null = null;
  private _yjsProvider: IYjsNotebookProvider | null = null;
  private _awareness: YjsAwareness | null = null;
  private _lockManager: ILockManager | null = null;
  private _commentSystem: ICommentSystem | null = null;
  private _userId: string = '';
  private _userName: string = 'Anonymous';
  private _cursorElements: HTMLElement[] = [];
  private _selectionElements: HTMLElement[] = [];
  private _contextChanged = new Signal<NotebookPanel, void>(this);
  private _collaborativeStatusChanged = new Signal<NotebookPanel, boolean>(this);
}

/**
 * The namespace for NotebookPanel class statics.
 */
export namespace NotebookPanel {
  /**
   * An options object for initializing a notebook widget.
   */
  export interface IOptions {
    /**
     * The rendermime instance used by the widget.
     */
    rendermime: IRenderMimeRegistry;

    /**
     * The content factory for the widget.
     */
    contentFactory: Notebook.IContentFactory;

    /**
     * The model for the widget.
     */
    model: NotebookModel;

    /**
     * The service manager used by the widget.
     */
    sessionContext: ISessionContext;

    /**
     * The application language translator.
     */
    translator?: ITranslator;

    /**
     * The toolbar for the widget.
     */
    toolbar?: Widget;

    /**
     * The document context for the widget.
     */
    context?: DocumentRegistry.IContext<NotebookModel>;
  }
}

/**
 * A notebook widget.
 */
export class Notebook extends Widget {
  /**
   * Construct a notebook widget.
   */
  constructor(options: Notebook.IOptions) {
    super();
    this.addClass(NOTEBOOK_CLASS);

    this._rendermime = options.rendermime;
    this._contentFactory = options.contentFactory;
    this._translator = options.translator || nullTranslator;

    // Create the cell container
    this._cellContainer = new Panel();
    this._cellContainer.addClass('jp-Notebook-cellContainer');
    this.addWidget(this._cellContainer);
  }

  /**
   * A signal emitted when the active cell changes.
   */
  get activeCellChanged(): ISignal<Notebook, Cell | null> {
    return this._activeCellChanged;
  }

  /**
   * The active cell widget.
   */
  get activeCell(): Cell | null {
    return this._activeCell;
  }

  /**
   * The rendermime instance used by the widget.
   */
  get rendermime(): IRenderMimeRegistry {
    return this._rendermime;
  }

  /**
   * The content factory used by the widget.
   */
  get contentFactory(): Notebook.IContentFactory {
    return this._contentFactory;
  }

  /**
   * The model for the widget.
   */
  get model(): NotebookModel | null {
    return this._model;
  }
  set model(value: NotebookModel | null) {
    if (this._model === value) {
      return;
    }

    // Clean up existing model connections
    if (this._model) {
      this._model.cells.changed.disconnect(this._onCellsChanged, this);
    }

    this._model = value;

    // Connect to the new model
    if (this._model) {
      this._model.cells.changed.connect(this._onCellsChanged, this);
      this._onCellsChanged(this._model.cells, {
        type: 'add',
        oldIndex: 0,
        newIndex: 0,
        oldValues: [],
        newValues: this._model.cells.slice()
      });
    } else {
      // Clear the notebook if there's no model
      this._cellContainer.widgets.forEach(widget => widget.dispose());
      this._cellContainer.clearWidgets();
    }
  }

  /**
   * The cells in the notebook.
   */
  get widgets(): ReadonlyArray<Cell> {
    return this._cellContainer.widgets as ReadonlyArray<Cell>;
  }

  /**
   * Dispose of the resources held by the widget.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    // Clean up model connections
    if (this._model) {
      this._model.cells.changed.disconnect(this._onCellsChanged, this);
    }

    // Dispose of cell widgets
    this._cellContainer.widgets.forEach(widget => widget.dispose());

    super.dispose();
  }

  /**
   * Handle the DOM events for the widget.
   */
  handleEvent(event: Event): void {
    switch (event.type) {
      case 'click':
        this._handleClick(event as MouseEvent);
        break;
      case 'focusin':
        this._handleFocusIn(event as FocusEvent);
        break;
      default:
        break;
    }
  }

  /**
   * Handle `after-attach` messages for the widget.
   */
  protected onAfterAttach(msg: Message): void {
    this.node.addEventListener('click', this);
    this.node.addEventListener('focusin', this);
  }

  /**
   * Handle `before-detach` messages for the widget.
   */
  protected onBeforeDetach(msg: Message): void {
    this.node.removeEventListener('click', this);
    this.node.removeEventListener('focusin', this);
  }

  /**
   * Handle `'activate-request'` messages.
   */
  protected onActivateRequest(msg: Message): void {
    if (this.activeCell) {
      this.activeCell.activate();
    }
  }

  /**
   * Handle click events on the notebook.
   */
  private _handleClick(event: MouseEvent): void {
    // Find the target cell
    const target = event.target as HTMLElement;
    const cellNode = target.closest('.jp-Cell') as HTMLElement;

    if (cellNode) {
      // Find the corresponding cell widget
      const cell = this._findCell(cellNode);
      if (cell) {
        this._activateCell(cell);
      }
    }
  }

  /**
   * Handle focus events on the notebook.
   */
  private _handleFocusIn(event: FocusEvent): void {
    // Find the target cell
    const target = event.target as HTMLElement;
    const cellNode = target.closest('.jp-Cell') as HTMLElement;

    if (cellNode) {
      // Find the corresponding cell widget
      const cell = this._findCell(cellNode);
      if (cell) {
        this._activateCell(cell);
      }
    }
  }

  /**
   * Find a cell widget given a DOM node.
   */
  private _findCell(node: HTMLElement): Cell | null {
    const widgets = this._cellContainer.widgets;
    for (let i = 0; i < widgets.length; i++) {
      const widget = widgets[i] as Cell;
      if (widget.node === node || widget.node.contains(node)) {
        return widget;
      }
    }
    return null;
  }

  /**
   * Activate a cell.
   */
  private _activateCell(cell: Cell): void {
    if (this._activeCell === cell) {
      return;
    }

    // Deactivate the previous active cell
    if (this._activeCell) {
      this._activeCell.removeClass('jp-mod-active');
    }

    // Activate the new cell
    this._activeCell = cell;
    this._activeCell.addClass('jp-mod-active');
    this._activeCell.activate();

    // Emit the active cell changed signal
    this._activeCellChanged.emit(this._activeCell);
  }

  /**
   * Handle changes to the cells list.
   */
  private _onCellsChanged(cells: any, args: any): void {
    switch (args.type) {
      case 'add':
        this._onCellsAdded(args.newIndex, args.newValues);
        break;
      case 'remove':
        this._onCellsRemoved(args.oldIndex, args.oldValues);
        break;
      case 'move':
        this._onCellsMoved(args.oldIndex, args.newIndex, args.newValues);
        break;
      case 'set':
        this._onCellsSet(args.newIndex, args.oldValues, args.newValues);
        break;
      default:
        break;
    }
  }

  /**
   * Handle cells being added to the cells list.
   */
  private _onCellsAdded(index: number, cells: ICellModel[]): void {
    // Create cell widgets for the new cells
    const widgets = cells.map(model => this._createCell(model));

    // Insert the new cell widgets
    this._cellContainer.insertWidgets(index, widgets);

    // Activate the first new cell if there's no active cell
    if (!this._activeCell && widgets.length > 0) {
      this._activateCell(widgets[0]);
    }
  }

  /**
   * Handle cells being removed from the cells list.
   */
  private _onCellsRemoved(index: number, cells: ICellModel[]): void {
    // Remove the corresponding widgets
    for (let i = 0; i < cells.length; i++) {
      const widget = this._cellContainer.widgets[index];
      this._cellContainer.removeWidgetAt(index);
      widget.dispose();
    }

    // Update the active cell if it was removed
    if (this._activeCell && !this._cellContainer.widgets.includes(this._activeCell)) {
      this._activeCell = null;
      this._activeCellChanged.emit(null);
    }
  }

  /**
   * Handle cells being moved in the cells list.
   */
  private _onCellsMoved(fromIndex: number, toIndex: number, cells: ICellModel[]): void {
    // Get the widgets to move
    const widgets: Widget[] = [];
    for (let i = 0; i < cells.length; i++) {
      widgets.push(this._cellContainer.widgets[fromIndex + i]);
    }

    // Remove the widgets from their current position
    for (let i = 0; i < cells.length; i++) {
      this._cellContainer.removeWidgetAt(fromIndex);
    }

    // Insert the widgets at their new position
    this._cellContainer.insertWidgets(toIndex, widgets);
  }

  /**
   * Handle cells being set in the cells list.
   */
  private _onCellsSet(index: number, oldCells: ICellModel[], newCells: ICellModel[]): void {
    // Remove the old widgets
    this._onCellsRemoved(index, oldCells);

    // Add the new widgets
    this._onCellsAdded(index, newCells);
  }

  /**
   * Create a cell widget for a cell model.
   */
  private _createCell(model: ICellModel): Cell {
    const factory = this.contentFactory;
    let cell: Cell;

    switch (model.type) {
      case 'code':
        cell = factory.createCodeCell({
          model,
          rendermime: this.rendermime,
          translator: this._translator
        });
        break;
      case 'markdown':
        cell = factory.createMarkdownCell({
          model,
          rendermime: this.rendermime,
          translator: this._translator
        });
        break;
      default:
        cell = factory.createRawCell({
          model,
          translator: this._translator
        });
        break;
    }

    return cell;
  }

  private _rendermime: IRenderMimeRegistry;
  private _contentFactory: Notebook.IContentFactory;
  private _translator: ITranslator;
  private _model: NotebookModel | null = null;
  private _cellContainer: Panel;
  private _activeCell: Cell | null = null;
  private _activeCellChanged = new Signal<Notebook, Cell | null>(this);
}

/**
 * The namespace for Notebook class statics.
 */
export namespace Notebook {
  /**
   * An options object for initializing a notebook widget.
   */
  export interface IOptions {
    /**
     * The rendermime instance used by the widget.
     */
    rendermime: IRenderMimeRegistry;

    /**
     * The content factory for the widget.
     */
    contentFactory: IContentFactory;

    /**
     * The application language translator.
     */
    translator?: ITranslator;
  }

  /**
   * A factory for creating notebook content.
   */
  export interface IContentFactory {
    /**
     * Create a new code cell widget.
     */
    createCodeCell(options: Cell.IOptions): Cell;

    /**
     * Create a new markdown cell widget.
     */
    createMarkdownCell(options: Cell.IOptions): Cell;

    /**
     * Create a new raw cell widget.
     */
    createRawCell(options: Cell.IOptions): Cell;
  }

  /**
   * The default implementation of an `IContentFactory`.
   */
  export class ContentFactory implements IContentFactory {
    /**
     * Create a new code cell widget.
     */
    createCodeCell(options: Cell.IOptions): Cell {
      // This would be implemented to create a code cell widget
      return new Cell();
    }

    /**
     * Create a new markdown cell widget.
     */
    createMarkdownCell(options: Cell.IOptions): Cell {
      // This would be implemented to create a markdown cell widget
      return new Cell();
    }

    /**
     * Create a new raw cell widget.
     */
    createRawCell(options: Cell.IOptions): Cell {
      // This would be implemented to create a raw cell widget
      return new Cell();
    }
  }

  /**
   * The default `ContentFactory` instance.
   */
  export const defaultContentFactory = new ContentFactory();
}