import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {openGimProjectFromId,openGimWithDialog} from '../openGimService.js';
const m=vi.hoisted(()=>({native:true,debugRuntime:false,info:vi.fn(),head:vi.fn(),register:vi.fn(),cleanup:vi.fn(),station:vi.fn(),line:vi.fn(),equipment:vi.fn(),extract:vi.fn(),choose:vi.fn(),detect:vi.fn(),hide:vi.fn(),show:vi.fn(),scheduleHide:vi.fn(),manifest:vi.fn(),batchRead:vi.fn(),inspectEarly:vi.fn(),withEarly:vi.fn(),startSubstation:vi.fn()}));
vi.mock('../../config/debug.js',()=>({get DEBUG_RUNTIME_LOGS(){return m.debugRuntime;}}));
vi.mock('@desktop/runtime.js',()=>({isTauri:()=>m.native}));
vi.mock('@desktop/fileDialog.js',()=>({openGimFilePath:async()=> 'tmp/open.gim'}));
vi.mock('@desktop/fileReader.js',()=>({getFileInfo:m.info,readFileHead:m.head}));
vi.mock('@desktop/database.js',()=>({authorizeCachedGimProject:async()=> 'tmp/open.gim',upsertGimProject:m.register,touchGimProjectOpened:async()=>{},readExtractionManifest:async()=>null,batchReadCachedFiles:m.batchRead}));
vi.mock('@desktop/gimExtract.js',async original=>({...await original<typeof import('@desktop/gimExtract.js')>(),extractGimArchiveNative:m.extract,readExtractionManifest:m.manifest}));
vi.mock('../substationExtractionJob.js',()=>({inspectEarlySemanticEligibility:m.inspectEarly,withEarlySemanticCapability:m.withEarly,startSubstationExtractionJob:m.startSubstation}));
vi.mock('../projectCleanupService.js',()=>({cleanupBeforeOpenNewProject:m.cleanup}));
vi.mock('../substationRuntime.js',()=>({openSubstationProject:m.station,onGimExtracted:vi.fn(),loadAllIfcFiles:vi.fn()}));
vi.mock('../powerlineRuntime.js',()=>({openPowerlineProject:m.line}));
vi.mock('../equipmentRuntime.js',()=>({openEquipmentProject:m.equipment}));
vi.mock('../../gim/projectType.js',()=>({detectGimProjectType:m.detect}));
vi.mock('../../gim/gimExtractor.js',async original=>({...await original<typeof import('../../gim/gimExtractor.js')>(),extractGimFile:m.extract}));
vi.mock('../substationResourceTelemetry.js',()=>({sampleSubstationRuntimeResources:async()=>{}}));
vi.mock('../gimOpenCore.js',async original=>({...await original<typeof import('../gimOpenCore.js')>(),showLoading:m.show,hideLoading:m.hide,scheduleHideLoading:m.scheduleHide}));
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
let loadButton:HTMLButtonElement;
const bytes=(magic='GIMPKGS')=>new TextEncoder().encode(magic).buffer;
const sourceFiles=()=>new Map([['unit.cbm',new File(['ENTITYNAME=PROJECT'],'unit.cbm')]]);
beforeEach(async()=>{
  vi.clearAllMocks();m.native=true;
  loadButton=document.createElement('button');
  const {bindProjectOpenPresentation}=await import('../projectOpenPresentationPort.js');
  bindProjectOpenPresentation({chooseGim:()=>m.choose(),chooseIfc:async()=>[],setBusy:(kind,busy)=>{if(kind==='gim')loadButton.disabled=busy;},resetInput:vi.fn()});
  m.info.mockResolvedValue({name:'open.gim',path:'tmp/open.gim',size:7,modified_ms:1,sha256:'source-a'});
  m.head.mockResolvedValue(bytes());m.register.mockResolvedValue({id:1,sha256:'source-a'});
  m.cleanup.mockImplementation(async(state:AppState)=>{state.invalidatePendingLoads();return true;});
  m.station.mockResolvedValue(undefined);m.line.mockResolvedValue(undefined);m.equipment.mockResolvedValue(undefined);
  m.extract.mockResolvedValue({magic:'GIMPKGS',files:sourceFiles()});m.detect.mockResolvedValue({type:'substation'});
  m.manifest.mockResolvedValue(null);m.inspectEarly.mockResolvedValue({eligible:true});m.withEarly.mockImplementation(async(_capability:unknown,_start:unknown,full:()=>Promise<unknown>)=>full());m.startSubstation.mockResolvedValue(undefined);
  localStorage.removeItem('gim-debug-substation-early-semantic');
});
afterEach(()=>{vi.restoreAllMocks();});
async function button(){return loadButton;}
it('reuses a same-SHA extraction manifest when the semantic index was not committed',async()=>{
  const source = new TextEncoder().encode('ENTITYNAME=PROJECT');
  m.manifest.mockResolvedValueOnce({source_sha256:'source-a',entries:[{path:'unit.cbm',size:source.byteLength,packed:true,cache_path:'cache/unit.cbm'}]});
  m.batchRead.mockResolvedValueOnce(new Map([['unit.cbm', source]]));
  const onExtracted = vi.fn();
  m.station.mockImplementationOnce(async (context:{getExtracted:()=>Promise<unknown>})=>{
    onExtracted(await context.getExtracted());
  });
  const state=new AppState();
  await openGimProjectFromId(state,vi.fn(),1);
  expect(m.station).toHaveBeenCalledOnce();
  expect(m.batchRead).toHaveBeenCalledWith(1, ['unit.cbm']);
  expect(onExtracted).toHaveBeenCalledOnce();
  const extracted = onExtracted.mock.calls[0][0];
  expect(extracted.preHydrated).toBe(true);
  expect([...extracted.files.keys()]).toEqual(['unit.cbm']);
  await expect(extracted.files.get('unit.cbm').text()).resolves.toBe('ENTITYNAME=PROJECT');
  expect(m.extract).not.toHaveBeenCalled();
});

it('exercises the early-semantic extraction policy branch',async()=>{
  localStorage.setItem('gim-debug-substation-early-semantic','1');
  m.station.mockImplementationOnce(async (context:{getExtracted:()=>Promise<unknown>})=>{await context.getExtracted();});
  const state=new AppState();
  await openGimProjectFromId(state,vi.fn(),1);
  expect(m.inspectEarly).toHaveBeenCalledOnce();expect(m.withEarly).toHaveBeenCalledOnce();expect(m.station).toHaveBeenCalledOnce();
});

it('keeps debug path sampling bounded and still opens the project',async()=>{
  m.debugRuntime=true;
  const state=new AppState();
  await openGimProjectFromId(state,vi.fn(),1);
  expect(m.station).toHaveBeenCalledOnce();
  m.debugRuntime=false;
});

it.each([['GIMPKGS','station'],['GIMPKGT','line']])('routes %s by source identity, activates after cleanup and always restores the button',async(magic,runtime)=>{
  const state=new AppState();m.head.mockResolvedValue(bytes(magic));
  await openGimProjectFromId(state,vi.fn(),1);
  const call=(runtime==='station'?m.station:m.line).mock.calls[0][0];
  expect(state.isCurrentSession(call.session)).toBe(true);expect(call.session.sourceSha256).toBe('source-a');expect(call.session.projectId).toBe(1);
  expect(m.cleanup).toHaveBeenCalledOnce();expect(m.extract).not.toHaveBeenCalled();expect((await button()).disabled).toBe(false);
});
it('restores the button when cleanup aborts before a session is assigned',async()=>{
  const state=new AppState();m.cleanup.mockImplementationOnce(async()=>{state.invalidatePendingLoads();return false;});
  await openGimProjectFromId(state,vi.fn(),1);expect((await button()).disabled).toBe(false);expect(m.station).not.toHaveBeenCalled();
});
it('an older request cannot re-enable the button or dispatch after a newer open starts',async()=>{
  const state=new AppState(),first=deferred<unknown>(),second=deferred<unknown>();
  m.info.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const a=openGimProjectFromId(state,vi.fn(),1);await vi.waitFor(()=>expect(m.info).toHaveBeenCalledTimes(1));
  const b=openGimProjectFromId(state,vi.fn(),2);await vi.waitFor(()=>expect(m.info).toHaveBeenCalledTimes(2));
  const info={name:'open.gim',path:'tmp/open.gim',size:7,modified_ms:1,sha256:'source-a'};
  first.resolve(info);await a;expect((await button()).disabled).toBe(true);expect(m.station).not.toHaveBeenCalled();
  second.resolve(info);await b;expect((await button()).disabled).toBe(false);expect(m.station).toHaveBeenCalledOnce();
});
it('reports a current runtime failure and permits the next request to succeed',async()=>{
  const state=new AppState(),error=vi.spyOn(console,'error').mockImplementation(()=>{});m.station.mockRejectedValueOnce(Error('runtime load'));
  await openGimProjectFromId(state,vi.fn(),1);expect(m.show).toHaveBeenCalledWith('GIM 解析失败: runtime load');expect((await button()).disabled).toBe(false);
  await openGimProjectFromId(state,vi.fn(),1);expect(m.station).toHaveBeenCalledTimes(2);expect(error).toHaveBeenCalledOnce();
});
it('shares extraction among runtime requests and refines GIMPKGS to equipment from contents',async()=>{
  const state=new AppState();m.detect.mockResolvedValue({type:'equipment'});
  m.station.mockImplementationOnce(async(context)=>{
    const a=await context.getExtracted(),b=await context.getExtracted();expect(a).toBe(b);expect(a.projectType).toBe('equipment');
  });
  await openGimProjectFromId(state,vi.fn(),1);expect(m.extract).toHaveBeenCalledOnce();expect(m.detect).toHaveBeenCalledOnce();
});
it('opens browser data and restores controls after a failure before session assignment',async()=>{
  m.native=false;const state=new AppState();m.choose.mockResolvedValue(new File([bytes()],'browser.gim'));
  m.cleanup.mockImplementationOnce(async()=>{state.invalidatePendingLoads();return false;});
  await openGimWithDialog(state,vi.fn());expect((await button()).disabled).toBe(false);expect(m.station).not.toHaveBeenCalled();
  await openGimWithDialog(state,vi.fn());expect(m.station).toHaveBeenCalledOnce();
});
