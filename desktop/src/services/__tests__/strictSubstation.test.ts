import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as THREE from 'three';
import { buildCbmTree } from '../../gim/cbmParser.js';
import { discoverIfcFromCBM } from '../../gim/gimIndexer.js';
import { parseFileDevRelation } from '../../gim/fileDevParser.js';
import { parseFamSectionsWithDiagnostics } from '../../gim/famParser.js';
import { buildSubstationAliasIndex, discoverSubstationGlSidecars, deviceOccurrenceScope } from '../../gim/substationEvidence.js';
import { buildGimIndexPayload, buildGeometryRefsPayload } from '../gimIndexPersistenceService.js';
import { restoreGimIndexToState } from '../gimIndexRestoreService.js';
import { collectCbmDeviceInstances, tryDevGlbFastPath, loadScopedRawFallbackGeometry } from '../modAutoLoadService.js';
import { discoverGeometriesFromDevPath, discoverGeometriesFromNode } from '../modGeometryDiscovery.js';
import { serializeDevToGlbDetailed, parseDevGlbAsset, loadDevGlb } from '../glbCacheService.js';
import { applyPlacementTransformToSceneUnits } from '../../viewer/xmlModLoader.js';
import { DevGlbTemplatePool } from '../devGlbTemplateRuntime.js';
import { collectDeviceGroups } from '../nodeInteractionService.js';
import { AppState } from '../../app/state.js';
import { sqliteRoundTrip } from './sqliteHarness.js';

const root = resolve(process.env.GIM_SAMPLE_ROOT ?? '../demo');
const samples = [
  { id: 'substation01', dir: 'demo-substation', sha: '711259814db95999f5282af1871da9cb50db4548b71626637b33038b062fc390' },
  { id: 'substation02', dir: 'substation02', sha: 'a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29' },
  { id: 'substation03', dir: 'substation03', sha: '3197c03ef2c6c423cbb85447f71491a4112db0f9a8cea0c9f72f0b410b8175ab' },
  { id: 'substation04', dir: 'substation04', sha: '00b7746d5ea6ab3b92c215c1e42ffc7eec5a9f0517c1c555fa27a596d4d800dc' },
];

class DiskFile {
  name: string; size: number;
  constructor(private path: string) { this.name = path.split(/[\\/]/).pop()!; this.size = statSync(path).size; }
  async text() { return readFileSync(this.path, 'utf8'); }
  async arrayBuffer() { const bytes = readFileSync(this.path); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
}
function filesAt(dir: string, prefix = '', files = new Map<string, File>()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Extraction provenance belongs to the test harness, not the GIM package.
    if (entry.name === '.gim-source.sha256') continue;
    const path = join(dir, entry.name), key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) filesAt(path, `${key}/`, files);
    else files.set(key, new DiskFile(path) as unknown as File);
  }
  return files;
}
const identity = new THREE.Matrix4().toArray();
function canonicalLeaf(rootOccurrence: string, assemblyPath: string, referencePath: string, path: string, matrix: number[], color: unknown) {
  return { rootOccurrence, assemblyPath, referencePath, path: path.toLowerCase(),
    matrix: matrix.map((n) => Number(n.toFixed(6)) || 0), color: color ?? null };
}
function aliasShape(tree: Parameters<typeof buildSubstationAliasIndex>[0]) {
  const aliases = buildSubstationAliasIndex(tree);
  return [...aliases.partToOccurrences].map(([path, nodes]) => [path, nodes.map((n) => n.path)]).sort();
}
const results: unknown[] = [];

for (const [ordinal, sample] of samples.entries()) {
  const available = existsSync(join(root, `${sample.id}.gim`));
  // 04 optional does not gate required 01/02/03. Required ones never use skip.
  if (ordinal === 3 && !available) { console.info('substation04: optional sample unavailable'); continue; }
  it(`STRICT ${sample.id}: raw → SQLite → restore → Rust/TS geometry → GLB → raw fallback`, async () => {
    expect(available, `required ${sample.id}.gim missing from ${root}`).toBe(true);
    expect(createHash('sha256').update(readFileSync(join(root, `${sample.id}.gim`))).digest('hex')).toBe(sample.sha);
    const dir = existsSync(join(root, sample.dir)) ? join(root, sample.dir) : join(root, sample.id);
    expect(existsSync(dir), `required unpacked sample missing: ${dir}`).toBe(true);
    expect(existsSync(join(dir,'.gim-source.sha256')), 'unpack identity stamp missing; extract with gim_survey/extract_inventory.py').toBe(true);
    expect(readFileSync(join(dir,'.gim-source.sha256'),'ascii').trim()).toBe(sample.sha);
    const files = filesAt(dir);
    const tree = await buildCbmTree(files);
    expect(tree).not.toBeNull();
    const ifcs = await discoverIfcFromCBM(files);
    const fdr = await parseFileDevRelation(files);
    const index = await buildGimIndexPayload(1, files, ifcs, tree, fdr, undefined, sample.sha);
    const refs = await buildGeometryRefsPayload(1, files, sample.sha);
    const seeds = collectCbmDeviceInstances(tree);
    const byDev = new Map<string, typeof seeds>();
    for (const seed of seeds) { const key = seed.devPath.replace(/^dev\//i, '').toLowerCase(); byDev.set(key, [...(byDev.get(key) ?? []), seed]); }
    const filter = byDev.keys().next().value!;
    const [sql] = sqliteRoundTrip([{ index, refs, filter: [filter] }]);
    const state = new AppState();
    restoreGimIndexToState(state, sql.index);
    const raw = index.fam_properties.map((r) => JSON.parse(r.raw_property_json!));
    const warm = [...state.cachedFamSourceProperties.values()].flat();
    const sortRows = (rows: typeof raw) => rows.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.sourceLine - b.sourceLine);
    expect(sortRows(warm)).toEqual(sortRows(raw));
    for (const path of new Set(index.fam_properties.map((p) => p.source_path))) {
      const file = [...files].find(([key]) => key.toLowerCase() === path.toLowerCase())![1];
      const sections = parseFamSectionsWithDiagnostics(await file.text(), path).sections;
      const projected = state.cachedFamProperties.get(path)!;
      expect(projected).toEqual(new Map([...sections].filter(([, map]) => map.size || projected.has('默认'))));
    }
    const warmSeeds = collectCbmDeviceInstances(state.currentCbmTree);
    expect(warmSeeds.map((s) => [s.path,s.name,s.devPath,s.transformMatrix])).toEqual(seeds.map((s) => [s.path,s.name,s.devPath,s.transformMatrix]));
    expect(aliasShape(state.currentCbmTree)).toEqual(aliasShape(tree));
    const local = new Map<string, Awaited<ReturnType<typeof discoverGeometriesFromDevPath>>>();
    const coldLeaves: ReturnType<typeof canonicalLeaf>[] = [];
    for (const [dev, placements] of byDev) {
      const graph = await discoverGeometriesFromDevPath(dev, files, identity, new Set());
      local.set(dev, graph);
      for (const seed of placements) {
        const cbm = new THREE.Matrix4().fromArray(seed.transformMatrix!.split(',').map(Number));
        for (const geo of [...graph.mods,...graph.stls]) {
          coldLeaves.push(canonicalLeaf(seed.path,geo.assemblyPath!,geo.referencePath!, 'modPath' in geo ? geo.modPath : geo.stlPath,
            cbm.clone().multiply(new THREE.Matrix4().fromArray(geo.placementTransformMatrix)).toArray(),geo.phmColor));
        }
      }
    }
    const rustLeaves = sql.reachable.map((r) => canonicalLeaf(r.root_occurrence!,r.assembly_path!,r.reference_path!,r.geometry_path,
      r.placement_transform_matrix!.split(',').map(Number), r.phm_color ? (() => { const [r1,g,b,a] = r.phm_color.split(',').map(Number); return {r:r1,g,b,a}; })() : null));
    const sorted = (rows: typeof coldLeaves) => rows.sort((a,b) => `${a.rootOccurrence}${a.referencePath}`.localeCompare(`${b.rootOccurrence}${b.referencePath}`));
    expect(sorted(rustLeaves)).toEqual(sorted(coldLeaves));
    expect(sql.reachable.map((r) => r.instance_key).sort()).toEqual(coldLeaves.map((r) => `raw:${r.rootOccurrence}${r.referencePath}`).sort());
    const sidecars = discoverSubstationGlSidecars(files.keys(),tree);
    for (const sidecar of sidecars) expect(sql.reachable.some((r) => r.geometry_path.toLowerCase() === sidecar.path.toLowerCase())).toBe(false);
    const statuses: Record<string, number> = { complete: 0, partial: 0, empty: 0, unsupported: 0, failed: 0 };
    const cache = mkdtempSync(join(tmpdir(), `gim-${sample.id}-glb-`));
    let glbChecks = 0;
    let fallbackChecks = 0;
    let damagedDev: string | null = null;
    const fallbackBoxes = new Map<string, THREE.Box3>();
    try {
      // Every unique root template is compiled; every root occurrence is restored.
      for (const [dev, placements] of byDev) {
        const compiled = await serializeDevToGlbDetailed(dev, files);
        statuses[compiled.status]++;
        if (!compiled.bytes) { expect(['empty','unsupported']).toContain(compiled.status); continue; }
        writeFileSync(join(cache,'device.glb'),compiled.bytes);
        const bytes = new Uint8Array(readFileSync(join(cache,'device.glb')));
        if (!damagedDev && compiled.status === 'complete') {
          // A damaged real-device file exercises the production warm fast path,
          // followed by the actual scoped raw loader, not only reference discovery.
          damagedDev = dev;
          writeFileSync(join(cache,'damaged.glb'), bytes.subarray(0, Math.min(8,bytes.length)));
          const fallbackState = new AppState();
          restoreGimIndexToState(fallbackState,sql.index);
          const session = fallbackState.activateProject(1,sample.sha);
          const scene = new THREE.Scene();
          const path = `DEV/${dev}`;
          const fast = await tryDevGlbFastPath(fallbackState,scene,placements,() => {},session.geometryToken,{
            loadDevGlb,parseDevGlbAsset,applyPlacementTransformToSceneUnits,
            readGeometryCacheManifest: async () => ({source_sha256:sample.sha,entries:[{entry_path:path,status:'glb',size:bytes.length}]}),
            batchReadGlbFiles: async () => new Map([[path,new Uint8Array(readFileSync(join(cache,'damaged.glb')))]]),
          },{session});
          expect(fast.profile.failedDevPaths.map((p) => p.toLowerCase())).toEqual([path.toLowerCase()]);
          expect(fallbackState.loadedXmlModGroups.size).toBe(0);
          const fallback = await loadScopedRawFallbackGeometry(fallbackState,scene,() => {},[path],true,true,
            session.geometryToken,session.generation,session.projectId,session.sourceSha256,session,fast.profile,files,seeds);
          expect(fallback.modCount+fallback.stlCount).toBeGreaterThan(0);
          const expectedRoots = new Set(placements.map((seed) => seed.path));
          const expectedKeys = new Set(sql.reachable.filter((r) => expectedRoots.has(r.root_occurrence!)).map((r) => r.instance_key));
          for (const [key,group] of [...fallbackState.loadedXmlModGroups,...fallbackState.loadedStlGroups]) {
            expect(expectedKeys.has(key)).toBe(true);
            expect(expectedRoots.has(group.userData.rootOccurrence)).toBe(true);
          }
          expect([...fallbackState.loadedXmlModGroups.keys(),...fallbackState.loadedStlGroups.keys()].sort()).toEqual([...expectedKeys].sort());
          const count = fallbackState.loadedXmlModGroups.size+fallbackState.loadedStlGroups.size;
          for (const seed of placements) {
            const box = new THREE.Box3();
            collectDeviceGroups(fallbackState,dev,{rootOccurrence:seed.path}).forEach((g) => box.expandByObject(g));
            fallbackBoxes.set(seed.path,box);
          }
          await loadScopedRawFallbackGeometry(fallbackState,scene,() => {},[path],true,true,
            session.geometryToken,session.generation,session.projectId,session.sourceSha256,session,fast.profile,files,seeds);
          expect(fallbackState.loadedXmlModGroups.size+fallbackState.loadedStlGroups.size).toBe(count);
          fallbackChecks=count;
          fallbackState.loadedXmlModGroups.forEach((g) => g.traverse((o) => (o as THREE.Mesh).geometry?.dispose()));
          fallbackState.loadedStlGroups.forEach((g) => g.traverse((o) => (o as THREE.Mesh).geometry?.dispose()));
        }
        const pool = new DevGlbTemplatePool({ session: state.captureProjectSession(), isCurrent: () => true, parse: parseDevGlbAsset });
        const prepared = await pool.prepare(dev, bytes);
        expect(prepared?.kind).toBe('shared');
        if (prepared?.kind !== 'shared') throw new Error(`Non-shareable actual GLB: ${dev}`);
        for (const seed of placements) {
          const group = prepared.template.createPlacement({ rootOccurrence: seed.path, instanceKey: `dev:${dev}#${seed.path}`, placementMatrix: seed.transformMatrix!.split(',').map(Number) });
          state.loadedXmlModGroups.set(seed.path,group);
          expect(collectDeviceGroups(state,dev,deviceOccurrenceScope(state.currentCbmTree,seed))).toEqual([group]);
          if (dev === damagedDev) {
            const box = new THREE.Box3().setFromObject(group), rawBox = fallbackBoxes.get(seed.path)!;
            box.min.toArray().forEach((v,i) => expect(v).toBeCloseTo(rawBox.min.toArray()[i],3));
            box.max.toArray().forEach((v,i) => expect(v).toBeCloseTo(rawBox.max.toArray()[i],3));
          }
          const refsInGlb: string[] = [];
          const sourceLeaves = [...local.get(dev)!.mods,...local.get(dev)!.stls];
          const sourceByReference = new Map(sourceLeaves.map((g) => [g.referencePath,g]));
          group.traverse((o) => {
            if (!o.userData.referencePath) return;
            refsInGlb.push(o.userData.referencePath);
            expect(o.userData.assemblyPath).toBe(sourceByReference.get(o.userData.referencePath)?.assemblyPath);
          });
          const expected = new Set(sourceLeaves.map((g) => g.referencePath));
          expect(refsInGlb.every((path) => expected.has(path))).toBe(true);
          expect(refsInGlb.length).toBe(compiled.diagnostics.renderableModCount + compiled.diagnostics.renderableStlCount);
          glbChecks++;
        }
        state.loadedXmlModGroups.clear();
        pool.dispose();
      }
    } finally { rmSync(cache,{ recursive: true, force: true }); }
    expect(glbChecks).toBeGreaterThan(0);
    expect(fallbackChecks).toBeGreaterThan(0);
    // One DEV's cache absence/corruption falls back using the same occurrence keys,
    // matrices and colors from the actual source files, including child closure.
    const fallbackSeed = byDev.get(filter)![0];
    const fallback = await discoverGeometriesFromNode(fallbackSeed,files);
    const filteredRoot = sql.filtered.filter((r) => r.root_occurrence === fallbackSeed.path);
    expect(filteredRoot.map((r) => r.instance_key).sort()).toEqual([...fallback.mods,...fallback.stls].map((g) => g.instanceKey).sort());
    const aliases = buildSubstationAliasIndex(tree);
    const repeated = new Map<string, typeof raw>();
    for (const r of raw) { const key = `${r.sourcePath}\0${r.section}\0${r.label}`; repeated.set(key,[...(repeated.get(key) ?? []),r]); }
    const groups = [...repeated.values()].filter((r) => r.length > 1);
    const summary = { sample:sample.id, sha256:sample.sha, famRows:raw.length, duplicateKeys:groups.length,
      conflicts:groups.filter((g) => new Set(g.map((p) => p.rawValue)).size > 1).length,
      rootOccurrences:seeds.length, uniqueDevTemplates:byDev.size,
      parts: aliases.partToOccurrences.size, unlinked:[...aliases.partToOccurrences.values()].filter((p) => p.length === 0).length,
      ambiguous:[...aliases.partToOccurrences.values()].filter((p) => p.length > 1).length,
      geometryLeaves:coldLeaves.length, glSidecars:sidecars.length, glbRestoredOccurrences:glbChecks,
      corruptDevRawFallbackLeaves:fallbackChecks, statuses, visual:'not-executed' };
    results.push(summary);
    writeFileSync(join(root,'runtime-correctness-gate.json'),JSON.stringify(results,null,2));
    console.info(JSON.stringify(summary));
  });
}
