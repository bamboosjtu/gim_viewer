import type { ObjectEvidence, EvidenceValue } from '../../engineering/types.js';
import type { EngineeringSourceGraph } from './sourceGraph.js';
import { toObjectEvidence, type SourceRecord } from './sourceEvidence.js';

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
  return records.map(record=>({...toObjectEvidence(record),inheritedContextDesignations:record.context.flatMap(units)}));
}
