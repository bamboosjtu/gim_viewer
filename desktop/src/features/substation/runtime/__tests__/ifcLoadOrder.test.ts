import {expect,it} from 'vitest';
import {planSubstationIfcLoad, prioritizeIfcEntries} from '../ifcLoadOrder.js';
import type { CbmNode } from '../../../../gim/types.js';
it('preserves the real first-source anchor while promoting evidenced connections ahead of other large IFCs',()=>{
 const entries=['anchor','ordinary','huge','connection','connection2'].map(modelId=>({modelId,path:`CBM/${modelId}.ifc`}));
 const sizes=new Map([['cbm/anchor.ifc',128*1024*1024],['cbm/huge.ifc',128*1024*1024],['cbm/connection.ifc',452*1024*1024]]);
 const original=entries.slice();
 expect(prioritizeIfcEntries(entries,sizes,new Set(['connection','connection2'])).map(e=>e.modelId))
  .toEqual(['anchor','connection2','ordinary','connection','huge']);
 expect(entries).toEqual(original);
 expect(prioritizeIfcEntries(entries,sizes,new Set(['anchor'])).map(e=>e.modelId)).toEqual(['anchor','ordinary','connection2','huge','connection']);
});

it('keeps the original anchor and a CBM-evidenced neutral IFC when skipping large sources',()=>{
 const entries=['anchor','huge','ordinary','model2'].map(modelId=>({modelId,name:modelId,path:`CBM/${modelId}.ifc`}));
 const bytes=128*1024*1024;
 const sizes=new Map(['anchor','huge','model2'].map(id=>[`cbm/${id}.ifc`,bytes]));
 const node:CbmNode={
   path:'CBM/connection.cbm',name:'软导体',ifcFile:'CBM/model2.ifc',ifcGuid:'guid',children:[],
   entityName:'F4',famPath:'',devPath:'',classifyName:'',transformMatrix:'',systemNames:[],
   devSymbolName:'',devType:'',devExpanded:false,
 };
 const plan=planSubstationIfcLoad(entries,sizes,node,true);
 expect(plan.queue.map(entry=>entry.modelId)).toEqual(['anchor','ordinary','model2']);
 expect(plan.skippedLargeIfc).toEqual([{path:'CBM/huge.ifc',bytes}]);
 expect(plan.evidencedConnections).toEqual(new Set(['model2']));
});

it('uses current file sizes for the queue without mutating saved sizes', () => {
  const entries = ['anchor','other'].map(modelId => ({modelId,name:modelId,path:`Models/${modelId}.ifc`}));
  const sizes = new Map([['models/other.ifc',1]]);
  const size = 128 * 1024 * 1024;
  const files = new Map([['models/OTHER.ifc', {size} as File]]);
  const plan = planSubstationIfcLoad(entries,sizes,null,true,files);

  expect(plan.sizes.get('models/other.ifc')).toBe(size);
  expect(sizes.get('models/other.ifc')).toBe(1);
  expect(plan.queue.map(entry => entry.modelId)).toEqual(['anchor']);
  expect(plan.skippedLargeIfc).toEqual([{path:'Models/other.ifc',bytes:size}]);
});
