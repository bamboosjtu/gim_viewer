import type { CbmNode } from './types.js';
import { buildSubstationAliasIndex, discoverSubstationGlSidecars, devAssemblyPath, deviceOccurrenceScope } from './substationEvidence.js';
import { parseWorkerXmlMod } from './geometry/xmlModWorkerParser.js';
import { normalizeConnectionPointGuid } from './connectionEndpoints.js';

export interface GlConnectionPortOwner {
  key: string;
  nodePath: string;
  rootOccurrence: string;
  assemblyPath: string;
  devIdentity: string;
  glPath: string;
  entityId: string;
  phase: string;
  localMatrix: readonly number[];
}
/** A same-UUID sidecar only authorizes its own DEV occurrences. Shared port
 * UUIDs remain multiple candidates; no global DEV or distance fallback. */
export class GlConnectionPortIndex {
  readonly byGuid = new Map<string, GlConnectionPortOwner[]>();
  readonly diagnostics = {files:0,ports:0,guids:0,unlinked:0,failed:0};
  constructor(root: CbmNode | null, paths: readonly string[], texts: ReadonlyMap<string,string>) {
    const nodes=new Map<string,CbmNode>();
    const visit=(node:CbmNode):void=>{nodes.set(node.path,node);node.children.forEach(visit);};if(root)visit(root);
    let aliases:ReturnType<typeof buildSubstationAliasIndex>|undefined;
    for(const sidecar of discoverSubstationGlSidecars(paths,root)){
      const text=texts.get(sidecar.path);if(!text){this.diagnostics.failed++;continue;}
      try{
        const document=parseWorkerXmlMod(text,sidecar.path);this.diagnostics.files++;
        for(const entity of document.entities){
          if(entity.primitive.type!=='Unsupported'||entity.primitive.sourceType!=='GimGeCableConcentration')continue;
          const attrs=entity.primitive.raw,guid=normalizeConnectionPointGuid(attrs.ConnectGuid);if(!guid)continue;
          this.diagnostics.ports++;
          const owners=this.byGuid.get(guid)??[];
          for(const semanticPath of sidecar.semanticPaths){
            const node=nodes.get(semanticPath);if(!node)continue;
            if(node.entityName.toUpperCase()==='PARTINDEX')aliases??=buildSubstationAliasIndex(root);
            const scope=deviceOccurrenceScope(root,node,aliases);
            for(const assemblyPath of scope.assemblyPaths??['']){
              const actual=aliases?.partToOccurrences.get(node.path)?.find(candidate=>devAssemblyPath(candidate.path)===assemblyPath)??node;
              const key=`${scope.rootOccurrence}|${assemblyPath}`;
              if(owners.some(owner=>owner.key===key&&owner.glPath===sidecar.path&&owner.entityId===String(entity.id)))continue;
              owners.push({key,nodePath:actual.path,rootOccurrence:scope.rootOccurrence,assemblyPath,devIdentity:sidecar.devIdentity,
                glPath:sidecar.path,entityId:String(entity.id),phase:String(attrs.Phase??''),localMatrix:entity.transformMatrix});
            }
          }
          if(!owners.length)this.diagnostics.unlinked++;
          this.byGuid.set(guid,owners);
        }
      }catch{this.diagnostics.failed++;}
    }
    this.diagnostics.guids=this.byGuid.size;
  }
  get(guid:string):readonly GlConnectionPortOwner[]{return this.byGuid.get(normalizeConnectionPointGuid(guid)??'')??[];}
}
