import { expect, it } from 'vitest';
import { assignEngineeringComposition, type CompositionContextEvidence } from '../compositionTemplate.js';
import { projectEngineeringComposition } from '../composition.js';
import type { EngineeringEntity, EngineeringSnapshot } from '../types.js';

const entity = (id: string, category: string, name = id): EngineeringEntity => ({ id, name, category, sourceIds: [id], kind: 'whole', boundaryEvidence: 'declared', classificationState: 'identified', classificationConflicts: 0 });
const snapshot = (entities: EngineeringEntity[]): EngineeringSnapshot => ({ scope: 'test', rulesVersion: 'test', entities, memberships: [], pending: [], aliases: [], relationships: [], diagnostics: [] });
const fact = (entityId: string, values: string[] = []): CompositionContextEvidence => ({ entityId, declarations: [{ names: values.map((value, i) => ({ value, evidenceId: `${entityId}:${i}` })) }], spaces: [], hostEntityIds: [] });

it('separates buildings and storeys, site works and civil facilities from primary installation systems', () => {
  const model = snapshot([entity('floor1', 'C-A4'), entity('floor2', 'C-A4'), entity('road', 'C-C5'), entity('trench', 'C-C1'), entity('lamp', 'C-D1'),
    entity('hvac', 'E19', '中央空调'), entity('water', 'C-D5', '给水管'), entity('fire', 'C-D2'), entity('capacitor', 'E10'), entity('aux', 'E03'), entity('secondary', 'E16'), entity('cable', 'M05'), entity('earth', 'M06')]);
  const evidence = model.entities.map(e => fact(e.id));
  for (let i = 0; i < 2; i++) evidence[i].spaces = [{ building: { value: '继保通信楼', evidenceId: 'building' }, storeys: [{ value: `${i + 1}层`, evidenceId: `floor:${i}` }] }];
  const original = structuredClone(model), assignments = assignEngineeringComposition(model, evidence);
  const titles = (id: string) => assignments.find(a => a.entityId === id)!.paths[0].map(g => g.title);
  expect(titles('floor1')).toEqual(['建筑工程', '继保通信楼', '1层']); expect(titles('floor2')).toEqual(['建筑工程', '继保通信楼', '2层']);
  for (const [id, group] of [['road', '站区性建筑'], ['trench', '电缆沟'], ['lamp', '照明'], ['hvac', '采暖、通风、空调'], ['water', '给排水'], ['fire', '消防']]) expect(titles(id)).toEqual(['建筑工程', group]);
  for (const [id, group] of [['capacitor', '无功补偿系统'], ['aux', '站用电系统'], ['secondary', '二次及直流系统'], ['cable', '电缆'], ['earth', '接地系统']]) expect(titles(id)).toEqual(['安装工程', group]);
  expect(model).toEqual(original);
  const view = projectEngineeringComposition(model, assignments, '工程');
  expect(view.nodes.get(view.rootKey)?.children.map(key => view.nodes.get(key)!.title)).toEqual(['建筑工程', '安装工程']);
  expect(view.nodes.get(view.rootKey)?.entityCount).toBe(model.entities.length);
});

it('does not use neutral-point grounding as evidence of the station ground grid, or pick an arbitrary conflicting context', () => {
  const model = snapshot([entity('neutral', 'E04', '消弧线圈及接地变成套装置'), entity('shared', 'E09')]);
  const first = fact('neutral', ['10kV系统', '接地变间隔01']), second = fact('shared');
  second.declarations = [...fact('shared', ['10kV系统', '36S']).declarations, ...fact('shared', ['110kV系统', '出线间隔02']).declarations];
  const a = assignEngineeringComposition(model, [first, second]), b = assignEngineeringComposition(model, [first, { ...second, declarations: [...second.declarations].reverse() }]);
  expect(a.map(item => item.paths)).toEqual(b.map(item => item.paths));
  expect(a[0].paths[0].map(g => g.title)).toEqual(['安装工程', '10千伏配电装置', '接地变间隔01']);
  expect(a[1].paths[0].map(g => g.title)).toEqual(['未分类', 'DEV+IFC 轨道', '设备']);
});

it('does not infer operating voltage from an equipment rating or a building/storey from exporter placeholders', () => {
  const model = snapshot([entity('insulator', 'M04', '20kV支柱绝缘子'), entity('proxy', 'U-OBJECT')]);
  const proxy = fact('proxy'); proxy.spaces = [{ building: { value: 'Default Building', evidenceId: 'b' }, storeys: [{ value: '无', evidenceId: 's' }] }];
  const assigned = assignEngineeringComposition(model, [fact('insulator'), proxy]);
  expect(assigned[0].paths[0].map(group=>group.title)).toEqual(['未分类', 'DEV+IFC 轨道', '装置性材料']);
  expect(assigned[1].paths[0].map(group=>group.title)).toEqual(['未分类', 'DEV+IFC 轨道', '其他']);
  for (const value of ['Building s', '建筑s', '新建模 1', '新建模1', '新建筑 1', '新建筑1', 'HN-220-B-2总平面']) {
    proxy.spaces[0].building.value = value;
    expect(assignEngineeringComposition(model, [proxy])[1].paths[0].map(group=>group.title)).toEqual(['未分类', 'DEV+IFC 轨道', '其他']);
  }
});

it('keeps a foundation unresolved when its host has no confirmed installation system', () => {
  const model = snapshot([entity('host', 'E09'), entity('foundation', 'C-B2', '独立基础')]);
  const foundation = fact('foundation'); foundation.hostEntityIds = ['host'];
  const result = assignEngineeringComposition(model, [fact('host'), foundation]);
  expect(result[1].paths[0].map(group => group.title)).toEqual(['未分类', 'DEV+IFC 轨道', '构件']);
});

it('groups a distribution area before splitting supports and foundations', () => {
  const model = snapshot([entity('host', 'E09'), entity('support', 'C-B1', '设备支架'), entity('foundation', 'C-B2', '独立基础')]);
  const host = fact('host', ['10kV系统', '36S']);
  const support = fact('support'); support.hostEntityIds = ['host'];
  const foundation = fact('foundation'); foundation.hostEntityIds = ['host'];
  const result = assignEngineeringComposition(model, [host, support, foundation]);
  const titles = (id: string) => result.find(row => row.entityId === id)!.paths[0].map(group => group.title);
  expect(titles('support')).toEqual(['建筑工程', '10千伏配电装置区域', '支架']);
  expect(titles('foundation')).toEqual(['建筑工程', '10千伏配电装置区域', '基础']);
});

it('groups main-transformer supports and foundations under 主变区域', () => {
  const model = snapshot([entity('host', 'E01'), entity('support', 'C-B1', '设备支架'), entity('frame', 'C-B7', '构架'), entity('foundation', 'C-B2', '独立基础')]);
  const host = fact('host', ['110kV主变压器系统']);
  const support = fact('support'); support.hostEntityIds = ['host'];
  const frame = fact('frame'); frame.hostEntityIds = ['host'];
  const foundation = fact('foundation'); foundation.hostEntityIds = ['host'];
  const result = assignEngineeringComposition(model, [host, support, frame, foundation]);
  const titles = (id: string) => result.find(row => row.entityId === id)!.paths[0].map(group => group.title);
  expect(titles('support')).toEqual(['建筑工程', '主变区域', '支架']);
  expect(titles('frame')).toEqual(['建筑工程', '主变区域', '构架']);
  expect(titles('foundation')).toEqual(['建筑工程', '主变区域', '基础']);
});

it('marks declared composition anchors without a confirmed whole as unbound', () => {
  const view = projectEngineeringComposition(snapshot([]), [], '工程', [{
    path: [{ key: 'building:配电楼', title: '配电楼', kind: 'building' }], evidence: ['declared'], sourceContextIds: ['c1'],
  }]);
  const group = [...view.nodes.values()].find(node => node.title === '配电楼')!;
  expect(group).toMatchObject({ kind: 'group', entityCount: 0, unbound: true });
});

it('nests a room/MEP delivery under a project building instead of creating a peer building', () => {
  const model = snapshot([entity('room', 'C-A1', '35kV配电室')]);
  const fact = (entityId: string): CompositionContextEvidence => ({ entityId, declarations: [], spaces: [{ building: { value: '配电室', evidenceId: 'room-building' }, storeys: [] }], hostEntityIds: [], availableBuildings: [{ value: '辅助用房', evidenceId: 'aux' }, { value: '配电楼', evidenceId: 'main' }] });
  expect(assignEngineeringComposition(model, [fact('room')])[0].paths[0].map(group => group.title)).toEqual(['建筑工程', '配电楼', '配电室']);
});

it('keeps a standalone 警传室 or 消防泵房 as its own building, not a room', () => {
  const model = snapshot([entity('guard', 'C-A1', '警传室'), entity('fire', 'C-A1', '消防泵房')]);
  const facts: CompositionContextEvidence[] = [
    { entityId: 'guard', declarations: [], spaces: [{ building: { value: '警传室', evidenceId: 'g' }, storeys: [] }], hostEntityIds: [], availableBuildings: [{ value: '配电楼', evidenceId: 'main' }] },
    { entityId: 'fire', declarations: [], spaces: [{ building: { value: '消防泵房', evidenceId: 'f' }, storeys: [] }], hostEntityIds: [], availableBuildings: [{ value: '配电楼', evidenceId: 'main' }] },
  ];
  expect(assignEngineeringComposition(model, facts).map(row => row.paths[0].map(group => group.title))).toEqual([
    ['建筑工程', '警传室'], ['建筑工程', '消防泵房'],
  ]);
});

it('uses the explicitly named bay voltage beneath an interval without inventing a voltage from the interval alone', () => {
  const model = snapshot([entity('line', 'E09'), entity('switchgear', 'E09'), entity('bus', 'M09'), entity('range', 'E09'), entity('neutral', 'E16.terminal_box'), entity('conflict', 'E09')]);
  const result = assignEngineeringComposition(model, [
    fact('line', ['交流电气系统', '≥110kV且<220kV系统', '110kV1号变压器线路间隔']),
    fact('switchgear', ['≥35kV且<66kV系统', '35kV1号变压开关柜线路间隔']),
    fact('bus', ['≥10kV且<20kV系统', '10kV1段母线间隔']),
    fact('range', ['≥110kV系统']),
    fact('neutral', ['变压器系统', '110kV中性点设备间隔1']),
    fact('conflict', ['110kV系统', '10kV出线间隔']),
  ]);
  const titles = (id: string) => result.find(row => row.entityId === id)!.paths[0].map(group => group.title);
  expect(titles('line')).toEqual(['安装工程', '110千伏配电装置', '110kV1号变压器线路间隔']);
  expect(titles('switchgear')).toEqual(['安装工程', '35千伏配电装置', '35kV1号变压开关柜线路间隔']);
  expect(titles('bus')).toEqual(['安装工程', '10千伏配电装置', '10kV1段母线间隔']);
  expect(titles('range')).toEqual(['未分类', 'DEV+IFC 轨道', '设备']);
  expect(titles('neutral')).toEqual(['安装工程', '主变压器系统', '110kV中性点设备间隔1']);
  expect(titles('conflict')).toEqual(['未分类', 'DEV+IFC 轨道', '设备']);
});

it('projects unclassified wholes as track and category buckets without an extra category level', () => {
  const model = snapshot([entity('orphan', 'E09')]);
  const assignments = assignEngineeringComposition(model, [fact('orphan')]);
  const view = projectEngineeringComposition(model, assignments, '工程');
  const root = view.nodes.get(view.rootKey)!;
  expect(root.children.map(key => view.nodes.get(key)!.title)).toEqual(['未分类']);
  const unclassified = view.nodes.get(root.children[0])!;
  expect(unclassified.children.map(key => view.nodes.get(key)!.title)).toEqual(['DEV+IFC 轨道']);
  const track = view.nodes.get(unclassified.children[0])!;
  expect(track.children.map(key => view.nodes.get(key)!.title)).toEqual(['设备']);
  expect(view.nodes.get(track.children[0])!.children).toHaveLength(1);
  expect(view.nodes.get(track.children[0])!.children.map(key => view.nodes.get(key)!.title)).toEqual(['orphan']);
});
