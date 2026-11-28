import { expect, it } from "vitest";
import { identityPlacement } from "../affineMatrix.js";
import {
  BooleanGraph,
  visibleGeometryRoots,
  outlinePartThresholdMm,
  type BooleanNode,
  type BooleanOperation,
} from "../algorithms/boolean/graph.js";
const t = (x: number) => [...identityPlacement.slice(0, 12), x, 0, 0, 1];
function collect<T>(gen: Generator<void, T, void>) {
  let value = gen.next();
  while (!value.done) value = gen.next();
  return value.value;
}
it.each(["Union", "Difference", "Intersection"] as const)(
  "retains ordered hidden leaves and placed outline for %s",
  (op) => {
    const nodes = new Map<number, BooleanNode>([
      [1, { localToParent: t(1) }],
      [2, { localToParent: t(3) }],
      [3, { localToParent: t(7), operation: { op, entity1: 1, entity2: 2 } }],
    ]);
    const graph = new BooleanGraph((id) => nodes.get(id)),
      ops: BooleanOperation[] = [];
    expect(
      collect(
        graph.outline(
          3,
          () => true,
          (o) => ops.push(o),
        ),
      ).map((p) => [p.id, p.matrix[12]]),
    ).toEqual(
      op === "Union"
        ? [
            [1, 8],
            [2, 10],
          ]
        : [[1, 8]],
    );
    expect([...graph.dependencies(3)]).toEqual([3, 1, 2]);
    expect(ops).toEqual([op]);
    expect(
      [
        ...visibleGeometryRoots([
          { id: 1, visible: false },
          { id: 3, visible: true },
        ]),
      ].map((x) => x.id),
    ).toEqual([3]);
  },
);
it("records a cycle and missing skipped cutter with bounded traversal", () => {
  const graph = new BooleanGraph((id) =>
    id === 1
      ? {
          localToParent: t(0),
          operation: { op: "Difference", entity1: 1, entity2: 8 },
        }
      : undefined,
  );
  expect(
    collect(
      graph.outline(
        1,
        () => true,
        () => {},
      ),
    ),
  ).toEqual([]);
  graph.dependencies(1);
  expect([...graph.failures]).toEqual([
    [1, "cycle"],
    [8, "missing-reference"],
  ]);
  expect(outlinePartThresholdMm("Wire")).toBe(0);
});
