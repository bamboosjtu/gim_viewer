import { describe, expect, it } from "vitest";
import { parseSld } from "../sld.js";
import { parseStd } from "../std.js";
import type { XmlDocument, XmlElement } from "../xml.js";

function element(tagName: string): XmlElement {
  return {
    tagName,
    textContent: "",
    outerHTML: `<${tagName} />`,
    getAttribute: () => null,
    removeAttribute: () => {},
    remove: () => {},
    attributes: [],
    children: [],
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function documentWith(root: XmlElement): XmlDocument {
  return { documentElement: root, querySelector: () => null };
}

describe("STD/SLD XML adapter contract", () => {
  it("returns an empty result before invoking the host adapter for empty text", () => {
    const adapter = () => {
      throw new Error("adapter must not run for empty text");
    };
    expect(parseStd("  ", "empty.std", adapter).status).toBe("empty");
    expect(parseSld("", "empty.sld", adapter).status).toBe("empty");
  });

  it("reports an unsupported root through the adapter contract", () => {
    const adapter = () => documentWith(element("BOGUS"));
    expect(parseStd("<BOGUS/>", "bad.std", adapter).status).toBe("unsupported");
    expect(parseSld("<BOGUS/>", "bad.sld", adapter).status).toBe("unsupported");
  });
});
