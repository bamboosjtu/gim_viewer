import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'desktop');
const fragmentsPkgVersion = JSON.parse(
  readFileSync(resolve(desktop, 'node_modules/@thatopen/fragments/package.json'), 'utf-8'),
).version as string;
const webIfcPkgVersion = JSON.parse(
  readFileSync(resolve(desktop, 'node_modules/web-ifc/package.json'), 'utf-8'),
).version as string;

export default defineConfig({
  // 让一次性采集脚本位于仓库根 tmp/ 也能被 Vitest 纳入，不改动应用测试集合。
  root,
  define: {
    __FRAGMENTS_PKG_VERSION__: JSON.stringify(fragmentsPkgVersion),
    __WEB_IFC_PKG_VERSION__: JSON.stringify(webIfcPkgVersion),
  },
  resolve: {
    alias: {
      'three-bvh-csg': resolve(desktop, 'node_modules/three-bvh-csg/src/index.js'),
      '@desktop': resolve(desktop, 'bridge'),
      vitest: resolve(desktop, 'node_modules/vitest'),
    },
  },
  server: { fs: { allow: [root, desktop] } },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tmp/performance-characterization.test.ts'],
    setupFiles: [resolve(desktop, 'vitest.setup.ts')],
  },
});
