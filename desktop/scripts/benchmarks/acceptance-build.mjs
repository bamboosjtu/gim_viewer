/** Build a native Release with a separate data identity. No normal cache is
 * read, removed or relocated here. Native get_db_path must still verify the
 * actual cache root before a run can be accepted as isolated. */
import {createHash} from 'node:crypto';
import {createReadStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ACCEPTANCE_IDENTIFIER = 'com.bamboosjtu.gimviewer.acceptance';

export function verifyAcceptanceDatabasePath(databasePath, expectedRoot) {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath) || !isAbsolute(expectedRoot)) {
    throw Error('Acceptance database path must be an absolute native path');
  }
  const actual = resolve(databasePath), root = resolve(expectedRoot);
  if (actual.toLowerCase() !== join(root, 'gim_cache.db').toLowerCase()
    || root.split(/[\\/]/).pop()?.toLowerCase() !== ACCEPTANCE_IDENTIFIER) {
    throw Error('Native database is outside the dedicated acceptance root');
  }
  const realRoot = realpathSync(root), realDatabase = realpathSync(actual);
  if (realRoot.split(/[\\/]/).pop()?.toLowerCase() !== ACCEPTANCE_IDENTIFIER
    || realDatabase.toLowerCase() !== join(realRoot, 'gim_cache.db').toLowerCase()) {
    throw Error('Acceptance cache resolves outside its dedicated root');
  }
  const normal = join(dirname(root), 'com.bamboosjtu.gimviewer');
  if (existsSync(normal) && realpathSync(normal).toLowerCase() === realRoot.toLowerCase()) {
    throw Error('Acceptance cache resolves to the normal application cache');
  }
  return actual;
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {windowsHide: true, encoding: 'utf8', ...options});
  if (result.error || result.status !== 0) {
    throw Error(`${binary} failed (${result.status ?? 'not-started'}): ${result.error?.message ?? result.stderr ?? ''}`);
  }
  return result.stdout?.trim() ?? '';
}

export function sourceFingerprint(root) {
  const paths = new Set();
  for (const flags of [['--cached'], ['--others', '--exclude-standard']]) {
    const listing = command('git', ['ls-files', '-z', ...flags, '--', 'desktop', 'crates', 'packages'], {cwd: root});
    for (const name of listing.split('\0')) if (name && existsSync(join(root, name))) paths.add(name);
  }
  const hash = createHash('sha256');
  for (const name of [...paths].sort()) {
    const bytes = readFileSync(join(root, name));
    hash.update(`${name}\0${bytes.length}\0`); hash.update(bytes);
  }
  return hash.digest('hex');
}

export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function directoryFingerprint(root) {
  const hash = createHash('sha256'); let files = 0, bytes = 0;
  const visit = async directory => {
    for (const entry of readdirSync(directory, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        files++; hash.update(relative(root, path).replaceAll('\\', '/') + '\0');
        for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
      } else throw Error(`Unsupported runtime entry: ${path}`);
    }
  };
  await visit(root); return {sha256: hash.digest('hex'), files, bytes};
}

export function windowsKnownFolder(folder) {
  if (!['ApplicationData', 'LocalApplicationData'].includes(folder)) throw Error('Unsupported Known Folder');
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::${folder})`]);
}

export async function buildAcceptance(root) {
  if (process.platform !== 'win32') throw Error('Native acceptance build requires Windows');
  root = resolve(root);
  const desktop = join(root, 'desktop');
  const config = join(desktop, 'src-tauri', 'tauri.acceptance.conf.json');
  if (JSON.parse(readFileSync(config, 'utf8')).identifier !== ACCEPTANCE_IDENTIFIER) throw Error('Invalid acceptance identifier');
  const temporary = join(root, '.tmp', 'native-acceptance-build'); mkdirSync(temporary, {recursive: true});
  const env = {...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary};
  const head = command('git', ['rev-parse', 'HEAD'], {cwd: root});
  const dirty = Boolean(command('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd: root}));
  env.VITE_GIM_COMMIT = head + (dirty ? '-dirty' : '');
  // Preparation and beforeBuildCommand use the project's installed versions.
  for (const script of ['copy-web-ifc-wasm.mjs', 'prepare-webview2-fixed-runtime.mjs']) {
    command(process.execPath, [join(desktop, 'scripts', script)], {cwd: desktop, env, stdio: 'inherit'});
  }
  const fingerprint = sourceFingerprint(root);
  command(process.execPath, [join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build',
    '--config', join(desktop, 'src-tauri', 'tauri.portable.conf.json'), '--config', config, '--no-bundle', '--ci'],
    {cwd: desktop, env, stdio: 'inherit'});
  if (sourceFingerprint(root) !== fingerprint) throw Error('Source changed during acceptance build; no manifest published');
  const tag = new Date().toISOString().replaceAll(':', '-');
  const output = join(root, 'output', 'acceptance', 'builds', `${tag}-${fingerprint.slice(0,12)}`);
  mkdirSync(output, {recursive: true});
  const release = join(desktop, 'src-tauri', 'target', 'release');
  cpSync(join(release, 'gim-viewer.exe'), join(output, 'GIM-Reader.exe'));
  cpSync(join(desktop, 'src-tauri', 'webview2-fixed-runtime'), join(output, 'webview2-fixed-runtime'), {recursive: true});
  const knownFolder = windowsKnownFolder('ApplicationData');
  if (!isAbsolute(knownFolder)) throw Error('Windows roaming Known Folder unavailable');
  const manifest = {schemaVersion: 1, profile: 'native-release-acceptance', identifier: ACCEPTANCE_IDENTIFIER,
    commit: head, dirty, sourceFingerprint: fingerprint, createdAt: new Date().toISOString(),
    executable: 'GIM-Reader.exe', executableSha256: await fileSha256(join(output, 'GIM-Reader.exe')),
    runtime: await directoryFingerprint(join(output, 'webview2-fixed-runtime')),
    expectedDataRoot: join(knownFolder, ACCEPTANCE_IDENTIFIER), nativeCachePathVerified: false,
    expectedLocalDataRoot: join(windowsKnownFolder('LocalApplicationData'), ACCEPTANCE_IDENTIFIER),
    config: {identifier: ACCEPTANCE_IDENTIFIER, bundle: 'fixedRuntime', mode: 'release'},
  };
  const path = join(output, 'acceptance-build.json'); writeFileSync(path, JSON.stringify(manifest, null, 2));
  console.log(`[acceptance] Build manifest: ${path}`); return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAcceptance(resolve(dirname(fileURLToPath(import.meta.url)), '../../..')).catch(error => {
    console.error(error); process.exitCode = 1;
  });
}
