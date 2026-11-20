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
    const doc = parseXmlModRoot(root, "MOD/cylinder.mod");
    expect(doc.isEmpty).toBe(false);
    expect(doc.declaredEntityCount).toBe(1);
    expect(doc.entities[0].id).toBe(7);
    expect(doc.entities[0].transformMatrix[12]).toBe(4);
    expect(doc.entities[0].color).toEqual({ r: 200, g: 50, b: 50, a: 100 });
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
