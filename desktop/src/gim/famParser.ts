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

export interface FamSourceProperty {
  /** One-based physical line in the source; normalized keys are not row identity. */
  sourceLine?: number;
  sourcePath: string;
  section: string;
  rawKey: string;
  label: string;
  rawValue: string;
  rawLine: string;
}

/** A candidate business identity is source evidence, never a synthesized code. */
export function resolveSubstationBusinessIdentity(properties: readonly FamSourceProperty[]) {
  const kinds = ['三维设计模型编码', '电网工程标识系统编码', '设备编码', '调度编码', '实物ID'];
  for (const kind of kinds) {
    const property = properties.find((p) => (p.label === kind || p.rawKey === kind) && !isGimEmptyValue(p.rawValue));
    if (property) return { value: property.rawValue, kind, source: { path: property.sourcePath, key: property.rawKey, section: property.section } };
  }
  return null;
}

/**
 * Detailed companion for diagnostics/tests. The public parser above keeps its
 * historical Map return shape so existing UI/cache callers do not need a DTO.
 */
export function parseFamSectionsWithDiagnostics(
  text: string,
  sourcePath = '',
): { sections: Map<string, Map<string, string>>; properties: FamSourceProperty[]; diagnostics: FamParseDiagnostics } {
  const properties: FamSourceProperty[] = [];
  const sections = new Map<string, Map<string, string>>();
  let cur = '默认';
  let map = new Map<string, string>();
  sections.set(cur, map);
  let malformedLineCount = 0;
  let propertyCount = 0;
  for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; map = sections.get(cur) ?? new Map(); sections.set(cur, map); continue; }

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
    const keys = parts.slice(0, -1).map((part) => part.trim()).filter((part) => !isGimEmptyValue(part));
    properties.push({ sourceLine: lineIndex + 1, sourcePath, section: cur, label: key, rawKey: keys[keys.length - 1], rawValue: value, rawLine: raw });
    // Derived single-value view: last physical row wins, including empty values.
    map.set(key, value);
    propertyCount++;
  }
  return { sections, properties, diagnostics: { malformedLineCount, propertyCount } };
}
