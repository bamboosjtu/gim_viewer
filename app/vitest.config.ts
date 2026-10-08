import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/domain.test.ts'], pool: 'forks', poolOptions: { forks: { singleFork: true } } } });
