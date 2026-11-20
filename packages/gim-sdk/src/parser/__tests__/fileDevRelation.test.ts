import { describe, expect, it } from "vitest";
import { parseFileDevRelationText } from "../fileDevRelation.js";

describe("independent FileDevRelation parser", () => {
  it("distinguishes JinQu pairing from BIMBase without path resolution", () => {
    const jinQu = parseFileDevRelationText(
      [
        "FILE.NUM=2",
        "FILE0.NAME=一次设备",
        "FILE0.DEV.NUM=1",
        "FILE0.DEV0=CBM/a.cbm",
        "FILE1.IFC=a.ifc",
      ].join("\n"),
      "CBM/FileDevRelation.cbm",
    );
    expect(jinQu.status).toBe("ok");
    expect(jinQu.value?.format).toBe("jin-qu");
    expect(jinQu.value?.entries[0]).toMatchObject({
      ifcFile: "a.ifc",
      ifcName: "一次设备",
      deviceCount: 1,
      deviceCbms: ["CBM/a.cbm"],
    });

    const bimbase = parseFileDevRelationText(
      "FILE.NUM=2\nFILE0.NAME=图纸\nFILE0.IFC=a.ifc\nFILE1.NAME=设备\nFILE1.DEV.NUM=1",
      "CBM/FileDevRelation.cbm",
    );
    expect(bimbase.value?.format).toBe("bimbase");
    expect(bimbase.value?.entries).toHaveLength(2);
  });

  it("returns partial status and diagnostic lines for a conflicting IFC field", () => {
    const result = parseFileDevRelationText(
      "FILE.NUM=1\nFILE0.NAME=设备\nFILE0.IFC=a.ifc\nFILE0.IFC=b.ifc",
      "custom/FileDevRelation.cbm",
    );
    expect(result.status).toBe("partial");
    expect(result.diagnostics[0]).toMatchObject({
      severity: "warning",
      code: "ambiguous-field",
      path: "custom/FileDevRelation.cbm",
      line: 3,
    });
    expect(result.value?.entries[0].diagnostics[0]).toMatchObject({
      field: "FILE0.IFC",
      values: ["a.ifc", "b.ifc"],
    });
  });
});
