/** The original first source establishes the coordinate anchor on both cold
 * and warm paths. Priority changes may only reorder the remaining sources. */
export function prioritizeIfcEntries<T extends {modelId: string; path: string}>(entries: readonly T[],
  sizes: ReadonlyMap<string, number>, connections: ReadonlySet<string>): T[] {
  if (!entries.length) return [];
  // A connection preview must not put a 452 MB source ahead of every small
  // building. Preserve connection priority within a bounded size class.
  const rank = (entry: T): number => (sizes.get(entry.path.toLowerCase()) ?? 0) > 64 * 1024 * 1024
    ? connections.has(entry.modelId)?2:3 : connections.has(entry.modelId)?0:1;
  return [entries[0], ...entries.slice(1).map((entry,index)=>({entry,index}))
    .sort((a,b)=>rank(a.entry)-rank(b.entry)||a.index-b.index).map(row=>row.entry)];
}
