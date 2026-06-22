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
    include: ['src/**/__tests__/**/*.test.ts', 'bridge/__tests__/**/*.test.ts'],
    // P2 评审 #7 测试分层：真实样本回归拆至 vitest.sample.config.ts（npm run test:sample），
    // 默认套件保持快速反馈
    exclude: ['src/gim/__tests__/sampleRegression.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      // 覆盖率配置（review0709.md §4.3：原项目未安装覆盖率工具，无法量化行/分支覆盖）
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      // 仅统计 src/ 下源码，排除测试文件、类型声明、入口装配
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        'src/main.ts',
        'src/vite-env.d.ts',
      ],
      // 阈值：先量化后补测，暂不强制失败，避免阻塞现有流程
      // 待覆盖率达到稳定基线后再启用 thresholds
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});
