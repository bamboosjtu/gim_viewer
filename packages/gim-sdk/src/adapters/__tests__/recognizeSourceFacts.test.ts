import { describe, expect, it } from "vitest";
import {
  adaptSourceEvidence,
  type SourceRecord,
} from "../recognizeSource.js";
import { readSourceFormatFacts } from "../sourceEvidenceReader.js";
import { readSourceTypeObservation } from "../sourceTypeDeclarations.js";
import sourceVocabulary from "../../semantic/catalog/sourceVocabulary.json";
import { resolveObjectEvidence } from "../../semantic/recognition/objectEvidenceDecision.js";
import {
  prepareObjectDecision,
  resolveObjectCandidates,
} from "../../semantic/recognition/objectEvidenceCandidates.js";

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

const options = { sourceTypesComplete: true, completeNeutralAssembly: false };

describe("format/semantic adapter boundary", () => {
  it("returns facts without semantic classification fields", () => {
    const type = "PowerBox/LightingBox/MaintenanceBox";
    const facts = readSourceFormatFacts(record(type), true);
    expect(facts.sourceType).toEqual({
      declaration: { value: type, evidenceId: `source:source_type:${type}` },
      modelDialect: "dev",
      properties: [],
      supplementalTypeProperties: [],
      models: [],
      predefinedTypes: [],
      cabinetNames: [],
      authoringCategories: [],
      roadPositions: [],
    });
    expect("record" in facts).toBe(false);
    expect("values" in facts).toBe(false);
    expect("normalize" in facts).toBe(false);
    expect("categoryValue" in facts).toBe(false);
    expect("standardTypes" in facts).toBe(false);
    expect("categoryHints" in facts).toBe(false);
    expect("compatibilityHints" in facts).toBe(false);
  });

  it("lets Semantic Core make the same decision from adapter facts", () => {
    const source = record("GIS");
    const facts = readSourceFormatFacts(source, true);
    expect(resolveObjectEvidence(facts)).toEqual(adaptSourceEvidence(source, options));
  });

  it("preserves property provenance and supplies typed composition without a source record", () => {
    const source = {
      ...record("Road"),
      parent: "owner",
      properties: [
        { keys: ["道路位置"], value: "站内", path: "road.fam", line: 12 },
        { keys: ["宿主设备编码"], value: "host-code", path: "road.fam", line: 13 },
      ],
    };
    const facts = readSourceFormatFacts(source, true);
    expect(facts.sourceType.roadPositions).toContainEqual(expect.objectContaining({
      value: "站内",
      evidenceId: JSON.stringify(["source", "road.fam", 12, ["道路位置"]]),
    }));
    expect(facts.hostCodes).toContainEqual(expect.objectContaining({ value: "host-code" }));
    expect(facts.composition).toEqual([{
      kind: "physical_assembly",
      parentSourceIds: ["owner"],
      status: "confirmed",
      evidence: ["assembly:owner->source"],
    }]);
    const building = readSourceFormatFacts({ ...source, source_type: "Building", track: "ifc" }, true);
    expect(building.sourceType.roadPositions).toEqual(facts.sourceType.roadPositions);
    expect(building.composition?.[0].kind).toBe("object_decomposition");
    expect(resolveObjectEvidence(facts).standardClasses).toEqual(
      expect.arrayContaining([expect.objectContaining({ term: "StationInRoadWays" })]),
    );
    expect(resolveObjectEvidence(building).standardClasses).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ term: "StationInRoadWays" })]),
    );
  });

  it("supplies declared type text and only a physical parent to the assembly decision", () => {
    const source = { ...record(" 消弧线圈 "), parent: "set" };
    expect(readSourceTypeObservation(source)).toEqual({
      sourceId: "source", declaredType: " 消弧线圈 ", physicalParentId: "set",
    });
    expect(readSourceTypeObservation({ ...source, track: "ifc" })).toEqual({
      sourceId: "source", declaredType: " 消弧线圈 ", physicalParentId: undefined,
    });
  });

  it("projects every vocabulary field in dictionary order", () => {
    const fields = sourceVocabulary.keywordDictionary.fields;
    const source = { ...record("GIS"), properties: fields.map((field) => ({ keys: [field], value: field })) };
    expect(readSourceFormatFacts(source, true).vocabularyDeclarations.map(({ field }) => field)).toEqual(fields);
  });

  it("resolves a standalone terminal box and its equipment-member variant from one fact set", () => {
    const source = record("TerminalBox");
    const facts = readSourceFormatFacts(source, true);
    const decision = prepareObjectDecision(facts);

    const standalone = resolveObjectCandidates(decision, false, false);
    const member = resolveObjectCandidates(decision, true, false);
    expect(standalone.standardClasses.map(({ id }) => id)).toEqual(["material:terminalbox"]);
    expect(member.standardClasses).toHaveLength(0);
    const evidenceId = facts.sourceType.declaration.evidenceId;
    expect(member.componentDeclarations.map((p) => p.evidenceId)).toContain(evidenceId);
    expect(resolveObjectEvidence(facts).equipmentMemberVariant?.componentTypeCandidates)
      .toContainEqual(expect.objectContaining({ value: "terminal_box", evidenceId }));
  });
});
