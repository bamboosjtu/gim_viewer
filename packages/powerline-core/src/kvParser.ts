import {
  parseSourceDocument,
  sourceScalarProperties,
  sourceConflicts,
  sourceFields,
} from './sourceDocument.js';
import type { SourceDiagnostic, SourceField } from './sourceDocument.js';
import { debugLog } from './diagnostics.js';
const lists = new WeakMap<Record<string, string>, readonly SourceField[]>();
const conflicts = new WeakMap<Record<string, string>, readonly SourceDiagnostic[]>();
/** Scalar projection: conflicting values never silently pick a winner. List/reference
 * consumers read SourceDocument fields; sparse conflict evidence survives this projection. */
export function parseKeyValue(text: string, path = ''): Record<string, string> {
  const doc = parseSourceDocument(path, text),
    properties = sourceScalarProperties(doc),
    diagnostics = sourceConflicts(doc);
  const repeated = sourceFields(doc, 'SUBSYSTEM');
  if (repeated.length > 1) lists.set(properties, repeated);
  if (diagnostics.length) {
    conflicts.set(properties, diagnostics);
    debugLog(true, '[GIM] ambiguous source fields', diagnostics);
  }
  return properties;
}
export function keyValueDiagnostics(
  properties: Record<string, string>,
): readonly SourceDiagnostic[] {
  return conflicts.get(properties) ?? [];
}

export function keyValueListFields(properties: Record<string, string>): readonly SourceField[] {
  return (
    lists.get(properties) ??
    (properties.SUBSYSTEM ? [{ path: '', keys: ['SUBSYSTEM'], value: properties.SUBSYSTEM }] : [])
  );
}
