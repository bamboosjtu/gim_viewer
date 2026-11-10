import { createWorkerProbe } from './workerProbe.js';
// Protocol/capability probe only. No engineering data or parser fixture.
let buffer:Uint8Array|undefined;
const state=globalThis as {__gimCapabilityModuleExecutions?:number};
state.__gimCapabilityModuleExecutions=(state.__gimCapabilityModuleExecutions??0)+1;
const pending=new Map<number,(bytes:ArrayBuffer)=>void>();
self.onmessage=createWorkerProbe().wrap(async(event,trace)=>{
  if(event.data.kind==='read-result'){pending.get(event.data.id)?.(event.data.bytes);pending.delete(event.data.id);return;}
  // Mirrors split-chunk imports of the canonical entry, without engineering data.
  const canonical=import.meta.url.split('#')[0];await import(/* @vite-ignore */ canonical);
  const reply=await new Promise<ArrayBuffer>(resolve=>{pending.set(1,resolve);self.postMessage({kind:'probe-read',id:1});});
  buffer=new Uint8Array(4*1024*1024);buffer.fill(1);
  trace.memory({name:'probe-buffer',scope:'worker',method:'array-buffer-capacity',quality:'measured-capacity',availability:'available',bytes:buffer.byteLength,sampleDelayMs:0});
  trace.produced();trace.reply({ready:true,moduleExecutions:state.__gimCapabilityModuleExecutions,roundTripValue:[...new Uint8Array(reply)].reduce((a,b)=>a+b,0)});
});
