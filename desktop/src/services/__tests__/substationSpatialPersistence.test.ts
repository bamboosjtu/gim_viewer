// @vitest-environment node
import{beforeEach,it,expect,vi}from'vitest';
import{AppState}from'../../app/state.js';
import type{SubstationSpatialIndex}from'../../gim/ifcSpatialParser.js';
import{buildAndCommitSubstationSpatialSemantic}from'../substationSpatialRuntime.js';
import{createSpatialSemanticStarter}from'../spatialSemanticStarter.js';
import{SUBSTATION_PARSER_DOMAIN_VERSION}from'../substationSpatialCodec.js';
import{buildSubstationSpatialIndexInWorker}from'../substationSpatialWorkerClient.js';
import{writeSubstationSpatialSemanticCache}from'../substationSpatialSemanticCache.js';
import type{PerfSession}from'../../utils/perfTimings.js';
vi.mock('../substationSpatialWorkerClient.js',()=>({buildSubstationSpatialIndexInWorker:vi.fn()}));
vi.mock('../substationSpatialSemanticCache.js',()=>({readSubstationSpatialSemanticCache:vi.fn(),writeSubstationSpatialSemanticCache:vi.fn()}));
vi.mock('../engineeringService.js',()=>({notifyEngineeringIfcEvidence:vi.fn(),notifyEngineeringIfcFailure:vi.fn()}));
vi.mock('../substationRuntimeTelemetry.js',()=>({createSubstationSpatialObserver:vi.fn(),sampleSubstationMemory:vi.fn()}));
vi.mock('../substationPresentation.js',()=>({renderSubstationCoreUi:vi.fn()}));
vi.mock('../../utils/perfTimings.js',()=>({perfBegin:()=>()=>{},perfMarkProductMoment:vi.fn()}));
const index={models:[],nodes:[],objects:[],links:[],coverage:{uncontainedIfcObjects:0}}as unknown as SubstationSpatialIndex;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(buildSubstationSpatialIndexInWorker).mockResolvedValue(index);vi.mocked(writeSubstationSpatialSemanticCache).mockResolvedValue({writeMs:1,snapshotBytes:1});});
function start(state:AppState,beforeCacheWrite:Promise<void>){const session=state.captureProjectSession();return buildAndCommitSubstationSpatialSemantic(state,new Map(),[],{}as never,[],session,{}as PerfSession,()=>{},'fixture',
 {projectId:session.projectId,sourceSha256:session.sourceSha256,beforeCacheWrite});}
it('publishes the index first and persists only after the source publication barrier',async()=>{
 const state=new AppState();state.activateProject(7,'source-a');let release!:()=>void;
 const work=start(state,new Promise<void>(r=>{release=r;}));
 await vi.waitFor(()=>expect(state.substationSpatialIndex).toBe(index));expect(writeSubstationSpatialSemanticCache).not.toHaveBeenCalled();
 release();expect(await work).toBe(true);expect(writeSubstationSpatialSemanticCache).toHaveBeenCalledWith(7,'source-a',index,SUBSTATION_PARSER_DOMAIN_VERSION,undefined);
});
it('does not persist an old index when the project changes while source publication is pending',async()=>{
 const state=new AppState();state.activateProject(7,'source-a');let release!:()=>void;
 const work=start(state,new Promise<void>(r=>{release=r;}));await vi.waitFor(()=>expect(state.substationSpatialIndex).toBe(index));
 state.activateProject(8,'source-b');release();expect(await work).toBe(false);expect(writeSubstationSpatialSemanticCache).not.toHaveBeenCalled();
});
it('signals index readiness while source publication and cache persistence remain pending',async()=>{
 const state=new AppState(),session=state.activateProject(7,'source-a');let releaseSource!:()=>void,releaseWrite!:()=>void;
 const source=new Promise<void>(r=>{releaseSource=r;}),write=new Promise<void>(r=>{releaseWrite=r;});
 vi.mocked(writeSubstationSpatialSemanticCache).mockImplementation(async()=>{await write;return{writeMs:1,snapshotBytes:1};});
 const work=vi.fn((onIndexReady:(ready:boolean)=>void)=>buildAndCommitSubstationSpatialSemantic(state,new Map(),[],{}as never,[],session,{}as PerfSession,()=>{},'fixture',
  {projectId:7,sourceSha256:'source-a',beforeCacheWrite:source,onIndexReady}));
 const starter=createSpatialSemanticStarter(work);let complete=false;const done=starter.complete().then(()=>{complete=true;});
 expect(await starter.ready()).toBe(true);expect(state.substationSpatialIndex).toBe(index);expect(complete).toBe(false);expect(writeSubstationSpatialSemanticCache).not.toHaveBeenCalled();
 releaseSource();await vi.waitFor(()=>expect(writeSubstationSpatialSemanticCache).toHaveBeenCalledOnce());expect(complete).toBe(false);
 releaseWrite();await done;expect(work).toHaveBeenCalledOnce();
});
