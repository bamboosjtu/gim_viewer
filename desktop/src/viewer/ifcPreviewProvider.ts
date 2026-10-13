import * as THREE from 'three';
import type { IfcGeometryProvider, IfcLOD, IfcPreviewData, IfcPreviewFineState, IfcPreviewObject, IfcPreviewProperties, IfcPreviewShape } from './ifcGeometryProvider.js';
import { buildPreviewInstances, disposePreviewMeshes, farViewDecision, projectedPreviewPixels, setPreviewInstanceVisible, type PreviewInstance, type FarViewDecision } from './ifcPreviewInstances.js';
import { IfcObjectFineRuntime, objectFineGroup } from './ifcObjectFineRuntime.js';
import type { LoaderSettings } from 'web-ifc';

/** Parameterized prisms, with earcut caps (including concave profiles). */
export function previewShapeGeometry(shape: IfcPreviewShape, level: 0|1, origin: number[]): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry;
  if (level===1 && shape.profile && shape.extrusion) {
    const points=shape.profile.map(p=>new THREE.Vector2(p[0],p[1])), n=points.length;
    const vertices=points.flatMap(p=>[p.x,p.y,0]);
    vertices.push(...points.flatMap(p=>[p.x+shape.extrusion![0],p.y+shape.extrusion![1],shape.extrusion![2]]));
    const indices: number[]=[];
    for(const [a,b,c] of THREE.ShapeUtils.triangulateShape(points,[])) indices.push(c,b,a,a+n,b+n,c+n);
    for(let i=0;i<n;i++){const j=(i+1)%n;indices.push(i,j,j+n,i,j+n,i+n);}
    geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    geometry.setIndex(indices);
  } else {
    const [x,y,z,X,Y,Z]=shape.bounds;
    geometry=new THREE.BoxGeometry(X-x,Y-y,Z-z).translate((x+X)/2,(y+Y)/2,(z+Z)/2);
  }
  // Apply source placement in double precision before Float32 storage.
  const m=new THREE.Matrix4().makeTranslation(-origin[0],-origin[1],-origin[2]).multiply(new THREE.Matrix4().fromArray(shape.matrix));
  geometry.applyMatrix4(m); geometry.computeVertexNormals();
  const expanded=geometry.toNonIndexed();geometry.dispose();return expanded;
}

interface Pending { resolve: (data: any)=>void; reject:(error: Error)=>void }
export class IfcPreviewProvider implements IfcGeometryProvider {
  readonly root=new THREE.Group();
  level: IfcLOD|null=null;
  data: IfcPreviewData|null=null;
  readonly modelId: string;
  private worker: Worker|null;
  private pending=new Map<number,Pending>();
  private sequence=0;
  private released=false;
  private fineTask: Promise<void>|null=null;
  private _fineState:IfcPreviewFineState|null=null;
  private fineListeners=new Set<(state:IfcPreviewFineState)=>void>();
  private loads=new Map<IfcLOD,Promise<void>>();
  private byGuid=new Map<string,IfcPreviewObject[]>();
  private byId=new Map<number,IfcPreviewObject>();
  private overlay: THREE.Mesh|null=null;
  private selected: IfcPreviewObject|null=null;
  private readonly material=new THREE.MeshStandardMaterial({color:0x849aaf,roughness:.8,side:THREE.DoubleSide});
  // Resolve readiness only: a fulfilled Promise must not retain the metadata
  // after releaseMetadata clears the provider's explicit owner.
  private readonly opened: Promise<void>;
  private propertyWorkers = new Map<Worker, (error: Error) => void>();
  private propertyEpoch=0;
  private readonly wasmConfig:{path:string;absolute:boolean};
  private readonly instanceBoxes:boolean;
  private readonly farView?:()=>{camera:THREE.Camera;height:number};
  private instances:PreviewInstance[]=[];
  private adaptive=new Map<number,{decision:FarViewDecision;sphere:THREE.Sphere;prism:THREE.Mesh|null}>();
  private frame:number|null=null;
  private cursor=0;
  private prismsById=new Map<number,IfcPreviewShape[]>();
  private instanceBounds=new Map<number,THREE.Box3>();
  private cachedPrisms=0;
  private maxAdaptiveFrameMs=0;
  private maxProfileUnitMs=0;
  private fineObjects=new Map<number,THREE.Mesh[]>();
  private objectFineRuntime:IfcObjectFineRuntime|null=null;
  private objectTasks=new Map<number,Promise<void>>();
  private fineProperties=new Map<number,IfcPreviewProperties>();
  loadObjectFine?: (object:IfcPreviewObject)=>Promise<void>;
  constructor(options: {modelId:string;sourcePath:string;bytes:Uint8Array;wasm:{path:string;absolute:boolean};
    sourceToViewer:THREE.Matrix4;loadFine:()=>Promise<void>;cancelFine?:()=>boolean;
    loadPropertiesBytes?:()=>Promise<Uint8Array|null>;releaseMetadataAfterPreview?:boolean;transferInput?:boolean;
    onResource?: (event:{state:'metadata-open'|'metadata-released'|'property-worker-open'|'property-worker-released';wasmHeapBytes?:number;rawBytes?:number})=>void;
    onTiming?: (event:{stage:'metadata'|'lod0'|'lod1'|'scene-commit';durationMs:number;level?:number;sourceBytes?:number;wasmInitMs?:number;openModelMs?:number;metadataMs?:number})=>void;
    worker?:Worker;instanceBoxes?:boolean;farView?:()=>{camera:THREE.Camera;height:number};
    objectFine?:boolean;webIfcSettings?:LoaderSettings;releaseObjectWorkerAfterLoad?:boolean;scheduleObjectFine?:(key:string,run:()=>Promise<void>)=>Promise<void>}) {
    this.modelId=options.modelId;
    this.onTiming=options.onTiming;
    this.wasmConfig=options.wasm;
    // Shared LOD0 boxes are the Preview default; explicit false is retained for A/B only.
    this.instanceBoxes=options.instanceBoxes??true;
    this.farView=options.farView;
    if(options.objectFine&&options.loadPropertiesBytes&&this.instanceBoxes){
      this.loadObjectFine=object=>{
        const existing=this.objectTasks.get(object.expressId);if(existing)return existing;
        if(this.byId.get(object.expressId)?.globalId!==object.globalId)return Promise.reject(new Error('IFC object identity mismatch'));
        const run=async()=>{
          if(this.unavailable())throw new Error('Preview released');
          // The source model is retained only in one bounded object Worker, not two WASM heaps.
          this.releasePreviewWorker();this.propertyEpoch++;this.stopPropertyWorkers();
          if(!this.objectFineRuntime)this.objectFineRuntime=new IfcObjectFineRuntime({wasm:options.wasm,webIfcSettings:options.webIfcSettings,readBytes:options.loadPropertiesBytes!,
            onTiming:event=>{this.root.userData.objectFineDiagnostic=event;(this.root.userData.objectFineEvents??=[]).push({...event,at:performance.now()});}});
          try {
          const result=await this.objectFineRuntime.load(object);
          if(this.unavailable())throw new Error('Preview released');
          if(!result.parts.some(part=>part.indices.length))throw new Error('Selected IFC object produced no fine geometry');
          const properties=options.releaseObjectWorkerAfterLoad?await this.objectFineRuntime.properties(object.expressId):null;
          if(this.unavailable())throw new Error('Preview released');
          const group=objectFineGroup(result,object,options.sourceToViewer),meshes=group.children.slice() as THREE.Mesh[];
          for(const mesh of meshes){mesh.matrix.premultiply(this.root.matrix.clone().invert().multiply(group.matrix));mesh.userData.expressId=object.expressId;this.root.add(mesh);}
          this.fineObjects.set(object.expressId,meshes);
          this.objectFineRuntime.forget(object.expressId);
          for(const entry of this.instances)if(entry.shape.object.expressId===object.expressId)setPreviewInstanceVisible(entry,false);
          const state=this.adaptive.get(object.expressId);if(state?.prism)state.prism.visible=false;
          this.root.updateMatrixWorld(true);
          if(properties)this.fineProperties.set(object.expressId,properties);
          } finally {if(options.releaseObjectWorkerAfterLoad){this.objectFineRuntime?.release();this.objectFineRuntime=null;}}
        };
        const task=options.scheduleObjectFine?options.scheduleObjectFine(`${options.modelId}:object:${object.expressId}`,run):run();
        this.objectTasks.set(object.expressId,task);void task.catch(()=>this.objectTasks.delete(object.expressId));return task;
      };
    }
    this.worker=options.worker ?? new Worker(new URL('./ifcPreviewWorker.ts',import.meta.url),{type:'module'});
    this.root.name=`IFC Preview · ${options.sourcePath}`;
    this.root.userData={provider:'ifc-preview',modelId:this.modelId,sourcePath:options.sourcePath};
    this.root.matrixAutoUpdate=false;
    this.worker.onmessage=(event)=>{
      const p=this.pending.get(event.data.id);if(!p)return;this.pending.delete(event.data.id);
      if(event.data.error)p.reject(new Error(event.data.error));else p.resolve(event.data.data);
    };
    this.worker.onerror=(event)=>{this.stopWorker(new Error(event.message || 'Preview worker failed'));};
    const exact=options.bytes.byteOffset===0&&options.bytes.byteLength===options.bytes.buffer.byteLength;
    const owned=options.transferInput&&exact?options.bytes:new Uint8Array(options.bytes);
    const inputBytes=owned.byteLength;
    this.opened=this.send({type:'open',modelId:options.modelId,sourcePath:options.sourcePath,bytes:owned,wasm:options.wasm},[owned.buffer]).then(data=>{
      if(this.released)throw new Error('Preview released');
      this.data=data;
      options.onTiming?.({stage:'metadata',durationMs:(data.timings?.wasmInitMs??0)+(data.timings?.openModelMs??0)+(data.timings?.metadataMs??0),sourceBytes:inputBytes,...data.timings});
      this.root.matrix.copy(options.sourceToViewer).multiply(new THREE.Matrix4().makeTranslation(...data.origin as [number,number,number]));
      for(const s of data.shapes as IfcPreviewShape[]) {
        if(this.byId.has(s.object.expressId))continue;
        this.byId.set(s.object.expressId,s.object);
        const candidates=this.byGuid.get(s.object.globalId) ?? [];candidates.push(s.object);this.byGuid.set(s.object.globalId,candidates);
      }
      options.onResource?.({state:'metadata-open',wasmHeapBytes:data.wasmHeapBytes,rawBytes:inputBytes});
    });
    this.loadFine=options.loadFine;
    this.cancelFine=options.cancelFine??null;
    this.loadPropertiesBytes=options.loadPropertiesBytes??null;
    this.releaseMetadataAfterPreview=options.releaseMetadataAfterPreview??false;
    this.onResource=options.onResource;
  }
  private readonly loadFine:()=>Promise<void>;
  private readonly onTiming?: (event:{stage:'metadata'|'lod0'|'lod1'|'scene-commit';durationMs:number;level?:number;sourceBytes?:number;wasmInitMs?:number;openModelMs?:number;metadataMs?:number})=>void;
  private readonly cancelFine:(()=>boolean)|null;
  private readonly loadPropertiesBytes:(()=>Promise<Uint8Array|null>)|null;
  private readonly releaseMetadataAfterPreview:boolean;
  private readonly onResource:((event:{state:'metadata-open'|'metadata-released'|'property-worker-open'|'property-worker-released';wasmHeapBytes?:number;rawBytes?:number})=>void)|undefined;
  get fineState():IfcPreviewFineState|null{return this._fineState;}
  private setFineState(value:IfcPreviewFineState):void {this._fineState=value;for(const listener of this.fineListeners)listener(value);}
  subscribeFineState(listener:(state:IfcPreviewFineState)=>void):()=>void {this.fineListeners.add(listener);return()=>this.fineListeners.delete(listener);}
  cancelFineRequest():boolean {return this.cancelFine?.()??false;}
  setFineDeferred():void {if(this.level===1&&this._fineState!=='fineLoading'&&this._fineState!=='fineReady')this.setFineState('fineDeferred');}
  releaseMetadata():void {this.stopWorker(new Error('Preview metadata released'));this.stopPropertyWorkers();this.data=null;this.byId.clear();this.byGuid.clear();this.onResource?.({state:'metadata-released'});}
  private unavailable():boolean {return this.released || this.level===2;}
  private send(message: Record<string,unknown>,transfer: Transferable[]=[]):Promise<any> {
    if(!this.worker)return Promise.reject(new Error('Preview metadata released'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker!.postMessage({...message,id},transfer);});
  }
  private releasePreviewWorker():void {
    if(!this.worker)return;
    this.stopWorker(new Error('Preview metadata model released after LOD1'));
    this.onResource?.({state:'metadata-released',wasmHeapBytes:this.data?.wasmHeapBytes});
  }
  canProvide(level: IfcLOD):boolean { return !this.released && (level===2 || (this.level!==2 && !!this.data?.shapes.some(s=>level===0||s.profile))); }
  loadLOD(level:IfcLOD):Promise<void> {
    if(this.released)return Promise.reject(new Error('Preview released'));
    if(level===2) {
      if(this._fineState==='fineReady')return Promise.resolve();
      if(this.fineTask)return this.fineTask;
      this.setFineState('fineLoading');
      const task=this.loadFine().then(()=>{
        if(!this.released){this.setFineState('fineReady');this.retire();}
      }).catch(error=>{
        this.fineTask=null;
        if(!this.released)this.setFineState((error as Error)?.name==='AbortError'?'fineDeferred':'fineFailed');
        throw error;
      });
      this.fineTask=task;return task;
    }
    if(this.level===2)return Promise.resolve();
    const existing=this.loads.get(level);if(existing)return existing;
    const task=this.build(level).then(()=>{if(level===1&&this.level===1){this.setFineState('previewReady');if(this.releaseMetadataAfterPreview)this.releasePreviewWorker();}});this.loads.set(level,task);return task;
  }
  private async build(level:0|1):Promise<void> {
    await this.opened;
    const data=this.data;
    if(this.unavailable()||!data)return;
    const buildStarted=performance.now();
    if(level===1&&this.instanceBoxes&&this.farView){
      for(const shape of data.shapes)if(shape.profile){const list=this.prismsById.get(shape.object.expressId)??[];list.push(shape);this.prismsById.set(shape.object.expressId,list);}
      // Process physically large candidates first; retain immutable GPU slot
      // identity/order. Selection bypasses this background projection queue.
      const importance=new Map([...this.instanceBounds].map(([id,box])=>[id,box.getSize(new THREE.Vector3()).lengthSq()]));
      this.instances.sort((a,b)=>(importance.get(b.shape.object.expressId)??0)-(importance.get(a.shape.object.expressId)??0));
      // LOD1 capability is ready; only in-view profiles are generated on demand.
      this.level=1;this.startFarView();
      this.onTiming?.({stage:'lod1',level,durationMs:performance.now()-buildStarted});return;
    }
    const temporary=new THREE.Group();
    // Box and Body are alternative representations. Keep all supported body items,
    // use explicit IFC boxes for LOD0 or when a product has no supported prism.
    const prisms=new Set(data.shapes.filter(s=>s.profile).map(s=>s.object.expressId));
    const boxes=new Set(data.shapes.filter(s=>!s.profile).map(s=>s.object.expressId));
    const shapes=data.shapes.filter(s=>level===1 ? (prisms.has(s.object.expressId)?!!s.profile:!s.profile) : (boxes.has(s.object.expressId)?!s.profile:!!s.profile));
    try {
      let instances:PreviewInstance[]=[];
      if(level===0&&this.instanceBoxes){
        const built=await buildPreviewInstances(shapes,data.origin,this.material,this.modelId,()=>this.unavailable(),()=>new Promise(resolve=>setTimeout(resolve,0)));
        temporary.add(...built.group.children.slice());instances=built.instances;
      } else {
      for(let offset=0;offset<shapes.length;offset+=64) {
        if(this.unavailable())return;
        const positions:number[]=[], ids:number[]=[];
        for(const s of shapes.slice(offset,offset+64)) {
          const g=previewShapeGeometry(s,level,data.origin), a=g.getAttribute('position');
          for(let i=0;i<a.count;i++)positions.push(a.getX(i),a.getY(i),a.getZ(i));
          for(let i=0;i<a.count/3;i++)ids.push(s.object.expressId);
          g.dispose();
        }
        const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
        geometry.computeVertexNormals();geometry.computeBoundingSphere();
        const mesh=new THREE.Mesh(geometry,this.material);
        mesh.userData={provider:'ifc-preview',modelId:this.modelId,lod:level,triangleExpressIds:new Uint32Array(ids)};
        temporary.add(mesh);
        await new Promise<void>(resolve=>setTimeout(resolve,0));
      }
      }
      if(this.unavailable())return;
      const selected=this.selected;
      const commitStarted=performance.now();
      this.clearGeometry();this.instances=instances;this.root.add(...temporary.children.slice());this.level=level;
      for(const entry of instances){const id=entry.shape.object.expressId,box=this.instanceBounds.get(id)??new THREE.Box3();box.union(new THREE.Box3(new THREE.Vector3(-.5,-.5,-.5),new THREE.Vector3(.5,.5,.5)).applyMatrix4(entry.matrix));this.instanceBounds.set(id,box);}
      if(selected)this.highlight(selected);
      this.root.updateMatrixWorld(true);
      this.onTiming?.({stage:'scene-commit',level,durationMs:performance.now()-commitStarted});
      this.onTiming?.({stage:level===0?'lod0':'lod1',level,durationMs:performance.now()-buildStarted});
    } finally {disposePreviewMeshes(temporary);}
  }
  private startFarView():void {
    if(!this.farView||this.frame!==null)return;
    const update=()=>{this.frame=null;if(this.unavailable()||!this.farView)return;
      const view=this.farView();this.updateFarView(view.camera,view.height);
      this.frame=requestAnimationFrame(update);
    };this.frame=requestAnimationFrame(update);
  }
  /** At most 128 instances / 2 ms per frame; one profile is the indivisible work unit. */
  updateFarView(camera:THREE.Camera,height:number):void {
    if(!this.data||!this.instances.length)return;
    camera.updateMatrixWorld();this.root.updateMatrixWorld(true);
    const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
    const start=performance.now();
    for(let work=0;work<128&&performance.now()-start<2;work++){
      const entry=this.instances[this.cursor++%this.instances.length],id=entry.shape.object.expressId;
      if(this.fineObjects.has(id))continue;
      let state=this.adaptive.get(id);
      if(!state){
        const sphere=this.instanceBounds.get(id)!.getBoundingSphere(new THREE.Sphere());
        state={decision:'box',sphere,prism:null};this.adaptive.set(id,state);
      }
      const sphere=state.sphere.clone().applyMatrix4(this.root.matrixWorld),selected=this.selected?.expressId===id;
      const inView=frustum.intersectsSphere(sphere),shapes=this.prismsById.get(id);
      let decision=inView||selected?farViewDecision(projectedPreviewPixels(sphere,camera,height),entry.shape.object.ifcType,!!shapes,state.decision,selected):'hidden';
      if(decision==='prism'&&!state.prism&&this.cachedPrisms>=512){
        const reusable=[...this.adaptive.entries()].find(([,s])=>s.prism&&s.decision!=='prism')
          ??(selected?[...this.adaptive.entries()].find(([otherId,s])=>otherId!==id&&s.prism):undefined);
        if(reusable){const [otherId,victim]=reusable;this.root.remove(victim.prism!);victim.prism!.geometry.dispose();victim.prism=null;victim.decision='box';this.cachedPrisms--;for(const other of this.instances)if(other.shape.object.expressId===otherId)setPreviewInstanceVisible(other,true);}
        else if(!selected)decision='box';
      }
      if(decision==='prism'&&!state.prism&&shapes){
        const profileStarted=performance.now();
        const values:number[]=[];
        for(const shape of shapes){const g=previewShapeGeometry(shape,1,this.data.origin);for(const value of g.getAttribute('position').array)values.push(value);g.dispose();}
        const g=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(values,3));g.computeVertexNormals();g.computeBoundingSphere();
        state.prism=new THREE.Mesh(g,this.material);state.prism.userData={provider:'ifc-preview',modelId:this.modelId,lod:1,approximate:true,triangleExpressIds:new Uint32Array(values.length/9).fill(id)};this.root.add(state.prism);this.cachedPrisms++;
        this.maxProfileUnitMs=Math.max(this.maxProfileUnitMs,performance.now()-profileStarted);
      }
      if(state.prism)state.prism.visible=decision==='prism';
      setPreviewInstanceVisible(entry,decision==='box');state.decision=decision;
    }
    this.maxAdaptiveFrameMs=Math.max(this.maxAdaptiveFrameMs,performance.now()-start);
  }
  farViewDiagnostic():{boxes:number;hidden:number;prisms:number;pending:number;cachedPrisms:number;maxFrameMs:number;maxProfileUnitMs:number}{
    const counts={boxes:0,hidden:0,prisms:0,pending:this.instanceBounds.size-this.adaptive.size,cachedPrisms:this.cachedPrisms,maxFrameMs:this.maxAdaptiveFrameMs,maxProfileUnitMs:this.maxProfileUnitMs};
    for(const state of this.adaptive.values())if(state.decision==='box')counts.boxes++;else if(state.decision==='hidden')counts.hidden++;else counts.prisms++;
    return counts;
  }
  findByGlobalId(guid:string):IfcPreviewObject[]{return [...this.byGuid.get(guid)??[]];}
  objectLOD(object:IfcPreviewObject):IfcLOD {return this.level===2||this.fineObjects.has(object.expressId)?2:this.farView?(this.adaptive.get(object.expressId)?.decision==='prism'?1:0):this.level===1&&this.data?.shapes.some(s=>s.object.expressId===object.expressId&&s.profile)?1:0;}
  async getProperties(expressId:number):Promise<IfcPreviewProperties>{
    if(this.unavailable())throw new Error('Preview released');
    const cached=this.fineProperties.get(expressId);if(cached)return cached;
    if(this.objectFineRuntime?.hasModel())return this.objectFineRuntime.properties(expressId);
    const epoch=this.propertyEpoch;
    if(this.worker)return this.send({type:'properties',expressId});
    if(!this.loadPropertiesBytes)throw new Error('Preview metadata released');
    const bytes=await this.loadPropertiesBytes();if(!bytes)throw new Error('IFC property source unavailable');
    if(this.unavailable())throw new Error('Preview released');
    if(epoch!==this.propertyEpoch)throw new DOMException('Property read superseded by object refinement','AbortError');
    const worker=new Worker(new URL('./ifcPreviewWorker.ts',import.meta.url),{type:'module'});
    const rawBytes=bytes.byteLength;
    const view=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength?bytes:new Uint8Array(bytes);
    const id=1;
    try {
      const response=await new Promise<any>((resolve,reject)=>{
        this.propertyWorkers.set(worker,reject);
        worker.onmessage=e=>e.data.id===id&&(e.data.error?reject(new Error(e.data.error)):resolve(e.data));
        worker.onerror=e=>reject(new Error(e.message||'IFC property worker failed'));
        worker.postMessage({id,type:'properties-once',bytes:view,expressId,wasm:this.wasmConfig},[view.buffer]);
      });
      this.onResource?.({state:'property-worker-open',wasmHeapBytes:response.wasmHeapBytes,rawBytes});
      return response.data;
    } finally {if(this.propertyWorkers.delete(worker))worker.terminate();this.onResource?.({state:'property-worker-released'});}
  }
  pick(raycaster:THREE.Raycaster):{object:IfcPreviewObject;distance:number}|null {
    if(this.released||this.level===2||!this.root.visible)return null;
    this.root.updateMatrixWorld(true);
    for(const hit of raycaster.intersectObjects(this.root.children,false)) {
      const ids=hit.object.userData.triangleExpressIds as Uint32Array|undefined;
      const instances=hit.object.userData.instanceExpressIds as Uint32Array|undefined;
      const object=hit.object.userData.expressId?this.byId.get(hit.object.userData.expressId):instances&&hit.instanceId!=null?this.byId.get(instances[hit.instanceId]):ids && hit.faceIndex!=null ? this.byId.get(ids[hit.faceIndex]) : null;
      if(object)return {object,distance:hit.distance};
    }
    return null;
  }
  highlight(object:IfcPreviewObject):void {
    this.clearHighlight();this.selected=object;
    if(this.level===2||!this.data)return;
    const fine=this.fineObjects.get(object.expressId);
    if(fine){
      // One independent overlay for each selected exact submesh; no shared-material mutation.
      const values:number[]=[];
      for(const mesh of fine){const source=mesh.geometry.clone().applyMatrix4(mesh.matrix),g=source.toNonIndexed();for(const value of g.getAttribute('position').array)values.push(value);g.dispose();if(g!==source)source.dispose();}
      const g=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(values,3));
      this.overlay=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0x00bbdd,side:THREE.DoubleSide,depthTest:false,transparent:true,opacity:.7}));this.overlay.renderOrder=100;this.root.add(this.overlay);return;
    }
    const shape=this.data.shapes.filter(s=>s.object.expressId===object.expressId);
    const hasPrism=shape.some(s=>s.profile);
    const selected=shape.filter(s=>this.level===1&&hasPrism?!!s.profile:!s.profile);
    const geometries=(selected.length?selected:shape).map(s=>previewShapeGeometry(s,this.level===1?1:0,this.data!.origin));
    const positions:number[]=[];for(const g of geometries){for(const value of g.getAttribute('position').array)positions.push(value);g.dispose();}
    const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    this.overlay=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:0x00bbdd,side:THREE.DoubleSide,depthTest:false,transparent:true,opacity:.7}));
    this.overlay.userData={...object,lod:this.level};this.overlay.renderOrder=100;this.root.add(this.overlay);
  }
  clearHighlight():void {this.selected=null;if(this.overlay){this.root.remove(this.overlay);this.overlay.geometry.dispose();(this.overlay.material as THREE.Material).dispose();this.overlay=null;}}
  private clearGeometry():void {if(this.frame!==null){cancelAnimationFrame(this.frame);this.frame=null;}this.clearHighlight();for(const meshes of this.fineObjects.values())for(const mesh of meshes)(mesh.material as THREE.Material).dispose();this.fineObjects.clear();this.fineProperties.clear();disposePreviewMeshes(this.root);this.instances=[];this.adaptive.clear();this.prismsById.clear();this.instanceBounds.clear();this.cachedPrisms=0;}
  private stopWorker(error:Error):void {this.worker?.terminate();this.worker=null;for(const p of this.pending.values())p.reject(error);this.pending.clear();}
  private stopPropertyWorkers():void {for(const [worker,reject] of this.propertyWorkers){worker.terminate();reject(new Error('Preview released'));}this.propertyWorkers.clear();}
  retire():void {this.objectFineRuntime?.release();this.objectFineRuntime=null;this.objectTasks.clear();this.clearGeometry();this.level=2;this.root.removeFromParent();this.stopWorker(new Error('Fine geometry available'));this.stopPropertyWorkers();}
  release():void {if(this.released)return;this.released=true;this.cancelFine?.();this.retire();this.material.dispose();this.releaseMetadata();this.fineListeners.clear();}
}
