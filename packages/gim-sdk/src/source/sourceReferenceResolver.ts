import { sourceReferenceCandidates, type EntryIndex } from "./entryResolver.js";
import {
  sourceReferenceFields,
  sourceScalar,
  type SourceField,
} from "./sourceDocument.js";
import type { SourceDocument } from "./sourceDocuments.js";

export interface SourceReference {
  lines?: number[];
  values?: string[];
  owner: string;
  field: string;
  value: string;
  target: string | null;
  candidates: string[];
  status: "resolved" | "missing" | "ambiguous";
}

interface AmbiguousFieldDiagnostic {
  kind: "ambiguous-field";
  source: string;
  field: string;
  lines: number[];
}

/** Appends reference evidence in traversal order using the caller's archive index. */
export function createSourceReferenceResolver(
  entryIndex: EntryIndex,
  references: SourceReference[],
  recordDiagnostic: (diagnostic: AmbiguousFieldDiagnostic) => void,
) {
  const ambiguousFields = new WeakMap<SourceDocument, Set<string>>();

  function resolve(owner: string, field: string, value: string): string | null {
    const candidates = sourceReferenceCandidates(entryIndex, value, owner);
    const target = candidates.length === 1 ? candidates[0] : null;
    references.push({
      owner,
      field,
      value,
      target,
      candidates: [...candidates],
      status: target ? "resolved" : candidates.length ? "ambiguous" : "missing",
    });
    return target;
  }

  function recordAmbiguity(
    doc: SourceDocument,
    key: string,
    fields: readonly SourceField[],
  ): void {
    const seen = ambiguousFields.get(doc) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key);
    ambiguousFields.set(doc, seen);
    const lines = fields.flatMap((field) =>
      field.line == null ? [] : [field.line],
    );
    recordDiagnostic({
      kind: "ambiguous-field",
      source: doc.path,
      field: key,
      lines,
    });
    const candidates = [
      ...new Set(
        fields.flatMap((field) => [
          ...sourceReferenceCandidates(entryIndex, field.value, doc.path),
        ]),
      ),
    ];
    references.push({
      owner: doc.path,
      field: key,
      value: "",
      values: fields.map((field) => field.value),
      lines,
      candidates,
      target: null,
      status: "ambiguous",
    });
  }

  function scalar(doc: SourceDocument, key: string): string {
    const result = sourceScalar(doc, key);
    if (result.status === "ambiguous") recordAmbiguity(doc, key, result.fields);
    return result.value;
  }

  function edgesFor(doc: SourceDocument, pattern: RegExp) {
    return sourceReferenceFields(doc, pattern, (key, fields) =>
      recordAmbiguity(doc, key, fields),
    );
  }

  return { resolve, scalar, edgesFor };
}
