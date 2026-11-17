import type {CompositionEvidence} from '../../engineering/types.js';
import type {CbmOccurrence, EngineeringSourceGraph} from './sourceGraph.js';
import type {SourceRecord} from './sourceEvidence.js';

/** Format interpretation stops at this adapter; F levels do not participate. */
export function cbmRelationKind(field:string):'organization'|'composition'|undefined {
  if(/^SUBDEVICE\d+$/i.test(field))return 'composition';
  if(/^SUBSYSTEM\d*$/i.test(field))return 'organization';
  return undefined;
}

/** Indexed by occurrence, never by template, name or navigation depth. No IO. */
export function collectSourceComposition(graph:EngineeringSourceGraph,records:readonly SourceRecord[]):Map<string,CompositionEvidence[]> {
  const result=new Map<string,CompositionEvidence[]>();
  const byCbm=new Map<string,string[]>();
  const add=(cbm:string,source:string)=>{const ids=byCbm.get(cbm)??[];if(!ids.includes(source))ids.push(source);byCbm.set(cbm,ids);};
  for(const row of records) {
    if(row.parent)result.set(row.id,[{kind:row.track==='dev'?'physical_assembly':'object_decomposition',
      parentSourceIds:[row.parent],evidence:[`assembly:${row.parent}->${row.id}`],status:'confirmed'}]);
    if(row.attributeContextId)add(row.attributeContextId,row.id);
    if(row.devOccurrence&&!row.parent)add(row.devOccurrence.cbmOccurrenceId,row.id);
  }
  for(const alias of graph.aliases)if(alias.candidates.length)byCbm.set(alias.sourceId,[...alias.candidates]);
  const nodes=new Map(graph.cbmOccurrences.map(node=>[node.id,node]));
  const parentCache=new Map<string,string[]>();
  function parents(node:CbmOccurrence,branch=new Set<string>()):string[] {
    const cached=parentCache.get(node.id);if(cached)return cached;
    if(branch.has(node.id))return [];
    branch.add(node.id);
    const direct=byCbm.get(node.id);
    const ancestor=node.parentId?nodes.get(node.parentId):undefined;
    const ids=direct??(cbmRelationKind(node.viaField)==='composition'&&ancestor?parents(ancestor,branch):[]);
    parentCache.set(node.id,ids);return ids;
  }
  for(const node of graph.cbmOccurrences) {
    if(cbmRelationKind(node.viaField)!=='composition'||!node.parentId)continue;
    const ancestor=nodes.get(node.parentId);
    const candidates=ancestor?parents(ancestor):[];
    for(const sourceId of byCbm.get(node.id)??[]) {
      // A semantic alias can point at the same physical occurrence as its parent.
      const ids=candidates.filter(id=>id!==sourceId);
      if(candidates.length&&!ids.length)continue;
      const links=result.get(sourceId)??[];
      links.push({kind:'semantic_composition',parentSourceIds:ids,
        evidence:[JSON.stringify([node.documentPath,node.viaField,node.parentId,node.id])],
        status:ids.length===1?'confirmed':ids.length?'ambiguous':'unresolved'});
      result.set(sourceId,links);
    }
  }
  return result;
}
