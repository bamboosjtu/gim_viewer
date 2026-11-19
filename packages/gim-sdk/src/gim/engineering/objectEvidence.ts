import type { ObjectEvidence, EvidenceValue } from "../../engineering/types.js";
import type { EngineeringSourceGraph } from "./sourceGraph.js";
import {
  adaptSourceEvidence,
  type SourceRecord,
} from "../../engineering/recognizeSource.js";
import { collectSourceComposition } from "./sourceComposition.js";

/** Organizational labels are retained for audit, separately from object-owned
 * designations. The domain must never use them to establish identity or hosts. */
export function engineeringObjectEvidence(
  graph: EngineeringSourceGraph,
  records: readonly SourceRecord[],
): ObjectEvidence[] {
  const nodes = new Map(graph.cbmOccurrences.map((node) => [node.id, node])),
    docs = new Map(graph.documents.map((doc) => [doc.path, doc]));
  const cached = new Map<string, EvidenceValue[]>();
  function units(key: string): EvidenceValue[] {
    const old = cached.get(key);
    if (old) return old;
    const node = nodes.get(key);
    if (!node) return [];
    const values = [
      ...(node.parentId ? units(node.parentId) : []),
      ...(docs.get(node.documentPath)?.fields ?? [])
        .filter(
          (field) =>
            /^(?:SYSTEMNAME\d+|NAME|PARTNAME)$/i.test(field.keys[0]) &&
            /主变|变压器系统/.test(field.value),
        )
        .map((field) => ({
          value: field.value,
          evidenceId: `${node.documentPath}:${field.line}`,
        })),
    ];
    cached.set(key, values);
    return values;
  }
  const composition = collectSourceComposition(graph, records);
  const familyPending = new Set(
    (graph.familyAssignments ?? [])
      .filter(({ path }) => {
        const doc = docs.get(path);
        return !doc || !doc.attributeStatus;
      })
      .map(({ sourceId }) => sourceId),
  );
  const familyRefMissing = new Set(
    graph.references
      .filter(
        (ref) =>
          ref.status !== "resolved" &&
          /^(?:BASEFAM|FAMILYFILE)/i.test(ref.field),
      )
      .map((ref) => ref.owner),
  );
  const possibleNeutral = new Set(
    records
      .filter((r) =>
        /^(?:CompleteSetOfArcSuppressionCoilAndGroundingTransformer|GroundTransformer\/ArcExtinguishingCoil)$/i.test(
          r.source_type,
        ),
      )
      .map((r) => r.id),
  );
  const neutralParts = new Map<string, number>();
  if (possibleNeutral.size)
    for (const r of records) {
      if (r.track !== "dev" || !possibleNeutral.has(r.parent)) continue;
      const own = `${r.source_type} ${r.name}`;
      const part = /GroundTransformer|接地变/i.test(own)
        ? 1
        : /ArcExtinguishingCoil|消弧线圈/i.test(own)
          ? 2
          : 0;
      neutralParts.set(r.parent, (neutralParts.get(r.parent) ?? 0) | part);
    }
  return records.map((record) => {
    const complete =
      !familyPending.has(record.id) &&
      !record.sources.some((path) => familyRefMissing.has(path));
    const evidence = adaptSourceEvidence(record, {
        sourceTypesComplete: complete,
        completeNeutralAssembly: neutralParts.get(record.id) === 3,
      }),
      edges = composition.get(record.id);
    // When semantic and physical parents coexist, retain both as constraints.
    // Recovery reports disagreement; it must not silently replace either edge.
    const semanticHosts = record.parent
      ? (edges
          ?.filter(
            (edge) =>
              edge.kind === "semantic_composition" &&
              edge.status === "confirmed",
          )
          .flatMap((edge) =>
            edge.parentSourceIds.map((value) => ({
              value,
              evidenceId: edge.evidence.join("|"),
            })),
          ) ?? [])
      : [];
    return {
      ...evidence,
      composition: edges,
      declaredHostSourceIds: [
        ...(evidence.declaredHostSourceIds ?? []),
        ...semanticHosts,
      ],
      inheritedContextDesignations: record.context.flatMap(units),
    };
  });
}
