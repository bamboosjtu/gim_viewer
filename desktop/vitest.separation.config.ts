import { defineConfig } from 'vitest/config';

/** Phase-1 contracts against actual packages, independent of old goldens. */
export default defineConfig({test:{
  environment:'node',include:['acceptance/separation/**/*.test.ts'],
  poolOptions:{forks:{minForks:1,maxForks:1}},testTimeout:180_000,
}});
