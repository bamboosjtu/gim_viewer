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
export const ENGINEERING_NAVIGATION_VERSION = 'engineering-navigation-v8';
/** Independent engineering and provenance projections share only source/entity
 * references. No business-tree object, physical seed or render group is input.
 */
export function projectEngineeringNavigation(sources: EngineeringSources, snapshot: EngineeringSnapshot): EngineeringNavigationData {
  const spatialNodes = new Map(sources.spatialNodes.map(node => [node.key, node]));
  const facts=collectCompositionEvidence(sources,snapshot,spatialNodes),declarations=collectDeclaredCompositionContexts(sources);
  const assignments = assignEngineeringComposition(snapshot,facts);
  const composition = projectEngineeringComposition(snapshot, assignments, '工程组成', declarations);
  const {sourceNodes,sourceRoot,sourceRows,sourceSearch}=projectEngineeringSource(sources);
  const records=new Map([...sources.graph.records,...sources.ifcRecords].map(record=>[record.id,record]));
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
  const inventory=projectEngineeringInventory(snapshot,[...records.values()]);
  return { version: ENGINEERING_NAVIGATION_VERSION,
    projectionVersions:{composition:ENGINEERING_COMPOSITION_VERSION,source:SOURCE_TREE_TEMPLATE_VERSION,inventory:INVENTORY_TEMPLATE_VERSION},
    inventorySearch:projectInventorySearch(inventory,snapshot,[...records.values()]), composition, sourceNodes, sourceRoot, sourceRows, compositionSearch, sourceSearch,
    compositionInput:{facts,declarations},
    inventory,metadata:{scope:snapshot.scope,rulesVersion:snapshot.rulesVersion,sourceComplete:sources.complete,sourceVersion:sources.version} };
}
