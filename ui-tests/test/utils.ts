import { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { Page, BrowserContext, Browser } from '@playwright/test';

/**
 * Run the selected cell and advance.
 */
export async function runAndAdvance(
  page: IJupyterLabPageFixture | Page
): Promise<void> {
  await page.keyboard.press('Shift+Enter');
}

/**
 * Wait for the kernel to be ready
 */
export async function waitForKernelReady(page: Page): Promise<void> {
  await page.waitForSelector('.jp-NotebookKernelStatus-fade');
  await page.waitForFunction(() => {
    const status = window.document.getElementsByClassName(
      'jp-NotebookKernelStatus'
    )[0];

    if (!status) {
      return false;
    }

    const finished = status?.getAnimations().reduce((prev, curr) => {
      return prev && curr.playState === 'finished';
    }, true);
    return finished;
  });
  const viewport = page.viewportSize();
  const width = viewport?.width;
  if (width && width > 600) {
    await page.waitForSelector('.jp-DebuggerBugButton[aria-disabled="false"]');
  }
}

/**
 * Special case for firefox headless issue
 * See https://github.com/jupyter/notebook/pull/6872#issuecomment-1549594166 for more details
 */
export async function hideAddCellButton(page: Page): Promise<void> {
  await page
    .locator('.jp-Notebook-footer')
    .evaluate((element) => (element.style.display = 'none'));
}

/**
 * Wait for the notebook to be ready
 */
export async function waitForNotebook(
  page: Page,
  browserName = ''
): Promise<void> {
  // wait for the kernel status animations to be finished
  await waitForKernelReady(page);
  await page.waitForSelector(
    ".jp-Notebook-ExecutionIndicator[data-status='idle']"
  );

  const checkpointLocator = '.jp-NotebookCheckpoint';
  // wait for the checkpoint indicator to be displayed
  await page.waitForSelector(checkpointLocator);

  // remove the amount of seconds manually since it might display strings such as "3 seconds ago"
  await page
    .locator(checkpointLocator)
    .evaluate(
      (element) => (element.innerHTML = 'Last Checkpoint: 3 seconds ago')
    );

  // special case for firefox headless issue
  // see https://github.com/jupyter/notebook/pull/6872#issuecomment-1549594166 for more details
  if (browserName === 'firefox') {
    await hideAddCellButton(page);
  }
}

/**
 * Wait for collaboration WebSocket connection and readiness
 */
export async function waitForCollaboration(page: any): Promise<void> {

  // Wait for collaboration indicators to be present
  await page.waitForSelector('[data-testid="collaboration-status"]', { timeout: 10000 });

  // Wait for WebSocket connection to be established
  await page.waitForFunction(() => {
    const statusElement = document.querySelector('[data-testid="collaboration-status"]');
    return statusElement?.getAttribute('data-connected') === 'true';
  }, { timeout: 5000 });

  // Wait for collaboration provider to be ready
  await page.waitForFunction(() => {
    return (window as any).jupyterapp?.serviceManager?.collaboration?.isReady === true;
  }, { timeout: 5000 });

  // Allow extra time for full initialization
  await page.waitForTimeout(500);
}

/**
 * Create multiple browser contexts for simulating concurrent users
 */
export async function createMultipleContexts(browser: Browser, count: number): Promise<BrowserContext[]> {
  const contexts: BrowserContext[] = [];

  for (let i = 0; i < count; i++) {
    const context = await browser.newContext({
      // Create isolated contexts with different user agents to simulate different users
      userAgent: `TestUser${i + 1}Browser/1.0`,
      // Each context gets its own storage, cookies, etc.
      storageState: undefined,
      // Unique viewport to help distinguish users
      viewport: { width: 1280, height: 720 }
    });

    // Add context identification for debugging
    await context.addInitScript(`
      window.__testUserId = 'user${i + 1}';
      window.__testUserIndex = ${i};
    `);

    contexts.push(context);
  }

  return contexts;
}

/**
 * Wait for document synchronization across clients
 */
export async function waitForSync(page: Page, timeout: number = 10000): Promise<void> {
  const startTime = Date.now();

  // Wait for sync indicator to show synchronization complete
  try {
    await page.waitForFunction(() => {
      const syncIndicator = document.querySelector('[data-testid="sync-status"]');
      return syncIndicator?.getAttribute('data-synced') === 'true';
    }, { timeout });
  } catch (error) {
    // If no sync indicator, wait for collaborative provider to be synced
    await page.waitForFunction(() => {
      const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
      return collaboration?.provider?.isSynced === true;
    }, { timeout: Math.max(0, timeout - (Date.now() - startTime)) });
  }

  // Additional wait to ensure all UI updates are complete
  await page.waitForTimeout(200);
}

/**
 * Simulate concurrent editing operations for conflict resolution testing
 */
export async function simulateConcurrentEdits(
  pages: Page[],
  cellIndex: number,
  contents: string[]
): Promise<void> {
  if (pages.length !== contents.length) {
    throw new Error('Number of pages must match number of content strings');
  }

  // Focus the target cell in all pages simultaneously
  const focusPromises = pages.map(async (page, index) => {
    const cellSelector = `.jp-Cell:nth-child(${cellIndex + 1}) .jp-InputArea-editor`;
    await page.click(cellSelector);
    await page.waitForSelector(`${cellSelector}.jp-mod-focused`);
  });

  await Promise.all(focusPromises);

  // Allow a brief moment for focus to stabilize
  await new Promise(resolve => setTimeout(resolve, 100));

  // Perform concurrent edits
  const editPromises = pages.map(async (page, index) => {
    const content = contents[index];

    // Clear existing content and type new content
    await page.keyboard.press('Control+a');
    await page.keyboard.type(content);
  });

  // Execute all edits simultaneously
  await Promise.all(editPromises);

  // Wait for all changes to sync
  const syncPromises = pages.map(page => waitForSync(page, 5000));
  await Promise.all(syncPromises);
}

/**
 * Verify user presence indicators are visible and correct
 */
export async function verifyPresenceIndicators(page: Page, expectedUsers: string[]): Promise<void> {
  // Wait for presence bar to be visible
  await page.waitForSelector('[data-testid="user-presence-bar"]', { timeout: 5000 });

  // Verify expected users are shown
  for (const userId of expectedUsers) {
    const userIndicator = `[data-testid="user-avatar"][data-user-id="${userId}"]`;
    await page.waitForSelector(userIndicator, { timeout: 3000 });

    // Verify avatar is visible
    const avatarElement = await page.locator(userIndicator);
    const isVisible = await avatarElement.isVisible();
    if (!isVisible) {
      throw new Error(`User avatar for ${userId} is not visible`);
    }
  }

  // Verify correct number of users are displayed
  const avatarCount = await page.locator('[data-testid="user-avatar"]').count();
  if (avatarCount !== expectedUsers.length) {
    throw new Error(`Expected ${expectedUsers.length} users, but found ${avatarCount}`);
  }
}

/**
 * Check if a specific cell is locked for editing
 */
export async function checkCellLock(page: Page, cellIndex: number): Promise<boolean> {
  const cellSelector = `.jp-Cell:nth-child(${cellIndex + 1})`;

  // Wait for cell to be present
  await page.waitForSelector(cellSelector);

  // Check for lock indicator
  const lockIndicator = await page.locator(`${cellSelector} [data-testid="cell-lock-indicator"]`);
  const isLocked = await lockIndicator.count() > 0;

  if (isLocked) {
    // Verify lock is visible and has correct state
    const isVisible = await lockIndicator.isVisible();
    if (!isVisible) {
      throw new Error(`Lock indicator for cell ${cellIndex} is not visible`);
    }
    const lockState = await lockIndicator.getAttribute('data-locked');
    return lockState === 'true';
  }

  // Also check if cell has locked class
  const cellElement = await page.locator(cellSelector);
  const hasLockedClass = await cellElement.evaluate(el => el.classList.contains('jp-mod-locked'));

  return hasLockedClass;
}

/**
 * Measure synchronization latency between two pages
 */
export async function measureSyncLatency(page1: Page, page2: Page): Promise<number> {
  const testText = `sync-test-${Date.now()}`;
  const cellIndex = 0; // Test on first cell

  // Focus first cell on page1
  const cellSelector = `.jp-Cell:nth-child(${cellIndex + 1}) .jp-InputArea-editor`;
  await page1.click(cellSelector);
  await page1.waitForSelector(`${cellSelector}.jp-mod-focused`);

  // Record start time and make edit
  const startTime = Date.now();
  await page1.keyboard.type(testText);

  // Wait for the change to appear on page2
  await page2.waitForFunction(
    (text) => {
      const cellEditor = document.querySelector('.jp-Cell:nth-child(1) .jp-InputArea-editor .cm-content');
      return cellEditor?.textContent?.includes(text) === true;
    },
    testText,
    { timeout: 10000 }
  );

  const endTime = Date.now();
  const latency = endTime - startTime;

  // Clean up test text
  await page1.keyboard.press('Control+a');
  await page1.keyboard.press('Backspace');
  await waitForSync(page1);

  return latency;
}

/**
 * Create a collaborative notebook session
 */
export async function createCollaborativeSession(page: Page, notebookPath: string): Promise<void> {
  // Navigate to the notebook with collaboration enabled
  const collaborativeUrl = `${notebookPath}?collaborative=true`;
  await page.goto(collaborativeUrl);

  // Wait for notebook to load
  await waitForNotebook(page);

  // Wait for collaboration features to initialize
  await waitForCollaboration(page);

  // Verify collaboration is active
  const isCollaborative = await page.evaluate(() => {
    const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
    return collaboration?.isActive === true;
  });

  if (!isCollaborative) {
    throw new Error('Failed to initialize collaborative session');
  }
}

/**
 * Verify document consistency across multiple pages
 */
export async function verifyDocumentConsistency(pages: Page[]): Promise<void> {
  if (pages.length < 2) {
    throw new Error('Need at least 2 pages to verify consistency');
  }

  // Get notebook content from first page as reference
  const referenceContent = await pages[0].evaluate(() => {
    const cells = Array.from(document.querySelectorAll('.jp-Cell'));
    return cells.map(cell => {
      const cellType = cell.classList.contains('jp-CodeCell') ? 'code' : 'markdown';
      const editor = cell.querySelector('.jp-InputArea-editor .cm-content');
      const source = editor?.textContent || '';
      return { cellType, source };
    });
  });

  // Compare all other pages against reference
  for (let i = 1; i < pages.length; i++) {
    const pageContent = await pages[i].evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.jp-Cell'));
      return cells.map(cell => {
        const cellType = cell.classList.contains('jp-CodeCell') ? 'code' : 'markdown';
        const editor = cell.querySelector('.jp-InputArea-editor .cm-content');
        const source = editor?.textContent || '';
        return { cellType, source };
      });
    });

    // Verify same number of cells
    if (referenceContent.length !== pageContent.length) {
      throw new Error(`Page ${i} has ${pageContent.length} cells, expected ${referenceContent.length}`);
    }

    // Verify each cell matches
    for (let cellIndex = 0; cellIndex < referenceContent.length; cellIndex++) {
      const refCell = referenceContent[cellIndex];
      const pageCell = pageContent[cellIndex];

      if (refCell.cellType !== pageCell.cellType) {
        throw new Error(`Cell ${cellIndex} type mismatch on page ${i}: expected ${refCell.cellType}, got ${pageCell.cellType}`);
      }

      if (refCell.source !== pageCell.source) {
        throw new Error(`Cell ${cellIndex} content mismatch on page ${i}:\nExpected: "${refCell.source}"\nActual: "${pageCell.source}"`);
      }
    }
  }
}

/**
 * Wait for user presence/awareness updates
 */
export async function waitForAwarenessUpdate(page: Page): Promise<void> {
  // Wait for awareness system to be ready
  await page.waitForFunction(() => {
    const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
    return collaboration?.awareness != null;
  }, { timeout: 5000 });

  // Wait for awareness to have at least one user (self)
  await page.waitForFunction(() => {
    const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
    const awareness = collaboration?.awareness;
    return awareness?.getStates().size >= 1;
  }, { timeout: 3000 });

  // Wait for presence UI to reflect awareness state
  await page.waitForSelector('[data-testid="user-presence-bar"]', { timeout: 2000 });

  // Allow time for all awareness updates to propagate
  await page.waitForTimeout(500);
}
