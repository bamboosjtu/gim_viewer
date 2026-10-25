/** Owned browser, identical real artifacts/placements, alternating modes in one scene. */
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [sample]=process.argv.slice(2);
if(!/^substation0[1-4]$/.test(sample))throw Error('Usage: node static-container-browser.mjs substation01');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const input=JSON.parse(readFileSync(resolve('../output/memory-workset',`${sample}-input.json`),'utf8'));
const cache=JSON.parse(readFileSync(resolve('../output/parse-reuse',`${sample}-decode.json`),'utf8'));
if(input.sha!==cache.sourceSha||hash(readFileSync(resolve('../demo',`${sample}.gim`)))!==input.sha||
  readFileSync(resolve('../demo',input.directory,'.gim-source.sha256'),'utf8').trim()!==input.sha)throw Error('Sample identity mismatch');
const artifacts=cache.manifest.map((row,i)=>({...row,bytes:readFileSync(resolve('../output/parse-reuse',sample,`${i}.cache`))}));
const manifest={sample,sha:input.sha,instances:input.instances,artifacts:artifacts.map(({bytes,...row})=>({...row,artifactSha:hash(bytes)}))};
const origin='http://127.0.0.1:14317',out=resolve('../output/static-container');mkdirSync(out,{recursive:true});
const server=createServer((req,res)=>{
  if(req.headers.origin!==origin){res.writeHead(404).end();return;}
  const match=/^\/artifact\/(\d+)$/.exec(req.url);
  const bytes=req.url==='/manifest'?Buffer.from(JSON.stringify(manifest)):match?artifacts[Number(match[1])]?.bytes:null;
  if(!bytes){res.writeHead(404).end();return;}
  res.writeHead(200,{'Access-Control-Allow-Origin':origin,'Content-Type':'application/octet-stream','Cache-Control':'no-store'}).end(bytes);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const source=`http://127.0.0.1:${server.address().port}`,id=new Date().toISOString().replaceAll(/[:.]/g,'-');
const profile=join(out,`${sample}-${id}`);mkdirSync(profile);
const child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
  '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--disable-background-timer-throttling',
  '--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
  await send('Page.navigate',{url:`${origin}/scripts/benchmarks/static-container.html`});
  let ready=false;for(let i=0;i<150;i++){if(await evaluate('typeof globalThis.startStaticContainerCheck')==='function'){ready=true;break;}await delay(200);}
  if(!ready)throw Error('Research page failed to load');
  const prepared=await evaluate(`startStaticContainerCheck(${JSON.stringify(source)})`);
  console.log(JSON.stringify({sample,phase:'verified',graphics:prepared.graphics,display:prepared.baseline.display,
    baselineProducts:prepared.baseline.worldProducts,candidateProducts:prepared.candidate.worldProducts}));
  const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:960,height:640,scale:1}});
  writeFileSync(join(out,`${sample}-${id}.png`),Buffer.from(screenshot.data,'base64'));
  const rounds=[];for(let i=0;i<3;i++){const round=await evaluate(`staticContainerCheck.measure(${i})`);rounds.push(round);console.log(JSON.stringify({sample,...round.summary}));}
  const files=['src/viewer/staticContainer.ts','src/viewer/viewerEngine.ts','src/services/modAutoLoadService.ts','src/services/nodeInteractionService.ts',
    'scripts/benchmarks/static-container.html','scripts/benchmarks/static-container-browser.mjs'];
  const result={sample,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
    sourceHashes:Object.fromEntries(files.map(file=>[file,hash(readFileSync(file))])),prepared,rounds,
    scope:'Real L0 cohort and CBM placements, identity project anchor, headless WebGL; paired CPU submission with gl.finish outside timing; no IFC/Tauri/full station acceptance'};
  result.closed=await evaluate('staticContainerCheck.close()');
  if(result.closed.placements||result.closed.templates)throw Error('Owned scene resources did not close');
  writeFileSync(join(out,`${sample}-${id}.json`),JSON.stringify(result,null,2));
}finally{
  socket?.close();if(child.pid&&child.exitCode==null){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{/* Already exited. */}}
  await new Promise(resolve=>server.close(resolve));
}
