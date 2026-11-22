import { describe, expect, it, vi } from "vitest";
import { SourceDocumentReader } from "../sourceDocumentReader.js";
import { SourceFamilyIndex } from "../sourceFamilyIndex.js";
import { parseSourceDocument } from "../sourceDocuments.js";
import * as famParser from "../famParser.js";

function host(
  options: {
    deferFamilies?: boolean;
    read?: (path: string) => Promise<string>;
  } = {},
) {
  const reads: string[] = [];
  const refs: string[] = [];
  const reader = new SourceDocumentReader({
    async readText(path) {
      reads.push(path);
      return options.read ? await options.read(path) : "[属性]\n设备型号=ABC\n";
    },
  });
  return {
    reads,
    refs,
    index: new SourceFamilyIndex({
      deferFamilies: options.deferFamilies,
      resolveReference(_owner, _field, value) {
        refs.push(value);
        return value === "base.fam" ? "FAM/base.fam" : null;
      },
      readDocument: (path) => reader.document(path),
    }),
  };
}

describe("SourceFamilyIndex", () => {
  it("resolves references once per owner and assigns each source/path pair once", async () => {
    const h = host();
    const doc = parseSourceDocument(
      "CBM/a.cbm",
      "BASEFAMILY=base.fam\nBASEFAMILY=base.fam\n",
    );
    h.index.assignFamilies(doc, "a");
    h.index.assignFamilies(doc, "a");
    expect(h.index.assignments).toEqual([
      { sourceId: "a", path: "FAM/base.fam" },
    ]);
    expect(h.reads).toEqual([]);
    const paths = h.index.referencedFamilies(doc);
    expect(h.index.referencedFamilies(doc)).toBe(paths);
    expect(paths).toEqual(["FAM/base.fam"]);
    expect(h.refs).toEqual(["base.fam", "base.fam"]);

    const first = await h.index.family(doc);
    const second = await h.index.family(doc);
    expect(h.reads).toEqual(["FAM/base.fam"]);
    expect(second).toBe(first);
    expect(h.refs).toEqual(["base.fam", "base.fam"]);
    expect(first[0]).toMatchObject({ path: "FAM/base.fam", value: "ABC" });
  });

  it("returns the same in-flight Promise for concurrent calls on one owner", async () => {
    const h = host();
    const doc = parseSourceDocument("a.dev", "BASEFAMILY=base.fam");
    const first = h.index.family(doc);
    expect(h.index.family(doc)).toBe(first);
    expect(h.reads).toEqual(["FAM/base.fam"]);
    await expect(first).resolves.toEqual([
      expect.objectContaining({ path: "FAM/base.fam", value: "ABC" }),
    ]);
  });

  it("shares one FAM read and one parse across concurrent owners", async () => {
    const parse = vi.spyOn(famParser, "parseFamSectionsWithDiagnostics");
    try {
    const h = host();
    const cbm = parseSourceDocument("a.cbm", "BASEFAMILY=base.fam");
    const dev = parseSourceDocument("b.dev", "BASEFAMILYPOINTER=base.fam");
    const first = h.index.family(cbm);
    const second = h.index.family(dev);
    expect(h.refs).toEqual(["base.fam", "base.fam"]);
    expect(h.reads).toEqual(["FAM/base.fam"]);
    const [fromCbm, fromDev] = await Promise.all([first, second]);
    expect(fromCbm).toEqual(fromDev);
    expect(fromCbm).not.toBe(fromDev);
    expect(fromCbm[0]).not.toBe(fromDev[0]);
    expect(fromCbm[0].keys).not.toBe(fromDev[0].keys);
    expect(fromCbm).toHaveLength(1);
    expect(h.reads).toEqual(["FAM/base.fam"]);
    expect(parse).toHaveBeenCalledOnce();
    } finally {
      parse.mockRestore();
    }
  });

  it("defers FAM IO while retaining assignments for later materialization", async () => {
    const h = host({ deferFamilies: true });
    const doc = parseSourceDocument("CBM/a.cbm", "BASEFAMILY=base.fam\n");
    h.index.assignFamilies(doc, "a");
    expect(h.index.assignments).toEqual([
      { sourceId: "a", path: "FAM/base.fam" },
    ]);
    expect(await h.index.family(doc)).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it("does not re-read the same source when a family is missing", async () => {
    const h = host({
      read: async () => {
        throw new Error("missing");
      },
    });
    const doc = parseSourceDocument("CBM/a.cbm", "BASEFAMILY=base.fam\n");
    h.index.assignFamilies(doc, "a");
    await expect(h.index.family(doc)).rejects.toThrow("missing");
    await expect(h.index.family(doc)).rejects.toThrow("missing");
    expect(h.reads).toEqual(["FAM/base.fam"]);
  });
});
