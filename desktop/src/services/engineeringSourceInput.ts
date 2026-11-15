import {isByteFile,copyByteFileBytes} from '@desktop/byteFile.js';
import {batchReadCachedFiles} from '@desktop/database.js';
import {ENGINEERING_SOURCE_BATCH_BYTES,ENGINEERING_SOURCE_BATCH_FILES,type EngineeringSourceInput} from './engineeringWorkerProtocol.js';

/** Read requested source entries only. The caller owns the immutable inventory
 * and session; no standard, classification or geometry identity is involved. */
export async function readEngineeringSourceInput(files:ReadonlyMap<string,File>,paths:readonly string[],projectId:number|null,current:()=>boolean):Promise<EngineeringSourceInput>{
  const input:EngineeringSourceInput={batches:[],files:[],errors:[]};
  for(let offset=0;offset<paths.length;){
    if(!current())throw new DOMException('Source input session expired','AbortError');
    const chunk:Array<[string,File]>=[];let estimated=0;
    while(offset<paths.length&&chunk.length<ENGINEERING_SOURCE_BATCH_FILES){
      const path=paths[offset],file=files.get(path);if(!file){input.errors.push({path,message:'Source entry missing'});offset++;continue;}
      if(chunk.length&&estimated+file.size>ENGINEERING_SOURCE_BATCH_BYTES)break;
      offset++;estimated+=file.size;chunk.push([path,file]);
    }
    if(!chunk.length)continue;
    const lazy=chunk.filter(([,file])=>!(file instanceof Blob)&&!isByteFile(file));
    let native:Map<string,Uint8Array|null>|undefined;
    if(lazy.length&&projectId!=null){
      try{native=await batchReadCachedFiles(projectId,lazy.map(([path])=>path));}
      catch{/* Isolate a native batch failure through the individual source reader. */}
    }
    if(!current())throw new DOMException('Source input session expired','AbortError');
    const parts:BlobPart[]=[],entries:Array<{path:string;offset:number;length:number}>=[];let bytes=0;
    for(const [path,file]of chunk){
      try{
        let part:Blob|Uint8Array<ArrayBuffer>;
        if(isByteFile(file))part=copyByteFileBytes(file)!;
        else if(file instanceof Blob)part=file;
        else{
          const lazyFile=file as unknown as {arrayBuffer?:()=>Promise<ArrayBuffer>;text:()=>Promise<string>};
          const value=native?.get(path);
          if(value)part=value.buffer instanceof ArrayBuffer?value as Uint8Array<ArrayBuffer>:value.slice() as Uint8Array<ArrayBuffer>;
          else if(typeof lazyFile.arrayBuffer==='function')part=new Uint8Array(await lazyFile.arrayBuffer());
          else part=new TextEncoder().encode(await lazyFile.text());
        }
        const length=part instanceof Blob?part.size:part.byteLength;
        parts.push(part);entries.push({path,offset:bytes,length});bytes+=length;
      }catch(error){input.errors.push({path,message:String(error)});}
    }
    const blob=new Blob(parts);
    if(blob.size>ENGINEERING_SOURCE_BATCH_BYTES){
      for(const entry of entries)input.files.push({path:entry.path,blob:blob.slice(entry.offset,entry.offset+entry.length)});
    }else if(entries.length)input.batches.push({blob,entries});
  }
  return input;
}
