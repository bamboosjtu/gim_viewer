import { describe,it,expect,vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { isCurrentGeometry } from '../../shared/projectSession.js';
import { WorkerRequests } from '../workerRequests.js';
import { createCachePublishStatus } from '../cachePublishStatus.js';
describe('session ownership and background requests',()=>{
  it.each(['activate','reset','invalidate'])('%s releases runtimes even when another disposer throws',entry=>{
    const state=new AppState(),release=vi.fn(),session=state.captureProjectSession();
    state.deviceLodRuntime={release,clearSelection:vi.fn(),select:vi.fn(),diagnostics:{}};
    state.engineeringCleanup=()=>{throw Error('broken disposer');};
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    if(entry==='activate')state.activateProject(1,'b');else if(entry==='reset')state.resetGimState();else state.invalidatePendingLoads();
    expect(release).toHaveBeenCalledTimes(1);expect(state.deviceLodRuntime).toBeNull();expect(state.isCurrentSession(session)).toBe(false);
    state.invalidatePendingLoads();expect(release).toHaveBeenCalledTimes(1);log.mockRestore();
  });
  it('geometry changes do not cancel semantic work',()=>{
    const state=new AppState(),session=state.activateProject(1,'a');state.geometryLoadToken++;
    expect(state.isCurrentSession(session)).toBe(true);expect(isCurrentGeometry(state,session)).toBe(false);
  });
  it('settles timeout, send failure and late replies exactly once',async()=>{
    vi.useFakeTimers();const stop=vi.fn(),rpc=new WorkerRequests<number>(100,stop);
    const timeout=expect(rpc.request(1,()=>{})).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(100);await timeout;expect(stop).toHaveBeenCalledTimes(1);
    rpc.settle(1,42);await expect(rpc.request(2,()=>{throw Error('send');})).rejects.toThrow('send');
    expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
  });
  it('old publication callbacks cannot overwrite a new session',()=>{
    document.body.innerHTML='<span id="status-publish"></span>';let current=true;
    const old=createCachePublishStatus(()=>current);old.beginCachePublish('core');current=false;
    const next=createCachePublishStatus(()=>true);next.beginCachePublish('rest');old.failCachePublish('late');old.resetCachePublishStatus();
    expect(document.querySelector('#status-publish')?.getAttribute('data-phase')).toBe('rest');next.resetCachePublishStatus();
  });
});
