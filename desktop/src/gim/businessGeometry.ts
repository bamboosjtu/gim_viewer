import type {BusinessShape,BusinessSpatialInput,BusinessTreeProjection} from './businessTree.js';

export const BUSINESS_GEOMETRY_EPSILON=1e-6;
export function businessGeometryShapes(p:BusinessTreeProjection,input:BusinessSpatialInput):Map<string,BusinessShape[]> {
  const result=new Map<string,BusinessShape[]>();
  for(const shape of input.shapes??[]){
    const key=p.objectBySource.get(shape.objectKey)??shape.objectKey;
    if(!p.objects.has(key)||shape.evidence!=='geometry'||![...shape.min,...shape.max].every(Number.isFinite)||shape.min.some((v,i)=>v>shape.max[i]||shape.max[i]-v>500))continue;
    const list=result.get(key)??[];list.push(shape);result.set(key,list);
  }
  return result;
}
export const centreOfBusinessShape=(s:BusinessShape):number[]=>s.min.map((v,i)=>(v+s.max[i])/2);
export const overlapBusinessShapes=(a:BusinessShape,b:BusinessShape,axes=[0,1,2],buffer=BUSINESS_GEOMETRY_EPSILON):boolean=>axes.every(i=>a.min[i]<=b.max[i]+buffer&&b.min[i]<=a.max[i]+buffer);
export const containsBusinessShape=(a:BusinessShape,b:BusinessShape):boolean=>[0,1,2].every(i=>a.min[i]<=b.min[i]+BUSINESS_GEOMETRY_EPSILON&&a.max[i]+BUSINESS_GEOMETRY_EPSILON>=b.max[i]);
export const businessPlanDistance=(point:readonly number[],box:BusinessShape):number=>Math.hypot(...[0,1].map(i=>Math.max(0,box.min[i]-point[i],point[i]-box.max[i])));
export function unionBusinessShapes(shapes:readonly BusinessShape[]):BusinessShape|undefined {
  if(!shapes.length)return;
  const min:[number,number,number]=[Infinity,Infinity,Infinity],max:[number,number,number]=[-Infinity,-Infinity,-Infinity];
  for(const shape of shapes)for(let i=0;i<3;i++){min[i]=Math.min(min[i],shape.min[i]);max[i]=Math.max(max[i],shape.max[i]);}
  return {objectKey:'',min,max,evidence:'geometry'};
}
