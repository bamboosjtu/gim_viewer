import {engineeringSourceRecords} from '../gim/engineering/sourceGraph.js';
import type { AppState } from '../app/state.js';
import type { SourceRecord } from '../gim/engineering/sourceEvidence.js';
import type { EngineeringNavigationData } from '../gim/engineering/navigation.js';
export type { EngineeringNavigationData, EngineeringSourceNode } from '../gim/engineering/navigation.js';

/** The Worker builds/restores the projections. UI access never reclassifies or
 * reconstructs a large project on the main thread. */
export function getEngineeringNavigation(state: AppState): EngineeringNavigationData | null {
  return state.engineeringNavigation;
}
const records = new WeakMap<object, Map<string, SourceRecord>>();
export function engineeringSourceRecord(state: AppState, id: string): SourceRecord | undefined {
  const sources = state.engineeringSources; if (!sources) return undefined;
  let index = records.get(sources);
  if (!index) { index = new Map(engineeringSourceRecords(sources.graph,sources.ifcRecords).map(record => [record.id, record])); records.set(sources, index); }
  return index.get(id);
}
