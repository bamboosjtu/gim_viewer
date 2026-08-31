/** 线路 FAM/DEV 属性解析的纯核心，可在 Worker 中运行。 */

import type { GimGraph } from './gimGraphTypes.js';
import type { LineFamPropertyPayload, LineDevPropertyPayload } from '@desktop/database.js';
import { normalizeGimPath, getFileNameLower } from './linePathNormalize.js';
import { parseLineFam } from './lineFamParser.js';
import { parseLineDev } from './lineDevParser.js';
import { LineParserTextCache } from './lineParserCache.js';

export interface LineAttributePayloadsCore {
  famPayloads: LineFamPropertyPayload[];
  devPayloads: LineDevPropertyPayload[];
  unmatchedRefs: string[];
}

function collectAttrRefs(graph: GimGraph): { famRefs: string[]; devRefs: string[] } {
  const famSet = new Set<string>();
  const devSet = new Set<string>();
  for (const node of graph.nodesByPath.values()) {
    for (const ref of node.refs.famFiles) if (ref) famSet.add(ref);
    for (const ref of node.refs.devFiles) if (ref) devSet.add(ref);
  }
  return { famRefs: Array.from(famSet), devRefs: Array.from(devSet) };
}

function parseFamPayload(
  sourcePath: string,
  cache: LineParserTextCache,
): LineFamPropertyPayload[] | null {
  const parsed = cache.parse('fam', sourcePath, parseLineFam);
  if (!parsed) return null;
  const normalizedPath = normalizeGimPath(sourcePath);
  const fileNameLower = getFileNameLower(sourcePath);
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
}

function parseDevPayload(
  sourcePath: string,
  cache: LineParserTextCache,
): LineDevPropertyPayload[] | null {
  const parsed = cache.parse('dev', sourcePath, parseLineDev);
  if (!parsed) return null;
  const normalizedPath = normalizeGimPath(sourcePath);
  const fileNameLower = getFileNameLower(sourcePath);
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

/** 在已构建的共享 cache 上解析所有 FAM/DEV 引用。 */
export function parseLineAttributesFromCache(
  graph: GimGraph,
  cache: LineParserTextCache,
): LineAttributePayloadsCore {
  const { famRefs, devRefs } = collectAttrRefs(graph);
  const famPayloads: LineFamPropertyPayload[] = [];
  const devPayloads: LineDevPropertyPayload[] = [];
  const unmatchedRefs: string[] = [];

  for (const refValue of famRefs) {
    const matchedPath = cache.resolveOriginalPath(refValue);
    if (!matchedPath) {
      unmatchedRefs.push(`FAM: ${refValue}`);
      continue;
    }
    try {
      const payloads = parseFamPayload(matchedPath, cache);
      if (!payloads) unmatchedRefs.push(`FAM: ${refValue} (matched key ${matchedPath} 但文件缺失)`);
      else famPayloads.push(...payloads);
    } catch {
      unmatchedRefs.push(`FAM: ${refValue} (读取/解析失败)`);
    }
  }

  for (const refValue of devRefs) {
    const matchedPath = cache.resolveOriginalPath(refValue);
    if (!matchedPath) {
      unmatchedRefs.push(`DEV: ${refValue}`);
      continue;
    }
    try {
      const payloads = parseDevPayload(matchedPath, cache);
      if (!payloads) unmatchedRefs.push(`DEV: ${refValue} (matched key ${matchedPath} 但文件缺失)`);
      else devPayloads.push(...payloads);
    } catch {
      unmatchedRefs.push(`DEV: ${refValue} (读取/解析失败)`);
    }
  }

  return { famPayloads, devPayloads, unmatchedRefs };
}

/** 构建一次共享文本 cache；Worker 输入和主线程回退都复用。 */
export function createLineParserCache(files: Iterable<{ path: string; text: string }>): LineParserTextCache {
  return new LineParserTextCache(files);
}

