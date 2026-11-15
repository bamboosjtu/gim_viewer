// The catalog owns the initial user gesture/pointer lock. Each simulation has
// an isolated frame, so switching sites cannot retain an old rendering session.
const welcome=document.getElementById('catalog-welcome');
const back=document.getElementById('catalog-back');
const menuTitle=document.title;
let frame=null,session='',ready=false;
const owns=(caller,token)=>!!frame && caller===frame.contentWindow && token===session;
const locked=()=>document.pointerLockElement===document.body;
function post(kind,extra={}) {
  if(frame)frame.contentWindow.postMessage({type:'gim-host',session,kind,...extra},location.origin);
}
function release(){if(locked())document.exitPointerLock();}
async function request(){
  if(locked())return;
  if(!document.body.requestPointerLock)return;
  try{await document.body.requestPointerLock({unadjustedMovement:true});}
  catch{await document.body.requestPointerLock();}
}
function exit(){
  const old=frame;frame=null;session='';ready=false;
  release();old?.remove();document.body.classList.remove('playing');
  welcome.hidden=false;back.hidden=true;document.title=menuTitle;
}
window.gimLevelHost=Object.freeze({
  owns,
  isLocked:(caller,token)=>owns(caller,token)&&locked(),
  requestLock:(caller,token)=>owns(caller,token)?request():Promise.reject(Error('Inactive simulation')),
  releaseLock:(caller,token)=>{if(owns(caller,token))release()},
});
for(const card of document.querySelectorAll('[data-level]'))card.addEventListener('click',event=>{
  if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  event.preventDefault();if(frame)return;
  session=crypto.randomUUID();ready=false;
  frame=document.createElement('iframe');frame.id='simulation-frame';
  frame.title=card.querySelector('h2').textContent;
  frame.allow='autoplay; fullscreen';
  const url=new URL(card.href,location.href);url.searchParams.set('embedded','1');url.searchParams.set('session',session);
  frame.src=url.href;document.body.append(frame);
  welcome.hidden=true;back.hidden=false;document.body.classList.add('playing');
  // Acquire before asynchronous model loading consumes the click activation.
  request().catch(()=>{});
});
back.addEventListener('click',exit);
document.addEventListener('pointerlockchange',()=>post('lock',{locked:locked()}));
document.addEventListener('mousemove',event=>{
  if(ready&&locked())post('look',{dx:event.movementX,dy:event.movementY});
});
for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{
  if(!frame||event.ctrlKey||event.altKey||event.metaKey)return;
  if(event.code==='KeyQ'&&type==='keydown'){event.preventDefault();exit();return;}
  if(['Space','KeyW','KeyA','KeyS','KeyD','KeyE','KeyR','Home','KeyM','KeyH','KeyF','KeyL','ArrowUp','ArrowDown'].includes(event.code))event.preventDefault();
  post('key',{eventType:type,code:event.code,repeat:event.repeat});
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)release()});
window.addEventListener('message',event=>{
  const data=event.data;
  if(event.origin!==location.origin||!frame||event.source!==frame.contentWindow||data?.session!==session)return;
  if(data.type==='gim-ready'){
    ready=true;
    if(typeof data.title==='string')document.title=data.title;
    post('lock',{locked:locked()});
  }
  if(data.type==='gim-exit')exit();
});
