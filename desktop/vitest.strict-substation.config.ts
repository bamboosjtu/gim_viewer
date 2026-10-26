import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({ ...base, test: { ...base.test,
  include: ['src/services/__tests__/strictSubstation.test.ts'],
  exclude: [], poolOptions: { forks: { singleFork: true } },
  // The strict sample chain performs a real SQLite round trip; share the same
  // one-build global setup and injected harness path as `test:sqlite`.
  globalSetup: ['./src/services/__tests__/sqliteGlobalSetup.ts'],
  testTimeout: 1_800_000,
  onConsoleLog: (log) => log.startsWith('{"sample"') || log.startsWith('substation04:'),
} });
