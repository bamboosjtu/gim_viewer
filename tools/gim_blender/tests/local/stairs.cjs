// Local regression on caller-staged before/after exports of the same source.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{chromium}=require('playwright-core');
async function main(){
 const work=path.resolve(process.argv[2]),out=path.dirname(work),id='dbfdd9628cc2e3249434b11439f6c192bbac07f953234df78fd67342e1f8a8f8';
 const roots={before:path.join(work,'result/web'),after:path.join(work,'converted-final/data/projects',id,'result/web')};
 const server=http.createServer((req,res)=>{
  const parts=new URL(req.url,'http://localhost').pathname.split('/').slice(1),variant=parts.shift(),base=roots[variant];
  let file;try{file=base&&path.resolve(base,...parts.map(decodeURIComponent))}catch{}
  if(!file||!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return}
  res.writeHead(200,{'Content-Type':({'.js':'application/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const args=['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-webgl'];
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args}),rows=[];
 try{for(const variant of ['before','after']){
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const sample=()=>page.evaluate(()=>{const t=window.__tour,s=t.state();return {x:s.px,y:s.py,feet:s.feet,eyeY:t.camera.position.y,grounded:s.grounded,failed:s.runtimeFailure}});
  try{
   await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/index.html`);await page.waitForFunction(()=>window.__tour?.ready&&window.__tour.state().started,null,{timeout:180000});await page.click('#scene');await page.waitForTimeout(700);
   await page.evaluate(()=>{const t=window.__tour;t.teleport(12.55,39,-1.5);t.setYaw(270);t.setPitch(0)});await page.waitForTimeout(250);
   const trace=[await sample()];await page.keyboard.down('KeyW');
   try{for(const x of [13.5,14.2,15.2,16.2,17.6]){await page.waitForFunction(x=>window.__tour.state().px>=x,x,{timeout:8000});trace.push(await sample())}}finally{await page.keyboard.up('KeyW')}
   await page.waitForTimeout(200);const top=await sample();await page.evaluate(()=>window.__tour.setYaw(90));await page.screenshot({path:path.join(out,`stairs-${variant}.png`)});
   if(variant==='before')assert(top.feet<-1.3,'the original must reproduce walking through the stair height');
   else{
    assert(top.feet>-.02&&top.feet<.02,'player stands on the 0m landing');assert(Math.abs(top.eyeY-top.feet-1.68)<.03,'human eye height is preserved');
    assert(trace[2].feet>trace[0].feet+.15&&trace[4].feet>trace[2].feet+.5,'feet rise over actual source treads');
   }
   await page.keyboard.down('KeyW');try{await page.waitForFunction(()=>window.__tour.state().px<12.65,null,{timeout:8000})}finally{await page.keyboard.up('KeyW')}
   await page.waitForTimeout(300);const bottom=await sample();assert(bottom.feet< -1.25&&bottom.feet> -1.6);
   assert.deepEqual(errors,[]);rows.push({variant,trace,top,bottom,errors});
  }catch(e){rows.push({variant,error:e.message,state:await sample().catch(()=>null)});throw e}
  finally{fs.writeFileSync(path.join(out,'stairs-walk.json'),JSON.stringify({passed:rows.length===2&&rows.every(r=>!r.error),sourceSha256:id,conditions:{headless:true,browser:'Edge',viewport:[1440,900],testOnlyGpuArguments:args},rows},null,2));await page.close()}
 }}finally{await browser.close();await new Promise(r=>server.close(r))}
 console.log(JSON.stringify(rows.map(r=>({variant:r.variant,feet:r.trace.map(p=>+p.feet.toFixed(3)),top:r.top.feet,bottom:r.bottom.feet}))));
}
main().catch(e=>{console.error(e);process.exitCode=1});
