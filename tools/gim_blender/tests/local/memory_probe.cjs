const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process'),{chromium}=require('playwright-core');
async function main(){
 const work=path.resolve(process.argv[2]),variants=(process.argv[3]||'s02-before,s02-after').split(','),rows=[];
 const server=http.createServer((req,res)=>{const f=path.resolve(work,'variants','.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!f.startsWith(path.join(work,'variants')+path.sep)||!fs.existsSync(f)){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':({'.js':'application/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css','.json':'application/json'})[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{for(const variant of variants){
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',headless:true,args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-webgl']});
  const samples=path.join(work,variant+'-native-memory.jsonl'),pidFile=path.join(work,variant+'-pids.json');let sampler,timer;
  try{const browserCdp=await browser.newBrowserCDPSession();const updatePids=async()=>{try{const p=await browserCdp.send('SystemInfo.getProcessInfo');fs.writeFileSync(pidFile+'.staging',JSON.stringify(p.processInfo.map(x=>x.id)));fs.renameSync(pidFile+'.staging',pidFile)}catch{}};
   await updatePids();timer=setInterval(updatePids,250);
   sampler=spawn(process.argv[4],['-u',path.join(__dirname,'sample_memory.py'),pidFile,samples],{stdio:'ignore',windowsHide:true});
   const page=await browser.newPage();await page.addInitScript(()=>{const Original=Worker;window.__workers={created:0,terminated:0};window.Worker=class extends Original{constructor(...args){super(...args);window.__workers.created++}terminate(){window.__workers.terminated++;return super.terminate()}}});
   await page.goto('http://127.0.0.1:'+server.address().port+'/'+variant+'/index.html?nolock=1');await page.waitForFunction(()=>window.__tour?.ready,null,{timeout:180000});await page.click('#scene');
   const cdp=await page.context().newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');await page.waitForTimeout(2000);const start=await cdp.send('Runtime.getHeapUsage');
   await page.keyboard.down('KeyS');await page.waitForTimeout(2000);await page.keyboard.up('KeyS');await cdp.send('HeapProfiler.collectGarbage');const end=await cdp.send('Runtime.getHeapUsage');await page.waitForTimeout(1000);
   const state=await page.evaluate(()=>({workers:window.__workers,counts:window.__tour.sceneData.counts,geometries:window.__tour.renderer.info.memory.geometries}));
   rows.push({variant,startHeap:start,endHeap:end,state});
  }finally{clearInterval(timer);sampler?.kill();await browser.close()}
  const data=fs.readFileSync(samples,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));rows.at(-1).native={sampledPeakPrivateBytes:Math.max(...data.map(x=>x.privateBytes)),postLoadPrivateBytes:data.at(-1).privateBytes,samples:data.length,lastProcessCount:data.at(-1).processes,lastUnavailable:data.at(-1).unavailable};
 }}finally{await new Promise(r=>server.close(r))}
 fs.writeFileSync(path.join(work,'memory.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows));
}
main().catch(e=>{console.error(e);process.exitCode=1});
