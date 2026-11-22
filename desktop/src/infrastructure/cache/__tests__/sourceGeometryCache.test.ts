import {it,expect} from 'vitest';
import {encodeSourceGeometryCache,decodeSourceGeometryCache} from '../sourceGeometryCache.js';
import type {SourceGeometryOccurrenceCatalog} from '@gim/gim-sdk/geometry';

it('deduplicates repeated physical identities and applies the budget to actual UTF-8 bytes',async()=>{
  const parent='cbm:'+'a'.repeat(990),matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const catalog:SourceGeometryOccurrenceCatalog={occurrences:Array.from({length:4000},(_,i)=>({id:`dev:${parent}/${i}`,sourceId:`dev:${parent}/${i}`,sourceContextId:parent,devPath:'a.dev',name:'支柱绝缘子',placementMatrix:matrix})),diagnostics:[]};
  const oldEstimate=catalog.occurrences.reduce((n,r)=>n+512+3*(r.id.length+r.sourceId.length+r.sourceContextId.length+r.devPath.length+r.name.length),0);
  expect(oldEstimate).toBeGreaterThan(32*1024*1024);
  const bytes=await encodeSourceGeometryCache('scope',catalog);expect(bytes).toBeDefined();expect(bytes!.length).toBeLessThan(8*1024*1024);
  expect(decodeSourceGeometryCache(bytes!,'scope',new Map([['a.dev',{}]]))).toEqual(catalog);
});

it('keeps source scope, entry and matrix guards on the compact cache',async()=>{
  const catalog:SourceGeometryOccurrenceCatalog={occurrences:[{id:'a',sourceId:'a',sourceContextId:'c',devPath:'a.dev',name:'a',placementMatrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],diagnostics:[{sourceContextId:'c',documentPath:'x.cbm',reason:'missing-source-reference'}]};
  const bytes=(await encodeSourceGeometryCache('scope',catalog))!;
  expect(() => decodeSourceGeometryCache(bytes,'other',new Map([['a.dev',{}]]))).toThrow('identity');
  expect(() => decodeSourceGeometryCache(bytes,'scope',new Map())).toThrow('occurrence');
  expect(decodeSourceGeometryCache(bytes,'scope',new Map([['a.dev',{}]]))).toEqual(catalog);
});
