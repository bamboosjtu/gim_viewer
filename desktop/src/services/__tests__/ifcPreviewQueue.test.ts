import { describe,it,expect } from 'vitest';
import { planRemainingIfcPreviews } from '../ifcPreviewQueue.js';
const entries=['anchor','large','normal','small-a','unknown','small-b'].map(path=>({path,name:path,modelId:path}));
const sizes=new Map([['anchor',200_000_000],['large',100_000_000],['normal',4_000_000],['small-a',10],['small-b',30]]);
describe('single-worker Preview queue planning',()=>{
 it('original remains exactly ordered and input identities unchanged',()=>expect(planRemainingIfcPreviews(entries,sizes,'original')).toEqual(entries));
 it('anchor fixed; stable bins; unknown normal; no mutation or new identity',()=>{
  const result=planRemainingIfcPreviews(entries,sizes,'conservative-fast-lane');
  expect(result.map(e=>e.path)).toEqual(['anchor','small-a','small-b','normal','unknown','large']);
  expect(result.every(e=>entries.includes(e))).toBe(true);
  expect(entries.map(e=>e.path)).toEqual(['anchor','large','normal','small-a','unknown','small-b']);
 });
 it('missing metadata preserves order',()=>expect(planRemainingIfcPreviews(entries,new Map(),'conservative-fast-lane')).toEqual(entries));
});
