// Visible local Chrome diagnostic. Any sandbox override is recorded explicitly.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{chromium}=require('playwright-core');
async function main(){
 const work=path.resolve(process.argv[2]),cases=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),sandbox=process.env.GIM_CHROME_SANDBOX!=='0',profile=path.join(work,sandbox?'normal-chrome-profile':'headed-diagnostic-profile');fs.mkdirSync(profile,{recursive:true});
 const chrome='C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
 let browser,context;const rows=[];
 try{
  context=await chromium.launchPersistentContext(profile,{executablePath:chrome,headless:false,chromiumSandbox:sandbox,viewport:{width:1920,height:1080},ignoreDefaultArgs:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],args:['--window-size=1940,1160']});
  browser=context.browser();const page=context.pages()[0]||await context.newPage();
  for(const item of cases){
   await page.goto(item.url);let target=page;
   if(item.gallery){await page.click('[data-level]');if(item.iframe)target=await(await page.waitForSelector('#simulation-frame')).contentFrame()}
   await target.waitForFunction(()=>window.__tour?.ready,null,{timeout:180000});await page.waitForTimeout(1000);
   await target.evaluate(()=>{const t=window.__tour,h=t.sceneData.home;t.teleport(...h.pos,h.floor);t.setYaw(h.yawDeg);t.setPitch(0)});
   const result=await target.evaluate(async()=>{const t=window.__tour,g=t.renderer.getContext(),ext=g.getExtension('WEBGL_debug_renderer_info'),frames=[];let last;await new Promise(resolve=>{const start=performance.now();function tick(time){if(last)frames.push(time-last);last=time;if(time-start>5000)resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)});const sorted=[...frames].sort((a,b)=>a-b);return {visible:document.visibilityState,focused:document.hasFocus(),renderer:ext?g.getParameter(ext.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER),counts:t.sceneData.counts,canvas:[t.renderer.domElement.width,t.renderer.domElement.height],dpr:t.renderer.getPixelRatio(),frames:frames.length,meanFrameMs:frames.reduce((a,b)=>a+b,0)/frames.length,p95FrameMs:sorted[Math.floor(sorted.length*.95)],draw:{...t.renderer.info.render},state:t.state()}});
   await page.keyboard.down('KeyS');await page.waitForTimeout(1500);await page.keyboard.up('KeyS');const moved=await target.evaluate(()=>window.__tour.state());
   rows.push({name:item.name,...result,movedDistance:Math.hypot(moved.px-result.state.px,moved.py-result.state.py)});
  }
  fs.writeFileSync(path.join(work,'normal-chrome.json'),JSON.stringify({sandboxEnabled:sandbox,args:['headed Chrome','no GPU backend/blocklist override','normal renderer/background throttling; automation connection defaults retained'],rows},null,2));console.log(JSON.stringify(rows.map(r=>({name:r.name,renderer:r.renderer,visible:r.visible,frame:r.meanFrameMs,p95:r.p95FrameMs,moved:r.movedDistance}))));
 }finally{if(context)await context.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
