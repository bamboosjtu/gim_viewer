/**
 * SLD 电气单线图与 STD 拓扑展示视图。
 *
 * 阶段 3（UI 渲染）：
 * - 「单线图」模式：inline SVG 渲染 SLD，CSS 通过独立 `<style>` 标签注入（CSP 兼容）
 * - 「拓扑列表」模式：树形展示 STD 层级（Substation → VoltageLevel → Bay → ConductingEquipment）
 * - 点击带 gridId 的元素（SVG `<g>` 或拓扑项）触发选中高亮，为阶段 4 联动预留入口
 *
 * 关联文档：[05-cbm-tree-structure.md](../../docs/schema/05-cbm-tree-structure.md)
 */

import type { AppState } from '../app/state.js';
import type { SldDocument } from '../gim/sldParser.js';
import type { StdDocument, StdNode } from '../gim/stdParser.js';
import { sldOverlay, sldOverlayClose, sldOverlayContent, sldPanel } from './dom.js';

type SldViewMode = 'diagram' | 'topology';

// 模块内单例状态（视图刷新间保持）
let activeMode: SldViewMode = 'diagram';
let selectedGridId: string | null = null;
let overlayState: AppState | null = null;
let overlayVisible = false;
let overlayInteractionsReady = false;

/**
 * 渲染 SLD 视图主入口。
 *
 * 在以下场景被调用：
 * - onGimExtracted：首次打开 GIM 后（state.currentSldDoc/currentStdDoc 已就绪）
 * - restoreStdSldFromCache：缓存命中后从磁盘恢复
 * - projectCleanupService：state.currentSldDoc/currentStdDoc 为 null 时显示空状态
 */
export function renderSldView(state: AppState): void {
  overlayState = state;
  ensureSldOverlayInteractions();
  sldPanel.innerHTML = '';

  const sld = state.currentSldDoc;
  const std = state.currentStdDoc;

  if (!sld && !std) {
    // 区分"未加载工程"与"已加载工程但无电气图数据"（如 Bentley 导出的 substation02 不含 .sld/.std）
    const hasProject = !!(state.currentCbmTree || state.currentGimGraph) || state.currentProjectId != null;
    const msg = hasProject
      ? '当前工程不含电气图数据（未找到 .sld / .std 文件）'
      : '加载 GIM 文件后显示电气单线图';
    sldPanel.innerHTML = `<div class="sld-empty-full">${msg}</div>`;
    renderSldOverlay();
    return;
  }

  sldPanel.appendChild(renderHeader(sld, std));
  sldPanel.appendChild(renderToolbar(state, sld, std));
  sldPanel.appendChild(renderContent(state, sld, std, activeMode));
  // 图纸工作区被选中时，将一次图复制到主视口的叠加层；左侧仍保留
  // 工具栏/拓扑列表，底层 3D 场景不参与此过程。
  overlayVisible = isSldTabActive() && activeMode === 'diagram';
  renderSldOverlay();
}

/** 清空 SLD 视图（项目切换时调用） */
export function clearSldView(): void {
  // 清理可能发生在测试/嵌入式宿主尚未创建左侧面板的场景；
  // 覆盖层和模块状态仍需正常复位。
  if (sldPanel) sldPanel.innerHTML = '';
  selectedGridId = null;
  activeMode = 'diagram';
  gridIdClickHandler = null;
  overlayState = null;
  overlayVisible = false;
  renderSldOverlay();
}

/**
 * 将一次图叠加在主视口中。只操作 #sld-overlay 的 DOM，不触碰 Viewer
 * runtime、Three.js 场景或模型索引，因此关闭图纸时 3D 模型仍然存在。
 */
function renderSldOverlay(): void {
  if (!sldOverlay || !sldOverlayContent) return;
  const sld = overlayState?.currentSldDoc;
  const visible = overlayVisible && activeMode === 'diagram' && !!sld?.safeSvgOuterHTML;
  sldOverlay.classList.toggle('visible', visible);
  sldOverlay.setAttribute('aria-hidden', String(!visible));
  if (!visible) {
    sldOverlayContent.replaceChildren();
    return;
  }
  sldOverlayContent.replaceChildren(renderSvgDiagram(overlayState!, sld!));
}

function ensureSldOverlayInteractions(): void {
  if (overlayInteractionsReady) return;
  overlayInteractionsReady = true;
  sldOverlayClose?.addEventListener('click', () => {
    overlayVisible = false;
    renderSldOverlay();
  });
  document.addEventListener('gim:tab-activated', (event: Event) => {
    const tabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
    if (tabId === 'tab-sld') {
      overlayVisible = true;
    } else {
      overlayVisible = false;
    }
    renderSldOverlay();
  });
}

function isSldTabActive(): boolean {
  return document.querySelector<HTMLElement>('#workspace-rail .rail-item.active')?.dataset.tab === 'tab-sld';
}

// ===== 头部信息 =====

function renderHeader(sld: SldDocument | null, std: StdDocument | null): HTMLElement {
  const header = document.createElement('div');
  header.className = 'sld-header';

  const title = document.createElement('div');
  title.className = 'sld-title';
  title.textContent = '电气单线图与拓扑';

  const meta = document.createElement('div');
  meta.className = 'sld-meta';
  const parts: string[] = [];
  if (sld) {
    parts.push(`SLD v${sld.version || '?'}`);
    if (sld.revision) parts.push(`rev ${sld.revision}`);
    if (sld.width && sld.height) parts.push(`${Math.round(sld.width)}×${Math.round(sld.height)}`);
    parts.push(`${sld.gridIdIndex.size} 图节点`);
  }
  if (std) {
    parts.push(`STD v${std.version || '?'}`);
    parts.push(`${std.gridIdIndex.size} 拓扑节点`);
  }
  meta.textContent = parts.join(' · ');

  header.appendChild(title);
  header.appendChild(meta);
  return header;
}

// ===== 工具栏（模式切换） =====

function renderToolbar(state: AppState, sld: SldDocument | null, std: StdDocument | null): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'sld-toolbar';

  const btnDiagram = document.createElement('button');
  btnDiagram.textContent = '单线图';
  btnDiagram.disabled = !sld || !sld.safeSvgOuterHTML;
  if (activeMode === 'diagram' && !btnDiagram.disabled) btnDiagram.classList.add('active');

  const btnTopology = document.createElement('button');
  btnTopology.textContent = '拓扑列表';
  btnTopology.disabled = !std || !std.substation;
  if (activeMode === 'topology' && !btnTopology.disabled) btnTopology.classList.add('active');

  // 切换到单线图
  btnDiagram.addEventListener('click', () => {
    if (btnDiagram.disabled) return;
    activeMode = 'diagram';
    replaceContent(state, sld, std, 'diagram');
    btnDiagram.classList.add('active');
    btnTopology.classList.remove('active');
    overlayVisible = isSldTabActive();
    renderSldOverlay();
  });

  // 切换到拓扑列表
  btnTopology.addEventListener('click', () => {
    if (btnTopology.disabled) return;
    activeMode = 'topology';
    replaceContent(state, sld, std, 'topology');
    btnTopology.classList.add('active');
    btnDiagram.classList.remove('active');
    overlayVisible = false;
    renderSldOverlay();
  });

  toolbar.appendChild(btnDiagram);
  toolbar.appendChild(btnTopology);
  return toolbar;
}

function replaceContent(state: AppState, sld: SldDocument | null, std: StdDocument | null, mode: SldViewMode): void {
  const old = sldPanel.querySelector('.sld-svg-wrap, .sld-topo-list');
  if (old) {
    old.replaceWith(renderContent(state, sld, std, mode));
  }
  renderSldOverlay();
}

// ===== 内容区 =====

function renderContent(state: AppState, sld: SldDocument | null, std: StdDocument | null, mode: SldViewMode): HTMLElement {
  if (mode === 'topology') {
    return renderTopologyList(state, std);
  }
  return renderSvgDiagram(state, sld);
}

// ===== 单线图（inline SVG） =====

function renderSvgDiagram(_state: AppState, sld: SldDocument | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sld-svg-wrap';

  if (!sld || !sld.safeSvgOuterHTML) {
    wrap.innerHTML = '<div class="sld-empty">此工程无 SLD 单线图</div>';
    return wrap;
  }

  // P0 安全评审：不可信 SVG 以 <img> blob 形式渲染。
  //
  // 浏览器对 <img> 内的 SVG 强制静态模式：
  //   - 脚本一律不执行（即使解析器白名单存在未覆盖的旁路）
  //   - 外部引用（网络请求）原生阻止
  //   - 内容无法访问宿主文档 / Tauri IPC / localStorage
  // 这比 sandbox iframe 更强（无需依赖属性拼写），且 CSS 在 SVG 文档内部生效，
  // 不再向主文档注入任何来自 GIM 的 <style>。
  //
  // 交互说明：gridId 点击联动由右侧拓扑列表承载；图面本身为静态渲染。
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(sld.safeSvgOuterHTML, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('parse error');
    const svg = doc.documentElement;

    // viewBox 自适应 + 尺寸弹性化
    if (!svg.getAttribute('viewBox') && sld.viewBox[2] > 0 && sld.viewBox[3] > 0) {
      svg.setAttribute('viewBox', sld.viewBox.join(' '));
    }
    svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('style', 'max-width:100%;height:auto;display:block;');

    // 净化后的 CSS 嵌入 SVG 文档内部（随 blob 进入 img 静态沙箱，不污染主文档）
    if (sld.css) {
      const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
      styleEl.textContent = sld.css;
      svg.insertBefore(styleEl, svg.firstChild);
    }

    const serialized = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const img = document.createElement('img');
    img.className = 'sld-svg-img';
    img.alt = 'SLD 单线图';
    img.style.maxWidth = '100%';
    img.style.display = 'block';
    img.src = url;
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    img.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      wrap.innerHTML = '<div class="sld-empty">SVG 渲染失败</div>';
    });
    wrap.appendChild(img);
  } catch (err) {
    console.warn('[SLD View] SVG 渲染失败:', err);
    wrap.innerHTML = '<div class="sld-empty">SVG 渲染失败</div>';
  }
  return wrap;
}

// ===== 拓扑列表（STD 树形展示） =====

function renderTopologyList(state: AppState, std: StdDocument | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sld-topo-list';

  if (!std || !std.substation) {
    wrap.innerHTML = '<div class="sld-empty">此工程无 STD 拓扑定义</div>';
    return wrap;
  }

  renderStdNode(std.substation, 0, wrap, state);
  return wrap;
}

function renderStdNode(node: StdNode, depth: number, parent: HTMLElement, state: AppState): void {
  const item = document.createElement('div');
  item.className = 'sld-topo-item';
  if (selectedGridId && node.gridId === selectedGridId) item.classList.add('selected');
  item.style.paddingLeft = `${8 + depth * 12}px`;

  const tag = document.createElement('span');
  tag.className = 'sld-topo-tag';
  tag.textContent = node.tag;

  const name = document.createElement('span');
  name.className = 'sld-topo-name';
  // name 优先 name，其次 desc，最后 '-'
  name.textContent = node.name || node.desc || '-';
  name.title = node.desc || node.name || '';

  item.appendChild(tag);
  item.appendChild(name);

  if (node.gridId) {
    const grid = document.createElement('span');
    grid.className = 'sld-topo-grid';
    grid.textContent = node.gridId;
    item.appendChild(grid);
    item.addEventListener('click', () => handleGridIdClick(state, node.gridId));
  }

  parent.appendChild(item);
  for (const child of node.children) {
    renderStdNode(child, depth + 1, parent, state);
  }
}

// ===== 阶段 4：gridId 双向联动 =====

/**
 * 外部联动回调（由 openGimService 注入）。
 *
 * 点击 SLD 元素或 STD 拓扑项时触发，外部回调负责：
 * - 通过 gridId 查找 CBM 节点
 * - 触发 handleNodeClick（高亮 CBM 树 + 加载 IFC + 3D 高亮 + 相机定位）
 *
 * 用回调注入避免 sldView ↔ nodeInteractionService 循环依赖。
 */
type GridIdClickHandler = (gridId: string) => Promise<void> | void;
let gridIdClickHandler: GridIdClickHandler | null = null;

/**
 * 注册外部 gridId 点击联动回调。
 *
 * 在 GIM 打开（首次或缓存命中）后由 openGimService 调用，
 * 在 projectCleanupService 清空项目时置空。
 */
export function setSldGridIdClickHandler(handler: GridIdClickHandler | null): void {
  gridIdClickHandler = handler;
}

/**
 * 外部触发的 SLD 高亮（由 nodeInteractionService 调用）。
 *
 * CBM 树节点点击时，根据其 gridId 反向高亮 SLD 元素和拓扑列表项。
 * gridId 为 null 时清除高亮。
 */
export function highlightSldByGridId(gridId: string | null): void {
  selectedGridId = gridId;

  // 1. SVG 图面（P0 安全评审后为 <img> 静态渲染，无 [data-grid-id] 节点，查询空转）
  sldPanel.querySelectorAll('[data-grid-id]').forEach((el) => {
    el.classList.toggle('sld-selected', el.getAttribute('data-grid-id') === gridId);
  });

  // 2. 拓扑列表选中项高亮 + 滚动到可见
  // 先高亮所有项，再单独找到首个匹配项滚动
  const topoItems = Array.from(sldPanel.querySelectorAll<HTMLElement>('.sld-topo-item'));
  let firstMatch: HTMLElement | null = null;
  for (const item of topoItems) {
    const gridEl = item.querySelector('.sld-topo-grid');
    const match = gridEl?.textContent === gridId;
    item.classList.toggle('selected', match);
    if (match && !firstMatch) firstMatch = item;
  }

  // 滚动到首个匹配项（在拓扑列表模式下）
  if (firstMatch) {
    try {
      firstMatch.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch {
      // 忽略滚动异常
    }
  }
}

// ===== gridId 选中处理 =====

function handleGridIdClick(_state: AppState, gridId: string): void {
  // 1. UI 高亮（同步）
  highlightSldByGridId(gridId);

  // 2. 触发外部联动回调（异步，不阻塞 UI）
  if (gridIdClickHandler) {
    try {
      const result = gridIdClickHandler(gridId);
      // 处理 Promise 返回值，捕获异常避免 unhandledrejection
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err) => {
          console.warn('[SLD] gridId 联动回调失败:', err);
        });
      }
    } catch (err) {
      console.warn('[SLD] gridId 联动回调同步异常:', err);
    }
  } else {
    console.log('[SLD] gridId 点击（未注册联动回调）:', gridId);
  }
}
