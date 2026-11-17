import type { EngineeringNavigationData, EngineeringSourceNode } from '../services/engineeringViewService.js';
import type { CompositionNode } from '../engineering/composition.js';
import { saveTreeExport } from '../services/treeExportService.js';

export type EngineeringTreeMode = 'composition' | 'source' | 'inventory';

export interface ExportedEngineeringTreeNode {
  key: string;
  title: string;
  kind: string;
  parent?: string;
  targetId?: string;
  entityCount?: number;
  fLevel?: string;
  sourceId?: string;
  documentPath?: string;
  inferred?: boolean;
  declaredContextIds?: string[];
  category?:string;
  subtype?:string;
  subtypeLabel?:string;
  template?:string;
  classificationStatus?:string;
  boundaryStatus?:string;
  unknownReason?:string;
  grain?:string;
  confirmedCount?:number;
  attachmentCount?:number;
  sourceCount?:number;
  children: ExportedEngineeringTreeNode[];
}

export interface ExportedEngineeringTree {
  schema: 'gim-engineering-tree-v1';
  project: string;
  mode: EngineeringTreeMode;
  templateVersion?:string;
  root: ExportedEngineeringTreeNode;
  metadata?:EngineeringNavigationData['metadata'];
}

function exportComposition(data: EngineeringNavigationData, project: string): ExportedEngineeringTree {
  const nodes = data.composition.nodes;
  const visit = (key: string): ExportedEngineeringTreeNode => {
    const node: CompositionNode = nodes.get(key)!;
    return {
      key: node.key,
      title: node.title,
      kind: node.kind,
      ...(node.parent ? { parent: node.parent } : {}),
      ...(node.targetId ? { targetId: node.targetId } : {}),
      entityCount: node.entityCount,
      ...(node.inferred ? { inferred: true } : {}),
      ...(node.declaredContextIds?.length ? { declaredContextIds: [...node.declaredContextIds] } : {}),
      children: node.children.map(visit),
    };
  };
  return { schema: 'gim-engineering-tree-v1', project, mode: 'composition', root: visit(data.composition.rootKey) };
}

function exportSource(data: EngineeringNavigationData, project: string): ExportedEngineeringTree {
  const visit = (key: string): ExportedEngineeringTreeNode => {
    const node: EngineeringSourceNode = data.sourceNodes.get(key)!;
    return {
      key: node.key,
      title: node.title,
      kind: node.kind,
      ...(node.parent ? { parent: node.parent } : {}),
      ...(node.fLevel ? { fLevel: node.fLevel } : {}),
      ...(node.sourceId ? { sourceId: node.sourceId } : {}),
      ...(node.documentPath ? { documentPath: node.documentPath } : {}),
      children: node.children.map(visit),
    };
  };
  return { schema: 'gim-engineering-tree-v1', project, mode: 'source', root: visit(data.sourceRoot) };
}

/** Converts the active projection to a stable, Map-free download payload. */
export function engineeringTreeExport(data: EngineeringNavigationData, mode: EngineeringTreeMode, project: string): ExportedEngineeringTree {
  if(mode==='inventory'){
    const inventory=data.inventory;if(!inventory)throw Error('设备材料清册尚未准备好');
    const visit=(key:string):ExportedEngineeringTreeNode=>{const node=inventory.nodes.get(key)!;return {...node,children:node.children.map(visit)};};
    return {schema:'gim-engineering-tree-v1',project,mode,root:visit(inventory.rootKey),metadata:data.metadata,templateVersion:inventory.version};
  }
  const result=mode === 'composition' ? exportComposition(data, project) : exportSource(data, project);
  result.metadata=data.metadata;result.templateVersion=data.projectionVersions?.[mode];return result;
}

/** Browser-only download wrapper; the serializer above is pure and testable. */
export async function downloadEngineeringTree(data: EngineeringNavigationData, mode: EngineeringTreeMode, project: string): Promise<string | null> {
  const payload = engineeringTreeExport(data, mode, project);
  const text=JSON.stringify(payload,null,2),name=`${project.replace(/[<>:"/\\|?*]/g,'_').slice(0,100)||'工程'}-${mode==='composition'?'工程组成':mode==='source'?'来源模型树':'设备材料清册'}.json`;
  return saveTreeExport(name,text);
}

export async function copyEngineeringTree(data: EngineeringNavigationData, mode: EngineeringTreeMode, project: string): Promise<void> {
  if(!navigator.clipboard?.writeText)throw Error('当前环境无法写入剪贴板，请使用导出 JSON');
  await navigator.clipboard.writeText(JSON.stringify(engineeringTreeExport(data,mode,project),null,2));
}
