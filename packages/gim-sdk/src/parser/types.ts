/**
 * Format-neutral parser contracts.
 *
 * Parsers report source facts and diagnostics only. Business identity,
 * semantic classification and ownership decisions belong to the five cores.
 * These types deliberately have no runtime or environment dependencies.
 */

export type ParseDiagnosticSeverity = "error" | "warning" | "info";

/** Parse lifecycle shared by streaming and document parsers. */
export type ParseStatus = "ok" | "partial" | "empty" | "unsupported" | "failed";

export interface ParseDiagnostic {
  severity: ParseDiagnosticSeverity;
  /** Stable machine-readable code, scoped to the parser that emitted it. */
  code: string;
  message: string;
  /** Source path when the input came from an archive entry. */
  path?: string;
  /** One-based physical line in the source, when known. */
  line?: number;
  /** Original value when the diagnostic refers to a bad field. */
  rawValue?: string;
}

export interface ParseResult<T> {
  value: T | null;
  diagnostics: readonly ParseDiagnostic[];
  /** Optional for compatibility; new parsers should set it. */
  status?: ParseStatus;
}

export interface Parser<TInput, TOutput> {
  parse(input: TInput): ParseResult<TOutput>;
}
