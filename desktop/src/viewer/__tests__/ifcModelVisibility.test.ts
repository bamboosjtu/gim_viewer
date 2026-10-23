import { expect, it, vi } from 'vitest';
import { IfcModelVisibility } from '../ifcModelVisibility.js';

function fixture() {
  const visible = new Map([[1,true],[2,true],[3,false]]);
  const model = { modelId:'source', object:{visible:true},
    getItemsIdsWithGeometry:vi.fn(async()=>[1,2,3]),
    getVisible:vi.fn(async(ids:number[])=>ids.map(id=>visible.get(id)!)),
    setVisible:vi.fn(async(ids:number[]|undefined,value:boolean)=>{ for(const id of ids??visible.keys()) visible.set(id,value); }),
    getGuidsByLocalIds:vi.fn(async(ids:number[])=>ids.map(String)),
    getLocalIdsByGuids:vi.fn(async(ids:string[])=>ids.map(Number)),
  };
  return {visible,model,runtime:new IfcModelVisibility(model)};
}
it('composes isolation and detail replacement without reviving previously hidden items',async()=>{
  const f=fixture();await f.runtime.setDetailVisible([2],false);
  await f.runtime.setDetailVisible([3],true);expect(f.visible.get(3)).toBe(false);
  await f.runtime.setScope(new Set([1,2]));
  expect([...f.visible.values()]).toEqual([true,false,false]);
  await f.runtime.setDetailVisible([2],true);
  expect([...f.visible.values()]).toEqual([true,true,false]);
  await f.runtime.setDetailVisible([1],false);
  await f.runtime.setScope(null);
  expect([...f.visible.values()]).toEqual([false,true,false]);
  await f.runtime.setDetailVisible([1],true);
  expect([...f.visible.values()]).toEqual([true,true,false]);
  await f.runtime.setDetailVisible([3],false);await f.runtime.setDetailVisible([3],true);
  expect(f.visible.get(3)).toBe(false);
});
it('hides unrelated sources without enumerating items and preserves a hidden source layer on restore',async()=>{
  const f=fixture();await f.runtime.setScope(new Set());
  expect(f.model.object.visible).toBe(false);expect(f.model.getVisible).not.toHaveBeenCalled();
  f.runtime.setLayerVisible(false);await f.runtime.setScope(new Set([1]));
  expect(f.model.object.visible).toBe(false);
  await f.runtime.setScope(null);expect(f.model.object.visible).toBe(false);
  f.runtime.setLayerVisible(true);expect(f.model.object.visible).toBe(true);
  expect([...f.visible.values()]).toEqual([true,true,false]);
});
it('serializes rapid A to B masks and never exposes a partially applied source',async()=>{
  const f=fixture();let unblock!:()=>void;
  const original=f.model.getVisible.getMockImplementation()!;
  f.model.getVisible.mockImplementationOnce(async ids=>{await new Promise<void>(resolve=>{unblock=resolve;});return original(ids);});
  const a=f.runtime.setScope(new Set([1]));await vi.waitFor(()=>expect(unblock).toBeTypeOf('function'));
  const b=f.runtime.setScope(new Set([2]));f.runtime.setLayerVisible(true);
  expect(f.model.object.visible).toBe(false);
  unblock();await Promise.all([a,b]);
  expect([...f.visible.values()]).toEqual([false,true,false]);expect(f.model.object.visible).toBe(true);
  await f.runtime.setScope(null);expect([...f.visible.values()]).toEqual([true,true,false]);
});
it('does not submit work after release during an item visibility read',async()=>{
  const f=fixture();let unblock!:()=>void;
  f.model.getVisible.mockImplementationOnce(async ids=>{await new Promise<void>(resolve=>{unblock=resolve;});return ids.map(()=>true);});
  const pending=f.runtime.setScope(new Set([1]));await vi.waitFor(()=>expect(unblock).toBeTypeOf('function'));
  f.runtime.release();unblock();await pending;
  expect(f.model.setVisible).not.toHaveBeenCalled();expect(f.model.object.visible).toBe(false);
});
it('reports corrupt visibility results and keeps the source hidden until a successful retry',async()=>{
  const f=fixture();f.model.getVisible.mockResolvedValueOnce([]);
  await expect(f.runtime.setScope(new Set([1]))).rejects.toThrow('length mismatch');
  expect(f.model.object.visible).toBe(false);
  await f.runtime.setScope(new Set([2]));
  expect([...f.visible.values()]).toEqual([false,true,false]);
});
