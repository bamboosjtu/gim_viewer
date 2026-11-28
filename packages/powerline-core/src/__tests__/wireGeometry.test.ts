import { it, expect } from "vitest";
import { resolveWireEnd, wireAttachmentIndex } from "../wireGeometry.js";
const frame = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1];
it("resolves port names in tower/string scope and treats a placed matrix as a complete endpoint", () => {
  const a = {
    towerId: "A",
    stringId: "back",
    portName: "C1",
    sourcePath: "s.cbm",
    kind: "string-end" as const,
    positionMm: [2, 3, 4] as [number, number, number],
  };
  const b = {
    ...a,
    towerId: "B",
    positionMm: [20, 30, 40] as [number, number, number],
  };
  const ctx = { ...a, towerToProject: frame };
  const ports = wireAttachmentIndex([a, b]);
  expect(resolveWireEnd({}, 0, 0, ctx, ports)?.position).toEqual([997, 2, 4]);
  expect(
    resolveWireEnd({}, 0, 0, { ...ctx, towerId: "B" }, ports)?.position,
  ).toEqual([970, 20, 40]);
  expect(
    resolveWireEnd({}, 0, 0, ctx, wireAttachmentIndex([a, a])),
  ).toBeUndefined();
  const props = { "POINT0.MATRIX1": "1,0,0,0,0,1,0,0,0,0,1,0,2,3,4,1" };
  expect(resolveWireEnd(props, 0, 1, ctx, ports)).toBeUndefined();
  expect(
    resolveWireEnd(
      props,
      0,
      1,
      {
        towerId: ctx.towerId,
        matrixPlacement: {
          evidence: "confirmed",
          unit: "m",
          parentToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1],
        },
      },
      ports,
    )?.position,
  ).toEqual([3000, 3000, 4000]);
});
