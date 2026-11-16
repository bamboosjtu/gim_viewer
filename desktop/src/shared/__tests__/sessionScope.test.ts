import {it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';

it('freezes tokens, keeps geometry replacement independent and refuses outgoing commits before disposal',()=>{
  const state=new AppState(),session=state.activateProject(1,'a'),scope=state.sessionScope(session),commit=vi.fn();
  expect(Object.isFrozen(session)).toBe(true);
  state.geometryLoadToken++;
  expect(state.withSession(session,()=>{commit();})).toBe(true);
  const release=vi.fn(()=>{expect(state.withSession(session,()=>{commit();})).toBe(false);});
  scope.own(release);
  state.activateProject(2,'b');
  expect(scope.signal.aborted).toBe(true);expect(release).toHaveBeenCalledOnce();expect(commit).toHaveBeenCalledOnce();
  scope.dispose();expect(release).toHaveBeenCalledOnce();
  const late=vi.fn();scope.own(late);expect(late).toHaveBeenCalledOnce();
});

it('releases all owned resources when one fails, and permits the next project to publish',()=>{
  const state=new AppState(),session=state.activateProject(1,'a'),scope=state.sessionScope(session),released=vi.fn();
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  scope.own(()=>{throw Error('broken');});scope.own(released);
  const next=state.activateProject(2,'b');
  expect(released).toHaveBeenCalledOnce();expect(log).toHaveBeenCalledOnce();
  expect(state.withSession(next,()=>{state.projectName='B';})).toBe(true);expect(state.projectName).toBe('B');
  log.mockRestore();
});

it('does not revive a disposed project scope through a new token capture',()=>{
  const state=new AppState(),session=state.activateProject(1,'a'),commit=vi.fn();
  state.sessionScope(session).dispose();
  expect(state.withSession(state.captureProjectSession(),()=>{commit();})).toBe(false);
  expect(commit).not.toHaveBeenCalled();
  const next=state.activateProject(2,'b');
  expect(state.withSession(next,()=>{commit();})).toBe(true);
});
