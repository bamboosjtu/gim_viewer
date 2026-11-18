import type { EngineeringSnapshot, SourceMembership } from "./types.js";

export interface SemanticTreeNode {
  member: SourceMembership;
  parentSourceId?: string;
  children: readonly string[];
}
export interface SemanticTree {
  roots: readonly string[];
  nodes: ReadonlyMap<string, SemanticTreeNode>;
  /** Invalid parent links omitted from the projection. */
  cyclicParentSourceIds?: readonly string[];
}

/** Read-only indexes over established facts. Queries never reinterpret evidence. */
export class EngineeringQuery {
  readonly entities: ReadonlyMap<
    string,
    EngineeringSnapshot["entities"][number]
  >;
  readonly pending: ReadonlyMap<string, EngineeringSnapshot["pending"][number]>;
  readonly memberships: ReadonlyMap<string, SourceMembership>;
  private readonly byOwner = new Map<string, SourceMembership[]>();
  private readonly trees = new Map<string, SemanticTree>();
  constructor(readonly snapshot: EngineeringSnapshot) {
    this.entities = new Map(
      snapshot.entities.map((entity) => [entity.id, entity]),
    );
    this.pending = new Map(snapshot.pending.map((item) => [item.id, item]));
    this.memberships = new Map(
      snapshot.memberships.map((member) => [member.sourceId, member]),
    );
    for (const member of snapshot.memberships)
      if (member.ownerId) {
        const rows = this.byOwner.get(member.ownerId) ?? [];
        rows.push(member);
        this.byOwner.set(member.ownerId, rows);
      }
  }
  members(ownerId: string): readonly SourceMembership[] {
    return this.byOwner.get(ownerId) ?? [];
  }
  tree(ownerId: string): SemanticTree {
    const previous = this.trees.get(ownerId);
    if (previous) return previous;
    const nodes = new Map<string, SemanticTreeNode & { children: string[] }>(),
      roots: string[] = [];
    for (const member of this.members(ownerId))
      nodes.set(member.sourceId, { member, children: [] });
    const checked = new Set<string>(),
      cut = new Set<string>();
    for (const sourceId of nodes.keys()) {
      const branch = new Set<string>();
      let cursor: string | undefined = sourceId;
      while (cursor && nodes.has(cursor) && !checked.has(cursor)) {
        if (branch.has(cursor)) {
          cut.add(cursor);
          break;
        }
        branch.add(cursor);
        cursor = nodes.get(cursor)?.member.parentPartId;
      }
      for (const id of branch) checked.add(id);
    }
    for (const [sourceId, node] of nodes) {
      const parent =
        !cut.has(sourceId) && node.member.parentPartId
          ? nodes.get(node.member.parentPartId)
          : undefined;
      if (parent) {
        node.parentSourceId = parent.member.sourceId;
        parent.children.push(sourceId);
      } else roots.push(sourceId);
    }
    const tree = {
      roots,
      nodes,
      ...(cut.size ? { cyclicParentSourceIds: [...cut] } : {}),
    };
    this.trees.set(ownerId, tree);
    return tree;
  }
}
const queries = new WeakMap<EngineeringSnapshot, EngineeringQuery>();
/** Snapshot identity includes the source revision; replacement builds new indexes. */
export function engineeringQuery(
  snapshot: EngineeringSnapshot,
): EngineeringQuery {
  let query = queries.get(snapshot);
  if (!query) {
    query = new EngineeringQuery(snapshot);
    queries.set(snapshot, query);
  }
  return query;
}
