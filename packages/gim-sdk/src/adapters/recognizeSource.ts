import type { SourceRecord } from "../shared/sourceRecord.js";
import { ENGINEERING_EVIDENCE_FIELDS } from "../shared/recognitionFieldPolicy.js";
import { createValueReader } from "./evidenceReader.js";
import { sourceTypeCandidates } from "./sourceTypeCandidates.js";
import {
  applyTypeDefaults,
  cabinetModelType,
  canonicalSourceType,
  ifcModelType,
  isTypeDeclaration,
  roadPositionType,
} from "./sourceTypePolicy.js";
import {
  ENGINEERING_RECOGNITION_VERSION,
  resolveObjectEvidence,
} from "../semantic/recognition/objectEvidenceDecision.js";
import type {
  SourceEvidenceFacts,
  SourceEvidenceOptions,
} from "../semantic/recognition/sourceEvidenceFacts.js";

export { ENGINEERING_RECOGNITION_VERSION, ENGINEERING_EVIDENCE_FIELDS };
export type { SourceRecord, SourceProperty } from "../shared/sourceRecord.js";

/** Read format fields and normalize values; semantic decisions are not made here. */
export function readSourceEvidenceFacts(
  record: SourceRecord,
  completeNeutralAssembly = false,
): SourceEvidenceFacts {
  const values = createValueReader(record);
  const candidates = sourceTypeCandidates(
    record,
    values,
    completeNeutralAssembly,
  );
  return {
    ...candidates,
    record,
    values,
    normalize: {
      applyTypeDefaults: (declarations) => applyTypeDefaults([...declarations]),
      canonicalSourceType,
      cabinetModelType,
      ifcModelType,
      isTypeDeclaration,
      roadPositionType: (type, positions) =>
        roadPositionType(type, [...positions]),
    },
  };
}

/** Public adapter entry retained for consumers; implementation lives in Semantic. */
export function adaptSourceEvidence(
  record: SourceRecord,
  options: SourceEvidenceOptions,
): ReturnType<typeof resolveObjectEvidence> {
  return resolveObjectEvidence(
    readSourceEvidenceFacts(record, options.completeNeutralAssembly),
    options,
  );
}

export function toObjectEvidence(record: SourceRecord) {
  return adaptSourceEvidence(record, {
    sourceTypesComplete: true,
    completeNeutralAssembly: false,
  });
}
