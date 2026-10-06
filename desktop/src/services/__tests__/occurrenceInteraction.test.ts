import { it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { buildCbmTree } from '../../gim/cbmParser.js';
import { deviceOccurrenceScope } from '../../gim/substationEvidence.js';
import { loadModStlForNode, collectDeviceGroups, frameAndHighlightDevice } from '../nodeInteractionService.js';
import { serializeDevToGlbDetailed, parseDevGlbAsset } from '../glbCacheService.js';
import { DevGlbTemplatePool } from '../devGlbTemplateRuntime.js';
import { highlightModGroups, resetModHighlight } from '../../viewer/highlight.js';
import { autoLoadModAndStlGeometry } from '../modAutoLoadService.js';
import { runProgressiveDevGlbPipeline } from '../progressiveGeometryService.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import { nestedPartFixture } from './nestedPartIndexFixture.js';

const mock = vi.hoisted(() => ({ ctx: null as any, frame: vi.fn(), bytes: null as Uint8Array | null }));
vi.mock('@desktop/database.js', () => ({ readGlbFile: async () => mock.bytes }));
vi.mock('../viewerUIBinding.js', () => ({ getViewerRuntimeWithUI: async () => ({ ctx: mock.ctx }) }));
vi.mock('../../viewer/camera.js', () => ({ frameBox: (...args: any[]) => mock.frame(...args) }));
const identity = new THREE.Matrix4().toArray();
function fixture() {
  const matrix = [...identity]; matrix[12] = 5000;
  return new Map(Object.entries({
    'CBM/project.cbm': 'ENTITYNAME=F3System\nSUBSYSTEMS.NUM=2\nSUBSYSTEM0=A.cbm\nSUBSYSTEM1=B.cbm',
    'CBM/A.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev\nSUBDEVICES.NUM=2\nSUBDEVICE0=part2.cbm\nSUBDEVICE1=part1.cbm',
    'CBM/B.cbm': `ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev\nTRANSFORMMATRIX=${matrix.join(',')}\nSUBDEVICES.NUM=1\nSUBDEVICE0=partB.cbm`,
    'CBM/part1.cbm': 'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=child.dev',
    'CBM/part2.cbm': 'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=other.dev',
    'CBM/partB.cbm': 'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=child.dev',
    'DEV/root.dev': 'SUBDEVICES.NUM=3\nSUBDEVICE0=child.dev\nSUBDEVICE1=other.dev\nSUBDEVICE2=child.dev\nTRANSFORMMATRIX2=1,0,0,0,0,1,0,0,0,0,1,0,100,0,0,1',
    'DEV/child.dev': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.phm',
    'DEV/other.dev': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.phm',
    'PHM/leaf.phm': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.mod',
    'MOD/leaf.mod': '<Device><Entities><Entity ID="1" Visible="true"><Cuboid L="100" W="100" H="100"/></Entity></Entities></Device>',
  }).map(([p,t]) => [p,new File([t],p)]));
}
beforeEach(() => {
  mock.ctx = { world: { scene: { three: new THREE.Scene() } }, fragments: { resetHighlight: vi.fn() } };
  mock.frame.mockReset(); mock.frame.mockResolvedValue(undefined);
  mock.bytes = null;
});

it.each(['raw','glb'] as const)('nested PARTINDEX uses the real root and parent subtree after %s loading', async (mode) => {
  const {files,tree,root,b}=await nestedPartFixture(2);
  const state=new AppState(); state.currentFiles=files; state.currentCbmTree=tree; state.currentProjectId=1;
  if (mode==='glb') mock.bytes=(await serializeDevToGlbDetailed(root.devPath,files)).bytes!;
  await loadModStlForNode(state,b,() => {});
  const scope=deviceOccurrenceScope(tree,b);
  expect(scope.rootOccurrence).toBe(root.path);
  const groups=collectDeviceGroups(state,b.devPath,scope);
  expect(groups.map(g=>g.userData.assemblyPath).sort()).toEqual(['sub:0/sub:0','sub:1/sub:0']);
  expect(state.highlightedModState?.groups).toEqual(groups);
  expect(groups.every(g=>{
    let owner: THREE.Object3D | null=g;
    while (owner && !owner.userData.rootOccurrence) owner=owner.parent;
    return owner?.userData.rootOccurrence===root.path;
  })).toBe(true);
  const count=state.loadedXmlModGroups.size;
  await loadModStlForNode(state,b,() => {});
  expect(state.loadedXmlModGroups.size).toBe(count);
  expect([...state.loadedXmlModGroups.values()].every(g=>g.userData.rootOccurrence===root.path)).toBe(true);
});

it('a GLB becoming available after raw loading does not duplicate the same occurrence on repeat click', async () => {
  const files = fixture(), tree = (await buildCbmTree(files))!;
  const state = new AppState(); state.currentFiles=files; state.currentCbmTree=tree; state.currentProjectId=1;
  await loadModStlForNode(state,tree.children[0],() => {});
  expect(state.loadedXmlModGroups.size).toBe(3);
  mock.bytes = (await serializeDevToGlbDetailed('root.dev',files)).bytes!;
  await loadModStlForNode(state,tree.children[0],() => {});
  expect(state.loadedXmlModGroups.size).toBe(3);
});

it('full raw auto load retains occurrence ownership and a subsequent progressive GLB commit adds no duplicate', async () => {
  const files=fixture(), tree=(await buildCbmTree(files))!;
  const state=new AppState(); state.currentFiles=files; state.currentCbmTree=tree;
  const scene=mock.ctx.world.scene.three;
  await autoLoadModAndStlGeometry(state,scene,() => {},{includeMod:true});
  expect(state.loadedXmlModGroups.size).toBe(6);
  for (const seed of tree.children) expect(collectDeviceGroups(state,seed.devPath,deviceOccurrenceScope(tree,seed))).toHaveLength(3);
  await runProgressiveDevGlbPipeline(state,scene,() => {});
  expect(state.loadedXmlModGroups.size).toBe(6);
});
it('A loaded does not let B PARTINDEX skip loading; reverse aliases and repeated assembly candidates stay scoped', async () => {
  const files = fixture(), tree = (await buildCbmTree(files))!;
  const state = new AppState(); state.currentFiles = files; state.currentCbmTree = tree;
  const a = tree.children[0], b = tree.children[1];
  const messages = vi.fn();
  await Promise.all([loadModStlForNode(state,a,messages),loadModStlForNode(state,a,messages)]);
  const part = b.children.find((n) => n.entityName === 'PARTINDEX')!;
  expect(collectDeviceGroups(state,part.devPath,deviceOccurrenceScope(tree,part))).toHaveLength(0);
  await loadModStlForNode(state,part,messages);
  expect(collectDeviceGroups(state,part.devPath,deviceOccurrenceScope(tree,part))).toHaveLength(2);
  expect(state.loadedXmlModGroups.size).toBe(6);
  await loadModStlForNode(state,part,messages);
  expect(state.loadedXmlModGroups.size).toBe(6);
  expect(messages.mock.calls.some(([m]) => m.includes('2 条装配路径'))).toBe(true);
  const boxA = new THREE.Box3(), boxB = new THREE.Box3();
  collectDeviceGroups(state,a.devPath,deviceOccurrenceScope(tree,a)).forEach((g) => boxA.expandByObject(g));
  collectDeviceGroups(state,b.devPath,deviceOccurrenceScope(tree,b)).forEach((g) => boxB.expandByObject(g));
  expect(boxB.min.x-boxA.min.x).toBeCloseTo(5);
});

it('real GLB round trip keeps repeated child assembly paths; highlight clones materials per occurrence', async () => {
  const files = fixture(), tree = (await buildCbmTree(files))!;
  const compiled = await serializeDevToGlbDetailed('root.dev',files);
  const state = new AppState(); state.currentCbmTree = tree;
  const pool = new DevGlbTemplatePool({ session:state.captureProjectSession(),isCurrent:() => true,parse:parseDevGlbAsset });
  const prepared = await pool.prepare('root.dev',compiled.bytes!);
  expect(prepared?.kind).toBe('shared'); if (prepared?.kind !== 'shared') return;
  for (const seed of tree.children) {
    const group = prepared.template.createPlacement({ rootOccurrence:seed.path, placementMatrix:seed.path.includes('B.cbm') ? [...identity.slice(0,12),5000,0,0,1] : identity });
    state.loadedXmlModGroups.set(seed.path,group);
  }
  const part = tree.children[0].children.find((n) => n.path === 'CBM/part1.cbm')!;
  const selected = collectDeviceGroups(state,part.devPath,deviceOccurrenceScope(tree,part));
  expect(selected.map((g) => g.userData.assemblyPath).sort()).toEqual(['sub:0','sub:2']);
  const aMesh = selected[0].children[0] as THREE.Mesh;
  const bMeshes: THREE.Mesh[] = []; state.loadedXmlModGroups.get('CBM/B.cbm')!.traverse((o) => { if ((o as THREE.Mesh).isMesh) bMeshes.push(o as THREE.Mesh); });
  const original = bMeshes[0].material;
  highlightModGroups(state,selected);
  expect(bMeshes[0].material).toBe(original);
  expect(aMesh.material).not.toBe(original);
  resetModHighlight(state); pool.dispose();
});

it('a project switch during camera await cannot reset or highlight the new project', async () => {
  const state = new AppState();
  const group = new THREE.Group(); group.userData.devPath='root.dev'; group.userData.rootOccurrence='CBM/A.cbm';
  group.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial()));
  state.loadedXmlModGroups.set('A',group);
  let finish!: () => void; mock.frame.mockImplementation(() => new Promise<void>((resolve) => { finish=resolve; }));
  const pending = frameAndHighlightDevice(mock.ctx as ViewerContext,state,'root.dev',{ rootOccurrence:'CBM/A.cbm' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  state.activateProject(2,'new');
  finish(); await pending;
  expect(mock.ctx.fragments.resetHighlight).not.toHaveBeenCalled();
  expect(state.highlightedModState).toBeNull();
});

it('a project switch during IFC reset await preserves the new highlight state', async () => {
  const state = new AppState();
  const group = new THREE.Group(); group.userData.devPath='root.dev'; group.userData.rootOccurrence='CBM/A.cbm';
  group.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial()));
  state.loadedXmlModGroups.set('A',group);
  state.highlightedItems = {};
  let finish!: () => void;
  mock.ctx.fragments.resetHighlight.mockImplementation(() => new Promise<void>((resolve) => { finish=resolve; }));
  const pending = frameAndHighlightDevice(mock.ctx as ViewerContext,state,'root.dev',{rootOccurrence:'CBM/A.cbm'});
  await vi.waitFor(() => expect(finish).toBeDefined());
  state.activateProject(2,'new');
  const newItems = {}; state.highlightedItems = newItems;
  highlightModGroups(state,[group]);
  const newHighlight = state.highlightedModState;
  finish(); await pending;
  expect(state.highlightedItems).toBe(newItems);
  expect(state.highlightedModState).toBe(newHighlight);
  resetModHighlight(state);
});
