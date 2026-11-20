import { describe, expect, it } from "vitest";
import { parseDev } from "../dev.js";

const matrix = (x: number) => `1,0,0,0,0,1,0,0,0,0,1,0,${x},0,0,1`;

describe("independent DEV parser", () => {
  it("keeps block-local solid and subdevice matrices", () => {
    const source = [
      "SYMBOLNAME=Parent",
      "BASEFAMILY=parent.fam",
      "SOLIDMODELS.NUM=1",
      "SOLIDMODEL0=body.phm",
      `TRANSFORMMATRIX0=${matrix(1)}`,
      "SUBDEVICES.NUM=1",
      "SUBDEVICE0=child.dev",
      `TRANSFORMMATRIX0=${matrix(2)}`,
    ].join("\n");
    const doc = parseDev(source, "DEV/parent.dev");
    expect(doc.symbolName).toBe("Parent");
    expect(doc.baseFamily).toBe("parent.fam");
    expect(doc.solidModels[0]).toMatchObject({
      solidModelPath: "body.phm",
      transformMatrix: expect.any(Array),
    });
    expect(doc.subDevices[0]).toMatchObject({
      devPath: "child.dev",
      sourceIndex: 0,
    });
    expect(doc.solidModels[0].transformMatrix[12]).toBe(1);
    expect(doc.subDevices[0].transformMatrix[12]).toBe(2);
  });
});
