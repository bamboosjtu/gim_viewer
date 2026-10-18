import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Opt-in runtime prototypes: keep object-fine identity/lifecycle checks
// available without including them in routine production regression.
export default defineConfig({ ...base, test: { ...base.test,
  exclude: [],
  include: [
    'src/viewer/__tests__/ifcObjectFine.test.ts',
  ],
} });
