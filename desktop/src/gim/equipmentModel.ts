import { getFileByPath, findFileByPath } from './fileLookup.js';
import { parseKeyValue } from './kvParser.js';

/** Device packages have a semantic Device entry, not an F1–F4 project tree.
 * Directory casing and the exporter/vendor are not classification signals. */
export async function findEquipmentEntry(files: Map<string, File>, readText: (file: File) => Promise<string> = file => file.text()): Promise<string | null> {
  const entries = [...files].filter(([path]) => /\.cbm$/i.test(path));
  if (entries.length === 0) {
    // Some standalone archives start at DEV, without a CBM wrapper. Require
    // one connected assembly root; never choose an arbitrary library member.
    const devs = [...files].filter(([path]) => /\.dev$/i.test(path));
    if (!devs.length) return null;
    const resolve = (ref: string): string | null => {
      const exact = findFileByPath(files, ref);
      if (exact) return exact.path;
      const name = ref.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
      const matches = [...files.keys()].filter(p => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase() === name);
      return matches.length === 1 ? matches[0] : null;
    };
    const children = new Map<string, string[]>(), referenced = new Set<string>();
    let hasGeometry = false;
    for (const [path, file] of devs) {
      if (file.size > 256 * 1024) return null;
      const kv = parseKeyValue(await readText(file)), refs: string[] = [];
      for (const [key, value] of Object.entries(kv)) {
        if (/^SUBDEVICE\d+$/i.test(key) && value.trim()) {
          const target = resolve(value.trim());
          if (!target || !/\.dev$/i.test(target)) return null;
          refs.push(target); referenced.add(target);
        }
        if (/^SOLIDMODEL\d+$/i.test(key) && /\.(phm|mod|stl)$/i.test(value.trim()) && resolve(value.trim())) hasGeometry = true;
      }
      children.set(path, refs);
    }
    const roots = devs.map(([path]) => path).filter(path => !referenced.has(path));
    if (roots.length !== 1 || !hasGeometry) return null;
    const parents = new Map(devs.map(([path]) => [path, 0]));
    for (const refs of children.values()) for (const ref of refs) parents.set(ref, parents.get(ref)! + 1);
    const queue = [roots[0]];
    for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) {
      const count = parents.get(child)! - 1;
      parents.set(child, count);
      if (count === 0) queue.push(child);
    }
    return queue.length === devs.length ? roots[0] : null;
  }
  // Do not search a station's thousands of CBMs or select an arbitrary device
  // inside a project. A standalone package has one semantic entry.
  if (entries.length !== 1) return null;
  const [path, file] = entries[0];
  if (file.size > 256 * 1024) return null;
  const kv = parseKeyValue(await readText(file));
  if (kv.ENTITYNAME?.trim().toLowerCase() !== 'device') return null;
  const dev = kv.OBJECTMODELPOINTER?.trim();
  if (!dev) return null;
  if (getFileByPath(files, dev)) return path;
  const name = dev.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const matches = [...files.keys()].filter(p => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase() === name);
  return matches.length === 1 ? path : null;
}

/** UTF-8 first; the equipment corpus also contains legacy GBK text. Keep
 * source bytes on disk unchanged and normalize only the device runtime input. */
export function decodeEquipmentText(bytes: ArrayBuffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}

export async function prepareEquipmentFiles(files: Map<string, File>, isCurrent: () => boolean): Promise<Map<string, File>> {
  const prepared = new Map(files);
  for (const [path, file] of files) {
    if (!isCurrent()) return prepared;
    if (!/\.(cbm|dev|fam|phm)$/i.test(path)) continue;
    const bytes = await file.arrayBuffer();
    if (!isCurrent()) return prepared;
    const text = decodeEquipmentText(bytes);
    prepared.set(path, new File([text], file.name, { type: file.type, lastModified: file.lastModified }));
  }
  return prepared;
}
