import type { AppState } from '../../app/state.js';
import { btnCacheManager, btnLoadGim, btnLoadLocal, gimFileInput } from '../dom.js';
import { isTauri } from '@desktop/runtime.js';
import { hideLoading, showLoading } from '../../services/gimOpenCore.js';
import { escapeHtml } from '../../shared/html.js';

const AUTO_OPEN_LAST_KEY = 'gim-auto-open-last';
const AUTO_SHOW_PROPS_KEY = 'gim-auto-show-props';

export function shouldAutoOpenLastProject(): boolean {
  try { return localStorage.getItem(AUTO_OPEN_LAST_KEY) === '1'; } catch { return false; }
}

export function shouldAutoShowProps(): boolean {
  try { return localStorage.getItem(AUTO_SHOW_PROPS_KEY) !== '0'; } catch { return true; }
}

interface RecentProject { id: number; name: string; path: string; projectType: string | null; parserVersion: string | null; updatedAt: number; }

function formatRelativeTime(ms: number): string {
  if (!ms) return '';
  const delta = Date.now() - ms;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

function writeSetting(key: string, enabled: boolean): void {
  try { localStorage.setItem(key, enabled ? '1' : '0'); } catch { /* ignore */ }
}

async function loadRecentProjects(): Promise<RecentProject[]> {
  if (!isTauri()) return [];
  try {
    const { listCachedProjects } = await import('@desktop/database.js');
    const projects = await listCachedProjects();
    return projects
      .filter((project) => /\.gim$/i.test(project.path))
      .slice(0, 6)
      .map((project) => ({
        id: project.id,
        name: project.name || project.path.split(/[\\/]/).pop() || project.path,
        path: project.path,
        projectType: project.project_type,
        parserVersion: project.parser_version,
        updatedAt: project.updated_at_ms,
      }));
  } catch (error) {
    console.warn('[ViewerShell] recent projects unavailable:', error);
    return [];
  }
}

async function openRecentProject(state: AppState, projectId: number): Promise<void> {
  try {
    showLoading('正在打开最近工程...');
    const { openGimProjectFromId } = await import('../../services/openGimService.js');
    await openGimProjectFromId(state, (text) => showLoading(text), projectId);
  } catch (error) {
    console.error('[ViewerShell] open recent project failed:', error);
    showLoading(`打开最近工程失败: ${error instanceof Error ? error.message : String(error)}`);
    setTimeout(hideLoading, 3000);
  }
}

function renderRecentList(
  targets: HTMLElement[],
  projects: RecentProject[],
  state: AppState,
): void {
  for (const target of targets) {
    target.replaceChildren();
    if (projects.length === 0) {
      const empty = document.createElement('div');
      empty.className = target.id === 'menu-recent-projects' ? 'menu-recent-empty' : 'recent-empty';
      empty.textContent = '暂无最近工程';
      target.appendChild(empty);
      continue;
    }
    for (const project of projects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = target.id === 'menu-recent-projects' ? '' : 'recent-project';
      const typeLabel = project.projectType === 'transmission_line' ? '线路' : '变电';
      const ago = formatRelativeTime(project.updatedAt);
      const meta = ago ? `${typeLabel} · ${ago}` : typeLabel;
      if (target.id === 'menu-recent-projects') {
        button.textContent = project.name;
        button.title = project.path;
      } else {
        button.innerHTML = `<span class="name">${escapeHtml(project.name)}</span><span class="meta">${escapeHtml(meta)}</span>`;
        button.title = project.path;
      }
      button.addEventListener('click', () => { void openRecentProject(state, project.id); });
      target.appendChild(button);
    }
  }
}

export function setupViewerShell(state: AppState): void {
  const moreButton = document.getElementById('btn-more') as HTMLButtonElement | null;
  const menu = document.getElementById('more-menu') as HTMLElement | null;
  const menuRecent = document.getElementById('menu-recent-projects') as HTMLElement | null;
  const welcomeRecent = document.getElementById('recent-projects') as HTMLElement | null;
  const continueButton = document.getElementById('btn-welcome-continue') as HTMLButtonElement | null;
  const welcomeOpen = document.getElementById('btn-welcome-open') as HTMLButtonElement | null;
  const autoOpenInput = document.getElementById('menu-auto-open-last') as HTMLInputElement | null;
  const autoPropsInput = document.getElementById('menu-show-props') as HTMLInputElement | null;
  let recent: RecentProject[] = [];
  let autoOpenAttempted = false;

  const closeMenu = (): void => {
    if (!menu || !moreButton) return;
    menu.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
  };
  const refreshRecent = async (): Promise<void> => {
    recent = await loadRecentProjects();
    renderRecentList([menuRecent, welcomeRecent].filter((node): node is HTMLElement => !!node), recent, state);
    if (continueButton) {
      continueButton.disabled = recent.length === 0;
      continueButton.title = recent[0]?.path ?? '暂无最近工程';
    }
  };

  if (autoOpenInput) autoOpenInput.checked = shouldAutoOpenLastProject();
  if (autoPropsInput) autoPropsInput.checked = shouldAutoShowProps();
  autoOpenInput?.addEventListener('change', () => {
    writeSetting(AUTO_OPEN_LAST_KEY, autoOpenInput.checked);
  });
  autoPropsInput?.addEventListener('change', () => {
    writeSetting(AUTO_SHOW_PROPS_KEY, autoPropsInput.checked);
  });

  if (moreButton && menu) {
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = menu.hidden;
      menu.hidden = !opening;
      moreButton.setAttribute('aria-expanded', String(opening));
      if (opening) {
        const ifcItem = document.getElementById('menu-ifc-detail');
        if (ifcItem) ifcItem.hidden = state.currentProjectType === 'transmission_line';
        const cacheItem = document.getElementById('menu-cache');
        if (cacheItem) cacheItem.hidden = !isTauri();
        const settingsItem = document.getElementById('menu-settings');
        if (settingsItem) settingsItem.hidden = !isTauri();
        void refreshRecent();
      }
    });
    menu.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', closeMenu);
  }

  document.getElementById('menu-attach-ifc')?.addEventListener('click', () => {
    closeMenu(); btnLoadLocal.click();
  });
  document.getElementById('menu-cache')?.addEventListener('click', () => {
    closeMenu(); btnCacheManager.click();
  });
  document.getElementById('menu-ifc-detail')?.addEventListener('click', () => {
    closeMenu();
    void import('../ifcDetailPanel.js').then(({ openIfcDetailPanel }) => openIfcDetailPanel());
  });
  document.getElementById('menu-settings')?.addEventListener('click', () => {
    closeMenu();
    void import('../settingsPanel.js').then(({ openSettingsPanel }) => openSettingsPanel());
  });
  welcomeOpen?.addEventListener('click', () => btnLoadGim.click());
  continueButton?.addEventListener('click', () => {
    const first = recent[0];
    if (first) void openRecentProject(state, first.id);
  });

  // Browser drop: a File has no persistent path, but the one-shot input path
  // already owns browser-mode opening. Desktop drag-drop is intentionally not
  // wired because arbitrary page-provided paths are outside the file grant.
  if (!isTauri()) {
    const viewport = document.getElementById('viewport');
    viewport?.addEventListener('dragover', (event) => { event.preventDefault(); });
    viewport?.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = Array.from(event.dataTransfer?.files ?? []).find((item) => /\.gim$/i.test(item.name));
      if (!file) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      gimFileInput.files = transfer.files;
      gimFileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  void refreshRecent().then(() => {
    if (!shouldAutoOpenLastProject() || autoOpenAttempted) return;
    autoOpenAttempted = true;
    const first = recent.find((project) => project.parserVersion);
    if (first && state.currentProjectType == null) {
      void openRecentProject(state, first.id);
    }
  });
}
