import {expect,it} from 'vitest';
import {ByteWorkBudget} from '../byteWorkBudget.js';
it('bounds concurrent consumers, releases once and rejects obsolete waiters',async()=>{
  const budget=new ByteWorkBudget(100);const a=await budget.acquire(70);let entered=false;
  const pending=budget.acquire(40).then(release=>{entered=true;return release;});await Promise.resolve();expect(entered).toBe(false);
  a();a();const b=await pending;expect(budget.bytes).toBe(40);expect(budget.peakBytes).toBe(70);
  const blocked=budget.acquire(100);const rejected=expect(blocked).rejects.toMatchObject({name:'AbortError'});
  budget.close();await rejected;b();expect(budget.bytes).toBe(0);
  await expect(budget.acquire(1)).rejects.toMatchObject({name:'AbortError'});
});
it('oversized results fail without blocking later valid work',async()=>{
  const budget=new ByteWorkBudget(10);await expect(budget.acquire(11)).rejects.toThrow('exceeds');
  const release=await budget.acquire(10);release();expect(budget.bytes).toBe(0);
});
