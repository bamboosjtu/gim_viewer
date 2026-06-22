/**
 * 将 Tauri release exe 与 Fixed WebView2 Runtime 组装为可搬运目录和 ZIP。
 * portable 不是单文件：WebView2 Runtime 目录必须和 exe 保持相对位置。
 */
import { createHash } from 'node:crypto';
import { createReadStream, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const releaseDir = resolve(projectRoot, 'src-tauri', 'target', 'release');
const sourceExe = join(releaseDir, 'gim-viewer.exe');
const sourceRuntime = join(releaseDir, 'webview2-fixed-runtime');
const portableRoot = join(releaseDir, 'bundle', 'portable');
const folderName = `GIM-Reader_${packageJson.version}_x64_portable`;
const outputDir = join(portableRoot, folderName);
const outputZip = join(portableRoot, `${folderName}.zip`);

function assertInsideWorkspace(target) {
  const rel = relative(projectRoot, resolve(target));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`拒绝操作工作区外路径: ${target}`);
}

function validateRuntime(dir) {
  return ['msedgewebview2.exe', 'msedge.dll', 'icudtl.dat', 'resources.pak']
    .every((name) => existsSync(join(dir, name)));
}

function walkStats(root) {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) {
        files++;
        bytes += statSync(fullPath).size;
      }
    }
  }
  return { files, bytes };
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  if (!existsSync(sourceExe)) throw new Error(`Tauri release exe 不存在: ${sourceExe}`);
  if (!validateRuntime(sourceRuntime)) {
    throw new Error(`release 目录未包含完整 WebView2 Fixed Runtime，拒绝生成伪 portable 包: ${sourceRuntime}`);
  }

  assertInsideWorkspace(outputDir);
  assertInsideWorkspace(outputZip);
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(outputZip, { force: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(sourceExe, join(outputDir, 'GIM-Reader.exe'));
  cpSync(sourceRuntime, join(outputDir, 'webview2-fixed-runtime'), { recursive: true });

  const runtimeStats = walkStats(join(outputDir, 'webview2-fixed-runtime'));
  const manifest = {
    product: 'GIM 阅读器',
    version: packageJson.version,
    architecture: 'x64',
    portable: true,
    executable: 'GIM-Reader.exe',
    webview2: {
      mode: 'fixedRuntime',
      directory: 'webview2-fixed-runtime',
      files: runtimeStats.files,
      bytes: runtimeStats.bytes,
    },
  };
  writeFileSync(join(outputDir, 'portable-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outputDir, '使用说明.txt'), [
    'GIM 阅读器 portable 版',
    '',
    '1. 请完整解压 ZIP，不能只复制 GIM-Reader.exe。',
    '2. 双击 GIM-Reader.exe 运行，无需安装 WebView2 Runtime。',
    '3. webview2-fixed-runtime 文件夹必须和 exe 位于同一目录。',
    '4. 首次启动会初始化随包运行时的读取权限，可能比后续启动稍慢。',
    '5. 不支持直接从网络共享/UNC 路径运行，请先复制到本机磁盘。',
    '',
  ].join('\r\n'));

  console.log(`[portable] 正在压缩 ${folderName}.zip...`);
  const tar = spawnSync('tar.exe', ['-a', '-c', '-f', outputZip, '-C', portableRoot, folderName], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (tar.status !== 0 || !existsSync(outputZip)) throw new Error(`portable ZIP 生成失败，tar 退出码 ${tar.status}`);

  const zipHash = await sha256(outputZip);
  writeFileSync(`${outputZip}.sha256`, `${zipHash}  ${folderName}.zip\r\n`);
  console.log(`[portable] 目录: ${outputDir}`);
  console.log(`[portable] ZIP: ${outputZip}`);
  console.log(`[portable] SHA256: ${zipHash}`);
}

main().catch((error) => {
  console.error(`[portable] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
