import {it,expect} from 'vitest';
import {RepresentationAddressIndex} from '../representationAddresses.js';
it('queries addresses without a semantic model and distinguishes same-template occurrences',()=>{
  const index=new RepresentationAddressIndex([
    {kind:'dev',sourceId:'first',rootOccurrence:'r',assemblyPath:'sub:0',devPath:'same.dev'},
    {kind:'dev',sourceId:'second',rootOccurrence:'r',assemblyPath:'sub:1',devPath:'same.dev'},
    {kind:'ifc',sourceId:'first',modelId:'m',expressId:3,globalId:'guid'},
  ]);
  expect(index.sourcesForDev('r',{assemblyPath:'sub:0/phm:1'})).toEqual(['first']);
  expect(index.sourcesForDev('r',{devPath:'SAME.DEV'})).toEqual(['first','second']);
  expect(index.sourcesForIfc('m',3)).toEqual(['first']);
  expect(index.sourcesForIfc('other',3)).toEqual([]);
  expect(index.bySource.get('first')).toHaveLength(2);
});
