import {lstatSync,mkdirSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {dirname,join,relative,resolve,sep,isAbsolute} from 'node:path';
import {workspacePath,sha256} from './samples.mjs';

/** Classify the workspace artifact domain, including output itself. */
export function isPublicArtifact(root,target){
  const rel=relative(resolve(root),resolve(target));
  if(isAbsolute(rel)||rel.split(sep).some(part=>part==='..'))throw Error('artifact-outside-workspace');
  return rel.split(sep)[0].toLowerCase()==='output';
}

/** Create artifacts only below workspace tmp/output, without traversing links. */
export function artifactDirectory(root,target){
  const path=resolve(target),rel=relative(resolve(root),path),parts=rel.split(sep);
  if(!['tmp','output'].includes(parts[0])||parts.some(part=>part==='..'))throw Error('Artifacts must be below workspace tmp/ or output/');
  let parent=resolve(root);
  for(const part of parts){parent=join(parent,part);try{mkdirSync(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    if(lstatSync(parent).isSymbolicLink()||!statSync(parent).isDirectory())throw Error('Artifact directory cannot contain links');}
  return parent;
}

/** Outputs may be new files; validate every existing parent and the leaf separately. */
export function artifactFile(root,target){
  const path=resolve(target);
  artifactDirectory(root,dirname(path));
  try{
    const entry=lstatSync(path);
    if(entry.isSymbolicLink()||!entry.isFile())throw Error('Artifact file cannot be a link or directory');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  return path;
}

function actions(value=[]){
  if(!Array.isArray(value))throw Error('invalid-actions');
  const selectors={'dev-fine':['canonical-first-base-v1','canonical-first-boolean-base-v1'],
    'ifc-near':['smallest-source-canonical-small-object-v1'],'ifc-fine':['smallest-source-canonical-small-object-v1']};
  return value.map(row=>{if(!selectors[row?.kind]?.includes(row.selector))throw Error('invalid-actions');return {kind:row.kind,selector:row.selector};});
}

/** JSON paths are relative to the JSON file; existing gim-samples-v1 paths are workspace-relative. */
export async function loadBatchInputs(root,{directory,registry}){
  if(Boolean(directory)===Boolean(registry))throw Error('Specify exactly one of --directory or --registry');
  const inputs=[];
  const visit=(folder,metadata={})=>{
    let entries;try{entries=readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'));}
    catch{inputs.push({path:folder,error:'directory-unreadable',...metadata});return 0;}
    let found=0;
    for(const entry of entries){const path=join(folder,entry.name);
      if(entry.isSymbolicLink()){inputs.push({path,error:'linked-input-not-followed',...metadata});continue;}
      if(entry.isDirectory())found+=visit(path,metadata);else if(entry.isFile()&&/\.gim$/i.test(entry.name)){inputs.push({path,...metadata});found++;}}
    return found;
  };
  const addDirectory=(path,metadata={})=>{
    let absolute;
    try{absolute=workspacePath(root,resolve(path),false);}catch{inputs.push({path,error:'directory-outside-workspace',...metadata});return;}
    let cursor=resolve(root);
    for(const part of relative(cursor,absolute).split(sep)){
      cursor=join(cursor,part);
      let info;try{info=lstatSync(cursor);}catch(error){inputs.push({path:absolute,error:error.code==='ENOENT'?'directory-missing':'directory-unreadable',...metadata});return;}
      if(info.isSymbolicLink()){inputs.push({path:absolute,error:'linked-input-not-followed',...metadata});return;}
    }
    let directoryInfo;try{directoryInfo=statSync(absolute);}catch{inputs.push({path:absolute,error:'directory-unreadable',...metadata});return;}
    if(!directoryInfo.isDirectory()){inputs.push({path:absolute,error:'not-a-directory',...metadata});return;}
    const before=inputs.length,found=visit(absolute,metadata);
    if(!found&&!inputs.slice(before).some(row=>row.error))inputs.push({path:absolute,error:'directory-empty',...metadata});
  };
  if(directory){
    addDirectory(directory);
  }else{
    const file=workspacePath(root,resolve(registry)),document=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    if(document.version==='gim-batch-directories-v1'){
      if(document.sampleTier!=='L2'||!Array.isArray(document.directories)||!document.directories.length)throw Error('L2 directory registry is invalid');
      for(const row of document.directories){
        if(typeof row?.path!=='string'||!row.path)inputs.push({error:'invalid-registry-entry',sampleTier:'L2',group:row?.group});
        else if(typeof row.group!=='string'||!/^[a-z][a-z0-9-]{1,40}$/.test(row.group))inputs.push({error:'invalid-group-label',sampleTier:'L2'});
        else addDirectory(resolve(dirname(file),row.path),{sampleTier:'L2',group:row.group??null});
      }
    }else{
      const rows=Array.isArray(document)?document:document.samples;
      if(!Array.isArray(rows))throw Error('Registry must be an array or an object with samples[]');
      const base=document.version==='gim-samples-v1'?root:dirname(file);
      for(const row of rows){
        const paths=typeof row==='string'?[row]:row?.paths??[row?.path];
        if(!Array.isArray(paths)||!paths.length){inputs.push({error:'invalid-registry-entry'});continue;}
        for(const path of paths)inputs.push({path:typeof path==='string'?resolve(base,path):null,
          sourceSha256:row?.sourceSha256,sampleTier:row?.sampleTier??row?.memberships?.[0]?.sampleTier,group:row?.group,
          requireSha:document.version==='gim-batch-input-v1'&&['L0','L1'].includes(row?.sampleTier),actions:row?.actions});
      }
    }
  }
  const seen=new Map(),samples=[],entries=[];
  for(const [index,input]of inputs.entries()){
    const entry={inputId:`input-${String(index+1).padStart(6,'0')}`,sampleId:null,sourceSha256:null,
      sampleTier:['L0','L1','L2'].includes(input.sampleTier)?input.sampleTier:null,
      group:typeof input.group==='string'&&/^[a-z][a-z0-9-]{1,40}$/.test(input.group)?input.group:null,
      actions:[],status:'READY',error:null,privatePath:input.path??null};
    try{
      if(input.error)throw Error(input.error);
      if(input.group!=null&&(typeof input.group!=='string'||!/^[a-z][a-z0-9-]{1,40}$/.test(input.group)))throw Error('invalid-group-label');
      if(input.requireSha&&!/^[a-f0-9]{64}$/i.test(input.sourceSha256??''))throw Error('source-sha-required');
      if(!input.path||!/\.gim$/i.test(input.path))throw Error('invalid-gim-path');
      const path=workspacePath(root,input.path),before=statSync(path);if(!before.isFile())throw Error('not-a-file');
      const sha=await sha256(path),after=statSync(path);
      if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('source-changed-during-hash');
      if(input.sourceSha256&&String(input.sourceSha256).toLowerCase()!==sha)throw Error('source-sha-mismatch');
      entry.actions=actions(input.actions);entry.sourceSha256=sha;entry.sampleId=`gim-${sha.slice(0,16)}`;entry.bytes=after.size;
      const key=sha+JSON.stringify(entry.actions);
      if(seen.has(key)){entry.status='DUPLICATE';entry.duplicateOf=seen.get(key);}
      else{seen.set(key,entry.inputId);samples.push({inputId:entry.inputId,sampleId:entry.sampleId,sourceSha256:sha,bytes:after.size,paths:[relative(root,path)],group:entry.group,actions:entry.actions});}
    }catch(error){entry.status='INPUT_ERROR';entry.error=/^[a-z][a-z0-9-]+$/.test(error.message)?error.message:error.code==='ENOENT'?'source-missing':'input-unreadable-or-outside-workspace';}
    entries.push(entry);
  }
  if(!entries.length)throw Error('No .gim inputs found');
  return {samples,entries};
}
