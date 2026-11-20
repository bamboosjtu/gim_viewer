import { describe, expect, it } from "vitest";
import { parseStd } from "../std.js";
import { parseSld } from "../sld.js";
import type { XmlElement } from "../xml.js";

function element(
  tagName: string,
  attrs: Record<string, string> = {},
): XmlElement {
  return {
    tagName,
    textContent: null,
    outerHTML: `<${tagName}/>`,
    getAttribute: (name) => attrs[name] ?? null,
    removeAttribute: () => {},
    remove: () => {},
    attributes: [],
    children: [],
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

describe("STD/SLD shared XML diagnostics", () => {
  it("uses ParseDiagnostic severity and raw root values", () => {
    const bad = parseStd("<STD>", "bad.std", () => ({
      documentElement: element("STD"),
      querySelector: () => element("parsererror"),
    }));
    expect(bad.status).toBe("failed");
    expect(bad.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "invalid-xml",
      path: "bad.std",
    });

    const unsupported = parseSld("<xml/>", "bad.sty", () => ({
      documentElement: element("xml"),
      querySelector: () => null,
    }));
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.diagnostics[0]).toMatchObject({
      severity: "warning",
      code: "unsupported-root",
      rawValue: "xml",
    });
  });
});
