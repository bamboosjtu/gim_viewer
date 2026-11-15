// Offline-only decomposition of a human-sized framed opening inside ONE
// explicitly labelled barrier object. Never associates separate IFC entities.
const {createHash}=require('node:crypto');
const EPS=2e-4;
function bounds(g){
 const b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
 for(let i=0;i<g.pos.length;i+=3)for(let k=0;k<3;k++){b[k]=Math.min(b[k],g.pos[i+k]);b[k+3]=Math.max(b[k+3],g.pos[i+k]);}
 return b;
}
function unique(values){return [...values].sort((a,b)=>a-b).filter((x,i,a)=>i===0||x-a[i-1]>EPS);}
function projectedContains(g,u,z,tangent){
 for(let i=0;i<g.idx.length;i+=3){
  const a=g.idx[i]*3,b=g.idx[i+1]*3,c=g.idx[i+2]*3;
  const ax=g.pos[a+tangent],ay=g.pos[a+2],bx=g.pos[b+tangent],by=g.pos[b+2],cx=g.pos[c+tangent],cy=g.pos[c+2];
  const det=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(det)<1e-9)continue;
  const s=((u-ax)*(cy-ay)-(z-ay)*(cx-ax))/det,t=((bx-ax)*(z-ay)-(by-ay)*(u-ax))/det;
  if(s>=-1e-7&&t>=-1e-7&&s+t<=1.0000001)return true;
 }
 return false;
}
function merge(parts){
 const pos=[],nor=[],idx=[];let base=0;
 for(const g of parts){for(const x of g.pos)pos.push(x);for(const x of g.nor)nor.push(x);for(const x of g.idx)idx.push(x+base);base+=g.pos.length/3;}
 return {pos,nor,idx};
}
function splitCompositeDoors(geoms,box,source){
 if(!/防爆墙|百叶墙|百叶围护|幕墙/.test(source.name))return {geoms,doors:[]};
 const dx=box[3]-box[0],dy=box[4]-box[1],axis=dx<dy?0:1,tangent=1-axis;
 if(Math.min(dx,dy)>.3||Math.max(dx,dy)<2||box[5]-box[2]<3)return {geoms,doors:[]};
 const boxes=geoms.map(bounds),removed=new Set(),doors=[];
 for(let f=0;f<geoms.length;f++){
  const frame=boxes[f],w=frame[tangent+3]-frame[tangent],h=frame[5]-frame[2];
  if(w<.65||w>1.6||h<1.8||h>3||frame[2]-box[2]>.3||removed.has(f))continue;
  const g=geoms[f],us=[],zs=[];
  for(let i=0;i<g.pos.length;i+=3){us.push(g.pos[i+tangent]);zs.push(g.pos[i+2]);}
  const u=unique(us),z=unique(zs);if(u.length!==4||z.length!==4)continue;
  if(u[1]-u[0]>.15||u[3]-u[2]>.15||z[1]-z[0]>.15||z[3]-z[2]>.15)continue;
  if(u[2]-u[1]<.55||z[2]-z[1]<1.7||projectedContains(g,(u[1]+u[2])/2,(z[1]+z[2])/2,tangent))continue;
  // Require full-height, solid panel geometry INSIDE that same source frame.
  const panels=[];
  for(let i=0;i<geoms.length;i++){
   if(i===f||removed.has(i))continue;const b=boxes[i];
   if(![0,1,2].every(k=>b[k]>=frame[k]-EPS&&b[k+3]<=frame[k+3]+EPS))continue;
   if(b[2]>z[1]+EPS||b[5]<z[2]-EPS)continue;
   if(!projectedContains(geoms[i],(b[tangent]+b[tangent+3])/2,(b[2]+b[5])/2,tangent))continue;
   panels.push(i);
  }
  panels.sort((a,b)=>boxes[a][tangent]-boxes[b][tangent]);
  if(panels.length<1||panels.length>2)continue;
  const covered=panels.reduce((sum,i)=>sum+boxes[i][tangent+3]-boxes[i][tangent],0);
  if(covered<(u[2]-u[1])*.85||Math.abs(boxes[panels[0]][tangent]-u[1])>.03||Math.abs(boxes[panels.at(-1)][tangent+3]-u[2])>.03)continue;
  if(!g.sourceGeometryId)continue;
  const frameRef=g.sourceGeometryId,sourceId=source.sourceId+'/opening/'+frameRef;
  const token=createHash('sha256').update(sourceId).digest('hex').slice(0,12);
  const b=frame.slice();b[tangent]=u[1];b[tangent+3]=u[2];b[2]=z[1];b[5]=z[2];
  const center=[(b[0]+b[3])/2,(b[1]+b[4])/2,(b[2]+b[5])/2];
  const leaves=panels.map((i,j)=>{
   removed.add(i);const p=boxes[i],side=panels.length===1?-1:j===0?-1:1;
   const hinge=center.slice();hinge[tangent]=side<0?p[tangent]:p[tangent+3];hinge[2]=p[2];
   const closed=axis===0?[0,-side]:[-side,0];
   const inward=axis===0?[Math.sign(source.siteCenter[0]-center[0])||1,0]:[0,Math.sign(source.siteCenter[1]-center[1])||1];
   const angle=Math.atan2(closed[0]*inward[1]-closed[1]*inward[0],closed[0]*inward[0]+closed[1]*inward[1]);
   return {name:`DOOR_${token}_${j}`,hinge,kind:'swing',angle,side,width:p[tangent+3]-p[tangent],height:p[5]-p[2],thickness:p[axis+3]-p[axis],
     closedDir:closed,geometry:merge([geoms[i]]),color:source.color,sourceGeometryId:geoms[i].sourceGeometryId};
  });
  doors.push({id:sourceId,sourceId,sourceExpressId:source.id,sourceFile:source.file,sourceType:source.type,
   roleEvidence:'same-object-frame-and-solid-panels',name:source.name+' · 检修门',category:source.category,
   kind:'swing',axis:axis===0?'x':'y',width:b[tangent+3]-b[tangent],height:b[5]-b[2],thickness:b[axis+3]-b[axis],
   bbox:b,center,bottom:b[2],top:b[5],material:'source',sourceGeometryDoor:true,leaves});
 }
 return {geoms:geoms.filter((g,i)=>!removed.has(i)),doors};
}
module.exports={splitCompositeDoors,bounds,projectedContains};
