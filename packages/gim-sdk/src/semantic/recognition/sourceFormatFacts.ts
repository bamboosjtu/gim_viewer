import type {
  CompositionEvidence,
  EvidenceValue,
  ObjectNameEvidence,
} from "../../shared/contracts.js";

/** Type text and the explicitly declared physical edge of an occurrence. */
export interface SourceTypeObservation {
  sourceId: string;
  declaredType: string;
  physicalParentId?: string;
}

export interface SourceTypeDeclarations {
  declaration: EvidenceValue;
  modelDialect: "dev" | "ifc";
  properties: readonly EvidenceValue[];
  supplementalTypeProperties: readonly EvidenceValue[];
  models: readonly EvidenceValue[];
  predefinedTypes: readonly EvidenceValue[];
  cabinetNames: readonly EvidenceValue[];
  roadPositions: readonly EvidenceValue[];
  authoringCategories: readonly EvidenceValue[];
}

/** Structured format evidence from one occurrence, prior to interpretation. */
export interface SourceFormatFacts {
  sourceId: string;
  name: string;
  names?: readonly ObjectNameEvidence[];
  assemblyParentId?: string;
  composition?: readonly CompositionEvidence[];
  sourceTypesComplete: boolean;
  sourceType: SourceTypeDeclarations;
  roles: readonly EvidenceValue[];
  purposes: readonly EvidenceValue[];
  hostCodes: readonly EvidenceValue[];
  hostDesignations: readonly EvidenceValue[];
  declaredHostSourceIds: readonly EvidenceValue[] | undefined;
  componentTypeDeclarations: readonly EvidenceValue[];
  keywordDeclarations: readonly EvidenceValue[];
  vocabularyDeclarations: readonly { field: string; property: EvidenceValue }[];
  contextualDeclarations: readonly EvidenceValue[];
  deviceNames: readonly EvidenceValue[];
  materialDeclarations: readonly EvidenceValue[];
  modelProperties: readonly EvidenceValue[];
  designations: readonly EvidenceValue[];
  identityCodes: readonly EvidenceValue[];
  identityNames: readonly EvidenceValue[];
  phases: readonly EvidenceValue[];
  phaseLabels: readonly EvidenceValue[];
}
