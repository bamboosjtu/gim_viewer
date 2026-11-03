import type { EngineeringSnapshot, EvidenceValue } from '../../engineering/types.js';
import type { CompositionDeclaration } from '../../engineering/composition.js';
import { canonicalBuildingName, declaredEngineeringComposition, type CompositionContextEvidence } from '../../engineering/compositionTemplate.js';
import type { EngineeringSources, EngineeringSpatialContext } from './buildSources.js';

/** File/placement hints belong to source adaptation and spatial refinement,
 * rather than the format-neutral composition template. */
export interface SourceCompositionEvidence extends CompositionContextEvidence {
  sourceHints?: string[];
  positions?: number[][];
}

/** Adapt only declared source context and real composition/association edges.
 * Domain mapping receives no F labels, file hierarchy depth, viewer or bounds. */
export function collectCompositionEvidence(sources: EngineeringSources, snapshot: EngineeringSnapshot,
  spatial: ReadonlyMap<string, EngineeringSpatialContext>): SourceCompositionEvidence[] {
  const records = new Map([...sources.graph.records, ...sources.ifcRecords].map(record => [record.id, record]));
  const cbm = new Map(sources.graph.cbmOccurrences.map(node => [node.id, node]));
  const docs = new Map(sources.graph.documents.map(doc => [doc.path, doc]));
  type Declaration = CompositionContextEvidence['declarations'][number];
  const declarations = new Map<string, Declaration[]>();
  function context(key: string): Declaration[] {
    const old = declarations.get(key); if (old) return old;
    const node = cbm.get(key); if (!node) return [];
    const fields = docs.get(node.documentPath)?.fields ?? [];
    const names: EvidenceValue[] = fields.filter(field => /^SYSTEMNAME\d+$/i.test(field.keys[0]))
      .sort((a,b) => Number(a.keys[0].match(/\d+$/)![0])-Number(b.keys[0].match(/\d+$/)![0]))
      .map(field => ({value:field.value,evidenceId:`${node.documentPath}:${field.line}`}));
    if (!names.some(name => name.value.trim() && !name.value.startsWith('&'))) for (const field of fields.filter(field => /^(?:NAME|PARTNAME)$/i.test(field.keys[0])))
      if (/系统|配电装置|间隔|楼|栋|房|室|构架|电缆沟/.test(field.value)) names.push({value:field.value,evidenceId:`${node.documentPath}:${field.line}`});
    const result = [...(node.parentId ? context(node.parentId) : []), ...(names.length ? [{names}] : [])];
    declarations.set(key,result); return result;
  }
  const cbmBySource = new Map<string, Set<string>>();
  function link(sourceId:string, occurrence:string):void {const keys=cbmBySource.get(sourceId)??new Set();keys.add(occurrence);cbmBySource.set(sourceId,keys);}
  for (const record of sources.graph.records) for (const key of record.context) if (cbm.has(key)) link(record.id,key);
  for (const alias of sources.graph.aliases) if (alias.status==='confirmed') for (const source of alias.candidates) link(source,alias.sourceId);
  for (const match of sources.ifcMatches) if (match.status==='confirmed') for (const source of match.ifcSourceIds) link(source,match.cbmOccurrenceId);
  const sourceContexts = new Map<string, Declaration[]>();
  function sourceContext(id:string, active=new Set<string>()):Declaration[] {
    const old=sourceContexts.get(id);if(old)return old;if(active.has(id))return [];
    const record=records.get(id);if(!record)return [];
    const keys=cbmBySource.get(id), next=new Set(active);next.add(id);
    const result=keys?.size ? [...keys].map(key=>({names:context(key).flatMap(declaration=>declaration.names)})) : record.parent ? sourceContext(record.parent,next) : [];
    sourceContexts.set(id,result);return result;
  }
  const spaces = new Map<string, CompositionContextEvidence['spaces']>();
  function sourceSpaces(id:string):CompositionContextEvidence['spaces'] {
    const old=spaces.get(id);if(old)return old;
    const result:CompositionContextEvidence['spaces']=[];
    for(const key of records.get(id)?.context??[]) {
      const seen=new Set<string>(), floors:EvidenceValue[]=[];let cursor:string|null=key;
      while(cursor&&!seen.has(cursor)) {
        seen.add(cursor);const node=spatial.get(cursor);if(!node)break;
        const declared=node.longName||node.name;
        const usable=!!declared&&!/总平面|Default Building|^(?:Building|Storey|Project|Site|建筑|模型\s*\d*)$/i.test(declared.trim())&&!declared.startsWith('&');
        // IFC building names are frequently exporter placeholders such as
        // "总平面"/"Default Building"; the delivery file name is a valid
        // source-backed fallback, but only when it names a building.
        const value={value:canonicalBuildingName(declared)||(usable?declared:'')||canonicalBuildingName(node.sourcePath)||declared,evidenceId:`${node.sourcePath}#${node.expressId}`,...(node.elevationMetres!==undefined?{elevationMetres:node.elevationMetres}:{})};
        if(node.kind==='storey')floors.unshift(value);
        if(node.kind==='building'){result.push({building:value,storeys:floors});break;}
        cursor=node.parentKey;
      }
    }
    spaces.set(id,result);return result;
  }
  const owners=new Map(snapshot.memberships.map(member=>[member.sourceId,member.ownerId]));
  const locations=new Map((sources.locations??[]).map(row=>[row.sourceId,row.position]));
  const relationships=new Map<string,string[]>();
  for(const relation of snapshot.relationships){const ids=relationships.get(relation.from)??[];ids.push(relation.to);relationships.set(relation.from,ids);}
  const availableBuildings:EvidenceValue[]=[];
  const seenBuildings=new Set<string>();
  for(const record of sources.ifcRecords) for(const path of record.sources){
    const value=canonicalBuildingName(path);
    if(value&&!seenBuildings.has(value)){seenBuildings.add(value);availableBuildings.push({value,evidenceId:path});}
  }
  const evidence:SourceCompositionEvidence[]=snapshot.entities.map(entity=>{
    const declarations=new Map<string,Declaration>(), ownSpaces=new Map<string,CompositionContextEvidence['spaces'][number]>(), hostIds=new Set(relationships.get(entity.id)??[]);
    for(const id of entity.sourceIds) {
      for(const declaration of sourceContext(id)) declarations.set(declaration.names.map(name=>name.evidenceId).join('|'),declaration);
      for(const space of sourceSpaces(id))ownSpaces.set([space.building.evidenceId,...space.storeys.map(f=>f.evidenceId)].join('|'),space);
      let parent=records.get(id)?.parent;const seen=new Set<string>();
      while(parent&&!seen.has(parent)){seen.add(parent);const owner=owners.get(parent);if(owner&&owner!==entity.id){hostIds.add(owner);break;}parent=records.get(parent)?.parent;}
    }
    const tracks = new Set(entity.sourceIds.map(id => records.get(id)?.track).filter((track): track is 'dev' | 'ifc' => !!track));
    const sourceHints=[...new Set(entity.sourceIds.flatMap(id=>records.get(id)?.sources??[]))];
    return {entityId:entity.id,declarations:[...declarations.values()],spaces:[...ownSpaces.values()],hostEntityIds:[...hostIds],
      sourceHints,deliveryBuildingNames:sourceHints.flatMap(path=>{const value=canonicalBuildingName(path);return value?[{value,evidenceId:path}]:[];}),
      availableBuildings,
      positions:entity.sourceIds.flatMap(id=>locations.has(id)?[locations.get(id)!]:[]),
      track: tracks.size === 1 ? [...tracks][0] : 'mixed'};
  });
  return evidence;
}

export function collectDeclaredCompositionContexts(sources: EngineeringSources): CompositionDeclaration[] {
  const docs = new Map(sources.graph.documents.map(doc => [doc.path, doc]));
  return declaredEngineeringComposition(sources.graph.cbmOccurrences.map(occurrence => ({ contextId: occurrence.id,
    names: (docs.get(occurrence.documentPath)?.fields ?? []).filter(field => /^SYSTEMNAME\d+$/i.test(field.keys[0]))
      .sort((a,b) => Number(a.keys[0].match(/\d+$/)![0])-Number(b.keys[0].match(/\d+$/)![0]))
      .map(field => ({ value: field.value, evidenceId: `${occurrence.documentPath}:${field.line}` })),
  })));
}
