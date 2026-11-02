import type { AppState } from '../app/state.js';

export function setupSelectionToolbar(state: AppState): () => void {
  const viewport = document.getElementById('viewport');
  if (!viewport || document.getElementById('selection-toolbar')) return () => {};
  try { state.autoLocate = localStorage.getItem('gim-auto-locate') !== '0'; } catch { /* session preference */ }
  const bar = document.createElement('div'); bar.id = 'selection-toolbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '模型浏览工具');
  bar.style.cssText = 'position:absolute;left:12px;top:12px;z-index:5;display:flex;gap:6px;padding:6px;border:1px solid #475569;border-radius:6px;background:#0f172aeb;color:#e2e8f0';
  const locate = document.createElement('button'); locate.type = 'button'; locate.id = 'btn-auto-locate';
  const refresh = () => { locate.textContent = `自动定位：${state.autoLocate ? '开' : '关'}`; locate.setAttribute('aria-pressed', String(state.autoLocate)); };
  locate.title = '控制在模型树或搜索中选择对象时是否定位；三维单击始终只选择。';
  locate.addEventListener('click', () => { state.autoLocate = !state.autoLocate; try { localStorage.setItem('gim-auto-locate', state.autoLocate ? '1' : '0'); } catch { /* session preference */ } refresh(); });
  refresh();
  const clear = document.createElement('button'); clear.type = 'button'; clear.id = 'btn-clear-selection'; clear.textContent = '清除选择'; clear.title = '清除选择并恢复隔离显示（Esc）';
  const clearSelection = () => { void import('../services/selectionCommands.js').then(({ clearCurrentSelection }) => clearCurrentSelection(state)).catch(error => console.warn('[清除选择]', error)); };
  clear.addEventListener('click', clearSelection);
  for (const button of [locate, clear]) button.style.cssText = 'padding:5px 9px;color:inherit;background:#1e293b;border:1px solid #64748b;border-radius:4px;cursor:pointer';
  bar.append(locate, clear); viewport.append(bar);
  const refreshVisibility = () => { bar.style.display = state.currentProjectType === 'transmission_line' ? 'none' : 'flex'; };
  const observer = new MutationObserver(refreshVisibility);
  observer.observe(viewport, { childList: true });
  const badge = document.getElementById('project-type-badge'); if (badge) observer.observe(badge, { childList: true, subtree: true });
  refreshVisibility();
  const escape = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.key !== 'Escape' || event.defaultPrevented || target?.closest('input,textarea,select,[contenteditable="true"]')) return;
    const menu = document.getElementById('more-menu'); if (menu && !menu.hidden) return;
    if (state.selectionRequest?.target || state.onlySelected) { event.preventDefault(); clearSelection(); }
  };
  document.addEventListener('keydown', escape);
  return () => { observer.disconnect(); document.removeEventListener('keydown', escape); bar.remove(); };
}
