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
 * 关联文档：[05-cbm-tree-structure.md](../../docs/schema/05-cbm-tree-structure.md)
 */

import { parseKeyValue } from './cbmParser.js';

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
export function parseSch(text: string): SchEntry[] {
  const kv = parseKeyValue(text);
  const num = parseInt(kv['SCH.NUM'] || '0', 10);
  if (!Number.isFinite(num) || num <= 0) return [];

  const entries: SchEntry[] = [];
  for (let i = 0; i < num; i++) {
    const filename = kv[`SCH${i}`];
    if (!filename) continue;
    const trimmed = filename.trim();
    const type = inferSchEntryType(trimmed);
    entries.push({
      index: i,
      filename: trimmed,
      path: `CBM/${trimmed}`,
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
 * 约定：SCH 入口固定为 `CBM/project.sch`。
 * 若不存在则返回空数组（说明该工程不含 STD/SLD 拓扑/单线图）。
 *
 * @param files GIM 解压后的文件集合（key 形如 `CBM/project.sch`）
 * @returns SCH 条目列表
 */
export async function discoverStdSldFromSCH(files: Map<string, File>): Promise<SchEntry[]> {
  const schFile = files.get('CBM/project.sch');
  if (!schFile) return [];
  try {
    const text = await schFile.text();
    return parseSch(text);
  } catch {
    return [];
  }
}
