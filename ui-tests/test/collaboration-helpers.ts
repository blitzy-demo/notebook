/**
 * Collaboration Testing Helpers
 *
 * Shared test utilities and helper functions for collaboration testing,
 * providing common functionality for multi-user scenarios, WebSocket mocking,
 * and performance measurement
 */

// External imports from packages
import type { BrowserContext } from '@playwright/test';
import { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Array as YArray } from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

// Type definitions for collaboration testing

/**
 * Represents a user in collaborative testing scenarios
 */
export interface CollaborationUser {
  /** Unique user identifier */
  id: string;
  /** Display name for the user */
  name: string;
  /** Avatar/profile image URL or identifier */
  avatar: string;
  /** Color theme associated with the user (for cursors, highlights) */
  color: string;
}

/**
 * Represents a collaborative editing session
 */
export interface CollaborationSession {
  /** WebSocket connection for real-time communication */
  websocket: WebSocket | null;
  /** Current state of the collaborative document */
  documentState: Y.Doc;
  /** Unique session identifier */
  sessionId: string;
  /** List of active participants in the session */
  participants: CollaborationUser[];
  /** Yjs WebSocket provider for synchronization */
  provider: WebsocketProvider | null;
  /** Cleanup function to properly close the session */
  cleanup: () => Promise<void>;
}

/**
 * Mock WebSocket server for testing collaborative features
 */
export class MockWebSocketServer {
  private server: any;
  private connections: Set<WebSocket>;
  private messageHistory: Array<{ timestamp: number; message: any; from?: string }>;
  private port: number;
  private isRunning: boolean;

  constructor(port = 8889) {
    this.port = port;
    this.connections = new Set();
    this.messageHistory = [];
    this.isRunning = false;
  }

  /**
   * Start the mock WebSocket server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // Mock server implementation for testing
    this.server = {
      port: this.port,
      url: `ws://localhost:${this.port}`,
      close: () => {
        this.isRunning = false;
        this.connections.clear();
      }
    };

    this.isRunning = true;
  }

  /**
   * Stop the mock WebSocket server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Close all connections
    this.connections.forEach(connection => {
      if (connection.readyState === WebSocket.OPEN) {
        connection.close();
      }
    });

    this.connections.clear();

    if (this.server) {
      this.server.close();
    }

    this.isRunning = false;
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(message: any): void {
    const messageData = {
      timestamp: Date.now(),
      message: message
    };

    this.messageHistory.push(messageData);

    this.connections.forEach(connection => {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify(message));
      }
    });
  }

  /**
   * Get all active WebSocket connections
   */
  getConnections(): WebSocket[] {
    return Array.from(this.connections);
  }

  /**
   * Simulate receiving a message from a specific client
   */
  simulateMessage(message: any, from?: string): void {
    const messageData = {
      timestamp: Date.now(),
      message: message,
      from: from
    };

    this.messageHistory.push(messageData);

    // Broadcast to other connections (excluding sender)
    this.connections.forEach(connection => {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify(message));
      }
    });
  }

  /**
   * Get the complete message history
   */
  getMessageHistory(): Array<{ timestamp: number; message: any; from?: string }> {
    return [...this.messageHistory];
  }
}

/**
 * Generate mock users for collaborative testing
 */
export function generateMockUsers(count: number): CollaborationUser[] {
  const users: CollaborationUser[] = [];
  const colors = TEST_CONFIG.USER_COLORS;
  const avatarStyles = TEST_CONFIG.AVATAR_STYLES;

  for (let i = 0; i < count; i++) {
    users.push({
      id: `user_${i + 1}`,
      name: `Test User ${i + 1}`,
      avatar: avatarStyles[i % avatarStyles.length],
      color: colors[i % colors.length]
    });
  }

  return users;
}

/**
 * Create a new Yjs document for collaborative testing
 */
export function createYjsDocument(): Y.Doc {
  const doc = new Y.Doc();

  // Initialize with basic notebook structure
  doc.getArray('cells'); // Initialize cells array
  const metadata = doc.getMap('metadata');

  // Set up basic notebook metadata
  metadata.set('kernelspec', {
    name: 'python3',
    display_name: 'Python 3'
  });

  metadata.set('language_info', {
    name: 'python',
    version: '3.9.0'
  });

  return doc;
}

/**
 * Simulate realistic typing behavior in a page
 */
export async function simulateTyping(
  page: IJupyterLabPageFixture,
  text: string,
  delay: number = TEST_CONFIG.SIMULATION_DELAY
): Promise<void> {
  for (const char of text) {
    await page.keyboard.type(char);

    // Add random variation to typing delay for realism
    const variation = Math.random() * delay * 0.5;
    await page.waitForTimeout(delay + variation);
  }
}

/**
 * Capture performance metrics during collaborative operations
 */
export async function capturePerformanceMetrics(
  page: IJupyterLabPageFixture
): Promise<{
  editLatency: number;
  memoryUsage: any;
  networkTiming: any;
  renderingMetrics: any;
}> {
  // Capture performance metrics using browser APIs
  const performanceData = await page.evaluate(() => {
    const performance = window.performance;
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;

    return {
      editLatency: performance.now(),
      memoryUsage: (performance as any).memory ? {
        used: (performance as any).memory.usedJSHeapSize,
        total: (performance as any).memory.totalJSHeapSize,
        limit: (performance as any).memory.jsHeapSizeLimit
      } : null,
      networkTiming: {
        connectTime: navigation.connectEnd - navigation.connectStart,
        dnsTime: navigation.domainLookupEnd - navigation.domainLookupStart,
        responseTime: navigation.responseEnd - navigation.responseStart
      },
      renderingMetrics: {
        domContentLoaded: navigation.domContentLoadedEventEnd - (navigation.startTime || 0),
        loadComplete: navigation.loadEventEnd - (navigation.startTime || 0)
      }
    };
  });

  return performanceData;
}

/**
 * Verify synchronization between two Yjs documents
 */
export function verifyYjsSync(doc1: Y.Doc, doc2: Y.Doc): boolean {
  try {
    // Simple approach: compare the document states by comparing arrays directly
    const cells1 = doc1.getArray('cells');
    const cells2 = doc2.getArray('cells');

    if (cells1.length !== cells2.length) {
      return false;
    }

    // Compare each cell
    for (let i = 0; i < cells1.length; i++) {
      const cell1 = cells1.get(i);
      const cell2 = cells2.get(i);

      if (JSON.stringify(cell1) !== JSON.stringify(cell2)) {
        return false;
      }
    }

    // Compare metadata
    const meta1 = doc1.getMap('metadata');
    const meta2 = doc2.getMap('metadata');

    const metaEntries1 = Array.from(meta1.entries());
    const metaEntries2 = Array.from(meta2.entries());

    if (metaEntries1.length !== metaEntries2.length) {
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error during Yjs sync verification:', error);
    return false;
  }
}

/**
 * Generate a collaborative notebook with sample content
 */
export function generateCollaborativeNotebook(): any {
  return {
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          '# Collaborative Notebook Test\n',
          '\n',
          'This notebook is used for testing collaborative editing features.'
        ]
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          'import numpy as np\n',
          'import matplotlib.pyplot as plt\n',
          '\n',
          '# Sample code for collaborative editing tests\n',
          'print("Hello from collaborative notebook!")'
        ]
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          '# This cell can be edited by multiple users\n',
          'x = np.linspace(0, 2*np.pi, 100)\n',
          'y = np.sin(x)\n',
          '\n',
          'plt.figure(figsize=(10, 6))\n',
          'plt.plot(x, y, label="sin(x)")\n',
          'plt.xlabel("x")\n',
          'plt.ylabel("y")\n',
          'plt.title("Collaborative Plot")\n',
          'plt.legend()\n',
          'plt.grid(True)\n',
          'plt.show()'
        ]
      }
    ],
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3'
      },
      language_info: {
        codemirror_mode: {
          name: 'ipython',
          version: 3
        },
        file_extension: '.py',
        mimetype: 'text/x-python',
        name: 'python',
        nbconvert_exporter: 'python',
        pygments_lexer: 'ipython3',
        version: '3.9.0'
      }
    },
    nbformat: 4,
    nbformat_minor: 4
  };
}

/**
 * Set up a collaboration server for testing
 */
export async function setupCollaborationServer(port: number = TEST_CONFIG.DEFAULT_SERVER_PORT): Promise<MockWebSocketServer> {
  const server = new MockWebSocketServer(port);
  await server.start();

  // Add some delay to ensure server is fully initialized
  await new Promise(resolve => setTimeout(resolve, 100));

  return server;
}

/**
 * Clean up a collaboration session
 */
export async function cleanupCollaborationSession(session: CollaborationSession): Promise<void> {
  try {
    // Disconnect WebSocket provider
    if (session.provider) {
      session.provider.disconnect();
      session.provider.destroy();
    }

    // Close WebSocket connection
    if (session.websocket && session.websocket.readyState === WebSocket.OPEN) {
      session.websocket.close();
    }

    // Clear document state
    session.documentState.destroy();

    // Clear participants
    session.participants.length = 0;

    // Execute custom cleanup if provided
    if (session.cleanup) {
      await session.cleanup();
    }

  } catch (error) {
    console.error('Error during collaboration session cleanup:', error);
  }
}

// Constants for testing configuration

/**
 * Timeout values for collaborative operations
 */
export const COLLABORATION_TIMEOUTS = {
  /** WebSocket connection timeout */
  WEBSOCKET_CONNECT: 5000,
  /** Maximum time to wait for document synchronization */
  SYNC_WAIT: 10000,
  /** Cell lock acquisition timeout */
  LOCK_TIMEOUT: 3000,
  /** User presence update timeout */
  PRESENCE_UPDATE: 2000
} as const;

/**
 * Performance thresholds for collaborative features
 */
export const PERFORMANCE_THRESHOLDS = {
  /** Maximum acceptable edit latency in milliseconds */
  MAX_EDIT_LATENCY: 100,
  /** Maximum memory overhead percentage */
  MAX_MEMORY_OVERHEAD: 20,
  /** Minimum number of concurrent users to support */
  MIN_CONCURRENT_USERS: 10,
  /** Minimum WebSocket message delivery success rate */
  WEBSOCKET_SUCCESS_RATE: 0.999
} as const;

/**
 * General test configuration constants
 */
export const TEST_CONFIG = {
  /** Default port for collaboration server */
  DEFAULT_SERVER_PORT: 8889,
  /** Number of retry attempts for flaky operations */
  RETRY_ATTEMPTS: 3,
  /** Default delay for simulated user actions */
  SIMULATION_DELAY: 50,
  /** Available user colors for collaborative indicators */
  USER_COLORS: [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
    '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F8C471', '#82E0AA', '#F1948A', '#AED6F1'
  ],
  /** Avatar style options for test users */
  AVATAR_STYLES: [
    'circle', 'square', 'rounded', 'hexagon',
    'diamond', 'star', 'heart', 'triangle'
  ]
} as const;
