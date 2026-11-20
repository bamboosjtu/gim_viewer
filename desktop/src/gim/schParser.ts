/**
 * Desktop SCH entry: file discovery stays here; the index grammar lives in
 * the gim-sdk parser layer.
 */
import { parseSch, type SchEntry } from '@gim/gim-sdk/parser';
import { getFileEntryIndex, getFileEntryResolver } from './entryResolver.js';
import { SourceConflictError } from './sourceDocument.js';

export { parseSch, type SchEntry, type SchEntryType } from '@gim/gim-sdk/parser';

/**
 * 从 GIM 解压文件集合发现 SCH 条目。
 *
 * 约定：SCH 入口固定为 `CBM/project.sch`，但 GIM 文件解压后路径大小写可能不同
 * （`Cbm/project.sch` / `cbm/project.sch`），按候选大小写顺序尝试。
 * 若不存在则返回空数组（说明该工程不含 STD/SLD 拓扑/单线图）。
 */
export async function discoverStdSldFromSCH(files: Map<string, File>): Promise<SchEntry[]> {
  const resolve = getFileEntryResolver(files),
    candidates = getFileEntryIndex(files).candidates('project.sch');
  if (candidates.length > 1)
    throw new SourceConflictError([
      {
        kind: 'ambiguous-field',
        path: '',
        field: 'project.sch',
        lines: [],
        values: [...candidates],
      },
    ]);
  const path = candidates[0];
  if (!path) return [];
  const file = files.get(path);
  if (!file) return [];
  const entries = parseSch(await file.text(), path);
  return entries.map((entry) => ({ ...entry, path: resolve(entry.filename, path) ?? entry.path }));
}
