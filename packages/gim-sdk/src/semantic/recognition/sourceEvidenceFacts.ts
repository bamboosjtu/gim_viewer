import type { EvidenceValue, ObjectEvidence } from "../types.js";
import type { SourceRecord } from "../../shared/sourceRecord.js";

/** Transient format facts supplied by adapters; no classification state. */
export interface SourceEvidenceFacts {
  record: SourceRecord;
  values: (
    labels: readonly string[],
    skipDevFields?: boolean,
  ) => EvidenceValue[];
  rawType: string;
  sourceTypeEvidenceId: string;
  type: string;
  devTypes: Readonly<Record<string, string>>;
  ifcTypes: Readonly<Record<string, string>>;
  typeFields: readonly string[];
  typeProperties: EvidenceValue[];
  typeModels: EvidenceValue[];
  predefinedCategories: EvidenceValue[];
  normalize: {
    applyTypeDefaults(
      declarations: readonly EvidenceValue[],
    ): readonly EvidenceValue[];
    canonicalSourceType(value: string): string;
    cabinetModelType(value: string): string | undefined;
    ifcModelType(type: string, value: string): string | undefined;
    isTypeDeclaration(value: string): boolean;
    roadPositionType(
      type: string,
      positions: readonly EvidenceValue[],
    ): EvidenceValue | undefined;
  };
}

export interface SourceEvidenceOptions {
  sourceTypesComplete: boolean;
  completeNeutralAssembly: boolean;
}

export type SourceEvidenceDecision = (
  facts: SourceEvidenceFacts,
) => ObjectEvidence;
