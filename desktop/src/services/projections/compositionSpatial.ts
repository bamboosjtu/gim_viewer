import type { EngineeringSnapshot } from '../../engineering/types.js';
import type { CompositionAssignment, CompositionGroup, CompositionDeclaration } from '../../engineering/composition.js';
import { assignEngineeringComposition, buildingPaths, canonicalBuildingName, isRoomBuildingName, supportTitle } from '../../engineering/compositionTemplate.js';
import type { SourceCompositionEvidence } from '../../gim/engineering/compositionContexts.js';

/** Projection heuristics, not engineering identity rules. Distances are metres.
 * The projection never changes engineering whole/source identity. */
export const SPATIAL_PROJECTION_POLICY = Object.freeze({
  version: 'composition-spatial-v4', maxExtent: 500, gridSize: 8,
  joinMargin: 0.6, voteMargin: 0.5, containmentMargin: 1,
  minMembers: 3, minArea: 12, minWidth: 2, minTop: 2,
  minVotes: 2, highVoltageKv: 66,
  areaDistance: 12, areaSeparation: 2,
});
const policy = SPATIAL_PROJECTION_POLICY;

/** Absolute source Z-up metres; no scene visibility, mesh identity or F depth. */
export interface CompositionBounds {entityId:string;bounds:number[];}
export interface CompositionSpatialDiagnostics {
  footprints:Array<{bounds:number[];members:number;names:string[];votes:Array<[string,number]>;chosen:string}>;
  firewallStacks?:Array<{bounds:number[];members:number;}>;
}
type Box=number[];
/** web-ifc/RegionalIndex bounds are absolute Y-up metres. The composition
 * projection consumes the source Z-up metre frame; keep this conversion in one
 * place so static and runtime evidence cannot drift. */
export function fromIfcYUpBounds(bounds: readonly number[]): number[] | undefined {
  if (bounds.length !== 6 || !bounds.every(Number.isFinite)) return undefined;
  const [minX, minY, minZ, maxX, maxY, maxZ] = bounds;
  return [minX, -maxZ, minY, maxX, -minZ, maxY];
}

const center=(b:Box)=>[(b[0]+b[3])/2,(b[1]+b[4])/2,(b[2]+b[5])/2];
const contains=(b:Box,p:number[],margin=0)=>p[0]>=b[0]-margin&&p[0]<=b[3]+margin&&p[1]>=b[1]-margin&&p[1]<=b[4]+margin;
const area=(b:Box)=>(b[3]-b[0])*(b[4]-b[1]);
const union=(a:Box,b:Box)=>a.map((n,i)=>i<3?Math.min(n,b[i]):Math.max(n,b[i]));
const valid=(b:Box)=>b.length===6&&b.every(Number.isFinite)&&b.slice(0,3).every((n,i)=>b[i+3]>=n)&&b[3]-b[0]<policy.maxExtent&&b[4]-b[1]<policy.maxExtent;
const civil:CompositionGroup={key:'civil',title:'建筑工程',kind:'discipline',order:0};

/** Spatial evidence refines business ownership only. Wholes, membership and
 * source identities are invariant. Ambiguous footprints remain unassigned. */
export function projectSpatialComposition(snapshot:EngineeringSnapshot,facts:readonly SourceCompositionEvidence[],bounds:readonly CompositionBounds[],diagnostics?:CompositionSpatialDiagnostics,declarations:readonly CompositionDeclaration[]=[]):CompositionAssignment[]{
  const base=assignEngineeringComposition(snapshot,facts),assignment=new Map(base.map(a=>[a.entityId,a]));
  const evidence=new Map(facts.map(f=>[f.entityId,f])),boxes=new Map<string,Box>();
  for(const row of bounds)if(valid(row.bounds)){
    boxes.set(row.entityId,boxes.has(row.entityId)?union(boxes.get(row.entityId)!,row.bounds):row.bounds.slice());
  }
  // A mixed "main foundation and fire wall" delivery file is not a wall
  // declaration for every product. A thin, long wall repeated at the same XY
  // footprint across contiguous elevations is a source-backed wall stack.
  const wallStacks=new Map<string,Array<{id:string;box:Box;file:string}>>();
  for(const entity of snapshot.entities){
    if(entity.category!=='C-A1')continue;
    const box=boxes.get(entity.id);
    if(!box)continue;
    const width=Math.min(box[3]-box[0],box[4]-box[1]),length=Math.max(box[3]-box[0],box[4]-box[1]);
    if(width>0.35||length<6||box[5]-box[2]<0.5)continue;
    for(const file of evidence.get(entity.id)?.sourceHints??[]){
      if(!/主变.*基础.*防火墙/.test(file))continue;
      const key=JSON.stringify([file,...[box[0],box[1],box[3],box[4]].map(n=>Math.round(n*4))]);
      const group=wallStacks.get(key)??[];group.push({id:entity.id,box,file});wallStacks.set(key,group);
    }
  }
  const firewallMembers=new Map<string,string[]>();
  for(const group of wallStacks.values()){
    if(group.length<3)continue;
    const ordered=[...group].sort((a,b)=>a.box[2]-b.box[2]);
    if(ordered[ordered.length-1].box[5]-ordered[0].box[2]<4)continue;
    if(ordered.slice(1).some((row,i)=>row.box[2]>ordered[i].box[5]+0.08))continue;
    const ids=ordered.map(row=>row.id);
    ids.forEach(id=>firewallMembers.set(id,ids));
    diagnostics?.firewallStacks?.push({bounds:ordered.map(row=>row.box).reduce(union),members:ids.length});
  }
  const anchors = snapshot.entities.flatMap(e => {
    if (!e.category.startsWith('E')) return [];
    const groups = new Map((assignment.get(e.id)?.paths ?? []).flatMap(path => path.filter(g => g.kind === 'system' && (g.key === 'main' || g.key.startsWith('distribution:')))).map(g => [g.key,g]));
    if (groups.size !== 1) return [];
    const points = boxes.has(e.id) ? [center(boxes.get(e.id)!)] : evidence.get(e.id)?.positions ?? [];
    return points.filter(p => p.length === 3 && p.every(Number.isFinite)).map(point => ({point, group:[...groups.values()][0], id:e.id}));
  });
  const areaPath = (entity:EngineeringSnapshot['entities'][number], group:CompositionGroup):CompositionGroup[] => {
    const foundation = ['C-B2','C-B3','C-B4'].includes(entity.category) || /基础|杯口|承台|垫层/.test(entity.name) && !/支架|构架/.test(entity.name);
    const firewall = !foundation && (firewallMembers.has(entity.id)||evidence.get(entity.id)?.deliveryStructureNames?.some(n=>n.value==='防火墙')
      || entity.category==='C-A1' && /防火墙|防火.*墙|墙.*防火/.test(entity.name));
    const title = firewall ? '防火墙' : foundation ? '基础' : supportTitle(entity, entity.category);
    return [civil,{key:`area:${group.key}`,title:group.key==='main'?'主变区域':`${group.title}区域`,kind:'area',order:20},
      {key:`area:${group.key}:${firewall?'firewall':foundation?'foundation':title}`,title,kind:'structure',order:firewall?30:foundation?20:10}];
  };
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
    let declaredName=false,fallbackName:CompositionGroup|undefined;
    if(!name&&names.size===0){
      const votes=new Map<string,{group:CompositionGroup;count:number;ids:string[]}>();
      for(const fact of facts){const paths=assignment.get(fact.entityId)?.paths??[],points=boxes.has(fact.entityId)?[center(boxes.get(fact.entityId)!)]:fact.positions??[];
        if(!points.length||!points.every(p=>contains(c.box,p,policy.voteMargin)))continue;
        const systems=new Map(paths.flatMap(p=>p.filter(g=>g.key.startsWith('distribution:'))).map(g=>[g.key,g]));
        if(systems.size===1){const group=[...systems.values()][0],vote=votes.get(group.key)??{group,count:0,ids:[]};vote.count++;vote.ids.push(fact.entityId);votes.set(group.key,vote);}}
      const ranked=[...votes.values()].sort((a,b)=>b.count-a.count);
      voteCounts.push(...ranked.map(v=>[v.group.title,v.count] as [string,number]));
      // A delivery building can contain both GIS and 10kV switchgear. The
      // numerous small cabinets do not rename its higher-voltage GIS building.
      const high=ranked.filter(v=>Number(v.group.key.split(':')[1])>=policy.highVoltageKv&&v.count>=policy.minVotes),low=ranked.filter(v=>Number(v.group.key.split(':')[1])<policy.highVoltageKv);
      const chosen=high.length===1&&low.length+high.length===ranked.length?high[0]:ranked.length===1?ranked[0]:undefined;
      if(chosen&&chosen.count>=policy.minVotes){
        const declared = new Map(declarations.flatMap(d=>d.path.filter(g=>g.kind==='building'&&/^配电室\d*$/.test(g.title))).map(g=>[g.key,g]));
        const title=`${chosen.group.title}楼`;fallbackName={key:`building:${title.toLowerCase()}`,title,kind:'building',order:0};
        declaredName=declared.size===1;name=declaredName?[...declared.values()][0]:fallbackName;
      }
    }
    // Anonymous physical building remains visible, without inventing a use.
    const main = anchors.filter(a=>a.group.key==='main'&&contains(c.box,a.point));
    const roof = contained.some(e=>e.category==='C-A6' || e.category==='C-A2' && area(boxes.get(e.id)!)>=area(c.box)*0.2 && boxes.get(e.id)![2]>policy.minTop);
    const outdoor = !name && names.size===0 && new Set(main.map(a=>a.id)).size>=2 && !roof;
    return {...c,area:outdoor?main[0].group:undefined,declaredName,fallbackName,
      names:[...names.values()].map(n=>n.title),votes:voteCounts,
      name:name??{key:`building:spatial:${c.box.slice(0,2).map(n=>Math.round(n*10)).join(':')}`,title:`建筑物${index+1}（用途待确认）`,kind:'building' as const,order:0},ambiguous:names.size>1};
  });
  const declaredCounts=new Map<string,number>();
  for(const building of buildings)if(building.declaredName)declaredCounts.set(building.name.key,(declaredCounts.get(building.name.key)??0)+1);
  for(const building of buildings){
    if(building.declaredName&&declaredCounts.get(building.name.key)!>1){building.name=building.fallbackName!;}
    diagnostics?.footprints.push({bounds:building.box,members:building.ids.length,names:building.names,votes:building.votes,chosen:building.area?'主变区域':building.name.title});
  }
  for(const e of snapshot.entities){
    if(!/^C-A|^C-B/.test(e.category)||!boxes.has(e.id))continue;
    const b=boxes.get(e.id)!,p=center(b),hits=buildings.filter(c=>!c.ambiguous&&contains(c.box,p,policy.joinMargin)&&b[0]>=c.box[0]-policy.containmentMargin&&b[3]<=c.box[3]+policy.containmentMargin&&b[1]>=c.box[1]-policy.containmentMargin&&b[4]<=c.box[4]+policy.containmentMargin);
    if(hits.length!==1)continue;
    const building=hits[0],old=assignment.get(e.id)!;
    // An explicit building path stays semantic, even when its footprint agrees.
    if(buildingPaths(evidence.get(e.id)).length)continue;
    if(building.area&&old.paths.some(path=>path.some(g=>g.kind==='area')))continue;
    if(building.area){
      assignment.set(e.id,{entityId:e.id,paths:[areaPath(e,building.area)],inferred:true});
      continue;
    }
    const floors=(evidence.get(e.id)?.spaces??[]).flatMap(s=>s.storeys),unique=new Map(floors.map(f=>[f.evidenceId,f]));
    const floor=[...unique.values()];
    const path:CompositionGroup[]=[civil,building.name];
    if(floor.length===1)path.push({key:`floor:${floor[0].evidenceId}`,title:floor[0].value,kind:'storey',order:floor[0].elevationMetres});
    else path.push({key:'floor:unconfirmed',title:'楼层待确认',kind:'storey'});
    assignment.set(e.id,{entityId:e.id,paths:[path],inferred:true});
  }
  // Room/MEP delivery files which only expose a room name can be placed under a
  // single physical building when their source bounds are fully contained.
  for(const e of snapshot.entities){
    if(!boxes.has(e.id)||/^C-A|^C-B/.test(e.category))continue;
    const room=(evidence.get(e.id)?.spaces??[]).map(space=>canonicalBuildingName(space.building.value)||space.building.value).find(name=>isRoomBuildingName(name));
    if(!room)continue;
    const semantic=buildingPaths(evidence.get(e.id));
    if(semantic.some(path=>path.some(group=>group.kind==='building'&&!isRoomBuildingName(group.title))))continue;
    const b=boxes.get(e.id)!,p=center(b),hits=buildings.filter(c=>!c.area&&!c.ambiguous&&contains(c.box,p,policy.joinMargin)
      &&b[0]>=c.box[0]-policy.containmentMargin&&b[3]<=c.box[3]+policy.containmentMargin&&b[1]>=c.box[1]-policy.containmentMargin&&b[4]<=c.box[4]+policy.containmentMargin);
    if(hits.length!==1)continue;
    const building=hits[0];
    assignment.set(e.id,{entityId:e.id,paths:[[civil,building.name,
      {key:`room:${room}`,title:room,kind:'storey',order:0}]],
    });
  }
  for(const e of snapshot.entities){
    const old=assignment.get(e.id)!, b=boxes.get(e.id);
    if(!b || !/^C-B|^C-A[1345]$/.test(e.category) || old.paths.some(p=>p[0]?.key!=='unclassified'))continue;
    const distances=new Map<string,{distance:number;group:CompositionGroup;id:string}>();
    for(const anchor of anchors){
      const distance=Math.hypot(Math.max(b[0]-anchor.point[0],0,anchor.point[0]-b[3]),Math.max(b[1]-anchor.point[1],0,anchor.point[1]-b[4]));
      if(distance>policy.areaDistance)continue;
      if(distance<(distances.get(anchor.group.key)?.distance??Infinity))distances.set(anchor.group.key,{distance,group:anchor.group,id:anchor.id});
    }
    const ranked=[...distances.values()].sort((a,b)=>a.distance-b.distance);
    if(!ranked.length || ranked.length>1&&ranked[1].distance-ranked[0].distance<policy.areaSeparation)continue;
    assignment.set(e.id,{entityId:e.id,paths:[areaPath(e,ranked[0].group)],inferred:true});
  }
  for(const e of snapshot.entities){
    const stack=firewallMembers.get(e.id),old=assignment.get(e.id);
    if(!stack||!old||old.paths.some(path=>path.some(group=>group.kind==='building')))continue;
    if(!old.paths.some(path=>path.some(group=>group.key==='area:main')))continue;
    assignment.set(e.id,{entityId:e.id,paths:[areaPath(e,{key:'main',title:'主变压器系统',kind:'system'})],
      inferred:true});
  }
  return snapshot.entities.map(e=>assignment.get(e.id)!);
}
