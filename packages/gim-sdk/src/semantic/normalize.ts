import {
  COMPOSITION_POLICY,
  COMPOSITION_SUBTYPE_COMPONENTS,
  compositionSubtypeHost,
  compositionSubtype,
} from "./compositionPolicy.js";
import { ENGINEERING_RULES_VERSION, explicitMain } from "./classify.js";
import { assertEngineeringPartition } from "./validate.js";
import {
  categoryDefinition,
  publishDirectoryClassification,
} from "./catalogClassification.js";
import { classificationDetails } from "./classificationDetails.js";
import { recoverComponentMembership } from "./recoverMembership.js";
import type {
  EngineeringEntity,
  EngineeringSnapshot,
  ObjectEvidence,
  PendingWhole,
  SourceAlias,
} from "./types.js";

import {
  compareSourceIds as compare,
  engineeringEntityId as identity,
  explicitIndependent,
  isReserved as reserve,
  isTransformerCategory as transformer,
  prepareEvidence,
} from "./normalization/prepareEvidence.js";
import { resolveTransformerBanks } from "./normalization/transformerBank.js";
import { resolveOwnership } from "./normalization/ownershipResolver.js";

export function normalizeEngineeringModel(
  scope: string,
  input: readonly ObjectEvidence[],
  aliases: readonly SourceAlias[] = [],
): EngineeringSnapshot {
  if (!scope) throw new Error("Engineering scope is required");
  const { disputedComposition, ordered, raw, parents, meaning } =
    prepareEvidence(input);
  const entities = new Map<string, EngineeringEntity>();
  const pending = new Map<string, PendingWhole>();
  const owners = new Map<string, string | null>();
  const relationships: EngineeringSnapshot["relationships"] = [];
  const diagnostics: EngineeringSnapshot["diagnostics"] = [];

  function addEntity(
    seed: string,
    category: string,
    name: string,
    proof: string,
    sourceIds: string[],
    kind: EngineeringEntity["kind"] = "whole",
  ) {
    const id = identity(scope, "entity", seed);
    if (entities.has(id))
      throw new Error(`Engineering identity collision: ${id}`);
    entities.set(id, {
      id,
      category,
      name,
      kind,
      boundaryEvidence: proof,
      classificationState: category === "U-OBJECT" ? "unknown" : "identified",
      sourceIds: [],
      classificationConflicts: 0,
      classificationStatus:
        meaning.get(
          sourceIds.find((id) => meaning.get(id)?.category === category) ?? "",
        )?.classificationStatus ??
        (category === "U-OBJECT" ? "unresolved" : "confirmed"),
      boundaryStatus:
        proof === "outward_object_boundary_unconfirmed" ||
        kind !== "whole" ||
        (sourceIds.some(
          (id) =>
            meaning.get(id)?.equipmentType ||
            meaning.get(id)?.componentType ||
            meaning.get(id)?.classificationStatus !== "confirmed",
        ) &&
          !sourceIds.some(
            (id) =>
              raw.get(id)?.identityCodes.length ||
              raw.get(id)?.designations.length ||
              explicitIndependent(raw.get(id)!),
          )) ||
        (COMPOSITION_POLICY.boundaryRequiresIdentity.includes(category) &&
          !sourceIds.some((id) => raw.get(id)?.identityCodes.length))
          ? "candidate"
          : "confirmed",
      grain: categoryDefinition(category)?.grain as
        "item" | "segment" | undefined,
      ...classificationDetails(category),
    });
    const interpreted = sourceIds
      .map((id) => meaning.get(id)!)
      .find((m) => m.category === category);
    if (interpreted)
      Object.assign(entities.get(id)!, {
        standardClass: interpreted.standardClass,
        subtype: interpreted.subtype,
        subtypeLabel: interpreted.subtypeLabel,
        unknownReason: interpreted.unknownReason,
      });
    sourceIds.forEach((sourceId) => owners.set(sourceId, id));
    return entities.get(id)!;
  }
  function bundle(seed: string, reason: string, sourceIds: string[]) {
    const id = identity(scope, "pending", seed);
    if (pending.has(id)) throw new Error(`Pending identity collision: ${id}`);
    pending.set(id, { id, reason, sourceIds: [] });
    sourceIds.forEach((sourceId) => owners.set(sourceId, id));
    return id;
  }

  resolveTransformerBanks({
    ordered,
    raw,
    meaning,
    owners,
    addEntity,
    bundle,
    diagnostics,
  });
  resolveOwnership({
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
  });
  // Index explicit host designations after traversal, so source order cannot
  // choose a host. A candidate spanning multiple main entities stays unresolved.
  const mainEntities = new Map<string, Set<string>>();
  for (const row of ordered) {
    const owner = owners.get(row.sourceId);
    const number = explicitMain(row);
    if (
      owner &&
      number &&
      entities.get(owner)?.category === "E01" &&
      meaning.get(row.sourceId)!.meaning === "object" &&
      transformer(meaning.get(row.sourceId)!.category)
    ) {
      const unit = `${number}${reserve(row) ? ":reserve" : ""}`,
        ids = mainEntities.get(unit) ?? new Set<string>();
      ids.add(owner);
      mainEntities.set(unit, ids);
    }
  }
  const redirects = new Map<string, string>();
  for (const row of ordered) {
    if (meaning.get(row.sourceId)!.meaning !== "neutral_set") continue;
    if (
      row.hostCodes?.length ||
      row.hostDesignations?.length ||
      row.declaredHostSourceIds?.length
    )
      continue;
    const previous = owners.get(row.sourceId);
    if (
      !previous ||
      pending.get(previous)?.reason !== "neutral_set_main_unresolved"
    )
      continue;
    const candidates = mainEntities.get(
      `${explicitMain(row)}${reserve(row) ? ":reserve" : ""}`,
    );
    if (candidates?.size === 1) {
      redirects.set(previous, [...candidates][0]);
      pending.delete(previous);
    }
  }
  for (const [sourceId, owner] of owners)
    if (owner && redirects.has(owner))
      owners.set(sourceId, redirects.get(owner)!);
  for (const relation of relationships)
    relation.to = redirects.get(relation.to) ?? relation.to;

  recoverComponentMembership(
    ordered,
    meaning,
    owners,
    entities,
    pending,
    (source, reason) => {
      bundle(`component-host:${source}`, reason, [source]);
    },
    (seed, category, name, source) =>
      addEntity(seed, category, name, "declared_component_host_boundary", [
        source,
      ]),
    diagnostics,
  );
  const usedOwners = new Set(owners.values());
  for (const id of entities.keys())
    if (!usedOwners.has(id)) entities.delete(id);
  for (const id of pending.keys()) if (!usedOwners.has(id)) pending.delete(id);
  for (let i = relationships.length - 1; i >= 0; i--)
    if (
      !entities.has(relationships[i].from) ||
      !entities.has(relationships[i].to)
    )
      relationships.splice(i, 1);

  const subtypeWitnesses = new Map<string, Map<string, readonly string[]>>();
  const memberships = ordered.map((row) => {
    const ownerId = owners.get(row.sourceId) ?? null;
    const interpretation = meaning.get(row.sourceId)!;
    if (interpretation.objectRole)
      interpretation.objectRole = {
        ...interpretation.objectRole,
        id: interpretation.meaning,
      };
    const entity = ownerId ? entities.get(ownerId) : undefined;
    if (entity) {
      entity.sourceIds.push(row.sourceId);
      if (interpretation.conflict) entity.classificationConflicts++;
      const component = interpretation.componentType;
      if (
        interpretation.meaning === "part" &&
        component?.status === "confirmed" &&
        component.id &&
        COMPOSITION_SUBTYPE_COMPONENTS.has(component.id) &&
        compositionSubtypeHost(entity.category)
      ) {
        let witnesses = subtypeWitnesses.get(entity.id);
        if (!witnesses) {
          witnesses = new Map();
          subtypeWitnesses.set(entity.id, witnesses);
        }
        if (!witnesses.has(component.id))
          witnesses.set(component.id, component.evidence);
      }
    } else if (ownerId) {
      const target = pending.get(ownerId);
      if (!target) throw new Error(`Dangling source owner: ${row.sourceId}`);
      target.sourceIds.push(row.sourceId);
    }
    return {
      sourceId: row.sourceId,
      ownerId,
      interpretation,
      ...(disputedComposition.has(row.sourceId)
        ? { compositionCandidates: disputedComposition.get(row.sourceId) }
        : {}),
      ...(row.assemblyParentId && raw.has(row.assemblyParentId)
        ? { parentPartId: row.assemblyParentId }
        : {}),
      disposition: entity
        ? ("whole_member" as const)
        : ownerId
          ? ("pending_whole_member" as const)
          : ("source_only" as const),
    };
  });
  const wholeAliases: EngineeringSnapshot["aliases"] = aliases
    .filter((a) => a.status !== "confirmed")
    .map((alias) => {
      const targets = new Set(
        alias.candidates.map((sourceId) => owners.get(sourceId) ?? null),
      );
      const ownerId = targets.size === 1 ? [...targets][0] : null;
      return {
        sourceId: alias.sourceId,
        ownerId,
        status:
          ownerId && entities.has(ownerId)
            ? "whole_resolved_component_ambiguous"
            : ownerId && pending.has(ownerId)
              ? "pending_bundle_resolved"
              : "whole_unresolved",
        componentCandidates: [...alias.candidates],
      };
    });
  const snapshot: EngineeringSnapshot = {
    recognitionCoverage: {
      inputSourceIds: ordered.map((r) => r.sourceId),
      processed: ordered.length,
      confirmed: 0,
      complete: true,
    },
    scope,
    evidenceBinding: { scope, sourceRevision: 0 },
    rulesVersion: ENGINEERING_RULES_VERSION,
    entities: [...entities.values()].sort((a, b) => compare(a.id, b.id)),
    memberships,
    pending: [...pending.values()].sort((a, b) => compare(a.id, b.id)),
    relationships: relationships.sort((a, b) =>
      compare(JSON.stringify(a), JSON.stringify(b)),
    ),
    aliases: wholeAliases,
    diagnostics,
  };
  for (const entity of snapshot.entities) {
    const subtype = compositionSubtype(entity, subtypeWitnesses.get(entity.id));
    if (subtype) {
      Object.assign(entity, subtype);
      if (entity.unknownReason === "equipment_subtype_evidence_insufficient")
        delete entity.unknownReason;
    }
    Object.assign(entity, publishDirectoryClassification(entity));
    entity.classificationState =
      entity.category === "U-OBJECT" ? "unknown" : "identified";
  }
  for (const member of snapshot.memberships) {
    Object.assign(
      member.interpretation,
      publishDirectoryClassification(member.interpretation),
    );
    if (member.interpretation.categoryStatus === "confirmed")
      snapshot.recognitionCoverage!.confirmed++;
  }
  assertEngineeringPartition(
    snapshot,
    ordered.map((row) => row.sourceId),
  );
  return snapshot;
}
