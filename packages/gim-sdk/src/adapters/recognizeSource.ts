import type { SourceRecord } from "../shared/sourceRecord.js";
import { readSourceFormatFacts } from "./sourceEvidenceReader.js";
import { resolveObjectEvidence } from "../semantic/recognition/objectEvidenceDecision.js";

export { ENGINEERING_RECOGNITION_VERSION } from "../semantic/recognition/objectEvidenceDecision.js";
export { ENGINEERING_EVIDENCE_FIELDS } from "../shared/recognitionFieldPolicy.js";
export type { SourceRecord, SourceProperty } from "../shared/sourceRecord.js";

interface SourceEvidenceOptions {
  sourceTypesComplete: boolean;
  completeNeutralAssembly: boolean;
}

/** Public adapter entry retained for consumers; implementation lives in Semantic. */
export function adaptSourceEvidence(
  record: SourceRecord,
  options: SourceEvidenceOptions,
): ReturnType<typeof resolveObjectEvidence> {
  return resolveObjectEvidence(
    readSourceFormatFacts(record, options.sourceTypesComplete),
    options.completeNeutralAssembly,
  );
}

export function toObjectEvidence(record: SourceRecord) {
  return adaptSourceEvidence(record, {
    sourceTypesComplete: true,
    completeNeutralAssembly: false,
  });
}
