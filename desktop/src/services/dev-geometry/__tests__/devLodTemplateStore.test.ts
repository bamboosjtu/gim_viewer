import {it,expect} from 'vitest';
import {DevLodTemplateStore,type DevLodTemplateStoreOptions} from '../devLodTemplateStore.js';
it('releases the occupied slot once and rejects queued work when its session ends',async()=>{
 const store=new DevLodTemplateStore({current:()=>true,worker:()=>({cacheConcurrency:1}),session:{}} as unknown as DevLodTemplateStoreOptions);
 const release=await store.acquireTemplateSlot('a');
 const pending=store.acquireTemplateSlot('b');const rejection=expect(pending).rejects.toMatchObject({name:'AbortError'});store.cancel();await rejection;
 release();release();expect(store.templateSlots).toBe(0);
});
