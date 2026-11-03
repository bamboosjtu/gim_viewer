// @vitest-environment node
import {expect,it} from 'vitest';
import {assertGoldenFresh,goldenLine,flatJsonBytes} from '../../../acceptance/engineering/golden.js';

it('rejects stale source/parser fingerprints instead of silently treating old output as an oracle',()=>{
  const expected={sourceSha256:'source',implementationSha256:'parser'};
  expect(()=>assertGoldenFresh(expected,{...expected,sourceSha256:'other'})).toThrow('source SHA');
  expect(()=>assertGoldenFresh(expected,{...expected,implementationSha256:'rules-changed'})).toThrow('stale');
  expect(()=>assertGoldenFresh(expected,{...expected})).not.toThrow();
});
it('canonicalizes property order while preserving ordered children and member differences',()=>{
  expect(goldenLine(['entities','id',{b:2,a:1}])).toBe(goldenLine(['entities','id',{a:1,b:2}]));
  expect(goldenLine(['memberships','id',{ownerId:'a'}])).not.toBe(goldenLine(['memberships','id',{ownerId:'b'}]));
  expect(goldenLine(['composition','id',{children:['a','b']}])).not.toBe(goldenLine(['composition','id',{children:['b','a']}]));
});
it('measures legacy flat JSON exactly without building a single expanded model string',()=>{
  const shared={text:'中文\\换行\n"quoted"'},value={a:[shared,shared,null],b:true,omitted:undefined};
  expect(flatJsonBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
});
