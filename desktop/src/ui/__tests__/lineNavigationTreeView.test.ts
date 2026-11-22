import {makeLineFixture} from '../../services/__tests__/lineNavigationFixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderLineNavigationTree, revealLineNavigationTarget } from '../lineNavigationTreeView.js';
import { buildLineNavigationIndex, buildLineNavigationSearchIndex } from '../../features/powerline/presentation/lineNavigationProjection.js';

describe('line navigation rendering and lifecycle', () => {
  afterEach(() => { document.body.innerHTML = ''; });

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

  it('reveals the same physical span under the requested strain and preserves each wire row', () => {
    const fixture = makeLineFixture();
    const index = buildLineNavigationIndex(fixture.graph, fixture.mapData);
    const strains = [...index.nodesByKey.values()].filter(row => row.kind === 'strain-section');
    const spans = strains.map(strain => strain.children.find(child => child.kind === 'span')!);
    expect(spans).toHaveLength(2);
    expect(spans[0].span?.key).toBe(spans[1].span?.key);
    expect(index.stats.spanCount).toBe(1);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const select = vi.fn();
    const tree = renderLineNavigationTree(index, host, select);
    try {
      for (const [rowIndex, span] of spans.entries()) {
        const wire = span.children.find(child => child.kind === 'wire')!;
        expect(index.nodesByKey.get(span.key)).toBe(span);
        expect(index.parentByKey.get(span.key)).toBe(strains[rowIndex].key);
        expect(index.nodesByKey.get(wire.key)).toBe(wire);
        expect(revealLineNavigationTarget(index, wire.key)).toBe(wire.key);
        const row = [...host.querySelectorAll<HTMLElement>('.line-navigation-row')]
          .find(candidate => candidate.dataset.nodePath === wire.key)!;
        row.click();
        expect(select).toHaveBeenLastCalledWith(wire);
      }
      const keys = [...host.querySelectorAll<HTMLElement>('.line-navigation-row')].map(row => row.dataset.nodePath);
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      tree.destroy();
    }
  });
it('destroys navigation listeners and cannot clear a replacement tree',()=>{
 const {graph,mapData}=makeLineFixture(),index=buildLineNavigationIndex(graph,mapData);
 const host=document.createElement('div');document.body.append(host);const selected=vi.fn();
 const old=renderLineNavigationTree(index,host,selected),oldRow=host.querySelector<HTMLElement>('.tree-row')!;
 const current=renderLineNavigationTree(index,host,selected),currentRow=host.querySelector<HTMLElement>('.tree-row')!;
 old.destroy();oldRow.click();expect(selected).not.toHaveBeenCalled();
 expect(host.contains(currentRow)).toBe(true);currentRow.click();expect(selected).toHaveBeenCalledTimes(1);
 current.destroy();current.destroy();currentRow.click();expect(selected).toHaveBeenCalledTimes(1);expect(host.children).toHaveLength(0);
});

});
