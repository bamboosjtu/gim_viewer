import { describe, expect, it } from "vitest";
import { SourceFamilyIndex } from "../sourceFamilyIndex.js";
import { parseSourceDocument } from "../sourceDocuments.js";

function host(options: { deferFamilies?: boolean; read?: (path: string) => Promise<string> } = {}) {
  const reads: string[] = [];
  const refs: string[] = [];
  return {
    reads,
    refs,
    index: new SourceFamilyIndex({
      deferFamilies: options.deferFamilies,
      resolveReference(_owner, _field, value) {
        refs.push(value);
        return value === "base.fam" ? "FAM/base.fam" : null;
      },
      async readDocument(path) {
        reads.push(path);
        const text = options.read ? await options.read(path) : "[属性]\n设备型号=ABC\n";
        return parseSourceDocument(path, text);
      },
    }),
  };
}

describe("SourceFamilyIndex", () => {
  it("caches FAM reads and assigns each source/path pair once", async () => {
    const h = host();
    const doc = parseSourceDocument("CBM/a.cbm", "BASEFAMILY=base.fam\nBASEFAMILY=base.fam\n");
    h.index.assignFamilies(doc, "a");
    h.index.assignFamilies(doc, "a");
    expect(h.index.assignments).toEqual([{ sourceId: "a", path: "FAM/base.fam" }]);
    expect(h.reads).toEqual([]);

    const first = await h.index.family(doc);
    const second = await h.index.family(doc);
    expect(h.reads).toEqual(["FAM/base.fam"]);
    expect(second).toBe(first);
    expect(first[0]).toMatchObject({ path: "FAM/base.fam", value: "ABC" });
  });

  it("defers FAM IO while retaining assignments for later materialization", async () => {
    const h = host({ deferFamilies: true });
    const doc = parseSourceDocument("CBM/a.cbm", "BASEFAMILY=base.fam\n");
    h.index.assignFamilies(doc, "a");
    expect(h.index.assignments).toEqual([{ sourceId: "a", path: "FAM/base.fam" }]);
    expect(await h.index.family(doc)).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it("does not re-read the same source when a family is missing", async () => {
    const h = host({ read: async () => { throw new Error("missing"); } });
    const doc = parseSourceDocument("CBM/a.cbm", "BASEFAMILY=base.fam\n");
    h.index.assignFamilies(doc, "a");
    await expect(h.index.family(doc)).rejects.toThrow("missing");
    await expect(h.index.family(doc)).rejects.toThrow("missing");
    expect(h.reads).toEqual(["FAM/base.fam"]);
  });
});
