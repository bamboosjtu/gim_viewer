import { createReadStream,createWriteStream,readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createGzip,createGunzip,createBrotliDecompress } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { SubstationSpatialIndexBuilder } from '../../src/gim/ifcSpatialParser.js';
import { createIfcModelId } from '../../src/gim/modelIdentity.js';
import { createEngineeringWorkerHandler } from '../../src/services/engineeringWorker.js';
import { decodeEngineeringWorkerResult,engineeringWorkerResultTransfers } from '../../src/services/engineeringWorkerTransport.js';
import { engineeringNavigationToWire,assertEngineeringNavigation } from '../../src/services/engineeringNavigationCache.js';
import { EngineeringRepresentationIndex,type SourceRepresentation } from '../../src/engineering/representations.js';
import type { EngineeringBuildResult } from '../../src/services/engineeringWorkerProtocol.js';
import { assertEngineeringPartition } from '../../src/engineering/validate.js';
import { engineeringGoldenRows,engineeringSnapshotRows,goldenLine,hash,assertGoldenFresh,flatJsonBytes } from '../../acceptance/engineering/golden.js';
import { isUsableAffineMatrix } from '../../src/gim/geometry/affineMatrix.js';
import { isIfcFeatureSourceType } from '../../src/gim/engineering/sourceEvidence.js';
import { normalizeEngineeringSources } from '../../src/gim/engineering/buildSources.js';

const sample=process.env.GIM_CORPUS_SAMPLE!,candidate=process.env.GIM_GOLDEN_MODE==='candidate';
const output=resolve('../output/engineering-stage3'),fixture=resolve(`../output/engineering-stage3/corpus-v1/${sample}`);
const goldens=resolve('acceptance/engineering/goldens'),proposals=join(output,'candidates');
const manifest=JSON.parse(readFileSync(resolve('acceptance/engineering/corpus.json'),'utf8'));
const definition=manifest.samples.find((s:{id:string})=>s.id===sample);
const fingerprint=JSON.parse(readFileSync(join(output,'fingerprint.json'),'utf8'));
const identity={sourceSha256:definition.sha256,parserVersion:fingerprint.implementationSha256,entries:[] as string[]};
const stages:Array<{name:string;elapsedMs:number;rssBytes:number}>=[],start=performance.now();
function stage(name:string){stages.push({name,elapsedMs:performance.now()-start,rssBytes:process.memoryUsage().rss});console.log(`${sample}: ${name}`);}

function assertFixedCases(model:EngineeringBuildResult){
  const {snapshot,sources,navigation}=model;
  assertEngineeringPartition(snapshot,[...sources.graph.records,...sources.ifcRecords].map(r=>r.id));assertEngineeringNavigation(navigation,sources,snapshot);
  const members=new Map(snapshot.memberships.map(m=>[m.sourceId,m]));
  for(const source of sources.ifcRecords)if(isIfcFeatureSourceType(source.source_type)&&members.get(source.id)?.interpretation.meaning!=='source_only')throw Error('IFC feature became an engineering whole');
  const named=(title:string)=>[...navigation.composition.nodes.values()].find(n=>n.kind==='group'&&n.title===title);
  if(sample==='s01'&&(!named('36S间隔')||!named('24S间隔')||named('20千伏配电装置')))throw Error('s01 declared bay projection regressed');
  if(sample==='s03'&&(!named('主控通信楼01')?.declaredContextIds?.length||!named('配电室01')?.declaredContextIds?.length||named('Default Building')))throw Error('Declared building contexts regressed');
  if(sample==='s02'&&named('HN-220-B-2总平面')||sample==='b11'&&named('建筑s')||sample==='b13'&&(named('新建筑1')||named('新建筑 1')))throw Error('Placeholder building became business context');
  if(sample==='s04'&&[110,35,10].some(kv=>!named(`${kv}千伏配电装置`)?.entityCount))throw Error('s04 distribution context coverage');
  if(navigation.inventory!.nodes.get(navigation.inventory!.rootKey)!.children.map(k=>navigation.inventory!.nodes.get(k)!.title).join('|')!=='设备|装置性材料|构件|其他')throw Error('Inventory business roots');
  if(sample==='s01'){
    const members=new Map(snapshot.memberships.map(m=>[m.sourceId,m])),owners=new Map(snapshot.entities.map(e=>[e.id,e]));
    const actuators=sources.graph.records.filter(r=>r.name==='操动机构箱');if(actuators.length!==3)throw Error('s01 operating-box source evidence changed');
    for(const r of actuators)if(members.get(r.id)?.ownerId!==members.get(r.parent)?.ownerId||owners.get(members.get(r.id)!.ownerId!)?.category!=='E05')throw Error('GIS integrated operating box became independent');
    const attached=sources.graph.records.filter(r=>/端子箱/.test(r.name)&&members.get(r.parent)?.interpretation.category==='E10');if(attached.length!==12)throw Error('s01 capacitor terminal source evidence changed');
    for(const r of attached)if(members.get(r.id)?.ownerId!==members.get(r.parent)?.ownerId)throw Error('Integrated terminal became independent');
    const independent=sources.ifcRecords.filter(r=>/端子箱模型01:Null:275431[79]/.test(r.name));if(independent.length!==2)throw Error('s01 independent terminals lost');
    for(const r of independent)if(owners.get(members.get(r.id)!.ownerId!)?.category!=='E16.terminal_box')throw Error('Standalone terminal swallowed');
    const sprinklers=sources.ifcRecords.filter(r=>/喷淋头/.test(r.name));if(sprinklers.length!==80||sprinklers.some(r=>members.get(r.id)?.interpretation.category!=='C-D5'))throw Error('Sprinkler family head classification regressed');
    const neutrals=snapshot.memberships.filter(m=>m.interpretation.meaning==='neutral_set');if(neutrals.length!==6||navigation.inventory!.nodes.get(navigation.inventory!.rootKey)?.attachmentCount!==6)throw Error('Neutral attachment visibility regressed');
  }
}

function assertRepresentations(model:EngineeringBuildResult){
  const records=[...model.sources.graph.records,...model.sources.ifcRecords],bindings:SourceRepresentation[]=records.map(r=>r.ifcOccurrence?{kind:'ifc',sourceId:r.id,...r.ifcOccurrence}:{kind:'dev',sourceId:r.id,rootOccurrence:r.devOccurrence!.rootSourceId,assemblyPath:r.devOccurrence!.assemblyPath,devPath:r.source});
  const index=new EngineeringRepresentationIndex(model.snapshot,bindings);
  for(const r of records){
    const result=r.ifcOccurrence?index.resolveIfc(r.ifcOccurrence.modelId,r.ifcOccurrence.expressId):index.resolveDev(r.devOccurrence!.rootSourceId,{assemblyPath:r.devOccurrence!.assemblyPath});
    if(!result.sourceIds.includes(r.id))throw Error(`Representation source address lost: ${r.id}`);
    if(r.devOccurrence&&!index.resolveDev(r.devOccurrence.rootSourceId,{assemblyPath:[r.devOccurrence.assemblyPath,'phm:0','mod:0'].filter(Boolean).join('/')}).sourceIds.includes(r.id))throw Error('Physical descendant fallback regressed');
  }
  if(model.geometryOccurrences.occurrences.length!==model.sources.graph.records.filter(r=>r.devOccurrence?.rootSourceId===r.id).length)throw Error('Geometry seed count changed by identity');
  if(model.geometryOccurrences.occurrences.some(o=>!isUsableAffineMatrix(o.placementMatrix)))throw Error('Invalid cumulative source placement');
}

async function canonical(model:EngineeringBuildResult,destination?:string,expected?:string){
  const sectionHashes=new Map<string,ReturnType<typeof createHash>>(),counts:Record<string,number>={},all=createHash('sha256');
  const writer=destination?createGzip({level:9}):undefined,file=destination?createWriteStream(destination):undefined;
  if(writer&&file)writer.pipe(file);
  const reader=expected?createInterface({input:createReadStream(expected).pipe(expected.endsWith('.br')?createBrotliDecompress():createGunzip()),crlfDelay:Infinity}):undefined;
  const iterator=reader?.[Symbol.asyncIterator]();let failures=0;const differences:unknown[]=[];
  for(const row of engineeringGoldenRows(model.sources,model.snapshot,model.navigation,model.geometryOccurrences)){
    const text=goldenLine(row),line=text+'\n';all.update(line);counts[row[0]]=(counts[row[0]]??0)+1;
    let digest=sectionHashes.get(row[0]);if(!digest){digest=createHash('sha256');sectionHashes.set(row[0],digest);}digest.update(line);
    if(writer&&!writer.write(line))await once(writer,'drain');
    if(iterator){const old=await iterator.next();if(old.done||old.value!==text){failures++;if(differences.length<30)differences.push({section:row[0],key:row[1],before:old.done?null:JSON.parse(old.value),after:row});}}
  }
  if(iterator&&!(await iterator.next()).done){failures++;differences.push({reason:'Golden has additional rows'});}
  reader?.close();
  if(writer&&file){writer.end();await once(file,'finish');}
  if(failures){writeFileSync(join(output,`${sample}-differences.json`),JSON.stringify({failures,differences},null,2));throw Error(`${sample}: ${failures} entity/member/projection golden differences`);}
  return {sha256:all.digest('hex'),counts,sections:Object.fromEntries([...sectionHashes].map(([key,d])=>[key,d.digest('hex')]))};
}

async function main(){
  mkdirSync(output,{recursive:true});mkdirSync(proposals,{recursive:true});
  if(hash(readFileSync(resolve('..',definition.path)))!==definition.sha256)throw Error('Actual source package SHA mismatch');
  const raw=JSON.parse(readFileSync(join(fixture,'identity.json'),'utf8'));
  if(raw.sha256!==definition.sha256)throw Error('Extracted corpus source identity mismatch');identity.entries=raw.paths;
  const expectedMetaPath=join(goldens,`${sample}.json`);
  if(!candidate)assertGoldenFresh(JSON.parse(readFileSync(expectedMetaPath,'utf8')),{sourceSha256:definition.sha256,implementationSha256:fingerprint.implementationSha256});
  const hashes=new Map<string,string>(raw.semantic.map((e:{path:string;sha256:string})=>[e.path,e.sha256]));
  const read=(path:string)=>{const bytes=readFileSync(join(fixture,'files',path));if(hash(bytes)!==hashes.get(path))throw Error(`Raw source fixture modified: ${path}`);return new Uint8Array(bytes);};
  let handle=createEngineeringWorkerHandler();await handle({type:'init',scope:definition.sha256,paths:raw.paths});
  const textPaths=raw.paths.filter((p:string)=>/\.(?:cbm|dev|fam)$/i.test(p));
  for(let i=0;i<textPaths.length;i+=256)await handle({type:'files',files:textPaths.slice(i,i+256).map((path:string)=>({path,bytes:read(path)}))});
  const extraction=await handle({type:'extract'});if(extraction.type!=='graph')throw Error('Graph expected');stage('source-extracted');
  const builder=new SubstationSpatialIndexBuilder(null);
  for(const path of extraction.summary.ifcPaths){builder.addIfcModel({modelId:createIfcModelId(path),path,name:path},new TextDecoder('utf-8',{fatal:true}).decode(read(path)));await new Promise<void>(r=>setImmediate(r));}
  const spatial=builder.finalize();if(spatial.models.some(m=>m.parseError))throw Error('IFC source parser failed');stage('ifc-parsed');
  const reply=await handle({type:'assemble',objects:spatial.objects,models:spatial.models,nodes:spatial.nodes,identity});if(reply.type!=='model')throw Error('Model expected');
  const received=structuredClone(reply.result,{transfer:engineeringWorkerResultTransfers(reply.result)});
  let model:EngineeringBuildResult|undefined=await decodeEngineeringWorkerResult(received,()=>true);received.body=new Uint8Array();stage('display-hydrated');
  assertFixedCases(model);assertRepresentations(model);stage('partition-projection-representation-verified');
  const reversed=normalizeEngineeringSources(definition.sha256,{...model.sources,graph:{...model.sources.graph,records:[...model.sources.graph.records].reverse()},ifcRecords:[...model.sources.ifcRecords].reverse()});
  const snapshotHash=(snapshot:typeof reversed)=>{const h=createHash('sha256');for(const row of engineeringSnapshotRows(snapshot))h.update(goldenLine(row)+'\n');return h.digest('hex');};
  if(snapshotHash(reversed)!==snapshotHash(model.snapshot))throw Error('Real-source ordering changed whole identity or membership');
  const result:Record<string,unknown>={sample,mode:candidate?'candidate':'verify',sourceSha256:definition.sha256,implementationSha256:fingerprint.implementationSha256,complete:model.sources.complete,incompleteReasons:model.sources.incompleteReasons,sources:model.snapshot.memberships.length,entities:model.snapshot.entities.length,pending:model.snapshot.pending.length,sourceOrderInvariant:true,transport:model.metrics,cacheStages:[]};
  const cacheDir=join(output,'cache',sample);mkdirSync(cacheDir,{recursive:true});
  for(const domain of model.cachePlan??[]){
    const cache=await handle({type:'encode-cache',buildId:model.buildId!,domain});if(cache.type!=='cache'||cache.result.error||!cache.result.bytes)throw Error(`Real cache failed: ${JSON.stringify(cache)}`);
    writeFileSync(join(cacheDir,`${domain}.bin`),cache.result.bytes);(result.cacheStages as unknown[]).push({domain,...cache.result.metrics});cache.result.bytes=undefined;stage(`cache-${domain}-saved`);
  }
  const golden=await canonical(model,candidate?join(proposals,`${sample}.jsonl.gz`):undefined,candidate?undefined:join(goldens,`${sample}.jsonl.br`));
  if(candidate)writeFileSync(join(proposals,`${sample}.json`),JSON.stringify({sourceSha256:definition.sha256,implementationSha256:fingerprint.implementationSha256,...golden,reviewBasis:'Current contract regression baseline; partition/representation checks and fixed source-backed cases. Not independently audited per-instance manual truth.'},null,2));
  result.golden=golden;
  if(['b13','b14'].includes(sample))result.legacyFlatPlainBytes={entities:flatJsonBytes(model.snapshot),navigation:flatJsonBytes(engineeringNavigationToWire(model.navigation))};
  const complete=model.sources.complete;await handle({type:'init',scope:'released',paths:[]});model=undefined;
  if(complete){
    handle=createEngineeringWorkerHandler();
    const started=performance.now(),warm=await handle({type:'restore',sourceBytes:new Uint8Array(readFileSync(join(cacheDir,'sources.bin'))),entityBytes:new Uint8Array(readFileSync(join(cacheDir,'entities.bin'))),navigationBytes:new Uint8Array(readFileSync(join(cacheDir,'navigation.bin'))),identity});
    if(warm.type!=='model')throw Error('Warm model expected');
    const restored=await decodeEngineeringWorkerResult(warm.result,()=>true);
    if(!restored.entityCacheHit||!restored.navigationCacheHit||restored.cachePlan?.length)throw Error('Warm domains did not restore completely');
    const replay=await canonical(restored);if(replay.sha256!==golden.sha256)throw Error('Cold/warm entity/member/projection mismatch');
    result.warm={ms:performance.now()-started,entityCacheHit:true,navigationCacheHit:true,semanticSha256:replay.sha256};stage('warm-all-domains-verified');
  }
  let maxRssKiB:number|null=null;try{maxRssKiB=process.resourceUsage().maxRSS;}catch{}
  result.memory={maxRssKiB,phaseSamples:stages,scope:'Node harness includes parser, display transport, golden rows, cache replay and legacy size estimate; not WebView/native rendering SLO'};
  result.passed=true;writeFileSync(join(output,`${sample}-result.json`),JSON.stringify(result,null,2));console.log(`${sample}: passed (${result.sources} sources)`);
}
main().catch(error=>{writeFileSync(join(output,`${sample}-result.json`),JSON.stringify({sample,passed:false,error:String(error)},null,2));console.error(error);process.exitCode=1;});
