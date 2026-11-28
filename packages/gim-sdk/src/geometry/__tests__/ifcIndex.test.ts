import { expect, it } from "vitest";
import {
  ifcLocalMetreBox,
  includeIfcMetreBox,
  queryIfcIndexRange,
  ifcSourceRestoration,
} from "../formats/ifc.js";
import { composePlacement } from "../affineMatrix.js";
it("answers restored indexed bounds without a backend or template buffer", () => {
  const local = ifcLocalMetreBox(
    Float32Array.of(-1, 0, 2, 0, 0, 1, 3, 1, 5, 0, 0, 1),
  );
  const raw = [-2, 0, 0, 0, 1, 3, 0, 0, 0, 0, 4, 0, 1, 0, 6, 1];
  const K = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10, 0, 0, 1];
  const restore = ifcSourceRestoration({
    kind: "coordination-applied",
    coordinationMatrix: K,
  })!;
  const total = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  includeIfcMetreBox(total, local, composePlacement(restore, raw));
  expect(total).toEqual([5, 0, 14, 14, 3, 26]);
  expect(queryIfcIndexRange(total)).toMatchObject({
    coverage: "conservative",
    bounds: { min: [5000, -26000, 0], max: [14000, -14000, 3000] },
  });
  expect(queryIfcIndexRange(undefined)).toEqual({ coverage: "unknown" });
  expect(queryIfcIndexRange([10, 1, 1, -2, -1, 3])).toEqual({
    coverage: "unknown",
  });
});
