import type { CbmNode, IfcEntry } from '../gim/types.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import { isRegionalConnectionObject } from '../shared/ifcConnectionEvidence.js';
import { LARGE_IFC_BYTES } from '../config/features.js';
import { getFileByPath } from '../gim/fileLookup.js';

/** The original first source establishes the coordinate anchor on both cold
 * and warm paths. Priority changes may only reorder the remaining sources. */
export function prioritizeIfcEntries<T extends { modelId: string; path: string }>(
  entries: readonly T[],
  sizes: ReadonlyMap<string, number>,
  connections: ReadonlySet<string>,
): T[] {
  if (!entries.length) return [];
  // A connection preview must not put a 452 MB source ahead of every small
  // building. Preserve connection priority within a bounded size class.
  const rank = (entry: T): number =>
    (sizes.get(entry.path.toLowerCase()) ?? 0) > LARGE_IFC_BYTES
      ? connections.has(entry.modelId)
        ? 2
        : 3
      : connections.has(entry.modelId)
        ? 0
        : 1;
  return [
    entries[0],
    ...entries
      .slice(1)
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
      .map((row) => row.entry),
  ];
}
export function planSubstationIfcLoad(
  entries: readonly IfcEntry[],
  sourceSizes: ReadonlyMap<string, number> | undefined,
  cbm: CbmNode | null,
  skipLarge: boolean,
  files?: Map<string, File> | null,
) {
  const sizes = new Map(sourceSizes);
  if (files) {
    for (const entry of entries) {
      const file = getFileByPath(files, entry.path);
      if (file) sizes.set(entry.path.toLowerCase(), file.size);
    }
  }
  const evidencedConnections = new Set<string>();
  function visit(node: CbmNode): void {
    if (
      node.ifcFile &&
      node.ifcGuid &&
      isRegionalConnectionObject({ ifcType: 'IFCBUILDINGELEMENTPROXY', name: node.name })
    ) {
      const modelId = resolveIfcModelId(node.ifcFile, entries);
      if (modelId) evidencedConnections.add(modelId);
    }
    node.children.forEach(visit);
  }
  if (cbm) visit(cbm);

  const isConnection = (entry: IfcEntry) =>
    evidencedConnections.has(entry.modelId) ||
    /接线|连接线|软导|导线|wire|cable/i.test(`${entry.name} ${entry.path}`);
  const kept = [...entries];
  const skippedLargeIfc: Array<{ path: string; bytes: number }> = [];
  if (skipLarge) {
    for (let i = kept.length - 1; i > 0; i--) {
      const { path } = kept[i];
      const bytes = sizes.get(path.toLowerCase()) ?? 0;
      if (isConnection(kept[i]) || bytes <= LARGE_IFC_BYTES) continue;
      skippedLargeIfc.push({ path, bytes });
      kept.splice(i, 1);
    }
  }
  const connections = new Set(kept.filter(isConnection).map((entry) => entry.modelId));
  return {
    queue: prioritizeIfcEntries(kept, sizes, connections),
    skippedLargeIfc,
    evidencedConnections,
    hasConnections: connections.size > 0,
    sizes,
  };
}
