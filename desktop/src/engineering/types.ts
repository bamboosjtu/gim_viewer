/** Format-neutral contracts. Source parsing and rendering are separate consumers. */
export interface EvidenceValue {
  value: string;
  evidenceId: string;
}

export interface ObjectEvidence {
  /** Package-local occurrence identity, never a template or display-name identity. */
  sourceId: string;
  name: string;
  /** A real composition edge; a source navigation ancestor is not a composition edge. */
  assemblyParentId?: string;
  typeCategory?: string;
  traits: {
    fastener?: boolean;
    assemblyContainer?: boolean;
    materialType?: boolean;
    nonphysical?: boolean;
  };
  designations: readonly EvidenceValue[];
  identityCodes: readonly EvidenceValue[];
  identityNames: readonly EvidenceValue[];
  phases: readonly EvidenceValue[];
}

export type SourceMeaning = 'object' | 'part' | 'fragment' | 'neutral_set' | 'container' | 'detail' | 'source_only';
export interface ObjectInterpretation {
  category: string;
  meaning: SourceMeaning;
  basis: string;
  conflict: string;
  independent: boolean;
  assemblyCategory: string;
  assemblySignature: string;
}

export interface EngineeringEntity {
  id: string;
  category: string;
  name: string;
  kind: 'whole' | 'set' | 'transformer_bank';
  boundaryEvidence: string;
  classificationState: 'identified' | 'unknown';
  sourceIds: string[];
  classificationConflicts: number;
  phaseBodyCount?: number;
  compositionState?: 'declared_identity_physical_completeness_unverified' | 'phase_completeness_unverified';
}

export interface PendingWhole {
  id: string;
  reason: string;
  sourceIds: string[];
}

export interface SourceMembership {
  sourceId: string;
  ownerId: string | null;
  disposition: 'whole_member' | 'pending_whole_member' | 'source_only';
  interpretation: ObjectInterpretation;
}

/** An independent entity's association does not make its representations internal. */
export interface EntityRelationship {
  from: string;
  to: string;
  kind: 'associated_with';
  evidence: string;
}

export interface SourceAlias {
  sourceId: string;
  candidates: readonly string[];
  status: 'confirmed' | 'ambiguous' | 'unresolved';
}

export interface WholeAlias {
  sourceId: string;
  ownerId: string | null;
  status: 'whole_resolved_component_ambiguous' | 'pending_bundle_resolved' | 'whole_unresolved';
  componentCandidates: readonly string[];
}

export interface EngineeringSnapshot {
  scope: string;
  rulesVersion: string;
  entities: EngineeringEntity[];
  memberships: SourceMembership[];
  pending: PendingWhole[];
  relationships: EntityRelationship[];
  aliases: WholeAlias[];
  diagnostics: Array<{ kind: string; identity: string; name: string }>;
}
