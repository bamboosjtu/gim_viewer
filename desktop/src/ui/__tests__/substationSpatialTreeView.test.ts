import { afterEach, describe, expect, it } from 'vitest';
import { AppState } from '../../app/state.js';
import type { CbmNode, IfcEntry } from '../../gim/types.js';
import { buildSubstationSpatialIndexFromTexts } from '../../gim/ifcSpatialParser.js';
import {
  renderSubstationSpatialTree,
  resolveSpatialSearchCbmPath,
  revealSpatialSearchTarget,
} from '../substationSpatialTreeView.js';

const entry: IfcEntry = { modelId: 'model', name: 'model', path: 'DEV/model.ifc' };

function cbm(overrides: Partial<CbmNode> = {}): CbmNode {
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

const ifcText = [
  "#1=IFCPROJECT('p',#99,'项目',$,$,$,$,(#2),$);",
  "#2=IFCSITE('s',#99,'站区',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
  "#3=IFCBUILDING('b',#99,'建筑',$,$,$,$,$,.ELEMENT.,$,$);",
  "#4=IFCBUILDINGSTOREY('f',#99,'一层',$,$,$,$,$,.ELEMENT.,0.);",
  "#10=IFCWALL('wall-guid',#99,'墙体',$,$,$,$,$,$);",
  "#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));",
  "#21=IFCRELAGGREGATES('r2',#99,$,$,#2,(#3));",
  "#22=IFCRELAGGREGATES('r3',#99,$,$,#3,(#4));",
  "#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('r4',#99,$,$,(#10),#4);",
].join('\n');

function hasRow(host: HTMLElement, key: string): boolean {
  return Array.from(host.querySelectorAll<HTMLElement>('.tree-row'))
    .some((row) => row.dataset.nodePath === key);
}

describe('substation spatial tree', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('空间容器本身不误选 CBM，搜索命中构件会展开祖先链', () => {
    const asset = cbm({
      path: 'CBM/wall.cbm',
      entityName: 'F4System',
      ifcFile: 'model.ifc',
      ifcGuid: 'wall-guid',
    });
    const state = new AppState();
    state.currentCbmTree = cbm({ children: [asset] });
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text: ifcText }], state.currentCbmTree);
    const host = document.createElement('div');
    document.body.appendChild(host);

    let selectedObject: string | null = null;
    renderSubstationSpatialTree(state, index, host, () => undefined, undefined, (item) => {
      selectedObject = item.key;
    });
    const project = index.nodes.find((node) => node.kind === 'project')!;
    const object = index.objects.find((item) => item.globalId === 'wall-guid')!;

    expect(resolveSpatialSearchCbmPath(index, project.key)).toBeNull();
    expect(hasRow(host, object.key)).toBe(false);
    revealSpatialSearchTarget(index, object.key);
    expect(hasRow(host, object.key)).toBe(true);
    expect(hasRow(host, asset.path)).toBe(false);
    const labels = Array.from(host.querySelectorAll<HTMLElement>('.tree-label')).map((el) => el.textContent || '');
    expect(labels.some((label) => /项目编号|Default|IFC(?:PROJECT|SITE|BUILDING)/i.test(label))).toBe(false);
    expect(labels).toContain('一层');
    host.querySelector<HTMLElement>(`[data-node-path="${object.key}"]`)!.click();
    expect(selectedObject).toBe(object.key);
  });

  it('未落位 IFC 构件和大分组支持分页加载，不再只显示前 200 个', () => {
    const walls = Array.from({ length: 205 }, (_, i) =>
      `#${100 + i}=IFCWALL('wall-${i}',#99,'墙体 ${i}',$,$,$,$,$,$);`,
    ).join('\n');
    const index = buildSubstationSpatialIndexFromTexts([
      { entry, text: `${ifcText.split("#10=IFCWALL")[0]}${walls}` },
    ], cbm());
    const host = document.createElement('div');
    document.body.appendChild(host);

    const state = new AppState();
    state.currentCbmTree = cbm();
    renderSubstationSpatialTree(state, index, host, () => undefined);
    host.querySelector<HTMLElement>('[data-node-path="spatial:quality:status"]')!.click();
    const group = host.querySelector<HTMLElement>('[data-node-path="spatial:quality:ifc-uncontained"]');
    expect(group).not.toBeNull();
    group!.click();
    const firstPage = host.querySelectorAll('[data-node-path^="ifc:model:object:"]').length;
    expect(firstPage).toBe(200);
    const more = host.querySelector<HTMLElement>('.spatial-load-more-row');
    expect(more?.textContent).toContain('剩余 5 个');
    more!.click();
    expect(host.querySelectorAll('[data-node-path^="ifc:model:object:"]').length).toBe(205);
    expect(host.querySelector('.spatial-load-more-row')).toBeNull();
  });

  it('坐标推断对象按网格分组，搜索时仍能展开到目标行', () => {
    const asset = cbm({
      path: 'CBM/device.cbm',
      entityName: 'F4System',
      devPath: 'device.dev',
      transformMatrix: '1,0,0,0,0,1,0,0,0,0,1,0,12345,23456,3456,1',
    });
    const state = new AppState();
    state.currentCbmTree = cbm({ children: [asset] });
    const index = buildSubstationSpatialIndexFromTexts([{ entry, text: ifcText }], state.currentCbmTree);
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderSubstationSpatialTree(state, index, host, () => undefined);

    const bucketKey = revealSpatialSearchTarget(index, asset.path);
    expect(bucketKey).toMatch(/^spatial:quality:placement:/);
    expect(host.querySelector(`[data-node-path="${bucketKey}"]`)).not.toBeNull();
    expect(host.querySelector(`[data-node-path="${asset.path}"]`)).not.toBeNull();
  });

  it('多个 IFC 来源模型按模型分组，避免 Default Project/Site 重复占满首层', () => {
    const state = new AppState();
    state.currentCbmTree = cbm();
    const index = buildSubstationSpatialIndexFromTexts([
      { entry, text: ifcText },
      { entry: { ...entry, modelId: 'model-2', name: 'model-2', path: 'DEV/model-2.ifc' }, text: ifcText },
    ], state.currentCbmTree);
    const host = document.createElement('div');
    document.body.appendChild(host);

    renderSubstationSpatialTree(state, index, host, () => undefined);
    const modelGroup = host.querySelector<HTMLElement>('[data-node-path="spatial:models"]');
    expect(modelGroup).not.toBeNull();
    modelGroup!.click();
    expect(host.querySelector('[data-node-path="spatial:model:model"]')).not.toBeNull();
    expect(host.querySelector('[data-node-path="spatial:model:model-2"]')).not.toBeNull();
  });
});
