import * as THREE from 'three';
import type { IfcGeometryProvider, IfcLOD, IfcPreviewData, IfcPreviewObject, IfcPreviewProperties, IfcPreviewShape } from './ifcGeometryProvider.js';

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
  private loads=new Map<IfcLOD,Promise<void>>();
  private byGuid=new Map<string,IfcPreviewObject[]>();
  private byId=new Map<number,IfcPreviewObject>();
  private overlay: THREE.Mesh|null=null;
  private selected: IfcPreviewObject|null=null;
  private readonly material=new THREE.MeshStandardMaterial({color:0x849aaf,roughness:.8,side:THREE.DoubleSide});
  private readonly opened: Promise<IfcPreviewData>;
  constructor(options: {modelId:string;sourcePath:string;bytes:Uint8Array;wasm:{path:string;absolute:boolean};
    sourceToViewer:THREE.Matrix4;loadFine:()=>Promise<void>;worker?:Worker}) {
    this.modelId=options.modelId;
    this.worker=options.worker ?? new Worker(new URL('./ifcPreviewWorker.ts',import.meta.url),{type:'module'});
    this.root.name=`IFC Preview · ${options.sourcePath}`;
    this.root.userData={provider:'ifc-preview',modelId:this.modelId,sourcePath:options.sourcePath};
    this.root.matrixAutoUpdate=false;
    this.worker.onmessage=(event)=>{
      const p=this.pending.get(event.data.id);if(!p)return;this.pending.delete(event.data.id);
      if(event.data.error)p.reject(new Error(event.data.error));else p.resolve(event.data.data);
    };
    this.worker.onerror=(event)=>{this.stopWorker(new Error(event.message || 'Preview worker failed'));};
    const owned=new Uint8Array(options.bytes);
    this.opened=this.send({type:'open',modelId:options.modelId,sourcePath:options.sourcePath,bytes:owned,wasm:options.wasm},[owned.buffer]).then(data=>{
      if(this.released)throw new Error('Preview released');
      this.data=data;
      this.root.matrix.copy(options.sourceToViewer).multiply(new THREE.Matrix4().makeTranslation(...data.origin as [number,number,number]));
      for(const s of data.shapes as IfcPreviewShape[]) {
        if(this.byId.has(s.object.expressId))continue;
        this.byId.set(s.object.expressId,s.object);
        const candidates=this.byGuid.get(s.object.globalId) ?? [];candidates.push(s.object);this.byGuid.set(s.object.globalId,candidates);
      }
      return data;
    });
    this.loadFine=options.loadFine;
  }
  private readonly loadFine:()=>Promise<void>;
  private unavailable():boolean {return this.released || this.level===2;}
  private send(message: Record<string,unknown>,transfer: Transferable[]=[]):Promise<any> {
    if(!this.worker)return Promise.reject(new Error('Preview metadata released'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker!.postMessage({...message,id},transfer);});
  }
  canProvide(level: IfcLOD):boolean { return !this.released && (level===2 || (this.level!==2 && !!this.data?.shapes.some(s=>level===0||s.profile))); }
  loadLOD(level:IfcLOD):Promise<void> {
    if(this.released)return Promise.reject(new Error('Preview released'));
    if(level===2) return this.fineTask ??= this.loadFine().then(()=>{if(!this.released)this.retire();}).catch(error=>{this.fineTask=null;throw error;});
    if(this.level===2)return Promise.resolve();
    const existing=this.loads.get(level);if(existing)return existing;
    const task=this.build(level);this.loads.set(level,task);return task;
  }
  private async build(level:0|1):Promise<void> {
    const data=await this.opened;
    if(this.unavailable())return;
    const temporary=new THREE.Group();
    // Box and Body are alternative representations. Keep all supported body items,
    // use explicit IFC boxes for LOD0 or when a product has no supported prism.
    const prisms=new Set(data.shapes.filter(s=>s.profile).map(s=>s.object.expressId));
    const boxes=new Set(data.shapes.filter(s=>!s.profile).map(s=>s.object.expressId));
    const shapes=data.shapes.filter(s=>level===1 ? (prisms.has(s.object.expressId)?!!s.profile:!s.profile) : (boxes.has(s.object.expressId)?!s.profile:!!s.profile));
    try {
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
      if(this.unavailable())return;
      const selected=this.selected;
      this.clearGeometry();this.root.add(...temporary.children.slice());this.level=level;
      if(selected)this.highlight(selected);
      this.root.updateMatrixWorld(true);
    } finally {for(const mesh of temporary.children as THREE.Mesh[])mesh.geometry.dispose();}
  }
  findByGlobalId(guid:string):IfcPreviewObject[]{return [...this.byGuid.get(guid)??[]];}
  objectLOD(object:IfcPreviewObject):IfcLOD {return this.level===2?2:this.level===1&&this.data?.shapes.some(s=>s.object.expressId===object.expressId&&s.profile)?1:0;}
  getProperties(expressId:number):Promise<IfcPreviewProperties>{return this.send({type:'properties',expressId});}
  pick(raycaster:THREE.Raycaster):{object:IfcPreviewObject;distance:number}|null {
    if(this.released||this.level===2||!this.root.visible)return null;
    this.root.updateMatrixWorld(true);
    for(const hit of raycaster.intersectObjects(this.root.children,false)) {
      const ids=hit.object.userData.triangleExpressIds as Uint32Array|undefined;
      const object=ids && hit.faceIndex!=null ? this.byId.get(ids[hit.faceIndex]) : null;
      if(object)return {object,distance:hit.distance};
    }
    return null;
  }
  highlight(object:IfcPreviewObject):void {
    this.clearHighlight();this.selected=object;
    if(this.level===2||!this.data)return;
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
  private clearGeometry():void {this.clearHighlight();for(const mesh of [...this.root.children] as THREE.Mesh[]){this.root.remove(mesh);mesh.geometry?.dispose();}}
  private stopWorker(error:Error):void {this.worker?.terminate();this.worker=null;for(const p of this.pending.values())p.reject(error);this.pending.clear();}
  retire():void {this.clearGeometry();this.level=2;this.root.removeFromParent();this.stopWorker(new Error('Fine geometry available'));}
  release():void {if(this.released)return;this.released=true;this.retire();this.material.dispose();this.data=null;this.byId.clear();this.byGuid.clear();}
}
