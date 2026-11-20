/**
 * SCH (schematic index) parser.
 *
 * `CBM/project.sch` lists STD/SLD entry names. This module only parses the
 * index grammar; resolving files and choosing diagrams belongs to the caller.
 */
import {
  parseKeyValue,
  keyValueDiagnostics,
} from "@gim/powerline-core/kvParser.js";
import { parseBoundedCount } from "@gim/powerline-core/parserLimits.js";
import { SourceConflictError } from "@gim/powerline-core/sourceDocument.js";

export type SchEntryType = "std" | "sld" | "unknown";

export interface SchEntry {
  index: number;
  filename: string;
  path: string;
  type: SchEntryType;
  name: string;
}

export function parseSch(
  text: string,
  sourcePath = "CBM/project.sch",
): SchEntry[] {
  const kv = parseKeyValue(text, sourcePath);
  const conflicts = keyValueDiagnostics(kv);
  if (conflicts.length) throw new SourceConflictError(conflicts);
  const num = parseBoundedCount(kv["SCH.NUM"], "SCH.NUM");
  if (num <= 0) return [];

  const entries: SchEntry[] = [];
  for (let i = 0; i < num; i++) {
    const filename = kv[`SCH${i}`];
    if (!filename) continue;
    const trimmed = filename.trim();
    const type = inferSchEntryType(trimmed);
    entries.push({
      index: i,
      filename: trimmed,
      path: `${sourcePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/")}/${trimmed}`.replace(
        /^\//,
        "",
      ),
      type,
      name: trimmed.replace(/\.(std|sld)$/i, ""),
    });
  }
  return entries;
}

function inferSchEntryType(filename: string): SchEntryType {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".std")) return "std";
  if (lower.endsWith(".sld")) return "sld";
  return "unknown";
}
