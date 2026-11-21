import {
  COMPOSITION_POLICY,
  componentHostCompatibility,
  isEquipmentHost,
  separateInstallation,
  unclassifiedAssemblyCandidate,
} from "../compositionPolicy.js";
import type {
  EngineeringEntity,
  EngineeringSnapshot,
  ObjectEvidence,
  ObjectInterpretation,
  PendingWhole,
} from "../types.js";
import { contextualInterpretation } from "./contextualRecognition.js";
import {
  explicitIndependent,
  isTransformerCategory as transformer,
  wholeName,
} from "./prepareEvidence.js";

interface OwnershipContext {
  ordered: readonly ObjectEvidence[];
  raw: ReadonlyMap<string, ObjectEvidence>;
  meaning: Map<string, ObjectInterpretation>;
  parents: ReadonlySet<string | undefined>;
  disputedComposition: ReadonlyMap<
    string,
    NonNullable<ObjectEvidence["composition"]>
  >;
  owners: Map<string, string | null>;
  pending: Map<string, PendingWhole>;
  entities: Map<string, EngineeringEntity>;
  relationships: EngineeringSnapshot["relationships"];
  diagnostics: EngineeringSnapshot["diagnostics"];
  addEntity: (
    seed: string,
    category: string,
    name: string,
    proof: string,
    sourceIds: string[],
    kind?: EngineeringEntity["kind"],
  ) => EngineeringEntity;
  bundle: (seed: string, reason: string, sourceIds: string[]) => unknown;
}

/** Remaining objects may share a physical assembly but never inherit a whole by default. */
function planSeparateObjectBoundary(
  m: Pick<ObjectInterpretation, "category" | "independent">,
  aboveCategory: string | undefined,
  abovePending: boolean,
): { proof: string; association?: string } {
  if (m.independent)
    return {
      proof: "independent_function_identity",
      association: "source_assembly_only",
    };
  if (aboveCategory === "U-OBJECT" && m.category !== "U-OBJECT")
    return {
      proof: "object_identity_parent_boundary_unknown",
      association: "unknown_parent_does_not_define_whole_boundary",
    };
  if (aboveCategory)
    return {
      proof: separateInstallation(m.category, aboveCategory)
        ? "independent_installation_object"
        : "object_identity_in_assembly",
      association: "source_assembly_only",
    };
  return {
    proof:
      !abovePending && m.category === "U-OBJECT"
        ? "outward_object_boundary_unconfirmed"
        : "object_identity",
  };
}
export function resolveOwnership({
  ordered,
  raw,
  meaning,
  parents,
  disputedComposition,
  owners,
  pending,
  entities,
  relationships,
  diagnostics,
  addEntity,
  bundle,
}: OwnershipContext): void {
  const visiting = new Set<string>();
  const equipmentContexts = new Map<string, boolean>();
  const declaredEquipment = (value: ObjectInterpretation) =>
    isEquipmentHost(value) &&
    ![
      "object_name",
      "standard_name_candidate",
      "family_identity_candidate",
      "unknown",
    ].includes(value.basis);
  function assign(sourceId: string): string | null {
    if (owners.has(sourceId)) return owners.get(sourceId)!;
    if (visiting.has(sourceId))
      throw new Error(`Source assembly cycle: ${sourceId}`);
    visiting.add(sourceId);
    const row = raw.get(sourceId)!;
    let m = meaning.get(sourceId)!;
    const above =
      row.assemblyParentId && raw.has(row.assemblyParentId)
        ? assign(row.assemblyParentId)
        : null;
    const parentMeaning = row.assemblyParentId
      ? meaning.get(row.assemblyParentId)
      : undefined;
    const parentEquipment = !!(
      row.assemblyParentId &&
      (equipmentContexts.get(row.assemblyParentId) ||
        (parentMeaning && declaredEquipment(parentMeaning)))
    );
    const host = above ? entities.get(above) : undefined;
    const contextual = contextualInterpretation(
      row,
      m,
      parentEquipment,
      host,
      parents,
    );
    if (contextual !== m) {
      m = contextual;
      meaning.set(sourceId, m);
    }
    const aboveCategory = above ? entities.get(above)?.category : undefined;
    const associate = (proof: string, evidence: string) => {
      const entity = addEntity(
        sourceId,
        m.category,
        wholeName(row, m.category),
        proof,
        [sourceId],
      );
      if (above)
        relationships.push({
          from: entity.id,
          to: above,
          kind: "associated_with",
          evidence,
        });
    };
    const disputed = disputedComposition.get(sourceId);
    if (disputed && row.assemblyParentId)
      diagnostics.push({
        kind: "composition_parent_unresolved",
        identity: sourceId,
        name: row.name,
      });
    if (m.basis === "attribute_conflict") {
      if (m.independent && m.objectRole?.status === "confirmed")
        associate("declared_independent_boundary", "source_assembly_only");
      else bundle(sourceId, "object_attributes_conflict", [sourceId]);
    } else if (
      row.assemblyParentId &&
      !raw.has(row.assemblyParentId) &&
      row.composition?.length &&
      !explicitIndependent(row)
    ) {
      bundle(sourceId, "composition_parent_missing", [sourceId]);
      m.membershipStatus = "unresolved";
      diagnostics.push({
        kind: "composition_parent_missing",
        identity: sourceId,
        name: row.name,
      });
    } else if (!row.assemblyParentId && disputed && !explicitIndependent(row)) {
      bundle(sourceId, "composition_parent_unresolved", [sourceId]);
      m.membershipStatus = "unresolved";
      m.membershipEvidence = disputed.flatMap((edge) => edge.evidence);
      diagnostics.push({
        kind: "composition_parent_unresolved",
        identity: sourceId,
        name: row.name,
      });
    } else if (
      above &&
      row.traits.luminaireTerminal &&
      !explicitIndependent(row) &&
      !m.conflict &&
      m.meaning === "object" &&
      m.category === "U-OBJECT" &&
      parentMeaning?.standardClass?.id === "material:lamps" &&
      row.composition?.some(
        (edge) =>
          edge.kind === "physical_assembly" && edge.status === "confirmed",
      )
    ) {
      m.meaning = "part";
      m.basis = "luminaire_terminal_assembly";
      m.membershipStatus = "candidate";
      m.membershipEvidence = [
        row.traits.luminaireTerminal.evidenceId,
        `assembly:${row.assemblyParentId}->${sourceId}`,
      ];
      owners.set(sourceId, above);
    } else if (
      above &&
      entities.has(above) &&
      parentEquipment &&
      !explicitIndependent(row) &&
      !m.conflict &&
      m.componentType?.status !== "confirmed" &&
      !unclassifiedAssemblyCandidate(row, m) &&
      row.composition?.some(
        (edge) =>
          edge.kind !== "object_decomposition" && edge.status === "confirmed",
      ) &&
      !["source_only", "container", "detail", "neutral_set"].includes(m.meaning)
    ) {
      // An equipment type/code/designation describes the member, not a new whole.
      m.meaning = "part";
      m.independent = false;
      m.membershipStatus = "confirmed";
      m.basis = "source_composition_member";
      m.membershipEvidence = [
        ...new Set(
          row.composition
            .flatMap((edge) => edge.evidence)
            .concat(`policy:${COMPOSITION_POLICY.version}:whole-boundary`),
        ),
      ];
      owners.set(sourceId, above);
    } else if (m.meaning === "neutral_set") {
      if (transformer(aboveCategory) && !explicitIndependent(row)) {
        owners.set(sourceId, above);
        m.membershipStatus = "confirmed";
        m.membershipEvidence = [
          `assembly:${row.assemblyParentId}->${sourceId}`,
        ];
      } else bundle(sourceId, "neutral_set_main_unresolved", [sourceId]);
    } else if (
      above &&
      entities.has(above) &&
      m.componentType?.status === "confirmed" &&
      !explicitIndependent(row)
    ) {
      const compatibility = componentHostCompatibility(m, entities.get(above)!);
      m.membershipEvidence = [
        ...(m.componentType.evidence ?? []),
        `assembly:${row.assemblyParentId}->${sourceId}`,
        `policy:${COMPOSITION_POLICY.version}:${m.componentType.id}`,
      ];
      if (compatibility === "compatible") {
        m.meaning = "part";
        m.independent = false;
        m.basis = "configured_component_assembly";
        m.membershipStatus = "confirmed";
        owners.set(sourceId, above);
      } else {
        const reason =
          compatibility === "unconfigured"
            ? "component_host_unconfigured"
            : "component_host_incompatible";
        bundle(sourceId, reason, [sourceId]);
        m.membershipStatus = "unresolved";
        diagnostics.push({ kind: reason, identity: sourceId, name: row.name });
      }
    } else if (["source_only", "container", "detail"].includes(m.meaning)) {
      owners.set(sourceId, above);
    } else if (m.meaning === "part") {
      if (
        m.componentType &&
        m.componentType.status !== "confirmed" &&
        !row.objectRoles?.some((p) => p.value === "part")
      ) {
        bundle(sourceId, "component_type_unresolved", [sourceId]);
        m.membershipStatus = "unresolved";
      } else if (above) {
        owners.set(sourceId, above);
        m.membershipStatus = "confirmed";
        m.membershipEvidence = [
          ...(row.objectRoles?.map((p) => p.evidenceId) ?? []),
          `assembly:${row.assemblyParentId}->${sourceId}`,
        ];
      } else bundle(sourceId, "component_whole_unresolved", [sourceId]);
    } else if (
      above &&
      parentEquipment &&
      unclassifiedAssemblyCandidate(row, m)
    ) {
      m.meaning = "part";
      m.independent = false;
      m.basis = "unclassified_equipment_assembly_member";
      m.membershipStatus = "candidate";
      m.membershipEvidence = [
        `assembly:${row.assemblyParentId}->${sourceId}`,
        `policy:${COMPOSITION_POLICY.version}:unclassified-assembly-member`,
      ];
      if (m.objectRole)
        m.objectRole = {
          id: "part",
          status: "candidate",
          evidence: m.membershipEvidence,
        };
      owners.set(sourceId, above);
    } else {
      const boundary = planSeparateObjectBoundary(
        m,
        aboveCategory,
        above !== null && pending.has(above),
      );
      if (boundary.association) associate(boundary.proof, boundary.association);
      else
        addEntity(
          sourceId,
          m.category,
          wholeName(row, m.category),
          boundary.proof,
          [sourceId],
        );
    }
    equipmentContexts.set(
      sourceId,
      declaredEquipment(m) ||
        (parentEquipment &&
          ["part", "container", "detail", "source_only"].includes(m.meaning)),
    );
    visiting.delete(sourceId);
    return owners.get(sourceId)!;
  }
  for (const row of ordered)
    if (meaning.get(row.sourceId)!.meaning !== "neutral_set")
      assign(row.sourceId);
  for (const row of ordered) assign(row.sourceId);
}
