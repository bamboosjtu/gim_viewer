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
  it('does not let local family names promote an internal instrument', () => {
    const instrument = source('i', '在线监测仪', { assemblyParentId: 'n', identityNames: [value('110kV中性点装置')] });
    const model = build([instrument, source('n', '110kV中性点装置')]);
    expect(model.entities).toHaveLength(0);
    expect(model.pending).toHaveLength(1);
    expect(model.pending[0].sourceIds).toEqual(['i', 'n']);
  });

  it('keeps terminal boxes independent across detail depth and wrappers', () => {
    const main = source('main', '主变压器');
    const terminal = source('terminal', '本体端子箱', { assemblyParentId: 'main' });
    const coarse = build([main, terminal]);
    const fine = build([main, { ...terminal, assemblyParentId: 'wrapper' },
      source('wrapper', 'Group', { assemblyParentId: 'main', traits: { assemblyContainer: true } }),
      source('radiator', '散热器', { assemblyParentId: 'wrapper' })]);
    expect(fine.entities.map(e => [e.id, e.category])).toEqual(coarse.entities.map(e => [e.id, e.category]));
    expect(fine.entities.find(e => e.category === 'E01')?.sourceIds).toEqual(['main', 'radiator', 'wrapper']);
    expect(fine.entities.find(e => e.category === 'E16.terminal_box')?.sourceIds).toEqual(['terminal']);
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

  it('resolves neutral attachments after hosts, including independent nested boxes', () => {
    const model = build([source('a-neutral', '中性点成套装置', { designations: [value('#2主变')] }),
      source('z-main', '主变压器', { designations: [value('#2主变')] }),
      source('instrument', '电动机构', { assemblyParentId: 'a-neutral' }),
      source('terminal', '端子箱', { assemblyParentId: 'a-neutral' })]);
    expect(model.pending).toHaveLength(0);
    expect(model.entities).toHaveLength(2);
    const main = model.entities.find(e => e.category === 'E01')!;
    expect(main.sourceIds).toEqual(['a-neutral', 'instrument', 'z-main']);
    expect(model.relationships[0].to).toBe(main.id);
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
    expect(interpretObject(source('x', 'HGIS智能控制柜', { typeCategory: 'E09' })).category).toBe('E16.control');
    expect(interpretObject(source('x', '变压器保护装置')).category).toBe('E16.protection');
    expect(interpretObject(source('x', '二次屏柜模型02_柜体'))).toMatchObject({ meaning: 'fragment', independent: false });
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
