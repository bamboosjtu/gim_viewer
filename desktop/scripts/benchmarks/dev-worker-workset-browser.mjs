/** Paired runs use the same Worker implementation. The baseline client is an
 * exact Git snapshot with only relative module/Worker URLs relocated. */
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [sample,mode]=process.argv.slice(2);
if(!/^substation0[1-4]$/.test(sample)||!['baseline','candidate'].includes(mode))throw Error('Usage: node dev-worker-workset-browser.mjs substation01 baseline|candidate');
const out=resolve('../output/memory-workset'),origin='http://127.0.0.1:14317',baselineCommit='93b2f2c';
mkdirSync(resolve('.tmp'),{recursive:true});
const baseline=execFileSync('git',['show',`${baselineCommit}:desktop/src/services/devGeometryWorkerClient.ts`],{encoding:'utf8',windowsHide:true});
const relocated=baseline.replaceAll("from '../","from '../src/").replaceAll("from './","from '../src/services/")
  .replace("new URL('./devGeometryWorker.ts'","new URL('../src/services/devGeometryWorker.ts'");
writeFileSync(resolve('.tmp/dev-worker-workset-baseline.ts'),relocated);
const manifest=JSON.parse(readFileSync(join(out,`${sample}-input.json`),'utf8'));
const rows=manifest.sources.map(row=>({path:Buffer.from(row.path),bytes:readFileSync(resolve('../demo',manifest.directory,row.path))}));
const payload=Buffer.alloc(9+rows.reduce((n,row)=>n+13+row.path.length+row.bytes.length,0));
if(payload.length>256*1024*1024)throw Error('Research source pack exceeds 256 MiB');
payload.write('GIMR');payload[4]=1;payload.writeUInt32LE(rows.length,5);let offset=9;
for(const row of rows){payload.writeUInt32LE(row.path.length,offset);offset+=4;row.path.copy(payload,offset);offset+=row.path.length;
  payload[offset++]=1;payload.writeBigUInt64LE(BigInt(row.bytes.length),offset);offset+=8;row.bytes.copy(payload,offset);offset+=row.bytes.length;}
const server=createServer((req,res)=>{
  if(req.headers.origin!==origin){res.writeHead(404).end();return;}
  const bytes=req.url==='/manifest'?Buffer.from(JSON.stringify(manifest)):req.url==='/sources'?payload:null;
  if(!bytes){res.writeHead(404).end();return;}
  res.writeHead(200,{'Access-Control-Allow-Origin':origin,'Content-Type':'application/octet-stream','Cache-Control':'no-store'}).end(bytes);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const source=`http://127.0.0.1:${server.address().port}`,runId=new Date().toISOString().replaceAll(/[:.]/g,'-');
const profile=join(out,`${sample}-${mode}-${runId}`);mkdirSync(profile);
const child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
  '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--disable-background-timer-throttling',
  '--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  let port;for(let i=0;i<100;i++){if(existsSync(join(profile,'DevToolsActivePort'))){port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);break;}await delay(200);}
  if(!port)throw Error('Owned browser startup timed out');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(row=>row.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let serial=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data),row=pending.get(message.id);if(!row)return;
    pending.delete(message.id);clearTimeout(row.timer);message.error?row.reject(Error(JSON.stringify(message.error))):row.resolve(message.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timed out: ${method}`));},180000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};
  await send('Page.navigate',{url:`${origin}/scripts/benchmarks/dev-worker-workset.html`});
  let ready=false;for(let i=0;i<150;i++){if(await evaluate('typeof globalThis.startWorkerWorkset')==='function'){ready=true;break;}await delay(200);}
  if(!ready)throw Error('Research page modules failed to load');
  const prepared=await evaluate(`startWorkerWorkset(${JSON.stringify({source,sample,mode})})`);
  const result={sample,mode,baselineCommit,baselineSha:createHash('sha256').update(baseline).digest('hex'),prepared,
    clientSha:createHash('sha256').update(readFileSync('src/services/devGeometryWorkerClient.ts')).digest('hex'),
    workerSha:createHash('sha256').update(readFileSync('src/services/devGeometryWorker.ts')).digest('hex'),
    workload:'one-resume-then-two-concurrent; ten pool create/cancel cycles',
    scope:'Headless Edge CPU DEV pool with real source Files; PrivateUsage process tree; no Tauri, IFC rendering or GPU VRAM',before:[],after:[]};
  const checkpoint=()=>{
    const unavailableAttempts=[];
    for(let attempt=0;attempt<3;attempt++){
      const memory=JSON.parse(execFileSync('python',['scripts/benchmarks/process-private-memory.py',String(child.pid)],{windowsHide:true,encoding:'utf8'}));
      if(memory.available)return {...memory,unavailableAttempts};
      unavailableAttempts.push(memory); // A process may exit during Toolhelp enumeration. Never count it as zero.
    }
    throw Error(`Private memory query unavailable: ${JSON.stringify(unavailableAttempts)}`);
  };
  const idleStart=Date.now();
  for(let i=0;i<3;i++){result.before.push({memory:checkpoint(),state:await evaluate('workerWorkset.snapshot()')});await delay(2000);}
  console.log(JSON.stringify({sample,mode,phase:'prepared',workers:prepared.liveWorkers,roots:prepared.roots,cohort:prepared.cohort,privateBytes:result.before.map(row=>row.memory.privateBytes)}));
  await delay(Math.max(0,45000-(Date.now()-idleStart)));
  result.verified=await evaluate('workerWorkset.verify()');
  for(let i=0;i<3;i++){result.after.push({memory:checkpoint(),state:await evaluate('workerWorkset.snapshot()')});await delay(2000);}
  result.resume=await evaluate('workerWorkset.resume()');
  result.cycles=[];
  for(let i=0;i<10;i++)result.cycles.push({cycle:i+1,...await evaluate('workerWorkset.cycle()'),memory:checkpoint()});
  result.closed=await evaluate('workerWorkset.close()');
  if(result.closed.liveWorkers||result.closed.templates||result.closed.placements)throw Error('Owned resources did not close');
  writeFileSync(join(out,`${sample}-${mode}-${runId}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify({sample,mode,phase:'complete',workers:result.after.map(row=>row.state.liveWorkers),privateBytes:result.after.map(row=>row.memory.privateBytes),resume:result.resume.requests,closed:result.closed}));
}finally{
  socket?.close();
  if(child.pid&&child.exitCode==null){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{/* Already exited. */}}
  await new Promise(resolve=>server.close(resolve));
}
