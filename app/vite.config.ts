import { defineConfig, loadEnv } from 'vite';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
export default defineConfig(({ mode }) => ({
  clearScreen: false,
  server: { strictPort: true, fs: { allow: ['..'] } },
  build: { target: 'chrome74', chunkSizeWarningLimit: 700 },
  worker: { format: 'iife' },
  plugins: [{ name: 'local-mobile-preview', configureServer(server) {
    // Development harness only. These routes are absent from production builds.
    const env = loadEnv(mode, resolve('..'), 'VITE_TIANDITU_KEY');
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__dev/')) { next(); return; }
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      try {
        if (req.url === '/__dev/settings') { res.end(JSON.stringify({ tiandituKey: env.VITE_TIANDITU_KEY ?? '', baseLayer: 'imagery' })); return; }
        if (req.url === '/__dev/samples') { const files = await readdir(resolve('../output/mobile-samples')); res.end(JSON.stringify(files.filter(f => /^line\d\d\.json$/.test(f)).map(f => f.slice(0, -5)))); return; }
        const match = req.url.match(/^\/__dev\/sample\/(line0[1-6])$/);
        if (match) { res.end(await readFile(resolve(`../output/mobile-samples/${match[1]}.json`))); return; }
        res.statusCode = 404; res.end('{}');
      } catch { res.statusCode = 404; res.end(JSON.stringify({ error: '尚未准备本地样本输入' })); }
    });
  } }],
}));
