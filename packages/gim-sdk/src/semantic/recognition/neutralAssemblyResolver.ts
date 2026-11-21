import type { SourceRecord } from "../../shared/sourceRecord.js";

/**
 * Identify complete neutral-point assemblies from raw DEV child types.
 *
 * This is a semantic decision (two direct typed witnesses are required); the
 * Adapter only supplies the records. Display names and indirect descendants do
 * not count.
 */
export function completeNeutralAssemblies(
  records: readonly SourceRecord[],
): Set<string> {
  const possible = new Set(
    records
      .filter((record) =>
        /^(?:CompleteSetOfArcSuppressionCoilAndGroundingTransformer|GroundTransformer\/ArcExtinguishingCoil)$/i.test(
          record.source_type,
        ),
      )
      .map((record) => record.id),
  );
  const parts = new Map<string, number>();
  if (!possible.size) return new Set();
  for (const record of records) {
    if (record.track !== "dev" || !possible.has(record.parent)) continue;
    const type = record.source_type.trim();
    const part = /^(?:GroundTransformer|接地变|接地变压器)$/i.test(type)
      ? 1
      : /^(?:ArcExtinguishingCoil|消弧线圈)$/i.test(type)
        ? 2
        : 0;
    parts.set(record.parent, (parts.get(record.parent) ?? 0) | part);
  }
  return new Set([...parts].filter(([, mask]) => mask === 3).map(([id]) => id));
}
