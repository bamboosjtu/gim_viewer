import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {artifactFile} from './batch-input.mjs';
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
export function systemCapabilities(){
  if(process.platform!=='win32')return {availability:'unsupported',reason:'windows-required'};
  const probe=arg=>spawnSync('wpr.exe',[arg],{windowsHide:true,encoding:'utf8',timeout:5000});
  const sources=probe('-pmcsources'),profiles=probe('-profiles');
  const exporter=spawnSync('where.exe',['WPAExporter.exe'],{windowsHide:true,encoding:'utf8',timeout:2000});
  return {availability:profiles.status===0?'available':'unavailable',wpr:profiles.status===0,
    wpaExporter:exporter.status===0?exporter.stdout.trim().split(/\r?\n/)[0]:null,
    pmcSources:sources.status===0?sources.stdout.split(/\r?\n/).map(s=>s.match(/^\s*\d+\s+(\w+)\s+/)?.[1]).filter(Boolean):[],
    permission:'authenticated-system-helper-required',elevatedCaptureAvailable:false,actualCaptureVerified:false};
}
/** Column contract is supplied with a frozen WPA profile, never guessed by CSV position. */
export function summarizeSystemRows(rows,contract,ownedProcesses){
  const required=['pid','created','start','end','value'];if(required.some(k=>!contract.columns?.[k]))throw Error('wpa-column-contract-missing');
  if(!['ns','us','ms','s'].includes(contract.timeUnit))throw Error('wpa-time-unit-required');
  const columns=contract.columns,summary=[],issues=[];
  for(const row of rows){
    if(required.some(k=>!(columns[k] in row))){issues.push('wpa-column-missing');continue;}
    if(required.some(k=>String(row[columns[k]]).trim()==='')){issues.push('wpa-value-missing');continue;}
    const pid=Number(row[columns.pid]),created=String(row[columns.created]),start=Number(row[columns.start]),end=Number(row[columns.end]),value=Number(row[columns.value]);
    const process=ownedProcesses.find(p=>p.pid===pid&&p.created===created);
    if(!process)continue;
    if(![start,end,value].every(Number.isFinite)||end<start){issues.push('wpa-value-invalid');continue;}
    summary.push({pid,created,tid:columns.tid?row[columns.tid]:null,start,end,timeUnit:contract.timeUnit,value,unit:contract.unit,method:contract.method,
      clockId:'etl',association:'verified-process-instance-and-window'});
  }
  if(!ownedProcesses.length)issues.push('process-identities-unverified');
  else if(!summary.length)issues.push('owned-process-instance-not-matched');
  return {availability:issues.length?'unavailable':'available',rows:summary,issues:[...new Set(issues)]};
}
export function parseCsv(text){
  if(Buffer.isBuffer(text))text=text[0]===255&&text[1]===254?text.subarray(2).toString('utf16le'):text.toString('utf8');
  const records=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(field);field='';}
    else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(Boolean))records.push(row);row=[];field='';}
    else field+=c;
  }
  if(quoted)throw Error('invalid-wpa-csv');
  if(field||row.length){row.push(field);records.push(row);}
  const header=records.shift()?.map(s=>s.replace(/^\uFEFF/,''))??[];
  if(new Set(header).size!==header.length)throw Error('duplicate-wpa-column');
  if(records.some(values=>values.length!==header.length))throw Error('wpa-column-count-mismatch');
  return records.map(values=>Object.fromEntries(header.map((key,i)=>[key,values[i]])));
}
export class SystemCapture {
  constructor(config){this.config=config;}
  async start(){
    const c=this.config;
    if(!Number.isFinite(c.durationMs)||c.durationMs<1||c.durationMs>30000||
      !Number.isSafeInteger(c.bufferMiB)||c.bufferMiB<8||c.bufferMiB>256)throw Error('system-window-and-buffer-budget-required');
    // A writable JSON plan cannot authorize privileged filesystem or WPR work.
    // Keep independent CPU/GPU diagnostics usable while no authenticated,
    // protected system collector is installed. Never launch a legacy fallback.
    this.result={status:'unavailable',reason:'authenticated-system-helper-required',
      requestedAtMs:performance.now(),actualCaptureVerified:false};
  }
  async stop(){return {...this.result,endedAtMs:performance.now()};}
}
export async function exportSystemTables(root,out,etl,config){
  const capability=systemCapabilities(),exporter=config.exporter??capability.wpaExporter;
  if(!exporter||!config.wpaProfile)return {availability:'unavailable',reason:'wpa-exporter-or-frozen-profile-missing'};
  if(basename(exporter).toLowerCase()!=='wpaexporter.exe')throw Error('invalid-wpa-exporter');
  const profile=resolve(config.wpaProfile);artifactFile(root,profile);
  if(hash(profile)!==config.profileSha256)throw Error('wpa-profile-changed');
  if(!existsSync(etl)||statSync(etl).size>512*1024*1024)throw Error('etl-missing-or-over-budget');
  const result=spawnSync(exporter,['-i',etl,'-profile',profile,'-outputfolder',out],{windowsHide:true,timeout:30000,
    env:{...process.env,TEMP:out,TMP:out,TMPDIR:out,_NT_SYMBOL_PATH:out},encoding:'utf8',maxBuffer:1024*1024});
  if(result.status!==0)return {availability:'unavailable',reason:'wpa-export-failed'};
  return {availability:'available',tables:(config.tables??[]).map(table=>{
    const file=resolve(out,table.file);if(relative(out,file).startsWith('..')||isAbsolute(relative(out,file)))throw Error('wpa-table-outside-output');
    artifactFile(root,file);if(statSync(file).size>128*1024*1024)throw Error('wpa-table-over-budget');
    return {name:table.name,...summarizeSystemRows(parseCsv(readFileSync(file)),table,config.ownedProcesses??[])};
  })};
}
