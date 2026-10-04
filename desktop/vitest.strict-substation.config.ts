import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({ ...base, test: { ...base.test,
  include: ['src/services/__tests__/strictSubstation.test.ts'],
  exclude: [], poolOptions: { forks: { singleFork: true } },
  testTimeout: 1_800_000,
  onConsoleLog: (log) => log.startsWith('{"sample"') || log.startsWith('substation04:'),
} });
