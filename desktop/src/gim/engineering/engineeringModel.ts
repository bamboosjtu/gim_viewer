import { normalizeEngineeringModel } from '../../engineering/normalize.js';
import type { EngineeringSnapshot } from '../../engineering/types.js';
import type { IfcSpatialObject } from '../ifcSpatialParser.js';
import { ifcSourceRecords } from './ifcSourceRecords.js';
import { toObjectEvidence } from './sourceEvidence.js';
import type { SourceRecord } from './sourceEvidence.js';
import type { EngineeringSourceGraph } from './sourceGraph.js';

export interface IfcSourceMatch {
  cbmOccurrenceId: string;
  sourcePath: string;
  rawGuid: string;
  status: 'confirmed' | 'ambiguous' | 'not_found';
  ifcSourceIds: string[];
  /** Physical DEV and IFC are candidates, not automatically a single object. */
  devSourceIds: string[];
}

export interface EngineeringSourceModel {
  sources: SourceRecord[];
  snapshot: EngineeringSnapshot;
  ifcMatches: IfcSourceMatch[];
}

const canonical = (value: string) => value.replace(/\\/g, '/').toLowerCase();

/** Joins delivered sources, independent of scene loading and either navigation
 * tree. A declared file+GUID link does not prove DEV/IFC physical equivalence.
 */
export function buildEngineeringSourceModel(scope: string, graph: EngineeringSourceGraph, objects: readonly IfcSpatialObject[]): EngineeringSourceModel {
  const ifc = ifcSourceRecords(objects);
  const sources = [...graph.records, ...ifc];
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
  const fileTargets = new Map(graph.references.filter(edge => edge.field.toUpperCase() === 'IFCFILE')
    .map(edge => [edge.owner, edge.target]));
  const ifcMatches: IfcSourceMatch[] = [];
  for (const cbm of graph.cbmOccurrences) {
    const doc = documents.get(cbm.documentPath)!;
    const rawGuid = doc.fields.find(field => field.keys[0].toUpperCase() === 'IFCGUID')?.value ?? '';
    if (!rawGuid) continue;
    const file = fileTargets.get(cbm.documentPath);
    const hits = file ? byModelGuid.get(JSON.stringify([canonical(file), rawGuid])) ??
      (rawGuid.endsWith('$') ? byModelGuid.get(JSON.stringify([canonical(file), rawGuid.slice(0, -1)])) : undefined) ?? [] : [];
    ifcMatches.push({ cbmOccurrenceId: cbm.id, sourcePath: cbm.documentPath, rawGuid,
      status: hits.length === 1 ? 'confirmed' : hits.length ? 'ambiguous' : 'not_found',
      ifcSourceIds: [...hits], devSourceIds: [...aliases.get(cbm.id) ?? devByCbm.get(cbm.id) ?? []] });
  }
  return { sources, snapshot: normalizeEngineeringModel(scope, sources.map(toObjectEvidence), graph.aliases), ifcMatches };
}
