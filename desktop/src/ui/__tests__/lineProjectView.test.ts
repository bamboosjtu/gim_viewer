import { describe, expect, it } from 'vitest';
import type { GimGraphNode } from '../../gim/gimGraphTypes.js';
import type { BoltModFile, HNumModFile } from '../../gim/geometry/ir.js';
import { buildLineNodeBuckets, renderLineModSource, renderLineTowerShapeSource } from '../lineProjectView.js';
import type { LineAttributeIndex } from '../../gim/lineAttributeTypes.js';
import type { LineFamPropertyRecord, LineDevPropertyRecord } from '@desktop/database.js';

function node(overrides: Partial<GimGraphNode> = {}): GimGraphNode {
  return {
    path: 'Cbm/tower.cbm',
    name: 'TOWER',
    entityName: 'F4System',
    classifyName: 'TOWER',
    rawProps: { GROUPTYPE: 'TOWER' },
    children: [],
    refs: {
      cbmFiles: [], devFiles: [], famFiles: [], phmFiles: [], modFiles: [],
      stlFiles: [], wireFiles: [], ifcFiles: [], rawRefs: {},
    },
    ...overrides,
  };
}

const hnum: HNumModFile = {
  hNum: 1,
  hRecords: [{ height: 1000, body: 'Body1', leg: 'Leg1' }],
  bodySections: [{
    name: 'Body1',
    hBody: 1000,
    points: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 1000, y: 0, z: 1000 },
    ],
    rods: [{ kind: 'tube', id1: 1, id2: 2, spec: 'φ100X5', material: 'Q235' }],
    groundPoints: [],
  }],
  hSubLegs: [],
  hLegs: [],
};

describe('线路塔位来源形状预览', () => {
  it('把 HNum 杆塔骨架放在来源页并提供可读来源按钮', () => {
    const html = renderLineTowerShapeSource(node(), [{
      path: 'Mod/tower-shape.mod',
      source: {
        kind: 'line-text-mod',
        format: 'text-hnum-comma-record',
        modPath: 'Mod/tower-shape.mod',
        records: hnum,
      },
    }]);

    expect(html).toContain('杆塔形状');
    expect(html).toContain('<svg');
    expect(html).toContain('width="280" height="280"');
    expect(html).toContain('viewBox="0 0 280 280"');
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(html).toContain('查看塔型 MOD');
    expect(html).not.toContain('未找到可预览');
  });

  it('非杆塔节点不插入形状预览', () => {
    expect(renderLineTowerShapeSource(node({ classifyName: 'WIRE', rawProps: { GROUPTYPE: 'WIRE' } }), [])).toBe('');
  });
});

function famRecord(source: string, key: string, value: string, display_key: string): LineFamPropertyRecord {
  return {
    source_path: source,
    normalized_path: source,
    file_name_lower: source.toLowerCase(),
    display_key,
    prop_key: key,
    prop_value: value,
    raw_line: `${display_key}=${key}=${value}`,
    sort_order: 0,
  };
}

function devRecord(source: string, key: string, value: string): LineDevPropertyRecord {
  return {
    source_path: source,
    normalized_path: source,
    file_name_lower: source.toLowerCase(),
    prop_key: key,
    prop_value: value,
    raw_line: `${key}=${value}`,
    sort_order: 0,
  };
}

function attrIndex(records: { fam: LineFamPropertyRecord[]; dev?: LineDevPropertyRecord[] }): LineAttributeIndex {
  const famBySourcePath = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  const famByFileNameLower = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  const devBySourcePath = new Map<string, Map<string, LineDevPropertyRecord[]>>();
  const devByFileNameLower = new Map<string, Map<string, LineDevPropertyRecord[]>>();
  for (const record of records.fam) {
    const byKey = famBySourcePath.get(record.source_path) ?? new Map<string, LineFamPropertyRecord[]>();
    byKey.set(record.prop_key, [...(byKey.get(record.prop_key) ?? []), record]);
    famBySourcePath.set(record.source_path, byKey);
    famByFileNameLower.set(record.file_name_lower, byKey);
  }
  for (const record of records.dev ?? []) {
    const byKey = devBySourcePath.get(record.source_path) ?? new Map<string, LineDevPropertyRecord[]>();
    byKey.set(record.prop_key, [...(byKey.get(record.prop_key) ?? []), record]);
    devBySourcePath.set(record.source_path, byKey);
    devByFileNameLower.set(record.file_name_lower, byKey);
  }
  return { famBySourcePath, famByFileNameLower, devBySourcePath, devByFileNameLower };
}

describe('线路属性面板分组', () => {
  it('塔位实例参数包含呼高/转角，关系按四类业务对象分组，引用集中在来源页', () => {
    const tower = node({
      path: 'Cbm/tower.cbm',
      entityName: 'Tower_Device',
      classifyName: '',
      rawProps: { ENTITYNAME: 'Tower_Device' },
      refs: {
        cbmFiles: [], devFiles: ['tower.dev'], famFiles: ['tower.fam'], phmFiles: [], modFiles: [],
        stlFiles: [], wireFiles: [], ifcFiles: [], rawRefs: {},
      },
    });
    const base = node({
      path: 'Cbm/base.cbm',
      entityName: 'Tower_Device',
      rawProps: { ENTITYNAME: 'Tower_Device' },
      refs: { cbmFiles: [], devFiles: [], famFiles: ['base.fam'], phmFiles: [], modFiles: [], stlFiles: [], wireFiles: [], ifcFiles: [], rawRefs: {} },
    });
    const string = node({
      path: 'Cbm/string.cbm',
      entityName: 'Tower_Device',
      rawProps: { ENTITYNAME: 'Tower_Device' },
      refs: { cbmFiles: [], devFiles: [], famFiles: ['string.fam'], phmFiles: [], modFiles: [], stlFiles: [], wireFiles: [], ifcFiles: [], rawRefs: {} },
    });
    const f4 = node({
      path: 'Cbm/f4.cbm',
      name: 'TOWER',
      entityName: 'F4System',
      classifyName: 'TOWER',
      rawProps: {
        ENTITYNAME: 'F4System', GROUPTYPE: 'TOWER',
        TOWERS: '1', 'TOWERS.NUM': '1', TOWER0: 'tower.cbm',
        'BASES.NUM': '1', BASE0: 'base.cbm', 'STRINGS.NUM': '1', 'STRING0.STRING': 'string.cbm',
        'STRING0.GPOINT': '前导1',
      },
      children: [tower, base, string],
    });
    const attrs = attrIndex({ fam: [
      famRecord('tower.fam', 'NOMINALHEIGHT', '42.000000', '呼高'),
      famRecord('tower.fam', 'TOWERHEIGHT', '57.500000', '杆塔高'),
      famRecord('tower.fam', 'LINEANGLE', '0.000000', '转角'),
    ], dev: [devRecord('tower.dev', 'DEVICETYPE', 'TOWER')] });

    const buckets = buildLineNodeBuckets(f4, attrs);
    expect(buckets.params).toContain('呼高');
    expect(buckets.params).toContain('转角');
    expect(buckets.params).not.toContain('data-prop-ref');
    expect(buckets.relations).toContain('杆塔');
    expect(buckets.relations).toContain('基础');
    expect(buckets.relations).toContain('导线');
    expect(buckets.relations).toContain('导线挂点');
    expect(buckets.relations).not.toContain('data-prop-ref');
    expect(buckets.source).toContain('data-prop-ref');
  });

  it('来源过多时按类型折叠并限制预览，避免工程节点生成超长表格', () => {
    const refs = Array.from({ length: 130 }, (_, index) => `Cbm/source-${index}.cbm`);
    const buckets = buildLineNodeBuckets(node({ refs: {
      cbmFiles: refs, devFiles: [], famFiles: [], phmFiles: [], modFiles: [],
      stlFiles: [], wireFiles: [], ifcFiles: [], rawRefs: {},
    } }), undefined);
    expect(buckets.source).toContain('共 131 个来源');
    expect(buckets.source).toContain('<details');
    expect(buckets.source).toContain('CBM（131）');
    expect(buckets.source).toContain('其余 11 个来源未在此处展开');
  });
});

describe('线路螺栓表格', () => {
  it('将多个螺栓渲染为单个表格而不是重复属性分节', () => {
    const bolt: BoltModFile = {
      section: 'Bolt',
      boltNum: 2,
      bolts: [
        { index: 1, spec: 'M64', length: 232, restFields: ['2', 'x'], position: { code: 210, x: 165, y: 165, z: 0 } },
        { index: 2, spec: 'M64', length: 232, restFields: ['2', 'x'], position: { code: 210, x: -165, y: 165, z: 0 } },
      ],
    };
    const html = renderLineModSource({
      path: 'Mod/bolt.mod',
      source: { kind: 'line-text-mod', format: 'text-section-kv-record', modPath: 'Mod/bolt.mod', records: bolt },
    }, { includeSourceLink: false });
    expect((html.match(/props-bolt-table/g) || []).length).toBe(1);
    expect(html).toContain('<th>规格</th>');
    expect(html).toContain('M64');
    expect(html).not.toContain('props-section-title">螺栓 1');
    expect(html).not.toContain('data-prop-ref');
  });
});
