import { afterEach, describe, expect, it } from 'vitest';
import type { GimGraph, GimGraphNode } from '../../gim/gimGraphTypes.js';
import type { CrossMarker, LineMapData, TowerMarker, WireSegment } from '../../gim/lineMapData.js';
import {
  buildLineNavigationIndex,
  buildLineNavigationSearchIndex,
  renderLineNavigationTree,
  resolveLineNavigationTarget,
  revealLineNavigationTarget,
} from '../lineNavigationTreeView.js';

function node(overrides: Partial<GimGraphNode> = {}): GimGraphNode {
  return {
    path: 'Cbm/project.cbm',
    name: 'project',
    entityName: '',
    classifyName: '',
    rawProps: {},
    children: [],
    refs: {
      cbmFiles: [], devFiles: [], famFiles: [], phmFiles: [], modFiles: [],
      stlFiles: [], wireFiles: [], ifcFiles: [], rawRefs: {},
    },
    ...overrides,
  };
}

function makeLineFixture(): {
  graph: GimGraph;
  mapData: LineMapData;
  nodes: { f3a: GimGraphNode; f3b: GimGraphNode; tower0: GimGraphNode; tower2: GimGraphNode; wireA: GimGraphNode; wireB: GimGraphNode; wireC: GimGraphNode; cross: GimGraphNode };
} {
  const towerDevice0 = node({
    path: 'Cbm/tower-device-0.cbm', name: 'Tower_Device', entityName: 'Tower_Device',
  });
  const tower0 = node({
    path: 'Cbm/tower-0.cbm', name: 'TOWER', entityName: 'F4System', classifyName: 'TOWER',
    rawProps: { GROUPTYPE: 'TOWER', BLHA: '30,120,0,0', 'STRING0.STRING': 'string-0.cbm' },
    children: [towerDevice0],
  });
  const tower2 = node({
    path: 'Cbm/tower-2.cbm', name: 'TOWER', entityName: 'F4System', classifyName: 'TOWER',
    rawProps: { GROUPTYPE: 'TOWER', BLHA: '32,122,0,0', 'STRING0.STRING': 'string-2.cbm' },
  });
  const wireA = node({
    path: 'Cbm/wire-a.cbm', name: 'WIRE', entityName: 'WIRE', classifyName: 'CONDUCTOR',
    rawProps: { 'POINT0.BLHA': '30,120,0,0', 'POINT1.BLHA': '31,121,0,0' },
  });
  const wireB = node({
    path: 'Cbm/wire-b.cbm', name: 'WIRE', entityName: 'WIRE', classifyName: 'OPGW',
    rawProps: { 'POINT0.BLHA': '30,120,0,0', 'POINT1.BLHA': '31,121,0,0' },
  });
  const wireC = node({
    path: 'Cbm/wire-c.cbm', name: 'WIRE', entityName: 'WIRE', classifyName: 'GROUNDWIRE',
    rawProps: { 'POINT0.BLHA': '30,120,0,0', 'POINT1.BLHA': '31,121,0,0' },
  });
  const wireGroupA = node({
    path: 'Cbm/wire-group-a.cbm', name: 'WIRE', entityName: 'F4System', classifyName: 'WIRE',
    rawProps: { GROUPTYPE: 'WIRE', BACKSTRING: 'string-0.cbm', FRONTSTRING: 'string-1.cbm' },
    children: [wireA, wireC],
  });
  const wireGroupB = node({
    path: 'Cbm/wire-group-b.cbm', name: 'WIRE', entityName: 'F4System', classifyName: 'WIRE',
    rawProps: { GROUPTYPE: 'WIRE', BACKSTRING: 'string-0.cbm', FRONTSTRING: 'string-1.cbm' },
    children: [wireB],
  });
  const cross = node({
    path: 'Cbm/cross-road.cbm', name: 'CROSS', entityName: 'F4System', classifyName: 'CROSS',
    rawProps: { GROUPTYPE: 'CROSS' },
  });
  const f3a = node({
    path: 'Cbm/f3-a.cbm', name: 'F3System', entityName: 'F3System',
    children: [tower0, wireGroupA],
  });
  // F3 边界只有后一座塔，档距端点仍从 WIRE 坐标补回前一段的塔位。
  const tower1 = node({
    path: 'Cbm/tower-1.cbm', name: 'TOWER', entityName: 'F4System', classifyName: 'TOWER',
    rawProps: { GROUPTYPE: 'TOWER', BLHA: '31,121,0,0', 'STRING0.STRING': 'string-1.cbm' },
  });
  const f3b = node({
    path: 'Cbm/f3-b.cbm', name: 'F3System', entityName: 'F3System',
    children: [tower1, tower2, wireGroupB, cross],
  });
  const f2 = node({ path: 'Cbm/f2.cbm', entityName: 'F2System', name: 'F2System', children: [f3a, f3b] });
  const f1 = node({ path: 'Cbm/f1.cbm', entityName: 'F1System', name: 'F1System', children: [f2] });
  const root = node({ path: 'Cbm/project.cbm', name: 'project', children: [f1] });

  const towerMarker = (source: GimGraphNode, number: string, lat: number, lng: number): TowerMarker => ({
    cbmPath: source.path, lat, lng, elev: 0, azimuth: 0, towerNumber: number,
    towerType: '直线塔', dataQuality: 'full', nodeRef: source,
  });
  const towers = [
    towerMarker(tower0, 'N10', 30, 120),
    towerMarker(tower1, 'N2', 31, 121),
    towerMarker(tower2, 'N3', 32, 122),
  ];
  const wire = (source: GimGraphNode, wireType: string): WireSegment => ({
    startLat: 30, startLng: 120, endLat: 31, endLng: 121,
    wireType, kValue: '1', split: wireType === 'CONDUCTOR' ? '4' : '1', nodeRef: source,
    startElev: 0, endElev: 0, spanMeters: 100, groupKind: 'inter-point',
  });
  const crosses: CrossMarker[] = [{ cbmPath: cross.path, lat: null, lng: null, crossType: 'CROSS', name: 'CROSS', nodeRef: cross }];
  const mapData: LineMapData = {
    towers,
    wires: [wire(wireA, 'CONDUCTOR'), wire(wireB, 'OPGW'), wire(wireC, 'GROUNDWIRE')],
    crosses,
    bbox: { minLat: 30, maxLat: 32, minLng: 120, maxLng: 122 },
    warnings: [],
    stats: { towerTotal: 3, towerWithBlha: 3, towerWithFam: 3, wireTotal: 3, wireWithEndpoints: 3, crossTotal: 1, crossWithCoord: 0 },
    unresolved: { towers: [], wires: [], crosses: [cross.path], famSources: [], devSources: [] },
  };
  const nodesByPath = new Map<string, GimGraphNode>();
  const walk = (current: GimGraphNode): void => { nodesByPath.set(current.path, current); current.children.forEach(walk); };
  walk(root);
  return { graph: { projectType: 'transmission_line', root, nodesByPath, filesByType: { cbm: [], dev: [], fam: [], phm: [], mod: [], stl: [], ifc: [], other: [] }, stats: {} }, mapData, nodes: { f3a, f3b, tower0, tower2, wireA, wireB, wireC, cross } };
}

describe('line navigation tree projection', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('把 F3 映射为耐张段，按塔号排序、聚合同一档距并保留类型明细', () => {
    const fixture = makeLineFixture();
    const index = buildLineNavigationIndex(fixture.graph, fixture.mapData);
    expect(index.stats.sectionCount).toBe(1);
    expect(index.stats.strainSectionCount).toBe(2);
    expect(index.stats.towerCount).toBe(3);
    expect(index.stats.spanCount).toBe(1);
    expect(index.stats.wireCount).toBe(3);
    expect(index.stats.unassociatedCrossCount).toBe(1);

    const section = index.route.children.find((child) => child.kind === 'section');
    expect(section).toBeDefined();
    const firstStrain = section!.children[0];
    expect(firstStrain.kind).toBe('strain-section');
    expect(firstStrain.children.map((child) => child.kind)).toEqual(['tower', 'span', 'tower']);
    expect(firstStrain.children[0].label).toBe('N2 杆塔');
    expect(firstStrain.children[1].children.map((child) => child.label)).toEqual(['导线', '地线', 'OPGW']);
    expect(firstStrain.children[1].children.map((child) => child.subtitle)).toEqual(['100.0 m · 分裂 4', '100.0 m · 分裂 1', '100.0 m · 分裂 1']);
    // wire 端点补入后一 F3 的边界塔，且共享来源路径可反查到业务行。
    const secondStrain = section!.children[1];
    expect(secondStrain.children.some((child) => child.label === 'N2 杆塔')).toBe(true);
    expect(index.targetBySourcePath.get(fixture.nodes.wireA.path)).toContain('line-navigation:span:');
  });

  it('默认行不出现 F1/F2/F3/F4 和设备原始类型，跨越物进入待关联组', () => {
    const fixture = makeLineFixture();
    const index = buildLineNavigationIndex(fixture.graph, fixture.mapData);
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderLineNavigationTree(index, host, () => undefined);
    const labels = Array.from(host.querySelectorAll<HTMLElement>('.line-navigation-label')).map((element) => element.textContent || '');
    expect(labels.some((label) => /F[1-4]System|Tower_Device|Wire_Device/.test(label))).toBe(false);
    expect(host.querySelectorAll('.line-navigation-meta')).not.toHaveLength(0);
    expect(Array.from(host.querySelectorAll<HTMLElement>('.line-navigation-meta')).every((meta) => meta.textContent === '')).toBe(true);
    const pending = index.route.children[index.route.children.length - 1];
    expect(pending?.kind).toBe('unassociated-crossings');
    expect(pending?.children[0].label).toContain('跨越物');
  });

  it('缺少塔号或档距端点时不把 cbm 文件名和起点/终点占位符写入导航', () => {
    const fixture = makeLineFixture();
    const index = buildLineNavigationIndex(fixture.graph, {
      ...fixture.mapData,
      towers: [],
    });
    const labels = Array.from(index.nodesByKey.values()).map((node) => node.label);
    expect(labels.some((label) => /\.cbm/i.test(label))).toBe(false);
    expect(labels.some((label) => label.includes('起点') || label.includes('终点'))).toBe(false);
    expect(labels).toContain('档距');
    expect(labels.some((label) => /^杆塔 \d{2}$/.test(label))).toBe(true);
  });

  it('搜索命中后展开工程→线路→区段→耐张段祖先链，并支持来源路径别名', () => {
    const fixture = makeLineFixture();
    const index = buildLineNavigationIndex(fixture.graph, fixture.mapData);
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderLineNavigationTree(index, host, () => undefined);
    const items = buildLineNavigationSearchIndex(index);
    const towerItem = items.find((item) => item.key === fixture.nodes.tower2.path);
    expect(towerItem).toBeDefined();
    const rowKey = revealLineNavigationTarget(index, towerItem!.key);
    expect(rowKey).toBeTruthy();
    const row = Array.from(host.querySelectorAll<HTMLElement>('.line-navigation-row'))
      .find((candidate) => candidate.dataset.nodePath === rowKey);
    expect(row).not.toBeUndefined();
    expect(row?.textContent).toContain('N3 杆塔');
  });

  it('隐藏的 Tower_Device CBM 来源回溯到可见杆塔行，并兼容裸文件名/反斜杠', () => {
    const fixture = makeLineFixture();
    const index = buildLineNavigationIndex(fixture.graph, fixture.mapData);
    const target = resolveLineNavigationTarget(index, '\\Cbm\\tower-device-0.cbm');
    expect(target?.kind).toBe('tower');
    expect(target?.label).toBe('N10 杆塔');
    expect(resolveLineNavigationTarget(index, 'tower-device-0.cbm')?.key).toBe(target?.key);
  });
});
