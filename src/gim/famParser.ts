/** 解析 FAM 文件中的分节属性 */
export function parseFamSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let cur = '默认';
  let map = new Map<string, string>();
  sections.set(cur, map);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; map = new Map(); sections.set(cur, map); continue; }
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      const eq2 = val.indexOf('=');
      if (eq2 > 0) val = val.slice(eq2 + 1).trim();
      map.set(key, val);
    }
  }
  return sections;
}
