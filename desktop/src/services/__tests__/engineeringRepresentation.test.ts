import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { extractEngineeringSourceGraph } from '@gim/gim-sdk/source';
import {buildTestEngineeringSources} from '../../../../packages/gim-sdk/src/gim/engineering/__tests__/fixtures.js';
import { getEngineeringRepresentations } from '../engineeringRepresentationService.js';
import { selectEngineeringTarget, reconcileEngineeringSelection } from '../engineeringSelection.js';
import { projectEngineeringNavigation } from '@gim/gim-sdk/projection';
import type { CbmNode } from '../../gim/types.js';

vi.mock('../../ui/dom.js', async () => {
  const original = await vi.importActual<typeof import('../../ui/dom.js')>('../../ui/dom.js');
  const drawer = document.createElement('aside'), body = document.createElement('div');
  drawer.id = 'props-drawer'; body.id = 'props-drawer-body'; drawer.append(body); document.body.append(drawer);
  return { ...original, propsDrawer: drawer, propsDrawerBody: body, btnCloseProps: document.createElement('button'), btnExportProps: document.createElement('button') };
});

const node = (path: string, children: CbmNode[] = []): CbmNode => ({ path, name: path, entityName: 'F2System', rawProperties: {},
  children, famPath: '', devPath: '', ifcFile: '', ifcGuid: '', classifyName: '', transformMatrix: '', systemNames: [], devSymbolName: '', devType: '', devExpanded: false });
async function fixture(shared = false, declaredBuilding = false) {
  const data: Record<string, string> = {
    'project.cbm': `SUBSYSTEM0=unit.cbm${shared ? '\nSUBSYSTEM1=unit.cbm' : ''}${declaredBuilding ? '\nSUBSYSTEM2=building.cbm' : ''}`,
    'unit.cbm': 'OBJECTMODELPOINTER=body.dev',
    'body.dev': 'TYPE=OilImmersedTransformer\nPURPOSE=主变\nSYMBOLNAME=主变压器\nSUBDEVICE0=box.dev\nSUBDEVICE1=radiator.dev',
    'box.dev': 'TYPE=ControlCabinet\nOBJECTROLE=independent\nSYMBOLNAME=测控柜', 'radiator.dev': 'TYPE=Radiator\nSYMBOLNAME=散热器',
  };
  if (declaredBuilding) data['building.cbm'] = 'SYSTEMNAME1=建筑物系统\nSYSTEMNAME2=生产建筑物\nSYSTEMNAME3=主控通信楼01';
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(data), readText: async p => data[p] });
  const built = buildTestEngineeringSources('package', graph, [], []), state = new AppState();
  state.activateProject(1, 'package'); state.engineering.sources = built.sources; state.engineering.snapshot = built.snapshot;
  state.engineering.navigation = projectEngineeringNavigation(built.sources, built.snapshot);
  state.currentCbmTree = node('project.cbm', [node('unit.cbm')]);
  const rootId = graph.records.find(row => row.devOccurrence?.rootSourceId === row.id)!.id;
  const root = new THREE.Group(); root.userData.rootOccurrence = rootId;
  const mesh = (assemblyPath: string) => { const group = new THREE.Group(); group.userData.assemblyPath = assemblyPath;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); group.add(mesh); root.add(group); return mesh; };
  const body = mesh(''), box = mesh('sub:0'), radiator = mesh('sub:1');
  state.loadedXmlModGroups.set('physical', root);
  const main = built.snapshot.entities.find(e => e.category === 'E01')!, terminal = built.snapshot.entities.find(e => e.category === 'E17')!;
  return { state, graph, rootId, root, body, box, radiator, main, terminal };
}

describe('source-to-physical representation adapter and filters', () => {
  it('uses the same whole and direct part hierarchy for the inspector and all three projections',async()=>{
    const raw:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=gis.dev',
      'gis.dev':'TYPE=GIS\nSYMBOLNAME=组合电器\nSUBDEVICE0=breaker.dev',
      'breaker.dev':'TYPE=CircuitBreaker\nSYMBOLNAME=内部断路器\nSUBDEVICE0=pt.dev',
      'pt.dev':'TYPE=PotentialTransformer\nSYMBOLNAME=内部互感器'};
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]});
    const built=buildTestEngineeringSources('p',graph,[],[]),state=new AppState();
    state.activateProject(1,'p');state.engineering.sources=built.sources;state.engineering.snapshot=built.snapshot;
    state.engineering.navigation=projectEngineeringNavigation(built.sources,built.snapshot);
    expect(built.snapshot.entities).toHaveLength(1);const whole=built.snapshot.entities[0];
    await selectEngineeringTarget(state,{kind:'engineering',key:whole.id},undefined,{fit:false,load:false});
    expect(document.getElementById('props-drawer-body')?.textContent).toContain('内部断路器 →');
    expect([...state.selection.engineeringSelection!.sourceIds].sort()).toEqual([...whole.sourceIds].sort());
    expect(state.engineering.navigation.inventory!.rowsByEntity.has(whole.id)).toBe(true);
    expect(state.engineering.navigation.composition.rowsByEntity.has(whole.id)).toBe(true);
    expect(whole.sourceIds.every(id=>state.engineering.navigation!.sourceRows.has(id))).toBe(true);
  });
  it('rejects binding a semantic snapshot to a different source revision',async()=>{
    const f=await fixture();
    expect(getEngineeringRepresentations(f.state)).not.toBeNull();
    const next=structuredClone(f.state.engineering.snapshot!);
    next.evidenceBinding.sourceRevision++;
    f.state.engineering.snapshot=next;
    expect(getEngineeringRepresentations(f.state)).toBeNull();
  });
  it('selects integrated GIS boxes with the host while keeping a standalone terminal box outside its isolated range',async()=>{
    const raw:Record<string,string>={'project.cbm':'SUBSYSTEM0=gis.cbm\nSUBSYSTEM1=free.cbm','gis.cbm':'OBJECTMODELPOINTER=gis.dev',
      'gis.dev':'TYPE=GIS\nSYMBOLNAME=组合电器GIS\nSUBDEVICE0=actuator.dev\nSUBDEVICE1=terminal.dev',
      'actuator.dev':'TYPE=OperatingMechanismBox\nSYMBOLNAME=操动机构箱','terminal.dev':'TYPE=TerminalBox\nOBJECTROLE=part\nSYMBOLNAME=端子箱','free.cbm':'OBJECTMODELPOINTER=free.dev','free.dev':'TYPE=TerminalBox\nOBJECTROLE=independent\nSYMBOLNAME=端子箱模型01:Null:2754317'};
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]}),built=buildTestEngineeringSources('p',graph,[],[]),state=new AppState();
    state.activateProject(1,'p');state.engineering.sources=built.sources;state.engineering.snapshot=built.snapshot;state.engineering.navigation=projectEngineeringNavigation(built.sources,built.snapshot);
    const gis=built.snapshot.entities.find(e=>e.category==='E05')!,free=built.snapshot.entities.find(e=>e.category==='M04')!;
    const mesh=(root:THREE.Group,assemblyPath:string)=>{const wrapper=new THREE.Group();wrapper.userData.assemblyPath=assemblyPath;const value=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());wrapper.add(value);root.add(wrapper);return value;};
    const gisRoot=new THREE.Group();gisRoot.userData.rootOccurrence=graph.records.find(r=>r.source==='gis.dev')!.id;
    const body=mesh(gisRoot,''),actuator=mesh(gisRoot,'sub:0'),terminal=mesh(gisRoot,'sub:1');
    const freeRoot=new THREE.Group();freeRoot.userData.rootOccurrence=graph.records.find(r=>r.source==='free.dev')!.id;const freeMesh=mesh(freeRoot,'');
    state.loadedXmlModGroups.set('gis',gisRoot);state.loadedXmlModGroups.set('free',freeRoot);
    const index=getEngineeringRepresentations(state)!.index;
    expect(index.resolveDev(gisRoot.userData.rootOccurrence,{assemblyPath:'sub:0'}).ownerIds).toEqual([gis.id]);
    expect(index.resolveDev(gisRoot.userData.rootOccurrence,{assemblyPath:'sub:1'}).ownerIds).toEqual([gis.id]);
    await selectEngineeringTarget(state,{kind:'engineering',key:gis.id});state.selection.setOnlySelected(true);
    expect([body.visible,actuator.visible,terminal.visible,freeMesh.visible]).toEqual([true,true,true,false]);
    await selectEngineeringTarget(state,{kind:'engineering',key:free.id});
    expect([body.visible,actuator.visible,terminal.visible,freeMesh.visible]).toEqual([false,false,false,true]);
    state.selection.setOnlySelected(false);
  });
  it('binds actual assembly paths independently of F labels', async () => {
    const f = await fixture(), representation = getEngineeringRepresentations(f.state)!;
    expect(representation.issues).toEqual([]);
    expect(representation.index.resolveDev(f.rootId, { assemblyPath: 'sub:0' }).ownerIds).toEqual([f.terminal.id]);
  });
  it('binds repeated CBM/template references to distinct actual source roots', async () => {
    const f = await fixture(true), representation = getEngineeringRepresentations(f.state)!;
    expect(representation.issues).toEqual([]); expect(representation.index.bySource.size).toBe(6);
    const roots = f.graph.records.filter(row => row.devOccurrence?.rootSourceId === row.id);
    expect(new Set(roots.map(row => row.id)).size).toBe(2);
    for (const root of roots) expect(representation.index.resolveDev(root.id, { assemblyPath: '' }).sourceIds).toContain(root.id);
    expect(representation.index.resolveDev('unit.cbm', { assemblyPath: '' }).sourceIds).toEqual([]);
  });
  it('isolates body members and preserves a nested control cabinet as an independent selection', async () => {
    const f = await fixture();
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id });
    expect(f.state.selection.representationSelection?.isCurrent()).toBe(true);
    expect(f.state.selection.representationSelection?.devRoots).toEqual(f.state.selection.engineeringSelection?.devRoots);
    f.state.selection.setOnlySelected(true);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, false, true]);
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.terminal.id });
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([false, true, false]);
    f.state.selection.setOnlySelected(false);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, true, true]);
  });
  it('restores pre-existing per-mesh visibility and does not let a stale inspector overwrite a newer whole', async () => {
    const f = await fixture(); f.radiator.visible = false;
    const previous = selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id });
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.terminal.id }); await previous;
    expect(document.querySelector('.props-header')?.textContent).toBe('测控柜');
    f.state.selection.setOnlySelected(true); f.state.selection.setOnlySelected(false);
    expect(f.radiator.visible).toBe(false);
    expect(f.state.selection.selectionRequest?.target?.key).toBe(f.terminal.id);
  });
  it('selects a view group as a deduplicated whole collection without inventing another entity', async () => {
    const f = await fixture(), count = f.state.engineering.snapshot!.entities.length;
    await selectEngineeringTarget(f.state, { kind: 'engineering-group', key: f.state.engineering.navigation!.composition.rootKey });
    f.state.selection.setOnlySelected(true);
    expect(f.state.selection.engineeringSelection?.ownerIds).toEqual(new Set([f.main.id, f.terminal.id]));
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, true, true]);
    expect(f.state.engineering.snapshot!.entities).toHaveLength(count);
    expect(document.body.textContent).toContain('对象数量2');
  });
  it('restores the view when inspecting an unassigned declaration after isolation and preserves pre-existing hidden members', async () => {
    const f = await fixture(false, true); f.radiator.visible = false;
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id }); f.state.selection.setOnlySelected(true);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, false, false]);
    const building = [...f.state.engineering.navigation!.composition.nodes.values()].find(node => node.title === '主控通信楼01')!;
    await selectEngineeringTarget(f.state, { kind: 'engineering-group', key: building.key });
    expect(f.state.selection.onlySelected).toBe(false);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, true, false]);
    expect((document.getElementById('engineering-isolate') as HTMLButtonElement).disabled).toBe(true);
    expect(f.state.selection.engineeringSelection?.sourceIds.size).toBe(0);
    expect(f.state.selection.canIsolateSelection).toBe(false); f.state.selection.setOnlySelected(true);
    expect(f.state.selection.onlySelected).toBe(false);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, true, false]);
  });
  it('keeps fine geometry explicit and returns only the selected representation roots to browsing', async () => {
    const f = await fixture(), refine = vi.fn(async () => []), releaseFine = vi.fn();
    f.state.deviceLodRuntime = { select: async () => [], clearSelection() {}, release() {}, diagnostics: {}, refine, releaseFine };
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id });
    expect(refine).not.toHaveBeenCalled();
    document.getElementById('engineering-refine')!.click();
    await vi.waitFor(() => expect(document.getElementById('engineering-refine-status')?.textContent).toContain('已准备'));
    expect(refine).toHaveBeenCalledTimes(1); expect(refine).toHaveBeenCalledWith(f.rootId);
    document.getElementById('engineering-release-fine')!.click();
    expect(releaseFine).toHaveBeenCalledTimes(1); expect(releaseFine).toHaveBeenCalledWith(f.rootId);
  });
  it('rebinds a selected whole to updated membership while keeping the same logical request', async () => {
    const f = await fixture(); await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id }); f.state.selection.setOnlySelected(true);
    const request = f.state.selection.selectionRequest!, next = structuredClone(f.state.engineering.snapshot!);
    const source = f.graph.records.find(row => row.name === '散热器')!.id;
    next.memberships.find(member => member.sourceId === source)!.ownerId = f.terminal.id;
    next.entities.find(entity => entity.id === f.main.id)!.sourceIds = f.main.sourceIds.filter(id => id !== source);
    next.entities.find(entity => entity.id === f.terminal.id)!.sourceIds.push(source);
    f.state.engineering.snapshot = next; f.state.engineering.navigation = projectEngineeringNavigation(f.state.engineering.sources!, next);
    expect(f.state.selection.representationSelection?.isCurrent()).toBe(false);
    await reconcileEngineeringSelection(f.state, request);
    expect(f.state.selection.selectionRequest?.id).toBe(request.id); expect(f.state.selection.engineeringSelection?.snapshot).toBe(next);
    expect(f.state.selection.representationSelection?.isCurrent()).toBe(true);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, false, false]);
  });
  it('clears an obsolete member range and offers candidates when a selected whole splits', async () => {
    const f = await fixture(); await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id }); f.state.selection.setOnlySelected(true);
    const next = structuredClone(f.state.engineering.snapshot!), [body, radiator] = f.main.sourceIds;
    next.entities = next.entities.filter(entity => entity.id !== f.main.id);
    next.entities.push({ ...f.main, id: 'new:body', sourceIds: [body] }, { ...f.main, id: 'new:radiator', sourceIds: [radiator] });
    for (const member of next.memberships) if (member.ownerId === f.main.id) member.ownerId = member.sourceId === body ? 'new:body' : 'new:radiator';
    next.relationships = [];
    f.state.engineering.snapshot = next; f.state.engineering.navigation = projectEngineeringNavigation(f.state.engineering.sources!, next);
    await reconcileEngineeringSelection(f.state, f.state.selection.selectionRequest!);
    expect(f.state.selection.engineeringSelection).toBeNull(); expect(document.querySelectorAll('[data-engineering-choice]')).toHaveLength(2);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([false, false, false]);
    document.querySelector<HTMLButtonElement>('[data-engineering-choice="0"]')!.click();
    await vi.waitFor(() => expect(f.state.selection.engineeringSelection?.ownerIds.size).toBe(1));
  });
});
