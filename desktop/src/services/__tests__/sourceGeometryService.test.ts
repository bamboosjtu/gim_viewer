import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { collectSourceGeometryOccurrences } from '../../gim/engineering/geometryOccurrences.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import { hydrateSubstationGeometryGraph } from '../../gim/geometry/substationSourceGraph.js';
import { discoverGeometriesFromDevPath } from '../modGeometryDiscovery.js';
import { getSourceGeometryOccurrences } from '../sourceGeometryService.js';
import { runProgressiveDevGlbPipeline } from '../progressiveGeometryService.js';
import { getEngineeringRepresentations } from '../engineeringRepresentationService.js';

it('renders repeated actual source instances without a CBM display tree or entity snapshot, then binds independent wholes', async () => {
  const tx = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0).toArray().join(',');
  const raw = {
    'project.cbm': 'SUBSYSTEM0=left.cbm\nSUBSYSTEM1=right.cbm',
    'left.cbm': `SUBSYSTEM0=shared.cbm\nTRANSFORMMATRIX=${tx(1000)}`,
    'right.cbm': `SUBSYSTEM0=shared.cbm\nTRANSFORMMATRIX=${tx(5000)}`,
    'shared.cbm': 'ENTITYNAME=F2System\nOBJECTMODELPOINTER=assets/main.dev',
    'assets/main.dev': 'SYMBOLNAME=主变压器\nSUBDEVICES.NUM=3\nSUBDEVICE0=\nSUBDEVICE2=terminal.dev',
    'assets/terminal.dev': 'SYMBOLNAME=测控柜\nSOLIDMODELS.NUM=1\nSOLIDMODEL0=shell.phm',
    'parts/shell.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=box.mod',
    'surfaces/box.mod': '<Device/>',
  };
  const files = new Map(Object.entries(raw).map(([path, text]) => [path, new File([text], path)]));
  const graph = await extractEngineeringSourceGraph({ paths: [...files.keys()], readText: p => files.get(p)!.text() });
  const state = new AppState(), session = state.activateProject(1, 'sha'); state.currentProjectType = 'substation';
  state.currentFiles = files; state.engineeringGeometryCatalog = collectSourceGeometryOccurrences(graph);
  expect(state.currentCbmTree).toBeNull(); expect(state.engineeringSnapshot).toBeNull();
  const roots = await getSourceGeometryOccurrences(state, session);
  expect(roots.map(r => r.placementMatrix[12])).toEqual([1000, 5000]);
  const compile = vi.fn(async () => new Uint8Array([1]));
  const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), () => {}, { session }, {
    serializeDevToGlb: compile,
    loadDevGlb: async () => { const group = new THREE.Group(), leaf = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      leaf.userData.assemblyPath = 'sub:2'; group.add(leaf); return group; },
    applyPlacementTransformToSceneUnits() {}, writeGlbFile: async () => {}, writeGeometryCacheVersion: async () => {},
    writeGeometryCacheManifest: async () => {}, yieldToMain: async () => {},
  });
  expect(result.renderedInstances).toBe(2); expect(compile).toHaveBeenCalledOnce();
  expect(compile).toHaveBeenCalledWith('assets/main.dev', files);
  const placed = [...state.loadedXmlModGroups.values()];
  expect(placed.map(g => g.userData.rootOccurrence)).toEqual(roots.map(r => r.id));
  expect(placed.map(g => new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()).x)).toEqual([1, 5]);

  const built = buildEngineeringSources('sha', graph, [], []); state.engineeringSources = built.sources; state.engineeringSnapshot = built.snapshot;
  const index = getEngineeringRepresentations(state)!.index;
  for (const root of roots) {
    const body = index.resolveDev(root.id, { assemblyPath: '' }), box = index.resolveDev(root.id, { assemblyPath: 'sub:2' });
    expect(body.ownerIds).toHaveLength(1); expect(box.ownerIds).toHaveLength(1); expect(body.ownerIds).not.toEqual(box.ownerIds);
  }
  expect(index.resolveDev(roots[0].id, { assemblyPath: 'sub:2' }).ownerIds).not.toEqual(index.resolveDev(roots[1].id, { assemblyPath: 'sub:2' }).ownerIds);

  const warmFiles = await hydrateSubstationGeometryGraph(roots.map(r => r.devPath), async paths =>
    new Map(paths.filter(p => files.has(p)).map(p => [p, files.get(p)!])), files.keys());
  expect([...warmFiles.keys()].sort()).toEqual(['assets/main.dev', 'assets/terminal.dev', 'parts/shell.phm', 'surfaces/box.mod']);
  for (const source of [files, warmFiles]) {
    const discovered = await discoverGeometriesFromDevPath(roots[0].devPath, source, roots[0].placementMatrix, new Set(), 0,
      { instances: 0 }, { rootOccurrence: roots[0].id, strictDependencies: true });
    expect(discovered.mods[0]).toMatchObject({ rootOccurrence: roots[0].id, assemblyPath: 'sub:2', modPath: 'surfaces/box.mod' });
  }
});

it('waits for physical source readiness only and discards an old-session occurrence result', async () => {
  const state = new AppState(), session = state.activateProject(1, 'old'); state.currentProjectType = 'substation';
  let publish!: (value: { occurrences: []; diagnostics: [] }) => void;
  state.engineeringGeometryReady = new Promise(resolve => { publish = resolve; });
  const result = getSourceGeometryOccurrences(state, session);
  state.activateProject(2, 'new'); publish({ occurrences: [], diagnostics: [] });
  expect(await result).toEqual([]); expect(state.engineeringGeometryCatalog).toBeNull();
});
