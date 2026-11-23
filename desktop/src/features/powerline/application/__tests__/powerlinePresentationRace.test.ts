import {beforeEach,it,expect,vi} from 'vitest';
import {AppState} from '../../../../app/state.js';
import {buildLineGimGraphFromTexts} from '../../../../gim/lineCbmParserCore.js';
import {openPowerlineProject} from '../openPowerlineProject.js';

const mocks=vi.hoisted(()=>({load:vi.fn(),worker:vi.fn(),hide:vi.fn(),schedule:vi.fn(),
  native: false, validate: vi.fn(), getGraph: vi.fn(), getAttributes: vi.fn()}));
vi.mock('../../presentation/linePresentationPort.js',()=>({linePresentation:()=>({present:mocks.load}),bindLinePresentation:vi.fn()}));
vi.mock('../../../../services/project/gimOpenCore.js',()=>({showLoading:vi.fn(),hideLoading:mocks.hide,scheduleHideLoading:mocks.schedule,currentPerfSession:()=>undefined}));
vi.mock('../../../../services/presentation/shell_projectBar.js',()=>({setProjectIdentity:vi.fn(),refreshNavigatorTitle:vi.fn(),bind:vi.fn()}));
vi.mock('@desktop/runtime.js',()=>({isTauri:()=>mocks.native}));
vi.mock('@desktop/database.js',()=>({
  validateGimCache: mocks.validate,
  getLineGraph: mocks.getGraph,
  getLineAttributes: mocks.getAttributes,
}));
vi.mock('../../runtime/lineParserInput.js',()=>({readLineParserInput:async()=>({files:[],requested:0,bytes:0,batches:0,cancelled:false})}));
vi.mock('../../runtime/lineParserWorkerClient.js',()=>({parseLineInWorker:mocks.worker}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.native = false;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function context(state: AppState, projectId: number, projectName: string) {
  const session = state.activateProject(projectId, projectName);
  return { state, session, projectId, projectName, projectTypeName: '线路',
    source: {} as Parameters<typeof openPowerlineProject>[0]['source'], showMessage: vi.fn(),
    getExtracted: vi.fn(async () => ({ status: 'ok' as const, magic: 'GIMPKGT' as const, files: new Map<string, File>() })) };
}

function parserResult() {
  return { graph: buildLineGimGraphFromTexts([]), attributes: { famPayloads: [], devPayloads: [] },
    timings: { worker: false, totalMs: 0, graphMs: 0, attributesMs: 0 } };
}

it('rejects old cold-open panels after a delayed presentation import finishes',async()=>{
  const state=new AppState(),session=state.activateProject(1,'a'),destroy=vi.fn();
  let loaded!:(value:{destroy:typeof destroy})=>void;
  mocks.load.mockReturnValue(new Promise(resolve=>{loaded=resolve;}));
  mocks.worker.mockResolvedValue({graph:buildLineGimGraphFromTexts([]),attributes:{famPayloads:[],devPayloads:[]},
    timings:{worker:false,totalMs:0,graphMs:0,attributesMs:0}});
  const opening=openPowerlineProject({state,session,projectId:1,projectName:'A',projectTypeName:'线路',
    source:{} as Parameters<typeof openPowerlineProject>[0]['source'],showMessage:vi.fn(),
    getExtracted:async()=>({status:'ok',magic:'GIMPKGT',files:new Map()})});
  await vi.waitFor(()=>expect(mocks.load).toHaveBeenCalled());
  state.activateProject(2,'b');state.projectName='B';
  loaded({destroy});await opening;
  expect(destroy).toHaveBeenCalledOnce();expect(mocks.hide).not.toHaveBeenCalled();expect(mocks.schedule).not.toHaveBeenCalled();
  expect(state.projectName).toBe('B');
});

it('rejects an old parser result and releases only the map owned by the current project', async () => {
  const state = new AppState();
  const old = deferred<ReturnType<typeof parserResult>>();
  const nextResult = parserResult();
  const destroy = vi.fn();
  mocks.worker.mockReturnValueOnce(old.promise).mockResolvedValueOnce(nextResult);
  mocks.load.mockResolvedValue({ destroy });
  const openingA = openPowerlineProject(context(state, 1, 'A'));
  await vi.waitFor(() => expect(mocks.worker).toHaveBeenCalledOnce());
  await openPowerlineProject(context(state, 2, 'B'));
  old.resolve(parserResult());
  await openingA;
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(state.currentGimGraph).toBe(nextResult.graph);
  expect(state.projectName).toBe('B');
  expect(destroy).not.toHaveBeenCalled();

  state.activateProject(3, 'substation');
  state.invalidatePendingLoads();
  expect(destroy).toHaveBeenCalledOnce();
});

it('leaves the source graph unpublished while SQLite attributes are pending and rejects the stale pair', async () => {
  const state = new AppState();
  const attrs = deferred<{ fam_properties: []; dev_properties: [] }>();
  mocks.native = true;
  mocks.validate.mockResolvedValue({ valid: true });
  mocks.getGraph.mockResolvedValue({ project_type: 'transmission_line', nodes: [], children: [], refs: [], file_stats: [] });
  mocks.getAttributes.mockReturnValue(attrs.promise);
  const a = context(state, 1, 'A');
  const opening = openPowerlineProject(a);
  await vi.waitFor(() => expect(mocks.getAttributes).toHaveBeenCalledOnce());
  expect(state.currentGimGraph).toBeNull();
  const b = context(state, 2, 'B');
  state.projectName = b.projectName;
  attrs.resolve({ fam_properties: [], dev_properties: [] });
  await opening;
  expect(state.projectName).toBe('B');
  expect(state.currentGimGraph).toBeNull();
  expect(mocks.load).not.toHaveBeenCalled();
  expect(a.getExtracted).not.toHaveBeenCalled();
});

it('rejects an expired opening before changing project identity or reading the source', async () => {
  const state = new AppState();
  const expired = context(state, 1, 'A');
  const replacement = context(state, 2, 'B');
  state.projectName = replacement.projectName;
  state.currentProjectType = 'substation';
  await openPowerlineProject(expired);
  expect(state.projectName).toBe('B');
  expect(state.currentProjectType).toBe('substation');
  expect(expired.getExtracted).not.toHaveBeenCalled();
});

it('publishes the project name resolved by cold extraction before presenting the line', async () => {
  const state = new AppState();
  const opening = context(state, 1, 'package filename');
  opening.getExtracted.mockImplementation(async () => {
    opening.projectName = 'name from package';
    return { status: 'ok', magic: 'GIMPKGT', files: new Map() };
  });
  mocks.worker.mockResolvedValue(parserResult());
  mocks.load.mockImplementation(async (state: AppState) => {
    expect(state.projectName).toBe('name from package');
    return { destroy: vi.fn() };
  });
  await openPowerlineProject(opening);
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(state.projectName).toBe('name from package');
  state.invalidatePendingLoads();
});
