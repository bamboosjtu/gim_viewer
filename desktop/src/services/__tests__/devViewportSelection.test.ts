import {expect,it,vi} from 'vitest';
import * as THREE from 'three';
import {AppState} from '../../app/state.js';
import type {CbmNode} from '../../gim/types.js';
import {selectViewportDev} from '../devViewportSelection.js';
import {highlightModGroups} from '../../viewer/highlight.js';

const mocks=vi.hoisted(()=>({handle:vi.fn(async()=>{}),properties:vi.fn(async(..._args:unknown[])=>{})}));
vi.mock('../nodeInteractionService.js',()=>({handleNodeClick:mocks.handle}));
vi.mock('../../ui/propsDrawer.js',()=>({showNodePropertiesBasic:mocks.properties}));
vi.mock('../../ui/shell/viewerShell.js',()=>({shouldAutoShowProps:()=>true}));
function node(path:string,name:string,children:CbmNode[]=[]):CbmNode {
  return {path,name,children,devPath:'a.dev'} as CbmNode;
}
function fixture(children:CbmNode[]) {
  mocks.handle.mockClear();mocks.properties.mockClear();
  document.body.innerHTML='<aside id="props-drawer" class="collapsed"><div id="props-drawer-body">old properties</div></aside>';
  const state=new AppState();state.activateProject(1,'sha');state.currentCbmTree=node('project','project',children);
  const picked=new THREE.Group();picked.userData={rootOccurrence:'shared',instanceKey:'instance'};
  picked.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial()));
  state.loadedXmlModGroups.set('instance',picked);
  const ctx={fragments:{resetHighlight:vi.fn(async()=>{})}} as any;
  const request=state.beginSelection({kind:'cbm',key:'shared'});
  return {state,picked,ctx,request};
}
it('delegates a unique source to the ordinary guarded tree selection flow',async()=>{
  const chosen=node('shared','chosen'),f=fixture([chosen]);
  await selectViewportDev(f.ctx,f.state,'shared','instance',f.request,()=>{});
  expect(mocks.handle).toHaveBeenCalledWith(f.state,chosen,expect.any(Function),f.request);
});
it('replaces old highlight/attributes with explicit source choices and waits for the user',async()=>{
  const a=node('shared','A'),b=node('shared','B'),f=fixture([node('left','left',[a]),node('right','right',[b])]);
  const old=new THREE.Group();old.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial()));
  highlightModGroups(f.state,[old]);
  await selectViewportDev(f.ctx,f.state,'shared','instance',f.request,()=>{});
  expect(mocks.handle).not.toHaveBeenCalled();expect(mocks.properties).not.toHaveBeenCalled();
  expect(f.state.highlightedModState?.groups).toEqual([f.picked]);
  const choices=[...document.querySelectorAll<HTMLButtonElement>('.props-source-choice')];
  expect(choices.map(button=>button.textContent)).toEqual(['project / left / A','project / right / B']);
  expect(document.getElementById('props-drawer')?.classList.contains('collapsed')).toBe(false);
  choices[1].click();await vi.waitFor(()=>expect(mocks.properties).toHaveBeenCalledOnce());
  expect(mocks.properties.mock.calls[0][1]).toBe(b);expect(f.state.selectionGeometry?.status).toBe('ambiguous');
  choices[0].click();await Promise.resolve();expect(mocks.properties).toHaveBeenCalledOnce();
});
it('does not let an old source choice overwrite a newer selection',async()=>{
  const f=fixture([node('shared','A'),node('shared','B')]);
  await selectViewportDev(f.ctx,f.state,'shared','instance',f.request,()=>{});
  const choice=document.querySelector<HTMLButtonElement>('.props-source-choice')!;
  f.state.beginSelection({kind:'cbm',key:'new'});choice.click();await Promise.resolve();
  expect(mocks.properties).not.toHaveBeenCalled();expect(f.state.selectionRequest?.target?.key).toBe('new');
});
it('keeps the picked source highlighted but clears stale properties when no semantic node exists',async()=>{
  const f=fixture([]);
  const status=document.createElement('span');status.id='status-selection';document.body.append(status);
  const openingFeedback=vi.fn();
  await selectViewportDev(f.ctx,f.state,'shared','instance',f.request,openingFeedback);
  expect(openingFeedback).not.toHaveBeenCalled();
  expect(status.textContent).toContain('没有对应');
  expect(f.state.selectionMessage).toBe(status.textContent);
  expect(f.state.highlightedModState?.groups).toEqual([f.picked]);
  expect(document.getElementById('props-drawer-body')?.textContent).toContain('没有对应');
  expect(document.querySelectorAll('.props-source-choice')).toHaveLength(0);
  expect(mocks.handle).not.toHaveBeenCalled();
});
