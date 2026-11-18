import type { IfcSpatialObject } from '../ifcSpatialTypes.js';
import { ifcSourceRecords } from './ifcSourceRecords.js';
import type { SourceRecord } from './sourceEvidence.js';
import {engineeringSourceRecords,type EngineeringSourceGraph} from './sourceGraph.js';
import {sourceScalar} from '../sourceDocument.js';

export interface IfcSourceMatch {
  cbmOccurrenceId: string;
  sourcePath: string;
  rawGuid: string;
  rawGuidValues?: readonly string[];
  status: 'confirmed' | 'ambiguous' | 'not_found';
  ifcSourceIds: string[];
  /** Physical DEV and IFC are candidates, not automatically a single object. */
  devSourceIds: string[];
}

export interface EngineeringSourceModel {
  sources: SourceRecord[];
  ifcMatches: IfcSourceMatch[];
}

const canonical = (value: string) => value.replace(/\\/g, '/').toLowerCase();

/** Joins delivered sources, independent of scene loading and either navigation
 * tree. A declared file+GUID link does not prove DEV/IFC physical equivalence.
 */
export function collectEngineeringSourceModel(graph: EngineeringSourceGraph, objects: readonly IfcSpatialObject[]): EngineeringSourceModel {
  const ifc = ifcSourceRecords(objects);
  const sources = engineeringSourceRecords(graph,ifc);
  const byModelGuid = new Map<string, string[]>();
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i];
    if (!object.globalId) continue;
    const key = JSON.stringify([canonical(object.sourcePath), object.globalId]);
    const hits = byModelGuid.get(key) ?? [];
    hits.push(ifc[i].id); byModelGuid.set(key, hits);
  }
  const documents = new Map(graph.documents.map(doc => [doc.path, doc]));
  const aliases = new Map(graph.aliases.map(alias => [alias.sourceId, alias.candidates]));
  const devByCbm = new Map<string, string[]>();
  for (const row of graph.records) for (const cbmId of row.context) {
    // Only a physical root is directly represented by this CBM; descendants have
    // their own DEV identities and may be reached via explicit component aliases.
    if (row.parent) continue;
    const hits = devByCbm.get(cbmId) ?? [];
    hits.push(row.id); devByCbm.set(cbmId, hits);
  }
  const fileTargets = new Map<string,{target:string|null;ambiguous:boolean}>();
  for(const edge of graph.references)if(edge.field.toUpperCase()==='IFCFILE'){
    const previous=fileTargets.get(edge.owner);
    const ambiguous=edge.status==='ambiguous'||!!previous&&(previous.ambiguous||previous.target!==edge.target);
    fileTargets.set(edge.owner,{target:ambiguous?null:edge.target,ambiguous});
  }
  const ifcMatches: IfcSourceMatch[] = [];
  const linksByDocument=new Map<string,Omit<IfcSourceMatch,'cbmOccurrenceId'|'devSourceIds'>|null>();
  for (const cbm of graph.cbmOccurrences) {
    let link=linksByDocument.get(cbm.documentPath);
    if(link===undefined){
      link=readLink(cbm.documentPath);
      linksByDocument.set(cbm.documentPath,link);
    }
    if(link)ifcMatches.push({...link,cbmOccurrenceId:cbm.id,
      devSourceIds:[...aliases.get(cbm.id)??devByCbm.get(cbm.id)??[]]});
  }
  return {sources,ifcMatches};

  function readLink(path:string):Omit<IfcSourceMatch,'cbmOccurrenceId'|'devSourceIds'>|null {
    const doc=documents.get(path);
    if(!doc)return null;
    const guid=sourceScalar(doc,'IFCGUID'),rawGuid=guid.value;
    if(guid.status==='empty')return null;
    const target=fileTargets.get(path);
    const ambiguous=guid.status==='ambiguous'||sourceScalar(doc,'IFCFILE').status==='ambiguous'||!!target?.ambiguous;
    const file=ambiguous?null:target?.target;
    const hits = file ? byModelGuid.get(JSON.stringify([canonical(file), rawGuid])) ??
      (rawGuid.endsWith('$') ? byModelGuid.get(JSON.stringify([canonical(file), rawGuid.slice(0, -1)])) : undefined) ?? [] : [];
    return {sourcePath:path,rawGuid,
      ...(guid.status==='ambiguous'?{rawGuidValues:guid.fields.map(field=>field.value)}:{}),
      status: ambiguous?'ambiguous':hits.length === 1 ? 'confirmed' : hits.length ? 'ambiguous' : 'not_found',
      ifcSourceIds:[...hits]};
  }
}
