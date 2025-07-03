// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from '@jupyterlab/application';

import {
  ReactWidget,
  ISessionContext,
  showErrorMessage,
  showDialog,
  Dialog,
} from '@jupyterlab/apputils';

import {
  Cell,
  CodeCell,
  MarkdownCell,
  ICellModel,
} from '@jupyterlab/cells';

import {
  NotebookPanel,
  INotebookModel,
  Notebook,
  NotebookActions,
  INotebookTracker,
} from '@jupyterlab/notebook';

import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { IDisposable, DisposableDelegate } from '@lumino/disposable';
import { Signal, ISignal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';

import React, { useEffect, useState, useCallback, useRef } from 'react';

// Types for collaboration services (these would be defined in the dependency files)
export interface IAwarenessState {
  clientId: string;
  user: {
    id: string;
    name: string;
    email?: string;
    avatar?: string;
    color: string;
  };
  cursor?: {
    cellId: string;
    position: number;
    line?: number;
    column?: number;
  };
  selection?: {
    cellId: string;
    start: number;
    end: number;
  };
  lastSeen: number;
}

export interface ICellLock {
  cellId: string;
  userId: string;
  userName: string;
  timestamp: number;
  expiresAt: number;
}

export interface ICollaborationComment {
  id: string;
  cellId: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: number;
  resolved: boolean;
  replies?: ICollaborationComment[];
}

export interface IAwarenessService {
  awareness: IAwarenessState[];
  localAwareness: IAwarenessState | null;
  awarenessChanged: ISignal<this, void>;
  updateCursor(cellId: string, position: number, line?: number, column?: number): void;
  updateSelection(cellId: string, start: number, end: number): void;
  dispose(): void;
}

export interface ILockService {
  locks: Map<string, ICellLock>;
  locksChanged: ISignal<this, void>;
  acquireLock(cellId: string): Promise<boolean>;
  releaseLock(cellId: string): void;
  isLocked(cellId: string): boolean;
  getLock(cellId: string): ICellLock | undefined;
  dispose(): void;
}

export interface ICommentService {
  comments: Map<string, ICollaborationComment[]>;
  commentsChanged: ISignal<this, void>;
  addComment(cellId: string, content: string): Promise<void>;
  resolveComment(commentId: string): Promise<void>;
  getComments(cellId: string): ICollaborationComment[];
  dispose(): void;
}

/**
 * The CSS class for collaboration indicators
 */
const COLLABORATION_INDICATOR_CLASS = 'jp-NotebookCollaboration-indicator';

/**
 * The CSS class for presence cursors
 */
const PRESENCE_CURSOR_CLASS = 'jp-NotebookPresence-cursor';

/**
 * The CSS class for cell lock indicators
 */
const CELL_LOCK_INDICATOR_CLASS = 'jp-NotebookLock-indicator';

/**
 * The CSS class for cell comment indicators
 */
const CELL_COMMENT_INDICATOR_CLASS = 'jp-NotebookComment-indicator';

/**
 * The CSS class for collaborative cell highlights
 */
const COLLABORATIVE_HIGHLIGHT_CLASS = 'jp-NotebookCollab-highlight';

/**
 * A React component for displaying user presence indicators
 */
const UserPresenceIndicator = ({
  awareness,
  cellId,
}: {
  awareness: IAwarenessState;
  cellId: string;
}): JSX.Element | null => {
  if (!awareness.cursor || awareness.cursor.cellId !== cellId) {
    return null;
  }

  const style = {
    backgroundColor: awareness.user.color,
    borderColor: awareness.user.color,
  };

  return (
    <div
      className={PRESENCE_CURSOR_CLASS}
      style={style}
      title={`${awareness.user.name} is here`}
    >
      <span className="jp-NotebookPresence-cursor-label">
        {awareness.user.name}
      </span>
    </div>
  );
};

/**
 * A React component for displaying cell lock status
 */
const CellLockIndicator = ({
  lock,
  translator,
}: {
  lock: ICellLock;
  translator: ITranslator;
}): JSX.Element => {
  const trans = translator.load('notebook');
  const timeRemaining = Math.max(0, lock.expiresAt - Date.now());
  const minutes = Math.ceil(timeRemaining / (1000 * 60));

  return (
    <div
      className={CELL_LOCK_INDICATOR_CLASS}
      title={trans.__(
        'Locked by %1 (%2 minutes remaining)',
        lock.userName,
        minutes.toString()
      )}
    >
      <span className="jp-NotebookLock-icon">🔒</span>
      <span className="jp-NotebookLock-user">{lock.userName}</span>
    </div>
  );
};

/**
 * A React component for displaying cell comment indicators
 */
const CellCommentIndicator = ({
  comments,
  translator,
  onToggleComments,
}: {
  comments: ICollaborationComment[];
  translator: ITranslator;
  onToggleComments: () => void;
}): JSX.Element => {
  const trans = translator.load('notebook');
  const unresolvedCount = comments.filter(c => !c.resolved).length;

  return (
    <div
      className={CELL_COMMENT_INDICATOR_CLASS}
      onClick={onToggleComments}
      title={trans.__(
        '%1 comments (%2 unresolved)',
        comments.length.toString(),
        unresolvedCount.toString()
      )}
    >
      <span className="jp-NotebookComment-icon">💬</span>
      <span className="jp-NotebookComment-count">{comments.length}</span>
    </div>
  );
};

/**
 * A React component that wraps a cell with collaborative features
 */
const CollaborativeCellWrapper = ({
  cell,
  awarenessService,
  lockService,
  commentService,
  translator,
}: {
  cell: Cell;
  awarenessService: IAwarenessService | null;
  lockService: ILockService | null;
  commentService: ICommentService | null;
  translator: ITranslator;
}): JSX.Element => {
  const [awareness, setAwareness] = useState<IAwarenessState[]>([]);
  const [lock, setLock] = useState<ICellLock | undefined>();
  const [comments, setComments] = useState<ICollaborationComment[]>([]);
  const [showComments, setShowComments] = useState(false);
  const cellId = cell.model.id;

  // Update awareness information
  useEffect(() => {
    if (!awarenessService) return;

    const updateAwareness = () => {
      setAwareness([...awarenessService.awareness]);
    };

    updateAwareness();
    awarenessService.awarenessChanged.connect(updateAwareness);

    return () => {
      awarenessService.awarenessChanged.disconnect(updateAwareness);
    };
  }, [awarenessService]);

  // Update lock information
  useEffect(() => {
    if (!lockService) return;

    const updateLocks = () => {
      setLock(lockService.getLock(cellId));
    };

    updateLocks();
    lockService.locksChanged.connect(updateLocks);

    return () => {
      lockService.locksChanged.disconnect(updateLocks);
    };
  }, [lockService, cellId]);

  // Update comment information
  useEffect(() => {
    if (!commentService) return;

    const updateComments = () => {
      setComments(commentService.getComments(cellId));
    };

    updateComments();
    commentService.commentsChanged.connect(updateComments);

    return () => {
      commentService.commentsChanged.disconnect(updateComments);
    };
  }, [commentService, cellId]);

  // Handle cursor and selection tracking
  useEffect(() => {
    if (!awarenessService) return;

    const editor = cell.editor;
    if (!editor) return;

    const handleCursorChange = () => {
      const position = editor.getCursorPosition();
      awarenessService.updateCursor(
        cellId,
        position.column,
        position.line,
        position.column
      );
    };

    const handleSelectionChange = () => {
      const selection = editor.getSelection();
      if (selection.start !== selection.end) {
        awarenessService.updateSelection(cellId, selection.start, selection.end);
      }
    };

    editor.model.value.changed.connect(handleCursorChange);
    editor.selectionChanged.connect(handleSelectionChange);

    return () => {
      editor.model.value.changed.disconnect(handleCursorChange);
      editor.selectionChanged.disconnect(handleSelectionChange);
    };
  }, [awarenessService, cell, cellId]);

  const toggleComments = useCallback(() => {
    setShowComments(!showComments);
  }, [showComments]);

  const cellAwareness = awareness.filter(
    a => a.cursor?.cellId === cellId || a.selection?.cellId === cellId
  );

  return (
    <div className={COLLABORATION_INDICATOR_CLASS}>
      {/* Presence indicators */}
      {cellAwareness.map(a => (
        <UserPresenceIndicator
          key={a.clientId}
          awareness={a}
          cellId={cellId}
        />
      ))}

      {/* Lock indicator */}
      {lock && (
        <CellLockIndicator lock={lock} translator={translator} />
      )}

      {/* Comment indicator */}
      {comments.length > 0 && (
        <CellCommentIndicator
          comments={comments}
          translator={translator}
          onToggleComments={toggleComments}
        />
      )}
    </div>
  );
};

/**
 * Enhanced NotebookPanel with collaborative editing capabilities
 */
export class CollaborativeNotebookPanel extends NotebookPanel {
  private _awarenessService: IAwarenessService | null = null;
  private _lockService: ILockService | null = null;
  private _commentService: ICommentService | null = null;
  private _collaborationEnabled = false;
  private _cellWrappers = new Map<string, Widget>();
  private _translator: ITranslator;
  private _disposables = new Set<IDisposable>();

  /**
   * Construct a new collaborative notebook panel
   */
  constructor(options: NotebookPanel.IOptions & {
    awarenessService?: IAwarenessService;
    lockService?: ILockService;
    commentService?: ICommentService;
    translator?: ITranslator;
  }) {
    super(options);
    
    this._awarenessService = options.awarenessService || null;
    this._lockService = options.lockService || null;
    this._commentService = options.commentService || null;
    this._translator = options.translator || nullTranslator;
    
    this._collaborationEnabled = !!(
      this._awarenessService || 
      this._lockService || 
      this._commentService
    );

    // Initialize collaborative features
    this._initializeCollaboration();

    // Setup cell monitoring
    this._setupCellMonitoring();
  }

  /**
   * Whether collaboration is enabled for this panel
   */
  get collaborationEnabled(): boolean {
    return this._collaborationEnabled;
  }

  /**
   * The awareness service
   */
  get awarenessService(): IAwarenessService | null {
    return this._awarenessService;
  }

  /**
   * The lock service
   */
  get lockService(): ILockService | null {
    return this._lockService;
  }

  /**
   * The comment service
   */
  get commentService(): ICommentService | null {
    return this._commentService;
  }

  /**
   * Initialize collaboration services
   */
  setCollaborationServices(
    awarenessService?: IAwarenessService,
    lockService?: ILockService,
    commentService?: ICommentService
  ): void {
    // Dispose existing services
    this._disposeServices();

    // Set new services
    this._awarenessService = awarenessService || null;
    this._lockService = lockService || null;
    this._commentService = commentService || null;
    
    this._collaborationEnabled = !!(
      this._awarenessService || 
      this._lockService || 
      this._commentService
    );

    // Reinitialize collaboration
    this._initializeCollaboration();
    this._updateAllCellWrappers();
  }

  /**
   * Dispose of the collaborative notebook panel
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this._disposeServices();
    this._disposeCellWrappers();
    super.dispose();
  }

  /**
   * Initialize collaboration features
   */
  private _initializeCollaboration(): void {
    if (!this._collaborationEnabled) {
      return;
    }

    // Monitor for cell editing to acquire locks
    if (this._lockService) {
      this._setupLockAcquisition();
    }

    // Monitor for cell focus to update awareness
    if (this._awarenessService) {
      this._setupAwarenessTracking();
    }

    // Add collaboration CSS classes
    this.addClass('jp-NotebookPanel-collaborative');
  }

  /**
   * Setup cell monitoring for dynamic wrapper updates
   */
  private _setupCellMonitoring(): void {
    // Monitor when cells are added or removed
    const notebook = this.content;
    
    const updateCells = () => {
      this._updateAllCellWrappers();
    };

    notebook.model?.cells.changed.connect(updateCells);
    notebook.activeCellChanged.connect(updateCells);

    this._disposables.add(
      new DisposableDelegate(() => {
        notebook.model?.cells.changed.disconnect(updateCells);
        notebook.activeCellChanged.disconnect(updateCells);
      })
    );
  }

  /**
   * Setup lock acquisition on cell editing
   */
  private _setupLockAcquisition(): void {
    if (!this._lockService) return;

    const notebook = this.content;
    
    const handleCellEdit = async (cell: Cell) => {
      const cellId = cell.model.id;
      
      // Skip if already locked by this user
      const existingLock = this._lockService!.getLock(cellId);
      if (existingLock && this._awarenessService?.localAwareness) {
        const localUserId = this._awarenessService.localAwareness.user.id;
        if (existingLock.userId === localUserId) {
          return;
        }
      }

      try {
        const acquired = await this._lockService!.acquireLock(cellId);
        if (!acquired) {
          const trans = this._translator.load('notebook');
          await showErrorMessage(
            trans.__('Cell Locked'),
            trans.__('This cell is currently being edited by another user.')
          );
          // Blur the cell to prevent editing
          cell.editor?.blur();
        }
      } catch (error) {
        console.error('Failed to acquire cell lock:', error);
      }
    };

    // Monitor cell focus events for lock acquisition
    const handleCellFocus = (notebook: Notebook, cell: Cell | null) => {
      if (cell && cell.editor) {
        cell.editor.focused.connect(() => handleCellEdit(cell));
      }
    };

    notebook.activeCellChanged.connect(handleCellFocus);

    this._disposables.add(
      new DisposableDelegate(() => {
        notebook.activeCellChanged.disconnect(handleCellFocus);
      })
    );
  }

  /**
   * Setup awareness tracking for cursor and selection updates
   */
  private _setupAwarenessTracking(): void {
    if (!this._awarenessService) return;

    const notebook = this.content;

    // Track active cell changes
    const handleActiveCellChange = (notebook: Notebook, cell: Cell | null) => {
      if (cell) {
        const cellId = cell.model.id;
        this._awarenessService!.updateCursor(cellId, 0);
      }
    };

    notebook.activeCellChanged.connect(handleActiveCellChange);

    this._disposables.add(
      new DisposableDelegate(() => {
        notebook.activeCellChanged.disconnect(handleActiveCellChange);
      })
    );
  }

  /**
   * Update all cell wrappers with current collaboration state
   */
  private _updateAllCellWrappers(): void {
    if (!this._collaborationEnabled) {
      return;
    }

    const notebook = this.content;
    
    // Remove old wrappers
    this._disposeCellWrappers();

    // Create new wrappers for each cell
    notebook.widgets.forEach(cell => {
      this._createCellWrapper(cell);
    });
  }

  /**
   * Create a collaboration wrapper for a cell
   */
  private _createCellWrapper(cell: Cell): void {
    const cellId = cell.model.id;
    
    const wrapper = ReactWidget.create(
      <CollaborativeCellWrapper
        cell={cell}
        awarenessService={this._awarenessService}
        lockService={this._lockService}
        commentService={this._commentService}
        translator={this._translator}
      />
    );

    wrapper.addClass('jp-NotebookCell-collaborationWrapper');
    
    // Insert wrapper as sibling to the cell
    const parent = cell.parent;
    if (parent) {
      const index = parent.widgets.indexOf(cell);
      parent.insertWidget(index + 1, wrapper);
    }

    this._cellWrappers.set(cellId, wrapper);
  }

  /**
   * Dispose all cell wrappers
   */
  private _disposeCellWrappers(): void {
    this._cellWrappers.forEach(wrapper => {
      wrapper.dispose();
    });
    this._cellWrappers.clear();
  }

  /**
   * Dispose collaboration services
   */
  private _disposeServices(): void {
    this._disposables.forEach(disposable => {
      disposable.dispose();
    });
    this._disposables.clear();

    if (this._awarenessService) {
      this._awarenessService.dispose();
    }
    if (this._lockService) {
      this._lockService.dispose();
    }
    if (this._commentService) {
      this._commentService.dispose();
    }
  }
}

/**
 * A namespace for CollaborativeNotebookPanel statics
 */
export namespace CollaborativeNotebookPanel {
  /**
   * Options for creating a collaborative notebook panel
   */
  export interface IOptions extends NotebookPanel.IOptions {
    /**
     * The awareness service for tracking user presence
     */
    awarenessService?: IAwarenessService;

    /**
     * The lock service for cell-level locking
     */
    lockService?: ILockService;

    /**
     * The comment service for cell comments
     */
    commentService?: ICommentService;

    /**
     * The translator for internationalization
     */
    translator?: ITranslator;
  }

  /**
   * Create a new collaborative notebook panel
   */
  export function createPanel(options: IOptions): CollaborativeNotebookPanel {
    return new CollaborativeNotebookPanel(options);
  }

  /**
   * Check if a notebook panel has collaboration enabled
   */
  export function isCollaborative(
    panel: NotebookPanel
  ): panel is CollaborativeNotebookPanel {
    return panel instanceof CollaborativeNotebookPanel;
  }
}

/**
 * A plugin to enhance NotebookPanel with collaborative features
 */
export const collaborativeNotebookPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook:collaborative-widget',
  description: 'Collaborative features for NotebookPanel widget',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');

    // Add command for toggling collaboration features
    const command = 'notebook:toggle-collaboration';
    app.commands.addCommand(command, {
      label: trans.__('Toggle Collaboration'),
      execute: async () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }

        if (CollaborativeNotebookPanel.isCollaborative(current)) {
          const result = await showDialog({
            title: trans.__('Collaboration Status'),
            body: trans.__('Collaboration is currently enabled for this notebook.'),
            buttons: [Dialog.okButton()],
          });
        } else {
          const result = await showDialog({
            title: trans.__('Enable Collaboration'),
            body: trans.__('Would you like to enable collaborative editing for this notebook?'),
            buttons: [Dialog.cancelButton(), Dialog.okButton()],
          });

          if (result.button.accept) {
            // This would integrate with the collaboration services
            // when they are available from other plugins
            console.log('Collaboration would be enabled here');
          }
        }
      },
      isEnabled: () => tracker.currentWidget !== null,
    });

    console.log('Collaborative notebook widget plugin activated');
  },
};

export default collaborativeNotebookPlugin;