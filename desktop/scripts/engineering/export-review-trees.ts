/** Run from desktop/: npx vite-node scripts/engineering/export-review-trees.ts
 * Requires the pinned nine-corpus raw files under
 * output/engineering-stage3/corpus-v1/<id>/files and source-Z-up bounds under
 * output/review-bounds/<id>-ifc-bounds.json. No sample is modified. */
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {extractEngineeringSourceGraph} from '../../src/gim/engineering/sourceGraph.js';
import {SubstationSpatialIndexBuilder} from '../../src/gim/ifcSpatialParser.js';
import {createIfcModelId} from '../../src/gim/modelIdentity.js';
import {buildEngineeringSources} from '../../src/gim/engineering/buildSources.js';
import {projectEngineeringNavigation} from '../../src/gim/engineering/navigation.js';
import {finalizeEngineeringComposition,projectEngineeringComposition} from '../../src/engineering/composition.js';
import {projectSpatialComposition,type CompositionBounds} from '../../src/services/projections/compositionSpatial.js';
import {assertEngineeringNavigation,encodeEngineeringNavigation,decodeEngineeringNavigation,engineeringNavigationToWire} from '../../src/services/engineeringNavigationCache.js';

const desktop=resolve('.');
const root=resolve('..');
const corpus=JSON.parse(readFileSync(join(desktop,'acceptance/engineering/corpus.json'),'utf8'));
const rawRoot=resolve(process.env.GIM_REVIEW_RAW_ROOT??join(root,'output/engineering-stage3/corpus-v1'));
const boundsRoot=resolve(process.env.GIM_REVIEW_BOUNDS_ROOT??join(root,'output/review-bounds'));
const out=resolve(process.env.GIM_REVIEW_OUT??join(root,'research/reviews/2026-11-03/model-tree'));
mkdirSync(out,{recursive:true});
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function files(dir:string, result:string[]=[], base:string=dir):string[] {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    if(entry.isDirectory()) files(path,result,base);
    else if(/\.(?:cbm|dev|fam|ifc)$/i.test(entry.name)) result.push(relative(base,path));
  }
  return result;
}
function readText(path:string){ return readFileSync(path).toString('utf8'); }
const results=[];
for(const sample of corpus.samples){
  if(process.env.GIM_REVIEW_SAMPLE&&sample.id!==process.env.GIM_REVIEW_SAMPLE) continue;
  const sourcePath=join(root,sample.path), sourceBytes=readFileSync(sourcePath);
  if(sourceBytes.length!==sample.bytes||sha(sourceBytes)!==sample.sha256) throw Error(`${sample.id}: source identity mismatch`);
  const raw=join(rawRoot,sample.id,'files');
  const receipt=JSON.parse(readFileSync(join(rawRoot,sample.id,'identity.json'),'utf8'));
  if(receipt.sha256!==sample.sha256)throw Error(`${sample.id}: raw corpus source mismatch`);
  for(const item of receipt.semantic)if(sha(readFileSync(join(raw,item.path)))!==item.sha256)throw Error(`${sample.id}: raw file mismatch ${item.path}`);
  if(!readdirSync(raw).length) throw Error(`${sample.id}: missing raw corpus; run prepare-corpus.py`);
  const paths=files(raw).map(path=>path.replace(/\\/g,'/'));
  if(!paths.some(path=>/^CBM\/project\.cbm$/i.test(path))) throw Error(`${sample.id}: raw corpus has no CBM/project.cbm`);
  const graph=await extractEngineeringSourceGraph({paths,readText:async path=>readText(join(raw,path))});
  // Spatial nodes use the same source adapter as the app; IFC geometry bounds
  // are independent web-ifc evidence and must carry the same source SHA.
  const builder=new SubstationSpatialIndexBuilder(null);
  for(const path of graph.ifcPaths) builder.addIfcModel({modelId:createIfcModelId(path),path,name:path},readText(join(raw,path)));
  const spatial=builder.finalize();
  const rebuilt=buildEngineeringSources(sample.sha256,graph,spatial.objects,spatial.models,spatial.nodes);
  const view=projectEngineeringNavigation(rebuilt.sources,rebuilt.snapshot);
  const owners=new Map(rebuilt.snapshot.memberships.map(row=>[row.sourceId,row.ownerId]));
  const boundsFile=join(boundsRoot,`${sample.id}-ifc-bounds.json`);
  const geometric=JSON.parse(readFileSync(boundsFile,'utf8'));
  if(geometric.length!==graph.ifcPaths.length) throw Error(`${sample.id}: geometry manifest mismatch`);
  const bounds:CompositionBounds[]=[];
  for(const model of geometric){
    if(!graph.ifcPaths.includes(model.path)) throw Error(`${sample.id}: unknown IFC model ${model.path}`);
    const modelPath=join(raw,model.path), modelSha=sha(readFileSync(modelPath));
    if(model.sha256!==modelSha) throw Error(`${sample.id}: missing/stale IFC bounds ${model.path}`);
    for(const object of model.objects??[]){
      const sourceId=`ifc:${JSON.stringify([createIfcModelId(model.path),object.expressId])}`,owner=owners.get(sourceId);
      if(owner) bounds.push({entityId:owner,bounds:object.bounds,evidence:sourceId});
    }
  }
  const diagnostics={footprints:[]};
  const input=view.compositionInput;
  if(!input) throw Error(`${sample.id}: missing composition input`);
  const assignments=projectSpatialComposition(rebuilt.snapshot,input.facts,bounds,diagnostics,input.declarations);
  if(process.env.GIM_REVIEW_EVIDENCE)writeFileSync(join(out,`${sample.id}-evidence.json`),JSON.stringify({entities:rebuilt.snapshot.entities,facts:input.facts,bounds,assignments,declarations:input.declarations}));
  view.composition=finalizeEngineeringComposition(projectEngineeringComposition(rebuilt.snapshot,assignments,'工程组成',input.declarations));
  view.compositionComplete=true;
  assertEngineeringNavigation(view,rebuilt.sources,rebuilt.snapshot);
  if(process.env.GIM_REVIEW_CACHE){
    const identity={sourceSha256:sample.sha256,parserVersion:'review-final-projection',entries:paths};
    const bytes=await encodeEngineeringNavigation(view,rebuilt.sources,rebuilt.snapshot,sample.sha256,identity);
    const restored=await decodeEngineeringNavigation(bytes,rebuilt.sources,rebuilt.snapshot,sample.sha256,identity);
    if(JSON.stringify(engineeringNavigationToWire(restored))!==JSON.stringify(engineeringNavigationToWire(view)))throw Error(`${sample.id}: final navigation cache roundtrip mismatch`);
    writeFileSync(join(out,`${sample.id}-navigation-cache.json`),JSON.stringify({sample:sample.id,complete:restored.compositionComplete,bytes:bytes.length,identical:true}));
  }
  const visit=(key:string):unknown=>{const node=view.composition.nodes.get(key)!;return {title:node.title,kind:node.kind,...(node.targetId?{targetId:node.targetId}:{}),entityCount:node.entityCount,...(node.kind==='group'&&node.evidence.length?{evidence:node.evidence.filter(e=>!e.startsWith('entity:'))}:{}),children:node.children.map(visit)};};
  writeFileSync(join(out,`${sample.id}-composition.json`),JSON.stringify({schema:'gim-engineering-composition-review-v1',sample:sample.id,sourceSha256:sample.sha256,metadata:view.metadata,root:visit(view.composition.rootKey)},null,2));
  const groups=[...view.composition.nodes.values()].filter(node=>node.kind==='group');
  const buildings=groups.filter(node=>{const parts=node.key.split('/');return parts[parts.length-1]?.startsWith('building:');}).map(node=>({name:node.title,entityCount:node.entityCount}));
  const mains=rebuilt.snapshot.entities.filter(entity=>entity.category==='E01').map(entity=>({name:entity.name,sourceCount:entity.sourceIds.length,roots:graph.records.filter(row=>!row.parent&&entity.sourceIds.includes(row.id)).map(row=>({name:row.name,type:row.source_type}))}));
  const row={sample:sample.id,sourceSha256:sample.sha256,rulesVersion:rebuilt.snapshot.rulesVersion,sourceVersion:rebuilt.sources.version,navigationVersion:view.version,sourceComplete:rebuilt.sources.complete,incompleteReasons:rebuilt.sources.incompleteReasons,outwardSources:rebuilt.snapshot.memberships.length,entities:rebuilt.snapshot.entities.length,pending:rebuilt.snapshot.pending.length,geometryBounds:bounds.length,buildings,mains,wrongMainCabinets:rebuilt.snapshot.entities.filter(entity=>entity.category==='E01'&&/柜|屏/.test(entity.name)).length};
  writeFileSync(join(out,`${sample.id}-checks.json`),JSON.stringify({...row,diagnostics},null,2));results.push(row);console.log(JSON.stringify(row));
}
writeFileSync(join(out,process.env.GIM_REVIEW_SAMPLE?'partial-manifest.json':'manifest.json'),JSON.stringify({complete:results.length===corpus.samples.length,scope:'all outward DEV/IFC sources; actual IFC geometry for composition only; classification requires engineering review',boundsRoot,rawRoot,results},null,2));
