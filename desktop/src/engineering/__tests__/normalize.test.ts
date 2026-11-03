import { describe, expect, it } from 'vitest';
import { normalizeEngineeringModel } from '../normalize.js';
import { interpretObject, isNumberedDesignation } from '../classify.js';
import { assertEngineeringPartition } from '../validate.js';
import type { ObjectEvidence } from '../types.js';

const value = (text: string) => ({ value: text, evidenceId: 'fixture' });
const source = (sourceId: string, name: string, extra: Partial<ObjectEvidence> = {}): ObjectEvidence => ({
  sourceId, name, traits: {}, designations: [], identityCodes: [], identityNames: [], phases: [], ...extra,
});
const build = (rows: ObjectEvidence[]) => normalizeEngineeringModel('test-package', rows);

describe('construction and operation engineering wholes', () => {
  it('prefers secondary type over a transformer name and family identity',()=>{
    const model=build([source('cabinet','2号主变压器测控柜',{typeCategory:'E16',identityNames:[value('主变压器')],designations:[value('2号主变')]} )]);
    expect(model.entities[0].category).toBe('E16.control_cabinet');
    expect(model.entities[0].name).toBe('2号主变压器测控柜');
  });
  it('uses object-owned designations for body and neutral sources without a file level',()=>{
    const designations=[value('2号备用主变')];
    const model=build([source('body','220kV变压器模型04',{typeCategory:'E-T',designations,phases:[value('单相')]}),source('box','端子箱',{assemblyParentId:'body'}),source('neutral','中性点成套装置',{designations})]);
    expect(model.entities).toHaveLength(1);expect(model.entities[0]).toMatchObject({category:'E01',name:'2号备用主变',sourceIds:['body','box','neutral']});
  });
  it('does not let local family names promote an internal instrument', () => {
    const instrument = source('i', '在线监测仪', { assemblyParentId: 'n', identityNames: [value('110kV中性点装置')] });
    const model = build([instrument, source('n', '110kV中性点装置')]);
    expect(model.entities).toHaveLength(0);
    expect(model.pending).toHaveLength(1);
    expect(model.pending[0].sourceIds).toEqual(['i', 'n']);
  });

  it('keeps embedded terminal boxes within the transformer across wrappers', () => {
    const main = source('main', '主变压器');
    const terminal = source('terminal', '本体端子箱', { assemblyParentId: 'main' });
    const coarse = build([main, terminal]);
    const fine = build([main, { ...terminal, assemblyParentId: 'wrapper' },
      source('wrapper', 'Group', { assemblyParentId: 'main', traits: { assemblyContainer: true } }),
      source('radiator', '散热器', { assemblyParentId: 'wrapper' })]);
    expect(fine.entities.map(e => [e.id, e.category])).toEqual(coarse.entities.map(e => [e.id, e.category]));
    expect(fine.entities.find(e => e.category === 'E01')?.sourceIds).toEqual(['main', 'radiator', 'terminal', 'wrapper']);
    expect(fine.entities).toHaveLength(1);
    expect(build([source('box','独立端子箱')]).entities[0].category).toBe('E16.terminal_box');
  });

  it('joins numbered peer fragments using engineering evidence', () => {
    const props = { designations: [value('1#电容器组')], identityCodes: [value('GN201')] };
    const rows = ['网栏及网门', '支柱绝缘子', '放电线圈'].map((part, i) => source(String(i), `10kV框架式电容器组模型11_${part}`, props));
    const peer = build(rows);
    const nested = build([...rows.map(r => ({ ...r, assemblyParentId: 'wrapper' })), source('wrapper', 'Group', { traits: { assemblyContainer: true } })]);
    expect(peer.entities).toHaveLength(1);
    expect(peer.entities[0]).toMatchObject({ category: 'E10', kind: 'set', sourceIds: ['0', '1', '2'] });
    expect(nested.entities).toEqual(peer.entities);
  });

  it('keeps generic shared identity as a pending collection', () => {
    const props = { designations: [value('接地变')], identityCodes: [value('GTJ10')] };
    const model = build(['避雷器', '隔离开关'].map((part, i) => source(String(i), `消弧线圈及接地变成套装置模型02_${part}`, props)));
    expect(model.entities).toHaveLength(0);
    expect(model.pending).toHaveLength(1);
  });

  it('does not interpret voltages, model numbers or dimensions as unit designations', () => {
    expect(isNumberedDesignation('35kV接地变模型02')).toBe(false);
    expect(isNumberedDesignation('1#电容器组')).toBe(true);
    expect(isNumberedDesignation('电压互感器05')).toBe(true);
    expect(isNumberedDesignation('电压互感器05型')).toBe(false);
  });

  it('groups six single-phase bodies into two banks independently of input order', () => {
    const rows = [2, 3].flatMap(number => ['A', 'B', 'C'].map(phase => source(`${number}-${phase}`, '500kV变压器模型09', {
      typeCategory: 'E01', designations: [value(`#${number}主变`)], phases: [value('单相')],
    })));
    const model = build(rows);
    expect(model.entities).toHaveLength(2);
    expect(model.entities.map(e => e.phaseBodyCount)).toEqual([3, 3]);
    expect(build(rows.reverse())).toEqual(model);
  });

  it('resolves neutral attachments with their nested terminal boxes after hosts', () => {
    const model = build([source('a-neutral', '中性点成套装置', { designations: [value('#2主变')] }),
      source('z-main', '主变压器', { designations: [value('#2主变')] }),
      source('instrument', '电动机构', { assemblyParentId: 'a-neutral' }),
      source('terminal', '端子箱', { assemblyParentId: 'a-neutral' })]);
    expect(model.pending).toHaveLength(0);
    expect(model.entities).toHaveLength(1);
    const main = model.entities.find(e => e.category === 'E01')!;
    expect(main.sourceIds).toEqual(['a-neutral', 'instrument', 'terminal', 'z-main']);
    expect(model.relationships).toEqual([]);
  });

  it('preserves reused material instances', () => {
    expect(build([0, 1, 2].map(i => source(String(i), '设备线夹单导线'))).entities).toHaveLength(3);
  });

  it('resolves component ambiguity at whole scope without picking a component', () => {
    const rows = [source('string', '绝缘子串'), ...[0, 1, 2].map(i => source(String(i), '金具球', { assemblyParentId: 'string' }))];
    const model = normalizeEngineeringModel('test', rows, [{ sourceId: 'part.cbm', status: 'ambiguous', candidates: ['0', '1', '2'] }]);
    expect(model.entities).toHaveLength(1);
    expect(model.aliases[0]).toMatchObject({ status: 'whole_resolved_component_ambiguous', componentCandidates: ['0', '1', '2'] });
    const unresolved = normalizeEngineeringModel('test', [source('a', '断路器'), source('b', '断路器')], [{ sourceId: 'ambiguous', status: 'ambiguous', candidates: ['a', 'b'] }]);
    expect(unresolved.aliases[0].status).toBe('whole_unresolved');
  });

  it('interprets the functional cabinet noun before its service prefix', () => {
    expect(interpretObject(source('x', 'HGIS智能控制柜', { typeCategory: 'E09' })).category).toBe('E16.control_cabinet');
    expect(interpretObject(source('x', '二次屏柜')).category).toBe('E16.panel_cabinet');
    expect(interpretObject(source('x', '通信柜')).category).toBe('E16.panel_cabinet');
    expect(interpretObject(source('x', '蓄电池组')).category).toBe('E16.battery_set');
    expect(interpretObject(source('x', '变压器保护装置')).category).toBe('E16.protection');
    expect(interpretObject(source('x', '二次屏柜模型02_柜体'))).toMatchObject({ meaning: 'fragment', independent: false });
  });

  it('keeps fire alarm buttons out of the component-button branch', () => {
    expect(interpretObject(source('x', '手动报警按钮'))).toMatchObject({ category: 'C-D2', independent: true, meaning: 'object' });
    expect(build([source('button', '手动报警按钮')]).entities.map(entity => entity.category)).toEqual(['C-D2']);
  });

  it('creates distinct E16 wholes for terminal box, panel, control cabinet and battery set', () => {
    const model = build([source('term', '独立端子箱'), source('panel', '二次屏柜'), source('control', 'HGIS智能控制柜'), source('battery', '蓄电池组')]);
    expect(model.entities.map(entity => entity.category).sort()).toEqual(['E16.battery_set', 'E16.control_cabinet', 'E16.panel_cabinet', 'E16.terminal_box']);
  });

  it('uses the documented M07 fallback only for explicit or material-typed other materials', () => {
    expect(interpretObject(source('x', '其他材料'))).toMatchObject({ category: 'M07', basis: 'object_name' });
    expect(interpretObject(source('x', '未细分材料'))).toMatchObject({ category: 'M07' });
    expect(interpretObject(source('x', '未知物料', { traits: { materialType: true } }))).toMatchObject({ category: 'M07', basis: 'material_type_fallback' });
    expect(interpretObject(source('x', '未知物料'))).toMatchObject({ category: 'U-OBJECT' });
  });

  it('records cable trench component roles without creating new wholes', () => {
    const model = build([source('trench', '电缆沟'), source('cover', '沟盖板', { assemblyParentId: 'trench' })]);
    expect(interpretObject(source('cover', '沟盖板')).role).toBe('cover');
    expect(interpretObject(source('side', '沟壁')).role).toBe('sidewall');
    expect(interpretObject(source('base', '沟底')).role).toBe('base');
    expect(model.entities).toHaveLength(1);
    expect(model.memberships.find(m => m.sourceId === 'cover')?.interpretation.role).toBe('cover');
  });

  it('preserves unknown proxies and known equipment nested under them', () => {
    const model = build([source('parent', 'Shape'), source('breaker', '断路器', { assemblyParentId: 'parent' })]);
    expect(model.entities.map(e => e.category).sort()).toEqual(['E06', 'U-OBJECT']);
  });

  it('keeps fasteners as source members or source-only without losing them', () => {
    const model = build([source('beam', '梁'), source('bolt', '螺栓', { traits: { fastener: true }, assemblyParentId: 'beam' }),
      source('orphan', '螺栓', { traits: { fastener: true } })]);
    expect(model.entities).toHaveLength(1);
    expect(model.memberships).toHaveLength(3);
    expect(model.entities[0].sourceIds).toEqual(['beam', 'bolt']);
    expect(model.memberships.find(m => m.sourceId === 'orphan')?.disposition).toBe('source_only');
  });

  it('keeps an independent foundation separate from equipment', () => {
    const model = build([source('main', '主变压器'), source('foundation', '基础', { assemblyParentId: 'main' })]);
    expect(model.entities).toHaveLength(2);
    expect(model.relationships).toHaveLength(1);
  });

  it('does not put classification or naming into a standalone occurrence ID', () => {
    expect(build([source('stable', '断路器')]).entities[0].id).toBe(build([source('stable', 'Shape')]).entities[0].id);
  });

  it('rejects duplicate source IDs and composition cycles', () => {
    expect(() => build([source('same', '梁'), source('same', '柱')])).toThrow('unique');
    expect(() => build([source('a', '梁', { assemblyParentId: 'b' }), source('b', '柱', { assemblyParentId: 'a' })])).toThrow('cycle');
  });

  it('rejects lost, duplicated and dangling source ownership in a snapshot', () => {
    const model = build([source('a', '梁'), source('b', '柱')]);
    model.memberships.pop();
    expect(() => assertEngineeringPartition(model, ['a', 'b'])).toThrow('incomplete');
    const duplicated = build([source('a', '梁')]);
    duplicated.entities[0].sourceIds.push('a');
    expect(() => assertEngineeringPartition(duplicated, ['a'])).toThrow('Duplicated');
    const dangling = build([source('a', '梁')]);
    dangling.memberships[0].ownerId = 'absent';
    expect(() => assertEngineeringPartition(dangling, ['a'])).toThrow('inconsistent');
  });
});
