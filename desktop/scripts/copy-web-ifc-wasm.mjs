/**
 * 从 node_modules/web-ifc 复制 WASM 文件到 public/wasm/
 * 在 dev/build/tauri:dev/tauri:build 前自动执行（通过 npm pre* hooks）
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

const require = createRequire(import.meta.url);
// web-ifc 的 exports 不暴露 ./package.json，通过主入口定位目录
const webIfcEntryPath = require.resolve('web-ifc');
const webIfcDir = dirname(webIfcEntryPath);

const targetDir = join(projectRoot, 'public', 'wasm');
mkdirSync(targetDir, { recursive: true });

const filesToCopy = [
  { src: 'web-ifc.wasm', dest: 'web-ifc.wasm' },
  { src: 'web-ifc-mt.wasm', dest: 'web-ifc-mt.wasm' },
];

for (const { src, dest } of filesToCopy) {
  const srcPath = join(webIfcDir, src);
  const destPath = join(targetDir, dest);

  if (!existsSync(srcPath)) {
    // web-ifc-mt.wasm 可选，缺失时跳过；web-ifc.wasm 必须存在
    if (src === 'web-ifc.wasm') {
      throw new Error(`[copy-web-ifc-wasm] 找不到必需的 WASM 文件: ${srcPath}`);
    }
    console.log(`[copy-web-ifc-wasm] 跳过可选文件 (不存在): ${srcPath}`);
    continue;
  }

  const srcSize = statSync(srcPath).size;
  copyFileSync(srcPath, destPath);
  console.log(`[copy-web-ifc-wasm] ${src} -> public/wasm/${dest} (${srcSize} bytes)`);
}

console.log('[copy-web-ifc-wasm] 完成');
