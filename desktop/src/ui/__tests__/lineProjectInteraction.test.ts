import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {makeLineFixture} from '../../features/powerline/presentation/__tests__/lineNavigationFixture.js';
import { buildLineProjectProjection } from '../../features/powerline/presentation/lineProjectProjection.js';
import { perfCurrentSession } from '../../utils/perfTimings.js';
import type { LineRenderOptions } from '../../features/powerline/presentation/linePresentationPort.js';
const m=vi.hoisted(()=>({render:vi.fn(),probe:vi.fn(),mod:vi.fn(),model:vi.fn(),projection:vi.fn()}));
vi.mock('../../viewer/lineModelPreview.js',()=>({lineModelPreview:()=>({show:m.model,dispose:()=>{}})}));
vi.mock('../lineMapView.js',()=>({renderLineMap:m.render}));
vi.mock('../lineMapBaseLayer.js',()=>({createMapLibreProbe:m.probe}));
vi.mock('../../features/powerline/runtime/lineModRuntimeService.js',()=>({loadLineModSourcesForNode:m.mod}));
vi.mock('../../features/powerline/presentation/lineMapProjection.js',()=>({buildLineMapProjection:m.projection}));
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
let activeState: AppState | undefined;
beforeEach(async ()=>{
  vi.resetModules();vi.resetAllMocks();HTMLElement.prototype.scrollIntoView=vi.fn();
  document.body.innerHTML=['viewport','cbm-tree-panel','file-dev-panel','model-list','props-drawer','props-drawer-body','empty-tip','status-right'].map(id=>`<div id="${id}"></div>`).join('');
  m.mod.mockResolvedValue([]);m.probe.mockRejectedValue(Error('offline'));
  (await import('../../app/composition/presentationBindings.js')).configurePresentation();
});
afterEach(async()=>{
  activeState?.invalidatePendingLoads();
  activeState = undefined;
  (await import('../lineProjectView.js')).destroyLineMapView();
});
async function fixture(options: LineRenderOptions = {}) {
  const data=makeLineFixture(),state=new AppState();
  activeState = state;
  const scope = state.sessionScope(state.activateProject(1, 'line-a'));
  state.currentProjectType='transmission_line';
  m.projection.mockReturnValue({mapData:data.mapData,renderable:true});
  const handles:Array<Record<string,ReturnType<typeof vi.fn>>>=[];
  m.render.mockImplementation(()=>{
    const layer=document.createElement('div');document.getElementById('viewport')!.append(layer);
    const handle={fit:vi.fn(),destroy:vi.fn(()=>layer.remove()),focusTowerByNodePath:vi.fn(()=>true),focusBboxByNodePaths:vi.fn(()=>true),getLayerPanel:vi.fn(()=>layer),handlePointerMove:vi.fn(),handlePointerClick:vi.fn(),handlePointerLeave:vi.fn()};handles.push(handle);return handle;
  });
  state.currentGimGraph = data.graph;
  const projection = buildLineProjectProjection(state, data.graph, perfCurrentSession());
  const view=await import('../lineProjectView.js');
  const owner = view.renderLineProjectPanels(state,projection,vi.fn(), options);
  scope.own(() => owner.destroy());
  return {state,...data,view,handles};
}
it('links real navigation, map tower/wire selections and property references without a 3D viewer',async()=>{
  const {view,nodes,mapData,handles}=await fixture();
  const [, ,onTower,options]=m.render.mock.calls[0];onTower(nodes.tower0);expect(document.querySelector('.props-header')).not.toBeNull();expect(document.querySelector('.tree-row.selected')).not.toBeNull();
  options.onWireClick(mapData.wires[0]);expect(document.getElementById('props-drawer-body')!.textContent).toContain('导线语义');
  expect(view.handleLinePropertyReference({kind:'cbm',path:nodes.tower2.path})).toBe(true);expect(handles[0].focusTowerByNodePath).toHaveBeenCalledWith(nodes.tower2.path);
  expect(view.handleLinePropertyReference({kind:'mod',path:'missing.mod'})).toBe(true);
  for(const row of [...document.querySelectorAll<HTMLElement>('.tree-row')])row.click();
  expect(handles[0].focusBboxByNodePaths).toHaveBeenCalled();
  expect(await view.getLatestCatenaryAuditPayload()).not.toBeNull();
});
it('discards a lazily loaded audit request when its project closes',async()=>{
  const {view}=await fixture();
  const pending=view.getLatestCatenaryAuditPayload();
  view.destroyLineMapView();
  expect(await pending).toBeNull();
});
it('late MOD details cannot replace another node or a new project inspector',async()=>{
  const {view,nodes,state}=await fixture(),first=deferred<[]>(),second=deferred<[]>();
  m.mod.mockImplementation((_state, node) => node === nodes.tower0 ? first.promise : second.promise);
  view.showLineNodeProperties(nodes.tower0,state,'First');
  await vi.waitFor(() => expect(m.mod).toHaveBeenCalledWith(state, nodes.tower0));
  view.showLineNodeProperties(nodes.tower2,state,'Second');
  await vi.waitFor(() => expect(m.mod).toHaveBeenCalledWith(state, nodes.tower2));
  first.resolve([]);await new Promise(resolve => setTimeout(resolve, 0));expect(document.querySelector('.props-header')!.textContent).toBe('Second');
  state.activateProject(2, 'line-b');
  document.getElementById('props-drawer-body')!.textContent='New project';second.resolve([]);await new Promise(resolve => setTimeout(resolve, 0));expect(document.getElementById('props-drawer-body')!.textContent).toBe('New project');
});
it('isolates current MOD failure while retaining basic properties',async()=>{
  const {view,nodes,state}=await fixture();m.mod.mockRejectedValueOnce(Error('<missing MOD>'));view.showLineNodeProperties(nodes.tower0,state);
  await vi.waitFor(()=>expect(document.getElementById('props-drawer-body')!.textContent).toContain('读取线路 MOD 失败：<missing MOD>'));
});
it('destroys a late basemap after replacement and aborts its outstanding creation',async()=>{
  const delayed=deferred<unknown>();m.probe.mockReturnValue(delayed.promise);
  const {view}=await fixture();m.probe.mockReturnValueOnce(delayed.promise);
  // The deferred initial probe is still awaiting its provider when close runs.
  await vi.waitFor(()=>expect(m.probe).toHaveBeenCalled());const signal=m.probe.mock.calls[0][1].signal;
  const destroy=vi.fn();view.destroyLineMapView();expect(signal.aborted).toBe(true);delayed.resolve({destroy});await vi.waitFor(()=>expect(destroy).toHaveBeenCalledOnce());
});
it('releases overlay bridges and forwards map interactions only through the active handle',async()=>{
  const callbacks:Record<string,(arg?:never)=>void>={},offs=Array.from({length:5},()=>vi.fn()),destroy=vi.fn();let index=0;
  const probe={destroy,getMap:()=>({project:()=>({x:0,y:0}),unproject:()=>({lng:0,lat:0})}),fitBounds:vi.fn(),
    ...Object.fromEntries(['onViewChange','onViewSettled','onPointerMove','onPointerClick','onPointerLeave'].map(key=>[key,(cb:(arg?:never)=>void)=>{callbacks[key]=cb;return offs[index++];}]))};
  const observeMapFrames = vi.fn();
  m.probe.mockResolvedValue(probe);const {state,handles}=await fixture({ observeMapFrames });
  await vi.waitFor(()=>expect(m.render).toHaveBeenCalledTimes(2));
  callbacks.onPointerMove({x:1,y:2} as never);callbacks.onPointerClick({x:3,y:4} as never);callbacks.onPointerLeave();callbacks.onViewChange('resize' as never);callbacks.onViewSettled();
  expect(handles[1].handlePointerMove).toHaveBeenCalledWith(1,2);expect(handles[1].handlePointerClick).toHaveBeenCalledWith(3,4);expect(handles[1].handlePointerLeave).toHaveBeenCalledOnce();
  expect(m.probe.mock.calls[0][1].onMapCreated).toBe(observeMapFrames);
  state.activateProject(2, 'line-b');expect(destroy).toHaveBeenCalledOnce();offs.forEach(off=>expect(off).toHaveBeenCalledOnce());
});

it('opens the referenced tower from the real inspector and places the chosen height for its owner',async()=>{
 const {nodes}=await fixture(); const {parseLineMod}=await import('@gim/powerline-core');
 const path='Mod/tower.mod';m.mod.mockResolvedValue([{path,source:parseLineMod('HNum,1\nH,1000,Body1\nBody1\nP,1,0,0,0\nP,2,0,0,1000\nR,1,2,φ100X5,Q235',path)}]);
 HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
 m.render.mock.calls[0][2](nodes.tower0);
 const button=await vi.waitFor(()=>{const b=document.querySelector<HTMLButtonElement>('.props-header button');expect(b).not.toBeNull();return b!;});button.click();
 await vi.waitFor(()=>expect(m.model).toHaveBeenCalled());const h=document.querySelector<HTMLSelectElement>('dialog select[aria-label="呼高"]')!;h.value='1000';h.dispatchEvent(new Event('change'));
 const batch=m.model.mock.lastCall![0];expect(batch.objects[0].address.rootOccurrence).toBe(nodes.tower0.path);expect([...batch.templates.values()].some((x:any)=>x.kind==='mesh')).toBe(true);
 document.querySelector('dialog')!.close();
});
