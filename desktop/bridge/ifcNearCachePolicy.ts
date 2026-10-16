export const IFC_NEAR_CACHE_LIMITS = {bytes:256*1024*1024,entries:4096,singleBytes:64*1024*1024} as const;
export const isNearArtifactKey=(key:string):boolean=>/\|(?:near-templates-v[^|]+|properties)\|/.test(key);
/** Estimate retained payload without serializing typed arrays or counting shared buffers twice. */
export function estimateArtifactBytes(value:unknown):number {
  const seen=new WeakSet<object>(),pending:unknown[]=[value];let bytes=0;
  while(pending.length){const item=pending.pop();
    if(typeof item==='string'){bytes+=item.length*2;continue;}
    if(typeof item==='number'){bytes+=8;continue;}
    if(typeof item==='boolean'){bytes+=4;continue;}
    if(!item || typeof item!=='object' || seen.has(item))continue;
    seen.add(item);
    if(ArrayBuffer.isView(item)){pending.push(item.buffer);continue;}
    if(item instanceof ArrayBuffer || typeof SharedArrayBuffer!=='undefined' && item instanceof SharedArrayBuffer){bytes+=item.byteLength;continue;}
    if(Array.isArray(item)){bytes+=24;for(const child of item)pending.push(child);continue;}
    bytes+=32;for(const [key,child] of Object.entries(item)){bytes+=key.length*2;pending.push(child);}
  }
  return bytes;
}
