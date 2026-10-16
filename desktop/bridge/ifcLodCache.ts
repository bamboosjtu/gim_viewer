/** Far artifacts remain independent. Near geometry/properties use a bounded derived cache. */
import {IFC_NEAR_CACHE_LIMITS,estimateArtifactBytes,isNearArtifactKey} from './ifcNearCachePolicy.js';
const databaseName='gim-ifc-lod-v1';
const metaStore='near-meta';
const usageKey='@usage';
interface Usage {key:string;bytes:number;count:number}
interface Metadata {key:string;bytes:number;touched:number}
let database:Promise<IDBDatabase>|null=null;
let warnedUnavailable=false;
export const ifcNearCacheDiagnostics={bytes:0,entries:0,evictions:0,oversized:0};
function open():Promise<IDBDatabase> {
  if(!database)database=new Promise((resolve,reject)=>{
    const request=indexedDB.open(databaseName,2);let blocked=false;
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('artifacts'))db.createObjectStore('artifacts');
      db.createObjectStore(metaStore,{keyPath:'key'}).createIndex('touched','touched');
      // Old near entries have no size/access accounting. Retire this derived
      // domain once, using keys only; do not clone or invalidate far fragments.
      const artifacts=request.transaction!.objectStore('artifacts');
      const cursor=artifacts.openKeyCursor();
      cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(isNearArtifactKey(String(row.key)))artifacts.delete(row.primaryKey);row.continue();};
    };
    request.onsuccess=()=>{if(blocked){request.result.close();return;}request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>{blocked=true;reject(Error('IFC near cache upgrade blocked'));};
  });
  return database;
}
function warn(error:unknown):void {if(!warnedUnavailable){warnedUnavailable=true;console.warn('[IFC LOD] cache write unavailable',error);}}
async function touch(keys:string[]):Promise<void> {
  const near=keys.filter(isNearArtifactKey);if(!near.length)return;
  try {const db=await open();await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(metaStore,'readwrite'),store=tx.objectStore(metaStore);
    for(const key of near){const request=store.get(key);request.onsuccess=()=>{if(request.result)store.put({...request.result,touched:Date.now()});};}
    tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);
  });}catch{/* Cache touches cannot block browsing. */}
}
export async function readIfcLodArtifacts<T>(keys:string[]):Promise<(T|null)[]> {
  if(!keys.length)return [];
  try {const db=await open();const values=await new Promise<(T|null)[]>((resolve,reject)=>{
    const tx=db.transaction('artifacts'),store=tx.objectStore('artifacts');const rows:(T|null)[]=keys.map(()=>null);
    keys.forEach((key,i)=>{const request=store.get(key);request.onsuccess=()=>{rows[i]=request.result??null;};});
    tx.oncomplete=()=>resolve(rows);tx.onerror=tx.onabort=()=>reject(tx.error);
  });void touch(keys.filter((_key,i)=>values[i]!==null));return values;}catch{return keys.map(()=>null);}
}
export async function readIfcLodArtifact<T>(key:string):Promise<T|null>{return (await readIfcLodArtifacts<T>([key]))[0];}
export async function writeIfcLodArtifacts(rows:{key:string;value:unknown}[]):Promise<void> {
  if(!rows.length)return;
  const unique=[...new Map(rows.map(row=>[row.key,row])).values()];
  const near=unique.filter(row=>isNearArtifactKey(row.key)).map(row=>({...row,bytes:estimateArtifactBytes(row.value)+row.key.length*2,admit:false}));
  let remainingBytes:number=IFC_NEAR_CACHE_LIMITS.bytes,remainingCount:number=IFC_NEAR_CACHE_LIMITS.entries;
  for(let i=near.length-1;i>=0;i--){const row=near[i];row.admit=row.bytes<=IFC_NEAR_CACHE_LIMITS.singleBytes && row.bytes<=remainingBytes && remainingCount>0;
    if(row.admit){remainingBytes-=row.bytes;remainingCount--;}else ifcNearCacheDiagnostics.oversized++;}
  try {const db=await open();await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['artifacts',metaStore],'readwrite'),artifacts=tx.objectStore('artifacts'),metadata=tx.objectStore(metaStore);
    for(const row of unique)if(!isNearArtifactKey(row.key))artifacts.put(row.value,row.key);
    const readUsage=metadata.get(usageKey);let usage:Usage;let evictions=0;
    tx.oncomplete=()=>{if(usage){ifcNearCacheDiagnostics.bytes=usage.bytes;ifcNearCacheDiagnostics.entries=usage.count;}ifcNearCacheDiagnostics.evictions+=evictions;resolve();};
    tx.onerror=tx.onabort=()=>reject(tx.error);
    readUsage.onsuccess=()=>{
      usage=readUsage.result??{key:usageKey,bytes:0,count:0};let pending=near.length;
      const protect=new Set(near.filter(row=>row.admit).map(row=>row.key));
      const save=()=>metadata.put(usage);
      const prune=()=>{
        if(usage.bytes<=IFC_NEAR_CACHE_LIMITS.bytes && usage.count<=IFC_NEAR_CACHE_LIMITS.entries){save();return;}
        const request=metadata.index('touched').openCursor();
        request.onsuccess=()=>{
          const cursor=request.result;
          if(!cursor || usage.bytes<=IFC_NEAR_CACHE_LIMITS.bytes && usage.count<=IFC_NEAR_CACHE_LIMITS.entries){save();return;}
          const old=cursor.value as Metadata;
          if(!protect.has(old.key)){artifacts.delete(old.key);cursor.delete();usage.bytes-=old.bytes;usage.count--;evictions++;}
          cursor.continue();
        };
      };
      if(!pending){save();return;}
      for(const row of near){const request=metadata.get(row.key);request.onsuccess=()=>{
        const old=request.result as Metadata|undefined;
        if(old){usage.bytes-=old.bytes;usage.count--;}
        if(row.admit){artifacts.put(row.value,row.key);metadata.put({key:row.key,bytes:row.bytes,touched:Date.now()});usage.bytes+=row.bytes;usage.count++;}
        else{artifacts.delete(row.key);metadata.delete(row.key);}
        if(--pending===0)prune();
      };}
    };
  });}catch(error){warn(error);}
}
export async function writeIfcLodArtifact(key:string,value:unknown):Promise<void>{await writeIfcLodArtifacts([{key,value}]);}
export async function deleteIfcLodArtifact(key:string):Promise<void> {
  try{const db=await open();await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['artifacts',metaStore],'readwrite'),metadata=tx.objectStore(metaStore);
    tx.objectStore('artifacts').delete(key);
    let usage:Usage|undefined;
    const readUsage=metadata.get(usageKey);readUsage.onsuccess=()=>{
      usage=readUsage.result??{key:usageKey,bytes:0,count:0};const current=usage!;const old=metadata.get(key);
      old.onsuccess=()=>{if(old.result){current.bytes-=old.result.bytes;current.count--;metadata.delete(key);metadata.put(current);}};
    };
    tx.oncomplete=()=>{if(usage){ifcNearCacheDiagnostics.bytes=usage.bytes;ifcNearCacheDiagnostics.entries=usage.count;}resolve();};tx.onerror=tx.onabort=()=>reject(tx.error);
  });}catch{/* Source fallback remains available. */}
}
