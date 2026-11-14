import * as THREE from 'three';
import { discoverGeometriesFromDevPath } from './modGeometryDiscovery.js';
import { getFileByPath } from '../gim/fileLookup.js';
import { stlBounds } from './devSpatialCatalog.js';
import { acceptVerifiedStlSourceEnvelope, stlSourceEnvelopeProof } from '../viewer/geometryBounds.js';

/** Serialized extras are untrusted. Bind a large single-STL exception to the
 * current DEV reference, raw bytes and every source triangle before admission.
 * Ordinary templates have no exception and do not need these source reads. */
export async function verifyDevGlbSourceEnvelope(scene: THREE.Group, devPath: string,
  files: Map<string, File> | undefined, current: () => boolean = () => true): Promise<void> {
  const proof=stlSourceEnvelopeProof(scene);if(!proof)return;
  const fail=()=>{throw Error('DEV STL source evidence mismatch');};
  const check=()=>{if(!current())throw new DOMException('DEV source verification expired','AbortError');};
  check();if(!files)return fail();
  const found=await discoverGeometriesFromDevPath(devPath,files,new THREE.Matrix4().toArray(),new Set(),0,{instances:0},{strictDependencies:true});
  check();if(found.mods.length||found.stls.length!==1)return fail();
  const edge=found.stls[0],file=getFileByPath(files,edge.stlPath);
  if(!file||proof.path!==edge.stlPath||file.size>128*1024*1024)return fail();
  const bytes=await file.arrayBuffer();check();if(bytes.byteLength<84||bytes.byteLength>128*1024*1024)return fail();
  const view=new DataView(bytes),triangles=view.getUint32(80,true);
  const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(proof.sha256!==sha||triangles!==proof.triangles||triangles>5_000_000||84+triangles*50!==bytes.byteLength)return fail();
  const bounds=stlBounds(bytes);if(!bounds)return fail();
  bounds.applyMatrix4(new THREE.Matrix4().fromArray(edge.placementTransformMatrix));bounds.min.multiplyScalar(.001);bounds.max.multiplyScalar(.001);
  if(!Array.isArray(proof.bounds)||proof.bounds.length!==6||![...bounds.min.toArray(),...bounds.max.toArray()]
    .every((value,i)=>Number.isFinite(proof.bounds[i])&&Math.abs(value-proof.bounds[i])<=.001))return fail();
  const meshes:THREE.Mesh[]=[];scene.updateMatrixWorld(true);scene.traverse(node=>{if((node as THREE.Mesh).isMesh)meshes.push(node as THREE.Mesh);});
  if(meshes.length!==1)return fail();
  const mesh=meshes[0],position=mesh.geometry.getAttribute('position'),normal=mesh.geometry.getAttribute('normal');
  if(!position||!normal||position.count!==triangles*3||normal.count!==position.count||!mesh.matrixWorld.equals(new THREE.Matrix4()))return fail();
  const placement=new THREE.Matrix4().fromArray(edge.placementTransformMatrix);for(const i of [12,13,14])placement.elements[i]*=.001;
  const normalMatrix=new THREE.Matrix3().getNormalMatrix(placement),p=new THREE.Vector3(),n=new THREE.Vector3(),actual=new THREE.Vector3();
  const swap=placement.determinant()<0,index=mesh.geometry.getIndex();
  let yieldedAt=performance.now();
  for(let triangle=0;triangle<triangles;triangle++){
    if(triangle%2048===0){
      check();
      if(performance.now()-yieldedAt>=8){await new Promise<void>(resolve=>setTimeout(resolve,0));check();yieldedAt=performance.now();}
    }
    const offset=84+triangle*50;
    n.set(view.getFloat32(offset,true),view.getFloat32(offset+4,true),view.getFloat32(offset+8,true)).applyMatrix3(normalMatrix).normalize();
    if(n.lengthSq()===0)n.set(1,0,0);
    for(let corner=0;corner<3;corner++){
      const sourceCorner=swap&&corner>0?3-corner:corner,at=offset+12+sourceCorner*12;
      p.set(Math.fround(view.getFloat32(at,true)*.001),Math.fround(view.getFloat32(at+4,true)*.001),Math.fround(view.getFloat32(at+8,true)*.001)).applyMatrix4(placement);
      const target=index?.getX(triangle*3+corner)??triangle*3+corner;
      const normalError=actual.fromBufferAttribute(normal,target).normalize().distanceTo(n);
      if(position.getX(target)!==Math.fround(p.x)||position.getY(target)!==Math.fround(p.y)||position.getZ(target)!==Math.fround(p.z)
        ||!Number.isFinite(normalError)||normalError>1e-5)return fail();
    }
  }
  check();acceptVerifiedStlSourceEnvelope(scene);
}
