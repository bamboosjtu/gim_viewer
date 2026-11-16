import { defineConfig } from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({server:{fs:{allow:[fileURLToPath(new URL('..',import.meta.url))]}}, test: { setupFiles:['vitest.setup.ts'], include: ['src/**/__tests__/**/*.test.ts', '../packages/powerline-core/src/**/__tests__/**/*.test.ts'], pool: 'forks', poolOptions: { forks: { singleFork: true } } } });
