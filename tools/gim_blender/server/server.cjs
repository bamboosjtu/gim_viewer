#!/usr/bin/env node
'use strict';
// Independent static demo service: Node builtins only, no GUI or conversion code.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),API='/__gim_blender_service__',REVISION='20261116-cli-service-v1';
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function write(p,value){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p+'.staging',JSON.stringify(value,null,2));fs.renameSync(p+'.staging',p)}
function request(url,method='GET',body){return new Promise((resolve,reject)=>{const req=http.request(url,{method,timeout:700,headers:body?{'Content-Type':'application/json'}:{}},res=>{let data='';res.on('data',chunk=>{data+=chunk});res.on('end',()=>{try{if(res.statusCode!==200)throw Error('HTTP '+res.statusCode);resolve(JSON.parse(data))}catch(e){reject(e)}})});req.on('timeout',()=>req.destroy(Error('timeout')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined)})}
function ready(project){return project.version===1&&/^[a-f0-9]{64}$/.test(project.id)&&['ready','partial'].includes(project.status)}
function projectAt(data,id){
 if(!/^[a-f0-9]{64}$/.test(id))return null;const folder=path.join(data,'projects',id);
 try{if(fs.lstatSync(folder).isSymbolicLink())return null;const meta=read(path.join(folder,'project.json'));if(!ready(meta)||meta.id!==id)return null;
  const web=path.join(folder,'result/web');if(fs.lstatSync(path.join(folder,'result')).isSymbolicLink()||fs.lstatSync(web).isSymbolicLink()||!fs.existsSync(path.join(web,'assets/world.glb'))||!fs.existsSync(path.join(web,'assets/scene.json')))return null;return {meta,web};
 }catch{return null}
}
function catalog(data){
 const base=path.join(data,'projects');let names=[];try{names=fs.readdirSync(base)}catch{}
 const projects=names.map(id=>projectAt(data,id)).filter(Boolean),cards=projects.map(({meta})=>`<a class="card" href="/${meta.id}/index.html?catalog=1" data-level="${meta.id}"><span class="badge">变电站巡检</span>${meta.status==='partial'?'<span class="badge">部分表示</span>':''}<h2>${escape(meta.title)}</h2><p>从整站大门出发，第一人称巡视设备与建筑。</p><b>进入漫游 →</b></a>`).join('');
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GIM Blender · 工程选择</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/catalog.css"><main><small>GIM BLENDER / VIRTUAL INSPECTION</small><h1>走进一座<span>变电站</span></h1><p>选择工程后直接进入模拟。点击场景锁定鼠标，Esc 释放鼠标。</p><div class="controls">WASD 行走　鼠标 环顾　E 开关门　Space 跳跃　M 地图　R 返回大门　Q 工程选择</div><section>${cards||'<p>请先使用转换工具导入 GIM。</p>'}</section></main></html>`;
}
function safeFile(base,parts){
 if(parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')||p.includes(':')))return null;
 const target=path.resolve(base,...parts),prefix=path.resolve(base)+path.sep;
 try{if(!target.startsWith(prefix)||!fs.statSync(target).isFile())return null;const real=fs.realpathSync(target),realBase=fs.realpathSync(base)+path.sep;return real.startsWith(realBase)?target:null}catch{return null}
}
function openBrowser(url,browser='auto'){
 if(browser==='none')return;
 const chrome=[process.env.GIM_BLENDER_CHROME,path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Google/Chrome/Application/chrome.exe'),path.join(process.env.ProgramFiles||'C:/Program Files','Google/Chrome/Application/chrome.exe')].find(p=>p&&fs.existsSync(p));
 const executable=chrome||path.join(process.env.SystemRoot||'C:/Windows','explorer.exe');
 const child=spawn(executable,[url],{cwd:path.dirname(executable),stdio:'ignore',detached:true,windowsHide:false});
 child.once('error',e=>console.error('浏览器未打开，请复制地址到 Chrome：',url,e.message));child.unref();
 console.log('浏览器打开请求：',url);
}
async function existing(statusFile,data){
 try{const saved=read(statusFile);if(saved.version!==1||path.resolve(saved.data)!==data)return null;const current=await request(saved.url+API.slice(1));return current.instance===saved.instance&&current.pid===saved.pid?saved:null}catch{return null}
}
async function start(options){
 const data=path.resolve(options.data),runtime=path.resolve(options.runtime),statusFile=path.join(data,'service/server.json');
 const prior=await existing(statusFile,data);
 if(prior){console.log('复用独立服务：'+prior.url+'（端口 '+prior.port+'，PID '+prior.pid+'）');if(options.open)openBrowser(prior.url,options.browser);return prior}
 if(!fs.existsSync(path.join(runtime,'index.html')))throw Error('Demo runtime missing: '+runtime);
 const instance=crypto.randomUUID(),token=crypto.randomBytes(24).toString('hex');let info;
 const respond=(res,status,body,type='text/plain; charset=utf-8',head=false)=>{const bytes=Buffer.from(body);res.writeHead(status,{'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':'no-cache'});res.end(head?undefined:bytes)};
 const server=http.createServer((req,res)=>{
  let route;try{route=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{respond(res,400,'Bad path');return}
  if(route===API){
   if(req.method==='GET'){respond(res,200,JSON.stringify({version:1,revision:REVISION,instance,pid:process.pid,port:info.port,url:info.url}), 'application/json');return}
   if(req.method==='POST'){let bytes='';req.on('data',chunk=>{bytes+=chunk;if(bytes.length>1024)req.destroy()});req.on('end',()=>{try{if(JSON.parse(bytes).token!==token){respond(res,403,'Denied');return}respond(res,200,'{"stopping":true}','application/json');server.close()}catch{respond(res,400,'Bad request')}});return}
   respond(res,405,'Method not allowed');return;
  }
  if(!['GET','HEAD'].includes(req.method)){respond(res,405,'Method not allowed');return}
  const head=req.method==='HEAD';
  if(route==='/'||route==='/index.html'){respond(res,200,catalog(data),'text/html; charset=utf-8',head);return}
  if(route==='/catalog.css'){const file=path.join(__dirname,'catalog.css');respond(res,200,fs.readFileSync(file),'text/css',head);return}
  const parts=route.split('/').slice(1),id=parts.shift(),project=projectAt(data,id);if(!project){respond(res,404,'Not found');return}
  const base=parts[0]==='assets'?project.web:runtime;
  const file=safeFile(base,parts);if(!file){respond(res,404,'Not found');return}
  const type=({'.js':'application/javascript','.html':'text/html; charset=utf-8','.json':'application/json','.css':'text/css','.wasm':'application/wasm','.glb':'model/gltf-binary'})[path.extname(file)]||'application/octet-stream';
  const size=fs.statSync(file).size;res.writeHead(200,{'Content-Type':type,'Content-Length':size,'Cache-Control':'no-cache'});
  if(head){res.end();return}const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
 });
 const requested=Number(options.port??8765);if(!Number.isInteger(requested)||requested<0||requested>65535)throw Error('Invalid port');
 let port=requested;
 for(let attempt=0;attempt<30;attempt++){
  try{await new Promise((resolve,reject)=>{const error=e=>{server.removeListener('listening',listen);reject(e)},listen=()=>{server.removeListener('error',error);resolve()};server.once('error',error);server.once('listening',listen);server.listen(port,'127.0.0.1')});break}
  catch(error){if(error.code!=='EADDRINUSE'||requested===0||attempt===29)throw error;port++;}
 }
 port=server.address().port;info={version:1,revision:REVISION,instance,token,pid:process.pid,port,url:'http://127.0.0.1:'+port+'/',data};write(statusFile,info);
 console.log('GIM Blender 独立 HTML 服务');console.log('端口：'+port);console.log('地址：'+info.url);console.log('PID：'+process.pid);console.log('关闭转换工具不会停止本服务。命令行按 Ctrl+C 或运行 stop_demo.cmd 停止。');
 server.on('close',()=>{try{if(read(statusFile).instance===instance)fs.unlinkSync(statusFile)}catch{}});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
 if(options.open)openBrowser(info.url,options.browser);return info;
}
async function main(){
 const args=process.argv.slice(2),options={data:path.join(ROOT,'data'),runtime:path.join(ROOT,'demo'),port:8765,browser:'auto'};
 for(let i=0;i<args.length;i++){const arg=args[i];if(['--data','--runtime','--port','--browser'].includes(arg))options[arg.slice(2)]=args[++i];else if(arg==='--open')options.open=true;else if(arg==='--stop')options.stop=true;else throw Error('Unknown option: '+arg)}
 if(options.stop){const file=path.join(path.resolve(options.data),'service/server.json'),info=await existing(file,path.resolve(options.data));if(!info){console.log('没有运行中的独立服务');return}await request(info.url+API.slice(1),'POST',{token:info.token});console.log('已停止服务：'+info.url);return}
 await start(options);
}
module.exports={catalog,safeFile,projectAt,ready,start,existing,REVISION};
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
