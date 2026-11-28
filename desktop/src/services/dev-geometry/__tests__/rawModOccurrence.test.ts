import {expect,it} from 'vitest';
import {readStandardMod} from '../rawModOccurrence.js';
import {loadXmlModFromText} from '../../../viewer/xmlModLoader.js';
import {Box3} from 'three';
const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,1000,0,0,1];
const xml='<Device><Entities><Entity ID="1"><Cuboid L="20" W="20" H="30"/></Entity></Entities></Device>';
it('places a standalone MOD through the raw inspector path, with an independently keyed local template',async()=>{
 const projection=await readStandardMod({text:async()=>xml} as File,'MOD/a.mod','sha');
 const geo={modPath:'MOD/a.mod',devPath:'d.dev',phmPath:'s.phm',devTransformMatrix:matrix,instanceKey:'A',placementTransformMatrix:matrix,phmTransformMatrix:matrix};
 const g=projection.place!(geo,'tower/A');g.updateMatrixWorld(true);
 expect(g.children[0].userData.geometrySourceAddress.rootOccurrence).toBe('tower/A');
 expect(new Box3().setFromObject(g).min.x).toBeCloseTo(.99);
});
it('preserves the unknown declaration, its raw fields, and the visible sibling through the host fallback',async()=>{
 const text=xml.replace('</Entities>','<Entity ID="2"><VendorShape original="abc"/></Entity></Entities>');
 const p=await readStandardMod({text:async()=>text} as File,'MOD/a.mod','sha');
 expect(p.place).toBeUndefined();expect(p.doc.entities[1].primitive).toMatchObject({type:'Unsupported',sourceType:'VendorShape',raw:{original:'abc'}});
 expect(loadXmlModFromText(text,'MOD/a.mod').userData.__gimXmlModDiagnostics).toMatchObject({status:'partial',unsupportedEntityCount:1,renderableEntityCount:1});
});

it.each([
 ['<BeamChannel Model="[10" Length="1400"/>','y',1.4],
 ['<Cable D="20" StartCoord="0,0,0" EndCoord="1000,0,0"/>','x',1],
] as const)('preserves legacy bounds and material on the compatibility route for %s',async(tag,axis,length)=>{
 const text='<Device><Entities><Entity ID="1">'+tag+'</Entity></Entities></Device>';
 const prepared=await readStandardMod({text:async()=>text} as File,'MOD/legacy.mod','sha');expect(prepared.place).toBeUndefined();
 const group=loadXmlModFromText(text,'MOD/legacy.mod'),bounds=new Box3().setFromObject(group);
 expect(bounds.max[axis]-bounds.min[axis]).toBeCloseTo(length,4);expect(group.userData.__gimXmlModDiagnostics.status).toBe('renderable');
});
