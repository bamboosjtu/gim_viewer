interface TimerExtension {TIME_ELAPSED_EXT:number;GPU_DISJOINT_EXT:number}
export interface GpuSample {passId:string;availability:'available'|'unavailable'|'unsupported';durationMs:number|null;reason?:string}
/** Asynchronous elapsed query only; never forces the command queue to finish. */
export class GpuTimer {
  private extension:TimerExtension|null;
  private pending:Array<{query:WebGLQuery;passId:string;atMs:number}>=[];
  private active:{query:WebGLQuery;passId:string;atMs:number}|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private gl:WebGL2RenderingContext,private emit:(sample:GpuSample)=>void,
    private now=()=>performance.now(),private limit=8,private timeoutMs=5000){
    this.extension=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }
  get supported(){return !!this.extension;}
  begin(passId:string){
    this.poll();
    if(!this.extension){this.emit({passId,availability:'unsupported',durationMs:null,reason:'timer-extension-missing'});return;}
    if(this.active||this.pending.length>=this.limit){this.emit({passId,availability:'unavailable',durationMs:null,reason:'query-capacity'});return;}
    const query=this.gl.createQuery();if(!query){this.emit({passId,availability:'unavailable',durationMs:null,reason:'query-allocation-failed'});return;}
    this.active={query,passId,atMs:this.now()};this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT,query);
  }
  end(){if(this.active&&this.extension){this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);this.pending.push(this.active);this.active=null;this.schedulePoll();}}
  private schedulePoll(){
    if(this.timer!==undefined||!this.pending.length)return;
    // Demand rendering can be idle after a pass. Read the query without drawing another frame.
    this.timer=setTimeout(()=>{this.timer=undefined;this.poll();this.schedulePoll();},100);
  }
  poll(){
    const gl=this.gl,ext=this.extension;if(!ext)return;
    const lost=gl.isContextLost(),disjoint=!lost&&gl.getParameter(ext.GPU_DISJOINT_EXT);
    this.pending=this.pending.filter(row=>{
      const available=!lost&&gl.getQueryParameter(row.query,gl.QUERY_RESULT_AVAILABLE);
      const expired=this.now()-row.atMs>=this.timeoutMs;
      if(!available&&!expired&&!lost&&!disjoint)return true;
      const raw=available&&!lost&&!disjoint?gl.getQueryParameter(row.query,gl.QUERY_RESULT):null;
      const valid=typeof raw==='number'&&Number.isFinite(raw)&&raw>=0;
      this.emit({passId:row.passId,availability:valid?'available':'unavailable',
        durationMs:valid?raw/1e6:null,
        ...(!valid?{reason:lost?'context-lost':disjoint?'disjoint':!available?'query-timeout':'invalid-query-result'}:{})});
      gl.deleteQuery(row.query);return false;
    });
  }
  dispose(){
    if(this.active){this.end();}
    if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;
    for(const row of this.pending){this.gl.deleteQuery(row.query);this.emit({passId:row.passId,availability:'unavailable',durationMs:null,reason:'capture-stopped'});}
    this.pending=[];
  }
}
