import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { setupSelectionToolbar } from '../selectionToolbar.js';
let dispose: (()=>void) | undefined;
beforeEach(async ()=>{vi.resetModules();localStorage.clear();document.body.innerHTML='<div id="viewport"></div><div id="cbm-tree-panel"></div><div id="sld-panel"></div><div id="props-drawer-body">selected</div><span id="status-selection"></span>';(await import('../../app/presentationBindings.js')).configurePresentation();});
afterEach(()=>{dispose?.();dispose=undefined;document.body.replaceChildren();});

it('controls only tree auto-location and remembers the preference',()=>{
  const state=new AppState();dispose=setupSelectionToolbar(state);
  const button=document.getElementById('btn-auto-locate')!;expect(button.getAttribute('aria-pressed')).toBe('true');button.click();expect(state.autoLocate).toBe(false);expect(localStorage.getItem('gim-auto-locate')).toBe('0');
  const request=state.beginSelection({kind:'engineering',key:'device'});expect(state.canAutoLocate(request)).toBe(false);button.click();expect(state.canAutoLocate(request)).toBe(true);
  state.cameraNavigationVersion++;expect(state.canAutoLocate(request)).toBe(false);
});

it.each(['button','escape'])('explicit %s clearing exits isolation instead of hiding an empty selected range',async mode=>{
  const state=new AppState();state.beginSelection({kind:'cbm',key:'device'});state.onlySelected=true;dispose=setupSelectionToolbar(state);
  if(mode==='button') document.getElementById('btn-clear-selection')!.click();else document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await vi.waitFor(()=>expect(state.selectionRequest?.target).toBeNull());expect(state.onlySelected).toBe(false);expect(state.canIsolateSelection).toBe(false);
  await vi.waitFor(()=>expect(document.getElementById('props-drawer-body')?.textContent).toBe('尚未选择对象'));await vi.dynamicImportSettled();
});
