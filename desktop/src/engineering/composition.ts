import type { EngineeringSnapshot } from './types.js';
import { categoryLabel } from './catalogLabels.js';

export interface CompositionGroup {
  key: string;
  title: string;
  kind: 'discipline' | 'system' | 'area' | 'unit' | 'building' | 'storey' | 'structure' | 'facility' | 'track' | 'category' | 'bucket';
  order?: number;
}
export interface CompositionAssignment {
  entityId: string;
  paths: CompositionGroup[][];
  evidence: string[];
  /** A projection estimate, never an entity identity or membership assertion. */
  inferred?: boolean;
}
export interface CompositionDeclaration {
  path: CompositionGroup[];
  evidence: string[];
  sourceContextIds: string[];
}
export interface CompositionNode {
  key: string;
  title: string;
  kind: 'project' | 'group' | 'entity' | 'pending';
  targetId?: string;
  children: string[];
  parent?: string;
  entityCount: number;
  evidence: string[];
  inferred?: boolean;
  declaredContextIds?: string[];
  /** A declared composition anchor with no confirmed engineering whole. */
  unbound?: boolean;
}
export interface EngineeringComposition {
  version: string;
  rootKey: string;
  nodes: Map<string, CompositionNode>;
  rowsByEntity: Map<string, string[]>;
}
export const ENGINEERING_COMPOSITION_VERSION = 'engineering-composition-v10';
function groupOrder(part:CompositionGroup):number|undefined {
  if(part.kind==='area')return part.key==='area:main'?20:21-(Number(part.title.match(/\d+/)?.[0])||0)/10000;
  if(part.kind==='building'){
    if(/主控|通信|控制楼/.test(part.title))return 0;
    const voltage=part.title.match(/(\d+)\s*(?:千伏|kV)/i);
    if(voltage)return 1-Number(voltage[1])/10000;
    return /辅助/.test(part.title)?9:5;
  }
  return part.order;
}
const childKey = (parent: string, kind: string, value: string) => `${parent}/${encodeURIComponent(kind)}:${encodeURIComponent(value)}`;

/** A view references whole entities; neither a row nor a group becomes a new
 * engineering object. Counts remain unique when an entity has several contexts.
 */
export function projectEngineeringComposition(snapshot: EngineeringSnapshot, assignments: readonly CompositionAssignment[], title: string, declarations: readonly CompositionDeclaration[] = []): EngineeringComposition {
  const rootKey = 'engineering:project', nodes = new Map<string, CompositionNode>(), rowsByEntity = new Map<string, string[]>();
  const members = new Map<string, Set<string>>();
  const orders = new Map<string, number>();
  nodes.set(rootKey, { key: rootKey, title: title || '工程组成', kind: 'project', children: [], entityCount: 0, evidence: [] });
  const byEntity = new Map(assignments.map(a => [a.entityId, a]));
  function group(parent: string, kind: string, value: string, name: string, evidence: string[], inferred = false): string {
    const key = childKey(parent, kind, value);
    if (!nodes.has(key)) {
      nodes.set(key, { key, parent, title: name, kind: 'group', children: [], entityCount: 0, evidence, ...(inferred ? {inferred:true} : {}) });
      nodes.get(parent)!.children.push(key);
    } else if (!inferred) delete nodes.get(key)!.inferred;
    return key;
  }
  const anchors = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    let parent = rootKey;
    for (const part of declaration.path) { parent = group(parent, part.kind, part.key, part.title, declaration.evidence); const order=groupOrder(part);if (order !== undefined) orders.set(parent, order); }
    const ids = anchors.get(parent) ?? new Set<string>(); declaration.sourceContextIds.forEach(id => ids.add(id)); anchors.set(parent, ids);
  }
  for (const [key, contexts] of anchors) nodes.get(key)!.declaredContextIds = [...contexts].sort();
  for (const entity of snapshot.entities) {
    const assignment = byEntity.get(entity.id);
    const paths = assignment?.paths.length ? assignment.paths : [[]];
    const seen = new Set<string>();
    for (const path of paths) {
      let parent = rootKey;
      if (!path.length) parent = group(parent, 'unresolved', 'context', '工程归属待确认', []);
      for (const part of path) { parent = group(parent, part.kind, part.key, part.title, assignment?.evidence ?? [], !!assignment?.inferred && ['building','storey','area','structure'].includes(part.kind)); const order=groupOrder(part);if (order !== undefined) orders.set(parent, order); }
      const terminalBucket = path[path.length - 1]?.kind === 'bucket';
      if (!terminalBucket) parent = group(parent, 'category', entity.category, categoryLabel(entity.category), []);
      if (seen.has(parent)) continue; seen.add(parent);
      const key = childKey(parent, 'entity', entity.id);
      nodes.set(key, { key, title: entity.name || categoryLabel(entity.category), kind: 'entity', targetId: entity.id, parent, children: [], entityCount: 1, evidence: assignment?.evidence ?? [], ...(assignment?.inferred ? {inferred:true} : {}) });
      nodes.get(parent)!.children.push(key);
      const rows = rowsByEntity.get(entity.id) ?? []; rows.push(key); rowsByEntity.set(entity.id, rows);
      for (let cursor: string | undefined = parent; cursor; cursor = nodes.get(cursor)?.parent) {
        const ids = members.get(cursor) ?? new Set<string>(); ids.add(entity.id); members.set(cursor, ids);
      }
    }
  }
  if (snapshot.pending.length) {
    const unresolved = group(rootKey, 'discipline', 'unclassified', '未分类', []);
    orders.set(unresolved, 2);
    const other = group(unresolved, 'category', 'pending-other', '其他', []);
    const parent = group(other, 'pending', 'wholes', '整体归属待确认', []);
    for (const pending of snapshot.pending) {
      const key = childKey(parent, 'pending', pending.id);
      nodes.set(key, { key, title: `待归整体集合 · ${pending.sourceIds.length} 个来源`, kind: 'pending', targetId: pending.id, parent, children: [], entityCount: 0, evidence: [pending.reason] });
      nodes.get(parent)!.children.push(key); rowsByEntity.set(pending.id, [key]);
    }
  }
  for (const [key, node] of nodes) {
    if (node.kind === 'group' || node.kind === 'project') node.entityCount = members.get(key)?.size ?? 0;
    if (node.kind === 'group' && node.declaredContextIds?.length && node.entityCount === 0) node.unbound = true;
    node.children.sort((a, b) => (orders.get(a) ?? 100) - (orders.get(b) ?? 100) || nodes.get(a)!.title.localeCompare(nodes.get(b)!.title, 'zh-CN', { numeric: true }) || a.localeCompare(b));
  }
  return { version: ENGINEERING_COMPOSITION_VERSION, rootKey, nodes, rowsByEntity };
}

/** Final composition shows represented membership, while empty source
 * declarations remain available in the independent provenance view. */
export function finalizeEngineeringComposition(view:EngineeringComposition):EngineeringComposition {
  function prune(key:string):boolean {
    const node=view.nodes.get(key)!;
    node.children=node.children.filter(prune);
    if(node.kind==='group'&&node.entityCount===0&&node.children.length===0){view.nodes.delete(key);return false;}
    return true;
  }
  prune(view.rootKey);return view;
}
