import {afterEach,expect,it,vi} from 'vitest';
import {ByteWorkBudget} from '../../utils/byteWorkBudget.js';
import {DevTemplateCacheReader} from '../devTemplateCacheReader.js';
const read=vi.hoisted(()=>vi.fn());
vi.mock('@desktop/devLodCache.js',()=>({readDevArtifactBatch:read}));
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();});
it('shares one byte reservation across a batch and retries deferred rows without turning them into misses',async()=>{
  vi.useFakeTimers();const budget=new ByteWorkBudget(128),reader=new DevTemplateCacheReader<number>(budget,{projectId:1,sourceSha256:'sha'});
  read.mockImplementationOnce(async(_store,keys)=>{expect(keys).toEqual(['a','b','c']);return new Map([['a',1],['b',null]]);})
    .mockImplementationOnce(async(_store,keys)=>{expect(keys).toEqual(['c','d']);return new Map([['c',3],['d',4]]);});
  const a=reader.read('a'),b=reader.read('b'),c=reader.read('c');await vi.advanceTimersByTimeAsync(0);
  const la=await a,lb=await b;expect(la.value).toBe(1);expect(lb.value).toBeNull();
  const d=reader.read('d');la.release();la.release();expect(budget.bytes).toBe(128);expect(read).toHaveBeenCalledTimes(1);
  lb.release();await vi.advanceTimersByTimeAsync(0);const lc=await c,ld=await d;
  expect(lc.value).toBe(3);expect(ld.value).toBe(4);lc.release();ld.release();
  expect(budget.bytes).toBe(0);expect(budget.peakBytes).toBe(128);expect(reader.diagnostics).toEqual({batches:2,entries:4,deferred:1});reader.close();
});
it('rejects queued requests on close and releases outstanding consumers exactly once',async()=>{
  vi.useFakeTimers();const budget=new ByteWorkBudget(128),reader=new DevTemplateCacheReader(budget,{projectId:1,sourceSha256:'sha'});
  read.mockResolvedValue(new Map([['a',{}]]));const a=reader.read('a');await vi.advanceTimersByTimeAsync(0);const lease=await a;
  const b=reader.read('b'),rejected=expect(b).rejects.toMatchObject({name:'AbortError'});reader.close();await rejected;
  lease.release();expect(budget.bytes).toBe(0);budget.close();
});
