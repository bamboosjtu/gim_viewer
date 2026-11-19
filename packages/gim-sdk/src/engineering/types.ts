/** Format-neutral contracts. Source parsing and rendering are separate consumers. */
export interface EvidenceValue {
  confidence?: "confirmed" | "candidate";
  value: string;
  evidenceId: string;
  context?: {
    section?: string;
    container?: string;
    rawContainerName?: string;
    applicability?: "instance" | "type" | "unknown";
  };
}

/** Names belonging to this occurrence, with their original evidence address. */
export interface ObjectNameEvidence extends EvidenceValue {
  kind: "object" | "engineering" | "family" | "source";
}

export interface ObjectEvidence {
  /** Typed source edges, independent of physical placement and organization. */
  composition?: readonly CompositionEvidence[];
  /** Same source facts interpreted when a proven physical/declared host is equipment. */
  equipmentMemberVariant?: ObjectEvidence;
  cabinetMemberVariant?: ObjectEvidence;
  allowNameFallback?: boolean;
  vocabularyAmbiguities?: readonly string[];
  standardClasses?: readonly StandardClassEvidence[];
  hostCodes?: readonly EvidenceValue[];
  hostDesignations?: readonly EvidenceValue[];
  declaredHostSourceIds?: readonly EvidenceValue[];
  vocabularyObservations?: readonly VocabularyObservation[];
  equipmentTypeCandidates?: readonly EvidenceValue[];
  componentTypeCandidates?: readonly EvidenceValue[];
  purposes?: readonly EvidenceValue[];
  /** Package-local occurrence identity, never a template or display-name identity. */
  sourceId: string;
  name: string;
  names?: readonly ObjectNameEvidence[];
  /** Domain composition parent, from physical assembly or confirmed semantic composition. */
  assemblyParentId?: string;
  typeCategory?: string;
  typeEvidenceId?: string;
  /** Private category/role hints interpreted from current-object structured fields. */
  propertyCategories?: readonly EvidenceValue[];
  objectRoles?: readonly EvidenceValue[];
  phaseLabels?: readonly EvidenceValue[];
  typeRefinements?: readonly string[];
  traits: {
    fastener?: boolean;
    assemblyContainer?: boolean;
    materialType?: boolean;
    nonphysical?: boolean;
    /** LED declaration on an occurrence named as a luminaire terminal board. */
    luminaireTerminal?: EvidenceValue;
  };
  /** Explicit designations of this object, never inherited organization labels. */
  designations: readonly EvidenceValue[];
  identityCodes: readonly EvidenceValue[];
  identityNames: readonly EvidenceValue[];
  /** Audit/context only. Cannot establish identity, grouping or attachment hosts. */
  inheritedContextDesignations?: readonly EvidenceValue[];
  phases: readonly EvidenceValue[];
}

export interface CompositionEvidence {
  kind: "semantic_composition" | "physical_assembly" | "object_decomposition";
  parentSourceIds: readonly string[];
  evidence: readonly string[];
  status: "confirmed" | "ambiguous" | "unresolved";
}

export type SourceMeaning =
  "object" | "part" | "neutral_set" | "container" | "detail" | "source_only";
export interface ObjectInterpretation {
  /** Private identity/assembly role, independent from the workbook directory. */
  recognitionCode?: string;
  sourceName?: string;
  standardClass?: StandardClassEvidence & {
    status: "confirmed" | "candidate" | "unresolved";
    evidence: readonly string[];
  };
  membershipEvidence?: readonly string[];
  membershipStatus?: "confirmed" | "candidate" | "unresolved";
  vocabularyObservations?: readonly VocabularyObservation[];
  categoryStatus?: "confirmed" | "candidate" | "unresolved";
  equipmentType?: TermInterpretation;
  componentType?: TermInterpretation;
  purpose?: TermInterpretation;
  objectRole?: TermInterpretation;
  /** Public workbook family code. Independent from purpose and assembly role. */
  category: string;
  meaning: SourceMeaning;
  basis: string;
  conflict: string;
  independent: boolean;
  classificationStatus?: "confirmed" | "candidate" | "unresolved";
  classificationEvidence?: string[];
  unknownReason?: string;
  subtype?: string;
  subtypeLabel?: string;
}

export interface TermInterpretation {
  id?: string;
  status: "confirmed" | "candidate" | "unresolved";
  evidence: readonly string[];
}
export interface VocabularyObservation {
  verification?: "verified" | "unverified" | "ambiguous";
  sourceLocation?: string;
  field: string;
  rawValue: string;
  status: "mapped" | "unresolved" | "ambiguous";
  evidenceId: string;
  dictionaryVersion: string;
  dictionaryEvidence?: string;
}

export interface EngineeringEntity {
  /** Functional equipment subtype inferred from confirmed members, not catalog facts. */
  subtypeStatus?: "confirmed" | "candidate" | "unresolved";
  subtypeEvidence?: readonly string[];
  /** Identity/assembly role; category is exclusively the workbook directory code. */
  recognitionCode?: string;
  standardClass?: ObjectInterpretation["standardClass"];
  id: string;
  category: string;
  name: string;
  kind: "whole" | "set" | "transformer_bank";
  boundaryEvidence: string;
  classificationState: "identified" | "unknown";
  sourceIds: string[];
  classificationConflicts: number;
  classificationStatus?: "confirmed" | "candidate" | "unresolved";
  categoryStatus?: "confirmed" | "candidate" | "unresolved";
  boundaryStatus?: "confirmed" | "candidate" | "unresolved";
  subtype?: string;
  subtypeLabel?: string;
  unknownReason?: string;
  grain?: "item" | "segment";
  phaseBodyCount?: number;
  compositionState?:
    | "declared_identity_physical_completeness_unverified"
    | "phase_completeness_unverified";
}

export interface StandardClassEvidence extends EvidenceValue {
  recognitionCode?: string;
  id: string;
  kind: "equipment" | "material" | "construction";
  label: string;
  term: string;
  category: string;
  catalogCategory?: string;
  catalogGroup?: string;
}

export interface PendingWhole {
  id: string;
  reason: string;
  sourceIds: string[];
}

export interface SourceMembership {
  /** Unresolved source edges retained alongside any independently verified physical parent. */
  compositionCandidates?: readonly CompositionEvidence[];
  /** Direct composition parent; distinct from the owning engineering whole. */
  parentPartId?: string;
  sourceId: string;
  ownerId: string | null;
  disposition: "whole_member" | "pending_whole_member" | "source_only";
  interpretation: ObjectInterpretation;
}

/** An independent entity's association does not make its representations internal. */
export interface EntityRelationship {
  from: string;
  to: string;
  kind: "associated_with";
  evidence: string;
}

export interface SourceAlias {
  sourceId: string;
  candidates: readonly string[];
  status: "confirmed" | "ambiguous" | "unresolved";
}

export interface WholeAlias {
  sourceId: string;
  ownerId: string | null;
  status:
    | "whole_resolved_component_ambiguous"
    | "pending_bundle_resolved"
    | "whole_unresolved";
  componentCandidates: readonly string[];
}

export interface EngineeringSnapshot {
  /** Source-fact revision, separate from query pagination/residency cursors. */
  evidenceBinding: { scope: string; sourceRevision: number };
  recognitionCoverage?: {
    inputSourceIds: readonly string[];
    processed: number;
    confirmed: number;
    complete: boolean;
  };
  scope: string;
  rulesVersion: string;
  entities: EngineeringEntity[];
  memberships: SourceMembership[];
  pending: PendingWhole[];
  relationships: EntityRelationship[];
  aliases: WholeAlias[];
  diagnostics: Array<{ kind: string; identity: string; name: string }>;
}
