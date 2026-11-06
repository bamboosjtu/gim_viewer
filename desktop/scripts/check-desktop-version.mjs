/** Desktop release metadata. package.json is the app/bundle version source;
 * Cargo and lock files must agree before any build or packaging work begins. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateDesktopVersions(versions) {
  const expected = versions['package.json'];
  if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(expected)) {
    throw Error('desktop/package.json 缺少有效的 SemVer 版本');
  }
  const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);
  if (mismatches.length) {
    throw Error(`桌面版本不一致（期望 ${expected}）：${mismatches.map(([file, version]) => `${file}=${version ?? '缺失'}`).join('，')}`);
  }
  return expected;
}

/** Tauri requires Rust and JS API major/minor compatibility, not equal patches. */
export function validateTauriRuntimeVersions(versions) {
  const rust = versions['Cargo.lock tauri'];
  const release = version => typeof version === 'string' ? version.match(/^(\d+\.\d+)\.\d+(?:[-+].*)?$/)?.[1] : undefined;
  const expected = release(rust);
  const mismatches = Object.entries(versions).filter(([, version]) => !expected || release(version) !== expected);
  if (mismatches.length) {
    throw Error(`Tauri Rust/API 主次版本不兼容（Rust=${rust ?? '缺失'}）：${mismatches.map(([file, version]) => `${file}=${version ?? '缺失'}`).join('，')}`);
  }
}

export function checkDesktopVersion(projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const json = path => JSON.parse(readFileSync(join(projectRoot, path), 'utf8'));
  const pkg = json('package.json'), lock = json('package-lock.json'), config = json('src-tauri/tauri.conf.json');
  const cargo = readFileSync(join(projectRoot, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoPackage = cargo.match(/^\[package\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
  const cargoLock = readFileSync(join(projectRoot, 'src-tauri/Cargo.lock'), 'utf8');
  const lockedPackage = cargoLock.split(/^\[\[package\]\]\s*$/m).find(block => /^name\s*=\s*"gim-viewer"\s*$/m.test(block)) ?? '';
  const version = text => text.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const appVersion = validateDesktopVersions({
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'tauri.conf.json': config.version === '../package.json' ? pkg.version : config.version,
    'Cargo.toml': version(cargoPackage),
    'Cargo.lock gim-viewer': version(lockedPackage),
  });
  const tauriPackage = cargoLock.split(/^\[\[package\]\]\s*$/m).find(block => /^name\s*=\s*"tauri"\s*$/m.test(block)) ?? '';
  const installedApi = join(projectRoot, 'node_modules/@tauri-apps/api/package.json');
  validateTauriRuntimeVersions({
    'Cargo.lock tauri': version(tauriPackage),
    'package-lock.json @tauri-apps/api': lock.packages?.['node_modules/@tauri-apps/api']?.version,
    ...(existsSync(installedApi) ? { 'node_modules @tauri-apps/api': JSON.parse(readFileSync(installedApi, 'utf8')).version } : {}),
  });
  return appVersion;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`[desktop version] ${checkDesktopVersion()} · 应用清单一致，Tauri Rust/API 主次版本兼容`); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
