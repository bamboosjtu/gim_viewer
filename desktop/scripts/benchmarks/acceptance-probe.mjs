import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ACCEPTANCE_IDENTIFIER, directoryFingerprint, fileSha256, sourceFingerprint, verifyAcceptanceDatabasePath, windowsKnownFolder} from './acceptance-build.mjs';

export function classifyNativeStartup(log, exitCode) {
  const gpuLaunchErrorCodes = [...new Set([...log.matchAll(/GPU process launch failed: error_code=(\d+)/g)].map(match => Number(match[1])))];
  if (gpuLaunchErrorCodes.length && log.includes("GPU process isn't usable")) {
    return {stage: 'webview-gpu-process-launch', gpuLaunchErrorCodes, reason: 'WebView browser terminated after GPU process launch failures'};
  }
  if (/Failed to setup app:.*(?:os error 5|Access is denied|拒绝访问)/.test(log)) {
    return {stage: 'native-setup', reason: 'Native setup reported access denied'};
  }
  return {stage: exitCode == null ? 'native-startup-timeout' : 'native-process-exit', reason: 'Native application did not reach a verified frontend'};
}

function tail(path, limit = 64 * 1024) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size, bytes = Buffer.alloc(Math.min(size, limit)), fd = openSync(path, 'r');
  try { readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString('utf8'); }
  finally { closeSync(fd); }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

/** Read one known command from our own Tauri frontend; no UI action, source
 * authorization, file picker substitution or geometry request is performed. */
async function nativeDatabasePath(target, port) {
  const address = new URL(target.webSocketDebuggerUrl);
  if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || Number(address.port) !== port) {
    throw Error('CDP target is outside the owned loopback endpoint');
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(Error('Native cache path query timed out')), 5000);
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { socket.close(); } catch { /* A failed connection has no usable socket. */ }
      error ? reject(error) : resolve(value);
    };
    socket.addEventListener('error', () => finish(Error('Native CDP socket failed')));
    socket.addEventListener('open', () => socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {
      expression: "globalThis.__TAURI_INTERNALS__?.invoke('get_db_path')", awaitPromise: true, returnByValue: true,
    }})));
    socket.addEventListener('message', event => {
      let data; try { data = JSON.parse(event.data); } catch { finish(Error('Invalid native CDP response')); return; }
      if (data.id !== 1) return;
      if (data.error || data.result?.exceptionDetails) finish(Error('Native get_db_path failed'));
      else finish(null, data.result?.result?.value);
    });
  });
}

async function stopOwnedProcess(child) {
  if (!child.pid) return true;
  if (child.exitCode != null || child.signalCode != null) return true;
  // PID belongs to this still-live ChildProcess. Each run also owns a unique
  // WebView profile; no process-name-wide shutdown is used.
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, encoding: 'utf8'});
  if (child.exitCode != null || child.signalCode != null) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

export async function probeAcceptance(manifestPath, timeoutMs = 30000) {
  if (process.platform !== 'win32') throw Error('Native acceptance requires Windows');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  manifestPath = resolve(manifestPath);
  const build = JSON.parse(readFileSync(manifestPath, 'utf8')), folder = dirname(manifestPath);
  if (build.identifier !== ACCEPTANCE_IDENTIFIER || build.profile !== 'native-release-acceptance') throw Error('Not an acceptance build');
  const expected = join(windowsKnownFolder('ApplicationData'), ACCEPTANCE_IDENTIFIER);
  const local = join(windowsKnownFolder('LocalApplicationData'), ACCEPTANCE_IDENTIFIER);
  if (resolve(build.expectedDataRoot).toLowerCase() !== expected.toLowerCase()) throw Error('Acceptance Known Folder differs from manifest');
  if (sourceFingerprint(root) !== build.sourceFingerprint) throw Error('Current source fingerprint differs from this build');
  const executable = join(folder, 'GIM-Reader.exe'), runtime = join(folder, 'webview2-fixed-runtime');
  if (await fileSha256(executable) !== build.executableSha256 || (await directoryFingerprint(runtime)).sha256 !== build.runtime.sha256) {
    throw Error('Acceptance executable/runtime hash mismatch');
  }
  const run = join(root, 'output', 'acceptance', 'runs', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(run, {recursive: true}); mkdirSync(expected, {recursive: true}); mkdirSync(local, {recursive: true});
  const profile = join(run, 'webview-profile'); mkdirSync(profile);
  const port = await unusedPort(), browserLog = join(run, 'webview-startup.log');
  const env = {...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: runtime,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --enable-logging --log-file="${browserLog}" --v=1`};
  const started = performance.now(), child = spawn(executable, [], {cwd: folder, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const output = {stdout: '', stderr: ''};
  for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => { output[name] = (output[name] + bytes.toString('utf8')).slice(-65536); });
  let spawnError = null; child.on('error', error => { spawnError = error.message; });
  let verifiedPath = null, endpointError = null, startup = null;
  try {
    while (performance.now() - started < timeoutMs && child.exitCode == null && !spawnError) {
      const browserTail = tail(browserLog);
      if (browserTail.includes("GPU process isn't usable")) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(1000)});
        if (!response.ok) throw Error(`CDP HTTP ${response.status}`);
        const targets = (await response.json()).filter(target => {
          if (target.type !== 'page') return false;
          try { const url = new URL(target.url); return url.hostname === 'tauri.localhost' || url.protocol === 'tauri:' && url.hostname === 'localhost'; }
          catch { return false; }
        });
        if (targets.length !== 1) throw Error(`Expected one native Tauri page, found ${targets.length}`);
        const database = await nativeDatabasePath(targets[0], port);
        if (typeof database !== 'string') throw Error('Native IPC is not ready');
        verifiedPath = verifyAcceptanceDatabasePath(database, expected);
        endpointError = null;
        startup = {stage: 'native-ipc-ready', reason: 'Native database path verified'}; break;
      } catch (error) { endpointError = error.message; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally {
    const nativeExitCode = child.exitCode, nativeSignal = child.signalCode;
    const elapsedMs = Math.round(performance.now() - started), cleanupComplete = await stopOwnedProcess(child);
    for (const [name, value] of Object.entries(output)) writeFileSync(join(run, `native.${name}.log`), value);
    const failure = classifyNativeStartup(output.stderr + tail(browserLog), nativeExitCode);
    const result = {schemaVersion: 1, kind: 'native-startup-preflight', buildManifest: manifestPath,
      sourceFingerprint: build.sourceFingerprint, executableSha256: build.executableSha256,
      pid: child.pid ?? null, executable, runtime, workingDirectory: folder, webviewProfile: profile,
      elapsedMs, outcome: verifiedPath ? 'ready' : 'failed',
      nativeCachePathVerified: Boolean(verifiedPath), databasePath: verifiedPath,
      nativeExitCode, nativeSignal, spawnError, endpointError, cleanupComplete,
      ...(startup ?? failure), stationPerformanceAccepted: false};
    writeFileSync(join(run, 'native-startup.json'), JSON.stringify(result, null, 2));
    console.log(`[acceptance] Native preflight: ${join(run, 'native-startup.json')}`);
    if (!verifiedPath || !cleanupComplete) throw Error(`Native preflight failed at ${result.stage}; cleanup=${cleanupComplete}`);
  }
  return run;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node scripts/benchmarks/acceptance-probe.mjs acceptance-build.json');
  probeAcceptance(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
}
