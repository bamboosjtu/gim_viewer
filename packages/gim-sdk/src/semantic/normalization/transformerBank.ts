import { COMPOSITION_POLICY, isEquipmentHost } from "../compositionPolicy.js";
import { explicitMain } from "../classify.js";
import type {
  EngineeringEntity,
  EngineeringSnapshot,
  ObjectEvidence,
  ObjectInterpretation,
} from "../types.js";
import {
  compareSourceIds,
  explicitIndependent,
  isReserved,
  isTransformerCategory,
  wholeName,
} from "./prepareEvidence.js";

interface TransformerBankContext {
  ordered: readonly ObjectEvidence[];
  raw: ReadonlyMap<string, ObjectEvidence>;
  meaning: ReadonlyMap<string, ObjectInterpretation>;
  owners: Map<string, string | null>;
  addEntity: (
    seed: string,
    category: string,
    name: string,
    proof: string,
    sourceIds: string[],
    kind?: EngineeringEntity["kind"],
  ) => EngineeringEntity;
  bundle: (seed: string, reason: string, sourceIds: string[]) => unknown;
  diagnostics: EngineeringSnapshot["diagnostics"];
}

/**
 * Group single-phase E01 bodies into transformer banks before ownership
 * traversal. Conflicting banks remain explicit pending/unresolved evidence.
 */
export function resolveTransformerBanks({
  ordered,
  raw,
  meaning,
  owners,
  addEntity,
  bundle,
  diagnostics,
}: TransformerBankContext): void {
  const banks = new Map<string, ObjectEvidence[]>();
  for (const row of ordered) {
    const m = meaning.get(row.sourceId)!;
    const number = explicitMain(row);
    if (
      owners.has(row.sourceId) ||
      explicitIndependent(row) ||
      m.meaning !== "object" ||
      m.category !== "E01" ||
      !number ||
      !row.phases.some((p) => p.value === "单相")
    )
      continue;
    let parent = row.assemblyParentId,
      contained = false;
    while (parent && raw.has(parent)) {
      const ancestor = meaning.get(parent)!;
      if (
        ancestor.meaning === "object" &&
        (isTransformerCategory(ancestor.category) ||
          (row.composition?.length &&
            isEquipmentHost(ancestor) &&
            ![
              "object_name",
              "standard_name_candidate",
              "family_identity_candidate",
              "unknown",
            ].includes(ancestor.basis)))
      ) {
        contained = true;
        break;
      }
      parent = raw.get(parent)?.assemblyParentId;
    }
    if (contained) continue;
    const unit = `${number}${isReserved(row) ? ":reserve" : ""}`;
    const members = banks.get(unit) ?? [];
    members.push(row);
    banks.set(unit, members);
  }
  for (const [number, members] of [...banks].sort(([a], [b]) =>
    compareSourceIds(a, b),
  )) {
    if (members.length < 2) continue;
    const codes = new Set(
      members.flatMap((row) => row.identityCodes.map((p) => p.value)),
    );
    const phases = members.flatMap(
      (row) => row.phaseLabels?.map((p) => p.value.trim().toUpperCase()) ?? [],
    );
    const parents = new Set(
      members
        .map((row) => row.assemblyParentId)
        .filter((id) => id && meaning.get(id)?.meaning !== "container"),
    );
    if (
      members.length > COMPOSITION_POLICY.mainBank.maximumBodies ||
      codes.size > 1 ||
      parents.size > 1 ||
      new Set(phases).size !== phases.length
    ) {
      diagnostics.push({
        kind: "whole_identity_conflict",
        identity: number,
        name: "主变成组证据冲突",
      });
      members.forEach((row) =>
        bundle(
          `main-conflict:${row.sourceId}`,
          "transformer_bank_identity_conflict",
          [row.sourceId],
        ),
      );
      continue;
    }
    const entity = addEntity(
      `main-bank:${number}`,
      "E01",
      wholeName(members[0], "E01"),
      "explicit_main_designation+single_phase_bodies",
      members.map((row) => row.sourceId),
      "transformer_bank",
    );
    entity.phaseBodyCount = members.length;
    entity.compositionState = "phase_completeness_unverified";
  }
}
