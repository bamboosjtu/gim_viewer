import type { SourceDiagnostic } from './geometry/ir.js';
export type { SourceDiagnostic } from './geometry/ir.js';

/** Lossless KEY=VALUE source spelling shared by navigation, semantics and geometry. */
export interface SourceField {
  keys: readonly string[];
  path: string;
  value: string;
  line?: number;
  rawLine?: string;
  section?: string;
  /** DEV matrix indices are local to SOLIDMODELS / SUBDEVICES. */
  block?: 'solid' | 'sub' | 'phm-solids' | 'phm-models';
}
export interface SourceDocument {
  path: string;
  rawLines: string[];
  fields: SourceField[];
  attributeStatus?: 'complete' | 'partial';
}
export function parseSourceDocument(path: string, text: string): SourceDocument {
  const rawLines = text.split(/\r?\n/),
    fields: SourceField[] = [];
  let block: SourceField['block'];
  for (const [index, rawLine] of rawLines.entries()) {
    const line = rawLine.replace(/^\uFEFF/, '').trim(),
      at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim(),
      upper = key.toUpperCase();
    if (/\.dev$/i.test(path)) {
      if (upper === 'SOLIDMODELS.NUM' || /^SOLIDMODEL\d+$/.test(upper)) block = 'solid';
      if (upper === 'SUBDEVICES.NUM' || /^SUBDEVICE\d+$/.test(upper)) block = 'sub';
    }
    if (/\.phm$/i.test(path)) {
      if (upper === 'SOLIDS.NUM' || /^SOLIDS\d+$/.test(upper)) block = 'phm-solids';
      if (upper === 'SOLIDMODELS.NUM' || /^SOLIDMODEL\d+$/.test(upper)) block = 'phm-models';
    }
    fields.push({
      path,
      line: index + 1,
      keys: [key],
      value: line.slice(at + 1).trim(),
      rawLine,
      ...(block && /^(?:TRANSFORMMATRIX|COLOR|SOLIDS|SOLIDMODEL)\d+$/.test(upper) ? { block } : {}),
    });
  }
  return { path, rawLines, fields };
}

const indexes = new WeakMap<
  SourceDocument,
  { fields: SourceField[]; byKey: Map<string, SourceField[]> }
>();
export function sourceFields(
  doc: SourceDocument,
  key: string,
  block?: SourceField['block'],
): readonly SourceField[] {
  let index = indexes.get(doc);
  if (!index || index.fields !== doc.fields) {
    const byKey = new Map<string, SourceField[]>();
    for (const field of doc.fields) {
      const key = field.keys[0].toUpperCase(),
        rows = byKey.get(key) ?? [];
      rows.push(field);
      byKey.set(key, rows);
    }
    index = { fields: doc.fields, byKey };
    indexes.set(doc, index);
  }
  const fields = index.byKey.get(key.toUpperCase()) ?? [];
  return block ? fields.filter((field) => field.block === block) : fields;
}

export function sourceScalar(
  doc: SourceDocument,
  key: string,
  block?: SourceField['block'],
): {
  status: 'resolved' | 'empty' | 'ambiguous';
  value: string;
  fields: readonly SourceField[];
} {
  const fields = sourceFields(doc, key, block),
    values = [...new Set(fields.map((field) => field.value))];
  return values.length > 1
    ? { status: 'ambiguous', value: '', fields }
    : { status: values[0] ? 'resolved' : 'empty', value: values[0] ?? '', fields };
}

export function sourceDiagnostic(
  doc: SourceDocument,
  key: string,
  fields: readonly SourceField[],
  kind: SourceDiagnostic['kind'] = 'ambiguous-field',
): SourceDiagnostic {
  return {
    kind,
    path: doc.path,
    field: key,
    lines: fields.flatMap((field) => (field.line == null ? [] : [field.line])),
    values: fields.map((field) => field.value),
  };
}

/** A scalar projection never silently picks a conflicting spelling. Raw rows stay on the document. */
export function sourceScalarProperties(doc: SourceDocument): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const field of doc.fields) {
    const key = field.keys[0];
    if (!Object.prototype.hasOwnProperty.call(result, key))
      result[key] = sourceScalar(doc, key).value;
  }
  return result;
}

/** Repeated SUBSYSTEM lines are separate list edges. Numbered slots are scalar. */
export function sourceReferenceFields(
  doc: SourceDocument,
  pattern: RegExp,
  onAmbiguous?: (key: string, fields: readonly SourceField[]) => void,
): SourceField[] {
  const result: SourceField[] = [],
    seen = new Set<string>();
  for (const field of doc.fields) {
    const key = field.keys[0].toUpperCase();
    if (!pattern.test(key)) continue;
    if (key === 'SUBSYSTEM') {
      result.push(field);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const scalar = sourceScalar(doc, key);
    if (scalar.status === 'ambiguous') onAmbiguous?.(key, scalar.fields);
    else result.push(field);
  }
  return result;
}

/** Sparse conflicts are retained without keeping a second copy of every source line. */
export function sourceConflicts(doc: SourceDocument): SourceDiagnostic[] {
  const result: SourceDiagnostic[] = [],
    seen = new Set<string>();
  for (const field of doc.fields) {
    const key = field.keys[0].toUpperCase(),
      group = key + '|' + (field.block ?? '');
    if (seen.has(group) || key === 'SUBSYSTEM') continue;
    seen.add(group);
    const scalar = sourceScalar(doc, key, field.block);
    if (scalar.status === 'ambiguous') result.push(sourceDiagnostic(doc, key, scalar.fields));
  }
  return result;
}

export class SourceConflictError extends Error {
  constructor(readonly diagnostics: readonly SourceDiagnostic[]) {
    super(
      `来源字段存在冲突：${diagnostics.map((row) => `${row.path}:${row.lines.join(',')} ${row.field}`).join('; ')}`,
    );
    this.name = 'SourceConflictError';
  }
}
