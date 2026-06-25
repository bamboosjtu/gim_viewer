/**
 * 线路工程 UI 渲染层。
 *
 * 复用左侧层级树面板（cbmTreePanel）显示线路 CBM 树，
 * 复用文件设备面板（fileDevPanel）显示文件摘要，
 * 复用属性面板（propsDrawerBody）显示节点属性。
 *
 * 关键约束（spec 五）：
 * - 点击线路节点只展示属性，不创建 ViewerRuntime
 * - 不弹 IFC 模态框
 * - 不显示"未找到 IFC 文件"为错误
 */

import type { AppState } from '../app/state.js';
import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import { escHtml } from '../shared/html.js';
import { cbmTreePanel, fileDevPanel, modelListEl, propsDrawerBody, propsDrawer, btnToggleProps, emptyTipEl } from './dom.js';

/** 线路工程实体图标（扩展变电工程的 ENTITY_ICONS） */
const LINE_ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️',
  F2System: '🏢',
  F3System: '⚡',
  F4System: '🔧',
  Tower_Device: '🗼',
  Wire_Device: '〰️',
  WIRE: '〰️',
  CROSS: '✖️',
  PARTINDEX: '🔩',
};

/** 节点显示名称：classifyName 优先，回退 entityName，再回退文件名 */
function nodeDisplayName(node: GimGraphNode): string {
  const fn = node.path.split('/').pop() || node.path;
  return node.classifyName || node.entityName || fn.replace(/\.(cbm|dev|fam)$/i, '');
}

/**
 * 递归渲染线路 CBM 树节点。
 * 复用 tree-node / tree-row / tree-toggle / tree-icon / tree-label / tree-children 样式。
 */
function renderLineTreeNode(
  node: GimGraphNode,
  parentEl: HTMLElement,
  onNodeClick: (node: GimGraphNode) => void,
): void {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  const toggle = document.createElement('span');
  toggle.className = `tree-toggle ${node.children.length === 0 ? 'leaf' : ''}`;
  toggle.textContent = '▶';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = LINE_ENTITY_ICONS[node.entityName] || '📁';
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = nodeDisplayName(node);
  label.title = node.path;
  row.appendChild(toggle);
  row.appendChild(icon);
  row.appendChild(label);
  nodeEl.appendChild(row);
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.appendChild(childrenEl);

  let expanded = false;
  let childrenRendered = false;
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    onNodeClick(node);
    if (node.children.length > 0) {
      expanded = !expanded;
      toggle.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const child of node.children) renderLineTreeNode(child, childrenEl, onNodeClick);
        childrenRendered = true;
      }
    }
  });
  parentEl.appendChild(nodeEl);
}

/** 渲染文件设备面板摘要（线路工程无 FileDevRelation，改为文件统计摘要） */
function renderLineFileSummary(graph: GimGraph): void {
  fileDevPanel.innerHTML = '';
  const stats = graph.stats;

  // 文件计数统一从 stats 读取（与缓存恢复路径一致：
  // 缓存命中时 filesByType 数组为空，计数仅存在于 stats）
  const summary: [string, string][] = [
    ['CBM 文件', String(stats.CBM || 0)],
    ['DEV 文件', String(stats.DEV || 0)],
    ['FAM 文件', String(stats.FAM || 0)],
    ['PHM 文件', String(stats.PHM || 0)],
    ['MOD 文件', String(stats.MOD || 0)],
    ['STL 文件', String(stats.STL || 0)],
    ['IFC 文件', String(stats.IFC || 0)],
    ['—', '—'],
    ['F1System', String(stats.F1System || 0)],
    ['F2System', String(stats.F2System || 0)],
    ['F3System', String(stats.F3System || 0)],
    ['F4System', String(stats.F4System || 0)],
    ['Tower_Device', String(stats.Tower_Device || 0)],
    ['Wire_Device', String(stats.Wire_Device || 0)],
    ['WIRE', String(stats.WIRE || 0)],
    ['CROSS', String(stats.CROSS || 0)],
    ['—', '—'],
    ['节点总数', String(stats.total || 0)],
  ];

  const wrap = document.createElement('div');
  wrap.className = 'props-section';
  const title = document.createElement('div');
  title.className = 'props-section-title';
  title.textContent = '线路工程文件摘要';
  wrap.appendChild(title);
  const table = document.createElement('table');
  table.className = 'props-table';
  for (const [k, v] of summary) {
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.className = 'prop-key';
    tdK.textContent = k;
    const tdV = document.createElement('td');
    tdV.className = 'prop-val';
    tdV.textContent = v;
    tr.appendChild(tdK);
    tr.appendChild(tdV);
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  fileDevPanel.appendChild(wrap);
}

/** 渲染模型面板提示 */
function renderLineModelPanel(): void {
  if (!modelListEl) return;
  modelListEl.innerHTML = '';
  const tip = document.createElement('div');
  tip.className = 'props-empty';
  tip.textContent = '线路工程当前以结构浏览为主，暂无 IFC 模型。';
  modelListEl.appendChild(tip);
}

/** 渲染引用清单为 HTML */
function renderRefs(refs: GimGraphNode['refs']): string {
  const sections: [string, string[]][] = [
    ['CBM 引用', refs.cbmFiles],
    ['DEV 引用', refs.devFiles],
    ['FAM 引用', refs.famFiles],
    ['PHM 引用', refs.phmFiles],
    ['MOD 引用', refs.modFiles],
    ['STL 引用', refs.stlFiles],
    ['WIRE 引用', refs.wireFiles],
    ['IFC 引用', refs.ifcFiles],
  ];
  let html = '';
  for (const [title, files] of sections) {
    if (files.length === 0) continue;
    html += `<div class="props-section"><div class="props-section-title">${escHtml(title)} (${files.length})</div><table class="props-table">`;
    for (const f of files) {
      html += `<tr><td class="prop-val" colspan="2" style="font-family:monospace;font-size:11px;color:#888;word-break:break-all">${escHtml(f)}</td></tr>`;
    }
    html += '</table></div>';
  }
  // rawRefs（STRING<i>.GPOINT 等非文件挂点信息）
  const rawRefKeys = Object.keys(refs.rawRefs);
  if (rawRefKeys.length > 0) {
    html += '<div class="props-section"><div class="props-section-title">挂点 / 原始引用</div><table class="props-table">';
    for (const k of rawRefKeys) {
      const vals = refs.rawRefs[k];
      html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val">${escHtml(vals.join('; '))}</td></tr>`;
    }
    html += '</table></div>';
  }
  return html;
}

/** WIRE 节点需要突出显示的字段 */
const WIRE_HIGHLIGHT_KEYS = ['KVALUE', 'SPLIT', 'POINT0.BLHA', 'POINT1.BLHA'];

/** 显示线路节点属性到属性面板（纯 UI，不创建 Viewer） */
export function showLineNodeProperties(node: GimGraphNode): void {
  let html = `<div class="props-header">${escHtml(nodeDisplayName(node))}</div>`;

  // 基本信息
  html += '<div class="props-section"><div class="props-section-title">基本信息</div><table class="props-table">';
  const fileName = node.path.split('/').pop() || node.path;
  const basic: [string, string][] = [
    ['路径', node.path],
    ['文件名', fileName],
    ['实体类型', node.entityName],
    ['分类名称', node.classifyName],
    ['子节点数', String(node.children.length)],
  ];
  for (const [k, v] of basic) {
    if (v) html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val">${escHtml(v)}</td></tr>`;
  }
  html += '</table></div>';

  // WIRE 节点突出显示字段
  if (node.entityName === 'WIRE') {
    const highlightVals: [string, string][] = [];
    for (const k of WIRE_HIGHLIGHT_KEYS) {
      if (node.rawProps[k]) highlightVals.push([k, node.rawProps[k]]);
    }
    // 补充 POINT0.MATRIX0 / POINT1.MATRIX0（悬链线计算用）
    for (const k of ['POINT0.MATRIX0', 'POINT1.MATRIX0']) {
      if (node.rawProps[k]) highlightVals.push([k, node.rawProps[k]]);
    }
    if (highlightVals.length > 0) {
      html += '<div class="props-section"><div class="props-section-title">WIRE 悬链线参数</div><table class="props-table">';
      for (const [k, v] of highlightVals) {
        html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val" style="font-family:monospace;font-size:11px;word-break:break-all">${escHtml(v)}</td></tr>`;
      }
      html += '</table></div>';
    }
  }

  // 原始属性 rawProps（排除已突出显示的 WIRE 字段，避免重复）
  const excludeKeys = new Set<string>([
    'ENTITYNAME', 'GROUPTYPE', 'WIRETYPE', 'DEVICETYPE', 'SYSCLASSIFYNAME', 'PARTNAME',
    'TRANSFORMMATRIX',
    ...(node.entityName === 'WIRE' ? WIRE_HIGHLIGHT_KEYS : []),
  ]);
  const otherProps: [string, string][] = [];
  for (const [k, v] of Object.entries(node.rawProps)) {
    if (excludeKeys.has(k)) continue;
    if (!v) continue;
    otherProps.push([k, v]);
  }
  if (otherProps.length > 0) {
    html += '<div class="props-section"><div class="props-section-title">原始属性</div><table class="props-table">';
    for (const [k, v] of otherProps) {
      html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val" style="font-family:monospace;font-size:11px;word-break:break-all">${escHtml(v)}</td></tr>`;
    }
    html += '</table></div>';
  }

  // 变换矩阵
  const tm = node.rawProps['TRANSFORMMATRIX'];
  if (tm && tm !== '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1') {
    html += '<div class="props-section"><div class="props-section-title">变换矩阵</div><table class="props-table">';
    html += `<tr><td class="prop-val" colspan="2" style="font-family:monospace;font-size:11px;color:#888;word-break:break-all">${escHtml(tm)}</td></tr>`;
    html += '</table></div>';
  }

  // 引用清单
  html += renderRefs(node.refs);

  propsDrawerBody.innerHTML = html;
}

/**
 * 渲染线路工程面板（统一入口）。
 *
 * - 复用左侧层级树面板显示线路 CBM 树
 * - 文件设备面板显示文件摘要
 * - 模型面板显示提示
 * - 点击节点只展示属性，不创建 ViewerRuntime
 */
export function renderLineProjectPanels(
  state: AppState,
  graph: GimGraph,
  showMessage: (text: string) => void,
): void {
  // 确保 state 与 graph 同步（调用方可能已设置，此处幂等确认）
  state.currentGimGraph = graph;

  // 1. 层级树
  cbmTreePanel.innerHTML = '';
  if (!graph.root) {
    cbmTreePanel.innerHTML = '<div class="props-empty">线路工程未找到 CBM 层级树</div>';
  } else {
    renderLineTreeNode(graph.root, cbmTreePanel, (node) => {
      // 点击节点：只展示属性，不创建 Viewer
      showLineNodeProperties(node);
      // 打开属性面板（纯 UI，不刷新视口）
      propsDrawer.classList.remove('collapsed');
      btnToggleProps.style.right = '332px';
    });
  }

  // 2. 文件设备面板摘要
  renderLineFileSummary(graph);

  // 3. 模型面板提示
  renderLineModelPanel();

  // 4. 隐藏空提示（线路工程不需要 3D 视口提示）
  if (emptyTipEl) emptyTipEl.style.display = 'none';

  // 5. 状态提示
  showMessage('线路工程已加载，当前为结构浏览模式');
  console.log('[GIM] 线路工程面板已渲染:', {
    type: graph.projectType,
    root: graph.root?.path || null,
    totalNodes: graph.stats.total,
    stats: graph.stats,
  });
}
