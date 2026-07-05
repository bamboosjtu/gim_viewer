import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 14317,
    host: true,
    strictPort: true,
    watch: {
      // 排除大目录，避免 chokidar 扫描 11 万 demo 文件阻塞事件循环
      ignored: ['**/demo/**', '**/dist/**', '**/src-tauri/target/**', '**/docs/**', '**/.trae/**'],
    },
  },
  optimizeDeps: {
    include: [
      'three',
      'web-ifc',
      '@thatopen/components',
      '@thatopen/fragments',
      'libarchive.js',
    ],
  },
  assetsInclude: ['**/*.gim'],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (id.includes('@thatopen/components') || id.includes('@thatopen/fragments')) {
            return 'thatopen';
          }

          if (id.includes('three')) {
            return 'three';
          }

          if (id.includes('web-ifc')) {
            return 'web-ifc';
          }

          if (id.includes('libarchive.js')) {
            return 'libarchive';
          }

          return 'vendor';
        },
      },
    },
  },
});
