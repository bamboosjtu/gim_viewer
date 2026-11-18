/** Lazily reads device geometry source entries. */
import { decodeGimText } from '../shared/textDecode.js';
import { readCachedEntry } from '@desktop/database.js';

/** One immutable key set per session, shared by discovery and source evidence.
 * Reads remain lazy; verification must not rebuild an archive index per DEV. */
export function createLazyGeometrySourceFiles(projectId:number|null,paths:Iterable<string>,sizes:ReadonlyMap<string,number>,current:()=>boolean):Map<string,File>{
  const files=new Map<string,File>();
  for(const path of paths)if(/\.(dev|phm|mod|stl|gl)$/i.test(path)){
    const read=async()=>{
      if(projectId==null||!current())throw Error('Device source unavailable');
      return new Uint8Array(await readCachedEntry(projectId,path)).buffer;
    };
    files.set(path,{name:path.split('/').pop()!,size:sizes.get(path)??0,arrayBuffer:read,
      text:async()=>decodeGimText(await read()).text} as File);
  }
  return files;
}
