import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 与 vite.config 保持一致：注入实际安装版本（features.test 依赖）
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
    alias: {
      // three-bvh-csg 无 exports 字段，Node 环境会解析到 CJS UMD 构建
      // （依赖全局 THREE / 循环依赖导致 "Class extends value undefined"）。
      // 强制 vitest 走 ESM 源码入口，与 vite dev/build 行为一致。
      'three-bvh-csg': '/node_modules/three-bvh-csg/src/index.js',
      '@desktop': resolve(__dirname, 'bridge'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // selectionInteraction 的 5 s 超时在默认高并发下会因 CPU 抢占偶发超时；
    // 限制并发 fork 数，保持断言与超时不变（不是用更长 timeout 掩盖）。
    poolOptions: {
      forks: { minForks: 1, maxForks: 2 },
    },
    include: ['src/**/__tests__/**/*.test.ts', 'bridge/__tests__/**/*.test.ts'],
    // Native and private-sample suites use explicit local entry points.
    exclude: ['src/services/__tests__/substationSqlite.integration.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      // 覆盖率配置（review0709.md §4.3：原项目未安装覆盖率工具，无法量化行/分支覆盖）
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: '../output/coverage',
      // 仅统计 src/ 下源码，排除测试文件、类型声明、入口装配
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        'src/main.ts',
        'src/vite-env.d.ts',
      ],
      // Pure-layer gates are enforced by the normal unit suite, without GIM samples.
      thresholds: {
        'src/engineering/**': { statements:95, lines:95, functions:95, branches:90 },
        'src/gim/**': { statements:90, lines:90, functions:90, branches:80 },
      },
    },
  },
});
