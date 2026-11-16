import {expect,it} from 'vitest';
import {COMPONENT_CATALOG} from '../../../engineering/catalogLabels.js';
import {componentHostCompatibility} from '../../../engineering/compositionPolicy.js';
import {interpretObject} from '../../../engineering/classify.js';
import {toObjectEvidence} from '../sourceEvidence.js';
it.each(COMPONENT_CATALOG.flatMap(part=>[part.term,part.label].map(word=>({part,word}))))('matches component $word with its own evidence namespace',({part,word})=>{
 const result=interpretObject(toObjectEvidence({id:'x',name:'unknown',source:'a.dev',source_type:word,parent:'',track:'dev',guid:'',sources:[],context:[],properties:[{keys:['OBJECTROLE'],value:'part',path:'a.fam'}]}));
 const ambiguous=word===part.term&&new Set(COMPONENT_CATALOG.filter(p=>p.term===word).map(p=>p.label)).size>1;
 expect(result).toMatchObject({meaning:'part',componentType:{id:part.id,status:ambiguous?'candidate':'confirmed'}});expect(result.standardClass).toBeUndefined();expect(result.equipmentType).toBeUndefined();
});
it('represents unknown compatibility distinctly from a compatible or incompatible host',()=>{
 expect(componentHostCompatibility({componentType:{id:'radiator'}},{category:'E-T'})).toBe('compatible');
 expect(componentHostCompatibility({componentType:{id:'radiator'}},{category:'E05'})).toBe('incompatible');
 expect(componentHostCompatibility({componentType:{id:'ladder'}},{category:'E-T'})).toBe('unconfigured');
});
