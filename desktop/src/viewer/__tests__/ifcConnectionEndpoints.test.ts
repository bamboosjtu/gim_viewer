import {expect,it} from 'vitest';
import {readConnectionEndpointEvidence} from '../ifcConnectionEndpoints.js';
import {validEndpointEvidence} from '../../gim/connectionEndpoints.js';

const uuid='12345678-1234-1234-1234-123456789abc';
const value=(value:unknown)=>({value});
function fixture(extra:Record<number,any>={}) {
 const rows:Record<number,any>={
  1:{GlobalId:value('wire'),Name:value('软导体')},2:{GlobalId:value('device')},
  10:{RelatedObjects:[value(1)],RelatingPropertyDefinition:value(11)},
  11:{Name:value('A相序终端关联模型接线点GUID'),HasProperties:[value(12),value(13)]},
  12:{Name:value('接线点0'),NominalValue:value(`{${uuid.toUpperCase()}}`)},
  13:{Name:value('接线点1'),Description:value(uuid),NominalValue:value('not-a-guid')},
  20:{RelatingPort:value(30),RelatedElement:value(1)},21:{RelatingPort:value(31),RelatedElement:value(2)},
  22:{RelatingPort:value(30),RelatedPort:value(31)},...extra};
 const types:Record<string,number[]>={IFCBUILDINGELEMENTPROXY:[1],IFCRELDEFINESBYPROPERTIES:[10],
  IFCRELCONNECTSPORTTOELEMENT:[20,21],IFCRELCONNECTSPORTS:[22]};
 const codes=Object.keys(types);
 const api={GetTypeCodeFromName:(name:string)=>codes.indexOf(name)+1,
  GetLineIDsWithType:(_m:number,code:number)=>({size:()=>types[codes[code-1]].length,get:(i:number)=>types[codes[code-1]][i],delete:()=>{}}),
  GetLine:(_m:number,id:number)=>rows[id]};
 return {api:api as any,rows,types};
}
it('retains explicit GUID property provenance and standard port links without treating Description as identity',()=>{
 const {api}=fixture(),rows=readConnectionEndpointEvidence(api,0).get(1)!;
 expect(rows).toEqual([
  {kind:'gim-connect-guid',reference:uuid.toUpperCase(),relationId:10,propertyId:12,propertySet:'A相序终端关联模型接线点GUID',propertyName:'接线点0'},
  {kind:'ifc-element',reference:'device',relationId:22,viaPortIds:[30,31]},
 ]);
 expect(validEndpointEvidence(rows)).toBe(true);
});
it('keeps multiple explicit port owners as candidates rather than selecting an arbitrary element',()=>{
 const {api,rows,types}=fixture({3:{GlobalId:value('second-device')},23:{RelatingPort:value(31),RelatedElement:value(3)}});
 types.IFCRELCONNECTSPORTTOELEMENT.push(23);
 expect(readConnectionEndpointEvidence(api,0).get(1)!.filter(r=>r.kind==='ifc-element').map(r=>r.reference)).toEqual(['device','second-device']);
 rows[11].Name=value('unrelated GUID notes');
 expect(readConnectionEndpointEvidence(api,0).get(1)!.every(r=>r.kind==='ifc-element')).toBe(true);
});
it('rejects malformed optional endpoint metadata at the persistence/stream boundary',()=>{
 expect(validEndpointEvidence([{kind:'gim-connect-guid',reference:'bad',relationId:1}])).toBe(false);
 expect(validEndpointEvidence([{kind:'ifc-element',reference:'g',relationId:-1}])).toBe(false);
 expect(validEndpointEvidence(Array(129).fill({kind:'ifc-element',reference:'g',relationId:1}))).toBe(false);
});
