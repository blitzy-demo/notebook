import { config } from './playwright.config';
import { devices } from '@playwright/test';

/**
 * Specialized Playwright configuration for collaboration testing that extends the base
 * configuration with multi-user scenarios, WebSocket testing capabilities, and
 * performance benchmarking settings for Jupyter Notebook v7 collaborative editing.
 */
const collaborationConfig = {
  // Extend base configuration with collaboration-specific enhancements
  ...config,

  // Enhanced global configuration for collaborative testing scenarios
  use: {
    ...config.use,
    // Enable comprehensive debugging artifacts for multi-user scenarios
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Global HTTP headers for collaboration endpoint identification
    extraHTTPHeaders: {
      'X-Collaboration-Test': 'true',
      'Accept': 'application/json',
    },
  },

  // Increased retries for WebSocket connection instability in CI environments
  retries: 3,

  // Extended timeout for multi-user synchronization scenarios
  timeout: 60000,

  // Specialized web servers for collaborative testing
  webServer: [
    ...config.webServer,
    {
      // Dedicated collaboration WebSocket server for testing
      command: 'jupyter notebook --collaborative --port=8889 --no-browser --allow-root',
      port: 8889,
      timeout: 120 * 1000,
      reuseExistingServer: true,
      stdout: 'pipe',
      env: {
        JUPYTER_COLLABORATION_ENABLED: 'true',
        JUPYTER_COLLABORATION_WS_ENDPOINT: '/api/collaboration/ws',
        JUPYTER_COLLABORATION_PERFORMANCE_MONITORING: 'true',
      },
    },
  ],

  // Comprehensive project configurations for different collaboration test scenarios
  projects: [
    {
      name: 'dual-user-chrome',
      use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        // WebSocket configuration for collaboration endpoints
        extraHTTPHeaders: {
          'X-Collaboration-Mode': 'dual-user',
          'X-Collaboration-User': 'user1',
        },
        // Browser launch options optimized for collaboration testing
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-blink-features=AutomationControlled',
          ],
        },
      },
      retries: 3,
      timeout: 60000,
      testMatch: /.*dual-user.*\.spec\.ts$/,
    },
    {
      name: 'dual-user-firefox',
      use: {
        ...devices['Desktop Firefox'],
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        extraHTTPHeaders: {
          'X-Collaboration-Mode': 'dual-user',
          'X-Collaboration-User': 'user1',
        },
      },
      retries: 3,
      timeout: 60000,
      testMatch: /.*dual-user.*\.spec\.ts$/,
    },
    {
      name: 'dual-user-safari',
      use: {
        ...devices['Desktop Safari'],
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        extraHTTPHeaders: {
          'X-Collaboration-Mode': 'dual-user',
          'X-Collaboration-User': 'user1',
        },
      },
      retries: 3,
      timeout: 60000,
      testMatch: /.*dual-user.*\.spec\.ts$/,
    },
    {
      name: 'multi-user-chrome',
      use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        extraHTTPHeaders: {
          'X-Collaboration-Mode': 'multi-user',
          'X-Performance-Monitoring': 'latency,memory',
        },
        // Enhanced browser configuration for multi-user testing
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--enable-automation',
            '--disable-blink-features=AutomationControlled',
            '--memory-pressure-off',
          ],
        },
      },
      retries: 3,
      timeout: 60000,
      testMatch: /.*multi-user.*\.spec\.ts$/,
    },
    {
      name: 'stress-test-concurrent',
      use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        extraHTTPHeaders: {
          'X-Collaboration-Mode': 'stress-test',
          'X-Concurrent-Users': '10',
          'X-Performance-Monitoring': 'latency,memory,websocket',
        },
        // Optimized configuration for high-concurrency testing
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--max-old-space-size=4096',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
          ],
        },
      },
      retries: 3,
      timeout: 120000, // Extended timeout for stress testing
      testMatch: /.*stress-test.*\.spec\.ts$/,
    },
    {
      name: 'performance-benchmarks',
      use: {
        ...devices['Desktop Chrome'],
        trace: 'on',
        video: 'on',
        extraHTTPHeaders: {
          'X-Collaboration-Mode': 'benchmark',
          'X-Performance-Monitoring': 'all',
          'X-Latency-Target': '100ms',
          'X-Memory-Target': '20percent',
        },
        // Performance-optimized browser configuration
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-web-security',
            '--enable-precise-memory-info',
            '--enable-memory-info',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
          ],
        },
      },
      retries: 2,
      timeout: 90000,
      testMatch: /.*benchmark.*\.spec\.ts$/,
    },
    {
      name: 'websocket-stability',
      use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        extraHTTPHeaders: {
          'X-Collaboration-Mode': 'websocket-stability',
          'X-WebSocket-Endpoint': '/api/collaboration/ws',
          'X-Connection-Stability-Target': '99.9percent',
        },
        // Network simulation configuration for stability testing
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-web-security',
            '--simulate-outdated-no-au=Tue, 31 Dec 2099 23:59:59 GMT',
          ],
        },
      },
      retries: 5, // Higher retry count for network instability testing
      timeout: 60000,
      testMatch: /.*websocket.*\.spec\.ts$/,
    },
  ],

  // Enhanced test reporting for collaboration metrics
  reporter: [
    ['html', {
      outputFolder: 'test-results/collaboration-html-report',
      open: 'never',
    }],
    ['json', {
      outputFile: 'test-results/collaboration-results.json',
    }],
    ['junit', {
      outputFile: 'test-results/collaboration-junit.xml',
    }],
    ['github'],
    // Custom collaboration performance reporter
    ['./test-utils/collaboration-performance-reporter.ts'],
  ],

  // Global setup for collaboration testing infrastructure
  globalSetup: './test-utils/collaboration-global-setup.ts',

  // Global teardown for cleanup and performance analysis
  globalTeardown: './test-utils/collaboration-global-teardown.ts',

  // Test output directory for collaboration artifacts
  outputDir: 'test-results/collaboration-artifacts',

  // Parallel execution settings optimized for multi-user scenarios
  workers: process.env.CI ? 2 : 4,
  fullyParallel: false, // Sequential execution for collaboration tests to avoid resource conflicts

  // Enhanced failure handling
  maxFailures: process.env.CI ? 3 : 1,

  // Metadata for collaboration test identification
  metadata: {
    testType: 'collaboration',
    features: [
      'real-time-synchronization',
      'user-presence-awareness',
      'cell-level-locking',
      'change-history-versioning',
      'permissions-access-control',
      'comment-review-system',
    ],
    performanceTargets: {
      latency: '<100ms (95th percentile)',
      memoryOverhead: '<20% increase',
      concurrentUsers: '≥10 users',
      websocketStability: '99.9% success rate',
    },
  },
};

export default collaborationConfig;
