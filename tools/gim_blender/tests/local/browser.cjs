// Explicit local sample check: against a server run by the isolated frozen EXE.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright-core');
async function main(){
 const url=process.argv[2],out=path.resolve(process.argv[3]);
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-webgl']});
 const page=await browser.newPage({viewport:{width:1440,height:810}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(url);assert.equal(await page.locator('[data-level]').count(),1);await page.click('[data-level]');
  const frame=await (await page.waitForSelector('#simulation-frame')).contentFrame();
  await frame.waitForFunction(()=>window.__tour?.ready&&window.__tour.state().started,null,{timeout:180000});
  await frame.waitForFunction(()=>window.__tour.state().pointerLocked,null,{timeout:10000});
  const metadata=await frame.evaluate(()=>({sha:window.__tour.sceneData.projectInfo.sourceSha256,counts:window.__tour.sceneData.counts,runtime:window.__tour.sceneData.buildVersion,
   leaves:window.__tour.doors.length,nav:window.__tour.sceneData.nav.equipment.sourceMeshSha256}));
  assert(metadata.sha.startsWith('b8e8ef'));assert.equal(metadata.counts.gimRoots,427);assert.equal(metadata.counts.doors,50);
  assert.equal(metadata.nav,'7c0563d28dbb90c51da60e23b3fec24c76edd8e466598984a143b779ef2723e4');
  const decoded=await frame.evaluate(async()=>{
   const THREE=await import('three'),t=window.__tour,meshes=[],ifc=new Set();t.scene.updateMatrixWorld(true);
   t.scene.traverse(o=>{if(!o.isMesh)return;if(o.userData.source_kind==='IFC')ifc.add(o.userData.source_file);if(o.userData.source_kind!=='GIM')return;
    o.geometry.computeBoundingBox();const b=o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);meshes.push({name:o.name,bbox:[b.min.x,-b.max.z,b.min.y,b.max.x,-b.min.z,b.max.y]});
   });return {gim:meshes,ifcFiles:ifc.size};
  });
  assert.equal(decoded.gim.length,30,'actual GLB GIM meshes');assert.equal(decoded.ifcFiles,4,'actual GLB IFC source files');
  if(process.argv[4]){
   const expected=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));let maxDifference=0;
   for(const c of expected.chunks){const actual=decoded.gim.find(x=>x.name===c.name);assert(actual);const span=Math.max(...[0,1,2].map(k=>c.bbox[k+3]-c.bbox[k]));
    const tolerance=.0002+2*span/(2**14-1),difference=Math.max(...c.bbox.map((x,k)=>Math.abs(x-actual.bbox[k])));assert(difference<=tolerance);maxDifference=Math.max(maxDifference,difference);
   }metadata.maxGlbBoundsDifferenceMetres=maxDifference;
  }
  metadata.decodedGimMeshes=decoded.gim.length;metadata.decodedIfcFiles=decoded.ifcFiles;
  const start=await frame.evaluate(()=>window.__tour.state());await page.keyboard.down('KeyS');
  try{await frame.waitForFunction(s=>Math.hypot(window.__tour.state().px-s.px,window.__tour.state().py-s.py)>.5,start,{timeout:8000})}finally{await page.keyboard.up('KeyS')}
  await page.keyboard.press('KeyR');await page.keyboard.press('Space');await frame.waitForFunction(()=>!window.__tour.state().grounded);await frame.waitForFunction(()=>window.__tour.state().grounded);
  await page.keyboard.press('KeyM');await frame.waitForFunction(()=>window.__tour.state().mapOpen);await page.keyboard.press('KeyM');await frame.waitForFunction(()=>!window.__tour.state().mapOpen);
  await frame.evaluate(()=>{window.__tour.teleport(31.9,-1.1,-1.4);window.__tour.setYaw(0);window.__tour.setPitch(0)});
  await page.keyboard.down('KeyW');await page.waitForTimeout(1400);await page.keyboard.up('KeyW');
  const wall=await frame.evaluate(()=>window.__tour.state());assert(wall.py<-.18,'louver wall blocks');
  const door=await frame.evaluate(()=>window.__tour.sceneData.doors.find(d=>d.sourceId?.includes('#38100/')));assert(door);
  await frame.evaluate(d=>{window.__tour.teleport(d.center[0],-1.65,-1.4);window.__tour.setYaw(0)},door);
  await page.waitForTimeout(200);assert((await frame.locator('#prompt').textContent()).includes('开门'));await page.screenshot({path:path.join(out,'packaged-door-prompt.png')});
  await page.keyboard.press('KeyE');await frame.waitForFunction(id=>window.__tour.doors.some(d=>d.id===id&&d.t>.99),door.id);
  await page.keyboard.down('KeyW');try{await frame.waitForFunction(()=>window.__tour.state().py>.8,null,{timeout:8000})}finally{await page.keyboard.up('KeyW')}
  await frame.evaluate(()=>window.__tour.setYaw(180));await page.keyboard.press('KeyE');await frame.waitForFunction(id=>window.__tour.doors.some(d=>d.id===id&&d.t<.01),door.id);
  await page.keyboard.press('KeyE');await frame.waitForFunction(id=>window.__tour.doors.some(d=>d.id===id&&d.t>.99),door.id);
  await page.keyboard.down('KeyW');try{await frame.waitForFunction(()=>window.__tour.state().py<-1.5,null,{timeout:8000})}finally{await page.keyboard.up('KeyW')}
  await page.keyboard.press('KeyR');await page.keyboard.press('KeyQ');await page.waitForFunction(()=>!document.querySelector('#simulation-frame'));
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({passed:true,metadata,cases:['one click entry and pointer lock','WASD','jump and landing','map','return to gate','solid wall blocking','small door E prompt','open, enter, close, reopen and exit','Q returns to catalog'],errors,browser:browser.version()},null,2));
 }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
