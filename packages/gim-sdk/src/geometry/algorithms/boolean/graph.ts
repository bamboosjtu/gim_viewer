import { composePlacement } from "../../affineMatrix.js";
export type BooleanOperation = "Union" | "Difference" | "Intersection";
export interface BooleanNode {
  readonly localToParent: readonly number[];
  readonly operation?: {
    readonly op: BooleanOperation;
    readonly entity1: number;
    readonly entity2: number;
  };
}
export interface OutlineLeaf {
  readonly id: number;
  readonly matrix: readonly number[];
}
export function* visibleGeometryRoots<T extends { visible: boolean }>(
  rows: Iterable<T>,
  slice?: { index: number; total: number },
) {
  let ordinal = 0;
  for (const row of rows)
    if (row.visible && (!slice || ordinal++ % slice.total === slice.index))
      yield row;
}

/** Each plan is scoped to an immutable source document and one detail request. Hidden declarations remain operands. */
export class BooleanGraph {
  private readonly outlines = new Map<number, OutlineLeaf[]>();
  private readonly active = new Set<number>();
  readonly failures = new Map<number, string>();
  constructor(readonly node: (id: number) => BooleanNode | undefined) {}
  *outline(
    id: number,
    leaf: (id: number) => boolean,
    simplified: (op: BooleanOperation) => void,
  ): Generator<void, OutlineLeaf[], void> {
    const cached = this.outlines.get(id);
    if (cached) return cached;
    const node = this.node(id);
    if (!node || this.active.has(id)) {
      this.failures.set(id, node ? "cycle" : "missing-reference");
      return [];
    }
    this.active.add(id);
    try {
      let pieces: OutlineLeaf[] = [];
      const operation = node.operation;
      if (!operation) {
        if (leaf(id)) pieces = [{ id, matrix: node.localToParent }];
      } else {
        const first = yield* this.outline(operation.entity1, leaf, simplified);
        const second =
          operation.op === "Union"
            ? yield* this.outline(operation.entity2, leaf, simplified)
            : [];
        pieces = [...first, ...second].map((p) => ({
          id: p.id,
          matrix: composePlacement(node.localToParent, p.matrix),
        }));
        simplified(operation.op);
      }
      this.outlines.set(id, pieces);
      yield;
      return pieces;
    } finally {
      this.active.delete(id);
    }
  }
  /** Include the skipped cutter in source diagnostics without evaluating its geometry. */
  dependencies(root: number) {
    const seen = new Set<number>(),
      active = new Set<number>(),
      stack = [{ id: root, leave: false }];
    while (stack.length) {
      const { id, leave } = stack.pop()!;
      if (leave) {
        active.delete(id);
        continue;
      }
      if (active.has(id)) {
        this.failures.set(id, "cycle");
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const n = this.node(id);
      if (!n) {
        this.failures.set(id, "missing-reference");
        continue;
      }
      if (!n.operation) continue;
      active.add(id);
      stack.push(
        { id, leave: true },
        { id: n.operation.entity2, leave: false },
        { id: n.operation.entity1, leave: false },
      );
    }
    return seen;
  }
}
export function outlinePartThresholdMm(kind: string): number {
  switch (kind) {
    case "CircularFixedPlate":
    case "BendingCylindrical":
    case "EllipticRing":
    case "Cylinder":
    case "Sphere":
    case "Ring":
    case "CircularGasket":
      return 100;
    case "Cuboid":
      return 50;
    default:
      return 0;
  }
}
