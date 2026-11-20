import { describe, expect, it } from "vitest";
import { parsePhm } from "../phm.js";

const matrix = (x: number) => `1,0,0,0,0,1,0,0,0,0,1,0,${x},0,0,1`;

describe("independent PHM parser", () => {
  it("parses SOLIDS and SOLIDMODELS without merging their block slots", () => {
    const source = [
      "SOLIDS.NUM=1",
      "SOLIDS0=body.mod",
      `TRANSFORMMATRIX0=${matrix(10)}`,
      "SOLIDMODELS.NUM=1",
      "SOLIDMODEL0=assembly.phm",
      `TRANSFORMMATRIX0=${matrix(20)}`,
      "COLOR0=255,0,0,100",
    ].join("\n");
    const doc = parsePhm(source, "PHM/assembly.phm");
    expect(doc.solidModels).toHaveLength(2);
    expect(doc.solidModels[0].transformMatrix[12]).toBe(10);
    expect(doc.solidModels[1].transformMatrix[12]).toBe(20);
    expect(doc.solidModels[1].color).toEqual({ r: 255, g: 0, b: 0, a: 100 });
    expect(doc.isEmpty).toBe(false);
  });
});
