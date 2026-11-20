import {beforeEach,it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {openEquipmentProject} from '../equipmentRuntime.js';
import type {GimRuntimeOpenContext,ExtractionResult} from '../gimOpenCore.js';
import type {EquipmentPresentationPort} from '../equipmentPresentationPort.js';

const runtime=vi.hoisted(()=>({viewer:vi.fn(),lod:vi.fn(),fit:vi.fn(),hide:vi.fn(),show:vi.fn()}));
vi.mock('../viewerUIBinding.js',()=>({getViewerRuntimeWithUI:runtime.viewer}));
vi.mock('../devLodRuntime.js',()=>({startDeviceLod:runtime.lod}));
vi.mock('../../viewer/camera.js',()=>({fitCameraToScene:runtime.fit}));
vi.mock('../../features/substation/presentation/substationPresentation.js',()=>({createNodeClickHandler:()=>vi.fn()}));
vi.mock('../gimOpenCore.js',()=>({showLoading:runtime.show,hideLoading:runtime.hide}));

function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};
}
function inputs():Map<string,File> {
  return new Map([['unit.cbm',new File(['ENTITYNAME=Device\nOBJECTMODELPOINTER=unit.dev'],'unit.cbm')],['unit.dev',new File(['SYMBOLNAME=Unit\nSOLIDMODELS.NUM=0'],'unit.dev')]]);
}
function fixture() {
  const state=new AppState(),session=state.activateProject(1,'a'),dispose=vi.fn();
  const presentation={navigation:vi.fn((_input:Parameters<EquipmentPresentationPort['navigation']>[0])=>dispose),deviceStatus:vi.fn()} satisfies EquipmentPresentationPort;
  const context:GimRuntimeOpenContext={state,session,projectId:1,projectName:'Unit',projectTypeName:'设备',
    source:{} as GimRuntimeOpenContext['source'],showMessage:vi.fn(),getExtracted:async()=>({status:'ok',magic:'GIMPKGS',files:inputs()})};
  return {state,session,context,presentation,dispose};
}
beforeEach(()=>{vi.clearAllMocks();runtime.viewer.mockResolvedValue({ctx:{}});runtime.lod.mockResolvedValue({});});

it('publishes extracted equipment through the port and owns its navigation until replacement',async()=>{
  const {state,context,presentation,dispose}=fixture();
  await openEquipmentProject(context,presentation);
  expect(state.currentProjectType).toBe('equipment');expect(state.currentCbmTree?.devPath).toBe('unit.dev');
  expect(state.currentIfcEntries).toEqual([]);expect(state.initialized).toBe(true);
  expect(presentation.navigation).toHaveBeenCalledOnce();expect(runtime.lod).toHaveBeenCalledOnce();
  const signal=presentation.navigation.mock.calls[0][0].signal;
  state.activateProject(2,'b');expect(signal.aborted).toBe(true);expect(dispose).toHaveBeenCalledOnce();
});

it('does not publish a delayed extraction after project replacement',async()=>{
  const {state,context,presentation}=fixture(),source=deferred<ExtractionResult>();
  context.getExtracted=()=>source.promise;
  const opening=openEquipmentProject(context,presentation);
  state.activateProject(2,'b');state.projectName='B';
  source.resolve({status:'ok',magic:'GIMPKGS',files:inputs()});await opening;
  expect(state.projectName).toBe('B');expect(state.currentFiles).toBeNull();
  expect(presentation.navigation).not.toHaveBeenCalled();expect(runtime.viewer).not.toHaveBeenCalled();
});

it('does not publish after replacement during source preparation',async()=>{
  const {state,context,presentation}=fixture(),files=inputs(),read=deferred<ArrayBuffer>();
  vi.spyOn(files.get('unit.cbm')!,'arrayBuffer').mockReturnValue(read.promise);
  context.getExtracted=async()=>({status:'ok',magic:'GIMPKGS',files});
  const opening=openEquipmentProject(context,presentation);
  await vi.waitFor(()=>expect(runtime.show).toHaveBeenCalled());
  state.activateProject(2,'b');read.resolve(new TextEncoder().encode('ENTITYNAME=Device').buffer);await opening;
  expect(state.currentCbmTree).toBeNull();expect(presentation.navigation).not.toHaveBeenCalled();
});

it('releases the published navigation while viewer creation is pending, and rejects late geometry commits',async()=>{
  const {state,context,presentation,dispose}=fixture(),viewer=deferred<{ctx:object}>();runtime.viewer.mockReturnValue(viewer.promise);
  const opening=openEquipmentProject(context,presentation);
  await vi.waitFor(()=>expect(runtime.viewer).toHaveBeenCalled());
  state.activateProject(2,'b');viewer.resolve({ctx:{}});await opening;
  expect(dispose).toHaveBeenCalledOnce();expect(runtime.lod).not.toHaveBeenCalled();expect(state.initialized).toBe(false);
  expect(state.projectSourceToViewerMatrix).toBeNull();
});

it('guards late LOD callbacks and permits recovery from a failed equipment entry',async()=>{
  const {state,context,presentation}=fixture();context.getExtracted=async()=>({status:'ok',magic:'GIMPKGS',files:new Map()});
  await expect(openEquipmentProject(context,presentation)).rejects.toThrow('入口');
  expect(presentation.navigation).not.toHaveBeenCalled();
  context.getExtracted=async()=>({status:'ok',magic:'GIMPKGS',files:inputs()});await openEquipmentProject(context,presentation);
  const status=runtime.lod.mock.calls[0][3] as (text:string)=>void;
  state.activateProject(2,'b');status('old status');
  expect(presentation.deviceStatus).not.toHaveBeenCalled();expect(runtime.fit).not.toHaveBeenCalled();
});

it('cancellation before extraction completion leaves navigation unpublished',async()=>{
  const {context,presentation}=fixture();context.getExtracted=async()=>({status:'cancelled'});
  await openEquipmentProject(context,presentation);
  expect(presentation.navigation).not.toHaveBeenCalled();expect(runtime.viewer).not.toHaveBeenCalled();
});
