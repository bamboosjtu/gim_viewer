/**
 * CBM source-record parser.
 *
 * CBM files are KEY=VALUE archives. This module extracts the lossless document,
 * raw properties and the two format-level references (ENTITYNAME and
 * OBJECTMODELPOINTER). Display-name selection, recursive tree building and DEV
 * expansion remain source/tree-builder responsibilities.
 */
import { normalizeEntityName } from "@gim/gim-primitives/entityName.js";
import type { ParseResult } from "./types.js";
import { fromSourceDiagnostic, parseStatus } from "./diagnostics.js";
import {
  parseSourceDocument,
  sourceConflicts,
  sourceScalarProperties,
  type SourceDiagnostic,
  type SourceDocument,
  type SourceField,
} from "@gim/gim-primitives/sourceDocument.js";

export interface CbmDocumentRecord {
  path: string;
  fields: readonly SourceField[];
  properties: Readonly<Record<string, string>>;
  /** Normalized ENTITYNAME spelling; the raw row remains in `fields`. */
  entityName: string;
  /** Raw OBJECTMODELPOINTER reference (possibly empty). */
  objectModelPointer: string;
  diagnostics: readonly SourceDiagnostic[];
}

export function parseCbmDocument(document: SourceDocument): CbmDocumentRecord {
  const properties = sourceScalarProperties(document);
  const first = (key: string): string => {
    const exact = properties[key];
    if (exact !== undefined) return exact;
    const lower = key.toLowerCase();
    const found = Object.keys(properties).find(
      (name) => name.toLowerCase() === lower,
    );
    return found === undefined ? "" : properties[found];
  };
  return {
    path: document.path,
    fields: document.fields,
    properties,
    entityName: normalizeEntityName(first("ENTITYNAME")),
    objectModelPointer: first("OBJECTMODELPOINTER"),
    diagnostics: sourceConflicts(document),
  };
}

export function parseCbmText(text: string, path = ""): CbmDocumentRecord {
  return parseCbmDocument(parseSourceDocument(path, text));
}

/** Unified diagnostic envelope for new Browser/Validate consumers. */
export function parseCbmResult(
  text: string,
  path = "",
): ParseResult<CbmDocumentRecord> {
  const value = parseCbmText(text, path);
  const diagnostics = value.diagnostics.map(fromSourceDiagnostic);
  return {
    value,
    diagnostics,
    status: parseStatus(diagnostics, value.fields.length > 0),
  };
}
