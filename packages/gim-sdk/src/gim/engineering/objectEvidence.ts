import type { ObjectEvidence, EvidenceValue } from '../../engineering/types.js';
import type { EngineeringSourceGraph } from './sourceGraph.js';
import { toObjectEvidence, type SourceRecord } from '../../engineering/recognizeSource.js';
import {collectSourceComposition} from './sourceComposition.js';

/** Organizational labels are retained for audit, separately from object-owned
 * designations. The domain must never use them to establish identity or hosts. */
export function engineeringObjectEvidence(graph: EngineeringSourceGraph, records: readonly SourceRecord[]): ObjectEvidence[] {
  const nodes=new Map(graph.cbmOccurrences.map(node=>[node.id,node])),docs=new Map(graph.documents.map(doc=>[doc.path,doc]));
  const cached=new Map<string,EvidenceValue[]>();
  function units(key:string):EvidenceValue[]{
    const old=cached.get(key);if(old)return old;const node=nodes.get(key);if(!node)return [];
    const values=[...(node.parentId?units(node.parentId):[]),...(docs.get(node.documentPath)?.fields??[])
      .filter(field=>/^(?:SYSTEMNAME\d+|NAME|PARTNAME)$/i.test(field.keys[0])&&/主变|变压器系统/.test(field.value))
      .map(field=>({value:field.value,evidenceId:`${node.documentPath}:${field.line}`}))];cached.set(key,values);return values;
  }
  const composition=collectSourceComposition(graph,records);
  return records.map(record=>{
    const evidence=toObjectEvidence(record),edges=composition.get(record.id);
    // When semantic and physical parents coexist, retain both as constraints.
    // Recovery reports disagreement; it must not silently replace either edge.
    const semanticHosts=record.parent?edges?.filter(edge=>edge.kind==='semantic_composition'&&edge.status==='confirmed').flatMap(edge=>
      edge.parentSourceIds.map(value=>({value,evidenceId:edge.evidence.join('|')})))??[]:[];
    return {...evidence,composition:edges,declaredHostSourceIds:[...(evidence.declaredHostSourceIds??[]),...semanticHosts],
      inheritedContextDesignations:record.context.flatMap(units)};
  });
}
