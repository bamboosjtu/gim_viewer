import { describe,it,expect,vi } from 'vitest';
import { AppState } from '../../../app/state.js';
import { createCachePublishStatus } from '../cachePublishStatus.js';
describe('session ownership and background requests',()=>{
  it.each(['activate','reset','invalidate'])('%s releases runtimes even when another disposer throws',entry=>{
    const state=new AppState(),release=vi.fn(),session=state.captureProjectSession();
    state.deviceLodRuntime={release,clearSelection:vi.fn(),select:vi.fn(),diagnostics:{}};
    const failure=Error('broken disposer');state.engineering.cleanup=()=>{throw failure;};
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    if(entry==='activate')state.activateProject(1,'b');else if(entry==='reset')state.resetGimState();else state.invalidatePendingLoads();
    expect(release).toHaveBeenCalledTimes(1);expect(state.deviceLodRuntime).toBeNull();expect(state.isCurrentSession(session)).toBe(false);
    expect(log).toHaveBeenCalledOnce();expect(log).toHaveBeenCalledWith('[Session] 资源释放失败',failure);
    state.invalidatePendingLoads();expect(release).toHaveBeenCalledTimes(1);log.mockRestore();
  });
  it('old publication callbacks cannot overwrite a new session',()=>{
    document.body.innerHTML='<span id="status-publish"></span>';let current=true;
    const old=createCachePublishStatus(()=>current);old.beginCachePublish('core');current=false;
    const next=createCachePublishStatus(()=>true);next.beginCachePublish('rest');old.failCachePublish('late');old.resetCachePublishStatus();
    expect(document.querySelector('#status-publish')?.getAttribute('data-phase')).toBe('rest');next.resetCachePublishStatus();
  });
});
