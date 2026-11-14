import {engineeringSourceRecords} from './sourceGraph.js';
import type { EngineeringSources } from './buildSources.js';
import { sourceDocumentTitle, sourceRecordTitle } from './sourceTitles.js';

export const SOURCE_TREE_TEMPLATE_VERSION = 'engineering-source-tree-v2';
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
const recordKey = (id: string) => `source:record:${id}`;
const cbmKey = (id: string) => `source:cbm:${id}`;
const ifcKey = (path: string) => `source:ifc:${path}`;
const spatialKey = (key: string) => `source:spatial:${key}`;


/** Faithful source organization; independent of business composition and inventory. */
export function projectEngineeringSource(sources:EngineeringSources) {
  const spatialNodes=new Map(sources.spatialNodes.map(n=>[n.key,n]));
  const records = new Map(engineeringSourceRecords(sources.graph,sources.ifcRecords).map(record => [record.id, record]));
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
      : source.attributeOnly&&source.attributeContextId?cbmKey(source.attributeContextId):source.track === 'dev' && source.devOccurrence ? cbmKey(source.devOccurrence.cbmOccurrenceId)
        : source.track === 'ifc' ? containers.length ? spatialKey(containers[0]) : ifcKey(source.sources[0]) : 'source:cbm';
    add({ key, title: sourceRecordTitle(source)+(source.attributeOnly?'（仅属性引用）':''), kind: 'record', sourceId: source.id, documentPath: source.source, parent, children: [] });
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
  return {version:SOURCE_TREE_TEMPLATE_VERSION,sourceNodes,sourceRoot,sourceRows,sourceSearch};
}
