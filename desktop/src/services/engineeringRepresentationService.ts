import {engineeringSourceRecords} from '../gim/engineering/sourceGraph.js';
import type { AppState } from '../app/state.js';
import { EngineeringRepresentationIndex, type SourceRepresentation } from '../engineering/representations.js';
import { isIfcFeatureSourceType } from '../gim/engineering/sourceEvidence.js';

export interface EngineeringRepresentationState {
  index: EngineeringRepresentationIndex;
  issues: Array<{ sourceId: string; reason: string }>;
  contextDocuments: ReadonlyMap<string, string>;
  ifcGuidCounts: ReadonlyMap<string, number>;
}
const cached = new WeakMap<AppState, { sources: unknown; snapshot: unknown; value: EngineeringRepresentationState }>();

/** DEV roots use the same occurrence identity in source, renderer and binding.
 * Repeated references to a single CBM/template remain distinct placements. */
export function getEngineeringRepresentations(state: AppState): EngineeringRepresentationState | null {
  const sources = state.engineeringSources, snapshot = state.engineeringSnapshot;
  if (!sources || !snapshot) return null;
  const previous = cached.get(state);
  if (previous?.sources === sources && previous.snapshot === snapshot) return previous.value;
  const records = engineeringSourceRecords(sources.graph,sources.ifcRecords);
  const bindings: SourceRepresentation[] = [], issues: EngineeringRepresentationState['issues'] = [];
  const ifcGuidCounts = new Map<string, number>();
  const roots = new Set(sources.graph.records.filter(row => row.devOccurrence?.rootSourceId === row.id).map(row => row.id));
  for (const row of records) {
    if(row.attributeOnly){issues.push({sourceId:row.id,reason:'attribute-only-no-physical-representation'});continue;}
    if (row.ifcOccurrence) {
      bindings.push({ kind: 'ifc', sourceId: row.id, ...row.ifcOccurrence, nonphysical: isIfcFeatureSourceType(row.source_type) });
      if (row.ifcOccurrence.globalId) { const key = JSON.stringify([row.ifcOccurrence.modelId, row.ifcOccurrence.globalId]); ifcGuidCounts.set(key, (ifcGuidCounts.get(key) ?? 0) + 1); }
      continue;
    }
    const address = row.devOccurrence;
    if (!address || !roots.has(address.rootSourceId)) { issues.push({ sourceId: row.id, reason: 'physical-occurrence-address-missing' }); continue; }
    bindings.push({ kind: 'dev', sourceId: row.id, rootOccurrence: address.rootSourceId, assemblyPath: address.assemblyPath, devPath: row.source });
  }
  const value = { index: new EngineeringRepresentationIndex(snapshot, bindings), issues,
    ifcGuidCounts,
    contextDocuments: new Map(sources.graph.cbmOccurrences.map(node => [node.id, node.documentPath])) };
  cached.set(state, { sources, snapshot, value });
  return value;
}
