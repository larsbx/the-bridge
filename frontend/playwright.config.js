import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  testMatch: process.env.BRIDGE_BROWSER_BACKEND === 'ash' ? 'ash-dashboard.spec.js' : 'dashboard.spec.js',
  workers: 1,
  timeout: 20000,
  use: {
    baseURL: 'http://127.0.0.1:3173',
    browserName: 'chromium',
    launchOptions: process.env.BRIDGE_CHROMIUM_PATH ? { executablePath: process.env.BRIDGE_CHROMIUM_PATH } : {},
    trace: 'retain-on-failure'
  },
  webServer: { command: 'node test/support/browser-server.mjs', url: 'http://127.0.0.1:3173/healthz', reuseExistingServer: false, timeout: 20000 }
});
