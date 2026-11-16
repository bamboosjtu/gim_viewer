const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const service=require('./server.cjs');
async function main(){
 const work=path.resolve(process.argv[2]),data=path.join(work,'data'),runtime=path.resolve(__dirname,'../assets/web'),id='a'.repeat(64),project=path.join(data,'projects',id),web=path.join(project,'result/web');
 fs.mkdirSync(path.join(web,'assets'),{recursive:true});fs.writeFileSync(path.join(project,'project.json'),JSON.stringify({version:1,id,status:'ready',title:'<img src=x>'}));
 for(const name of ['scene.json','world.glb'])fs.writeFileSync(path.join(web,'assets',name),'ordinary serving DTO');
 assert(service.catalog(data).includes('&lt;img'));assert(!service.catalog(data).includes('<iframe'));assert(!service.catalog(data).includes('<script'));
 assert.equal(service.safeFile(web,['..','source.gim']),null);
 const occupied=http.createServer((req,res)=>res.end('unrelated'));await new Promise(r=>occupied.listen(0,'127.0.0.1',r));const base=occupied.address().port;
 const script=path.join(__dirname,'server.cjs'),log=fs.openSync(path.join(work,'node.log'),'a');
 const p=spawn(process.execPath,[script,'--data',data,'--runtime',runtime,'--port',String(base),'--browser','none'],{stdio:['ignore',log,log],windowsHide:true});
 let info;
 try{
  for(let i=0;i<100;i++){try{info=JSON.parse(fs.readFileSync(path.join(data,'service/server.json'),'utf8'));break}catch{}await new Promise(r=>setTimeout(r,50))}
  assert(info);assert.equal(info.port,base+1);assert.equal(info.pid,p.pid);
  const printed=fs.readFileSync(path.join(work,'node.log'),'utf8');assert(printed.includes('端口：'+info.port));assert(printed.includes('地址：'+info.url));
  const html=await(await fetch(info.url)).text();assert(html.includes('catalog=1'));assert(!html.includes('iframe'));
  const page=await(await fetch(info.url+id+'/index.html?catalog=1')).text();assert(page.includes('level-back'));
  assert.equal(await(await fetch(info.url+id+'/assets/world.glb')).text(),'ordinary serving DTO');
  for(const route of [id+'/source.gim',id+'/assets/%2e%2e/%2e%2e/source.gim','data/projects/'])assert.equal((await fetch(info.url+route)).status,404);
  const second=spawn(process.execPath,[script,'--data',data,'--runtime',runtime,'--port',String(base),'--browser','none'],{stdio:'ignore',windowsHide:true});assert.equal(await new Promise(r=>second.on('exit',r)),0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'service/server.json'))).pid,p.pid);
  const stop=spawn(process.execPath,[script,'--data',data,'--stop'],{stdio:'ignore',windowsHide:true});assert.equal(await new Promise(r=>stop.on('exit',r)),0);
  await new Promise(r=>p.on('exit',r));console.log(JSON.stringify({passed:true,cases:['independent CLI','port collision','printed persistent address','direct navigation','web-only boundary','reuse running service','explicit stop']}));
 }finally{if(p.exitCode===null)p.kill();await new Promise(r=>occupied.close(r));fs.closeSync(log)}
}
main().catch(e=>{console.error(e);process.exitCode=1});
