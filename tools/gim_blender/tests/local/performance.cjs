// Explicit local performance investigation; serves only caller-staged tmp/ data.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const quantile=(a,q)=>{a=[...a].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(a.length*q))]||0};
async function main(){
 const work=path.resolve(process.argv[2]),variants=(process.argv[3]||'tool-before,research,research-runtime').split(','),out=path.join(work,'measurements');fs.mkdirSync(out,{recursive:true});
 const server=http.createServer((req,res)=>{const route=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(work,'variants','.'+route);if(!file.startsWith(path.join(work,'variants')+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'application/javascript','.json':'application/json','.wasm':'application/wasm','.css':'text/css'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const root='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',headless:process.env.GIM_PERF_HEADED!=='1',args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-webgl']});
 try{
  const system=await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo');
  fs.writeFileSync(path.join(out,'gpu.json'),JSON.stringify({version:browser.version(),gpu:system.gpu},null,2));
  for(const variant of variants){
   const page=await browser.newPage({viewport:{width:Number(process.env.GIM_PERF_WIDTH||1280),height:Number(process.env.GIM_PERF_HEIGHT||720)},deviceScaleFactor:Number(process.env.GIM_PERF_DPR||1)});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>{
    window.__perf={record:false,frames:[],cpu:[],calls:{}};const original=requestAnimationFrame;
    window.requestAnimationFrame=cb=>original(time=>{const p=window.__perf,begin=performance.now();if(p.record&&cb.name==='animate'){if(p.last)p.frames.push(time-p.last);p.last=time}cb(time);if(p.record&&cb.name==='animate')p.cpu.push(performance.now()-begin)});
   });
   const t0=Date.now();await page.goto(root+'/'+variant+'/index.html?nolock=1');let target=page;
   if(variant.endsWith('-host')){await page.click('[data-level]');target=await (await page.waitForSelector('#simulation-frame')).contentFrame();}
   await target.waitForFunction(()=>window.__tour?.ready,null,{timeout:180000});await target.click('#scene');
   const readyMs=Date.now()-t0;
   const scene=await target.evaluate(()=>{
    const t=window.__tour,g=t.renderer.getContext(),ext=g.getExtension('WEBGL_debug_renderer_info');let meshes=0;t.scene.traverse(o=>{if(o.isMesh)meshes++});
    const instrument=(object,key,label)=>{if(!object?.[key])return;const fn=object[key];object[key]=function(...args){const start=performance.now();try{return fn.apply(this,args)}finally{const p=window.__perf;if(p.record){const c=p.calls[label]??={count:0,ms:0};c.count++;c.ms+=performance.now()-start}}}};
    instrument(t.renderer,'render','render');instrument(t.hud,'update','hud');instrument(t.nav,'blocked','blocked');instrument(t.nav,'floorAtFootprint','floorFootprint');instrument(t.nav.equipment,'floorAt','equipmentFloor');
    return {sha:t.sceneData.projectInfo?.sourceSha256,counts:t.sceneData.counts,meshes,renderer:ext?g.getParameter(ext.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER),width:t.renderer.domElement.width,height:t.renderer.domElement.height,pixelRatio:t.renderer.getPixelRatio(),home:t.sceneData.home||t.sceneData.start};
   });
   const rows=[];
   for(const phase of ['standing','walking','turning']){
    if(process.env.GIM_PERF_PRE_GC==='1'){const gc=await page.context().newCDPSession(page);await gc.send('HeapProfiler.collectGarbage');await gc.detach();}
    await page.keyboard.press('KeyR');await target.evaluate(()=>{const t=window.__tour,h=t.sceneData.home||t.sceneData.start;t.teleport(...h.pos,h.floor);t.setYaw(h.yawDeg);t.setPitch(0)});await page.waitForTimeout(Number(process.env.GIM_PERF_WARMUP||600));
    await target.evaluate(()=>{const p=window.__perf;p.frames=[];p.cpu=[];p.calls={};p.last=null;p.record=true});
    const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start');
    const begin=Date.now();
    if(phase==='walking'){await page.keyboard.down('KeyS');await page.waitForTimeout(5000);await page.keyboard.up('KeyS')}
    else if(phase==='turning')for(let i=0;i<50;i++){await target.evaluate(i=>window.__tour.setYaw(90+Math.sin(i/50*Math.PI*2)*60),i);await page.waitForTimeout(100)}
    else await page.waitForTimeout(5000);
    const profile=await cdp.send('Profiler.stop');await cdp.detach();fs.writeFileSync(path.join(out,variant+'-'+phase+'-cpu.json'),JSON.stringify(profile.profile));
    const measured=await target.evaluate(()=>{window.__perf.record=false;return {...window.__perf,state:window.__tour.state(),draw:{...window.__tour.renderer.info.render},pixelRatio:window.__tour.renderer.getPixelRatio(),heap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null}});
    rows.push({phase,seconds:(Date.now()-begin)/1000,frameCount:measured.frames.length,frameMs:{median:quantile(measured.frames,.5),p95:quantile(measured.frames,.95),sum:measured.frames.reduce((a,b)=>a+b,0)},cpuMs:{median:quantile(measured.cpu,.5),p95:quantile(measured.cpu,.95),sum:measured.cpu.reduce((a,b)=>a+b,0)},calls:measured.calls,draw:measured.draw,pixelRatio:measured.pixelRatio,heap:measured.heap,position:[measured.state.px,measured.state.py]});
   }
   const result={variant,readyMs,conditions:{warmupMs:Number(process.env.GIM_PERF_WARMUP||600),prePhaseGc:process.env.GIM_PERF_PRE_GC==='1'},scene,rows,errors};fs.writeFileSync(path.join(out,variant+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await page.close();
  }
 }finally{await browser.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1});
