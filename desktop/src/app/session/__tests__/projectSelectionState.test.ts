import {afterEach,expect,it,vi} from 'vitest';
import {AppState} from '../../state.js';
import {setLogSink} from '../../../utils/logger.js';

afterEach(()=>setLogSink());

it('keeps selection cancellation and camera intent independent of geometry batch tokens',()=>{
 const state=new AppState();state.activateProject(1,'source');
 const first=state.selection.beginSelection({kind:'cbm',key:'first'}),guard=state.selection.selectionGuard(first),token=state.geometryLoadToken;
 expect(guard.isCurrent()).toBe(true);expect(state.selection.canAutoLocate(first)).toBe(true);
 state.viewState.cameraNavigationVersion++;
 expect(state.selection.canAutoLocate(first)).toBe(false);
 const second=state.selection.beginSelection({kind:'ifc-element',key:'next'},'viewport');
 expect(first.signal.aborted).toBe(true);expect(guard.isCurrent()).toBe(false);expect(guard.isSessionCurrent()).toBe(true);
 expect(state.geometryLoadToken).toBe(token);expect(state.selection.canAutoLocate(second)).toBe(false);
 state.resetGimState();expect(second.signal.aborted).toBe(true);expect(guard.isSessionCurrent()).toBe(false);
 const third=state.selection.beginSelection(null);expect(third.id).toBeGreaterThan(second.id);
 expect(state.selection.selectionGeometry).toBeNull();expect(state.selection.selectionMessage).toBe('');expect(state.selection.onlySelected).toBe(false);
});

it('invalidates the project before releasing selection decorations and isolates each release failure',()=>{
 const state=new AppState(),session=state.activateProject(1,'source'),error=new Error('decoration failed'),sink=vi.fn();setLogSink(sink);
 const disposed=vi.fn(()=>expect(state.isCurrentSession(session)).toBe(false));
 state.selection.hoverCleanup=()=>{expect(state.isCurrentSession(session)).toBe(false);throw error;};
 state.selection.selectionDecorationCleanup=disposed;state.selection.engineeringSelectionCleanup=disposed;
 state.resetGimState();state.resetGimState();
 expect(disposed).toHaveBeenCalledTimes(2);expect(sink).toHaveBeenCalledWith('error',['[Selection] release failed',error]);
 expect(state.selection.hoverCleanup).toBeNull();expect(state.selection.selectionDecorationCleanup).toBeNull();
});
