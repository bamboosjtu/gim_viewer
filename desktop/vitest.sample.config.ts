import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 样本回归专用配置：仅运行 sampleRegression.test.ts（P2 评审 #7 测试分层）。
// 独立定义而非 mergeConfig——mergeConfig 会拼接 include 数组导致全部用例仍被运行。

const fragmentsPkgVersion = JSON.parse(
  readFileSync('./node_modules/@thatopen/fragments/package.json', 'utf-8'),
).version as string;
const webIfcPkgVersion = JSON.parse(
  readFileSync('./node_modules/web-ifc/package.json', 'utf-8'),
).version as string;

export default defineConfig({
  define: {
    __FRAGMENTS_PKG_VERSION__: JSON.stringify(fragmentsPkgVersion),
    __WEB_IFC_PKG_VERSION__: JSON.stringify(webIfcPkgVersion),
  },
  resolve: {
    // three-bvh-csg 无 exports 字段，Node 环境会解析到 CJS UMD 构建（同主配置）
    alias: {
      'three-bvh-csg': '/node_modules/three-bvh-csg/src/index.js',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/gim/__tests__/sampleRegression.test.ts', 'bridge/__tests__/**/*.test.ts'],
  },
});
