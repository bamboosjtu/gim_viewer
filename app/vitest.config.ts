import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { setupFiles:['tests/setup.ts'], include: ['tests/domain.test.ts', 'tests/header.test.ts', 'tests/preview.test.ts', 'tests/crossing.test.ts'], pool: 'forks', poolOptions: { forks: { singleFork: true } } } });
