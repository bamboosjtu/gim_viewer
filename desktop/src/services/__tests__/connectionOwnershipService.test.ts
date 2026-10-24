import {afterEach,expect,it,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {prepareConnectionOwnership} from '../connectionOwnershipService.js';
const mocks=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('@desktop/runtime.js',()=>({isTauri:()=>true}));
vi.mock('@desktop/database.js',()=>({batchReadCachedFiles:mocks.read}));
const uuid='12345678-1234-1234-1234-123456789abc',port='87654321-4321-4321-4321-cba987654321';
const path=`MOD/${uuid}.gl`,xml=`<Device><Entities><Entity ID="4"><GimGeCableConcentration ConnectGuid="${port}"/></Entity></Entities></Device>`;
function setup(){
 const state=new AppState(),session=state.activateProject(1,'sha');
 state.substationEntryPaths=[`DEV/${uuid}.dev`,path];state.substationEntrySizes.set(path,xml.length);
 state.currentCbmTree={path:'CBM/project.cbm',name:'device',entityName:'F4System',children:[],devPath:`DEV/${uuid}.dev`} as any;
 return {state,session};
}
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();});
it('batch reads small sidecar metadata once without parsing DEV geometry',async()=>{
 const {state,session}=setup();mocks.read.mockResolvedValue(new Map([[path,new TextEncoder().encode(xml)]]));
 await prepareConnectionOwnership(state,session);
 expect(mocks.read).toHaveBeenCalledOnce();expect(mocks.read).toHaveBeenCalledWith(1,[path]);expect(state.substationConnectionPorts?.get(port)).toHaveLength(1);
});
it('does not admit unknown/oversized inputs or publish into a later project session',async()=>{
 const {state,session}=setup();state.substationEntrySizes.set(path,1024*1024+1);
 await prepareConnectionOwnership(state,session);expect(mocks.read).not.toHaveBeenCalled();
 state.substationEntrySizes.set(path,xml.length);
 let finish!:(data:Map<string,Uint8Array>)=>void;mocks.read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=prepareConnectionOwnership(state,session);state.activateProject(2,'other');
 finish(new Map([[path,new TextEncoder().encode(xml)]]));await pending;
 expect(state.substationConnectionPorts).toBeNull();
});
it('bounds optional metadata waiting and ignores a late reply after timeout',async()=>{
 vi.useFakeTimers();const {state,session}=setup();let finish!:(data:Map<string,Uint8Array>)=>void;
 mocks.read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=prepareConnectionOwnership(state,session);await vi.advanceTimersByTimeAsync(5000);await pending;
 finish(new Map([[path,new TextEncoder().encode(xml)]]));await Promise.resolve();
 expect(state.substationConnectionPorts).toBeNull();
});
