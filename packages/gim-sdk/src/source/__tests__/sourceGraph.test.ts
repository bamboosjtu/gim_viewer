import { describe, expect, it, vi } from "vitest";
import {
  extractEngineeringSourceGraph,
  materializeEngineeringFamilies,
} from "../sourceGraph.js";
import { toObjectEvidence } from "../../adapters/recognizeSource.js";
import { normalizeEngineeringModel } from "../../semantic/normalize.js";

function files(entries: Record<string, string>) {
  return {
    paths: Object.keys(entries),
    readText: async (path: string) => entries[path],
  };
}

describe("independent engineering source graph", () => {
  it("keeps lazy family ownership identical to eager expansion without inheriting root CBM attributes", async () => {
    const input = files({
      "project.cbm":
        "OBJECTMODELPOINTER=root.dev\nBASEFAMILY=root.fam\nSUBDEVICE0=part.cbm",
      "root.dev": "TYPE=GIS\nSUBDEVICE0=part.dev",
      "part.dev": "TYPE=ACPorcelainCircuitBreaker",
      "root.fam":
        "[设计]\n设备类型=EQUIPMENTTYPE=GIS\n设备编码=GRIDIDENTIFICATIONSYSTEMCODE=root-code",
      "part.cbm":
        "ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev\nBASEFAMILY=part.fam",
      "part.fam": "[设计]\n设备名称=DEVICENAME=child-name",
    });
    const readText = vi.fn(input.readText);
    const eager = await extractEngineeringSourceGraph(input),
      lazy = await extractEngineeringSourceGraph(
        { ...input, readText },
        {
          deferFamilies: true,
        },
      );
    expect(
      readText.mock.calls.flat().filter((path) => path.endsWith(".fam")),
    ).toEqual([]);
    expect(
      lazy.documents.every((document) => !document.path.endsWith(".fam")),
    ).toBe(true);
    await materializeEngineeringFamilies(lazy, readText);
    expect(
      readText.mock.calls.flat().filter((path) => path.endsWith(".fam")),
    ).toEqual(["root.fam", "part.fam"]);
    const materialized = structuredClone(lazy);
    const readCount = readText.mock.calls.length;
    await materializeEngineeringFamilies(lazy, readText);
    expect(readText).toHaveBeenCalledTimes(readCount);
    expect(lazy).toEqual(materialized);
    for (const child of lazy.records.filter((row) => row.parent)) {
      expect(child.properties.some((p) => p.path === "root.fam")).toBe(false);
      expect(child.properties.some((p) => p.path === "part.fam")).toBe(true);
    }
    const observations = (graph: typeof eager) =>
      graph.records.map((row) => ({
        id: row.id,
        properties: [...row.properties].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      }));
    expect(observations(lazy)).toEqual(observations(eager));
    expect(
      normalizeEngineeringModel(
        "case",
        lazy.records.map(toObjectEvidence),
      ).memberships.find((m) => m.sourceId === lazy.records[1].id)
        ?.interpretation,
    ).toMatchObject({ category: "E06", categoryStatus: "confirmed" });
  });
  it("reads shared documents once and preserves reference order across repeated occurrences", async () => {
    const raw: Record<string, string> = {
      "project.cbm": "SUBSYSTEM0=unit.cbm\nSUBSYSTEM1=unit.cbm",
      "unit.cbm":
        "OBJECTMODELPOINTER=unit.dev\nIFCFILE=models/first.ifc$\nIFCFILE=models/second.ifc",
      "unit.dev": "SYMBOLNAME=断路器\nTYPE=CircuitBreaker",
      "models/first.ifc": "",
      "models/second.ifc": "",
    };
    const reads: Record<string, number> = {};
    const graph = await extractEngineeringSourceGraph({
      paths: Object.keys(raw).reverse(),
      readText: async (path) => {
        reads[path] = (reads[path] ?? 0) + 1;
        return raw[path];
      },
    });
    expect(graph.records).toHaveLength(2);
    expect(reads).toEqual({ "project.cbm": 1, "unit.cbm": 1, "unit.dev": 1 });
    expect(graph.cbmOccurrences.map((row) => row.viaField)).toEqual([
      "",
      "SUBSYSTEM0",
      "SUBSYSTEM1",
    ]);
    expect(
      graph.references.map(({ field, status, target }) => [
        field,
        status,
        target,
      ]),
    ).toEqual([
      ["project-entry", "resolved", "project.cbm"],
      ["SUBSYSTEM0", "resolved", "unit.cbm"],
      ["OBJECTMODELPOINTER", "resolved", "unit.dev"],
      ["IFCFILE", "ambiguous", null],
      ["SUBSYSTEM1", "resolved", "unit.cbm"],
      ["OBJECTMODELPOINTER", "resolved", "unit.dev"],
    ]);
    expect(graph.references[3]).toMatchObject({
      values: ["models/first.ifc$", "models/second.ifc"],
      lines: [2, 3],
      candidates: ["models/first.ifc", "models/second.ifc"],
    });
    expect(graph.diagnostics).toEqual([
      {
        kind: "ambiguous-field",
        source: "unit.cbm",
        field: "IFCFILE",
        lines: [2, 3],
      },
    ]);
  });

  it("preserves same-template parent/child occurrences without actual assembly evidence", async () => {
    const graph = await extractEngineeringSourceGraph(
      files({
        "CBM/project.cbm": "SUBSYSTEM=p.cbm",
        "CBM/p.cbm":
          "ENTITYNAME=F2System\nOBJECTMODELPOINTER=unit.dev\nSUBSYSTEM0=c.cbm",
        "CBM/c.cbm": "ENTITYNAME=F3System\nOBJECTMODELPOINTER=unit.dev",
        "Devices/unit.dev":
          "SYMBOLNAME=断路器\nTYPE=CircuitBreaker\nSUBDEVICES.NUM=0",
      }),
    );
    expect(graph.records).toHaveLength(2);
    expect(graph.records.every((r) => !r.parent)).toBe(true);
    expect(graph.aliases).toHaveLength(0);
    expect(
      normalizeEngineeringModel("case", graph.records.map(toObjectEvidence))
        .entities,
    ).toHaveLength(2);
  });

  it("joins real repeated DEV children as ambiguous source aliases regardless of F labels", async () => {
    const graph = await extractEngineeringSourceGraph(
      files({
        "project.cbm": "SUBSYSTEM0=main.cbm",
        "main.cbm":
          "ENTITYNAME=F3System\nOBJECTMODELPOINTER=string.dev\nSUBSYSTEM0=part.cbm",
        "part.cbm": "ENTITYNAME=F2System\nOBJECTMODELPOINTER=ball.dev",
        "string.dev":
          "SYMBOLNAME=绝缘子串\nTYPE=ChainInsulation\nSUBDEVICES.NUM=2\nSUBDEVICE0=ball.dev\nSUBDEVICE1=ball.dev",
        "ball.dev": "OBJECTROLE=part\nSYMBOLNAME=金具球",
      }),
    );
    expect(graph.records).toHaveLength(3);
    expect(graph.aliases[0]).toMatchObject({ status: "ambiguous" });
    expect(graph.aliases[0].candidates).toHaveLength(2);
    const model = normalizeEngineeringModel(
      "case",
      graph.records.map(toObjectEvidence),
      graph.aliases,
    );
    expect(model.entities).toHaveLength(1);
    expect(model.aliases[0].status).toBe("whole_resolved_component_ambiguous");
  });

  it("preserves shared CBM reference occurrences and matrix rows independently", async () => {
    const graph = await extractEngineeringSourceGraph(
      files({
        "project.cbm": "SUBSYSTEM0=unit.cbm\nSUBSYSTEM1=unit.cbm",
        "unit.cbm": "OBJECTMODELPOINTER=unit.dev\nTRANSFORMMATRIX=placement",
        "unit.dev":
          "SYMBOLNAME=断路器\nSOLIDMODELS.NUM=1\nTRANSFORMMATRIX0=solid\nSUBDEVICES.NUM=0\nTRANSFORMMATRIX0=child",
      }),
    );
    expect(graph.records).toHaveLength(2);
    expect(new Set(graph.records.map((r) => r.id)).size).toBe(2);
    expect(
      graph.documents
        .find((d) => d.path === "unit.dev")
        ?.fields.filter((p) => p.keys[0] === "TRANSFORMMATRIX0")
        .map((p) => p.value),
    ).toEqual(["solid", "child"]);
  });

  it("does not resolve ambiguous basename or case collisions to the first file", async () => {
    const graph = await extractEngineeringSourceGraph(
      files({
        "project.cbm": "OBJECTMODELPOINTER=unit.dev",
        "A/unit.dev": "SYMBOLNAME=梁",
        "B/unit.dev": "SYMBOLNAME=柱",
      }),
    );
    expect(graph.records).toHaveLength(0);
    expect(
      graph.references.find((r) => r.field === "OBJECTMODELPOINTER")?.status,
    ).toBe("ambiguous");
    const collision = await extractEngineeringSourceGraph(
      files({
        "project.cbm": "OBJECTMODELPOINTER=unit.dev",
        "unit.dev": "SYMBOLNAME=梁",
        "UNIT.DEV": "SYMBOLNAME=柱",
      }),
    );
    expect(collision.records).toHaveLength(0);
  });

  it("discovers IFC globally without requiring a CBM GUID association", async () => {
    const graph = await extractEngineeringSourceGraph(
      files({
        "Cbm/project.cbm": "ENTITYNAME=F1System",
        "Elsewhere/model.IFC": "IFC",
      }),
    );
    expect(graph.ifcPaths).toEqual(["Elsewhere/model.IFC"]);
  });

  it("preserves family evidence without borrowing its name as the component name", async () => {
    const graph = await extractEngineeringSourceGraph(
      files({
        "project.cbm": "OBJECTMODELPOINTER=unit.dev",
        "unit.dev":
          "TYPE=OnlineMonitoring\nSYMBOLNAME=在线监测仪\nBASEFAMILYPOINTER=family.fam",
        "family.fam":
          "[设备]\n工程中名称=PROJECTNAME=110kV中性点装置\nmalformed-row",
      }),
    );
    expect(graph.records[0].properties[0]).toMatchObject({
      path: "family.fam",
      line: 2,
      rawLine: "工程中名称=PROJECTNAME=110kV中性点装置",
    });
    expect(
      graph.documents.find((doc) => doc.path === "family.fam")?.rawLines[2],
    ).toBe("malformed-row");
    const model = normalizeEngineeringModel(
      "case",
      graph.records.map(toObjectEvidence),
    );
    expect(model.entities).toHaveLength(0);
    expect(model.pending[0].reason).toBe("component_whole_unresolved");
  });

  it("records branch cycles and enforces cancellation and occurrence limits", async () => {
    const data = files({
      "project.cbm": "OBJECTMODELPOINTER=unit.dev",
      "unit.dev": "SUBDEVICE0=unit.dev",
    });
    expect(
      (await extractEngineeringSourceGraph(data)).diagnostics,
    ).toHaveLength(1);
    await expect(
      extractEngineeringSourceGraph(data, { maxOccurrences: 1 }),
    ).rejects.toThrow("budget");
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractEngineeringSourceGraph(data, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });

  it("uses the same occurrence budget for CBM traversal and DEV expansion", async () => {
    const input = files({
      "project.cbm": "OBJECTMODELPOINTER=unit.dev\nSUBSYSTEM0=bay.cbm",
      "unit.dev": "SUBDEVICE0=part.dev",
      "part.dev": "SYMBOLNAME=部件",
      "bay.cbm": "ENTITYNAME=F2System",
    });
    await expect(
      extractEngineeringSourceGraph(input, { maxOccurrences: 3 }),
    ).rejects.toThrow("Engineering source occurrence budget exceeded");
    const graph = await extractEngineeringSourceGraph(input, {
      maxOccurrences: 4,
    });
    expect(graph.cbmOccurrences).toHaveLength(2);
    expect(graph.records).toHaveLength(2);
  });

  it("retains repeated raw reference keys without colliding source identities", async () => {
    const graph = await extractEngineeringSourceGraph(
      files({
        "project.cbm": "SUBSYSTEM=unit.cbm\nSUBSYSTEM=unit.cbm",
        "unit.cbm": "OBJECTMODELPOINTER=unit.dev",
        "unit.dev": "SYMBOLNAME=断路器",
      }),
    );
    expect(graph.records).toHaveLength(2);
    expect(new Set(graph.records.map((row) => row.id)).size).toBe(2);
  });
});
