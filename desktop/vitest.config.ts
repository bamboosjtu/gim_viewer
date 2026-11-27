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
  // Shared package tests and contract fixtures are workspace sources outside desktop/.
  server: {fs: {allow: [resolve(__dirname, '..')]}},
  define: {
    __FRAGMENTS_PKG_VERSION__: JSON.stringify(fragmentsPkgVersion),
    __WEB_IFC_PKG_VERSION__: JSON.stringify(webIfcPkgVersion),
  },
  resolve: {
      conditions: ['gim-source', 'module', 'browser', 'development|production'],
    alias: {
      // three-bvh-csg 无 exports 字段，Node 环境会解析到 CJS UMD 构建
      // （依赖全局 THREE / 循环依赖导致 "Class extends value undefined"）。
      // 强制 vitest 走 ESM 源码入口，与 vite dev/build 行为一致。
      'three-bvh-csg': '/node_modules/three-bvh-csg/src/index.js',
      '@desktop': resolve(__dirname, 'bridge'),
      '@tests/sdk-source-fixtures': resolve(__dirname, '../packages/gim-sdk/tests/sourceFixtures.ts'),
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
    include: ['src/**/__tests__/**/*.test.ts', 'bridge/__tests__/**/*.test.ts', '../packages/powerline-core/src/**/__tests__/**/*.test.ts', '../packages/contracts-native/src/**/__tests__/**/*.test.ts', '../packages/gim-primitives/src/**/__tests__/**/*.test.ts', '../packages/measurement-core/src/**/__tests__/**/*.test.ts', ...(process.env.GIM_SDK_COVERAGE_OWNED ? [] : ['../packages/gim-sdk/src/**/__tests__/**/*.test.ts'])],
    // Native and private-sample suites use explicit local entry points.
    exclude: ['src/features/substation/runtime/__tests__/substationSqlite.integration.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text-summary', 'json-summary', 'json', 'html'],
      reportsDirectory: '../output/coverage/desktop',
      // 仅统计 src/ 下源码，排除测试文件、类型声明、入口装配
      include: ['src/**/*.ts', ...(process.env.GIM_SDK_COVERAGE_OWNED ? ['../packages/gim-sdk/src/**/*.ts'] : [])].map(pattern=>resolve(__dirname,pattern).replaceAll('\\','/')),
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        '../packages/gim-sdk/src/**/__tests__/**',
        'src/**/*.d.ts',
        'src/main.ts',
        'src/vite-env.d.ts',
      ].map(pattern=>resolve(__dirname,pattern).replaceAll('\\','/')),
      // Pure-layer gates are enforced by the normal unit suite, without GIM samples.
      thresholds: {
        'src/gim/**': { statements:90, lines:90, functions:90, branches:80 },
        'src/app/session/{openProject,projectSourceAcquisition}.ts': {statements:70,lines:70,functions:80,branches:50},
        'src/features/substation/application/{substationRuntime,substationOpenStages,substationColdPersistence,substationColdSource}.ts': {statements:70,lines:70,functions:45,branches:70},
        'src/features/substation/runtime/{patrolNavigationRuntime,patrolSceneCache,patrolSceneCompiler}.ts': {statements:65,lines:65,functions:70,branches:55},
        'src/gim/geometry/xmlModDocument.ts': {statements:85,lines:85,functions:85,branches:70},
        'src/services/presentation/viewerUIBinding.ts': {statements:80,lines:80,functions:50,branches:70},
        'src/ui/lineProjectView.ts': {statements:70,lines:70,functions:60,branches:65},
        'src/ui/{lineMapView,lineMapPainter,lineMapPointer,lineMapRenderer}.ts': {statements:65,lines:65,functions:65,branches:60},
      },
    },
  },
});
