import { describe, expect, it } from "vitest";
import {
  classifyLineMod,
  parseLineMod,
  parseXmlModRoot,
  type XmlModNode,
} from "../mod.js";

function entityNode(id: string, children: XmlModNode[]): XmlModNode {
  return {
    tagName: "Entity",
    attrs: { ID: id, Type: "simple", Visible: "True" },
    children,
  };
}

describe("independent substation XML MOD parser", () => {
  it("parses the Device/Entities/Entity grammar without a DOM", () => {
    const root: XmlModNode = {
      tagName: "Device",
      attrs: {},
      children: [
        {
          tagName: "Entities",
          attrs: {},
          children: [
            entityNode("7", [
              {
                tagName: "Cylinder",
                attrs: { R: "50", H: "300" },
                children: [],
              },
              {
                tagName: "TransformMatrix",
                attrs: { Value: "1,0,0,0,0,1,0,0,0,0,1,0,4,5,6,1" },
                children: [],
              },
              {
                tagName: "Color",
                attrs: { R: "200", G: "50", B: "50", A: "100" },
                children: [],
              },
            ]),
          ],
        },
      ],
    };
    const doc = parseXmlModRoot(root, "MOD/cylinder.mod", (tagName, attrs) =>
      tagName === "Cylinder"
        ? { type: "Cylinder", r: Number(attrs.R), h: Number(attrs.H) }
        : null,
    );
    expect(doc.isEmpty).toBe(false);
    expect(doc.declaredEntityCount).toBe(1);
    expect(doc.entities[0].id).toBe(7);
    expect(doc.entities[0].transformMatrix[12]).toBe(4);
    expect(doc.entities[0].color).toEqual({ r: 200, g: 50, b: 50, a: 100 });
  });
});

describe("substation XML MOD parser diagnostics", () => {
  it("distinguishes a missing matrix from an invalid matrix", () => {
    const mapper = () => ({ type: "Cuboid" as const, l: 1, w: 1, h: 1 });
    const node = (matrix?: string): XmlModNode => ({
      tagName: "Device",
      attrs: {},
      children: [
        {
          tagName: "Entities",
          attrs: {},
          children: [
            {
              tagName: "Entity",
              attrs: { ID: "1" },
              children: [
                { tagName: "Cuboid", attrs: {}, children: [] },
                ...(matrix === undefined
                  ? []
                  : [
                      {
                        tagName: "TransformMatrix",
                        attrs: { Value: matrix },
                        children: [],
                      },
                    ]),
              ],
            },
          ],
        },
      ],
    });
    expect(
      parseXmlModRoot(node(), "MOD/missing.mod", mapper).diagnostics,
    ).toEqual([]);
    const invalid = parseXmlModRoot(node("1,0,0"), "MOD/invalid.mod", mapper);
    expect(invalid.entities[0].transformMatrix).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    expect(invalid.diagnostics[0]).toMatchObject({
      severity: "warning",
      code: "invalid-source-matrix",
      path: "MOD/invalid.mod",
      rawValue: "1,0,0",
    });
  });

  it("reports id, missing and unsupported primitive failures without dropping unsupported objects", () => {
    const entity = (
      entityAttrs: Record<string, string>,
      children: XmlModNode[] = [],
    ) => ({
      tagName: "Device",
      attrs: {},
      children: [
        {
          tagName: "Entities",
          attrs: {},
          children: [
            {
              tagName: "Entity",
              attrs: entityAttrs,
              children,
            },
          ],
        },
      ],
    });
    const mapper = () => null;
    const invalidId = parseXmlModRoot(
      entity({ ID: "1abc" }),
      "MOD/id.mod",
      mapper,
    );
    expect(invalidId.entities).toEqual([]);
    expect(invalidId.diagnostics[0]).toMatchObject({
      code: "invalid-entity-id",
      rawValue: "1abc",
    });

    const missing = parseXmlModRoot(
      entity({ ID: "1" }),
      "MOD/missing.mod",
      mapper,
    );
    expect(missing.entities).toEqual([]);
    expect(missing.diagnostics[0].code).toBe("missing-primitive");

    const unsupported = parseXmlModRoot(
      entity({ ID: "1" }, [
        { tagName: "Mystery", attrs: { A: "1" }, children: [] },
      ]),
      "MOD/unsupported.mod",
      mapper,
    );
    expect(unsupported.entities[0].primitive).toMatchObject({
      type: "Unsupported",
      sourceType: "Mystery",
      raw: { A: "1" },
    });
    expect(unsupported.diagnostics[0]).toMatchObject({
      code: "unsupported-primitive",
      rawValue: 'Mystery {"A":"1"}',
    });
    expect(unsupported.status).toBe("partial");
  });

  it.each([
    ["1abc", "1abc" + ",0".repeat(15)],
    ["Infinity", "Infinity" + ",0".repeat(15)],
    ["NaN", "NaN" + ",0".repeat(15)],
    ["empty slot", "1,,0" + ",0".repeat(13)],
    ["projective", "1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0"],
  ])("rejects a malformed or unusable matrix token: %s", (_label, value) => {
    const mapper = () => ({ type: "Cuboid" as const, l: 1, w: 1, h: 1 });
    const doc = parseXmlModRoot(
      {
        tagName: "Device",
        attrs: {},
        children: [
          {
            tagName: "Entities",
            attrs: {},
            children: [
              {
                tagName: "Entity",
                attrs: { ID: "1" },
                children: [
                  { tagName: "Cuboid", attrs: {}, children: [] },
                  {
                    tagName: "TransformMatrix",
                    attrs: { Value: value },
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      "MOD/strict.mod",
      mapper,
    );
    expect(doc.entities[0].transformMatrix).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    expect(doc.diagnostics[0]).toMatchObject({
      severity: "warning",
      code: "invalid-source-matrix",
      path: "MOD/strict.mod",
      rawValue: value,
    });
  });
});

describe("line MOD format family", () => {
  it("keeps line MOD selection separate from substation XML MOD", () => {
    const line = "KEY=VALUE\nOTHER=2";
    expect(classifyLineMod(line)).toBe("text-key-value");
    expect(parseLineMod(line, "MOD/line.mod").format).toBe("text-key-value");
    expect(classifyLineMod("<Device><Entities /></Device>")).toBeNull();
  });
});
