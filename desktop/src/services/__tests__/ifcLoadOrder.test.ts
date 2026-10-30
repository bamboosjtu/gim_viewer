import {expect,it} from 'vitest';
import {prioritizeIfcEntries} from '../ifcLoadOrder.js';
it('preserves the real first-source anchor while promoting evidenced connections ahead of other large IFCs',()=>{
 const entries=['anchor','ordinary','huge','connection','connection2'].map(modelId=>({modelId,path:`CBM/${modelId}.ifc`}));
 const sizes=new Map([['cbm/anchor.ifc',128*1024*1024],['cbm/huge.ifc',128*1024*1024],['cbm/connection.ifc',452*1024*1024]]);
 const original=entries.slice();
 expect(prioritizeIfcEntries(entries,sizes,new Set(['connection','connection2'])).map(e=>e.modelId))
  .toEqual(['anchor','connection2','ordinary','connection','huge']);
 expect(entries).toEqual(original);
 expect(prioritizeIfcEntries(entries,sizes,new Set(['anchor'])).map(e=>e.modelId)).toEqual(['anchor','ordinary','connection2','huge','connection']);
});
