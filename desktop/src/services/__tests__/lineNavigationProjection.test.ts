// @vitest-environment node
import {describe,it,expect} from 'vitest';

import type { LineAttributeIndex } from '../../gim/lineAttributeTypes.js';
import type { LineFamPropertyRecord } from '../../../bridge/database.js';

import {node,parseFamFixture,makeLineFixture} from './lineNavigationFixture.js';
import {buildLineNavigationIndex,resolveLineNavigationTarget} from '../lineNavigationProjection.js';

describe('line navigation projection without DOM',()=>{
function crossingFixture(families: [string, string][], refs = ['cross.fam']) {
    const fixture = makeLineFixture();
    fixture.nodes.cross.children.push(node({ path: 'Cbm/actual-cross.cbm', entityName: 'CROSS', rawProps: { CODE: '201' }, refs: { ...node().refs, famFiles: refs } }));
    const attrs: LineAttributeIndex = { famBySourcePath: new Map(), famByFileNameLower: new Map(), devBySourcePath: new Map(), devByFileNameLower: new Map() };
    for (const [path, text] of families) {
      const rows = new Map<string, LineFamPropertyRecord[]>();
      for (const row of parseFamFixture(text)) { const values = rows.get(row.prop_key) ?? []; values.push({ ...row, source_path: path, normalized_path: path.toLowerCase(), file_name_lower: path.split('/').pop()!.toLowerCase(), sort_order: values.length }); rows.set(row.prop_key, values); }
      attrs.famBySourcePath.set(path, rows);
      attrs.famByFileNameLower.set(path.split('/').pop()!.toLowerCase(), rows);
    }
    return buildLineNavigationIndex(fixture.graph, fixture.mapData, { attrs });
  }
it('按自身 FAM 判定铁路，容忍空接触网高并保留 CODE，优先同目录同名 FAM', () => {
    const index = crossingFixture([['CBM/CROSS.fam', '铁路名称=NAME=示例铁路\n接触网高=接触网高='], ['Dev/cross.fam', '屋顶类型=ROOFTYPE=平顶']]);
    const cross = [...index.nodesByKey.values()].find(row => row.kind === 'crossing')!;
    expect(cross.label).toContain('铁路'); expect(cross.label).toContain('示例铁路'); expect(cross.label).not.toContain('房屋');
    expect(cross.cross?.codes).toEqual(['201']);
  });
it('无同目录且存在重名来源时保留未分类，不使用 basename 索引的最后一项', () => {
    const index = crossingFixture([['Dev/cross.fam', '屋顶类型=ROOFTYPE=平顶'], ['Phm/cross.fam', '树木种类=TREETYPE=松树']]);
    expect([...index.nodesByKey.values()].find(row => row.kind === 'crossing')!.label).toContain('未分类跨越物');
  });
it('多个自身 FAM 的不同键族保留冲突，不以顺序决定类型', () => {
    const index = crossingFixture([['Cbm/a.fam', '屋顶类型=ROOFTYPE='], ['Cbm/b.fam', '接触网高=接触网高=']], ['a.fam', 'b.fam']);
    expect([...index.nodesByKey.values()].find(row => row.kind === 'crossing')!.label).toContain('类型冲突');
  });
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
it('隐藏的 Tower_Device CBM 来源回溯到可见杆塔行，并兼容裸文件名/反斜杠', () => {
    const fixture = makeLineFixture();
    const index = buildLineNavigationIndex(fixture.graph, fixture.mapData);
    const target = resolveLineNavigationTarget(index, '\\Cbm\\tower-device-0.cbm');
    expect(target?.kind).toBe('tower');
    expect(target?.label).toBe('N10 杆塔');
    expect(resolveLineNavigationTarget(index, 'tower-device-0.cbm')?.key).toBe(target?.key);
  });
});
