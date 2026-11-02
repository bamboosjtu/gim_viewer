import type { AppState, SelectionRequest } from '../app/state.js';
import { selectEngineeringTarget } from './engineeringSelection.js';
import { inspectEngineeringDocument } from './engineeringSourceInspector.js';

const canonical = (path: string) => path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').toLowerCase();
/** Legacy file/diagram links are source addresses, never an alternative entity
 * classifier. Shared document occurrences and cross-whole aliases stay explicit. */
export async function selectEngineeringCbmSource(state: AppState, path: string, request: SelectionRequest): Promise<boolean> {
  if (!state.isCurrentSelection(request) || !state.engineeringSources || !state.engineeringSnapshot) return false;
  const sources = state.engineeringSources, wanted = canonical(path);
  const paths = [...new Set(sources.graph.cbmOccurrences.map(node => node.documentPath))];
  const exact = paths.filter(value => canonical(value) === wanted);
  const matches = exact.length ? exact : paths.filter(value => canonical(value).split('/').pop() === wanted.split('/').pop());
  if (matches.length !== 1) return false;
  const documentPath = matches[0], occurrences = sources.graph.cbmOccurrences.filter(node => node.documentPath === documentPath);
  if (occurrences.length === 1) {
    const occurrence = occurrences[0], candidates = new Set<string>();
    for (const record of sources.graph.records) if (record.devOccurrence?.cbmOccurrenceId === occurrence.id && record.devOccurrence.rootSourceId === record.id) candidates.add(record.id);
    for (const alias of sources.graph.aliases) if (alias.sourceId === occurrence.id) for (const id of alias.candidates) candidates.add(id);
    for (const match of sources.ifcMatches) if (match.cbmOccurrenceId === occurrence.id) for (const id of match.ifcSourceIds) candidates.add(id);
    const members = new Map(state.engineeringSnapshot.memberships.map(member => [member.sourceId, member.ownerId]));
    const owners = new Set([...candidates].map(id => members.get(id)));
    if (owners.size === 1 && !owners.has(null) && !owners.has(undefined)) {
      return selectEngineeringTarget(state, { kind: 'engineering', key: [...owners][0]! }, request);
    }
    if (candidates.size === 1) return selectEngineeringTarget(state, { kind: 'engineering-source', key: [...candidates][0] }, request);
  }
  const occurrenceId = occurrences.length === 1 ? occurrences[0].id : undefined;
  request.target = { kind: 'engineering-source', key: occurrenceId ?? `document:${documentPath}` };
  await inspectEngineeringDocument(state, documentPath, occurrenceId, request); return true;
}
