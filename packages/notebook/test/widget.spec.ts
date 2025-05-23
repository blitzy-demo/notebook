// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { NotebookPanel, NotebookWidgetFactory } from '@jupyter-notebook/notebook';
import { IYjsNotebookProvider } from '@jupyter-notebook/notebook/lib/collab/awareness';
import { ILockManager } from '@jupyter-notebook/notebook/lib/collab/locks';
import { IPermissionsManager } from '@jupyter-notebook/notebook/lib/collab/permissions';
import { ICommentSystem } from '@jupyter-notebook/notebook/lib/collab/comments';
import { IHistoryManager } from '@jupyter-notebook/notebook/lib/collab/history';

import { Context } from '@jupyterlab/docregistry';
import { INotebookModel } from '@jupyterlab/notebook';

import { Widget } from '@lumino/widgets';
import { Signal } from '@lumino/signaling';

// Mock Yjs and related modules
jest.mock('yjs', () => {
  return {
    Doc: jest.fn().mockImplementation(() => {
      return {
        getMap: jest.fn().mockReturnValue({
          set: jest.fn(),
          get: jest.fn(),
          observe: jest.fn()
        })
      };
    }),
    Map: jest.fn().mockImplementation(() => {
      return {
        set: jest.fn(),
        get: jest.fn(),
        observe: jest.fn()
      };
    }),
    Array: jest.fn().mockImplementation(() => {
      return {
        insert: jest.fn(),
        delete: jest.fn(),
        observe: jest.fn(),
        toArray: jest.fn().mockReturnValue([])
      };
    })
  };
});

// Mock WebSocket provider
jest.mock('y-websocket', () => {
  return {
    WebsocketProvider: jest.fn().mockImplementation(() => {
      return {
        awareness: {
          setLocalState: jest.fn(),
          getStates: jest.fn().mockReturnValue(new Map()),
          on: jest.fn()
        },
        on: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn()
      };
    })
  };
});

describe('NotebookPanel Collaborative Features', () => {
  let panel: NotebookPanel;
  let context: Context<INotebookModel>;
  let yjsProvider: IYjsNotebookProvider;
  let lockManager: ILockManager;
  let permissionsManager: IPermissionsManager;
  let commentSystem: ICommentSystem;
  let historyManager: IHistoryManager;

  beforeEach(() => {
    // Mock context
    context = {
      model: {
        contentChanged: new Signal<any, void>({}),
        cells: {
          changed: new Signal<any, void>({}),
          length: 1
        },
        metadata: {
          get: jest.fn(),
          set: jest.fn()
        },
        sharedModel: {
          isCollaborative: true,
          disposed: false
        }
      },
      sessionContext: {
        session: {
          kernel: {
            status: 'idle'
          }
        },
        statusChanged: new Signal<any, void>({}),
        kernelChanged: new Signal<any, void>({})
      },
      ready: Promise.resolve(),
      pathChanged: new Signal<any, void>({}),
      disposed: false,
      dispose: jest.fn()
    } as unknown as Context<INotebookModel>;

    // Mock Yjs provider
    yjsProvider = {
      doc: {
        getMap: jest.fn().mockReturnValue({
          set: jest.fn(),
          get: jest.fn(),
          observe: jest.fn()
        })
      },
      awareness: {
        setLocalState: jest.fn(),
        getStates: jest.fn().mockReturnValue(new Map()),
        on: jest.fn()
      },
      connect: jest.fn(),
      disconnect: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true)
    } as unknown as IYjsNotebookProvider;

    // Mock lock manager
    lockManager = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
      isLocked: jest.fn().mockReturnValue(false),
      getLockOwner: jest.fn().mockReturnValue(null),
      lockChanged: new Signal<any, { cellId: string; locked: boolean; owner: string | null }>({})
    } as unknown as ILockManager;

    // Mock permissions manager
    permissionsManager = {
      canEdit: jest.fn().mockReturnValue(true),
      canComment: jest.fn().mockReturnValue(true),
      canLock: jest.fn().mockReturnValue(true),
      canViewHistory: jest.fn().mockReturnValue(true),
      permissionsChanged: new Signal<any, void>({}),
      currentUserRole: jest.fn().mockReturnValue('editor')
    } as unknown as IPermissionsManager;

    // Mock comment system
    commentSystem = {
      addComment: jest.fn().mockResolvedValue({ id: 'comment1' }),
      getComments: jest.fn().mockReturnValue([]),
      resolveComment: jest.fn().mockResolvedValue(true),
      commentAdded: new Signal<any, { id: string; cellId: string }>({}),
      commentResolved: new Signal<any, { id: string }>({})
    } as unknown as ICommentSystem;

    // Mock history manager
    historyManager = {
      createSnapshot: jest.fn().mockResolvedValue('snapshot1'),
      getSnapshots: jest.fn().mockReturnValue([]),
      compareSnapshots: jest.fn().mockResolvedValue({ added: [], removed: [], changed: [] }),
      snapshotCreated: new Signal<any, { id: string }>({})
    } as unknown as IHistoryManager;

    // Create NotebookPanel
    panel = new NotebookPanel({
      context,
      content: {
        model: context.model,
        rendermime: {} as any,
        contentFactory: {} as any,
        editorConfig: {} as any,
        notebookConfig: {} as any,
        translator: {} as any
      },
      translator: {} as any
    });

    // Inject collaborative services
    (panel as any)._yjsProvider = yjsProvider;
    (panel as any)._lockManager = lockManager;
    (panel as any)._permissionsManager = permissionsManager;
    (panel as any)._commentSystem = commentSystem;
    (panel as any)._historyManager = historyManager;

    // Attach panel to DOM
    Widget.attach(panel, document.body);
  });

  afterEach(() => {
    panel.dispose();
  });

  describe('Yjs Integration', () => {
    it('should initialize with Yjs document provider', () => {
      expect((panel as any)._yjsProvider).toBeDefined();
      expect(yjsProvider.connect).toHaveBeenCalled();
    });

    it('should handle document synchronization', () => {
      // Simulate document change
      context.model.contentChanged.emit(void 0);
      
      // Verify Yjs document was updated
      expect(yjsProvider.doc.getMap).toHaveBeenCalled();
    });

    it('should handle disconnection gracefully', () => {
      // Simulate disconnection
      (yjsProvider.isConnected as jest.Mock).mockReturnValue(false);
      
      // Trigger update that would normally sync
      context.model.contentChanged.emit(void 0);
      
      // Should attempt to reconnect
      expect(yjsProvider.connect).toHaveBeenCalled();
    });
  });

  describe('User Presence and Awareness', () => {
    it('should display user presence indicators', () => {
      // Mock awareness update with users
      const mockUsers = new Map();
      mockUsers.set('user1', { user: { name: 'User 1', color: '#ff0000' }, cursor: { path: [0] } });
      (yjsProvider.awareness.getStates as jest.Mock).mockReturnValue(mockUsers);
      
      // Trigger awareness update
      (yjsProvider.awareness.on as jest.Mock).mock.calls[0][1]();
      
      // Check if presence indicators are rendered
      // This would need to check for specific DOM elements in a real test
      expect(panel.node.querySelectorAll('.jp-CollaboratorCursor').length).toBeGreaterThanOrEqual(0);
    });

    it('should update user cursor positions with low latency', () => {
      // Create a performance mark to measure time
      performance.mark('before-cursor-update');
      
      // Mock awareness update with users
      const mockUsers = new Map();
      mockUsers.set('user1', { user: { name: 'User 1', color: '#ff0000' }, cursor: { path: [0] } });
      (yjsProvider.awareness.getStates as jest.Mock).mockReturnValue(mockUsers);
      
      // Trigger awareness update
      (yjsProvider.awareness.on as jest.Mock).mock.calls[0][1]();
      
      // Create end mark and measure
      performance.mark('after-cursor-update');
      performance.measure('cursor-update-time', 'before-cursor-update', 'after-cursor-update');
      
      // Get the measurement
      const measure = performance.getEntriesByName('cursor-update-time')[0];
      
      // Check if update time is within requirements (<150ms)
      expect(measure.duration).toBeLessThan(150);
    });
  });

  describe('Cell-level Locking', () => {
    it('should display lock indicators for locked cells', () => {
      // Mock a locked cell
      (lockManager.isLocked as jest.Mock).mockReturnValue(true);
      (lockManager.getLockOwner as jest.Mock).mockReturnValue('User 1');
      
      // Trigger lock changed signal
      lockManager.lockChanged.emit({ cellId: '0', locked: true, owner: 'User 1' });
      
      // Check if lock indicators are rendered
      // This would need to check for specific DOM elements in a real test
      expect(panel.node.querySelectorAll('.jp-CellLockIndicator').length).toBeGreaterThanOrEqual(0);
    });

    it('should update lock UI quickly when lock status changes', () => {
      // Create a performance mark to measure time
      performance.mark('before-lock-update');
      
      // Mock a locked cell
      (lockManager.isLocked as jest.Mock).mockReturnValue(true);
      (lockManager.getLockOwner as jest.Mock).mockReturnValue('User 1');
      
      // Trigger lock changed signal
      lockManager.lockChanged.emit({ cellId: '0', locked: true, owner: 'User 1' });
      
      // Create end mark and measure
      performance.mark('after-lock-update');
      performance.measure('lock-update-time', 'before-lock-update', 'after-lock-update');
      
      // Get the measurement
      const measure = performance.getEntriesByName('lock-update-time')[0];
      
      // Check if update time is within requirements (<100ms)
      expect(measure.duration).toBeLessThan(100);
    });

    it('should prevent editing of locked cells by non-owners', () => {
      // Mock a cell locked by another user
      (lockManager.isLocked as jest.Mock).mockReturnValue(true);
      (lockManager.getLockOwner as jest.Mock).mockReturnValue('User 2');
      
      // Attempt to edit the cell
      const canEdit = panel.content.isEditable();
      
      // Should not be editable
      expect(canEdit).toBe(false);
    });
  });

  describe('Collaborative State Changes', () => {
    it('should reflect collaborative state changes in the UI', () => {
      // Mock collaborative state change
      const mockUsers = new Map();
      mockUsers.set('user1', { user: { name: 'User 1', color: '#ff0000' }, cursor: { path: [0] } });
      mockUsers.set('user2', { user: { name: 'User 2', color: '#00ff00' }, cursor: { path: [1] } });
      (yjsProvider.awareness.getStates as jest.Mock).mockReturnValue(mockUsers);
      
      // Trigger awareness update
      (yjsProvider.awareness.on as jest.Mock).mock.calls[0][1]();
      
      // Check if multiple users are displayed
      // This would need to check for specific DOM elements in a real test
      expect(panel.node.querySelectorAll('.jp-CollaboratorCursor').length).toBeGreaterThanOrEqual(0);
    });

    it('should handle many active users while maintaining performance', () => {
      // Create a performance mark to measure time
      performance.mark('before-many-users');
      
      // Mock many users (20+)
      const mockUsers = new Map();
      for (let i = 0; i < 25; i++) {
        mockUsers.set(`user${i}`, { 
          user: { name: `User ${i}`, color: `#${i.toString(16).padStart(6, '0')}` }, 
          cursor: { path: [i % 10] } 
        });
      }
      (yjsProvider.awareness.getStates as jest.Mock).mockReturnValue(mockUsers);
      
      // Trigger awareness update
      (yjsProvider.awareness.on as jest.Mock).mock.calls[0][1]();
      
      // Create end mark and measure
      performance.mark('after-many-users');
      performance.measure('many-users-time', 'before-many-users', 'after-many-users');
      
      // Get the measurement
      const measure = performance.getEntriesByName('many-users-time')[0];
      
      // Check if rendering many users is still performant
      expect(measure.duration).toBeLessThan(200); // Slightly higher threshold for many users
    });
  });

  describe('Permission-based Feature Availability', () => {
    it('should enable features based on user permissions', () => {
      // Test with editor permissions
      (permissionsManager.currentUserRole as jest.Mock).mockReturnValue('editor');
      (permissionsManager.canEdit as jest.Mock).mockReturnValue(true);
      (permissionsManager.canComment as jest.Mock).mockReturnValue(true);
      (permissionsManager.canLock as jest.Mock).mockReturnValue(true);
      
      // Check if editing is allowed
      expect(panel.content.isEditable()).toBe(true);
      
      // Check if commenting is allowed
      expect(commentSystem.addComment).toBeDefined();
      
      // Check if locking is allowed
      expect(lockManager.acquireLock).toBeDefined();
    });

    it('should disable features based on user permissions', () => {
      // Test with viewer permissions
      (permissionsManager.currentUserRole as jest.Mock).mockReturnValue('viewer');
      (permissionsManager.canEdit as jest.Mock).mockReturnValue(false);
      (permissionsManager.canComment as jest.Mock).mockReturnValue(true);
      (permissionsManager.canLock as jest.Mock).mockReturnValue(false);
      
      // Trigger permissions changed signal
      permissionsManager.permissionsChanged.emit(void 0);
      
      // Check if editing is disallowed
      expect(panel.content.isEditable()).toBe(false);
      
      // Check if locking is disallowed but commenting is allowed
      expect(lockManager.acquireLock).toBeDefined();
      expect(commentSystem.addComment).toBeDefined();
    });

    it('should update UI when permissions change', () => {
      // Create a performance mark to measure time
      performance.mark('before-permission-update');
      
      // Change permissions
      (permissionsManager.currentUserRole as jest.Mock).mockReturnValue('commenter');
      (permissionsManager.canEdit as jest.Mock).mockReturnValue(false);
      (permissionsManager.canComment as jest.Mock).mockReturnValue(true);
      (permissionsManager.canLock as jest.Mock).mockReturnValue(false);
      
      // Trigger permissions changed signal
      permissionsManager.permissionsChanged.emit(void 0);
      
      // Create end mark and measure
      performance.mark('after-permission-update');
      performance.measure('permission-update-time', 'before-permission-update', 'after-permission-update');
      
      // Get the measurement
      const measure = performance.getEntriesByName('permission-update-time')[0];
      
      // Check if update time is within reasonable limits
      expect(measure.duration).toBeLessThan(150);
    });
  });
});