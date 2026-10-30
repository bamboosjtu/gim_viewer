import type {BusinessObject,BusinessShape,BusinessSpatialInput,BusinessTreeProjection} from './businessTree.js';
import type {IfcSpatialNode} from './ifcSpatialParser.js';
import {businessGeometryShapes,businessPlanDistance,centreOfBusinessShape,overlapBusinessShapes,unionBusinessShapes} from './businessGeometry.js';

const civilKinds=new Set(['building','structure','foundation','plumbing','lighting','fire']);
const key=(...parts:string[])=>`business:${parts.map(encodeURIComponent).join(':')}`;
export function businessBuildingName(text:string):string|undefined {
  const match=text.match(/(?:\d+\s*(?:kV|千伏)?\s*)?(?:配电楼|主控楼|控制楼|通信楼|综合楼|辅助用房|警卫室|警传室|消防泵房|泵房)|\d+\s*号楼/i);
  return match?.[0].replace(/\s/g,'').replace(/^(\d+)(?:kV|千伏)?配电楼$/i,'$1千伏配电楼');
}
const facility=(text:string)=>text.match(/事故油池|化粪池|雨水泵池|消防水池|雨水井|电缆隧道|电缆沟|围墙|大门|道路|独立避雷针|构架|支架/)?.[0];
interface Place {floor?:IfcSpatialNode;name?:string;explicit:boolean}
interface Building {name:string;boxes:BusinessShape[];evidence:string[]}

/** Physical architectural footprints join files and floors. Anonymous exporter
 * containers are never a building identity. Material/MEP inference does not
 * enlarge these fixed footprints. All distances are in the source XY plane. */
export function assignBuildingOwnership(p:BusinessTreeProjection,input:BusinessSpatialInput):void {
  const shapes=businessGeometryShapes(p,input),source=(o:BusinessObject)=>o.ifcKeys.map(k=>input.objectByKey.get(k)).find(Boolean);
  const civil=[...p.objects.values()].filter(o=>civilKinds.has(o.kind));
  const places=new Map<string,Place>(),byObject=new Map<string,Place>();
  for(const o of civil){
    const s=source(o);let where=s?.spatialKey?places.get(s.spatialKey):undefined;
    if(!where){
      where={explicit:false};let node=s?.spatialKey?input.nodeByKey.get(s.spatialKey):undefined;const seen=new Set<string>();
      while(node&&!seen.has(node.key)){
        seen.add(node.key);if(node.kind==='storey'&&!where.floor)where.floor=node;
        const named=businessBuildingName([node.name,node.longName??''].join(' '));
        if(named&&!where.name){where.name=named;where.explicit=true;}
        if(node.kind==='building'&&!where.name&&!/总平面|总图|总轴网|场地|站区|工程|项目/.test(node.name)&&!/^(?:IFC.*#.*|Default.*|Building|建筑物?|构筑物?|未命名.*|默认.*|无|--|\s*)$/i.test(node.name)){where.name=node.name;where.explicit=true;}
        node=node.parentKey?input.nodeByKey.get(node.parentKey):undefined;
      }
      if(s?.spatialKey)places.set(s.spatialKey,where);
    }
    const own={...where},named=o.context.map(businessBuildingName).find(Boolean);
    if(named){own.name=named;own.explicit=true;}
    if(!own.name)own.name=businessBuildingName(s?.sourcePath??'');
    byObject.set(o.key,own);
  }
  const buildingBodies=civil.filter(o=>o.kind==='building'&&!facility(o.name)&&shapes.has(o.key)&&
    // Architectural bodies establish footprints. Outdoor frames, foundation
    // mats and thousands of steel fasteners must not connect separate houses.
    (/建筑|配电楼|主控楼|辅助用房|警卫室|警传室|泵房/.test(source(o)?.sourcePath??'')||byObject.get(o.key)?.explicit)&&
    !/IFC(?:MECHANICALFASTENER|FASTENER|PLATE|MEMBER|REINFORCING)/.test(source(o)?.ifcType??''));
  const boxes=buildingBodies.map(o=>unionBusinessShapes(shapes.get(o.key)!)!),parents=buildingBodies.map((_,i)=>i),cells=new Map<string,number[]>();
  const root=(i:number):number=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
  for(let i=0;i<boxes.length;i++){
    const b=boxes[i],x0=Math.floor(b.min[0]/10),x1=Math.floor(b.max[0]/10),y0=Math.floor(b.min[1]/10),y1=Math.floor(b.max[1]/10),seen=new Set<number>();
    if((x1-x0+1)*(y1-y0+1)>10000)continue;
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
      const cell=`${x},${y}`,members=cells.get(cell)??[];
      for(const j of members)if(!seen.has(j)){seen.add(j);if(root(i)!==root(j)&&overlapBusinessShapes(b,boxes[j],[0,1],.2))parents[root(i)]=root(j);}
      members.push(i);cells.set(cell,members);
    }
  }
  const components=new Map<number,BusinessObject[]>();for(let i=0;i<buildingBodies.length;i++){const r=root(i),list=components.get(r)??[];list.push(buildingBodies[i]);components.set(r,list);}
  const buildings=new Map<string,Building>();
  const add=(name:string,object:BusinessObject,evidence:string):void=>{
    const building=buildings.get(name)??{name,boxes:[],evidence:[]};building.boxes.push(...shapes.get(object.key)??[]);if(!building.evidence.includes(evidence))building.evidence.push(evidence);buildings.set(name,building);
  };
  const primaryAreas=new Map<number,BusinessShape[]>();
  for(const o of p.objects.values())if(o.assignment.status==='confirmed'&&o.kind==='device'&&/GIS|HGIS|组合电器/i.test(o.name)){
    const v=p.regions.get(p.units.get(o.assignment.unitKey)!.regionKey)?.voltage;if(v==null)continue;
    const rows=primaryAreas.get(v)??[];rows.push(...shapes.get(o.key)??[]);primaryAreas.set(v,rows);
  }
  const areas=[...primaryAreas].map(([voltage,rows])=>({voltage,box:unionBusinessShapes(rows)})).filter((a):a is {voltage:number;box:BusinessShape}=>!!a.box);
  let anonymous=0;
  const ordered=[...components.values()].sort((a,b)=>boxes[buildingBodies.indexOf(a[0])].min[0]-boxes[buildingBodies.indexOf(b[0])].min[0]);
  for(const members of ordered){
    const envelope=unionBusinessShapes(members.flatMap(o=>shapes.get(o.key)!))!,area=(envelope.max[0]-envelope.min[0])*(envelope.max[1]-envelope.min[1]);
    const names=new Set(members.map(o=>byObject.get(o.key)?.name).filter((n):n is string=>!!n));
    const voltages=areas.filter(a=>businessPlanDistance(centreOfBusinessShape(a.box),envelope)<.2);
    // A floor file can contain both voltage buildings; only the primary
    // arrangement separates those footprints, never one storey-wide union.
    if(voltages.length>1&&[...names].some(n=>/千伏配电楼/.test(n)))for(const v of voltages)names.add(`${v.voltage}千伏配电楼`);
    if(!names.size&&members.length>=10&&area>=20&&envelope.max[2]-envelope.min[2]>=2.5){
      names.add(voltages.length===1?`${voltages[0].voltage}千伏配电楼`:`建筑物${++anonymous}`);
    }
    if(!names.size)continue;
    const only=names.size===1?[...names][0]:undefined;
    const fixed=new Map<string,BusinessShape[]>();for(const o of members){const n=byObject.get(o.key)?.name;if(n){const rows=fixed.get(n)??[];rows.push(...shapes.get(o.key)!);fixed.set(n,rows);}}
    for(const o of members){
      const where=byObject.get(o.key)!,own=shapes.get(o.key)!;let name=where.name??only;
      if(!name){
        const point=centreOfBusinessShape(unionBusinessShapes(own)!),ranked=[...names].map(n=>{
          const voltage=Number(n.match(/^(\d+(?:\.\d+)?)千伏/)?.[1]),a=areas.find(a=>a.voltage===voltage),seeds=a?[a.box]:fixed.get(n)??[];
          let distance=Infinity;for(const b of seeds)distance=Math.min(distance,businessPlanDistance(point,b));return {name:n,distance};
        }).sort((a,b)=>a.distance-b.distance);
        if(ranked[0]?.distance<=20&&(!ranked[1]||ranked[1].distance-ranked[0].distance>=2))name=ranked[0].name;
      }
      if(name){where.name=name;add(name,o,where.explicit?'named-building-or-storey':'architectural-footprint');}
    }
  }
  const footprintCells=new Map<string,Map<string,BusinessShape[]>>();
  for(const b of buildings.values())for(const shape of b.boxes){
    const x0=Math.floor((shape.min[0]-.6)/10),x1=Math.floor((shape.max[0]+.6)/10),y0=Math.floor((shape.min[1]-.6)/10),y1=Math.floor((shape.max[1]+.6)/10);
    if((x1-x0+1)*(y1-y0+1)>10000)continue;
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const k=`${x},${y}`,cell=footprintCells.get(k)??new Map<string,BusinessShape[]>(),rows=cell.get(b.name)??[];rows.push(shape);cell.set(b.name,rows);footprintCells.set(k,cell);}
  }
  // Explicit named architectural objects without geometry still retain their
  // source ownership; they cannot enlarge the footprint used for other files.
  const buildingFor=(o:BusinessObject,seen=new Set<string>()):string|undefined=>{
    const where=byObject.get(o.key);if(where?.name)return where.name;
    if(seen.has(o.key)||seen.size>32)return;seen.add(o.key);
    const s=source(o),host=s?.hostObjectKey&&p.objectBySource.get(s.hostObjectKey),owner=host&&p.objects.get(host);
    const inherited=owner&&buildingFor(owner,seen);if(inherited){if(where){where.name=inherited;where.explicit=byObject.get(owner.key)?.explicit??false;}return inherited;}
    const own=shapes.get(o.key)??[];if(!own.length)return;
    const names=new Set<string>();for(const shape of own){const point=centreOfBusinessShape(shape);for(const name of footprintCells.get(`${Math.floor(point[0]/10)},${Math.floor(point[1]/10)}`)?.keys()??[])names.add(name);}
    const ranked=[...names].map(name=>{
      let distance=0;for(const s of own){let nearest=Infinity;const point=centreOfBusinessShape(s),rows=footprintCells.get(`${Math.floor(point[0]/10)},${Math.floor(point[1]/10)}`)?.get(name)??[];for(const seed of rows)nearest=Math.min(nearest,businessPlanDistance(point,seed));distance=Math.max(distance,nearest);}return {name,distance};
    }).sort((a,b)=>a.distance-b.distance);
    if(ranked[0]?.distance<=.6&&(!ranked[1]||ranked[1].distance-ranked[0].distance>=.5))return ranked[0].name;
  };
  const storeysPerModel=new Map<string,number>();for(const n of input.nodeByKey.values())if(n.kind==='storey')storeysPerModel.set(n.modelId,(storeysPerModel.get(n.modelId)??0)+1);
  const level=(floor:IfcSpatialNode|undefined):number|undefined=>{
    if(!floor||/^(无|未命名|default.*|IFC.*|标高\s*\d+|0)$/i.test(floor.name)&&(storeysPerModel.get(floor.modelId)??0)<2)return;
    const scale=input.modelUnits?.get(floor.modelId)??floor.placement?.unitScaleToMetres;
    if(floor.elevation!=null&&scale&&Number.isFinite(floor.elevation*scale))return floor.elevation*scale;
    const m=floor.name.match(/(-?\d+(?:\.\d+)?)\s*m/i);return m?Number(m[1]):undefined;
  };
  const mainBodies=[...p.objects.values()].filter(o=>o.assignment.status==='confirmed'&&p.units.get(o.assignment.unitKey)?.kind==='transformer'&&/变压器|主变本体/.test(o.name));
  for(const o of civil){
    const where=byObject.get(o.key)!,s=source(o),path=s?.sourcePath??'',isFoundation=o.kind==='foundation';
    let mainUnit:string|undefined;
    if(isFoundation&&!/构架|建筑基础|墙下基础|条形基础/.test(o.name+' '+path)){
      const own=unionBusinessShapes(shapes.get(o.key)??[]),ranked=new Map<string,number>();
      if(own){const point=centreOfBusinessShape(own);for(const main of mainBodies){let d=Infinity;for(const b of shapes.get(main.key)??[])d=Math.min(d,businessPlanDistance(point,b));ranked.set(main.assignment.unitKey,Math.min(ranked.get(main.assignment.unitKey)??Infinity,d));}}
      const candidates=[...ranked].sort((a,b)=>a[1]-b[1]);if(candidates[0]?.[1]<=2&&(!candidates[1]||candidates[1][1]-candidates[0][1]>=3))mainUnit=candidates[0][0];
    }
    // Site facilities keep their function even when their XY footprint lies
    // beneath a house. Containment is a source fact, not business ownership.
    const facilityType=o.kind==='structure'?facility(o.name):undefined;
    let site=isFoundation?'基础':facilityType!=='支架'?facilityType:undefined;
    const name=site?undefined:buildingFor(o);
    // A generic support may be part of a building; its noun alone is weaker
    // than a building host. Explicit trenches/frames retain site ownership.
    if(!site&&!name)site=facilityType;
    const regionKey=name?key('building',name):site?key('site',site):'business:construction:site';
    if(!p.regions.has(regionKey))p.regions.set(regionKey,{key:regionKey,title:name??site??'站区性建筑',domain:'construction'});
    else if(regionKey==='business:construction:site')p.regions.get(regionKey)!.title='站区性建筑';
    const system=o.kind==='fire'?'消防':o.kind==='lighting'?'照明':o.kind==='plumbing'?'给排水':undefined,z=level(where.floor);
    const foundationBuilding=isFoundation&&!mainUnit?buildingFor(o):undefined;
    const foundationType=mainUnit||/主变|变压器|设备基础|构架/.test(o.name+' '+path)?'设备基础':/建筑基础|墙下基础|条形基础/.test(o.name)||foundationBuilding&&/建筑|土建/.test(path)?'建筑基础':'其他基础';
    const title=system??(isFoundation?foundationType:name?(z!=null?`${Number(z.toFixed(4))}m标高层`:'建筑构件'):'构件'),unitKey=key(regionKey,title);
    if(!p.units.has(unitKey))p.units.set(unitKey,{key:unitKey,title,regionKey,kind:'building'});
    o.assignment={status:name?(where.explicit?'confirmed':'inferred'):site?'inferred':'unresolved',unitKey,
      reason:name?(where.explicit?'明确建筑名称或宿主关系':'建筑实体的唯一平面范围归属'):site?'基础或站区设施类型归组':'具体建筑归属证据不足',
      evidence:[...(o.assignment.evidence??[]),...(where.floor?[where.floor.key,where.floor.name]:[]),...(name?[name,'architectural-footprint']:[]),...(isFoundation?['foundation-type']:[])]};
    if(mainUnit){o.assignment.relatedUnitKeys=[mainUnit];o.assignment.reason='基础位于唯一主变本体平面范围附近';o.assignment.evidence.push('source-xy-metres');}
    if(isFoundation){o.assignment.evidence.push(foundationType);if(foundationType==='建筑基础'&&foundationBuilding)o.assignment.evidence.push(foundationBuilding);}
  }
}
