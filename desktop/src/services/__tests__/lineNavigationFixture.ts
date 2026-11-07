import type { GimGraph, GimGraphNode } from '../../gim/gimGraphTypes.js';


import type { CrossMarker, LineMapData, TowerMarker, WireSegment } from '../../gim/lineMapData.js';
export function node(overrides: Partial<GimGraphNode> = {}): GimGraphNode {
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
export function parseFamFixture(text: string): Array<{ display_key: string; prop_key: string; prop_value: string; raw_line: string }> {
  return text.split(/\r?\n/).filter(Boolean).map((raw) => {
    const first = raw.indexOf('=');
    const second = first < 0 ? -1 : raw.indexOf('=', first + 1);
    if (first < 0 || second < 0) return { display_key: raw, prop_key: raw, prop_value: '', raw_line: raw };
    return {
      display_key: raw.slice(0, first),
      prop_key: raw.slice(first + 1, second),
      prop_value: raw.slice(second + 1),
      raw_line: raw,
    };
  });
}
export function makeLineFixture(): {
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