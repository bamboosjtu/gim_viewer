/**
 * FileDevRelation.cbm format parser.
 *
 * Three vendor spellings coexist: JinQu paired FILE entries, Bentley
 * FILES/DEVS, and BIMBase FILE/DEV/IFC. This module only reads declarations
 * and reports conflicts. Path resolution, basename ambiguity and modelId
 * generation stay in the desktop source adapter.
 */
import {
  keyValueDiagnostics,
  parseKeyValue,
} from "@gim/powerline-core/kvParser.js";
import { parseBoundedCount } from "@gim/powerline-core/parserLimits.js";
import type { SourceDiagnostic } from "@gim/powerline-core/sourceDocument.js";
import type { ParseDiagnostic, ParseResult, ParseStatus } from "./types.js";

export type FileDevRelationFormat = "jin-qu" | "bentley" | "bimbase";

export interface FileDevRelationRecord {
  index: number;
  format: FileDevRelationFormat;
  name: string;
  directIfc: string;
  ifcFile: string;
  ifcName: string;
  deviceCount: number;
  deviceCbms: string[];
  diagnostics: readonly SourceDiagnostic[];
}

export interface FileDevRelationDocument {
  status: ParseStatus;
  format: FileDevRelationFormat;
  count: number;
  entries: FileDevRelationRecord[];
}

const empty = (value: string | undefined): boolean =>
  value === undefined ||
  ["", "-", "/", "-100", "软件自动生成"].includes(value.trim().toLowerCase());

function value(kv: Record<string, string>, key: string): string {
  const direct = kv[key];
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  const found = Object.keys(kv).find((name) => name.toLowerCase() === lower);
  return found === undefined ? "" : kv[found];
}

function countKeyFor(kv: Record<string, string>): "FILES.NUM" | "FILE.NUM" {
  return empty(value(kv, "FILES.NUM")) ? "FILE.NUM" : "FILES.NUM";
}

function hasCount(kv: Record<string, string>, index: number): boolean {
  return (
    !empty(value(kv, `FILE${index}.DEVS.NUM`)) ||
    !empty(value(kv, `FILE${index}.DEV.NUM`))
  );
}

function hasIfc(kv: Record<string, string>, index: number): boolean {
  return !empty(value(kv, `FILE${index}.IFC`));
}

function append(
  entries: FileDevRelationRecord[],
  kv: Record<string, string>,
  diagnostics: readonly SourceDiagnostic[],
  index: number,
  format: FileDevRelationFormat,
  pairedIfc = "",
): void {
  const name = value(kv, `FILE${index}.NAME`);
  const directIfc = value(kv, `FILE${index}.IFC`);
  const devKey = hasCount(kv, index)
    ? !empty(value(kv, `FILE${index}.DEVS.NUM`))
      ? `FILE${index}.DEVS.NUM`
      : `FILE${index}.DEV.NUM`
    : null;
  const deviceCount = devKey ? parseBoundedCount(value(kv, devKey), devKey) : 0;
  const deviceCbms: string[] = [];
  for (let j = 0; j < deviceCount; j++) {
    const dev =
      value(kv, `FILE${index}.DEV${j}`) || value(kv, `FILE${index}.DEVS${j}`);
    if (dev) deviceCbms.push(dev);
  }
  const nameAsIfc = /\.ifc$/i.test(name) ? name : "";
  const ifcFile =
    directIfc || (empty(pairedIfc) ? "" : pairedIfc.trim()) || nameAsIfc;
  const ifcName =
    name.replace(/\.(?:ifc|dgn)$/i, "") || ifcFile.replace(/\.ifc$/i, "");
  const sourceDiagnostics = diagnostics.filter((row) =>
    row.field.startsWith(`FILE${index}.`),
  );
  if (ifcName || ifcFile || devKey || sourceDiagnostics.length)
    entries.push({
      index,
      format,
      name,
      directIfc,
      ifcFile,
      ifcName,
      deviceCount,
      deviceCbms,
      diagnostics: sourceDiagnostics,
    });
}

export function parseFileDevRelationText(
  text: string,
  sourcePath = "FileDevRelation.cbm",
): ParseResult<FileDevRelationDocument> {
  const kv = parseKeyValue(text, sourcePath);
  const diagnostics = keyValueDiagnostics(kv);
  const countKey = countKeyFor(kv);
  const num = parseBoundedCount(value(kv, countKey), countKey);
  const isLegacyPair =
    countKey === "FILE.NUM" &&
    num > 1 &&
    num % 2 === 0 &&
    Array.from({ length: num / 2 }, (_, pair) => pair * 2).every((i) =>
      hasCount(kv, i),
    ) &&
    Array.from({ length: num / 2 }, (_, pair) => pair * 2 + 1).every((i) =>
      hasIfc(kv, i),
    ) &&
    Array.from({ length: num / 2 }, (_, pair) => pair * 2 + 1).every(
      (i) => !hasCount(kv, i) && empty(value(kv, `FILE${i}.NAME`)),
    );
  const format: FileDevRelationFormat = isLegacyPair
    ? "jin-qu"
    : countKey === "FILES.NUM"
      ? "bentley"
      : "bimbase";
  const entries: FileDevRelationRecord[] = [];
  if (isLegacyPair) {
    for (let i = 0; i < num; i += 2)
      append(
        entries,
        kv,
        diagnostics,
        i,
        format,
        value(kv, `FILE${i + 1}.IFC`),
      );
  } else {
    for (let i = 0; i < num; i++) append(entries, kv, diagnostics, i, format);
  }
  const status: ParseStatus = diagnostics.length
    ? "partial"
    : entries.length
      ? "ok"
      : "empty";
  const parseDiagnostics: ParseDiagnostic[] = diagnostics.map((row) => ({
    severity: "warning",
    code: row.kind,
    message: `FileDevRelation field conflict: ${row.field}`,
    path: row.path,
    ...(row.lines[0] !== undefined ? { line: row.lines[0] } : {}),
  }));
  return {
    value: { status, format, count: num, entries },
    diagnostics: parseDiagnostics,
    status,
  };
}
