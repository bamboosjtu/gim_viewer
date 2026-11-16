const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{chromium}=require('playwright-core');
async function main(){
 const work=path.resolve(process.argv[2]),variants=(process.argv[3]||'tool-host,research-host').split(',');
 const server=http.createServer((req,res)=>{const f=path.resolve(work,'variants','.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!f.startsWith(path.join(work,'variants')+path.sep)||!fs.existsSync(f)){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':({'.js':'application/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css','.json':'application/json'})[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',headless:true,args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-webgl']});const rows=[];
 try{for(const variant of variants){const page=await browser.newPage({viewport:{width:1280,height:720}});await page.addInitScript(()=>{const W=Worker;window.__decoderWorkers={created:0,terminated:0};window.Worker=class extends W{constructor(...args){super(...args);window.__decoderWorkers.created++}terminate(){window.__decoderWorkers.terminated++;return super.terminate()}}});await page.goto(process.env.GIM_WALK_URL||'http://127.0.0.1:'+server.address().port+'/'+variant+'/index.html');await page.click('[data-level]');const frame=await (await page.waitForSelector('#simulation-frame')).contentFrame();await frame.waitForFunction(()=>window.__tour?.ready,null,{timeout:180000});await page.waitForTimeout(700);
   await frame.evaluate(()=>{const t=window.__tour,h=t.sceneData.home||t.sceneData.start;t.teleport(...h.pos,h.floor);t.setYaw(h.yawDeg);t.setPitch(0)});
   const sample=()=>frame.evaluate(()=>{const t=window.__tour,s=t.state();return {x:s.px,y:s.py,feet:s.feet,yaw:s.yaw,fps:s.fps,paused:s.controlsPaused,locked:s.pointerLocked,grounded:s.grounded,failed:s.runtimeFailure,prompt:document.getElementById('prompt').textContent,gate:t.doors.find(d=>d.id==='GATE')}});
   const servedRuntime=await frame.evaluate(async()=> (await (await fetch('./js/main.js')).text()).includes('advancePlayer'));
   const before=await sample();await page.keyboard.down('KeyW');await page.waitForTimeout(3000);await page.keyboard.up('KeyW');const closed=await sample();
   await page.keyboard.press('KeyE');await page.waitForTimeout(600);const opened=await sample();await frame.evaluate(()=>window.__tour.setYaw(90));await page.keyboard.down('KeyW');await page.waitForTimeout(3000);await page.keyboard.up('KeyW');const inside=await sample();
   assert(closed.x<before.x-5);assert(opened.gate.open&&opened.gate.t>.99);assert(inside.x<closed.x-5);
   const decoderWorkers=await frame.evaluate(()=>window.__decoderWorkers);if(servedRuntime)assert.equal(decoderWorkers.created,decoderWorkers.terminated,'decoded geometry must not leave decoder workers running');
   rows.push({variant,servedRuntime,decoderWorkers,before,closed,opened,inside});await page.close();
 }}finally{await browser.close();await new Promise(r=>server.close(r))}
 fs.writeFileSync(path.join(work,'movement.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows));
}
main().catch(e=>{console.error(e);process.exitCode=1});
