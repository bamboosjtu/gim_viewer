/**
 * 准备 Windows portable 构建所需的 WebView2 Fixed Version Runtime。
 *
 * 来源优先级：
 * 1. 已准备好的 src-tauri/webview2-fixed-runtime
 * 2. WEBVIEW2_FIXED_RUNTIME_DIR 指向的已解压目录
 * 3. WEBVIEW2_FIXED_RUNTIME_CAB 指向的微软 Fixed Runtime CAB
 * 4. 从微软 WebView2 官方下载页解析并下载最新 x64 CAB
 *
 * 运行时是构建输入但不提交仓库；下载的 CAB 缓存在 .tmp/webview2/。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, cpSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const runtimeDir = resolve(projectRoot, 'src-tauri', 'webview2-fixed-runtime');
const cacheDir = resolve(projectRoot, '.tmp', 'webview2');
const extractDir = resolve(cacheDir, 'extracted');
const downloadPage = 'https://developer.microsoft.com/en-us/microsoft-edge/webview2/';

function assertInsideWorkspace(target) {
  const rel = relative(projectRoot, resolve(target));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`拒绝操作工作区外路径: ${target}`);
  }
}

function validateRuntime(dir) {
  const required = ['msedgewebview2.exe', 'msedge.dll', 'icudtl.dat', 'resources.pak'];
  return required.every((name) => existsSync(join(dir, name)));
}

function copyRuntime(sourceDir) {
  const source = resolve(sourceDir);
  if (!validateRuntime(source)) {
    throw new Error(`WebView2 Runtime 目录不完整（缺少核心文件）: ${source}`);
  }
  if (source === runtimeDir) return;
  assertInsideWorkspace(runtimeDir);
  rmSync(runtimeDir, { recursive: true, force: true });
  cpSync(source, runtimeDir, { recursive: true });
}

function findRuntimeRoot(root) {
  if (validateRuntime(root)) return root;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readDirectoryEntries(current)) {
      if (!entry.isDirectory()) continue;
      const child = join(current, entry.name);
      if (validateRuntime(child)) return child;
      stack.push(child);
    }
  }
  return null;
}

function readDirectoryEntries(dir) {
  // 延迟导入样式会让异常栈难读；在这里集中处理不存在/无权限目录。
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function resolveOfficialCabUrl() {
  const override = process.env.WEBVIEW2_FIXED_RUNTIME_URL?.trim();
  if (override) return override;

  console.log('[WebView2] 正在查询微软官方最新 x64 Fixed Runtime...');
  const response = await fetch(downloadPage, { redirect: 'follow' });
  if (!response.ok) throw new Error(`无法访问微软 WebView2 下载页: HTTP ${response.status}`);
  const html = (await response.text())
    .replaceAll('\\u002F', '/')
    .replaceAll('\\u003A', ':')
    .replaceAll('\\u002E', '.');
  const matches = [...html.matchAll(/https:\/\/[^"'\\\s]+\/Microsoft\.WebView2\.FixedVersionRuntime\.([0-9.]+)\.x64\.cab/g)];
  if (matches.length === 0) {
    throw new Error(`微软下载页未返回 x64 Fixed Runtime。请手动下载 CAB 并设置 WEBVIEW2_FIXED_RUNTIME_CAB。\n${downloadPage}`);
  }
  matches.sort((a, b) => compareVersions(b[1], a[1]));
  return matches[0][0];
}

function compareVersions(a, b) {
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function downloadCab(url) {
  mkdirSync(cacheDir, { recursive: true });
  const fileName = decodeURIComponent(basename(new URL(url).pathname));
  const cabPath = join(cacheDir, fileName);
  if (existsSync(cabPath)) {
    console.log(`[WebView2] 复用已下载 CAB: ${cabPath}`);
    return cabPath;
  }

  const partialPath = `${cabPath}.partial`;
  assertInsideWorkspace(partialPath);
  console.log(`[WebView2] 下载 ${fileName}（约 250-300MB，仅首次构建需要）...`);
  const download = spawnSync('curl.exe', [
    '--fail',
    '--location',
    '--retry', '3',
    '--retry-delay', '2',
    '--continue-at', '-',
    '--output', partialPath,
    url,
  ], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (download.status !== 0) {
    throw new Error(`WebView2 CAB 下载失败，curl 退出码 ${download.status}`);
  }
  renameSync(partialPath, cabPath);
  return cabPath;
}

function extractCab(cabPath) {
  assertInsideWorkspace(extractDir);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  console.log(`[WebView2] 解压 ${basename(cabPath)}...`);
  const result = spawnSync('expand.exe', [resolve(cabPath), '-F:*', extractDir], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`expand.exe 解压失败，退出码 ${result.status}`);
  const root = findRuntimeRoot(extractDir);
  if (!root) throw new Error(`CAB 解压后未找到完整 WebView2 Runtime: ${extractDir}`);
  copyRuntime(root);
}

async function main() {
  if (validateRuntime(runtimeDir)) {
    console.log(`[WebView2] Fixed Runtime 已就绪: ${runtimeDir}`);
    return;
  }

  const sourceDir = process.env.WEBVIEW2_FIXED_RUNTIME_DIR?.trim();
  if (sourceDir) {
    console.log(`[WebView2] 从 WEBVIEW2_FIXED_RUNTIME_DIR 复制运行时: ${sourceDir}`);
    copyRuntime(sourceDir);
  } else {
    const configuredCab = process.env.WEBVIEW2_FIXED_RUNTIME_CAB?.trim();
    const cabPath = configuredCab
      ? resolve(configuredCab)
      : await downloadCab(await resolveOfficialCabUrl());
    if (!existsSync(cabPath)) throw new Error(`找不到 WebView2 CAB: ${cabPath}`);
    extractCab(cabPath);
  }

  if (!validateRuntime(runtimeDir)) throw new Error(`WebView2 Fixed Runtime 准备失败: ${runtimeDir}`);
  const versionMatch = /FixedVersionRuntime\.([0-9.]+)\./.exec(
    process.env.WEBVIEW2_FIXED_RUNTIME_CAB ?? process.env.WEBVIEW2_FIXED_RUNTIME_URL ?? '',
  );
  writeFileSync(join(runtimeDir, '.gim-viewer-runtime.json'), JSON.stringify({
    preparedAt: new Date().toISOString(),
    version: versionMatch?.[1] ?? null,
    architecture: 'x64',
  }, null, 2));
  console.log(`[WebView2] Fixed Runtime 准备完成: ${runtimeDir}`);
}

main().catch((error) => {
  console.error(`[WebView2] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
