import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          sequence: { groupOrder: 0 },
          include: [
            'packages/*/test/**/*.test.ts',
            'apps/*/test/unit/**/*.test.ts',
            'tools/*/test/unit/**/*.test.ts',
          ],
          exclude: ['apps/desktop/**'],
        },
      },
      {
        // The desktop screens: React components in a simulated browser, in Arabic and English.
        extends: './apps/desktop/vite.config.ts',
        test: {
          name: 'desktop',
          sequence: { groupOrder: 0 },
          root: './apps/desktop',
          include: ['test/unit/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['test/setup.ts'],
          css: { modules: { classNameStrategy: 'non-scoped' } },
        },
      },
      {
        test: {
          name: 'integration',
          sequence: { groupOrder: 1 },
          include: [
            'db/tests/**/*.test.ts',
            'apps/*/test/integration/**/*.test.ts',
            'tools/*/test/integration/**/*.test.ts',
          ],
          globalSetup: ['packages/testing/src/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          maxWorkers: 4,
        },
      },
    ],
  },
});
