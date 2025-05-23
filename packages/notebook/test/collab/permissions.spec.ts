// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Y from 'yjs';
import {
  PermissionsManager,
  IPermissionsManager,
  PermissionRole,
  PermissionAction,
  PermissionScope,
  IPermissionUser,
  IPermissionEntry,
  PermissionManagerStatus
} from '../../src/collab/permissions';

/**
 * Helper function to create a mock user for testing
 */
function createMockUser(id: string, displayName: string, isAdmin: boolean = false): IPermissionUser {
  return {
    id,
    displayName,
    isAdmin,
    avatarUrl: `https://example.com/avatars/${id}.png`,
    email: `${id}@example.com`
  };
}

/**
 * Helper function to create a permissions manager for testing
 */
function createPermissionsManager(
  currentUser: IPermissionUser,
  initialPermissions?: IPermissionEntry[],
  hubApiUrl?: string
): IPermissionsManager {
  const ydoc = new Y.Doc();
  ydoc.clientID = parseInt(currentUser.id, 10);
  
  return new PermissionsManager({
    ydoc,
    currentUser,
    notebookId: 'test-notebook',
    initialPermissions,
    hubApiUrl,
    autoAssignOwner: true,
    enableCellPermissions: true
  });
}

/**
 * Helper function to connect two Yjs documents
 */
function connectYjsDocs(doc1: Y.Doc, doc2: Y.Doc): void {
  // Create update handlers to sync the documents
  const doc1UpdateHandler = (update: Uint8Array) => {
    Y.applyUpdate(doc2, update);
  };
  
  const doc2UpdateHandler = (update: Uint8Array) => {
    Y.applyUpdate(doc1, update);
  };
  
  // Set up event listeners
  doc1.on('update', doc1UpdateHandler);
  doc2.on('update', doc2UpdateHandler);
  
  // Sync the initial state
  doc1UpdateHandler(Y.encodeStateAsUpdate(doc1));
}

describe('PermissionsManager', () => {
  describe('constructor', () => {
    it('should create a permissions manager with the correct initial state', () => {
      const user = createMockUser('1', 'User 1');
      const permissionsManager = createPermissionsManager(user);
      
      expect(permissionsManager.status).toBe(PermissionManagerStatus.Ready);
      expect(permissionsManager.currentUser).toEqual(user);
      expect(permissionsManager.currentRole).toBe(PermissionRole.Owner); // Auto-assigned as owner
      expect(permissionsManager.getPermissions()).toHaveLength(1); // Should have one permission entry for the current user
    });
    
    it('should initialize with provided permissions', () => {
      const owner = createMockUser('1', 'Owner');
      const editor = createMockUser('2', 'Editor');
      const viewer = createMockUser('3', 'Viewer');
      
      const initialPermissions: IPermissionEntry[] = [
        {
          user: owner,
          role: PermissionRole.Owner,
          grantedAt: Date.now(),
          grantedBy: owner,
          scope: PermissionScope.Notebook
        },
        {
          user: editor,
          role: PermissionRole.Editor,
          grantedAt: Date.now(),
          grantedBy: owner,
          scope: PermissionScope.Notebook
        },
        {
          user: viewer,
          role: PermissionRole.Viewer,
          grantedAt: Date.now(),
          grantedBy: owner,
          scope: PermissionScope.Notebook
        }
      ];
      
      const permissionsManager = createPermissionsManager(owner, initialPermissions);
      
      expect(permissionsManager.getPermissions()).toHaveLength(3);
      expect(permissionsManager.getUserPermissions(editor.id)[0].role).toBe(PermissionRole.Editor);
      expect(permissionsManager.getUserPermissions(viewer.id)[0].role).toBe(PermissionRole.Viewer);
    });
    
    it('should auto-assign owner role when no owners exist', () => {
      const user = createMockUser('1', 'User 1');
      const initialPermissions: IPermissionEntry[] = [];
      
      const permissionsManager = createPermissionsManager(user, initialPermissions);
      
      expect(permissionsManager.currentRole).toBe(PermissionRole.Owner);
      expect(permissionsManager.getPermissions()).toHaveLength(1);
    });
  });
  
  describe('role-based access control', () => {
    let owner: IPermissionUser;
    let editor: IPermissionUser;
    let commenter: IPermissionUser;
    let viewer: IPermissionUser;
    let ownerManager: IPermissionsManager;
    let editorManager: IPermissionsManager;
    let commenterManager: IPermissionsManager;
    let viewerManager: IPermissionsManager;
    
    beforeEach(() => {
      owner = createMockUser('1', 'Owner');
      editor = createMockUser('2', 'Editor');
      commenter = createMockUser('3', 'Commenter');
      viewer = createMockUser('4', 'Viewer');
      
      // Create permissions managers for each user
      ownerManager = createPermissionsManager(owner);
      
      // Set up initial permissions
      ownerManager.setUserRole(editor.id, PermissionRole.Editor);
      ownerManager.setUserRole(commenter.id, PermissionRole.Commenter);
      ownerManager.setUserRole(viewer.id, PermissionRole.Viewer);
      
      // Create managers for other users with the same Yjs document
      const ownerYdoc = (ownerManager as PermissionsManager)['_ydoc'];
      
      editorManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: editor,
        notebookId: 'test-notebook',
        autoAssignOwner: false,
        enableCellPermissions: true
      });
      
      commenterManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: commenter,
        notebookId: 'test-notebook',
        autoAssignOwner: false,
        enableCellPermissions: true
      });
      
      viewerManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: viewer,
        notebookId: 'test-notebook',
        autoAssignOwner: false,
        enableCellPermissions: true
      });
    });
    
    it('should correctly identify user roles', () => {
      expect(ownerManager.currentRole).toBe(PermissionRole.Owner);
      expect(editorManager.currentRole).toBe(PermissionRole.Editor);
      expect(commenterManager.currentRole).toBe(PermissionRole.Commenter);
      expect(viewerManager.currentRole).toBe(PermissionRole.Viewer);
    });
    
    it('should allow owners to perform all actions', async () => {
      // Test all permission actions
      for (const action of Object.values(PermissionAction)) {
        const result = await ownerManager.checkPermission(action);
        expect(result.allowed).toBe(true);
      }
    });
    
    it('should allow editors to edit, execute, comment, and view', async () => {
      // Actions editors should be allowed to perform
      const allowedActions = [
        PermissionAction.View,
        PermissionAction.Edit,
        PermissionAction.Execute,
        PermissionAction.Comment,
        PermissionAction.Lock
      ];
      
      // Actions editors should not be allowed to perform
      const disallowedActions = [
        PermissionAction.ManagePermissions,
        PermissionAction.Delete
      ];
      
      for (const action of allowedActions) {
        const result = await editorManager.checkPermission(action);
        expect(result.allowed).toBe(true);
      }
      
      for (const action of disallowedActions) {
        const result = await editorManager.checkPermission(action);
        expect(result.allowed).toBe(false);
      }
    });
    
    it('should allow commenters to comment and view', async () => {
      // Actions commenters should be allowed to perform
      const allowedActions = [
        PermissionAction.View,
        PermissionAction.Comment
      ];
      
      // Actions commenters should not be allowed to perform
      const disallowedActions = [
        PermissionAction.Edit,
        PermissionAction.Execute,
        PermissionAction.Lock,
        PermissionAction.ManagePermissions,
        PermissionAction.Delete
      ];
      
      for (const action of allowedActions) {
        const result = await commenterManager.checkPermission(action);
        expect(result.allowed).toBe(true);
      }
      
      for (const action of disallowedActions) {
        const result = await commenterManager.checkPermission(action);
        expect(result.allowed).toBe(false);
      }
    });
    
    it('should allow viewers to only view content', async () => {
      // Actions viewers should be allowed to perform
      const allowedActions = [
        PermissionAction.View
      ];
      
      // Actions viewers should not be allowed to perform
      const disallowedActions = [
        PermissionAction.Edit,
        PermissionAction.Execute,
        PermissionAction.Comment,
        PermissionAction.Lock,
        PermissionAction.ManagePermissions,
        PermissionAction.Delete
      ];
      
      for (const action of allowedActions) {
        const result = await viewerManager.checkPermission(action);
        expect(result.allowed).toBe(true);
      }
      
      for (const action of disallowedActions) {
        const result = await viewerManager.checkPermission(action);
        expect(result.allowed).toBe(false);
      }
    });
    
    it('should provide appropriate error messages for disallowed actions', async () => {
      const result = await viewerManager.checkPermission(PermissionAction.Edit);
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('does not have');
    });
    
    it('should treat admin users as owners regardless of assigned role', async () => {
      // Create an admin user with viewer role
      const admin = createMockUser('5', 'Admin', true);
      ownerManager.setUserRole(admin.id, PermissionRole.Viewer);
      
      // Create a permissions manager for the admin user
      const ownerYdoc = (ownerManager as PermissionsManager)['_ydoc'];
      const adminManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: admin,
        notebookId: 'test-notebook',
        autoAssignOwner: false,
        enableCellPermissions: true
      });
      
      // Admin should be able to perform owner actions despite having viewer role
      const result = await adminManager.checkPermission(PermissionAction.ManagePermissions);
      expect(result.allowed).toBe(true);
      expect(result.role).toBe(PermissionRole.Owner);
    });
  });
  
  describe('cell-level permissions', () => {
    let owner: IPermissionUser;
    let editor: IPermissionUser;
    let ownerManager: IPermissionsManager;
    let editorManager: IPermissionsManager;
    const cellId = 'test-cell-1';
    
    beforeEach(() => {
      owner = createMockUser('1', 'Owner');
      editor = createMockUser('2', 'Editor');
      
      // Create permissions managers for each user
      ownerManager = createPermissionsManager(owner);
      
      // Set up initial permissions
      ownerManager.setUserRole(editor.id, PermissionRole.Editor);
      
      // Create manager for editor with the same Yjs document
      const ownerYdoc = (ownerManager as PermissionsManager)['_ydoc'];
      
      editorManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: editor,
        notebookId: 'test-notebook',
        autoAssignOwner: false,
        enableCellPermissions: true
      });
    });
    
    it('should allow setting cell-specific permissions', async () => {
      // Owner sets viewer permission for editor on a specific cell
      const result = await ownerManager.setCellRole(editor.id, cellId, PermissionRole.Viewer);
      expect(result).toBe(true);
      
      // Get cell permissions
      const cellPermissions = ownerManager.getCellPermissions(cellId);
      expect(cellPermissions).toHaveLength(1);
      expect(cellPermissions[0].user.id).toBe(editor.id);
      expect(cellPermissions[0].role).toBe(PermissionRole.Viewer);
    });
    
    it('should enforce cell-specific permissions over notebook permissions', async () => {
      // Editor normally has edit permission for the notebook
      const notebookEditResult = await editorManager.checkPermission(PermissionAction.Edit);
      expect(notebookEditResult.allowed).toBe(true);
      
      // Owner sets viewer permission for editor on a specific cell
      await ownerManager.setCellRole(editor.id, cellId, PermissionRole.Viewer);
      
      // Editor should not be able to edit that specific cell
      const cellEditResult = await editorManager.checkPermission(PermissionAction.Edit, cellId);
      expect(cellEditResult.allowed).toBe(false);
      
      // But editor should still be able to edit other cells
      const otherCellEditResult = await editorManager.checkPermission(PermissionAction.Edit, 'other-cell');
      expect(otherCellEditResult.allowed).toBe(true);
    });
    
    it('should allow removing cell-specific permissions', async () => {
      // Set cell permission
      await ownerManager.setCellRole(editor.id, cellId, PermissionRole.Viewer);
      
      // Verify it was set
      const cellPermissions = ownerManager.getCellPermissions(cellId);
      expect(cellPermissions).toHaveLength(1);
      
      // Remove the permission
      const removeResult = await ownerManager.removeCellPermissions(editor.id, cellId);
      expect(removeResult).toBe(true);
      
      // Verify it was removed
      const updatedCellPermissions = ownerManager.getCellPermissions(cellId);
      expect(updatedCellPermissions).toHaveLength(0);
      
      // Editor should now be able to edit the cell again
      const cellEditResult = await editorManager.checkPermission(PermissionAction.Edit, cellId);
      expect(cellEditResult.allowed).toBe(true);
    });
    
    it('should not allow non-owners to set cell permissions', async () => {
      // Editor tries to set cell permission for themselves
      const result = await editorManager.setCellRole(editor.id, cellId, PermissionRole.Owner);
      expect(result).toBe(false);
      
      // No cell permissions should be set
      const cellPermissions = ownerManager.getCellPermissions(cellId);
      expect(cellPermissions).toHaveLength(0);
    });
  });
  
  describe('temporary permissions', () => {
    let owner: IPermissionUser;
    let viewer: IPermissionUser;
    let ownerManager: IPermissionsManager;
    let viewerManager: IPermissionsManager;
    
    beforeEach(() => {
      jest.useFakeTimers();
      
      owner = createMockUser('1', 'Owner');
      viewer = createMockUser('2', 'Viewer');
      
      // Create permissions managers for each user
      ownerManager = createPermissionsManager(owner);
      
      // Set up initial permissions
      ownerManager.setUserRole(viewer.id, PermissionRole.Viewer);
      
      // Create manager for viewer with the same Yjs document
      const ownerYdoc = (ownerManager as PermissionsManager)['_ydoc'];
      
      viewerManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: viewer,
        notebookId: 'test-notebook',
        autoAssignOwner: false,
        enableCellPermissions: true
      });
    });
    
    afterEach(() => {
      jest.useRealTimers();
    });
    
    it('should set temporary notebook-level permissions that expire', async () => {
      // Initially viewer cannot edit
      const initialEditResult = await viewerManager.checkPermission(PermissionAction.Edit);
      expect(initialEditResult.allowed).toBe(false);
      
      // Owner grants temporary editor permission to viewer for 5 seconds
      const tempResult = await ownerManager.setTemporaryPermission(
        viewer.id,
        PermissionRole.Editor,
        5000, // 5 seconds
        PermissionScope.Notebook
      );
      expect(tempResult).toBe(true);
      
      // Viewer should now be able to edit
      const editResult = await viewerManager.checkPermission(PermissionAction.Edit);
      expect(editResult.allowed).toBe(true);
      
      // Advance time past expiration
      jest.advanceTimersByTime(6000); // 6 seconds
      
      // Sync permissions to clean up expired permissions
      await viewerManager.syncPermissions();
      
      // Viewer should no longer be able to edit
      const finalEditResult = await viewerManager.checkPermission(PermissionAction.Edit);
      expect(finalEditResult.allowed).toBe(false);
    });
    
    it('should set temporary cell-level permissions that expire', async () => {
      const cellId = 'test-cell-1';
      
      // Initially viewer cannot edit any cell
      const initialEditResult = await viewerManager.checkPermission(PermissionAction.Edit, cellId);
      expect(initialEditResult.allowed).toBe(false);
      
      // Owner grants temporary editor permission to viewer for a specific cell for 5 seconds
      const tempResult = await ownerManager.setTemporaryPermission(
        viewer.id,
        PermissionRole.Editor,
        5000, // 5 seconds
        PermissionScope.Cell,
        cellId
      );
      expect(tempResult).toBe(true);
      
      // Viewer should now be able to edit that cell
      const editResult = await viewerManager.checkPermission(PermissionAction.Edit, cellId);
      expect(editResult.allowed).toBe(true);
      
      // But not other cells
      const otherCellEditResult = await viewerManager.checkPermission(PermissionAction.Edit, 'other-cell');
      expect(otherCellEditResult.allowed).toBe(false);
      
      // Advance time past expiration
      jest.advanceTimersByTime(6000); // 6 seconds
      
      // Sync permissions to clean up expired permissions
      await viewerManager.syncPermissions();
      
      // Viewer should no longer be able to edit the cell
      const finalEditResult = await viewerManager.checkPermission(PermissionAction.Edit, cellId);
      expect(finalEditResult.allowed).toBe(false);
    });
  });
  
  describe('permission changes and propagation', () => {
    let user1: IPermissionUser;
    let user2: IPermissionUser;
    let manager1: IPermissionsManager;
    let manager2: IPermissionsManager;
    
    beforeEach(() => {
      user1 = createMockUser('1', 'User 1');
      user2 = createMockUser('2', 'User 2');
      
      // Create permissions managers for each user
      manager1 = createPermissionsManager(user1);
      
      // Create a second manager with its own Yjs document
      manager2 = createPermissionsManager(user2);
      
      // Connect the Yjs documents
      const doc1 = (manager1 as PermissionsManager)['_ydoc'];
      const doc2 = (manager2 as PermissionsManager)['_ydoc'];
      connectYjsDocs(doc1, doc2);
    });
    
    it('should propagate permission changes to all connected clients', async () => {
      // User 1 sets User 2 as an editor
      await manager1.setUserRole(user2.id, PermissionRole.Editor);
      
      // User 2's manager should see the change
      const user2Permissions = manager2.getUserPermissions(user2.id);
      expect(user2Permissions).toHaveLength(1);
      expect(user2Permissions[0].role).toBe(PermissionRole.Editor);
      
      // User 2's current role should be updated
      expect(manager2.currentRole).toBe(PermissionRole.Editor);
    });
    
    it('should emit permissionsChanged signal when permissions change', async () => {
      // Set up a spy for the permissionsChanged signal
      const permissionsChangedSpy = jest.fn();
      manager1.permissionsChanged.connect(permissionsChangedSpy);
      
      // User 1 sets User 2 as an editor
      await manager1.setUserRole(user2.id, PermissionRole.Editor);
      
      // The signal should be emitted
      expect(permissionsChangedSpy).toHaveBeenCalled();
      const eventArg = permissionsChangedSpy.mock.calls[0][1];
      expect(eventArg.type).toBe('added');
      expect(eventArg.entry.user.id).toBe(user2.id);
      expect(eventArg.entry.role).toBe(PermissionRole.Editor);
    });
    
    it('should emit permissionsChanged signal when permissions are updated', async () => {
      // First set User 2 as an editor
      await manager1.setUserRole(user2.id, PermissionRole.Editor);
      
      // Set up a spy for the permissionsChanged signal
      const permissionsChangedSpy = jest.fn();
      manager1.permissionsChanged.connect(permissionsChangedSpy);
      
      // Update User 2 to be a commenter
      await manager1.setUserRole(user2.id, PermissionRole.Commenter);
      
      // The signal should be emitted
      expect(permissionsChangedSpy).toHaveBeenCalled();
      const eventArg = permissionsChangedSpy.mock.calls[0][1];
      expect(eventArg.type).toBe('updated');
      expect(eventArg.entry.user.id).toBe(user2.id);
      expect(eventArg.entry.role).toBe(PermissionRole.Commenter);
      expect(eventArg.previousRole).toBe(PermissionRole.Editor);
    });
    
    it('should emit permissionsChanged signal when permissions are removed', async () => {
      // First set User 2 as an editor
      await manager1.setUserRole(user2.id, PermissionRole.Editor);
      
      // Set up a spy for the permissionsChanged signal
      const permissionsChangedSpy = jest.fn();
      manager1.permissionsChanged.connect(permissionsChangedSpy);
      
      // Remove User 2's permissions
      await manager1.removeUserPermissions(user2.id);
      
      // The signal should be emitted
      expect(permissionsChangedSpy).toHaveBeenCalled();
      const eventArg = permissionsChangedSpy.mock.calls[0][1];
      expect(eventArg.type).toBe('removed');
      expect(eventArg.entry.user.id).toBe(user2.id);
    });
  });
  
  describe('JupyterHub integration', () => {
    let owner: IPermissionUser;
    let hubUser: IPermissionUser;
    let permissionsManager: IPermissionsManager;
    
    beforeEach(() => {
      owner = createMockUser('1', 'Owner');
      hubUser = createMockUser('hub-user', 'Hub User');
      
      // Mock fetch for JupyterHub API
      global.fetch = jest.fn().mockImplementation((url) => {
        if (url.includes('/users/hub-user')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              name: 'hub-user',
              display_name: 'Hub User from API',
              avatar_url: 'https://example.com/hub-avatar.png',
              email: 'hub-user@example.com',
              admin: true
            })
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404
        });
      });
      
      // Create permissions manager with JupyterHub API URL
      permissionsManager = createPermissionsManager(owner, undefined, 'https://example.com/hub/api');
    });
    
    afterEach(() => {
      jest.restoreAllMocks();
    });
    
    it('should fetch user information from JupyterHub API', async () => {
      // Set role for a user not yet in the system
      await permissionsManager.setUserRole(hubUser.id, PermissionRole.Editor);
      
      // Verify fetch was called
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/users/hub-user'));
      
      // Get the user permissions
      const userPermissions = permissionsManager.getUserPermissions(hubUser.id);
      expect(userPermissions).toHaveLength(1);
      
      // Verify the user info was updated from the API
      expect(userPermissions[0].user.displayName).toBe('Hub User from API');
      expect(userPermissions[0].user.avatarUrl).toBe('https://example.com/hub-avatar.png');
      expect(userPermissions[0].user.email).toBe('hub-user@example.com');
      expect(userPermissions[0].user.isAdmin).toBe(true);
    });
    
    it('should handle errors when fetching from JupyterHub API', async () => {
      // Mock console.warn
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      // Mock fetch to throw an error
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
      
      // Set role for a user not yet in the system
      await permissionsManager.setUserRole('error-user', PermissionRole.Editor);
      
      // Verify fetch was called
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/users/error-user'));
      
      // Verify warning was logged
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch user information'), expect.any(Error));
      
      // Get the user permissions
      const userPermissions = permissionsManager.getUserPermissions('error-user');
      expect(userPermissions).toHaveLength(1);
      
      // Verify minimal user info was created
      expect(userPermissions[0].user.id).toBe('error-user');
      expect(userPermissions[0].user.displayName).toBe('error-user');
      
      // Clean up
      consoleWarnSpy.mockRestore();
    });
    
    it('should recognize JupyterHub admin users and grant them owner privileges', async () => {
      // Set hub user as a viewer
      await permissionsManager.setUserRole(hubUser.id, PermissionRole.Viewer);
      
      // Create a permissions manager for the hub user
      const hubUserManager = new PermissionsManager({
        ydoc: (permissionsManager as PermissionsManager)['_ydoc'],
        currentUser: {
          id: hubUser.id,
          displayName: 'Hub User from API',
          avatarUrl: 'https://example.com/hub-avatar.png',
          email: 'hub-user@example.com',
          isAdmin: true
        },
        notebookId: 'test-notebook',
        autoAssignOwner: false
      });
      
      // Hub user should be able to perform owner actions despite being a viewer
      const result = await hubUserManager.checkPermission(PermissionAction.ManagePermissions);
      expect(result.allowed).toBe(true);
      expect(result.role).toBe(PermissionRole.Owner);
    });
  });
  
  describe('UI adaptation based on permissions', () => {
    let owner: IPermissionUser;
    let editor: IPermissionUser;
    let commenter: IPermissionUser;
    let viewer: IPermissionUser;
    let ownerManager: IPermissionsManager;
    let editorManager: IPermissionsManager;
    let commenterManager: IPermissionsManager;
    let viewerManager: IPermissionsManager;
    
    beforeEach(() => {
      owner = createMockUser('1', 'Owner');
      editor = createMockUser('2', 'Editor');
      commenter = createMockUser('3', 'Commenter');
      viewer = createMockUser('4', 'Viewer');
      
      // Create permissions managers for each user
      ownerManager = createPermissionsManager(owner);
      
      // Set up initial permissions
      ownerManager.setUserRole(editor.id, PermissionRole.Editor);
      ownerManager.setUserRole(commenter.id, PermissionRole.Commenter);
      ownerManager.setUserRole(viewer.id, PermissionRole.Viewer);
      
      // Create managers for other users with the same Yjs document
      const ownerYdoc = (ownerManager as PermissionsManager)['_ydoc'];
      
      editorManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: editor,
        notebookId: 'test-notebook',
        autoAssignOwner: false
      });
      
      commenterManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: commenter,
        notebookId: 'test-notebook',
        autoAssignOwner: false
      });
      
      viewerManager = new PermissionsManager({
        ydoc: ownerYdoc,
        currentUser: viewer,
        notebookId: 'test-notebook',
        autoAssignOwner: false
      });
    });
    
    it('should provide permission check results for UI adaptation', async () => {
      // Define UI elements and their required permissions
      const uiElements = [
        { id: 'edit-button', action: PermissionAction.Edit },
        { id: 'execute-button', action: PermissionAction.Execute },
        { id: 'comment-button', action: PermissionAction.Comment },
        { id: 'share-button', action: PermissionAction.ManagePermissions }
      ];
      
      // Check visibility for owner
      const ownerVisibility = await Promise.all(
        uiElements.map(async (element) => {
          const result = await ownerManager.checkPermission(element.action);
          return { id: element.id, visible: result.allowed };
        })
      );
      
      // All elements should be visible to owner
      expect(ownerVisibility.every(e => e.visible)).toBe(true);
      
      // Check visibility for viewer
      const viewerVisibility = await Promise.all(
        uiElements.map(async (element) => {
          const result = await viewerManager.checkPermission(element.action);
          return { id: element.id, visible: result.allowed };
        })
      );
      
      // Only view-related elements should be visible to viewer
      expect(viewerVisibility.find(e => e.id === 'edit-button')?.visible).toBe(false);
      expect(viewerVisibility.find(e => e.id === 'execute-button')?.visible).toBe(false);
      expect(viewerVisibility.find(e => e.id === 'comment-button')?.visible).toBe(false);
      expect(viewerVisibility.find(e => e.id === 'share-button')?.visible).toBe(false);
    });
    
    it('should provide user role information for UI customization', () => {
      // Get all users and their roles for UI display
      const users = ownerManager.getUsers();
      const userRoles = users.map(user => {
        const permissions = ownerManager.getUserPermissions(user.id);
        const notebookPermission = permissions.find(p => p.scope === PermissionScope.Notebook);
        return {
          id: user.id,
          displayName: user.displayName,
          role: notebookPermission?.role || 'none'
        };
      });
      
      // Verify all users and their roles are included
      expect(userRoles).toHaveLength(4); // owner, editor, commenter, viewer
      expect(userRoles.find(u => u.id === owner.id)?.role).toBe(PermissionRole.Owner);
      expect(userRoles.find(u => u.id === editor.id)?.role).toBe(PermissionRole.Editor);
      expect(userRoles.find(u => u.id === commenter.id)?.role).toBe(PermissionRole.Commenter);
      expect(userRoles.find(u => u.id === viewer.id)?.role).toBe(PermissionRole.Viewer);
    });
    
    it('should provide cell-specific permission information for UI adaptation', async () => {
      const cellId = 'test-cell-1';
      
      // Owner sets viewer permission for editor on a specific cell
      await ownerManager.setCellRole(editor.id, cellId, PermissionRole.Viewer);
      
      // Check if editor can edit this specific cell
      const canEdit = await editorManager.checkPermission(PermissionAction.Edit, cellId);
      expect(canEdit.allowed).toBe(false);
      
      // UI should adapt based on this result
      // For example, disable edit controls for this cell
      const editControlsEnabled = canEdit.allowed;
      expect(editControlsEnabled).toBe(false);
      
      // But editor should still be able to edit other cells
      const canEditOtherCell = await editorManager.checkPermission(PermissionAction.Edit, 'other-cell');
      expect(canEditOtherCell.allowed).toBe(true);
    });
  });
  
  describe('error handling and edge cases', () => {
    let owner: IPermissionUser;
    let permissionsManager: IPermissionsManager;
    
    beforeEach(() => {
      owner = createMockUser('1', 'Owner');
      permissionsManager = createPermissionsManager(owner);
    });
    
    it('should handle non-existent users gracefully', async () => {
      const nonExistentUserId = 'non-existent-user';
      
      // Check permissions for non-existent user
      const userPermissions = permissionsManager.getUserPermissions(nonExistentUserId);
      expect(userPermissions).toHaveLength(0);
      
      // Check if non-existent user can perform an action
      const result = await permissionsManager.checkUserPermission(nonExistentUserId, PermissionAction.View);
      expect(result.allowed).toBe(true); // Default role is Viewer, which can view
      expect(result.role).toBe(PermissionRole.Viewer);
    });
    
    it('should handle permission removal for non-existent users', async () => {
      const nonExistentUserId = 'non-existent-user';
      
      // Try to remove permissions for non-existent user
      const result = await permissionsManager.removeUserPermissions(nonExistentUserId);
      expect(result).toBe(true); // Should succeed since there's nothing to remove
    });
    
    it('should handle cell permission removal for non-existent cells', async () => {
      const nonExistentCellId = 'non-existent-cell';
      
      // Try to remove cell permissions for non-existent cell
      const result = await permissionsManager.removeCellPermissions(owner.id, nonExistentCellId);
      expect(result).toBe(true); // Should succeed since there's nothing to remove
    });
    
    it('should handle disabled cell permissions', async () => {
      // Create a permissions manager with cell permissions disabled
      const noCellPermissionsManager = new PermissionsManager({
        ydoc: new Y.Doc(),
        currentUser: owner,
        notebookId: 'test-notebook',
        enableCellPermissions: false
      });
      
      // Try to set cell permissions
      const setCellResult = await noCellPermissionsManager.setCellRole('user-id', 'cell-id', PermissionRole.Editor);
      expect(setCellResult).toBe(false);
      
      // Try to remove cell permissions
      const removeCellResult = await noCellPermissionsManager.removeCellPermissions('user-id', 'cell-id');
      expect(removeCellResult).toBe(false);
    });
  });
  
  describe('dispose', () => {
    it('should clean up resources when disposed', () => {
      const user = createMockUser('1', 'User 1');
      const permissionsManager = createPermissionsManager(user);
      
      // Set up spies for signals
      const statusChangedSpy = jest.spyOn(permissionsManager.statusChanged, 'disconnect');
      const permissionsChangedSpy = jest.spyOn(permissionsManager.permissionsChanged, 'disconnect');
      
      // Dispose the permissions manager
      permissionsManager.dispose();
      
      // Verify signals were disconnected
      expect(statusChangedSpy).toHaveBeenCalled();
      expect(permissionsChangedSpy).toHaveBeenCalled();
      
      // Verify the manager is disposed
      expect((permissionsManager as any)._isDisposed).toBe(true);
    });
  });
});