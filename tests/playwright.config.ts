import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PLAYWRIGHT_REPORT ?? 'playwright-report' }]],
  use: { baseURL: process.env.GATEWAY_URL ?? 'http://localhost:8080', screenshot: 'only-on-failure' },
});
