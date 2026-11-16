// Explicit local browser smoke for already imported workspace-staged samples.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright-core');
async function main(){
 const [url,home,out]=process.argv.slice(2),projects=path.resolve(home,'data/projects');
 const records=fs.readdirSync(projects).map(id=>JSON.parse(fs.readFileSync(path.join(projects,id,'project.json'),'utf8'))).filter(r=>['ready','partial'].includes(r.status));
 const args=['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-webgl'];
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args});
 const rows=[];
 try{for(const rec of records){
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.click(`[data-level="${rec.id}"]`);await page.waitForFunction(()=>window.__tour?.ready&&window.__tour.state().started,null,{timeout:180000});await page.click('#scene');await page.waitForTimeout(700);
  const observed=await page.evaluate(()=>{const t=window.__tour,g=t.renderer.getContext(),ext=g.getExtension('WEBGL_debug_renderer_info'),names=[];t.scene.traverse(o=>{if(o.isMesh&&o.userData.source_kind==='GIM')names.push(o.name)});return {sha:t.sceneData.projectInfo.sourceSha256,counts:t.sceneData.counts,geometry:t.sceneData.geometry,loadedGimChunks:names.sort(),renderer:ext?g.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,drawCalls:t.renderer.info.render.calls}});
  const meta=JSON.parse(fs.readFileSync(path.join(projects,rec.id,'work/build/gim_scene.json'),'utf8'));
  assert.equal(observed.sha,rec.id);assert.deepEqual(observed.counts,rec.counts);assert.deepEqual(observed.loadedGimChunks,meta.chunks.map(c=>c.name).sort());assert(observed.drawCalls>0);
  const state=()=>page.evaluate(()=>window.__tour.state()),start=await state();
  await page.keyboard.down('KeyS');try{await page.waitForFunction(s=>Math.hypot(window.__tour.state().px-s.px,window.__tour.state().py-s.py)>.5,start,{timeout:12000})}finally{await page.keyboard.up('KeyS')}
  await page.keyboard.press('KeyR');const reset=await state();assert(Math.hypot(reset.px-start.px,reset.py-start.py)<.01);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.__tour.state().grounded,null,{timeout:5000});await page.waitForFunction(()=>window.__tour.state().grounded,null,{timeout:8000});
  await page.keyboard.press('KeyM');await page.waitForFunction(()=>window.__tour.state().mapOpen);await page.keyboard.press('KeyM');await page.waitForFunction(()=>!window.__tour.state().mapOpen);
  await page.keyboard.press('KeyQ');await page.waitForSelector('[data-level]');assert.equal(await page.locator('iframe').count(),0);assert.deepEqual(errors,[]);
  rows.push({sourceSha256:rec.id,status:rec.status,...observed,cases:['direct entry','all generated GIM chunks decoded','WASD','return to spawn','jump and landing','map','Q returns to selection'],errors});await page.close();
 }}finally{await browser.close()}
 fs.writeFileSync(out,JSON.stringify({passed:true,conditions:{headless:true,browser:'Edge',viewport:[1280,720],testOnlyGpuArguments:args},rows},null,2));console.log(JSON.stringify({passed:true,levels:rows.map(r=>({sha:r.sourceSha256.slice(0,6),status:r.status,loadedGimChunks:r.loadedGimChunks.length}))}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
