import * as THREE from 'three';
import type { IfcPreviewObject } from './ifcGeometryProvider.js';
import type { ObjectFineResult } from './ifcObjectFineData.js';
import type { LoaderSettings } from 'web-ifc';

/** Experimental session-owned Worker. Bounded request timeout terminates synchronous WASM too. */
export class IfcObjectFineRuntime {
  private worker:Worker|null=null;
  private sequence=0;
  private pending=new Map<number,{resolve:(data:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private opened:Promise<unknown>|null=null;
  private tasks=new Map<number,{globalId:string;task:Promise<ObjectFineResult>}>();
  private released=false;
  private idle:ReturnType<typeof setTimeout>|null=null;
  constructor(private options:{wasm:{path:string;absolute:boolean};readBytes:()=>Promise<Uint8Array|null>;
    webIfcSettings?:LoaderSettings;
    timeoutMs?:number;worker?:()=>Worker;onTiming?:(data:Record<string,unknown>)=>void}){}
  private send(message:Record<string,unknown>,transfer:Transferable[]=[]):Promise<any>{
    if(!this.worker)return Promise.reject(new Error('Object fine model unavailable'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.stop(new Error('Object fine request exceeded fixed budget')),this.options.timeoutMs??30000);
      this.pending.set(id,{resolve,reject,timer});this.worker!.postMessage({...message,id},transfer);
    });
  }
  private async open():Promise<void>{
    if(this.released)throw new Error('Object fine released');
    const started=performance.now();
    const bytes=await this.options.readBytes();
    if(this.released)throw new Error('Object fine released');
    if(!bytes)throw new Error('IFC source not materialized');
    this.options.onTiming?.({stage:'source-read',durationMs:performance.now()-started,rawBytes:bytes.byteLength});
    this.worker=this.options.worker?.()??new Worker(new URL('./ifcObjectFineWorker.ts',import.meta.url),{type:'module'});
    this.worker.onmessage=({data})=>{const p=this.pending.get(data.id);if(!p)return;this.pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(new Error(data.error)):p.resolve(data.data);};
    this.worker.onerror=e=>this.stop(new Error(e.message));
    const owned=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength?bytes:new Uint8Array(bytes);
    const info=await this.send({type:'open',bytes:owned,wasm:this.options.wasm,webIfcSettings:this.options.webIfcSettings},[owned.buffer]);this.options.onTiming?.({stage:'open',...info});
  }
  load(object:IfcPreviewObject):Promise<ObjectFineResult>{
    if(this.released)return Promise.reject(new Error('Object fine released'));
    if(this.idle){clearTimeout(this.idle);this.idle=null;}
    const existing=this.tasks.get(object.expressId);if(existing)return existing.globalId===object.globalId?existing.task:Promise.reject(new Error('IFC object identity mismatch'));
    if(!this.opened)this.opened=this.open().catch(error=>{this.stop(error);throw error;});
    const task=this.opened.then(()=>this.send({type:'object',expressId:object.expressId,globalId:object.globalId})).then((result:ObjectFineResult)=>{
      this.options.onTiming?.({stage:'object',expressId:object.expressId,geometryMs:result.geometryMs,wasmHeapBytes:result.wasmHeapBytes});
      this.armIdle();return result;
    });
    this.tasks.set(object.expressId,{globalId:object.globalId,task});
    void task.catch(()=>{this.tasks.delete(object.expressId);});return task;
  }
  hasModel():boolean{return !!this.opened;}
  forget(expressId:number):void {this.tasks.delete(expressId);}
  private armIdle():void {if(this.idle)clearTimeout(this.idle);if(!this.released&&this.worker&&this.pending.size===0)this.idle=setTimeout(()=>this.stop(new Error('Object metadata idle released')),60000);}
  properties(expressId:number):Promise<any>{if(this.idle){clearTimeout(this.idle);this.idle=null;}return Promise.resolve(this.opened).then(()=>this.send({type:'properties',expressId})).finally(()=>this.armIdle());}
  private stop(error:Error):void {if(this.idle){clearTimeout(this.idle);this.idle=null;}this.worker?.terminate();this.worker=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.opened=null;this.tasks.clear();this.options.onTiming?.({stage:'released',reason:error.message,wasmHeapBytes:0});}
  release():void {this.released=true;this.stop(new Error('Object fine released'));}
}

/** web-ifc flat geometry is already metres / Y-up. Only the production anchor translation remains. */
export function objectFineGroup(result:ObjectFineResult,object:IfcPreviewObject,sourceToViewer:THREE.Matrix4):THREE.Group {
  const group=new THREE.Group();group.userData={...object,representationProvider:'web-ifc-object',lod:2,approximate:false};
  group.matrixAutoUpdate=false;
  group.matrix.copy(sourceToViewer).multiply(new THREE.Matrix4().makeRotationX(Math.PI/2));
  for(const part of result.parts){
    const geometry=new THREE.BufferGeometry(),positions=new Float32Array(part.vertices.length/2),normals=new Float32Array(part.vertices.length/2);
    for(let i=0;i<part.vertices.length/6;i++){positions.set(part.vertices.subarray(i*6,i*6+3),i*3);normals.set(part.vertices.subarray(i*6+3,i*6+6),i*3);}
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setIndex(new THREE.BufferAttribute(part.indices,1));
    const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:new THREE.Color(...part.color.slice(0,3) as [number,number,number]),opacity:part.color[3],transparent:part.color[3]<1,side:THREE.DoubleSide}));
    mesh.matrixAutoUpdate=false;mesh.matrix.fromArray(part.matrix);mesh.userData={...group.userData};group.add(mesh);
  }
  group.updateMatrixWorld(true);return group;
}
