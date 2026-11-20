import type { SourceDiagnostic } from "@gim/powerline-core/geometry/ir.js";
import type { ParseDiagnostic, ParseStatus } from "./types.js";

/** Keep legacy SourceDiagnostic payloads, but expose one browser-facing shape. */
export function fromSourceDiagnostic(row: SourceDiagnostic): ParseDiagnostic {
  return {
    severity: "warning",
    code: row.kind,
    message: `${row.field}: ${row.kind}`,
    path: row.path,
    ...(row.lines[0] === undefined ? {} : { line: row.lines[0] }),
    ...(row.values.length ? { rawValue: row.values.join(" | ") } : {}),
  };
}

export function parseStatus(
  diagnostics: readonly ParseDiagnostic[],
  hasValue: boolean,
): ParseStatus {
  if (diagnostics.length) return "partial";
  return hasValue ? "ok" : "empty";
}
