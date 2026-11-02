import type { EngineeringSnapshot } from './types.js';

export type SourceRepresentation =
  | { kind: 'dev'; sourceId: string; rootOccurrence: string; assemblyPath: string; devPath: string }
  | { kind: 'ifc'; sourceId: string; modelId: string; expressId: number; globalId: string; nonphysical?: boolean };
export interface RepresentationResolution {
  status: 'bound' | 'ambiguous' | 'unassociated';
  sourceIds: string[];
  ownerIds: string[];
}
export interface DevRepresentationHint { assemblyPath?: string; devPath?: string }
const canonical = (value: string) => value.replace(/\\/g, '/').toLowerCase();
function append(map: Map<string, string[]>, key: string, sourceId: string): void {
  const ids = map.get(key) ?? []; ids.push(sourceId); map.set(key, ids);
}

/** Only joins identities and source membership. It never creates a mesh, chooses
 * LOD, infers physical ownership from proximity or determines entity grain.
 */
export class EngineeringRepresentationIndex {
  readonly ownerBySource = new Map<string, string | null>();
  readonly sourcesByOwner = new Map<string, string[]>();
  readonly bySource = new Map<string, SourceRepresentation>();
  readonly devRoots = new Map<string, Array<Extract<SourceRepresentation, { kind: 'dev' }>>>();
  readonly ifcObjects = new Map<string, string[]>();
  private readonly devAssembly = new Map<string, Map<string, string[]>>();
  private readonly devFiles = new Map<string, Map<string, string[]>>();
  constructor(readonly snapshot: EngineeringSnapshot, bindings: readonly SourceRepresentation[]) {
    for (const member of snapshot.memberships) {
      this.ownerBySource.set(member.sourceId, member.ownerId);
      if (member.ownerId) {
        const ids = this.sourcesByOwner.get(member.ownerId) ?? [];
        ids.push(member.sourceId); this.sourcesByOwner.set(member.ownerId, ids);
      }
    }
    for (const binding of bindings) {
      if (!this.ownerBySource.has(binding.sourceId) || this.bySource.has(binding.sourceId)) throw Error('Invalid source representation binding');
      this.bySource.set(binding.sourceId, binding);
      if (binding.kind === 'dev') {
        const rows = this.devRoots.get(binding.rootOccurrence) ?? [];
        rows.push(binding); this.devRoots.set(binding.rootOccurrence, rows);
        const paths = this.devAssembly.get(binding.rootOccurrence) ?? new Map<string, string[]>();
        append(paths, binding.assemblyPath, binding.sourceId); this.devAssembly.set(binding.rootOccurrence, paths);
        const files = this.devFiles.get(binding.rootOccurrence) ?? new Map<string, string[]>();
        append(files, canonical(binding.devPath), binding.sourceId); this.devFiles.set(binding.rootOccurrence, files);
      } else {
        const key = JSON.stringify([binding.modelId, binding.expressId]);
        const rows = this.ifcObjects.get(key) ?? [];
        rows.push(binding.sourceId); this.ifcObjects.set(key, rows);
      }
    }
  }
  resolveSources(sourceIds: readonly string[]): RepresentationResolution {
    const ids = [...new Set(sourceIds)].sort();
    const owners = [...new Set(ids.map(id => this.ownerBySource.get(id)).filter((id): id is string => !!id))].sort();
    return { status: owners.length === 1 ? 'bound' : owners.length > 1 ? 'ambiguous' : 'unassociated', sourceIds: ids, ownerIds: owners };
  }
  resolveIfc(modelId: string, expressId: number): RepresentationResolution {
    return this.resolveSources(this.ifcObjects.get(JSON.stringify([modelId, expressId])) ?? []);
  }
  resolveDev(rootOccurrence: string, hint: DevRepresentationHint = {}): RepresentationResolution {
    if (hint.assemblyPath !== undefined) {
      const paths = this.devAssembly.get(rootOccurrence);
      let path = hint.assemblyPath;
      // Mesh hints may include PHM/MOD suffixes. Walk actual path segments to
      // the nearest DEV occurrence; never scan every sibling for every mesh.
      while (paths) {
        const ids = paths.get(path); if (ids) return this.resolveSources(ids);
        if (!path) break;
        const slash = path.lastIndexOf('/'); path = slash < 0 ? '' : path.slice(0, slash);
      }
      return this.resolveSources([]);
    } else if (hint.devPath) {
      const ids = this.devFiles.get(rootOccurrence)?.get(canonical(hint.devPath));
      if (ids) return this.resolveSources(ids);
    }
    return this.resolveSources((this.devRoots.get(rootOccurrence) ?? []).map(row => row.sourceId));
  }
  sourcesForOwners(ownerIds: ReadonlySet<string>): Set<string> {
    const result = new Set<string>();
    for (const owner of ownerIds) for (const source of this.sourcesByOwner.get(owner) ?? []) result.add(source);
    return result;
  }
  rootsForSources(sourceIds: ReadonlySet<string>): Set<string> {
    const roots = new Set<string>();
    for (const id of sourceIds) { const address = this.bySource.get(id); if (address?.kind === 'dev') roots.add(address.rootOccurrence); }
    return roots;
  }
  /** A coarse mixed-owner representation cannot be claimed by either owner. */
  includesDev(rootOccurrence: string, hint: DevRepresentationHint, selectedSources: ReadonlySet<string>): boolean {
    const resolved = this.resolveDev(rootOccurrence, hint);
    return resolved.sourceIds.length > 0 && resolved.sourceIds.every(id => selectedSources.has(id));
  }
}
