import type { AppState } from '../../../app/state.js';
import type { CbmNode } from '../../../gim/types.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import { logger } from '../../../utils/logger.js';

export function createEquipmentSelection(
  state: AppState,
  scope: SessionScope,
  showMessage: (text: string) => void,
): (node: CbmNode) => void {
  return (node) => {
    if (!scope.isCurrent()) return;
    const request = state.selection.beginSelection({ kind: 'cbm', key: node.path });
    const current = () => scope.isCurrent() && state.selection.isCurrentSelection(request);
    void import('../../../services/nodeInteractionService.js')
      .then(({ handleNodeClick }) => {
        if (current()) return handleNodeClick(state, node, showMessage, request);
      })
      .catch((error) => {
        if (current()) logger.warn('[选择] 设备节点交互失败:', error);
      });
  };
}
