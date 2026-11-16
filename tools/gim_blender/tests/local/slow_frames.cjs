const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
async function main(){
 const work=path.resolve(process.argv[2]);const variants=(process.argv[3]||'tool-before,tool-after').split(','),rows=[];
 const server=http.createServer((req,res)=>{const f=path.resolve(work,'variants','.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!f.startsWith(path.join(work,'variants')+path.sep)||!fs.existsSync(f)){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':({'.js':'application/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css','.json':'application/json'})[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',headless:true,args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-webgl']});
 try{for(const variant of variants){const page=await browser.newPage({viewport:{width:1280,height:720}});
  await page.addInitScript(()=>{const raf=requestAnimationFrame;window.__slowFrames=false;let last=0;window.requestAnimationFrame=cb=>raf(function tick(time){if(window.__slowFrames&&time-last<120){raf(tick);return}last=time;cb(time)})});
  await page.goto('http://127.0.0.1:'+server.address().port+'/'+variant+'/index.html?nolock=1');await page.waitForFunction(()=>window.__tour?.ready);await page.click('#scene');
  await page.evaluate(()=>{const t=window.__tour,h=t.sceneData.home;t.teleport(...h.pos,h.floor);t.setYaw(h.yawDeg);t.setPitch(0);window.__slowFrames=true});
  const before=await page.evaluate(()=>window.__tour.state());const start=Date.now();await page.keyboard.down('KeyS');await page.waitForTimeout(5000);await page.keyboard.up('KeyS');const after=await page.evaluate(()=>window.__tour.state());
  const distance=Math.hypot(after.px-before.px,after.py-before.py);rows.push({variant,seconds:(Date.now()-start)/1000,distanceMetres:distance,reportedFps:after.fps});
  if(variant.includes('after')){
   assert(distance>14&&distance<18,'low render FPS must not slow walking to a crawl');
   await page.evaluate(()=>{const t=window.__tour,h=t.sceneData.home;t.teleport(...h.pos,h.floor);t.setYaw(h.yawDeg);t.setPitch(0)});
   await page.keyboard.down('KeyW');await page.waitForTimeout(4000);await page.keyboard.up('KeyW');
   const closed=await page.evaluate(()=>({s:window.__tour.state(),gate:window.__tour.sceneData.gate}));
   assert(closed.s.px>closed.gate.bbox[3]+.2,'low-FPS physics cannot tunnel through the closed station gate');
   await page.keyboard.press('KeyE');await page.waitForTimeout(700);await page.keyboard.down('KeyW');await page.waitForTimeout(3000);await page.keyboard.up('KeyW');
   const inside=await page.evaluate(()=>window.__tour.state());assert(inside.px<closed.gate.bbox[0]-1,'open gate remains traversable at low FPS');
   rows.at(-1).collision={closedX:closed.s.px,openX:inside.px,passed:true};
  }await page.close();
 }}finally{await browser.close();await new Promise(r=>server.close(r))}
 fs.writeFileSync(path.join(work,'slow-frames.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows));
}
main().catch(e=>{console.error(e);process.exitCode=1});
