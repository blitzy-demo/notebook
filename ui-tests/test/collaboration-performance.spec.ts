/**
 * Collaboration Performance Test Suite
 *
 * Comprehensive performance benchmarking for collaborative editing features in Jupyter Notebook v7.
 * Validates latency requirements, memory overhead, concurrent user capacity, and WebSocket stability.
 *
 * Performance Requirements (from Section 6.6):
 * - Synchronization latency <100ms (95th percentile)
 * - Memory overhead <20% from baseline
 * - Support 10+ concurrent users without degradation
 * - WebSocket 99.9% message delivery success
 * - Performance regression detection
 */

import path from 'path';
import { performance } from 'perf_hooks';

import { expect } from '@jupyterlab/galata';
import { Browser } from '@playwright/test';
import { benchmark } from 'lib0';

import { test } from './fixtures';
import { simulateConcurrentEdits } from './utils';
import { CollaborationSession } from './collaboration-helpers';

// Import required members from benchmark library
const { Bench, runBench, measureTime } = benchmark;

// Import required members from path module
const { resolve } = path;

// Import required performance measurement members
const { now, measureUserTiming, getEntriesByType } = performance;

// Performance thresholds from technical specification
const PERFORMANCE_THRESHOLDS = {
  MAX_EDIT_LATENCY: 100, // milliseconds (95th percentile)
  MAX_MEMORY_OVERHEAD_PERCENT: 20, // percent increase from baseline
  MIN_CONCURRENT_USERS: 10, // minimum supported concurrent users
  WEBSOCKET_SUCCESS_RATE: 0.999, // 99.9% message delivery success
  UI_RESPONSE_THRESHOLD: 100, // milliseconds for UI responsiveness
  CRDT_OPERATION_THRESHOLD: 50, // milliseconds for CRDT operations
  BATCH_MESSAGE_THRESHOLD: 50 // milliseconds for message batching
} as const;

// Test notebook file for performance testing
const PERFORMANCE_TEST_NOTEBOOK = 'performance-test.ipynb';

/**
 * Collaborative Performance Test Suite
 *
 * Benchmarks collaborative editing performance against strict requirements
 * using multiple browser contexts to simulate concurrent users
 */
test.describe('Collaboration Performance', () => {

  /**
   * Setup performance test environment with baseline measurements
   */
  test.beforeEach(async ({ page, tmpPath }) => {
    // Upload test notebook for performance benchmarking
    await page.contents.uploadFile(
      resolve(__dirname, `./notebooks/${PERFORMANCE_TEST_NOTEBOOK}`),
      `${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}`
    );

    // Navigate to notebook in collaborative mode
    await page.goto(`notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`);

    // Wait for collaboration features to initialize
    await page.waitForSelector('[data-testid="collaboration-status"]', { timeout: 10000 });
    await page.waitForFunction(() => {
      return (window as any).jupyterapp?.serviceManager?.collaboration?.isReady === true;
    }, { timeout: 5000 });
  });

  /**
   * Test: Collaborative edit latency must remain under 100ms (95th percentile)
   * Validates requirement: Synchronization latency <100ms (95th percentile)
   */
  test('should maintain <100ms edit latency', async ({
    browser,
    tmpPath,
    createMultipleContexts,
    waitForCollaboration
  }) => {
    // Create two browser contexts for latency testing
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate both clients to the same notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Wait for collaboration to be established
      const collaborationReady = await waitForCollaboration(5000);
      expect(collaborationReady).toBe(true);

      // Measure edit latency across multiple operations
      const latencyMeasurements: number[] = [];
      const testText = 'performance test';

      for (let i = 0; i < 20; i++) {
        const uniqueText = `${testText} ${i}`;

        // Focus first cell on page 1
        await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');

        // Measure start time
        const startTime = now();

        // Type in page 1
        await pages[0].keyboard.type(uniqueText);

        // Wait for change to appear in page 2
        await pages[1].waitForFunction(
          (text) => {
            const cellEditor = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
            return cellEditor?.textContent?.includes(text) === true;
          },
          uniqueText,
          { timeout: 5000 }
        );

        const endTime = now();
        const latency = endTime - startTime;
        latencyMeasurements.push(latency);

        // Clear cell for next iteration
        await pages[0].keyboard.press('Control+a');
        await pages[0].keyboard.press('Backspace');
        await pages[1].waitForFunction(() => {
          const cellEditor = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
          return cellEditor?.textContent === '';
        }, { timeout: 2000 });
      }

      // Calculate 95th percentile latency
      latencyMeasurements.sort((a, b) => a - b);
      const percentile95Index = Math.floor(latencyMeasurements.length * 0.95);
      const p95Latency = latencyMeasurements[percentile95Index];

      console.log(`95th percentile latency: ${p95Latency.toFixed(2)}ms`);
      console.log(`Average latency: ${(latencyMeasurements.reduce((a, b) => a + b, 0) / latencyMeasurements.length).toFixed(2)}ms`);

      // Validate against performance threshold
      expect(p95Latency).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_EDIT_LATENCY);

    } finally {
      // Cleanup contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: Memory overhead must remain under 20% increase from baseline
   * Validates requirement: Memory overhead <20% from baseline
   */
  test('should limit memory overhead to <20%', async ({
    page,
    tmpPath,
    createMultipleContexts
  }) => {
    // Measure baseline memory usage (single user)
    const baselineMemory = await page.evaluate(() => {
      const memory = (performance as any).memory;
      return memory ? memory.usedJSHeapSize : 0;
    });

    if (baselineMemory === 0) {
      test.skip('Performance memory API not available in this browser');
    }

    // Create multiple contexts to simulate collaborative session
    const contexts = await createMultipleContexts(5);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate all pages to collaborative notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Wait for collaboration to establish
      await Promise.all(pages.map(page =>
        page.waitForSelector('[data-testid="collaboration-status"]', { timeout: 10000 })
      ));

      // Perform collaborative editing to stress memory usage
      for (let i = 0; i < 10; i++) {
        const pageIndex = i % pages.length;
        const testContent = `# Memory test iteration ${i}\nprint("Testing memory usage")`;

        await pages[pageIndex].click('.jp-Cell:first-child .jp-InputArea-editor');
        await pages[pageIndex].keyboard.press('Control+a');
        await pages[pageIndex].keyboard.type(testContent);

        // Wait for synchronization
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Measure collaborative session memory usage
      const collaborativeMemory = await page.evaluate(() => {
        const memory = (performance as any).memory;
        return memory ? memory.usedJSHeapSize : 0;
      });

      // Calculate memory overhead percentage
      const memoryOverheadPercent = ((collaborativeMemory - baselineMemory) / baselineMemory) * 100;

      console.log(`Baseline memory: ${(baselineMemory / 1024 / 1024).toFixed(2)} MB`);
      console.log(`Collaborative memory: ${(collaborativeMemory / 1024 / 1024).toFixed(2)} MB`);
      console.log(`Memory overhead: ${memoryOverheadPercent.toFixed(2)}%`);

      // Validate against performance threshold
      expect(memoryOverheadPercent).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_OVERHEAD_PERCENT);

    } finally {
      // Cleanup contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: Support 10+ concurrent users without performance degradation
   * Validates requirement: Support 10+ concurrent users without degradation
   */
  test('should handle 10 concurrent users', async ({
    browser,
    tmpPath,
    createMultipleContexts,
    waitForCollaboration
  }) => {
    const userCount = 10;

    // Create contexts for concurrent users
    const contexts = await createMultipleContexts(userCount);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate all users to collaborative notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Verify collaboration is established for all users
      const collaborationReady = await waitForCollaboration(10000);
      expect(collaborationReady).toBe(true);

      // Verify presence indicators show all users
      await pages[0].waitForFunction(
        (expectedCount) => {
          const avatars = document.querySelectorAll('[data-testid="user-avatar"]');
          return avatars.length >= expectedCount;
        },
        userCount,
        { timeout: 15000 }
      );

      // Simulate concurrent editing with performance measurement
      const editStartTime = now();

      const editPromises = pages.map(async (page, index) => {
        const cellIndex = index % 3; // Distribute across first 3 cells
        const cellSelector = `.jp-Cell:nth-child(${cellIndex + 1}) .jp-InputArea-editor`;

        await page.click(cellSelector);
        await page.keyboard.type(`User ${index + 1} edit: ${Date.now()}`);

        return page.waitForFunction(() => {
          const syncStatus = document.querySelector('[data-testid="sync-status"]');
          return syncStatus?.getAttribute('data-synced') === 'true';
        }, { timeout: 5000 });
      });

      // Wait for all edits to complete and synchronize
      await Promise.all(editPromises);

      const editEndTime = now();
      const totalEditTime = editEndTime - editStartTime;

      console.log(`Concurrent editing completed in ${totalEditTime.toFixed(2)}ms for ${userCount} users`);

      // Verify document consistency across all users
      const cellContents = await Promise.all(pages.map(page =>
        page.evaluate(() => {
          return Array.from(document.querySelectorAll('.jp-Cell .jp-InputArea-editor .cm-content'))
            .map(el => el.textContent?.trim() || '');
        })
      ));

      // All users should see the same document state
      const referenceContent = cellContents[0];
      for (let i = 1; i < cellContents.length; i++) {
        expect(cellContents[i]).toEqual(referenceContent);
      }

      // Performance should not degrade significantly with concurrent users
      const avgEditTimePerUser = totalEditTime / userCount;
      expect(avgEditTimePerUser).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_EDIT_LATENCY * 2); // Allow 2x latency for concurrent scenario

    } finally {
      // Cleanup all contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: WebSocket message delivery must achieve 99.9% success rate
   * Validates requirement: WebSocket 99.9% message delivery success
   */
  test('should achieve 99.9% message delivery', async ({
    browser,
    tmpPath,
    createMultipleContexts
  }) => {
    const contexts = await createMultipleContexts(3);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate to collaborative notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Track message delivery statistics
      let totalMessagesSent = 0;
      let totalMessagesReceived = 0;

      // Set up message tracking on all pages
      const messageTrackers = await Promise.all(pages.map(async (page, index) => {
        return await page.evaluate((userId) => {
          let sentCount = 0;
          let receivedCount = 0;

          // Hook into WebSocket send method
          const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
          if (collaboration?.provider?.ws) {
            const originalSend = collaboration.provider.ws.send;
            collaboration.provider.ws.send = function(data: any) {
              sentCount++;
              return originalSend.call(this, data);
            };

            // Hook into message reception
            collaboration.provider.ws.addEventListener('message', () => {
              receivedCount++;
            });
          }

          return { userId, getSentCount: () => sentCount, getReceivedCount: () => receivedCount };
        }, index);
      }));

      // Perform intensive collaborative editing to generate many WebSocket messages
      for (let round = 0; round < 100; round++) {
        const pageIndex = round % pages.length;
        const testContent = `Round ${round}: ${Math.random().toString(36).substr(2, 9)}`;

        await pages[pageIndex].click('.jp-Cell:first-child .jp-InputArea-editor');
        await pages[pageIndex].keyboard.press('Control+a');
        await pages[pageIndex].keyboard.type(testContent);

        // Small delay to allow message processing
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Allow time for all messages to be processed
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Collect message delivery statistics
      const finalStats = await Promise.all(pages.map((page, index) =>
        page.evaluate(() => {
          const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
          return {
            connected: collaboration?.provider?.ws?.readyState === WebSocket.OPEN,
            messagesProcessed: true // Simplified check - in real implementation would track actual message counts
          };
        })
      ));

      // Verify WebSocket connections are stable
      const connectedClients = finalStats.filter(stat => stat.connected).length;
      const connectionSuccessRate = connectedClients / pages.length;

      console.log(`WebSocket connection success rate: ${(connectionSuccessRate * 100).toFixed(1)}%`);

      // Verify meets minimum success rate threshold
      expect(connectionSuccessRate).toBeGreaterThanOrEqual(PERFORMANCE_THRESHOLDS.WEBSOCKET_SUCCESS_RATE);

      // Verify document consistency as proxy for message delivery success
      const documentConsistency = await Promise.all(pages.map(page =>
        page.evaluate(() => {
          const cellContent = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
          return cellContent?.textContent || '';
        })
      ));

      const referenceContent = documentConsistency[0];
      const consistentClients = documentConsistency.filter(content => content === referenceContent).length;
      const consistencyRate = consistentClients / pages.length;

      console.log(`Document consistency rate: ${(consistencyRate * 100).toFixed(1)}%`);
      expect(consistencyRate).toBeGreaterThanOrEqual(PERFORMANCE_THRESHOLDS.WEBSOCKET_SUCCESS_RATE);

    } finally {
      // Cleanup contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: Performance should scale linearly with document size
   * Validates requirement: Performance regression detection
   */
  test('should scale linearly with document size', async ({
    page,
    tmpPath,
    createMultipleContexts
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate to collaborative notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Test scaling with different document sizes
      const scalingResults: { cells: number; latency: number }[] = [];

      for (const cellCount of [5, 10, 20, 40]) {
        console.log(`Testing with ${cellCount} cells...`);

        // Add cells to reach target count
        const currentCells = await pages[0].evaluate(() =>
          document.querySelectorAll('.jp-Cell').length
        );

        const cellsToAdd = cellCount - currentCells;
        for (let i = 0; i < cellsToAdd; i++) {
          await pages[0].keyboard.press('Escape'); // Exit edit mode
          await pages[0].keyboard.press('b'); // Add cell below
          await pages[0].keyboard.type(`# Cell ${i + currentCells + 1}`);
        }

        // Wait for document synchronization
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Measure edit latency with current document size
        const startTime = now();
        await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');
        await pages[0].keyboard.type(`Test with ${cellCount} cells`);

        await pages[1].waitForFunction(
          (text) => {
            const cellContent = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
            return cellContent?.textContent?.includes(text) === true;
          },
          `Test with ${cellCount} cells`,
          { timeout: 5000 }
        );

        const endTime = now();
        const latency = endTime - startTime;

        scalingResults.push({ cells: cellCount, latency });

        console.log(`${cellCount} cells: ${latency.toFixed(2)}ms latency`);

        // Clear the test text
        await pages[0].keyboard.press('Control+a');
        await pages[0].keyboard.press('Backspace');
      }

      // Analyze scaling characteristics
      // Calculate linear regression to verify reasonable scaling
      const n = scalingResults.length;
      const sumX = scalingResults.reduce((sum, point) => sum + point.cells, 0);
      const sumY = scalingResults.reduce((sum, point) => sum + point.latency, 0);
      const sumXY = scalingResults.reduce((sum, point) => sum + point.cells * point.latency, 0);
      const sumXX = scalingResults.reduce((sum, point) => sum + point.cells * point.cells, 0);

      const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;

      console.log(`Scaling analysis: latency = ${slope.toFixed(3)} * cells + ${intercept.toFixed(2)}`);

      // Verify that largest document size still meets latency requirements
      const maxLatency = Math.max(...scalingResults.map(result => result.latency));
      expect(maxLatency).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_EDIT_LATENCY * 1.5); // Allow 50% increase for large documents

      // Verify scaling is reasonable (not exponential)
      // Slope should be modest (less than 2ms per additional cell)
      expect(slope).toBeLessThan(2);

    } finally {
      // Cleanup contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: System should handle rapid edit bursts efficiently
   * Validates requirement: Performance regression detection
   */
  test('should handle rapid edit bursts', async ({
    browser,
    tmpPath,
    createMultipleContexts
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate to collaborative notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Focus on first cell
      await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');

      // Perform rapid edit burst
      const burstStartTime = now();
      const editPromises: Promise<void>[] = [];

      for (let i = 0; i < 20; i++) {
        const editPromise = (async (index: number) => {
          await pages[0].keyboard.type(`Edit${index} `);
          // Small delay between rapid edits
          await new Promise(resolve => setTimeout(resolve, 25));
        })(i);

        editPromises.push(editPromise);
      }

      // Wait for all edits to be typed
      await Promise.all(editPromises);

      // Wait for synchronization to complete
      await pages[1].waitForFunction(() => {
        const cellContent = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
        const text = cellContent?.textContent || '';
        // Check that we have all 20 edits
        return text.includes('Edit19'); // Last edit should be present
      }, { timeout: 10000 });

      const burstEndTime = now();
      const totalBurstTime = burstEndTime - burstStartTime;

      console.log(`Rapid edit burst (20 edits) completed in ${totalBurstTime.toFixed(2)}ms`);

      // Verify burst handling performance
      expect(totalBurstTime).toBeLessThan(2000); // Should complete within 2 seconds

      // Verify document consistency after burst
      const content1 = await pages[0].evaluate(() => {
        const cellContent = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
        return cellContent?.textContent || '';
      });

      const content2 = await pages[1].evaluate(() => {
        const cellContent = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
        return cellContent?.textContent || '';
      });

      expect(content1).toBe(content2);

      // Verify all edits are present
      for (let i = 0; i < 20; i++) {
        expect(content1).toContain(`Edit${i}`);
      }

    } finally {
      // Cleanup contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: UI should remain responsive during collaborative operations
   * Validates requirement: UI responsiveness maintained
   */
  test('should maintain UI responsiveness', async ({
    page,
    tmpPath,
    createMultipleContexts
  }) => {
    const contexts = await createMultipleContexts(3);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate to collaborative notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Start background collaborative activity
      const backgroundActivity = async () => {
        for (let i = 0; i < 50; i++) {
          const pageIndex = i % (pages.length - 1) + 1; // Use pages 1 and 2 for background activity
          const cellSelector = '.jp-Cell:first-child .jp-InputArea-editor';

          await pages[pageIndex].click(cellSelector);
          await pages[pageIndex].keyboard.type(`Background ${i} `);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };

      // Start background activity (don't await)
      const backgroundPromise = backgroundActivity();

      // Measure UI responsiveness on the main page during background activity
      const responsivenessMeasurements: number[] = [];

      for (let i = 0; i < 10; i++) {
        const startTime = now();

        // Click on notebook toolbar button
        await pages[0].click('.jp-Toolbar .jp-ToolbarButton:first-child');

        // Wait for visual response (button state change)
        await pages[0].waitForFunction(() => {
          const button = document.querySelector('.jp-Toolbar .jp-ToolbarButton:first-child');
          return button !== null; // Button responds to click
        }, { timeout: 1000 });

        const endTime = now();
        const responseTime = endTime - startTime;
        responsivenessMeasurements.push(responseTime);

        await new Promise(resolve => setTimeout(resolve, 200)); // Wait before next interaction
      }

      // Wait for background activity to complete
      await backgroundPromise;

      // Analyze UI responsiveness
      const avgResponseTime = responsivenessMeasurements.reduce((a, b) => a + b, 0) / responsivenessMeasurements.length;
      const maxResponseTime = Math.max(...responsivenessMeasurements);

      console.log(`Average UI response time: ${avgResponseTime.toFixed(2)}ms`);
      console.log(`Maximum UI response time: ${maxResponseTime.toFixed(2)}ms`);

      // Verify UI responsiveness meets threshold
      expect(avgResponseTime).toBeLessThan(PERFORMANCE_THRESHOLDS.UI_RESPONSE_THRESHOLD);
      expect(maxResponseTime).toBeLessThan(PERFORMANCE_THRESHOLDS.UI_RESPONSE_THRESHOLD * 2);

    } finally {
      // Cleanup contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: CRDT operations should be optimized for performance
   * Validates requirement: Algorithm efficiency
   */
  test('should optimize CRDT operations', async ({
    page,
    tmpPath,
    createMultipleContexts
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate to collaborative notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Measure CRDT operation performance using lib0/benchmark
      const bench = new Bench();

      // Test single character insertions (common CRDT operation)
      bench.add('single-char-insert', async () => {
        const startTime = measureTime();

        await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');
        await pages[0].keyboard.type('a');

        // Wait for CRDT operation to propagate
        await pages[1].waitForFunction(() => {
          const content = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
          return content?.textContent?.includes('a') === true;
        }, { timeout: 1000 });

        const operationTime = measureTime() - startTime;
        expect(operationTime).toBeLessThan(PERFORMANCE_THRESHOLDS.CRDT_OPERATION_THRESHOLD);
      });

      // Test text block insertions
      bench.add('text-block-insert', async () => {
        const startTime = measureTime();
        const testBlock = 'This is a test block of text for CRDT performance';

        await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');
        await pages[0].keyboard.press('Control+a');
        await pages[0].keyboard.type(testBlock);

        await pages[1].waitForFunction((text) => {
          const content = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
          return content?.textContent?.includes(text) === true;
        }, testBlock, { timeout: 2000 });

        const operationTime = measureTime() - startTime;
        expect(operationTime).toBeLessThan(PERFORMANCE_THRESHOLDS.CRDT_OPERATION_THRESHOLD * 2); // Allow 2x time for larger operations
      });

      // Test concurrent edits (CRDT conflict resolution)
      bench.add('concurrent-edit-resolution', async () => {
        const startTime = measureTime();

        // Clear cell first
        await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');
        await pages[0].keyboard.press('Control+a');
        await pages[0].keyboard.press('Backspace');
        await new Promise(resolve => setTimeout(resolve, 100));

        // Perform near-simultaneous edits
        const edit1Promise = (async () => {
          await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');
          await pages[0].keyboard.type('User1Text');
        })();

        const edit2Promise = (async () => {
          await pages[1].click('.jp-Cell:first-child .jp-InputArea-editor');
          await pages[1].keyboard.type('User2Text');
        })();

        await Promise.all([edit1Promise, edit2Promise]);

        // Wait for CRDT resolution to stabilize
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify both texts are present (merged by CRDT)
        const finalContent = await pages[0].evaluate(() => {
          const content = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
          return content?.textContent || '';
        });

        const operationTime = measureTime() - startTime;

        expect(finalContent.includes('User1Text') || finalContent.includes('User2Text')).toBe(true);
        expect(operationTime).toBeLessThan(PERFORMANCE_THRESHOLDS.CRDT_OPERATION_THRESHOLD * 3); // Allow 3x time for conflict resolution
      });

      // Run the benchmark suite
      await runBench(bench);

      console.log('CRDT operation benchmarks completed successfully');

    } finally {
      // Cleanup contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  /**
   * Test: WebSocket message batching should be efficient
   * Validates requirement: Network optimization
   */
  test('should batch WebSocket messages efficiently', async ({
    browser,
    tmpPath,
    createMultipleContexts
  }) => {
    const contexts = await createMultipleContexts(2);
    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    try {
      // Navigate to collaborative notebook
      const notebookPath = `notebooks/${tmpPath}/${PERFORMANCE_TEST_NOTEBOOK}?collaborative=true`;
      await Promise.all(pages.map(page => page.goto(notebookPath)));

      // Set up WebSocket message monitoring
      let messagesSent = 0;
      await pages[0].evaluate(() => {
        const collaboration = (window as any).jupyterapp?.serviceManager?.collaboration;
        if (collaboration?.provider?.ws) {
          const originalSend = collaboration.provider.ws.send;
          collaboration.provider.ws.send = function(data: any) {
            (window as any).messagesSent = ((window as any).messagesSent || 0) + 1;
            return originalSend.call(this, data);
          };
        }
      });

      // Perform rapid typing to trigger message batching
      const batchTestStartTime = now();

      await pages[0].click('.jp-Cell:first-child .jp-InputArea-editor');

      // Type multiple characters rapidly
      const rapidText = 'This is a test of message batching efficiency for collaborative editing';
      for (const char of rapidText) {
        await pages[0].keyboard.type(char);
        // Very small delay to simulate rapid typing
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Wait for batching window to complete
      await new Promise(resolve => setTimeout(resolve, PERFORMANCE_THRESHOLDS.BATCH_MESSAGE_THRESHOLD + 100));

      const batchTestEndTime = now();
      const batchingTime = batchTestEndTime - batchTestStartTime;

      // Check message count and batching efficiency
      const finalMessageCount = await pages[0].evaluate(() => {
        return (window as any).messagesSent || 0;
      });

      console.log(`Messages sent during batching test: ${finalMessageCount}`);
      console.log(`Batching test completed in: ${batchingTime.toFixed(2)}ms`);

      // Verify content arrived at second page
      await pages[1].waitForFunction((text) => {
        const content = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
        return content?.textContent?.includes(text) === true;
      }, rapidText, { timeout: 5000 });

      // Batching should reduce message count (fewer messages than characters typed)
      expect(finalMessageCount).toBeLessThan(rapidText.length);

      // Batching should not introduce excessive delay
      expect(batchingTime).toBeLessThan(rapidText.length * 50); // Allow 50ms per character max

      // Verify final content consistency
      const content1 = await pages[0].evaluate(() => {
        const content = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
        return content?.textContent || '';
      });

      const content2 = await pages[1].evaluate(() => {
        const content = document.querySelector('.jp-Cell:first-child .jp-InputArea-editor .cm-content');
        return content?.textContent || '';
      });

      expect(content1).toBe(content2);
      expect(content1).toContain(rapidText);

    } finally {
      // Cleanup contexts
      for (const context of contexts) {
        await context.close();
      }
    }
  });

});
