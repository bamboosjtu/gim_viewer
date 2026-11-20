/**
 * Desktop FileDevRelation source adapter.
 *
 * Text parsing (vendor spellings/declarations) lives in the gim-sdk parser.
 * This layer owns file discovery, path resolution, duplicate-basename policy
 * and runtime model IDs.
 */
import type { FileDevEntry } from './types.js';
import { parseFileDevRelationText } from '@gim/gim-sdk/parser';
import { getFileEntryResolver } from './entryResolver.js';
import { createIfcModelId } from './modelIdentity.js';
import { resolveIfcPath } from './gimIndexer.js';
import { logger } from '../utils/logger.js';

export async function parseFileDevRelation(files: Map<string, File>): Promise<FileDevEntry[]> {
  const path = getFileEntryResolver(files)('FileDevRelation.cbm');
  const f = path ? files.get(path) : undefined;
  if (!f) return [];
  const parsed = parseFileDevRelationText(await f.text(), path ?? f.name);
  const records = parsed.value?.entries ?? [];
  const entries: FileDevEntry[] = [];
  for (const record of records) {
    const resolvedIfc = /\.ifc$/i.test(record.ifcFile)
      ? resolveIfcPath(files, record.ifcFile)
      : { kind: 'not-found' as const };
    const referenceConflict = record.diagnostics.some(
      (row) => row.field === `FILE${record.index}.IFC` || row.field === `FILE${record.index}.NAME`,
    );
    const modelId =
      !referenceConflict && resolvedIfc.kind === 'resolved'
        ? createIfcModelId(resolvedIfc.path)
        : '';
    if (resolvedIfc.kind === 'ambiguous') {
      logger.warn(
        '[GIM] FileDevRelation IFC 引用存在重复 basename，跳过模型关联:',
        record.ifcFile,
        resolvedIfc.candidates,
      );
    }
    entries.push({
      sourceDesignFile: record.name,
      ifcName: record.ifcName,
      ifcFile: record.ifcFile,
      modelId,
      deviceCount: record.deviceCount,
      deviceCbms: record.deviceCbms,
      ...(record.diagnostics.length ? { sourceDiagnostics: [...record.diagnostics] } : {}),
    });
  }
  return entries;
}
