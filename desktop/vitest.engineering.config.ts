import { defineConfig } from 'vitest/config';

/** Required nine-package gate. Missing input is a failure, never a skip. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['acceptance/engineering/**/*.test.ts'],
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
    testTimeout: 120_000,
  },
});
