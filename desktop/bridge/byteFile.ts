/** Native metadata File facade. Takes ownership of the supplied byte view;
 * callers must not mutate it afterwards. The facade itself is not cloneable;
 * Worker adapters explicitly materialize a Blob or transfer owned copies. */
const contents=new WeakMap<object,Uint8Array<ArrayBuffer>>();
class ByteBlob {
  readonly size:number;
  constructor(bytes:Uint8Array<ArrayBuffer>,readonly type='') {this.size=bytes.byteLength;contents.set(this,bytes);}
  async arrayBuffer():Promise<ArrayBuffer>{return contents.get(this)!.slice().buffer;}
  async text():Promise<string>{return new TextDecoder().decode(contents.get(this)!);}
  slice(start=0,end=this.size,type=''):Blob{
    const index=(n:number)=>{const value=Number.isNaN(n)?0:Math.trunc(n);return value<0?Math.max(this.size+value,0):Math.min(value,this.size);};
    const from=index(start),to=Math.max(from,index(end));
    return new ByteBlob(contents.get(this)!.subarray(from,to),type.toLowerCase())as unknown as Blob;
  }
  stream():ReadableStream<Uint8Array>{
    const bytes=contents.get(this)!;
    return new ReadableStream({start(controller){controller.enqueue(bytes.slice());controller.close();}});
  }
}
class ByteFile extends ByteBlob {
  readonly webkitRelativePath='';
  constructor(bytes:Uint8Array<ArrayBuffer>,readonly name:string,readonly lastModified:number,type:string){super(bytes,type);}
}
export function createByteFile(bytes:Uint8Array<ArrayBuffer>,name:string,options:{lastModified?:number;type?:string}={}):File{
  return new ByteFile(bytes,name,options.lastModified??0,options.type??'')as unknown as File;
}
export function isByteFile(value:unknown):boolean{return value instanceof ByteFile&&contents.has(value);}
/** A transfer must never detach the primary immutable source. */
export function copyByteFileBytes(value:unknown):Uint8Array<ArrayBuffer>|undefined{
  return typeof value==='object'&&value!==null?contents.get(value)?.slice():undefined;
}
