import {
  categoryFromName,
  explicitMain,
  interpretRecognitionObject as interpretObject,
} from "../classify.js";
import type {
  CompositionEvidence,
  ObjectEvidence,
  ObjectInterpretation,
} from "../types.js";

/** Lossless package-local identity. No class version, tree parent or traversal counter. */
export function engineeringEntityId(
  scope: string,
  kind: string,
  seed: string,
): string {
  return `${kind}:${JSON.stringify([scope, seed])}`;
}

export function compareSourceIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isTransformerCategory(category: string | undefined): boolean {
  return !!category && ["E01", "E-T", "E03"].includes(category);
}

export function isReserved(row: ObjectEvidence): boolean {
  return row.designations.some((p) => /备用|预留/.test(p.value));
}

export function explicitIndependent(row: ObjectEvidence): boolean {
  return row.objectRoles?.some((p) => p.value === "independent") ?? false;
}

export function wholeName(row: ObjectEvidence, category: string): string {
  const number = explicitMain(row);
  if (category === "E01" && number)
    return `${number}号${isReserved(row) ? "备用" : ""}主变`;
  return (
    row.identityNames.find((p) => {
      const c = categoryFromName(p.value);
      return (
        c === category || (category.startsWith("E16") && c.startsWith("E16"))
      );
    })?.value ?? row.name
  );
}

export interface PreparedEvidence {
  disputedComposition: Map<string, NonNullable<ObjectEvidence["composition"]>>;
  conflictingComposition: Map<string, readonly CompositionEvidence[]>;
  ordered: ObjectEvidence[];
  raw: Map<string, ObjectEvidence>;
  parents: Set<string | undefined>;
  meaning: Map<string, ObjectInterpretation>;
}

/**
 * Normalize source composition edges and interpret each row once before
 * identity/boundary/ownership work starts. All later phases share these
 * immutable maps instead of re-reading composition evidence.
 */
export function prepareEvidence(
  input: readonly ObjectEvidence[],
): PreparedEvidence {
  const disputedComposition = new Map<
    string,
    NonNullable<ObjectEvidence["composition"]>
  >();
  const conflictingComposition = new Map<
    string,
    readonly CompositionEvidence[]
  >();
  const ordered = input
    .map((row) => {
      if (!row.composition?.length) return row;
      let uncertain: CompositionEvidence[] | undefined;
      let parent: string | undefined;
      let multipleParents = false;
      const physicalParent = row.assemblyParentId;
      let physicalEdge: CompositionEvidence | undefined;
      let decompositionParent = false;
      let contrarySemanticParent = false;
      for (const edge of row.composition) {
        if (physicalParent && edge.status === "confirmed") {
          if (
            edge.kind === "physical_assembly" &&
            edge.parentSourceIds.includes(physicalParent)
          )
            physicalEdge = edge;
          if (
            edge.kind === "object_decomposition" &&
            edge.parentSourceIds.includes(physicalParent)
          )
            decompositionParent = true;
          if (
            edge.kind === "semantic_composition" &&
            edge.parentSourceIds.some((id) => id !== physicalParent)
          )
            contrarySemanticParent = true;
        }
        if (edge.kind !== "semantic_composition") continue;
        if (edge.status !== "confirmed") {
          (uncertain ??= []).push(edge);
        } else if (!row.assemblyParentId && !multipleParents) {
          for (const id of edge.parentSourceIds) {
            if (parent !== undefined && parent !== id) {
              multipleParents = true;
              break;
            }
            parent = id;
          }
        }
      }
      if (
        physicalParent &&
        contrarySemanticParent &&
        (physicalEdge || !decompositionParent)
      ) {
        const edges = row.composition.filter(
          (edge) => edge.kind !== "object_decomposition",
        );
        if (!physicalEdge)
          edges.unshift({
            kind: "physical_assembly",
            status: "confirmed",
            parentSourceIds: [physicalParent],
            evidence: [`assembly:${physicalParent}->${row.sourceId}`],
          });
        conflictingComposition.set(row.sourceId, edges);
        disputedComposition.set(row.sourceId, edges);
        return row;
      }
      if (multipleParents)
        disputedComposition.set(
          row.sourceId,
          row.composition.filter(
            (edge) => edge.kind === "semantic_composition",
          ),
        );
      else if (uncertain) disputedComposition.set(row.sourceId, uncertain);
      if (
        row.assemblyParentId ||
        multipleParents ||
        uncertain ||
        parent === undefined
      )
        return row;
      return { ...row, assemblyParentId: parent };
    })
    .sort((a, b) => compareSourceIds(a.sourceId, b.sourceId));
  const raw = new Map(ordered.map((row) => [row.sourceId, row]));
  if (raw.size !== input.length || raw.has(""))
    throw new Error("Source occurrence IDs must be unique and nonempty");
  // Validate the whole graph before grouping. Preassigned set members must not
  // hide cycles that recursive ownership lookup would otherwise skip.
  const checked = new Set<string>();
  for (const row of ordered) {
    const branch = new Set<string>();
    let cursor: string | undefined = row.sourceId;
    while (cursor && raw.has(cursor) && !checked.has(cursor)) {
      if (branch.has(cursor))
        throw new Error(`Source assembly cycle: ${cursor}`);
      branch.add(cursor);
      cursor = raw.get(cursor)!.assemblyParentId;
    }
    branch.forEach((id) => checked.add(id));
  }
  const parents = new Set(
    ordered
      .filter((row) => !row.traits.nonphysical)
      .map((row) => row.assemblyParentId)
      .filter(Boolean),
  );
  const meaning = new Map(
    ordered.map((row) => [
      row.sourceId,
      interpretObject(row, parents.has(row.sourceId)),
    ]),
  );
  return {
    disputedComposition,
    conflictingComposition,
    ordered,
    raw,
    parents,
    meaning,
  };
}
