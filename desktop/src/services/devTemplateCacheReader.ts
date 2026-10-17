import {readDevArtifactBatch} from '@desktop/devLodCache.js';
import {ByteWorkBudget} from '../utils/byteWorkBudget.js';
interface Lease<T> {value:T|null;release:()=>void}
interface Request<T> {key:string;resolve:(lease:Lease<T>)=>void;reject:(error:unknown)=>void}
/** One reservation covers the whole batch until its last consumer finishes.
 * Native reads defer rows that exceed the remaining byte ceiling. Neither
 * prefetch nor concurrent parsing can bypass the shared cold/warm budget. */
export class DevTemplateCacheReader<T> {
  readonly diagnostics={batches:0,entries:0,deferred:0};
  private queue:Request<T>[]=[];
  private running=false;
  private closed=false;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private leases=new Set<()=>void>();
  constructor(private budget:ByteWorkBudget,private context:{projectId:number|null;sourceSha256:string|null}){}
  read(key:string):Promise<Lease<T>> {
    if(this.closed)return Promise.reject(new DOMException('DEV cache reader released','AbortError'));
    const promise=new Promise<Lease<T>>((resolve,reject)=>this.queue.push({key,resolve,reject}));
    if(!this.running&&!this.timer)this.timer=setTimeout(()=>{this.timer=null;void this.drain();},0);
    return promise;
  }
  private async drain():Promise<void>{
    this.running=true;
    try {while(this.queue.length&&!this.closed){
      let batch:Request<T>[]=[],release:(()=>void)|undefined;
      try {
        release=await this.budget.acquire(this.budget.limit);
        if(this.closed)throw new DOMException('DEV cache reader released','AbortError');
        batch=this.queue.splice(0,16);
        const values=await readDevArtifactBatch<T>('templates',batch.map(row=>row.key),this.context,this.budget.limit);
        if(this.closed)throw new DOMException('DEV cache reader released','AbortError');
        const admitted=batch.filter(row=>values.has(row.key)),deferred=batch.filter(row=>!values.has(row.key));
        if(!admitted.length)throw Error('DEV cache batch made no progress');
        this.diagnostics.batches++;this.diagnostics.entries+=admitted.length;this.diagnostics.deferred+=deferred.length;
        this.queue.unshift(...deferred);
        let remaining=admitted.length;const reservation=release;release=undefined;
        const finish=()=>{if(--remaining===0)reservation();};
        for(const row of admitted){
          let done=false;const consume=()=>{if(done)return;done=true;this.leases.delete(consume);finish();};
          this.leases.add(consume);row.resolve({value:values.get(row.key)!,release:consume});
        }
      }catch(error){for(const row of batch)row.reject(error);}
      finally {release?.();}
    }}finally {this.running=false;}
  }
  close():void{
    this.closed=true;if(this.timer)clearTimeout(this.timer);
    for(const row of this.queue)row.reject(new DOMException('DEV cache reader released','AbortError'));
    this.queue=[];for(const release of this.leases)release();this.leases.clear();
  }
}
