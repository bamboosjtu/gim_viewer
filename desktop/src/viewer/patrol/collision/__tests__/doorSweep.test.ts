import {it,expect} from 'vitest';
import {Box3,Matrix4,Vector3} from 'three';
import {buildPatrolAsset,type PlacedAsset} from '../patrolGeometry.js';
import {doorSweepObstruction} from '../doorSweep.js';
import {doorRange,type DoorMotionDescriptor} from '../../doorMotion.js';
const identity=new Matrix4(),gate:DoorMotionDescriptor={sourceId:'product',leafRepresentationId:'22',hingePosition:[0,0,0],closedTip:[2,0,0],hingeAxis:[0,0,1],closedAngle:0,openAngle:Math.PI/2,radius:2,evidence:['preview-swing']};
function placed(id:string,coords:number[]):PlacedAsset{return {id,matrix:identity,inverse:identity,mirror:false,support:false,asset:buildPatrolAsset([{positions:Float32Array.from(coords),indices:Uint32Array.from([0,1,2,0,2,3]),matrix:identity.toArray()}])};}
it('distinguishes a person in the sweep, an independent obstacle, and a clear arc from a safe operating position',async()=>{
 const leaf=placed('product/leaf/22',[0,0,0,2,0,0,2,0,2,0,0,2]),wall=placed('wall',[-1,.8,0,2,.8,0,2,.8,2,-1,.8,2]);
 const area=doorRange(gate,new Box3(new Vector3(),new Vector3(2,.05,2)));
 const run=(feet:Vector3,others:PlacedAsset[])=>doorSweepObstruction(gate,identity,area,leaf,new Map(others.map(o=>[o.id,o])),feet,new AbortController().signal);
 expect(await run(new Vector3(.8,.8,0),[])).toEqual({kind:'person'});
 expect(await run(new Vector3(-5,0,0),[wall])).toEqual({kind:'obstacle',id:'wall'});
 expect(await run(new Vector3(-5,0,0),[])).toBeUndefined();
});
