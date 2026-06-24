import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    host: true,
    strictPort: true,
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
