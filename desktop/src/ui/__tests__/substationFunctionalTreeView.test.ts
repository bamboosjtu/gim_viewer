import { afterEach, describe, expect, it } from 'vitest';
import { AppState } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';
import {
  buildFunctionalDomainIndex,
  buildFunctionalSearchIndex,
  renderSubstationFunctionalTree,
  revealFunctionalSearchTarget,
} from '../substationFunctionalTreeView.js';

function node(overrides: Partial<CbmNode> = {}): CbmNode {
  return {
    path: 'CBM/project.cbm',
    name: '工程',
    entityName: 'F1System',
    children: [],
    famPath: '',
    devPath: '',
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: '',
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
    ...overrides,
  };
}

describe('substation functional tree projection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('按 F3 功能域分组，F2 只成为专业徽标，并把未分类系统收拢为一个域', () => {
    const duplicatePart = node({
      path: 'CBM/part-index.cbm',
      name: '柜内端子',
      entityName: 'PARTINDEX',
      devPath: 'part.dev',
    });
    const virtualPart = node({
      path: 'CBM/device.cbm#dev:0:part.dev',
      name: '柜内端子',
      entityName: 'DEV_SUBDEVICE',
      devPath: 'part.dev',
    });
    const electricalSystem = node({
      path: 'CBM/electrical-system.cbm',
      name: '电气系统 / 220kV系统 / 进线间隔',
      entityName: 'F3System',
      systemNames: ['电气系统', '220kV系统', '进线间隔'],
      children: [
        node({
          path: 'CBM/component.cbm',
          entityName: 'F4System',
          name: '断路器',
          ifcFile: 'model.ifc',
          ifcGuid: 'guid-1',
        }),
        node({
          path: 'CBM/device.cbm',
          entityName: 'F4System',
          name: '保护柜',
          devPath: 'cabinet.dev',
          children: [duplicatePart, virtualPart],
        }),
      ],
    });
    const buildingSystem = node({
      path: 'CBM/building-system.cbm',
      name: '建筑物系统 / 建筑',
      entityName: 'F3System',
      systemNames: ['建筑物系统', '建筑'],
      children: [],
    });
    const unclassifiedSystem = node({
      path: 'CBM/unclassified-system.cbm',
      name: '&其他',
      entityName: 'F3System',
      systemNames: [],
      classifyName: '0****001',
      children: [],
    });
    const root = node({
      children: [
        node({ entityName: 'F2System', classifyName: 'A', children: [electricalSystem] }),
        node({ entityName: 'F2System', classifyName: 'U', children: [buildingSystem] }),
        node({ entityName: 'F2System', classifyName: '02', children: [unclassifiedSystem] }),
      ],
    });

    const index = buildFunctionalDomainIndex(root);
    expect(index.domains.map((domain) => domain.title)).toEqual(['电气系统', '建筑物系统', '未归类系统']);
    expect(index.domains.find((domain) => domain.title === '电气系统')?.disciplineLabels).toEqual(['安装']);
    expect(index.domains.find((domain) => domain.title === '未归类系统')?.systems).toHaveLength(1);

    const electrical = index.domains[0].systems[0];
    expect(electrical.assets.map((asset) => asset.role)).toEqual(['component', 'device']);
    expect(electrical.assets[1].parts).toHaveLength(1);
    expect(electrical.assets[1].parts[0].sourceNodes).toHaveLength(2);
    expect(index.targetByKey.get(virtualPart.path)?.rowKey).toBe(electrical.assets[1].parts[0].key);
  });

  it('默认只生成工程根和功能域，搜索命中时按祖先链惰性展开', () => {
    const f3 = node({
      path: 'CBM/system.cbm',
      name: '电气系统 / 10kV系统 / 间隔01',
      entityName: 'F3System',
      systemNames: ['电气系统', '10kV系统', '间隔01'],
      children: [
        node({
          path: 'CBM/device.cbm',
          entityName: 'F4System',
          name: '设备',
          devPath: 'device.dev',
          children: [node({ path: 'CBM/part.cbm', entityName: 'PARTINDEX', name: '部件', devPath: 'part.dev' })],
        }),
      ],
    });
    const root = node({ children: [node({ entityName: 'F2System', classifyName: 'A', children: [f3] })] });
    const state = new AppState();
    state.projectName = '测试变电工程';
    state.currentCbmTree = root;
    const index = buildFunctionalDomainIndex(root);
    const host = document.createElement('div');
    document.body.appendChild(host);
    let clicked: CbmNode | null = null;
    renderSubstationFunctionalTree(state, index, host, (selected) => { clicked = selected; });

    expect(host.querySelectorAll('.functional-tree-row')).toHaveLength(2);
    const initialBadges = Array.from(host.querySelectorAll<HTMLElement>('.functional-badge'))
      .map((element) => element.textContent || '');
    expect(initialBadges).toEqual(['1 个域', '1 个系统']);
    expect(host.textContent).not.toContain('F4 1');
    const searchItems = buildFunctionalSearchIndex(state, index);
    const partItem = searchItems.find((item) => item.title === '部件');
    expect(partItem).toBeDefined();
    const rowKey = revealFunctionalSearchTarget(index, partItem!.key);
    expect(rowKey).toBeTruthy();
    expect(host.querySelector(`[data-node-path="${rowKey}"]`)).not.toBeNull();
    // 展开祖先链只操作箭头，不触发祖先对象选择。
    expect(clicked).toBeNull();
    host.querySelector<HTMLElement>(`[data-node-path="${rowKey}"]`)!.click();
    expect(clicked).not.toBeNull();
    expect(clicked!.path).toBe('CBM/part.cbm');
  });
});
