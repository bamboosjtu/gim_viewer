import type { ProjectPresentation } from '../services/projectPresentationPort.js';
import { setSelectionStatus } from './shell/statusBar.js';
import { escHtml } from '../shared/html.js';

export const projectPresentation: ProjectPresentation = {
  async refreshDeviceBounds(state, current) {
    const view = await import('./deviceBoundsMarker.js');
    if (current()) view.refreshDeviceBoundsMarkers(state);
  },
  hideEmptyState() {
    const tip = document.getElementById('empty-tip');
    if (tip) tip.style.display = 'none';
  },
  expandedTreePaths() {
    return [
      ...document.querySelectorAll<HTMLElement>('#cbm-tree-panel .tree-toggle.expanded'),
    ].flatMap((toggle) => {
      const path = toggle.closest<HTMLElement>('.tree-row')?.dataset.nodePath;
      return path ? [path] : [];
    });
  },
  async restoreExpandedTree(paths, current) {
    const tree = await import('./cbmTreeView.js');
    if (current()) await tree.expandTreeToPaths(paths, current);
  },
  removeModelRows(ids) {
    for (const id of ids) document.getElementById(`model-${id}`)?.remove();
  },
  async renderNavigation(state, select, current) {
    const [tree, files] = await Promise.all([
      import('./cbmTreeView.js'),
      import('./fileDevView.js'),
    ]);
    if (!current()) return;
    tree.buildAndRenderCbmTree(state, select);
    files.renderFileDevPanel(state, select);
    const tip = document.getElementById('empty-tip');
    if (tip) tip.style.display = 'none';
  },
  async resetIdentity(current) {
    const bar = await import('./shell/projectBar.js');
    if (!current()) return;
    bar.setProjectIdentity(null, null);
    bar.refreshNavigatorTitle();
  },
  async clearProjectViews(current) {
    const [sld, tabs] = await Promise.all([import('./sldView.js'), import('./tabs.js')]);
    if (!current()) return;
    for (const id of ['model-list', 'cbm-tree-panel', 'file-dev-panel', 'sld-panel'])
      document.getElementById(id)?.replaceChildren();
    const body = document.getElementById('props-drawer-body');
    if (body) body.innerHTML = '<div class="props-empty">选择层级树节点查看属性</div>';
    const tip = document.getElementById('empty-tip');
    if (tip) tip.style.display = '';
    sld.clearSldView();
    tabs.showAllTabs();
  },
  clearSelection() {
    const body = document.getElementById('props-drawer-body');
    if (body) body.innerHTML = '<div class="props-empty">尚未选择对象</div>';
    setSelectionStatus(null);
  },
  geometryFeedback(detail, fitWhole) {
    const note = document.querySelector('[data-engineering-geometry-note]');
    if (note) note.textContent = detail;
    if (fitWhole) {
      const button = document.getElementById('engineering-fit');
      if (button) button.textContent = '定位整件';
    }
  },
  async chooseEngineeringRange(detail, choices, current) {
    const { openPropsDrawerUI, renderInspectorTabs, sectionHtml } =
      await import('./propsDrawer.js');
    if (!current()) return;
    openPropsDrawerUI();
    renderInspectorTabs('<div class="props-header">选择范围待确认</div>', {
      overview:
        sectionHtml('范围变化', [['状态', detail]]) +
        choices
          .map(
            (choice, i) =>
              `<button class="prop-ref-link" data-engineering-choice="${i}">${escHtml(choice.label)}</button>`,
          )
          .join(''),
      params: '',
      relations: '',
      source: '',
    });
    document.querySelectorAll<HTMLElement>('[data-engineering-choice]').forEach((button) =>
      button.addEventListener('click', () => {
        if (current()) choices[Number(button.dataset.engineeringChoice)]?.choose();
      }),
    );
  },
};
