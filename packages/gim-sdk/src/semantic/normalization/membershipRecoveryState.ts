import { isNumberedDesignation, mainNumber } from "../classify.js";
import { isEquipmentHost } from "../compositionPolicy.js";
import type {
  EngineeringEntity,
  ObjectEvidence,
  ObjectInterpretation,
} from "../types.js";

/** Builds the recovery indexes once and keeps related membership writes together. */
export function createMembershipRecoveryState(
  rows: readonly ObjectEvidence[],
  meaning: ReadonlyMap<string, ObjectInterpretation>,
  owners: Map<string, string | null>,
  entities: ReadonlyMap<string, EngineeringEntity>,
) {
  const key = (value: string) => {
    const main = mainNumber(value),
      text = value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    return main &&
      /(?:主变(?:压器)?(?:系统)?\d*|主变(?:压器)?(?:系统)?(?:备用|预留)?)$/.test(
        text,
      )
      ? `main:${main}:${/备用|预留/.test(value) ? "reserve" : "active"}`
      : text;
  };
  const codes = new Map<string, Set<string>>(),
    names = new Map<string, Set<string>>(),
    children = new Map<string, ObjectEvidence[]>();
  const index = (
    map: Map<string, Set<string>>,
    value: string,
    owner: string,
  ) => {
    const k = key(value),
      ids = map.get(k) ?? new Set<string>();
    ids.add(owner);
    map.set(k, ids);
  };
  for (const row of rows) {
    if (row.assemblyParentId) {
      const list = children.get(row.assemblyParentId) ?? [];
      list.push(row);
      children.set(row.assemblyParentId, list);
    }
    const owner = owners.get(row.sourceId),
      m = meaning.get(row.sourceId)!;
    if (
      !owner ||
      !entities.has(owner) ||
      !isEquipmentHost(entities.get(owner)!) ||
      m.meaning !== "object"
    )
      continue;
    row.identityCodes.forEach((p) => index(codes, p.value, owner));
    row.designations.forEach((p) => index(names, p.value, owner));
    if (isNumberedDesignation(row.name)) index(names, row.name, owner);
  }
  const attach = (
    row: ObjectEvidence,
    to: string,
    proof: string[],
    status: "confirmed" | "candidate" | "unresolved",
    previous = owners.get(row.sourceId),
  ) => {
    const m = meaning.get(row.sourceId)!;
    owners.set(row.sourceId, to);
    if (m.meaning !== "neutral_set") {
      m.meaning = "part";
      m.basis = "declared_component_host";
    }
    m.independent = false;
    m.membershipEvidence = proof;
    m.membershipStatus = status;
    if (m.objectRole) m.objectRole = { id: m.meaning, status, evidence: proof };
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const child of children.get(id) ?? []) {
        const cm = meaning.get(child.sourceId)!;
        if (
          owners.get(child.sourceId) !== previous ||
          !["part", "detail", "container", "source_only"].includes(cm.meaning)
        )
          continue;
        owners.set(child.sourceId, to);
        cm.membershipEvidence = proof;
        cm.membershipStatus = status;
        visit(child.sourceId);
      }
    };
    if (previous !== to) visit(row.sourceId);
  };
  return { key, codes, names, index, attach };
}
