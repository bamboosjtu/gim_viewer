import { describe, expect, it } from "vitest";
import { parseCbmResult } from "../cbm.js";
import { parseDevResult } from "../dev.js";
import { parsePhmResult } from "../phm.js";
import { fromSourceDiagnostic } from "../diagnostics.js";

describe("parser diagnostic envelope", () => {
  it("maps source diagnostics to the shared shape and preserves raw values", () => {
    expect(
      fromSourceDiagnostic({
        kind: "invalid-source-matrix",
        path: "DEV/a.dev",
        field: "TRANSFORMMATRIX0",
        lines: [4, 5],
        values: ["1,2", "3,4"],
      }),
    ).toEqual({
      severity: "warning",
      code: "invalid-source-matrix",
      message: "TRANSFORMMATRIX0: invalid-source-matrix",
      path: "DEV/a.dev",
      line: 4,
      rawValue: "1,2 | 3,4",
    });
  });

  it("reports partial/empty status without changing specialized values", () => {
    const cbm = parseCbmResult("ENTITYNAME=a\nENTITYNAME=b", "CBM/a.cbm");
    expect(cbm.status).toBe("partial");
    expect(cbm.diagnostics[0]).toMatchObject({
      code: "ambiguous-field",
      line: 1,
    });
    expect(cbm.value).not.toBeNull();

    expect(parseDevResult("", "DEV/empty.dev").status).toBe("empty");
    expect(parsePhmResult("", "PHM/empty.phm").status).toBe("empty");
  });
});
