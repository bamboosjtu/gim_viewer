import {afterEach,expect,it,vi} from 'vitest';
import {ByteWorkBudget} from '../../utils/byteWorkBudget.js';
import {DevTemplateCacheReader} from '../devTemplateCacheReader.js';
const read=vi.hoisted(()=>vi.fn());
vi.mock('@desktop/devLodCache.js',()=>({readDevArtifactBatch:read}));
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();});
it('shares one byte reservation and keeps deferred rows out of the miss path',async()=>{
  vi.useFakeTimers();const budget=new ByteWorkBudget(128),reader=new DevTemplateCacheReader<number>(budget,{projectId:1,sourceSha256:'sha'});
  read.mockImplementationOnce(async(_store,keys)=>{expect(keys).toEqual(['a','b','c']);return new Map([
    ['a',{status:'hit',value:1}],['b',{status:'miss'}],['c',{status:'deferred'}]]);})
    .mockImplementationOnce(async(_store,keys)=>{expect(keys).toEqual(['c','d']);return new Map([
      ['c',{status:'hit',value:3}],['d',{status:'hit',value:4}]]);});
  const a=reader.read('a'),b=reader.read('b'),c=reader.read('c');await vi.advanceTimersByTimeAsync(0);
  const la=await a,lb=await b;expect(la.status).toBe('hit');expect(la.value).toBe(1);expect(lb.status).toBe('miss');
  const d=reader.read('d');la.release();la.release();expect(budget.bytes).toBe(128);expect(read).toHaveBeenCalledTimes(1);
  lb.release();await vi.advanceTimersByTimeAsync(0);const lc=await c,ld=await d;
  expect(lc.status).toBe('hit');expect(lc.value).toBe(3);expect(ld.status).toBe('hit');expect(ld.value).toBe(4);lc.release();ld.release();
  expect(budget.bytes).toBe(0);expect(budget.peakBytes).toBe(128);
  expect(reader.diagnostics).toMatchObject({batches:2,entries:4,deferred:1,hits:3,misses:1});
  reader.close();
});
it('reports a per-row read-error instead of converting it to a miss or rejecting the batch',async()=>{
  vi.useFakeTimers();const budget=new ByteWorkBudget(128),reader=new DevTemplateCacheReader<number>(budget,{projectId:1,sourceSha256:'sha'});
  read.mockResolvedValue(new Map([['a',{status:'read-error',error:'db locked'}]]));
  const a=reader.read('a');await vi.advanceTimersByTimeAsync(0);const lease=await a;
  expect(lease.status).toBe('read-error');expect(lease.error).toContain('db locked');expect(reader.diagnostics.readErrors).toBe(1);
  lease.release();expect(budget.bytes).toBe(0);reader.close();
});
it('rejects queued requests on close and releases outstanding consumers exactly once',async()=>{
  vi.useFakeTimers();const budget=new ByteWorkBudget(128),reader=new DevTemplateCacheReader(budget,{projectId:1,sourceSha256:'sha'});
  read.mockResolvedValue(new Map([['a',{status:'hit',value:{}}]]));const a=reader.read('a');await vi.advanceTimersByTimeAsync(0);const lease=await a;
  const b=reader.read('b'),rejected=expect(b).rejects.toMatchObject({name:'AbortError'});reader.close();await rejected;
  lease.release();expect(budget.bytes).toBe(0);budget.close();
});
