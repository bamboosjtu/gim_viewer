import {engineeringSourceRecords} from './sourceGraph.js';
import type { EngineeringSources } from './buildSources.js';
import type { EngineeringSnapshot } from '../../engineering/types.js';
import { collectCompositionEvidence, collectDeclaredCompositionContexts, type SourceCompositionEvidence } from './compositionContexts.js';
import { assignEngineeringComposition } from '../../engineering/compositionTemplate.js';
import type { CompositionDeclaration } from '../../engineering/composition.js';
import { projectEngineeringComposition, ENGINEERING_COMPOSITION_VERSION, type EngineeringComposition } from '../../engineering/composition.js';
import { categoryLabel } from '../../engineering/catalogLabels.js';
import { projectEngineeringInventory, projectInventorySearch, INVENTORY_TEMPLATE_VERSION, type EngineeringInventory } from './inventory.js';

export type { EngineeringSourceNode } from './sourceProjection.js';
import type { EngineeringSourceNode } from './sourceProjection.js';
import { projectEngineeringSource, SOURCE_TREE_TEMPLATE_VERSION } from './sourceProjection.js';
export interface EngineeringNavigationData {
  version: string;
  projectionErrors?: Record<string,string>;
  compositionComplete?: boolean;
  /** Full geometry-backed projection or an explicitly partial semantic/range view. */
  compositionCoverage?: 'full' | 'partial';
  composition: EngineeringComposition;
  sourceNodes: Map<string, EngineeringSourceNode>;
  sourceRoot: string;
  sourceRows: Map<string, string>;
  compositionSearch: Array<{ key: string; title: string; subtitle: string; searchText: string }>;
  sourceSearch: Array<{ key: string; title: string; subtitle: string }>;
  inventorySearch?: Array<{key:string;title:string;subtitle:string;searchText:string}>;
  projectionVersions?: {composition:string;source:string;inventory:string};
  inventory?: EngineeringInventory;
  metadata?: {scope:string;rulesVersion:string;sourceComplete:boolean;sourceVersion:string};
  compositionInput?:{facts:SourceCompositionEvidence[];declarations:CompositionDeclaration[]};
}
export const ENGINEERING_NAVIGATION_VERSION = 'engineering-navigation-v11';
/** Independent engineering and provenance projections share only source/entity
 * references. No business-tree object, physical seed or render group is input.
 */
export function projectEngineeringNavigation(sources: EngineeringSources, snapshot: EngineeringSnapshot): EngineeringNavigationData {
  const spatialNodes = new Map(sources.spatialNodes.map(node => [node.key, node]));
  const projectionErrors:Record<string,string>={};
  let facts:SourceCompositionEvidence[]=[],declarations:CompositionDeclaration[]=[],assignments:ReturnType<typeof assignEngineeringComposition>=[];
  let composition:EngineeringComposition={version:ENGINEERING_COMPOSITION_VERSION,rootKey:'engineering:project',nodes:new Map([['engineering:project',{key:'engineering:project',title:'工程组成（投影不可用）',kind:'project',children:[],entityCount:0}]]),rowsByEntity:new Map()};
  try { facts=collectCompositionEvidence(sources,snapshot,spatialNodes);declarations=collectDeclaredCompositionContexts(sources);assignments=assignEngineeringComposition(snapshot,facts);composition=projectEngineeringComposition(snapshot,assignments,'工程组成',declarations); }
  catch(error){projectionErrors.composition=String(error);}
  let sourceView:ReturnType<typeof projectEngineeringSource>={version:SOURCE_TREE_TEMPLATE_VERSION,sourceNodes:new Map([['source:project',{key:'source:project',title:'来源（投影不可用）',kind:'group',children:[]}]]),sourceRoot:'source:project',sourceRows:new Map(),sourceSearch:[]};
  try {sourceView=projectEngineeringSource(sources);} catch(error){projectionErrors.source=String(error);}
  const {sourceNodes,sourceRoot,sourceRows,sourceSearch}=sourceView;
  const records=new Map(engineeringSourceRecords(sources.graph,sources.ifcRecords).map(record=>[record.id,record]));
  const pathsByEntity = new Map(assignments.map(assignment => [assignment.entityId, assignment.paths]));
  const compositionSearch = snapshot.entities.map(entity => {
    const names = new Set<string>();
    for (const id of entity.sourceIds) { const source = records.get(id); if (source) {
      names.add(source.name);
      for (const property of source.properties) if (property.keys?.some(key => ['工程中名称', '设备名称', 'PROJECTNAME', '设备编码', '电网工程标识系统编码'].includes(key))) names.add(property.value);
    } }
    const paths = (pathsByEntity.get(entity.id) ?? []).map(path => path.map(group => group.title).join(' / ')).filter(Boolean);
    const context = paths.length ? [...new Set(paths)].join('；') : '工程归属待确认';
    const subtitle = `${categoryLabel(entity.category)} · ${context}`;
    return { key: entity.id, title: entity.name, subtitle,
      searchText: [entity.name, subtitle, ...names, entity.id].join('\n').toLowerCase() };
  });
  for (const pending of snapshot.pending) {
    const title = '待归整体集合', subtitle = `整体归属待确认 · ${pending.sourceIds.length} 个来源`;
    compositionSearch.push({ key: pending.id, title, subtitle,
      searchText: [title, subtitle, pending.id, ...pending.sourceIds.map(id => records.get(id)?.name ?? '')].join('\n').toLowerCase() });
  }
  let inventory:EngineeringInventory|undefined,inventorySearch:ReturnType<typeof projectInventorySearch>=[];
  try {inventory=projectEngineeringInventory(snapshot,[...records.values()]);inventorySearch=projectInventorySearch(inventory,snapshot,[...records.values()]);} catch(error){inventory=undefined;inventorySearch=[];projectionErrors.inventory=String(error);}
  return { version: ENGINEERING_NAVIGATION_VERSION,
    projectionVersions:{composition:ENGINEERING_COMPOSITION_VERSION,source:SOURCE_TREE_TEMPLATE_VERSION,inventory:INVENTORY_TEMPLATE_VERSION},
    projectionErrors:Object.keys(projectionErrors).length?projectionErrors:undefined,
    ...(projectionErrors.composition?{compositionComplete:false,compositionCoverage:'partial' as const}:{}),
    inventorySearch, composition, sourceNodes, sourceRoot, sourceRows, compositionSearch, sourceSearch,
    compositionInput:{facts,declarations},
    inventory,metadata:{scope:snapshot.scope,rulesVersion:snapshot.rulesVersion,sourceComplete:sources.complete,sourceVersion:sources.version} };
}
