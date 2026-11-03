import { expect, it } from 'vitest';
import { extractEngineeringSourceGraph } from '../engineering/sourceGraph.js';
import { buildEngineeringSources } from '../engineering/buildSources.js';
import { projectEngineeringNavigation } from '../engineering/navigation.js';
import { collectCompositionEvidence } from '../engineering/compositionContexts.js';
import { assignEngineeringComposition } from '../../engineering/compositionTemplate.js';
import type { CompositionNode } from '../../engineering/composition.js';

async function fixture(raw: Record<string, string>) {
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(raw), readText: async path => raw[path] });
  const built = buildEngineeringSources('sample', graph, [], []);
  return { ...built, graph, view: projectEngineeringNavigation(built.sources, built.snapshot) };
}
function paths(f: Awaited<ReturnType<typeof fixture>>, name: string): string[][] {
  const entity = f.snapshot.entities.find(entity => entity.name === name)!;
  expect(entity, name).toBeDefined();
  return (f.view.composition.rowsByEntity.get(entity.id) ?? []).map(row => {
    const names: string[] = []; let current: string | undefined = row;
    while (current) { const node: CompositionNode = f.view.composition.nodes.get(current)!; names.unshift(node.title); current = node.parent; }
    return names;
  });
}

it('projects a declared main unit without promoting the transformer purpose from organization labels', async () => {
  const f = await fixture({ 'project.cbm': 'SUBSYSTEM0=main.cbm\nSUBSYSTEM1=foundation.cbm',
    'main.cbm': 'ENTITYNAME=F3System\nSYSTEMNAME1=电气系统\nSYSTEMNAME2=主变系统01\nSYSTEMNAME3=主变01\nOBJECTMODELPOINTER=main.dev',
    'main.dev': 'TYPE=OilFilledTransformer\nSYMBOLNAME=220kV变压器模型ZJ01_1\nSUBDEVICE0=box.dev', 'box.dev': 'SYMBOLNAME=独立端子箱',
    'foundation.cbm': 'ENTITYNAME=F2System\nSYSTEMNAME2=主变系统01\nOBJECTMODELPOINTER=foundation.dev', 'foundation.dev': 'SYMBOLNAME=独立基础' });
  const main = f.snapshot.entities.find(entity => entity.category === 'E-T')!;
  expect(main.name).toBe('220kV变压器模型ZJ01_1');
  expect(paths(f, main.name)[0]).toEqual(expect.arrayContaining(['安装工程', '主变压器系统', '1号主变']));
  expect(main.sourceIds).toHaveLength(2);
  expect(paths(f, '独立基础')[0]).toEqual(expect.arrayContaining(['建筑工程', '主变压器系统区域', '基础']));
  expect(f.snapshot.entities).toHaveLength(2);
});

it('preserves declared buildings with unconfirmed members instead of replacing them by generic IFC containers', async () => {
  const f = await fixture({ 'project.cbm': 'SUBSYSTEM0=building.cbm',
    'building.cbm': 'SYSTEMNAME1=建筑物系统\nSYSTEMNAME2=生产建筑物\nSYSTEMNAME3=主控通信楼01' });
  const building = [...f.view.composition.nodes.values()].find(node => node.title === '主控通信楼01')!;
  expect(building.entityCount).toBe(0); expect(building.declaredContextIds).toHaveLength(1);
  expect(f.snapshot.entities).toEqual([]);
  expect(f.view.sourceNodes.get(`source:cbm:${building.declaredContextIds![0]}`)?.documentPath).toBe('building.cbm');
});

it('uses the declared unit 36S as a bay without requiring 间隔 or any fixed F/SYSTEMNAME level', async () => {
  for (const [level, field] of [['F2System', 'SYSTEMNAME3'], ['PARTINDEX', 'SYSTEMNAME7']]) {
    const f = await fixture({ 'project.cbm': 'SUBSYSTEM0=left.cbm\nSUBSYSTEM1=right.cbm',
      'left.cbm': `ENTITYNAME=${level}\nSYSTEMNAME1=交流电气系统\nSYSTEMNAME2=10kV系统\n${field}=36S\nOBJECTMODELPOINTER=shared.dev`,
      'right.cbm': 'ENTITYNAME=F4System\nSYSTEMNAME1=交流电气系统\nSYSTEMNAME2=10千伏配电装置\nSYSTEMNAME3=24S\nOBJECTMODELPOINTER=shared.dev',
      'shared.dev': 'TYPE=SwitchCabinet\nSYMBOLNAME=10kV馈线柜\nSUBDEVICE0=button.dev', 'button.dev': 'TYPE=Button\nSYMBOLNAME=按钮' });
    const view = f.view.composition, names = [...view.nodes.values()].map(node => node.title);
    expect(names).toEqual(expect.arrayContaining(['安装工程', '10千伏配电装置', '36S间隔', '24S间隔']));
    expect(f.snapshot.entities).toHaveLength(2); expect(view.nodes.get(view.rootKey)?.entityCount).toBe(2);
    expect(names).not.toContain('设备'); expect(names).not.toContain('装置性材料');
    const search = f.view.compositionSearch.filter(item => item.title === '10kV馈线柜');
    expect(search).toHaveLength(2);
    expect(search.map(item => item.subtitle).join(' / ')).toEqual(expect.stringContaining('36S间隔'));
    expect(search.map(item => item.subtitle).join(' / ')).toEqual(expect.stringContaining('24S间隔'));
    for (const item of search) { expect(item.subtitle).not.toContain('按钮'); expect(item.searchText).toContain('按钮'); }
  }
});

it('keeps a main-transformer incoming bay in its distribution installation and its support in civil works', async () => {
  const f = await fixture({ 'project.cbm': 'SUBSYSTEM0=bay.cbm',
    'bay.cbm': 'SYSTEMNAME1=电气系统\nSYSTEMNAME2=10kV系统\nSYSTEMNAME3=主变进线间隔01\nOBJECTMODELPOINTER=cabinet.dev\nSUBSYSTEM0=support.cbm',
    'cabinet.dev': 'TYPE=SwitchCabinet\nSYMBOLNAME=10kV主变进线柜', 'support.cbm': 'OBJECTMODELPOINTER=support.dev', 'support.dev': 'SYMBOLNAME=设备支架' });
  expect(paths(f, '10kV主变进线柜')[0]).toEqual(expect.arrayContaining(['安装工程', '10千伏配电装置', '主变进线间隔01']));
  expect(paths(f, '设备支架')[0]).toEqual(expect.arrayContaining(['建筑工程', '10千伏配电装置区域', '构支架']));
  expect([...f.view.composition.nodes.values()].map(row => row.title)).not.toContain('主变压器系统');
});

it('falls back from a placeholder IfcBuilding name to the delivery building name', async () => {
  const graph=await extractEngineeringSourceGraph({paths:['project.cbm','body.dev'],readText:async p=>p==='project.cbm'?'OBJECTMODELPOINTER=body.dev':'SYMBOLNAME=主体'});
  const object={key:'object',modelId:'m',expressId:1,ifcType:'IFCWALL',globalId:'g',name:'墙',sourcePath:'CBM/04-建筑配电楼.ifc',parentObjectKey:null,childObjectKeys:[],relationshipCount:0,spatialKey:'building',spatialKeys:['building'],spatialContainment:null,geometryStatus:'represented'};
  const node={key:'building',modelId:'m',expressId:2,ifcType:'IFCBUILDING',kind:'building',globalId:'b',name:'HN-220-B-2总平面',sourcePath:'CBM/04-建筑配电楼.ifc',parentKey:null,longName:''};
  const built=buildEngineeringSources('sample',graph,[object as never],[{modelId:'m',path:'CBM/04-建筑配电楼.ifc'}] as never,[node as never]);
  const facts=collectCompositionEvidence(built.sources,built.snapshot,new Map([[node.key,node as never]]));
  expect(facts.find(fact=>fact.spaces.length)?.spaces[0].building.value).toBe('配电楼');
});

it('maps confirmed IFC object context through its exact source link and retains its engineering category', async () => {
  const f = await fixture({ 'project.cbm': 'SUBSYSTEM0=bay.cbm', 'bay.cbm': 'SYSTEMNAME2=10kV系统\nSYSTEMNAME3=36S' });
  const occurrence = f.graph.cbmOccurrences.find(node => node.documentPath === 'bay.cbm')!.id;
  const source = { id: 'ifc:m#1', track: 'ifc' as const, source: 'model.ifc', name: '未知交付产品', source_type: 'IFCBUILDINGELEMENTPROXY', parent: '', properties: [], sources: ['model.ifc'], context: [], guid: 'g' };
  f.sources.ifcRecords.push(source); f.sources.ifcMatches.push({ cbmOccurrenceId: occurrence, sourcePath: 'bay.cbm', rawGuid: 'g', status: 'confirmed', ifcSourceIds: [source.id], devSourceIds: [] });
  f.snapshot.entities.push({ id: 'whole:unknown', name: source.name, category: 'U-OBJECT', kind: 'whole', sourceIds: [source.id], boundaryEvidence: 'source-instance', classificationState: 'unknown', classificationConflicts: 0 });
  const assignment = assignEngineeringComposition(f.snapshot,collectCompositionEvidence(f.sources, f.snapshot, new Map())).find(row => row.entityId === 'whole:unknown')!;
  expect(assignment.paths[0].map(group => group.title)).toEqual(['安装工程', '10千伏配电装置', '36S间隔']);
  expect(f.snapshot.entities[0].classificationState).toBe('unknown');
});
