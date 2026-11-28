import type { HNumModFile, PRecord } from "@gim/gim-primitives/geometry/ir.js";
import { resolveTowerTopology } from "./towerTopology.js";

export interface SelectedTowerHeight {
  heightMm: number;
  subLegs?: readonly number[];
}
/** The caller supplies the confirmed height/sublegs. Preserve coordinates relative to the highest tower's base plane. */
export function selectTowerParts(
  source: HNumModFile,
  choice: SelectedTowerHeight,
) {
  const topology = resolveTowerTopology(source),
    matches = source.hRecords.filter((h) => h.height === choice.heightMm);
  const h = matches.length === 1 ? matches[0] : undefined,
    body = h ? source.bodySections.findIndex((b) => b.name === h.body) : -1;
  const missing: string[] = [];
  if (!h || body < 0)
    return {
      selectionKey: JSON.stringify([choice.heightMm, "unresolved"]),
      sections: topology,
      confirmed: false,
      missing: ["unresolved-height"],
    };
  const leg = h.leg ? Number(h.leg.slice(3)) : undefined;
  const selected = new Set<PRecord>(),
    subLegs = new Set(choice.subLegs);
  const scopes = source.bodySections[body].partStarts ?? [];
  if (
    leg !== undefined &&
    !scopes.some((s) => s.kind === "leg" && s.leg === leg)
  )
    missing.push("unresolved-leg");
  if (scopes.some((s) => s.kind === "subleg" && s.leg === leg) && !subLegs.size)
    missing.push("unspecified-subleg");
  for (const id of subLegs)
    if (!scopes.some((s) => s.leg === leg && s.subleg === id))
      missing.push("unresolved-subleg:" + id);
  for (let n = 0; n <= body; n++) {
    const b = source.bodySections[n],
      starts = b.partStarts ?? [{ kind: "body", point: 0 } as const];
    for (const [i, start] of starts.entries()) {
      const include =
        start.kind === "body" ||
        (n === body &&
          start.leg === leg &&
          (start.kind === "leg" ||
            (start.subleg !== undefined && subLegs.has(start.subleg))));
      if (include)
        for (
          let j = start.point;
          j < (starts[i + 1]?.point ?? b.points.length);
          j++
        )
          selected.add(b.points[j]);
    }
  }
  const confirmed = missing.length === 0;
  const sections = topology.map((s) => ({
    ...s,
    points: s.points.filter((p) => selected.has(p)),
    // A file-wide R block may physically follow the last SubLeg. Membership follows its resolved endpoints.
    rods: s.rods.filter((r) => {
      if (r.start && r.end) return selected.has(r.start) && selected.has(r.end);
      // A trailing reference block can describe any Body. With no resolved endpoint
      // its membership is indeterminate; retain the declaration for the skeleton diagnostic.
      if (!r.start && !r.end) {
        missing.push(`unresolved-rod:${s.sectionIndex}:${r.ordinal}`);
        return true;
      }
      return selected.has((r.start ?? r.end)!);
    }),
    // Section headers scope P nodes. Exporters may put the template G table after all rods.
    ports: s.ports,
  }));
  return {
    selectionKey: JSON.stringify([
      h.height,
      h.body,
      h.leg,
      [...subLegs].sort((a, b) => a - b),
    ]),
    sections,
    confirmed,
    missing,
  };
}
