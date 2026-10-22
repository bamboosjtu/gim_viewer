import {beforeEach,expect,it,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {perfReset} from '../../utils/perfTimings.js';
import {collectProjectDiagnostic} from '../projectDiagnosticService.js';

const db=vi.hoisted(()=>({path:vi.fn(async():Promise<string>=>'C:/acceptance/gim_cache.db'),
  project:vi.fn(async(_id:number):Promise<any>=>({projectId:7})),latest:vi.fn(async():Promise<any>=>({projectId:99}))}));
vi.mock('@desktop/database.js',()=>({getDbPath:db.path,getProjectDiagnostic:db.project,getLatestProjectCacheDiagnostic:db.latest}));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function fixture(){const state=new AppState();state.activateProject(7,'sha');state.currentProjectType='substation';perfReset();return state;}
beforeEach(()=>{vi.clearAllMocks();db.path.mockResolvedValue('C:/acceptance/gim_cache.db');db.project.mockResolvedValue({projectId:7});db.latest.mockResolvedValue({projectId:99});});
it('exports existing timings and the active database without looking at or parsing source files',async()=>{
  const state=fixture(),source=vi.fn(()=>{throw Error('Diagnostic must not touch source files');});
  Object.defineProperty(state,'currentFiles',{get:source});
  const data=await collectProjectDiagnostic(state);
  expect(source).not.toHaveBeenCalled();expect(db.project).toHaveBeenCalledWith(7);expect(db.latest).not.toHaveBeenCalled();
  expect(data).toMatchObject({databaseDiagnosticScope:'active-project',projectSession:{projectId:7,sourceSha256:'sha'},
    substationCapabilities:null,substationCapabilitiesStatus:'not-collected',diagnosticReadErrors:{}});
  expect(data?.timings.taskPhases).toBeDefined();
});
it('reuses a known capability summary and labels unavailable or inapplicable facts explicitly',async()=>{
  const state=fixture();state.substationCapabilities={fixture:true} as any;
  const data=await collectProjectDiagnostic(state);expect(data?.substationCapabilities).toBe(state.substationCapabilities);
  expect(data?.substationCapabilitiesStatus).toBe('available');
  state.currentProjectType='transmission_line';
  const line=await collectProjectDiagnostic(state);expect(line?.substationCapabilities).toBeNull();expect(line?.substationCapabilitiesStatus).toBe('not-applicable');
});
it('rejects a previous project result and never substitutes the newer project ID into its read',async()=>{
  const state=fixture(),read=deferred<any>();db.project.mockReturnValueOnce(read.promise);
  const pending=collectProjectDiagnostic(state);await Promise.resolve();
  state.activateProject(8,'next');read.resolve({projectId:7});
  expect(await pending).toBeNull();expect(db.project).toHaveBeenCalledWith(7);
});
it('shares concurrent reads per session and falls back to latest-project scope only without an active project',async()=>{
  const state=fixture(),read=deferred<any>();db.project.mockReturnValueOnce(read.promise);
  const first=collectProjectDiagnostic(state),second=collectProjectDiagnostic(state);expect(first).toBe(second);
  await Promise.resolve();expect(db.project).toHaveBeenCalledOnce();read.resolve({projectId:7});await first;
  state.currentProjectId=null;const latest=await collectProjectDiagnostic(state);
  expect(db.latest).toHaveBeenCalledOnce();expect(latest?.databaseDiagnosticScope).toBe('latest-project');
});
it('keeps the performance snapshot when database diagnostics fail',async()=>{
  const state=fixture();db.project.mockRejectedValueOnce(Error('database unavailable'));
  const data=await collectProjectDiagnostic(state);
  expect(data?.diagnostic).toBeNull();expect(data?.dbPath).toContain('gim_cache.db');
  expect(data?.diagnosticReadErrors.project).toContain('database unavailable');expect(data?.timings).toBeDefined();
});
it('bounds a hung diagnostic read and clears its timer without marking the project failed',async()=>{
  vi.useFakeTimers();
  try {
    const state=fixture();db.path.mockImplementationOnce(()=>new Promise(()=>{}));
    const pending=collectProjectDiagnostic(state);await vi.advanceTimersByTimeAsync(5000);
    const data=await pending;
    expect(data?.dbPath).toBeNull();expect(data?.diagnosticReadErrors.dbPath).toContain('超过 5 秒');
    expect(data?.diagnostic).toEqual({projectId:7});expect(state.currentProjectId).toBe(7);expect(vi.getTimerCount()).toBe(0);
  } finally {vi.useRealTimers();}
});
