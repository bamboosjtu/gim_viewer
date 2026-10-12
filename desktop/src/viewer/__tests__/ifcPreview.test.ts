import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { IFCPROJECT, IFCPRODUCT, IFCSITE } from 'web-ifc';
import { inspectIfcPreview } from '../ifcPreviewData.js';
import { IfcPreviewProvider, previewShapeGeometry } from '../ifcPreviewProvider.js';
import type { IfcPreviewData, IfcPreviewObject } from '../ifcGeometryProvider.js';
import { AppState } from '../../app/state.js';

function fixture() {
  const h=(value:number)=>({value}), n=(value:number)=>({value});
  const lines:Record<number,any>={
    1:{type:1,UnitsInContext:h(2)},2:{Units:[h(3)]},3:{type:3,UnitType:{value:'LENGTHUNIT'},Name:{value:'METRE'},Prefix:{value:'MILLI'}},
    4:{WorldCoordinateSystem:h(5)},5:{type:5,Location:h(6)},6:{Coordinates:[n(1000),n(2000),n(0)]},
    10:{type:10,ObjectPlacement:h(11)},11:{type:11,RelativePlacement:h(12)},12:{type:5,Location:h(13)},13:{Coordinates:[n(10000),n(0),n(0)]},
    20:{expressID:20,type:20,GlobalId:{value:'GUID-A'},Name:{value:'A'},ObjectPlacement:h(21),Representation:h(30)},
    21:{type:11,PlacementRelTo:h(11),RelativePlacement:h(22)},22:{type:5,Location:h(23),RefDirection:h(24)},23:{Coordinates:[n(0),n(3000),n(0)]},24:{DirectionRatios:[0,1,0]},
    30:{Representations:[h(31)]},31:{RepresentationIdentifier:{value:'Body'},ContextOfItems:h(4),Items:[h(40)]},
    40:{expressID:40,type:40,FirstOperand:h(41)},41:{type:41,SweptArea:h(42),ExtrudedDirection:h(43),Depth:n(4000)},
    42:{type:42,XDim:n(2000),YDim:n(1000)},43:{DirectionRatios:[0,0,1]},
  };
  const names:Record<number,string>={3:'IFCSIUNIT',5:'IFCAXIS2PLACEMENT3D',11:'IFCLOCALPLACEMENT',20:'IFCMEMBER',40:'IFCBOOLEANCLIPPINGRESULT',41:'IFCEXTRUDEDAREASOLID',42:'IFCRECTANGLEPROFILEDEF'};
  const api:any={GetLine:(_m:number,id:number)=>lines[id],GetNameFromTypeCode:(type:number)=>names[type]??'IFCCONTEXT',GetLineIDsWithType:(_m:number,type:number)=>{
    const ids=type===IFCPROJECT?[1]:type===IFCPRODUCT?[20]:type===IFCSITE?[10]:[];
    return {size:()=>ids.length,get:(i:number)=>ids[i]};
  }};
  return {api,lines,h};
}
function data():IfcPreviewData {const f=fixture();return inspectIfcPreview(f.api,0,'ifc_fixture','CBM/model.ifc');}
class WorkerStub {
  onmessage:((event:any)=>void)|null=null;onerror:((event:any)=>void)|null=null;
  terminate=vi.fn();
  postMessage(input:any){
    if(input.type==='open')queueMicrotask(()=>this.onmessage?.({data:{id:input.id,data:data()}}));
    if(input.type==='properties-once')queueMicrotask(()=>this.onmessage?.({data:{id:input.id,data:{attributes:{Name:{value:'A'}},propertySets:[]},wasmHeapBytes:4096}}));
  }
}
function provider(loadFine=async()=>{},extra:Record<string,unknown>={}) {
  const worker=new WorkerStub();
  const p=new IfcPreviewProvider({modelId:'ifc_fixture',sourcePath:'CBM/model.ifc',bytes:new Uint8Array([1]),wasm:{path:'/',absolute:true},
    sourceToViewer:new THREE.Matrix4().makeRotationX(-Math.PI/2),loadFine,worker:worker as unknown as Worker,...extra});
  return {p,worker};
}
describe('IFC preview source coordinates and representation identity',()=>{
  it('reports Worker metadata and LOD/commit durations without changing identity',async()=>{
    const events:any[]=[];
    const {p}=provider(async()=>{}, {onTiming:(e:any)=>events.push(e)});
    await p.loadLOD(0);await p.loadLOD(1);
    expect(events.map(e=>e.stage)).toEqual(['metadata','scene-commit','lod0','scene-commit','lod1']);
    expect(events.every(e=>Number.isFinite(e.durationMs)&&e.durationMs>=0)).toBe(true);
    expect(events[0].sourceBytes).toBe(1);expect(p.findByGlobalId('GUID-A')[0].expressId).toBe(20);
    p.release();
  });
  it('derives metres from project units, context and nested Site placement exactly once',()=>{
    const d=data(),s=d.shapes[0],matrix=new THREE.Matrix4().fromArray(s.matrix);
    expect(d.unitScale).toBe(.001);expect(d.origin).toEqual([10,0,0]);
    expect(new THREE.Vector3(0,0,0).applyMatrix4(matrix).toArray()).toEqual([11,5,0]);
    expect(new THREE.Vector3(1000,0,0).applyMatrix4(matrix).toArray()).toEqual([11,6,0]);
    expect(s.object).toMatchObject({key:'ifc:ifc_fixture:object:20',expressId:20,globalId:'GUID-A',provider:'ifc-preview',ifcType:'IFCMEMBER'});
    expect(s.approximation).toContain('clipping omitted');
  });
  it('origin normalization cancels with the viewer root, without any fitted translation',()=>{
    const d=data(),s=d.shapes[0],sourceToViewer=new THREE.Matrix4().makeRotationX(-Math.PI/2);
    const g=previewShapeGeometry(s,1,d.origin), root=sourceToViewer.clone().multiply(new THREE.Matrix4().makeTranslation(...d.origin as [number,number,number]));
    const bbox=new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute).applyMatrix4(root);
    expect(bbox.min.x).toBeCloseTo(10.5);expect(bbox.max.x).toBeCloseTo(11.5);
    expect(bbox.max.y).toBeCloseTo(4);expect(bbox.min.z).toBeCloseTo(-6);
    g.dispose();
  });
  it('placement cycles isolate the product and never invent an identity placement',()=>{
    const {api,lines,h}=fixture();lines[11].PlacementRelTo=h(21);
    // Site origin is independently required, so a corrupt Site is a file-level preview failure.
    expect(()=>inspectIfcPreview(api,0,'ifc_fixture','model.ifc')).toThrow('cycle');
  });
  it('unknown profiles remain unsupported, while LOD2 can still load',()=>{
    const {api,lines}=fixture();lines[42].type=999;
    const d=inspectIfcPreview(api,0,'ifc_fixture','model.ifc');
    expect(d.shapes).toHaveLength(0);expect(d.diagnostics.unsupported).toBe(1);
    expect(d.diagnostics.reasons['unsupported preview profile']).toBe(1);
  });
  it('concave prism caps use triangulation instead of a centroid fan',()=>{
    const s=data().shapes[0];s.profile=[[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]];s.extrusion=[0,0,1];s.matrix=new THREE.Matrix4().toArray();
    const geometry=previewShapeGeometry(s,1,[0,0,0]);
    expect(geometry.getAttribute('position').count/3).toBe(20);geometry.dispose();
  });
  it('missing GlobalId is diagnosed instead of manufacturing a new semantic identity',()=>{
    const {api,lines}=fixture();lines[20].GlobalId=null;
    const d=inspectIfcPreview(api,0,'ifc_fixture','model.ifc');
    expect(d.shapes).toHaveLength(0);expect(d.diagnostics.reasons['missing IFC GlobalId']).toBe(1);
  });
  it('LOD0 → LOD1 picking keeps the original object and does not create per-object scene identity',async()=>{
    const {p}=provider();await p.loadLOD(0);const key=p.findByGlobalId('GUID-A')[0];await p.loadLOD(1);
    const ray=new THREE.Raycaster(new THREE.Vector3(11,2,0),new THREE.Vector3(0,0,-1));
    expect(p.pick(ray)?.object).toEqual(key);expect(p.root.children).toHaveLength(1);
    await p.loadLOD(1);expect(p.root.children).toHaveLength(1);p.release();
  });
  it('highlight has independent material and release disposes the worker and scene resources',async()=>{
    const {p,worker}=provider();await p.loadLOD(1);const mesh=p.root.children[0] as THREE.Mesh;
    const material=mesh.material, dispose=vi.spyOn(mesh.geometry,'dispose');
    p.highlight(p.findByGlobalId('GUID-A')[0]);expect(p.root.children).toHaveLength(2);
    expect((p.root.children[1] as THREE.Mesh).material).not.toBe(material);
    p.clearHighlight();expect(mesh.material).toBe(material);
    const scene=new THREE.Scene();scene.add(p.root);const state=new AppState();state.ifcPreviewProviders.set(p.modelId,p);
    state.activateProject(2,'new');expect(worker.terminate).toHaveBeenCalledTimes(1);expect(dispose).toHaveBeenCalled();expect(scene.children).toHaveLength(0);
  });
  it('fine requests share one Promise and failed fine loading keeps the preview available',async()=>{
    const load=vi.fn(async()=>{throw new Error('fine failed');}),{p}=provider(load);await p.loadLOD(1);
    const a=p.loadLOD(2),b=p.loadLOD(2);expect(a).toBe(b);await expect(a).rejects.toThrow('fine failed');
    expect(load).toHaveBeenCalledTimes(1);expect(p.level).toBe(1);expect(p.root.children).toHaveLength(1);p.release();
  });
  it('fine completion removes preview without losing the GlobalId lookup',async()=>{
    const {p}=provider();await p.loadLOD(1);const object:IfcPreviewObject=p.findByGlobalId('GUID-A')[0];
    await p.loadLOD(2);expect(p.level).toBe(2);expect(p.root.children).toHaveLength(0);expect(p.findByGlobalId('GUID-A')).toEqual([object]);p.release();
  });
  it('retries failed fine conversion and publishes each lifecycle state',async()=>{
    let attempts=0;const states:string[]=[];
    const {p}=provider(async()=>{attempts++;if(attempts===1)throw new Error('transient conversion failure');});
    p.subscribeFineState(state=>states.push(state));await p.loadLOD(1);p.setFineDeferred();
    expect(p.fineState).toBe('fineDeferred');
    await expect(p.loadLOD(2)).rejects.toThrow('transient conversion failure');
    expect(p.fineState).toBe('fineFailed');
    await p.loadLOD(2);
    expect(attempts).toBe(2);expect(p.fineState).toBe('fineReady');
    expect(states).toEqual(['previewReady','fineDeferred','fineLoading','fineFailed','fineLoading','fineReady']);p.release();
  });
  it('releases Preview WASM after LOD1 and reads properties with a disposable metadata worker',async()=>{
    const created:WorkerStub[]=[];
    class PropertyWorker extends WorkerStub {constructor(){super();created.push(this);}}
    vi.stubGlobal('Worker',PropertyWorker);
    const events:any[]=[];
    const {p,worker}=provider(async()=>{}, {releaseMetadataAfterPreview:true,
      loadPropertiesBytes:async()=>new Uint8Array([9,8,7]),onResource:(event:any)=>events.push(event)});
    await p.loadLOD(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(events.some(event=>event.state==='metadata-released')).toBe(true);
    await expect(p.getProperties(20)).resolves.toMatchObject({attributes:{Name:{value:'A'}}});
    expect(created).toHaveLength(1);expect(created[0].terminate).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({state:'property-worker-open',wasmHeapBytes:4096,rawBytes:3}));
    expect(events.some(event=>event.state==='property-worker-released')).toBe(true);
    p.release();vi.unstubAllGlobals();
  });
  it('transfers the property input without a copy and terminates an outstanding property worker on release',async()=>{
    const input=new Uint8Array([9,8,7]);
    const created:WorkerStub[]=[];
    let sent:Uint8Array|undefined;
    class SlowPropertyWorker extends WorkerStub {
      constructor(){super();created.push(this);}
      postMessage(message:any){sent=message.bytes;}
    }
    vi.stubGlobal('Worker',SlowPropertyWorker);
    try {
      const {p}=provider(async()=>{}, {releaseMetadataAfterPreview:true,loadPropertiesBytes:async()=>input});
      await p.loadLOD(1);
      expect(await (p as any).opened).toBeUndefined();
      const query=p.getProperties(20);
      const rejected=expect(query).rejects.toThrow('Preview released');
      await Promise.resolve();
      expect(sent).toBe(input);
      p.release();
      await rejected;
      expect(created[0].terminate).toHaveBeenCalledTimes(1);
      expect(p.data).toBeNull();
      expect(p.findByGlobalId('GUID-A')).toEqual([]);
    } finally {vi.unstubAllGlobals();}
  });
  it('does not start a metadata worker when a source reread finishes after project release',async()=>{
    let finish!:(bytes:Uint8Array)=>void;
    const created:WorkerStub[]=[];
    class PropertyWorker extends WorkerStub {constructor(){super();created.push(this);}}
    vi.stubGlobal('Worker',PropertyWorker);
    try {
      const {p}=provider(async()=>{}, {releaseMetadataAfterPreview:true,
        loadPropertiesBytes:()=>new Promise<Uint8Array>(resolve=>{finish=resolve;})});
      await p.loadLOD(1);
      const query=p.getProperties(20),rejected=expect(query).rejects.toThrow('Preview released');
      p.release();finish(new Uint8Array([1]));
      await rejected;expect(created).toHaveLength(0);
    } finally {vi.unstubAllGlobals();}
  });
});
