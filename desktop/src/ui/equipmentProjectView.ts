import type { AppState } from '../app/state.js';
import type { EquipmentPresentationPort } from '../features/equipment/presentation/equipmentPresentationPort.js';
import { cbmTreePanel, emptyTipEl } from './dom.js';
import { renderCbmTreeUI, selectCbmTreeRow } from './cbmTreeView.js';
import { renderSearchBox } from './searchBox.js';
import { setProjectIdentity, refreshNavigatorTitle } from './shell/projectBar.js';
import { setIfcStatus } from './shell/statusBar.js';
import { getNodeDisplayName } from '../shared/displayName.js';

export function createEquipmentProjectPresentation(state: AppState): EquipmentPresentationPort {
  return {
    navigation({ name, tree, onSelect, signal }) {
      if (signal.aborted) return () => {};
      setProjectIdentity(name, 'equipment');
      refreshNavigatorTitle();
      setIfcStatus('');
      const host = document.createElement('div');
      cbmTreePanel.replaceChildren(host);
      const nodes = new Map<string, typeof tree>();
      const visit = (node: typeof tree) => {
        nodes.set(node.path, node);
        node.children.forEach(visit);
      };
      visit(tree);
      const view = new AbortController();
      const select = (node: typeof tree) => {
        if (!signal.aborted && !view.signal.aborted) onSelect(node);
      };
      let search: ReturnType<typeof renderSearchBox> | undefined;
      const dispose = () => {
        if (view.signal.aborted) return;
        view.abort();
        signal.removeEventListener('abort', dispose);
        search?.destroy();
        nodes.clear();
        host.remove();
      };
      signal.addEventListener('abort', dispose, { once: true });
      try {
        search = renderSearchBox(
          host,
          [...nodes].map(([key, node]) => ({
            key,
            title: getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries),
            subtitle: node.entityName,
          })),
          (key) => {
            const node = nodes.get(key);
            if (node) {
              select(node);
              selectCbmTreeRow(key);
            }
          },
        );
        renderCbmTreeUI(state, tree, host, select, view.signal);
        if (emptyTipEl) emptyTipEl.style.display = 'none';
        if (signal.aborted) dispose();
        return dispose;
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
