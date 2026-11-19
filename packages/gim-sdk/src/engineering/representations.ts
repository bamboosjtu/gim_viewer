import type { EngineeringSnapshot } from "../semantic/types.js";
import {
  RepresentationAddressIndex,
  type SourceRepresentation,
  type DevRepresentationHint,
} from "../geometry/representationAddresses.js";
export type {
  SourceRepresentation,
  DevRepresentationHint,
} from "../geometry/representationAddresses.js";

export interface RepresentationResolution {
  status: "bound" | "ambiguous" | "unassociated";
  sourceIds: string[];
  ownerIds: string[];
  pendingIds?: string[];
  unknownSourceIds?: string[];
}

export interface RepresentationEvidenceState {
  sourceUsage: "physical" | "attributes_only" | "unknown";
  availability:
    | "not_requested"
    | "available"
    | "partial"
    | "empty"
    | "unsupported"
    | "failed";
  bindingStatus: RepresentationResolution["status"];
}

/** Reserved for consumers reporting evidence about one representation. */
export function representationEvidenceState(
  sourceUsage: RepresentationEvidenceState["sourceUsage"],
  availability: RepresentationEvidenceState["availability"],
  binding: RepresentationResolution,
): RepresentationEvidenceState {
  return { sourceUsage, availability, bindingStatus: binding.status };
}
/** Semantic membership joins an independently usable geometry address index. */
export class EngineeringRepresentationIndex extends RepresentationAddressIndex {
  readonly ownerBySource = new Map<string, string | null>();
  private readonly sourcesByOwner = new Map<string, string[]>();
  private readonly pendingBySource = new Map<string, string>();
  constructor(
    readonly snapshot: EngineeringSnapshot,
    bindings: readonly SourceRepresentation[],
  ) {
    super(bindings);
    const entities = new Set(snapshot.entities.map((entity) => entity.id));
    const pending = new Set(snapshot.pending.map((group) => group.id));
    for (const member of snapshot.memberships) {
      const owner =
        member.ownerId && entities.has(member.ownerId) ? member.ownerId : null;
      this.ownerBySource.set(member.sourceId, owner);
      if (member.ownerId && pending.has(member.ownerId))
        this.pendingBySource.set(member.sourceId, member.ownerId);
      const selectable = owner ?? this.pendingBySource.get(member.sourceId);
      if (selectable) {
        const ids = this.sourcesByOwner.get(selectable) ?? [];
        ids.push(member.sourceId);
        this.sourcesByOwner.set(selectable, ids);
      }
    }
  }
  resolveSources(sourceIds: readonly string[]): RepresentationResolution {
    const ids = [...new Set(sourceIds)].sort();
    const owners = [
      ...new Set(
        ids
          .map((id) => this.ownerBySource.get(id))
          .filter((id): id is string => !!id),
      ),
    ].sort();
    const incomplete = ids.some((id) => !this.ownerBySource.get(id));
    const pendingIds = [
      ...new Set(ids.flatMap((id) => this.pendingBySource.get(id) ?? [])),
    ].sort();
    const unknownSourceIds = ids.filter((id) => !this.ownerBySource.has(id));
    return {
      status:
        owners.length === 1 && !incomplete
          ? "bound"
          : owners.length
            ? "ambiguous"
            : "unassociated",
      sourceIds: ids,
      ownerIds: owners,
      ...(pendingIds.length ? { pendingIds } : {}),
      ...(unknownSourceIds.length ? { unknownSourceIds } : {}),
    };
  }
  resolveIfc(modelId: string, expressId: number): RepresentationResolution {
    return this.resolveSources(this.sourcesForIfc(modelId, expressId));
  }
  resolveDev(
    rootOccurrence: string,
    hint: DevRepresentationHint = {},
  ): RepresentationResolution {
    return this.resolveSources(this.sourcesForDev(rootOccurrence, hint));
  }
  sourcesForOwners(ownerIds: ReadonlySet<string>): Set<string> {
    const result = new Set<string>();
    for (const owner of ownerIds)
      for (const source of this.sourcesByOwner.get(owner) ?? [])
        result.add(source);
    return result;
  }
  /** A coarse mixed-owner representation cannot be claimed by either owner. */
  includesDev(
    rootOccurrence: string,
    hint: DevRepresentationHint,
    selectedSources: ReadonlySet<string>,
  ): boolean {
    const sourceIds = this.sourcesForDev(rootOccurrence, hint);
    return (
      sourceIds.length > 0 &&
      sourceIds.every(
        (id) => this.ownerBySource.has(id) && selectedSources.has(id),
      )
    );
  }
}
