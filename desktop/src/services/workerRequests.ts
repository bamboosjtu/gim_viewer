/** One settlement path for worker requests, regardless of transport/protocol. */
export class WorkerRequests<T> {
  private pending = new Map<number, { resolve(value:T):void; reject(error:Error):void; timer:ReturnType<typeof setTimeout> }>();
  constructor(private timeoutMs = 120_000, private onTimeout: (error:Error)=>void = () => {}) {}
  private expire(id:number):void {
    if(!this.pending.has(id))return;
    const error=new Error(`Worker 请求超时（${this.timeoutMs} ms），请重试`);
    this.rejectAll(error);this.onTimeout(error);
  }
  request(id:number, send:()=>void):Promise<T> {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.expire(id),this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try {send();}catch(error){this.settle(id,undefined,error instanceof Error?error:new Error(String(error)));}
    });
  }
  /** Extend a live request only when its Worker reports actual stage progress. */
  touch(id:number):boolean {
    const row=this.pending.get(id);if(!row)return false;
    clearTimeout(row.timer);row.timer=setTimeout(()=>this.expire(id),this.timeoutMs);return true;
  }
  settle(id:number,value?:T,error?:Error):void {
    const row=this.pending.get(id);if(!row)return;
    this.pending.delete(id);clearTimeout(row.timer);
    if(error)row.reject(error);else row.resolve(value as T);
  }
  rejectAll(error:Error):void { for(const id of [...this.pending.keys()])this.settle(id,undefined,error); }
}
