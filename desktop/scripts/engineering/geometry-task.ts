import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {extractEngineeringSourceGraph} from '../../src/gim/engineering/sourceGraph.js';
import {collectSourceGeometryOccurrences} from '../../src/gim/engineering/geometryOccurrences.js';
import {discoverGeometriesFromDevPath} from '../../src/services/modGeometryDiscovery.js';
import {isUsableAffineMatrix} from '../../src/gim/geometry/affineMatrix.js';
import {hash} from '../../acceptance/engineering/golden.js';

const sample=process.env.GIM_CORPUS_SAMPLE!,output=resolve('../output/engineering-stage3'),root=join(output,'corpus-v1',sample);
async function main(){
 const corpus=JSON.parse(readFileSync(resolve('acceptance/engineering/corpus.json'),'utf8')).samples.find((s:{id:string})=>s.id===sample);
 if(hash(readFileSync(resolve('..',corpus.path)))!==corpus.sha256)throw Error('Geometry source SHA mismatch');
 const identity=JSON.parse(readFileSync(join(root,'identity.json'),'utf8'));
 if(identity.sha256!==corpus.sha256||!identity.geometry)throw Error('Prepare current semantic and PHM corpus first');
 const hashes=new Map<string,string>([...identity.semantic,...identity.geometry].map((f:{path:string;sha256:string})=>[f.path,f.sha256]));
 const read=async(path:string)=>{const data=readFileSync(join(root,'files',path));if(hash(data)!==hashes.get(path))throw Error(`Geometry raw fixture modified: ${path}`);try{return new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{return new TextDecoder('gb18030',{fatal:true}).decode(data);}};
 const graph=await extractEngineeringSourceGraph({paths:identity.paths,readText:read}),catalog=collectSourceGeometryOccurrences(graph);
 const files=new Map<string,File>(identity.paths.map((path:string)=>[path,{name:path.split('/').pop()!,size:0,text:()=>read(path)} as File]));
 const counts={roots:catalog.occurrences.length,templates:0,modLeaves:0,stlLeaves:0,reachableOccurrences:0},unavailable:Array<{path:string;reason:string}>=[];
 for(const path of [...new Set(catalog.occurrences.map(o=>o.devPath))]){
  const rows=catalog.occurrences.filter(o=>o.devPath===path),local=await discoverGeometriesFromDevPath(path,files,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],new Set(),0,{instances:0},{strictDependencies:false});
  if([...local.mods,...local.stls].some(r=>!isUsableAffineMatrix(r.placementTransformMatrix)))throw Error('Geometry reference transform invalid');
  counts.templates++;counts.modLeaves+=local.mods.length;counts.stlLeaves+=local.stls.length;counts.reachableOccurrences+=(local.mods.length+local.stls.length)*rows.length;
  try{await discoverGeometriesFromDevPath(path,files,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],new Set(),0,{instances:0},{strictDependencies:true});}catch(error){unavailable.push({path,reason:String(error)});}
 }
 if(!counts.roots||!counts.reachableOccurrences||catalog.occurrences.some(o=>!isUsableAffineMatrix(o.placementMatrix)))throw Error('Physical geometry occurrence coverage failed');
 writeFileSync(join(output,`${sample}-geometry.json`),JSON.stringify({sample,passed:true,sourceSha256:corpus.sha256,...counts,unavailable,scope:'Actual DEV/PHM reference chains, cumulative matrices and leaf availability. No triangulation or native rendering.'},null,2));
 console.log(sample,JSON.stringify(counts));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
