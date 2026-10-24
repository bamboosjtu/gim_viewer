import {expect,it} from 'vitest';
import {buildCbmTree} from '../cbmParser.js';
import {GlConnectionPortIndex} from '../glConnectionPorts.js';
const uuid='12345678-1234-1234-1234-123456789abc',port='87654321-4321-4321-4321-cba987654321';
function filesOf(raw:Record<string,string>):Map<string,File>{return new Map(Object.entries(raw).map(([path,text])=>[path,{name:path,text:async()=>text} as File]));}
const gl=`<Device><Entities><Entity ID="4"><GimGeCableConcentration ConnectGuid="${port}" Phase="A"/></Entity></Entities></Device>`;
it('uses same-UUID DEV occurrences, preserves shared GUID candidates and does not invent geometry',async()=>{
 const files=filesOf({'CBM/project.cbm':'ENTITYNAME=F1System\nSUBSYSTEMS.NUM=2\nSUBSYSTEM0=a.cbm\nSUBSYSTEM1=b.cbm',
  'CBM/a.cbm':`ENTITYNAME=F4System\nOBJECTMODELPOINTER=${uuid}.dev`,
  'CBM/b.cbm':`ENTITYNAME=F4System\nOBJECTMODELPOINTER=${uuid}.dev`,[`DEV/${uuid}.dev`]:'SOLIDMODELS.NUM=0',
  [`MOD/${uuid}.gl`]:gl});
 const root=await buildCbmTree(files),index=new GlConnectionPortIndex(root,[...files.keys()],new Map([[`MOD/${uuid}.gl`,gl]]));
 const owners=index.get(port);expect(owners).toHaveLength(2);expect(new Set(owners.map(o=>o.key)).size).toBe(2);
 expect(owners.every(o=>o.entityId==='4'&&o.phase==='A'&&o.localMatrix.length===16)).toBe(true);
 expect(index.get(`{${port.toUpperCase()}}`)).toEqual(owners);
 files.delete(`DEV/${uuid}.dev`);
 expect(new GlConnectionPortIndex(root,[...files.keys()],new Map([[`MOD/${uuid}.gl`,gl]])).get(port)).toEqual([]);
});
it('rejects unsafe XML and unrelated sidecars without guessing a device',()=>{
 const paths=[`DEV/${uuid}.dev`,`MOD/${uuid}.gl`];
 expect(new GlConnectionPortIndex(null,paths,new Map([[paths[1],'<!DOCTYPE x [<!ENTITY e "x">]><Device/>']])).get(port)).toEqual([]);
});
