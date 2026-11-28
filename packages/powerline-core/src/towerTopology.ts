import type { HNumModFile, PRecord } from "@gim/gim-primitives/geometry/ir.js";

function indexPoints(points: Iterable<PRecord>) {
  const byId = new Map<number, PRecord | undefined>();
  for (const point of points)
    byId.set(point.id, byId.has(point.id) ? undefined : point);
  return byId;
}

/** Trailing R blocks may reference unique IDs file-wide. Once IDs repeat, endpoints must resolve in the declaring Body. */
export function resolveTowerTopology(source: HNumModFile) {
  const global = indexPoints(source.bodySections.flatMap((b) => b.points));
  let fileScope = true;
  for (const value of global.values())
    if (!value) {
      fileScope = false;
      break;
    }
  return source.bodySections.map((body, sectionIndex) => {
    const points = fileScope ? global : indexPoints(body.points);
    return {
      name: body.name,
      sectionIndex,
      points: body.points,
      ports: body.groundPoints,
      rods: body.rods.map((record, ordinal) => ({
        ordinal,
        record,
        start: record.id1 == null ? undefined : points.get(record.id1),
        end: record.id2 == null ? undefined : points.get(record.id2),
      })),
    };
  });
}
