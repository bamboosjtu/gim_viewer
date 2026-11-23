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
    locate.textContent = `自动定位：${state.selection.autoLocate ? '开' : '关'}`;
    locate.setAttribute('aria-pressed', String(state.selection.autoLocate));
  };
  locate.title = '控制在模型树或搜索中选择对象时是否定位；三维单击始终只选择。';
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
  clear.title = '清除选择并恢复隔离显示（Esc）';
  const clearSelection = () => {
    void import('../services/selection/selectionCommands.js')
      .then(({ clearCurrentSelection }) => clearCurrentSelection(state))
      .catch((error) => logger.warn('[清除选择]', error));
  };
  clear.addEventListener('click', clearSelection);
  bar.append(locate, clear);
  viewport.append(bar);
  const refreshVisibility = () => {
    bar.style.display = state.currentProjectType === 'transmission_line' ? 'none' : 'flex';
  };
  const observer = new MutationObserver(refreshVisibility);
  observer.observe(viewport, { childList: true });
  const badge = document.getElementById('project-type-badge');
  if (badge) observer.observe(badge, { childList: true, subtree: true });
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
    if (state.selection.selectionRequest?.target || state.selection.onlySelected) {
      event.preventDefault();
      clearSelection();
    }
  };
  document.addEventListener('keydown', escape);
  return () => {
    observer.disconnect();
    document.removeEventListener('keydown', escape);
    bar.remove();
  };
}
