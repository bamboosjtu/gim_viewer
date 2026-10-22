import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import {
  collectSubstationRuntimeResourceSnapshot,
  sampleSubstationRuntimeResources,
  startSubstationResourceMonitor,
} from '../substationResourceTelemetry.js';
import {
  perfCurrentSession,
  perfReset,
  perfRuntimeResourceSnapshot,
  perfMemorySnapshot,
} from '../../utils/perfTimings.js';

const native = vi.hoisted(() => ({ enabled: false, read: vi.fn() }));
vi.mock('@desktop/runtime.js', () => ({ isTauri: () => native.enabled }));
vi.mock('@desktop/database.js', () => ({ getProcessMemory: native.read }));
afterEach(() => { native.enabled=false; native.read.mockReset(); vi.useRealTimers(); });

function makeTree(): { children: unknown[] } {
  return { children: [{ children: [] }, { children: [] }] };
}

describe('Substation Runtime resource checkpoints', () => {
  beforeEach(() => perfReset());

  it('counts logical owners and unique scene resources without copying bytes', () => {
    const state = new AppState();
    state.currentProjectType = 'substation';
    state.currentCbmTree = makeTree() as any;
    state.currentIfcEntries = [{ name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'a' }];
    state.loadedModels.set('a', { modelId: 'a', runtimeModelId: 'runtime-a', visible: true });
    state.fileDevRelations = [{ ifcName: 'a', ifcFile: 'a.ifc', modelId: 'a', deviceCount: 1, deviceCbms: ['device'] }];
    state.substationSpatialIndex = {
      models: [],
      nodes: [{ key: 'node' }],
      objects: [{ key: 'object' }],
      links: [{ cbmPath: 'device' }],
      rootNodeKeys: ['node'],
      coverage: {},
      placementGroups: [],
      identityPlacementLinks: [],
    } as any;

    const texture = new THREE.Texture();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const root = new THREE.Group();
    const sharedA = new THREE.Mesh(geometry, material);
    const sharedB = new THREE.Mesh(geometry, material);
    root.add(sharedA, sharedB);
    const sharedPlacement = new THREE.Group();
    sharedPlacement.userData.__gimDevGlbTemplatePlacement = true;
    const legacyPlacement = new THREE.Group();
    legacyPlacement.userData.__gimDevGlbLegacyPlacement = true;
    state.loadedXmlModGroups.set('shared', sharedPlacement);
    state.loadedXmlModGroups.set('legacy', legacyPlacement);
    state.loadedStlGroups.set('stl', new THREE.Group());
    state.modRootGroup = root;

    root.userData.__gimDevGlbTemplatePool = {
      metrics: () => ({ templateParseCount: 1 }),
      currentResourceCounts: () => ({
        templateCount: 1,
        sharedGeometryCount: 1,
        sharedMaterialCount: 1,
        sharedTextureCount: 1,
      }),
    };
    const fragmentsList = new Map([['runtime-a', { object: root }]]);
    const ctx = {
      world: {
        scene: { three: root },
        renderer: { info: { memory: { geometries: 1, textures: 1 }, programs: [{}] } },
      },
      fragments: { list: fragmentsList },
    } as any;

    const snapshot = collectSubstationRuntimeResourceSnapshot(state, 'interactive', ctx);
    expect(snapshot).toMatchObject({
      sceneObjectCount: 3,
      groupCount: 1,
      meshCount: 2,
      uniqueGeometryCount: 1,
      uniqueMaterialCount: 1,
      uniqueTextureCount: 1,
      rendererInfoGeometries: 1,
      rendererInfoTextures: 1,
      rendererInfoPrograms: 1,
      templateCount: 1,
      templateParseCount: 1,
      sharedPlacementCount: 1,
      legacyPlacementCount: 1,
      sharedGeometryCount: 1,
      sharedMaterialCount: 1,
      sharedTextureCount: 1,
      loadedXmlModGroupCount: 2,
      loadedStlGroupCount: 1,
      fragmentModelCount: 1,
      loadedIfcModelCount: 1,
      currentIfcEntryCount: 1,
      cbmNodeCount: 3,
      spatialNodeCount: 1,
      spatialObjectCount: 1,
      spatialLinkCount: 1,
      fileDevRelationCount: 1,
      modRootPresent: true,
    });

    geometry.dispose();
    material.dispose();
    texture.dispose();
  });

  it('records paired checkpoints and rejects a stale performance session', async () => {
    const state = new AppState();
    const session = perfResetForState(state, 'sha-a');
    await sampleSubstationRuntimeResources(state, 'interactive', session);
    expect(perfRuntimeResourceSnapshot()).toHaveLength(1);
    expect(perfMemorySnapshot()[0]).toMatchObject({
      label: 'interactive',
      rssBytes: null,
      tauriProcessRssBytes: null,
      processTreeRssBytes: null,
      processTreeAvailable: false,
      jsHeapUsedBytes: null,
    });

    perfReset({ generation: 99, projectId: 99, sourceSha256: 'sha-b' });
    await sampleSubstationRuntimeResources(state, 'late-old', session);
    expect(perfRuntimeResourceSnapshot().map((item) => item.label)).toEqual([]);
    expect(perfMemorySnapshot()).toEqual([]);
  });
});

function perfResetForState(state: AppState, sourceSha256: string) {
  const session = state.activateProject(1, sourceSha256);
  perfReset({
    generation: session.generation,
    projectId: session.projectId,
    sourceSha256: session.sourceSha256,
  });
  return perfCurrentSession();
}

it('private commit alone drives pressure; old IPC cannot alter a new project and monitor does not overlap reads', async()=>{
  vi.useFakeTimers();native.enabled=true;
  const state=new AppState();perfResetForState(state,'sha');
  const dev=vi.fn(),ifc=vi.fn();state.deviceLodRuntime={setExternalMemoryPressure:dev} as any;
  state.ifcRegionalRuntimes.set('ifc',{setMemoryPressure:ifc,release:vi.fn()} as any);
  let reply!:(value:any)=>void;
  native.read.mockImplementationOnce(()=>new Promise(resolve=>{reply=resolve;}));
  const monitor=startSubstationResourceMonitor(state,{} as any);
  await vi.advanceTimersByTimeAsync(15000);expect(native.read).toHaveBeenCalledTimes(1);
  reply({processTreeAvailable:true,processTreeRssBytes:1024,processTreePrivateBytes:6*1024**3*0.9});
  await vi.advanceTimersByTimeAsync(0);expect(dev).toHaveBeenLastCalledWith('critical');expect(ifc).toHaveBeenLastCalledWith('critical');
  expect(perfRuntimeResourceSnapshot()).toHaveLength(0); // no periodic full-scene walk
  native.read.mockResolvedValue({processTreeAvailable:true,processTreeRssBytes:10*1024**3,processTreePrivateBytes:null});
  await vi.advanceTimersByTimeAsync(5000);expect(dev).toHaveBeenLastCalledWith('unknown');
  native.read.mockImplementationOnce(()=>new Promise(resolve=>{reply=resolve;}));
  await vi.advanceTimersByTimeAsync(5000);const calls=dev.mock.calls.length;
  state.activateProject(2,'new');reply({processTreeAvailable:true,processTreePrivateBytes:7*1024**3});
  await vi.advanceTimersByTimeAsync(20000);expect(dev.mock.calls.length).toBe(calls);
  expect(state.substationResourceMonitor).toBeNull();monitor.release();
});
