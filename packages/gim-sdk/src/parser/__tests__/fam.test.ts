import { describe, expect, it } from "vitest";
import * as parser from "../parser.js";

describe("independent FAM parser", () => {
  it("keeps the first non-empty key candidate and the final segment as value", () => {
    const sections = parser.parseFamSections(
      "\uFEFF[设计参数]\n中文名=英文键=110kV\n中文名=中文名=设备\n=工程系统=出线间隔01\n",
    );
    expect(sections.get("设计参数")).toEqual(
      new Map([
        ["中文名", "设备"],
        ["工程系统", "出线间隔01"],
      ]),
    );
  });

  it("returns a format-neutral result with diagnostics for malformed rows", () => {
    const result = parser.parseFamDocument(
      "[构力自定义属性]\n==value\n=\n只有一段\nA=B=C\n",
      "source.fam",
    );
    expect(result.value?.sections.get("构力自定义属性")).toEqual(
      new Map([["A", "C"]]),
    );
    expect(result.value?.properties.map((row) => row.sourceLine)).toEqual([5]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "fam-malformed-line",
        path: "source.fam",
      }),
    ]);
  });

  it("returns no diagnostics for a clean FAM document", () => {
    const result = parser.parseFamDocument("[属性]\n设备编码=ABC\n");
    expect(result.value?.sections.get("属性")).toEqual(
      new Map([["设备编码", "ABC"]]),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("does not expose source-layer business identity interpretation", () => {
    expect("resolveSubstationBusinessIdentity" in parser).toBe(false);
  });
});
