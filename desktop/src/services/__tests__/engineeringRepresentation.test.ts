import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import { getEngineeringRepresentations } from '../engineeringRepresentationService.js';
import { selectEngineeringTarget, reconcileEngineeringSelection } from '../engineeringSelection.js';
import { projectEngineeringNavigation } from '../../gim/engineering/navigation.js';
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
    'body.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=box.dev\nSUBDEVICE1=radiator.dev',
    'box.dev': 'SYMBOLNAME=测控柜', 'radiator.dev': 'SYMBOLNAME=散热器',
  };
  if (declaredBuilding) data['building.cbm'] = 'SYSTEMNAME1=建筑物系统\nSYSTEMNAME2=生产建筑物\nSYSTEMNAME3=主控通信楼01';
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(data), readText: async p => data[p] });
  const built = buildEngineeringSources('package', graph, [], []), state = new AppState();
  state.activateProject(1, 'package'); state.engineeringSources = built.sources; state.engineeringSnapshot = built.snapshot;
  state.engineeringNavigation = projectEngineeringNavigation(built.sources, built.snapshot);
  state.currentCbmTree = node('project.cbm', [node('unit.cbm')]);
  const rootId = graph.records.find(row => row.devOccurrence?.rootSourceId === row.id)!.id;
  const root = new THREE.Group(); root.userData.rootOccurrence = rootId;
  const mesh = (assemblyPath: string) => { const group = new THREE.Group(); group.userData.assemblyPath = assemblyPath;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); group.add(mesh); root.add(group); return mesh; };
  const body = mesh(''), box = mesh('sub:0'), radiator = mesh('sub:1');
  state.loadedXmlModGroups.set('physical', root);
  const main = built.snapshot.entities.find(e => e.category === 'E01')!, terminal = built.snapshot.entities.find(e => e.category === 'E16.control_cabinet')!;
  return { state, graph, rootId, root, body, box, radiator, main, terminal };
}

describe('source-to-physical representation adapter and filters', () => {
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
    expect(f.state.representationSelection?.isCurrent()).toBe(true);
    expect(f.state.representationSelection?.devRoots).toEqual(f.state.engineeringSelection?.devRoots);
    f.state.setOnlySelected(true);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, false, true]);
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.terminal.id });
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([false, true, false]);
    f.state.setOnlySelected(false);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, true, true]);
  });
  it('restores pre-existing per-mesh visibility and does not let a stale inspector overwrite a newer whole', async () => {
    const f = await fixture(); f.radiator.visible = false;
    const previous = selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id });
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.terminal.id }); await previous;
    expect(document.querySelector('.props-header')?.textContent).toBe('测控柜');
    f.state.setOnlySelected(true); f.state.setOnlySelected(false);
    expect(f.radiator.visible).toBe(false);
    expect(f.state.selectionRequest?.target?.key).toBe(f.terminal.id);
  });
  it('selects a view group as a deduplicated whole collection without inventing another entity', async () => {
    const f = await fixture(), count = f.state.engineeringSnapshot!.entities.length;
    await selectEngineeringTarget(f.state, { kind: 'engineering-group', key: f.state.engineeringNavigation!.composition.rootKey });
    f.state.setOnlySelected(true);
    expect(f.state.engineeringSelection?.ownerIds).toEqual(new Set([f.main.id, f.terminal.id]));
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, true, true]);
    expect(f.state.engineeringSnapshot!.entities).toHaveLength(count);
    expect(document.body.textContent).toContain('工程分组范围');
  });
  it('restores the view when inspecting an unassigned declaration after isolation and preserves pre-existing hidden members', async () => {
    const f = await fixture(false, true); f.radiator.visible = false;
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id }); f.state.setOnlySelected(true);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, false, false]);
    const building = [...f.state.engineeringNavigation!.composition.nodes.values()].find(node => node.title === '主控通信楼01')!;
    await selectEngineeringTarget(f.state, { kind: 'engineering-group', key: building.key });
    expect(f.state.onlySelected).toBe(false);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, true, false]);
    expect((document.getElementById('engineering-isolate') as HTMLButtonElement).disabled).toBe(true);
    expect(f.state.engineeringSelection?.sourceIds.size).toBe(0);
    expect(f.state.canIsolateSelection).toBe(false); f.state.setOnlySelected(true);
    expect(f.state.onlySelected).toBe(false);
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
    const f = await fixture(); await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id }); f.state.setOnlySelected(true);
    const request = f.state.selectionRequest!, next = structuredClone(f.state.engineeringSnapshot!);
    const source = f.graph.records.find(row => row.name === '散热器')!.id;
    next.memberships.find(member => member.sourceId === source)!.ownerId = f.terminal.id;
    next.entities.find(entity => entity.id === f.main.id)!.sourceIds = f.main.sourceIds.filter(id => id !== source);
    next.entities.find(entity => entity.id === f.terminal.id)!.sourceIds.push(source);
    f.state.engineeringSnapshot = next; f.state.engineeringNavigation = projectEngineeringNavigation(f.state.engineeringSources!, next);
    expect(f.state.representationSelection?.isCurrent()).toBe(false);
    await reconcileEngineeringSelection(f.state, request);
    expect(f.state.selectionRequest?.id).toBe(request.id); expect(f.state.engineeringSelection?.snapshot).toBe(next);
    expect(f.state.representationSelection?.isCurrent()).toBe(true);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([true, false, false]);
  });
  it('clears an obsolete member range and offers candidates when a selected whole splits', async () => {
    const f = await fixture(); await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id }); f.state.setOnlySelected(true);
    const next = structuredClone(f.state.engineeringSnapshot!), [body, radiator] = f.main.sourceIds;
    next.entities = next.entities.filter(entity => entity.id !== f.main.id);
    next.entities.push({ ...f.main, id: 'new:body', sourceIds: [body] }, { ...f.main, id: 'new:radiator', sourceIds: [radiator] });
    for (const member of next.memberships) if (member.ownerId === f.main.id) member.ownerId = member.sourceId === body ? 'new:body' : 'new:radiator';
    next.relationships = [];
    f.state.engineeringSnapshot = next; f.state.engineeringNavigation = projectEngineeringNavigation(f.state.engineeringSources!, next);
    await reconcileEngineeringSelection(f.state, f.state.selectionRequest!);
    expect(f.state.engineeringSelection).toBeNull(); expect(document.querySelectorAll('[data-engineering-choice]')).toHaveLength(2);
    expect([f.body.visible, f.box.visible, f.radiator.visible]).toEqual([false, false, false]);
    document.querySelector<HTMLButtonElement>('[data-engineering-choice="0"]')!.click();
    await vi.waitFor(() => expect(f.state.engineeringSelection?.ownerIds.size).toBe(1));
  });
});
