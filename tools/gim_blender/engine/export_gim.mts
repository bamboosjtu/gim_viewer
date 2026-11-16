/** Offline GIM mesh export using this tool's own source/discovery/compiler copy.
 * Source geometry stays Z-up metres. No DOM, IPC, DB or full app startup.
 * Cross-implementation audits are an explicit developer diagnostic only.
 */
import {readFileSync,readdirSync,statSync,writeFileSync,openSync,writeSync,closeSync,renameSync,mkdirSync} from 'node:fs';
import {join,relative,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {extractEngineeringSourceGraph} from './snapshot/core/src/gim/engineering/sourceGraph.js';
import {collectSourceGeometryOccurrences} from './snapshot/core/src/gim/engineering/geometryOccurrences.js';
import {getFileEntryResolver} from './snapshot/core/src/gim/entryResolver.js';
import {discoverGeometriesFromDevPath} from './snapshot/core/src/services/modGeometryDiscovery.js';
import {parseWorkerXmlMod} from './snapshot/core/src/gim/geometry/xmlModWorkerParser.js';
import {loadXmlModFromFiles,applyPlacementTransformToSceneUnits,XML_MOD_GEOMETRY_DIAGNOSTICS_KEY} from './snapshot/core/src/viewer/xmlModLoader.js';
import {parseStlBinary} from './snapshot/core/src/viewer/stlLoader.js';

const ROOT=resolve(process.env.GIM_BLENDER_EXTRACT!);
const BUILD=resolve(process.env.GIM_BLENDER_BUILD!);
const LOD=Number(process.env.GIM_BLENDER_GIM_LOD??'0') as 0|1;
const VERIFY_ASSEMBLY=process.env.GIM_BLENDER_VERIFY_ASSEMBLY==='1';
if(LOD!==0&&LOD!==1)throw Error('Offline browsing supports explicit GIM LOD 0 or 1');
const paths:string[]=[];
function walk(dir:string){for(const entry of readdirSync(dir,{withFileTypes:true})){
 const full=join(dir,entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile())paths.push(relative(ROOT,full).replace(/\\/g,'/'));
}}
walk(ROOT);paths.sort();mkdirSync(BUILD,{recursive:true});
// Keep a stable shared file Map, with lazy bytes rather than loading every IFC.
class DiskFile extends File {
 private bytes:Promise<ArrayBuffer>|null=null;
 constructor(readonly fullPath:string){super([],basename(fullPath));}
 get size(){return statSync(this.fullPath).size;}
 async arrayBuffer(){return this.bytes??=(async()=>{const b=readFileSync(this.fullPath);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);})();}
 async text(){return new TextDecoder().decode(await this.arrayBuffer());}
}
const files=new Map(paths.map(p=>[p,new DiskFile(join(ROOT,p)) as File]));
const resolver=getFileEntryResolver(files);
const canonical=(p:string)=>{const key=resolver(p);if(!key)throw Error('Missing or ambiguous source: '+p);return key.replace(/\\/g,'/').toLowerCase();};
const readText=async(p:string)=>{
 const b=readFileSync(join(ROOT,p));try{return new TextDecoder('utf-8',{fatal:true}).decode(b);}
 catch{return new TextDecoder('gb18030').decode(b);}
};
const graph=await extractEngineeringSourceGraph({paths,readText});
const catalog=collectSourceGeometryOccurrences(graph);
if(catalog.diagnostics.length)throw Error('Viewer source occurrence diagnostics: '+JSON.stringify(catalog.diagnostics.slice(0,8)));
const placementFile=join(BUILD,'gim_placements.json');
const legacy=JSON.parse(readFileSync(placementFile,'utf8'));
// Labels come from the same CBM document address. They never choose a geometry
// representation or placement; those are owned by the source occurrence.
const labelsByDocument=new Map(legacy.placements.map((row:any)=>[canonical(row.file),row]));
const contexts=new Map(graph.cbmOccurrences.map(node=>[node.id,node]));
const matched=new Set<any>(),roots:any[]=[];let maxRootDifferenceMm=0;
for(const occ of catalog.occurrences){
 const context=contexts.get(occ.sourceContextId)!;
 roots.push({occ,row:labelsByDocument.get(canonical(context.documentPath))||{label:occ.name}});
}
if(VERIFY_ASSEMBLY){
 const actualByPath=new Map<string,any[]>();
 for(const row of legacy.placements){const key=canonical(row.dev),list=actualByPath.get(key)||[];list.push(row);actualByPath.set(key,list);}
 for(const {occ} of roots){
  const candidates=actualByPath.get(canonical(occ.devPath))||[];
  let chosen:any=null,error=Infinity;
  for(const row of candidates){if(matched.has(row))continue;const d=Math.max(...row.matrix.map((x:number,i:number)=>Math.abs(x-occ.placementMatrix[i])));if(d<error){error=d;chosen=row;}}
  if(!chosen||error>2e-5)throw Error('Independent CBM root placement mismatch: '+occ.id+' '+error);
  matched.add(chosen);maxRootDifferenceMm=Math.max(maxRootDifferenceMm,error);
 }
 if(matched.size!==legacy.placements.length)throw Error('Independent root multiplicity mismatch');
}

type Chunk={name:string;category:string;color:number[];tile:number[];pos:Float32Array[];nor:Float32Array[];idx:Uint32Array[];vertexCount:number;indexCount:number;bbox:number[];sources:Set<string>};
const chunks=new Map<string,Chunk>(),compiled=new Map<string,THREE.Group>(),leafRows:any[]=[],sourceRows=new Map<string,any>();
const stats:any={mod_files:0,stl_files:0,mod_entities:0,tris:0,verts:0,skipped:0,unsupported:0,approximated_booleans:0,tiny_skipped:0,categories:{}};
let observedNonXmlControls=0;
function add(mesh:THREE.Mesh,placement:number[],label:string,path:string,probe=false){
 mesh.updateWorldMatrix(true,false);
 const m=new THREE.Matrix4().fromArray(placement);m.elements[12]*=.001;m.elements[13]*=.001;m.elements[14]*=.001;m.multiply(mesh.matrixWorld);
 const normal=new THREE.Matrix3().getNormalMatrix(m),g=mesh.geometry,p=g.getAttribute('position'),n=g.getAttribute('normal');
 if(!p?.count)return;
 const material=(Array.isArray(mesh.material)?mesh.material[0]:mesh.material) as THREE.MeshStandardMaterial;
 const color=new THREE.Color();material.color?.getRGB(color,THREE.SRGBColorSpace);
 const rgba=[Math.round(color.r*255),Math.round(color.g*255),Math.round(color.b*255),material.opacity??1];
 const category=label.split('/')[0]||'其他';
 const bbox=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
 const positions=new Float32Array(p.count*3),normals=new Float32Array(p.count*3),v=new THREE.Vector3();
 for(let i=0;i<p.count;i++){
  v.fromBufferAttribute(p,i).applyMatrix4(m);if(!Number.isFinite(v.x+v.y+v.z))throw Error('Non-finite exported source position: '+path);
  positions.set([v.x,v.y,v.z],i*3);
  for(let a=0;a<3;a++){bbox[a]=Math.min(bbox[a],v.getComponent(a));bbox[a+3]=Math.max(bbox[a+3],v.getComponent(a));}
  if(n)v.fromBufferAttribute(n,i).applyMatrix3(normal).normalize();else v.set(0,0,1);
  normals.set([v.x,v.y,v.z],i*3);
 }
 // Spatial packing follows the placed geometry, including Entity transforms.
 // A malformed distant source Entity must not consume the Draco precision of
 // otherwise valid meshes that share only a DEV root's placement and color.
 const tile=[Math.floor((bbox[0]+bbox[3])/60),Math.floor((bbox[1]+bbox[4])/60)];
 const key=JSON.stringify([category,rgba,tile]);
 let c=chunks.get(key);
 if(!c){c={name:'GIM_'+chunks.size,category,color:rgba,tile,pos:[],nor:[],idx:[],vertexCount:0,indexCount:0,bbox:bbox.slice(),sources:new Set()};chunks.set(key,c);}
 else for(let a=0;a<3;a++){c.bbox[a]=Math.min(c.bbox[a],bbox[a]);c.bbox[a+3]=Math.max(c.bbox[a+3],bbox[a+3]);}
 if(VERIFY_ASSEMBLY&&probe){
  const sample=[0,Math.floor(p.count/2),p.count-1],local=new Float32Array(9);
  sample.forEach((vertex,i)=>{v.fromBufferAttribute(p,vertex).applyMatrix4(mesh.matrixWorld);local.set([v.x,v.y,v.z],i*3);});
  // An indexed probe keeps vertex identities stable. The product helper
  // reverses triangle winding for reflections; three arbitrary sample points
  // must not be mistaken for a non-indexed triangle and have their rows swapped.
  const geo=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(local,3));geo.setIndex([0,1,2]);
  const group=new THREE.Group();group.add(new THREE.Mesh(geo));applyPlacementTransformToSceneUnits(group,placement);
  const expected=geo.getAttribute('position');
  sample.forEach((vertex,i)=>{
   const target=[expected.getX(i),expected.getY(i),expected.getZ(i)];
   if(Math.max(...target.map((value,k)=>Math.abs(value-positions[vertex*3+k])))>2e-5)throw Error('Source vertex placement disagrees with product helper: '+path);
   geometryProbes.push({chunk:c!.name,vertex:c!.vertexCount+vertex,expected:target});
  });geo.dispose();
 }
 const index=g.index,count=index?.count??p.count,indices=new Uint32Array(count),mirrored=m.determinant()<0;
 for(let i=0;i<count;i+=3){const a=index?index.getX(i):i,b=index?index.getX(i+1):i+1,d=index?index.getX(i+2):i+2;indices.set([a+c.vertexCount,(mirrored?d:b)+c.vertexCount,(mirrored?b:d)+c.vertexCount],i);}
 c.pos.push(positions);c.nor.push(normals);c.idx.push(indices);c.sources.add(path);c.vertexCount+=p.count;c.indexCount+=count;
 stats.tris+=count/3;stats.verts+=p.count;stats.categories[category]=(stats.categories[category]||0)+count/3;
}

const failures:any[]=[];
const geometryProbes:any[]=[];
const hashes=new Map<string,string>();
for(const [index,{occ,row}] of roots.entries()){
 const inverseRoot=new THREE.Matrix4().fromArray(occ.placementMatrix).invert();
 let rootProbe=false;
 const discovered=await discoverGeometriesFromDevPath(occ.devPath,files,occ.placementMatrix,new Set(),0,{instances:0},{rootOccurrence:occ.id,strictDependencies:true});
 for(const leaf of [...discovered.mods,...discovered.stls]){
  const sourcePath='modPath'in leaf?leaf.modPath:leaf.stlPath;
  const path=resolver(sourcePath);if(!path)throw Error('Unresolved leaf '+sourcePath);
  const matrix=leaf.placementTransformMatrix;
  leafRows.push({path,sourcePath:path,matrix,rootOccurrence:occ.id,assemblyPath:leaf.assemblyPath,referencePath:leaf.referencePath,label:row.label});
  // The desktop compiles templates in DEV-local space, independently of CBM
  // world rotation/translation. Keep world placement exact, and use the local
  // linear part only for the outline size policy and its cache identity.
  const localPlacement=inverseRoot.clone().multiply(new THREE.Matrix4().fromArray(matrix)).elements;
  const linear=localPlacement.map((v:number,i:number)=>[12,13,14].includes(i)?0:Math.round(v*1e10)/1e10);
  let hash=hashes.get(path);if(!hash){hash=createHash('sha256').update(new Uint8Array(await files.get(path)!.arrayBuffer())).digest('hex');hashes.set(path,hash);}
  // Share only identical source bytes; keep every path and occurrence in the
  // provenance tables. This is representation reuse, never identity merging.
  const key=JSON.stringify([hash,linear,leaf.phmColor,leaf.phmColorMaxA]);
  let group=compiled.get(key);
  if(!group){
   if(/\.(mod|gl)$/i.test(path)){
    const text=await files.get(path)!.text();const controls=(text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g)||[]).length;
    group=await loadXmlModFromFiles(path,files,leaf.phmColor,leaf.phmColorMaxA,{strict:true,parseXml:parseWorkerXmlMod,lod:LOD,outline:{placementMatrix:localPlacement}})??undefined;
    if(!group)throw Error('Viewer MOD compiler returned no group: '+path);
    const diag=group.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY];
    group.userData.offlineNonXmlControls=controls;
    stats.approximated_booleans+=diag?.simplifiedBooleans||0;stats.tiny_skipped+=diag?.omittedSmallParts||0;
   }else if(/\.stl$/i.test(path)){
    group=parseStlBinary(await files.get(path)!.arrayBuffer(),path)??undefined;
    if(!group)throw Error('Viewer STL parser returned no geometry: '+path);
    if(leaf.phmColor){const c=leaf.phmColor;group.traverse(o=>{if((o as THREE.Mesh).isMesh){const mesh=o as THREE.Mesh;const mat=(mesh.material as THREE.MeshStandardMaterial).clone();mesh.material=mat;mat.color.setRGB(c.r/255,c.g/255,c.b/255);const a=c.a<=0?1:c.a/(leaf.phmColorMaxA!>100?255:100);mat.opacity=a;}});}
   }else throw Error('Unsupported reachable geometry extension: '+path);
   compiled.set(key,group);
  }
  const diag=group.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY];
  if(!sourceRows.has(path)){
   const controls=group.userData.offlineNonXmlControls||0;
   sourceRows.set(path,{path,sha256:hash,diagnostics:diag,nonXmlControls:controls,kind:/\.stl$/i.test(path)?'STL':'MOD'});
   observedNonXmlControls+=controls;
   if(diag){stats.mod_files++;stats.mod_entities+=diag.entityCount||0;stats.unsupported+=diag.unsupportedEntityCount||0;}else stats.stl_files++;
  }
  if(diag?.failedVisibleRoots?.length)failures.push({path,rootOccurrence:occ.id,failures:diag.failedVisibleRoots});
  group.traverse(o=>{if((o as THREE.Mesh).isMesh){add(o as THREE.Mesh,matrix,row.label||occ.name||'其他',path,!rootProbe);rootProbe=true;}});
 }
 if(index%100===0)console.log('viewer export roots',index+1,'/',roots.length,'leaves',leafRows.length,'triangles',stats.tris,'compiled',compiled.size);
}
const usedLeaves=new Set<any>();let maxLeafDifferenceMm=0;
if(VERIFY_ASSEMBLY){
 if(!Array.isArray(legacy.leaf_instances))throw Error('Regenerate the independent Python source/leaf inventory');
 const leafGroups=new Map<string,any[]>();
 for(const leaf of legacy.leaf_instances){const key=canonical(leaf.path),list=leafGroups.get(key)||[];list.push(leaf);leafGroups.set(key,list);}
 for(const leaf of leafRows){
  let chosen:any=null,error=Infinity;
  for(const row of leafGroups.get(canonical(leaf.path))||[]){if(usedLeaves.has(row))continue;const d=Math.max(...row.matrix.map((v:number,i:number)=>Math.abs(v-leaf.matrix[i])));if(d<error){error=d;chosen=row;}}
  if(!chosen||error>2e-5)throw Error('Independent DEV/PHM leaf placement mismatch: '+leaf.path+' '+error);
  usedLeaves.add(chosen);maxLeafDifferenceMm=Math.max(maxLeafDifferenceMm,error);
 }
 if(usedLeaves.size!==legacy.leaf_instances.length)throw Error('Independent leaf occurrence multiplicity mismatch');
}
const temp=join(BUILD,'gim_scene.bin.staging'),fd=openSync(temp,'w');let offset=0;const metaChunks:any[]=[];
function write(array:Float32Array|Uint32Array){const b=Buffer.from(array.buffer,array.byteOffset,array.byteLength);let done=0;while(done<b.length)done+=writeSync(fd,b,done,b.length-done);offset+=b.length;}
try{for(const c of chunks.values()){
 const po=offset;for(const a of c.pos)write(a);const no=offset;for(const a of c.nor)write(a);const io=offset;for(const a of c.idx)write(a);
 metaChunks.push({name:c.name,category:c.category,color:c.color,tile:c.tile,vertexCount:c.vertexCount,indexCount:c.indexCount,positionOffset:po,normalOffset:no,indexOffset:io,bbox:c.bbox,sourcePaths:[...c.sources]});
}}finally{closeSync(fd);}
renameSync(temp,join(BUILD,'gim_scene.bin'));stats.chunks=metaChunks.length;
const audit=VERIFY_ASSEMBLY?{geometryProbes,probeFormatVersion:2,
 viewerParity:{independentRootCount:matched.size,maxRootMatrixDifferenceMm:maxRootDifferenceMm,
 independentLeafCount:usedLeaves.size,maxLeafMatrixDifferenceMm:maxLeafDifferenceMm,
 strictDependencies:true,observedNonXmlControlCharacters:observedNonXmlControls,ifcFiles:graph.ifcPaths}}:{};
const meta={version:2,source:process.env.GIM_BLENDER_SOURCE_NAME,coordinateSystem:'source-z-up-metres-v2',geometryBackend:`gim-blender-lod${LOD}`,geometryLod:LOD,
 stats,chunks:metaChunks,placements:roots.length,dev_instances:legacy.counts.dev_instances,phm_instances:legacy.counts.phm_instances,solids:leafRows.length,leaf_counts:sourceRows.size,leaf_instances:leafRows,
 source_geometry:[...sourceRows.values()],geometryFailures:failures,...audit,
 limits:[`Tool LOD${LOD} browsing approximation; local compiler snapshot, not an engineering accuracy proof.`]};
writeFileSync(join(BUILD,'gim_scene.json'),JSON.stringify(meta));
if(VERIFY_ASSEMBLY){
 writeFileSync(join(BUILD,'viewer_reference_roots.json'),JSON.stringify({occurrenceCount:roots.length,diagnostics:catalog.diagnostics,rows:roots.map(({occ})=>({id:occ.id,sourceId:occ.sourceId,devPath:occ.devPath,matrix:occ.placementMatrix}))}));
 writeFileSync(join(BUILD,'viewer_reference_leaves.json'),JSON.stringify({roots:roots.length,leaves:leafRows,errors:[]}));
}
console.log(JSON.stringify({stats,...audit,geometryFailures:failures.length}));
