import { getFileByPath } from './fileLookup.js';
import { parseKeyValue } from './kvParser.js';

/** Device packages have a semantic Device entry, not an F1–F4 project tree.
 * Directory casing and the exporter/vendor are not classification signals. */
export async function findEquipmentEntry(files: Map<string, File>, readText: (file: File) => Promise<string> = file => file.text()): Promise<string | null> {
  const entries = [...files].filter(([path]) => /\.cbm$/i.test(path));
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
    if (!/\.(cbm|dev|fam)$/i.test(path)) continue;
    const bytes = await file.arrayBuffer();
    if (!isCurrent()) return prepared;
    const text = decodeEquipmentText(bytes);
    prepared.set(path, new File([text], file.name, { type: file.type, lastModified: file.lastModified }));
  }
  return prepared;
}
