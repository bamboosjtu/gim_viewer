/** Starts only its own headless Edge/profile and loopback fixture server.
 * Requires Vite on 127.0.0.1:14317 and the adjacent sample benchmark outputs. */
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const out=resolve('../output/parse-reuse'), origin='http://127.0.0.1:14317';
const edge=process.argv[2]??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const runId=new Date().toISOString().replaceAll(/[:.]/g,'-'), profile=join(out,`edge-${runId}`);
mkdirSync(profile,{recursive:true});
const payloads=new Map();
for(const sample of ['substation01','substation02','substation03','substation04']){
  const manifest=JSON.parse(readFileSync(join(out,`${sample}-decode.json`),'utf8'));
  const rows=manifest.manifest.map((row,i)=>({path:Buffer.from(`templates/${row.key}`),bytes:readFileSync(join(out,sample,`${i}.cache`))}));
  const buffer=Buffer.alloc(57+rows.reduce((n,row)=>n+13+row.path.length+row.bytes.length,0));
  buffer.write('GIMR');buffer[4]=2;buffer.writeUInt32LE(rows.length,5);
  buffer.writeBigUInt64LE(BigInt(rows.reduce((n,row)=>n+row.bytes.length,0)),41);buffer.writeUInt32LE(rows.length,49);
  let offset=57;
  for(const row of rows){buffer.writeUInt32LE(row.path.length,offset);offset+=4;row.path.copy(buffer,offset);offset+=row.path.length;
    buffer[offset++]=1;buffer.writeBigUInt64LE(BigInt(row.bytes.length),offset);offset+=8;row.bytes.copy(buffer,offset);offset+=row.bytes.length;}
  payloads.set(`/${sample}`,buffer);
}
const server=createServer((req,res)=>{
  const bytes=payloads.get(req.url);
  if(req.headers.origin!==origin||!bytes){res.writeHead(404).end();return;}
  res.writeHead(200,{'Access-Control-Allow-Origin':origin,'Content-Type':'application/octet-stream','Cache-Control':'no-store'}).end(bytes);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const source=`http://127.0.0.1:${server.address().port}`;
const child=spawn(edge,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  let port;
  for(let i=0;i<100;i++){if(existsSync(join(profile,'DevToolsActivePort'))){port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);break;}await delay(200);}
  if(!port)throw Error('Owned Edge CDP startup timed out');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(row=>row.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let serial=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data),row=pending.get(message.id);if(!row)return;
    pending.delete(message.id);clearTimeout(row.timer);message.error?row.reject(Error(JSON.stringify(message.error))):row.resolve(message.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timed out: ${method}`));},120000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  await send('Page.navigate',{url:`${origin}/scripts/benchmarks/dev-cache-decode.html`});
  let ready=false;
  for(let i=0;i<150;i++){const result=await send('Runtime.evaluate',{expression:'typeof globalThis.runCacheDecodeCheck',returnByValue:true});
    if(result.result?.value==='function'){ready=true;break;}await delay(200);}
  if(!ready)throw Error('Benchmark modules did not load');
  const result=await send('Runtime.evaluate',{expression:`globalThis.runCacheDecodeCheck(${JSON.stringify(source)})`,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  writeFileSync(join(out,`browser-${runId}.json`),JSON.stringify(result.result.value,null,2));
  console.log(JSON.stringify({...result.result.value,results:result.result.value.results.map(({baseline,candidate,...row})=>row)},null,2));
}finally{
  socket?.close();
  if(child.pid&&child.exitCode==null){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{/* Already exited. */}}
  await new Promise(resolve=>server.close(resolve));
}
