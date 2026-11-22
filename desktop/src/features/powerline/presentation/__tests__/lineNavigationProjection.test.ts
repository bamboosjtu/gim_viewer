// @vitest-environment node
import {describe,it,expect} from 'vitest';

import type { LineAttributeIndex } from '@gim/powerline-core/lineAttributeTypes.js';
import type { LineFamPropertyRecord } from '@desktop/database.js';

import {node,parseFamFixture,makeLineFixture} from '../../../../services/__tests__/lineNavigationFixture.js';
import { buildLineNavigationIndex } from '../lineNavigationProjection.js';
import { resolveLineNavigationTarget } from '../lineNavigationTargets.js';

describe('line navigation projection without DOM',()=>{
  it.each([false, true])('associates a crossing with an unresolved span only through a resolved reference (resolved=%s)', resolved => {
    const fixture = makeLineFixture();
    fixture.nodes.cross.rawProps.SPANREF = resolved ? 'Cbm/wire-group-b.cbm' : 'missing.cbm';
    fixture.nodes.cross.refs.cbmFiles = resolved ? ['Cbm/wire-group-b.cbm'] : [];
    fixture.nodes.cross.children.push(node({ path: 'Cbm/cross.cbm', entityName: 'CROSS' }));
    const index = buildLineNavigationIndex(fixture.graph, { ...fixture.mapData, wires: [] });
    const crossing = [...index.nodesByKey.values()].find(row => row.kind === 'crossing')!;
    const parent = index.nodesByKey.get(index.parentByKey.get(crossing.key)!);
    expect(parent?.kind).toBe(resolved ? 'span' : 'unassociated-crossings');
    expect(index.stats.unassociatedCrossCount).toBe(resolved ? 0 : 1);
  });
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

  it('follows the exact parent chain for a hidden source sharing a visible tower basename', () => {
    const fixture = makeLineFixture();
    const hidden = node({ path: 'Other/tower-0.cbm', entityName: 'Tower_Device' });
    fixture.nodes.tower2.children.push(hidden);
    fixture.graph.nodesByPath.set(hidden.path, hidden);
    const index = buildLineNavigationIndex(fixture.graph, fixture.mapData);
    expect(resolveLineNavigationTarget(index, 'other\\TOWER-0.CBM')?.node).toBe(fixture.nodes.tower2);
    expect(resolveLineNavigationTarget(index, fixture.nodes.tower0.path)?.node).toBe(fixture.nodes.tower0);
    expect(resolveLineNavigationTarget(index, 'tower-0.cbm')).toBeNull();
    expect(resolveLineNavigationTarget(index, 'Missing/tower-2.cbm')).toBeNull();
    expect(resolveLineNavigationTarget(index, 'tower-2.cbm')?.node).toBe(fixture.nodes.tower2);
  });

  it.each([false, true])('keeps coincident towers ambiguous unless the wire has a source binding (bound=%s)', bound => {
    const fixture = makeLineFixture();
    const wire = fixture.mapData.wires[0];
    const coincident = fixture.mapData.towers.find(tower => tower.nodeRef === fixture.nodes.tower2)!;
    coincident.lat = wire.startLat;
    coincident.lng = wire.startLng;
    if (bound) {
      wire.nodeRef.rawProps.BACKSTRING = fixture.nodes.tower0.path;
      wire.nodeRef.refs.stringTargets = { BACKSTRING: fixture.nodes.tower0.path };
    }
    const index = buildLineNavigationIndex(fixture.graph, { ...fixture.mapData, wires: [wire] });
    const span = [...index.nodesByKey.values()].find(row => row.span?.wires.includes(wire))!.span!;
    expect(span.startTower?.cbmPath).toBe(bound ? fixture.nodes.tower0.path : undefined);
    expect(span.endTower?.cbmPath).toBe('Cbm/tower-1.cbm');
    expect(span.unresolved).toBe(!bound);
    expect(span.wires[0]).toMatchObject({ startLat: wire.startLat, startLng: wire.startLng });
  });
});
