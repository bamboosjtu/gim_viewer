/**
 * SCH（原理图索引）解析器。
 *
 * GIM 工程中 `CBM/project.sch` 与 `CBM/project.cbm` 平级，是 STD/SLD 入口：
 *
 * ```text
 * SCH.NUM=2
 * SCH0=zjx.std
 * SCH1=zjx.sld
 * ```
 *
 * - `SCH.NUM`：条目总数
 * - `SCHi`：第 i 个条目文件名（相对 CBM/ 目录）
 *
 * 文件类型由后缀推断：`.std` → STD（拓扑定义），`.sld` → SLD（电气单线图 SVG）。
 *
 * 关联文档：docs/schema/logical-model.md
 */

import {parseKeyValue,keyValueDiagnostics} from './kvParser.js';
import {SourceConflictError} from './sourceDocument.js';
import {getFileEntryResolver,getFileEntryIndex} from './entryResolver.js';
import { parseBoundedCount } from './parserLimits.js';

/** SCH 条目类型 */
export type SchEntryType = 'std' | 'sld' | 'unknown';

/** SCH 单条条目 */
export interface SchEntry {
  /** 在 SCH 文件中的索引（0-based） */
  index: number;
  /** 文件名（如 `zjx.std`） */
  filename: string;
  /** 在 GIM 解压文件集合中的路径（如 `CBM/zjx.std`） */
  path: string;
  /** 条目类型（按后缀推断） */
  type: SchEntryType;
  /** 去后缀的名称（如 `zjx`） */
  name: string;
}

/**
 * 解析 SCH 文件文本。
 *
 * 复用 `parseKeyValue`（来自 `cbmParser.ts`），按 `SCH.NUM` / `SCHi` 模式解析。
 *
 * @param text SCH 文件原始文本
 * @returns 条目列表（按 index 升序）。若 NUM 缺失或为 0，返回空数组。
 */
export function parseSch(text: string,sourcePath='CBM/project.sch'): SchEntry[] {
  const kv = parseKeyValue(text,sourcePath);
  const conflicts=keyValueDiagnostics(kv);if(conflicts.length)throw new SourceConflictError(conflicts);
  const num = parseBoundedCount(kv['SCH.NUM'], 'SCH.NUM');
  if (num <= 0) return [];

  const entries: SchEntry[] = [];
  for (let i = 0; i < num; i++) {
    const filename = kv[`SCH${i}`];
    if (!filename) continue;
    const trimmed = filename.trim();
    const type = inferSchEntryType(trimmed);
    entries.push({
      index: i,
      filename: trimmed,
      path: `${sourcePath.replace(/\\/g,'/').split('/').slice(0,-1).join('/')}/${trimmed}`.replace(/^\//,''),
      type,
      name: trimmed.replace(/\.(std|sld)$/i, ''),
    });
  }
  return entries;
}

/** 按后缀推断 SCH 条目类型 */
function inferSchEntryType(filename: string): SchEntryType {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.std')) return 'std';
  if (lower.endsWith('.sld')) return 'sld';
  return 'unknown';
}

/**
 * 从 GIM 解压文件集合发现 SCH 条目。
 *
 * 约定：SCH 入口固定为 `CBM/project.sch`，但 GIM 文件解压后路径大小写可能不同
 * （`Cbm/project.sch` / `cbm/project.sch`），按候选大小写顺序尝试。
 * 若不存在则返回空数组（说明该工程不含 STD/SLD 拓扑/单线图）。
 *
 * @param files GIM 解压后的文件集合（key 形如 `CBM/project.sch`）
 * @returns SCH 条目列表
 */
export async function discoverStdSldFromSCH(files:Map<string,File>):Promise<SchEntry[]> {
  const resolve=getFileEntryResolver(files),candidates=getFileEntryIndex(files).candidates('project.sch');
  if(candidates.length>1)throw new SourceConflictError([{kind:'ambiguous-field',path:'',field:'project.sch',lines:[],values:[...candidates]}]);
  const path=candidates[0];if(!path)return [];
  const file=files.get(path);if(!file)return [];
  const entries=parseSch(await file.text(),path);
  return entries.map(entry=>({...entry,path:resolve(entry.filename,path)??entry.path}));
}
