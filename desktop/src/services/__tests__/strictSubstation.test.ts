import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { GeometryCacheManifestEntry } from '@desktop/database.js';
import * as THREE from 'three';
import { collectEquipmentGeometryOccurrences } from '../../gim/equipmentGeometryOccurrences.js';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { collectSourceGeometryOccurrences } from '../../gim/engineering/geometryOccurrences.js';
import { packEngineeringSource, unpackEngineeringSource } from '../engineeringSourceCodec.js';
import { hydrateSubstationGeometryGraph } from '../../gim/geometry/substationSourceGraph.js';
import { buildCbmTree } from '../../gim/cbmParser.js';
import { discoverIfcFromCBM } from '../../gim/gimIndexer.js';
import { parseFileDevRelation } from '../../gim/fileDevParser.js';
import { parseFamSectionsWithDiagnostics } from '../../gim/famParser.js';
import { buildSubstationAliasIndex, discoverSubstationGlSidecars, devAssemblyPath } from '../../gim/substationEvidence.js';
import { buildGimIndexPayload, buildGeometryRefsPayload } from '../gimIndexPersistenceService.js';
import { restoreGimIndexToState } from '../gimIndexRestoreService.js';
import { tryDevGlbFastPath, loadScopedRawFallbackGeometry, diagnoseGroupBBox } from '../modAutoLoadService.js';
import { discoverGeometriesFromDevPath } from '../modGeometryDiscovery.js';
import { serializeDevToGlbDetailed, parseDevGlbAsset, loadDevGlb, InvalidDevGeometryError } from '../glbCacheService.js';
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
function verifyPhysicalAliases(tree: Parameters<typeof buildSubstationAliasIndex>[0]) {
  const aliases=buildSubstationAliasIndex(tree),roots=new Set(collectEquipmentGeometryOccurrences(tree).map(n=>n.id));
  for (const [path,candidates] of aliases.partToOccurrences) {
    const owner=aliases.partToRoot.get(path);
    if (!candidates.length) continue;
    expect(owner, `linked alias ${path} must have a real loading root`).toBeDefined();
    expect(roots.has(owner!.path)).toBe(true);
    const actual=new Set<string>();
    const walk=(n:NonNullable<typeof tree>)=>{if(n.entityName!=='DEV_SUBDEVICE')return;actual.add(n.path);n.children.forEach(walk);};
    owner!.children.forEach(walk);
    expect(candidates.every(n=>actual.has(n.path))).toBe(true);
    const parent=aliases.partToSemanticParent.get(path);
    if (parent?.entityName==='PARTINDEX') {
      const parentCandidates=aliases.partToOccurrences.get(parent.path) ?? [];
      expect(candidates.every(n=>parentCandidates.some(p=>n.path===p.path||n.path.startsWith(`${p.path}#dev:`)))).toBe(true);
    }
  }
  return aliases;
}
const results: unknown[] = [];

for (const [ordinal, sample] of samples.entries()) {
  const available = existsSync(join(root, `${sample.id}.gim`));
  // 04 optional does not gate required 01/02/03. Required ones never use skip.
  if (ordinal === 3 && !available && process.env.GIM_REQUIRE_SUBSTATION04!=='1') { console.info('substation04: optional sample unavailable'); continue; }
  it(`STRICT ${sample.id}: raw → SQLite source facts → source occurrences → cold/warm geometry → GLB → raw fallback`, async () => {
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
    const sourceGraph = await extractEngineeringSourceGraph({ paths: [...files.keys()], readText: async p => files.get(p)!.text() });
    const seeds = collectSourceGeometryOccurrences(sourceGraph).occurrences;
    const physicalAliases=verifyPhysicalAliases(tree);
    if (sample.id==='substation04') {
      const part='CBM/85401e77-4659-47df-847b-ec4d4e8a319d.cbm';
      expect(physicalAliases.partToRoot.get(part)?.path).toBe('CBM/c93b6211-9266-4a4f-a0d9-dec587b4e02c.cbm');
      expect(physicalAliases.partToOccurrences.get(part)?.map(n=>devAssemblyPath(n.path))).toEqual(
        [0,1].flatMap(parent=>Array.from({length:8},(_,i)=>`sub:0/sub:${parent}/sub:${i}`)));
    }
    const byDev = new Map<string, typeof seeds>();
    for (const seed of seeds) { const key = seed.devPath.replace(/^dev\//i, '').toLowerCase(); byDev.set(key, [...(byDev.get(key) ?? []), seed]); }
    const filter = byDev.keys().next().value!;
    const [sql] = await sqliteRoundTrip([{ index, refs }]);
    const state = new AppState();
    restoreGimIndexToState(state, sql.index);
    expect(state.currentIfcEntries).toEqual(ifcs); // first IFC anchor survives SQLite restore
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
    const restoredGraph = unpackEngineeringSource(packEngineeringSource(sourceGraph)) as typeof sourceGraph;
    const warmSeeds = collectSourceGeometryOccurrences(restoredGraph).occurrences;
    expect(warmSeeds).toEqual(seeds);
    expect(aliasShape(state.currentCbmTree)).toEqual(aliasShape(tree));
    verifyPhysicalAliases(state.currentCbmTree);
    const local = new Map<string, Awaited<ReturnType<typeof discoverGeometriesFromDevPath>>>();
    const coldLeaves: ReturnType<typeof canonicalLeaf>[] = [];
    for (const [dev, placements] of byDev) {
      const graph = await discoverGeometriesFromDevPath(dev, files, identity, new Set());
      local.set(dev, graph);
      for (const seed of placements) {
        const cbm = new THREE.Matrix4().fromArray(seed.placementMatrix);
        for (const geo of [...graph.mods,...graph.stls]) {
          coldLeaves.push(canonicalLeaf(seed.id,geo.assemblyPath!,geo.referencePath!, 'modPath' in geo ? geo.modPath : geo.stlPath,
            cbm.clone().multiply(new THREE.Matrix4().fromArray(geo.placementTransformMatrix)).toArray(),geo.phmColor));
        }
      }
    }
    // Persisted source rows retain their original references and transforms;
    // the database no longer invents physical roots from its old CBM projection.
    const order = <T extends {sort_order:number}>(rows:T[], field:keyof T) => [...rows].sort((a,b) =>
      String(a[field]) < String(b[field]) ? -1 : String(a[field]) > String(b[field]) ? 1 : a.sort_order-b.sort_order);
    expect(sql.refs.dev_solid_models).toEqual(order(refs.dev_solid_models,'dev_path'));
    expect(sql.refs.dev_sub_devices).toEqual(order(refs.dev_sub_devices,'dev_path'));
    expect(sql.refs.phm_solid_models).toEqual(order(refs.phm_solid_models,'phm_path'));
    const warmFiles = await hydrateSubstationGeometryGraph(seeds.map(row=>row.devPath), async paths =>
      new Map(paths.filter(path=>files.has(path)).map(path=>[path,files.get(path)!])), files.keys());
    const warmLeaves: typeof coldLeaves = [];
    for (const [dev,placements] of byDev) {
      const local = await discoverGeometriesFromDevPath(dev,warmFiles,identity,new Set());
      for (const seed of placements) for (const leaf of [...local.mods,...local.stls])
        warmLeaves.push(canonicalLeaf(seed.id,leaf.assemblyPath!,leaf.referencePath!,'modPath' in leaf?leaf.modPath:leaf.stlPath,
          new THREE.Matrix4().fromArray(seed.placementMatrix).multiply(new THREE.Matrix4().fromArray(leaf.placementTransformMatrix)).toArray(),leaf.phmColor));
    }
    const sorted = (rows: typeof coldLeaves) => rows.sort((a,b)=>`${a.rootOccurrence}${a.referencePath}`.localeCompare(`${b.rootOccurrence}${b.referencePath}`));
    expect(sorted(warmLeaves)).toEqual(sorted(coldLeaves));
    const sidecars = discoverSubstationGlSidecars(files.keys(),tree);
    for (const sidecar of sidecars) expect(coldLeaves.some(row=>row.path.toLowerCase()===sidecar.path.toLowerCase())).toBe(false);
    const statuses: Record<string, number> = { complete: 0, partial: 0, empty: 0, unsupported: 0, sourceInvalid: 0, transientFailed: 0 };
    const cache = mkdtempSync(join(tmpdir(), `gim-${sample.id}-glb-`));
    const persisted: GeometryCacheManifestEntry[] = [];
    let warmReads = 0;
    let glbChecks = 0;
    let theoreticalRecoverableOccurrences = 0;
    let rejectedOccurrences = 0;
    const rejectedTemplates: Array<{dev:string;roots:number;reason:string}> = [];
    let fallbackChecks = 0;
    let damagedDev: string | null = null;
    const fallbackBoxes = new Map<string, THREE.Box3>();
    try {
      // Every unique root template is compiled; every root occurrence is restored.
      for (const [dev, placements] of byDev) {
        let compiled;
        try {
          // This chain validates the browsing GLB cache written by the cold
          // pipeline (L0 outline). Exact L2 CSG is a separate explicit
          // refinement path with known long tails, and serializing 300+
          // Boolean MODs at L2 in jsdom does not complete; L2 behaviour is
          // covered by xmlModGeometry tests instead.
          compiled = await serializeDevToGlbDetailed(dev, files, { lod: 0 });
        } catch (error) {
          if (!(error instanceof InvalidDevGeometryError) || !error.sourceEvidence) throw error;
          persisted.push({entry_path:`DEV/${dev}`,status:'source-invalid',size:0,diagnostic:`${error.message}; ${error.sourceEvidence}`});
          statuses.sourceInvalid++;
          rejectedOccurrences += placements.length;
          rejectedTemplates.push({ dev, roots:placements.length, reason:error.reason });
          continue;
        }
        statuses[compiled.status]++;
        if (!compiled.bytes) { persisted.push({entry_path:`DEV/${dev}`,status:compiled.status === 'unsupported'?'unsupported':'empty',size:0}); expect(['empty','unsupported']).toContain(compiled.status); continue; }
        persisted.push({entry_path:`DEV/${dev}`,status:compiled.status === 'partial'?'partial':'glb',size:compiled.bytes.byteLength});
        writeFileSync(join(cache,dev),compiled.bytes);
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
          const expectedRoots = new Set(placements.map((seed) => seed.id));
          const expectedKeys = new Set(coldLeaves.filter(row=>expectedRoots.has(row.rootOccurrence)).map(row=>`raw:${row.rootOccurrence}${row.referencePath}`));
          for (const [key,group] of [...fallbackState.loadedXmlModGroups,...fallbackState.loadedStlGroups]) {
            expect(expectedKeys.has(key)).toBe(true);
            expect(expectedRoots.has(group.userData.rootOccurrence)).toBe(true);
          }
          expect([...fallbackState.loadedXmlModGroups.keys(),...fallbackState.loadedStlGroups.keys()].sort()).toEqual([...expectedKeys].sort());
          const count = fallbackState.loadedXmlModGroups.size+fallbackState.loadedStlGroups.size;
          for (const seed of placements) {
            const box = new THREE.Box3();
            collectDeviceGroups(fallbackState,dev,{rootOccurrence:seed.id}).forEach((g) => box.expandByObject(g));
            fallbackBoxes.set(seed.id,box);
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
          const group = prepared.template.createPlacement({ rootOccurrence: seed.id, instanceKey: `dev:${dev}#${seed.id}`, placementMatrix: seed.placementMatrix });
          theoreticalRecoverableOccurrences++;
          if (!diagnoseGroupBBox(group,dev,{disposeOnFailure:false})) {
            rejectedOccurrences++;
            continue;
          }
          state.loadedXmlModGroups.set(seed.id,group);
          expect(collectDeviceGroups(state,dev,{rootOccurrence:seed.id})).toEqual([group]);
          if (dev === damagedDev) {
            const box = new THREE.Box3().setFromObject(group), rawBox = fallbackBoxes.get(seed.id)!;
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
      const restored=new AppState();restoreGimIndexToState(restored,sql.index);restored.currentProjectId=1;restored.currentSourceSha256=sample.sha;restored.geometryLoadToken=1;
      const result=await tryDevGlbFastPath(restored,new THREE.Scene(),warmSeeds,()=>{},1,{
        readGeometryCacheManifest:async()=>({source_sha256:sample.sha,entries:persisted}),
        batchReadGlbFiles:async(_pid,paths)=>new Map(paths.map(path=>{warmReads++;return [path,new Uint8Array(readFileSync(join(cache,path.replace(/^DEV\//i,''))))];})),
        loadDevGlb,parseDevGlbAsset,applyPlacementTransformToSceneUnits,
      },{projectId:1,generation:restored.projectGeneration,sourceSha256:sample.sha});
      expect(result).not.toBeNull();expect(result?.profile.failedDevPaths).toEqual([]);
      expect(restored.loadedXmlModGroups.size).toBe(glbChecks);
      expect(warmReads).toBe(persisted.filter(e=>e.status==='glb'||e.status==='partial').length);
    } finally { rmSync(cache,{ recursive: true, force: true }); }
    expect(glbChecks).toBeGreaterThan(0);
    expect(fallbackChecks).toBeGreaterThan(0);
    // One DEV's cache absence/corruption falls back using the same occurrence keys,
    // matrices and colors from the actual source files, including child closure.
    const fallbackSeed = byDev.get(filter)![0];
    const fallback = await discoverGeometriesFromDevPath(fallbackSeed.devPath,files,fallbackSeed.placementMatrix,new Set(),0,{instances:0},{rootOccurrence:fallbackSeed.id});
    const sourceLeaves = coldLeaves.filter(row=>row.rootOccurrence===fallbackSeed.id);
    expect([...fallback.mods,...fallback.stls].map(row=>row.instanceKey).sort()).toEqual(sourceLeaves.map(row=>`raw:${row.rootOccurrence}${row.referencePath}`).sort());
    const aliases = buildSubstationAliasIndex(tree);
    const repeated = new Map<string, typeof raw>();
    for (const r of raw) { const key = `${r.sourcePath}\0${r.section}\0${r.label}`; repeated.set(key,[...(repeated.get(key) ?? []),r]); }
    const groups = [...repeated.values()].filter((r) => r.length > 1);
    expect(statuses.transientFailed).toBe(0); // untyped/transient errors above fail the strict gate
    if(sample.id==='substation02') {
      expect(statuses.sourceInvalid).toBe(2);
      expect(rejectedOccurrences).toBe(34);
    }
    const summary = { sample:sample.id, sha256:sample.sha, famRows:raw.length, duplicateKeys:groups.length,
      conflicts:groups.filter((g) => new Set(g.map((p) => p.rawValue)).size > 1).length,
      rootOccurrences:seeds.length, uniqueDevTemplates:byDev.size,
      parts: aliases.partToOccurrences.size, unlinked:[...aliases.partToOccurrences.values()].filter((p) => p.length === 0).length,
      ambiguous:[...aliases.partToOccurrences.values()].filter((p) => p.length > 1).length,
      warmGlbReads:warmReads,warmRecompiledTemplates:0,deterministicManifestTemplates:persisted.length,
      geometryLeaves:coldLeaves.length, glSidecars:sidecars.length, glbRestoredOccurrences:glbChecks,
      theoreticalRecoverableOccurrences: theoreticalRecoverableOccurrences + rejectedTemplates.reduce((sum,r)=>sum+r.roots,0),
      successfullySubmittedOccurrences:glbChecks, abnormalRejectedOccurrences:rejectedOccurrences, rejectedTemplates,
      corruptDevRawFallbackLeaves:fallbackChecks, statuses, visual:'not-executed' };
    results.push(summary);
    writeFileSync(join(root,'runtime-correctness-gate.json'),JSON.stringify(results,null,2));
    console.info(JSON.stringify(summary));
  });
}
