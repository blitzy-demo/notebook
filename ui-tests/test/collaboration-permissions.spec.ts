/**
 * Collaboration Permissions and Access Control Test Suite
 *
 * Tests role-based access control, JupyterHub integration, and permission
 * enforcement in collaborative notebooks. Validates RBAC implementation
 * for view-only, edit, and admin roles with dynamic permission management.
 */

import * as path from 'path';
import { expect } from '@jupyterlab/galata';
import { expect as playwrightExpect } from '@playwright/test';
// Page import removed to fix unused import warning

import { test } from './fixtures';
import {
  createMultipleContexts,
  createCollaborativeSession
} from './utils';
// Collaboration helpers imports commented to fix unused import warnings
// These would be needed in a full implementation:
// import {
//   CollaborationUser,
//   CollaborationSession,
//   generateMockUsers,
//   cleanupCollaborationSession
// } from './collaboration-helpers';

// Test notebook path for permissions testing
const PERMISSIONS_NOTEBOOK = 'permissions-test.ipynb';
const SHARED_NOTEBOOK = 'shared-notebook.ipynb';

// Configure test to disable auto-navigation for manual control
test.use({ autoGoto: false });

test.describe('Permissions and Access Control', () => {
  test.beforeEach(async ({ page, tmpPath, collaborationServer, mockUsers }) => {
    // Upload test notebooks for permissions testing
    await page.contents.uploadFile(
      path.resolve(__dirname, `../../binder/${PERMISSIONS_NOTEBOOK}`),
      `${tmpPath}/${PERMISSIONS_NOTEBOOK}`
    );

    await page.contents.uploadFile(
      path.resolve(__dirname, `../../binder/${SHARED_NOTEBOOK}`),
      `${tmpPath}/${SHARED_NOTEBOOK}`
    );

    // Ensure collaboration server is ready before tests
    if (collaborationServer) {
      await page.waitForTimeout(500); // Allow server initialization
    }
  });

  test.afterEach(async ({ page }) => {
    // Clean up any active collaboration sessions
    await page.evaluate(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      if (collaboration?.provider) {
        collaboration.provider.disconnect();
      }
    });
  });

  test('should enforce view-only permissions', async ({
    page,
    tmpPath,
    mockUsers,
    waitForCollaboration
  }) => {
    // Simulate a view-only user accessing a collaborative notebook
    const notebook = `${tmpPath}/${PERMISSIONS_NOTEBOOK}`;

    // Mock JupyterHub authentication response for view-only user
    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'viewer-user',
          groups: ['view-only-group'],
          permissions: {
            notebooks: { [notebook]: 'view' }
          }
        })
      });
    });

    // Navigate to collaborative notebook as view-only user
    await createCollaborativeSession(page, `notebooks/${notebook}`);
    await waitForCollaboration();

    // Verify view-only permission indicators are displayed
    const permissionBadge = page.locator('[data-testid="permission-badge"]');
    await expect(permissionBadge).toBeVisible();
    await expect(permissionBadge).toHaveText('View Only');

    // Verify user cannot edit cells - all cells should be read-only
    const firstCell = page.locator('.jp-Cell:first-child');
    await firstCell.click();

    // Attempt to edit should be blocked
    await page.keyboard.type('This should not appear');
    await page.waitForTimeout(1000);

    const cellContent = await firstCell.locator('.jp-InputArea-editor').textContent();
    expect(cellContent).not.toContain('This should not appear');

    // Verify edit-related buttons are disabled
    const addCellButton = page.locator('[data-command="notebook:insert-cell-below"]');
    await expect(addCellButton).toBeDisabled();

    const deleteCellButton = page.locator('[data-command="notebook:delete-cell"]');
    await expect(deleteCellButton).toBeDisabled();

    // Verify toolbar shows read-only indicators
    const readOnlyIndicator = page.locator('[data-testid="readonly-indicator"]');
    await expect(readOnlyIndicator).toBeVisible();
    await expect(readOnlyIndicator).toHaveText('Read Only');
  });

  test('should allow editing with edit permissions', async ({
    page,
    tmpPath,
    mockUsers,
    waitForCollaboration
  }) => {
    const notebook = `${tmpPath}/${PERMISSIONS_NOTEBOOK}`;

    // Mock JupyterHub authentication response for edit user
    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'editor-user',
          groups: ['editor-group'],
          permissions: {
            notebooks: { [notebook]: 'edit' }
          }
        })
      });
    });

    await createCollaborativeSession(page, `notebooks/${notebook}`);
    await waitForCollaboration();

    // Verify edit permission indicators
    const permissionBadge = page.locator('[data-testid="permission-badge"]');
    await expect(permissionBadge).toBeVisible();
    await expect(permissionBadge).toHaveText('Edit');

    // Verify user can edit cells
    const firstCell = page.locator('.jp-Cell:first-child .jp-InputArea-editor');
    await firstCell.click();

    const testContent = 'print("Edit permission test")';
    await page.keyboard.type(testContent);

    // Verify content was added
    const cellContent = await firstCell.textContent();
    expect(cellContent).toContain(testContent);

    // Verify edit-related buttons are enabled
    const addCellButton = page.locator('[title="Insert a cell below"]');
    await expect(addCellButton).toBeEnabled();

    // Test adding a new cell
    await addCellButton.click();
    const cellCount = await page.locator('.jp-Cell').count();
    expect(cellCount).toBeGreaterThan(1);

    // Verify user cannot perform admin actions (e.g., manage permissions)
    const permissionsDialog = page.locator('[data-testid="permissions-dialog"]');
    await expect(permissionsDialog).not.toBeVisible();

    const managePermissionsButton = page.locator('[data-command="notebook:manage-permissions"]');
    if (await managePermissionsButton.count() > 0) {
      await expect(managePermissionsButton).toBeDisabled();
    }
  });

  test('should provide admin controls for admin role', async ({
    page,
    tmpPath,
    mockUsers,
    waitForCollaboration
  }) => {
    const notebook = `${tmpPath}/${PERMISSIONS_NOTEBOOK}`;

    // Mock JupyterHub authentication for admin user
    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'admin-user',
          groups: ['admin-group'],
          permissions: {
            notebooks: { [notebook]: 'admin' }
          },
          admin: true
        })
      });
    });

    await createCollaborativeSession(page, `notebooks/${notebook}`);
    await waitForCollaboration();

    // Verify admin permission indicators
    const permissionBadge = page.locator('[data-testid="permission-badge"]');
    await expect(permissionBadge).toBeVisible();
    await expect(permissionBadge).toHaveText('Admin');

    // Verify admin can edit like regular editor
    const firstCell = page.locator('.jp-Cell:first-child .jp-InputArea-editor');
    await firstCell.click();
    await page.keyboard.type('print("Admin test")');

    // Verify admin controls are available
    const menuBar = page.locator('.jp-MenuBar');
    await menuBar.locator('text="Edit"').click();

    const managePermissionsItem = page.locator('[data-command="notebook:manage-permissions"]');
    await expect(managePermissionsItem).toBeVisible();
    await expect(managePermissionsItem).toBeEnabled();

    // Open permissions management dialog
    await managePermissionsItem.click();

    const permissionsDialog = page.locator('[data-testid="permissions-dialog"]');
    await expect(permissionsDialog).toBeVisible();

    // Verify dialog shows user list and permission controls
    const userList = permissionsDialog.locator('[data-testid="user-permissions-list"]');
    await expect(userList).toBeVisible();

    const addUserButton = permissionsDialog.locator('[data-testid="add-user-permission"]');
    await expect(addUserButton).toBeVisible();
    await expect(addUserButton).toBeEnabled();

    // Close dialog
    const closeButton = permissionsDialog.locator('[data-testid="close-dialog"]');
    await closeButton.click();
    await expect(permissionsDialog).not.toBeVisible();
  });

  test('should integrate with JupyterHub auth', async ({
    page,
    tmpPath,
    waitForCollaboration
  }) => {
    const notebook = `${tmpPath}/${SHARED_NOTEBOOK}`;

    // Mock JupyterHub API endpoints
    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-user',
          groups: ['default-users'],
          server: '/user/test-user/',
          permissions: { notebooks: { [notebook]: 'edit' } }
        })
      });
    });

    await page.route('/hub/api/authorizations/cookie/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: { name: 'test-user' },
          scopes: ['access:notebooks']
        })
      });
    });

    // Navigate to notebook and verify authentication flow
    await createCollaborativeSession(page, `notebooks/${notebook}`);
    await waitForCollaboration();

    // Verify user information is displayed in collaboration bar
    const userPresenceBar = page.locator('[data-testid="user-presence-bar"]');
    await expect(userPresenceBar).toBeVisible();

    const currentUserAvatar = page.locator('[data-testid="current-user-avatar"]');
    await expect(currentUserAvatar).toBeVisible();

    // Verify user name from JupyterHub is displayed
    const userName = await currentUserAvatar.getAttribute('title');
    expect(userName).toBe('test-user');

    // Verify authentication-based permission enforcement
    const collaborationStatus = page.locator('[data-testid="collaboration-status"]');
    await expect(collaborationStatus).toHaveAttribute('data-authenticated', 'true');
    await expect(collaborationStatus).toHaveAttribute('data-permission-level', 'edit');
  });

  test('should deny unauthorized actions', async ({
    page,
    tmpPath,
    waitForCollaboration
  }) => {
    const notebook = `${tmpPath}/${PERMISSIONS_NOTEBOOK}`;

    // Mock authentication failure
    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Unauthorized access'
        })
      });
    });

    // Attempt to access notebook without proper authentication
    await page.goto(`notebooks/${notebook}`);

    // Verify access is denied with appropriate error message
    const errorMessage = page.locator('[data-testid="access-denied-message"]');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toHaveText('Access denied');

    // Verify collaborative features are not accessible
    const collaborationFeatures = page.locator('[data-testid="collaboration-toolbar"]');
    await expect(collaborationFeatures).not.toBeVisible();

    // Mock valid authentication with no permissions for this notebook
    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'unauthorized-user',
          groups: ['no-access-group'],
          permissions: { notebooks: {} } // No permissions for any notebook
        })
      });
    });

    await page.reload();

    // Verify permission denied message
    const permissionDenied = page.locator('[data-testid="permission-denied-message"]');
    await expect(permissionDenied).toBeVisible();
    await expect(permissionDenied).toHaveText('You do not have permission to access this notebook');
  });

  test('should update permissions dynamically', async ({
    browser,
    tmpPath,
    mockUsers
  }) => {
    const notebook = `${tmpPath}/${SHARED_NOTEBOOK}`;

    // Create two browser contexts - admin and regular user
    const [adminContext, userContext] = await createMultipleContexts(browser as any, 2);

    const adminPage = await adminContext.newPage();
    const userPage = await userContext.newPage();

    try {
      // Set up admin authentication
      await adminPage.route('/hub/api/user', async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'admin-user',
            admin: true,
            permissions: { notebooks: { [notebook]: 'admin' } }
          })
        });
      });

      // Set up user with initial view-only permission
      let userPermissionLevel = 'view';
      await userPage.route('/hub/api/user', async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'regular-user',
            permissions: { notebooks: { [notebook]: userPermissionLevel } }
          })
        });
      });

      // Both users access the notebook
      await createCollaborativeSession(adminPage, `notebooks/${notebook}`);
      await createCollaborativeSession(userPage, `notebooks/${notebook}`);

      // Verify user starts with view-only permissions
      const userPermissionBadge = userPage.locator('[data-testid="permission-badge"]');
      await playwrightExpect(userPermissionBadge).toHaveText('View Only');

      // Admin changes user permission to edit
      await adminPage.locator('.jp-MenuBar text="Edit"').click();
      await adminPage.locator('[data-command="notebook:manage-permissions"]').click();

      const permissionsDialog = adminPage.locator('[data-testid="permissions-dialog"]');
      await playwrightExpect(permissionsDialog).toBeVisible();

      // Find user in permissions list and change to edit
      const userRow = permissionsDialog.locator(`[data-user="regular-user"]`);
      await userRow.locator('[data-testid="permission-select"]').selectOption('edit');

      // Apply changes
      await permissionsDialog.locator('[data-testid="apply-permissions"]').click();

      // Update mock route to reflect new permission
      userPermissionLevel = 'edit';

      // Verify user receives permission update notification
      const permissionUpdateNotification = userPage.locator('[data-testid="permission-update-notification"]');
      await playwrightExpect(permissionUpdateNotification).toBeVisible();
      await playwrightExpect(permissionUpdateNotification).toHaveText('Your permissions have been updated to: Edit');

      // Verify user permission badge updates
      await playwrightExpect(userPermissionBadge).toHaveText('Edit');

      // Verify user can now edit
      const firstCell = userPage.locator('.jp-Cell:first-child .jp-InputArea-editor');
      await firstCell.click();
      await userPage.keyboard.type('Now I can edit!');

      const cellContent = await firstCell.textContent();
      expect(cellContent).toContain('Now I can edit!');

    } finally {
      await adminContext.close();
      await userContext.close();
    }
  });

  test('should show permission indicators in UI', async ({
    page,
    tmpPath,
    mockUsers,
    waitForCollaboration
  }) => {
    const notebook = `${tmpPath}/${PERMISSIONS_NOTEBOOK}`;

    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-user',
          permissions: { notebooks: { [notebook]: 'edit' } }
        })
      });
    });

    await createCollaborativeSession(page, `notebooks/${notebook}`);
    await waitForCollaboration();

    // Verify permission badge in header
    const headerPermission = page.locator('[data-testid="notebook-header"] [data-testid="permission-badge"]');
    await expect(headerPermission).toBeVisible();
    await expect(headerPermission).toHaveText('Edit');

    // Verify collaboration toolbar shows permission info
    const collaborationToolbar = page.locator('[data-testid="collaboration-toolbar"]');
    await expect(collaborationToolbar).toBeVisible();

    const permissionInfo = collaborationToolbar.locator('[data-testid="permission-info"]');
    await expect(permissionInfo).toBeVisible();
    await expect(permissionInfo).toHaveText('You have edit access');

    // Verify permission indicators on cells (for admin users)
    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'admin-user',
          admin: true,
          permissions: { notebooks: { [notebook]: 'admin' } }
        })
      });
    });

    await page.reload();
    await waitForCollaboration();

    // Admin should see lock controls on cells
    const cellLockControl = page.locator('.jp-Cell:first-child [data-testid="cell-lock-control"]');
    await expect(cellLockControl).toBeVisible();

    // Verify status bar permission display
    const statusBar = page.locator('[data-testid="notebook-status-bar"]');
    if (await statusBar.count() > 0) {
      const statusPermission = statusBar.locator('[data-testid="status-permission"]');
      await expect(statusPermission).toHaveText('Admin');
    }
  });

  test('should handle permission conflicts', async ({
    browser,
    tmpPath,
    mockUsers
  }) => {
    const notebook = `${tmpPath}/${SHARED_NOTEBOOK}`;

    // Create two admin contexts to simulate permission conflict
    const [admin1Context, admin2Context] = await createMultipleContexts(browser as any, 2);

    const admin1Page = await admin1Context.newPage();
    const admin2Page = await admin2Context.newPage();

    try {
      // Both users have admin permissions
      const adminAuthResponse = {
        admin: true,
        permissions: { notebooks: { [notebook]: 'admin' } }
      };

      await admin1Page.route('/hub/api/user', async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'admin1', ...adminAuthResponse })
        });
      });

      await admin2Page.route('/hub/api/user', async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'admin2', ...adminAuthResponse })
        });
      });

      // Both admins access notebook
      await createCollaborativeSession(admin1Page, `notebooks/${notebook}`);
      await createCollaborativeSession(admin2Page, `notebooks/${notebook}`);

      // Admin1 opens permissions dialog
      await admin1Page.locator('.jp-MenuBar text="Edit"').click();
      await admin1Page.locator('[data-command="notebook:manage-permissions"]').click();

      const dialog1 = admin1Page.locator('[data-testid="permissions-dialog"]');
      await playwrightExpect(dialog1).toBeVisible();

      // Admin2 tries to open permissions dialog simultaneously
      await admin2Page.locator('.jp-MenuBar text="Edit"').click();
      await admin2Page.locator('[data-command="notebook:manage-permissions"]').click();

      // Admin2 should see conflict warning
      const conflictWarning = admin2Page.locator('[data-testid="permission-conflict-warning"]');
      await playwrightExpect(conflictWarning).toBeVisible();
      await playwrightExpect(conflictWarning).toHaveText('Another admin is currently managing permissions');

      // Admin2's dialog should be read-only or blocked
      const dialog2 = admin2Page.locator('[data-testid="permissions-dialog"]');
      if (await dialog2.count() > 0) {
        const readOnlyWarning = dialog2.locator('[data-testid="readonly-permissions-warning"]');
        await playwrightExpect(readOnlyWarning).toBeVisible();
      }

      // Admin1 closes dialog
      await dialog1.locator('[data-testid="close-dialog"]').click();

      // Wait for conflict to resolve
      await admin2Page.waitForTimeout(1000);

      // Now Admin2 should be able to manage permissions
      await admin2Page.locator('[data-command="notebook:manage-permissions"]').click();
      const dialog2Active = admin2Page.locator('[data-testid="permissions-dialog"]');
      await playwrightExpect(dialog2Active).toBeVisible();

    } finally {
      await admin1Context.close();
      await admin2Context.close();
    }
  });

  test('should audit permission changes', async ({
    page,
    tmpPath,
    mockUsers,
    waitForCollaboration
  }) => {
    const notebook = `${tmpPath}/${PERMISSIONS_NOTEBOOK}`;

    // Mock admin user
    await page.route('/hub/api/user', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'admin-user',
          admin: true,
          permissions: { notebooks: { [notebook]: 'admin' } }
        })
      });
    });

    // Mock audit log API
    const auditLog: any[] = [];
    await page.route('/api/collaboration/audit/**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audit_log: auditLog })
        });
      } else if (route.request().method() === 'POST') {
        const auditEntry = await route.request().postDataJSON();
        auditLog.push({
          ...auditEntry,
          timestamp: new Date().toISOString(),
          id: auditLog.length + 1
        });
        await route.fulfill({
          status: 201,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true })
        });
      }
    });

    await createCollaborativeSession(page, `notebooks/${notebook}`);
    await waitForCollaboration();

    // Open permissions dialog and make changes
    await page.locator('.jp-MenuBar text="Edit"').click();
    await page.locator('[data-command="notebook:manage-permissions"]').click();

    const permissionsDialog = page.locator('[data-testid="permissions-dialog"]');
    await expect(permissionsDialog).toBeVisible();

    // Add a new user permission
    const addUserButton = permissionsDialog.locator('[data-testid="add-user-permission"]');
    await addUserButton.click();

    const addUserModal = page.locator('[data-testid="add-user-modal"]');
    await expect(addUserModal).toBeVisible();

    await addUserModal.locator('[data-testid="user-name-input"]').fill('new-user');
    await addUserModal.locator('[data-testid="permission-level-select"]').selectOption('edit');
    await addUserModal.locator('[data-testid="add-user-confirm"]').click();

    // Apply changes
    await permissionsDialog.locator('[data-testid="apply-permissions"]').click();

    // Verify audit log entry was created
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].action).toBe('permission_granted');
    expect(auditLog[0].target_user).toBe('new-user');
    expect(auditLog[0].permission_level).toBe('edit');
    expect(auditLog[0].admin_user).toBe('admin-user');

    // Open audit log viewer
    await page.locator('.jp-MenuBar text="View"').click();
    const auditLogMenuItem = page.locator('[data-command="notebook:show-audit-log"]');
    if (await auditLogMenuItem.count() > 0) {
      await auditLogMenuItem.click();

      const auditLogPanel = page.locator('[data-testid="audit-log-panel"]');
      await expect(auditLogPanel).toBeVisible();

      const auditEntry = auditLogPanel.locator('[data-testid="audit-entry"]:first-child');
      await expect(auditEntry).toHaveText('permission_granted');
      await expect(auditEntry).toHaveText('new-user');
      await expect(auditEntry).toHaveText('admin-user');
    }
  });
});
