import { describe, it, expect, vi } from "vitest";
import { parseXmlModRoot, type XmlModNode } from "../../parser/mod.js";
import { queryXmlModBounds, analyzePrimitive } from "../analysisGeometry.js";
import * as compiler from "../compilePrimitive.js";
const node = (
  tagName: string,
  attrs: Record<string, string> = {},
  children: XmlModNode[] = [],
): XmlModNode => ({ tagName, attrs, children });
const matrix = (x: number) =>
  node("TransformMatrix", { Value: `1,0,0,0,0,1,0,0,0,0,1,0,${x},0,0,1` });
const box = () => node("Cuboid", { L: "2", W: "2", H: "2" });
const entity = (id: number, visible: boolean, ...children: XmlModNode[]) =>
  node("Entity", { ID: String(id), Visible: String(visible) }, children);
const doc = (rows: XmlModNode[]) =>
  parseXmlModRoot(node("Device", {}, [node("Entities", {}, rows)]), {
    sourcePath: "t.mod",
    matrixLayout: "project-column-major",
  });
const bool = (Type: string, Entity1 = "1", Entity2 = "2") =>
  node("Boolean", { Type, Entity1, Entity2 });
describe("mesh-independent MOD bounds", () => {
  it("includes Float32-rounded vertices in a display envelope", () => {
    const source = doc([
      entity(1, true, node("Cylinder", { R: "0.1", H: "1" })),
    ]);
    expect(queryXmlModBounds(source, { purpose: "analytical" })).toMatchObject({
      bounds: { max: [0.1, 0.1, 1] },
    });
    expect(queryXmlModBounds(source, { purpose: "display" })).toMatchObject({
      bounds: { max: [Math.fround(0.1), Math.fround(0.1), 1] },
    });
  });
  it("G12 applies each edge once and distinguishes mathematical and displayed intersections", () => {
    const spy = vi.spyOn(compiler, "compilePrimitive");
    try {
      for (const [op, min, max] of [
        ["Union", 0, 3],
        ["Difference", 0, 2],
        ["Intersection", 1, 2],
      ] as const) {
        const raw = doc([
          entity(1, false, box(), matrix(1)),
          entity(2, false, box(), matrix(2)),
          entity(3, true, bool(op), matrix(10)),
        ]);
        expect(queryXmlModBounds(raw, { purpose: "analytical" })).toMatchObject(
          {
            coverage: "conservative",
            bounds: { min: [min + 10, -1, 0], max: [max + 10, 1, 2] },
          },
        );
      }
      const raw = doc([
        entity(1, false, box(), matrix(1)),
        entity(2, false, box(), matrix(4)),
        entity(3, true, bool("Intersection")),
      ]);
      expect(queryXmlModBounds(raw, { purpose: "analytical" })).toEqual({
        coverage: "empty",
      });
      expect(queryXmlModBounds(raw, { purpose: "display" })).toMatchObject({
        coverage: "conservative",
        bounds: { min: [0, -1, 0], max: [2, 1, 2] },
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it("keeps incomplete operands unknown, includes independent roots, and isolates cycles", () => {
    for (const bad of [
      entity(2, false, box(), node("TransformMatrix", { Value: "bad" })),
      entity(2, false, node("Unknown")),
      entity(2, false, bool("Union", "1", "3")),
      entity(9, false, box()),
    ]) {
      const raw = doc([
        entity(1, false, box()),
        bad,
        entity(3, true, bool("Difference")),
        entity(4, true, box(), matrix(20)),
      ]);
      expect(queryXmlModBounds(raw, { purpose: "display" })).toMatchObject({
        coverage: "unknown",
        knownBounds: { min: [19, -1, 0], max: [21, 1, 2] },
      });
    }
  });
  it("derives cylinder end ports directly in local mm", () => {
    expect(
      analyzePrimitive({ kind: "Cylinder", radius: 3, height: 7 }),
    ).toMatchObject({
      range: { bounds: { min: [-3, -3, 0], max: [3, 3, 7] } },
      ports: [{ position: [0, 0, 0] }, { position: [0, 0, 7] }],
    });
  });

  it("retains a touching box and applies a nested rotation in its parent's frame", () => {
    const raw = doc([
      entity(1, false, box(), matrix(1)),
      entity(2, false, box(), matrix(3)),
      entity(
        3,
        false,
        bool("Intersection"),
        node("TransformMatrix", { Value: "0,1,0,0,-1,0,0,0,0,0,1,0,0,0,0,1" }),
      ),
      entity(4, true, bool("Union", "3", "3"), matrix(10)),
    ]);
    expect(queryXmlModBounds(raw, { purpose: "analytical" })).toMatchObject({
      coverage: "conservative",
      bounds: { min: [9, 2, 0], max: [11, 2, 2] },
    });
  });
});
