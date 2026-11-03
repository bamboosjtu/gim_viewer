import type { EngineeringSnapshot } from '../../engineering/types.js';
import type { CompositionAssignment, CompositionGroup } from '../../engineering/composition.js';
import { assignEngineeringComposition, buildingPaths } from '../../engineering/compositionTemplate.js';
import type { SourceCompositionEvidence } from '../../gim/engineering/compositionContexts.js';

/** Projection heuristics, not engineering identity rules. Distances are metres.
 * v1 preserves the existing automatic refinement policy. */
export const SPATIAL_PROJECTION_POLICY = Object.freeze({
  version: 'composition-spatial-v1', maxExtent: 500, gridSize: 8,
  joinMargin: 0.6, voteMargin: 0.5, containmentMargin: 1,
  minMembers: 3, minArea: 12, minWidth: 2, minTop: 2,
  minVotes: 2, highVoltageKv: 66,
});
const policy = SPATIAL_PROJECTION_POLICY;

/** Absolute source Z-up metres; no scene visibility, mesh identity or F depth. */
export interface CompositionBounds {entityId:string;bounds:number[];evidence:string}
export interface CompositionSpatialDiagnostics {footprints:Array<{bounds:number[];members:number;names:string[];votes:Array<[string,number]>;chosen:string}>}
type Box=number[];
/** web-ifc/RegionalIndex bounds are absolute Y-up metres. The composition
 * projection consumes the source Z-up metre frame; keep this conversion in one
 * place so static and runtime evidence cannot drift. */
export function fromIfcYUpBounds(bounds: readonly number[]): number[] | undefined {
  if (bounds.length !== 6 || !bounds.every(Number.isFinite)) return undefined;
  const [minX, minY, minZ, maxX, maxY, maxZ] = bounds;
  return [minX, -maxZ, minY, maxX, -minZ, maxY];
}

export interface CompositionParityMismatch {
  entityId: string;
  sourceIds: string[];
  expectedPaths: string[];
  actualPaths: string[];
}

/** Aligns independent static/runtime projections by engineering entity and
 * reports path-level differences, retaining source IDs for offline evidence. */
export function compareCompositionAssignments(
  expected: readonly CompositionAssignment[],
  actual: readonly CompositionAssignment[],
  sourceIdsByEntity: ReadonlyMap<string, readonly string[]> = new Map(),
): { missing: string[]; extra: string[]; mismatches: CompositionParityMismatch[] } {
  const key = (rows: readonly CompositionAssignment[]) => new Map(rows.map(row => [row.entityId, row]));
  const left = key(expected), right = key(actual), missing: string[] = [], extra: string[] = [], mismatches: CompositionParityMismatch[] = [];
  for (const [entityId, row] of left) {
    const other = right.get(entityId);
    if (!other) { missing.push(entityId); continue; }
    const paths = (value: CompositionAssignment) => value.paths.map(path => path.map(group => `${group.kind}:${group.key}`).join('/')).sort();
    const expectedPaths = paths(row), actualPaths = paths(other);
    if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) mismatches.push({
      entityId, sourceIds: [...(sourceIdsByEntity.get(entityId) ?? [])], expectedPaths, actualPaths,
    });
  }
  for (const entityId of right.keys()) if (!left.has(entityId)) extra.push(entityId);
  return { missing, extra, mismatches };
}
const center=(b:Box)=>[(b[0]+b[3])/2,(b[1]+b[4])/2,(b[2]+b[5])/2];
const contains=(b:Box,p:number[],margin=0)=>p[0]>=b[0]-margin&&p[0]<=b[3]+margin&&p[1]>=b[1]-margin&&p[1]<=b[4]+margin;
const area=(b:Box)=>(b[3]-b[0])*(b[4]-b[1]);
const union=(a:Box,b:Box)=>a.map((n,i)=>i<3?Math.min(n,b[i]):Math.max(n,b[i]));
const valid=(b:Box)=>b.length===6&&b.every(Number.isFinite)&&b.slice(0,3).every((n,i)=>b[i+3]>=n)&&b[3]-b[0]<policy.maxExtent&&b[4]-b[1]<policy.maxExtent;
const civil:CompositionGroup={key:'civil',title:'建筑工程',kind:'discipline',order:0};

/** Spatial evidence refines business ownership only. Wholes, membership and
 * source identities are invariant. Ambiguous footprints remain unassigned. */
export function projectSpatialComposition(snapshot:EngineeringSnapshot,facts:readonly SourceCompositionEvidence[],bounds:readonly CompositionBounds[],diagnostics?:CompositionSpatialDiagnostics):CompositionAssignment[]{
  const base=assignEngineeringComposition(snapshot,facts),assignment=new Map(base.map(a=>[a.entityId,a]));
  const evidence=new Map(facts.map(f=>[f.entityId,f])),boxes=new Map<string,Box>(),boundsEvidence=new Map<string,string[]>();
  for(const row of bounds)if(valid(row.bounds)){
    boxes.set(row.entityId,boxes.has(row.entityId)?union(boxes.get(row.entityId)!,row.bounds):row.bounds.slice());
    const refs=boundsEvidence.get(row.entityId)??[];refs.push(row.evidence);boundsEvidence.set(row.entityId,refs);
  }
  const architecturalSeeds=new Set(['C-A1','C-A2','C-A3','C-A4','C-A5','C-A6']);
  const seeds=snapshot.entities.filter(e=>architecturalSeeds.has(e.category)&&boxes.has(e.id)&&
    (evidence.get(e.id)?.sourceHints??[]).some(p=>/建筑|配电.*楼|辅助用房|主控.*楼|警卫|门卫/.test(p))&&
    boxes.get(e.id)![5]>policy.minTop);
  const parents=seeds.map((_,i)=>i),find=(i:number):number=>parents[i]===i?i:parents[i]=find(parents[i]);
  // Spatial hash keeps large structural files from quadratic all-pairs scans.
  const cells=new Map<string,number[]>(),size=policy.gridSize,margin=policy.joinMargin;
  seeds.forEach((e,i)=>{const b=boxes.get(e.id)!,seen=new Set<number>();for(let x=Math.floor((b[0]-margin)/size);x<=Math.floor((b[3]+margin)/size);x++)for(let y=Math.floor((b[1]-margin)/size);y<=Math.floor((b[4]+margin)/size);y++){
    const key=`${x},${y}`,hits=cells.get(key)??[];for(const j of hits)if(!seen.has(j)){seen.add(j);const a=boxes.get(seeds[j].id)!;if(a[0]<=b[3]+margin&&a[3]>=b[0]-margin&&a[1]<=b[4]+margin&&a[4]>=b[1]-margin)parents[find(i)]=find(j);}hits.push(i);cells.set(key,hits);
  }});
  const components=new Map<number,{box:Box;ids:string[]}>();seeds.forEach((e,i)=>{const root=find(i),b=boxes.get(e.id)!,old=components.get(root);if(old){old.box=union(old.box,b);old.ids.push(e.id);}else components.set(root,{box:b.slice(),ids:[e.id]});});
  const footprints=[...components.values()].filter(c=>c.ids.length>=policy.minMembers&&area(c.box)>=policy.minArea&&Math.min(c.box[3]-c.box[0],c.box[4]-c.box[1])>=policy.minWidth);
  const buildings=footprints.map((c,index)=>{
    const names=new Map<string,CompositionGroup>();
    const contained=snapshot.entities.filter(e=>e.category.startsWith('C-A')&&boxes.has(e.id)&&contains(c.box,center(boxes.get(e.id)!)));
    for(const e of contained)for(const path of buildingPaths(evidence.get(e.id))) {const building=path.find(p=>p.kind==='building');if(building)names.set(building.key,building);}
    let name=names.size===1?[...names.values()][0]:undefined;const voteCounts:Array<[string,number]>=[];
    if(!name&&names.size===0){
      const votes=new Map<string,{group:CompositionGroup;count:number}>();
      for(const fact of facts){const paths=assignment.get(fact.entityId)?.paths??[],points=boxes.has(fact.entityId)?[center(boxes.get(fact.entityId)!)]:fact.positions??[];
        if(!points.length||!points.every(p=>contains(c.box,p,policy.voteMargin)))continue;
        const systems=new Map(paths.flatMap(p=>p.filter(g=>g.key.startsWith('distribution:'))).map(g=>[g.key,g]));
        if(systems.size===1){const group=[...systems.values()][0],vote=votes.get(group.key)??{group,count:0};vote.count++;votes.set(group.key,vote);}}
      const ranked=[...votes.values()].sort((a,b)=>b.count-a.count);
      voteCounts.push(...ranked.map(v=>[v.group.title,v.count] as [string,number]));
      // A delivery building can contain both GIS and 10kV switchgear. The
      // numerous small cabinets do not rename its higher-voltage GIS building.
      const high=ranked.filter(v=>Number(v.group.key.split(':')[1])>=policy.highVoltageKv&&v.count>=policy.minVotes),low=ranked.filter(v=>Number(v.group.key.split(':')[1])<policy.highVoltageKv);
      const chosen=high.length===1&&low.length+high.length===ranked.length?high[0]:ranked.length===1?ranked[0]:undefined;
      if(chosen&&chosen.count>=policy.minVotes){
        const title=`${chosen.group.title}楼`;name={key:`building:${title.toLowerCase()}`,title,kind:'building',order:0};
      }
    }
    // Anonymous physical building remains visible, without inventing a use.
    diagnostics?.footprints.push({bounds:c.box,members:c.ids.length,names:[...names.values()].map(n=>n.title),votes:voteCounts,chosen:name?.title??''});
    return {...c,name:name??{key:`building:spatial:${c.box.slice(0,2).map(n=>Math.round(n*10)).join(':')}`,title:`建筑物${index+1}（用途待确认）`,kind:'building' as const,order:0},ambiguous:names.size>1};
  });
  for(const e of snapshot.entities){
    if(!/^C-A|^C-B/.test(e.category)||!boxes.has(e.id))continue;
    const b=boxes.get(e.id)!,p=center(b),hits=buildings.filter(c=>!c.ambiguous&&contains(c.box,p,policy.joinMargin)&&b[0]>=c.box[0]-policy.containmentMargin&&b[3]<=c.box[3]+policy.containmentMargin&&b[1]>=c.box[1]-policy.containmentMargin&&b[4]<=c.box[4]+policy.containmentMargin);
    if(hits.length!==1)continue;
    const building=hits[0],old=assignment.get(e.id)!;
    // An explicit building path stays semantic, even when its footprint agrees.
    if(buildingPaths(evidence.get(e.id)).length)continue;
    const floors=(evidence.get(e.id)?.spaces??[]).flatMap(s=>s.storeys),unique=new Map(floors.map(f=>[f.evidenceId,f]));
    const floor=[...unique.values()];
    const path:CompositionGroup[]=[civil,building.name];
    if(floor.length===1)path.push({key:`floor:${floor[0].evidenceId}`,title:floor[0].value,kind:'storey',order:floor[0].elevationMetres});
    else path.push({key:'floor:unconfirmed',title:'楼层待确认',kind:'storey'});
    const refs=[...new Set([e.id,...building.ids.slice(0,3)].flatMap(id=>boundsEvidence.get(id)??[]))];
    assignment.set(e.id,{entityId:e.id,paths:[path],evidence:[...old.evidence,'spatial-building-footprint',policy.version,...refs],inferred:true});
  }
  return snapshot.entities.map(e=>assignment.get(e.id)!);
}
