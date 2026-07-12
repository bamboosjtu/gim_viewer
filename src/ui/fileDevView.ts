import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import { fileDevPanel } from './dom.js';
import { getNodeDisplayName } from '../shared/displayName.js';

const ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️', F2System: '🏢', F3System: '⚡', F4System: '🔧', PARTINDEX: '🔩',
};

/**
 * 判断 CBM 节点是否为 MOD 几何加载起点。
 *
 * 与 services/modAutoLoadService.isGeometryAutoLoadSeed 保持一致：
 * 必须有 devPath，排除 DEV_SUBDEVICE（虚拟节点）和 PARTINDEX（父 DEV 的语义别名，
 * 自身无 SUBDEVICE 局部矩阵，由根 DEV 递归覆盖）。
 */
function isModDeviceNode(node: CbmNode): boolean {
  return !!node.devPath
    && node.entityName !== 'DEV_SUBDEVICE'
    && node.entityName !== 'PARTINDEX';
}

/**
 * 遍历 CBM 树，收集所有可作为 MOD 几何加载起点的设备节点。
 *
 * 与 services/modAutoLoadService.collectCbmDeviceInstances 的筛选逻辑一致，
 * 但不含 transform 累积（UI 层不需要矩阵，只用于列表展示和点击回调）。
 */
function collectModDeviceNodes(root: CbmNode | null): CbmNode[] {
  const nodes: CbmNode[] = [];
  if (!root) return nodes;
  function walk(node: CbmNode) {
    if (isModDeviceNode(node)) {
      nodes.push(node);
    }
    for (const child of node.children) {
      walk(child);
    }
  }
  walk(root);
  return nodes;
}

/**
 * 创建一个可折叠的树节点 DOM 结构。
 *
 * @param iconText 图标 emoji
 * @param labelText 节点标签文本
 * @param onToggle 展开/折叠时的回调（首次展开时调用，用于懒加载子节点）
 * @returns 包含 row 和 childrenEl 的结构
 */
function createCollapsibleNode(
  iconText: string,
  labelText: string,
  paddingLeft: string,
): { nodeEl: HTMLElement; row: HTMLElement; childrenEl: HTMLElement } {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = paddingLeft;
  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  toggle.textContent = '▶';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = iconText;
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = labelText;
  row.appendChild(toggle); row.appendChild(icon); row.appendChild(label);
  nodeEl.appendChild(row);
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.appendChild(childrenEl);
  return { nodeEl, row, childrenEl };
}

/**
 * 创建设备子节点行（用于 IFC entries 和 MOD devices 共用）。
 */
function createDeviceRow(
  devNode: CbmNode | undefined,
  fallbackName: string,
  state: AppState,
  onNodeClick: (node: CbmNode) => void,
  paddingLeft: string,
): HTMLElement {
  const devRow = document.createElement('div');
  devRow.className = 'tree-row';
  devRow.style.paddingLeft = paddingLeft;
  const devIcon = document.createElement('span');
  devIcon.className = 'tree-icon';
  devIcon.textContent = devNode ? (ENTITY_ICONS[devNode.entityName] || '📁') : '🔩';
  const devLabel = document.createElement('span');
  devLabel.className = 'tree-label';
  devLabel.textContent = devNode ? getNodeDisplayName(devNode, state.ifcGuidToName) : fallbackName;
  devRow.appendChild(devIcon); devRow.appendChild(devLabel);
  devRow.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    devRow.classList.add('selected');
    if (devNode) {
      onNodeClick(devNode);
    } else {
      const tempNode: CbmNode = {
        path: '', name: fallbackName,
        entityName: '', children: [], famPath: '', devPath: '',
        ifcFile: '', ifcGuid: '', classifyName: '', transformMatrix: '',
        systemNames: [], devSymbolName: '', devType: '', devExpanded: false,
      };
      onNodeClick(tempNode);
    }
  });
  return devRow;
}

/**
 * 纯 UI 渲染层：渲染文件-设备面板，不依赖 ViewerContext。
 *
 * 面板分两个区域：
 * 1. IFC 模型区域：按 IFC 文件分组，每组下挂关联设备（CBM 节点）
 * 2. MOD 几何模型区域：全部有 devPath 的设备节点，作为统一总节点的子项
 *
 * 两个区域的设备点击均通过 onNodeClick 回调，由交互层统一处理。
 *
 * @param onNodeClick 设备节点点击回调（由交互层提供）
 */
export function renderFileDevPanelUI(
  state: AppState,
  onNodeClick: (node: CbmNode) => void,
): void {
  fileDevPanel.innerHTML = '';

  const modDeviceNodes = collectModDeviceNodes(state.currentCbmTree);
  const hasIfcEntries = state.fileDevRelations.length > 0;
  const hasModDevices = modDeviceNodes.length > 0;

  if (!hasIfcEntries && !hasModDevices) {
    fileDevPanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示文件-设备关系</div>';
    return;
  }

  // ── 1. IFC 模型区域 ──
  for (const entry of state.fileDevRelations) {
    const { nodeEl, row, childrenEl } = createCollapsibleNode(
      '📄',
      `${entry.ifcName} (${entry.deviceCount})`,
      '0px',
    );

    let expanded = false;
    let childrenRendered = false;
    row.addEventListener('click', () => {
      expanded = !expanded;
      row.querySelector('.tree-toggle')?.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const devCbm of entry.deviceCbms) {
          const devNode = state.cbmNodeIndex.get(devCbm);
          const devRow = createDeviceRow(
            devNode,
            devCbm.replace(/\.cbm$/i, ''),
            state,
            onNodeClick,
            '24px',
          );
          childrenEl.appendChild(devRow);
        }
        childrenRendered = true;
      }
    });
    fileDevPanel.appendChild(nodeEl);
  }

  // ── 2. MOD 几何模型区域 ──
  // 将全部有 devPath 的设备节点作为统一总节点的子项。
  // 变电工程中 DEV.glb 已按 DEV 预编译，此处提供统一的浏览入口。
  if (hasModDevices) {
    const { nodeEl, row, childrenEl } = createCollapsibleNode(
      '🧊',
      `MOD 几何模型 (${modDeviceNodes.length})`,
      '0px',
    );

    let expanded = false;
    let childrenRendered = false;
    row.addEventListener('click', () => {
      expanded = !expanded;
      row.querySelector('.tree-toggle')?.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const devNode of modDeviceNodes) {
          const devRow = createDeviceRow(
            devNode,
            devNode.name,
            state,
            onNodeClick,
            '24px',
          );
          childrenEl.appendChild(devRow);
        }
        childrenRendered = true;
      }
    });
    fileDevPanel.appendChild(nodeEl);
  }
}

/**
 * 渲染文件-设备面板。
 * 统一入口：无论首次打开还是缓存命中，都使用 onNodeClick 回调处理交互。
 */
export function renderFileDevPanel(
  state: AppState,
  onNodeClick: (node: CbmNode) => void,
): void {
  renderFileDevPanelUI(state, onNodeClick);
}
