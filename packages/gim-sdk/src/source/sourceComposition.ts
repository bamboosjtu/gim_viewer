import type { CompositionEvidence } from "../shared/contracts.js";
import type { CbmOccurrence, EngineeringSourceGraph } from "./sourceGraph.js";
import type { SourceRecord } from "./sourceEvidence.js";

/** Format interpretation stops at this adapter; F levels do not participate. */
export function cbmRelationKind(
  field: string,
): "organization" | "composition" | undefined {
  if (/^SUBDEVICE\d+$/i.test(field)) return "composition";
  if (/^SUBSYSTEM\d*$/i.test(field)) return "organization";
  return undefined;
}

/** Indexed by occurrence, never by template, name or navigation depth. No IO. */
export function collectSourceComposition(
  graph: EngineeringSourceGraph,
  records: readonly SourceRecord[],
): Map<string, CompositionEvidence[]> {
  const result = new Map<string, CompositionEvidence[]>();
  const byCbm = new Map<string, Set<string>>();
  const add = (cbm: string, source: string) => {
    const existing = byCbm.get(cbm);
    if (existing) existing.add(source);
    else byCbm.set(cbm, new Set([source]));
  };
  for (const row of records) {
    if (row.parent)
      result.set(row.id, [
        {
          kind:
            row.track === "dev" ? "physical_assembly" : "object_decomposition",
          parentSourceIds: [row.parent],
          evidence: [`assembly:${row.parent}->${row.id}`],
          status: "confirmed",
        },
      ]);
    if (row.attributeContextId) add(row.attributeContextId, row.id);
    if (row.devOccurrence && !row.parent)
      add(row.devOccurrence.cbmOccurrenceId, row.id);
  }
  for (const alias of graph.aliases)
    for (const candidate of alias.candidates) add(alias.sourceId, candidate);
  const nodes = new Map(graph.cbmOccurrences.map((node) => [node.id, node]));
  const parentCache = new Map<string, ReadonlySet<string>>();
  const emptyParents: ReadonlySet<string> = new Set();
  function parents(
    node: CbmOccurrence,
    branch = new Set<string>(),
  ): ReadonlySet<string> {
    const cached = parentCache.get(node.id);
    if (cached) return cached;
    if (branch.has(node.id)) return emptyParents;
    branch.add(node.id);
    const direct = byCbm.get(node.id);
    const ancestor = node.parentId ? nodes.get(node.parentId) : undefined;
    const ids =
      direct ??
      (cbmRelationKind(node.viaField) === "composition" && ancestor
        ? parents(ancestor, branch)
        : emptyParents);
    parentCache.set(node.id, ids);
    return ids;
  }
  for (const node of graph.cbmOccurrences) {
    if (cbmRelationKind(node.viaField) !== "composition" || !node.parentId)
      continue;
    const children = byCbm.get(node.id);
    if (!children?.size) continue;
    const ancestor = nodes.get(node.parentId);
    const candidates = ancestor ? parents(ancestor) : emptyParents;
    const candidateIds = [...candidates];
    const evidence = [
      JSON.stringify([
        node.documentPath,
        node.viaField,
        node.parentId,
        node.id,
      ]),
    ];
    for (const sourceId of children) {
      // A semantic alias can point at the same physical occurrence as its parent.
      const ids = candidates.has(sourceId)
        ? candidateIds.filter((id) => id !== sourceId)
        : candidateIds;
      if (candidates.size && !ids.length) continue;
      const links = result.get(sourceId) ?? [];
      links.push({
        kind: "semantic_composition",
        parentSourceIds: ids,
        evidence,
        status:
          ids.length === 0
            ? "unresolved"
            : ids.length === 1 && children.size === 1
              ? "confirmed"
              : "ambiguous",
      });
      result.set(sourceId, links);
    }
  }
  return result;
}
