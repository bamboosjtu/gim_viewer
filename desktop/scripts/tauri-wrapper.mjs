/**
 * Tauri CLI 包装脚本（dev / build 通用）。
 *
 * 将 Tauri CLI 的临时目录（%TEMP%\.tauri）重定向到工作区内的 .tmp 目录，
 * 避免 bundle 过程的临时文件（NSIS 编译、资源复制、图标转换等）污染系统盘。
 *
 * 原理：Tauri CLI 使用 std::env::temp_dir() 创建临时工作目录，
 * Windows 上读取优先级 TMP > TEMP > USERPROFILE，Unix 上读取 TMPDIR。
 * 设置这些环境变量即可重定向到工作区内。
 *
 * 用法：
 *   node scripts/tauri-wrapper.mjs build   → tauri build
 *   node scripts/tauri-wrapper.mjs dev     → tauri dev
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

const tmpDir = resolve(projectRoot, '.tmp');
mkdirSync(tmpDir, { recursive: true });

const env = {
  ...process.env,
  TMP: tmpDir,
  TEMP: tmpDir,
  TMPDIR: tmpDir,
};

const subcommand = process.argv[2] || 'build';
const extraArgs = process.argv.slice(3);
const buildConfigArgs = subcommand === 'build'
  ? ['--config', resolve(projectRoot, 'src-tauri', 'tauri.portable.conf.json')]
  : [];

const result = spawnSync('npx', ['tauri', subcommand, ...buildConfigArgs, ...extraArgs], {
  stdio: 'inherit',
  env,
  shell: true,
});

process.exit(result.status ?? 1);
