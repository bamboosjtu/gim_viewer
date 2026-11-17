import {it,expect,vi,beforeEach} from 'vitest';
const m=vi.hoisted(()=>({select:vi.fn(),render:vi.fn()}));
vi.mock('../sldView.js',()=>({setSldGridIdClickHandler:m.select,renderSldView:m.render}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();});
it('a stale disposer cannot detach a newer registration of the same callback',async()=>{
  const {diagramPresentation:view}=await import('../diagramPresentation.js'),select=vi.fn();
  const first=await view.onSelect(select,()=>true),next=await view.onSelect(select,()=>true);
  first();expect(m.select).toHaveBeenCalledTimes(2);next();next();
  expect(m.select).toHaveBeenCalledTimes(3);expect(m.select).toHaveBeenLastCalledWith(null);
});
it('does not register or render when ownership changes during lazy preparation',async()=>{
  const {diagramPresentation:view}=await import('../diagramPresentation.js');let current=true;
  const pending=view.onSelect(vi.fn(),()=>current),rendered=view.render({} as never,()=>current);current=false;
  (await pending)();await rendered;expect(m.select).not.toHaveBeenCalled();expect(m.render).not.toHaveBeenCalled();
});
