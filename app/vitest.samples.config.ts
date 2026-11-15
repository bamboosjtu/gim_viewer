import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { setupFiles:['vitest.setup.ts'],include: ['tests/local/samples.test.ts'], testTimeout: 90000, pool: 'forks', poolOptions: { forks: { singleFork: true } } } });
