import type { CbmNode } from './types.js';
import type { SourceGeometryOccurrence } from './engineering/geometryOccurrences.js';
import { isSubstationGeometryRoot } from './substationEvidence.js';
import { isUsableAffineMatrix } from './geometry/affineMatrix.js';

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Active standalone-equipment browser adapter. Its assembly tree is also the
 * equipment selection address space; substation engineering never uses it. */
export function collectEquipmentGeometryOccurrences(root: CbmNode | null): SourceGeometryOccurrence[] {
  const result: SourceGeometryOccurrence[] = [];
  function visit(node: CbmNode, parent: number[]): void {
    const values = node.transformMatrix?.split(',').map(part => Number(part.trim()));
    const local = values && node.transformMatrix.split(',').every(part => part.trim()) && isUsableAffineMatrix(values) ? values : identity();
    const placement = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++)
      placement[c * 4 + r] += parent[k * 4 + r] * local[c * 4 + k];
    if (isSubstationGeometryRoot(node)) result.push({ id: node.path, sourceId: node.path,
      sourceContextId: node.path, devPath: node.devPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''), name: node.name, placementMatrix: placement });
    node.children.forEach(child => visit(child, placement));
  }
  if (root) visit(root, identity());
  return result;
}
