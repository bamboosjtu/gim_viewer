import { isTauri } from '@desktop/runtime.js';
import type { CachedProjectSummary } from '@desktop/database.js';
import { summarizeDiagnostic } from '../shared/diagnosticSummary.js';
import { getDebugConfigSnapshot } from '../config/debug.js';

export type CacheResult<T> = { ok: true; value: T } | { ok: false; message: string };
export interface ProjectCacheSummary {
  id: number;
  name: string;
  path: string;
  projectType: string | null;
  parserVersion: string | null;
  size: number;
  updatedAt: number;
  lastOpenedAt: number;
}
export interface CacheValidationSummary {
  state: 'valid' | 'rebuild' | 'on-open';
  text: string;
}
type Database = typeof import('@desktop/database.js');
const fail = (message: string): CacheResult<never> => ({ ok: false, message });
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;

/** Services own persistence access and map failures to UI-consumable results.
 * No path from these summaries authorizes opening a source: opening still uses
 * openGimProjectFromId and the native database-backed authorization command. */
async function cacheOperation<T>(action: string, operation: (database: Database) => Promise<T>): Promise<CacheResult<T>> {
  if (!isTauri()) return fail('本地缓存仅在桌面版可用');
  try { return { ok: true, value: await operation(await import('@desktop/database.js')) }; }
  catch (error) { return fail(`${action}失败：${error instanceof Error ? error.message : String(error)}`); }
}
function summary(row: CachedProjectSummary): ProjectCacheSummary {
  return { id: row.id, name: row.name || row.path.split(/[\\/]/).pop() || row.path,
    path: row.path, projectType: row.project_type, parserVersion: row.parser_version,
    size: row.size, updatedAt: row.updated_at_ms, lastOpenedAt: row.last_opened_at_ms || row.updated_at_ms };
}
export function readProjectCaches(): Promise<CacheResult<ProjectCacheSummary[]>> {
  return cacheOperation('读取缓存项目', async database => (await database.listCachedProjects()).map(summary));
}
export async function readRecentProjects(): Promise<CacheResult<ProjectCacheSummary[]>> {
  if (!isTauri()) return { ok: true, value: [] };
  const result = await readProjectCaches();
  return result.ok ? { ok: true, value: result.value.filter(project => /\.gim$/i.test(project.path)).slice(0, 6) } : result;
}
export function readCacheDatabasePath(): Promise<CacheResult<string>> {
  return cacheOperation('读取缓存位置', database => database.getDbPath());
}
export async function checkProjectCache(projectId: number): Promise<CacheResult<CacheValidationSummary>> {
  if (!validId(projectId)) return fail('工程记录无效');
  return cacheOperation<CacheValidationSummary>('校验缓存', async database => {
    const project = (await database.listCachedProjects()).find(project => project.id === projectId);
    if (!project) throw Error('工程记录已不存在，请刷新列表');
    if (project.project_type === 'equipment') return { state: 'on-open', text: '独立设备缓存会在打开时校验' };
    if (project.project_type !== 'substation' && project.project_type !== 'transmission_line')
      return { state: 'rebuild', text: '工程信息尚未就绪，请重新打开工程' };
    const result = await database.validateGimCache(projectId, project.project_type);
    return result.valid ? { state: 'valid', text: `缓存有效 · IFC ${result.cached_ifc_count}/${result.ifc_entry_count}` }
      : { state: 'rebuild', text: `缓存需重建 · ${result.cache_miss_reason ?? '工程缓存未完成'}` };
  });
}
export async function readCachedProjectReport(projectId: number, format: 'json' | 'summary'): Promise<CacheResult<string>> {
  if (!validId(projectId)) return fail('工程记录无效');
  return cacheOperation('读取缓存诊断', async database => {
    const diagnostic = await database.getProjectDiagnostic(projectId);
    return format === 'json' ? JSON.stringify({ projectId, diagnostic, debug: getDebugConfigSnapshot() }, null, 2)
      : summarizeDiagnostic({ diagnostic });
  });
}
export async function removeProjectCache(projectId: number): Promise<CacheResult<void>> {
  if (!validId(projectId)) return fail('工程记录无效');
  return cacheOperation('删除缓存', async database => { await database.deleteProjectCache(projectId); });
}
