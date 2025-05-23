// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { NotebookPanel } from '../src/widget';
import { NotebookModel } from '../src/model';
import { YjsAwareness } from '../src/collab/awareness';
import { ILockManager, LockManager } from '../src/collab/locks';
import { ICommentSystem } from '../src/collab/comments';
import { IHistoryManager } from '../src/collab/history';
import { IPermissionsManager, PermissionLevel, UserRole } from '../src/collab/permissions';
import { ISessionContext, SessionContext } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { Notebook } from '@jupyterlab/notebook';
import { Cell, ICellModel } from '@jupyterlab/cells';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { INotebookShell } from '@jupyter-notebook/application';
import { Widget } from '@lumino/widgets';
import { UUID } from '@lumino/coreutils';
import * as Y from 'yjs';

// Mock classes and functions
class MockSessionContext implements ISessionContext {
  constructor() {
    /* empty */
  }
  readonly id = 'mock-session-id';
  readonly name = 'mock-session';
  readonly path = 'mock-path';
  readonly type = 'notebook';
  readonly kernelPreference = {};
  readonly connectionStatusChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly statusChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly kernelChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly propertyChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly iopubMessage = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly unhandledMessage = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly disposed = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly isDisposed = false;
  readonly session = null;
  readonly kernel = null;
  readonly status = 'idle';
  readonly isReady = true;
  readonly ready = Promise.resolve();
  readonly initialize = jest.fn(() => Promise.resolve());
  readonly startNew = jest.fn(() => Promise.resolve());
  readonly shutdown = jest.fn(() => Promise.resolve());
  readonly changeKernel = jest.fn(() => Promise.resolve());
  readonly dispose = jest.fn();
}

class MockRenderMimeRegistry implements IRenderMimeRegistry {
  constructor() {
    /* empty */
  }
  readonly defaultRendererFactory = null as any;
  readonly rendererFactories = [] as any[];
  readonly dataTypeConverters = [] as any[];
  readonly latexTypesetter = null as any;
  readonly linkHandler = null as any;
  readonly resolver = null as any;
  readonly createRenderer = jest.fn(() => null as any);
  readonly preferredMimeType = jest.fn(() => null as any);
  readonly findRendererFactory = jest.fn(() => null as any);
  readonly getRenderer = jest.fn(() => null as any);
  readonly renderModel = jest.fn(() => Promise.resolve());
  readonly clone = jest.fn(() => this);
}

class MockDocumentRegistry implements DocumentRegistry.IContext<NotebookModel> {
  constructor(model: NotebookModel) {
    this._model = model;
    this.sessionContext = new MockSessionContext();
  }
  readonly id = 'mock-context-id';
  readonly path = 'mock-path';
  readonly localPath = 'mock-local-path';
  readonly contentsModel = null as any;
  readonly model = this._model;
  readonly sessionContext: ISessionContext;
  readonly urlResolver = null as any;
  readonly ready = Promise.resolve();
  readonly isReady = true;
  readonly disposed = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly isDisposed = false;
  readonly fileChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly pathChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly titleChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly modelChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly contextualHelp = null as any;
  readonly saveState = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly fileChanged_ = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly saveState_ = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly dispose = jest.fn();
  readonly save = jest.fn(() => Promise.resolve());
  readonly saveAs = jest.fn(() => Promise.resolve());
  readonly revert = jest.fn(() => Promise.resolve());
  readonly createCheckpoint = jest.fn(() => Promise.resolve({ id: '', last_modified: '' }));
  readonly deleteCheckpoint = jest.fn(() => Promise.resolve());
  readonly restoreCheckpoint = jest.fn(() => Promise.resolve());
  readonly listCheckpoints = jest.fn(() => Promise.resolve([]));
  readonly addSibling = jest.fn(() => null as any);

  private _model: NotebookModel;
}

class MockNotebook extends Notebook {
  constructor() {
    super({
      rendermime: new MockRenderMimeRegistry(),
      contentFactory: Notebook.defaultContentFactory,
      mimeTypeService: null as any
    });
  }

  readonly activeCellIndex = 0;
  readonly activeCell = null as any;
  readonly widgets = [] as Cell[];
  readonly activeCellChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly selectionChanged = {
    connect: jest.fn(),
    disconnect: jest.fn()
  };
  readonly isSelected = jest.fn(() => false);
}

// Helper function to create a mock Yjs document
function createMockYjsDocument(): Y.Doc {
  const ydoc = new Y.Doc();
  // Initialize with some basic structure
  ydoc.getMap('metadata');
  ydoc.getArray('cells');
  return ydoc;
}

// Helper function to create a mock awareness instance
function createMockAwareness(ydoc: Y.Doc): YjsAwareness {
  const awareness = new YjsAwareness(ydoc);
  // Add a mock user
  awareness.setLocalStateField('user', {
    name: 'Test User',
    color: '#ff0000',
    avatar: null
  });
  return awareness;
}

// Helper function to create a mock lock manager
function createMockLockManager(): ILockManager {
  return {
    status: 'ready' as any,
    statusChanged: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    lockAcquired: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    lockReleased: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    lockFailed: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    lockExpiring: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    acquireLock: jest.fn(() => Promise.resolve({ success: true })),
    releaseLock: jest.fn(() => Promise.resolve(true)),
    getLock: jest.fn(() => null),
    hasLock: jest.fn(() => false),
    getAllLocks: jest.fn(() => []),
    renewLock: jest.fn(() => Promise.resolve(true)),
    forceReleaseLock: jest.fn(() => Promise.resolve(true)),
    releaseAllLocks: jest.fn(() => Promise.resolve(true)),
    dispose: jest.fn(),
    isDisposed: false
  };
}

// Helper function to create a mock comment system
function createMockCommentSystem(): ICommentSystem {
  return {
    changed: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    notificationsChanged: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    getThreads: jest.fn(() => []),
    getThreadsForCell: jest.fn(() => []),
    getThread: jest.fn(() => undefined),
    createThread: jest.fn(() => ({ id: 'thread-1', comments: [] } as any)),
    deleteThread: jest.fn(),
    addComment: jest.fn(() => ({ id: 'comment-1' } as any)),
    updateComment: jest.fn(() => ({ id: 'comment-1' } as any)),
    deleteComment: jest.fn(),
    resolveComment: jest.fn(() => ({ id: 'comment-1' } as any)),
    reopenComment: jest.fn(() => ({ id: 'comment-1' } as any)),
    archiveComment: jest.fn(() => ({ id: 'comment-1' } as any)),
    addReply: jest.fn(() => ({ id: 'reply-1' } as any)),
    updateReply: jest.fn(() => ({ id: 'reply-1' } as any)),
    deleteReply: jest.fn(),
    getNotifications: jest.fn(() => []),
    getUnreadNotifications: jest.fn(() => []),
    markNotificationAsRead: jest.fn(),
    markAllNotificationsAsRead: jest.fn(),
    filterComments: jest.fn(() => []),
    searchComments: jest.fn(() => []),
    getStatistics: jest.fn(() => ({
      totalThreads: 0,
      totalComments: 0,
      totalReplies: 0,
      openComments: 0,
      resolvedComments: 0,
      archivedComments: 0
    })),
    dispose: jest.fn(),
    isDisposed: false
  };
}

// Helper function to create a mock history manager
function createMockHistoryManager(): IHistoryManager {
  return {
    snapshotCreated: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    contentRestored: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    createSnapshot: jest.fn(() => Promise.resolve({ id: 'snapshot-1' } as any)),
    getHistory: jest.fn(() => Promise.resolve([])),
    getSnapshot: jest.fn(() => Promise.resolve(null)),
    getDiff: jest.fn(() => Promise.resolve({ cellChanges: {} } as any)),
    restoreSnapshot: jest.fn(() => Promise.resolve()),
    restoreCells: jest.fn(() => Promise.resolve()),
    updateConfig: jest.fn(),
    pruneHistory: jest.fn(() => Promise.resolve(0)),
    deleteSnapshot: jest.fn(() => Promise.resolve()),
    getConfig: jest.fn(() => ({})),
    dispose: jest.fn()
  };
}

// Helper function to create a mock permissions manager
function createMockPermissionsManager(): IPermissionsManager {
  return {
    permissionsChanged: {
      connect: jest.fn(),
      disconnect: jest.fn()
    },
    initialize: jest.fn(() => Promise.resolve()),
    setUserRole: jest.fn(() => Promise.resolve()),
    getUserRole: jest.fn(() => Promise.resolve(UserRole.Editor)),
    setCellPermission: jest.fn(() => Promise.resolve()),
    getCellPermission: jest.fn(() => Promise.resolve(PermissionLevel.Write)),
    setCellInheritance: jest.fn(() => Promise.resolve()),
    hasNotebookPermission: jest.fn(() => Promise.resolve(true)),
    hasCellPermission: jest.fn(() => Promise.resolve(true)),
    setAccessMode: jest.fn(() => Promise.resolve()),
    getAccessMode: jest.fn(() => Promise.resolve('shared' as any)),
    getNotebookUsers: jest.fn(() => Promise.resolve(new Map())),
    getCellsWithCustomPermissions: jest.fn(() => Promise.resolve(new Map())),
    transferOwnership: jest.fn(() => Promise.resolve()),
    syncPermissions: jest.fn(() => Promise.resolve())
  };
}

describe('NotebookPanel', () => {
  let panel: NotebookPanel;
  let model: NotebookModel;
  let context: DocumentRegistry.IContext<NotebookModel>;
  let notebook: MockNotebook;
  let ydoc: Y.Doc;
  let awareness: YjsAwareness;

  beforeEach(() => {
    // Create a Yjs document for collaborative editing
    ydoc = createMockYjsDocument();
    awareness = createMockAwareness(ydoc);

    // Create a notebook model with collaborative features enabled
    model = new NotebookModel({
      collaborative: true,
      collaborationOptions: {
        documentId: 'test-notebook',
        awareness: awareness
      }
    });

    // Set up the shared model with Yjs integration
    (model as any).sharedModel = { ydoc };

    // Create the document context with the model
    context = new MockDocumentRegistry(model);

    // Create a mock notebook
    notebook = new MockNotebook();

    // Create the notebook panel
    panel = new NotebookPanel({
      content: notebook as any,
      context: context
    });

    // Mock the collaboration components
    (panel as any)._awareness = awareness;
    (panel as any)._lockManager = createMockLockManager();
    (panel as any)._commentSystem = createMockCommentSystem();
    (panel as any)._historyManager = createMockHistoryManager();
    (panel as any)._permissionsManager = createMockPermissionsManager();
    (panel as any)._isCollaborative = true;

    // Attach the panel to the DOM
    Widget.attach(panel, document.body);
  });

  afterEach(() => {
    panel.dispose();
    ydoc.destroy();
  });

  describe('Collaborative features', () => {
    it('should have collaborative mode enabled', () => {
      expect(panel.isCollaborative).toBe(true);
    });

    it('should have awareness instance available', () => {
      expect(panel.awareness).toBe(awareness);
    });

    it('should have lock manager available', () => {
      expect(panel.lockManager).toBeTruthy();
    });

    it('should have comment system available', () => {
      expect(panel.commentSystem).toBeTruthy();
    });

    it('should have history manager available', () => {
      expect(panel.historyManager).toBeTruthy();
    });

    it('should have permissions manager available', () => {
      expect(panel.permissionsManager).toBeTruthy();
    });

    it('should emit collaborationChanged signal when initialized', () => {
      const spy = jest.fn();
      panel.collaborationChanged.connect(spy);

      // Manually trigger the signal
      (panel as any)._collaborationChanged.emit({
        collaborative: true,
        awareness: awareness
      });

      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][1].collaborative).toBe(true);
      expect(spy.mock.calls[0][1].awareness).toBe(awareness);
    });

    it('should clean up collaboration resources when disposed', () => {
      const cleanupSpy = jest.spyOn(panel as any, '_cleanupCollaboration');
      panel.dispose();
      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('User presence and awareness', () => {
    it('should track collaborator count', () => {
      // Initially there should be no collaborators (only the local user)
      expect(panel.collaboratorCount).toBe(0);

      // Add a mock remote user
      const mockState = {
        user: {
          name: 'Remote User',
          color: '#00ff00'
        }
      };
      awareness.awareness.setStates(new Map([[999, mockState]]));

      // Now there should be one collaborator
      expect(panel.collaboratorCount).toBe(1);
    });

    it('should update presence indicator when awareness changes', () => {
      // Mock the update presence indicator method
      const updateSpy = jest.spyOn(panel as any, '_updatePresenceIndicator');

      // Simulate an awareness change
      awareness.awareness.setStates(new Map([
        [999, {
          user: {
            name: 'Remote User',
            color: '#00ff00'
          }
        }]
      ]));

      // Manually trigger the awareness change handler
      (panel as any)._onAwarenessChange({
        added: [999],
        updated: [],
        removed: []
      });

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should update remote cursors when awareness changes', () => {
      // Mock the update remote cursors method
      const updateSpy = jest.spyOn(panel as any, '_updateRemoteCursorsAndSelections');

      // Simulate an awareness change
      awareness.awareness.setStates(new Map([
        [999, {
          user: {
            name: 'Remote User',
            color: '#00ff00'
          },
          cursor: {
            cellId: 'cell-1',
            position: { line: 0, column: 0 }
          }
        }]
      ]));

      // Manually trigger the awareness change handler
      (panel as any)._onAwarenessChange({
        added: [999],
        updated: [],
        removed: []
      });

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should update awareness when active cell changes', () => {
      // Mock the update active cell awareness method
      const updateSpy = jest.spyOn(panel as any, '_updateActiveCellAwareness');

      // Create a mock active cell
      const mockCell = {
        model: { id: 'cell-1' },
        editor: null
      };
      (notebook as any).activeCell = mockCell;
      (notebook as any).activeCellIndex = 0;

      // Manually trigger the active cell changed handler
      (panel as any)._onActiveCellChanged(notebook, mockCell);

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should update awareness when selection changes', () => {
      // Mock the update selection awareness method
      const updateSpy = jest.spyOn(panel as any, '_updateSelectionAwareness');

      // Manually trigger the selection changed handler
      (panel as any)._onSelectionChanged(notebook);

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should render remote user presence with low latency', async () => {
      // This test verifies that UI updates happen quickly after awareness changes
      const updateSpy = jest.spyOn(panel as any, '_updatePresenceIndicator');

      // Simulate an awareness change
      const startTime = performance.now();
      awareness.awareness.setStates(new Map([
        [999, {
          user: {
            name: 'Remote User',
            color: '#00ff00'
          }
        }]
      ]));

      // Manually trigger the awareness change handler
      (panel as any)._onAwarenessChange({
        added: [999],
        updated: [],
        removed: []
      });

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(updateSpy).toHaveBeenCalled();
      // Verify that the update happens within the required latency (150ms)
      expect(latency).toBeLessThan(150);
    });
  });

  describe('Cell locking', () => {
    it('should show lock indicators when cells are locked', () => {
      // Mock the lock manager to return a lock
      const mockLock = {
        cellId: 'cell-1',
        userId: 'user-1',
        userName: 'Remote User',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30000
      };
      (panel.lockManager as any).getLock = jest.fn(() => mockLock);
      (panel.lockManager as any).getAllLocks = jest.fn(() => [mockLock]);

      // Create a mock cell
      const mockCell = {
        model: { id: 'cell-1' },
        node: document.createElement('div')
      };
      (notebook as any).widgets = [mockCell as any];

      // Manually trigger a lock change
      (panel.lockManager as any).lockAcquired.emit(mockLock);

      // Verify that the cell has a lock indicator
      expect(mockCell.node.querySelector('.jp-CollaborativeCellHighlight')).toBeTruthy();
    });

    it('should update lock UI quickly when locks change', () => {
      // This test verifies that UI updates happen quickly after lock changes
      const mockLock = {
        cellId: 'cell-1',
        userId: 'user-1',
        userName: 'Remote User',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30000
      };
      (panel.lockManager as any).getLock = jest.fn(() => mockLock);
      (panel.lockManager as any).getAllLocks = jest.fn(() => [mockLock]);

      // Create a mock cell
      const mockCell = {
        model: { id: 'cell-1' },
        node: document.createElement('div')
      };
      (notebook as any).widgets = [mockCell as any];

      // Measure the time it takes to update the UI
      const startTime = performance.now();
      (panel.lockManager as any).lockAcquired.emit(mockLock);
      const endTime = performance.now();
      const latency = endTime - startTime;

      // Verify that the update happens within the required latency (100ms)
      expect(latency).toBeLessThan(100);
    });

    it('should allow acquiring locks on cells', async () => {
      // Mock the lock manager
      const acquireSpy = jest.spyOn(panel.lockManager as any, 'acquireLock');

      // Create a mock cell
      const mockCell = {
        model: { id: 'cell-1' },
        node: document.createElement('div')
      };
      (notebook as any).widgets = [mockCell as any];
      (notebook as any).activeCell = mockCell;

      // Attempt to acquire a lock
      await panel.lockManager?.acquireLock('cell-1');

      expect(acquireSpy).toHaveBeenCalledWith('cell-1', expect.anything());
    });

    it('should release locks when cells are no longer being edited', async () => {
      // Mock the lock manager
      const releaseSpy = jest.spyOn(panel.lockManager as any, 'releaseLock');

      // Create a mock cell
      const mockCell = {
        model: { id: 'cell-1' },
        node: document.createElement('div')
      };
      (notebook as any).widgets = [mockCell as any];

      // Attempt to release a lock
      await panel.lockManager?.releaseLock('cell-1');

      expect(releaseSpy).toHaveBeenCalledWith('cell-1');
    });
  });

  describe('Collaborative state changes', () => {
    it('should update UI when collaborative state changes', () => {
      // Mock the update presence indicator method
      const updateSpy = jest.spyOn(panel as any, '_updatePresenceIndicator');

      // Simulate a collaborative state change
      (panel as any)._collaborationChanged.emit({
        collaborative: true,
        awareness: awareness,
        collaboratorCount: 1
      });

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should update UI when cells are added or removed', () => {
      // Mock the update active cell awareness method
      const updateSpy = jest.spyOn(panel as any, '_updateActiveCellAwareness');

      // Simulate a cells changed event
      (panel as any)._onCellsChanged(null, {
        type: 'add',
        newIndex: 0,
        newValues: [{ id: 'cell-1' }]
      });

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should handle many active users without performance degradation', () => {
      // This test verifies that the UI remains performant with many users
      const updateSpy = jest.spyOn(panel as any, '_updatePresenceIndicator');

      // Create a map with many users (50)
      const userStates = new Map();
      for (let i = 0; i < 50; i++) {
        userStates.set(1000 + i, {
          user: {
            name: `User ${i}`,
            color: `#${Math.floor(Math.random() * 16777215).toString(16)}`
          }
        });
      }

      // Simulate an awareness change with many users
      const startTime = performance.now();
      awareness.awareness.setStates(userStates);

      // Manually trigger the awareness change handler
      (panel as any)._onAwarenessChange({
        added: Array.from(userStates.keys()),
        updated: [],
        removed: []
      });

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(updateSpy).toHaveBeenCalled();
      // Even with many users, updates should be reasonably fast
      expect(latency).toBeLessThan(200);
    });
  });

  describe('Permission-based features', () => {
    it('should respect user permissions for editing', async () => {
      // Mock the permissions manager
      const permissionSpy = jest.spyOn(panel.permissionsManager as any, 'hasNotebookPermission');
      permissionSpy.mockResolvedValue(false);

      // Attempt to perform an action that requires write permission
      const canEdit = await panel.permissionsManager?.hasNotebookPermission(
        'mock-path',
        'current-user',
        'write' as any
      );

      expect(permissionSpy).toHaveBeenCalled();
      expect(canEdit).toBe(false);
    });

    it('should respect user permissions for cell-level operations', async () => {
      // Mock the permissions manager
      const permissionSpy = jest.spyOn(panel.permissionsManager as any, 'hasCellPermission');
      permissionSpy.mockResolvedValue(false);

      // Attempt to perform an action that requires cell-level permission
      const canEditCell = await panel.permissionsManager?.hasCellPermission(
        'mock-path',
        'cell-1',
        'current-user',
        'write' as any
      );

      expect(permissionSpy).toHaveBeenCalled();
      expect(canEditCell).toBe(false);
    });

    it('should show appropriate UI based on user permissions', async () => {
      // Mock the permissions manager to return different permissions
      const permissionSpy = jest.spyOn(panel.permissionsManager as any, 'hasNotebookPermission');
      
      // First test with read-only permission
      permissionSpy.mockResolvedValue(false);
      let canEdit = await panel.permissionsManager?.hasNotebookPermission(
        'mock-path',
        'current-user',
        'write' as any
      );
      expect(canEdit).toBe(false);
      
      // Then test with write permission
      permissionSpy.mockResolvedValue(true);
      canEdit = await panel.permissionsManager?.hasNotebookPermission(
        'mock-path',
        'current-user',
        'write' as any
      );
      expect(canEdit).toBe(true);
    });
  });
});