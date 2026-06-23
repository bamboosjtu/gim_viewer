import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { fileDevPanel } from './dom.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';
import { showNodeProperties, openPropsDrawer } from './propsDrawer.js';
import { highlightIfcFromNode } from '../viewer/highlight.js';

const ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️', F2System: '🏢', F3System: '⚡', F4System: '🔧', PARTINDEX: '🔩',
};

/** 渲染文件-设备面板 */
export function renderFileDevPanel(
  ctx: ViewerContext,
  state: AppState,
  showMessage: (text: string) => void,
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
              showNodeProperties(ctx, state, devNode);
              highlightIfcFromNode(ctx, state, devNode, showMessage);
            } else {
              const tempNode: CbmNode = {
                path: `CBM/${devCbm}`, name: devCbm.replace(/\.cbm$/i, ''),
                entityName: '', children: [], famPath: '', devPath: '',
                ifcFile: '', ifcGuid: '', classifyName: '', transformMatrix: '',
              };
              showNodeProperties(ctx, state, tempNode);
              highlightIfcFromNode(ctx, state, tempNode, showMessage);
            }
            openPropsDrawer(ctx);
          });
          childrenEl.appendChild(devRow);
        }
        childrenRendered = true;
      }
    });
    fileDevPanel.appendChild(nodeEl);
  }
}
