import { defineConfig } from 'vitest/config';
import base from '../../vitest.config.js';

export default defineConfig({
  define: base.define,
  resolve: base.resolve,
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['scripts/benchmarks/dev-cache-decode.sample.ts'],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 180_000,
  },
});
