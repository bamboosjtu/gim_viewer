import { beforeEach, expect, it, vi } from 'vitest';
import { readProjectCaches, readRecentProjects, readCacheDatabasePath, checkProjectCache,
  readCachedProjectReport, removeProjectCache } from '../projectCacheService.js';

const io = vi.hoisted(() => ({ native: true, list: vi.fn(), path: vi.fn(), validate: vi.fn(), report: vi.fn(), remove: vi.fn() }));
vi.mock('@desktop/runtime.js', () => ({ isTauri: () => io.native }));
vi.mock('@desktop/database.js', () => ({ listCachedProjects: io.list, getDbPath: io.path,
  validateGimCache: io.validate, getProjectDiagnostic: io.report, deleteProjectCache: io.remove }));
vi.mock('../../config/debug.js', () => ({ getDebugConfigSnapshot: () => ({ enabled: false }) }));
const project = (id: number, type: string | null = 'substation', path = `C:/sources/${id}.gim`) => ({
  id, name: '', path, project_type: type, parser_version: 'current', size: 2048, modified_ms: 10, updated_at_ms: 20, last_opened_at_ms: 30,
});
beforeEach(() => { vi.resetAllMocks(); io.native = true; io.list.mockResolvedValue([]); });

it('keeps the database order and exact source paths while deriving six GIM recent entries', async () => {
  const rows = [project(1, null, 'C:/sources/model.ifc'), ...Array.from({ length: 8 }, (_, i) => project(i + 2, 'substation', `C:\\sources\\${i + 2}.GIM`))];
  io.list.mockResolvedValue(rows);
  const result = await readRecentProjects(); expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.message);
  expect(result.value.map(row => row.id)).toEqual([2, 3, 4, 5, 6, 7]);
  expect(result.value[0]).toMatchObject({ name: '2.GIM', path: rows[1].path, lastOpenedAt: 30 });
  expect(io.validate).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
});
it('distinguishes an unavailable cache from a genuinely empty recent list and maps native read failures', async () => {
  io.list.mockRejectedValue(Error('database busy'));
  expect(await readRecentProjects()).toEqual({ ok: false, message: '读取缓存项目失败：database busy' });
  io.list.mockResolvedValue([]); expect(await readRecentProjects()).toEqual({ ok: true, value: [] });
  io.path.mockRejectedValue('offline'); expect(await readCacheDatabasePath()).toEqual({ ok: false, message: '读取缓存位置失败：offline' });
});
it('does not invoke native persistence in browser mode', async () => {
  io.native = false;
  expect(await readRecentProjects()).toEqual({ ok: true, value: [] });
  expect((await readProjectCaches()).ok).toBe(false);
  expect((await removeProjectCache(1)).ok).toBe(false);
  expect(io.list).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
});
it('selects the validation domain from current database facts and preserves standalone equipment semantics', async () => {
  io.validate.mockResolvedValue({ valid: true, cached_ifc_count: 2, ifc_entry_count: 2 });
  for (const type of ['transmission_line', 'substation']) {
    io.list.mockResolvedValue([project(7, type)]);
    expect(await checkProjectCache(7)).toEqual({ ok: true, value: { state: 'valid', text: '缓存有效 · IFC 2/2' } });
    expect(io.validate).toHaveBeenLastCalledWith(7, type);
  }
  io.validate.mockClear(); io.list.mockResolvedValue([project(7, 'equipment')]);
  expect(await checkProjectCache(7)).toEqual({ ok: true, value: { state: 'on-open', text: '独立设备缓存会在打开时校验' } });
  io.list.mockResolvedValue([project(7, null)]); expect((await checkProjectCache(7))).toMatchObject({ ok: true, value: { state: 'rebuild' } });
  expect(io.validate).not.toHaveBeenCalled();
  io.list.mockResolvedValue([]); expect(await checkProjectCache(7)).toMatchObject({ ok: false, message: expect.stringContaining('已不存在') });
});
it('rejects invalid project IDs before any database access and keeps failures as results', async () => {
  for (const id of [0, -1, 1.5, NaN, Infinity]) {
    expect((await checkProjectCache(id)).ok).toBe(false);
    expect((await readCachedProjectReport(id, 'json')).ok).toBe(false);
    expect((await removeProjectCache(id)).ok).toBe(false);
  }
  expect(io.list).not.toHaveBeenCalled(); expect(io.report).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
  io.remove.mockRejectedValue(Error('locked')); expect(await removeProjectCache(2)).toEqual({ ok: false, message: '删除缓存失败：locked' });
});
it('builds diagnostic payloads in the service without triggering validation or changing the cache', async () => {
  const diagnostic = { project_type: 'substation', valid: true, current_parser_version: 'current' };
  io.report.mockResolvedValue(diagnostic);
  const json = await readCachedProjectReport(5, 'json'), text = await readCachedProjectReport(5, 'summary');
  expect(json.ok && JSON.parse(json.value)).toEqual({ projectId: 5, diagnostic, debug: { enabled: false } });
  expect(text.ok && text.value).toContain('工程类型：substation');
  expect(io.validate).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
});
