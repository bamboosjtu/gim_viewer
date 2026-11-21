import type { ObjectEvidence, EvidenceValue } from "../semantic/types.js";
import type { EngineeringSourceGraph } from "../source/sourceGraph.js";
import { adaptSourceEvidence, type SourceRecord } from "./recognizeSource.js";
import { collectSourceComposition } from "../source/sourceComposition.js";
import { completeNeutralAssemblies } from "../semantic/recognition/neutralAssemblyResolver.js";

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
  const neutralAssemblies = completeNeutralAssemblies(records);
  return records.map((record) => {
    const complete =
      !familyPending.has(record.id) &&
      !record.sources.some((path) => familyRefMissing.has(path));
    const evidence = adaptSourceEvidence(record, {
        sourceTypesComplete: complete,
        completeNeutralAssembly: neutralAssemblies.has(record.id),
      }),
      edges = composition.get(record.id);
    return {
      ...evidence,
      composition: edges,
      inheritedContextDesignations: record.context.flatMap(units),
    };
  });
}
