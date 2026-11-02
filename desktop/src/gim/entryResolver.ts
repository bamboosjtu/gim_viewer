import { normalizeFilePath } from './fileLookup.js';

/** Resolve exporter references against archive facts. A basename is usable
 * only when globally unique; physical directories do not carry type meaning. */
export function createEntryResolver(paths: Iterable<string>): (reference: string, owner?: string) => string | null {
  const exact = new Map<string, string[]>(), bases = new Map<string, string[]>();
  const normalize = (value: string) => {
    const parts: string[] = [];
    for (const part of normalizeFilePath(value).split('/')) {
      if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/').toLowerCase();
  };
  for (const path of paths) for (const [map, key] of [[exact, normalize(path)], [bases, normalize(path).split('/').pop()!]] as const) {
    const values = map.get(key) ?? []; values.push(path); map.set(key, values);
  }
  return (reference, owner = '') => {
    const folder = normalizeFilePath(owner).split('/').slice(0, -1).join('/');
    for (const key of [...new Set([folder ? normalize(`${folder}/${reference}`) : normalize(reference), normalize(reference)])]) {
      const hits = exact.get(key); if (hits?.length) return hits.length === 1 ? hits[0] : null;
    }
    const hits = bases.get(normalize(reference).split('/').pop()!);
    return hits?.length === 1 ? hits[0] : null;
  };
}
