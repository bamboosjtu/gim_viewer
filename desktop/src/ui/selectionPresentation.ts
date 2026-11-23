import type { SelectionPresentation } from '../services/presentation/selectionPresentationPort.js';
import { beginSelectionStage } from '../services/selection/selectionTiming.js';
let navigation:
  Promise<[typeof import('./cbmTreeView.js'), typeof import('./sldView.js')]> | undefined;
export const selectionPresentation: SelectionPresentation = {
  async nodeInspector(state, request) {
    const props = await import('./propsDrawer.js');
    return {
      async show(node, ctx) {
        if (!state.selection.isCurrentSelection(request)) return;
        if (ctx) {
          await props.showNodeProperties(ctx, state, node, request);
          if (state.selection.isCurrentSelection(request)) props.openPropsDrawer(ctx);
        } else {
          props.openPropsDrawerUI();
          await props.showNodePropertiesBasic(state, node, request);
        }
      },
    };
  },
  async syncNavigation(state, request, lookup) {
    const endImports = beginSelectionStage(state, request, 'navigation.imports');
    let views: [typeof import('./cbmTreeView.js'), typeof import('./sldView.js')],
      resolve: () => string | null;
    try {
      navigation ??= Promise.all([import('./cbmTreeView.js'), import('./sldView.js')]).catch(
        (error) => {
          navigation = undefined;
          throw error;
        },
      );
      [views, resolve] = await Promise.all([navigation, lookup()]);
    } finally {
      endImports();
    }
    if (!state.selection.isCurrentSelection(request)) return;
    const endTree = beginSelectionStage(state, request, 'navigation.tree');
    try {
      views[0].syncSelectedTreeRow(state);
    } finally {
      endTree();
    }
    const endLookup = beginSelectionStage(state, request, 'navigation.sldLookup');
    let gridId: string | null;
    try {
      gridId = resolve();
    } finally {
      endLookup();
    }
    const endSld = beginSelectionStage(state, request, 'navigation.sldCommit');
    try {
      views[1].highlightSldByGridId(gridId);
    } finally {
      endSld();
    }
  },
  async chooseSources(message, choices, current) {
    const view = await import('./selectionSources.js');
    if (current()) view.showSelectionSources(message, choices, current);
  },
  async unlinkedDiagram(state, gridId, request) {
    const props = await import('./propsDrawer.js');
    if (state.selection.isCurrentSelection(request))
      props.showUnlinkedSldProperties(state, gridId, request);
  },
  async sourceTree(state, current) {
    const tree = await import('./engineeringTreeView.js');
    if (!current()) return;
    state.viewState.mode = 'source';
    tree.renderEngineeringTree(state);
    tree.syncEngineeringTreeSelection(state);
  },
  async engineeringTree(state, sourceId, current) {
    const tree = await import('./engineeringTreeView.js');
    if (!current()) return;
    if (sourceId) tree.revealEngineeringSource(state, sourceId);
    else tree.syncEngineeringTreeSelection(state);
  },
  async refreshEngineeringTree(state, current) {
    const tree = await import('./engineeringTreeView.js');
    if (current()) tree.renderEngineeringTree(state);
  },
  async engineeringInspector(model, current) {
    const view = await import('./engineeringInspector.js');
    if (current()) view.renderEngineeringInspector(model);
  },
  async projectionChanged(message, current) {
    const { renderInspectorTabs, sectionHtml } = await import('./propsDrawer.js');
    if (!current()) return;
    renderInspectorTabs('<div class="props-header">工程分组已更新</div>', {
      overview: sectionHtml('选择范围', [['状态', message]]),
      params: '',
      relations: '',
      source: '',
    });
  },
};
