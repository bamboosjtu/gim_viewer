export function chunkCandidates<T extends { file: Pick<File, 'size'> }>(
  candidates: T[],
  maxFiles: number,
  maxBytes: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const candidate of candidates) {
    const size = Math.max(0, candidate.file.size || 0);
    if (current.length > 0 && (current.length >= maxFiles || currentBytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(candidate);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function buildBatchByteLookup(
  result: Map<string, Uint8Array | null>,
): Map<string, Uint8Array | null> {
  const normalized = new Map<string, Uint8Array | null>();
  for (const [candidatePath, bytes] of result) {
    const key = candidatePath.replace(/\\/g, '/').toLowerCase();
    if (!normalized.has(key)) normalized.set(key, bytes);
  }
  return normalized;
}

export function lookupBatchBytes(
  result: Map<string, Uint8Array | null>,
  normalizedResult: Map<string, Uint8Array | null>,
  path: string,
): Uint8Array | null | undefined {
  const exact = result.get(path);
  if (exact !== undefined || result.has(path)) return exact;
  const key = path.replace(/\\/g, '/').toLowerCase();
  return normalizedResult.get(key);
}
