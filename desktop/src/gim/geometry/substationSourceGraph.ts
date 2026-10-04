import { parseDev } from './devParser.js';
import { parsePhm } from './phmParser.js';
import { PARSER_LIMITS } from '../parserLimits.js';
import { getFileByPath } from '../fileLookup.js';

export function geometryTargetPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('/')) return normalized;
  const prefix = /\.dev$/i.test(normalized) ? 'DEV' : /\.phm$/i.test(normalized) ? 'PHM' : 'MOD';
  return `${prefix}/${normalized}`;
}

/** Source hydration only. Placement/colour remain on parser edges and are consumed by discovery.
 * Batch breadth traversal supports both automatic and click-time cache fallback.
 * An absent sibling does not hide the remaining reachable sources. */
export async function hydrateSubstationGeometryGraph(
  devPaths: readonly string[],
  readFiles: (paths: string[]) => Promise<ReadonlyMap<string, File>>,
): Promise<Map<string, File>> {
  const files = new Map<string, File>();
  const seen = new Set<string>();
  let pending = devPaths.map((path) => ({ path: geometryTargetPath(path), depth: 0 }));
  while (pending.length > 0) {
    const batch = pending.filter(({ path }) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    pending = [];
    if (seen.size > PARSER_LIMITS.maxGeometryQueue) throw new Error('缓存几何引用队列超过安全上限');
    if (!batch.length) break;
    if (batch.some(({ depth }) => depth > PARSER_LIMITS.maxRecursionDepth)) throw new Error('缓存几何递归深度超过安全上限');
    const loaded = new Map<string, File>();
    for (let start = 0; start < batch.length; start += 256) {
      const chunk = await readFiles(batch.slice(start, start + 256).map(({ path }) => path));
      for (const [path, file] of chunk) loaded.set(path, file);
    }
    for (const [path, file] of loaded) files.set(path, file);
    for (const { path, depth } of batch) {
      const file = getFileByPath(loaded, path);
      if (!file) continue;
      try {
        let targets: string[] = [];
        if (/\.dev$/i.test(path)) {
          const doc = parseDev(await file.text(), path);
          targets = [...doc.solidModels.map((s) => s.solidModelPath), ...doc.subDevices.map((s) => s.devPath)];
        } else if (/\.phm$/i.test(path)) {
          targets = parsePhm(await file.text(), path).solidModels.map((s) => s.solidModelPath);
        }
        for (const target of targets) {
          if (/\.(dev|phm|mod|stl|gl)$/i.test(target)) pending.push({ path: geometryTargetPath(target), depth: depth + 1 });
        }
      } catch { /* This source is diagnosed by strict compilation/discovery, siblings remain available. */ }
    }
  }
  return files;
}
