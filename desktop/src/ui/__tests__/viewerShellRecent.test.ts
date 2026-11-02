import { beforeEach, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import type { CacheResult, ProjectCacheSummary } from '../../services/projectCacheService.js';
const service = vi.hoisted(() => ({ recent: vi.fn(), open: vi.fn() }));
vi.mock('@desktop/runtime.js', () => ({ isTauri: () => true }));
vi.mock('../../services/projectCacheService.js', () => ({ readRecentProjects: service.recent }));
vi.mock('../../services/openGimService.js', () => ({ openGimProjectFromId: service.open }));
vi.mock('../../services/gimOpenCore.js', () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }));
const project = (id: number): ProjectCacheSummary => ({ id, name: `工程${id}`, path: `C:/source/${id}.gim`, projectType: 'substation',
  parserVersion: 'current', size: 1, updatedAt: 100, lastOpenedAt: 100 });
const success = (id: number): CacheResult<ProjectCacheSummary[]> => ({ ok: true, value: [project(id)] });
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); localStorage.clear();
  document.body.innerHTML = '<button id="btn-load-gim"></button><button id="btn-load-local"></button><button id="btn-cache-manager"></button><input id="gim-file-input" type="file"><button id="btn-more"></button><div id="more-menu" hidden><button id="menu-only-selected"></button><div id="menu-recent-projects"></div></div><div id="recent-projects"></div><button id="btn-welcome-continue"></button>';
  service.recent.mockResolvedValue({ ok: true, value: [] });
});
it('shows a failed recent read instead of an empty-history claim and disables continuing', async () => {
  service.recent.mockResolvedValue({ ok: false, message: '读取缓存项目失败：busy' });
  const { setupViewerShell } = await import('../shell/viewerShell.js'); setupViewerShell(new AppState());
  await vi.waitFor(() => expect(document.querySelector('#recent-projects')?.textContent).toContain('读取缓存项目失败'));
  expect(document.querySelector('#recent-projects')?.textContent).not.toContain('暂无最近工程');
  expect((document.getElementById('btn-welcome-continue') as HTMLButtonElement).disabled).toBe(true);
  expect(service.open).not.toHaveBeenCalled();
});
it('ignores a late listing and opens the current database project ID through the authorization-owning service', async () => {
  let resolve!: (value: CacheResult<ProjectCacheSummary[]>) => void;
  service.recent.mockReturnValueOnce(new Promise<CacheResult<ProjectCacheSummary[]>>(done => { resolve = done; })).mockResolvedValue(success(2));
  const state = new AppState(), { setupViewerShell } = await import('../shell/viewerShell.js'); setupViewerShell(state);
  document.getElementById('btn-more')!.click();
  await vi.waitFor(() => expect(document.getElementById('recent-projects')?.textContent).toContain('工程2'));
  resolve(success(1)); await Promise.resolve();
  expect(document.getElementById('recent-projects')?.textContent).not.toContain('工程1');
  document.getElementById('btn-welcome-continue')!.click();
  await vi.waitFor(() => expect(service.open).toHaveBeenCalledWith(state, expect.any(Function), 2));
  expect(service.open).toHaveBeenCalledTimes(1);
});
it('does not open a previously displayed entry if the continue refresh fails', async () => {
  service.recent.mockResolvedValue(success(2));
  const { setupViewerShell } = await import('../shell/viewerShell.js'); setupViewerShell(new AppState());
  await vi.waitFor(() => expect(document.getElementById('recent-projects')?.textContent).toContain('工程2'));
  service.recent.mockResolvedValue({ ok: false, message: '读取缓存项目失败：offline' });
  document.getElementById('btn-welcome-continue')!.click();
  await vi.waitFor(() => expect(document.getElementById('recent-projects')?.textContent).toContain('offline'));
  expect(service.open).not.toHaveBeenCalled();
});
it('hides global isolation for an engineering target without a current member range and rejects a stale action', async () => {
  const state = new AppState(); state.currentProjectType = 'substation'; state.beginSelection({ kind: 'engineering-group', key: 'declared-building' });
  const { setupViewerShell } = await import('../shell/viewerShell.js'); setupViewerShell(state);
  document.getElementById('btn-more')!.click();
  expect(document.getElementById('menu-only-selected')!.hidden).toBe(true);
  document.getElementById('menu-only-selected')!.click(); expect(state.onlySelected).toBe(false);
});
