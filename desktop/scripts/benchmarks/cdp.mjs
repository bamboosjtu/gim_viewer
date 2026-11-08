/** CDP for an explicitly owned loopback application. No discovery of user browsers. */
export class CdpConnection {
  #socket; #serial=0; #pending=new Map(); #listeners=new Set(); #closed=false;
  #timedOut=new Map(); #blocked=new Set();
  get closed(){return this.#closed;}
  static async connect(url,port){
    const address=new URL(url);
    if(address.protocol!=='ws:'||address.hostname!=='127.0.0.1'||Number(address.port)!==port)throw Error('CDP endpoint must belong to the owned loopback port');
    const connection=new CdpConnection();connection.#socket=new WebSocket(url);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{connection.close();reject(Error('CDP connection timeout'));},5000);
      connection.#socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      connection.#socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP connection failed'));},{once:true});
    });
    connection.#socket.addEventListener('message',event=>{
      let message;try{message=JSON.parse(event.data);}catch{connection.close();return;}
      const blocked=connection.#timedOut.get(message.id);
      if(blocked){connection.#timedOut.delete(message.id);connection.#blocked.delete(blocked);return;}
      const pending=connection.#pending.get(message.id);
      if(pending){connection.#pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(Error(`CDP ${pending.method} rejected`)):pending.resolve(message.result);}
      else if(message.method)for(const listener of connection.#listeners)listener(message);
    });
    connection.#socket.addEventListener('close',()=>connection.close());
    return connection;
  }
  onEvent(listener){this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  send(method,params={},sessionId,timeoutMs=5000){
    if(this.#closed)return Promise.reject(Error('CDP connection closed'));
    const key=`${sessionId??'page'}:${method}`;
    if(this.#blocked.has(key))return Promise.reject(Error('CDP previous request remains outstanding'));
    if(this.#pending.size+this.#timedOut.size>=128)return Promise.reject(Error('CDP pending limit'));
    return new Promise((resolve,reject)=>{
      const id=++this.#serial,timer=setTimeout(()=>{this.#pending.delete(id);this.#blocked.add(key);this.#timedOut.set(id,key);reject(Error(`CDP ${method} timeout`));},timeoutMs);
      this.#pending.set(id,{resolve,reject,timer,method});
      try{this.#socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}
      catch(error){this.#pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  async evaluate(expression,sessionId,timeoutMs=5000){
    const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId,timeoutMs);
    if(result.exceptionDetails)throw Error('CDP evaluation failed');return result.result?.value;
  }
  close(){if(this.#closed)return;this.#closed=true;for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(Error('CDP closed'));}this.#pending.clear();this.#timedOut.clear();this.#blocked.clear();this.#listeners.clear();try{this.#socket?.close();}catch{}}
}

/** Heap values are isolate-wide sampled values. Targets are never apportioned OS memory. */
export class WorkerHeapSampler {
  #targets=new Map(); #stopListener; #timer; #closed=false; #mapped=new Set(); #samples=0; #missing=0; #external=0; #identities=new Map();
  constructor(cdp,emit,periodMs=1000){this.cdp=cdp;this.emit=emit;this.periodMs=periodMs;}
  diagnosticSpec=null;diagnosticTask=null;diagnosticResult=null;
  configureDiagnostic(spec){if(spec.mode!=='diagnostic'||!['cpu','allocations','heap'].includes(spec.kind))throw Error('Explicit diagnostic mode/capture required');this.diagnosticSpec=spec;}
  #maybeDiagnose(row){
    const spec=this.diagnosticSpec;if(!spec||this.diagnosticTask||row.identity?.family!==spec.family)return;
    this.diagnosticTask=this.#capture(row,spec).then(result=>{this.diagnosticResult=result;},()=>{this.diagnosticResult={status:'unavailable',reason:'target-ended-or-profiling-unsupported',workerId:row.identity?.workerId,kind:spec.kind};});
  }
  async #capture(row,spec){
    const session=row.sessionId,duration=Math.min(30000,Math.max(1000,spec.durationMs??5000)),started=performance.now();
    if(spec.kind==='heap'){
      let bytes=0,overflow=false;
      const unsubscribe=this.cdp.onEvent(message=>{if(message.sessionId===session&&message.method==='HeapProfiler.addHeapSnapshotChunk'){
        bytes+=Buffer.byteLength(message.params.chunk);if(bytes<=256*1024*1024)spec.chunk(message.params.chunk);else overflow=true;
      }});
      try{await this.cdp.send('HeapProfiler.enable',{},session);await this.cdp.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false},session,120000);}
      finally{unsubscribe();}
      return {status:overflow?'incomplete':'available',kind:'heap',bytes,workerId:row.identity.workerId,durationMs:performance.now()-started,privateArtifact:true};
    }
    const domain=spec.kind==='cpu'?'Profiler':'HeapProfiler';await this.cdp.send(`${domain}.enable`,{},session);
    await this.cdp.send(spec.kind==='cpu'?'Profiler.start':'HeapProfiler.startSampling',spec.kind==='cpu'?{}:{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true},session);
    await new Promise(resolve=>setTimeout(resolve,duration));
    const result=await this.cdp.send(spec.kind==='cpu'?'Profiler.stop':'HeapProfiler.stopSampling',{},session,30000);spec.write(result.profile);
    return {status:'available',kind:spec.kind,workerId:row.identity.workerId,durationMs:performance.now()-started,privateArtifact:true};
  }
  async completeDiagnostics(){if(this.diagnosticTask)await this.diagnosticTask;return this.diagnosticResult??(this.diagnosticSpec?{status:'unavailable',reason:'requested-worker-family-not-created'}:null);}
  async start(){
    this.#stopListener=this.cdp.onEvent(message=>{
      if(message.method==='Target.attachedToTarget'&&message.params.targetInfo.type==='worker'){
        if(this.#targets.size>=1024){this.#missing++;this.emit({kind:'target-loss',reason:'target-limit',atMs:performance.now()});return;}
        const {sessionId,targetInfo}=message.params;
        const identity=this.#identities.get(targetInfo.url)??null;
        const row={sessionId,targetId:targetInfo.targetId,url:targetInfo.url,identity,isolateId:null,pending:false,ended:false,created:performance.now()};this.#targets.set(sessionId,row);
        this.#sample(row,'attached').catch(()=>{}); // #sample emits its own unavailable record.
      }else if(message.method==='Target.detachedFromTarget'){
        const row=this.#targets.get(message.params.sessionId);if(row){row.ended=true;this.#targets.delete(row.sessionId);this.#identities.delete(row.url);this.emit({kind:'worker-target-ended',workerId:row.identity?.workerId??null,targetId:row.targetId,atMs:performance.now()});}
      }
    });
    await this.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
    this.#timer=setInterval(()=>{for(const row of this.#targets.values())this.#sample(row,'periodic').catch(()=>{});},this.periodMs);
  }
  associate(url,context){
    const identity={workerId:context.workerId,runId:context.runId,family:context.family};this.#identities.set(url,identity);
    for(const row of this.#targets.values())if(row.url===url){row.identity=identity;if(row.isolateId)this.#mapped.add(identity.workerId);}
  }
  async #sample(row,checkpoint){
    if(this.#closed||row.ended)return;
    if(row.pending){this.#missing++;this.emit({kind:'heap-sample',workerId:row.identity?.workerId??null,availability:'unavailable',bytes:null,reason:'previous-sample-pending',atMs:performance.now(),checkpoint});return;}
    row.pending=true;const requestedMs=performance.now();
    try{
      if(!row.identity){
        const identity=await this.cdp.evaluate('globalThis.__gimMeasurementIdentity ?? null',row.sessionId,2000);
        if(identity?.workerId&&identity?.runId)row.identity=identity;
        else if(performance.now()-row.created>500)row.identity={workerId:`external-worker-${++this.#external}`,runId:null,family:'external',association:'owned-page-target-only'};
        else throw Error('worker-identity-unavailable');
      }
      if(!row.isolateId){
        row.isolateId=(await this.cdp.send('Runtime.getIsolateId',{},row.sessionId,2000)).id;
        if(typeof row.isolateId!=='string'||!row.isolateId)throw Error('isolate-identity-unavailable');
        this.#mapped.add(row.identity.workerId);
      }
      this.#maybeDiagnose(row);
      const heap=await this.cdp.send('Runtime.getHeapUsage',{},row.sessionId,2000);
      if(!Number.isFinite(heap.usedSize)||!Number.isFinite(heap.totalSize))throw Error('heap-fields-unavailable');
      this.#samples++;
      this.emit({kind:'heap-sample',workerId:row.identity.workerId,runId:row.identity.runId,family:row.identity.family,targetId:row.targetId,isolateId:row.isolateId,
        scope:'isolate',method:'CDP.Runtime.getHeapUsage',quality:'runtime-sampled',availability:'available',bytes:heap.usedSize,capacityBytes:heap.totalSize,
        backingStorageBytes:Number.isFinite(heap.backingStorageSize)?heap.backingStorageSize:null,
        atMs:performance.now(),sampleDelayMs:performance.now()-requestedMs,checkpoint,peakMeaning:'observed-only'});
    }catch{
      this.#missing++;this.emit({kind:'heap-sample',workerId:row.identity?.workerId??null,targetId:row.targetId,scope:'isolate',method:'CDP.Runtime.getHeapUsage',quality:'runtime-sampled',availability:'unavailable',bytes:null,
        reason:row.ended?'target-ended':row.identity?'runtime-timeout-or-unsupported':'worker-identity-unavailable',atMs:performance.now(),sampleDelayMs:performance.now()-requestedMs,checkpoint});
    }finally{row.pending=false;}
  }
  async checkpoint(workerId,name){const row=[...this.#targets.values()].find(row=>row.identity?.workerId===workerId);if(row)await this.#sample(row,name);}
  snapshot(){return {mappedWorkerIds:[...this.#mapped],externalTargets:this.#external,samples:this.#samples,missing:this.#missing,scope:'isolate',osWorkerMemoryAvailable:false};}
  stop(){this.#closed=true;clearInterval(this.#timer);this.#stopListener?.();for(const row of this.#targets.values()){
    row.ended=true;this.emit({kind:'heap-sampling-stopped',workerId:row.identity?.workerId??null,atMs:performance.now()});
  }
    this.#targets.clear();}
}
