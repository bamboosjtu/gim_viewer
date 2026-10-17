// Manual single-file correctness probe, never part of the default test suite.
// Compares a bounded regional subset to source reopen. The optional mutation
// and catalog modes reproduce rejected alternatives; they are not product paths.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const [file,output,mode='subset']=process.argv.slice(2);
if(!file||!output||!['subset','mutation','catalog'].includes(mode))throw Error('Usage (desktop cwd): node scripts/benchmarks/ifc-regional-mutation-check.mjs source.ifc output.json [subset|mutation|catalog]');
const bundle=resolve('node_modules/.cache/gim-ifc-regional-probe.cjs');
await build({stdin:{contents:`export {readRegionalSemantics,classifyRegionalOpenings} from './src/viewer/ifcRegionalData.ts';
export {extractIfcObjectFine} from './src/viewer/ifcObjectFineData.ts';
export {RegionalSubsetBuilder} from './src/viewer/ifcRegionalSubset.ts';
export {IfcOpeningRelationEditor} from './src/viewer/ifcOpeningPolicy.ts';`,resolveDir:process.cwd(),loader:'ts'},
  bundle:true,platform:'node',format:'cjs',packages:'external',outfile:bundle});
const {readRegionalSemantics,classifyRegionalOpenings,extractIfcObjectFine,IfcOpeningRelationEditor,RegionalSubsetBuilder}=require(bundle);
const {IfcAPI,IFCMECHANICALFASTENER}=require('web-ifc'),api=new IfcAPI();await api.Init(undefined,true);
const source=readFileSync(file),sha=createHash('sha256').update(source).digest('hex');
if(sha!=='71d5d31cdddbf01f336864cc6d13a469ce07efa475e175f2f7b7ec65df679605')throw Error('Probe targets belong to the registered steel source only');
const hosts=[71558,71482,70538],batches=[[71558],[71482,70538]];
const snapshot=(model,selected=hosts)=>selected.map(id=>{
  const guid=api.GetLine(model,id,false).GlobalId.value,result=extractIfcObjectFine(api,model,id,guid);
  const parts=result.parts.map(part=>{const hash=createHash('sha256');hash.update(Buffer.from(part.vertices.buffer,part.vertices.byteOffset,part.vertices.byteLength));
    hash.update(Buffer.from(part.indices.buffer,part.indices.byteOffset,part.indices.byteLength));hash.update(JSON.stringify([part.matrix,part.color]));return hash.digest('hex');}).sort();
  return {id,guid,parts,details:result.parts.map(part=>({vertices:[...part.vertices],indices:[...part.indices],matrix:part.matrix,color:part.color})),coordinationMatrix:result.coordinationMatrix,triangles:result.parts.reduce((sum,part)=>sum+part.indices.length/3,0)};
});
const started=performance.now();let model=api.OpenModel(source,{COORDINATE_TO_ORIGIN:false});
const sourceOpenMs=performance.now()-started,index={objects:[],...readRegionalSemantics(api,model)};
if(mode==='subset'){
  const ids=api.GetLineIDsWithType(model,IFCMECHANICALFASTENER);const fastener=ids.get(0);ids.delete?.();
  let retained;
  for(const host of [...new Set(index.openingRelations.map(row=>row.host))].slice(0,64)){
    if(hosts.includes(host))continue;
    if(classifyRegionalOpenings(api,model,index,new Set([host])).retained){retained=host;break;}
  }
  for(const id of [fastener,retained].filter(Boolean))if(!hosts.includes(id)){hosts.push(id);batches[0].push(id);}
}
const original=snapshot(model),phases=[],removed=new Set();
let metadataMs=0,policyOpenMs=0;
if(mode==='subset'){
  const builder=new RegionalSubsetBuilder(api,model,index),requested=new Set();
  for(const batch of batches){
    const classification=classifyRegionalOpenings(api,model,index,new Set(batch));classification.small.forEach(id=>removed.add(id));batch.forEach(id=>requested.add(id));
    const subset=builder.build([...requested],removed);
    const geometry=snapshot(subset.model,hosts.filter(id=>requested.has(id)));api.CloseModel(subset.model);
    phases.push({batch,classification,cumulative:[...removed],requested:[...requested],subsetMs:subset.elapsedMs,subsetRecords:subset.records,geometry});
  }
} else if(mode==='catalog'){
  const start=performance.now(),allHosts=[...new Set(index.openingRelations.map(row=>row.host))],small=[];
  for(let i=0;i<allHosts.length;i+=128)small.push(...classifyRegionalOpenings(api,model,index,new Set(allHosts.slice(i,i+128))).small);
  metadataMs=performance.now()-start;
  for(const batch of batches){const classification=classifyRegionalOpenings(api,model,index,new Set(batch));classification.small.forEach(id=>removed.add(id));
    phases.push({batch,classification,cumulative:[...removed]});}
  api.CloseModel(model);
  const input=Buffer.from(source);new IfcOpeningRelationEditor(input).omit(small);
  const openStarted=performance.now();model=api.OpenModel(input,{COORDINATE_TO_ORIGIN:false});policyOpenMs=performance.now()-openStarted;
  const requested=new Set();
  for(const phase of phases){phase.batch.forEach(id=>requested.add(id));phase.requested=[...requested];phase.geometry=snapshot(model).filter(row=>requested.has(row.id));}
} else {
for(const batch of batches){
  const classification=classifyRegionalOpenings(api,model,index,new Set(batch));
  classification.small.forEach(id=>removed.add(id));
  const start=performance.now();classification.small.forEach(id=>api.DeleteLine(model,id));api.ResetCache(model);
  const mutationMs=performance.now()-start;
  phases.push({batch,classification,cumulative:[...removed],mutationMs,geometry:snapshot(model)});
}
}
api.CloseModel(model);
for(const phase of phases){
  const input=Buffer.from(source);new IfcOpeningRelationEditor(input).omit(phase.cumulative);
  const start=performance.now();model=api.OpenModel(input,{COORDINATE_TO_ORIGIN:false});phase.reopenMs=performance.now()-start;
  phase.baseline=snapshot(model).filter(row=>!phase.requested||phase.requested.includes(row.id));phase.equal=JSON.stringify(phase.geometry)===JSON.stringify(phase.baseline);api.CloseModel(model);
  phase.differences=phase.geometry.map((object,i)=>({id:object.id,parts:object.details.map((part,j)=>{
    const other=phase.baseline[i].details[j];const maximum=(a,b)=>a.length===b.length?Math.max(0,...a.map((v,k)=>Math.abs(v-b[k]))):null;
    return {vertices:maximum(part.vertices,other.vertices),indices:maximum(part.indices,other.indices),matrix:maximum(part.matrix,other.matrix),color:maximum(part.color,other.color)};
  })}));
}
const result={scope:'Single steel source; exact vertices, indices, colors, placement and coordination matrix hashes on the explicitly listed products; no full station',
  mode,sourceSha256:sha,sourceBytes:source.length,sourceOpenMs,metadataMs,policyOpenMs,original,phases,passed:phases.every(phase=>phase.equal&&phase.classification.small.length>0)};
mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,mode,sourceOpenMs,metadataMs,policyOpenMs,phases:phases.map(({batch,classification,mutationMs,subsetMs,subsetRecords,reopenMs,equal,differences})=>({batch,classification,mutationMs,subsetMs,subsetRecords,reopenMs,equal,differences}))}));
if(!result.passed)process.exitCode=1;
