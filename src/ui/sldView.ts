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
import { sldPanel } from './dom.js';

type SldViewMode = 'diagram' | 'topology';

// 模块内单例状态（视图刷新间保持）
let activeMode: SldViewMode = 'diagram';
let selectedGridId: string | null = null;

/**
 * 渲染 SLD 视图主入口。
 *
 * 在以下场景被调用：
 * - onGimExtracted：首次打开 GIM 后（state.currentSldDoc/currentStdDoc 已就绪）
 * - restoreStdSldFromCache：缓存命中后从磁盘恢复
 * - projectCleanupService：state.currentSldDoc/currentStdDoc 为 null 时显示空状态
 */
export function renderSldView(state: AppState): void {
  sldPanel.innerHTML = '';

  const sld = state.currentSldDoc;
  const std = state.currentStdDoc;

  if (!sld && !std) {
    sldPanel.innerHTML = '<div class="sld-empty-full">加载 GIM 文件后显示电气单线图</div>';
    return;
  }

  sldPanel.appendChild(renderHeader(sld, std));
  sldPanel.appendChild(renderToolbar(state, sld, std));
  sldPanel.appendChild(renderContent(state, sld, std, activeMode));
}

/** 清空 SLD 视图（项目切换时调用） */
export function clearSldView(): void {
  sldPanel.innerHTML = '';
  selectedGridId = null;
  activeMode = 'diagram';
  gridIdClickHandler = null;
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
  });

  // 切换到拓扑列表
  btnTopology.addEventListener('click', () => {
    if (btnTopology.disabled) return;
    activeMode = 'topology';
    replaceContent(state, sld, std, 'topology');
    btnTopology.classList.add('active');
    btnDiagram.classList.remove('active');
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
}

// ===== 内容区 =====

function renderContent(state: AppState, sld: SldDocument | null, std: StdDocument | null, mode: SldViewMode): HTMLElement {
  if (mode === 'topology') {
    return renderTopologyList(state, std);
  }
  return renderSvgDiagram(state, sld);
}

// ===== 单线图（inline SVG） =====

function renderSvgDiagram(state: AppState, sld: SldDocument | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sld-svg-wrap';

  if (!sld || !sld.safeSvgOuterHTML) {
    wrap.innerHTML = '<div class="sld-empty">此工程无 SLD 单线图</div>';
    return wrap;
  }

  // 注入 CSS（CSP 兼容：从 <script type="text/css"> 抽出的 CSS 通过独立 <style> 标签注入）
  if (sld.css) {
    const style = document.createElement('style');
    style.textContent = sld.css;
    wrap.appendChild(style);
  }

  // 注入 SVG：通过 DOMParser 解析后 append，确保命名空间正确
  const parser = new DOMParser();
  const doc = parser.parseFromString(sld.safeSvgOuterHTML, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.warn('[SLD View] SVG 注入解析失败:', parseError.textContent);
    wrap.innerHTML = '<div class="sld-empty">SVG 解析失败</div>';
    return wrap;
  }

  const svg = doc.documentElement;
  // 自适应：保留原始 viewBox，强制 max-width: 100%
  if (!svg.getAttribute('viewBox') && sld.viewBox[2] > 0 && sld.viewBox[3] > 0) {
    svg.setAttribute('viewBox', sld.viewBox.join(' '));
  }
  svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
  // 移除固定 width/height（让 CSS 控制）
  svg.removeAttribute('width');
  svg.removeAttribute('height');

  // 为每个带 gridId 的 <g> 标记 data-grid-id，绑定点击事件
  svg.querySelectorAll('[gridId]').forEach((el) => {
    const gid = el.getAttribute('gridId') || '';
    if (gid) {
      el.setAttribute('data-grid-id', gid);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        handleGridIdClick(state, gid);
      });
    }
  });

  wrap.appendChild(svg);
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

  // 1. SVG 内选中元素高亮 + 滚动到可见
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
