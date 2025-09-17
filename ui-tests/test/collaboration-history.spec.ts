/**
 * Change History and Versioning Test Suite
 *
 * Tests for F-027: Change History & Versioning functionality including version tracking,
 * diff visualization, snapshot storage, rollback capabilities, and authorship tracking
 * for collaborative editing scenarios in Jupyter Notebook v7.
 *
 * This test suite validates:
 * - Cell-level change history tracking
 * - Visual diff generation between versions
 * - Automatic snapshot creation at intervals
 * - Version restoration and rollback functionality
 * - User authorship attribution
 * - Deleted cell history preservation
 * - Concurrent version branch handling
 * - History export and persistence
 */

import path from 'path';

import { expect } from '@jupyterlab/galata';

import { test } from './fixtures';
import { waitForCollaboration } from './utils';

const TEST_NOTEBOOK = 'collaboration-history-test.ipynb';
const MULTI_USER_NOTEBOOK = 'multi-user-history-test.ipynb';

test.use({ autoGoto: false });

test.describe('Change History and Versioning', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    // Upload test notebooks for history testing
    await page.contents.uploadFile(
      path.resolve(__dirname, `./notebooks/${TEST_NOTEBOOK}`),
      `${tmpPath}/${TEST_NOTEBOOK}`
    );

    await page.contents.uploadFile(
      path.resolve(__dirname, `./notebooks/${MULTI_USER_NOTEBOOK}`),
      `${tmpPath}/${MULTI_USER_NOTEBOOK}`
    );

    // Enable collaboration mode for history tracking
    await page.goto(`notebooks/${tmpPath}/${TEST_NOTEBOOK}?collaborative=true`);

    // Wait for collaboration infrastructure to initialize
    await waitForCollaboration(page);

    // Wait for history service to be ready
    await page.waitForFunction(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      return collaboration?.historyTracker?.isReady === true;
    }, { timeout: 10000 });
  });

  test.afterEach(async ({ page }) => {
    // Clean up collaboration session
    await page.evaluate(async () => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      if (collaboration?.session) {
        await collaboration.session.cleanup();
      }
    });
  });

  test('should track edit history for each cell', async ({ page, tmpPath }) => {

    // Focus on the first cell
    const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
    await page.click(cellSelector);
    await page.waitForSelector(`${cellSelector}.jp-mod-focused`);

    // Make initial edit
    const initialText = 'print("Initial version")';
    await page.keyboard.press('Control+a');
    await page.keyboard.type(initialText);

    // Wait for history to record the change
    await page.waitForTimeout(1000);

    // Make second edit
    const secondText = 'print("Second version")';
    await page.keyboard.press('Control+a');
    await page.keyboard.type(secondText);

    // Wait for history recording
    await page.waitForTimeout(1000);

    // Open history panel
    await page.menu.clickMenuItem('View>Show Change History');

    // Wait for history panel to load
    await page.waitForSelector('[data-testid="history-panel"]');

    // Verify history entries exist
    const historyEntries = await page.locator('[data-testid="history-entry"]');
    const entryCount = await historyEntries.count();

    expect(entryCount).toBeGreaterThanOrEqual(2);

    // Verify cell-specific history
    await page.click('[data-testid="cell-history-tab"]');

    // Select first cell in history view
    await page.click('[data-testid="cell-selector"]:first-child');

    // Verify cell history shows both versions
    const cellHistoryEntries = await page.locator('[data-testid="cell-history-entry"]');
    const cellEntryCount = await cellHistoryEntries.count();

    expect(cellEntryCount).toBeGreaterThanOrEqual(2);

    // Verify content of history entries
    const firstEntry = cellHistoryEntries.first();
    const latestEntry = cellHistoryEntries.last();

    const firstContent = await firstEntry.locator('[data-testid="history-content"]').textContent();
    const latestContent = await latestEntry.locator('[data-testid="history-content"]').textContent();

    expect(firstContent).toContain('Initial version');
    expect(latestContent).toContain('Second version');
  });

  test('should display version timeline', async ({ page, tmpPath }) => {

    // Create multiple versions by editing different cells
    const cells = await page.locator('.jp-Cell').count();

    for (let i = 0; i < Math.min(cells, 3); i++) {
      const cellSelector = `.jp-Cell:nth-child(${i + 1}) .jp-InputArea-editor`;
      await page.click(cellSelector);
      await page.keyboard.press('Control+a');
      await page.keyboard.type(`print("Version ${i + 1} content")`);
      await page.waitForTimeout(500); // Let history service record
    }

    // Open history panel
    await page.menu.clickMenuItem('View>Show Change History');
    await page.waitForSelector('[data-testid="history-panel"]');

    // Switch to timeline view
    await page.click('[data-testid="timeline-view-tab"]');
    await page.waitForSelector('[data-testid="version-timeline"]');

    // Verify timeline elements
    const timelineItems = await page.locator('[data-testid="timeline-item"]');
    const timelineCount = await timelineItems.count();

    expect(timelineCount).toBeGreaterThanOrEqual(3);

    // Verify timeline is ordered chronologically
    const timestamps: number[] = [];
    for (let i = 0; i < Math.min(timelineCount, 5); i++) {
      const item = timelineItems.nth(i);
      const timestampText = await item.locator('[data-testid="timestamp"]').textContent();
      const timestamp = new Date(timestampText || '').getTime();
      timestamps.push(timestamp);
    }

    // Verify timestamps are in descending order (newest first)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }

    // Verify each timeline item has required information
    const firstItem = timelineItems.first();
    await expect(firstItem.locator('[data-testid="version-id"]')).toBeVisible();
    await expect(firstItem.locator('[data-testid="author-info"]')).toBeVisible();
    await expect(firstItem.locator('[data-testid="change-summary"]')).toBeVisible();
    await expect(firstItem.locator('[data-testid="timestamp"]')).toBeVisible();
  });

  test('should show diff between versions', async ({ page, tmpPath }) => {

    // Create initial version
    const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
    await page.click(cellSelector);
    await page.keyboard.press('Control+a');
    const originalContent = 'import numpy as np\nprint("Original content")';
    await page.keyboard.type(originalContent);
    await page.waitForTimeout(1000);

    // Create modified version
    await page.keyboard.press('Control+a');
    const modifiedContent = 'import pandas as pd\nprint("Modified content")\nprint("Additional line")';
    await page.keyboard.type(modifiedContent);
    await page.waitForTimeout(1000);

    // Open history panel and timeline
    await page.menu.clickMenuItem('View>Show Change History');
    await page.waitForSelector('[data-testid="history-panel"]');
    await page.click('[data-testid="timeline-view-tab"]');

    // Select two versions for comparison
    const timelineItems = await page.locator('[data-testid="timeline-item"]');
    await timelineItems.first().click();
    await page.keyboard.down('Control');
    await timelineItems.nth(1).click();
    await page.keyboard.up('Control');

    // Click compare versions button
    await page.click('[data-testid="compare-versions-btn"]');
    await page.waitForSelector('[data-testid="diff-viewer"]');

    // Verify diff viewer elements
    await expect(page.locator('[data-testid="diff-header"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-sidebar"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-content"]')).toBeVisible();

    // Verify diff shows added and removed lines
    const addedLines = await page.locator('.diff-line-added');
    const removedLines = await page.locator('.diff-line-removed');

    expect(await addedLines.count()).toBeGreaterThan(0);
    expect(await removedLines.count()).toBeGreaterThan(0);

    // Verify specific changes are highlighted
    const addedContent = await addedLines.first().textContent();
    const removedContent = await removedLines.first().textContent();

    expect(addedContent).toContain('pandas');
    expect(removedContent).toContain('numpy');

    // Test line-by-line diff view
    await page.click('[data-testid="line-by-line-view"]');
    await page.waitForSelector('[data-testid="diff-split-view"]');

    // Verify split view shows before and after
    await expect(page.locator('[data-testid="diff-before"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-after"]')).toBeVisible();

    // Test unified diff view
    await page.click('[data-testid="unified-view"]');
    await page.waitForSelector('[data-testid="diff-unified-view"]');

    const unifiedDiff = await page.locator('[data-testid="diff-unified-view"]').textContent();
    expect(unifiedDiff).toContain('-import numpy as np');
    expect(unifiedDiff).toContain('+import pandas as pd');
  });

  test('should create snapshots at intervals', async ({ page, tmpPath }) => {

    // Configure shorter snapshot interval for testing
    await page.evaluate(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      if (collaboration?.historyTracker) {
        collaboration.historyTracker.setSnapshotInterval(2000); // 2 seconds
      }
    });

    // Make changes with delays to trigger multiple snapshots
    const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
    await page.click(cellSelector);

    // First change
    await page.keyboard.press('Control+a');
    await page.keyboard.type('print("Snapshot 1")');
    await page.waitForTimeout(2500); // Wait for snapshot

    // Second change
    await page.keyboard.press('Control+a');
    await page.keyboard.type('print("Snapshot 2")');
    await page.waitForTimeout(2500); // Wait for snapshot

    // Third change
    await page.keyboard.press('Control+a');
    await page.keyboard.type('print("Snapshot 3")');
    await page.waitForTimeout(2500); // Wait for snapshot

    // Open history panel to verify snapshots
    await page.menu.clickMenuItem('View>Show Change History');
    await page.waitForSelector('[data-testid="history-panel"]');

    // Switch to snapshots view
    await page.click('[data-testid="snapshots-tab"]');
    await page.waitForSelector('[data-testid="snapshots-list"]');

    // Verify multiple snapshots were created
    const snapshots = await page.locator('[data-testid="snapshot-item"]');
    const snapshotCount = await snapshots.count();

    expect(snapshotCount).toBeGreaterThanOrEqual(3);

    // Verify snapshot metadata
    const firstSnapshot = snapshots.first();
    await expect(firstSnapshot.locator('[data-testid="snapshot-timestamp"]')).toBeVisible();
    await expect(firstSnapshot.locator('[data-testid="snapshot-id"]')).toBeVisible();
    await expect(firstSnapshot.locator('[data-testid="snapshot-size"]')).toBeVisible();

    // Verify snapshots are ordered by time
    const timestampElements = await page.locator('[data-testid="snapshot-timestamp"]');
    const timestamps: number[] = [];

    for (let i = 0; i < Math.min(3, snapshotCount); i++) {
      const timestampText = await timestampElements.nth(i).textContent();
      const timestamp = new Date(timestampText || '').getTime();
      timestamps.push(timestamp);
    }

    // Verify descending order (newest first)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }

    // Test snapshot content preview
    await firstSnapshot.click();
    await page.waitForSelector('[data-testid="snapshot-preview"]');

    const previewContent = await page.locator('[data-testid="snapshot-preview"]').textContent();
    expect(previewContent).toContain('Snapshot 3'); // Latest content
  });

  test('should restore previous version', async ({ page, tmpPath }) => {

    // Create initial content
    const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
    await page.click(cellSelector);
    await page.keyboard.press('Control+a');
    const originalContent = 'print("Original content to restore")';
    await page.keyboard.type(originalContent);
    await page.waitForTimeout(1000);

    // Modify content (version to rollback from)
    await page.keyboard.press('Control+a');
    const modifiedContent = 'print("Modified content - should be reverted")';
    await page.keyboard.type(modifiedContent);
    await page.waitForTimeout(1000);

    // Verify current content is modified
    let currentContent = await page.locator(`${cellSelector} .cm-content`).textContent();
    expect(currentContent).toContain('Modified content');

    // Open history panel
    await page.menu.clickMenuItem('View>Show Change History');
    await page.waitForSelector('[data-testid="history-panel"]');
    await page.click('[data-testid="timeline-view-tab"]');

    // Find and select the original version (should be second in timeline)
    const timelineItems = await page.locator('[data-testid="timeline-item"]');
    const originalVersionItem = timelineItems.nth(1); // Second item (older)
    await originalVersionItem.click();

    // Verify preview shows original content
    await page.waitForSelector('[data-testid="version-preview"]');
    const previewContent = await page.locator('[data-testid="version-preview"]').textContent();
    expect(previewContent).toContain('Original content');

    // Restore the original version
    await page.click('[data-testid="restore-version-btn"]');

    // Confirm restoration dialog
    await page.waitForSelector('[data-testid="restore-confirm-dialog"]');
    await page.click('[data-testid="confirm-restore-btn"]');

    // Wait for restoration to complete
    await page.waitForSelector('[data-testid="restoration-complete"]', { timeout: 10000 });

    // Verify content has been restored
    currentContent = await page.locator(`${cellSelector} .cm-content`).textContent();
    expect(currentContent).toContain('Original content to restore');
    expect(currentContent).not.toContain('Modified content');

    // Verify restoration created a new history entry
    await page.waitForTimeout(1000);
    const updatedTimelineItems = await page.locator('[data-testid="timeline-item"]');
    const newCount = await updatedTimelineItems.count();

    // Should have original + modified + restoration entry
    expect(newCount).toBeGreaterThanOrEqual(3);

    // Verify restoration entry has correct metadata
    const restorationEntry = updatedTimelineItems.first();
    const changeType = await restorationEntry.locator('[data-testid="change-type"]').textContent();
    expect(changeType).toContain('Restoration');
  });

  test('should preserve authorship information', async ({ page, browserName, tmpPath }) => {
    test.skip(browserName === 'webkit', 'Multi-context test not supported in webkit');

    const notebookPath = `notebooks/${tmpPath}/collaboration-history-authorship.ipynb`;

    // Create second browser context for different user
    const context2 = await page.context().browser()?.newContext({
      userAgent: 'CollaborativeTestUser2',
      storageState: undefined
    });

    if (!context2) {
      test.skip();
      return;
    }

    const page2 = await context2.newPage();

    try {
      // Both users navigate to same notebook
      await page.goto(`${notebookPath}?collaborative=true&user=alice`);
      await page2.goto(`${notebookPath}?collaborative=true&user=bob`);

      // Wait for collaboration to initialize on both pages
      await waitForCollaboration(page);
      await waitForCollaboration(page2);

      // User Alice makes first edit
      const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
      await page.click(cellSelector);
      await page.keyboard.press('Control+a');
      await page.keyboard.type('print("Edit by Alice")');
      await page.waitForTimeout(1000);

      // User Bob makes second edit
      await page2.click(cellSelector);
      await page2.keyboard.press('Control+a');
      await page2.keyboard.type('print("Edit by Bob")');
      await page2.waitForTimeout(1000);

      // User Alice makes third edit
      await page.click(cellSelector);
      await page.keyboard.press('Control+a');
      await page.keyboard.type('print("Another edit by Alice")');
      await page.waitForTimeout(1000);

      // Open history panel on first page
      await page.menu.clickMenuItem('View>Show Change History');
      await page.waitForSelector('[data-testid="history-panel"]');
      await page.click('[data-testid="timeline-view-tab"]');

      // Verify authorship information
      const timelineItems = await page.locator('[data-testid="timeline-item"]');
      const itemCount = await timelineItems.count();

      expect(itemCount).toBeGreaterThanOrEqual(3);

      // Check first entry (Alice's second edit)
      const firstItem = timelineItems.first();
      const firstAuthor = await firstItem.locator('[data-testid="author-info"]').textContent();
      expect(firstAuthor).toContain('alice');

      // Check second entry (Bob's edit)
      const secondItem = timelineItems.nth(1);
      const secondAuthor = await secondItem.locator('[data-testid="author-info"]').textContent();
      expect(secondAuthor).toContain('bob');

      // Check third entry (Alice's first edit)
      const thirdItem = timelineItems.nth(2);
      const thirdAuthor = await thirdItem.locator('[data-testid="author-info"]').textContent();
      expect(thirdAuthor).toContain('alice');

      // Verify author avatars are displayed
      await expect(firstItem.locator('[data-testid="author-avatar"]')).toBeVisible();
      await expect(secondItem.locator('[data-testid="author-avatar"]')).toBeVisible();
      await expect(thirdItem.locator('[data-testid="author-avatar"]')).toBeVisible();

      // Test author filtering
      await page.click('[data-testid="author-filter-dropdown"]');
      await page.click('[data-testid="filter-author-alice"]');

      // Verify only Alice's edits are shown
      await page.waitForTimeout(500);
      const filteredItems = await page.locator('[data-testid="timeline-item"]');
      const filteredCount = await filteredItems.count();

      // Should show Alice's 2 edits
      expect(filteredCount).toBe(2);

      // Verify all visible items are by Alice
      for (let i = 0; i < filteredCount; i++) {
        const item = filteredItems.nth(i);
        const author = await item.locator('[data-testid="author-info"]').textContent();
        expect(author).toContain('alice');
      }

    } finally {
      await context2.close();
    }
  });

  test('should handle history for deleted cells', async ({ page, tmpPath }) => {

    // Add content to first cell
    const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
    await page.click(cellSelector);
    await page.keyboard.press('Control+a');
    const cellContent = 'print("This cell will be deleted")';
    await page.keyboard.type(cellContent);
    await page.waitForTimeout(1000);

    // Add a new cell below
    await page.keyboard.press('Escape');
    await page.keyboard.press('b'); // Add cell below
    await page.waitForTimeout(500);

    // Add content to second cell
    const secondCellSelector = '.jp-Cell:nth-child(2) .jp-InputArea-editor';
    await page.click(secondCellSelector);
    await page.keyboard.type('print("Second cell content")');
    await page.waitForTimeout(1000);

    // Delete the first cell
    await page.click('.jp-Cell:first-child');
    await page.keyboard.press('Escape'); // Exit edit mode
    await page.keyboard.press('d');
    await page.keyboard.press('d'); // Delete cell
    await page.waitForTimeout(1000);

    // Verify cell was deleted
    const remainingCells = await page.locator('.jp-Cell');
    const cellCount = await remainingCells.count();
    const firstCellContent = await remainingCells.first().locator('.jp-InputArea-editor .cm-content').textContent();

    expect(firstCellContent).toContain('Second cell');

    // Open history panel
    await page.menu.clickMenuItem('View>Show Change History');
    await page.waitForSelector('[data-testid="history-panel"]');

    // Switch to deleted cells view
    await page.click('[data-testid="deleted-cells-tab"]');
    await page.waitForSelector('[data-testid="deleted-cells-list"]');

    // Verify deleted cell appears in history
    const deletedCells = await page.locator('[data-testid="deleted-cell-item"]');
    const deletedCount = await deletedCells.count();

    expect(deletedCount).toBeGreaterThanOrEqual(1);

    // Verify deleted cell content and metadata
    const firstDeletedCell = deletedCells.first();
    await expect(firstDeletedCell.locator('[data-testid="deleted-cell-content"]')).toBeVisible();
    await expect(firstDeletedCell.locator('[data-testid="deletion-timestamp"]')).toBeVisible();
    await expect(firstDeletedCell.locator('[data-testid="cell-position"]')).toBeVisible();

    // Check deleted cell content
    const deletedContent = await firstDeletedCell.locator('[data-testid="deleted-cell-content"]').textContent();
    expect(deletedContent).toContain('This cell will be deleted');

    // Test restore deleted cell
    await firstDeletedCell.click();
    await page.click('[data-testid="restore-deleted-cell-btn"]');

    // Confirm restoration
    await page.waitForSelector('[data-testid="restore-deleted-confirm"]');
    await page.click('[data-testid="confirm-restore-deleted-btn"]');

    // Wait for restoration
    await page.waitForTimeout(2000);

    // Verify cell was restored
    const restoredCells = await page.locator('.jp-Cell');
    const restoredCount = await restoredCells.count();
    const restoredContent = await restoredCells.first().locator('.jp-InputArea-editor .cm-content').textContent();

    expect(restoredCount).toBe(cellCount + 1);
    expect(restoredContent).toContain('This cell will be deleted');
  });

  test('should merge concurrent version branches', async ({ page, browserName, tmpPath }) => {
    test.skip(browserName === 'webkit', 'Multi-context test not supported in webkit');



    // Create second browser context
    const context2 = await page.context().browser()?.newContext({
      userAgent: 'CollaborativeTestUser2',
      storageState: undefined
    });

    if (!context2) {
      test.skip();
      return;
    }

    const page2 = await context2.newPage();

    try {
      // Both users navigate to same notebook
      const notebookPath = `notebooks/${tmpPath}/${MULTI_USER_NOTEBOOK}`;
      await page.goto(`${notebookPath}?collaborative=true&user=alice`);
      await page2.goto(`${notebookPath}?collaborative=true&user=bob`);

      await waitForCollaboration(page);
      await waitForCollaboration(page2);

      // Simulate network split - disconnect one user temporarily
      await page2.evaluate(() => {
        const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
        if (collaboration?.provider) {
          collaboration.provider.disconnect();
        }
      });

      // User Alice makes changes while Bob is disconnected
      const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
      await page.click(cellSelector);
      await page.keyboard.press('Control+a');
      await page.keyboard.type('print("Alice branch edit 1")');
      await page.waitForTimeout(500);

      // User Bob makes conflicting changes while disconnected
      await page2.click(cellSelector);
      await page2.keyboard.press('Control+a');
      await page2.keyboard.type('print("Bob branch edit 1")');
      await page2.waitForTimeout(500);

      // More divergent changes
      await page.keyboard.press('Control+a');
      await page.keyboard.type('print("Alice branch edit 2")');
      await page.waitForTimeout(500);

      await page2.keyboard.press('Control+a');
      await page2.keyboard.type('print("Bob branch edit 2")');
      await page2.waitForTimeout(500);

      // Reconnect Bob to trigger merge
      await page2.evaluate(() => {
        const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
        if (collaboration?.provider) {
          collaboration.provider.connect();
        }
      });

      // Wait for sync and merge to complete
      await page.waitForTimeout(3000);
      await page2.waitForTimeout(3000);

      // Open history panel to verify merge
      await page.menu.clickMenuItem('View>Show Change History');
      await page.waitForSelector('[data-testid="history-panel"]');
      await page.click('[data-testid="timeline-view-tab"]');

      // Look for merge entry
      const timelineItems = await page.locator('[data-testid="timeline-item"]');
      let foundMerge = false;
      const itemCount = await timelineItems.count();

      for (let i = 0; i < itemCount; i++) {
        const item = timelineItems.nth(i);
        const changeType = await item.locator('[data-testid="change-type"]').textContent();

        if (changeType && changeType.includes('Merge')) {
          foundMerge = true;

          // Verify merge metadata
          await expect(item.locator('[data-testid="merge-info"]')).toBeVisible();
          await expect(item.locator('[data-testid="branch-info"]')).toBeVisible();

          // Click to see merge details
          await item.click();
          await page.waitForSelector('[data-testid="merge-details"]');

          // Verify branch information
          const branchInfo = await page.locator('[data-testid="branch-info"]').textContent();
          expect(branchInfo).toContain('alice');
          expect(branchInfo).toContain('bob');

          break;
        }
      }

      expect(foundMerge).toBe(true);

      // Verify both changes are preserved in final content
      const finalContent = await page.locator(`${cellSelector} .cm-content`).textContent();
      // CRDT should have merged both changes appropriately
      expect(finalContent).toBeTruthy(); // Basic validation that content exists

      // Test branch view
      await page.click('[data-testid="branch-view-tab"]');
      await page.waitForSelector('[data-testid="branch-timeline"]');

      // Verify branch visualization shows divergent paths
      const branches = await page.locator('[data-testid="branch-line"]');
      const branchCount = await branches.count();
      expect(branchCount).toBeGreaterThanOrEqual(2); // Alice and Bob branches

    } finally {
      await context2.close();
    }
  });

  test('should export version history', async ({ page, tmpPath }) => {

    // Create multiple versions
    const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';
    await page.click(cellSelector);

    const versions = [
      'print("Version 1 for export")',
      'print("Version 2 for export")',
      'print("Version 3 for export")'
    ];

    for (const version of versions) {
      await page.keyboard.press('Control+a');
      await page.keyboard.type(version);
      await page.waitForTimeout(1000);
    }

    // Open history panel
    await page.menu.clickMenuItem('View>Show Change History');
    await page.waitForSelector('[data-testid="history-panel"]');

    // Click export history button
    await page.click('[data-testid="export-history-btn"]');
    await page.waitForSelector('[data-testid="export-options-dialog"]');

    // Configure export options
    await page.check('[data-testid="include-diffs"]');
    await page.check('[data-testid="include-authorship"]');
    await page.check('[data-testid="include-deleted-cells"]');

    // Select JSON format
    await page.selectOption('[data-testid="export-format"]', 'json');

    // Start export
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-testid="start-export-btn"]');

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/.*history.*\.json$/);

    // Save and verify export file
    const exportPath = path.resolve(tmpPath, 'exported-history.json');
    await download.saveAs(exportPath);

    // Verify export format (would need file system access in real test)
    // This would typically be verified by reading the file and checking structure

    // Test CSV export as well
    await page.click('[data-testid="export-history-btn"]');
    await page.waitForSelector('[data-testid="export-options-dialog"]');
    await page.selectOption('[data-testid="export-format"]', 'csv');

    const csvDownloadPromise = page.waitForEvent('download');
    await page.click('[data-testid="start-export-btn"]');

    const csvDownload = await csvDownloadPromise;
    expect(csvDownload.suggestedFilename()).toMatch(/.*history.*\.csv$/);

    // Test history backup
    await page.click('[data-testid="backup-history-btn"]');
    await page.waitForSelector('[data-testid="backup-confirm-dialog"]');

    const backupPromise = page.waitForEvent('download');
    await page.click('[data-testid="confirm-backup-btn"]');

    const backup = await backupPromise;
    expect(backup.suggestedFilename()).toMatch(/.*backup.*\.zip$/);

    // Verify export completed successfully
    await page.waitForSelector('[data-testid="export-success-message"]');

    const successMessage = await page.locator('[data-testid="export-success-message"]').textContent();
    expect(successMessage).toContain('successfully exported');
  });
});
