import { describe, expect, it } from "vitest";
import { resolveMaterial } from "../materialResolver.js";
import { resolveComponents } from "../componentResolver.js";
import { contextualRule } from "../recognitionPolicy.js";

const evidence = (value: string) => ({ value, evidenceId: `e:${value}` });

describe("semantic recognition decisions", () => {
  it("resolves material membership before component filtering", () => {
    const material = resolveMaterial({
      declarations: [evidence("接地电阻")],
      materialDeclarations: [evidence("接地电阻")],
      componentContext: true,
      independent: false,
      componentHint: { componentIds: ["ground_resistance"] },
      ruleFor: contextualRule,
    });
    expect(material.groundMaterial).toBe(true);
    expect(material.groundMember).toBe(true);
    expect(material.materialCode).toBe("M06");
    expect(material.modelTerms("接地电阻").length).toBeGreaterThan(0);
  });

  it("keeps component/standard priority explicit and records unknown namespace ambiguity", () => {
    const components = resolveComponents({
      declarations: [evidence("zzunknownpart")],
      componentEntries: {
        zzunknownpart: { componentIds: ["part-a", "part-b"] },
      },
      componentHint: undefined,
      cabinetMember: false,
      independent: false,
      componentContext: false,
      modelTerms: () => [
        {
          id: "x",
          kind: "equipment",
          label: "X",
          term: "x",
          category: "x",
          recognitionCode: "E01",
          catalogCategory: "x",
          catalogGroup: "x",
        },
      ],
      groundWord: () => false,
      ruleFor: contextualRule,
      namespaceAmbiguities: [],
    });
    expect(components.componentDeclarations).toEqual([]);
    expect(components.namespaceAmbiguities).toEqual(["zzunknownpart"]);
    expect(components.componentIds("zzunknownpart")).toEqual([
      "part-a",
      "part-b",
    ]);
  });
});
