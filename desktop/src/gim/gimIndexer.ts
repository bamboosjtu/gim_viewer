import type { IfcEntry, CbmNode } from './types.js';
import {readCbmSourceDocument}from'./cbmDocument.js';
import {getFileEntryIndex} from './entryResolver.js';
import {sourceScalarProperties,sourceReferenceFields} from './sourceDocument.js';
import { PARSER_LIMITS, parseBoundedCount } from '@gim/powerline-core/parserLimits.js';

import {
  createIfcModelId,
  normalizeEntryPath,
  normalizedIfcBasename,
  stripIfcExtension,
} from './modelIdentity.js';
import { getFirstNonEmptyKv, isGimEmptyValue } from './gimValueSemantics.js';

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
  if(isGimEmptyValue(ref))return {kind:'not-found'};
  const normalized=normalizeEntryPath(ref),index=getFileEntryIndex(files);
  const candidates=[...(normalized.includes('/')?index.exactCandidates(ref):index.basenameCandidates(ref))]
    .filter(path=>normalizeEntryPath(path).endsWith('.ifc'));
  return candidates.length===1?{kind:'resolved',path:candidates[0]}:candidates.length?{kind:'ambiguous',candidates}:{kind:'not-found'};
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
  const index=getFileEntryIndex(files),visited=new Set<string>(),found=new Map<string,IfcEntry>();
  const ambiguous=(key:string)=>console.warn('[GIM] CBM 引用槽存在冲突，保留来源诊断且不猜测:',key);
  async function walk(path:string,depth=0):Promise<void> {
    if(depth>PARSER_LIMITS.maxRecursionDepth)throw Error('CBM IFC 引用递归深度超过安全上限');
    const key=normalizeEntryPath(path);if(visited.has(key))return;visited.add(key);
    if(visited.size>PARSER_LIMITS.maxCbmNodes)throw Error('CBM IFC 节点数超过安全上限');
    const file=files.get(path);if(!file)return;
    let doc:Awaited<ReturnType<typeof readCbmSourceDocument>>;
    try {doc=await readCbmSourceDocument(file,path);}catch(error){console.warn('[GIM] CBM IFC 来源读取失败，保留其他来源:',path,error);return;}
    const props=sourceScalarProperties(doc);
    parseBoundedCount(getFirstNonEmptyKv(props,['IFC.NUM']),'IFC.NUM');
    parseBoundedCount(getFirstNonEmptyKv(props,['SUBSYSTEMS.NUM']),'SUBSYSTEMS.NUM');
    for(const field of sourceReferenceFields(doc,/^IFC\d+$/,ambiguous)) {
      const ref=field.value;if(isGimEmptyValue(ref))continue;
      const resolved=resolveIfcPath(files,ref);
      if(resolved.kind==='ambiguous')console.warn('[GIM] IFC 引用存在多个候选:',ref,resolved.candidates);
      if(resolved.kind==='not-found'){console.warn('[GIM] CBM 引用的 IFC 文件不存在:',ref);continue;}
      for(const actual of resolved.kind==='resolved'?[resolved.path]:resolved.candidates) {
        const name=stripIfcExtension(actual.replace(/\\/g,'/').split('/').pop()!);
        found.set(normalizeEntryPath(actual),{path:actual,name,modelId:createIfcModelId(actual)});
      }
    }
    for(const field of sourceReferenceFields(doc,/^SUBSYSTEM(?:\d+)?$/,ambiguous)) {
      if(isGimEmptyValue(field.value))continue;
      const candidates=index.candidates(field.value,path);
      if(candidates.length===1)await walk(candidates[0],depth+1);
      else if(candidates.length>1)console.warn('[GIM] CBM 子系统引用存在多个候选:',field.value,candidates);
    }
  }
  const roots=index.basenameCandidates('project.cbm');
  if(roots.length===1)await walk(roots[0]);
  else if(roots.length>1)console.warn('[GIM] 工程 CBM 入口不唯一:',roots);
  // Retain all delivered IFCs even when a CBM is missing, ambiguous or unreadable.
  for(const entry of scanIfcFiles(files))if(!found.has(normalizeEntryPath(entry.path)))found.set(normalizeEntryPath(entry.path),entry);
  return [...found.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.path.localeCompare(b.path));
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
        index.set(`${modelId}:${n.ifcGuid}`, n);
      }
    }
    for (const child of n.children) walk(child);
  }
  if (node) walk(node);
  return index;
}
