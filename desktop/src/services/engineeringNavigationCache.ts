import { ENGINEERING_NAVIGATION_VERSION, type EngineeringNavigationData } from '../gim/engineering/navigation.js';
import { ENGINEERING_COMPOSITION_VERSION } from '../engineering/composition.js';
import { INVENTORY_TEMPLATE_VERSION } from '../engineering/inventoryTemplate.js';
import { SOURCE_TREE_TEMPLATE_VERSION } from '../gim/engineering/sourceProjection.js';
import type { EngineeringSnapshot } from '../engineering/types.js';
import type { EngineeringSources } from '../gim/engineering/buildSources.js';
import { decodeEngineeringArtifact, encodeEngineeringArtifact, type EngineeringCacheIdentity } from './engineeringCacheCodec.js';
import {packEngineeringSource} from './engineeringSourceCodec.js';

const valid = (condition: unknown, reason: string): void => { if (!condition) throw Error(`工程视图缓存无效：${reason}`); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string');

/** Only composition refinement returns to the Worker that owns the immutable
 * navigation base. Search rows carry their explicit entity identity and new
 * suffix, rather than cloning unchanged source trees, inventory and text. */
export interface EngineeringNavigationCacheProjection {
  composition: EngineeringNavigationData['composition'];
  compositionComplete?: boolean;
  compositionCoverage?: EngineeringNavigationData['compositionCoverage'];
  search: Array<{key:string;subtitle:string;append:string}>;
}
export function createNavigationCacheProjection(base:EngineeringNavigationData,view:EngineeringNavigationData):EngineeringNavigationCacheProjection {
  const changed=new Set(['composition','compositionComplete','compositionCoverage','compositionSearch']);
  for(const key of new Set([...Object.keys(base),...Object.keys(view)]))if(!changed.has(key))
    valid(Reflect.get(base,key)===Reflect.get(view,key),'projection base changed');
  const rows=new Map(base.compositionSearch.map(row=>[row.key,row]));
  valid(rows.size===base.compositionSearch.length&&view.compositionSearch.length===rows.size,'projection search coverage');
  const seen=new Set<string>();
  const search=view.compositionSearch.map(row=>{
    const original=rows.get(row.key);
    valid(original&&!seen.has(row.key)&&row.title===original.title&&typeof row.subtitle==='string'
      &&typeof row.searchText==='string'&&row.searchText.startsWith(original.searchText),'projection search identity / prefix');
    seen.add(row.key);
    return {key:row.key,subtitle:row.subtitle,append:row.searchText.slice(original!.searchText.length)};
  });
  return {composition:view.composition,compositionComplete:view.compositionComplete,compositionCoverage:view.compositionCoverage,search};
}
export function applyNavigationCacheProjection(base:EngineeringNavigationData,projection:EngineeringNavigationCacheProjection):EngineeringNavigationData {
  valid(object(projection)&&object(projection.composition)
    &&(projection.compositionComplete===undefined||typeof projection.compositionComplete==='boolean')
    &&(projection.compositionCoverage===undefined||['full','partial'].includes(projection.compositionCoverage)),'projection shape');
  const rows=new Map(base.compositionSearch.map(row=>[row.key,row]));
  valid(rows.size===base.compositionSearch.length&&Array.isArray(projection.search)&&projection.search.length===rows.size,'projection search coverage');
  const seen=new Set<string>();
  const compositionSearch=projection.search.map(row=>{
    valid(object(row)&&typeof row.key==='string'&&typeof row.subtitle==='string'&&typeof row.append==='string','projection search row');
    const original=rows.get(row.key);valid(original&&!seen.has(row.key),'projection search identity');seen.add(row.key);
    return {...original!,subtitle:row.subtitle,searchText:original!.searchText+row.append};
  });
  return {...base,compositionComplete:projection.compositionComplete,compositionCoverage:projection.compositionCoverage,
    composition:projection.composition,compositionSearch};
}
async function dependency(snapshot: EngineeringSnapshot, sourceDigest: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([sourceDigest,packEngineeringSource(snapshot)]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Cache structure validation checks real source/entity references and complete
 * reachability. A malformed projection is rebuilt independently of facts. */
export function assertEngineeringNavigation(view: EngineeringNavigationData, sources: EngineeringSources, snapshot: EngineeringSnapshot, allowPartial=false): void {
  valid(object(view) && view.version === ENGINEERING_NAVIGATION_VERSION && object(view.composition) && view.composition.version === ENGINEERING_COMPOSITION_VERSION, 'version');
  const errors=view.projectionErrors;
  valid(errors===undefined||object(errors)&&Object.entries(errors).every(([key,value])=>['composition','source','inventory'].includes(key)&&typeof value==='string'&&value.length>0),'projection errors');
  valid(allowPartial||!Object.keys(errors??{}).length,'partial projection');
  const failed=(key:string)=>allowPartial&&!!errors?.[key];
  valid(view.projectionVersions?.composition===ENGINEERING_COMPOSITION_VERSION&&view.projectionVersions?.inventory===INVENTORY_TEMPLATE_VERSION&&view.projectionVersions?.source===SOURCE_TREE_TEMPLATE_VERSION&&(failed('inventory')&&!view.inventory||view.inventory?.version===INVENTORY_TEMPLATE_VERSION),'projection versions');
  const entities = new Set([...snapshot.entities, ...snapshot.pending].map(e => e.id));
  const sourceIds = new Set([...sources.graph.records, ...sources.ifcRecords].map(r => r.id));
  const contexts = new Set(sources.graph.cbmOccurrences.map(node=>node.id));
  function tree(nodes: Map<string, any>, root: string, composition: boolean, inventory=false) {
    valid(nodes instanceof Map && typeof root === 'string' && nodes.has(root), 'root');
    for (const [key, node] of nodes) {
      valid(typeof key === 'string' && object(node) && node.key === key && typeof node.title === 'string' && strings(node.children) && new Set(node.children).size === node.children.length, 'node');
      valid((inventory ? ['project','group','template','entity','pending','record']:composition ? ['project', 'group', 'entity', 'pending'] : ['group', 'cbm', 'record', 'ifc-file', 'spatial']).includes(node.kind), 'node kind');
      valid(key === root ? node.parent === undefined : typeof node.parent === 'string' && nodes.has(node.parent), 'parent');
      for (const child of node.children) valid(nodes.get(child)?.parent === key, 'child edge');
      if (composition) valid(Number.isSafeInteger(node.entityCount) && node.entityCount >= 0 && (node.targetId === undefined || entities.has(node.targetId)), 'entity reference');
      if(inventory&&node.kind==='template')valid(typeof node.template==='string'&&node.template.length>0,'inventory template');
      if(inventory&&node.confirmedCount!==undefined)valid(Number.isSafeInteger(node.confirmedCount)&&node.confirmedCount>=0&&node.confirmedCount<=node.entityCount,'inventory confirmed count');
      if(!composition||inventory) valid(node.sourceId === undefined || sourceIds.has(node.sourceId), 'source reference');
      if (composition && node.declaredContextIds !== undefined) valid(strings(node.declaredContextIds) && new Set(node.declaredContextIds).size === node.declaredContextIds.length && node.declaredContextIds.every((id:string)=>contexts.has(id)), 'declared context');
    }
    const visited = new Set<string>(), stack = [root];
    while (stack.length) { const key = stack.pop()!; valid(!visited.has(key), 'cycle or repeated parent'); visited.add(key); for (const child of nodes.get(key).children) stack.push(child); }
    valid(visited.size === nodes.size, 'unreachable rows');
  }
  tree(view.composition.nodes, view.composition.rootKey, true); tree(view.sourceNodes, view.sourceRoot, false);
  valid(view.composition.rowsByEntity instanceof Map && (failed('composition')||view.composition.rowsByEntity.size === entities.size), 'entity coverage');
  for (const [id, rows] of view.composition.rowsByEntity) valid(entities.has(id) && strings(rows) && rows.length && rows.every(key => view.composition.nodes.get(key)?.targetId === id), 'entity rows');
  valid(view.sourceRows instanceof Map && (failed('source')||view.sourceRows.size === sourceIds.size), 'source coverage');
  for (const [id, row] of view.sourceRows) valid(sourceIds.has(id) && typeof row === 'string' && view.sourceNodes.get(row)?.sourceId === id, 'source rows');
  for (const [items, ids] of [[view.compositionSearch, entities], [view.sourceSearch, new Set(view.sourceNodes.keys())]] as const) {
    valid(Array.isArray(items) && items.every(item => object(item) && typeof item.key === 'string' && ids.has(item.key) && typeof item.title === 'string' && typeof item.subtitle === 'string'), 'search');
  }
  valid(view.compositionSearch.every(item => typeof item.searchText === 'string'), 'engineering search text');
  if(!failed('inventory')||view.inventory){
  valid(view.inventory?.nodes instanceof Map && view.inventory.rowsByEntity instanceof Map && view.inventory.rowsBySource instanceof Map,'inventory');
  valid(view.inventory!.rowsByEntity.size===entities.size&&[...entities].every(id=>view.inventory!.rowsByEntity.has(id)),'inventory entity coverage');
  const inventory=view.inventory!;tree(inventory.nodes,inventory.rootKey,true,true);
  valid(inventory.nodes.get(inventory.rootKey)!.children.map(key=>inventory.nodes.get(key)?.title).join('|')==='设备|装置性材料|构件|其他','inventory root groups');
  for(const node of inventory.nodes.values())if(node.attachmentCount!==undefined)valid(Number.isSafeInteger(node.attachmentCount)&&node.attachmentCount>=0,'inventory attachment count');
  for(const [id,rows]of inventory.rowsByEntity)valid(entities.has(id)&&strings(rows)&&rows.length===1&&rows.every(key=>inventory.nodes.get(key)?.targetId===id),'inventory entity rows');
  for(const entity of snapshot.entities){const node=inventory.nodes.get(inventory.rowsByEntity.get(entity.id)![0])!;
    valid(['category','subtype','subtypeLabel','classificationStatus','boundaryStatus','unknownReason','grain'].every(key=>node[key as keyof typeof node]===entity[key as keyof typeof entity])&&node.sourceCount===entity.sourceIds.length,'inventory entity facts');
  }
  valid(inventory.rowsBySource.size===sourceIds.size,'inventory source coverage');
  for(const member of snapshot.memberships){const row=inventory.nodes.get(inventory.rowsBySource.get(member.sourceId)??'');valid(row?.sourceId===member.sourceId,'inventory source row');}
  valid(Array.isArray(view.inventorySearch)&&view.inventorySearch.length===entities.size&&new Set(view.inventorySearch.map(r=>r.key)).size===entities.size&&view.inventorySearch.every(r=>entities.has(r.key)&&typeof r.title==='string'&&typeof r.subtitle==='string'&&typeof r.searchText==='string'),'inventory search');
  }else valid(Array.isArray(view.inventorySearch)&&view.inventorySearch.length===0,'failed inventory search');
  const input=view.compositionInput;valid(input&&Array.isArray(input.facts)&&(failed('composition')||input.facts.length===snapshot.entities.length)&&new Set(input.facts.map(f=>f.entityId)).size===input.facts.length&&input.facts.every(f=>entities.has(f.entityId)&&Array.isArray(f.spaces)&&Array.isArray(f.declarations)&&strings(f.hostEntityIds)
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
export function engineeringNavigationFromWire(payload: unknown, sources: EngineeringSources, snapshot: EngineeringSnapshot, allowPartial=false): EngineeringNavigationData {
  valid(object(payload) && object(payload.composition), 'payload');
  const raw = payload as ReturnType<typeof engineeringNavigationToWire>;
  const view = { ...raw, composition: { ...raw.composition, nodes: map(raw.composition.nodes), rowsByEntity: map(raw.composition.rowsByEntity) }, sourceNodes: map(raw.sourceNodes), sourceRows: map(raw.sourceRows),
    inventory:raw.inventory?{...raw.inventory,nodes:map(raw.inventory.nodes),rowsByEntity:map(raw.inventory.rowsByEntity),rowsBySource:map(raw.inventory.rowsBySource)}:undefined } as EngineeringNavigationData;
  assertEngineeringNavigation(view, sources, snapshot, allowPartial); return view;
}
export async function decodeEngineeringNavigation(bytes: Uint8Array, sources: EngineeringSources, snapshot: EngineeringSnapshot, sourceDigest: string, id: EngineeringCacheIdentity): Promise<EngineeringNavigationData> {
  const { payload } = await decodeEngineeringArtifact('navigation', bytes, id, await dependency(snapshot, sourceDigest));
  return engineeringNavigationFromWire(payload, sources, snapshot);
}
