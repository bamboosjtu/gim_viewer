import {lstatSync,readFileSync} from 'node:fs';
import {dirname,relative,resolve,sep} from 'node:path';
import {workspacePath,sha256} from '../benchmarks/samples.mjs';

export const REQUIRED_ROLES=['substation','line','equipment'];
export const PRODUCT_TYPE={substation:'substation',line:'transmission_line',equipment:'equipment'};

export function validateLocalRegistryShape(document){
  if(document?.version!=='gim-local-tests-v1'||!Array.isArray(document.samples))throw Error('local-registry-version-or-samples-invalid');
  const roles=new Set();
  for(const row of document.samples){
    if(!REQUIRED_ROLES.includes(row?.role))throw Error('local-sample-role-invalid');
    if(typeof row.path!=='string'||!row.path.toLowerCase().endsWith('.gim'))throw Error('local-sample-path-invalid');
    roles.add(row.role);
  }
  for(const role of REQUIRED_ROLES)if(!roles.has(role))throw Error(`local-sample-missing-${role}`);
  return document.samples;
}

export function readLocalRegistry(root,path){
  const file=workspacePath(root,resolve(path));
  const document=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  return {file,samples:validateLocalRegistryShape(document)};
}

export async function planLocalRegistry(root,local){
  const available=[],skipped=[],seen=new Set();
  for(const row of local.samples){
    if(!/^[a-f0-9]{64}$/i.test(row.sourceSha256??'')){
      skipped.push({role:row.role,reason:'source-not-configured'});continue;
    }
    const path=workspacePath(root,resolve(dirname(local.file),row.path),false);
    let cursor=resolve(root),missing=false;
    for(const part of relative(cursor,path).split(sep)){
      cursor=resolve(cursor,part);
      let entry;
      try{entry=lstatSync(cursor);}catch(error){if(error.code==='ENOENT'){missing=true;break;}throw error;}
      if(entry.isSymbolicLink())throw Error(`local-sample-link-rejected:${row.role}`);
    }
    if(missing){skipped.push({role:row.role,reason:'source-missing'});continue;}
    const source=workspacePath(root,path);
    const actual=await sha256(source);
    if(actual!==row.sourceSha256.toLowerCase())throw Error(`local-sample-sha-mismatch:${row.role}`);
    if(seen.has(actual))throw Error('local-sample-sha-duplicated');
    seen.add(actual);available.push({...row,path:source,sourceSha256:actual});
  }
  return {available,skipped};
}

export function applyProjectRoleChecks(rows,samples){
  const roles=new Map(samples.map(row=>[row.sourceSha256.toLowerCase(),row.role]));
  let mismatches=0;
  for(const row of rows){
    const role=roles.get(row.sourceSha256?.toLowerCase());
    row.expectedRole=role??null;
    if(row.status!=='PASS')continue;
    if(!role||row.projectType!==PRODUCT_TYPE[role]){
      row.status='FAIL';row.error='registered-project-type-mismatch';mismatches++;
    }
  }
  return mismatches;
}
