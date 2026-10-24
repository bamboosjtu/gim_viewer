import type { CbmNode, IfcEntry } from './types.js';
import { resolveIfcModelId } from './modelIdentity.js';

export interface IfcConnectionOwnership {
  status: 'confirmed' | 'ambiguous' | 'unresolved';
  semanticNodes: readonly CbmNode[];
  /** Physical DEV containment is separate from electrical endpoint topology. */
  deviceNodes: readonly CbmNode[];
}
/** Source-scoped exact IFCGUID evidence. Repeated aliases remain candidates;
 * a semantic CBM object is never silently promoted to an electrical device. */
export class IfcConnectionOwnershipIndex {
  private matches = new Map<string, CbmNode[]>();
  private parent = new Map<CbmNode, CbmNode>();
  constructor(root: CbmNode | null, entries: readonly IfcEntry[]) {
    const walk = (node: CbmNode, parent?: CbmNode): void => {
      if (parent) this.parent.set(node, parent);
      if (node.ifcFile && node.ifcGuid) {
        const modelId = resolveIfcModelId(node.ifcFile, entries);
        if (modelId) {
          const key = `${modelId}\0${node.ifcGuid.trim()}`, nodes = this.matches.get(key) ?? [];
          nodes.push(node); this.matches.set(key, nodes);
        }
      }
      for (const child of node.children) walk(child, node);
    };
    if (root) walk(root);
  }
  get(modelId: string, globalId: string): IfcConnectionOwnership {
    // Compressed IFC GUIDs are case sensitive. No bare-GUID, name or spatial
    // fallback is allowed when source identity/explicit references are absent.
    const semanticNodes = this.matches.get(`${modelId}\0${globalId.trim()}`) ?? [];
    const deviceNodes = new Map<string, CbmNode>();
    for (const semantic of semanticNodes) {
      for (let node: CbmNode | undefined = semantic; node; node = this.parent.get(node)) {
        if (node.devPath && node.entityName.toUpperCase() !== 'PARTINDEX') { deviceNodes.set(node.path, node); break; }
      }
    }
    return {status: semanticNodes.length === 1 ? 'confirmed' : semanticNodes.length ? 'ambiguous' : 'unresolved',
      semanticNodes, deviceNodes: [...deviceNodes.values()]};
  }
}
const cache = new WeakMap<CbmNode, {entries: readonly IfcEntry[]; index: IfcConnectionOwnershipIndex}>();
export function ifcConnectionOwnershipIndex(root: CbmNode | null, entries: readonly IfcEntry[]): IfcConnectionOwnershipIndex {
  if (!root) return new IfcConnectionOwnershipIndex(null, entries);
  const existing = cache.get(root);
  if (existing?.entries === entries) return existing.index;
  const index = new IfcConnectionOwnershipIndex(root, entries); cache.set(root, {entries, index}); return index;
}
