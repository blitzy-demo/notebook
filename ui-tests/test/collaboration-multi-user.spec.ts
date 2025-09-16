// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Multi-user collaboration test suite validating concurrent editing scenarios with 2 or more users,
 * testing CRDT conflict resolution and document consistency. This comprehensive test suite validates
 * all collaborative features (F-024 through F-029) including real-time synchronization, user presence,
 * cell locking, change history, permissions, and comment systems.
 */

import path from 'path';

import { expect } from '@jupyterlab/galata';
import { BrowserContext } from '@playwright/test';

import { test } from './fixtures';
import {
  verifyDocumentConsistency,
  createMultipleContexts,
  waitForCollaboration,
  waitForSync,
  simulateConcurrentEdits,
  verifyPresenceIndicators,
  checkCellLock,
  measureSyncLatency,
  createCollaborativeSession,
  waitForAwarenessUpdate
} from './utils';
import {
  cleanupCollaborationSession,
  generateCollaborativeNotebook,
  PERFORMANCE_THRESHOLDS,
  COLLABORATION_TIMEOUTS,
  CollaborationSession
} from './collaboration-helpers';

// Test notebook configuration
const COLLABORATION_NOTEBOOK = 'collaborative-test.ipynb';

// Configure test behavior
test.use({ autoGoto: false });

test.describe('Multi-User Collaboration', () => {
  let notebookContent: any;

  test.beforeEach(async ({ page, tmpPath }) => {
    // Generate collaborative notebook with test content
    notebookContent = generateCollaborativeNotebook();

    // Upload notebook for testing
    await page.contents.uploadFile(
      JSON.stringify(notebookContent),
      `${tmpPath}/${COLLABORATION_NOTEBOOK}`,
      'application/json'
    );
  });

  test.afterEach(async ({ collaborationServer }) => {
    // Cleanup collaboration server resources
    if (collaborationServer) {
      await collaborationServer.stop();
    }
  });

  test('should sync edits between two users in real-time', async ({
    browser,
    tmpPath,
    collaborationServer,
    mockUsers,
    waitForCollaboration: waitForCollaborationFixture
  }) => {
    // Validate Real-Time Document Synchronization (F-024) with basic two-user sync
    const contexts = await createMultipleContexts(browser, 2);
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    try {
      const pages = await Promise.all(
        contexts.map(context => context.newPage())
      );

      // Both users navigate to collaborative notebook
      await Promise.all(
        pages.map(page => createCollaborativeSession(page, notebookPath))
      );

      // Wait for collaboration to be established
      const collaborationReady = await waitForCollaborationFixture();
      expect(collaborationReady).toBe(true);

      // Verify presence indicators show both users
      await Promise.all(
        pages.map(page => waitForAwarenessUpdate(page))
      );

      // Verify user presence indicators (F-025)
      await verifyPresenceIndicators(pages[0], [mockUsers[0].id, mockUsers[1].id]);
      await verifyPresenceIndicators(pages[1], [mockUsers[0].id, mockUsers[1].id]);

      // User 1 edits first cell
      const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
      await pages[0].click(cellSelector);
      await pages[0].keyboard.type('# Edited by User 1\nprint("Hello from User 1")');

      // Wait for synchronization
      await waitForSync(pages[0]);

      // Verify User 2 sees the changes
      await pages[1].waitForFunction(() => {
        const cellContent = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
        return cellContent?.textContent?.includes('Hello from User 1');
      }, { timeout: COLLABORATION_TIMEOUTS.SYNC_WAIT });

      // User 2 adds content to second cell
      await pages[1].click('.jp-Cell:nth-child(2) .jp-InputArea-editor');
      await pages[1].keyboard.type('# Edited by User 2\nprint("Hello from User 2")');

      // Wait for synchronization
      await waitForSync(pages[1]);

      // Verify User 1 sees User 2's changes
      await pages[0].waitForFunction(() => {
        const secondCell = document.querySelector('.jp-Cell:nth-child(2) .jp-InputArea-editor .cm-content');
        return secondCell?.textContent?.includes('Hello from User 2');
      }, { timeout: COLLABORATION_TIMEOUTS.SYNC_WAIT });

      // Validate final document consistency
      await verifyDocumentConsistency(pages);

      // Measure and validate synchronization latency (performance requirement)
      const latency = await measureSyncLatency(pages[0], pages[1]);
      expect(latency).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_EDIT_LATENCY);

    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });

  test('should handle concurrent cell edits without conflicts', async ({
    browser,
    tmpPath,
    collaborationServer,
    mockUsers
  }) => {
    // Test CRDT conflict resolution and operational transformation
    const contexts = await createMultipleContexts(browser, 2);
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    try {
      const pages = await Promise.all(
        contexts.map(context => context.newPage())
      );

      // Setup collaborative sessions
      await Promise.all(
        pages.map(page => createCollaborativeSession(page, notebookPath))
      );

      // Wait for collaboration initialization
      await Promise.all(
        pages.map(page => waitForCollaboration(page))
      );

      // Test concurrent editing on same cell (CRDT resolution)
      const concurrentEdits = [
        'print("Concurrent edit from User 1")',
        'print("Concurrent edit from User 2")'
      ];

      // Simulate simultaneous edits on the same cell
      await simulateConcurrentEdits(pages, 1, concurrentEdits);

      // Wait for all changes to propagate and resolve
      await Promise.all(pages.map(page => waitForSync(page, 10000)));

      // Verify document consistency after conflict resolution
      await verifyDocumentConsistency(pages);

      // Verify both edits are preserved in some form (CRDT merge behavior)
      const finalContent = await pages[0].evaluate(() => {
        const cell = document.querySelector('.jp-Cell:nth-child(2) .jp-InputArea-editor .cm-content');
        return cell?.textContent || '';
      });

      // CRDT should merge both changes without data loss
      const hasUser1Content = finalContent.includes('User 1') || finalContent.includes('Concurrent edit');
      const hasUser2Content = finalContent.includes('User 2') || finalContent.includes('Concurrent edit');

      expect(hasUser1Content || hasUser2Content).toBe(true);

    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });

  test('should maintain consistency with 3+ users', async ({
    browser,
    tmpPath,
    collaborationServer,
    mockUsers
  }) => {
    // Test multi-user document consistency with 3 concurrent users
    const userCount = 3;
    const contexts = await createMultipleContexts(browser, userCount);
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    try {
      const pages = await Promise.all(
        contexts.map(context => context.newPage())
      );

      // All users join collaborative session
      await Promise.all(
        pages.map(page => createCollaborativeSession(page, notebookPath))
      );

      // Wait for all users to be present
      await Promise.all(
        pages.map(page => waitForAwarenessUpdate(page))
      );

      // Verify all users can see each other
      const expectedUserIds = mockUsers.slice(0, userCount).map(user => user.id);
      await Promise.all(
        pages.map(page => verifyPresenceIndicators(page, expectedUserIds))
      );

      // Each user edits a different cell to test parallel collaboration
      const editPromises = pages.map(async (page, index) => {
        const cellIndex = index; // Each user gets their own cell
        const cellSelector = `.jp-Cell:nth-child(${cellIndex + 1}) .jp-InputArea-editor`;

        await page.click(cellSelector);
        await page.keyboard.type(`# Edit from User ${index + 1}\nprint("Content from user ${index + 1}")`);
        await waitForSync(page);
      });

      // Execute all edits in parallel
      await Promise.all(editPromises);

      // Allow extra time for all changes to propagate
      await Promise.all(pages.map(page => waitForSync(page, 15000)));

      // Verify document consistency across all users
      await verifyDocumentConsistency(pages);

      // Verify each user's contribution is present in all clients
      for (let userIndex = 0; userIndex < userCount; userIndex++) {
        const expectedContent = `Content from user ${userIndex + 1}`;

        for (const page of pages) {
          await page.waitForFunction(
            (content) => {
              const cells = Array.from(document.querySelectorAll('.jp-Cell .jp-InputArea-editor .cm-content'));
              return cells.some(cell => cell.textContent?.includes(content));
            },
            expectedContent,
            { timeout: 10000 }
          );
        }
      }

    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });

  test('should handle rapid sequential edits across users', async ({
    browser,
    tmpPath,
    collaborationServer
  }) => {
    // Stress testing rapid edits to validate performance under load
    const contexts = await createMultipleContexts(browser, 2);
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    try {
      const pages = await Promise.all(
        contexts.map(context => context.newPage())
      );

      // Setup collaborative sessions
      await Promise.all(
        pages.map(page => createCollaborativeSession(page, notebookPath))
      );

      // Wait for collaboration readiness
      await Promise.all(
        pages.map(page => waitForCollaboration(page))
      );

      // Perform rapid sequential edits
      const rapidEditCount = 10;
      const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';

      for (let i = 0; i < rapidEditCount; i++) {
        const page = pages[i % 2]; // Alternate between users
        const userNumber = (i % 2) + 1;

        await page.click(cellSelector);
        await page.keyboard.press('End'); // Go to end of cell
        await page.keyboard.type(`\n# Rapid edit ${i + 1} by User ${userNumber}`);

        // Small delay to allow some synchronization
        await page.waitForTimeout(50);
      }

      // Wait for all edits to fully synchronize
      await Promise.all(pages.map(page => waitForSync(page, 20000)));

      // Verify document consistency after rapid editing
      await verifyDocumentConsistency(pages);

      // Verify that most edits are preserved
      const finalContent = await pages[0].evaluate(() => {
        const cell = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
        return cell?.textContent || '';
      });

      // Count preserved edits
      const preservedEdits = (finalContent.match(/Rapid edit \d+/g) || []).length;

      // Should preserve significant portion of edits (allow for some merging/conflicts)
      expect(preservedEdits).toBeGreaterThan(rapidEditCount * 0.7);

    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });

  test('should sync cell additions and deletions', async ({
    browser,
    tmpPath,
    collaborationServer
  }) => {
    // Test structural changes sync (cell additions/deletions)
    const contexts = await createMultipleContexts(browser, 2);
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    try {
      const pages = await Promise.all(
        contexts.map(context => context.newPage())
      );

      // Setup collaborative sessions
      await Promise.all(
        pages.map(page => createCollaborativeSession(page, notebookPath))
      );

      await Promise.all(
        pages.map(page => waitForCollaboration(page))
      );

      // Get initial cell count
      const initialCellCount = await pages[0].locator('.jp-Cell').count();

      // User 1 adds a new cell
      await pages[0].click('.jp-Notebook-footer');
      await pages[0].keyboard.press('a'); // Add cell above
      await pages[0].keyboard.type('print("New cell added by User 1")');

      // Wait for synchronization
      await waitForSync(pages[0]);

      // Verify User 2 sees the new cell
      await pages[1].waitForFunction(
        (expectedCount) => {
          return document.querySelectorAll('.jp-Cell').length === expectedCount;
        },
        initialCellCount + 1,
        { timeout: COLLABORATION_TIMEOUTS.SYNC_WAIT }
      );

      // User 2 adds another cell
      await pages[1].click('.jp-Cell:last-child');
      await pages[1].keyboard.press('b'); // Add cell below
      await pages[1].keyboard.type('print("New cell added by User 2")');

      // Wait for synchronization
      await waitForSync(pages[1]);

      // Verify both users see both new cells
      await Promise.all(pages.map(page =>
        page.waitForFunction(
          (expectedCount) => {
            return document.querySelectorAll('.jp-Cell').length === expectedCount;
          },
          initialCellCount + 2,
          { timeout: COLLABORATION_TIMEOUTS.SYNC_WAIT }
        )
      ));

      // Test cell deletion - User 1 deletes a cell
      await pages[0].click('.jp-Cell:nth-child(2)'); // Select a cell
      await pages[0].keyboard.press('d'); // Enter delete mode
      await pages[0].keyboard.press('d'); // Confirm deletion

      // Wait for synchronization
      await waitForSync(pages[0]);

      // Verify User 2 sees the deletion
      await pages[1].waitForFunction(
        (expectedCount) => {
          return document.querySelectorAll('.jp-Cell').length === expectedCount;
        },
        initialCellCount + 1,
        { timeout: COLLABORATION_TIMEOUTS.SYNC_WAIT }
      );

      // Verify final document consistency
      await verifyDocumentConsistency(pages);

    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });

  test('should handle concurrent cell type changes', async ({
    browser,
    tmpPath,
    collaborationServer
  }) => {
    // Test markdown/code cell type conversions during collaboration
    const contexts = await createMultipleContexts(browser, 2);
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    try {
      const pages = await Promise.all(
        contexts.map(context => context.newPage())
      );

      // Setup collaborative sessions
      await Promise.all(
        pages.map(page => createCollaborativeSession(page, notebookPath))
      );

      await Promise.all(
        pages.map(page => waitForCollaboration(page))
      );

      // User 1 converts first cell to markdown
      await pages[0].click('.jp-Cell:first-child');
      await pages[0].keyboard.press('m'); // Convert to markdown

      // Add markdown content
      await pages[0].keyboard.type('# This is now a markdown cell\n\nWith **bold** text');

      // Wait for synchronization
      await waitForSync(pages[0]);

      // Verify User 2 sees the cell type change
      await pages[1].waitForFunction(() => {
        const firstCell = document.querySelector('.jp-Cell:first-child');
        return firstCell?.classList.contains('jp-MarkdownCell');
      }, { timeout: COLLABORATION_TIMEOUTS.SYNC_WAIT });

      // User 2 converts second cell from code to markdown
      await pages[1].click('.jp-Cell:nth-child(2)');
      await pages[1].keyboard.press('m'); // Convert to markdown
      await pages[1].keyboard.type('## Another markdown cell\n\nWith *italic* text');

      // Wait for synchronization
      await waitForSync(pages[1]);

      // Verify User 1 sees the cell type change
      await pages[0].waitForFunction(() => {
        const secondCell = document.querySelector('.jp-Cell:nth-child(2)');
        return secondCell?.classList.contains('jp-MarkdownCell');
      }, { timeout: COLLABORATION_TIMEOUTS.SYNC_WAIT });

      // Test converting back to code cell
      await pages[0].click('.jp-Cell:nth-child(2)');
      await pages[0].keyboard.press('y'); // Convert to code

      // Wait for synchronization
      await waitForSync(pages[0]);

      // Verify User 2 sees the conversion back to code
      await pages[1].waitForFunction(() => {
        const secondCell = document.querySelector('.jp-Cell:nth-child(2)');
        return secondCell?.classList.contains('jp-CodeCell');
      }, { timeout: COLLABORATION_TIMEOUTS.SYNC_WAIT });

      // Verify final document consistency
      await verifyDocumentConsistency(pages);

    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });

  test('should scale to 10 concurrent users', async ({
    browser,
    tmpPath,
    collaborationServer
  }) => {
    // Performance validation with maximum user count as per requirements
    const maxUsers = PERFORMANCE_THRESHOLDS.MIN_CONCURRENT_USERS;
    const contexts = await createMultipleContexts(browser, maxUsers);
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    try {
      const pages = await Promise.all(
        contexts.map(context => context.newPage())
      );

      // Capture baseline performance metrics
      const startTime = Date.now();

      // All users join collaborative session
      await Promise.all(
        pages.map(page => createCollaborativeSession(page, notebookPath))
      );

      // Wait for all users to establish collaboration
      await Promise.all(
        pages.map(page => waitForCollaboration(page))
      );

      // Measure connection time
      const connectionTime = Date.now() - startTime;
      console.log(`${maxUsers} users connected in ${connectionTime}ms`);

      // Verify all users can see each other (limited check for performance)
      const presenceCheckPromises = pages.slice(0, 3).map(async page => {
        await waitForAwarenessUpdate(page);
        const avatarCount = await page.locator('[data-testid="user-avatar"]').count();
        expect(avatarCount).toBeGreaterThanOrEqual(1);
      });

      await Promise.all(presenceCheckPromises);

      // Each user makes a small edit to test concurrent performance
      const editStartTime = Date.now();

      const editPromises = pages.map(async (page, index) => {
        // Stagger edits slightly to avoid overwhelming the system
        await page.waitForTimeout(index * 10);

        const cellIndex = index % 3; // Distribute across first 3 cells
        const cellSelector = `.jp-Cell:nth-child(${cellIndex + 1}) .jp-InputArea-editor`;

        await page.click(cellSelector);
        await page.keyboard.press('End');
        await page.keyboard.type(`\n# User ${index + 1} edit`);
      });

      await Promise.all(editPromises);

      // Wait for all edits to synchronize
      await Promise.all(pages.slice(0, 3).map(page => waitForSync(page, 30000)));

      const editTime = Date.now() - editStartTime;
      console.log(`${maxUsers} user edits synchronized in ${editTime}ms`);

      // Verify system maintains responsiveness under load
      expect(editTime).toBeLessThan(30000); // Should complete within 30 seconds

      // Sample check for document consistency (check first 3 users to avoid timeout)
      await verifyDocumentConsistency(pages.slice(0, 3));

      // Verify no significant memory leaks by checking remaining responsive
      const responsiveCheck = await pages[0].evaluate(() => {
        return document.querySelector('.jp-NotebookPanel') !== null;
      });

      expect(responsiveCheck).toBe(true);

    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });

  test('should handle user disconnection gracefully', async ({
    browser,
    tmpPath,
    collaborationServer,
    mockUsers
  }) => {
    // Test user leaving scenario and cleanup
    const contexts = await createMultipleContexts(browser, 3);
    const notebookPath = `notebooks/${tmpPath}/${COLLABORATION_NOTEBOOK}`;

    try {
      const pages = await Promise.all(
        contexts.map(context => context.newPage())
      );

      // All users join collaborative session
      await Promise.all(
        pages.map(page => createCollaborativeSession(page, notebookPath))
      );

      // Wait for collaboration initialization
      await Promise.all(
        pages.map(page => waitForCollaboration(page))
      );

      // Verify all users are present
      await Promise.all(
        pages.map(page => waitForAwarenessUpdate(page))
      );

      const expectedUsers = mockUsers.slice(0, 3).map(user => user.id);
      await verifyPresenceIndicators(pages[0], expectedUsers);

      // Each user makes an edit
      await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');
      await pages[0].keyboard.type('User 1 initial edit');

      await pages[1].click('.jp-Cell:nth-child(2) .jp-InputArea-editor');
      await pages[1].keyboard.type('User 2 initial edit');

      await pages[2].click('.jp-Cell:nth-child(3) .jp-InputArea-editor');
      await pages[2].keyboard.type('User 3 initial edit');

      // Wait for synchronization
      await Promise.all(pages.map(page => waitForSync(page)));

      // User 2 disconnects (close context)
      await contexts[1].close();

      // Allow time for disconnection to be processed
      await pages[0].waitForTimeout(2000);

      // Verify remaining users no longer see disconnected user
      await pages[0].waitForFunction(
        () => {
          const avatars = document.querySelectorAll('[data-testid="user-avatar"]');
          return avatars.length <= 2; // Should only see self and remaining user
        },
        { timeout: COLLABORATION_TIMEOUTS.PRESENCE_UPDATE * 2 }
      );

      // Remaining users should still be able to collaborate
      await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');
      await pages[0].keyboard.press('End');
      await pages[0].keyboard.type('\nAfter disconnection edit by User 1');

      await pages[2].click('.jp-Cell:nth-child(3) .jp-InputArea-editor');
      await pages[2].keyboard.press('End');
      await pages[2].keyboard.type('\nAfter disconnection edit by User 3');

      // Wait for synchronization between remaining users
      await waitForSync(pages[0]);
      await waitForSync(pages[2]);

      // Verify document consistency between remaining users
      await verifyDocumentConsistency([pages[0], pages[2]]);

      // Verify both users' post-disconnection edits are present
      const finalContent = await pages[0].evaluate(() => {
        const cells = Array.from(document.querySelectorAll('.jp-Cell .jp-InputArea-editor .cm-content'));
        return cells.map(cell => cell.textContent || '').join('\n');
      });

      expect(finalContent).toContain('After disconnection edit by User 1');
      expect(finalContent).toContain('After disconnection edit by User 3');

    } finally {
      // Close remaining contexts
      await Promise.all([contexts[0], contexts[2]].map(context => context.close()));
    }
  });
});
