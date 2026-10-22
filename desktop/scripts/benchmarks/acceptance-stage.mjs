/** Stage a verified native acceptance package in the Windows temp directory.
 * Directory-dependent startup is observed; its ACL cause is not established.
 * This copies only the verified package; it never edits ACLs or cache data. */
import {cpSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ACCEPTANCE_IDENTIFIER, directoryFingerprint, fileSha256, sourceFingerprint, windowsKnownFolder} from './acceptance-build.mjs';

export async function stageAcceptanceBuild(manifestPath) {
  manifestPath = resolve(manifestPath);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const build = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (build.profile !== 'native-release-acceptance' || build.identifier !== ACCEPTANCE_IDENTIFIER
    || build.executable !== 'GIM-Reader.exe') throw Error('Not an acceptance package');
  if (sourceFingerprint(root) !== build.sourceFingerprint) throw Error('Current source differs from this build');
  const source = dirname(manifestPath), executable = join(source, 'GIM-Reader.exe');
  const runtime = join(source, 'webview2-fixed-runtime');
  if (await fileSha256(executable) !== build.executableSha256
    || (await directoryFingerprint(runtime)).sha256 !== build.runtime.sha256) throw Error('Acceptance package hash mismatch');
  const destination = mkdtempSync(join(windowsKnownFolder('LocalApplicationData'), 'Temp', 'gim-native-acceptance-'));
  cpSync(executable, join(destination, 'GIM-Reader.exe'));
  cpSync(runtime, join(destination, 'webview2-fixed-runtime'), {recursive: true});
  // Leave the original manifest byte-for-byte intact; the probe checks the
  // relocated executable and complete runtime again before launching them.
  cpSync(manifestPath, join(destination, 'acceptance-build.json'));
  writeFileSync(join(destination, 'staging-receipt.json'), JSON.stringify({
    sourceManifest: manifestPath, stagedAt: new Date().toISOString(),
    sourceFingerprint: build.sourceFingerprint, executableSha256: build.executableSha256,
  }, null, 2));
  const staged = join(destination, 'acceptance-build.json');
  console.log(`[acceptance] Staged manifest: ${staged}`);
  return staged;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node scripts/benchmarks/acceptance-stage.mjs acceptance-build.json');
  stageAcceptanceBuild(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
}
