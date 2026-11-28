import {it,expect} from 'vitest';
import {overviewFields} from '../../ui/overviewFields';
import type {BusinessObject,PowerlineProject} from '@gim/powerline-core';
it('keeps longitude, latitude and zero elevation in Android tower properties',()=>{
 const tower={id:'t',kind:'tower',name:'T',coordinate:[114,30,0],lineIds:[],strainIds:[],attributes:[],relatedIds:[]} as unknown as BusinessObject;
 const rows=overviewFields(tower,new Map(),{objects:[tower]} as PowerlineProject);
 expect(rows).toContainEqual(['纬度','30.0000000°']);expect(rows).toContainEqual(['经度','114.0000000°']);expect(rows.find(([k])=>k==='高程')?.[1]).toBe('0.00 m');
});
