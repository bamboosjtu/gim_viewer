import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({dispose:vi.fn(),create:vi.fn()}));
vi.mock('@thatopen/components',()=>({Components:class {get(){return {create:m.create};}dispose=m.dispose;},Worlds:class {}}));
vi.mock('../demandRendering.js',()=>({installDemandRendering:vi.fn()}));
vi.mock('../renderMeasurement.js',()=>({observeRenderer:vi.fn()}));
import {createViewerEngine} from '../viewerEngine.js';
beforeEach(()=>{vi.clearAllMocks();m.create.mockImplementation(()=>{throw Error('world creation');});m.dispose.mockResolvedValue(undefined);});
it('waits for partial engine disposal before exposing the failed initialization',async()=>{
  let release!:()=>void;m.dispose.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
  let failed=false;const pending=createViewerEngine(document.createElement('div')).catch(error=>{failed=true;throw error;});
  await vi.waitFor(()=>expect(m.dispose).toHaveBeenCalledOnce());expect(failed).toBe(false);
  release();await expect(pending).rejects.toThrow('world creation');
});
it('preserves the creation error if cleanup also fails',async()=>{
  const log=vi.spyOn(console,'warn').mockImplementation(()=>{});m.dispose.mockImplementation(()=>{throw Error('dispose');});
  await expect(createViewerEngine(document.createElement('div'))).rejects.toThrow('world creation');expect(log).toHaveBeenCalledOnce();log.mockRestore();
});
