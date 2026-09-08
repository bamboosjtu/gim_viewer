import { isGimEmptyValue } from './gimValueSemantics.js';

/**
 * 解析 FAM 文件中的分节属性。
 *
 * 变电样本使用多种三段式写法：`中文名=英文键=值`、
 * `中文名=中文名=值` 以及 BIMBase 的 `=中文名=值`。Map 的公共返回
 * contract 仍然是 section → key/value；只把稳定的 key/value 投影到
 * Map，不把厂商标签扩张成新的 domain model。
 */
export function parseFamSections(text: string): Map<string, Map<string, string>> {
  return parseFamSectionsWithDiagnostics(text).sections;
}

export interface FamParseDiagnostics {
  /** Non-empty lines that cannot produce a stable key/value pair. */
  malformedLineCount: number;
  /** Number of retained section properties after malformed lines are skipped. */
  propertyCount: number;
}

/**
 * Detailed companion for diagnostics/tests. The public parser above keeps its
 * historical Map return shape so existing UI/cache callers do not need a DTO.
 */
export function parseFamSectionsWithDiagnostics(
  text: string,
): { sections: Map<string, Map<string, string>>; diagnostics: FamParseDiagnostics } {
  const sections = new Map<string, Map<string, string>>();
  let cur = '默认';
  let map = new Map<string, string>();
  sections.set(cur, map);
  let malformedLineCount = 0;
  let propertyCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; map = new Map(); sections.set(cur, map); continue; }

    const parts = line.split('=');
    if (parts.length < 2) { malformedLineCount++; continue; }
    const value = parts[parts.length - 1].trim();
    const key = parts
      .slice(0, -1)
      .map((part) => part.trim())
      .find((candidate) => !isGimEmptyValue(candidate));
    // 没有任何非空 key candidate 的行无法形成稳定属性；跳过并让调用方
    // 通过样本/诊断统计发现 malformed，而不是制造空字符串 Map key。
    if (key === undefined) { malformedLineCount++; continue; }
    map.set(key, value);
    propertyCount++;
  }
  return { sections, diagnostics: { malformedLineCount, propertyCount } };
}
