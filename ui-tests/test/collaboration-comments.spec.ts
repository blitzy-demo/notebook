// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect } from '@jupyterlab/galata';

import { test } from './fixtures';
import { createCollaborativeSession } from './utils';

/**
 * Test suite for Comment and Review System in collaborative notebooks
 *
 * Validates inline comments, threaded discussions, notifications, and
 * comment resolution workflows across multiple collaborative users
 */
test.describe('Comment and Review System', () => {
  const TEST_NOTEBOOK = 'collaboration-comments-test.ipynb';

  test.use({ autoGoto: false });

  test.beforeEach(async ({
    page,
    tmpPath,
    collaborationServer,
    waitForCollaboration,
    mockUsers
  }) => {
    // Create test notebook with sample content for commenting
    const notebookContent = {
      cells: [
        {
          cell_type: 'markdown',
          metadata: {},
          source: [
            '# Comment System Test Notebook\n',
            '\n',
            'This notebook is used for testing comment and review functionality.'
          ]
        },
        {
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: [
            '# Sample code cell for commenting\n',
            'import numpy as np\n',
            'data = np.array([1, 2, 3, 4, 5])\n',
            'print("Data shape:", data.shape)'
          ]
        },
        {
          cell_type: 'markdown',
          metadata: {},
          source: [
            '## Analysis Section\n',
            '\n',
            'This section contains analysis that may need review comments.'
          ]
        }
      ],
      metadata: {
        kernelspec: {
          display_name: 'Python 3',
          language: 'python',
          name: 'python3'
        }
      },
      nbformat: 4,
      nbformat_minor: 4
    };

    // Upload test notebook
    await page.contents.uploadContent(
      JSON.stringify(notebookContent, null, 2),
      'text',
      `${tmpPath}/${TEST_NOTEBOOK}`
    );

    // Ensure collaboration server is running
    if (collaborationServer) {
      const isReady = await waitForCollaboration(5000);
      expect(isReady).toBe(true);
    }
  });

  test('should add inline comment to cell', async ({
    page,
    tmpPath,
    collaborationEnabled,
    mockUsers
  }) => {
    // Navigate to collaborative notebook
    await createCollaborativeSession(page, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

    // Wait for notebook to be ready
    await page.waitForSelector('.jp-Notebook-cell', { timeout: 10000 });

    // Select the first code cell for commenting
    const codeCell = page.locator('.jp-Cell').nth(1); // Second cell (index 1) is code
    await codeCell.click();

    // Right-click to open context menu
    await codeCell.click({ button: 'right' });

    // Click "Add Comment" menu item
    await page.waitForSelector('.jp-Menu .jp-MenuItem:has-text("Add Comment")', { timeout: 5000 });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

    // Comment dialog should appear
    await page.waitForSelector('[data-testid="comment-dialog"]', { timeout: 5000 });

    // Enter comment text
    const commentText = 'This code could benefit from better error handling.';
    await page.fill('[data-testid="comment-input"]', commentText);

    // Submit comment
    await page.click('[data-testid="comment-submit"]');

    // Verify comment was added successfully
    await page.waitForSelector('[data-testid="comment-indicator"]', { timeout: 3000 });

    // Verify comment indicator appears on the cell
    const commentIndicator = codeCell.locator('[data-testid="comment-indicator"]');
    await expect(commentIndicator).toBeVisible();

    // Click comment indicator to view comment
    await commentIndicator.click();

    // Verify comment content is displayed
    await page.waitForSelector('[data-testid="comment-thread"]', { timeout: 3000 });
    const commentThread = page.locator('[data-testid="comment-thread"]');
    await expect(commentThread).toContainText(commentText);
  });

  test('should display comment indicators', async ({
    page,
    tmpPath,
    mockUsers
  }) => {
    await createCollaborativeSession(page, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

    // Add comment to first cell
    const firstCell = page.locator('.jp-Cell').first();
    await firstCell.click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

    await page.waitForSelector('[data-testid="comment-dialog"]');
    await page.fill('[data-testid="comment-input"]', 'Comment on first cell');
    await page.click('[data-testid="comment-submit"]');

    // Add comment to third cell
    const thirdCell = page.locator('.jp-Cell').nth(2);
    await thirdCell.click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

    await page.waitForSelector('[data-testid="comment-dialog"]');
    await page.fill('[data-testid="comment-input"]', 'Comment on third cell');
    await page.click('[data-testid="comment-submit"]');

    // Verify comment indicators are visible on both cells
    const firstCellIndicator = firstCell.locator('[data-testid="comment-indicator"]');
    const thirdCellIndicator = thirdCell.locator('[data-testid="comment-indicator"]');

    await expect(firstCellIndicator).toBeVisible();
    await expect(thirdCellIndicator).toBeVisible();

    // Verify indicators have correct styling/appearance
    const firstIndicatorColor = await firstCellIndicator.evaluate(el =>
      getComputedStyle(el).backgroundColor
    );
    expect(firstIndicatorColor).toBeTruthy(); // Should have background color

    // Verify hover behavior
    await firstCellIndicator.hover();
    await page.waitForSelector('[data-testid="comment-preview"]', { timeout: 2000 });
    const preview = page.locator('[data-testid="comment-preview"]');
    await expect(preview).toContainText('Comment on first cell');
  });

  test('should support threaded replies', async ({
    page,
    tmpPath,
    mockUsers,
    createMultipleContexts,
    browser
  }) => {
    // Create multiple browser contexts for different users
    const contexts = await createMultipleContexts(2);
    const page1 = await contexts[0].newPage();
    const page2 = await contexts[1].newPage();

    try {
      // User 1 navigates to notebook and adds initial comment
      await createCollaborativeSession(page1, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);
      await page1.waitForSelector('.jp-Cell');

      const cell = page1.locator('.jp-Cell').first();
      await cell.click({ button: 'right' });
      await page1.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

      await page1.waitForSelector('[data-testid="comment-dialog"]');
      await page1.fill('[data-testid="comment-input"]', 'Initial comment from User 1');
      await page1.click('[data-testid="comment-submit"]');

      // User 2 navigates to same notebook
      await createCollaborativeSession(page2, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);
      await page2.waitForSelector('.jp-Cell');

      // User 2 should see User 1's comment indicator
      const cellPage2 = page2.locator('.jp-Cell').first();
      await page2.waitForSelector('[data-testid="comment-indicator"]', { timeout: 5000 });

      // User 2 clicks comment indicator to view and reply
      await cellPage2.locator('[data-testid="comment-indicator"]').click();
      await page2.waitForSelector('[data-testid="comment-thread"]');

      // User 2 adds a reply
      await page2.click('[data-testid="reply-button"]');
      await page2.waitForSelector('[data-testid="reply-input"]');
      await page2.fill('[data-testid="reply-input"]', 'Reply from User 2');
      await page2.click('[data-testid="reply-submit"]');

      // Verify threaded structure
      await page2.waitForSelector('[data-testid="comment-replies"]');
      const replies = page2.locator('[data-testid="comment-replies"]');
      await expect(replies).toContainText('Reply from User 2');

      // User 1 should see the reply
      await page1.reload();
      await page1.waitForSelector('.jp-Cell');
      await page1.locator('[data-testid="comment-indicator"]').click();
      await page1.waitForSelector('[data-testid="comment-thread"]');

      const page1Replies = page1.locator('[data-testid="comment-replies"]');
      await expect(page1Replies).toContainText('Reply from User 2');

      // Verify thread count indicator
      const threadCount = page1.locator('[data-testid="comment-indicator"] [data-testid="thread-count"]');
      await expect(threadCount).toContainText('2'); // Original comment + 1 reply

    } finally {
      await page1.close();
      await page2.close();
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  test('should send notifications for new comments', async ({
    page,
    tmpPath,
    mockUsers,
    createMultipleContexts,
    browser
  }) => {
    const contexts = await createMultipleContexts(2);
    const page1 = await contexts[0].newPage();
    const page2 = await contexts[1].newPage();

    try {
      // Both users navigate to the same notebook
      await createCollaborativeSession(page1, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);
      await createCollaborativeSession(page2, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

      // User 2 adds a comment while User 1 is viewing the notebook
      const cell = page2.locator('.jp-Cell').first();
      await cell.click({ button: 'right' });
      await page2.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

      await page2.waitForSelector('[data-testid="comment-dialog"]');
      await page2.fill('[data-testid="comment-input"]', 'New comment notification test');
      await page2.click('[data-testid="comment-submit"]');

      // User 1 should receive a notification
      await page1.waitForSelector('[data-testid="notification-toast"]', { timeout: 5000 });
      const notification = page1.locator('[data-testid="notification-toast"]');
      await expect(notification).toContainText('New comment added');
      await expect(notification).toContainText('User 2'); // Should show who added the comment

      // Clicking notification should navigate to the comment
      await notification.click();
      await page1.waitForSelector('[data-testid="comment-thread"]', { timeout: 3000 });
      const commentThread = page1.locator('[data-testid="comment-thread"]');
      await expect(commentThread).toContainText('New comment notification test');

    } finally {
      await page1.close();
      await page2.close();
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  test('should track comment resolution status', async ({
    page,
    tmpPath,
    mockUsers
  }) => {
    await createCollaborativeSession(page, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

    // Add a comment
    const cell = page.locator('.jp-Cell').first();
    await cell.click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

    await page.waitForSelector('[data-testid="comment-dialog"]');
    await page.fill('[data-testid="comment-input"]', 'This needs to be resolved');
    await page.click('[data-testid="comment-submit"]');

    // Open comment thread
    await page.waitForSelector('[data-testid="comment-indicator"]');
    await cell.locator('[data-testid="comment-indicator"]').click();
    await page.waitForSelector('[data-testid="comment-thread"]');

    // Initially comment should be unresolved
    const resolveButton = page.locator('[data-testid="resolve-comment"]');
    await expect(resolveButton).toBeVisible();
    await expect(resolveButton).toContainText('Resolve');

    // Comment indicator should show unresolved status
    const indicator = cell.locator('[data-testid="comment-indicator"]');
    const unresolvedClass = await indicator.getAttribute('class');
    expect(unresolvedClass).toContain('unresolved');

    // Resolve the comment
    await resolveButton.click();

    // Verify resolution status changed
    await page.waitForSelector('[data-testid="resolved-badge"]', { timeout: 3000 });
    const resolvedBadge = page.locator('[data-testid="resolved-badge"]');
    await expect(resolvedBadge).toContainText('Resolved');

    // Comment indicator should show resolved status
    const resolvedClass = await indicator.getAttribute('class');
    expect(resolvedClass).toContain('resolved');

    // Should be able to unresolve
    await page.click('[data-testid="unresolve-comment"]');
    await expect(resolveButton).toBeVisible();
    const againUnresolvedClass = await indicator.getAttribute('class');
    expect(againUnresolvedClass).toContain('unresolved');
  });

  test('should preserve comments across sessions', async ({
    page,
    tmpPath,
    mockUsers
  }) => {
    // First session: add comments
    await createCollaborativeSession(page, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

    // Add comment to first cell
    const firstCell = page.locator('.jp-Cell').first();
    await firstCell.click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');
    await page.waitForSelector('[data-testid="comment-dialog"]');
    await page.fill('[data-testid="comment-input"]', 'Persistent comment 1');
    await page.click('[data-testid="comment-submit"]');

    // Add comment to second cell
    const secondCell = page.locator('.jp-Cell').nth(1);
    await secondCell.click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');
    await page.waitForSelector('[data-testid="comment-dialog"]');
    await page.fill('[data-testid="comment-input"]', 'Persistent comment 2');
    await page.click('[data-testid="comment-submit"]');

    // Verify comments are present
    await expect(firstCell.locator('[data-testid="comment-indicator"]')).toBeVisible();
    await expect(secondCell.locator('[data-testid="comment-indicator"]')).toBeVisible();

    // Close and reopen notebook (simulate new session)
    await page.reload();
    await page.waitForSelector('.jp-Cell', { timeout: 10000 });

    // Verify comments are still present after reload
    await expect(firstCell.locator('[data-testid="comment-indicator"]')).toBeVisible();
    await expect(secondCell.locator('[data-testid="comment-indicator"]')).toBeVisible();

    // Verify comment content is preserved
    await firstCell.locator('[data-testid="comment-indicator"]').click();
    await page.waitForSelector('[data-testid="comment-thread"]');
    await expect(page.locator('[data-testid="comment-thread"]')).toContainText('Persistent comment 1');

    // Close comment and check second comment
    await page.keyboard.press('Escape');
    await secondCell.locator('[data-testid="comment-indicator"]').click();
    await page.waitForSelector('[data-testid="comment-thread"]');
    await expect(page.locator('[data-testid="comment-thread"]')).toContainText('Persistent comment 2');
  });

  test('should filter comments by status', async ({
    page,
    tmpPath,
    mockUsers
  }) => {
    await createCollaborativeSession(page, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

    // Add several comments with different resolutions
    const cells = page.locator('.jp-Cell');

    // Add unresolved comment
    await cells.nth(0).click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');
    await page.waitForSelector('[data-testid="comment-dialog"]');
    await page.fill('[data-testid="comment-input"]', 'Unresolved comment');
    await page.click('[data-testid="comment-submit"]');

    // Add resolved comment
    await cells.nth(1).click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');
    await page.waitForSelector('[data-testid="comment-dialog"]');
    await page.fill('[data-testid="comment-input"]', 'To be resolved comment');
    await page.click('[data-testid="comment-submit"]');

    // Resolve the second comment
    await cells.nth(1).locator('[data-testid="comment-indicator"]').click();
    await page.waitForSelector('[data-testid="comment-thread"]');
    await page.click('[data-testid="resolve-comment"]');
    await page.keyboard.press('Escape');

    // Add another unresolved comment
    await cells.nth(2).click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');
    await page.waitForSelector('[data-testid="comment-dialog"]');
    await page.fill('[data-testid="comment-input"]', 'Another unresolved comment');
    await page.click('[data-testid="comment-submit"]');

    // Open comments panel/sidebar
    await page.click('[data-testid="comments-panel-button"]');
    await page.waitForSelector('[data-testid="comments-panel"]');

    // By default, should show all comments (3 total)
    await expect(page.locator('[data-testid="comment-item"]')).toHaveCount(3);

    // Filter to show only unresolved comments
    await page.click('[data-testid="filter-unresolved"]');
    await expect(page.locator('[data-testid="comment-item"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="comment-item"]').first()).toContainText('Unresolved comment');
    await expect(page.locator('[data-testid="comment-item"]').last()).toContainText('Another unresolved comment');

    // Filter to show only resolved comments
    await page.click('[data-testid="filter-resolved"]');
    await expect(page.locator('[data-testid="comment-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="comment-item"]')).toContainText('To be resolved comment');

    // Reset filter to show all
    await page.click('[data-testid="filter-all"]');
    await expect(page.locator('[data-testid="comment-item"]')).toHaveCount(3);
  });

  test('should mention users in comments', async ({
    page,
    tmpPath,
    mockUsers,
    createMultipleContexts,
    browser
  }) => {
    const contexts = await createMultipleContexts(2);
    const page1 = await contexts[0].newPage();
    const page2 = await contexts[1].newPage();

    try {
      // Both users connect to notebook
      await createCollaborativeSession(page1, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);
      await createCollaborativeSession(page2, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

      // User 1 adds comment with mention
      const cell = page1.locator('.jp-Cell').first();
      await cell.click({ button: 'right' });
      await page1.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

      await page1.waitForSelector('[data-testid="comment-dialog"]');
      await page1.fill('[data-testid="comment-input"]', 'Hey @TestUser2, can you review this cell?');

      // Verify mention autocomplete appears
      await page1.waitForSelector('[data-testid="mention-autocomplete"]', { timeout: 3000 });
      const autocomplete = page1.locator('[data-testid="mention-autocomplete"]');
      await expect(autocomplete).toContainText('TestUser2');

      // Select the mention
      await page1.click('[data-testid="mention-option"]:has-text("TestUser2")');
      await page1.click('[data-testid="comment-submit"]');

      // User 2 should receive mention notification
      await page2.waitForSelector('[data-testid="mention-notification"]', { timeout: 5000 });
      const mentionNotification = page2.locator('[data-testid="mention-notification"]');
      await expect(mentionNotification).toContainText('You were mentioned');
      await expect(mentionNotification).toContainText('TestUser1');

      // Click notification to navigate to comment
      await mentionNotification.click();
      await page2.waitForSelector('[data-testid="comment-thread"]');

      // Verify mention is highlighted in comment
      const mentionHighlight = page2.locator('[data-testid="user-mention"]');
      await expect(mentionHighlight).toContainText('@TestUser2');
      await expect(mentionHighlight).toHaveClass(/mentioned/);

      // User 2 replies to the mention
      await page2.click('[data-testid="reply-button"]');
      await page2.waitForSelector('[data-testid="reply-input"]');
      await page2.fill('[data-testid="reply-input"]', '@TestUser1 looks good to me!');
      await page2.click('[data-testid="reply-submit"]');

      // User 1 should receive notification for the mention in reply
      await page1.waitForSelector('[data-testid="mention-notification"]', { timeout: 5000 });

    } finally {
      await page1.close();
      await page2.close();
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  test('should support comment editing and deletion', async ({
    page,
    tmpPath,
    mockUsers
  }) => {
    await createCollaborativeSession(page, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

    // Add a comment
    const cell = page.locator('.jp-Cell').first();
    await cell.click({ button: 'right' });
    await page.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

    await page.waitForSelector('[data-testid="comment-dialog"]');
    const originalComment = 'Original comment text';
    await page.fill('[data-testid="comment-input"]', originalComment);
    await page.click('[data-testid="comment-submit"]');

    // Open comment thread
    await page.waitForSelector('[data-testid="comment-indicator"]');
    await cell.locator('[data-testid="comment-indicator"]').click();
    await page.waitForSelector('[data-testid="comment-thread"]');

    // Verify original comment is displayed
    await expect(page.locator('[data-testid="comment-content"]')).toContainText(originalComment);

    // Edit the comment
    await page.hover('[data-testid="comment-content"]');
    await page.click('[data-testid="edit-comment"]');

    await page.waitForSelector('[data-testid="edit-comment-input"]');
    const editedComment = 'Edited comment text';
    await page.fill('[data-testid="edit-comment-input"]', editedComment);
    await page.click('[data-testid="save-edit"]');

    // Verify comment was updated
    await expect(page.locator('[data-testid="comment-content"]')).toContainText(editedComment);
    await expect(page.locator('[data-testid="comment-content"]')).not.toContainText(originalComment);

    // Verify edit indicator is shown
    await expect(page.locator('[data-testid="edited-indicator"]')).toContainText('edited');

    // Delete the comment
    await page.hover('[data-testid="comment-content"]');
    await page.click('[data-testid="delete-comment"]');

    // Confirm deletion dialog
    await page.waitForSelector('[data-testid="confirm-delete-dialog"]');
    await page.click('[data-testid="confirm-delete"]');

    // Comment thread should be removed
    await expect(page.locator('[data-testid="comment-thread"]')).toHaveCount(0);

    // Comment indicator should be removed from cell
    await expect(cell.locator('[data-testid="comment-indicator"]')).toHaveCount(0);
  });

  test('should integrate with review workflows', async ({
    page,
    tmpPath,
    mockUsers,
    createMultipleContexts,
    browser
  }) => {
    const contexts = await createMultipleContexts(2);
    const reviewerPage = await contexts[0].newPage();
    const authorPage = await contexts[1].newPage();

    try {
      // Author and reviewer both connect to notebook
      await createCollaborativeSession(authorPage, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);
      await createCollaborativeSession(reviewerPage, `notebooks/${tmpPath}/${TEST_NOTEBOOK}`);

      // Reviewer adds review comment requesting changes
      const cell = reviewerPage.locator('.jp-Cell').nth(1); // Code cell
      await cell.click({ button: 'right' });
      await reviewerPage.click('.jp-Menu .jp-MenuItem:has-text("Add Comment")');

      await reviewerPage.waitForSelector('[data-testid="comment-dialog"]');
      await reviewerPage.fill('[data-testid="comment-input"]', 'Please add error handling here');

      // Set comment type as "Change Request"
      await reviewerPage.selectOption('[data-testid="comment-type"]', 'change_request');
      await reviewerPage.click('[data-testid="comment-submit"]');

      // Author should see change request notification
      await authorPage.waitForSelector('[data-testid="review-notification"]', { timeout: 5000 });
      const reviewNotification = authorPage.locator('[data-testid="review-notification"]');
      await expect(reviewNotification).toContainText('Change requested');

      // Author addresses the comment by editing the cell
      await authorPage.click(cell);
      await authorPage.keyboard.press('Enter'); // Enter edit mode
      await authorPage.keyboard.type('\ntry:\n    # Added error handling\nexcept Exception as e:\n    print(f"Error: {e}")');
      await authorPage.keyboard.press('Shift+Enter'); // Run cell

      // Author responds to review comment
      await cell.locator('[data-testid="comment-indicator"]').click();
      await authorPage.waitForSelector('[data-testid="comment-thread"]');
      await authorPage.click('[data-testid="reply-button"]');
      await authorPage.waitForSelector('[data-testid="reply-input"]');
      await authorPage.fill('[data-testid="reply-input"]', 'Added error handling as requested');
      await authorPage.click('[data-testid="reply-submit"]');

      // Author marks change as complete
      await authorPage.click('[data-testid="mark-addressed"]');

      // Reviewer should see that change was addressed
      await reviewerPage.reload();
      await reviewerPage.waitForSelector('.jp-Cell');
      await cell.locator('[data-testid="comment-indicator"]').click();
      await reviewerPage.waitForSelector('[data-testid="comment-thread"]');

      const addressedBadge = reviewerPage.locator('[data-testid="addressed-badge"]');
      await expect(addressedBadge).toContainText('Addressed');

      // Reviewer can approve the changes
      await reviewerPage.click('[data-testid="approve-changes"]');
      await reviewerPage.waitForSelector('[data-testid="approval-badge"]');

      const approvalBadge = reviewerPage.locator('[data-testid="approval-badge"]');
      await expect(approvalBadge).toContainText('Approved');

      // Comment should now show as resolved in the workflow
      const resolvedWorkflowBadge = reviewerPage.locator('[data-testid="workflow-resolved"]');
      await expect(resolvedWorkflowBadge).toBeVisible();

      // Author should receive approval notification
      await authorPage.waitForSelector('[data-testid="approval-notification"]', { timeout: 5000 });
      const approvalNotification = authorPage.locator('[data-testid="approval-notification"]');
      await expect(approvalNotification).toContainText('Changes approved');

    } finally {
      await reviewerPage.close();
      await authorPage.close();
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  test.afterEach(async ({ page }) => {
    // Clean up any open dialogs or panels
    try {
      // Close comment dialogs
      await page.keyboard.press('Escape');

      // Close comments panel if open
      const commentsPanel = page.locator('[data-testid="comments-panel"]');
      if (await commentsPanel.isVisible()) {
        await page.click('[data-testid="close-comments-panel"]');
      }

      // Wait for cleanup to complete
      await page.waitForTimeout(500);
    } catch (error) {
      // Ignore cleanup errors
      console.log('Comment test cleanup completed with minor errors:', error);
    }
  });
});
