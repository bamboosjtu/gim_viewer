import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// P2 评审 #7：读取实际安装版本（node_modules 内 package.json 的精确版本号）
const fragmentsPkgVersion = JSON.parse(
  readFileSync('./node_modules/@thatopen/fragments/package.json', 'utf-8'),
).version as string;
const webIfcPkgVersion = JSON.parse(
  readFileSync('./node_modules/web-ifc/package.json', 'utf-8'),
).version as string;

export default defineConfig(({ mode }) => {
  // npm 命令约定从 desktop/ 执行，但项目级配置文件位于仓库根目录。
  // 统一 envDir 后，根目录 .env 中的 VITE_* 变量在 dev/build 两条路径中
  // 都能被读取；同时兼容早期 desktop/.env 使用的 TIANDITU_APIKEY 命名，
  // 避免用户已经配置 Key 却被静默判定为“未配置”。
  const envRoot = resolve(__dirname, '..');
  const rootEnv = loadEnv(mode, envRoot, '');
  const desktopEnv = loadEnv(mode, __dirname, '');
  const tiandituKey = [
    rootEnv.VITE_TIANDITU_KEY,
    desktopEnv.VITE_TIANDITU_KEY,
    desktopEnv.TIANDITU_APIKEY,
    rootEnv.TIANDITU_APIKEY,
  ]
    .map((value) => String(value ?? '').trim())
    .find(Boolean) ?? '';

  return {
    clearScreen: false,
    // Vite 默认以 process.cwd()（desktop/）为 envDir；这里显式指向仓库根，
    // 让根目录 .env 成为文档和实际行为一致的唯一推荐位置。
    envDir: envRoot,
    // P2 评审 #7：注入实际安装版本（package.json 依赖声明是 semver 范围，补丁
    // 升级不改变范围字符串；Fragments 缓存键必须随实际安装版本变化）
    define: {
      __FRAGMENTS_PKG_VERSION__: JSON.stringify(fragmentsPkgVersion),
      __WEB_IFC_PKG_VERSION__: JSON.stringify(webIfcPkgVersion),
      // 只映射天地图这一项；不把 desktop/.env 中的其它非 VITE 变量暴露到前端。
      'import.meta.env.VITE_TIANDITU_KEY': JSON.stringify(tiandituKey),
    },
    resolve: {
      alias: {
        '@desktop': resolve(__dirname, 'bridge'),
      },
    },
    server: {
      port: 14317,
      host: true,
      strictPort: true,
      watch: {
        // 排除大目录，避免 chokidar 扫描 11 万 demo 文件阻塞事件循环
        ignored: ['**/demo/**', '**/dist/**', '**/src-tauri/target/**', '**/docs/**', '**/.agents/**'],
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
      // 重依赖（three 1.5MB / maplibre 1MB / web-ifc 3.6MB）已按工程类型拆分且
      // 仅在对应分支动态加载（P2 评审 #6），单 chunk 体积是预期行为，非首屏负载。
      // 阈值放宽至 2MB，超出仍会告警。
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;

            if (id.includes('@thatopen/components') || id.includes('@thatopen/fragments')) {
              return 'thatopen';
            }

            // acc-plan P2-2：按工程类型拆分重依赖，避免单一大 vendor 全量加载
            // - 变电路径：three / camera-controls（3D 视角控制）
            // - 线路路径：maplibre / pmtiles（地图底图）
            // 两类工程互不加载对方的重依赖
            if (id.includes('camera-controls')) {
              return 'camera-controls';
            }

            if (id.includes('maplibre')) {
              return 'maplibre';
            }

            if (id.includes('pmtiles')) {
              return 'pmtiles';
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
  };
});
