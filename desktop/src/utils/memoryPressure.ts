export type MemoryPressure = 'unknown' | 'normal' | 'high' | 'critical';
export const PROCESS_TREE_PRIVATE_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
/** RSS/working set must never be substituted for private commit. */
export function privateMemoryPressure(bytes: number | null | undefined, available: boolean): MemoryPressure {
  if (!available || bytes == null || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const ratio = bytes / PROCESS_TREE_PRIVATE_LIMIT_BYTES;
  return ratio >= 0.9 ? 'critical' : ratio >= 0.8 ? 'high' : 'normal';
}
