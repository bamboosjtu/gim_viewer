import {it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {buildLineGimGraphFromTexts} from '../../gim/lineCbmParserCore.js';
import {openPowerlineProject} from '../powerlineRuntime.js';

const mocks=vi.hoisted(()=>({load:vi.fn(),worker:vi.fn(),hide:vi.fn(),schedule:vi.fn()}));
vi.mock('../presentationPort.js',()=>({loadPresentation:mocks.load,bindPresentationLoader:vi.fn()}));
vi.mock('../gimOpenCore.js',()=>({showLoading:vi.fn(),hideLoading:mocks.hide,scheduleHideLoading:mocks.schedule,currentPerfSession:()=>undefined}));
vi.mock('../presentation/dom.js',()=>({emptyTipEl:null,bind:vi.fn()}));
vi.mock('../presentation/shell_projectBar.js',()=>({setProjectIdentity:vi.fn(),refreshNavigatorTitle:vi.fn(),bind:vi.fn()}));
vi.mock('@desktop/runtime.js',()=>({isTauri:()=>false}));
vi.mock('../lineParserInput.js',()=>({readLineParserInput:async()=>({files:[],requested:0,bytes:0,batches:0,cancelled:false})}));
vi.mock('../lineParserWorkerClient.js',()=>({parseLineInWorker:mocks.worker}));

it('rejects old cold-open panels after a delayed presentation import finishes',async()=>{
  const state=new AppState(),session=state.activateProject(1,'a'),render=vi.fn();
  let loaded!:(value:{renderLineProjectPanels:typeof render})=>void;
  mocks.load.mockReturnValue(new Promise(resolve=>{loaded=resolve;}));
  mocks.worker.mockResolvedValue({graph:buildLineGimGraphFromTexts([]),attributes:{famPayloads:[],devPayloads:[]},
    timings:{worker:false,totalMs:0,graphMs:0,attributesMs:0}});
  const opening=openPowerlineProject({state,session,projectId:1,projectName:'A',projectTypeName:'线路',
    source:{} as Parameters<typeof openPowerlineProject>[0]['source'],showMessage:vi.fn(),
    getExtracted:async()=>({status:'ok',magic:'GIMPKGT',files:new Map()})});
  await vi.waitFor(()=>expect(mocks.load).toHaveBeenCalledWith('lineProjectView'));
  state.activateProject(2,'b');state.projectName='B';
  loaded({renderLineProjectPanels:render});await opening;
  expect(render).not.toHaveBeenCalled();expect(mocks.hide).not.toHaveBeenCalled();expect(mocks.schedule).not.toHaveBeenCalled();
  expect(state.projectName).toBe('B');
});
