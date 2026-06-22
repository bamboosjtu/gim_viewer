import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SldDocument } from '../../gim/sldParser.js';
import { AppState } from '../../app/state.js';

function makeSld(): SldDocument {
  return {
    version: 'DLT1',
    soft: 'test',
    revision: '1',
    width: 320,
    height: 180,
    viewBox: [0, 0, 320, 180],
    css: '',
    symbols: new Map(),
    groups: [],
    gridIdIndex: new Map(),
    safeSvgOuterHTML: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="white"/></svg>',
  };
}

describe('SLD 主视口叠加层', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <nav id="workspace-rail">
        <button class="rail-item active" data-tab="tab-tree"></button>
        <button class="rail-item" data-tab="tab-sld"></button>
      </nav>
      <div id="sld-panel"></div>
      <div id="viewport">
        <div id="three-runtime-sentinel"></div>
        <div id="sld-overlay" class="sld-overlay" aria-hidden="true">
          <div class="sld-overlay-header"><button id="sld-overlay-close" type="button">关闭</button></div>
          <div id="sld-overlay-content"></div>
        </div>
      </div>
    `;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:test-sld'),
    });
  });

  it('切换图纸只显示覆盖层，不移除三维运行时容器', async () => {
    vi.resetModules();
    const { renderSldView } = await import('../sldView.js');
    const state = new AppState();
    state.currentSldDoc = makeSld();

    renderSldView(state);
    const sentinel = document.getElementById('three-runtime-sentinel');
    expect(sentinel).not.toBeNull();
    expect(document.querySelector('#sld-overlay.visible')).toBeNull();

    document.dispatchEvent(new CustomEvent('gim:tab-activated', { detail: { tabId: 'tab-sld' } }));
    expect(document.querySelector('#sld-overlay.visible')).not.toBeNull();
    expect(document.querySelector('#sld-overlay-content .sld-svg-img')).not.toBeNull();
    expect(document.getElementById('three-runtime-sentinel')).toBe(sentinel);

    document.dispatchEvent(new CustomEvent('gim:tab-activated', { detail: { tabId: 'tab-tree' } }));
    expect(document.querySelector('#sld-overlay.visible')).toBeNull();
    expect(document.getElementById('three-runtime-sentinel')).toBe(sentinel);
  });

  it('关闭工程时清空覆盖层，但不触碰主视口节点', async () => {
    vi.resetModules();
    const { renderSldView, clearSldView } = await import('../sldView.js');
    const state = new AppState();
    state.currentSldDoc = makeSld();
    renderSldView(state);
    document.dispatchEvent(new CustomEvent('gim:tab-activated', { detail: { tabId: 'tab-sld' } }));

    clearSldView();
    expect(document.querySelector('#sld-overlay.visible')).toBeNull();
    expect(document.getElementById('sld-overlay-content')?.childElementCount).toBe(0);
    expect(document.getElementById('three-runtime-sentinel')).not.toBeNull();
  });
});
