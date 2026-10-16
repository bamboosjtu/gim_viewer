/** Indexed heap: promotion/cancellation removes entries immediately, without stale nodes.
 * Subtracting the same current time from every ordinary rank preserves age ordering. */
export class WorkQueue<T> {
  private heap: {key:string;value:T;rank:number;order:number}[]=[];
  private positions=new Map<string,number>();
  private sequence=0;
  private rank(priority:number,queuedAt:number) { return priority===0 ? -Infinity : priority+queuedAt/15000; }
  get size() {return this.heap.length;}
  set(key:string,value:T,priority:number,queuedAt:number):void {
    const position=this.positions.get(key);
    if(position!==undefined){this.heap[position].rank=this.rank(priority,queuedAt);this.heap[position].value=value;this.repair(position);return;}
    const index=this.heap.length;this.heap.push({key,value,rank:this.rank(priority,queuedAt),order:++this.sequence});this.positions.set(key,index);this.up(index);
  }
  take():[string,T]|undefined {const first=this.heap[0];if(!first)return;this.delete(first.key);return [first.key,first.value];}
  delete(key:string):void {
    const index=this.positions.get(key);if(index===undefined)return;
    const last=this.heap.pop()!;this.positions.delete(key);
    if(index<this.heap.length){this.heap[index]=last;this.positions.set(last.key,index);this.repair(index);}
  }
  clear():void {this.heap=[];this.positions.clear();}
  private before(a:number,b:number):boolean {const x=this.heap[a],y=this.heap[b];return x.rank<y.rank || x.rank===y.rank && x.order<y.order;}
  private swap(a:number,b:number):void {[this.heap[a],this.heap[b]]=[this.heap[b],this.heap[a]];this.positions.set(this.heap[a].key,a);this.positions.set(this.heap[b].key,b);}
  private up(index:number):number {while(index>0){const parent=(index-1)>>>1;if(!this.before(index,parent))break;this.swap(index,parent);index=parent;}return index;}
  private repair(index:number):void {
    index=this.up(index);
    while(index*2+1<this.heap.length){let next=index*2+1;if(next+1<this.heap.length && this.before(next+1,next))next++;
      if(!this.before(next,index))break;this.swap(next,index);index=next;}
  }
}
