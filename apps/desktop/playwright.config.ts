/**
 * Screen tests in a real browser against the real API (T9/T10): every flow runs in Arabic
 * (right to left, light) and in English (left to right, dark).
 *
 *   pnpm test:e2e
 *
 * Needs PostgreSQL and `.env` like the API tests, and Chromium (`pnpm exec playwright install
 * chromium` once; or ARTEPOOL_E2E_CHROMIUM=<path to chrome>).
 */
import { defineConfig, devices } from '@playwright/test';
import type { Lang, Theme } from './e2e/fixtures';
import { E2E } from './e2e/paths';

const executablePath = process.env.ARTEPOOL_E2E_CHROMIUM;

const devServer = (pc: keyof typeof E2E.pcs) => ({
  command: `pnpm exec vite --configLoader runner --port ${E2E.pcs[pc].port} --strictPort`,
  url: `http://localhost:${E2E.pcs[pc].port}/`,
  env: {
    ...process.env,
    ARTEPOOL_DEV_DEVICE_FILE: E2E.pcs[pc].deviceFile,
    // Only the "setup" PC holds a setup token (written by the harness for each wizard test).
    ...(pc === 'setup' ? { ARTEPOOL_DEV_SETUP_FILE: E2E.setupFile } : {}),
  } as Record<string, string>,
  reuseExistingServer: false,
  timeout: 120_000,
});

export default defineConfig<{ lang: Lang; theme: Theme }>({
  testDir: './e2e',
  outputDir: './test-results',
  // One API server and shared PCs: flows run one after another.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1366, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'ar-light', use: { lang: 'ar', theme: 'light', colorScheme: 'light' } },
    { name: 'en-dark', use: { lang: 'en', theme: 'dark', colorScheme: 'dark' } },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx e2e/harness/harness.ts',
      url: `${E2E.control}/ready`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    devServer('office'),
    devServer('pos'),
    devServer('fresh'),
    devServer('setup'),
  ],
});
