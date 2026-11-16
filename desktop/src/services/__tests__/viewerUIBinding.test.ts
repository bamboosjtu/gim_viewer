import {beforeEach,it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
const mocks=vi.hoisted(()=>({get:vi.fn(),selection:vi.fn(),drawer:vi.fn(),disposeDrawer:vi.fn(),disposeSelection:vi.fn(),historyDispose:vi.fn(),resetVisibility:vi.fn(),sync:vi.fn()}));
vi.mock('../../viewer/viewerRuntime.js',()=>({getViewerRuntime:mocks.get}));
vi.mock('../../viewer/selection.js',()=>({setupSelection:mocks.selection}));
vi.mock('../../viewer/viewHistory.js',()=>({ViewerViewHistory:class {dispose=mocks.historyDispose;}}));
vi.mock('../selectionVisibility.js',()=>({createSelectionVisibility:()=>({reset:mocks.resetVisibility,registerModel:vi.fn(),removeModel:vi.fn()})}));
vi.mock('../nodeInteractionService.js',()=>({syncSelectionNavigation:mocks.sync}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();mocks.get.mockResolvedValue({ctx:{fragments:{list:new Map()}}});mocks.drawer.mockReturnValue(mocks.disposeDrawer);mocks.selection.mockReturnValue(mocks.disposeSelection);});
async function prepare() {
  const {bindViewerPresentation}=await import('../viewerPresentationPort.js');
  const port={bindProperties:mocks.drawer,showElement:vi.fn(),showRegional:vi.fn(),addModel:vi.fn(),removeModel:vi.fn()};
  bindViewerPresentation(async()=>port);
  const {bindProjectPresentation}=await import('../projectPresentationPort.js');
  bindProjectPresentation((await import('../../ui/projectPresentation.js')).projectPresentation);
  return {port,...await import('../viewerUIBinding.js')};
}
it('rolls back partially bound UI and state, then binds only once on retry',async()=>{
  const {getViewerRuntimeWithUI}=await prepare(),state=new AppState();
  mocks.selection.mockImplementationOnce(()=>{throw Error('selection setup');});
  await expect(getViewerRuntimeWithUI(state)).rejects.toThrow('selection setup');
  expect(mocks.disposeDrawer).toHaveBeenCalledOnce();expect(mocks.historyDispose).toHaveBeenCalledOnce();expect(mocks.resetVisibility).toHaveBeenCalledOnce();
  expect(state.viewHistory).toBeNull();expect(state.selectionVisibility).toBeNull();
  const [a,b]=await Promise.all([getViewerRuntimeWithUI(state),getViewerRuntimeWithUI(state)]);
  expect(a).toBe(b);expect(mocks.drawer).toHaveBeenCalledTimes(2);expect(mocks.selection).toHaveBeenCalledTimes(2);
  expect(mocks.disposeSelection).not.toHaveBeenCalled();
});
it('retries a failed presentation load before mutating state or attaching listeners',async()=>{
  const {getViewerRuntimeWithUI}=await prepare(),{bindViewerPresentation}=await import('../viewerPresentationPort.js'),state=new AppState();
  bindViewerPresentation(async()=>{throw Error('chunk download');});
  await expect(getViewerRuntimeWithUI(state)).rejects.toThrow('chunk');expect(mocks.get).not.toHaveBeenCalled();expect(state.viewHistory).toBeNull();
  const {port}=await prepare();await getViewerRuntimeWithUI(state);expect(port.bindProperties).toHaveBeenCalledOnce();
});
it('a failed new binding preserves history and visibility resources it did not create',async()=>{
  const {getViewerRuntimeWithUI}=await prepare(),state=new AppState(),dispose=vi.fn(),reset=vi.fn();
  const history={dispose} as never,visibility={reset} as never;state.viewHistory=history;state.selectionVisibility=visibility;
  mocks.selection.mockImplementationOnce(()=>{throw Error('setup');});
  await expect(getViewerRuntimeWithUI(state)).rejects.toThrow('setup');
  expect(state.viewHistory).toBe(history);expect(state.selectionVisibility).toBe(visibility);expect(dispose).not.toHaveBeenCalled();expect(reset).not.toHaveBeenCalled();
});
it('routes model and selection callbacks through the prepared view and ignores stale clearing',async()=>{
  const {port,getViewerRuntimeWithUI}=await prepare(),state=new AppState(),runtime=await getViewerRuntimeWithUI(state);
  runtime.ctx.fragments.list.set('runtime-model',{} as never);
  runtime.modelCallbacks.onModelAdded?.('model','runtime-model');runtime.modelCallbacks.onModelRemoved?.('model','runtime-model');
  expect(port.addModel).toHaveBeenCalledWith(runtime.ctx,state,'model','runtime-model');expect(port.removeModel).toHaveBeenCalledWith('model');
  const args=mocks.selection.mock.calls[0],request=state.beginSelection({kind:'ifc-element',key:'model:1'});
  await args[3]('model',1,request);await args[5]({modelId:'model'},{expressId:1},request);
  expect(port.showElement).toHaveBeenCalledOnce();expect(port.showRegional).toHaveBeenCalledOnce();
  document.body.innerHTML='<div id="props-drawer-body">selected</div>';args[4](request);expect(document.body.textContent).toBe('尚未选择对象');
  state.beginSelection({kind:'cbm',key:'new'});document.body.textContent='new selection';args[4](request);expect(document.body.textContent).toBe('new selection');
});
