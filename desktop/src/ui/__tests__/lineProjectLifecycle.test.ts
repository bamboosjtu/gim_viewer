import {expect,it,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import type {GimGraph} from '@gim/powerline-core/gimGraphTypes.js';
import { buildLineProjectProjection } from '../../features/powerline/presentation/lineProjectProjection.js';
import { perfCurrentSession } from '../../utils/perfTimings.js';

it('owns project DOM and invalidates old destroy handles when the view is replaced',async()=>{
  vi.resetModules();
  document.body.innerHTML=['viewport','cbm-tree-panel','file-dev-panel','model-list','props-drawer','props-drawer-body','empty-tip','status-right'].map(id=>`<div id="${id}"></div>`).join('');
  const {renderLineProjectPanels,destroyLineMapView}=await import('../lineProjectView.js');
  const state=new AppState(),graph={root:null,nodesByPath:new Map(),stats:{total:0},projectType:'transmission_line',warnings:[]} as unknown as GimGraph;
  try{
    const scope = state.sessionScope(state.activateProject(1, 'line-a'));
    const project = () => buildLineProjectProjection(state, graph, perfCurrentSession());
    const old=renderLineProjectPanels(state,project(),()=>{});
    scope.own(() => old.destroy());
    expect(document.getElementById('viewport')?.children.length).toBe(1);
    state.activateProject(2, 'line-b');
    expect(document.getElementById('viewport')?.children.length).toBe(0);
    const current=renderLineProjectPanels(state,project(),()=>{});
    old.destroy();
    expect(document.getElementById('viewport')?.children.length).toBe(1);
    current.destroy();current.destroy();
    expect(document.getElementById('viewport')?.children.length).toBe(0);
  }finally{destroyLineMapView();document.body.replaceChildren();}
});
