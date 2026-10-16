/** Bounds bytes admitted to a consumer stage. Already-running producer memory is separate. */
export class ByteWorkBudget {
  bytes = 0;
  peakBytes = 0;
  private closed = false;
  private waiting: { bytes:number; resolve:(release:()=>void)=>void; reject:(error:Error)=>void }[] = [];
  constructor(readonly limit:number) {}
  acquire(bytes:number):Promise<()=>void> {
    if(this.closed) return Promise.reject(new DOMException('Byte budget released','AbortError'));
    if(!Number.isSafeInteger(bytes) || bytes<0 || bytes>this.limit) return Promise.reject(Error('Input exceeds byte budget'));
    return new Promise((resolve,reject)=>{this.waiting.push({bytes,resolve,reject});this.drain();});
  }
  close():void {
    this.closed=true;
    for(const row of this.waiting)row.reject(new DOMException('Byte budget released','AbortError'));
    this.waiting=[];
  }
  private drain():void {
    while(!this.closed && this.waiting.length && this.bytes+this.waiting[0].bytes<=this.limit) {
      const row=this.waiting.shift()!;this.bytes+=row.bytes;this.peakBytes=Math.max(this.peakBytes,this.bytes);
      let released=false;
      row.resolve(()=>{if(released)return;released=true;this.bytes-=row.bytes;this.drain();});
    }
  }
}
