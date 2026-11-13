/** CDP for an explicitly owned loopback application. No discovery of user browsers. */
const cdpError=(code,message,method)=>Object.assign(Error(message),{code,method});
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
      if(pending){connection.#pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(cdpError('runtime-command-rejected',`CDP ${pending.method} rejected`,pending.method)):pending.resolve(message.result);}
      else if(message.method)for(const listener of connection.#listeners)listener(message);
    });
    connection.#socket.addEventListener('close',()=>connection.close());
    return connection;
  }
  onEvent(listener){this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  send(method,params={},sessionId,timeoutMs=5000){
    if(this.#closed)return Promise.reject(cdpError('runtime-connection-closed','CDP connection closed',method));
    const key=`${sessionId??'page'}:${method}`;
    if(this.#blocked.has(key))return Promise.reject(cdpError('runtime-request-outstanding','CDP previous request remains outstanding',method));
    if(this.#pending.size+this.#timedOut.size>=128)return Promise.reject(cdpError('runtime-pending-limit','CDP pending limit',method));
    return new Promise((resolve,reject)=>{
      const id=++this.#serial,timer=setTimeout(()=>{this.#pending.delete(id);this.#blocked.add(key);this.#timedOut.set(id,key);reject(cdpError('runtime-timeout',`CDP ${method} timeout`,method));},timeoutMs);
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
  #targets=new Map(); #stopListener; #closed=false; #mapped=new Set(); #samples=0; #missing=0; #external=0; #identities=new Map(); #coalesced=0;
  constructor(cdp,emit,periodMs=1000,now=()=>performance.now()){this.cdp=cdp;this.emit=emit;this.periodMs=periodMs;this.now=now;}
  onDiagnosticTarget=null;
  async start(){
    const main={sessionId:undefined,targetId:'owned-main-page',identity:{workerId:'host',runId:null,family:'host'},isolateId:null,pending:false,ended:false,created:this.now()};
    this.#targets.set('main',main);this.#sample(main,'attached').catch(()=>{});
    this.#stopListener=this.cdp.onEvent(message=>{
      if(message.method==='Target.attachedToTarget'&&message.params.targetInfo.type==='worker'){
        if(this.#targets.size>=1024){this.#missing++;this.emit({kind:'target-loss',reason:'target-limit',atMs:performance.now()});return;}
        const {sessionId,targetInfo}=message.params;
        const identity=this.#identities.get(targetInfo.url)??null;
        const row={sessionId,targetId:targetInfo.targetId,url:targetInfo.url,identity,isolateId:null,pending:false,ended:false,created:this.now()};this.#targets.set(sessionId,row);
        this.#sample(row,'attached').catch(()=>{}); // #sample emits its own unavailable record.
      }else if(message.method==='Target.detachedFromTarget'){
        const row=this.#targets.get(message.params.sessionId);if(row){row.ended=true;clearTimeout(row.timer);clearTimeout(row.identityTimer);row.resolveIdentity?.();this.#targets.delete(row.sessionId);this.#identities.delete(row.url);this.emit({kind:'worker-target-ended',workerId:row.identity?.workerId??null,targetId:row.targetId,atMs:this.now()});}
      }
    });
    await this.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  }
  associate(url,context){
    const identity={workerId:context.workerId,runId:context.runId,family:context.family};this.#identities.set(url,identity);
    for(const row of this.#targets.values())if(row.url===url){row.identity=identity;clearTimeout(row.identityTimer);row.resolveIdentity?.();if(row.isolateId)this.#mapped.add(identity.workerId);}
  }
  async #identity(row){
    if(row.identity)return;
    // The owned-page Worker registry supplies identity without executing JS in
    // a busy Worker. Runtime.evaluate can queue behind OpenModel/compilation
    // and turn an identity lookup into a false heap timeout.
    await new Promise(resolve=>{row.resolveIdentity=resolve;row.identityTimer=setTimeout(resolve,500);});
    row.resolveIdentity=null;
    if(!row.identity&&!row.ended&&!this.#closed)row.identity={workerId:`external-worker-${++this.#external}`,runId:null,family:'external',association:'owned-page-target-only'};
  }
  #sample(row,checkpoint){
    if(this.#closed||row.ended)return;
    if(row.pending){this.#coalesced++;return row.pending;}
    clearTimeout(row.timer);
    const requestedMs=this.now();
    row.pending=this.#collect(row,checkpoint,requestedMs).finally(()=>{
      row.pending=null;
      if(!this.#closed&&!row.ended)row.timer=setTimeout(()=>{this.#sample(row,'periodic')?.catch(()=>{});},Math.max(0,requestedMs+this.periodMs-this.now()));
    });
    return row.pending;
  }
  async #collect(row,checkpoint,requestedMs){
    let failureMethod='worker-registry';
    try{
      await this.#identity(row);if(this.#closed||row.ended)return;
      if(!row.isolateId){
        failureMethod='Runtime.getIsolateId';
        row.isolateId=(await this.cdp.send('Runtime.getIsolateId',{},row.sessionId,2000)).id;
        if(typeof row.isolateId!=='string'||!row.isolateId)throw Error('isolate-identity-unavailable');
        this.#mapped.add(row.identity.workerId);
      }
      this.onDiagnosticTarget?.(row.identity,row.sessionId);
      failureMethod='Runtime.getHeapUsage';
      const heap=await this.cdp.send('Runtime.getHeapUsage',{},row.sessionId,2000);
      if(!Number.isFinite(heap.usedSize)||!Number.isFinite(heap.totalSize))throw Error('heap-fields-unavailable');
      if(this.#closed||row.ended)return;
      this.#samples++;
      this.emit({kind:'heap-sample',workerId:row.identity.workerId,runId:row.identity.runId,family:row.identity.family,targetId:row.targetId,isolateId:row.isolateId,
        scope:'isolate',method:'CDP.Runtime.getHeapUsage',quality:'runtime-sampled',availability:'available',bytes:heap.usedSize,capacityBytes:heap.totalSize,
        backingStorageBytes:Number.isFinite(heap.backingStorageSize)?heap.backingStorageSize:null,
        atMs:this.now(),targetCreatedAtMs:row.created,sampleDelayMs:this.now()-requestedMs,checkpoint,peakMeaning:'observed-only'});
    }catch(error){
      // A normal target/recording boundary cancels its outstanding request.
      // The terminal timestamp still extends coverage to the last valid sample;
      // genuine timeouts and excessive live/tail gaps remain incomplete.
      if(this.#closed||row.ended){this.emit({kind:'heap-sample-cancelled',workerId:row.identity?.workerId??null,
        reason:this.#closed?'sampling-stopped':'target-ended',atMs:this.now(),checkpoint});return;}
      this.#missing++;this.emit({kind:'heap-sample',workerId:row.identity?.workerId??null,targetId:row.targetId,scope:'isolate',method:'CDP.Runtime.getHeapUsage',quality:'runtime-sampled',availability:'unavailable',bytes:null,
        reason:typeof error?.code==='string'&&/^runtime-/.test(error.code)?error.code:row.identity?'runtime-timeout-or-unsupported':'worker-identity-unavailable',failureMethod,
        atMs:this.now(),targetCreatedAtMs:row.created,sampleDelayMs:this.now()-requestedMs,checkpoint});
    }
  }
  async checkpoint(workerId,name){const row=[...this.#targets.values()].find(row=>row.identity?.workerId===workerId);if(row)await this.#sample(row,name);}
  snapshot(){return {periodMs:this.periodMs,mappedWorkerIds:[...this.#mapped],externalTargets:this.#external,samples:this.#samples,missing:this.#missing,coalesced:this.#coalesced,scope:'isolate',osWorkerMemoryAvailable:false};}
  stop(){this.#closed=true;this.#stopListener?.();for(const row of this.#targets.values()){
    row.ended=true;clearTimeout(row.timer);clearTimeout(row.identityTimer);row.resolveIdentity?.();this.emit({kind:'heap-sampling-stopped',workerId:row.identity?.workerId??null,atMs:this.now()});
  }
    this.#targets.clear();}
}
