import {expect,it} from 'vitest';
import {COMPONENT_CATALOG} from '../catalog/catalogLabels.js';
import {componentHostCompatibility} from '../compositionPolicy.js';
import {interpretObject} from '../classify.js';
import {toObjectEvidence} from '../../adapters/recognizeSource.js';
it.each(COMPONENT_CATALOG.flatMap(part=>(part.id==='cabinet_led'?[part.label]:[part.term,part.label]).map(word=>({part,word}))))('matches component $word with its own evidence namespace',({part,word})=>{
 const result=interpretObject(toObjectEvidence({id:'x',name:'unknown',source:'a.dev',source_type:word,parent:'',track:'dev',guid:'',sources:[],context:[],properties:[{keys:['OBJECTROLE'],value:'part',path:'a.fam'}]}));
 const expectedId=word==='ProtectionEquipment'?'protective_device':part.id;
 expect(result).toMatchObject({meaning:'part',componentType:{id:expectedId,status:'confirmed'}});if(part.id==='ground_resistance')expect(result.standardClass?.id).toBe('material:groundresistance');else expect(result.standardClass).toBeUndefined();expect(result.equipmentType).toBeUndefined();
});
it('represents unknown compatibility distinctly from a compatible or incompatible host',()=>{
 expect(componentHostCompatibility({componentType:{id:'radiator'}},{category:'E-T'})).toBe('compatible');
 expect(componentHostCompatibility({componentType:{id:'radiator'}},{category:'E05'})).toBe('compatible');
 expect(componentHostCompatibility({componentType:{id:'ladder'}},{category:'E-T'})).toBe('compatible');
});

it('rejects non-equipment hosts and retains unknown host kinds',()=>{expect(componentHostCompatibility({}, {category:'M06'})).toBe('incompatible');expect(componentHostCompatibility({}, {category:'U-OBJECT'})).toBe('unconfigured');});
