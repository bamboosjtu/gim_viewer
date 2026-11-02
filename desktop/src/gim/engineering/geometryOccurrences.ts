import type { EngineeringSourceGraph } from './sourceGraph.js';
import { isUsableAffineMatrix } from '../geometry/affineMatrix.js';

/** Physical placement input. Neither an engineering entity nor a UI node. */
export interface SourceGeometryOccurrence {
  id: string;
  sourceId: string;
  sourceContextId: string;
  devPath: string;
  name: string;
  /** Column-major, cumulative CBM source transform. Geometry placement applies
   * the existing millimetre/unit and source-axis conversion exactly once. */
  placementMatrix: number[];
}
export interface SourceGeometryOccurrenceCatalog {
  occurrences: SourceGeometryOccurrence[];
  diagnostics: Array<{ sourceContextId: string; documentPath: string; reason: 'invalid-source-matrix' | 'invalid-cumulative-matrix' }>;
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const result = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++)
    for (let k = 0; k < 4; k++) result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return result;
}

/** Real DEV roots were identified by actual assembly references in the source
 * adapter. F tags, role/classification and design depth do not select seeds. */
export function collectSourceGeometryOccurrences(graph: EngineeringSourceGraph): SourceGeometryOccurrenceCatalog {
  const nodes = new Map(graph.cbmOccurrences.map(node => [node.id, node]));
  const docs = new Map(graph.documents.map(doc => [doc.path, doc]));
  const matrices = new Map<string, number[]>(), active = new Set<string>();
  const diagnostics: SourceGeometryOccurrenceCatalog['diagnostics'] = [];
  function placement(key: string): number[] {
    const cached = matrices.get(key); if (cached) return cached;
    const node = nodes.get(key);
    if (!node || active.has(key)) throw Error('Invalid source occurrence graph for geometry placement');
    active.add(key);
    const parent = node.parentId ? placement(node.parentId) : identity();
    const field = docs.get(node.documentPath)?.fields.find(field => field.keys[0].toUpperCase() === 'TRANSFORMMATRIX');
    let local = identity();
    if (field?.value.trim()) {
      const parts = field.value.split(','), values = parts.map(part => Number(part.trim()));
      if (parts.every(part => part.trim()) && isUsableAffineMatrix(values)) local = values;
      else diagnostics.push({ sourceContextId: key, documentPath: node.documentPath, reason: 'invalid-source-matrix' });
    }
    let result = multiply(parent, local);
    if (!isUsableAffineMatrix(result)) { diagnostics.push({ sourceContextId: key, documentPath: node.documentPath, reason: 'invalid-cumulative-matrix' }); result = identity(); }
    active.delete(key); matrices.set(key, result); return result;
  }
  const occurrences: SourceGeometryOccurrence[] = [], seen = new Set<string>();
  for (const record of graph.records) {
    const address = record.devOccurrence;
    if (!address || address.rootSourceId !== record.id) continue;
    if (seen.has(record.id) || !nodes.has(address.cbmOccurrenceId)) throw Error('Invalid physical source occurrence identity');
    seen.add(record.id);
    occurrences.push({ id: record.id, sourceId: record.id, sourceContextId: address.cbmOccurrenceId,
      devPath: record.source, name: record.name, placementMatrix: placement(address.cbmOccurrenceId).slice() });
  }
  return { occurrences, diagnostics };
}
