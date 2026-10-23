import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { IfcRegionalRuntime } from '../ifcRegionalRuntime.js';
import { IfcModelVisibility } from '../ifcModelVisibility.js';

it('keeps unrelated regional/fine groups hidden across timer synchronization and layer changes',async()=>{
  vi.useFakeTimers();
  const model={modelId:'A',object:new THREE.Group(),getItemsIdsWithGeometry:async()=>[1,2],
    getVisible:async(ids:number[])=>ids.map(()=>true),setVisible:vi.fn(async()=>{}),
    getGuidsByLocalIds:async(ids:number[])=>ids.map(String),getLocalIdsByGuids:async(ids:string[])=>ids.map(Number)};
  const visibility=new IfcModelVisibility(model);
  const runtime=new IfcRegionalRuntime('A','source.ifc',{objects:[],unitScale:1,openingRelations:[]},{
    ctx:{world:{scene:{three:new THREE.Scene()},camera:{controls:{addEventListener:vi.fn(),removeEventListener:vi.fn()}}},
      fragments:{list:{onBeforeDelete:{add:vi.fn(),remove:vi.fn()}}}} as any,
    model,visibility,readBytes:vi.fn(),cacheKey:'key',isCurrent:()=>true,sourceToViewer:new THREE.Matrix4(),
  });
  const internal=runtime as any;
  const first=new THREE.Group(),second=new THREE.Group();
  first.userData={expressId:1,lod:1};second.userData={expressId:2,lod:2};
  runtime.root.add(first,second);internal.groups.set(1,first);internal.groups.set(2,second);
  // Do not start geometry work in this visibility-only timer check.
  internal.schedule=vi.fn();
  try {
    runtime.setSelectionScope(true,new Set([2]));
    expect(first.visible).toBe(false);expect(second.visible).toBe(true);expect(runtime.root.visible).toBe(true);
    runtime.setSelectionScope(true,new Set());
    vi.advanceTimersByTime(2000);expect(runtime.root.visible).toBe(false);
    runtime.setSelectionScope(true,new Set([2]));visibility.setLayerVisible(false);runtime.refreshVisibility();
    vi.advanceTimersByTime(1000);expect(runtime.root.visible).toBe(false);
    runtime.setSelectionScope(false,new Set());expect(first.visible).toBe(true);expect(second.visible).toBe(true);
    expect(runtime.root.visible).toBe(false);visibility.setLayerVisible(true);runtime.refreshVisibility();
    expect(runtime.root.visible).toBe(true);
    expect(model.setVisible).not.toHaveBeenCalled();
  } finally {runtime.release();visibility.release();vi.useRealTimers();}
});
