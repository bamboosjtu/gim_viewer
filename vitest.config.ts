import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
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
