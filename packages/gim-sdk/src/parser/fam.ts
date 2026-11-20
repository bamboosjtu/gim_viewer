import { parseFamPhysicalRecords } from "@gim/powerline-core/famRecords.js";
import type { ParseDiagnostic, ParseResult } from "./types.js";
import { isGimEmptyValue } from "./values.js";

/**
 * Parse the physical FAM sections.
 *
 * Substation samples use several three-segment spellings: `中文名=英文键=值`,
 * `中文名=中文名=值` and BIMBase's `=中文名=值`. The Map return remains a
 * stable section -> key/value projection; vendor labels never become a new
 * domain model. Business identity interpretation is intentionally not part of
 * this parser.
 */
export function parseFamSections(
  text: string,
): Map<string, Map<string, string>> {
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
  segments?: readonly string[];
}

export interface FamDocument {
  sections: Map<string, Map<string, string>>;
  properties: FamSourceProperty[];
}

/**
 * Detailed companion for diagnostics/tests. The historical Map return shape
 * is kept so existing UI/cache callers do not need a DTO.
 */
export function parseFamSectionsWithDiagnostics(
  text: string,
  sourcePath = "",
): {
  sections: Map<string, Map<string, string>>;
  properties: FamSourceProperty[];
  diagnostics: FamParseDiagnostics;
} {
  const properties: FamSourceProperty[] = [];
  const sections = new Map<string, Map<string, string>>();
  let cur = "默认";
  let map = new Map<string, string>();
  sections.set(cur, map);
  let malformedLineCount = 0;
  let propertyCount = 0;
  for (const record of parseFamPhysicalRecords(text)) {
    const { rawLine: raw, sourceLine, segments, section } = record;
    const tagged =
      segments.length === 1
        ? raw.trim().match(/^([\w\u3400-\u9fff.-]+)#([^#]+)#([^\r\n]*)$/u)
        : null;
    const parts = tagged ? [tagged[2], tagged[1], tagged[3]] : segments;
    cur = section;
    map = sections.get(cur) ?? new Map<string, string>();
    sections.set(cur, map);
    if (record.kind === "section") continue;
    if (parts.length < 2) {
      malformedLineCount++;
      continue;
    }
    const value = parts[parts.length - 1].trim();
    const key = parts
      .slice(0, -1)
      .map((part) => part.trim())
      .find((candidate) => !isGimEmptyValue(candidate));
    // A line without any non-empty key candidate cannot form a stable
    // property; skip it and expose the count instead of creating an empty key.
    if (key === undefined) {
      malformedLineCount++;
      continue;
    }
    const keys = parts
      .slice(0, -1)
      .map((part) => part.trim())
      .filter((part) => !isGimEmptyValue(part));
    properties.push({
      sourceLine,
      segments: parts,
      sourcePath,
      section: cur,
      label: key,
      rawKey: keys[keys.length - 1],
      rawValue: value,
      rawLine: raw,
    });
    // Derived single-value view: the last physical row wins, including empty values.
    map.set(key, value);
    propertyCount++;
  }
  return {
    sections,
    properties,
    diagnostics: { malformedLineCount, propertyCount },
  };
}

/**
 * Canonical parser result for new callers. The legacy detailed function above
 * remains for compatibility with existing source/UI consumers.
 */
export function parseFamDocument(
  text: string,
  sourcePath = "",
): ParseResult<FamDocument> {
  const parsed = parseFamSectionsWithDiagnostics(text, sourcePath);
  const diagnostics: ParseDiagnostic[] = [];
  if (parsed.diagnostics.malformedLineCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "fam-malformed-line",
      message: `${parsed.diagnostics.malformedLineCount} FAM line(s) skipped`,
      ...(sourcePath ? { path: sourcePath } : {}),
    });
  }
  return {
    value: { sections: parsed.sections, properties: parsed.properties },
    diagnostics,
  };
}
