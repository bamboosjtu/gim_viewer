import { describe, expect, it, vi } from "vitest";
import { SourceDocumentReader } from "../sourceDocumentReader.js";
import { parseSourceDocument } from "../sourceDocuments.js";

describe("SourceDocumentReader", () => {
  it("shares the in-flight read and publishes one document per path", async () => {
    let resolve!: (text: string) => void;
    const promise = new Promise<string>((finish) => {
      resolve = finish;
    });
    const readText = vi.fn(() => promise);
    const reader = new SourceDocumentReader({ readText });
    const first = reader.document("unit.dev");
    expect(reader.document("unit.dev")).toBe(first);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledWith("unit.dev");
    expect(reader.documents).toEqual([]);

    resolve("TYPE=CircuitBreaker");
    const document = await first;
    expect(reader.document("unit.dev")).toBe(first);
    expect(reader.documents).toEqual([document]);
    expect(document.fields).toEqual([
      expect.objectContaining({ keys: ["TYPE"], value: "CircuitBreaker" }),
    ]);
  });

  it.each(["text", "parsed"] as const)(
    "caches a failed %s read within one session and retries in a new session",
    async (mode) => {
      const path = "project.cbm";
      const text = "ENTITYNAME=F1System";
      const failure = new Error("archive read failed");
      const readText = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(text);
      const document = parseSourceDocument(path, text);
      const readDocument = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(document);
      const source =
        mode === "parsed" ? { readText, readDocument } : { readText };
      const read = mode === "parsed" ? readDocument : readText;
      const session = new SourceDocumentReader(source);
      const failed = session.document(path);
      await expect(failed).rejects.toBe(failure);
      expect(session.document(path)).toBe(failed);
      expect(session.documents).toEqual([]);
      expect(read).toHaveBeenCalledTimes(1);

      const fresh = new SourceDocumentReader(source);
      await expect(fresh.document(path)).resolves.toEqual(document);
      expect(fresh.documents).toHaveLength(1);
      expect(read).toHaveBeenCalledTimes(2);
      if (mode === "parsed") expect(readText).not.toHaveBeenCalled();
    },
  );
});
