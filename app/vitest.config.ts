import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { setupFiles:['vitest.setup.ts'], include: ['src/**/__tests__/**/*.test.ts', '../packages/powerline-core/src/**/__tests__/**/*.test.ts'], pool: 'forks', poolOptions: { forks: { singleFork: true } } } });
