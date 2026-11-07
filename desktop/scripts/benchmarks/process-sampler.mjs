import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export function startProcessSampler(executable,ownedChild,ownedExecutable,env,emit){
  const child=spawn(executable,[String(ownedChild.pid),ownedExecutable],{env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  let ended=false;let failures=0,sequence=0;const pending=new Map();
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{const row=JSON.parse(line);const item={...row,controllerReceivedMs:performance.now(),clockId:'native-sampler'};emit(item);const waiter=pending.get(row.checkpoint);if(waiter){clearTimeout(waiter.timer);pending.delete(row.checkpoint);waiter.resolve(item);}}catch{failures++;}});
  child.on('error',()=>{failures++;});
  child.stdin.on('error',()=>{failures++;});
  const completion=new Promise(resolve=>child.once('close',()=>{ended=true;lines.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('native-sampler-ended'));}pending.clear();resolve();}));
  return {checkpoint(name){if(ended||child.stdin.destroyed)return Promise.reject(Error('native-sampler-unavailable'));
      return new Promise((resolve,reject)=>{const key=`${++sequence}:${name}`,timer=setTimeout(()=>{pending.delete(key);failures++;reject(Error('native-sampler-checkpoint-timeout'));},5000);pending.set(key,{resolve,reject,timer});child.stdin.write(key+'\n');});},
    async stop(){if(!ended&&!child.stdin.destroyed)child.stdin.end('stop\n');const timer=setTimeout(()=>{if(!ended)child.kill();},3000);await completion;clearTimeout(timer);return {failures};}};
}
