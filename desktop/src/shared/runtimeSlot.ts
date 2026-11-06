export class RuntimeSlot<T extends { release():void }> {
  private runtime:T|null=null;
  constructor(private report:(error:unknown)=>void=error=>console.error('[Runtime] release failed',error)){}
  get value():T|null {return this.runtime;}
  set value(next:T|null) {
    if(next===this.runtime)return;
    const previous=this.runtime;this.runtime=next;
    try{previous?.release();}catch(error){this.report(error);}
  }
}
