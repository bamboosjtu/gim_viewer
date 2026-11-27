import { mountPatrolOverlay } from './patrolOverlay.js';
import { toolGlyph } from './viewerToolIcons.js';
import { mountViewerToolbox } from './viewerToolbox.js';
import { logger } from '../utils/logger.js';
import type { AppState } from '../app/state.js';

export function setupSelectionToolbar(state: AppState): () => void {
  const viewport = document.getElementById('viewport');
  if (!viewport || document.getElementById('selection-toolbar')) return () => {};
  try {
    state.selection.autoLocate = localStorage.getItem('gim-auto-locate') !== '0';
  } catch {
    /* session preference */
  }
  const bar = document.createElement('div');
  bar.id = 'selection-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '模型浏览工具');
  const locate = document.createElement('button');
  locate.type = 'button';
  locate.id = 'btn-auto-locate';
  const refresh = () => {
    const label = `自动定位：${state.selection.autoLocate ? '开' : '关'}`;
    toolGlyph(locate, 'locate', label, label + ' · 从模型树或搜索定位');
    locate.setAttribute('aria-pressed', String(state.selection.autoLocate));
  };

  locate.addEventListener('click', () => {
    state.selection.autoLocate = !state.selection.autoLocate;
    try {
      localStorage.setItem('gim-auto-locate', state.selection.autoLocate ? '1' : '0');
    } catch {
      /* session preference */
    }
    refresh();
  });
  refresh();
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.id = 'btn-clear-selection';
  clear.textContent = '清除选择';
  toolGlyph(clear, 'clear', '清除选择', '清除选择并退出当前隔离（Esc）');
  const clearSelection = () => {
    void import('../services/selection/selectionCommands.js')
      .then(({ clearCurrentSelection }) => clearCurrentSelection(state))
      .catch((error) => logger.warn('[清除选择]', error));
  };
  clear.addEventListener('click', clearSelection);
  const toolbox = mountViewerToolbox(state, bar, viewport, [locate, clear]);
  const group = bar.querySelector<HTMLElement>('[data-group="view"] .viewer-ribbon-actions');
  const patrol =
    group && state.navigation ? mountPatrolOverlay(state.navigation, group, viewport) : null;
  viewport.append(bar);
  const refreshVisibility = () => {
    if (patrol) patrol.enter.hidden = state.currentProjectType !== 'substation';
    viewport.classList.toggle(
      'has-3d-tools',
      state.currentProjectType !== 'transmission_line' &&
        (!!state.currentProjectType || state.ifc.loadedModels.size > 0),
    );
  };
  const observer = new MutationObserver(refreshVisibility);
  observer.observe(viewport, { childList: true });
  const badge = document.getElementById('project-type-badge');
  if (badge) observer.observe(badge, { childList: true, subtree: true });
  state.viewerCommands.addEventListener('change', refreshVisibility);
  refreshVisibility();
  const escape = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      target?.closest('input,textarea,select,[contenteditable="true"]')
    )
      return;
    const menu = document.getElementById('more-menu');
    if (menu && !menu.hidden) return;
    if (state.viewerCommands.snapshot.tool === 'distance') {
      event.preventDefault();
      state.viewerCommands.dispatch({ kind: 'cancelPoint' });
      return;
    }
    if (state.selection.selectionRequest?.target || state.selection.onlySelected) {
      event.preventDefault();
      clearSelection();
    }
  };
  document.addEventListener('keydown', escape);
  return () => {
    observer.disconnect();
    patrol?.dispose();
    toolbox.dispose();
    state.viewerCommands.removeEventListener('change', refreshVisibility);
    document.removeEventListener('keydown', escape);
    bar.remove();
  };
}
