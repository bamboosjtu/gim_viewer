import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';

describe('属性检查器纯 DOM 交互', () => {
  beforeEach(() => {
    // dom.ts captures element references at module evaluation time. Reset the
    // module registry before replacing document.body so every test exercises
    // the current fixture instead of a detached element from the prior test.
    vi.resetModules();
    document.body.innerHTML = `
      <button id="btn-toggle-props"></button>
      <button id="btn-close-props"></button>
      <button id="btn-export-props"></button>
      <aside id="props-drawer" class="collapsed"><div id="props-drawer-body"></div></aside>
    `;
  });

  it('无 Viewer 时也能切换页签并分发来源引用事件', async () => {
    // dom.ts 在模块加载时读取元素，因此必须在动态 import 前创建 DOM。
    const drawer = await import('../propsDrawer.js');
    const dictionary = await import('../propertyDictionary.js');
    const handler = vi.fn(() => true);
    dictionary.registerPropertyReferenceHandler(handler);
    drawer.setupPropsDrawerInteractions();
    drawer.renderInspectorTabs(
      '<div class="props-header">WIRE</div>',
      {
        overview: '<div>概览内容</div>',
        params: '<div>参数内容</div>',
        relations: '<div>关系内容</div>',
        source: '<div><button type="button" class="prop-ref-link" data-prop-ref="1" data-reference-kind="fam" data-reference-path="FAM/a.fam">查看属性族</button></div>',
      },
    );

    (document.querySelector('[data-itab="params"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-itab="params"]')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('[data-itab-pane="params"]')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('[data-itab-pane="overview"]')?.classList.contains('active')).toBe(false);

    (document.querySelector('[data-itab="source"]') as HTMLButtonElement).click();
    (document.querySelector('[data-prop-ref]') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledWith({ kind: 'fam', path: 'FAM/a.fam' });
  });

  it('运行时 IFC modelId 通过 IfcEntry 反查真实来源路径', async () => {
    const drawer = await import('../propsDrawer.js');
    const state = new AppState();
    state.currentIfcEntries = [{
      name: 'foo',
      path: 'DEV/A/foo.ifc',
      modelId: 'ifc_0123456789abcdef',
    }];
    state.deviceToIfcFile.set('CBM/device.cbm', 'ifc_0123456789abcdef');
    const node: CbmNode = {
      path: 'CBM/device.cbm',
      name: '设备',
      entityName: 'F4System',
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
    };

    await drawer.showNodePropertiesBasic(state, node);
    const link = document.querySelector<HTMLButtonElement>('[data-reference-kind="ifc"]');
    expect(link?.dataset.referencePath).toBe('DEV/A/foo.ifc');
  });

  it('未知运行时 IFC modelId 不伪造来源路径', async () => {
    const drawer = await import('../propsDrawer.js');
    const state = new AppState();
    const node: CbmNode = {
      path: 'CBM/device.cbm',
      name: '设备',
      entityName: 'F4System',
      children: [],
      famPath: '',
      devPath: '',
      ifcFile: 'ifc_future-format',
      ifcGuid: 'guid-1',
      classifyName: '',
      transformMatrix: '',
      systemNames: [],
      devSymbolName: '',
      devType: '',
      devExpanded: false,
    };

    await drawer.showNodePropertiesBasic(state, node);
    expect(document.querySelector('[data-reference-kind="ifc"]')).toBeNull();
  });

  it('CBM 裸 IFC 文件名来源反查为包内真实路径', async () => {
    const drawer = await import('../propsDrawer.js');
    const state = new AppState();
    state.currentIfcEntries = [{
      name: 'foo',
      path: 'DEV/A/foo.ifc',
      modelId: 'ifc_0123456789abcdef',
    }];
    const node: CbmNode = {
      path: 'CBM/device.cbm',
      name: '设备',
      entityName: 'F4System',
      children: [],
      famPath: '',
      devPath: '',
      ifcFile: 'foo.ifc',
      ifcGuid: '',
      classifyName: '',
      transformMatrix: '',
      systemNames: [],
      devSymbolName: '',
      devType: '',
      devExpanded: false,
    };

    await drawer.showNodePropertiesBasic(state, node);
    expect(document.querySelector<HTMLButtonElement>('[data-reference-kind="ifc"]')?.dataset.referencePath)
      .toBe('DEV/A/foo.ifc');
  });

  it('重复 basename 的 CBM 来源不静默指向任一 IFC', async () => {
    const drawer = await import('../propsDrawer.js');
    const state = new AppState();
    state.currentIfcEntries = [
      { name: 'foo', path: 'DEV/A/foo.ifc', modelId: 'ifc_aaaaaaaaaaaaaaaa' },
      { name: 'foo', path: 'DEV/B/foo.ifc', modelId: 'ifc_bbbbbbbbbbbbbbbb' },
    ];
    const node: CbmNode = {
      path: 'CBM/device.cbm',
      name: '设备',
      entityName: 'F4System',
      children: [],
      famPath: '',
      devPath: '',
      ifcFile: 'foo.ifc',
      ifcGuid: '',
      classifyName: '',
      transformMatrix: '',
      systemNames: [],
      devSymbolName: '',
      devType: '',
      devExpanded: false,
    };

    await drawer.showNodePropertiesBasic(state, node);
    expect(document.querySelector('[data-reference-kind="ifc"]')).toBeNull();
  });
});
