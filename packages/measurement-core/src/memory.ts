export type MemoryKind = 'buffer-capacity' | 'logical-source' | 'estimated-ir' | 'budget-reservation' | 'wasm-linear-capacity';
interface Allocation { bytes: number; kind: MemoryKind; owners: Set<string>; }
/** Explicit resource accounting, never a substitute for runtime/process memory. */
export class MemoryLedger {
  private allocations = new Map<string, Allocation>();
  private peak = new Map<MemoryKind, number>();
  private totals = new Map<MemoryKind, number>();
  private owners=new Map<string,{allocations:number;bytes:Partial<Record<MemoryKind,number>>}>();
  private reference(owner:string,kind:MemoryKind,bytes:number,sign:1|-1){
    const row=this.owners.get(owner)??{allocations:0,bytes:{}};row.allocations+=sign;row.bytes[kind]=(row.bytes[kind]??0)+bytes*sign;
    if(row.allocations)this.owners.set(owner,row);else this.owners.delete(owner);
  }
  acquire(id: string, owner: string, bytes: number, kind: MemoryKind): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('invalid-memory-capacity');
    const old = this.allocations.get(id);
    if (old) {
      if (old.bytes !== bytes || old.kind !== kind) throw Error('allocation-identity-conflict');
      if(!old.owners.has(owner)){old.owners.add(owner);this.reference(owner,kind,bytes,1);}return;
    }
    this.allocations.set(id, { bytes, kind, owners: new Set([owner]) });
    this.reference(owner,kind,bytes,1);
    const total = (this.totals.get(kind) ?? 0) + bytes; this.totals.set(kind, total);
    this.peak.set(kind, Math.max(this.peak.get(kind) ?? 0, total));
  }
  release(id: string, owner: string): void {
    const row = this.allocations.get(id); if (!row || !row.owners.delete(owner)) return;
    this.reference(owner,row.kind,row.bytes,-1);
    if (!row.owners.size) { this.allocations.delete(id); this.totals.set(row.kind, this.totals.get(row.kind)! - row.bytes); }
  }
  transfer(id: string, from: string, to: string): void {
    const row = this.allocations.get(id); if (!row?.owners.has(from)) throw Error('transfer-without-owner');
    if (from === to) return;
    if(!row.owners.has(to)){row.owners.add(to);this.reference(to,row.kind,row.bytes,1);}
    row.owners.delete(from);this.reference(from,row.kind,row.bytes,-1);
  }
  copy(id: string, newId: string, owner: string): void {
    const row = this.allocations.get(id); if (!row || id === newId || this.allocations.has(newId)) throw Error('invalid-copy');
    this.acquire(newId, owner, row.bytes, row.kind);
  }
  releaseOwner(owner: string): void { for (const id of this.allocations.keys()) this.release(id, owner); }
  bytes(kind:MemoryKind):number { return this.totals.get(kind)??0; }
  snapshot(ownerLimit=128) {
    const owners: Record<string, Partial<Record<MemoryKind, number>>> = Object.create(null);
    const limit=Number.isFinite(ownerLimit)?Math.max(0,Math.min(4096,Math.floor(ownerLimit))):128;let count=0;
    for(const [owner,row]of this.owners){if(count>=limit)break;owners[owner]={...row.bytes};count++;}
    return { uniqueAllocations: this.allocations.size, uniqueBytesByKind: Object.fromEntries(this.totals),
      peakUniqueBytesByKind: Object.fromEntries(this.peak), referencedBytesByOwner: owners,
      activeOwners:this.owners.size,omittedOwners:this.owners.size-count,
      scope: 'tracked-resources-only', ownerTotalsAreAdditive: false };
  }
}

/** Object identity stays in a WeakMap; the ledger retains IDs/counts, never buffers. */
export class BufferLedger {
  readonly ledger = new MemoryLedger();
  private identities = new WeakMap<ArrayBufferLike,string>();
  private references = new Map<string,Map<string,number>>();
  private sequence=0;
  retain(value:ArrayBufferLike|ArrayBufferView,owner:string):string {
    const buffer=ArrayBuffer.isView(value)?value.buffer:value;
    let id=this.identities.get(buffer);if(!id){id=`buffer-${++this.sequence}`;this.identities.set(buffer,id);}
    const references=this.references.get(id)??new Map<string,number>();references.set(owner,(references.get(owner)??0)+1);this.references.set(id,references);
    this.ledger.acquire(id,owner,buffer.byteLength,'buffer-capacity');return id;
  }
  release(value:ArrayBufferLike|ArrayBufferView,owner:string):void {
    const id=this.identities.get(ArrayBuffer.isView(value)?value.buffer:value);if(!id)return;
    this.releaseId(id,owner);
  }
  releaseId(id:string,owner:string):void {
    const references=this.references.get(id),count=references?.get(owner);if(!count)return;
    if(count>1)references!.set(owner,count-1);else{references!.delete(owner);this.ledger.release(id,owner);}
    if(!references!.size)this.references.delete(id);
  }
  transfer(value:ArrayBufferLike|ArrayBufferView,from:string,to:string):void {
    const id=this.identities.get(ArrayBuffer.isView(value)?value.buffer:value);if(!id)throw Error('transfer-without-allocation');
    if(from===to)return;
    const references=this.references.get(id);if(!references?.has(from))throw Error('transfer-without-owner');
    this.ledger.transfer(id,from,to);references.set(to,(references.get(to)??0)+references.get(from)!);references.delete(from);
  }
  get bytes():number{return this.ledger.bytes('buffer-capacity');}
}

/** A set of views shares one backing allocation. WASM may be excluded by caller. */
export function uniqueBufferCapacity(values: Iterable<ArrayBufferLike | ArrayBufferView>): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const value of values) buffers.add(ArrayBuffer.isView(value) ? value.buffer : value);
  let total = 0; for (const buffer of buffers) total += buffer.byteLength; return total;
}
