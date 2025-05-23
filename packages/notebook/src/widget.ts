// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISessionContext, SessionContext } from '@jupyterlab/apputils';

import { Cell, ICellModel } from '@jupyterlab/cells';

import { CodeEditor } from '@jupyterlab/codeeditor';

import { IChangedArgs } from '@jupyterlab/coreutils';

import {
  DocumentRegistry,
  IDocumentWidget,
  DocumentWidget
} from '@jupyterlab/docregistry';

import { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { NotebookModel } from './model';

import { Notebook, StaticNotebook } from '@jupyterlab/notebook';

import { INotebookShell } from '@jupyter-notebook/application';

import { Signal, ISignal } from '@lumino/signaling';

import { Panel, Widget } from '@lumino/widgets';

import * as Y from 'yjs';

// Import collaboration modules
import { YjsAwareness } from './collab/awareness';
import { ILockManager } from './collab/locks';
import { ICommentSystem } from './collab/comments';
import { IHistoryManager } from './collab/history';
import { IPermissionsManager } from './collab/permissions';

/**
 * A widget for notebooks.
 */
export class NotebookPanel
  extends DocumentWidget<Notebook, NotebookModel>
  implements IDocumentWidget<Notebook, NotebookModel> {
  /**
   * Construct a notebook panel.
   */
  constructor(options: NotebookPanel.IOptions) {
    super({
      content: options.content,
      context: options.context,
      reveal: options.reveal
    });

    this.translator = options.translator || nullTranslator;

    // Set up CSS classes
    this.addClass('jp-NotebookPanel');

    // Add collaboration-specific CSS class
    this.addClass('jp-NotebookPanel-collaborative');

    // Set up collaboration components if enabled
    this._setupCollaboration();
  }

  /**
   * The session context used by the panel.
   */
  get sessionContext(): ISessionContext {
    return this.context.sessionContext;
  }

  /**
   * The model for the widget.
   */
  get model(): NotebookModel {
    return this.content.model as NotebookModel;
  }

  /**
   * The toolbar for the widget.
   */
  get toolbar(): NotebookPanel.IToolbar {
    return (super.toolbar as unknown) as NotebookPanel.IToolbar;
  }

  /**
   * The awareness instance for collaborative editing.
   */
  get awareness(): YjsAwareness | null {
    return this._awareness;
  }

  /**
   * The lock manager for cell-level locking.
   */
  get lockManager(): ILockManager | null {
    return this._lockManager;
  }

  /**
   * The comment system for collaborative commenting.
   */
  get commentSystem(): ICommentSystem | null {
    return this._commentSystem;
  }

  /**
   * The history manager for version history.
   */
  get historyManager(): IHistoryManager | null {
    return this._historyManager;
  }

  /**
   * The permissions manager for access control.
   */
  get permissionsManager(): IPermissionsManager | null {
    return this._permissionsManager;
  }

  /**
   * A signal emitted when collaboration state changes.
   */
  get collaborationChanged(): ISignal<this, NotebookPanel.ICollaborationChangedArgs> {
    return this._collaborationChanged;
  }

  /**
   * Whether collaborative editing is enabled.
   */
  get isCollaborative(): boolean {
    return this._isCollaborative;
  }

  /**
   * The number of active collaborators.
   */
  get collaboratorCount(): number {
    if (!this._awareness) {
      return 0;
    }
    // Count all states except our own
    const states = this._awareness.getStates();
    const ownClientId = this._awareness.clientID;
    let count = 0;
    
    states.forEach((_, clientId) => {
      if (clientId !== ownClientId) {
        count++;
      }
    });
    
    return count;
  }

  /**
   * Dispose of the resources held by the widget.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    // Clean up collaboration resources
    this._cleanupCollaboration();

    super.dispose();
  }

  /**
   * Handle a change to the title.
   */
  protected onTitleChanged(oldValue: string, newValue: string): void {
    super.onTitleChanged(oldValue, newValue);
    
    // Update awareness with new document title if collaborative
    if (this._awareness && this._isCollaborative) {
      const state = this._awareness.getLocalState() || {};
      this._awareness.setLocalStateField('documentInfo', {
        ...state.documentInfo,
        title: newValue
      });
    }
  }

  /**
   * Set up collaboration features if enabled.
   */
  private _setupCollaboration(): void {
    // Check if the model has Yjs integration
    const ydoc = this.model.sharedModel?.ydoc as Y.Doc;
    if (!ydoc) {
      this._isCollaborative = false;
      return;
    }

    this._isCollaborative = true;

    // Initialize awareness
    this._awareness = new YjsAwareness(ydoc);
    
    // Set initial awareness state
    this._awareness.setLocalStateField('user', {
      name: 'Anonymous', // Default name, should be updated from user settings
      color: this._getRandomColor(),
      avatar: null // Could be set from user profile
    });

    this._awareness.setLocalStateField('documentInfo', {
      title: this.title.label,
      path: this.context.path
    });

    // Initialize other collaboration components
    this._initLockManager(ydoc);
    this._initCommentSystem(ydoc);
    this._initHistoryManager(ydoc);
    this._initPermissionsManager(ydoc);

    // Set up event listeners
    this._setupCollaborationEventListeners();

    // Add collaboration UI components
    this._addCollaborationUI();

    // Emit collaboration changed signal
    this._collaborationChanged.emit({
      collaborative: true,
      awareness: this._awareness,
      lockManager: this._lockManager,
      commentSystem: this._commentSystem,
      historyManager: this._historyManager,
      permissionsManager: this._permissionsManager
    });
  }

  /**
   * Initialize the lock manager.
   */
  private _initLockManager(ydoc: Y.Doc): void {
    // This would be implemented by importing the actual lock manager
    // For now, we'll just set it to null
    this._lockManager = null;
  }

  /**
   * Initialize the comment system.
   */
  private _initCommentSystem(ydoc: Y.Doc): void {
    // This would be implemented by importing the actual comment system
    // For now, we'll just set it to null
    this._commentSystem = null;
  }

  /**
   * Initialize the history manager.
   */
  private _initHistoryManager(ydoc: Y.Doc): void {
    // This would be implemented by importing the actual history manager
    // For now, we'll just set it to null
    this._historyManager = null;
  }

  /**
   * Initialize the permissions manager.
   */
  private _initPermissionsManager(ydoc: Y.Doc): void {
    // This would be implemented by importing the actual permissions manager
    // For now, we'll just set it to null
    this._permissionsManager = null;
  }

  /**
   * Set up event listeners for collaboration features.
   */
  private _setupCollaborationEventListeners(): void {
    if (!this._awareness) {
      return;
    }

    // Listen for awareness changes
    this._awareness.on('change', this._onAwarenessChange.bind(this));

    // Listen for cell changes to update cursor positions
    this.content.model?.cells.changed.connect(this._onCellsChanged, this);

    // Listen for active cell changes to update awareness
    this.content.activeCellChanged.connect(this._onActiveCellChanged, this);

    // Listen for selection changes to update awareness
    this.content.selectionChanged.connect(this._onSelectionChanged, this);
  }

  /**
   * Add collaboration UI components to the notebook.
   */
  private _addCollaborationUI(): void {
    // Create collaboration bar
    this._collaborationBar = new Panel();
    this._collaborationBar.addClass('jp-CollaborationBar');

    // Add presence indicators
    this._presenceIndicator = new Widget();
    this._presenceIndicator.addClass('jp-CollaborationPresence');
    this._collaborationBar.addWidget(this._presenceIndicator);

    // Add the collaboration bar to the notebook layout
    // This would typically be added to the shell, but for now we'll just add it to the panel
    this.addWidget(this._collaborationBar);

    // Update the presence indicator
    this._updatePresenceIndicator();
  }

  /**
   * Update the presence indicator with current collaborators.
   */
  private _updatePresenceIndicator(): void {
    if (!this._awareness || !this._presenceIndicator) {
      return;
    }

    const states = this._awareness.getStates();
    const ownClientId = this._awareness.clientID;
    const collaborators: Array<{ id: number; user: any }> = [];

    // Collect collaborator information
    states.forEach((state, clientId) => {
      if (clientId !== ownClientId && state.user) {
        collaborators.push({
          id: clientId,
          user: state.user
        });
      }
    });

    // Update the presence indicator UI
    const node = this._presenceIndicator.node;
    node.innerHTML = '';

    if (collaborators.length === 0) {
      const emptyIndicator = document.createElement('div');
      emptyIndicator.className = 'jp-CollaborationPresence-empty';
      emptyIndicator.textContent = 'No collaborators';
      node.appendChild(emptyIndicator);
      return;
    }

    // Create avatar elements for each collaborator
    collaborators.forEach(collaborator => {
      const avatar = document.createElement('div');
      avatar.className = 'jp-CollaborationAvatar';
      avatar.style.backgroundColor = collaborator.user.color || '#ccc';
      avatar.title = collaborator.user.name || 'Unknown user';
      
      // Add initials or avatar image
      if (collaborator.user.avatar) {
        const img = document.createElement('img');
        img.src = collaborator.user.avatar;
        img.alt = collaborator.user.name || 'User avatar';
        avatar.appendChild(img);
      } else {
        const initials = document.createElement('span');
        initials.textContent = this._getInitials(collaborator.user.name || 'U');
        avatar.appendChild(initials);
      }

      node.appendChild(avatar);
    });

    // Add count indicator if there are many collaborators
    if (collaborators.length > 5) {
      const countIndicator = document.createElement('div');
      countIndicator.className = 'jp-CollaborationCount';
      countIndicator.textContent = `+${collaborators.length - 5}`;
      node.appendChild(countIndicator);
    }
  }

  /**
   * Handle awareness changes.
   */
  private _onAwarenessChange(changes: { added: number[]; updated: number[]; removed: number[] }): void {
    // Update the presence indicator
    this._updatePresenceIndicator();

    // Update cursor and selection indicators in the notebook
    this._updateRemoteCursorsAndSelections();

    // Emit collaboration changed signal with updated collaborator count
    this._collaborationChanged.emit({
      collaborative: this._isCollaborative,
      awareness: this._awareness,
      lockManager: this._lockManager,
      commentSystem: this._commentSystem,
      historyManager: this._historyManager,
      permissionsManager: this._permissionsManager,
      collaboratorCount: this.collaboratorCount
    });
  }

  /**
   * Handle changes to the cells collection.
   */
  private _onCellsChanged(sender: any, args: IChangedArgs<ICellModel>): void {
    if (!this._awareness || !this._isCollaborative) {
      return;
    }

    // Update awareness with active cell information
    this._updateActiveCellAwareness();
  }

  /**
   * Handle active cell changes.
   */
  private _onActiveCellChanged(sender: Notebook, args: Cell | null): void {
    if (!this._awareness || !this._isCollaborative) {
      return;
    }

    // Update awareness with active cell information
    this._updateActiveCellAwareness();
  }

  /**
   * Handle selection changes.
   */
  private _onSelectionChanged(sender: Notebook): void {
    if (!this._awareness || !this._isCollaborative) {
      return;
    }

    // Update awareness with selection information
    this._updateSelectionAwareness();
  }

  /**
   * Update awareness with active cell information.
   */
  private _updateActiveCellAwareness(): void {
    if (!this._awareness || !this.content.activeCell) {
      return;
    }

    const activeCell = this.content.activeCell;
    const activeCellIndex = this.content.activeCellIndex;

    // Get the cell ID from the model
    const cellId = activeCell.model.id;

    // Update awareness with active cell information
    this._awareness.setLocalStateField('activeCell', {
      cellId,
      index: activeCellIndex
    });
  }

  /**
   * Update awareness with selection information.
   */
  private _updateSelectionAwareness(): void {
    if (!this._awareness) {
      return;
    }

    const selectedCells = this.content.widgets.filter((cell, index) => {
      return this.content.isSelected(cell);
    });

    const selectedIndices = selectedCells.map(cell => {
      return this.content.widgets.indexOf(cell);
    });

    // Update awareness with selection information
    this._awareness.setLocalStateField('selection', {
      indices: selectedIndices
    });

    // If there's an active cell with an editor, update cursor position
    if (this.content.activeCell && this.content.activeCell.editor) {
      const editor = this.content.activeCell.editor;
      const position = editor.getCursorPosition();
      const selection = editor.getSelection();

      this._awareness.setLocalStateField('cursor', {
        cellId: this.content.activeCell.model.id,
        position,
        selection
      });
    }
  }

  /**
   * Update remote cursors and selections in the notebook.
   */
  private _updateRemoteCursorsAndSelections(): void {
    if (!this._awareness) {
      return;
    }

    // Clear existing remote cursors and selections
    this._clearRemoteCursorsAndSelections();

    const states = this._awareness.getStates();
    const ownClientId = this._awareness.clientID;

    // Render remote cursors and selections
    states.forEach((state, clientId) => {
      if (clientId !== ownClientId) {
        this._renderRemoteCursorAndSelection(clientId, state);
      }
    });
  }

  /**
   * Clear all remote cursors and selections.
   */
  private _clearRemoteCursorsAndSelections(): void {
    // Remove all remote cursor elements
    const cursors = document.querySelectorAll('.jp-CollaborativeCursor');
    cursors.forEach(cursor => cursor.remove());

    // Remove all remote selection elements
    const selections = document.querySelectorAll('.jp-CollaborativeSelection');
    selections.forEach(selection => selection.remove());

    // Remove all cell highlights
    const highlights = document.querySelectorAll('.jp-CollaborativeCellHighlight');
    highlights.forEach(highlight => {
      const cell = highlight.parentElement;
      if (cell) {
        cell.classList.remove('jp-CollaborativeCellHighlight-container');
      }
      highlight.remove();
    });
  }

  /**
   * Render a remote cursor and selection.
   */
  private _renderRemoteCursorAndSelection(clientId: number, state: any): void {
    if (!state.user || !state.activeCell) {
      return;
    }

    const color = state.user.color || '#ccc';
    const name = state.user.name || 'Anonymous';

    // Highlight active cell
    this._highlightRemoteActiveCell(clientId, state.activeCell, color, name);

    // Render cursor and selection if available
    if (state.cursor) {
      this._renderRemoteCursor(clientId, state.cursor, color, name);
    }

    // Highlight selected cells if available
    if (state.selection && state.selection.indices) {
      this._highlightRemoteSelectedCells(clientId, state.selection.indices, color);
    }
  }

  /**
   * Highlight a remote user's active cell.
   */
  private _highlightRemoteActiveCell(clientId: number, activeCell: any, color: string, name: string): void {
    if (!activeCell || activeCell.index === undefined) {
      return;
    }

    const index = activeCell.index;
    if (index < 0 || index >= this.content.widgets.length) {
      return;
    }

    const cell = this.content.widgets[index];
    if (!cell) {
      return;
    }

    // Add highlight element
    const highlight = document.createElement('div');
    highlight.className = 'jp-CollaborativeCellHighlight';
    highlight.dataset.clientId = String(clientId);
    highlight.style.borderColor = color;

    // Add user label
    const label = document.createElement('div');
    label.className = 'jp-CollaborativeUserLabel';
    label.textContent = name;
    label.style.backgroundColor = color;
    highlight.appendChild(label);

    // Add to cell
    cell.node.classList.add('jp-CollaborativeCellHighlight-container');
    cell.node.appendChild(highlight);
  }

  /**
   * Render a remote cursor.
   */
  private _renderRemoteCursor(clientId: number, cursor: any, color: string, name: string): void {
    if (!cursor || !cursor.cellId || !cursor.position) {
      return;
    }

    // Find the cell with the given ID
    const cell = this.content.widgets.find(cell => cell.model.id === cursor.cellId);
    if (!cell || !cell.editor) {
      return;
    }

    const editor = cell.editor;
    const position = cursor.position;

    // Create cursor element
    const cursorElement = document.createElement('div');
    cursorElement.className = 'jp-CollaborativeCursor';
    cursorElement.dataset.clientId = String(clientId);
    cursorElement.style.backgroundColor = color;

    // Add name tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'jp-CollaborativeCursor-tooltip';
    tooltip.textContent = name;
    tooltip.style.backgroundColor = color;
    cursorElement.appendChild(tooltip);

    // Position the cursor using CodeMirror coordinates
    const coords = editor.getCoordinateForPosition(position);
    if (!coords) {
      return;
    }

    // Add cursor to editor
    const editorNode = editor.host;
    editorNode.appendChild(cursorElement);

    // Position cursor
    cursorElement.style.left = `${coords.left}px`;
    cursorElement.style.top = `${coords.top}px`;
    cursorElement.style.height = `${coords.height}px`;

    // Render selection if available
    if (cursor.selection) {
      this._renderRemoteSelection(clientId, cell, cursor.selection, color);
    }
  }

  /**
   * Render a remote selection.
   */
  private _renderRemoteSelection(clientId: number, cell: Cell, selection: CodeEditor.IRange, color: string): void {
    if (!cell.editor) {
      return;
    }

    const editor = cell.editor;

    // Create selection element
    const selectionElement = document.createElement('div');
    selectionElement.className = 'jp-CollaborativeSelection';
    selectionElement.dataset.clientId = String(clientId);
    selectionElement.style.backgroundColor = `${color}33`; // Add transparency
    selectionElement.style.borderColor = color;

    // Add selection to editor
    const editorNode = editor.host;
    editorNode.appendChild(selectionElement);

    // Position selection based on range
    // This is a simplified version - in a real implementation, we would need to handle multi-line selections
    const start = editor.getCoordinateForPosition(selection.start);
    const end = editor.getCoordinateForPosition(selection.end);

    if (!start || !end) {
      return;
    }

    // Simple case: single line selection
    if (selection.start.line === selection.end.line) {
      selectionElement.style.left = `${start.left}px`;
      selectionElement.style.top = `${start.top}px`;
      selectionElement.style.width = `${end.left - start.left}px`;
      selectionElement.style.height = `${start.height}px`;
    } else {
      // Multi-line selections would need more complex rendering
      // For simplicity, we'll just show a basic indicator
      selectionElement.style.left = `${start.left}px`;
      selectionElement.style.top = `${start.top}px`;
      selectionElement.style.width = `10px`;
      selectionElement.style.height = `${start.height}px`;
      selectionElement.classList.add('jp-CollaborativeSelection-multiline');
    }
  }

  /**
   * Highlight remote selected cells.
   */
  private _highlightRemoteSelectedCells(clientId: number, indices: number[], color: string): void {
    indices.forEach(index => {
      if (index < 0 || index >= this.content.widgets.length) {
        return;
      }

      const cell = this.content.widgets[index];
      if (!cell) {
        return;
      }

      // Add selection class and style
      cell.node.classList.add('jp-CollaborativeCell-selected');
      
      // Add a data attribute for the client ID
      cell.node.dataset.selectedByClientId = String(clientId);
      
      // Add a colored border using a custom property
      cell.node.style.setProperty('--jp-collaborative-selection-color', color);
    });
  }

  /**
   * Clean up collaboration resources.
   */
  private _cleanupCollaboration(): void {
    // Clean up event listeners
    if (this._awareness) {
      this._awareness.off('change', this._onAwarenessChange.bind(this));
    }

    this.content.model?.cells.changed.disconnect(this._onCellsChanged, this);
    this.content.activeCellChanged.disconnect(this._onActiveCellChanged, this);
    this.content.selectionChanged.disconnect(this._onSelectionChanged, this);

    // Clean up UI elements
    if (this._collaborationBar) {
      this._collaborationBar.dispose();
      this._collaborationBar = null;
    }

    if (this._presenceIndicator) {
      this._presenceIndicator.dispose();
      this._presenceIndicator = null;
    }

    // Clear remote cursors and selections
    this._clearRemoteCursorsAndSelections();

    // Clean up collaboration components
    this._awareness = null;
    this._lockManager = null;
    this._commentSystem = null;
    this._historyManager = null;
    this._permissionsManager = null;

    this._isCollaborative = false;
  }

  /**
   * Get a random color for user identification.
   */
  private _getRandomColor(): string {
    const colors = [
      '#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5',
      '#2196F3', '#03A9F4', '#00BCD4', '#009688', '#4CAF50',
      '#8BC34A', '#CDDC39', '#FFEB3B', '#FFC107', '#FF9800',
      '#FF5722', '#795548', '#607D8B'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /**
   * Get initials from a name.
   */
  private _getInitials(name: string): string {
    if (!name) {
      return '?';
    }
    
    const parts = name.split(' ');
    if (parts.length === 1) {
      return parts[0].charAt(0).toUpperCase();
    }
    
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  private _awareness: YjsAwareness | null = null;
  private _lockManager: ILockManager | null = null;
  private _commentSystem: ICommentSystem | null = null;
  private _historyManager: IHistoryManager | null = null;
  private _permissionsManager: IPermissionsManager | null = null;
  
  private _collaborationBar: Panel | null = null;
  private _presenceIndicator: Widget | null = null;
  
  private _isCollaborative = false;
  private _collaborationChanged = new Signal<this, NotebookPanel.ICollaborationChangedArgs>(this);
  
  private translator: ITranslator;
}

/**
 * A namespace for NotebookPanel statics.
 */
export namespace NotebookPanel {
  /**
   * An options interface for NotebookPanels.
   */
  export interface IOptions {
    /**
     * The rendermime instance used by the panel.
     */
    rendermime: IRenderMimeRegistry;

    /**
     * The language preference for the model.
     */
    languagePreference?: string;

    /**
     * The content factory for the panel.
     */
    contentFactory?: IContentFactory;

    /**
     * The mimeType for the document.
     */
    mimeType?: string;

    /**
     * The application language translator.
     */
    translator?: ITranslator;

    /**
     * The service used to look up mime types.
     */
    mimeTypeService?: IContentFactory.IMimeTypeService;

    /**
     * The notebook content.
     */
    content: Notebook;

    /**
     * The document context for the notebook.
     */
    context: DocumentRegistry.IContext<NotebookModel>;

    /**
     * Whether to render the notebook content on initialization.
     */
    reveal?: boolean;
  }

  /**
   * A content factory interface for NotebookPanel.
   */
  export interface IContentFactory {
    /**
     * Create a new content area for the panel.
     */
    createNotebook(options: Notebook.IOptions): Notebook;
  }

  /**
   * The notebook panel renderer interface.
   */
  export interface IRenderer {
    /**
     * Render the notebook panel.
     */
    createNotebook(options: Notebook.IOptions): Notebook;
  }

  /**
   * The notebook panel toolbar interface.
   */
  export interface IToolbar {
    /**
     * Add an item to the toolbar.
     */
    addItem(name: string, widget: Widget): void;

    /**
     * Insert an item into the toolbar at the specified index.
     */
    insertItem(index: number, name: string, widget: Widget): void;
  }

  /**
   * The collaboration changed arguments interface.
   */
  export interface ICollaborationChangedArgs {
    /**
     * Whether collaborative editing is enabled.
     */
    collaborative: boolean;

    /**
     * The awareness instance for collaborative editing.
     */
    awareness: YjsAwareness | null;

    /**
     * The lock manager for cell-level locking.
     */
    lockManager?: ILockManager | null;

    /**
     * The comment system for collaborative commenting.
     */
    commentSystem?: ICommentSystem | null;

    /**
     * The history manager for version history.
     */
    historyManager?: IHistoryManager | null;

    /**
     * The permissions manager for access control.
     */
    permissionsManager?: IPermissionsManager | null;

    /**
     * The number of active collaborators.
     */
    collaboratorCount?: number;
  }

  /**
   * Default implementation of the content factory.
   */
  export class ContentFactory implements IContentFactory {
    /**
     * Create a new content factory.
     */
    constructor(options: ContentFactory.IOptions = {}) {
      this.editorFactory = options.editorFactory;
      this.notebookContentFactory = options.notebookContentFactory;
      this.toolbarFactory = options.toolbarFactory;
    }

    /**
     * The editor factory.
     */
    readonly editorFactory: StaticNotebook.IEditorFactory | undefined;

    /**
     * The notebook content factory.
     */
    readonly notebookContentFactory: Notebook.IContentFactory | undefined;

    /**
     * The toolbar factory.
     */
    readonly toolbarFactory: IContentFactory.IToolbarFactory | undefined;

    /**
     * Create a new notebook widget.
     */
    createNotebook(options: Notebook.IOptions): Notebook {
      return new Notebook(options);
    }
  }

  /**
   * A namespace for the notebook panel content factory.
   */
  export namespace ContentFactory {
    /**
     * An options interface for the content factory.
     */
    export interface IOptions {
      /**
       * The editor factory.
       */
      editorFactory?: StaticNotebook.IEditorFactory;

      /**
       * The factory for notebook content.
       */
      notebookContentFactory?: Notebook.IContentFactory;

      /**
       * The toolbar factory.
       */
      toolbarFactory?: IContentFactory.IToolbarFactory;
    }

    /**
     * A service interface for creating mime models.
     */
    export interface IMimeTypeService {
      /**
       * Get the mime type for the given file path.
       */
      getMimeTypeByFilePath(path: string): string;
    }
  }

  /**
   * A namespace for the content factory.
   */
  export namespace IContentFactory {
    /**
     * A toolbar factory interface.
     */
    export interface IToolbarFactory {
      /**
       * Create a new toolbar for the panel.
       */
      createToolbar(): NotebookPanel.IToolbar;
    }
  }
}