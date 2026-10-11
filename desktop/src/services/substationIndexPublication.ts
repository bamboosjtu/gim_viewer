import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';
import type { GimIndexPayload, GeometryRefsPayload } from '@desktop/database.js';
import { buildGimIndexPayload, buildGeometryRefsPayload } from './gimIndexPersistenceService.js';

interface PublicationInput {
  projectId: number;
  sourceSha256: string;
  files: Map<string, File>;
  cachePaths: Map<string, string>;
  tree: CbmNode | null;
  ifcs: IfcEntry[];
  relations: FileDevEntry[];
}
interface PublicationDependencies {
  isCurrent(): boolean;
  saveIndex(payload: GimIndexPayload): Promise<void>;
  saveRefs(payload: GeometryRefsPayload): Promise<void>;
  validate(): Promise<{ substation_semantic_cache_valid: boolean }>;
  onPhase?(phase: string, counts?: Record<string, number>): void;
}

/** Publish the existing semantic + reference transactions, independently of
 * DEV compilation, IFC Preview, Spatial, and Fragments. Native extraction
 * supplies cachePaths directly; the fallback must finish source writes first.
 */
export async function publishSubstationIndex(input: PublicationInput, deps: PublicationDependencies): Promise<boolean> {
  const current = () => deps.isCurrent();
  if (!current()) return false;
  if (!input.sourceSha256 || input.projectId <= 0 || !input.tree || !input.ifcs.length) {
    throw new Error('变电索引缺少完整源身份或语义入口');
  }
  const paths = new Map([...input.cachePaths].map(([path,value]) => [path.replace(/\\/g,'/').toLowerCase(),value]));
  for (const [path] of input.files) {
    if (/\.(ifc|cbm|fam|dev|phm|mod|gl|stl|sch|std|sld)$/i.test(path) && !paths.get(path.replace(/\\/g,'/').toLowerCase())) {
      throw new Error(`源文件尚未完成缓存，拒绝发布语义索引: ${path}`);
    }
  }
  // Bounded small-text reads, shared only for this publication. Never read
  // IFC bytes here. This also prevents an unreadable FAM/DEV from becoming
  // silently omitted properties through the permissive interactive builders.
  deps.onPhase?.('sourceTextStart');
  const prepared = new Map(input.files);
  const candidates = [...input.files].filter(([path]) => /\.(cbm|fam|dev|phm)$/i.test(path));
  for (let offset=0; offset<candidates.length; offset+=32) {
    if (!current()) return false;
    const chunk = candidates.slice(offset,offset+32);
    const texts = await Promise.all(chunk.map(([,file]) => file.text()));
    if (!current()) return false;
    chunk.forEach(([path,file],i) => prepared.set(path,new Proxy(file,{
      get(target,key) {
        if (key === 'text') return async () => texts[i];
        const value = Reflect.get(target,key,target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
  }
  deps.onPhase?.('sourceTextReady',{files:candidates.length});
  const index = await buildGimIndexPayload(input.projectId,prepared,input.ifcs,input.tree,input.relations,input.cachePaths,input.sourceSha256);
  const refs = await buildGeometryRefsPayload(input.projectId,prepared,input.sourceSha256);
  if (!current()) return false;
  deps.onPhase?.('saveIndexStart');
  await deps.saveIndex(index);
  if (!current()) return false;
  deps.onPhase?.('saveIndexReady',{entries:index.entries.length,cbm:index.cbm_nodes.length,fam:index.fam_properties.length,dev:index.dev_properties.length,relations:index.file_dev_entries.length,ifc:index.ifc_models.length});
  await deps.saveRefs(refs); // Existing final parser-version commit.
  if (!current()) return false;
  const validation = await deps.validate();
  if (!current()) return false;
  if (!validation.substation_semantic_cache_valid) throw new Error('变电语义索引发布后有效性校验失败');
  deps.onPhase?.('semanticCacheValid');
  return true;
}
