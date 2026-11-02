/** Own headless Edge/profile and loopback Vite only; never attaches to user tabs. */
import {spawn,execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

const edge=process.argv[2]??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port=Number(process.argv[3]??14357),origin=`http://127.0.0.1:${port}`;
const out=resolve('../output/engineering-worker'),stamp=new Date().toISOString().replaceAll(/[:.]/g,'-'),profile=join(out,`profile-${stamp}`);
mkdirSync(profile,{recursive:true});
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,socket;const pending=new Map();
try{
  let ready=false;
  for(let i=0;i<100;i++){
    if(vite.exitCode!==null)throw Error(`Owned Vite exited: ${vite.exitCode}`);
    try {const r=await fetch(`${origin}/scripts/engineering/worker-check.html`);if(r.ok){ready=true;break;}}catch{}
    await delay(100);
  }
  if(!ready)throw Error('Owned Vite did not become ready');
  browser=spawn(edge,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
  let debugPort;
  for(let i=0;i<100;i++){
    if(existsSync(join(profile,'DevToolsActivePort'))){debugPort=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);break;}
    await delay(100);
  }
  if(!debugPort)throw Error('Owned Edge did not become ready');
  const targets=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket=new WebSocket(targets.find(row=>row.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let serial=0;
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data),request=pending.get(message.id);if(!request)return;
    pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(Error(JSON.stringify(message.error))):request.resolve(message.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},30000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  await send('Page.navigate',{url:`${origin}/scripts/engineering/worker-check.html`});
  ready=false;
  for(let i=0;i<150;i++){const r=await send('Runtime.evaluate',{expression:'typeof globalThis.runEngineeringWorkerCheck',returnByValue:true});
    if(r.result?.value==='function'){ready=true;break;}await delay(100);}
  if(!ready)throw Error('Engineering browser modules did not load');
  const result=await send('Runtime.evaluate',{expression:'globalThis.runEngineeringWorkerCheck()',awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  if(result.result?.value?.passed!==true)throw Error('Engineering Worker check failed');
  writeFileSync(join(out,'result.json'),JSON.stringify(result.result.value,null,2));
  console.log(JSON.stringify(result.result.value,null,2));
}finally{
  for(const request of pending.values())clearTimeout(request.timer);socket?.close();
  for(const child of [browser,vite])if(child?.pid&&child.exitCode===null){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
}
