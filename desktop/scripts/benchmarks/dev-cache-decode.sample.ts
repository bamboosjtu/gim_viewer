/** Manual, paired CPU benchmark on real L0 artifacts. No native IPC, drawing or
 * station-open timing is inferred. Run from desktop with the adjacent config. */
import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { buildCbmTree } from '../../src/gim/cbmParser.js';
import { collectCbmDeviceInstances } from '../../src/services/modAutoLoadService.js';
import { serializeDevToGlbDetailed, parseDevGlbAsset } from '../../src/services/glbCacheService.js';
import { parseWorkerXmlMod } from '../../src/gim/geometry/xmlModWorkerParser.js';
import { DEV_GEOMETRY_VERSION } from '../../src/services/devSpatialCatalog.js';
import { disposeSharedXmlModGeometries, disposeSharedXmlModMaterials } from '../../src/viewer/xmlModGeometry.js';
import { parseBatchCachePayload } from '../../bridge/database.js';
import { packDevArtifact, unpackDevArtifact } from '../../bridge/devLodCache.js';

const samples = [
  ['substation01', 'demo-substation', '711259814db95999f5282af1871da9cb50db4548b71626637b33038b062fc390'],
  ['substation02', 'substation02', 'a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29'],
  ['substation03', 'substation03', '3197c03ef2c6c423cbb85447f71491a4112db0f9a8cea0c9f72f0b410b8175ab'],
  ['substation04', 'substation04', '00b7746d5ea6ab3b92c215c1e42ffc7eec5a9f0517c1c555fa27a596d4d800dc'],
] as const;
const output = resolve('../output/parse-reuse');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function filesIn(root: string): Map<string, File> {
  const files = new Map<string, File>();
  const walk = (dir: string, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name, full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, path + '/');
      else files.set(path, { name: entry.name, size: statSync(full).size,
        text: async () => readFileSync(full, 'utf8'),
        arrayBuffer: async () => new Uint8Array(readFileSync(full)).buffer,
      } as File);
    }
  };
  walk(root); return files;
}
interface Fixture { key: string; path: string; artifact: Uint8Array; sha: string | null }
function envelope(fixtures: Fixture[]): Uint8Array {
  const encoder = new TextEncoder(), paths = fixtures.map(row => encoder.encode(`templates/${row.key}`));
  const bytes = new Uint8Array(57 + fixtures.reduce((n, row, i) => n + 13 + paths[i].length + row.artifact.length, 0));
  bytes.set(encoder.encode('GIMR')); bytes[4] = 2;
  const view = new DataView(bytes.buffer); view.setUint32(5, fixtures.length, true);
  view.setBigUint64(41, BigInt(fixtures.reduce((n, row) => n + row.artifact.length, 0)), true);
  view.setUint32(49, fixtures.length, true);
  let offset = 57;
  for (let i = 0; i < fixtures.length; i++) {
    const path = paths[i], artifact = fixtures[i].artifact;
    view.setUint32(offset, path.length, true); offset += 4;
    bytes.set(path, offset); offset += path.length; bytes[offset++] = 1;
    view.setBigUint64(offset, BigInt(artifact.length), true); offset += 8;
    bytes.set(artifact, offset); offset += artifact.length;
  }
  return bytes;
}
function decode(payload: Uint8Array, borrow: boolean): any[] {
  return parseBatchCachePayload(payload, { copyBytes: !borrow }).items.map(row =>
    unpackDevArtifact(row.entry_path.slice('templates/'.length), row.bytes!));
}
function quantile(values: number[], p: number) { return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]; }
function summary(values: number[]) { return { p50: quantile(values, .5), p95: quantile(values, .95), max: Math.max(...values) }; }

for (const [sample, directory, sha] of samples) it(`${sample}: real L0 ownership, geometry and paired cache decoding`, async () => {
  mkdirSync(output, { recursive: true });
  const root = resolve('../demo', directory);
  expect(existsSync(root), `${sample} extracted directory is required`).toBe(true);
  expect(digest(readFileSync(resolve('../demo', `${sample}.gim`)))).toBe(sha);
  expect(readFileSync(join(root, '.gim-source.sha256'), 'utf8').trim()).toBe(sha);
  const files = filesIn(root), tree = await buildCbmTree(files), instances = collectCbmDeviceInstances(tree);
  const paths = [...new Set(instances.map(row => row.devPath.replace(/\\/g, '/')))]
    .map(path => /^dev\//i.test(path) ? path : `DEV/${path}`).sort();
  expect(paths.length).toBeGreaterThan(0);
  const bySize = [...paths].sort((a, b) => (files.get(b)?.size ?? 0) - (files.get(a)?.size ?? 0) || a.localeCompare(b));
  // Cover both large assemblies and an evenly spaced set of unique physical
  // roots. Never duplicate an asset to inflate measured batch size.
  const selected = [...new Set([...bySize.slice(0, 16), ...Array.from({ length: Math.min(48, paths.length) },
    (_, i) => paths[Math.floor(i * paths.length / Math.min(48, paths.length))])])].sort();
  const fixtures: Fixture[] = [], manifest: Record<string, unknown>[] = [];
  const assetDir = join(output, sample); mkdirSync(assetDir, { recursive: true });
  for (const [index, path] of selected.entries()) {
    const key = `${DEV_GEOMETRY_VERSION}|${sha}|${path}|lod0`;
    const result = await serializeDevToGlbDetailed(path, files, { lod: 0, parseXml: parseWorkerXmlMod });
    const templateSha = result.bytes ? digest(result.bytes) : null;
    const artifact = packDevArtifact(key, { result, sha: templateSha });
    writeFileSync(join(assetDir, `${index}.cache`), artifact);
    fixtures.push({ path, key, artifact, sha: templateSha });
    manifest.push({ path, key, sha: templateSha, status: result.status, bytes: result.bytes?.byteLength ?? 0,
      artifactBytes: artifact.byteLength, diagnostics: result.diagnostics });
    disposeSharedXmlModGeometries(); disposeSharedXmlModMaterials();
  }
  const payload = envelope(fixtures), baseline = decode(payload, false), candidate = decode(payload, true);
  expect(candidate.length).toBe(baseline.length);
  let glbBytes = 0, geometries = 0;
  const geometryFingerprint = async (path: string, bytes: Uint8Array) => {
    const asset = await parseDevGlbAsset(path, bytes); expect(asset).not.toBeNull();
    asset!.scene.updateMatrixWorld(true);
    const meshes: any[] = [];
    asset!.scene.traverse(object => {
      const mesh = object as THREE.Mesh; if (!mesh.isMesh) return;
      const geometry = mesh.geometry, attrs: Record<string, string> = {};
      for (const [name, attr] of Object.entries(geometry.attributes)) {
        const array = attr.array; attrs[name] = digest(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      }
      meshes.push({ attrs, index: geometry.index ? digest(new Uint8Array(geometry.index.array.buffer,
        geometry.index.array.byteOffset, geometry.index.array.byteLength)) : null, matrix: mesh.matrixWorld.toArray(),
        material: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(m => m.toJSON()) });
      geometry.dispose(); for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
    });
    // Generated UUIDs are runtime identities; geometry, transforms and appearance are compared.
    return JSON.stringify(meshes).replace(/"uuid":"[^"]+",?/g, '');
  };
  for (let i = 0; i < fixtures.length; i++) {
    const bytes = candidate[i].result.bytes as Uint8Array | null;
    expect({ ...candidate[i], result: { ...candidate[i].result, bytes: null } })
      .toEqual({ ...baseline[i], result: { ...baseline[i].result, bytes: null } });
    expect(bytes ? digest(bytes) : null).toBe(fixtures[i].sha);
    expect(baseline[i].result.bytes ? digest(baseline[i].result.bytes) : null).toBe(fixtures[i].sha);
    if (!bytes) continue;
    glbBytes += bytes.length;
    expect(bytes.buffer).not.toBe(payload.buffer); expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.length);
    expect(await geometryFingerprint(fixtures[i].path, bytes)).toBe(await geometryFingerprint(fixtures[i].path, baseline[i].result.bytes));
    geometries++;
  }
  const iterations = 100, repeats = Math.max(1, Math.min(16, Math.ceil(4 * 1024 * 1024 / payload.length)));
  let checksum = 0;
  const measure = (borrow: boolean): number => {
    const started = performance.now();
    for (let i = 0; i < repeats; i++) for (const value of decode(payload, borrow)) checksum += value.result.bytes?.length ?? 0;
    return (performance.now() - started) / repeats;
  };
  for (let i = 0; i < 10; i++) { measure(false); measure(true); }
  const control: number[] = [], trial: number[] = [];
  for (let i = 0; i < iterations; i++) {
    if (i % 2) { trial.push(measure(true)); control.push(measure(false)); }
    else { control.push(measure(false)); trial.push(measure(true)); }
  }
  expect(checksum).toBeGreaterThan(0); expect(geometries).toBeGreaterThan(0);
  const record = { sample, sourceSha: sha, uniqueDevRoots: paths.length, occurrences: instances.length,
    cohort: fixtures.length, renderableTemplates: geometries, batchBytes: payload.length, glbBytes,
    removedIntermediateCopyBytes: fixtures.reduce((n, row) => n + row.artifact.length, 0), iterations, repeats,
    baselineMs: summary(control), candidateMs: summary(trial), control, trial, manifest,
    scope: 'Node/jsdom GIMR v2 decode CPU only; geometry verified; excludes native IPC, rendering and station open' };
  writeFileSync(join(output, `${sample}-decode.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ ...record, manifest: undefined, control: undefined, trial: undefined }));
});
