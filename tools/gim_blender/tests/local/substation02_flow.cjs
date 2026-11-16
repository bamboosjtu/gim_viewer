// Explicit local test of freshly imported substation02 on the independent service.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright-core');
async function main(){
 const [url,projectArg,outArg]=process.argv.slice(2),project=path.resolve(projectArg),out=path.resolve(outArg),build=path.join(project,'work/build');
 const read=n=>JSON.parse(fs.readFileSync(path.join(build,n),'utf8'));
 const gim=read('gim_scene.json'),ifc=read('ifc_scene.json'),inventory=read('ifc_bounds.json');
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist','--enable-webgl']});
 const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[],cases=[];page.on('pageerror',e=>errors.push(e.message));
 let frame;
 const state=()=>frame.evaluate(()=>window.__tour.state());
 async function walk(predicate,arg,timeout=20000){await page.keyboard.down('KeyW');try{await frame.waitForFunction(predicate,arg,{timeout})}finally{await page.keyboard.up('KeyW')}await page.waitForTimeout(120)}
 try{
  await page.goto(url);const original=page.url();assert.equal(await page.locator('[data-level]').count(),1);await page.click('[data-level]');
  frame=page;
  await frame.waitForFunction(()=>window.__tour?.ready&&window.__tour.state().started,null,{timeout:300000});
  await page.click('#scene');await frame.waitForFunction(()=>window.__tour.state().pointerLocked,null,{timeout:10000});assert.notEqual(page.url(),original);
  const decoded=await frame.evaluate(async()=>{
   const THREE=await import('three'),t=window.__tour,chunks=[],files=new Set();t.scene.updateMatrixWorld(true);
   t.scene.traverse(o=>{if(!o.isMesh)return;if(o.userData.source_kind==='IFC'&&o.userData.source_file)files.add(o.userData.source_file);if(o.userData.source_kind!=='GIM')return;
    o.geometry.computeBoundingBox();const b=o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    chunks.push({name:o.name,triangles:(o.geometry.index?.count||o.geometry.getAttribute('position').count)/3,bbox:[b.min.x,-b.max.z,b.min.y,b.max.x,-b.min.z,b.max.y]});
   });
   const data=t.sceneData,doorDefinitions=[...data.doors,...(data.gate?[data.gate]:[])];
   return {sourceSha256:data.projectInfo.sourceSha256,counts:data.counts,geometry:data.geometry,chunks,ifcFiles:[...files],
    missingLeaves:doorDefinitions.flatMap(d=>(d.leaves||[]).filter(l=>!t.scene.getObjectByName(l.name)).map(l=>l.name)),declaredDoors:doorDefinitions.length,activeDoors:t.doors.length,
    home:data.home||data.start,gate:data.gate,equipmentTriangles:t.nav.equipment.indices.length/3};
  });
  assert.equal(decoded.sourceSha256,'a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29');
  assert.equal(gim.placements,3326);assert.equal(gim.solids,4346);assert.equal(inventory.files.length,17);assert.equal(Object.keys(ifc.files).length,17);
  assert.equal(decoded.chunks.length,gim.chunks.length);assert.deepEqual(decoded.ifcFiles.sort(),[...new Set(ifc.chunks.map(c=>c.file))].sort());
  assert.deepEqual(decoded.missingLeaves,[]);assert.equal(decoded.activeDoors,decoded.declaredDoors);
  let maxBoundsError=0;const triangleChanges=[],distantSourceChunks=[];
  for(const c of gim.chunks){const actual=decoded.chunks.find(x=>x.name===c.name);assert(actual,'missing chunk '+c.name);
   const span=Math.max(...[0,1,2].map(k=>c.bbox[k+3]-c.bbox[k])),tolerance=.0002+2*span/(2**14-1),difference=Math.max(...c.bbox.map((x,k)=>Math.abs(x-actual.bbox[k])));
   assert(difference<=tolerance,'source-frame bounds mismatch '+c.name);
   if(Math.max(...c.bbox.map(Math.abs))>1e6)distantSourceChunks.push({name:c.name,bbox:c.bbox,sourcePaths:c.sourcePaths});
   else maxBoundsError=Math.max(maxBoundsError,difference);
   if(actual.triangles!==c.indexCount/3)triangleChanges.push({name:c.name,source:c.indexCount/3,glb:actual.triangles});
  }
  assert(maxBoundsError<.02,'valid station geometry must retain centimetre precision');
  cases.push({case:'actual GLB source coverage',gimChunks:decoded.chunks.length,ifcFiles:decoded.ifcFiles.length,maxValidBoundsErrorMetres:maxBoundsError,triangleChanges,distantSourceChunks});
  const start=await state();await page.keyboard.down('KeyS');try{await frame.waitForFunction(s=>Math.hypot(window.__tour.state().px-s.px,window.__tour.state().py-s.py)>.5,start,{timeout:10000})}finally{await page.keyboard.up('KeyS')}
  await page.waitForTimeout(750);const yaw=(await state()).yaw;await page.mouse.move(400,350);await page.mouse.move(560,390,{steps:8});await page.waitForTimeout(150);assert(Math.abs((await state()).yaw-yaw)>.001,'mouse look');
  await page.keyboard.press('KeyR');const home=await state();await page.keyboard.press('Space');await frame.waitForFunction(()=>!window.__tour.state().grounded);await frame.waitForFunction(()=>window.__tour.state().grounded);assert(Math.abs((await state()).feet-home.feet)<.08);
  await page.keyboard.press('KeyM');await frame.waitForFunction(()=>window.__tour.state().mapOpen);const mapped=await state();await page.keyboard.down('KeyW');await page.waitForTimeout(180);await page.keyboard.up('KeyW');const paused=await state();assert(Math.hypot(paused.px-mapped.px,paused.py-mapped.py)<.001);
  await page.keyboard.press('KeyM');await frame.waitForFunction(()=>!window.__tour.state().mapOpen);await page.keyboard.press('KeyR');
  const returned=await state();assert(Math.hypot(returned.px-decoded.home.pos[0],returned.py-decoded.home.pos[1])<.001);
  cases.push({case:'WASD, mouse look, jump/landing, map pause, return to gate',passed:true});
  if(decoded.gate){
   const gate=decoded.gate;await walk(g=>{const s=window.__tour.state();return Math.hypot(s.px-g.center[0],s.py-g.center[1])<2.5},gate);
   assert((await frame.locator('#prompt').textContent()).includes('开启大门'));await page.keyboard.press('KeyE');await frame.waitForFunction(()=>window.__tour.doors.some(d=>d.id==='GATE'&&d.t>.99));
   await walk(g=>{const s=window.__tour.state();return (s.px-g.center[0])*g.outward[0]+(s.py-g.center[1])*g.outward[1]<-1},gate);
   cases.push({case:'walk from spawn, E opens station gate, enter compound',passed:true});
  }
  const door=await frame.evaluate(()=>{
   const t=window.__tour,n=t.nav;
   const all=[...t.sceneData.doors].sort((a,b)=>(b.main?1:0)-(a.main?1:0));
   for(const d of all){if(d.category!=='建筑'||d.width<.85||d.height<1.8)continue;const normal=d.axis==='x'?[1,0]:[0,1];
    const home=t.sceneData.home||t.sceneData.start,preferred=Math.sign((home.pos[0]-d.center[0])*normal[0]+(home.pos[1]-d.center[1])*normal[1])||1;
    for(const sign of [preferred,-preferred]){const vector=normal.map(x=>x*sign),start=d.center.slice(0,2).map((x,k)=>x+vector[k]*1.2),end=d.center.slice(0,2).map((x,k)=>x-vector[k]*1.2);
     const feet=n.safeFloor(...start,d.bottom),inside=n.safeFloor(...end,d.bottom);if(Math.abs(feet-d.bottom)>.6||Math.abs(inside-d.bottom)>.6)continue;
     let clear=true,current=feet;for(let step=12;step>=-12;step--){const x=d.center[0]+vector[0]*step*.1,y=d.center[1]+vector[1]*step*.1,next=n.floorAtFootprint(x,y,current);if(next===null||next>current+.56||n.blocked(x,y,.27,next)){clear=false;break}current=next}
     if(clear)return {id:d.id,sourceFile:d.sourceFile,start,end,feet,normal:vector,center:d.center};
    }
   }return null;
  });assert(door,'need a physical doorway with clear source geometry on both sides');
  await frame.evaluate(d=>{window.__tour.teleport(...d.start,d.feet);window.__tour.setYaw(Math.atan2(d.normal[0],-d.normal[1])*180/Math.PI);window.__tour.setPitch(0)},door);
  await page.waitForTimeout(150);assert(/开门|打开.*门|升起.*门/.test(await frame.locator('#prompt').textContent()));await page.keyboard.press('KeyE');await frame.waitForFunction(id=>window.__tour.doors.some(d=>d.id===id&&d.t>.99),door.id);
  await walk(d=>{const s=window.__tour.state();return (s.px-d.center[0])*d.normal[0]+(s.py-d.center[1])*d.normal[1]<-.8},door);
  await frame.evaluate(d=>window.__tour.setYaw(Math.atan2(-d.normal[0],d.normal[1])*180/Math.PI),door);
  await page.keyboard.press('KeyE');await frame.waitForFunction(id=>window.__tour.doors.some(d=>d.id===id&&d.t<.01),door.id);await page.keyboard.press('KeyE');await frame.waitForFunction(id=>window.__tour.doors.some(d=>d.id===id&&d.t>.99),door.id);
  await walk(d=>{const s=window.__tour.state();return (s.px-d.center[0])*d.normal[0]+(s.py-d.center[1])*d.normal[1]>.8},door);
  cases.push({case:'source building door: open, enter, close, reopen, exit',sourceId:door.id,sourceFile:door.sourceFile,passed:true});
  const device=await frame.evaluate(()=>{
   const n=window.__tour.nav,e=n.equipment;
   for(let i=0;i<e.indices.length/3;i+=37){const [a,b,c]=e.triangle(i),u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]);
    let nx=u[1]*v[2]-u[2]*v[1],ny=u[2]*v[0]-u[0]*v[2],nz=u[0]*v[1]-u[1]*v[0],len=Math.hypot(nx,ny,nz);if(len<.02||Math.abs(nz)/len>.02)continue;
    len=Math.hypot(nx,ny);nx/=len;ny/=len;if(Math.max(Math.abs(nx),Math.abs(ny))<.9999)continue;const center=a.map((z,k)=>(z+b[k]+c[k])/3);
    for(const sign of [1,-1]){const normal=[nx*sign,ny*sign],start=center.slice(0,2).map((z,k)=>z+normal[k]*.95);if(!n.isInside(...start,.5))continue;
     const feet=n.layers(...start).filter(z=>z<=center[2]-.5).at(-1);if(feet===undefined||center[2]>feet+1.5||Math.max(a[2],b[2],c[2])<feet+1.8)continue;
     if(n.blocked(...start,.27,feet)||n.obstacles.blocked(center[0],center[1],.27,feet)||!e.blocked(center[0],center[1],.27,feet))continue;
     let clear=true;for(let d=.37;d<.96;d+=.06){const x=center[0]+normal[0]*d,y=center[1]+normal[1]*d;if(n.blocked(x,y,.27,feet)||Math.abs((n.floorAtFootprint(x,y,feet)??Infinity)-feet)>.06){clear=false;break}}
     if(clear)return {center,normal,start,feet,triangle:i};
    }
   }return null;
  });assert(device,'need an accessible actual DEV surface');
  await frame.evaluate(d=>{window.__tour.teleport(...d.start,d.feet);window.__tour.setYaw(Math.atan2(d.normal[0],-d.normal[1])*180/Math.PI)},device);
  await walk(d=>{const s=window.__tour.state();return (s.px-d.center[0])*d.normal[0]+(s.py-d.center[1])*d.normal[1]<.4},device);
  await page.keyboard.down('ShiftLeft');await page.keyboard.down('KeyW');await page.waitForTimeout(500);await page.keyboard.up('KeyW');await page.keyboard.up('ShiftLeft');
  const stopped=await state(),separation=(stopped.px-device.center[0])*device.normal[0]+(stopped.py-device.center[1])*device.normal[1];assert(separation>=.24&&separation<.4);
  cases.push({case:'walking and sprinting stopped by an actual DEV surface',triangle:device.triangle,separationMetres:separation,passed:true});
  await page.keyboard.press('KeyR');await page.screenshot({path:path.join(out,'substation02-entry.png')});
  await frame.evaluate(()=>window.__tour.setPaused(true));
  const overview=await frame.evaluate(async()=>{const THREE=await import('three'),t=window.__tour,b=t.sceneData.nav.bounds,center=new THREE.Vector3((b.x0+b.x1)/2,3,-(b.y0+b.y1)/2),distance=Math.max(b.x1-b.x0,b.y1-b.y0);const labels=t.scene.getObjectByName('LandmarkLabels');if(labels)labels.visible=false;t.camera.fov=44;t.camera.position.copy(center).add(new THREE.Vector3(distance*.85,distance*.75,distance*.85));t.camera.lookAt(center);t.camera.updateProjectionMatrix();t.renderer.render(t.scene,t.camera);return t.renderer.domElement.toDataURL('image/png').split(',')[1]});
  fs.writeFileSync(path.join(out,'substation02-overview.png'),Buffer.from(overview,'base64'));
  await page.keyboard.press('KeyQ');await page.waitForSelector('[data-level]');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({passed:true,decoded,cases,errors,browser:browser.version()},null,2));console.log(JSON.stringify({passed:true,cases}));
 }catch(e){fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({passed:false,cases,errors,error:String(e),state:frame?await state().catch(()=>null):null},null,2));await page.screenshot({path:path.join(out,'browser-failure.png')}).catch(()=>{});throw e}
 finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
