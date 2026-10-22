import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { IfcRegionalRuntime } from '../ifcRegionalRuntime.js';

it('memory pressure retains visible/selected detail, restores the far representation for offscreen detail and releases idle WASM', async () => {
  const camera = new THREE.PerspectiveCamera(60,1,0.1,100);
  camera.lookAt(0,0,-1); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const object = (expressId:number,bounds:number[])=>({expressId,globalId:String(expressId),name:'member',ifcType:'IFCMEMBER',bounds});
  const visible=object(1,[-1,-1,-5,1,1,-4]),offscreen=object(2,[99,99,99,101,101,101]),selected=object(3,[99,99,99,101,101,101]);
  const model={modelId:'m',object:new THREE.Group(),setVisible:vi.fn(async()=>{}),getItemsIdsWithGeometry:vi.fn(async()=>[])};
  const runtime=new IfcRegionalRuntime('m','CBM/m.ifc',{objects:[visible,offscreen,selected],unitScale:1,openingRelations:[]},{
    ctx:{world:{scene:{three:new THREE.Scene()},camera:{three:camera,controls:{addEventListener:vi.fn(),removeEventListener:vi.fn()}}},
      fragments:{list:{onBeforeDelete:{add:vi.fn(),remove:vi.fn()}}}} as any,
    model,readBytes:vi.fn(),cacheKey:'key',isCurrent:()=>true,sourceToViewer:new THREE.Matrix4(),
  });
  const internal=runtime as any;
  const groups=[1,2,3].map(id=>{const group=new THREE.Group();group.userData={expressId:id,lod:id===3?2:1};return group;});
  groups.forEach((group,i)=>{internal.groups.set(i+1,group);runtime.root.add(group);internal.localIds.set(i+1,100+i);});
  internal.selectedExpressId=3;
  const worker={terminate:vi.fn()};internal.worker=worker;
  const fineSource={hasModel:()=>true,cancel:vi.fn(),release:vi.fn()}; internal.fineRuntime=fineSource;
  try {
    runtime.setMemoryPressure('critical');expect(worker.terminate).toHaveBeenCalledOnce();
    expect(fineSource.cancel).toHaveBeenCalledOnce();
    await internal.update();
    expect(internal.groups.has(1)).toBe(true);expect(internal.groups.has(3)).toBe(true);
    expect(internal.groups.has(2)).toBe(false);
    expect(model.setVisible).toHaveBeenCalledWith([101],true);
    expect(await runtime.refine(selected)).toBe(groups[2]);
    await expect(runtime.refine(offscreen)).rejects.toThrow('内存压力');
    runtime.setMemoryPressure('normal');expect(runtime.diagnostics.memoryPressure).toBe('normal');
  } finally { runtime.release(); }
});
