// Real Tauri/WebView isolated geometry experiment. Uses an existing, validated
// source cache and the production first IFC anchor; it is NOT a cold-open gate.
import WebSocket from '../../desktop/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
const [mode='baseline',label=mode]=process.argv.slice(2),out='output/ifc-geometry-breakthrough/';mkdirSync(out,{recursive:true});
let page;const boot=Date.now();while(Date.now()-boot<15000){
  try{const pages=await(await fetch('http://127.0.0.1:9352/json/list')).json();page=pages.find(p=>p.type==='page'&&p.url==='http://localhost:14317/');if(page)break;}catch{}
  await new Promise(r=>setTimeout(r,100));
}
if(!page)throw Error('Expected local Tauri page absent');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
let sequence=0;const pending=new Map();
ws.on('message',bytes=>{const response=JSON.parse(bytes),p=pending.get(response.id);if(p){pending.delete(response.id);clearTimeout(p.timer);response.error?p.reject(Error(JSON.stringify(response.error))):p.resolve(response.result);}});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' exceeded 15s'));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const response=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(response.exceptionDetails)throw Error(JSON.stringify(response.exceptionDetails));return response.result.value;};
const screenshot=async suffix=>{const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(out+label+'-'+suffix+'.png',Buffer.from(r.data,'base64'));};
const result={mode,label,scope:'steel source only + production anchor; no tail IFC / DEV batch',budgetMs:90000,observations:[]};
try {
  const boundStart=Date.now();let bound=false;
  while(Date.now()-boundStart<10000){const o=await send('Runtime.evaluate',{expression:"document.querySelector('#btn-load-gim')"});if(o.result.objectId){const listeners=await send('DOMDebugger.getEventListeners',{objectId:o.result.objectId});if(listeners.listeners.some(e=>e.type==='click')){bound=true;break;}}await new Promise(r=>setTimeout(r,50));}
  if(!bound)throw Error('10s production UI startup gate failed');
  await evaluate(`(async()=>{
    const s=window.__gimAppState;if(s.currentProjectId!==null)throw Error('Fresh experiment process required');
    localStorage.removeItem('GIM_COORD_OFFSET');localStorage.removeItem('gim-debug-fragments-cache');
    const d=await import('/bridge/database.ts'),T=await import('/node_modules/.vite/deps/three.js'),m=await import('/src/viewer/ifcPreviewProvider.ts'),v=await import('/src/viewer/viewerRuntime.ts'),loader=await import('/src/viewer/ifcLoader.ts');
    const projects=await d.listCachedProjects(),project=projects.find(p=>p.path.toLowerCase().endsWith('/demo/substation02.gim')&&p.size===34176631);
    if(!project)throw Error('Actual substation02 cache missing');
    const projectId=project.id??project.project_id;s.activateProject(projectId,'a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29');s.currentProjectType='substation';
    const manifest=await d.readGeometryCacheManifest(projectId);if(manifest.source_sha256!=='a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29')throw Error('Cached source SHA mismatch');
    const index=await d.getGimIndex(projectId),first=index.ifc_models[0];
    const binding=await(await import('/src/services/viewerUIBinding.ts')).getViewerRuntimeWithUI(s),ctx=binding.ctx;await loader.initEngine(ctx,s);
    loader.registerModelEvents(ctx,s,binding.modelCallbacks);document.querySelector('#empty-tip').style.display='none';
    await(await import('/src/viewer/ifcEntryLoader.ts')).loadIfcEntry(ctx,s,{modelId:first.model_id,name:first.name,path:first.entry_path},()=>d.readCachedIfc(projectId,first.entry_path),undefined,{transferInput:true});
    await (await import('/src/services/coordinateAlignmentService.ts')).syncProjectSourceToViewerFromFragments(s,ctx.fragments);
    if(!s.projectSourceToViewerMatrix)throw Error('Production anchor missing');
    window.__geo={T,s,ctx,m,d,projectId,first,events:[],heartbeat:[],frames:[],inputs:[],started:performance.now(),status:'reading',anchor:s.projectSourceToViewerMatrix.toArray(),baseCoordinationModel:ctx.fragments.baseCoordinationModel};
    const a=window.__geo;a.last=performance.now();a.timer=setInterval(()=>{const n=performance.now();a.heartbeat.push(n-a.last);a.last=n},125);
    document.addEventListener('keydown',e=>{if(e.key==='F8'){const n=performance.now();requestAnimationFrame(()=>a.inputs.push({trusted:e.isTrusted,dispatchMs:n-e.timeStamp,paintMs:performance.now()-n}));}});
    let last=performance.now();const frame=n=>{a.frames.push(n-last);last=n;if(a.status!=='released')requestAnimationFrame(frame)};requestAnimationFrame(frame);
    a.task=(async()=>{
      const path='CBM/0302-钢结构.ifc',bytes=await d.readCachedIfc(projectId,path);a.sourceBytes=bytes.byteLength;a.readMs=performance.now()-a.started;a.sourceReady=performance.now();a.status='metadata';
      const p=new m.IfcPreviewProvider({modelId:(await import('/src/gim/modelIdentity.ts')).createIfcModelId(path),sourcePath:path,bytes,wasm:{...ctx.ifcLoader.settings.wasm},sourceToViewer:s.projectSourceToViewerMatrix.clone(),loadFine:async()=>{throw Error('Full steel LOD2 excluded from this experiment')},
        instanceBoxes:${mode!=='baseline'},farView:${mode==='adaptive'?"()=>({camera:ctx.world.camera.three,height:ctx.world.renderer.three.domElement.clientHeight})":"undefined"},objectFine:${mode==='adaptive'},
        transferInput:true,releaseMetadataAfterPreview:true,loadPropertiesBytes:()=>d.readCachedIfc(projectId,path),onTiming:event=>{a.events.push({...event,at:performance.now()-a.sourceReady});},onResource:event=>{a.resources??=[];a.resources.push(event);}});
      a.p=p;s.ifcPreviewProviders.set(p.modelId,p);ctx.world.scene.three.add(p.root);await p.loadLOD(0);a.lod0At=performance.now()-a.sourceReady;
      const box=new T.Box3().setFromObject(p.root),center=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3()),distance=size.length();
      a.box={min:box.min.toArray(),max:box.max.toArray()};await ctx.world.camera.controls.setLookAt(center.x+distance*.45,center.y+distance*.5,center.z+distance*.65,...center.toArray(),false);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));a.firstVisibleAt=performance.now()-a.sourceReady;
      if(!document.contains(ctx.world.renderer.three.domElement))throw Error('Renderer detached from visible viewport');
      a.status='lod0';a.objects=new Set(p.data.shapes.map(x=>x.object.expressId)).size;
    })().catch(e=>{a.status='failed';a.error=String(e)});
  })()`);
  const started=Date.now();
  const resources=async()=>{
    const memory=await evaluate(`(()=>{const a=window.__geo;if(!a)return null;if(!a.memoryPending){a.memoryPending=true;window.__TAURI_INTERNALS__.invoke('get_process_memory').then(m=>a.memory={at:performance.now(),...m}).finally(()=>a.memoryPending=false);}return a.memory??null;})()`);
    return {atWall:Date.now(),memory,heap:await send('Runtime.getHeapUsage')};
  };
  result.resources=[];
  while(Date.now()-started<result.budgetMs){
    const snapshot=await evaluate(`(()=>{const a=window.__geo;return {status:a?.status,error:a?.error,at:performance.now(),events:a?.events,sourceBytes:a?.sourceBytes,memory:null,renderer:a?.ctx.world.renderer.three.info.render}})()`);
    snapshot.heap=await send('Runtime.getHeapUsage');result.observations.push(snapshot);
    result.resources.push(await resources());
    if(snapshot.status==='failed')throw Error(snapshot.error);
    if(snapshot.status==='lod0')break;
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'F8',code:'F8',windowsVirtualKeyCode:119});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'F8',code:'F8',windowsVirtualKeyCode:119});
    await new Promise(r=>setTimeout(r,500));
  }
  if(result.observations.at(-1)?.status!=='lod0')throw Error('Fixed 90s LOD0 observation window exceeded');
  await new Promise(r=>setTimeout(r,1500));await screenshot('far-lod0');
  result.lod0=await evaluate(`(()=>{const a=window.__geo;return {readMs:a.readMs,lod0At:a.lod0At,firstVisibleAt:a.firstVisibleAt,events:a.events,objects:a.objects,box:a.box,anchor:a.anchor,first:a.first,baseCoordinationModel:a.baseCoordinationModel,renderer:{...a.ctx.world.renderer.three.info.render},resources:a.resources,heartbeat:a.heartbeat,frames:a.frames.slice(-60),inputs:a.inputs}})()`);
  result.lod0.heap=await send('Runtime.getHeapUsage');result.lod0.memory=await evaluate(`window.__TAURI_INTERNALS__.invoke('get_process_memory')`);
  await evaluate(`(()=>{const a=window.__geo;a.status='lod1-loading';a.task=a.p.loadLOD(1).then(()=>a.status='lod1').catch(e=>{a.error=String(e);a.status='failed'})})()`);
  const second=Date.now();while(Date.now()-second<60000){const status=await evaluate(`window.__geo.status`);if(status==='lod1')break;if(status==='failed')throw Error(await evaluate(`window.__geo.error`));await new Promise(r=>setTimeout(r,500));}
  if(await evaluate(`window.__geo.status`)!=='lod1')throw Error('Fixed 60s LOD1 window exceeded');
  await new Promise(r=>setTimeout(r,5000));await screenshot('far-lod1');
  result.lod1=await evaluate(`(()=>{const a=window.__geo;return {events:a.events,renderer:{...a.ctx.world.renderer.three.info.render},adaptive:a.p.farViewDiagnostic(),heartbeat:a.heartbeat,frames:a.frames}})()`);
  result.lod1.heap=await send('Runtime.getHeapUsage');
  if(mode==='adaptive'){
    result.selected=await evaluate(`(async()=>{const a=window.__geo,T=a.T,s=a.s,p=a.p,shape=p.data.shapes.find(x=>x.object.ifcType==='IFCPLATE'&&x.profile),object=shape.object;
      const g=a.m.previewShapeGeometry(shape,1,p.data.origin),box=new T.Box3().setFromBufferAttribute(g.getAttribute('position')).applyMatrix4(p.root.matrix);g.dispose();const c=box.getCenter(new T.Vector3()),r=Math.max(box.getSize(new T.Vector3()).length()*3,1);
      await a.ctx.world.camera.controls.setLookAt(c.x+r,c.y+r,c.z+r,...c.toArray(),false);
      a.selectedObject=object;const request=s.beginSelection({kind:'ifc-object',key:object.key});await(await import('/src/services/ifcPreviewService.ts')).selectIfcPreview(a.ctx,s,p,object,request);p.highlight(object);
      return {object,requestId:request.id,previewBox:{min:box.min.toArray(),max:box.max.toArray()},worldMatrix:p.root.matrix.toArray(),props:document.querySelector('#props-drawer')?.textContent};})()`);
    await new Promise(r=>setTimeout(r,1500));await screenshot('near-selected-preview');
    const pos=await evaluate(`(()=>{const r=document.querySelector('[data-preview-refine]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const at=Date.now();await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pos});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pos});
    while(Date.now()-at<45000){const status=await evaluate(`({lod:window.__geo.p.objectLOD(window.__geo.selectedObject),message:window.__gimAppState.selectionGeometry,diagnostic:window.__geo.p.root.userData.objectFineDiagnostic,events:window.__geo.p.root.userData.objectFineEvents})`);result.fine=status;result.resources.push(await resources());await send('Input.dispatchKeyEvent',{type:'keyDown',key:'F8',code:'F8',windowsVirtualKeyCode:119});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'F8',code:'F8',windowsVirtualKeyCode:119});if(status.message?.status==='failed')throw Error(status.message.detail);if(status.lod===2){result.fine.wallMs=Date.now()-at;break;}await new Promise(r=>setTimeout(r,500));}
    if(result.fine?.lod!==2)throw Error('Fixed 45s object-fine observation window exceeded');
    await screenshot('near-selected-fine');
    result.fine.detail=await evaluate(`(()=>{const a=window.__geo,p=a.p,T=a.T,meshes=p.root.children.filter(x=>x.userData.expressId===a.selectedObject.expressId),box=new T.Box3();for(const m of meshes)box.union(new T.Box3().setFromObject(m));return {key:a.s.selectionRequest.target.key,worldBox:{min:box.min.toArray(),max:box.max.toArray()},matrices:meshes.map(m=>m.matrixWorld.toArray()),props:document.querySelector('#props-drawer-body')?.textContent,renderer:{...a.ctx.world.renderer.three.info.render},heartbeat:a.heartbeat,inputs:a.inputs,adaptive:p.farViewDiagnostic()}})()`);
    result.secondObject=await evaluate(`(async()=>{const a=window.__geo,p=a.p,T=a.T,shape=p.data.shapes.find(x=>x.object.expressId===68826);if(!shape)throw Error('Independently audited four-opening plate missing');const object=shape.object,request=a.s.beginSelection({kind:'ifc-object',key:object.key});
      const started=performance.now();await(await import('/src/services/ifcPreviewService.ts')).selectIfcPreview(a.ctx,a.s,p,object,request);const propertiesMs=performance.now()-started;await p.loadObjectFine(object);
      const fineMs=performance.now()-started-propertiesMs;p.highlight(object);const c=new T.Box3();for(const m of p.root.children.filter(m=>m.userData.expressId===object.expressId))c.union(new T.Box3().setFromObject(m));
      const g=a.m.previewShapeGeometry(shape,shape.profile?1:0,p.data.origin),b=new T.Box3().setFromBufferAttribute(g.getAttribute('position')).applyMatrix4(p.root.matrix);g.dispose();
      const center=c.getCenter(new T.Vector3()),radius=Math.max(c.getSize(new T.Vector3()).length()*3,.5);await a.ctx.world.camera.controls.setLookAt(center.x+radius,center.y+radius,center.z+radius,...center.toArray(),false);
      return {object,propertiesMs,fineMs,sourceOpeningCount:4,diagnostic:p.root.userData.objectFineDiagnostic,events:p.root.userData.objectFineEvents,previewBox:{min:b.min.toArray(),max:b.max.toArray()},fineBox:{min:c.min.toArray(),max:c.max.toArray()},requestId:request.id};})()`);
    await screenshot('near-four-openings-fine');
  }
}catch(error){result.failure=String(error);console.error(result.failure);}finally{
  result.release=await evaluate(`(()=>{const a=window.__geo;if(!a)return null;clearInterval(a.timer);a.status='released';a.s.activateProject(null,null);return {providers:a.s.ifcPreviewProviders.size,children:a.p?.root.children.length}})()`).catch(e=>({error:String(e)}));
  writeFileSync(out+label+'.json',JSON.stringify(result,null,2));ws.close();
}
if(result.failure)process.exitCode=1;
