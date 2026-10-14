import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Opt-in runtime prototypes: keep their identity/lifecycle checks available
// without including them in routine production regression.
export default defineConfig({ ...base, test: { ...base.test,
  exclude: [],
  include: [
    'src/viewer/__tests__/ifcPreview.test.ts',
    'src/viewer/__tests__/ifcPreviewInstances.test.ts',
    'src/viewer/__tests__/ifcObjectFine.test.ts',
    'src/services/__tests__/ifcPreviewSelection.test.ts',
    'src/services/__tests__/ifcPreviewQueue.test.ts',
  ],
} });
