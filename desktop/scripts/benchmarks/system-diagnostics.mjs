import {spawn,spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {artifactFile} from './batch-input.mjs';
const sourceHelper=fileURLToPath(new URL('./system-collector.ps1',import.meta.url));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const ps=value=>"'"+String(value).replaceAll("'","''")+"'";
export function systemCapabilities(){
  if(process.platform!=='win32')return {availability:'unsupported',reason:'windows-required'};
  const probe=arg=>spawnSync('wpr.exe',[arg],{windowsHide:true,encoding:'utf8',timeout:5000});
  const sources=probe('-pmcsources'),profiles=probe('-profiles');
  const exporter=spawnSync('where.exe',['WPAExporter.exe'],{windowsHide:true,encoding:'utf8',timeout:2000});
  return {availability:profiles.status===0?'available':'unavailable',wpr:profiles.status===0,
    wpaExporter:exporter.status===0?exporter.stdout.trim().split(/\r?\n/)[0]:null,
    pmcSources:sources.status===0?sources.stdout.split(/\r?\n/).map(s=>s.match(/^\s*\d+\s+(\w+)\s+/)?.[1]).filter(Boolean):[],
    permission:'capture-requires-elevated-helper',actualCaptureVerified:false};
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
  constructor(root,out,config,build){this.root=root;this.out=out;this.config=config;this.build=build;}
  async start(){
    const c=this.config;
    const helper=this.build.manifestPath?join(this.build.manifestPath,'..','system-collector.ps1'):sourceHelper;
    if(!this.build.systemCollectorSha256||!existsSync(helper)||hash(helper)!==this.build.systemCollectorSha256)throw Error('system-collector-build-attestation-missing');
    if(!Number.isFinite(c.durationMs)||c.durationMs<1||c.durationMs>30000||
      !Number.isSafeInteger(c.bufferMiB)||c.bufferMiB<8||c.bufferMiB>256)throw Error('system-window-and-buffer-budget-required');
    const capabilities=systemCapabilities();this.result={capabilities,status:'not-started'};
    if(!capabilities.wpr){this.result.status='unsupported';return;}
    const folder=join(this.out,'system');mkdirSync(folder,{recursive:true});
    const instance='gim-'+randomBytes(12).toString('hex'),pmc=c.pmc??[];
    if(pmc.length>3||pmc.some(name=>!capabilities.pmcSources.includes(name)))throw Error('unsupported-pmc-selection');
    const hardware=pmc.length?'<HardwareCounter Id="PMC"><SampledCounters>'+pmc.map(name=>'<SampledCounter Value="'+name+'"/>').join('')+'</SampledCounters></HardwareCounter>':'';
    const wprp=join(folder,'capture.wprp');
    writeFileSync(wprp,'<?xml version="1.0" encoding="utf-8"?><WindowsPerformanceRecorder Version="1.0"><Profiles>'+
      '<SystemCollector Id="SC" Name="'+instance+'"><BufferSize Value="1024"/><Buffers Value="'+c.bufferMiB+'"/></SystemCollector>'+
      '<SystemProvider Id="SP"><Keywords>'+['ProcessThread','Loader','SampledProfile','CSwitch','DiskIO','DiskIOInit','FileIO','FileIOInit',...(pmc.length?['PmcProfile']:[])].map(k=>'<Keyword Value="'+k+'"/>').join('')+
      '</Keywords><Stacks><Stack Value="SampledProfile"/></Stacks></SystemProvider>'+hardware+
      '<Profile Id="GIM.Verbose.Memory" Name="GIM" Description="Bounded GIM diagnostic" LoggingMode="Memory" DetailLevel="Verbose"><Collectors><SystemCollectorId Value="SC"><SystemProviderId Value="SP"/>'+
      (pmc.length?'<HardwareCounterId Value="PMC"/>':'')+'</SystemCollectorId></Collectors></Profile></Profiles></WindowsPerformanceRecorder>');
    const plan={root:this.root,out:folder,instance,durationMs:c.durationMs,profile:wprp,profileSha256:hash(wprp),
      helperSha256:hash(helper),buildFingerprint:this.build.sourceFingerprint,executableSha256:this.build.executableSha256,
      controllerPid:process.pid,controllerStartedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),buildManifest:this.build.manifestPath,gpu:c.gpu===true,nonce:randomBytes(24).toString('hex')};
    const planFile=artifactFile(this.root,join(folder,'plan.private.json'));writeFileSync(planFile,JSON.stringify(plan));
    const inner='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+helper+'" -Plan "'+planFile+'"';
    const command='Start-Process -WindowStyle Hidden -Verb RunAs -FilePath powershell.exe -ArgumentList '+ps(inner);
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{this.result.status='unavailable';this.result.reason='elevation-launch-failed';});
    this.result={...this.result,status:'starting',instance,privatePlan:planFile,clockId:'system-controller',requestedAtMs:performance.now()};
    this.folder=folder;
    this.lease=setInterval(()=>writeFileSync(join(folder,'lease'),String(Date.now())),500);
    // Capture must be live before the product process starts.
    const deadline=performance.now()+15000;
    while(performance.now()<deadline&&!existsSync(join(folder,'started.private.json'))&&!existsSync(join(folder,'finished.private.json')))
      await new Promise(r=>setTimeout(r,100));
    this.result.status=existsSync(join(folder,'started.private.json'))?'collecting':'unavailable';
    if(this.result.status==='unavailable')this.result.reason='elevation-denied-or-wpr-start-failed';
  }
  async stop(){
    clearInterval(this.lease);if(!this.folder)return this.result;
    writeFileSync(join(this.folder,'stop.request'),'stop');
    const finish=join(this.folder,'finished.private.json'),deadline=performance.now()+15000;
    while(!existsSync(finish)&&performance.now()<deadline)await new Promise(r=>setTimeout(r,100));
    if(existsSync(finish))Object.assign(this.result,JSON.parse(readFileSync(finish,'utf8').replace(/^\uFEFF/,'')));
    else Object.assign(this.result,{status:'incomplete',reason:'system-stop-unconfirmed'});
    this.result.endedAtMs=performance.now();return this.result;
  }
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
