import { logger } from '../utils/logger.js';
/** Desktop SCH entry discovery. The index grammar lives in the SDK parser. */
import { parseSch, type SchEntry } from '@gim/gim-sdk/parser';
import { getFileEntryIndex } from './entryResolver.js';
import { readCbmSourceDocument } from './cbmDocument.js';
import { SourceConflictError, sourceDiagnostic, sourceScalar } from './sourceDocument.js';
import { getFirstNonEmptyKv } from './gimValueSemantics.js';
import type { CbmNode } from './types.js';

export { parseSch, type SchEntry, type SchEntryType } from '@gim/gim-sdk/parser';

export interface SchematicEntry extends SchEntry {
  /** Actual archive entry, null for a missing or ambiguous reference. */
  matchedPath: string | null;
}

export async function discoverStdSldFromSCH(
  files: Map<string, File>,
  root?: CbmNode | null,
): Promise<SchematicEntry[]> {
  const index = getFileEntryIndex(files);
  const rootPath = root?.path ?? index.resolve('project.cbm') ?? '';
  const rootFile = files.get(rootPath);
  let declared = '';
  if (root?.rawProperties) {
    const conflicts = root.sourceDiagnostics?.filter(
      (diagnostic) => diagnostic.field.toUpperCase() === 'SCH',
    );
    if (conflicts?.length) throw new SourceConflictError(conflicts);
    declared = getFirstNonEmptyKv(root.rawProperties, ['SCH']);
  } else if (rootFile) {
    const document = await readCbmSourceDocument(rootFile, rootPath);
    const field = sourceScalar(document, 'SCH');
    if (field.status === 'ambiguous') {
      throw new SourceConflictError([sourceDiagnostic(document, 'SCH', field.fields)]);
    }
    declared = getFirstNonEmptyKv({ SCH: field.value }, ['SCH']);
  }

  const reference = declared || 'project.sch';
  const candidates = index.candidates(reference, rootPath);
  if (candidates.length > 1) {
    throw new SourceConflictError([
      {
        kind: 'ambiguous-field',
        path: rootPath,
        field: 'SCH',
        lines: [],
        values: [...candidates],
      },
    ]);
  }
  const path = candidates[0];
  const file = files.get(path);
  if (!file) {
    if (declared) logger.warn(`[SCH] 根 CBM 引用的入口不存在: ${declared}`);
    return [];
  }
  return parseSch(await file.text(), path).map((entry) => {
    const matchedPath = index.resolve(entry.filename, path);
    return { ...entry, path: matchedPath ?? entry.path, matchedPath };
  });
}
