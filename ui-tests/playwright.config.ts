import baseConfig from '@jupyterlab/galata/lib/playwright-config';
import { devices } from '@playwright/test';

const config = {
  ...baseConfig,
  use: {
    appPath: '',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  retries: 1,
  timeout: 60000, // Extended timeout for collaborative scenarios
  testDir: 'test',
  projects: [
    {
      name: 'single-user',
      use: {
        ...devices['Desktop Chrome'],
        trace: 'on-first-retry',
        video: 'retain-on-failure',
      },
      retries: 1,
      timeout: 30000,
    },
    {
      name: 'collaboration-tests',
      use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure', // Enhanced debugging for collaboration
        video: 'retain-on-failure',
        // WebSocket configuration for collaboration server endpoints
        extraHTTPHeaders: {
          'X-Collaboration-Mode': 'true',
        },
      },
      retries: 3, // Increased retries for WebSocket instability
      timeout: 60000, // Extended timeout for multi-user scenarios
      testMatch: /.*collaboration.*\.spec\.ts$/,
    },
    {
      name: 'collaboration-multi-context',
      use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        // Configuration for multiple browser contexts simulation
        launchOptions: {
          args: ['--no-sandbox', '--disable-web-security'],
        },
      },
      retries: 3,
      timeout: 60000,
      testMatch: /.*multi-user.*\.spec\.ts$/,
    },
  ],
  webServer: [
    {
      command: 'jlpm start',
      port: 8888,
      timeout: 120 * 1000,
      reuseExistingServer: true,
      stdout: 'pipe',
    },
    {
      // Collaboration WebSocket server
      command: 'jupyter notebook --collaborative --port=8889',
      port: 8889,
      timeout: 120 * 1000,
      reuseExistingServer: true,
      stdout: 'pipe',
      env: {
        JUPYTER_COLLABORATION_ENABLED: 'true',
      },
    },
  ],
};

module.exports = config;
