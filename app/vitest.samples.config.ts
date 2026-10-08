import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/samples.test.ts'], testTimeout: 90000, pool: 'forks', poolOptions: { forks: { singleFork: true } } } });
