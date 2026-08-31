import type { IfcEntry, CbmNode } from './types.js';
import { parseKeyValue } from './cbmParser.js';
import { PARSER_LIMITS, parseBoundedCount } from './parserLimits.js';
import { getFileByPath, hasFileByPath } from './fileLookup.js';
import {
  createIfcModelId,
  normalizeEntryPath,
  normalizedIfcBasename,
  stripIfcExtension,
} from './modelIdentity.js';

/**
 * 解析 CBM IFC 引用值的实际路径。
 *
 * IFC 文件位置随导出软件而异（JinQu 在 DEV/，Bentley 在 CBM/），
 * CBM 中 IFC0..N 只写裸文件名。解析顺序：常见目录拼接 → 全局 basename
 * 大小写不敏感匹配。重复 basename 不猜测，返回 ambiguous 供调用方记录。
 */
export type IfcPathResolveResult =
  | { kind: 'resolved'; path: string }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; candidates: string[] };

export function resolveIfcPath(files: Map<string, File>, ref: string): IfcPathResolveResult {
  const normalizedRef = normalizeEntryPath(ref);
  if (!normalizedRef) return { kind: 'not-found' };

  // 保留 Map 的真实键；后续解析会直接 `files.get(entry.path)`，不能把
  // Windows 反斜杠键只转换成展示用的正斜杠而丢失可读性/可访问性。
  const allPaths = Array.from(files.keys());
  const exactCandidates = allPaths.filter((path) => normalizeEntryPath(path) === normalizedRef);
  if (normalizedRef.includes('/')) {
    if (exactCandidates.length === 1) return { kind: 'resolved', path: exactCandidates[0] };
    if (exactCandidates.length > 1) return { kind: 'ambiguous', candidates: exactCandidates };
    return { kind: 'not-found' };
  }

  // 裸文件名可能同时出现在 DEV/、CBM/ 或其他目录。即使 DEV/ 是常见布局，
  // 也不能按目录顺序猜测，否则两个同名 IFC 会串联到错误模型。
  const refLower = normalizedIfcBasename(ref);
  const basenameCandidates = allPaths.filter((path) => {
    if (!normalizeEntryPath(path).endsWith('.ifc')) return false;
    return normalizedIfcBasename(path) === refLower;
  });
  if (basenameCandidates.length === 1) return { kind: 'resolved', path: basenameCandidates[0] };
  if (basenameCandidates.length > 1) return { kind: 'ambiguous', candidates: basenameCandidates };
  return { kind: 'not-found' };
}

/** 扫描全部目录下的 IFC 文件（兼容 DEV/、CBM/ 等不同导出布局） */
export function scanIfcFiles(files: Map<string, File>): IfcEntry[] {
  const entries: IfcEntry[] = [];
  for (const [path] of files) {
    const normalized = normalizeEntryPath(path);
    if (normalized.endsWith('.ifc')) {
      const fn = path.replace(/\\/g, '/').split('/').pop()!;
      entries.push({ name: stripIfcExtension(fn), path, modelId: createIfcModelId(path) });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.path.localeCompare(b.path));
}

/** 从 CBM 层级递归发现 IFC 文件引用 */
export async function discoverIfcFromCBM(files: Map<string, File>): Promise<IfcEntry[]> {
  const visited = new Set<string>();
  const ifcSet = new Map<string, IfcEntry>();
  const fileByLowerPath = new Map<string, File>();
  for (const [path, file] of files) fileByLowerPath.set(path.replace(/\\/g, '/').toLowerCase(), file);
  let visitedCount = 0;
  async function walk(p: string, depth = 0) {
    if (depth > PARSER_LIMITS.maxRecursionDepth) throw new Error(`CBM IFC 引用递归深度超过 ${PARSER_LIMITS.maxRecursionDepth}`);
    const normalized = p.replace(/\\/g, '/');
    const visitKey = normalized.toLowerCase();
    if (visited.has(visitKey)) return; visited.add(visitKey);
    visitedCount++;
    if (visitedCount > PARSER_LIMITS.maxCbmNodes) throw new Error(`CBM IFC 节点数超过安全上限 ${PARSER_LIMITS.maxCbmNodes}`);
    const f = getFileByPath(files, p) ?? fileByLowerPath.get(visitKey); if (!f) return;
    const kv = parseKeyValue(await f.text());
    const n = parseBoundedCount(kv['IFC.NUM'], 'IFC.NUM');
    for (let i = 0; i < n; i++) {
      const r = kv[`IFC${i}`];
      if (!r) continue;
      const nm = stripIfcExtension(r.split(/[\\/]/).pop() || r);
      const resolved = resolveIfcPath(files, r);
      if (resolved.kind === 'ambiguous') {
        console.warn('[GIM] IFC 引用存在重复 basename，保留全部候选但不猜测关联:', r, resolved.candidates);
        for (const candidate of resolved.candidates) {
          if (!normalizeEntryPath(candidate).endsWith('.ifc')) continue;
          const candidateName = candidate.replace(/\\/g, '/').split('/').pop() || candidate;
          ifcSet.set(normalizeEntryPath(candidate), {
            name: stripIfcExtension(candidateName),
            path: candidate,
            modelId: createIfcModelId(candidate),
          });
        }
      } else if (resolved.kind === 'resolved') {
        ifcSet.set(normalizeEntryPath(resolved.path), {
          name: nm,
          path: resolved.path,
          modelId: createIfcModelId(resolved.path),
        });
      } else {
        console.warn('[GIM] CBM 引用的 IFC 文件不存在:', r);
        // 不生成虚假的 IfcEntry：占位路径不在 GIM entry 清单中，若继续
        // 写入 substation_ifc_model 会让 SQLite 拒绝整份索引。原始 CBM
        // 引用仍保留在节点和诊断日志中，用户可据此定位缺失资源。
      }
    }
    const sn = parseBoundedCount(kv['SUBSYSTEMS.NUM'], 'SUBSYSTEMS.NUM');
    for (let i = 0; i < sn; i++) { const s = kv[`SUBSYSTEM${i}`]; if (s) await walk(`CBM/${s}`, depth + 1); }
    const sg = kv['SUBSYSTEM']; if (sg) await walk(`CBM/${sg}`, depth + 1);
  }
  const entry = hasFileByPath(files, 'CBM/project.cbm')
    ? 'CBM/project.cbm'
    : Array.from(files.keys()).find((path) => path.replace(/\\/g, '/').toLowerCase() === 'cbm/project.cbm');
  if (entry) await walk(entry);
  // CBM 引用清单可能不完整；补入包内未被引用的 IFC，确保同名文件也都可加载。
  for (const entry of scanIfcFiles(files)) {
    if (!ifcSet.has(normalizeEntryPath(entry.path))) ifcSet.set(normalizeEntryPath(entry.path), entry);
  }
  return Array.from(ifcSet.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.path.localeCompare(b.path));
}

/** 构建 IFCGUID → CbmNode 反向索引 */
export function buildIfcGuidIndex(node: CbmNode | null, ifcEntries: readonly import('./types.js').IfcEntry[] = []): Map<string, CbmNode> {
  const index = new Map<string, CbmNode>();
  function walk(n: CbmNode) {
    if (n.ifcGuid && n.ifcFile) {
      const exactMatches = ifcEntries.filter((entry) => normalizeEntryPath(entry.path) === normalizeEntryPath(n.ifcFile));
      // 同一规范化路径出现多条 entry 时也视为歧义；不能因为 find()
      // 的迭代顺序而把 GUID 绑定到任意一个模型。
      const exact = exactMatches.length === 1 ? exactMatches[0] : undefined;
      const byName = ifcEntries.filter((entry) =>
        normalizedIfcBasename(entry.path) === normalizedIfcBasename(n.ifcFile));
      const modelId = exact?.modelId || (byName.length === 1 ? byName[0].modelId : null);
      // 重复 basename 且 CBM 只给裸文件名时，拒绝建立可能串模的索引。
      if (modelId) {
        // 兼容旧 SQLite 索引中由 basename 生成的 model_id；新索引一律使用
        // ifc_<hash>，不会进入此分支。这样升级旧缓存时仍能读取诊断数据，
        // 而新工程不会重新引入同名冲突。
        const indexModelId = modelId.startsWith('ifc_') ? modelId : n.ifcFile;
        index.set(`${indexModelId}:${n.ifcGuid}`, n);
      }
    }
    for (const child of n.children) walk(child);
  }
  if (node) walk(node);
  return index;
}

// getNodeDisplayName / isPlaceholderName 已迁移至 shared/displayName.ts
// 此处保留 re-export 以兼容 viewer/highlight.ts 等已有导入
export { getNodeDisplayName } from '../shared/displayName.js';
