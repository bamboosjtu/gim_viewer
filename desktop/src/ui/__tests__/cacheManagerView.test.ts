import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CacheResult, ProjectCacheSummary } from '../../services/projectCacheService.js';

const service = vi.hoisted(() => ({ list: vi.fn(), path: vi.fn(), check: vi.fn(), report: vi.fn(), remove: vi.fn() }));
vi.mock('../../services/projectCacheService.js', () => ({ readProjectCaches: service.list, readCacheDatabasePath: service.path,
  checkProjectCache: service.check, readCachedProjectReport: service.report, removeProjectCache: service.remove }));
const project = (id: number): ProjectCacheSummary => ({ id, name: `工程${id}`, path: `C:/source/${id}.gim`, projectType: 'equipment',
  parserVersion: 'current', size: 1, updatedAt: 100, lastOpenedAt: 100 });
const success = <T>(value: T): CacheResult<T> => ({ ok: true, value });
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); document.body.replaceChildren();
  service.list.mockResolvedValue(success([project(7)])); service.path.mockResolvedValue(success('current.db'));
  service.check.mockResolvedValue(success({ state: 'on-open', text: '独立设备缓存会在打开时校验' }));
});
afterEach(() => { vi.unstubAllGlobals(); });
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;

it('closes immediately while reads wait and keeps late replies from touching a reopened manager', async () => {
  const list = pending<CacheResult<ProjectCacheSummary[]>>(), path = pending<CacheResult<string>>();
  service.list.mockReturnValueOnce(list.promise); service.path.mockReturnValueOnce(path.promise);
  const { openCacheManager } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../cacheManagerView.js'); });
  const first = openCacheManager(); button('#cache-mgr-close').click();
  expect(document.getElementById('cache-manager-modal')).toBeNull();
  await openCacheManager(); expect(document.body.textContent).toContain('工程7');
  list.resolve(success([project(1)])); path.resolve(success('stale.db')); await first;
  expect(document.body.textContent).not.toContain('工程1'); expect(document.body.textContent).not.toContain('stale.db');
  expect(document.getElementById('cache-mgr-dbpath')?.textContent).toBe('current.db');
  button('#cache-mgr-done').click(); expect(document.getElementById('cache-manager-modal')).toBeNull();
});
it('keeps the newest refresh when an earlier listing returns later', async () => {
  const old = pending<CacheResult<ProjectCacheSummary[]>>(); service.list.mockReturnValueOnce(old.promise);
  const { openCacheManager } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../cacheManagerView.js'); }); const opening = openCacheManager();
  button('#cache-mgr-refresh').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('工程7'));
  old.resolve(success([project(1)])); await opening;
  expect(document.body.textContent).toContain('工程7'); expect(document.body.textContent).not.toContain('工程1');
});
it('shows service failures as text and distinguishes them from an empty cache', async () => {
  service.path.mockResolvedValue({ ok: false, message: '读取缓存位置失败' });
  service.list.mockResolvedValueOnce({ ok: false, message: '读取缓存项目失败：<script>busy</script>' });
  const { openCacheManager } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../cacheManagerView.js'); }); await openCacheManager();
  expect(document.body.textContent).toContain('读取缓存项目失败：<script>busy</script>');
  expect(document.querySelector('script')).toBeNull(); expect(document.body.textContent).not.toContain('暂无缓存项目');
  service.list.mockResolvedValue(success([])); button('#cache-mgr-refresh').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('暂无缓存项目'));
});
it('delegates validation by project ID and prevents duplicate requests while it waits', async () => {
  const check = pending<CacheResult<{ state: 'valid'; text: string }>>(); service.check.mockReturnValueOnce(check.promise);
  const { openCacheManager } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../cacheManagerView.js'); }); await openCacheManager();
  const target = button('.cache-mgr-validate'); target.click(); target.click();
  expect(target.disabled).toBe(true); expect(service.check).toHaveBeenCalledTimes(1); expect(service.check).toHaveBeenCalledWith(7);
  check.resolve(success({ state: 'valid', text: '缓存有效' }));
  await vi.waitFor(() => expect(target.disabled).toBe(false)); expect(document.body.textContent).toContain('缓存有效');
  service.check.mockResolvedValue({ ok: false, message: '校验缓存失败：busy' }); target.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('校验缓存失败：busy'));
  expect(target.disabled).toBe(false); expect(document.querySelector('.cache-badge')?.parentElement?.textContent).toContain('设备');
});
it('requires the existing delete decision and keeps a failed deletion retryable without issuing duplicates', async () => {
  const decision = vi.fn(() => false); vi.stubGlobal('confirm', decision);
  const { openCacheManager } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../cacheManagerView.js'); }); await openCacheManager();
  const target = button('.cache-mgr-delete'); target.click(); expect(service.remove).not.toHaveBeenCalled();
  const removal = pending<CacheResult<void>>(); service.remove.mockReturnValueOnce(removal.promise); decision.mockReturnValue(true);
  target.click(); target.click(); expect(service.remove).toHaveBeenCalledTimes(1); expect(service.remove).toHaveBeenCalledWith(7);
  removal.resolve({ ok: false, message: '删除缓存失败：locked' });
  await vi.waitFor(() => expect(target.disabled).toBe(false));
  expect(target.textContent).toBe('删除失败'); expect(target.title).toContain('locked');
});
