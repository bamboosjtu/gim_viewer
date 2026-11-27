import { describe, expect, it, vi } from "vitest";
import { parseXmlModRoot, type XmlModNode } from "../../parser/mod.js";
import { compileXmlModDocument } from "../compileXmlModDocument.js";
import * as compiler from "../compilePrimitive.js";
import {
  checkGeometryBudget,
  DEFAULT_GEOMETRY_LIMITS,
} from "../geometryBudget.js";
import type { GeometryLimits } from "../primitiveContracts.js";

function compileNodes(nodes: XmlModNode[]) {
  const root = {
    tagName: "Device",
    attrs: {},
    children: [
      {
        tagName: "Entities",
        attrs: {},
        children: nodes.map((node, i) => ({
          tagName: "Entity",
          attrs: { ID: String(i + 1) },
          children: [node],
        })),
      },
    ],
  };
  return compileXmlModDocument(
    parseXmlModRoot(root, {
      sourcePath: "MOD/fixture.mod",
      matrixLayout: "project-column-major",
    }),
  );
}

describe("standard XML MOD compiler", () => {
  it("G09 compiles equal local shapes once per document", () => {
    const compile = vi.spyOn(compiler, "compilePrimitive");
    try {
      const result = compileNodes(
        ["2", "2e0"].map((R) => ({
          tagName: "Cylinder",
          attrs: { R, H: "5" },
          children: [],
        })),
      );
      expect(compile).toHaveBeenCalledTimes(1);
      expect(result.entities[0].templateKey).toBe(
        result.entities[1].templateKey,
      );
      expect(result.templates.size).toBe(1);
    } finally {
      compile.mockRestore();
    }
  });
  it.each(["", "0", "-1", "3mm", "Infinity", "NaN", "1e999", "0x12"])(
    "rejects an illegal source radius %j",
    (R) => {
      const result = compileNodes([
        { tagName: "Cylinder", attrs: { R, H: "1" }, children: [] },
      ]);
      expect(result.templates.size).toBe(0);
      expect(result.entities[0].diagnostics).toContainEqual(
        expect.objectContaining({
          code: "invalid-field-value",
          location: {
            path: "MOD/fixture.mod",
            entityId: 1,
            ordinal: 1,
            sourceTag: "Cylinder",
            field: "R",
          },
        }),
      );
    },
  );
  it("retains missing and unsupported sources; rejects unrepresentable Float32 meshes locally", () => {
    const result = compileNodes([
      { tagName: "Cuboid", attrs: { L: "2", H: "1" }, children: [] },
      { tagName: "Other", attrs: { raw: "x" }, children: [] },
      { tagName: "Cylinder", attrs: { R: "1e100", H: "10" }, children: [] },
      { tagName: "Cuboid", attrs: { L: "2", W: "2", H: "2" }, children: [] },
    ]);
    expect(result.entities.map((e) => e.interpretation.status)).toEqual([
      "invalid",
      "unsupported",
      "standard",
      "standard",
    ]);
    expect(result.entities[2].diagnostics[0].code).toBe("invalid-mesh-extent");
    expect(result.templates.size).toBe(1);
  });
  it.each(Object.keys(DEFAULT_GEOMETRY_LIMITS) as (keyof GeometryLimits)[])(
    "G13 checks %s at the allocation boundary",
    (name) => {
      expect(checkGeometryBudget({ [name]: 3 }, { [name]: 3 })).toBeUndefined();
      expect(checkGeometryBudget({ [name]: 4 }, { [name]: 3 })).toMatchObject({
        code: "capacity-exceeded",
        stage: "compile",
        limit: { name, requested: 4, allowed: 3 },
      });
      expect(() => checkGeometryBudget({}, { [name]: 0 })).toThrow(RangeError);
    },
  );
});
