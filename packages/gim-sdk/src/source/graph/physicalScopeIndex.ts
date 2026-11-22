import type { SourceRecord } from "../sourceEvidence.js";

export interface PhysicalScope {
  records: SourceRecord[];
  rootIds: Set<string>;
  bySource?: Map<string, SourceRecord[]>;
}

/** Scope lookups are built only when a CBM occurrence asks to match a DEV. */
export class PhysicalScopeIndex {
  private readonly childScopes = new WeakMap<
    PhysicalScope,
    Map<string, PhysicalScope>
  >();

  root(records: SourceRecord[]): PhysicalScope {
    return {
      records,
      rootIds: new Set(records.slice(0, 1).map((row) => row.id)),
    };
  }

  matchingDescendants(scope: PhysicalScope, path: string): SourceRecord[] {
    if (!scope.bySource) {
      scope.bySource = new Map();
      for (const row of scope.records) {
        const rows = scope.bySource.get(row.source) ?? [];
        rows.push(row);
        scope.bySource.set(row.source, rows);
      }
    }
    return (scope.bySource.get(path) ?? []).filter(
      (row) => !scope.rootIds.has(row.id),
    );
  }

  /** Later aliases see only the matched part subtrees within this scope. */
  child(
    nearest: PhysicalScope,
    target: string,
    candidates: readonly SourceRecord[],
  ): PhysicalScope {
    let children = this.childScopes.get(nearest);
    if (!children) {
      children = new Map();
      this.childScopes.set(nearest, children);
    }
    let child = children.get(target);
    if (!child) {
      const ids = new Set(candidates.map((row) => row.id));
      const prefixes = candidates.map((row) => `${row.id}/`);
      const subtree = nearest.records.filter(
        (row) =>
          ids.has(row.id) ||
          prefixes.some((prefix) => row.id.startsWith(prefix)),
      );
      child = { records: subtree, rootIds: ids };
      children.set(target, child);
    }
    return child;
  }
}
