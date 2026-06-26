/**
 * 线路工程 FAM/DEV 属性持久化服务（v5）。
 *
 * 从 GimGraph.refs 收集所有 .fam / .dev 引用，匹配 currentFiles 中的实际文件，
 * 读取文本并解析为 LineFamPropertyPayload[] / LineDevPropertyPayload[]，
 * 供 save_line_project_cache 统一事务写入 SQLite。
 *
 * 匹配策略（避免漏命中）：
 * 1. 优先精确归一化匹配：normalizeGimPath(refValue) === normalizeGimPath(fileKey)
 * 2. 回退文件名小写匹配：getFileNameLower(refValue) === getFileNameLower(fileKey)
 * 3. 同名多文件时取第一个匹配（记录 warning）
 *
 * 设计参考 gimIndexPersistenceService.ts（变电工程索引入库）。
 */

import type { GimGraph } from '../gim/gimGraphTypes.js';
import type {
  LineFamPropertyPayload,
  LineDevPropertyPayload,
} from '../desktop/database.js';
import { LineRefKind } from '../gim/lineRefKind.js';
import { normalizeGimPath, getFileNameLower } from '../gim/linePathNormalize.js';
import { parseLineFam } from '../gim/lineFamParser.js';
import { parseLineDev } from '../gim/lineDevParser.js';
import { DEBUG_GIM_CACHE } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

/** 解析结果（供 saveLineProjectCache 使用） */
export interface LineAttributePayloads {
  famPayloads: LineFamPropertyPayload[];
  devPayloads: LineDevPropertyPayload[];
  /** 未能匹配到实际文件的引用（用于诊断 warning） */
  unmatchedRefs: string[];
}

/**
 * 构建 currentFiles 的查找索引。
 *
 * @returns { byNormalizedPath, byFileNameLower }
 * - byNormalizedPath: 归一化路径 → 原始 key
 * - byFileNameLower: 文件名小写 → 原始 key 列表（同名可能多个）
 */
function buildFileLookup(currentFiles: Map<string, File>): {
  byNormalizedPath: Map<string, string>;
  byFileNameLower: Map<string, string[]>;
} {
  const byNormalizedPath = new Map<string, string>();
  const byFileNameLower = new Map<string, string[]>();
  for (const key of currentFiles.keys()) {
    const normalized = normalizeGimPath(key);
    if (!byNormalizedPath.has(normalized)) {
      byNormalizedPath.set(normalized, key);
    }
    const fnLower = getFileNameLower(key);
    let list = byFileNameLower.get(fnLower);
    if (!list) {
      list = [];
      byFileNameLower.set(fnLower, list);
    }
    list.push(key);
  }
  return { byNormalizedPath, byFileNameLower };
}

/**
 * 匹配单个引用值到 currentFiles 中的实际文件 key。
 *
 * @returns 匹配到的原始 key，未匹配返回 null
 */
function matchRefToFile(
  refValue: string,
  lookup: { byNormalizedPath: Map<string, string>; byFileNameLower: Map<string, string[]> },
): string | null {
  const normalized = normalizeGimPath(refValue);
  // 1. 精确归一化匹配
  const exact = lookup.byNormalizedPath.get(normalized);
  if (exact) return exact;
  // 2. 文件名小写匹配
  const fnLower = getFileNameLower(refValue);
  if (fnLower) {
    const list = lookup.byFileNameLower.get(fnLower);
    if (list && list.length > 0) return list[0];
  }
  return null;
}

/**
 * 从 GimGraph.refs 收集所有去重的 .fam / .dev 引用。
 *
 * 遍历所有节点，按 ref_kind 分类收集 famFiles / devFiles 引用值。
 * 同一引用值在多个节点出现时只保留一份（属性按文件维度缓存）。
 *
 * @returns { famRefs: string[], devRefs: string[] } 去重后的引用值列表
 */
function collectAttrRefs(graph: GimGraph): { famRefs: string[]; devRefs: string[] } {
  const famSet = new Set<string>();
  const devSet = new Set<string>();
  for (const node of graph.nodesByPath.values()) {
    for (const ref of node.refs.famFiles) {
      if (ref) famSet.add(ref);
    }
    for (const ref of node.refs.devFiles) {
      if (ref) devSet.add(ref);
    }
  }
  return { famRefs: Array.from(famSet), devRefs: Array.from(devSet) };
}

/**
 * 解析单个属性文件为 payload 数组。
 *
 * @param sourcePath currentFiles 中的原始 key（用于 UI 展示和 source_path 字段）
 * @param fileText 文件文本内容
 * @param isFam true=FAM（三段式），false=DEV（普通 KEY=VALUE）
 */
function parseAttrFile(
  sourcePath: string,
  fileText: string,
  isFam: boolean,
): LineFamPropertyPayload[] | LineDevPropertyPayload[] {
  const normalizedPath = normalizeGimPath(sourcePath);
  const fileNameLower = getFileNameLower(sourcePath);

  if (isFam) {
    const parsed = parseLineFam(fileText);
    return parsed.map((p, idx) => ({
      source_path: sourcePath,
      normalized_path: normalizedPath,
      file_name_lower: fileNameLower,
      display_key: p.display_key,
      prop_key: p.prop_key,
      prop_value: p.prop_value,
      raw_line: p.raw_line,
      sort_order: idx,
    }));
  } else {
    const parsed = parseLineDev(fileText);
    return parsed.map((p, idx) => ({
      source_path: sourcePath,
      normalized_path: normalizedPath,
      file_name_lower: fileNameLower,
      prop_key: p.prop_key,
      prop_value: p.prop_value,
      raw_line: p.raw_line,
      sort_order: idx,
    }));
  }
}

/**
 * 解析线路工程全部 FAM/DEV 属性，生成可写入 SQLite 的 payload。
 *
 * 流程：
 * 1. 从 graph.refs 收集去重的 famFiles / devFiles 引用
 * 2. 构建 currentFiles 查找索引（归一化路径 + 文件名小写）
 * 3. 逐个匹配引用 → 读取文件文本 → 解析为 payload
 * 4. 未匹配的引用收集到 unmatchedRefs（不阻断，仅 warning）
 *
 * @param graph 已构建的线路工程图
 * @param currentFiles GIM 解压后的文件 Map（首次导入时持有）
 */
export async function parseLineAttributes(
  graph: GimGraph,
  currentFiles: Map<string, File>,
): Promise<LineAttributePayloads> {
  const { famRefs, devRefs } = collectAttrRefs(graph);
  const lookup = buildFileLookup(currentFiles);

  const famPayloads: LineFamPropertyPayload[] = [];
  const devPayloads: LineDevPropertyPayload[] = [];
  const unmatchedRefs: string[] = [];

  // 解析 FAM 引用
  for (const refValue of famRefs) {
    const matchedKey = matchRefToFile(refValue, lookup);
    if (!matchedKey) {
      unmatchedRefs.push(`FAM: ${refValue}`);
      continue;
    }
    const file = currentFiles.get(matchedKey);
    if (!file) {
      unmatchedRefs.push(`FAM: ${refValue} (matched key ${matchedKey} 但文件缺失)`);
      continue;
    }
    try {
      const text = await file.text();
      const payloads = parseAttrFile(matchedKey, text, true) as LineFamPropertyPayload[];
      famPayloads.push(...payloads);
    } catch (err) {
      console.warn('[LineAttr] FAM 文件读取/解析失败:', matchedKey, err);
      unmatchedRefs.push(`FAM: ${refValue} (读取/解析失败)`);
    }
  }

  // 解析 DEV 引用
  for (const refValue of devRefs) {
    const matchedKey = matchRefToFile(refValue, lookup);
    if (!matchedKey) {
      unmatchedRefs.push(`DEV: ${refValue}`);
      continue;
    }
    const file = currentFiles.get(matchedKey);
    if (!file) {
      unmatchedRefs.push(`DEV: ${refValue} (matched key ${matchedKey} 但文件缺失)`);
      continue;
    }
    try {
      const text = await file.text();
      const payloads = parseAttrFile(matchedKey, text, false) as LineDevPropertyPayload[];
      devPayloads.push(...payloads);
    } catch (err) {
      console.warn('[LineAttr] DEV 文件读取/解析失败:', matchedKey, err);
      unmatchedRefs.push(`DEV: ${refValue} (读取/解析失败)`);
    }
  }

  debugLog(DEBUG_GIM_CACHE, '[LineAttr] 属性解析完成:', {
    famRefs: famRefs.length,
    devRefs: devRefs.length,
    famPayloads: famPayloads.length,
    devPayloads: devPayloads.length,
    unmatched: unmatchedRefs.length,
  });
  if (unmatchedRefs.length > 0) {
    console.warn('[LineAttr] 未匹配的引用:', unmatchedRefs);
  }

  return { famPayloads, devPayloads, unmatchedRefs };
}

/** 估算 payload 序列化后的 JSON 大小（MB），用于性能日志和风险控制 */
export function estimatePayloadSizeMB(
  graphPayloadJson: string,
  famPayloads: LineFamPropertyPayload[],
  devPayloads: LineDevPropertyPayload[],
): number {
  // graph payload 已序列化为 JSON 字符串，直接取长度
  const graphBytes = graphPayloadJson.length;
  // FAM/DEV payload 未序列化，估算（每个字段平均长度 × 数量）
  let attrBytes = 0;
  for (const p of famPayloads) {
    attrBytes += (p.source_path.length + p.normalized_path.length + p.file_name_lower.length
      + (p.display_key?.length ?? 0) + p.prop_key.length + (p.prop_value?.length ?? 0)
      + (p.raw_line?.length ?? 0) + 64);
  }
  for (const p of devPayloads) {
    attrBytes += (p.source_path.length + p.normalized_path.length + p.file_name_lower.length
      + p.prop_key.length + (p.prop_value?.length ?? 0) + (p.raw_line?.length ?? 0) + 48);
  }
  return (graphBytes + attrBytes) / (1024 * 1024);
}

/** LineRefKind 常量引用（避免本文件遗漏使用统一常量） */
export const ATTR_REF_KIND = {
  FAM: LineRefKind.FAM_FILES,
  DEV: LineRefKind.DEV_FILES,
} as const;
