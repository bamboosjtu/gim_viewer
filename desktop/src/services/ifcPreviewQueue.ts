import type { IfcEntry } from '../gim/types.js';
export type PreviewQueueStrategy = 'original' | 'conservative-fast-lane';
// Cross-sample source-size bins; hints only, never predicted conversion cost.
export const PREVIEW_SMALL_BYTES = 1024 * 1024;
export const PREVIEW_LARGE_BYTES = 64 * 1024 * 1024;
export function planRemainingIfcPreviews(entries: readonly IfcEntry[], sizes: ReadonlyMap<string, number>, strategy: PreviewQueueStrategy): IfcEntry[] {
  if (strategy === 'original' || entries.length < 2) return [...entries];
  const bucket = (entry: IfcEntry): number => {
    const bytes = sizes.get(entry.path.toLowerCase());
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return 1;
    return bytes < PREVIEW_SMALL_BYTES ? 0 : bytes >= PREVIEW_LARGE_BYTES ? 2 : 1;
  };
  // Anchor is fixed even when smaller sources exist. Stable within every bin.
  return [entries[0], ...entries.slice(1).map((entry, index) => ({entry,index}))
    .sort((a,b) => bucket(a.entry)-bucket(b.entry) || a.index-b.index).map(x => x.entry)];
}
