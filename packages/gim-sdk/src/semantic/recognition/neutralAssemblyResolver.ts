import type { SourceTypeObservation } from "./sourceFormatFacts.js";

/** Complete assemblies require both declared types as direct physical members. */
export function completeNeutralAssemblies(
  observations: readonly SourceTypeObservation[],
): Set<string> {
  const possible = new Set<string>();
  for (const { sourceId, declaredType } of observations) {
    if (
      /^(?:CompleteSetOfArcSuppressionCoilAndGroundingTransformer|GroundTransformer\/ArcExtinguishingCoil)$/i.test(
        declaredType,
      )
    )
      possible.add(sourceId);
  }
  if (!possible.size) return possible;
  const parts = new Map<string, number>();
  for (const { declaredType, physicalParentId } of observations) {
    if (!physicalParentId || !possible.has(physicalParentId)) continue;
    const type = declaredType.trim();
    const part = /^(?:GroundTransformer|接地变|接地变压器)$/i.test(type)
      ? 1
      : /^(?:ArcExtinguishingCoil|消弧线圈)$/i.test(type)
        ? 2
        : 0;
    if (part)
      parts.set(physicalParentId, (parts.get(physicalParentId) ?? 0) | part);
  }
  return new Set([...parts].filter(([, mask]) => mask === 3).map(([id]) => id));
}
