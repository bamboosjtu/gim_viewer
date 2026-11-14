import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';

export const refKey=e=>[e.context?.runId??e.runId,e.producerId,e.sequence].join('\0');
const identity=e=>JSON.stringify([e.context.runId,e.context.operationTraceId??null,e.context.taskId,e.context.attemptId,
  e.context.workerId,e.context.generation,e.context.geometryToken,e.context.requestId,e.context.sourceSha256,
  e.context.buildId,e.context.sampleId,e.context.sourceId,e.context.geometryLod,e.context.parentTaskId,
  e.context.executorId,e.context.scopeId,e.ownerProducerId??e.producerId,e.clockId]);
export function resolveScopes(scopes){
  const requested=new Map(scopes.filter(s=>s.declaration==='requested').map(s=>[s.scopeId,s])),issues=[];
  function request(scope,seen=new Set()){
    if(seen.has(scope.scopeId)){issues.push('scope-parent-cycle');return [];}seen.add(scope.scopeId);
    const parent=scope.parentScopeId?requested.get(scope.parentScopeId):null;
    const inherited=parent?request(parent,seen):null;
    const capabilities=scope.capabilities??inherited;
    if(capabilities===null||capabilities===undefined){issues.push('scope-request-unknown');return [];}
    if(inherited&&capabilities.some(c=>!inherited.includes(c)))issues.push('scope-capability-expansion');
    return capabilities;
  }
  for(const scope of scopes){
    if(!scope.window||!Number.isFinite(scope.window.startMs)||
      scope.window.endMs!==null&&!Number.isFinite(scope.window.endMs)){issues.push('scope-window-invalid');continue;}
    if(scope.declaration==='requested'){request(scope);continue;}
    if(!Array.isArray(scope.capabilities)){issues.push('effective-capabilities-unknown');continue;}
    const parent=requested.get(scope.scopeId)??requested.get(scope.parentScopeId);
    if(!parent)issues.push('effective-request-unknown');
    else if(scope.capabilities.some(c=>!request(parent).includes(c)))issues.push('effective-capability-expansion');
    if(scope.window.endMs!==null&&scope.window.endMs<scope.window.startMs)issues.push('scope-window-reversed');
  }
  return {issues:[...new Set(issues)],requests:[...requested.values()].map(scope=>({scopeId:scope.scopeId,capabilities:request(scope)}))};
}
export function expandFrames(frames){
  return frames.flatMap(frame=>frame.events?frame.events.map(e=>({...e,context:e.context??frame.contexts?.[e.contextIndex]})):[frame]);
}
/** Preserve raw values and references. Nothing here rewrites Benchmark evidence. */
export function normalizeTrace(events,{limit=100000,health=null}={}){
  const refs=new Map(),groups=new Map(),issues=[],clocks=[],scopeRecords=[],operations=[],milestones=[],dependencies=[],waits=[],resources=[];
  const sequences=new Map();
  for(const event of events.slice(0,limit)){
    if(event.version!==MEASUREMENT_VERSION)throw Error('unsupported-measurement-version');
    if(!event.context?.runId||!Number.isFinite(event.atMs)||!Number.isSafeInteger(event.sequence)){
      issues.push('invalid-event');continue;
    }
    const ref=refKey(event),old=refs.get(ref);
    if(old){if(JSON.stringify(old)!==JSON.stringify(event))issues.push('event-reference-conflict');continue;}
    refs.set(ref,event);
    const producer=event.context.runId+'\0'+event.producerId,previous=sequences.get(producer)??0;
    if(event.sequence!==previous+1)issues.push('sequence-gap:'+producer);
    sequences.set(producer,event.sequence);
    const t=event.trace;
    if(t?.calibration)clocks.push({...t.calibration});
    if(t?.type==='scope')scopeRecords.push(event);
    if(t?.type==='operation')operations.push(event);
    if(t?.type==='milestone')milestones.push(event);
    if(t?.type==='dependency')dependencies.push(event);
    if(t?.type==='wait')waits.push(event);
    if(t?.type==='resource')resources.push(event);
    const id=t?.type==='span'?t.id:event.kind==='phase'&&event.timing!=='aggregate'?event.spanId:null;
    if(t?.type==='span'&&(typeof id!=='string'||!id)){issues.push('span-identity-missing');continue;}
    if(!id)continue;
    const key=event.context.runId+'\0'+id;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(event);
  }
  if(events.length>limit)issues.push('analysis-event-limit');
  if(health?.dropped||health?.activeOverflow||health?.duplicate||health?.sequenceGaps||health?.invalid||health?.foreignRun)issues.push('trace-collection-loss');
  const spans=[];
  for(const [key,rows]of groups){
    const signatures=new Set(rows.map(identity)),starts=rows.filter(e=>e.trace?.action==='started'),ends=rows.filter(e=>e.trace?.action==='ended');
    const intervals=rows.filter(e=>e.kind==='phase'),problems=[];
    const start=starts[0]?.atMs??intervals[0]?.startMs??null;
    const intervalEnd=e=>e.endMs??e.startMs+e.durationMs;
    const end=ends[0]?.trace.endMs??(intervals[0]?intervalEnd(intervals[0]):null);
    if(signatures.size!==1)problems.push('context-conflict');
    if(starts.some(e=>e.atMs!==start)||ends.some(e=>e.trace.endMs!==end))problems.push('lifecycle-conflict');
    const anomalies=ends.length>1?['duplicate-end']:[];
    if(new Set(rows.map(e=>e.status??e.trace?.status).filter(Boolean)).size>1)problems.push('status-conflict');
    if(intervals.some(e=>e.startMs!==start||intervalEnd(e)!==end||
      e.endMs!==undefined&&e.endMs-e.startMs!==e.durationMs))problems.push('interval-conflict');
    if(start!==null&&end!==null&&end<start)problems.push('reversed-boundary');
    if(start!==null&&!Number.isFinite(start)||end!==null&&!Number.isFinite(end))problems.push('invalid-boundary');
    if(ends.length&&!starts.length&&!intervals.length)problems.push('orphan-end');
    const row=rows[0];
    spans.push({key,id:key.split('\0')[1],context:row.context,clockId:row.clockId,
      producerId:row.ownerProducerId??row.producerId,name:starts[0]?.trace.name??intervals[0]?.name??row.trace?.name,
      parentSpanId:starts[0]?.trace.parentSpanId??intervals[0]?.parentSpanId??null,
      startMs:start,endMs:end,durationMs:problems.length||start===null||end===null?null:end-start,
      lifecycleObserved:starts.length>0,state:problems.length?'conflict':end===null?'open':starts.length?'closed':'interval-only',
      issues:[...problems,...anomalies],eventRefs:rows.map(e=>({runId:e.context.runId,producerId:e.producerId,sequence:e.sequence}))});
  }
  const scopeClosures=new Map();
  for(const e of scopeRecords)if(e.trace.action==='closed'){
    const key=e.context.runId+'\0'+e.trace.id,rows=scopeClosures.get(key)??[];rows.push(e);scopeClosures.set(key,rows);
  }
  const scopes=scopeRecords.filter(e=>e.trace.scope).map(e=>{
    const scope={...e.trace.scope,window:{...e.trace.scope.window}};
    const closed=scopeClosures.get(e.context.runId+'\0'+scope.scopeId)??[];
    if(closed.length===1)scope.window.endMs=closed[0].trace.endMs;
    if(closed.length>1)issues.push('scope-close-conflict');
    return scope;
  });
  issues.push(...resolveScopes(scopes).issues);
  return {measurementVersion:MEASUREMENT_VERSION,spans,scopes,clocks,operations,milestones,dependencies,waits,resources,
    issues:[...new Set(issues)],eventCount:refs.size,events:[...refs.values()]};
}
export function mapTime(clockId,atMs,clocks,referenceClockId){
  if(!Number.isFinite(atMs))return null;
  if(clockId===referenceClockId)return {ms:atMs,uncertaintyMs:0};
  const candidates=clocks.filter(c=>c.clockId===clockId&&c.referenceClockId===referenceClockId
    &&atMs>=c.validFromLocalMs&&(c.validToLocalMs===null||atMs<=c.validToLocalMs));
  if(candidates.length!==1)return null;
  const c=candidates[0];
  if(!Number.isFinite(c.offsetMs)||!Number.isFinite(c.uncertaintyMs)||c.uncertaintyMs<0||
    !Number.isFinite(c.validFromLocalMs)||c.validToLocalMs!==null&&!Number.isFinite(c.validToLocalMs))return null;
  return {ms:atMs+c.offsetMs,uncertaintyMs:c.uncertaintyMs};
}
export function traceCoverage(trace,operationTraceId){
  const events=trace.events.filter(e=>e.context.operationTraceId===operationTraceId);
  const executors=[...new Set(events.filter(e=>e.kind==='task'||e.kind==='trace').map(e=>e.context.executorId??e.context.workerId))];
  const domains=executors.map(executorId=>{
    const scopes=trace.scopes.filter(s=>s.declaration==='effective'&&s.operationTraceId===operationTraceId&&s.executorId===executorId);
    const root=trace.operations.find(e=>e.context.operationTraceId===operationTraceId&&e.trace.action==='started');
    const domainSpans=trace.spans.filter(s=>s.context.operationTraceId===operationTraceId&&(s.context.executorId??s.context.workerId)===executorId);
    const clockMissing=root&&domainSpans.some(s=>s.startMs!==null&&!mapTime(s.clockId,s.startMs,trace.clocks,root.clockId));
    const reason=clockMissing?'clock-mapping-unavailable':!scopes.length?'effective-scope-missing':scopes.some(s=>s.window.endMs===null)?'scope-unclosed':
      scopes.some(s=>!s.capabilities?.includes('span-lifecycle'))?'capability-disabled':
      trace.spans.some(s=>s.context.operationTraceId===operationTraceId&&(s.context.executorId??s.context.workerId)===executorId&&s.state!=='closed')?'span-evidence-partial':null;
    return {executorId,status:reason?'partial':'complete',reason,windows:scopes.map(s=>s.window)};
  });
  return {operationTraceId,domains,traceComplete:domains.length>0&&domains.every(d=>d.status==='complete')&&!trace.issues.length,
    issues:trace.issues,requiredCapabilities:['operation-context','span-lifecycle']};
}
export function waitIntervals(trace){
  const groups=new Map();
  for(const e of trace.waits){const key=e.context.runId+'\0'+e.trace.id;
    const rows=groups.get(key)??[];rows.push(e);groups.set(key,rows);}
  return [...groups].map(([id,rows])=>{
    const starts=rows.filter(e=>e.trace.action==='started'),ends=rows.filter(e=>e.trace.action==='ended');
    const a=starts[0],b=ends[0],consistent=a&&b&&a.clockId===b.clockId&&identity(a)===identity(b)&&b.atMs>=a.atMs;
    return {id,context:rows[0].context,resourceId:a?.trace.resourceId,reason:a?.trace.reason,ownerClockId:a?.clockId,
      startMs:a?.atMs??null,endMs:b?.atMs??null,durationMs:consistent?b.atMs-a.atMs:null,
      state:starts.length>1||ends.length>1?'conflict':consistent?'closed':a&&!b?'open':'partial',
      eventRefs:rows.map(e=>({runId:e.context.runId,producerId:e.producerId,sequence:e.sequence}))};
  });
}
/** Slot occupancy is a scheduling constraint, never a data dependency. */
export function resourceConstraints(trace,operationTraceId){
  const rows=trace.resources.filter(e=>e.context.operationTraceId===operationTraceId),slots=new Map(),constraints=[],issues=[];
  const waits=waitIntervals(trace);
  const waitKey=(context,resourceId,clockId)=>JSON.stringify([context.runId,context.taskId,context.attemptId,resourceId,clockId]);
  const waitsByTask=new Map();
  for(const wait of waits)if(wait.state==='closed'){
    const key=waitKey(wait.context,wait.resourceId,wait.ownerClockId),list=waitsByTask.get(key)??[];
    list.push(wait);waitsByTask.set(key,list);
  }
  for(const e of rows){
    const t=e.trace;if(!t.slotId)continue;
    const key=e.context.runId+'\0'+t.resourceId+'\0'+t.slotId,previous=slots.get(key);
    if(t.action==='released'){slots.set(key,{release:e});continue;}
    if(t.action!=='granted')continue;
    if(previous?.grant){issues.push('slot-double-granted');continue;}
    if(previous?.release){
      const release=previous.release;
      const wait=waitsByTask.get(waitKey(e.context,t.resourceId,e.clockId))?.find(w=>w.startMs<=release.atMs&&w.endMs>=e.atMs);
      if(!wait){slots.set(key,{grant:e});continue;}
      if(release.clockId!==e.clockId||release.atMs>e.atMs)issues.push('resource-clock-or-order-conflict');
      else constraints.push({fromTaskId:release.context.taskId,fromAttemptId:release.context.attemptId,toTaskId:e.context.taskId,toAttemptId:e.context.attemptId,resourceId:t.resourceId,slotId:t.slotId,
        certainty:t.reason==='release-enabled-grant'&&t.eventRefs?.some(r=>refKey(r)===refKey(release))?'verified':'candidate',
        eventRefs:[...wait.eventRefs,...[release,e].map(row=>({runId:row.context.runId,producerId:row.producerId,sequence:row.sequence}))]});
    }
    slots.set(key,{grant:e});
  }
  return {constraints,issues};
}
export function blockingPath(trace,{operationTraceId,milestone,maxCandidates=64}){
  const operation=trace.operations.find(e=>e.context.operationTraceId===operationTraceId&&e.trace.action==='started');
  const target=trace.milestones.find(e=>e.context.operationTraceId===operationTraceId&&e.trace.name===milestone);
  const coverage=traceCoverage(trace,operationTraceId),resources=resourceConstraints(trace,operationTraceId),
    issues=[...coverage.issues,...resources.issues];
  if(!operation||!target)return {kind:'Partial Blocking Path',coverage,paths:[],issues:['operation-or-milestone-missing']};
  const clock=operation.clockId,map=(c,t)=>mapTime(c,t,trace.clocks,clock);
  const targetTime=map(target.clockId,target.atMs);
  if(!targetTime)return {kind:'Partial Blocking Path',coverage,paths:[],issues:['target-clock-unavailable']};
  const nodes=new Map();
  for(const s of trace.spans.filter(s=>s.context.operationTraceId===operationTraceId&&s.durationMs!==null)){
    const start=map(s.clockId,s.startMs),end=map(s.clockId,s.endMs);
    if(start&&end&&start.ms>=operation.atMs&&end.ms<=targetTime.ms+end.uncertaintyMs)
      nodes.set(s.id,{...s,start,end});
  }
  const parents=new Set([...nodes.values()].map(n=>n.parentSpanId).filter(Boolean));
  const referenced=new Set(trace.dependencies.filter(e=>e.context.operationTraceId===operationTraceId)
    .flatMap(e=>[e.trace.fromSpanId,e.trace.toSpanId]));
  // Referenced scheduler roundtrips are opaque fragments. Overlapping descendants
  // cannot join them on a weighted path; every edge must join disjoint intervals.
  for(const id of parents)if(nodes.get(id)?.name!=='host.scheduled-task'||!referenced.has(id))nodes.delete(id);
  const incoming=new Map(),validRefs=new Set(trace.events.map(refKey));
  const sink=target.trace.fromSpanId;
  if(!sink)return {operationTraceId,milestone,kind:'Partial Blocking Path',coverage,paths:[],
    wallClockMs:targetTime.ms-operation.atMs,unattributed:[{startMs:operation.atMs,endMs:targetTime.ms}],
    issues:[...issues,'milestone-dependency-missing']};
  if(!nodes.has(sink))return {operationTraceId,milestone,kind:'Partial Blocking Path',coverage,paths:[],
    issues:[...issues,'goal-span-unavailable']};
  const dataEdges=trace.dependencies.filter(e=>e.context.operationTraceId===operationTraceId);
  const needed=new Set([sink]);
  const predecessors=new Map();
  for(const e of dataEdges){const list=predecessors.get(e.trace.toSpanId)??[];list.push(e.trace.fromSpanId);predecessors.set(e.trace.toSpanId,list);}
  const pending=[sink];
  for(let cursor=0;cursor<pending.length;cursor++)for(const id of predecessors.get(pending[cursor])??[])if(!needed.has(id)){needed.add(id);pending.push(id);}
  const neededTasks=new Set([...nodes.values()].filter(n=>needed.has(n.id)).map(n=>JSON.stringify([n.context.taskId,n.context.attemptId])));
  const resourceEdges=resources.constraints.flatMap(c=>{
    if(!neededTasks.has(JSON.stringify([c.toTaskId,c.toAttemptId])))return [];
    if(c.certainty!=='verified'){issues.push('resource-blocker-candidate');return [];}
    const from=[...nodes.values()].filter(n=>n.context.taskId===c.fromTaskId&&n.context.attemptId===c.fromAttemptId).sort((a,b)=>b.end.ms-a.end.ms)[0];
    const to=[...nodes.values()].filter(n=>n.context.taskId===c.toTaskId&&n.context.attemptId===c.toAttemptId).sort((a,b)=>a.start.ms-b.start.ms)[0];
    if(!from||!to){issues.push('resource-execution-boundary-missing');return [];}
    return [{trace:{fromSpanId:from.id,toSpanId:to.id,eventRefs:c.eventRefs}}];
  });
  for(const event of [...dataEdges.filter(e=>needed.has(e.trace.toSpanId)),...resourceEdges]){
    const edge=event.trace,a=nodes.get(edge.fromSpanId),b=nodes.get(edge.toSpanId);
    if(!a||!b||!edge.eventRefs?.length||edge.eventRefs.some(r=>!validRefs.has(refKey(r)))){
      issues.push('dependency-evidence-missing');continue;
    }
    if(a.end.ms-a.end.uncertaintyMs>b.start.ms+b.start.uncertaintyMs){issues.push('dependency-order-conflict');continue;}
    const list=incoming.get(b.id)??[];list.push(a.id);incoming.set(b.id,list);
  }
  const visiting=new Set(),memo=new Map();let retainedPathIds=0;
  function solve(id,depth=0){
    if(depth>512||retainedPathIds>200000){issues.push('analysis-path-budget');return [];}
    if(visiting.has(id)){issues.push('constraint-cycle');return [];}
    if(memo.has(id))return memo.get(id);
    visiting.add(id);
    const n=nodes.get(id),pre=[];let bestWeight=-Infinity;
    for(const previous of incoming.get(id)??[])for(const p of solve(previous,depth+1)){
      if(p.end>n.start.ms){issues.push('clock-order-uncertain');continue;}
      // All paths leaving this node share its end time. A later predecessor
      // does not dominate an earlier, heavier chain; retain maximum weight.
      if(p.weight>bestWeight){bestWeight=p.weight;pre.length=0;}
      if(p.weight<bestWeight)continue;
      if(pre.length<maxCandidates)pre.push(p);else issues.push('candidate-limit');
    }
    let paths=pre.length?pre.map(p=>({ids:[...p.ids,id],weight:p.weight+n.durationMs,end:n.end.ms,uncertaintyMs:n.end.uncertaintyMs})):
      [{ids:[id],weight:n.durationMs,end:n.end.ms,uncertaintyMs:n.end.uncertaintyMs}];
    if(paths.length>maxCandidates){issues.push('candidate-limit');paths=paths.slice(0,maxCandidates);}
    retainedPathIds+=paths.reduce((sum,path)=>sum+path.ids.length,0);
    visiting.delete(id);memo.set(id,paths);return paths;
  }
  let candidates=solve(sink);
  if(candidates.length>maxCandidates){issues.push('candidate-limit');candidates=candidates.slice(0,maxCandidates);}
  const paths=candidates.map(path=>{
    let cursor=operation.atMs;const unattributed=[];
    for(const id of path.ids){const n=nodes.get(id);if(n.start.ms>cursor)unattributed.push({startMs:cursor,endMs:n.start.ms});cursor=Math.max(cursor,n.end.ms);}
    if(cursor<targetTime.ms)unattributed.push({startMs:cursor,endMs:targetTime.ms});
    return {...path,unattributed};
  });
  const partial=!coverage.traceComplete||issues.length||!paths.length||paths.some(p=>p.unattributed.length);
  return {operationTraceId,milestone,wallClockMs:targetTime.ms-operation.atMs,coverage,
    kind:partial?'Partial Blocking Path':paths.length>1?'Critical Path Candidates':'Critical Path',
    paths,waits:waitIntervals(trace).filter(w=>w.context.operationTraceId===operationTraceId),
    resourceConstraints:resources.constraints,issues:[...new Set(issues)],interpretation:'observed execution; not predicted optimization benefit'};
}
export function exportChromeTrace(trace){
  const events=[],tracks=new Map(),main=trace.operations[0]?.clockId??trace.events[0]?.clockId;
  let asyncId=0;
  const track=id=>{if(!tracks.has(id))tracks.set(id,tracks.size+1);return tracks.get(id);};
  for(const s of trace.spans){
    const start=s.startMs===null?null:mapTime(s.clockId,s.startMs,trace.clocks,main);
    const end=s.endMs===null?null:mapTime(s.clockId,s.endMs,trace.clocks,main);
    const id=++asyncId,tid=track(s.context.executorId??s.context.workerId),args={spanId:s.id,state:s.state,issues:s.issues,eventRefs:s.eventRefs,clockId:s.clockId,
      operationTraceId:s.context.operationTraceId,uncertaintyMs:start?.uncertaintyMs??null};
    // Async slices permit overlapping awaits on one physical executor.
    if(start)events.push({ph:'b',pid:1,tid,cat:'gim',id,name:s.name,ts:start.ms*1000,args});
    if(end&&s.state!=='conflict')events.push({ph:'e',pid:1,tid,cat:'gim',id,name:s.name,ts:end.ms*1000,args});
  }
  for(const e of trace.events.filter(e=>e.trace&&e.trace.type!=='span')){
    const mapped=mapTime(e.clockId,e.atMs,trace.clocks,main);if(!mapped)continue;
    events.push({ph:'i',s:'t',pid:1,tid:track(e.context.executorId??e.context.workerId),ts:mapped.ms*1000,
      name:e.trace.name??e.trace.type+'.'+e.trace.action,args:{...e.trace,eventRef:refKey(e)}});
  }
  for(const e of trace.events.filter(e=>!e.trace&&['worker','task','clock','loss'].includes(e.kind))){
    const mapped=mapTime(e.clockId,e.atMs,trace.clocks,main);if(!mapped)continue;
    events.push({ph:'i',s:'t',pid:1,tid:track(e.context.executorId??e.context.workerId),ts:mapped.ms*1000,
      name:e.kind+'.'+e.name,args:{context:e.context,eventRef:refKey(e),status:e.status,reasonCode:e.reasonCode}});
  }
  const messages=new Map();
  for(const e of trace.events.filter(e=>e.trace?.type==='message')){
    const id=JSON.stringify([e.context.runId,e.context.operationTraceId,e.context.taskId,e.context.attemptId,e.trace.id]),rows=messages.get(id)??[];rows.push(e);messages.set(id,rows);
  }
  let flow=asyncId;
  for(const rows of messages.values()){
    const sent=rows.find(e=>e.trace.action==='sent'),received=rows.find(e=>e.trace.action==='received');
    if(!sent||!received)continue;const id=++flow;
    for(const [e,ph]of [[sent,'s'],[received,'f']]){
      const mapped=mapTime(e.clockId,e.atMs,trace.clocks,main);if(mapped)events.push({ph,id,pid:1,tid:track(e.context.executorId??e.context.workerId),ts:mapped.ms*1000,name:'message',cat:'gim'});
    }
  }
  for(const [name,tid]of tracks)events.unshift({ph:'M',pid:1,tid,name:'thread_name',args:{name}});
  return {traceEvents:events,displayTimeUnit:'ms',metadata:{format:'Chrome Trace Event JSON',timestampUnit:'us',
    sourceProtocol:trace.measurementVersion,issues:trace.issues,unmappedSpans:trace.spans.filter(s=>!mapTime(s.clockId,s.startMs,trace.clocks,main)).length}};
}
