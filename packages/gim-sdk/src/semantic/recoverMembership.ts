import {
  categoryFromName,
  isNumberedDesignation,
  mainNumber,
} from "./classify.js";
import {
  componentHostCompatibility,
  COMPOSITION_POLICY,
  isEquipmentHost,
} from "./compositionPolicy.js";
import type {
  ObjectEvidence,
  ObjectInterpretation,
  EngineeringEntity,
  EngineeringSnapshot,
  PendingWhole,
} from "./types.js";

import { createMembershipRecoveryState } from "./normalization/membershipRecoveryState.js";

/** Recover engineering composition from object-owned declarations. This never
 * edits the source parent, physical occurrence or representation address. */
export function recoverComponentMembership(
  rows: readonly ObjectEvidence[],
  meaning: ReadonlyMap<string, ObjectInterpretation>,
  owners: Map<string, string | null>,
  entities: Map<string, EngineeringEntity>,
  pending: ReadonlyMap<string, PendingWhole>,
  unresolved: (sourceId: string, reason: string) => void,
  create: (
    seed: string,
    category: string,
    name: string,
    source: string,
  ) => EngineeringEntity,
  diagnostics: EngineeringSnapshot["diagnostics"],
): void {
  const { key, codes, names, index, attach } = createMembershipRecoveryState(
    rows,
    meaning,
    owners,
    entities,
  );
  for (const row of rows) {
    const m = meaning.get(row.sourceId)!;
    const prior = owners.get(row.sourceId);
    const reason = prior ? pending.get(prior)?.reason : undefined;
    // Host declarations can fill absent ownership, not erase contrary source evidence.
    const neutral = m.meaning === "neutral_set";
    if (
      reason &&
      reason !== "component_whole_unresolved" &&
      !(neutral && reason === "neutral_set_main_unresolved")
    )
      continue;
    if (
      m.basis === "attribute_conflict" ||
      row.objectRoles?.some((p) => p.value === "independent") ||
      !(
        neutral ||
        m.meaning === "part" ||
        m.componentType?.status === "confirmed"
      )
    )
      continue;
    const direct = row.declaredHostSourceIds ?? [];
    const declared = !!(
      direct.length ||
      row.hostCodes?.length ||
      row.hostDesignations?.length
    );
    const explicit = [
      ...direct,
      ...(row.hostCodes ?? []),
      ...(row.hostDesignations ?? []),
    ];
    const designations = row.hostDesignations ?? [];
    if (!explicit.length) continue;
    const luminaireTerminal = m.basis === "luminaire_terminal_assembly";
    const luminaireHost = (host: EngineeringEntity) =>
      luminaireTerminal && host.standardClass?.id === "material:lamps";
    const constraints = [
      ...direct.map((p) => {
        const owner = owners.get(p.value),
          host = owner ? entities.get(owner) : undefined;
        return host && (isEquipmentHost(host) || luminaireHost(host))
          ? new Set([host.id])
          : new Set<string>();
      }),
      ...(row.hostCodes ?? []).map(
        (p) => codes.get(key(p.value)) ?? new Set<string>(),
      ),
      ...designations.map((p) => names.get(key(p.value)) ?? new Set<string>()),
    ];
    if (!constraints.length) continue;
    let candidates = new Set(constraints[0]);
    for (const values of constraints.slice(1))
      candidates = new Set([...candidates].filter((id) => values.has(id)));
    const matched = [...candidates];
    const accepts = (id: string) =>
      neutral
        ? COMPOSITION_POLICY.transformerRoles.includes(
            entities.get(id)!.category,
          )
        : luminaireTerminal
          ? luminaireHost(entities.get(id)!)
          : componentHostCompatibility(m, entities.get(id)!) === "compatible" ||
            (!m.componentType &&
              row.objectRoles?.some((p) => p.value === "part"));
    candidates = new Set(matched.filter(accepts));
    if (
      !explicit.length &&
      m.meaning === "object" &&
      candidates.size === 1 &&
      candidates.has(owners.get(row.sourceId) ?? "")
    )
      continue;
    const proof = [...direct, ...(row.hostCodes ?? []), ...designations]
      .map((p) => p.evidenceId)
      .concat(
        m.componentType?.evidence ?? [],
        `policy:${COMPOSITION_POLICY.version}:${m.componentType?.id ?? "declared-role"}`,
      );
    if (candidates.size === 1) {
      const target = [...candidates][0],
        previous = owners.get(row.sourceId);
      if (luminaireTerminal && previous === target) continue;
      if (
        previous &&
        entities.has(previous) &&
        previous !== target &&
        row.composition?.some((edge) => edge.status === "confirmed")
      ) {
        const reason = "composition_host_conflict";
        unresolved(row.sourceId, reason);
        attach(
          row,
          owners.get(row.sourceId)!,
          [...(m.membershipEvidence ?? []), ...proof],
          "unresolved",
          previous,
        );
        m.conflict = reason;
        diagnostics.push({
          kind: reason,
          identity: row.sourceId,
          name: row.name,
        });
      } else attach(row, target, proof, declared ? "confirmed" : "candidate");
      continue;
    }
    const anyMatch = constraints.some((ids) => ids.size > 0);
    const resolved = constraints.filter((ids) => ids.size > 0);
    const conflicting =
      resolved.length > 1 &&
      resolved.reduce(
        (common, ids) => new Set([...common].filter((id) => ids.has(id))),
        new Set(resolved[0]),
      ).size === 0;
    const name = designations.length === 1 ? designations[0].value : "",
      category = mainNumber(name) ? "E01" : categoryFromName(name);
    // A declared numbered host can establish a candidate whole even when the
    // exporter delivered only its components. A catalog term alone cannot.
    if (
      !direct.length &&
      !anyMatch &&
      name &&
      isNumberedDesignation(name) &&
      category.startsWith("E") &&
      m.meaning === "part" &&
      componentHostCompatibility(m, { category }) === "compatible"
    ) {
      const code = row.hostCodes?.[0]?.value ?? "",
        seed = `declared-host:${JSON.stringify([code, key(name)])}`;
      const host = create(seed, category, name, row.sourceId);
      host.boundaryStatus = "candidate";
      host.classificationStatus = "candidate";
      index(names, name, host.id);
      if (code) index(codes, code, host.id);
      attach(row, host.id, proof, "candidate");
      continue;
    }
    if (explicit.length || anyMatch) {
      const reason = conflicting
        ? "component_host_conflict"
        : matched.length && !candidates.size
          ? matched.some(
              (id) =>
                componentHostCompatibility(m, entities.get(id)!) ===
                "unconfigured",
            )
            ? "component_host_unconfigured"
            : "component_host_incompatible"
          : anyMatch
            ? "component_host_ambiguous"
            : "component_host_not_found";
      unresolved(row.sourceId, reason);
      m.membershipEvidence = proof;
      m.membershipStatus = "unresolved";
      m.conflict = conflicting ? reason : m.conflict;
      diagnostics.push({
        kind: reason,
        identity: row.sourceId,
        name: row.name,
      });
    }
  }
}
