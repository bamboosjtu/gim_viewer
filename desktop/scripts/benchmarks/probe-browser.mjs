/** Protocol smoke check in an owned browser. Never a native performance baseline. */
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CdpConnection,WorkerHeapSampler} from './cdp.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),desktop=join(root,'desktop');
const out=join(root,'tmp','gim-bench',`protocol-${Date.now()}`);mkdirSync(out,{recursive:true});
const env={...process.env,TEMP:out,TMP:out,TMPDIR:out,VITE_GIM_BENCHMARK:'1',VITE_GIM_DIAGNOSTICS:'1'};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const vite=spawn(process.execPath,[join(desktop,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','14359','--strictPort'],{cwd:desktop,env,windowsHide:true,stdio:'ignore'});
let browser,cdp,sampler;const rows=[];let error=null,result=null;
try{
  let ready=false;for(let i=0;i<100;i++){if(vite.exitCode!==null)throw Error('owned-vite-failed');try{if((await fetch('http://127.0.0.1:14359/',{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await delay(100);}
  if(!ready)throw Error('owned-vite-timeout');
  const executable=process.argv[2]??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser=spawn(executable,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${out}`,'--no-first-run','--no-default-browser-check','about:blank'],{env,windowsHide:true,stdio:'ignore'});
  browser.on('error',()=>{error='browser-start-failed';});
  const portFile=join(out,'DevToolsActivePort');for(let i=0;i<100&&!existsSync(portFile)&&!error;i++)await delay(100);
  if(!existsSync(portFile))throw Error('browser-cdp-unavailable');
  const port=Number(readFileSync(portFile,'utf8').split('\n')[0]),targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp=await CdpConnection.connect(targets.find(t=>t.type==='page').webSocketDebuggerUrl,port);
  sampler=new WorkerHeapSampler(cdp,row=>rows.push(row));await sampler.start();
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:14359/'});
  ready=false;for(let i=0;i<100;i++){if(await cdp.evaluate('typeof globalThis.__gimBenchmark')==='object'){ready=true;break;}await delay(100);}
  if(!ready)throw Error('browser-probe-api-unavailable');
  await cdp.evaluate('globalThis.__gimBenchmark.capabilityProbe()');await delay(3500);
  result=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');await cdp.evaluate('globalThis.__gimBenchmark.endCapabilityProbe()');
}catch(cause){error=cause.message;}
finally{
  sampler?.stop();cdp?.close();
  for(const child of [browser,vite])if(child?.pid&&child.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
}
const report={kind:'browser-protocol-check',nativeBaseline:false,outcome:!error&&rows.some(r=>r.availability==='available'&&r.workerId?.includes('measurement-probe'))&&result?.measurement?.detailComplete?'PASS':'INCONCLUSIVE',error,
  sampling:sampler?.snapshot()??null,rows,measurement:result?.measurement??null};
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({outcome:report.outcome,error,report:join(out,'report.json')}));process.exitCode=report.outcome==='PASS'?0:2;
