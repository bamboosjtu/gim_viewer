import { ENGINEERING_NAVIGATION_VERSION, type EngineeringNavigationData } from '../gim/engineering/navigation.js';
import { ENGINEERING_COMPOSITION_VERSION } from '../engineering/composition.js';
import type { EngineeringSnapshot } from '../engineering/types.js';
import type { EngineeringSources } from '../gim/engineering/buildSources.js';
import { decodeEngineeringArtifact, encodeEngineeringArtifact, type EngineeringCacheIdentity } from './engineeringCacheCodec.js';

const valid = (condition: unknown, reason: string): void => { if (!condition) throw Error(`工程视图缓存无效：${reason}`); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string');
async function dependency(snapshot: EngineeringSnapshot, sourceDigest: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([sourceDigest, snapshot]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Cache structure validation checks real source/entity references and complete
 * reachability. A malformed projection is rebuilt independently of facts. */
export function assertEngineeringNavigation(view: EngineeringNavigationData, sources: EngineeringSources, snapshot: EngineeringSnapshot): void {
  valid(object(view) && view.version === ENGINEERING_NAVIGATION_VERSION && object(view.composition) && view.composition.version === ENGINEERING_COMPOSITION_VERSION, 'version');
  const entities = new Set([...snapshot.entities, ...snapshot.pending].map(e => e.id));
  const sourceIds = new Set([...sources.graph.records, ...sources.ifcRecords].map(r => r.id));
  const contexts = new Set(sources.graph.cbmOccurrences.map(node=>node.id));
  function tree(nodes: Map<string, any>, root: string, composition: boolean, inventory=false) {
    valid(nodes instanceof Map && typeof root === 'string' && nodes.has(root), 'root');
    for (const [key, node] of nodes) {
      valid(typeof key === 'string' && object(node) && node.key === key && typeof node.title === 'string' && strings(node.children) && new Set(node.children).size === node.children.length, 'node');
      valid((inventory ? ['project','group','entity','pending','record']:composition ? ['project', 'group', 'entity', 'pending'] : ['group', 'cbm', 'record', 'ifc-file', 'spatial']).includes(node.kind), 'node kind');
      valid(key === root ? node.parent === undefined : typeof node.parent === 'string' && nodes.has(node.parent), 'parent');
      for (const child of node.children) valid(nodes.get(child)?.parent === key, 'child edge');
      if (composition) valid(Number.isSafeInteger(node.entityCount) && node.entityCount >= 0 && (node.targetId === undefined || entities.has(node.targetId)), 'entity reference');
      if(!composition||inventory) valid(node.sourceId === undefined || sourceIds.has(node.sourceId), 'source reference');
      if (composition && node.declaredContextIds !== undefined) valid(strings(node.declaredContextIds) && new Set(node.declaredContextIds).size === node.declaredContextIds.length && node.declaredContextIds.every((id:string)=>contexts.has(id)), 'declared context');
    }
    const visited = new Set<string>(), stack = [root];
    while (stack.length) { const key = stack.pop()!; valid(!visited.has(key), 'cycle or repeated parent'); visited.add(key); for (const child of nodes.get(key).children) stack.push(child); }
    valid(visited.size === nodes.size, 'unreachable rows');
  }
  tree(view.composition.nodes, view.composition.rootKey, true); tree(view.sourceNodes, view.sourceRoot, false);
  valid(view.composition.rowsByEntity instanceof Map && view.composition.rowsByEntity.size === entities.size, 'entity coverage');
  for (const [id, rows] of view.composition.rowsByEntity) valid(entities.has(id) && strings(rows) && rows.length && rows.every(key => view.composition.nodes.get(key)?.targetId === id), 'entity rows');
  valid(view.sourceRows instanceof Map && view.sourceRows.size === sourceIds.size, 'source coverage');
  for (const [id, row] of view.sourceRows) valid(sourceIds.has(id) && typeof row === 'string' && view.sourceNodes.get(row)?.sourceId === id, 'source rows');
  for (const [items, ids] of [[view.compositionSearch, entities], [view.sourceSearch, new Set(view.sourceNodes.keys())]] as const) {
    valid(Array.isArray(items) && items.every(item => object(item) && typeof item.key === 'string' && ids.has(item.key) && typeof item.title === 'string' && typeof item.subtitle === 'string'), 'search');
  }
  valid(view.compositionSearch.every(item => typeof item.searchText === 'string'), 'engineering search text');
  valid(view.inventory?.nodes instanceof Map && view.inventory.rowsByEntity instanceof Map && view.inventory.rowsBySource instanceof Map,'inventory');
  valid(view.inventory!.rowsByEntity.size===entities.size&&[...entities].every(id=>view.inventory!.rowsByEntity.has(id)),'inventory entity coverage');
  const inventory=view.inventory!;tree(inventory.nodes,inventory.rootKey,true,true);
  for(const [id,rows]of inventory.rowsByEntity)valid(entities.has(id)&&strings(rows)&&rows.length===1&&rows.every(key=>inventory.nodes.get(key)?.targetId===id),'inventory entity rows');
  const owned=snapshot.memberships.filter(m=>m.ownerId);
  valid(inventory.rowsBySource.size===owned.length,'inventory source coverage');
  for(const member of owned){const row=inventory.nodes.get(inventory.rowsBySource.get(member.sourceId)??'');valid(row?.sourceId===member.sourceId,'inventory source row');}
  const input=view.compositionInput;valid(input&&Array.isArray(input.facts)&&input.facts.length===snapshot.entities.length&&new Set(input.facts.map(f=>f.entityId)).size===snapshot.entities.length&&input.facts.every(f=>entities.has(f.entityId)&&Array.isArray(f.spaces)&&Array.isArray(f.declarations)&&strings(f.hostEntityIds)
    && (f.sourceHints===undefined||strings(f.sourceHints))
    && (f.deliveryBuildingNames===undefined||Array.isArray(f.deliveryBuildingNames)&&f.deliveryBuildingNames.every(n=>object(n)&&typeof n.value==='string'&&typeof n.evidenceId==='string'))
    && (f.positions===undefined||Array.isArray(f.positions)&&f.positions.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))))&&Array.isArray(input.declarations),'composition input');
}

export const engineeringNavigationToWire = (view: EngineeringNavigationData) => ({ ...view, composition: { ...view.composition, nodes: [...view.composition.nodes], rowsByEntity: [...view.composition.rowsByEntity] }, sourceNodes: [...view.sourceNodes], sourceRows: [...view.sourceRows],
  inventory:view.inventory?{...view.inventory,nodes:[...view.inventory.nodes],rowsByEntity:[...view.inventory.rowsByEntity],rowsBySource:[...view.inventory.rowsBySource]}:undefined });
function map(value: unknown): Map<string, any> {
  valid(Array.isArray(value) && value.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string'), 'map shape');
  const result = new Map(value as Array<[string, unknown]>); valid(result.size === (value as unknown[]).length, 'duplicate map identity'); return result;
}
export async function encodeEngineeringNavigation(view: EngineeringNavigationData, sources: EngineeringSources, snapshot: EngineeringSnapshot, sourceDigest: string, id: EngineeringCacheIdentity): Promise<Uint8Array> {
  assertEngineeringNavigation(view, sources, snapshot);
  return (await encodeEngineeringArtifact('navigation', engineeringNavigationToWire(view), id, await dependency(snapshot, sourceDigest))).bytes;
}
export function engineeringNavigationFromWire(payload: unknown, sources: EngineeringSources, snapshot: EngineeringSnapshot): EngineeringNavigationData {
  valid(object(payload) && object(payload.composition), 'payload');
  const raw = payload as ReturnType<typeof engineeringNavigationToWire>;
  const view = { ...raw, composition: { ...raw.composition, nodes: map(raw.composition.nodes), rowsByEntity: map(raw.composition.rowsByEntity) }, sourceNodes: map(raw.sourceNodes), sourceRows: map(raw.sourceRows),
    inventory:raw.inventory?{...raw.inventory,nodes:map(raw.inventory.nodes),rowsByEntity:map(raw.inventory.rowsByEntity),rowsBySource:map(raw.inventory.rowsBySource)}:undefined } as EngineeringNavigationData;
  assertEngineeringNavigation(view, sources, snapshot); return view;
}
export async function decodeEngineeringNavigation(bytes: Uint8Array, sources: EngineeringSources, snapshot: EngineeringSnapshot, sourceDigest: string, id: EngineeringCacheIdentity): Promise<EngineeringNavigationData> {
  const { payload } = await decodeEngineeringArtifact('navigation', bytes, id, await dependency(snapshot, sourceDigest));
  return engineeringNavigationFromWire(payload, sources, snapshot);
}
