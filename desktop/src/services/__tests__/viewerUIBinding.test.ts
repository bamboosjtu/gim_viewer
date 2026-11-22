import {beforeEach,it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
const mocks=vi.hoisted(()=>({get:vi.fn(),selection:vi.fn(),drawer:vi.fn(),disposeDrawer:vi.fn(),disposeSelection:vi.fn(),historyDispose:vi.fn(),resetVisibility:vi.fn(),sync:vi.fn(),fragmentPick:vi.fn(async()=>true),regionalPick:vi.fn(async()=>true)}));
vi.mock('../../viewer/viewerRuntime.js',()=>({getViewerRuntime:mocks.get}));
vi.mock('../../viewer/viewerEngine.js',()=>({createViewerEngine:vi.fn()}));
vi.mock('../../viewer/selection.js',()=>({setupSelection:mocks.selection}));
vi.mock('../../viewer/viewHistory.js',()=>({ViewerViewHistory:class {dispose=mocks.historyDispose;}}));
vi.mock('../selectionVisibility.js',()=>({createSelectionVisibility:()=>({reset:mocks.resetVisibility,registerModel:vi.fn(),removeModel:vi.fn()})}));
vi.mock('../selectionNavigation.js',()=>({syncSelectionNavigation:mocks.sync}));
vi.mock('../engineeringViewportSelection.js',()=>({selectEngineeringFragmentPick:mocks.fragmentPick,selectEngineeringIfcPick:mocks.regionalPick}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();mocks.get.mockResolvedValue({ctx:{fragments:{list:new Map()}}});mocks.drawer.mockReturnValue(mocks.disposeDrawer);mocks.selection.mockReturnValue(mocks.disposeSelection);});
async function prepare() {
  const {bindViewerPresentation}=await import('../viewerPresentationPort.js');
  const port={bindProperties:mocks.drawer,showElement:vi.fn(),showRegional:vi.fn(),addModel:vi.fn(),removeModel:vi.fn()};
  bindViewerPresentation(async()=>port);
  const {bindProjectPresentation}=await import('../projectPresentationPort.js');
  bindProjectPresentation((await import('../../ui/projectPresentation.js')).projectPresentation);
  return {port,...await import('../viewerUIBinding.js')};
}

it('prepares modules once without creating a viewer before source restoration', async () => {
  const {port, prepareViewerBindingModules, getViewerRuntimeWithUI} = await prepare();
  const {bindViewerPresentation} = await import('../viewerPresentationPort.js');
  const factory = vi.fn(async () => port);
  bindViewerPresentation(factory);
  await prepareViewerBindingModules();
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.drawer).not.toHaveBeenCalled();

  await getViewerRuntimeWithUI(new AppState());
  expect(factory).toHaveBeenCalledOnce();
  expect(mocks.get).toHaveBeenCalledOnce();
});
it('rolls back partially bound UI and state, then binds only once on retry',async()=>{
  const {getViewerRuntimeWithUI}=await prepare(),state=new AppState();
  mocks.selection.mockImplementationOnce(()=>{throw Error('selection setup');});
  await expect(getViewerRuntimeWithUI(state)).rejects.toThrow('selection setup');
  expect(mocks.disposeDrawer).toHaveBeenCalledOnce();expect(mocks.historyDispose).toHaveBeenCalledOnce();expect(mocks.resetVisibility).toHaveBeenCalledOnce();
  expect(state.viewState.viewHistory).toBeNull();expect(state.selection.selectionVisibility).toBeNull();
  const [a,b]=await Promise.all([getViewerRuntimeWithUI(state),getViewerRuntimeWithUI(state)]);
  expect(a).toBe(b);expect(mocks.drawer).toHaveBeenCalledTimes(2);expect(mocks.selection).toHaveBeenCalledTimes(2);
  expect(mocks.disposeSelection).not.toHaveBeenCalled();
});
it('retries a failed presentation load before mutating state or attaching listeners',async()=>{
  const {getViewerRuntimeWithUI}=await prepare(),{bindViewerPresentation}=await import('../viewerPresentationPort.js'),state=new AppState();
  bindViewerPresentation(async()=>{throw Error('chunk download');});
  await expect(getViewerRuntimeWithUI(state)).rejects.toThrow('chunk');expect(mocks.get).not.toHaveBeenCalled();expect(state.viewState.viewHistory).toBeNull();
  const {port}=await prepare();await getViewerRuntimeWithUI(state);expect(port.bindProperties).toHaveBeenCalledOnce();
});
it('a failed new binding preserves history and visibility resources it did not create',async()=>{
  const {getViewerRuntimeWithUI}=await prepare(),state=new AppState(),dispose=vi.fn(),reset=vi.fn();
  const history={dispose} as never,visibility={reset} as never;state.viewState.viewHistory=history;state.selection.selectionVisibility=visibility;
  mocks.selection.mockImplementationOnce(()=>{throw Error('setup');});
  await expect(getViewerRuntimeWithUI(state)).rejects.toThrow('setup');
  expect(state.viewState.viewHistory).toBe(history);expect(state.selection.selectionVisibility).toBe(visibility);expect(dispose).not.toHaveBeenCalled();expect(reset).not.toHaveBeenCalled();
});
it('routes model and selection callbacks through the prepared view and ignores stale clearing',async()=>{
  const {port,getViewerRuntimeWithUI}=await prepare(),state=new AppState(),runtime=await getViewerRuntimeWithUI(state);
  runtime.ctx.fragments.list.set('runtime-model',{} as never);
  runtime.modelCallbacks.onModelAdded?.('model','runtime-model');runtime.modelCallbacks.onModelRemoved?.('model','runtime-model');
  expect(port.addModel).toHaveBeenCalledWith(runtime.ctx,state,'model','runtime-model');expect(port.removeModel).toHaveBeenCalledWith('model');
  const args=mocks.selection.mock.calls[0],request=state.selection.beginSelection({kind:'ifc-element',key:'model:1'});
  await args[3]('model',1,request);await args[5]({modelId:'model'},{expressId:1},request);
  expect(port.showElement).toHaveBeenCalledOnce();expect(port.showRegional).toHaveBeenCalledOnce();
  document.body.innerHTML='<div id="props-drawer-body">selected</div>';args[4](request);expect(document.body.textContent).toBe('尚未选择对象');
  state.selection.beginSelection({kind:'cbm',key:'new'});document.body.textContent='new selection';args[4](request);expect(document.body.textContent).toBe('new selection');
});

it('dispatches engineering IFC hits and rejects stale results after fetching the handler',async()=>{
  const {port,getViewerRuntimeWithUI}=await prepare();
  const state=new AppState();state.currentProjectType='substation';
  const runtime=await getViewerRuntimeWithUI(state);
  const model={};runtime.ctx.fragments.list.set('runtime-model',model as never);
  const [, , , fragment, , regional]=mocks.selection.mock.calls[0];
  const request=state.selection.beginSelection({kind:'ifc-element',key:'original'});
  expect(await fragment('runtime-model',7,request)).toBe(true);
  expect(await regional({modelId:'source'},{expressId:8},request)).toBe(true);
  expect(mocks.fragmentPick).toHaveBeenCalledWith(state,'runtime-model',7,request,model);
  expect(mocks.regionalPick).toHaveBeenCalledWith(state,'source',8,request);
  const lateFragment=fragment('runtime-model',7,request),lateRegional=regional({modelId:'source'},{expressId:8},request);
  state.selection.beginSelection({kind:'ifc-element',key:'replacement'});
  await expect(Promise.all([lateFragment,lateRegional])).resolves.toEqual([true,true]);
  expect(mocks.fragmentPick).toHaveBeenCalledOnce();
  expect(mocks.regionalPick).toHaveBeenCalledOnce();
  expect(port.showElement).not.toHaveBeenCalled();
  expect(port.showRegional).not.toHaveBeenCalled();
});
