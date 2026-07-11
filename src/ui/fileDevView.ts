import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import { fileDevPanel } from './dom.js';
import { getNodeDisplayName } from '../shared/displayName.js';

const ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️', F2System: '🏢', F3System: '⚡', F4System: '🔧', PARTINDEX: '🔩',
};

/**
 * 纯 UI 渲染层：渲染文件-设备面板，不依赖 ViewerContext。
 * @param onNodeClick 设备节点点击回调（由交互层提供）
 */
export function renderFileDevPanelUI(
  state: AppState,
  onNodeClick: (node: CbmNode) => void,
): void {
  fileDevPanel.innerHTML = '';
  if (state.fileDevRelations.length === 0) {
    fileDevPanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示文件-设备关系</div>';
    return;
  }
  for (const entry of state.fileDevRelations) {
    const nodeEl = document.createElement('div');
    nodeEl.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row';
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = '▶';
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '📄';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = `${entry.ifcName} (${entry.deviceCount})`;
    row.appendChild(toggle); row.appendChild(icon); row.appendChild(label);
    nodeEl.appendChild(row);
    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';
    nodeEl.appendChild(childrenEl);

    let expanded = false;
    let childrenRendered = false;
    row.addEventListener('click', () => {
      expanded = !expanded;
      toggle.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const devCbm of entry.deviceCbms) {
          const devNode = state.cbmNodeIndex.get(devCbm);
          const devRow = document.createElement('div');
          devRow.className = 'tree-row';
          devRow.style.paddingLeft = '24px';
          const devIcon = document.createElement('span');
          devIcon.className = 'tree-icon';
          devIcon.textContent = devNode ? (ENTITY_ICONS[devNode.entityName] || '📁') : '🔩';
          const devLabel = document.createElement('span');
          devLabel.className = 'tree-label';
          devLabel.textContent = devNode ? getNodeDisplayName(devNode, state.ifcGuidToName) : devCbm.replace(/\.cbm$/i, '');
          devRow.appendChild(devIcon); devRow.appendChild(devLabel);
          devRow.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
            devRow.classList.add('selected');
            if (devNode) {
              onNodeClick(devNode);
            } else {
              const tempNode: CbmNode = {
                path: `CBM/${devCbm}`, name: devCbm.replace(/\.cbm$/i, ''),
                entityName: '', children: [], famPath: '', devPath: '',
                ifcFile: '', ifcGuid: '', classifyName: '', transformMatrix: '',
                // 新增字段默认值
                systemNames: [], devSymbolName: '', devType: '', devExpanded: false,
              };
              onNodeClick(tempNode);
            }
          });
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
