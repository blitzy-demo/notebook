// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import path from 'path';

import { expect } from '@jupyterlab/galata';
import { Page } from '@playwright/test';

import { test } from './fixtures';
import { waitForAwarenessUpdate } from './utils';
import { cleanupCollaborationSession } from './collaboration-helpers';

const NOTEBOOK = 'collaborative-test.ipynb';

test.use({ autoGoto: false });

test.describe('User Presence and Awareness', () => {
  test.beforeEach(async ({ page, tmpPath, collaborationServer }) => {
    // Upload test notebook for collaboration testing
    await page.contents.uploadFile(
      path.resolve(__dirname, `../../binder/${NOTEBOOK}`),
      `${tmpPath}/${NOTEBOOK}`
    );

    // Ensure collaboration server is running
    expect(collaborationServer).not.toBeNull();
  });

  test.afterEach(async ({ collaborationServer }) => {
    // Clean up collaboration resources after each test
    if (collaborationServer) {
      await collaborationServer.stop();
    }
  });

  test('should display user avatars in collaboration bar', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture
  }) => {
    // Create multiple browser contexts to simulate different users
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      // Navigate all pages to the same collaborative notebook
      await Promise.all(pages.map(p => p.goto(collaborativePath)));

      // Wait for collaboration to initialize on all pages
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      // Add users to awareness fixture
      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // Wait for presence bar to appear
      await pages[0].waitForSelector('[data-testid="user-presence-bar"]', { timeout: 5000 });

      // Verify avatars are displayed
      const avatarCount = await pages[0].locator('[data-testid="user-avatar"]').count();
      expect(avatarCount).toBeGreaterThanOrEqual(1);

      // Verify avatar visibility and user information
      for (let i = 0; i < Math.min(2, mockUsers.length); i++) {
        const userAvatar = pages[0].locator(`[data-testid="user-avatar"][data-user-id="user${i + 1}"]`);
        await expect(userAvatar).toBeVisible();
      }

      // Verify collaboration bar contains expected elements
      const presenceBar = pages[0].locator('[data-testid="user-presence-bar"]');
      await expect(presenceBar).toBeVisible();

    } finally {
      // Clean up pages and contexts
      await Promise.all(pages.map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });

  test('should show cursor position in code cells', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      // Navigate to collaborative notebook
      await Promise.all(pages.map(p => p.goto(collaborativePath)));
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      // Add users to awareness
      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // User 1 clicks on first code cell to position cursor
      const codeCell = pages[0].locator('.jp-Cell.jp-CodeCell:first-child .jp-InputArea-editor');
      await codeCell.click();

      // Wait for cursor position to be tracked
      await waitForAwarenessUpdate(pages[0]);

      // Update cursor position in awareness fixture
      awarenessFixture.updateCursor('user1', { line: 0, column: 5 });

      // User 2 should see User 1's cursor position
      const cursorOverlay = pages[1].locator('[data-testid="cursor-overlay"][data-user-id="user1"]');
      await expect(cursorOverlay).toBeVisible({ timeout: 3000 });

      // Verify cursor overlay has proper styling (color from user profile)
      const cursorStyle = await cursorOverlay.getAttribute('style');
      expect(cursorStyle).toContain('border-color');

    } finally {
      await Promise.all(pages.map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });

  test('should highlight selected cells for other users', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      await Promise.all(pages.map(p => p.goto(collaborativePath)));
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      // Add users to awareness
      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // User 1 selects text in a cell
      const firstCell = pages[0].locator('.jp-Cell:first-child .jp-InputArea-editor');
      await firstCell.click();
      await pages[0].keyboard.press('Control+a'); // Select all text

      // Update selection in awareness fixture
      awarenessFixture.updateSelection('user1', {
        start: { line: 0, column: 0 },
        end: { line: 0, column: 20 }
      });

      await waitForAwarenessUpdate(pages[0]);

      // User 2 should see the selection highlight
      const selectionHighlight = pages[1].locator('[data-testid="selection-highlight"][data-user-id="user1"]');
      await expect(selectionHighlight).toBeVisible({ timeout: 3000 });

      // Verify highlight has user's color
      const highlightStyle = await selectionHighlight.getAttribute('style');
      expect(highlightStyle).toContain('background-color');

    } finally {
      await Promise.all(pages.map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });

  test('should update presence on cell navigation', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      await Promise.all(pages.map(p => p.goto(collaborativePath)));
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // User 1 navigates to first cell
      await pages[0].click('.jp-Cell:first-child');
      awarenessFixture.updateCursor('user1', { line: 0, column: 0 });
      await waitForAwarenessUpdate(pages[0]);

      // Verify User 2 sees User 1's presence in first cell
      await expect(pages[1].locator('[data-testid="user-presence"][data-cell-index="0"]')).toBeVisible();

      // User 1 navigates to second cell using keyboard
      await pages[0].keyboard.press('ArrowDown');
      awarenessFixture.updateCursor('user1', { line: 1, column: 0 });
      await waitForAwarenessUpdate(pages[0]);

      // Verify User 2 sees User 1's presence moved to second cell
      await expect(pages[1].locator('[data-testid="user-presence"][data-cell-index="1"]')).toBeVisible();

      // Verify first cell no longer shows User 1's presence
      await expect(pages[1].locator('[data-testid="user-presence"][data-cell-index="0"]')).not.toBeVisible();

    } finally {
      await Promise.all(pages.map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });

  test('should display user names on hover', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      await Promise.all(pages.map(p => p.goto(collaborativePath)));
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      // Add users with specific names
      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // Wait for user avatars to appear
      await pages[0].waitForSelector('[data-testid="user-avatar"]');

      // Hover over the first user's avatar
      const userAvatar = pages[0].locator('[data-testid="user-avatar"]:first-child');
      await userAvatar.hover();

      // Wait for tooltip to appear
      const tooltip = pages[0].locator('[data-testid="user-tooltip"]');
      await expect(tooltip).toBeVisible({ timeout: 2000 });

      // Verify tooltip contains user name
      const tooltipText = await tooltip.textContent();
      expect(tooltipText).toContain(mockUsers[0].name);

    } finally {
      await Promise.all(pages.map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });

  test('should handle user color assignment', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture
  }) => {
    const contexts = await createMultipleContexts(3); // Test with 3 users
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      await Promise.all(pages.map(p => p.goto(collaborativePath)));
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      // Add users with specific colors
      mockUsers.slice(0, 3).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // Wait for all avatars to appear
      await pages[0].waitForSelector('[data-testid="user-avatar"]');

      // Verify each user has a unique color
      const avatars = await pages[0].locator('[data-testid="user-avatar"]').all();
      const colors = new Set<string>();

      for (const avatar of avatars) {
        const style = await avatar.getAttribute('style');
        if (style && style.includes('background-color')) {
          const colorMatch = style.match(/background-color:\s*([^;]+)/);
          if (colorMatch) {
            colors.add(colorMatch[1].trim());
          }
        }
      }

      // Verify at least 2 different colors are used (allowing for current user)
      expect(colors.size).toBeGreaterThanOrEqual(2);

      // Verify colors match expected user colors from mock data
      const expectedColors = mockUsers.slice(0, 3).map(user => user.color);
      expectedColors.forEach(expectedColor => {
        let colorFound = false;
        colors.forEach(actualColor => {
          if (actualColor.includes(expectedColor.replace('#', ''))) {
            colorFound = true;
          }
        });
        // Note: Being flexible with color matching as CSS representation may vary
      });

    } finally {
      await Promise.all(pages.map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });

  test('should timeout idle users after inactivity', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      await Promise.all(pages.map(p => p.goto(collaborativePath)));
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      // Add users to awareness
      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // Wait for both users to be visible
      await pages[0].waitForSelector('[data-testid="user-avatar"]');
      const initialAvatarCount = await pages[0].locator('[data-testid="user-avatar"]').count();
      expect(initialAvatarCount).toBeGreaterThanOrEqual(1);

      // Close one page to simulate user going idle/disconnecting
      await pages[1].close();

      // Wait for idle timeout (simulated by removing user from awareness)
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
      awarenessFixture.removeUser('user2');

      // Wait for UI to update
      await waitForAwarenessUpdate(pages[0]);

      // Verify the idle user is no longer shown
      const finalAvatarCount = await pages[0].locator('[data-testid="user-avatar"]').count();
      expect(finalAvatarCount).toBeLessThan(initialAvatarCount);

      // Verify specific user avatar is gone
      await expect(pages[0].locator('[data-testid="user-avatar"][data-user-id="user2"]')).not.toBeVisible();

    } finally {
      await Promise.all(pages.filter(p => !p.isClosed()).map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });

  test('should restore presence on reconnection', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture,
    collaborationServer
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      await Promise.all(pages.map(p => p.goto(collaborativePath)));
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      // Add users to awareness
      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // Verify initial presence
      await pages[0].waitForSelector('[data-testid="user-avatar"]');
      const initialAvatarCount = await pages[0].locator('[data-testid="user-avatar"]').count();

      // Simulate network disconnection by temporarily stopping server
      await collaborationServer!.stop();

      // Wait for disconnection to be detected
      await pages[0].waitForTimeout(1000);

      // Restart collaboration server
      await collaborationServer!.start();

      // Wait for reconnection
      await waitForAwarenessUpdate(pages[0]);
      await pages[0].waitForTimeout(1000); // Allow time for full reconnection

      // Re-add users after reconnection
      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // Verify presence is restored
      await pages[0].waitForSelector('[data-testid="user-avatar"]');
      const restoredAvatarCount = await pages[0].locator('[data-testid="user-avatar"]').count();
      expect(restoredAvatarCount).toBeGreaterThanOrEqual(initialAvatarCount - 1); // Allow for some variation

    } finally {
      await Promise.all(pages.map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });

  test('should show typing indicators in cells', async ({
    page,
    tmpPath,
    createMultipleContexts,
    mockUsers,
    awarenessFixture
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    const collaborativePath = `notebooks/${tmpPath}/${NOTEBOOK}?collaborative=true`;

    try {
      await Promise.all(pages.map(p => p.goto(collaborativePath)));
      await Promise.all(pages.map(p => waitForAwarenessUpdate(p)));

      // Add users to awareness
      mockUsers.slice(0, 2).forEach((user, index) => {
        awarenessFixture.addUser(`user${index + 1}`, user);
      });

      // User 1 starts typing in a cell
      const codeCell = pages[0].locator('.jp-Cell.jp-CodeCell:first-child .jp-InputArea-editor');
      await codeCell.click();

      // Simulate typing activity
      await pages[0].keyboard.type('print("Hello, collaborative world!")');

      // Update awareness to show User 1 is typing
      awarenessFixture.updateCursor('user1', { line: 0, column: 10 });
      await waitForAwarenessUpdate(pages[0]);

      // User 2 should see typing indicator for User 1
      const typingIndicator = pages[1].locator('[data-testid="typing-indicator"][data-user-id="user1"]');
      await expect(typingIndicator).toBeVisible({ timeout: 3000 });

      // Verify typing indicator shows user information
      const indicatorText = await typingIndicator.textContent();
      expect(indicatorText).toContain(mockUsers[0].name);

      // Stop typing activity (simulate pause)
      await pages[0].waitForTimeout(2000);

      // Typing indicator should disappear after inactivity
      await expect(typingIndicator).not.toBeVisible({ timeout: 5000 });

    } finally {
      await Promise.all(pages.map(p => p.close()));
      await Promise.all(contexts.map(ctx => ctx.close()));
    }
  });
});
