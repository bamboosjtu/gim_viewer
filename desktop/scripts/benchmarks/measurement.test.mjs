import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareRuns,approveBaseline} from './compare.mjs';
import {selectSamples} from './samples.mjs';
import {CdpConnection} from './cdp.mjs';
import {cacheVerified,coldWarmEquivalent,verifyProfile} from './profiles.mjs';
import {prepareFixedRuntimeSecurity} from '../fixed-runtime-security.mjs';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const conditions={machineId:'machine',runtimeSha256:'runtime',buildMode:'release',measurementVersion:'v1',mode:'benchmark',scenario:'open',cacheState:'cold',sourceSha256:'source',sampleId:'sample',profileDigest:'profile',workloadDigest:'workload',routeDigest:'route',viewportDigest:'viewport'};
const runs=(prefix,value)=>Array.from({length:3},(_,i)=>({conditions:{...conditions},processInstanceId:`${prefix}-${i}`,correctness:'passed',cacheVerified:true,measurementComplete:true,requiredMetrics:['openMs'],metrics:{openMs:value+i}}));
test('missing evidence is inconclusive, explicit correctness failure is fail',()=>{
  const b=runs('base',100),c=runs('candidate',100);c[0].measurementComplete=false;assert.equal(compareRuns(b,c).outcome,'INCONCLUSIVE');c[0].correctness='failed';assert.equal(compareRuns(b,c).outcome,'FAIL');
});
test('different metric sets cannot pass by comparing missing values',()=>{
  const b=runs('base',100),c=runs('candidate',100);for(const run of c){run.requiredMetrics=['otherMs'];run.metrics={otherMs:1};}
  assert.equal(compareRuns(b,c).outcome,'INCONCLUSIVE');
});
test('regression requires independent retest and cannot be hidden by a mode or workload change',()=>{
  const b=runs('b',100),c=runs('c',120);assert.equal(compareRuns(b,c).requiresRetest,true);
  assert.equal(compareRuns(b,c,{retestBaseline:runs('br',100),retestCandidate:runs('cr',120)}).outcome,'FAIL');
  c[0].conditions.mode='diagnostic';assert.equal(compareRuns(b,c).outcome,'INCONCLUSIVE');
});
test('baseline promotion is explicit and refuses incomplete or unfrozen candidates',()=>{
  const candidate={outcome:'PASS',selectionFrozen:true,runs:runs('base',100)};
  assert.throws(()=>approveBaseline(candidate,''));assert.throws(()=>approveBaseline({...candidate,selectionFrozen:false},'developer'));
  assert.ok(approveBaseline(candidate,'developer').approval.candidateDigest);
});
test('warm cache proof is domain-specific and misses cannot masquerade as a warm run',()=>{
  const evidence={cache:{sourceMatches:true,semanticValid:true,ifcFarHits:2,linePack:'valid'},progress:{cacheSettled:true,
    workload:{devSources:3,ifcSources:2},cache:{engineering:'hit',devCatalogHits:3,writeFailures:0,readFailures:0}}};
  assert.equal(cacheVerified(evidence,'warm','substation'),true);evidence.cache.ifcFarHits=1;assert.equal(cacheVerified(evidence,'warm','substation'),false);
  evidence.progress.workload.ifcSources=0;evidence.progress.cache.engineering='none';assert.equal(cacheVerified(evidence,'warm','equipment'),true);
  evidence.cache.linePack='missing';assert.equal(cacheVerified(evidence,'warm','transmission_line'),false);
  assert.throws(()=>verifyProfile({frozen:true,digest:'edited'}),/digest mismatch/);
  const run={conditions:{sourceSha256:'sha'},evidence:{semanticDigest:'semantic',baseArtifactDigest:'a',progress:{workload:{shown:1}}},actionTargetDigests:[]};
  assert.equal(coldWarmEquivalent(run,{...run,evidence:{...run.evidence,baseArtifactDigest:'b'}}).outcome,'FAIL');
});
test('selection is deterministic, mandatory regression survives and no timing is consulted',()=>{
  const s=(id,tier,group,extra={})=>({sampleId:id,sourceSha256:id,bytes:100,container:{payload:'7z',magic:'GIMPKGS'},memberships:[{sampleTier:tier,group}],inventory:{status:'available',files:10,extensions:{cbm:1,dev:1,mod:1}},...extra});
  const registry={samples:[s('a','L1','development-regression',{requiredRegression:'full-package-index',timing:999}),s('b','L0','common-model',{timing:1}),s('c','L2','complex-equipment')]};
  const first=selectSamples(registry);registry.samples.reverse();assert.deepEqual(selectSamples(registry),first);assert.equal(first.profiles['commit-gate'][0].sampleId,'a');assert.equal(first.frozen,false);
});
test('CDP timeouts do not enqueue another heap request until the old response arrives',async()=>{
  const original=globalThis.WebSocket;let socket;
  class FakeSocket extends EventTarget {
    sent=[];
    constructor(){super();socket=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    send(text){this.sent.push(JSON.parse(text));}
    reply(id,result={}){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,result})}));}
    close(){this.dispatchEvent(new Event('close'));}
  }
  globalThis.WebSocket=FakeSocket;let cdp;
  try{
    cdp=await CdpConnection.connect('ws://127.0.0.1:12345/owned',12345);
    await assert.rejects(cdp.send('Runtime.getHeapUsage',{},'worker',5),/timeout/);
    await assert.rejects(cdp.send('Runtime.getHeapUsage',{},'worker',5),/outstanding/);assert.equal(socket.sent.length,1);
    socket.reply(socket.sent[0].id,{usedSize:12});
    const next=cdp.send('Runtime.getHeapUsage',{},'worker');socket.reply(socket.sent[1].id,{usedSize:24});assert.equal((await next).usedSize,24);
    const pending=cdp.send('Runtime.getIsolateId',{},'worker');cdp.close();await assert.rejects(pending,/closed/);
  }finally{cdp?.close();globalThis.WebSocket=original;}
});
test('portable runtime preparation includes image integrity and restricts recursive operations to owned files',()=>{
  const workspace=resolve('..'),base=join(workspace,'tmp','runtime-security-unit');mkdirSync(base,{recursive:true});
  const root=mkdtempSync(join(base,'run-')),runtime=join(root,'webview2-fixed-runtime');mkdirSync(runtime);writeFileSync(join(runtime,'msedgewebview2.exe'),'unit-protocol-only');writeFileSync(join(root,'GIM-Reader.exe'),'unit-protocol-only');
  const calls=[];prepareFixedRuntimeSecurity(workspace,runtime,(_exe,args)=>{calls.push(args);return {status:0};});
  if(process.platform==='win32'){
    assert.ok(calls.some(args=>args[1]==='/setintegritylevel'&&args[2]==='(OI)(CI)M'));
    assert.ok(calls.some(args=>args[0]===join(root,'GIM-Reader.exe')&&args[2]==='M'));
    assert.throws(()=>prepareFixedRuntimeSecurity(workspace,runtime,()=>({status:1})),/preparation failed/);
  }
  assert.throws(()=>prepareFixedRuntimeSecurity(runtime,root,()=>({status:0})),/outside/);
});
