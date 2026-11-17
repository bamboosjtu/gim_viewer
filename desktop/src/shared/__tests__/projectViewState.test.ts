import {it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
it('resets project view preferences without resetting the window camera epoch or losing history ownership',()=>{
  const state=new AppState(),clear=vi.fn(),history={clear} as never;
  state.viewState.viewHistory=history;state.viewState.cameraNavigationVersion=7;
  state.viewState.hasFittedCamera=true;state.viewState.viewerUserInteracted=true;
  state.viewState.mode='source';state.viewState.expanded.source.add('old');
  const request=state.selection.beginSelection({kind:'cbm',key:'old'});expect(request.cameraNavigationVersion).toBe(7);
  state.resetGimState();expect(clear).toHaveBeenCalledOnce();expect(state.viewState.viewHistory).toBe(history);
  expect(state.viewState.cameraNavigationVersion).toBe(7);expect(state.viewState.hasFittedCamera).toBe(false);
  expect(state.viewState.viewerUserInteracted).toBe(false);expect(state.viewState.mode).toBe('inventory');
  expect(state.viewState.expanded.source.size).toBe(0);expect(state.selection.isCurrentSelection(request)).toBe(false);
});
