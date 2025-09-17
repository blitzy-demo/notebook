// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect } from '@jupyterlab/galata';

import { test } from './fixtures';

/**
 * Cell-Level Locking Test Suite
 *
 * Validates distributed lock acquisition, visual lock indicators, timeout handling,
 * and conflict prevention mechanisms for collaborative editing of notebook cells.
 *
 * Features tested:
 * - F-026: Cell-Level Locking implementation
 * - Automatic lock acquisition when editing cells
 * - Visual lock indicators for locked cells
 * - Prevention of simultaneous editing conflicts
 * - Lock timeout and cleanup handling
 * - Lock recovery after reconnection
 * - Concurrent editing of different cells
 */

const COLLABORATION_NOTEBOOK = 'collaboration-locks-test.ipynb';
const LOCK_TEST_TIMEOUT = 10000;

// Use collaboration-enabled test environment
test.use({
  autoGoto: false,
  collaborationEnabled: true
});

test.describe('Cell-Level Locking', () => {
  // Setup test notebook before each test
  test.beforeEach(async ({ page, tmpPath }) => {
    // Create a test notebook with multiple cells for lock testing
    const testNotebook = {
      cells: [
        {
          cell_type: 'markdown',
          metadata: {},
          source: ['# Lock Testing Notebook\n', 'This notebook tests cell-level locking mechanisms.']
        },
        {
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ['# Cell 1: Test basic lock acquisition\n', 'print("Lock test cell 1")']
        },
        {
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ['# Cell 2: Test concurrent access prevention\n', 'x = 42\n', 'print(f"Value: {x}")']
        },
        {
          cell_type: 'markdown',
          metadata: {},
          source: ['## Lock Testing Documentation\n', 'This cell tests markdown locking.']
        }
      ],
      metadata: {
        kernelspec: {
          display_name: 'Python 3',
          language: 'python',
          name: 'python3'
        },
        language_info: {
          name: 'python',
          version: '3.9.0'
        }
      },
      nbformat: 4,
      nbformat_minor: 4
    };

    // Upload the test notebook
    await page.contents.uploadContent(
      JSON.stringify(testNotebook),
      'text',
      `${tmpPath}/${COLLABORATION_NOTEBOOK}`
    );
  });

  // Cleanup after each test
  test.afterEach(async ({ collaborationServer }) => {
    if (collaborationServer) {
      // Stop collaboration server to clean up WebSocket connections
      await collaborationServer.stop();
    }
  });

  test('should acquire lock when editing cell', async ({
    page,
    tmpPath,
    collaborationServer,
    waitForCollaboration
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to notebook with collaboration enabled
    await page.goto(`${notebookPath}?collaborative=true`);

    // Wait for collaboration features to be ready
    const isConnected = await waitForCollaboration(5000);
    expect(isConnected).toBe(true);

    // Wait for notebook to be fully loaded
    await page.waitForSelector('.jp-Notebook', { timeout: LOCK_TEST_TIMEOUT });
    await page.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT });

    // Click on the first code cell to start editing
    const firstCodeCellSelector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';
    await page.click(firstCodeCellSelector);

    // Wait for cell to be focused and lock to be acquired
    await page.waitForSelector(`${firstCodeCellSelector}.jp-mod-focused`, { timeout: 3000 });

    // Verify lock acquisition by checking for lock indicator
    await page.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 2000 });

    // Verify lock indicator shows correct locked state
    const lockIndicatorElement = page.locator('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]');
    const lockState = await lockIndicatorElement.getAttribute('data-locked');
    expect(lockState).toBe('true');

    // Verify cell has locked styling
    const cellElement = page.locator('.jp-Cell:nth-child(2)');
    expect(await cellElement.getAttribute('class')).toContain('jp-mod-locked');
  });

  test('should display lock indicator for locked cells', async ({
    page,
    tmpPath,
    collaborationServer,
    waitForCollaboration,
    mockUsers
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to collaborative notebook
    await page.goto(`${notebookPath}?collaborative=true`);

    // Wait for collaboration setup
    const isConnected = await waitForCollaboration(5000);
    expect(isConnected).toBe(true);

    // Wait for cells to load
    await page.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT });

    // Start editing a cell to trigger lock
    const targetCellSelector = '.jp-Cell:nth-child(3) .jp-InputArea-editor';
    await page.click(targetCellSelector);

    // Wait for lock indicator to appear
    await page.waitForSelector('.jp-Cell:nth-child(3) [data-testid="cell-lock-indicator"]', { timeout: 3000 });
    const lockIndicator = page.locator('.jp-Cell:nth-child(3) [data-testid="cell-lock-indicator"]');

    // Verify lock indicator visual properties
    await page.waitForSelector('.jp-Cell:nth-child(3) [data-testid="cell-lock-indicator"] .jp-collab-lock-icon');

    // Verify lock indicator shows user information
    const userInfo = await lockIndicator.getAttribute('data-locked-by');
    expect(userInfo).toBeTruthy();

    // Verify lock indicator has appropriate styling
    expect(await lockIndicator.getAttribute('class')).toContain('jp-collab-lock-active');

    // Check that lock indicator tooltip shows correct information
    await lockIndicator.hover();
    await page.waitForSelector('[data-testid="lock-tooltip"]', { timeout: 2000 });

    const tooltip = page.locator('[data-testid="lock-tooltip"]');
    const tooltipText = await tooltip.textContent();
    expect(tooltipText).toContain('locked');
  });

  test('should prevent other users from editing locked cell', async ({
    tmpPath,
    collaborationServer,
    waitForCollaboration,
    createMultipleContexts
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Create two browser contexts to simulate different users
    const contexts = await createMultipleContexts(2);
    const page1 = await contexts[0].newPage();
    const page2 = await contexts[1].newPage();

    try {
      // Both users navigate to the same collaborative notebook
      await Promise.all([
        page1.goto(`${notebookPath}?collaborative=true`),
        page2.goto(`${notebookPath}?collaborative=true`)
      ]);

      // Wait for collaboration to be ready on both pages
      await Promise.all([
        waitForCollaboration(5000),
        waitForCollaboration(5000)
      ]);

      // Wait for cells to be available
      await Promise.all([
        page1.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT }),
        page2.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT })
      ]);

      // User 1 starts editing a cell (acquires lock)
      const cellSelector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';
      await page1.click(cellSelector);

      // Wait for lock to be acquired by user 1
      await page1.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });

      // User 2 should see the cell as locked
      await page2.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });

      // User 2 tries to click on the locked cell
      await page2.click(cellSelector);

      // Verify that User 2 cannot edit (cell should not focus or become editable)
      await page2.waitForTimeout(1000); // Give time for any potential focus

      const isFocusedOnPage2 = await page2.evaluate((selector: string) => {
        const editor = document.querySelector(selector);
        return editor?.classList.contains('jp-mod-focused') || false;
      }, cellSelector);

      expect(isFocusedOnPage2).toBe(false);

      // Verify lock denial feedback (e.g., toast message, visual feedback)
      await page2.waitForSelector('[data-testid="lock-denied-message"]', { timeout: 2000 });

    } finally {
      // Context cleanup is handled by the fixture
    }
  });

  test('should release lock on cell blur', async ({
    page,
    tmpPath,
    collaborationServer,
    waitForCollaboration
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to collaborative notebook
    await page.goto(`${notebookPath}?collaborative=true`);

    // Wait for collaboration setup
    const isConnected = await waitForCollaboration(5000);
    expect(isConnected).toBe(true);

    // Wait for cells to load
    await page.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT });

    // Start editing a cell to acquire lock
    const cellSelector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';
    await page.click(cellSelector);

    // Verify lock is acquired
    await page.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });
    const lockIndicator = page.locator('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]');

    // Verify lock indicator is visible and active
    expect(await lockIndicator.isVisible()).toBe(true);

    // Blur the cell by clicking elsewhere or pressing Escape
    await page.keyboard.press('Escape');

    // Alternative: click on another cell to blur current one
    await page.click('.jp-Cell:nth-child(3) .jp-InputArea-editor');

    // Wait for lock to be released (indicator should disappear)
    await page.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { state: 'hidden', timeout: 3000 });

    // Verify cell no longer has locked styling
    const cellElement = page.locator('.jp-Cell:nth-child(2)');
    expect(await cellElement.getAttribute('class')).not.toContain('jp-mod-locked');

    // Verify lock state is cleared
    const lockIndicatorElement = page.locator('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]');
    const lockState = await lockIndicatorElement.getAttribute('data-locked');
    expect(lockState).toBe('false');
  });

  test('should handle lock timeout for idle users', async ({
    page,
    tmpPath,
    collaborationServer,
    waitForCollaboration
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to collaborative notebook
    await page.goto(`${notebookPath}?collaborative=true`);

    // Wait for collaboration setup
    const isConnected = await waitForCollaboration(5000);
    expect(isConnected).toBe(true);

    // Wait for cells to load
    await page.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT });

    // Start editing a cell to acquire lock
    const cellSelector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';
    await page.click(cellSelector);

    // Verify lock is acquired
    await page.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });
    const lockIndicator = page.locator('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]');

    // Verify lock is initially active
    expect(await lockIndicator.isVisible()).toBe(true);

    // Simulate idle behavior (no typing or interaction)
    // Wait for lock timeout (assuming timeout is configured to ~5 seconds for testing)
    await page.waitForTimeout(6000);

    // Check if lock timeout warning appears
    await page.waitForSelector('[data-testid="lock-timeout-warning"]', { timeout: 2000 });

    // Continue waiting for full timeout
    await page.waitForTimeout(3000);

    // Verify lock is automatically released due to timeout
    await page.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { state: 'hidden', timeout: 2000 });

    // Verify cell styling is cleared
    const cellElement = page.locator('.jp-Cell:nth-child(2)');
    expect(await cellElement.getAttribute('class')).not.toContain('jp-mod-locked');

    // Verify timeout notification was shown
    await page.waitForSelector('[data-testid="lock-timeout-notification"]', { timeout: 1000 });
  });

  test('should queue lock requests appropriately', async ({
    tmpPath,
    collaborationServer,
    waitForCollaboration,
    createMultipleContexts
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Create three browser contexts to test lock queuing
    const contexts = await createMultipleContexts(3);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));

    try {
      // All users navigate to the same collaborative notebook
      await Promise.all(pages.map(page => page.goto(`${notebookPath}?collaborative=true`)));

      // Wait for collaboration to be ready on all pages
      await Promise.all(pages.map(() => waitForCollaboration(5000)));

      // Wait for cells to be available
      await Promise.all(pages.map(page =>
        page.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT })
      ));

      const cellSelector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';

      // User 1 acquires the lock first
      await pages[0].click(cellSelector);
      await pages[0].waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });

      // Users 2 and 3 request the same lock (should be queued)
      await Promise.all([
        pages[1].click(cellSelector),
        pages[2].click(cellSelector)
      ]);

      // Verify queue indicators appear for users 2 and 3
      await Promise.all([
        pages[1].waitForSelector('[data-testid="lock-queue-indicator"]', { timeout: 3000 }),
        pages[2].waitForSelector('[data-testid="lock-queue-indicator"]', { timeout: 3000 })
      ]);

      const queueIndicator1 = pages[1].locator('[data-testid="lock-queue-indicator"]');
      const queueIndicator2 = pages[2].locator('[data-testid="lock-queue-indicator"]');

      // Verify queue positions are shown
      const queuePosition1 = await queueIndicator1.getAttribute('data-queue-position');
      const queuePosition2 = await queueIndicator2.getAttribute('data-queue-position');

      expect(parseInt(queuePosition1)).toBe(1);
      expect(parseInt(queuePosition2)).toBe(2);

      // User 1 releases the lock
      await pages[0].keyboard.press('Escape');

      // User 2 should automatically acquire the lock (next in queue)
      await pages[1].waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });

      // User 3's queue position should update
      const updatedQueuePosition = await queueIndicator2.getAttribute('data-queue-position');
      expect(parseInt(updatedQueuePosition)).toBe(1);

    } finally {
      // Context cleanup is handled by the fixture
    }
  });

  test('should recover locks after reconnection', async ({
    page,
    tmpPath,
    collaborationServer,
    waitForCollaboration
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to collaborative notebook
    await page.goto(`${notebookPath}?collaborative=true`);

    // Wait for collaboration setup
    let isConnected = await waitForCollaboration(5000);
    expect(isConnected).toBe(true);

    // Wait for cells to load
    await page.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT });

    // Start editing a cell to acquire lock
    const cellSelector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';
    await page.click(cellSelector);

    // Verify lock is acquired
    await page.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });
    const lockIndicator = page.locator('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]');

    // Simulate connection interruption by stopping collaboration server
    if (collaborationServer) {
      await collaborationServer.stop();
    }

    // Wait for disconnect indicator
    await page.waitForSelector('[data-testid="collaboration-disconnect"]', { timeout: 5000 });

    // Verify lock is maintained during disconnection (optimistic locking)
    const isLockVisible = await lockIndicator.isVisible();
    expect(isLockVisible).toBe(true);

    // Restart collaboration server to simulate reconnection
    if (collaborationServer) {
      await collaborationServer.start();
    }

    // Wait for reconnection
    await page.waitForSelector('[data-testid="collaboration-reconnect"]', { timeout: 5000 });

    // Verify lock state is recovered after reconnection
    await page.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });

    // Verify lock state is consistent
    const lockState = await lockIndicator.getAttribute('data-locked');
    expect(lockState).toBe('true');

    // Verify user can continue editing without issues
    await page.keyboard.type(' # Reconnection test');

    // Verify changes are synchronized
    await page.waitForTimeout(1000);
    const cellContent = await page.evaluate(() => {
      const editor = document.querySelector('.jp-Cell:nth-child(2) .jp-InputArea-editor .cm-content');
      return editor?.textContent || '';
    });

    expect(cellContent).toContain('Reconnection test');
  });

  test('should allow concurrent editing of different cells', async ({
    tmpPath,
    collaborationServer,
    waitForCollaboration,
    createMultipleContexts
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Create two browser contexts for concurrent users
    const contexts = await createMultipleContexts(2);
    const page1 = await contexts[0].newPage();
    const page2 = await contexts[1].newPage();

    try {
      // Both users navigate to the collaborative notebook
      await Promise.all([
        page1.goto(`${notebookPath}?collaborative=true`),
        page2.goto(`${notebookPath}?collaborative=true`)
      ]);

      // Wait for collaboration setup on both pages
      await Promise.all([
        waitForCollaboration(5000),
        waitForCollaboration(5000)
      ]);

      // Wait for cells to be available
      await Promise.all([
        page1.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT }),
        page2.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT })
      ]);

      // User 1 edits cell 2, User 2 edits cell 3 (different cells)
      const cell2Selector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';
      const cell3Selector = '.jp-Cell:nth-child(3) .jp-InputArea-editor';

      // Start concurrent editing of different cells
      await Promise.all([
        page1.click(cell2Selector),
        page2.click(cell3Selector)
      ]);

      // Both users should successfully acquire locks on their respective cells
      await Promise.all([
        page1.waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 }),
        page2.waitForSelector('.jp-Cell:nth-child(3) [data-testid="cell-lock-indicator"]', { timeout: 3000 })
      ]);

      const lockIndicator1 = page1.locator('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]');
      const lockIndicator2 = page2.locator('.jp-Cell:nth-child(3) [data-testid="cell-lock-indicator"]');

      // Both users should be able to type in their cells
      await Promise.all([
        page1.keyboard.type(' # Edit by User 1'),
        page2.keyboard.type(' # Edit by User 2')
      ]);

      // Wait for synchronization
      await page1.waitForTimeout(2000);
      await page2.waitForTimeout(2000);

      // Verify both edits are preserved and synchronized
      const cell2ContentOnPage2 = await page2.evaluate(() => {
        const editor = document.querySelector('.jp-Cell:nth-child(2) .jp-InputArea-editor .cm-content');
        return editor?.textContent || '';
      });

      const cell3ContentOnPage1 = await page1.evaluate(() => {
        const editor = document.querySelector('.jp-Cell:nth-child(3) .jp-InputArea-editor .cm-content');
        return editor?.textContent || '';
      });

      expect(cell2ContentOnPage2).toContain('Edit by User 1');
      expect(cell3ContentOnPage1).toContain('Edit by User 2');

      // Verify no conflicts occurred (both locks maintained independently)
      const lock1Visible = await lockIndicator1.isVisible();
      const lock2Visible = await lockIndicator2.isVisible();
      expect(lock1Visible).toBe(true);
      expect(lock2Visible).toBe(true);

    } finally {
      // Context cleanup is handled by the fixture
    }
  });

  test('should handle rapid lock transitions', async ({
    page,
    tmpPath,
    collaborationServer,
    waitForCollaboration
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Navigate to collaborative notebook
    await page.goto(`${notebookPath}?collaborative=true`);

    // Wait for collaboration setup
    const isConnected = await waitForCollaboration(5000);
    expect(isConnected).toBe(true);

    // Wait for cells to load
    await page.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT });

    const cell1Selector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';
    const cell2Selector = '.jp-Cell:nth-child(3) .jp-InputArea-editor';
    const cell3Selector = '.jp-Cell:nth-child(4) .jp-InputArea-editor';

    // Perform rapid transitions between cells to stress test the locking system
    for (let i = 0; i < 5; i++) {
      // Rapidly click between different cells
      await page.click(cell1Selector);
      await page.waitForTimeout(200);

      await page.click(cell2Selector);
      await page.waitForTimeout(200);

      await page.click(cell3Selector);
      await page.waitForTimeout(200);
    }

    // Wait for system to stabilize
    await page.waitForTimeout(1000);

    // Verify final state is consistent (only one cell should be locked)
    const lockIndicators = page.locator('[data-testid="cell-lock-indicator"]');
    const activeLockCount = await lockIndicators.count();

    expect(activeLockCount).toBe(1); // Only one cell should remain locked

    // Verify the locked cell is the last one clicked (cell 3)
    await page.waitForSelector('.jp-Cell:nth-child(4) [data-testid="cell-lock-indicator"]');

    // Verify system can continue normal operation after rapid transitions
    await page.keyboard.type(' # Stress test complete');

    // Verify content is properly updated
    const cellContent = await page.evaluate(() => {
      const editor = document.querySelector('.jp-Cell:nth-child(4) .jp-InputArea-editor .cm-content');
      return editor?.textContent || '';
    });

    expect(cellContent).toContain('Stress test complete');

    // Verify no memory leaks or stuck locks from rapid transitions
    const stuckLockIndicators = page.locator('[data-testid="cell-lock-indicator"][data-locked="true"]');
    const stuckLockCount = await stuckLockIndicators.count();

    expect(stuckLockCount).toBe(1); // Should be exactly the one active lock
  });

  // Performance and reliability test
  test('should maintain performance during concurrent lock operations', async ({
    tmpPath,
    collaborationServer,
    waitForCollaboration,
    createMultipleContexts
  }) => {
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    // Create multiple contexts to simulate heavy concurrent usage
    const contexts = await createMultipleContexts(4);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));

    try {
      // All users navigate to the collaborative notebook
      await Promise.all(pages.map(page => page.goto(`${notebookPath}?collaborative=true`)));

      // Wait for all to be ready
      await Promise.all(pages.map(() => waitForCollaboration(5000)));

      // Wait for cells to be available on all pages
      await Promise.all(pages.map(page =>
        page.waitForSelector('.jp-Cell', { timeout: LOCK_TEST_TIMEOUT })
      ));

      // Measure performance during concurrent operations
      const startTime = Date.now();

      // All users rapidly try to acquire locks on different cells
      const lockOperations = pages.map(async (page, index) => {
        const cellIndex = (index % 4) + 2; // Use cells 2-5
        const cellSelector = `.jp-Cell:nth-child(${cellIndex}) .jp-InputArea-editor`;

        for (let i = 0; i < 3; i++) {
          await page.click(cellSelector);
          await page.waitForTimeout(500);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
      });

      await Promise.all(lockOperations);

      const operationTime = Date.now() - startTime;

      // Verify performance is acceptable (should complete within reasonable time)
      expect(operationTime).toBeLessThan(15000); // 15 seconds max for all operations

      // Verify system is still responsive after concurrent operations
      await pages[0].click('.jp-Cell:nth-child(2) .jp-InputArea-editor');
      await pages[0].waitForSelector('.jp-Cell:nth-child(2) [data-testid="cell-lock-indicator"]', { timeout: 3000 });

      // Verify no system errors or lock conflicts
      const errorIndicators = pages[0].locator('[data-testid="collaboration-error"]');
      const errorCount = await errorIndicators.count();
      expect(errorCount).toBe(0);

    } finally {
      // Context cleanup is handled by the fixture
    }
  });
});
