/**
 * STD/SLD 编排服务。
 *
 * 负责协调 SCH 入口发现、STD/SLD 解析、三向 gridId 索引构建三个步骤，
 * 把结果写入 AppState 供 UI 层和交互层使用。
 *
 * **首次打开**（currentFiles 非空）：
 *   1. discoverStdSldFromSCH(currentFiles) → SchEntry[]
 *   2. 按 SchEntry 类型读取 STD/SLD 文件 → parseStd/parseSld
 *   3. buildStdSldIndex(cbmRoot, stdDoc, sldDoc) → StdSldIndex
 *   4. 写入 state.currentStdDoc / currentSldDoc / currentStdSldIndex
 *
 * **缓存命中**（currentFiles 为空）：
 *   从磁盘缓存读取 STD/SLD 文件后走相同流程。
 *
 * 关联文档：[05-cbm-tree-structure.md](../../docs/schema/05-cbm-tree-structure.md)
 */

import type { AppState } from '../app/state.js';
import type { SchEntry } from '../gim/schParser.js';
import { discoverStdSldFromSCH, parseSch } from '../gim/schParser.js';
import { parseStd, type StdDocument } from '../gim/stdParser.js';
import { parseSld, type SldDocument } from '../gim/sldParser.js';
import { buildStdSldIndex, type StdSldIndex } from '../gim/stdSldIndex.js';
import { DEBUG_RUNTIME_LOGS } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { isTauri } from '../desktop/runtime.js';

/** 解析结果摘要 */
export interface StdSldParseResult {
  schEntries: SchEntry[];
  stdDoc: StdDocument | null;
  sldDoc: SldDocument | null;
  index: StdSldIndex;
}

/**
 * 解析并构建 STD/SLD 三向索引。
 *
 * **首次打开**（files 非空）：从内存文件读取
 * **缓存命中**（files 为空 + state.currentProjectId 设置 + Tauri 环境）：
 *   从磁盘缓存读取 CBM/project.sch 与各 SCH 引用的 .std/.sld 文件
 *
 * @param state 全局 AppState，写入 currentStdDoc/currentSldDoc/currentStdSldIndex
 * @param files GIM 解压后的文件集合（首次打开），或 null（缓存命中从磁盘读取）
 * @returns 解析结果摘要；若 SCH 入口不存在或缓存不可用返回 null
 */
export async function parseAndIndexStdSld(
  state: AppState,
  files: Map<string, File> | null,
): Promise<StdSldParseResult | null> {
  let schEntries: SchEntry[] = [];
  let fileTextMap: Map<string, string> = new Map();

  if (files) {
    // 首次打开：从内存文件发现 SCH 入口
    schEntries = await discoverStdSldFromSCH(files);
    if (schEntries.length === 0) {
      debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 该工程不含 SCH 入口（无 STD/SLD 拓扑与单线图）');
      return null;
    }
    // 读取 STD/SLD 文件文本
    for (const entry of schEntries) {
      const file = files.get(entry.path);
      if (!file) {
        console.warn(`[STD/SLD] SCH 引用的文件不存在: ${entry.path}`);
        continue;
      }
      try {
        fileTextMap.set(entry.path, await file.text());
      } catch (err) {
        console.error(`[STD/SLD] 读取文件失败: ${entry.path}`, err);
      }
    }
  } else {
    // 缓存命中：从磁盘缓存读取
    if (!isTauri() || state.currentProjectId == null) {
      debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 缓存命中场景缺少 projectId，跳过 STD/SLD 解析');
      return null;
    }

    const projectId = state.currentProjectId;
    try {
      const { readCachedIfc } = await import('../desktop/database.js');
      // 读取 SCH 入口文件
      const schBytes = await readCachedIfc(projectId, 'CBM/project.sch');
      const schText = new TextDecoder().decode(schBytes);
      schEntries = parseSch(schText);
      if (schEntries.length === 0) {
        debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 缓存命中但 SCH 入口为空');
        return null;
      }
      // 批量读取 STD/SLD 文件
      const { batchReadCachedFiles } = await import('../desktop/database.js');
      const entryPaths = schEntries.map((e) => e.path);
      const bytesMap = await batchReadCachedFiles(projectId, entryPaths);
      for (const [entryPath, bytes] of bytesMap) {
        if (bytes) {
          fileTextMap.set(entryPath, new TextDecoder().decode(bytes));
        } else {
          console.warn(`[STD/SLD] 缓存文件不存在或读取失败: ${entryPath}`);
        }
      }
    } catch (err) {
      console.warn('[STD/SLD] 从磁盘缓存读取 STD/SLD 失败:', err);
      return null;
    }
  }

  // 解析 STD/SLD 文档
  let stdDoc: StdDocument | null = null;
  let sldDoc: SldDocument | null = null;
  for (const entry of schEntries) {
    const text = fileTextMap.get(entry.path);
    if (!text) continue;
    try {
      if (entry.type === 'std') {
        stdDoc = parseStd(text, entry.path);
        if (!stdDoc.substation) {
          console.warn(`[STD/SLD] STD 解析失败或无 Substation: ${entry.path}`);
          stdDoc = null;
        }
      } else if (entry.type === 'sld') {
        sldDoc = parseSld(text, entry.path);
        if (sldDoc.groups.length === 0) {
          console.warn(`[SLD] SLD 解析失败或无图形: ${entry.path}`);
        }
      }
    } catch (err) {
      console.error(`[STD/SLD] 解析 ${entry.path} 失败:`, err);
    }
  }

  // 构建三向索引
  const index = buildStdSldIndex(state.currentCbmTree, stdDoc, sldDoc);

  // 写入 state
  state.currentStdDoc = stdDoc;
  state.currentSldDoc = sldDoc;
  state.currentStdSldIndex = index;

  debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 解析完成', {
    source: files ? 'extracted' : 'cache',
    sch_entries: schEntries.length,
    std_gridIds: stdDoc?.gridIdIndex.size ?? 0,
    sld_gridIds: sldDoc?.gridIdIndex.size ?? 0,
    cbm_gridIds: index.cbmByGridId.size,
    stdOnly: index.stdOnlyGridIds.length,
    sldOnly: index.sldOnlyGridIds.length,
  });

  return { schEntries, stdDoc, sldDoc, index };
}

/**
 * 在 GIM 解压完成后并行解析 STD/SLD（不阻塞主流程）。
 *
 * 失败时不抛错，仅输出警告（与 CBM 树构建失败时的处理方式一致）。
 */
export async function parseStdSldOnGimExtracted(
  state: AppState,
  files: Map<string, File>,
): Promise<void> {
  try {
    await parseAndIndexStdSld(state, files);
  } catch (err) {
    console.warn('[STD/SLD] 后台解析失败:', err);
  }
}

/**
 * 在缓存命中后从磁盘恢复 STD/SLD（不阻塞主流程）。
 *
 * 与 parseStdSldOnGimExtracted 的差异：
 * - 不传 files，由函数内部从磁盘读取
 * - 必须在 state.currentProjectId 设置后调用
 */
export async function restoreStdSldFromCache(state: AppState): Promise<void> {
  try {
    await parseAndIndexStdSld(state, null);
  } catch (err) {
    console.warn('[STD/SLD] 缓存恢复失败:', err);
  }
}
