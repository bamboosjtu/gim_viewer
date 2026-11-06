import { normalizeFilePath } from './fileLookup.js';

export type EntryResolver = (reference: string, owner?: string) => string | null;

const fileResolvers = new WeakMap<ReadonlyMap<string, unknown>, { size: number; resolve: EntryResolver }>();

/** Extracted file maps have stable entry keys; hydration only replaces values.
 * Reuse their path index across tree/DEV traversal, geometry and properties.
 * A new source map or a changed entry count builds a new index. */
export function getFileEntryResolver(files: ReadonlyMap<string, unknown>): EntryResolver {
  const cached = fileResolvers.get(files);
  if (cached?.size === files.size) return cached.resolve;
  const resolve = createEntryResolver(files.keys());
  fileResolvers.set(files, { size: files.size, resolve });
  return resolve;
}

/** Resolve exporter references against archive facts. A basename is usable
 * only when globally unique; physical directories do not carry type meaning. */
export function createEntryResolver(paths: Iterable<string>): EntryResolver {
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
