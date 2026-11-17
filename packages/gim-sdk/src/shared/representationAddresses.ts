export type SourceRepresentation =
  | { kind: 'dev'; sourceId: string; rootOccurrence: string; assemblyPath: string; devPath: string }
  | { kind: 'ifc'; sourceId: string; modelId: string; expressId: number; globalId: string; nonphysical?: boolean };
export interface DevRepresentationHint { assemblyPath?: string; devPath?: string }
const canonical = (value: string) => value.replace(/\\/g, '/').toLowerCase();
function append(map: Map<string, string[]>, key: string, sourceId: string): void {
  const ids = map.get(key) ?? []; ids.push(sourceId); map.set(key, ids);
}

/** Pure source/representation address index; usable before semantic recognition. */
export class RepresentationAddressIndex {
  readonly bySource=new Map<string,SourceRepresentation[]>();
  readonly devRoots=new Map<string,Array<Extract<SourceRepresentation,{kind:'dev'}>>>();
  readonly ifcObjects=new Map<string,string[]>();
  private readonly devAssembly=new Map<string,Map<string,string[]>>();
  private readonly devFiles=new Map<string,Map<string,string[]>>();
  constructor(bindings:readonly SourceRepresentation[]) {
    for (const binding of bindings) {
      const addresses=this.bySource.get(binding.sourceId)??[];
      addresses.push(binding);this.bySource.set(binding.sourceId,addresses);
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
  sourcesForIfc(modelId:string,expressId:number):string[] {
    return this.ifcObjects.get(JSON.stringify([modelId,expressId]))??[];
  }
  sourcesForDev(rootOccurrence: string, hint: DevRepresentationHint = {}): string[] {
    if (hint.assemblyPath !== undefined) {
      const paths = this.devAssembly.get(rootOccurrence);
      let path = hint.assemblyPath;
      // Mesh hints may include PHM/MOD suffixes. Walk actual path segments to
      // the nearest DEV occurrence; never scan every sibling for every mesh.
      while (paths) {
        const ids = paths.get(path); if (ids) return ids;
        if (!path) break;
        const slash = path.lastIndexOf('/'); path = slash < 0 ? '' : path.slice(0, slash);
      }
      return [];
    } else if (hint.devPath) {
      const ids = this.devFiles.get(rootOccurrence)?.get(canonical(hint.devPath));
      if (ids) return ids;
    }
    return (this.devRoots.get(rootOccurrence) ?? []).map(row => row.sourceId);
  }

  rootsForSources(sourceIds:ReadonlySet<string>):Set<string> {
    const roots=new Set<string>();
    for(const id of sourceIds)for(const address of this.bySource.get(id)??[])if(address.kind==='dev')roots.add(address.rootOccurrence);
    return roots;
  }
}
