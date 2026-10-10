import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/domain.test.ts', 'tests/header.test.ts', 'tests/preview.test.ts'], pool: 'forks', poolOptions: { forks: { singleFork: true } } } });
