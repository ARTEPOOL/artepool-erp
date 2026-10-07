import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            'apps/*/test/unit/**/*.test.ts',
            'tools/*/test/unit/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
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
