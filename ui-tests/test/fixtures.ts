import { test as base } from '@jupyterlab/galata';
import { Browser } from '@playwright/test';
import {
  cleanupCollaborationSession,
  setupCollaborationServer,
  generateMockUsers,
  createYjsDocument,
  MockWebSocketServer,
  CollaborationSession,
  CollaborationUser,
  COLLABORATION_TIMEOUTS
} from './collaboration-helpers';

export const test = base.extend({
  waitForApplication: async ({ baseURL }, use, testInfo) => {
    const waitIsReady = async (page): Promise<void> => {
      await page.waitForSelector('#main-panel');
    };
    await use(waitIsReady);
  },

  // Collaboration test fixtures for multi-user scenarios

  /**
   * Fixture to manage WebSocket server connection for collaboration testing
   */
  collaborationServer: async ({}, use, testInfo) => {
    let server: MockWebSocketServer | null = null;

    try {
      server = await setupCollaborationServer();
      await use(server);
    } finally {
      if (server) {
        await server.stop();
      }
    }
  },

  /**
   * Fixture to toggle collaboration mode on/off
   */
  collaborationEnabled: async ({}, use) => {
    // Enable collaboration mode for multi-user testing
    await use(true);
  },

  /**
   * Fixture providing predefined user profiles (names, avatars, colors) for collaborative testing
   */
  mockUsers: async ({}, use) => {
    const users = generateMockUsers(4); // Generate 4 test users by default
    await use(users);
  },

  /**
   * Fixture for setting up initial Yjs document states
   */
  yjsDocumentFixture: async ({}, use) => {
    let doc: any = null;

    try {
      doc = createYjsDocument();
      await use(doc);
    } finally {
      if (doc) {
        doc.destroy();
      }
    }
  },

  /**
   * Fixture for user presence and cursor tracking setup
   */
  awarenessFixture: async ({ collaborationServer }, use) => {
    const awarenessData = {
      users: new Map(),
      cursors: new Map(),
      selections: new Map(),

      // Methods to manage awareness state
      addUser: (userId: string, userInfo: CollaborationUser) => {
        awarenessData.users.set(userId, userInfo);
      },

      updateCursor: (userId: string, position: { line: number; column: number }) => {
        awarenessData.cursors.set(userId, position);
      },

      updateSelection: (userId: string, range: { start: any; end: any }) => {
        awarenessData.selections.set(userId, range);
      },

      removeUser: (userId: string) => {
        awarenessData.users.delete(userId);
        awarenessData.cursors.delete(userId);
        awarenessData.selections.delete(userId);
      },

      cleanup: () => {
        awarenessData.users.clear();
        awarenessData.cursors.clear();
        awarenessData.selections.clear();
      }
    };

    try {
      await use(awarenessData);
    } finally {
      awarenessData.cleanup();
    }
  },

  /**
   * Hook that ensures WebSocket connection is established before proceeding with tests
   */
  waitForCollaboration: async ({ collaborationServer }, use) => {
    const waitForConnection = async (timeoutMs: number = COLLABORATION_TIMEOUTS.WEBSOCKET_CONNECT): Promise<boolean> => {
      if (!collaborationServer) {
        return false;
      }

      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        try {
          // Check if server is running and accessible
          const testWs = new WebSocket(`ws://localhost:${collaborationServer.port || 8889}`);

          const connected = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              testWs.close();
              resolve(false);
            }, 1000);

            testWs.onopen = () => {
              clearTimeout(timeout);
              testWs.close();
              resolve(true);
            };

            testWs.onerror = () => {
              clearTimeout(timeout);
              resolve(false);
            };
          });

          if (connected) {
            return true;
          }
        } catch (error) {
          // Connection failed, continue waiting
        }

        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return false;
    };

    await use(waitForConnection);
  },

  /**
   * Fixture for creating multiple browser contexts for multi-user testing
   */
  createMultipleContexts: async ({ browser }, use) => {
    const contexts: any[] = [];

    const createContexts = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const context = await browser.newContext({
          // Unique session for each context to simulate different users
          storageState: undefined,
          // Add user agent variation to simulate different users
          userAgent: `CollabTestUser${i + 1}`
        });
        contexts.push(context);
      }
      return contexts;
    };

    try {
      await use(createContexts);
    } finally {
      // Clean up all contexts
      for (const context of contexts) {
        await context.close();
      }
      contexts.length = 0;
    }
  }
});
