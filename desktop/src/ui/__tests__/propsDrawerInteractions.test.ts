import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('属性检查器纯 DOM 交互', () => {
  beforeEach(() => {
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
});
