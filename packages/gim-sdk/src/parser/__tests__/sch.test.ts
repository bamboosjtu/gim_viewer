import { describe, expect, it } from "vitest";
import { parseSch } from "../sch.js";

describe("independent SCH parser", () => {
  it("classifies STD/SLD entries without resolving files", () => {
    const entries = parseSch(
      "SCH.NUM=2\nSCH0=zjx.std\nSCH1=diagram.sld",
      "CBM/project.sch",
    );
    expect(entries).toEqual([
      {
        index: 0,
        filename: "zjx.std",
        path: "CBM/zjx.std",
        type: "std",
        name: "zjx",
      },
      {
        index: 1,
        filename: "diagram.sld",
        path: "CBM/diagram.sld",
        type: "sld",
        name: "diagram",
      },
    ]);
  });
});
