import type {PackedEngineeringSource} from './engineeringSourceCodec.js';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const marker=encoder.encode(',"nodes":[');
const fail=():never=>{throw Error('工程来源表 JSON 无效');};
let channel:MessageChannel|undefined;
const queue:Array<()=>void>=[];
/** A task boundary without the browser's nested-timer clamp. */
export function yieldEngineeringCodec():Promise<void>{
  const immediate=(globalThis as {setImmediate?:(callback:()=>void)=>unknown}).setImmediate;
  if(immediate)return new Promise(resolve=>immediate(resolve));
  if(typeof MessageChannel==='undefined')return new Promise(resolve=>setTimeout(resolve,0));
  if(!channel){channel=new MessageChannel();channel.port1.onmessage=()=>queue.shift()?.();}
  return new Promise(resolve=>{queue.push(resolve);channel!.port2.postMessage(null);});
}
const check=(current:()=>boolean)=>{if(!current())throw new DOMException('Engineering codec cancelled','AbortError');};

/** Only a fully owned allocation may be detached. Drop its storage immediately
 * after consumption instead of keeping native bytes until a later GC. */
export function releaseEngineeringBytes(bytes:Uint8Array):void{
  const buffer=bytes.buffer;
  if(!(buffer instanceof ArrayBuffer)||bytes.byteOffset!==0||bytes.byteLength!==buffer.byteLength)return;
  try{(buffer as ArrayBuffer&{transfer?:(length:number)=>ArrayBuffer}).transfer?.(0);}
  catch{/* Native/non-detachable storage keeps the existing GC fallback. */}
}

/** Exact JSON.stringify(table) UTF-8 bytes, with bounded temporary strings.
 * The persisted and runtime formats remain unchanged. */
export async function* engineeringTableChunks(table:PackedEngineeringSource,maxBytes:number,
  current:()=>boolean=()=>true,yieldTask:()=>Promise<void>=yieldEngineeringCodec,envelope?:{prefix:string;suffix:string},consume=false):AsyncGenerator<Uint8Array>{
  let total=0;
  const bytes=(text:string)=>{const chunk=encoder.encode(text);total+=chunk.byteLength;if(total>maxBytes)throw Error('工程来源表 JSON 超过容量上限 (plain size)');return chunk;};
  check(current);if(envelope)yield bytes(envelope.prefix);yield bytes(JSON.stringify({encoding:table.encoding,shapes:table.shapes}).slice(0,-1)+',"nodes":[');
  for(let start=0;start<table.nodes.length;){
    check(current);let end=Math.min(start+4096,table.nodes.length),text=JSON.stringify(table.nodes.slice(start,end));
    while(text.length>1024*1024&&end-start>1){end=start+Math.max(1,(end-start)>>1);text=JSON.stringify(table.nodes.slice(start,end));}
    const chunk=bytes((start?',':'')+text.slice(1,-1));
    if(consume)for(let i=start;i<end;i++)(table.nodes as unknown[])[i]=null;
    yield chunk;start=end;if(start<table.nodes.length)await yieldTask();
  }
  yield bytes('],"root":'+JSON.stringify(table.root)+'}');if(envelope)yield bytes(envelope.suffix);check(current);
}

export async function stringifyEngineeringTable(table:PackedEngineeringSource,maxBytes:number,
  current:()=>boolean=()=>true,yieldTask:()=>Promise<void>=yieldEngineeringCodec,envelope?:{prefix:string;suffix:string},consume=false):Promise<Uint8Array>{
  const chunks:Uint8Array[]=[];let total=0;
  for await(const chunk of engineeringTableChunks(table,maxBytes,current,yieldTask,envelope,consume)){chunks.push(chunk);total+=chunk.length;}
  const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;releaseEngineeringBytes(chunk);}
  return result;
}

/** Read the canonical table JSON emitted by both old and current encoders.
 * Scanning bytes keeps quotes/escapes intact and avoids a model-sized UTF-16
 * string. The existing table decoder still validates all shapes/references. */
export async function parseEngineeringTable(bytes:Uint8Array,current:()=>boolean=()=>true,
  yieldTask:()=>Promise<void>=yieldEngineeringCodec):Promise<PackedEngineeringSource>{
  check(current);let start=-1;
  for(let i=0;i<=bytes.length-marker.length;i++){
    if(bytes[i]!==marker[0])continue;let j=1;while(j<marker.length&&bytes[i+j]===marker[j])j++;
    if(j===marker.length){start=i;break;}
  }
  if(start<0)return fail();
  const header=JSON.parse(decoder.decode(bytes.subarray(0,start))+'}') as Partial<PackedEngineeringSource>;
  if(header.encoding!=='engineering-source-table-v1'||!Array.isArray(header.shapes)||Object.keys(header).some(k=>k!=='encoding'&&k!=='shapes'))return fail();
  const nodes:PackedEngineeringSource['nodes']=[];
  let scratch=new Uint8Array();
  let inString=false,escaped=false,depth=0,batchStart=start+marker.length,rows=0,lastEnd=batchStart,outerEnd=-1;
  const consume=(end:number)=>{
    // Add array framing before decoding. Concatenating brackets onto decoded
    // text forces a second, model-sized total of flattened UTF-16 strings.
    const length=end-batchStart,required=length+2;
    if(scratch.length<required)scratch=new Uint8Array(Math.ceil(required/65536)*65536);
    scratch[0]=91;scratch.set(bytes.subarray(batchStart,end),1);scratch[length+1]=93;
    const batch:unknown=JSON.parse(decoder.decode(scratch.subarray(0,required)));
    if(!Array.isArray(batch))return fail();for(const row of batch)nodes.push(row);
  };
  for(let i=batchStart;i<bytes.length;i++){
    const byte=bytes[i];
    if(inString){if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34)inString=false;continue;}
    if(byte===34){inString=true;continue;}
    if(byte===91)depth++;
    else if(byte===93){
      if(depth===0){outerEnd=i;break;}
      if(--depth===0){rows++;lastEnd=i+1;
        if(rows>=4096||lastEnd-batchStart>=1024*1024){consume(lastEnd);rows=0;batchStart=lastEnd;
          if(bytes[batchStart]===44)batchStart++;await yieldTask();check(current);}
      }
    }
  }
  if(outerEnd<0||inString||depth!==0)return fail();
  if(lastEnd>batchStart)consume(lastEnd);
  // A nonempty tail other than the final node-array bracket is malformed.
  if(bytes.subarray(lastEnd,outerEnd).some(byte=>byte!==32&&byte!==9&&byte!==10&&byte!==13))return fail();
  const suffix=decoder.decode(bytes.subarray(outerEnd+1));if(!suffix.startsWith(','))return fail();
  const footer=JSON.parse('{'+suffix.slice(1)) as {root?:number};
  if(Object.keys(footer).length!==1||!Number.isSafeInteger(footer.root)||footer.root!<0||footer.root!>=nodes.length)return fail();
  check(current);releaseEngineeringBytes(scratch);return {encoding:header.encoding,shapes:header.shapes,nodes,root:footer.root!};
}
