import {expect,it} from 'vitest';
import {requirementContext} from '../requirements.js';
it('requires explicit standard/model context and exposes only field-verified facts',()=>{
  const input={standardVersion:'Q/GDW 11810.1—2023',equipmentType:'gis',modelType:'generic' as const};
  const result=requirementContext(input);
  expect(result.applicableRequirements.find(r=>r.componentName==='母线')?.fields.specialRequirements.value).toBe('独立气室分开建模');
  expect(requirementContext({...input,modelType:undefined}).status).toBe('unknown');
  expect(requirementContext({...input,standardVersion:'unknown'}).applicableRequirements).toEqual([]);
  const fields=result.applicableRequirements[0].fields;fields.componentName.value='mutated';
  expect(requirementContext(input).applicableRequirements[0].fields.componentName.value).not.toBe('mutated');
  const partial=result.applicableRequirements.find(r=>r.componentName?.includes('土建接口'));
  expect(partial?.fields.componentName.evidence.verification).toBe('verified');expect(partial?.fields.genericModel).toBeUndefined();
});
