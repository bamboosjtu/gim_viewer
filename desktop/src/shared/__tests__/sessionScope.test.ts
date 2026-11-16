import {it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';

it('rejects delayed reads after replacement without exposing the result to a commit',async()=>{
  const state=new AppState(),scope=state.sessionScope(state.activateProject(1,'a')),commit=vi.fn();
  let finish!:(value:string)=>void;
  const pending=scope.read(()=>new Promise<string>(resolve=>{finish=resolve;})).then(commit);
  state.activateProject(2,'b');finish('old');
  await expect(pending).rejects.toThrow('no longer owns');expect(commit).not.toHaveBeenCalled();
  const read=vi.fn(async()=>42);await expect(scope.read(read)).rejects.toThrow('no longer owns');expect(read).not.toHaveBeenCalled();
});

it('guards publication even when replacement runs between preparation and the caller resuming',async()=>{
  const state=new AppState(),scope=state.sessionScope(state.activateProject(1,'a')),commit=vi.fn();
  const ready=scope.read(async()=>42);
  void ready.then(()=>state.activateProject(2,'b'));
  expect(await ready).toBe(42);
  expect(scope.withSession(()=>{commit();})).toBe(false);expect(commit).not.toHaveBeenCalled();
});

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
