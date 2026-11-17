import {afterEach,expect,it,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import type {IfcRegionalRuntime} from '../../viewer/ifcRegionalRuntime.js';
import {setLogSink} from '../../utils/logger.js';
import {RuntimeSlot} from '../runtimeSlot.js';

afterEach(()=>setLogSink());

it('rejects old registration and late deletion without replacing the active IFC address',()=>{
 const state=new AppState(),old=state.activateProject(1,'old');
 const oldId=state.ifc.getRuntimeModelId('same',old);
 state.ifc.registerIfcRuntimeModel('same',oldId,old);
 const current=state.activateProject(2,'new'),id=state.ifc.getRuntimeModelId('same',current);
 state.ifc.registerIfcRuntimeModel('same',id,current);
 state.ifc.loadedModels.set('same',{modelId:'same',runtimeModelId:id,visible:true});
 state.ifc.registerIfcRuntimeModel('same',oldId,old);
 expect(state.ifc.getRuntimeModelId('same',old)).toBe(oldId);
 expect(state.ifc.runtimeModelIds.get('same')).toBe(id);
 expect(state.ifc.isCurrentRuntimeModel(oldId)).toBe(false);
 expect(state.ifc.isCurrentRuntimeModel(id)).toBe(true);
 expect(state.ifc.remove(oldId)).toEqual({logicalModelId:'same',removed:false});
 expect(state.ifc.loadedModels.get('same')?.runtimeModelId).toBe(id);
 expect(state.ifc.modelOwners.get(id)).toBe(current);
 expect(state.ifc.remove(id)).toEqual({logicalModelId:'same',removed:true});
 expect(state.ifc.loadedModels.size).toBe(0);
});

it('releases all IFC runtimes despite an error, logs the original error and keeps Map identities',()=>{
 const state=new AppState(),error=new Error('release failed'),sink=vi.fn();setLogSink(sink);
 const second=vi.fn();
 state.ifc.regionalRuntimes.set('first',{release:()=>{throw error;}} as unknown as IfcRegionalRuntime);
 state.ifc.regionalRuntimes.set('second',{release:second} as unknown as IfcRegionalRuntime);
 const maps=[state.ifc.loadedModels,state.ifc.runtimeModelIds,state.ifc.logicalModelIds,state.ifc.modelOwners,state.ifc.regionalRuntimes];
 state.resetGimState();state.resetGimState();
 expect(second).toHaveBeenCalledOnce();
 expect(sink).toHaveBeenCalledWith('error',['[IFC runtime] release failed',error]);
 expect(maps).toEqual([state.ifc.loadedModels,state.ifc.runtimeModelIds,state.ifc.logicalModelIds,state.ifc.modelOwners,state.ifc.regionalRuntimes]);
 for(const map of maps)expect(map.size).toBe(0);
});

it('routes RuntimeSlot replacement errors through the shared logger while retaining the new owner',()=>{
 const sink=vi.fn(),error=new Error('old runtime failed');setLogSink(sink);
 const slot=new RuntimeSlot(),next={release:vi.fn()};
 slot.value={release:()=>{throw error;}};slot.value=next;
 expect(slot.value).toBe(next);expect(sink).toHaveBeenCalledWith('error',['[Runtime] release failed',error]);
 slot.value=null;expect(next.release).toHaveBeenCalledOnce();
});
