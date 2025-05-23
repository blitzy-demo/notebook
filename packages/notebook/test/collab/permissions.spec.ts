// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { IPermissionsService } from '@jupyter-notebook/application';
import {
  PermissionsManager,
  IPermissionsManager,
  UserRole,
  PermissionLevel,
  ROLE_PERMISSIONS
} from '../../src/collab/permissions';
import * as Y from 'yjs';

/**
 * Mock implementation of IPermissionsService for testing
 */
class MockPermissionsService implements IPermissionsService {
  private _documentPermissions = new Map<
    string,
    IPermissionsService.IDocumentPermissions
  >();
  private _userPermissions = new Map<
    string,
    Map<string, IPermissionsService.IUserPermissions>
  >();

  readonly permissionsChanged = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn()
  };

  async getDocumentPermissions(
    documentPath: string
  ): Promise<IPermissionsService.IDocumentPermissions> {
    return (
      this._documentPermissions.get(documentPath) || {
        owner: 'default-owner',
        accessMode: 'private',
        defaultPermissions: {
          read: true,
          write: false,
          comment: false,
          manage: false
        }
      }
    );
  }

  async setDocumentPermissions(
    documentPath: string,
    permissions: IPermissionsService.IDocumentPermissions
  ): Promise<void> {
    this._documentPermissions.set(documentPath, permissions);
    this.permissionsChanged.emit({
      documentPath,
      permissions
    });
  }

  async getUserPermissions(
    documentPath: string,
    userId: string
  ): Promise<IPermissionsService.IUserPermissions> {
    const docUsers = this._userPermissions.get(documentPath);
    if (!docUsers) {
      return {
        read: false,
        write: false,
        comment: false,
        manage: false
      };
    }
    return (
      docUsers.get(userId) || {
        read: false,
        write: false,
        comment: false,
        manage: false
      }
    );
  }

  async setUserPermissions(
    documentPath: string,
    userId: string,
    permissions: IPermissionsService.IUserPermissions
  ): Promise<void> {
    let docUsers = this._userPermissions.get(documentPath);
    if (!docUsers) {
      docUsers = new Map<string, IPermissionsService.IUserPermissions>();
      this._userPermissions.set(documentPath, docUsers);
    }
    docUsers.set(userId, permissions);
    this.permissionsChanged.emit({
      documentPath,
      userId,
      permissions
    });
  }

  async hasPermission(
    documentPath: string,
    permission: IPermissionsService.Permission
  ): Promise<boolean> {
    const currentUserId = 'current-user';
    const userPerms = await this.getUserPermissions(documentPath, currentUserId);
    return userPerms[permission];
  }

  async getDocumentUsers(
    documentPath: string
  ): Promise<Map<string, IPermissionsService.IUserPermissions>> {
    return this._userPermissions.get(documentPath) || new Map();
  }
}

describe('PermissionsManager', () => {
  let doc: Y.Doc;
  let permissionsManager: IPermissionsManager;
  let mockPermissionsService: MockPermissionsService;
  const notebookPath = '/path/to/notebook.ipynb';
  const owner = 'owner-user';
  const currentUser = 'current-user';
  const otherUser = 'other-user';

  beforeEach(() => {
    // Create a new Yjs document for each test
    doc = new Y.Doc();
    
    // Create a mock permissions service
    mockPermissionsService = new MockPermissionsService();
    
    // Create the permissions manager with the mock service
    permissionsManager = new PermissionsManager({
      permissionsService: mockPermissionsService,
      currentUserId: currentUser,
      hubUrl: 'https://hub.example.org',
      enforcePermissions: true
    });
    
    // Initialize the permissions manager with the document
    return permissionsManager.initialize(notebookPath, doc, owner);
  });

  afterEach(() => {
    doc.destroy();
  });

  describe('initialization', () => {
    it('should initialize with the owner as Owner role', async () => {
      const role = await permissionsManager.getUserRole(notebookPath, owner);
      expect(role).toBe(UserRole.Owner);
    });

    it('should set the access mode to private by default', async () => {
      const accessMode = await permissionsManager.getAccessMode(notebookPath);
      expect(accessMode).toBe('private');
    });

    it('should sync with the permissions service', async () => {
      // Set up the mock permissions service with some data
      await mockPermissionsService.setDocumentPermissions(notebookPath, {
        owner: 'new-owner',
        accessMode: 'shared',
        defaultPermissions: {
          read: true,
          write: false,
          comment: false,
          manage: false
        }
      });

      await mockPermissionsService.setUserPermissions(notebookPath, 'user1', {
        read: true,
        write: true,
        comment: true,
        manage: false
      });

      // Sync permissions
      await permissionsManager.syncPermissions(notebookPath);

      // Verify the permissions were synced
      const accessMode = await permissionsManager.getAccessMode(notebookPath);
      expect(accessMode).toBe('shared');

      const role = await permissionsManager.getUserRole(notebookPath, 'user1');
      expect(role).toBe(UserRole.Editor);
    });
  });

  describe('role-based access control', () => {
    beforeEach(async () => {
      // Set up different users with different roles
      await permissionsManager.setUserRole(notebookPath, 'viewer', UserRole.Viewer);
      await permissionsManager.setUserRole(notebookPath, 'commenter', UserRole.Commenter);
      await permissionsManager.setUserRole(notebookPath, 'editor', UserRole.Editor);
      await permissionsManager.setUserRole(notebookPath, 'owner', UserRole.Owner);
    });

    it('should assign correct permission levels based on roles', async () => {
      // Viewer should have read permission only
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'viewer', IPermissionsService.Permission.Read
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'viewer', IPermissionsService.Permission.Comment
      )).toBe(false);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'viewer', IPermissionsService.Permission.Write
      )).toBe(false);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'viewer', IPermissionsService.Permission.Manage
      )).toBe(false);

      // Commenter should have read and comment permissions
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'commenter', IPermissionsService.Permission.Read
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'commenter', IPermissionsService.Permission.Comment
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'commenter', IPermissionsService.Permission.Write
      )).toBe(false);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'commenter', IPermissionsService.Permission.Manage
      )).toBe(false);

      // Editor should have read, comment, and write permissions
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'editor', IPermissionsService.Permission.Read
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'editor', IPermissionsService.Permission.Comment
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'editor', IPermissionsService.Permission.Write
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'editor', IPermissionsService.Permission.Manage
      )).toBe(false);

      // Owner should have all permissions
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'owner', IPermissionsService.Permission.Read
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'owner', IPermissionsService.Permission.Comment
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'owner', IPermissionsService.Permission.Write
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'owner', IPermissionsService.Permission.Manage
      )).toBe(true);
    });

    it('should enforce role-based permissions for notebook operations', async () => {
      // Set current user to viewer
      const viewerManager = new PermissionsManager({
        permissionsService: mockPermissionsService,
        currentUserId: 'viewer',
        enforcePermissions: true
      });
      await viewerManager.initialize(notebookPath, doc, owner);

      // Viewer should not be able to change permissions
      await expect(viewerManager.setUserRole(
        notebookPath, otherUser, UserRole.Editor
      )).rejects.toThrow('You do not have permission to manage roles');

      // Set current user to editor
      const editorManager = new PermissionsManager({
        permissionsService: mockPermissionsService,
        currentUserId: 'editor',
        enforcePermissions: true
      });
      await editorManager.initialize(notebookPath, doc, owner);

      // Editor should not be able to change permissions
      await expect(editorManager.setUserRole(
        notebookPath, otherUser, UserRole.Editor
      )).rejects.toThrow('You do not have permission to manage roles');

      // Set current user to owner
      const ownerManager = new PermissionsManager({
        permissionsService: mockPermissionsService,
        currentUserId: 'owner',
        enforcePermissions: true
      });
      await ownerManager.initialize(notebookPath, doc, owner);

      // Owner should be able to change permissions
      await expect(ownerManager.setUserRole(
        notebookPath, otherUser, UserRole.Editor
      )).resolves.not.toThrow();
    });
  });

  describe('cell-level permissions', () => {
    const cellId = 'cell-123';

    beforeEach(async () => {
      // Set up users with different roles
      await permissionsManager.setUserRole(notebookPath, 'viewer', UserRole.Viewer);
      await permissionsManager.setUserRole(notebookPath, 'editor', UserRole.Editor);
    });

    it('should inherit permissions from notebook by default', async () => {
      // Check that cell permissions match notebook permissions
      const viewerCellPermission = await permissionsManager.getCellPermission(
        notebookPath, cellId, 'viewer'
      );
      expect(viewerCellPermission).toBe(PermissionLevel.Read);

      const editorCellPermission = await permissionsManager.getCellPermission(
        notebookPath, cellId, 'editor'
      );
      expect(editorCellPermission).toBe(PermissionLevel.Write);
    });

    it('should allow setting custom cell permissions', async () => {
      // Set custom permission for viewer on this cell
      await permissionsManager.setCellPermission(
        notebookPath, cellId, 'viewer', PermissionLevel.Write
      );

      // Disable inheritance for this cell
      await permissionsManager.setCellInheritance(notebookPath, cellId, false);

      // Check that the custom permission is applied
      const viewerCellPermission = await permissionsManager.getCellPermission(
        notebookPath, cellId, 'viewer'
      );
      expect(viewerCellPermission).toBe(PermissionLevel.Write);

      // Editor should have no permission on this cell since inheritance is disabled
      // and no specific permission was set
      const editorCellPermission = await permissionsManager.getCellPermission(
        notebookPath, cellId, 'editor'
      );
      expect(editorCellPermission).toBe(PermissionLevel.None);
    });

    it('should enforce cell-level permissions', async () => {
      // Set custom permission for viewer on this cell
      await permissionsManager.setCellPermission(
        notebookPath, cellId, 'viewer', PermissionLevel.Write
      );

      // Disable inheritance for this cell
      await permissionsManager.setCellInheritance(notebookPath, cellId, false);

      // Check permissions for specific operations
      expect(await permissionsManager.hasCellPermission(
        notebookPath, cellId, 'viewer', IPermissionsService.Permission.Read
      )).toBe(true);
      expect(await permissionsManager.hasCellPermission(
        notebookPath, cellId, 'viewer', IPermissionsService.Permission.Write
      )).toBe(true);
      expect(await permissionsManager.hasCellPermission(
        notebookPath, cellId, 'viewer', IPermissionsService.Permission.Manage
      )).toBe(false);

      // Editor should have no permission on this cell
      expect(await permissionsManager.hasCellPermission(
        notebookPath, cellId, 'editor', IPermissionsService.Permission.Read
      )).toBe(false);
    });
  });

  describe('access modes', () => {
    it('should support private access mode', async () => {
      await permissionsManager.setAccessMode(notebookPath, 'private');
      
      // Users without explicit roles should have no access
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'unknown-user', IPermissionsService.Permission.Read
      )).toBe(false);
    });

    it('should support shared access mode', async () => {
      await permissionsManager.setAccessMode(notebookPath, 'shared');
      
      // Users without explicit roles should have read access
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'unknown-user', IPermissionsService.Permission.Read
      )).toBe(true);
      
      // But not write access
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'unknown-user', IPermissionsService.Permission.Write
      )).toBe(false);
    });

    it('should support public access mode', async () => {
      await permissionsManager.setAccessMode(notebookPath, 'public');
      
      // Users without explicit roles should have read access
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'unknown-user', IPermissionsService.Permission.Read
      )).toBe(true);
      
      // But not write access
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'unknown-user', IPermissionsService.Permission.Write
      )).toBe(false);
    });

    it('should sync access mode with the server', async () => {
      await permissionsManager.setAccessMode(notebookPath, 'shared');
      
      // Verify the access mode was synced to the server
      const serverPermissions = await mockPermissionsService.getDocumentPermissions(notebookPath);
      expect(serverPermissions.accessMode).toBe('shared');
    });
  });

  describe('permission changes and propagation', () => {
    it('should emit events when permissions change', async () => {
      // Set up a listener for permission changes
      const changeHandler = jest.fn();
      permissionsManager.permissionsChanged.connect(changeHandler);

      // Make a permission change
      await permissionsManager.setUserRole(notebookPath, otherUser, UserRole.Editor);

      // Verify the event was emitted
      expect(changeHandler).toHaveBeenCalled();
      const event = changeHandler.mock.calls[0][1];
      expect(event.type).toBe('user');
      expect(event.path).toBe(notebookPath);
      expect(event.userId).toBe(otherUser);
      expect(event.permission).toBe(UserRole.Editor);
    });

    it('should propagate permission changes to the server', async () => {
      // Make a permission change
      await permissionsManager.setUserRole(notebookPath, otherUser, UserRole.Editor);

      // Verify the change was propagated to the server
      const userPermissions = await mockPermissionsService.getUserPermissions(
        notebookPath, otherUser
      );
      expect(userPermissions).toEqual(ROLE_PERMISSIONS[UserRole.Editor]);
    });

    it('should update permissions when synced from server', async () => {
      // Set permissions on the server
      await mockPermissionsService.setUserPermissions(notebookPath, otherUser, {
        read: true,
        write: true,
        comment: true,
        manage: false
      });

      // Sync permissions
      await permissionsManager.syncPermissions(notebookPath);

      // Verify the permissions were updated
      const role = await permissionsManager.getUserRole(notebookPath, otherUser);
      expect(role).toBe(UserRole.Editor);
    });
  });

  describe('ownership transfer', () => {
    it('should allow the owner to transfer ownership', async () => {
      // Set current user to owner
      const ownerManager = new PermissionsManager({
        permissionsService: mockPermissionsService,
        currentUserId: owner,
        enforcePermissions: true
      });
      await ownerManager.initialize(notebookPath, doc, owner);

      // Transfer ownership
      await ownerManager.transferOwnership(notebookPath, otherUser);

      // Verify the new owner
      const newOwner = (await mockPermissionsService.getDocumentPermissions(notebookPath)).owner;
      expect(newOwner).toBe(otherUser);

      // Verify the new owner has Owner role
      const role = await ownerManager.getUserRole(notebookPath, otherUser);
      expect(role).toBe(UserRole.Owner);
    });

    it('should prevent non-owners from transferring ownership', async () => {
      // Set current user to editor
      const editorManager = new PermissionsManager({
        permissionsService: mockPermissionsService,
        currentUserId: 'editor',
        enforcePermissions: true
      });
      await editorManager.initialize(notebookPath, doc, owner);
      await permissionsManager.setUserRole(notebookPath, 'editor', UserRole.Editor);

      // Attempt to transfer ownership
      await expect(editorManager.transferOwnership(
        notebookPath, otherUser
      )).rejects.toThrow('Only the owner can transfer ownership');
    });
  });

  describe('JupyterHub integration', () => {
    it('should use the provided JupyterHub URL', () => {
      // Create a permissions manager with a specific Hub URL
      const hubUrl = 'https://hub.example.org';
      const hubManager = new PermissionsManager({
        hubUrl,
        currentUserId: currentUser
      });
      
      // This is a bit of a hack to test a private property
      // In a real application, we would test the integration through behavior
      expect((hubManager as any)._hubUrl).toBe(hubUrl);
    });

    it('should handle permission synchronization with JupyterHub users', async () => {
      // This test simulates the integration with JupyterHub by using the
      // permissions service as a proxy for the Hub's user management
      
      // Set up user permissions on the "Hub"
      await mockPermissionsService.setUserPermissions(notebookPath, 'hub-user', {
        read: true,
        write: true,
        comment: true,
        manage: false
      });

      // Sync permissions from the "Hub"
      await permissionsManager.syncPermissions(notebookPath);

      // Verify the permissions were synced
      const role = await permissionsManager.getUserRole(notebookPath, 'hub-user');
      expect(role).toBe(UserRole.Editor);
    });
  });

  describe('UI adaptation', () => {
    // These tests verify that the permissions system provides the necessary
    // information for the UI to adapt based on user permissions
    
    it('should provide user role information for UI adaptation', async () => {
      // Set up users with different roles
      await permissionsManager.setUserRole(notebookPath, 'viewer', UserRole.Viewer);
      await permissionsManager.setUserRole(notebookPath, 'editor', UserRole.Editor);
      
      // Get all users with access
      const users = await permissionsManager.getNotebookUsers(notebookPath);
      
      // Verify the user roles
      expect(users.get('viewer')).toBe(UserRole.Viewer);
      expect(users.get('editor')).toBe(UserRole.Editor);
    });

    it('should provide cell permission information for UI adaptation', async () => {
      const cellId1 = 'cell-1';
      const cellId2 = 'cell-2';
      
      // Set custom permissions for cells
      await permissionsManager.setCellPermission(
        notebookPath, cellId1, 'viewer', PermissionLevel.Write
      );
      await permissionsManager.setCellInheritance(notebookPath, cellId1, false);
      
      await permissionsManager.setCellPermission(
        notebookPath, cellId2, 'editor', PermissionLevel.Read
      );
      await permissionsManager.setCellInheritance(notebookPath, cellId2, false);
      
      // Get cells with custom permissions
      const cells = await permissionsManager.getCellsWithCustomPermissions(notebookPath);
      
      // Verify the cell permissions
      expect(cells.has(cellId1)).toBe(true);
      expect(cells.has(cellId2)).toBe(true);
      
      const cell1Perms = cells.get(cellId1);
      expect(cell1Perms?.inheritFromNotebook).toBe(false);
      expect(cell1Perms?.userPermissions.get('viewer')).toBe(PermissionLevel.Write);
      
      const cell2Perms = cells.get(cellId2);
      expect(cell2Perms?.inheritFromNotebook).toBe(false);
      expect(cell2Perms?.userPermissions.get('editor')).toBe(PermissionLevel.Read);
    });

    it('should provide permission check methods for UI components', async () => {
      // Set up a user with Editor role
      await permissionsManager.setUserRole(notebookPath, 'ui-user', UserRole.Editor);
      
      // These methods would be used by UI components to determine what to show
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'ui-user', IPermissionsService.Permission.Read
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'ui-user', IPermissionsService.Permission.Write
      )).toBe(true);
      expect(await permissionsManager.hasNotebookPermission(
        notebookPath, 'ui-user', IPermissionsService.Permission.Manage
      )).toBe(false);
    });
  });
});