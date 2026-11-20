/** Resolve and parse the schematic documents for the current CBM source. */
import type { AppState } from '../app/state.js';
import type { SchEntry } from '../gim/schParser.js';
import { discoverStdSldFromSCH } from '../gim/schParser.js';
import { parseStd, type StdDocument } from '../gim/stdParser.js';
import { parseSld, type SldDocument } from '../gim/sldParser.js';
import { buildStdSldIndex, type StdSldIndex } from '../gim/stdSldIndex.js';
import { DEBUG_RUNTIME_LOGS } from '../config/debug.js';
import { debugLog, logger } from '../utils/logger.js';

/** 解析结果摘要 */
export interface StdSldParseResult {
  schEntries: SchEntry[];
  stdDoc: StdDocument | null;
  sldDoc: SldDocument | null;
  index: StdSldIndex;
}

/**
 * 将一次 STD/SLD 解析的局部结果提交到 AppState。
 *
 * 解析服务本身可能跨越多个 await，不能在内部直接写全局状态；调用方应
 * 在提交前完成 `state.isCurrentSession(session)` 校验，再调用此同步函数。
 * 传入 null 表示当前工程没有可用的 STD/SLD 文档，显式清空三项状态。
 */
export function commitStdSldResult(state: AppState, result: StdSldParseResult | null): void {
  state.currentStdDoc = result?.stdDoc ?? null;
  state.currentSldDoc = result?.sldDoc ?? null;
  state.currentStdSldIndex = result?.index ?? null;
}

async function parseAndIndexStdSld(
  state: AppState,
  files: Map<string, File>,
  cacheProjectId?: number,
): Promise<StdSldParseResult | null> {
  const cbmTree = state.currentCbmTree;
  const entries = await discoverStdSldFromSCH(files, cbmTree);
  if (!entries.length) return null;

  const fileTextMap = new Map<string, string>();
  const paths = new Set(
    entries
      .filter((entry) => entry.type !== 'unknown')
      .flatMap((entry) => (entry.matchedPath ? [entry.matchedPath] : [])),
  );
  let batchRead = false;
  if (cacheProjectId != null && paths.size) {
    try {
      const { batchReadCachedFiles } = await import('@desktop/database.js');
      const bytesMap = await batchReadCachedFiles(cacheProjectId, [...paths]);
      const decoder = new TextDecoder();
      for (const [path, bytes] of bytesMap) {
        if (bytes) fileTextMap.set(path, decoder.decode(bytes));
      }
      batchRead = true;
    } catch (err) {
      logger.warn('[STD/SLD] 批量读取电气图文件失败:', err);
    }
  }
  if (!batchRead) {
    for (const path of paths) {
      try {
        const file = files.get(path);
        if (file) fileTextMap.set(path, await file.text());
      } catch (err) {
        logger.warn(`[STD/SLD] 读取文件失败: ${path}`, err);
      }
    }
  }

  // 解析 STD/SLD 文档
  let stdDoc: StdDocument | null = null;
  let sldDoc: SldDocument | null = null;
  for (const entry of entries) {
    if (entry.type === 'unknown') continue;
    const text = entry.matchedPath == null ? undefined : fileTextMap.get(entry.matchedPath);
    if (text === undefined) {
      logger.warn(`[STD/SLD] SCH 引用缺失、存在歧义或读取失败: ${entry.filename}`);
      continue;
    }
    try {
      if (entry.type === 'std') {
        stdDoc = parseStd(text, entry.path);
        if (stdDoc.status === 'failed')
          logger.warn(`[STD/SLD] STD 解析失败: ${entry.path}`, stdDoc.diagnostics);
      } else if (entry.type === 'sld') {
        sldDoc = parseSld(text, entry.path);
        if (sldDoc.status === 'failed')
          logger.warn(`[SLD] SLD 解析失败: ${entry.path}`, sldDoc.diagnostics);
      }
    } catch (err) {
      logger.error(`[STD/SLD] 解析 ${entry.path} 失败:`, err);
    }
  }

  // 构建三向索引
  const index = buildStdSldIndex(cbmTree, stdDoc, sldDoc);

  debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 解析完成', {
    source: cacheProjectId == null ? 'extracted' : 'cache',
    sch_entries: entries.length,
    std_gridIds: stdDoc?.gridIdIndex.size ?? 0,
    sld_gridIds: sldDoc?.gridIdIndex.size ?? 0,
    cbm_gridIds: index.cbmByGridId.size,
    stdOnly: index.stdOnlyGridIds.length,
    sldOnly: index.sldOnlyGridIds.length,
  });

  return { schEntries: entries, stdDoc, sldDoc, index };
}

/**
 * 在 GIM 解压完成后并行解析 STD/SLD（不阻塞主流程）。
 *
 * 失败时不抛错，仅输出警告（与 CBM 树构建失败时的处理方式一致）。返回的
 * 结果必须由调用方在会话校验通过后调用 commitStdSldResult 提交。
 */
export async function parseStdSldOnGimExtracted(
  state: AppState,
  files: Map<string, File>,
): Promise<StdSldParseResult | null> {
  try {
    return await parseAndIndexStdSld(state, files);
  } catch (err) {
    logger.warn('[STD/SLD] 后台解析失败:', err);
    return null;
  }
}

/**
 * 在缓存命中后从磁盘恢复 STD/SLD（不阻塞主流程）。
 *
 * 与 parseStdSldOnGimExtracted 的差异：
 * - files 为已恢复的惰性来源清单，图纸优先通过批读获取
 * - 必须在 state.currentProjectId 设置后调用
 * - 只返回局部结果，不直接写入 AppState
 */
export async function restoreStdSldFromCache(
  state: AppState,
  files: Map<string, File>,
): Promise<StdSldParseResult | null> {
  try {
    if (state.currentProjectId == null) return null;
    return await parseAndIndexStdSld(state, files, state.currentProjectId);
  } catch (err) {
    logger.warn('[STD/SLD] 缓存恢复失败:', err);
    return null;
  }
}
