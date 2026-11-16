import {it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {setupSelection} from '../selection.js';
const pick=vi.hoisted(()=>vi.fn());
vi.mock('../ifcVisibleRaycast.js',()=>({raycastVisibleIfc:pick}));
vi.mock('../selectionOutline.js',()=>({clearHoverOutline:vi.fn(),outlineFragmentItems:vi.fn(),showHoverOutline:vi.fn(),showFragmentHover:vi.fn(),showHoverBounds:vi.fn()}));
vi.mock('../highlight.js',()=>({commitSelectionHighlight:vi.fn(),highlightModGroups:vi.fn()}));
function fixture() {
  const controls=new EventTarget(),state=new AppState(),container=document.createElement('div');state.initialized=true;
  const ctx={world:{camera:{controls}},fragments:{list:new Map()}} as never;
  return {controls,state,container,ctx};
}
it('detaches listeners idempotently, ignores a pending pick and allows one fresh binding',async()=>{
  const {state,container,ctx,controls}=fixture(),selected=vi.fn(),cleared=vi.fn();
  let finish!:(value:null)=>void;pick.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const remove=vi.spyOn(controls,'removeEventListener'),dispose=setupSelection(ctx,state,container,selected,cleared);
  container.click();expect(pick).toHaveBeenCalledOnce();dispose();dispose();finish(null);await Promise.resolve();await Promise.resolve();
  expect(selected).not.toHaveBeenCalled();expect(cleared).not.toHaveBeenCalled();expect(state.selectionRequest).toBeNull();expect(state.hoverCleanup).toBeNull();expect(remove).toHaveBeenCalledOnce();
  container.dispatchEvent(new WheelEvent('wheel'));controls.dispatchEvent(new Event('controlstart'));expect(state.cameraNavigationVersion).toBe(0);
  const next=setupSelection(ctx,state,container,selected,cleared);container.dispatchEvent(new WheelEvent('wheel'));expect(state.cameraNavigationVersion).toBe(1);next();
});
it('rolls back listeners when registration fails halfway through setup',()=>{
  const {state,container,ctx,controls}=fixture(),add=vi.spyOn(window,'addEventListener').mockImplementationOnce(()=>{throw Error('binding failure');});
  expect(()=>setupSelection(ctx,state,container,vi.fn())).toThrow('binding failure');add.mockRestore();
  container.dispatchEvent(new WheelEvent('wheel'));controls.dispatchEvent(new Event('controlstart'));
  expect(state.cameraNavigationVersion).toBe(0);expect(state.hoverCleanup).toBeNull();
});
