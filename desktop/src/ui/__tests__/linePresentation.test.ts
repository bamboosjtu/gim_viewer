import {it,expect,vi} from 'vitest';
const render=vi.hoisted(()=>vi.fn(()=>({destroy:vi.fn()})));
vi.mock('../lineProjectView.js',()=>({renderLineProjectPanels:render}));
it('refuses a late project before mounting and returns the current view for scope ownership',async()=>{
  const {linePresentation:view}=await import('../linePresentation.js');let current=true;
  const pending=view.present({} as never,{} as never,vi.fn(),{},()=>current);current=false;
  expect(await pending).toBeUndefined();expect(render).not.toHaveBeenCalled();
  expect(await view.present({} as never,{} as never,vi.fn(),{},()=>true)).toHaveProperty('destroy');expect(render).toHaveBeenCalledOnce();
});
