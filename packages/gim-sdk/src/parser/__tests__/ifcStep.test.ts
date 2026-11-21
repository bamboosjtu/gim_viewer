import { describe, expect, it } from "vitest";
import {
  materializeIfcEntity,
  scanIfcEntityBoundaries,
  splitIfcArgs,
} from "../ifcStep.js";

describe("independent IFC STEP lexical parser", () => {
  it("scans records and preserves quoted semicolons/parentheses", () => {
    const text =
      "#1=IFCPROJECT('gid',#2,'name;with;semis',$,#3,$,$,$);\n" +
      "#2=IFCCARTESIANPOINT((1.,2.,3.));\n" +
      "#3=IFCLOCALPLACEMENT($,#2);";
    const scanned: Array<{
      id: number;
      type: string;
      start: number;
      end: number;
    }> = [];
    expect(
      scanIfcEntityBoundaries(
        text,
        (expressId, ifcType, bodyStart, bodyEnd) => {
          scanned.push({
            id: expressId,
            type: ifcType,
            start: bodyStart,
            end: bodyEnd,
          });
        },
      ),
    ).toBe(3);
    expect(scanned.map((row) => row.type)).toEqual([
      "IFCPROJECT",
      "IFCCARTESIANPOINT",
      "IFCLOCALPLACEMENT",
    ]);
    const project = materializeIfcEntity(text, {
      expressId: 1,
      ifcType: "IFCPROJECT",
      bodyStart: scanned[0].start,
      bodyEnd: -1,
    });
    expect(project.args[2]).toBe("'name;with;semis'");
  });

  it("splits nested arguments without splitting quoted commas", () => {
    expect(splitIfcArgs("(1,2,3),'a,b',#4")).toEqual([
      "(1,2,3)",
      "'a,b'",
      "#4",
    ]);
  });

  it.each([
    "ISO-10303-21;HEADER;FILE_DESCRIPTION(('See; #91=IFCWALL(example)'),'2;1');ENDSEC;DATA;ENDSEC;END-ISO-10303-21;",
    "/* Example; #92=IFCWALL(comment) */",
  ])("keeps records inside literals out of fallback results: %s", (text) => {
    const ids: number[] = [];
    expect(scanIfcEntityBoundaries(text, (id) => ids.push(id))).toBe(0);
    expect(ids).toEqual([]);
  });

  it("still recovers an unanchored record outside a quoted literal", () => {
    const text =
      "prefix 'Example; #91=IFCWALL(example)' #2=IFCCARTESIANPOINT((1.,2.,3.));";
    const records: Array<ReturnType<typeof materializeIfcEntity>> = [];
    expect(
      scanIfcEntityBoundaries(
        text,
        (expressId, ifcType, bodyStart, bodyEnd) => {
          records.push(
            materializeIfcEntity(text, {
              expressId,
              ifcType,
              bodyStart,
              bodyEnd,
            }),
          );
        },
      ),
    ).toBe(1);
    expect(records).toEqual([
      { expressId: 2, ifcType: "IFCCARTESIANPOINT", args: ["(1.,2.,3.)"] },
    ]);
  });

  it("skips quoted and commented headers and finds the record after a comment", () => {
    const text =
      "#1=IFCTEXT('it''s a label; #91=IFCWALL(example)');" +
      "/* #92=IFCWALL(comment); */ #2=IFCLOCALPLACEMENT($,/* ) , */#3);" +
      '#3=IFCBINARY("remark; #93=IFCWALL(example)");';
    const entities: Array<ReturnType<typeof materializeIfcEntity>> = [];
    expect(
      scanIfcEntityBoundaries(
        text,
        (expressId, ifcType, bodyStart, bodyEnd) => {
          entities.push(
            materializeIfcEntity(text, {
              expressId,
              ifcType,
              bodyStart,
              bodyEnd,
            }),
          );
        },
      ),
    ).toBe(3);
    expect(entities.map((entity) => entity.expressId)).toEqual([1, 2, 3]);
    expect(entities[0].args).toEqual(["'it''s a label; #91=IFCWALL(example)'"]);
    expect(entities[1].args).toEqual(["$", "#3"]);
  });
});
