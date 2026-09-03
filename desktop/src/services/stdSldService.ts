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
 *   4. 返回局部结果；由调用方在 ProjectLoadSession 仍有效时提交到 AppState
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
import { isTauri } from '@desktop/runtime.js';

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
export function commitStdSldResult(
  state: AppState,
  result: StdSldParseResult | null,
): void {
  state.currentStdDoc = result?.stdDoc ?? null;
  state.currentSldDoc = result?.sldDoc ?? null;
  state.currentStdSldIndex = result?.index ?? null;
}

/**
 * 校验缓存恢复结果是否覆盖了 GIM 索引中声明的电气图文件。
 *
 * 旧版本缓存只落盘 IFC/几何文件，SQLite 的 gim_entry 虽然仍记录
 * project.sch、*.std、*.sld，但 extracted/{projectId} 下没有对应文件。
 * 这种缓存不能继续走短路路径，否则电气图面板只能显示空状态。
 */
export function findMissingStdSldCacheParts(
  entryPaths: Iterable<string>,
  result: StdSldParseResult | null,
): string[] {
  let expectsSch = false;
  let expectsStd = false;
  let expectsSld = false;

  for (const entryPath of entryPaths) {
    const lower = entryPath.replace(/\\/g, '/').toLowerCase();
    if (lower === 'cbm/project.sch') expectsSch = true;
    else if (lower.startsWith('cbm/') && lower.endsWith('.std')) expectsStd = true;
    else if (lower.startsWith('cbm/') && lower.endsWith('.sld')) expectsSld = true;
  }

  const missing: string[] = [];
  if (expectsSch && (!result || result.schEntries.length === 0)) missing.push('SCH');
  // NBT1 samples intentionally store the rendered SLD SVG in both the .std
  // and .sld entries. parseStd returns a document with version=NBT1 and no
  // Substation for that format; this is a supported "no standalone topology"
  // result (the cold path follows the same degradation), not a missing cache.
  const stdIsRenderedSvg = result?.stdDoc?.version?.toUpperCase() === 'NBT1';
  if (expectsStd && !result?.stdDoc?.substation && !stdIsRenderedSvg) missing.push('STD');
  if (expectsSld && (!result?.sldDoc?.safeSvgOuterHTML || result.sldDoc.groups.length === 0)) {
    missing.push('SLD');
  }
  return missing;
}

/**
 * 解析并构建 STD/SLD 三向索引。
 *
 * **首次打开**（files 非空）：从内存文件读取
 * **缓存命中**（files 为空 + state.currentProjectId 设置 + Tauri 环境）：
 *   从磁盘缓存读取 CBM/project.sch 与各 SCH 引用的 .std/.sld 文件
 *
 * @param state 全局 AppState；只读取当前 CBM 树和缓存工程 ID，不在本函数内写入状态
 * @param files GIM 解压后的文件集合（首次打开），或 null（缓存命中从磁盘读取）
 * @returns 解析结果摘要；若 SCH 入口不存在或缓存不可用返回 null
 */
export async function parseAndIndexStdSld(
  state: AppState,
  files: Map<string, File> | null,
): Promise<StdSldParseResult | null> {
  // 在第一次 await 之前捕获只读输入。若工程在解析期间切换，后续构建仍
  // 只能基于原工程的 CBM 树/项目 ID 生成局部结果，绝不混入新工程状态。
  const cbmTree = state.currentCbmTree;
  const projectId = state.currentProjectId;
  let schEntries: SchEntry[] = [];
  let fileTextMap: Map<string, string> = new Map();

  if (files) {
    // 首次打开：从内存文件发现 SCH 入口
    schEntries = await discoverStdSldFromSCH(files);
    if (schEntries.length === 0) {
      debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 该工程不含 SCH 入口（无 STD/SLD 拓扑与单线图）');
      return null;
    }
    // 读取 STD/SLD 文件文本（大小写不敏感查找：GIM 解压后路径可能是 Cbm/ 或 CBM/）
    for (const entry of schEntries) {
      let file = files.get(entry.path);
      if (!file) {
        // 大小写不敏感兜底：遍历匹配
        const lower = entry.path.toLowerCase();
        for (const [p, f] of files) {
          if (p.toLowerCase() === lower) {
            file = f;
            break;
          }
        }
      }
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
    if (!isTauri() || projectId == null) {
      debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 缓存命中场景缺少 projectId，跳过 STD/SLD 解析');
      return null;
    }

    try {
      const { readCachedIfc, batchReadCachedFiles } = await import('@desktop/database.js');
      // 读取 SCH 入口文件（尝试多种大小写，因 GIM 解压后路径大小写可能不同）
      const schCandidates = ['CBM/project.sch', 'Cbm/project.sch', 'cbm/project.sch'];
      let schBytes: Uint8Array | null = null;
      let schMatchedPath = '';
      for (const candidate of schCandidates) {
        try {
          schBytes = await readCachedIfc(projectId, candidate);
          schMatchedPath = candidate;
          break;
        } catch {
          // 此大小写不匹配，尝试下一个
        }
      }
      if (!schBytes) {
        debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 缓存命中但 SCH 入口不存在（尝试过', schCandidates.join('/'), ')');
        return null;
      }
      const schText = new TextDecoder().decode(schBytes);
      schEntries = parseSch(schText);
      if (schEntries.length === 0) {
        debugLog(DEBUG_RUNTIME_LOGS, '[STD/SLD] 缓存命中但 SCH 入口为空');
        return null;
      }
      // 批量读取 STD/SLD 文件（同时尝试原始路径和大小写变体，应对 GIM 内部路径大小写不一致）
      const entryPaths = schEntries.map((e) => e.path);
      // 同时加入大小写变体（Cbm/、cbm/）作为兜底
      const altPaths: string[] = [];
      for (const p of entryPaths) {
        if (p.startsWith('CBM/')) {
          altPaths.push('Cbm/' + p.slice(4));
          altPaths.push('cbm/' + p.slice(4));
        }
      }
      const bytesMap = await batchReadCachedFiles(projectId, [...entryPaths, ...altPaths]);
      for (const [entryPath, bytes] of bytesMap) {
        if (bytes) {
          // 通过 entry.path 索引（即便实际读取的路径是大小写变体，也用原始 entry.path 索引）
          const targetPath = entryPaths.includes(entryPath) ? entryPath : entryPaths.find((p) => p.toLowerCase() === entryPath.toLowerCase());
          if (targetPath) {
            fileTextMap.set(targetPath, new TextDecoder().decode(bytes));
          }
        }
      }
      // 校验：是否有 SCH 引用的文件未读到
      for (const entry of schEntries) {
        if (!fileTextMap.has(entry.path)) {
          console.warn(`[STD/SLD] 缓存文件不存在或读取失败: ${entry.path}`);
        }
      }
      if (schMatchedPath !== 'CBM/project.sch') {
        console.log(`[SCH] 缓存命中 SCH 入口路径非默认大小写：${schMatchedPath}`);
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
        // NBT1 is an SVG merge document intentionally carrying no standalone
        // electrical topology. Keep the parsed marker so cache restore can
        // distinguish this supported format from a missing/corrupt STD file.
        if (!stdDoc.substation && stdDoc.version.toUpperCase() !== 'NBT1') {
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
  const index = buildStdSldIndex(cbmTree, stdDoc, sldDoc);

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
    console.warn('[STD/SLD] 后台解析失败:', err);
    return null;
  }
}

/**
 * 在缓存命中后从磁盘恢复 STD/SLD（不阻塞主流程）。
 *
 * 与 parseStdSldOnGimExtracted 的差异：
 * - 不传 files，由函数内部从磁盘读取
 * - 必须在 state.currentProjectId 设置后调用
 * - 只返回局部结果，不直接写入 AppState
 */
export async function restoreStdSldFromCache(state: AppState): Promise<StdSldParseResult | null> {
  try {
    return await parseAndIndexStdSld(state, null);
  } catch (err) {
    console.warn('[STD/SLD] 缓存恢复失败:', err);
    return null;
  }
}
