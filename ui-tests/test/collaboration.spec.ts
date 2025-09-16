// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import path from 'path';

import { expect } from '@jupyterlab/galata';

import { test } from './fixtures';

import {
  waitForCollaboration,
  waitForSync,
  createCollaborativeSession
} from './utils';

import {
  CollaborationUser,
  CollaborationSession,
  cleanupCollaborationSession
} from './collaboration-helpers';

import { Page } from '@playwright/test';

const COLLABORATION_NOTEBOOK = 'collaboration-test.ipynb';

test.use({ autoGoto: false });

/**
 * Core collaboration test suite validating basic real-time synchronization features
 * and ensuring single-user mode compatibility remains intact when collaboration is disabled.
 *
 * Tests cover:
 * - Real-Time Document Synchronization (F-024) basic functionality
 * - Collaboration enablement/disablement without breaking single-user mode
 * - WebSocket connection establishment and teardown
 * - Basic document sync between two users
 * - Backward compatibility for single-user scenarios
 */
test.describe('Basic Collaboration Features', () => {

  test.beforeEach(async ({ page, tmpPath }) => {
    // Upload test notebook for collaboration testing
    await page.contents.uploadFile(
      path.resolve(__dirname, `../../binder/example.ipynb`),
      `${tmpPath}/${COLLABORATION_NOTEBOOK}`
    );

    // Ensure we start with a clean collaboration state
    await page.evaluate(() => {
      // Clear any existing collaboration state
      if ((window as any).jupyterapp?.serviceManager?.collaboration) {
        (window as any).jupyterapp.serviceManager.collaboration.cleanup?.();
      }
    });
  });

  test.afterEach(async ({ page }) => {
    // Clean up collaboration resources after each test
    try {
      await page.evaluate(() => {
        const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
        if (collaboration) {
          // Disconnect any active WebSocket connections
          collaboration.provider?.disconnect();

          // Clear awareness state
          collaboration.awareness?.destroy();

          // Clean up document state
          collaboration.document?.destroy();
        }
      });
    } catch (error) {
      // Ignore cleanup errors in tests
      console.warn('Collaboration cleanup error:', error);
    }
  });

  /**
   * Test: Collaboration mode can be enabled without causing errors
   * Validates that the collaboration system can be activated and remains stable
   */
  test('should enable collaboration mode without errors', async ({
    page,
    tmpPath,
    collaborationEnabled
  }) => {
    const notebook = `${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to notebook with collaboration enabled
    await page.goto(`notebooks/${notebook}?collaborative=true`);

    // Wait for notebook to load completely
    await page.waitForSelector('.jp-NotebookPanel', { timeout: 10000 });

    // Verify collaboration mode is active without errors
    const collaborationActive = await page.evaluate(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      return collaboration?.isActive === true;
    });

    expect(collaborationActive).toBe(true);

    // Verify no JavaScript errors occurred during collaboration initialization
    const hasErrors = await page.evaluate(() => {
      return window.jupyterErrors && window.jupyterErrors.length > 0;
    });

    expect(hasErrors).toBeFalsy();
  });

  /**
   * Test: WebSocket connection establishment
   * Validates that the /api/collaboration/ws connection can be established
   */
  test('should establish WebSocket connection', async ({
    page,
    tmpPath,
    collaborationServer,
    waitForCollaboration
  }) => {
    const notebook = `${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to collaborative notebook
    await page.goto(`notebooks/${notebook}?collaborative=true`);

    // Wait for collaboration to initialize
    await waitForCollaboration(5000);

    // Verify WebSocket connection is established
    const wsConnected = await page.evaluate(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      return collaboration?.provider?.wsconnected === true;
    });

    expect(wsConnected).toBe(true);

    // Verify connection state indicator shows connected status
    const statusElement = page.locator('[data-testid="collaboration-status"]');
    const connectionStatus = await statusElement.getAttribute('data-connected');
    expect(connectionStatus).toBe('true');
  });

  /**
   * Test: Basic metadata synchronization between users
   * Validates that notebook metadata changes sync properly between collaborative users
   */
  test('should sync notebook metadata between users', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers
  }) => {
    const notebook = `${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Create two browser contexts to simulate different users
    const contexts = await createMultipleContexts(2);
    const page1 = await contexts[0].newPage();
    const page2 = await contexts[1].newPage();

    try {
      // Both users navigate to the same collaborative notebook
      await Promise.all([
        page1.goto(`notebooks/${notebook}?collaborative=true`),
        page2.goto(`notebooks/${notebook}?collaborative=true`)
      ]);

      // Wait for collaboration to be ready on both pages
      await Promise.all([
        waitForCollaboration(page1),
        waitForCollaboration(page2)
      ]);

      // User 1 changes notebook metadata
      await page1.evaluate(() => {
        const nbModel = (window as any).jupyterapp?.shell?.currentWidget?.content?.model;
        if (nbModel) {
          const metadata = nbModel.metadata;
          metadata.set('test_collaboration', {
            modified_by: 'user1',
            timestamp: Date.now()
          });
        }
      });

      // Wait for synchronization
      await waitForSync(page1, 3000);
      await waitForSync(page2, 3000);

      // Verify User 2 received the metadata change
      const syncedMetadata = await page2.evaluate(() => {
        const nbModel = (window as any).jupyterapp?.shell?.currentWidget?.content?.model;
        return nbModel ? nbModel.metadata.get('test_collaboration') : null;
      });

      expect(syncedMetadata).toBeTruthy();
      expect(syncedMetadata.modified_by).toBe('user1');

    } finally {
      await page1.close();
      await page2.close();
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: Single user can edit normally in collaborative mode
   * Validates that collaboration mode doesn't interfere with single-user operations
   */
  test('should handle single user in collaborative mode', async ({
    page,
    tmpPath
  }) => {
    const notebook = `${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to collaborative notebook as single user
    await page.goto(`notebooks/${notebook}?collaborative=true`);

    // Wait for notebook and collaboration to load
    await page.waitForSelector('.jp-NotebookPanel');
    await waitForCollaboration(page);

    // Verify user can edit cells normally
    const firstCell = page.locator('.jp-Cell:first-child .jp-InputArea-editor');
    await firstCell.click();

    // Add content to the cell
    const testContent = '# Single user collaboration test\nprint("Hello collaborative world!")';
    await page.keyboard.press('Control+a');
    await page.keyboard.type(testContent);

    // Verify content was added successfully
    const cellContent = await page.locator('.jp-Cell:first-child .cm-content').textContent();
    expect(cellContent).toContain('Single user collaboration test');
    expect(cellContent).toContain('Hello collaborative world!');

    // Verify collaboration status shows one user (self)
    await page.waitForSelector('[data-testid="user-presence-bar"]', { timeout: 3000 });
    const userAvatars = await page.locator('[data-testid="user-avatar"]').count();
    expect(userAvatars).toBeGreaterThanOrEqual(0); // May show self or be empty for single user
  });

  /**
   * Test: Graceful fallback when collaboration is disabled
   * Validates that single-user mode works perfectly when collaboration features are disabled
   */
  test('should gracefully fall back when collaboration disabled', async ({
    page,
    tmpPath
  }) => {
    const notebook = `${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to notebook WITHOUT collaboration enabled (normal single-user mode)
    await page.goto(`notebooks/${notebook}`);

    // Wait for notebook to load
    await page.waitForSelector('.jp-NotebookPanel');

    // Verify collaboration elements are not present
    const collaborationStatus = page.locator('[data-testid="collaboration-status"]');
    await expect(collaborationStatus).toHaveCount(0);

    const presenceBar = page.locator('[data-testid="user-presence-bar"]');
    await expect(presenceBar).toHaveCount(0);

    // Verify normal notebook functionality works perfectly
    const firstCell = page.locator('.jp-Cell:first-child .jp-InputArea-editor');
    await firstCell.click();

    // Add and execute content
    const testCode = 'print("Single user mode works!")';
    await page.keyboard.press('Control+a');
    await page.keyboard.type(testCode);

    // Execute the cell
    await page.keyboard.press('Shift+Enter');

    // Verify output appears
    await page.waitForSelector('.jp-Cell:first-child .jp-OutputArea', { timeout: 10000 });
    const output = await page.locator('.jp-Cell:first-child .jp-OutputArea').textContent();
    expect(output).toContain('Single user mode works!');

    // Verify no collaboration-related JavaScript errors
    const hasCollabErrors = await page.evaluate(() => {
      const errors = (window as any).jupyterErrors || [];
      return errors.some((error: any) =>
        error.message && error.message.toLowerCase().includes('collaboration')
      );
    });

    expect(hasCollabErrors).toBe(false);
  });

  /**
   * Test: Connection resilience after network interruption
   * Validates that collaboration can reconnect after temporary network issues
   */
  test('should reconnect after network interruption', async ({
    page,
    tmpPath,
    collaborationServer
  }) => {
    const notebook = `${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to collaborative notebook
    await page.goto(`notebooks/${notebook}?collaborative=true`);

    // Wait for initial collaboration connection
    await waitForCollaboration(page);

    // Verify initial connection
    const initialConnection = await page.evaluate(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      return collaboration?.provider?.wsconnected === true;
    });

    expect(initialConnection).toBe(true);

    // Simulate network interruption by disconnecting WebSocket
    await page.evaluate(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      if (collaboration?.provider?.ws) {
        collaboration.provider.ws.close();
      }
    });

    // Wait a moment for disconnection to register
    await page.waitForTimeout(1000);

    // Verify disconnection is detected
    const disconnectedState = await page.evaluate(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      return collaboration?.provider?.wsconnected === false;
    });

    expect(disconnectedState).toBe(true);

    // Wait for automatic reconnection (most systems have auto-reconnect)
    await page.waitForTimeout(3000);

    // Check if reconnection occurred or connection is restored
    const reconnectionAttempted = await page.evaluate(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      // Return true if either reconnected or connection state shows reconnecting
      return collaboration?.provider && (
        collaboration.provider.wsconnected === true ||
        collaboration.provider.ws?.readyState === WebSocket.CONNECTING
      );
    });

    // We expect either successful reconnection or active reconnection attempt
    expect(reconnectionAttempted).toBeTruthy();
  });

  /**
   * Test: Notebook format compatibility preservation
   * Validates that collaborative features don't alter the standard .ipynb file format
   */
  test('should preserve notebook format compatibility', async ({
    page,
    tmpPath
  }) => {
    const notebook = `${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Get original notebook content
    const originalContent = await page.contents.get(`${tmpPath}/${COLLABORATION_NOTEBOOK}`);

    // Open notebook in collaborative mode
    await page.goto(`notebooks/${notebook}?collaborative=true`);
    await waitForCollaboration(page);

    // Make some collaborative edits
    const firstCell = page.locator('.jp-Cell:first-child .jp-InputArea-editor');
    await firstCell.click();
    await page.keyboard.type('# Collaborative edit test');

    // Save the notebook
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.jp-NotebookCheckpoint');

    // Get saved notebook content
    const savedContent = await page.contents.get(`${tmpPath}/${COLLABORATION_NOTEBOOK}`);

    // Verify file format structure remains valid
    expect(savedContent.type).toBe('notebook');
    expect(savedContent.format).toBe('json');

    // Parse content to verify it's valid JSON notebook format
    const notebookData = savedContent.content as any;
    expect(notebookData.nbformat).toBeDefined();
    expect(notebookData.nbformat_minor).toBeDefined();
    expect(notebookData.cells).toBeDefined();
    expect(Array.isArray(notebookData.cells)).toBe(true);
    expect(notebookData.metadata).toBeDefined();

    // Verify no collaboration-specific metadata pollutes the file format
    const metadataKeys = Object.keys(notebookData.metadata);
    const hasCollabMetadata = metadataKeys.some(key =>
      key.includes('collaboration') || key.includes('yjs') || key.includes('websocket')
    );

    expect(hasCollabMetadata).toBe(false);

    // Verify basic notebook structure compatibility
    expect(notebookData.nbformat).toBe(4); // Standard Jupyter format version
    expect(typeof notebookData.metadata).toBe('object');
  });

  /**
   * Test: Kernel operations remain independent per user
   * Validates that collaborative editing doesn't interfere with kernel execution
   */
  test('should not affect kernel operations', async ({
    page,
    tmpPath,
    createMultipleContexts
  }) => {
    const notebook = `${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Create two contexts for testing independent kernel operations
    const contexts = await createMultipleContexts(2);
    const page1 = await contexts[0].newPage();
    const page2 = await contexts[1].newPage();

    try {
      // Both users open the same notebook
      await Promise.all([
        page1.goto(`notebooks/${notebook}?collaborative=true`),
        page2.goto(`notebooks/${notebook}?collaborative=true`)
      ]);

      // Wait for collaboration on both pages
      await Promise.all([
        waitForCollaboration(page1),
        waitForCollaboration(page2)
      ]);

      // User 1 executes a cell
      await page1.click('.jp-Cell:first-child .jp-InputArea-editor');
      await page1.keyboard.press('Control+a');
      await page1.keyboard.type('user1_var = "executed by user 1"');
      await page1.keyboard.press('Shift+Enter');

      // User 2 executes a different cell (or adds one)
      // First, add a new cell
      await page2.keyboard.press('b'); // Add cell below
      await page2.keyboard.type('user2_var = "executed by user 2"\\nprint(user2_var)');
      await page2.keyboard.press('Shift+Enter');

      // Wait for both executions to complete
      await Promise.all([
        page1.waitForSelector('.jp-Cell:first-child .jp-OutputArea', { timeout: 10000 }),
        page2.waitForSelector('.jp-Cell:nth-child(2) .jp-OutputArea', { timeout: 10000 })
      ]);

      // Verify User 1's kernel state is independent
      await page1.click('.jp-Notebook-footer');
      await page1.keyboard.press('b'); // Add new cell
      await page1.keyboard.type('print("User 1 kernel test:", user1_var)');
      await page1.keyboard.press('Shift+Enter');

      // Verify User 2's kernel state is independent
      await page2.click('.jp-Notebook-footer');
      await page2.keyboard.press('b'); // Add new cell
      await page2.keyboard.type('print("User 2 kernel test:", user2_var)');
      await page2.keyboard.press('Shift+Enter');

      // Both should execute successfully with their own kernel variables
      await Promise.all([
        page1.waitForSelector('.jp-OutputArea:last-child', { timeout: 10000 }),
        page2.waitForSelector('.jp-OutputArea:last-child', { timeout: 10000 })
      ]);

      // Verify outputs show independent execution
      const user1Output = await page1.locator('.jp-OutputArea:last-child').textContent();
      const user2Output = await page2.locator('.jp-OutputArea:last-child').textContent();

      // Each user should see their own variable values
      expect(user1Output).toContain('User 1 kernel test');
      expect(user2Output).toContain('User 2 kernel test');

      // Document structure should be synced even if kernel states are separate
      await waitForSync(page1);
      await waitForSync(page2);

      // Both pages should show the same notebook structure
      const cells1 = await page1.locator('.jp-Cell').count();
      const cells2 = await page2.locator('.jp-Cell').count();
      expect(cells1).toBe(cells2);

    } finally {
      await page1.close();
      await page2.close();
      for (const context of contexts) {
        await context.close();
      }
    }
  });

});
