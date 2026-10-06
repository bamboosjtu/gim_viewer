import { beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';
import { nestedPartFixture } from './nestedPartIndexFixture.js';

const runtime = vi.hoisted(() => ({ ctx: null as any }));
vi.mock('../../viewer/viewerRuntime.js', () => ({ getViewerRuntime: async () => ({ctx:runtime.ctx}) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve=r; });
  return { promise, resolve };
}
function node(name: string, x=0): CbmNode {
  const matrix = new THREE.Matrix4().makeTranslation(x,0,0).toArray();
  return { path:`CBM/${name}.cbm`,name,entityName:'F4System',children:[],famPath:'',devPath:`${name}.dev`,
    ifcFile:'',ifcGuid:'',classifyName:'',transformMatrix:matrix.join(','),systemNames:[],devSymbolName:'',devType:'',devExpanded:false };
}
function fixture() {
  const state=new AppState(), a=node('A',10000), b=node('B',20000);
  state.currentCbmTree={...node('project'),entityName:'F3System',devPath:'',children:[a,b]};
  state.currentFiles=new Map(Object.entries({
    'DEV/A.dev':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.phm',
    'DEV/B.dev':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.phm',
    'PHM/leaf.phm':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.mod',
    'MOD/leaf.mod':'<Device><Entities><Entity ID="1" Visible="true"><Cuboid L="100" W="100" H="100"/></Entity></Entities></Device>',
  }).map(([p,text]) => [p,new File([text],p)]));
  return {state,a,b};
}
beforeEach(() => {
  vi.resetModules();
  HTMLElement.prototype.scrollIntoView=vi.fn();
  document.body.innerHTML='<div id="viewport"><canvas></canvas></div><button id="btn-toggle-props"></button><button id="btn-close-props"></button><button id="btn-export-props"></button><aside id="props-drawer"><div id="props-drawer-body"></div></aside><div id="cbm-tree-panel"></div><div id="file-dev-panel"></div><div id="sld-panel"></div><span id="status-selection">未选中</span>';
  const camera={ target:new THREE.Vector3(),position:new THREE.Vector3(),
    setLookAt:vi.fn(async (x:number,y:number,z:number,tx:number,ty:number,tz:number) => { camera.position.set(x,y,z);camera.target.set(tx,ty,tz); }),
    stop:vi.fn(),getPosition:(v:THREE.Vector3) => v.copy(camera.position),getTarget:(v:THREE.Vector3) => v.copy(camera.target) };
  runtime.ctx={ world:{ scene:{three:new THREE.Scene()},camera:{controls:camera} },
    fragments:{list:new Map(),resetHighlight:vi.fn(async () => {}),highlight:vi.fn(async () => {}),core:{update:vi.fn()} } };
});

it('nested parent → child selections share the physical root load while the child owns the final commit', async () => {
  const {files,tree,root,a,b}=await nestedPartFixture(2);
  const state=new AppState(); state.currentFiles=files; state.currentCbmTree=tree;
  const source=files.get('DEV/root.dev')!,read=deferred<ArrayBuffer>(),started=deferred<void>();
  let reads=0;
  files.set('DEV/root.dev',{text:()=>source.text(),arrayBuffer:()=>{reads++;started.resolve();return read.promise;}} as File);
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  const slow=handleNodeClick(state,a,()=>{}); await started.promise;
  const latest=handleNodeClick(state,b,()=>{});
  expect(reads).toBe(1);
  read.resolve(await source.arrayBuffer()); await Promise.all([slow,latest]);
  expect(state.selectionRequest?.target?.key).toBe(b.path);
  expect(document.querySelector('.props-header')?.textContent).toBe(b.name);
  expect(state.highlightedModState?.groups.map(g=>g.userData.assemblyPath).sort()).toEqual(['sub:0/sub:0','sub:1/sub:0']);
  expect([...state.loadedXmlModGroups.values()].every(g=>g.userData.rootOccurrence===root.path)).toBe(true);
  const count=state.loadedXmlModGroups.size;
  await handleNodeClick(state,b,()=>{});
  expect(state.loadedXmlModGroups.size).toBe(count);
});

it('A slow FAM cannot replace B inspector after B has rendered', async () => {
  const {state,a,b}=fixture(), read=deferred<string>(),started=deferred<void>(); a.famPath='slow.fam';
  state.currentFiles!.set('CBM/slow.fam',{text:() => { started.resolve();return read.promise; }} as File);
  const drawer=await import('../../ui/propsDrawer.js');
  const pending=drawer.showNodePropertiesBasic(state,a); await started.promise;
  await drawer.showNodePropertiesBasic(state,b);
  read.resolve('[设计参数]\n材质=材质=旧A'); await pending;
  expect(document.querySelector('.props-header')!.textContent).toBe('B');
  expect(document.getElementById('status-selection')!.textContent).toBe('B');
});

it('A slow geometry remains a resource but cannot reclaim B camera or material highlight', async () => {
  const {state,a,b}=fixture(),read=deferred<ArrayBuffer>(),started=deferred<void>();
  const source=state.currentFiles!.get('DEV/A.dev')!;
  state.currentFiles!.set('DEV/A.dev',{text:() => source.text(),arrayBuffer:() => { started.resolve();return read.promise; }} as File);
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  const messages:string[]=[];
  const pending=handleNodeClick(state,a,(text) => messages.push(`A: ${text}`)); await started.promise;
  await handleNodeClick(state,b,(text) => messages.push(`B: ${text}`));
  const target=runtime.ctx.world.camera.controls.target.clone();
  const committedMessages=[...messages],committedMessage=state.selectionMessage;
  read.resolve(await source.arrayBuffer()); await pending;
  expect(state.loadedXmlModGroups.size).toBe(2);
  expect(state.highlightedModState?.groups.every((g) => g.userData.rootOccurrence===b.path)).toBe(true);
  expect(runtime.ctx.world.camera.controls.target).toEqual(target);
  expect(document.querySelector('.props-header')!.textContent).toBe('B');
  expect(messages).toEqual(committedMessages);expect(state.selectionMessage).toBe(committedMessage);
  expect(state.selectionRequest!.target!.key).toBe(b.path);
});

it('selecting unsupported B clears A highlight, preserves geometry and camera, and shows B', async () => {
  const {state,a,b}=fixture();
  state.currentFiles!.set('DEV/B.dev',new File(['SOLIDMODELS.NUM=0'],'B.dev'));
  state.geometryDiagnosticsByDevPath.set('dev/b.dev',{devPath:'DEV/B.dev',status:'unsupported',source:'warm',reason:'parser-unsupported',unsupportedPrimitiveTypeCounts:{Unknown:1}});
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  await handleNodeClick(state,a,() => {});
  const count=state.loadedXmlModGroups.size, target=runtime.ctx.world.camera.controls.target.clone();
  await handleNodeClick(state,b,() => {});
  expect(state.highlightedModState).toBeNull();
  expect(state.loadedXmlModGroups.size).toBe(count);
  expect(runtime.ctx.world.camera.controls.target).toEqual(target);
  expect(document.querySelector('.props-header')!.textContent).toBe('B');
  expect(document.body.textContent).toContain('当前解析器不支持');
});

it.each(['empty','failed','partial'] as const)('A → %s B uses the known diagnostic without framing an empty box', async (status) => {
  const {state,a,b}=fixture();
  if (status!=='partial') state.currentFiles!.set('DEV/B.dev',new File(['SOLIDMODELS.NUM=0'],'B.dev'));
  else {
    state.currentFiles!.set('DEV/B.dev',new File(['SOLIDMODELS.NUM=1\nSOLIDMODEL0=partial.phm'],'B.dev'));
    state.currentFiles!.set('PHM/partial.phm',new File(['SOLIDMODELS.NUM=1\nSOLIDMODEL0=partial.mod'],'partial.phm'));
    state.currentFiles!.set('MOD/partial.mod',new File(['<Device><Entities><Entity ID="1" Visible="true"><Cuboid L="100" W="100" H="100"/></Entity><Entity ID="2" Visible="true"><Unknown/></Entity></Entities></Device>'],'partial.mod'));
  }
  state.geometryDiagnosticsByDevPath.set('dev/b.dev',{devPath:'DEV/B.dev',status,source:'cold',reason:status==='failed'?'parse-failed':undefined,unsupportedPrimitiveTypeCounts:{},detail:`known-${status}`});
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  await handleNodeClick(state,a,() => {});
  const target=runtime.ctx.world.camera.controls.target.clone();
  await handleNodeClick(state,b,() => {});
  expect(state.selectionRequest!.target!.key).toBe(b.path);
  expect(state.selectionGeometry!.status).toBe(status);
  expect(document.querySelector('.props-header')!.textContent).toBe('B');
  if (status!=='partial') expect(document.body.textContent).toContain(`known-${status}`);
  else expect(document.body.textContent).toContain('部分来源或 primitive 暂不支持');
  if (status==='partial') expect(state.highlightedModState!.groups.every((g) => g.userData.rootOccurrence===b.path)).toBe(true);
  else { expect(state.highlightedModState).toBeNull();expect(runtime.ctx.world.camera.controls.target).toEqual(target); }
});

it('file-level IFC B stays a semantic selection without inventing a GUID or another template instance', async () => {
  const {state,a,b}=fixture(); b.devPath='';b.ifcFile='model.ifc';
  state.currentIfcEntries=[{modelId:'model',name:'model',path:'CBM/model.ifc'}];state.loadedModels.set('model',{modelId:'model',runtimeModelId:'model',visible:true});
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  await handleNodeClick(state,a,() => {});
  const target=runtime.ctx.world.camera.controls.target.clone();
  await handleNodeClick(state,b,() => {});
  expect(state.selectionGeometry!.status).toBe('file-only');
  expect(state.highlightedModState).toBeNull();expect(state.highlightedItems).toBeNull();
  expect(runtime.ctx.world.camera.controls.target).toEqual(target);
  expect(document.body.textContent).toContain('没有直接对象 GUID 关联');expect(b.ifcGuid).toBe('');
});

it('slow FAM read cannot commit after project replacement or an explicit cancellation', async () => {
  const {state,a,b}=fixture(),read=deferred<string>(),started=deferred<void>();a.famPath='slow.fam';a.devPath='';
  state.currentFiles!.set('CBM/slow.fam',{text:() => {started.resolve();return read.promise;}} as File);
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  const pending=handleNodeClick(state,a,() => {});await started.promise;
  state.activateProject(2,'new-project');b.devPath='';
  await handleNodeClick(state,b,() => {});
  read.resolve('[设计参数]\nName=Old A');await pending;
  expect(document.querySelector('.props-header')!.textContent).toBe('B');
  const request=state.beginSelection(null);
  expect(state.isCurrentSelection(request)).toBe(true);expect(state.selectionRequest!.target).toBeNull();
});

it('reversed PARTINDEX children share one in-flight root load but only the last part commits UI', async () => {
  const {state}=fixture();
  const {buildCbmTree}=await import('../../gim/cbmParser.js');
  for (const [path,text] of Object.entries({
    'CBM/project.cbm':'ENTITYNAME=F3System\nSUBSYSTEMS.NUM=1\nSUBSYSTEM0=root.cbm',
    'CBM/root.cbm':'ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev\nSUBDEVICES.NUM=2\nSUBDEVICE0=b.cbm\nSUBDEVICE1=a.cbm',
    'CBM/a.cbm':'ENTITYNAME=PARTINDEX\nSYSTEMNAME1=Part A\nOBJECTMODELPOINTER=a.dev',
    'CBM/b.cbm':'ENTITYNAME=PARTINDEX\nSYSTEMNAME1=Part B\nOBJECTMODELPOINTER=b.dev',
    'DEV/root.dev':'SUBDEVICES.NUM=2\nSUBDEVICE0=a.dev\nSUBDEVICE1=b.dev\nTRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,20000,0,0,1',
    'DEV/a.dev':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.phm','DEV/b.dev':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.phm',
  })) state.currentFiles!.set(path,new File([text],path));
  state.currentCbmTree=(await buildCbmTree(state.currentFiles!))!;
  const source=state.currentFiles!.get('DEV/root.dev')!,read=deferred<ArrayBuffer>(),started=deferred<void>();
  const bytes=vi.fn(() => {started.resolve();return read.promise;});
  state.currentFiles!.set('DEV/root.dev',{text:() => source.text(),arrayBuffer:bytes} as unknown as File);
  const root=state.currentCbmTree.children[0],a=root.children[1],b=root.children[0];
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  const token=state.geometryLoadToken;
  const pendingA=handleNodeClick(state,a,() => {});await started.promise;
  const pendingB=handleNodeClick(state,b,() => {});
  expect(state.selectionRequest!.target!.key).toBe(b.path);expect(bytes).toHaveBeenCalledTimes(1);
  read.resolve(await source.arrayBuffer());await Promise.all([pendingA,pendingB]);
  expect(state.highlightedModState!.groups.map((g) => g.userData.assemblyPath)).toEqual(['sub:1']);
  expect(document.querySelector('.props-header')!.textContent).toBe('Part B');
  expect(runtime.ctx.world.camera.controls.target.x).toBeCloseTo(20);
  expect(state.geometryLoadToken).toBe(token);
  const count=state.loadedXmlModGroups.size;
  await handleNodeClick(state,b,() => {});expect(state.loadedXmlModGroups.size).toBe(count);
  const {resetModHighlight}=await import('../../viewer/highlight.js');resetModHighlight(state);
  for (const group of state.loadedXmlModGroups.values()) group.traverse((o) => {
    const mesh=o as THREE.Mesh;if (mesh.isMesh) expect((mesh.material as THREE.MeshStandardMaterial).emissiveIntensity).not.toBe(0.8);
  });
});

it('an unlinked PARTINDEX clears A and never falls back to global DEV matching', async () => {
  const {state,a,b}=fixture();b.entityName='PARTINDEX';b.devPath=a.devPath;
  // B is a semantic child of a different root which has no child assembly.
  const owner=node('Owner');owner.children=[b];state.currentFiles!.set('DEV/Owner.dev',new File(['SUBDEVICES.NUM=0'],'Owner.dev'));
  state.currentCbmTree!.children=[a,owner];
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  await handleNodeClick(state,a,() => {});const target=runtime.ctx.world.camera.controls.target.clone();
  await handleNodeClick(state,b,() => {});
  expect(state.selectionGeometry!.status).toBe('unlinked');expect(state.highlightedModState).toBeNull();
  expect(runtime.ctx.world.camera.controls.target).toEqual(target);
});

it('an already-started IFC reset completes before the latest MOD apply, without resetting B afterwards', async () => {
  const {state,a,b}=fixture(),reset=deferred<void>(),started=deferred<void>();
  state.highlightedItems={old:[1]};
  runtime.ctx.fragments.resetHighlight.mockImplementationOnce(() => {started.resolve();return reset.promise;});
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  const pendingA=handleNodeClick(state,a,() => {});await started.promise;
  const pendingB=handleNodeClick(state,b,() => {});
  reset.resolve();await Promise.all([pendingA,pendingB]);
  expect(state.highlightedModState!.groups.every((g) => g.userData.rootOccurrence===b.path)).toBe(true);
  expect(runtime.ctx.world.camera.controls.target.x).toBeCloseTo(20);
  expect(runtime.ctx.fragments.resetHighlight).toHaveBeenCalledTimes(1);
});

it('a pending camera operation is replaced when B selects, and cannot jump back after release', async () => {
  const {state,a,b}=fixture(),movement=deferred<void>(),started=deferred<void>();
  const controls=runtime.ctx.world.camera.controls;
  let generation=0;
  controls.setLookAt.mockImplementation((x:number,y:number,z:number,tx:number,ty:number,tz:number) => {
    const owned=++generation;
    if (owned===1) {started.resolve();return movement.promise.then(() => {if (owned===generation) controls.target.set(tx,ty,tz);});}
    controls.target.set(tx,ty,tz);controls.position.set(x,y,z);return Promise.resolve();
  });
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  const pendingA=handleNodeClick(state,a,() => {});await started.promise;
  await handleNodeClick(state,b,() => {});movement.resolve();await pendingA;
  expect(controls.stop).toHaveBeenCalledTimes(1);expect(controls.target.x).toBeCloseTo(20);
  expect(state.highlightedModState!.groups.every((g) => g.userData.rootOccurrence===b.path)).toBe(true);
});

function spatialFixture(state:AppState) {
  return import('../../gim/ifcSpatialParser.js').then(({buildSubstationSpatialIndexFromTexts}) => {
    const entry={modelId:'model',name:'model',path:'CBM/model.ifc'};
    state.currentIfcEntries=[entry];state.ifcRuntimeModelIds.set('model','model');
    state.substationSpatialIndex=buildSubstationSpatialIndexFromTexts([{entry,text:[
      "#1=IFCPROJECT('p',#99,'Project',$,$,$,$,(#2),$);",
      "#2=IFCSITE('s',#99,'Site',$,$,$,$,$,.ELEMENT.,$,$,0.,$,$);",
      "#10=IFCWALL('guid-B',#99,'IFC B',$,$,$,$,$,$);",
      "#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));",
      "#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('r2',#99,$,$,(#10),#2);",
    ].join('\n')}],state.currentCbmTree!);
    return state.substationSpatialIndex;
  });
}

it('functional tree A → spatial IFC B keeps B row and inspector after A FAM completes', async () => {
  const {state,a}=fixture(),fam=deferred<string>(),started=deferred<void>();a.famPath='slow.fam';
  state.currentProjectType='substation';state.substationNavMode='functional';
  state.currentFiles!.set('CBM/slow.fam',{text:() => {started.resolve();return fam.promise;}} as File);
  const index=await spatialFixture(state),object=index.objects[0];
  const {createNodeClickHandler}=await import('../substationRuntime.js');
  const {buildAndRenderCbmTree}=await import('../../ui/cbmTreeView.js');
  buildAndRenderCbmTree(state,createNodeClickHandler(state,() => {}));
  const {revealFunctionalSearchTarget,buildFunctionalDomainIndex}=await import('../../ui/substationFunctionalTreeView.js');
  const rowKey=revealFunctionalSearchTarget(buildFunctionalDomainIndex(state.currentCbmTree!),a.path)!;
  document.querySelector<HTMLElement>(`[data-node-path="${rowKey}"]`)!.click();await started.promise;
  const modes=[...document.querySelectorAll<HTMLButtonElement>('.substation-nav-mode-btn')];
  modes.find((button) => button.textContent==='空间')!.click();
  const {revealSpatialSearchTarget}=await import('../../ui/substationSpatialTreeView.js');revealSpatialSearchTarget(index,object.key);
  document.querySelector<HTMLElement>(`[data-node-path="${object.key}"]`)!.click();
  await vi.waitFor(() => expect(document.querySelector('.props-header')!.textContent).toBe('IFC B'));
  fam.resolve('[设计参数]\nName=Old A');
  await vi.waitFor(() => expect(state.loadedXmlModGroups.size).toBe(1));
  expect(state.selectionRequest!.target).toEqual({kind:'ifc-object',key:object.key});
  expect(document.querySelector('.tree-row.selected')?.getAttribute('data-node-path')).toBe(object.key);
  expect(state.highlightedModState).toBeNull();expect(document.querySelector('.props-header')!.textContent).toBe('IFC B');
  const id=state.selectionRequest!.id;buildAndRenderCbmTree(state,createNodeClickHandler(state,() => {}));
  expect(state.selectionRequest!.id).toBe(id);expect(document.querySelector('.tree-row.selected')?.getAttribute('data-node-path')).toBe(object.key);
});

it.each([false,true])('a spatial IFC second render loses ownership to B; project replacement = %s', async (replaceProject) => {
  const {state,b}=fixture(),data=deferred<any[]>(),started=deferred<void>();
  const index=await spatialFixture(state),object=index.objects[0];
  runtime.ctx.fragments.list.set('model',{getLocalIdsByGuids:async () => [10],getItemsData:() => {started.resolve();return data.promise;}});
  const drawer=await import('../../ui/propsDrawer.js');drawer.setupPropsDrawer(runtime.ctx);
  const {handleSpatialSelection,handleNodeClick}=await import('../nodeInteractionService.js');
  const pending=handleSpatialSelection(state,object,index,state.beginSelection({kind:'ifc-object',key:object.key}));
  await started.promise;if (replaceProject) state.activateProject(2,'next');b.devPath='';
  await handleNodeClick(state,b,() => {});data.resolve([{Name:{value:'Old IFC'}}]);await pending;
  expect(document.querySelector('.props-header')!.textContent).toBe('B');expect(document.body.textContent).not.toContain('Old IFC');
});

it('search selection wins before lazy imports and a slow 3D raycast cannot steal it', async () => {
  const {state,b}=fixture(),ray=deferred<any>(),started=deferred<void>();state.initialized=true;
  runtime.ctx.fragments.list.set('model',{getGuidsByLocalIds:async () => ['guid'],getItemsData:async () => []});
  runtime.ctx.fragments.raycast=vi.fn(() => {started.resolve();return ray.promise;});
  const {getViewerRuntimeWithUI}=await import('../viewerUIBinding.js');await getViewerRuntimeWithUI(state,() => {});
  document.querySelector<HTMLCanvasElement>('canvas')!.click();await started.promise;
  const {createNodeClickHandler}=await import('../substationRuntime.js');
  const {buildAndRenderCbmTree}=await import('../../ui/cbmTreeView.js');state.currentProjectType='substation';state.substationNavMode='functional';
  buildAndRenderCbmTree(state,createNodeClickHandler(state,() => {}));
  const input=document.querySelector<HTMLInputElement>('[role="combobox"]')!;input.value='B';input.dispatchEvent(new Event('input'));
  const option=[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent!.startsWith('B'))!;option.click();
  expect(state.selectionRequest!.target).toEqual({kind:'cbm',key:b.path});
  await vi.waitFor(() => expect(state.highlightedModState?.groups[0]?.userData.rootOccurrence).toBe(b.path));
  ray.resolve({localId:10,fragments:{modelId:'model'}});
  await ray.promise;
  expect(state.selectionRequest!.target!.key).toBe(b.path);expect(document.querySelector('.props-header')!.textContent).toBe('B');
  expect(runtime.ctx.fragments.highlight).not.toHaveBeenCalled();
});

it('an in-flight 3D IFC apply is reset before B, and blank viewport cancellation clears inspector and selection', async () => {
  const {state,b}=fixture(),apply=deferred<void>(),started=deferred<void>();state.initialized=true;
  let visibleIfc:any=null;
  runtime.ctx.fragments.list.set('model',{getGuidsByLocalIds:async () => ['guid'],getItemsData:async () => []});
  runtime.ctx.fragments.raycast=vi.fn(async () => ({localId:10,fragments:{modelId:'model'}}));
  runtime.ctx.fragments.highlight.mockImplementationOnce(async (_style:any,items:any) => {started.resolve();await apply.promise;visibleIfc=items;});
  runtime.ctx.fragments.resetHighlight.mockImplementation(async () => {visibleIfc=null;});
  const {getViewerRuntimeWithUI}=await import('../viewerUIBinding.js');await getViewerRuntimeWithUI(state,() => {});
  document.querySelector<HTMLCanvasElement>('canvas')!.click();await started.promise;
  const {handleNodeClick}=await import('../nodeInteractionService.js');const pending=handleNodeClick(state,b,() => {});
  apply.resolve();await pending;
  expect(visibleIfc).toBeNull();expect(state.highlightedItems).toBeNull();
  expect(state.highlightedModState!.groups.every((g) => g.userData.rootOccurrence===b.path)).toBe(true);
  const target=runtime.ctx.world.camera.controls.target.clone();
  runtime.ctx.fragments.raycast.mockResolvedValueOnce(null);document.querySelector<HTMLCanvasElement>('canvas')!.click();
  await vi.waitFor(() => expect(state.highlightedModState).toBeNull());
  expect(state.selectionRequest!.target).toBeNull();expect(document.body.textContent).toContain('尚未选择对象');
  expect(runtime.ctx.world.camera.controls.target).toEqual(target);
});

it('SLD topology A → 3D B invalidates A properties and the previous topology highlight', async () => {
  const {state,a}=fixture(),fam=deferred<string>(),started=deferred<void>();state.initialized=true;a.famPath='slow.fam';a.classifyName='0TEST*001';
  state.currentFiles!.set('CBM/slow.fam',{text:() => {started.resolve();return fam.promise;}} as File);
  runtime.ctx.fragments.list.set('model',{getGuidsByLocalIds:async () => ['guid-B'],getItemsData:async () => [{Name:{value:'Picked B'}}]});
  runtime.ctx.fragments.raycast=vi.fn(async () => ({localId:10,fragments:{modelId:'model'}}));
  const {getViewerRuntimeWithUI}=await import('../viewerUIBinding.js');await getViewerRuntimeWithUI(state,() => {});
  const {parseStd}=await import('../../gim/stdParser.js');
  state.currentStdDoc=parseStd('<STD><Substation name="Station"><VoltageLevel name="10kV"><Bay name="A" gridId="A0TEST*001"/></VoltageLevel></Substation></STD>');
  const {buildStdSldIndex}=await import('../../gim/stdSldIndex.js');
  state.currentStdSldIndex=buildStdSldIndex(state.currentCbmTree,state.currentStdDoc,null);
  const {setupSldGridIdInteraction}=await import('../substationRuntime.js');await setupSldGridIdInteraction(state,() => {},state.captureProjectSession());
  const {renderSldView}=await import('../../ui/sldView.js');renderSldView(state);
  [...document.querySelectorAll<HTMLButtonElement>('#sld-panel button')].find((button) => button.textContent!.includes('拓扑'))!.click();
  [...document.querySelectorAll<HTMLElement>('.sld-topo-item')].find((item) => item.textContent!.includes('A0TEST*001'))!.click();
  await started.promise;document.querySelector<HTMLCanvasElement>('canvas')!.click();
  await vi.waitFor(() => expect(state.highlightedItems).not.toBeNull());
  fam.resolve('[设计参数]\nName=Old A');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Picked B'));
  expect(state.selectionRequest!.target).toEqual({kind:'ifc-element',key:'model:10'});
  expect(document.querySelector('.sld-topo-item.selected')).toBeNull();expect(document.querySelector('.props-header')!.textContent).toBe('IFC 构件');
});

it('a resource helper from an old session cannot create a new user selection', async () => {
  const {state,a,b}=fixture(),old=state.captureProjectSession();state.activateProject(3,'replacement');
  const request=state.beginSelection({kind:'cbm',key:b.path});
  const {loadModStlForNode,frameAndHighlightDevice}=await import('../nodeInteractionService.js');
  await loadModStlForNode(state,a,() => {},old);
  await frameAndHighlightDevice(runtime.ctx,state,a.devPath,{rootOccurrence:a.path},old);
  expect(state.selectionRequest).toBe(request);expect(state.loadedXmlModGroups.size).toBe(0);
});

it.each(['empty','unsupported','failed'] as const)('raw %s is classified from traversal/loader evidence, not a guessed empty', async (expected) => {
  const {state,a,b}=fixture();
  if (expected==='empty') state.currentFiles!.set('DEV/B.dev',new File(['SOLIDMODELS.NUM=0'],'B.dev'));
  if (expected==='unsupported') state.currentFiles!.set('MOD/leaf.mod',new File(['<Device><Entities><Entity ID="1" Visible="true"><Unknown/></Entity></Entities></Device>'],'leaf.mod'));
  if (expected==='failed') state.currentFiles!.set('DEV/B.dev',new File(['SOLIDMODELS.NUM=1\nSOLIDMODEL0=missing.phm'],'B.dev'));
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  if (expected!=='unsupported') await handleNodeClick(state,a,() => {});
  const target=runtime.ctx.world.camera.controls.target.clone();
  await handleNodeClick(state,b,() => {});
  expect(state.selectionGeometry!.status).toBe(expected);expect(state.highlightedModState).toBeNull();
  expect(runtime.ctx.world.camera.controls.target).toEqual(target);expect(document.querySelector('.props-header')!.textContent).toBe('B');
});

it('a declared DEV reference to an empty PHM is empty without falsely claiming DEV has no SOLIDMODEL', async () => {
  const {state,a,b}=fixture();
  state.currentFiles!.set('DEV/B.dev',new File(['SOLIDMODELS.NUM=1\nSOLIDMODEL0=empty.phm'],'B.dev'));
  state.currentFiles!.set('PHM/empty.phm',new File(['SOLIDMODELS.NUM=0'],'empty.phm'));
  const {handleNodeClick}=await import('../nodeInteractionService.js');
  await handleNodeClick(state,a,() => {});
  const target=runtime.ctx.world.camera.controls.target.clone();
  await handleNodeClick(state,b,() => {});
  expect(state.selectionGeometry!.status).toBe('empty');
  const {getGeometryDiagnostic}=await import('../../gim/geometry/geometryDiagnostics.js');
  const diagnostic=getGeometryDiagnostic(state,b.devPath);
  expect(diagnostic?.status).toBe('empty');
  expect(diagnostic?.reason).toBeUndefined();
  expect(state.highlightedModState).toBeNull();
  expect(runtime.ctx.world.camera.controls.target).toEqual(target);
  expect(document.querySelector('.props-header')!.textContent).toBe('B');
});
