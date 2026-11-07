import {existsSync,readdirSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';

export function assertOwnedRuntime(workspace,runtime){
  const base=realpathSync(workspace),target=realpathSync(runtime),rel=relative(base,target);
  if(!rel||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw Error('Runtime is outside the workspace');
  if(!existsSync(join(target,'msedgewebview2.exe')))throw Error('Fixed runtime executable missing');
  const visit=directory=>{for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(entry.isSymbolicLink())throw Error('Runtime must not contain links');
    if(entry.isDirectory())visit(join(directory,entry.name));
  }};visit(target);return target;
}

/** Fix file metadata, not Chromium sandbox flags. ZIP/copies can inherit Low IL. */
export function prepareFixedRuntimeSecurity(workspace,runtime,execute=spawnSync){
  const target=assertOwnedRuntime(resolve(workspace),runtime);
  if(process.platform!=='win32')return {status:'not-applicable'};
  const commands=[
    [target,'/grant','*S-1-15-2-2:(OI)(CI)(RX)','/T','/C','/Q'],
    [target,'/grant','*S-1-15-2-1:(OI)(CI)(RX)','/T','/C','/Q'],
    [target,'/setintegritylevel','(OI)(CI)M','/T','/C','/Q'],
  ];
  for(const name of ['GIM-Reader.exe','measurement_sampler.exe']){
    const host=join(dirname(target),name);if(existsSync(host))commands.push([host,'/setintegritylevel','M','/Q']);
  }
  for(const args of commands){
    const result=execute('icacls.exe',args,{windowsHide:true,encoding:'utf8'});
    if(result.error||result.status!==0)throw Error('Fixed runtime permission/integrity preparation failed');
  }
  return {status:'prepared',policy:'appcontainer-rx-medium-integrity-v1',sandboxDisabled:false};
}
