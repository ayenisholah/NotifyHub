import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.DEMO_E2E_URL ?? 'http://127.0.0.1:4100',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
});
