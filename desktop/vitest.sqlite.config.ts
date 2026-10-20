import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  define: base.define,
  resolve: base.resolve,
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./src/services/__tests__/sqliteGlobalSetup.ts'],
    include: ['src/services/__tests__/substationSqlite.integration.test.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
