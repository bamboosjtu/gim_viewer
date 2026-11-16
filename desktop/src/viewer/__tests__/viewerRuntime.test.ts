import {beforeEach,it,expect,vi} from 'vitest';
const engine=vi.hoisted(()=>vi.fn());
vi.mock('../viewerEngine.js',()=>({createViewerEngine:engine}));
beforeEach(()=>{vi.resetModules();engine.mockReset();});

it('shares creation, reports readiness only after success and reuses the engine',async()=>{
  const runtime=await import('../viewerRuntime.js'),ctx={world:{}},viewport=document.createElement('div');
  engine.mockReturnValue(ctx);
  expect(runtime.peekViewerRuntime()).toBeNull();expect(runtime.isViewerRuntimeCreated()).toBe(false);
  const a=runtime.getViewerRuntime(viewport),b=runtime.getViewerRuntime(viewport);
  expect(runtime.viewerRuntimePhase()).toBe('creating');expect(runtime.isViewerRuntimeCreated()).toBe(false);
  expect(await a).toBe(await b);expect(runtime.isViewerRuntimeCreated()).toBe(true);
  expect((await runtime.getViewerRuntime(viewport)).ctx).toBe(ctx);expect(engine).toHaveBeenCalledOnce();
});

it('drops a rejected initialization and permits a subsequent open to retry',async()=>{
  const runtime=await import('../viewerRuntime.js'),viewport=document.createElement('div');
  engine.mockImplementationOnce(()=>{throw Error('WebGL unavailable');}).mockReturnValue({world:{}});
  const a=runtime.getViewerRuntime(viewport),b=runtime.getViewerRuntime(viewport);
  await expect(a).rejects.toThrow('WebGL');await expect(b).rejects.toThrow('WebGL');
  expect(runtime.viewerRuntimePhase()).toBe('failed');expect(runtime.peekViewerRuntime()).toBeNull();
  expect(runtime.isViewerRuntimeCreated()).toBe(false);
  await runtime.getViewerRuntime(viewport);expect(engine).toHaveBeenCalledTimes(2);expect(runtime.viewerRuntimePhase()).toBe('ready');
});
