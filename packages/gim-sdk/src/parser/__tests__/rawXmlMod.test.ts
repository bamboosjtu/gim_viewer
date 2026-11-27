import { expect, it } from "vitest";
import { parseXmlModRoot, type XmlModNode } from "../mod.js";

const node = (
  tagName: string,
  attrs: Record<string, string> = {},
  children: XmlModNode[] = [],
): XmlModNode => ({ tagName, attrs, children });
const context = {
  sourcePath: "MOD/source.mod",
  matrixLayout: "project-column-major",
} as const;

it("keeps all raw declarations while removing ambiguous IDs from operand lookup", () => {
  const doc = parseXmlModRoot(
    node("Device", {}, [
      node("Entities", {}, [
        node("ENTITY", { ID: "001" }, [node("CUBOID")]),
        node("Entity", { ID: "1" }, [node("Cylinder")]),
        node("Entity", { ID: "?" }, [node("SPHERE")]),
        node("ENTITY", { ID: "5" }, [
          node("BOOLEAN", { ENTITY1: "1", ENTITY2: "2" }),
        ]),
      ]),
    ]),
    context,
  );
  expect(doc.status).toBe("partial");
  expect(doc.declaredEntityCount).toBe(4);
  expect(doc.entities.map((e) => e.raw.attrs.ID)).toEqual([
    "001",
    "1",
    "?",
    "5",
  ]);
  expect([...doc.entitiesById.keys()]).toEqual([5]);
  expect(
    doc.diagnostics
      .filter((d) => d.code === "missing-reference")
      .map((d) => d.field),
  ).toEqual(["Entity1", "Entity2"]);
});

it("keeps invalid matrix text and distinguishes an empty block from a missing block", () => {
  expect(
    parseXmlModRoot(node("Device", {}, [node("Entities")]), context).status,
  ).toBe("empty");
  expect(parseXmlModRoot(node("Device"), context).status).toBe("failed");
  const e = node("ENTITY", { ID: "4" }, [
    node("Cylinder"),
    node("TRANSFORMMATRIX", { VALUE: "oops" }),
  ]);
  const doc = parseXmlModRoot(
    node("Device", {}, [node("Entities", {}, [e])]),
    context,
  );
  expect(doc.diagnostics[0]).toMatchObject({
    code: "invalid-source-matrix",
    rawValue: "oops",
    entityId: 4,
    ordinal: 1,
  });
  expect(doc.entities[0].rawTransformMatrix).toBe("oops");
  expect(doc.entities[0].transformMatrix).toEqual([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
});

it("never binds conflicting identity, matrix or operand attributes by attribute order", () => {
  const declarations = [
    node("Entity", { ID: "1", id: "9" }, [node("Cuboid")]),
    node("Entity", { ID: "2" }, [
      node("Cylinder"),
      node("TransformMatrix", { Value: "bad", VALUE: "different" }),
    ]),
    node("Entity", { ID: "3" }, [
      node("Boolean", { Entity1: "1", ENTITY1: "2", Entity2: "2" }),
    ]),
  ];
  const doc = parseXmlModRoot(
    node("Device", {}, [node("Entities", {}, declarations)]),
    context,
  );
  expect([...doc.entitiesById.keys()]).toEqual([2, 3]);
  expect(doc.entities[2].operandIds).toEqual([undefined, 2]);
  expect(
    doc.diagnostics
      .filter((d) => d.code === "conflicting-field")
      .map((d) => d.ordinal),
  ).toEqual([1, 2, 3]);
  expect(
    doc.diagnostics.some(
      (d) => d.code === "invalid-source-matrix" && d.entityId === 2,
    ),
  ).toBe(true);
});
