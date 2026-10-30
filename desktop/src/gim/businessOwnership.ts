import type { BusinessObject, BusinessShape, BusinessSpatialInput, BusinessTreeProjection } from './businessTree.js';
import {businessPlanDistance,centreOfBusinessShape,businessGeometryShapes as geometry,unionBusinessShapes as union,overlapBusinessShapes as overlap,containsBusinessShape as contains} from './businessGeometry.js';

const materialKinds=new Set(['导线','母线','金具','绝缘子','套管','电缆','接地材料','其他材料']);
const key=(...parts:string[])=>`business:${parts.map(encodeURIComponent).join(':')}`;
const epsilon=1e-6;
const centre=(a:BusinessShape)=>a.min.map((v,i)=>(v+a.max[i])/2);
/** Metres in the source XY plane. These are conservative inference bounds,
 * not measured accuracy guarantees; ties and long crossing conductors remain
 * shared/unresolved. Explicit source ownership always wins. */
export const BUSINESS_PLANAR_RULES:Readonly<Record<string,{range:number;margin:number;maxSpan:number}>>={
  '导线':{range:8,margin:2,maxSpan:12},'绝缘子':{range:6,margin:2,maxSpan:12},
  '金具':{range:4,margin:1.5,maxSpan:8},'套管':{range:4,margin:1.5,maxSpan:8},
  device:{range:3,margin:1.5,maxSpan:20},component:{range:8,margin:3,maxSpan:20},
};
const deviceClass=(name:string)=>name.match(/中性点|避雷器|电流互感器|电压互感器|电容器|电抗器|变压器|断路器|隔离开关|接地开关|HGIS|GIS|组合电器|开关柜/i)?.[0].toUpperCase();
function assign(p:BusinessTreeProjection,o:BusinessObject,regionKey:string,title:string,status:'confirmed'|'inferred'|'shared'|'unresolved',reason:string,evidence:string[],kind:'building'|'bus'|'unresolved'='building',identity=title):void {
  const unitKey=key(regionKey,identity);if(!p.units.has(unitKey))p.units.set(unitKey,{key:unitKey,title,regionKey,kind});
  o.assignment={status,unitKey,reason,evidence};
}
/** Explicit ownership and endpoint sets precede bounded source-XY inference.
 * Distance results remain inferred; ambiguity is retained in the projection. */
export function assignMaterialOwnership(p:BusinessTreeProjection,input:BusinessSpatialInput):void {
  const shapes=geometry(p,input),units=new Map<string,BusinessShape[]>(),regionShapes=new Map<string,BusinessShape[]>();
  // A standalone IFC main body is a primary business anchor, even when its
  // CBM source has no numbered bay. Reuse an existing main unit at the same
  // footprint; keep both source objects and never invent a transformer number.
  for(const o of p.objects.values())if(o.assignment.status==='unresolved'&&o.ifcKeys.length&&['device','component'].includes(o.kind)&&
    /主变压器|主变本体|(?:^|[-_\s])主变(?:$|[-_\s])/.test(o.name.split(/[:：]/,1)[0])&&!/间隔|柜|保护|测控|中性点|避雷器/.test(o.name)){
    const own=union(shapes.get(o.key)??[]);if(!own)continue;const point=centre(own),ranked=new Map<string,number>();
    for(const primary of p.objects.values())if(primary.key!==o.key&&primary.assignment.status==='confirmed'&&p.units.get(primary.assignment.unitKey)?.kind==='transformer'&&/变压器|主变本体|(?:^|[-_\s])主变(?:$|[-_\s])/.test(primary.name.split(/[:：]/,1)[0])){
      let distance=Infinity;for(const box of shapes.get(primary.key)??[])distance=Math.min(distance,businessPlanDistance(point,box));ranked.set(primary.assignment.unitKey,Math.min(ranked.get(primary.assignment.unitKey)??Infinity,distance));
    }
    const candidates=[...ranked].map(([unitKey,distance])=>({unitKey,distance})).sort((a,b)=>a.distance-b.distance);
    if(candidates[0]?.distance<=1&&(!candidates[1]||candidates[1].distance-candidates[0].distance>=2))o.assignment={status:'inferred',unitKey:candidates[0].unitKey,reason:'主变本体与已有主变单元的唯一平面范围一致',evidence:['source-main-transformer-type','source-xy-metres'],candidates:candidates.slice(0,2)};
    else{
      const regionKey='business:transformers',unitKey=key(regionKey,'unnumbered',o.key);
      if(!p.regions.has(regionKey))p.regions.set(regionKey,{key:regionKey,title:'主变压器系统',domain:'installation'});
      p.units.set(unitKey,{key:unitKey,title:'主变单元（源未编号）',regionKey,kind:'transformer'});
      o.assignment={status:'confirmed',unitKey,reason:'主变本体建立独立功能单元，源内未提供编号',evidence:['source-main-transformer-type','unnumbered-primary-unit']};
    }
  }
  const primaryByUnit=new Map<string,BusinessObject[]>();
  for(const o of p.objects.values()){
    const u=p.units.get(o.assignment.unitKey)!,r=p.regions.get(u.regionKey)!;
    if(r.domain!=='installation'||o.assignment.status!=='confirmed'||u.kind==='unresolved'||(!['device','component'].includes(o.kind)&&!(u.kind==='bus'&&o.kind==='母线'))||u.regionKey==='business:secondary'||u.regionKey==='business:ground')continue;
    const bounds=shapes.get(o.key)??[];units.set(u.key,[...(units.get(u.key)??[]),...bounds]);regionShapes.set(r.key,[...(regionShapes.get(r.key)??[]),...bounds]);
    const primary=primaryByUnit.get(u.key)??[];primary.push(o);primaryByUnit.set(u.key,primary);
  }
  const grid=new Map<string,Set<string>>(),cell=10;
  const register=(unitKey:string,boxes:BusinessShape[])=>{for(const b of boxes){const x0=Math.floor(b.min[0]/cell),x1=Math.floor(b.max[0]/cell),y0=Math.floor(b.min[1]/cell),y1=Math.floor(b.max[1]/cell);if((x1-x0+1)*(y1-y0+1)>10000)continue;
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const k=`${x},${y}`,set=grid.get(k)??new Set();set.add(unitKey);grid.set(k,set);}}};
  for(const [u,boxes]of units)register(u,boxes);
  const infer=(o:BusinessObject,unitKey:string,reason:string,evidence:string[])=>{o.assignment={status:'inferred',unitKey,reason,evidence,candidates:[{unitKey,distance:0}]};};
  const pending=[...p.objects.values()].filter(o=>(materialKinds.has(o.kind)&&o.kind!=='接地材料'||['device','component'].includes(o.kind))&&o.assignment.status!=='confirmed');
  for(const o of pending){
    if(!materialKinds.has(o.kind))continue;
    const own=shapes.get(o.key)??[];if(!own.length||o.voltageConflict)continue;
    const candidates=new Set<string>();for(const b of own){
      const x0=Math.floor(b.min[0]/cell),x1=Math.floor(b.max[0]/cell),y0=Math.floor(b.min[1]/cell),y1=Math.floor(b.max[1]/cell);if((x1-x0+1)*(y1-y0+1)>10000)continue;
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(const u of grid.get(`${x},${y}`)??[])candidates.add(u);
    }
    const compatible=[...candidates].filter(u=>{const r=p.regions.get(p.units.get(u)!.regionKey)!;return (o.voltage==null||r.voltage==null||o.voltage===r.voltage)&&(!/主变区域/.test(o.name)||r.key==='business:transformers');});
    const enclosed=compatible.filter(u=>own.every(s=>(units.get(u)??[]).some(b=>contains(b,s))));
    if(enclosed.length===1){infer(o,enclosed[0],'装置性材料位于唯一兼容设备或母线范围内',['unique-geometric-enclosure']);continue;}
    const contact=compatible.filter(u=>own.some(s=>(units.get(u)??[]).some(b=>overlap(b,s))));
    const slender=own.every(s=>{const widths=s.min.map((v,i)=>s.max[i]-v).sort((a,b)=>b-a);return widths[0]>=4*widths[1];});
    if(o.kind!=='母线'&&(o.kind!=='导线'&&o.kind!=='电缆'||slender)&&contact.length===1){infer(o,contact[0],'装置性材料与唯一兼容设备的表示范围相交',['unique-bounds-overlap']);continue;}
    if(o.kind!=='母线'||/柜内|内部|母排/.test(o.name)||o.ownerKey&&p.objects.get(o.ownerKey)?.kind==='device')continue;
    const named=o.name.match(/(\d+(?:\.\d+)?)\s*(?:kV|千伏)/i),voltage=o.voltage??(named?Number(named[1]):undefined);
    const regions=[...regionShapes].filter(([r,bounds])=>p.regions.get(r)?.voltage!=null&&(voltage==null||p.regions.get(r)!.voltage===voltage)&&own.some(s=>bounds.some(b=>overlap(b,s,[0,1]))));
    if(regions.length===1){const regionKey=regions[0][0];assign(p,o,regionKey,'母线设备间隔','inferred','母线类型与唯一配电区域范围一致',['bus-type','primary-voltage-region','geometry-overlap'],'bus','bus');
      const u=o.assignment.unitKey,list=units.get(u)??[];list.push(...own);units.set(u,list);register(u,own);}
  }
  // A support that physically meets the bus follows that bus as one unit.
  for(const o of pending)if(o.assignment.status==='unresolved'&&o.kind==='绝缘子'){
    const own=shapes.get(o.key)??[],bus=[...units].filter(([u,boxes])=>p.units.get(u)?.kind==='bus'&&own.some(s=>boxes.some(b=>overlap(b,s))));
    if(bus.length===1)infer(o,bus[0][0],'绝缘子与唯一母线的表示范围相交',['bus-support-bounds']);
  }
  for(let pass=0;pass<4;pass++){
    let changed=false;
    for(const relation of input.connections??[]){
      const o=p.objects.get(p.objectBySource.get(relation.objectKey)??relation.objectKey);if(!o||!materialKinds.has(o.kind)||o.assignment.status==='confirmed')continue;
      const endpoints=relation.endpointKeys.map(k=>p.objects.get(p.objectBySource.get(k)??k));
      if(!endpoints.length||endpoints.some(e=>!e||!['confirmed','inferred'].includes(e.assignment.status)))continue;
      const target=[...new Set(endpoints.map(e=>e!.assignment.unitKey))];
      if(target.length===1){
        if(o.assignment.unitKey!==target[0]||!o.assignment.evidence.includes('IFC connection endpoints')){infer(o,target[0],'全部明确连接端点归属同一业务单元',['IFC connection endpoints']);changed=true;}
      }else {
        const regions=new Set(target.map(u=>p.units.get(u)!.regionKey));
        if(regions.size===1){const regionKey=[...regions][0];assign(p,o,regionKey,'区域连接材料','shared','连接多个间隔，保留区域归属及关联间隔',['IFC connection endpoints'],'unresolved','unassigned');o.assignment.relatedUnitKeys=target;}
        else{
          const regionKey='business:unresolved:installation';if(!p.regions.has(regionKey))p.regions.set(regionKey,{key:regionKey,title:'安装区域待确认',domain:'installation'});
          assign(p,o,regionKey,'区域连接材料','unresolved','连接端点跨业务区域，不能由表示范围确定所有权',['IFC connection endpoints'],'unresolved','unassigned');o.assignment.relatedUnitKeys=target;
        }
      }
    }
    if(!changed)break;
  }
  // Short equipment leads can project onto one primary footprint while their
  // midpoint is closer to the bus. A unique primary contact is stronger than
  // that midpoint ranking, but remains inferred and never expands the anchor.
  for(const o of pending)if(o.kind==='导线'&&o.assignment.status==='unresolved'&&!o.voltageConflict&&!o.assignment.reason.includes('多个 CBM')&&!o.assignment.evidence.includes('IFC connection endpoints')){
    const own=shapes.get(o.key)??[],body=union(own);if(!body||Math.max(body.max[0]-body.min[0],body.max[1]-body.min[1])>BUSINESS_PLANAR_RULES['导线'].maxSpan)continue;
    const candidateKeys=new Set<string>(),x0=Math.floor(body.min[0]/cell),x1=Math.floor(body.max[0]/cell),y0=Math.floor(body.min[1]/cell),y1=Math.floor(body.max[1]/cell);
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(const u of grid.get(`${x},${y}`)??[])candidateKeys.add(u);
    const contact=[...candidateKeys].filter(u=>{
      const unit=p.units.get(u)!,r=p.regions.get(unit.regionKey)!;
      return unit.kind!=='bus'&&unit.kind!=='shared'&&unit.kind!=='unresolved'&&(o.voltage==null||r.voltage==null||o.voltage===r.voltage)&&
        (!/主变区域/.test(o.name)||r.key==='business:transformers')&&own.every(s=>(units.get(u)??[]).some(b=>overlap(s,b,[0,1])));
    });
    if(contact.length!==1)continue;
    const point=centre(body),ranked=[...candidateKeys].filter(u=>{const r=p.regions.get(p.units.get(u)!.regionKey)!;return o.voltage==null||r.voltage==null||o.voltage===r.voltage;}).map(unitKey=>({unitKey,distance:Math.min(...(units.get(unitKey)??[]).map(b=>businessPlanDistance(point,b)))})).sort((a,b)=>a.distance-b.distance);
    o.assignment={status:'inferred',unitKey:contact[0],reason:'短接引导线的平面范围与唯一主设备范围相交',evidence:['source-xy-metres','unique-primary-lead-contact-v1'],candidates:ranked.slice(0,2)};
  }
  for(const o of pending){
    const rule=BUSINESS_PLANAR_RULES[o.kind],own=shapes.get(o.key)??[];
    if(!rule||!own.length||o.assignment.status!=='unresolved'||o.voltageConflict||o.assignment.evidence.includes('IFC connection endpoints'))continue;
    const body=union(own)!,point=centreOfBusinessShape(body),candidateKeys=new Set<string>(),asset=['device','component'].includes(o.kind);
    const span=Math.max(body.max[0]-body.min[0],body.max[1]-body.min[1]),crossWire=o.kind==='导线'&&span>rule.maxSpan;
    const x0=Math.floor(((crossWire?body.min[0]:point[0])-rule.range)/cell),x1=Math.floor(((crossWire?body.max[0]:point[0])+rule.range)/cell);
    const y0=Math.floor(((crossWire?body.min[1]:point[1])-rule.range)/cell),y1=Math.floor(((crossWire?body.max[1]:point[1])+rule.range)/cell);
    if((x1-x0+1)*(y1-y0+1)>10000)continue;
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(const u of grid.get(`${x},${y}`)??[])candidateKeys.add(u);
    const ranked=[...candidateKeys].filter(u=>{
      const unit=p.units.get(u)!,r=p.regions.get(unit.regionKey)!;
      if(o.voltage!=null&&r.voltage!=null&&o.voltage!==r.voltage||/主变区域/.test(o.name)&&unit.regionKey!=='business:transformers')return false;
      if(asset){const category=deviceClass(o.name);return !!category&&(primaryByUnit.get(u)??[]).some(primary=>deviceClass(primary.name)===category||category==='避雷器'&&/中性点/.test(primary.name)||unit.kind==='transformer'&&['中性点','避雷器'].includes(category));}
      return unit.kind!=='shared'&&unit.kind!=='unresolved';
    }).map(unitKey=>{
      let distance=Infinity;for(const b of units.get(unitKey)??[])distance=Math.min(distance,businessPlanDistance(point,b));return {unitKey,distance};
    }).sort((a,b)=>a.distance-b.distance);
    o.assignment.candidates=ranked.slice(0,2);
    const first=ranked[0],second=ranked[1];
    if(!first)continue;
    if(span>rule.maxSpan){
      const crossing=ranked.filter(c=>units.get(c.unitKey)?.some(b=>overlap(body,b,[0,1]))),regions=new Set(crossing.map(c=>p.units.get(c.unitKey)!.regionKey));
      if(o.kind==='导线'&&crossing.length>1&&regions.size===1){assign(p,o,[...regions][0],'区域连接材料','shared','长导线跨越多个平面候选间隔，保留区域共享',['source-xy-metres','cross-bay-range'],'unresolved','unassigned');o.assignment.relatedUnitKeys=crossing.map(c=>c.unitKey);o.assignment.candidates=ranked.slice(0,2);}
      continue;
    }
    if(first.distance>rule.range)continue;
    if(second?second.distance-first.distance<rule.margin:first.distance>rule.range-rule.margin)continue;
    o.assignment={status:'inferred',unitKey:first.unitKey,reason:'平面最近间隔满足类型、范围及候选区分度约束',evidence:['source-xy-metres','planar-nearest-margin-v1'],candidates:ranked.slice(0,2)};
  }
  const areas=[...regionShapes].map(([regionKey,boxes])=>({regionKey,box:union(boxes)})).filter((r):r is {regionKey:string;box:BusinessShape}=>!!r.box);
  for(const o of pending)if(o.assignment.status==='unresolved'){
    const own=shapes.get(o.key)??[];
    let regionKey=/主变区域/.test(o.name)?'business:transformers':undefined;
    if(!regionKey&&own.length){const matched=areas.filter(r=>own.every(b=>{const c=centre(b);return [0,1,2].every(i=>c[i]>=r.box.min[i]-epsilon&&c[i]<=r.box.max[i]+epsilon);}));if(matched.length===1)regionKey=matched[0].regionKey;}
    if(regionKey&&p.regions.has(regionKey)&&!o.assignment.evidence.includes('IFC connection endpoints'))assign(p,o,regionKey,'区域材料','unresolved','已确定业务区域，间隔归属证据不足',['business-region','primary-geometry-envelope'],'unresolved','unassigned');
    if(own.length){
      o.assignment.candidates=[...units].filter(([u])=>{const r=p.regions.get(p.units.get(u)!.regionKey)!;return (!regionKey||r.key===regionKey)&&(o.voltage==null||r.voltage==null||o.voltage===r.voltage);}).map(([unitKey,boxes])=>{
        let nearest=Infinity;for(const s of own)for(const b of boxes)nearest=Math.min(nearest,businessPlanDistance(centre(s),b));return {unitKey,distance:nearest};
      }).filter(c=>Number.isFinite(c.distance)).sort((a,b)=>a.distance-b.distance).slice(0,2);
    }
  }
}
