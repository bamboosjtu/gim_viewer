import type { EngineeringSources } from './buildSources.js';
import type { EngineeringSnapshot } from '../../engineering/types.js';
import { collectCompositionEvidence, collectDeclaredCompositionContexts } from './compositionContexts.js';
import { assignEngineeringComposition, type CompositionContextEvidence } from '../../engineering/compositionTemplate.js';
import type { CompositionDeclaration } from '../../engineering/composition.js';
import { projectEngineeringComposition, type EngineeringComposition } from '../../engineering/composition.js';
import { categoryLabel } from '../../engineering/catalogLabels.js';
import { projectEngineeringInventory, type EngineeringInventory } from './inventory.js';
import { sourceDocumentTitle, sourceRecordTitle } from './sourceTitles.js';

export interface EngineeringSourceNode {
  key: string;
  title: string;
  kind: 'group' | 'cbm' | 'record' | 'ifc-file' | 'spatial';
  parent?: string;
  children: string[];
  sourceId?: string;
  documentPath?: string;
  /** GIM F1/F2/F3/F4 or PARTINDEX for the source view; never an entity level. */
  fLevel?: string;
}
export interface EngineeringNavigationData {
  version: string;
  composition: EngineeringComposition;
  sourceNodes: Map<string, EngineeringSourceNode>;
  sourceRoot: string;
  sourceRows: Map<string, string>;
  compositionSearch: Array<{ key: string; title: string; subtitle: string; searchText: string }>;
  sourceSearch: Array<{ key: string; title: string; subtitle: string }>;
  inventory?: EngineeringInventory;
  metadata?: {scope:string;rulesVersion:string;sourceComplete:boolean;sourceVersion:string};
  compositionInput?:{facts:CompositionContextEvidence[];declarations:CompositionDeclaration[]};
}
export const ENGINEERING_NAVIGATION_VERSION = 'engineering-navigation-v3';
const recordKey = (id: string) => `source:record:${id}`;
const cbmKey = (id: string) => `source:cbm:${id}`;
const ifcKey = (path: string) => `source:ifc:${path}`;
const spatialKey = (key: string) => `source:spatial:${key}`;

/** Independent engineering and provenance projections share only source/entity
 * references. No business-tree object, physical seed or render group is input.
 */
export function projectEngineeringNavigation(sources: EngineeringSources, snapshot: EngineeringSnapshot): EngineeringNavigationData {
  const spatialNodes = new Map(sources.spatialNodes.map(node => [node.key, node]));
  const facts=collectCompositionEvidence(sources,snapshot,spatialNodes),declarations=collectDeclaredCompositionContexts(sources);
  const assignments = assignEngineeringComposition(snapshot,facts);
  const composition = projectEngineeringComposition(snapshot, assignments, '工程组成', declarations);
  const records = new Map([...sources.graph.records, ...sources.ifcRecords].map(record => [record.id, record]));
  const sourceNodes = new Map<string, EngineeringSourceNode>(), sourceRoot = 'source:project', sourceRows = new Map<string, string>();
  function add(node: EngineeringSourceNode) { sourceNodes.set(node.key, node); }
  add({ key: sourceRoot, title: 'GIM 来源（DEV / IFC）', kind: 'group', children: [] });
  add({ key: 'source:cbm', title: 'DEV 轨道（F1 / F2 / F3 / F4）', kind: 'group', parent: sourceRoot, children: [] });
  add({ key: 'source:ifc', title: 'IFC 轨道（逐文件）', kind: 'group', parent: sourceRoot, children: [] });
  const docs = new Map(sources.graph.documents.map(doc => [doc.path, doc]));
  const rootsByCbm=new Map(sources.graph.records.filter(record=>!record.parent&&record.devOccurrence).map(record=>[record.devOccurrence!.cbmOccurrenceId,record]));
  const aliasTitles=new Map(sources.graph.aliases.map(alias=>{const titles=[...new Set(alias.candidates.map(id=>records.get(id)).filter((r):r is NonNullable<typeof r>=>!!r).map(sourceRecordTitle))];return [alias.sourceId,titles.length===1?titles[0]:undefined];}));
  for (const node of sources.graph.cbmOccurrences) {
    const doc = docs.get(node.documentPath);
    const names = doc?.fields.filter(field => /^SYSTEMNAME\d+$/i.test(field.keys[0])).map(field => field.value).filter(value => value && !/^(?:-|其他|其它|NULL\d*)$/i.test(value) && !value.startsWith('&'));
    const rootRecord=rootsByCbm.get(node.id);
    const ownName=doc?.fields.some(field=>/^(?:NAME|PARTNAME|PROJECTNAME)$/i.test(field.keys[0])&&field.value.trim()&&!/^(?:-|--|无|其他|NULL\d*)$/i.test(field.value)&&!field.value.startsWith('&'));
    const raw = names?.length||ownName ? sourceDocumentTitle(doc,node.documentPath) : rootRecord ? sourceRecordTitle(rootRecord) : aliasTitles.get(node.id)??sourceDocumentTitle(doc,node.documentPath);
    const entityName = node.entityName ?? doc?.fields.find(field => /^ENTITYNAME$/i.test(field.keys[0]))?.value ?? '';
    const level = /^F[1-4](?:System)?$/i.test(entityName) ? entityName.slice(0, 2).toUpperCase() : entityName.toUpperCase() === 'PARTINDEX' ? 'PARTINDEX' : '';
    const title = level ? `${level} ${raw}` : raw;
    add({ key: cbmKey(node.id), title, kind: 'cbm', documentPath: node.documentPath, ...(level ? { fLevel: level } : {}), parent: node.parentId ? cbmKey(node.parentId) : 'source:cbm', children: [] });
  }
  for (const path of sources.graph.ifcPaths) add({ key: ifcKey(path), title: sourceDocumentTitle(undefined,path), documentPath: path, kind: 'ifc-file', parent: 'source:ifc', children: [] });
  const spatial = { nodes: sources.spatialNodes, nodeByKey: spatialNodes };
  for (const node of spatial?.nodes ?? []) add({ key: spatialKey(node.key), title: node.name || node.ifcType, kind: 'spatial', documentPath: node.sourcePath,
    parent: node.parentKey && spatial?.nodeByKey.has(node.parentKey) ? spatialKey(node.parentKey) : ifcKey(node.sourcePath), children: [] });
  for (const source of records.values()) {
    const key = recordKey(source.id);
    const containers = source.context.filter(key => spatial?.nodeByKey.has(key));
    const parent = source.parent && records.has(source.parent) ? recordKey(source.parent)
      : source.track === 'dev' && source.devOccurrence ? cbmKey(source.devOccurrence.cbmOccurrenceId)
        : source.track === 'ifc' ? containers.length ? spatialKey(containers[0]) : ifcKey(source.sources[0]) : 'source:cbm';
    add({ key, title: sourceRecordTitle(source), kind: 'record', sourceId: source.id, documentPath: source.source, parent, children: [] });
    sourceRows.set(source.id, key);
    if (!source.parent) for (const container of containers.slice(1)) add({ key: `${key}:spatial:${container}`, title: source.name || source.source_type,
      kind: 'record', sourceId: source.id, documentPath: source.source, parent: spatialKey(container), children: [] });
  }
  for (const node of sourceNodes.values()) if (node.parent) {
    const parent = sourceNodes.get(node.parent);
    if (parent) parent.children.push(node.key);
    else { node.parent = node.kind === 'record' || node.kind === 'spatial' ? 'source:ifc' : 'source:cbm'; sourceNodes.get(node.parent)!.children.push(node.key); }
  }
  const sourceSearch = [...sourceNodes.values()].filter(node => node.kind !== 'group').map(node => ({ key: node.key, title: node.title,
    subtitle: node.sourceId ? `${records.get(node.sourceId)?.source_type ?? ''} · ${node.documentPath}` : node.documentPath ?? '' }));
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
  return { version: ENGINEERING_NAVIGATION_VERSION, composition, sourceNodes, sourceRoot, sourceRows, compositionSearch, sourceSearch,
    compositionInput:{facts,declarations},
    inventory:projectEngineeringInventory(snapshot,[...records.values()]),metadata:{scope:snapshot.scope,rulesVersion:snapshot.rulesVersion,sourceComplete:sources.complete,sourceVersion:sources.version} };
}
