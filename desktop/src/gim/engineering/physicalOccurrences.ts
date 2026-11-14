import type {EntryIndex} from '../entryResolver.js';
import type {SourceDocument} from './sourceDocuments.js';
import type {SourceGeometryOccurrenceCatalog} from './geometryOccurrences.js';
import {isUsableAffineMatrix} from '../geometry/affineMatrix.js';

const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const scalar=(doc:SourceDocument,key:string)=>doc.fields.find(p=>p.keys[0].toUpperCase()===key)?.value??'';
interface DevTree {path:string;children:DevTree[]}
interface Scope {roots:DevTree[];matches:Map<string,DevTree[]>}
/** Physical references only. Does not create SourceRecords, aliases, attributes,
 * identities or tree projections. Parsed documents/index are shared with the
 * later semantic consumer, so a second pass does not read/parse them again. */
export async function extractPhysicalOccurrences(input:{entryIndex:EntryIndex;readDocument(path:string):Promise<SourceDocument>},
  options:{signal?:AbortSignal;onProgress?:(count:number)=>void;maxOccurrences?:number;maxDepth?:number}={}):Promise<SourceGeometryOccurrenceCatalog>{
  const catalog:SourceGeometryOccurrenceCatalog={occurrences:[],diagnostics:[]};
  let count=0,lastYield=performance.now();
  const max=options.maxOccurrences??500_000,maxDepth=options.maxDepth??128;
  const check=(depth:number)=>{
    if(options.signal?.aborted)throw new DOMException('Physical source extraction cancelled','AbortError');
    if(depth>maxDepth||++count>max)throw Error('Physical source occurrence budget exceeded');
    if(count%256===0){options.onProgress?.(count);const now=performance.now();if(now-lastYield>=8){lastYield=now;return true;}}
    return false;
  };
  const resolve=(owner:string,value:string,context:string)=>{
    const hits=input.entryIndex.candidates(value,owner);
    if(hits.length===1)return hits[0];
    catalog.diagnostics.push({sourceContextId:context,documentPath:owner,reason:hits.length?'ambiguous-source-reference':'missing-source-reference'});
    return null;
  };
  const read=async(path:string,context:string)=>{
    try{return await input.readDocument(path);}catch(error){
      if(options.signal?.aborted)throw error;
      catalog.diagnostics.push({sourceContextId:context,documentPath:path,reason:'source-read-failed'});return null;
    }
  };
  const tree=async(path:string,ancestors:Set<string>,depth:number):Promise<DevTree|null>=>{
    if(check(depth))await new Promise<void>(resolve=>setTimeout(resolve,0));
    if(ancestors.has(path)){catalog.diagnostics.push({sourceContextId:path,documentPath:path,reason:'source-cycle'});return null;}
    const doc=await read(path,path);if(!doc)return null;
    const next=new Set(ancestors);next.add(path);
    const node:DevTree={path,children:[]};
    for(const field of doc.fields)if(/^SUBDEVICE\d+$/i.test(field.keys[0])&&/\.dev$/i.test(field.value)){
      const target=resolve(path,field.value,path);if(!target)continue;
      const child=await tree(target,next,depth+1);if(child)node.children.push(child);
    }
    return node;
  };
  const roots=new Map<string,Promise<DevTree|null>>();
  const matches=(scope:Scope,path:string)=>{
    let rows=scope.matches.get(path);if(rows)return rows;
    rows=[];
    const visit=(node:DevTree)=>{for(const child of node.children){if(child.path===path)rows!.push(child);visit(child);}};
    scope.roots.forEach(visit);scope.matches.set(path,rows);return rows;
  };
  const placement=(doc:SourceDocument,parent:number[],context:string)=>{
    const raw=scalar(doc,'TRANSFORMMATRIX');let local=identity();
    if(raw.trim()){
      const parts=raw.split(','),values=parts.map(part=>Number(part.trim()));
      if(parts.every(part=>part.trim())&&isUsableAffineMatrix(values))local=values;
      else catalog.diagnostics.push({sourceContextId:context,documentPath:doc.path,reason:'invalid-source-matrix'});
    }
    const result=new Array<number>(16).fill(0);
    for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)result[c*4+r]+=parent[k*4+r]*local[c*4+k];
    if(isUsableAffineMatrix(result))return result;
    catalog.diagnostics.push({sourceContextId:context,documentPath:doc.path,reason:'invalid-cumulative-matrix'});return identity();
  };
  const visit=async(path:string,id:string,ancestors:Set<string>,scopes:Scope[],parent:number[],depth:number):Promise<void>=>{
    if(check(depth))await new Promise<void>(resolve=>setTimeout(resolve,0));
    if(ancestors.has(path)){catalog.diagnostics.push({sourceContextId:id,documentPath:path,reason:'source-cycle'});return;}
    const doc=await read(path,id);if(!doc){if(depth===0)throw Error('Physical project source unavailable');return;}
    let matrix:number[]|undefined;
    const placed=()=>matrix??=placement(doc,parent,id);
    const omp=scalar(doc,'OBJECTMODELPOINTER');let childScopes=scopes;
    if(omp){
      const target=resolve(path,omp,id);
      if(target){
        const nearest=scopes[scopes.length-1],candidates=nearest?matches(nearest,target):[];
        if(candidates.length)childScopes=[...scopes,{roots:candidates,matches:new Map()}];
        else if(scalar(doc,'ENTITYNAME').trim().toUpperCase()!=='PARTINDEX'){
          let root=roots.get(target);if(!root){root=tree(target,new Set(),0);roots.set(target,root);}
          const topology=await root;
          if(topology){const sourceId=`dev:${id}:${target}`;
            catalog.occurrences.push({id:sourceId,sourceId,sourceContextId:id,devPath:target,name:scalar(await input.readDocument(target),'SYMBOLNAME')||scalar(doc,'SYMBOLNAME')||scalar(doc,'NAME'),placementMatrix:placed()});}
          childScopes=[...scopes,{roots:topology?[topology]:[],matches:new Map()}];
        }
      }
    }
    const edges=doc.fields.filter(p=>/^(?:SUBSYSTEM\d*|SUBDEVICE\d+)$/i.test(p.keys[0])&&/\.cbm$/i.test(p.value));
    const counts=new Map<string,number>();for(const field of edges){const key=field.keys[0].toUpperCase();counts.set(key,(counts.get(key)??0)+1);}
    const next=new Set(ancestors);next.add(path);
    for(const field of edges){const target=resolve(path,field.value,id);if(!target)continue;
      const key=field.keys[0].toUpperCase(),edge=key+((counts.get(key)??0)>1?`@line:${field.line}`:'');
      await visit(target,`${id}/${edge}:${target}`,next,childScopes,placed(),depth+1);
    }
  };
  const root=input.entryIndex.resolve('project.cbm');if(!root)throw Error('Physical sources require a unique project.cbm');
  await visit(root,`cbm:${root}`,new Set(),[],identity(),0);options.onProgress?.(count);
  return catalog;
}
