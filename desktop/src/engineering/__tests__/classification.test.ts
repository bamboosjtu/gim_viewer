import {expect,it} from 'vitest';
import {interpretRecognitionObject} from '../classify.js';
import {declaredObject} from './evidenceFixtures.js';
const value=(value:string,evidenceId=value)=>({value,evidenceId});
it('retains confirmed type facts when a name describes another object',()=>{
 expect(interpretRecognitionObject(declaredObject('x','油浸式变压器',{typeCategory:'E06'}))).toMatchObject({category:'E06',classificationStatus:'confirmed',meaning:'object'});
});
it('keeps same-context contradictory attributes unresolved',()=>{
 expect(interpretRecognitionObject(declaredObject('x','unknown',{typeCategory:'E06',propertyCategories:[value('E07')]}))).toMatchObject({category:'U-OBJECT',basis:'attribute_conflict'});
});
it('retains candidates from different attribute contexts',()=>{
 const properties=[{...value('E06'),context:{section:'设计'}},{...value('E07'),context:{section:'产品'}}];
 expect(interpretRecognitionObject(declaredObject('x','unknown',{typeCategory:'E06',propertyCategories:properties}))).toMatchObject({category:'E06',basis:'contextual_category_candidates',classificationStatus:'candidate'});
});
it('uses the catalog name only as a candidate and never as a component role',()=>{
 expect(interpretRecognitionObject(declaredObject('x','油浸式变压器'))).toMatchObject({classificationStatus:'candidate',meaning:'object'});
 expect(interpretRecognitionObject(declaredObject('x','控制柜'))).toMatchObject({independent:false,classificationStatus:'candidate'});
 expect(interpretRecognitionObject(declaredObject('x','本体端子箱'))).toMatchObject({meaning:'object'});
});
it.each(['part','independent','source_only','detail','container'])('honors explicit object role %s',role=>{
 const result=interpretRecognitionObject(declaredObject('x','unknown',{objectRoles:[value(role)]}));
 expect(role==='independent'?result.independent:result.meaning).toBe(role==='independent'?true:role);
 expect(result.objectRole?.status).toBe('confirmed');
});
it('rejects contradictory part and independent roles',()=>{
 expect(interpretRecognitionObject(declaredObject('x','unknown',{objectRoles:[value('part'),value('independent')]}))).toMatchObject({basis:'attribute_conflict',category:'U-OBJECT'});
});
