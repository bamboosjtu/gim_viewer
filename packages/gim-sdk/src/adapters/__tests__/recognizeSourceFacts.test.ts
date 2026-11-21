import { describe, expect, it } from "vitest";
import {
  adaptSourceEvidence,
  readSourceEvidenceFacts,
  type SourceRecord,
} from "../recognizeSource.js";
import { resolveObjectEvidence } from "../../semantic/recognition/objectEvidenceDecision.js";

const record = (type: string): SourceRecord => ({
  id: "source",
  track: "dev",
  source: "source.dev",
  source_type: type,
  name: "unknown",
  parent: "",
  properties: [],
  sources: [],
  context: [],
  guid: "",
});

describe("format/semantic adapter boundary", () => {
  it("returns facts without semantic classification fields", () => {
    const facts = readSourceEvidenceFacts(record("GIS"));
    expect(facts.rawType).toBe("GIS");
    expect(facts.type).toBe("GIS");
    expect("categoryValue" in facts).toBe(false);
    expect("standardTypes" in facts).toBe(false);
  });

  it("lets Semantic Core make the same decision from adapter facts", () => {
    const source = record("GIS");
    const facts = readSourceEvidenceFacts(source);
    const direct = resolveObjectEvidence(facts, {
      sourceTypesComplete: true,
      completeNeutralAssembly: false,
    });
    expect(direct).toEqual(
      adaptSourceEvidence(source, {
        sourceTypesComplete: true,
        completeNeutralAssembly: false,
      }),
    );
  });
});
