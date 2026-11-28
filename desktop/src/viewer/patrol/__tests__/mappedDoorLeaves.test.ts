import {expect,it} from 'vitest';
import {BoxGeometry,Matrix4} from 'three';
import {mappedDoorLeaves} from '../mappedDoorLeaves.js';
function panel(x:number,id:number){const g=new BoxGeometry(1,2,.05);const p=g.getAttribute('position'),vertices=new Float32Array(p.count*6);
 for(let i=0;i<p.count;i++)vertices.set([p.getX(i),p.getY(i),p.getZ(i),0,1,0],i*6);
 return {geometryId:id,vertices,indices:Uint32Array.from(g.index!.array),matrix:new Matrix4().makeTranslation(x,1,0).toArray(),color:[1,1,1,1]};}
it('assigns the two actual touching panels to separate hinges, leaving other types static',()=>{
 const a=panel(-.5,11),b=panel(.5,12),ls=mappedDoorLeaves('IFCBUILDINGELEMENTPROXY','平开大门',[a,b]);expect(ls.map(l=>l.parts)).toEqual([[0],[1]]);expect(ls[0].motion.hingePosition[0]).toBeCloseTo(-1,1);expect(ls[1].motion.hingePosition[0]).toBeCloseTo(1,1);
 expect(mappedDoorLeaves('IFCBUILDINGELEMENTPROXY','墙体',[a,b])).toEqual([]);expect(mappedDoorLeaves('IFCBUILDINGELEMENTPROXY','平开大门',[a,panel(3,13)])).toEqual([]);
});
