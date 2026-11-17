import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import type {GimRuntimeOpenContext,ExtractionResult} from '../gimOpenCore.js';
import type {CbmNode} from '../../gim/types.js';
import {openSubstationProject,onGimExtracted} from '../substationRuntime.js';
vi.mock('../gimOpenCore.js',async original=>({...await original<typeof import('../gimOpenCore.js')>(),showLoading:vi.fn(),hideLoading:vi.fn()}));
const m=vi.hoisted(()=>({native:false,validate:vi.fn(),index:vi.fn(),restore:vi.fn(),load:vi.fn(),geometry:vi.fn(),build:vi.fn(),spatial:vi.fn(),documents:vi.fn(),render:vi.fn(),hydrate:vi.fn(),core:vi.fn(),rest:vi.fn(),cacheIfc:vi.fn(),cacheSources:vi.fn()}));
vi.mock('@desktop/runtime.js',()=>({isTauri:()=>m.native}));
vi.mock('@desktop/database.js',()=>({validateGimCache:m.validate,getGimIndex:m.index,saveGimIndex:vi.fn(),saveGeometryRefs:vi.fn(),saveSubstationSemanticRest:vi.fn()}));
vi.mock('../substationIndexPublication.js',()=>({publishSubstationCore:m.core,publishSubstationRest:m.rest}));
vi.mock('../gimExtractedCacheService.js',()=>({cacheIfcEntries:m.cacheIfc,cacheExtractedFiles:m.cacheSources}));
vi.mock('@desktop/gimExtract.js',()=>({createDiskBackedFile:(_id:number,path:string)=>new File([''],path)}));
vi.mock('../gimIndexRestoreService.js',()=>({restoreGimIndexToState:m.restore}));
vi.mock('../engineeringService.js',()=>({beginEngineeringBuild:m.build}));
vi.mock('../substationIfcRuntime.js',()=>({loadAllIfcFiles:m.load}));
vi.mock('../equipmentRuntime.js',()=>({startGeometryOnlyView:m.geometry,openEquipmentProject:m.geometry}));
vi.mock('../substationRuntimeTelemetry.js',()=>({sampleSubstationMemory:async()=>{}}));
vi.mock('../substationSpatialRuntime.js',()=>({buildAndCommitSubstationSpatialSemantic:m.spatial,commitCachedSubstationSpatialSemantic:vi.fn(),scheduleSubstationSpatialSemantic:vi.fn()}));
vi.mock('../substationDocumentRuntime.js',()=>({buildAndCommitSubstationStdSld:m.documents}));
vi.mock('../nativeSmallFileHydration.js',()=>({hydrateNativeSmallFiles:m.hydrate}));
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function files() {return new Map([
  ['project.cbm',new File(['ENTITYNAME=PROJECT\nSYSTEMNAME=Unit\nSUBSYSTEM0=unit.cbm'],'project.cbm')],
  ['unit.cbm',new File(['ENTITYNAME=F4System\nOBJECTMODELPOINTER=unit.dev'],'unit.cbm')],
  ['unit.dev',new File(['SYMBOLNAME=Unit'],'unit.dev')],
  ['model.ifc',new File(['IFC'],'model.ifc')],
]);}
function fixture() {
  const state=new AppState(),session=state.activateProject(null,'a');
  const context:GimRuntimeOpenContext={state,session,projectId:null,projectName:'A',projectTypeName:'变电',source:{} as GimRuntimeOpenContext['source'],showMessage:vi.fn(),getExtracted:vi.fn(async()=>({status:'ok' as const,magic:'GIMPKGS',files:files()}))};
  return {state,context};
}
beforeEach(async()=>{
  vi.clearAllMocks();m.native=false;m.spatial.mockResolvedValue(true);m.documents.mockResolvedValue(true);m.load.mockResolvedValue(undefined);m.geometry.mockResolvedValue(undefined);
  m.validate.mockResolvedValue({valid:true,substation_properties_complete:true});
  m.core.mockResolvedValue(true);m.rest.mockResolvedValue(true);
  m.cacheIfc.mockResolvedValue({pathMap:new Map(),errors:[]});m.cacheSources.mockResolvedValue({pathMap:new Map(),errors:[],cachedCount:4});
  m.index.mockResolvedValue({entries:[],cbm_nodes:[],ifc_models:[],file_dev_entries:[],fam_properties:[],dev_properties:[]});
  m.restore.mockImplementation((state:AppState)=>{state.currentCbmTree={path:'cached.cbm',children:[]} as unknown as CbmNode;state.currentIfcEntries=[{path:'cached.ifc',name:'cached',modelId:'cached'}];});
  const {bindProjectPresentation}=await import('../projectPresentationPort.js');
  bindProjectPresentation({renderNavigation:m.render,refreshDeviceBounds:vi.fn(),resetIdentity:vi.fn(),destroyLineView:vi.fn(),clearProjectViews:vi.fn(),clearSelection:vi.fn(),hideEmptyState:vi.fn(),expandedTreePaths:vi.fn(),restoreExpandedTree:vi.fn(),removeModelRows:vi.fn(),geometryFeedback:vi.fn(),chooseEngineeringRange:vi.fn()});
});
afterEach(()=>{vi.restoreAllMocks();});
it('cold open publishes real CBM sources before IFC and defers optional work',async()=>{
  const {state,context}=fixture();
  await openSubstationProject(context);
  expect(state.currentCbmTree?.path).toBe('project.cbm');expect(state.currentFiles?.size).toBe(4);
  expect(m.render).toHaveBeenCalledOnce();expect(m.build).toHaveBeenCalledOnce();expect(m.load).toHaveBeenCalledOnce();
  expect(m.spatial).not.toHaveBeenCalled();expect(m.documents).not.toHaveBeenCalled();
  const options=m.load.mock.calls[0][3];await options.startSpatialSemantic();await options.startStdSld();
  expect(m.spatial).toHaveBeenCalledOnce();expect(m.documents).toHaveBeenCalledOnce();
});
it('direct semantic publication retains its await contract and geometry changes keep the session alive',async()=>{
  const {state,context}=fixture();state.geometryLoadToken++;
  const entries=await onGimExtracted(state,files(),context.showMessage,'A','变电',context.session);
  expect(entries).toHaveLength(1);expect(m.spatial).toHaveBeenCalledOnce();expect(m.documents).toHaveBeenCalledOnce();
});
it('warm open restores the index without extraction and shares deferred source work',async()=>{
  const {state,context}=fixture();m.native=true;context.projectId=1;
  await openSubstationProject(context);
  expect(context.getExtracted).not.toHaveBeenCalled();expect(m.restore).toHaveBeenCalledOnce();expect(state.currentCbmTree?.path).toBe('cached.cbm');
  expect(m.render).toHaveBeenCalledOnce();expect(m.load.mock.calls[0][1][0].path).toBe('cached.ifc');
});
it.each(['validation','restore'])('falls back to the real cold path after a current %s failure',async(stage)=>{
  const {state,context}=fixture();m.native=true;context.projectId=1;
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  if(stage==='validation')m.validate.mockRejectedValueOnce(Error('cache validation'));else m.index.mockRejectedValueOnce(Error('index unavailable'));
  await openSubstationProject(context);expect(context.getExtracted).toHaveBeenCalledOnce();expect(state.currentCbmTree?.path).toBe('project.cbm');expect(warning).toHaveBeenCalled();
});
it.each(['validation','index','extraction'])('rejects a late %s result after project replacement',async(stage)=>{
  const {state,context}=fixture(),gate=deferred<unknown>();
  if(stage==='extraction')context.getExtracted=()=>gate.promise as Promise<ExtractionResult>;
  else {m.native=true;context.projectId=1;(stage==='validation'?m.validate:m.index).mockReturnValueOnce(gate.promise);}
  const opening=openSubstationProject(context);
  if(stage==='index')await vi.waitFor(()=>expect(m.index).toHaveBeenCalled());
  state.activateProject(2,'b');state.projectName='B';
  gate.resolve(stage==='validation'?{valid:true}:stage==='index'?{}:{status:'ok' as const,magic:'GIMPKGS',files:files()});await opening;
  expect(state.projectName).toBe('B');expect(state.currentCbmTree).toBeNull();expect(m.restore).not.toHaveBeenCalled();expect(m.render).not.toHaveBeenCalled();expect(m.load).not.toHaveBeenCalled();
});
it('rejects a delayed CBM read before semantic publication',async()=>{
  const {state,context}=fixture(),input=files(),read=deferred<ArrayBuffer>();
  vi.spyOn(input.get('project.cbm')!,'arrayBuffer').mockReturnValue(read.promise);
  context.getExtracted=async()=>({status:'ok' as const,magic:'GIMPKGS',files:input});
  const opening=openSubstationProject(context);await vi.waitFor(()=>expect(input.get('project.cbm')!.arrayBuffer).toHaveBeenCalled());
  state.activateProject(2,'b');read.resolve(new TextEncoder().encode('ENTITYNAME=PROJECT').buffer);await opening;
  expect(state.currentCbmTree).toBeNull();expect(m.render).not.toHaveBeenCalled();
});
it('honors explicit extraction cancellation and propagates a current failure for retry',async()=>{
  const {context}=fixture();context.getExtracted=async()=>({status:'cancelled'});await openSubstationProject(context);expect(m.render).not.toHaveBeenCalled();
  context.getExtracted=async()=>{throw Error('source unavailable');};await expect(openSubstationProject(context)).rejects.toThrow('source unavailable');
  context.getExtracted=async()=>({status:'ok' as const,magic:'GIMPKGS',files:files()});await openSubstationProject(context);expect(m.load).toHaveBeenCalledOnce();
});
it('uses geometry-only opening for a DEV project with no IFC',async()=>{
  const {context}=fixture(),input=files();input.delete('model.ifc');context.getExtracted=async()=>({status:'ok' as const,magic:'GIMPKGS',files:input});
  await openSubstationProject(context);expect(m.geometry).toHaveBeenCalledOnce();expect(m.load).not.toHaveBeenCalled();
});
it.each([true,false])('publishes the captured cold source inputs once (native cache paths = %s)',async(nativePaths)=>{
  const {context}=fixture(),input=files();m.native=true;context.projectId=1;m.validate.mockResolvedValue({valid:false});
  context.getExtracted=async()=>({status:'ok',magic:'GIMPKGS',files:input,cachePaths:nativePaths?new Map([['model.ifc','tmp/model.ifc']]):undefined});
  await openSubstationProject(context);
  const options=m.load.mock.calls[0][3];await Promise.all([options.startCachePersistence(),options.startCachePersistence()]);
  expect(m.core).toHaveBeenCalledOnce();expect(m.rest).toHaveBeenCalledOnce();expect(m.core.mock.calls[0][0].files).toBe(input);
  expect(m.core.mock.calls[0][0].sourceSha256).toBe('a');expect(m.core.mock.calls[0][1].isCurrent()).toBe(true);
  expect(m.cacheIfc).toHaveBeenCalledTimes(nativePaths?0:1);expect(m.cacheSources).toHaveBeenCalledTimes(nativePaths?0:1);
});
it('a persistence task waiting for source materialization cannot publish after replacement',async()=>{
  const {state,context}=fixture(),materialized=deferred<void>();m.native=true;context.projectId=1;m.validate.mockResolvedValue({valid:false});
  context.getExtracted=async()=>({status:'ok',magic:'GIMPKGS',files:files(),cachePaths:new Map([['model.ifc','tmp/model.ifc']]),sourceMaterialization:materialized.promise});
  await openSubstationProject(context);const pending=m.load.mock.calls[0][3].startCachePersistence();
  state.activateProject(2,'b');materialized.resolve();await pending;
  expect(m.core).not.toHaveBeenCalled();expect(m.rest).not.toHaveBeenCalled();
});
it('warm property repair preserves the warm path and owns publication callbacks',async()=>{
  const {state,context}=fixture();m.native=true;context.projectId=1;m.validate.mockResolvedValue({valid:true,substation_properties_complete:false});
  m.rest.mockImplementationOnce(async(_input,ports)=>{ports.onPublished({fam_properties:[{source_path:'unit.fam',raw_property_json:'{"key":"value"}'}]});return true;});
  await openSubstationProject(context);await vi.waitFor(()=>expect(m.rest).toHaveBeenCalledOnce());
  expect(context.getExtracted).not.toHaveBeenCalled();expect(state.cachedFamSourceProperties.get('unit.fam')).toEqual([{key:'value'}]);
  expect(m.rest.mock.calls[0][1].isCurrent()).toBe(true);state.activateProject(2,'b');expect(m.rest.mock.calls[0][1].isCurrent()).toBe(false);
});
