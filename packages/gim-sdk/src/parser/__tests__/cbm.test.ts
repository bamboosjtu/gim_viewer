import { describe, expect, it } from "vitest";
import { parseCbmText } from "../cbm.js";

describe("independent CBM source-record parser", () => {
  it("keeps raw properties and only normalizes the format-level entity name", () => {
    const record = parseCbmText(
      "ENTITYNAME=f4system\nOBJECTMODELPOINTER=DEV/unit.dev\nSYSTEMNAME1=间隔一\nSYSTEMNAME2=-",
      "CBM/unit.cbm",
    );
    expect(record.path).toBe("CBM/unit.cbm");
    expect(record.entityName).toBe("F4System");
    expect(record.objectModelPointer).toBe("DEV/unit.dev");
    expect(record.properties["SYSTEMNAME1"]).toBe("间隔一");
    expect(record.fields).toHaveLength(4);
  });
});
