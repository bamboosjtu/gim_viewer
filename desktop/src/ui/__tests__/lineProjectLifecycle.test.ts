import {expect,it,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import type {GimGraph} from '../../gim/gimGraphTypes.js';

it('owns project DOM and invalidates old destroy handles when the view is replaced',async()=>{
  vi.resetModules();
  document.body.innerHTML=['viewport','cbm-tree-panel','file-dev-panel','model-list','props-drawer','props-drawer-body','empty-tip','status-right'].map(id=>`<div id="${id}"></div>`).join('');
  const {renderLineProjectPanels,destroyLineMapView}=await import('../lineProjectView.js');
  const state=new AppState(),graph={root:null,nodesByPath:new Map(),stats:{total:0},projectType:'transmission_line',warnings:[]} as unknown as GimGraph;
  try{
    const old=renderLineProjectPanels(state,graph,()=>{});
    expect(document.getElementById('viewport')?.children.length).toBe(1);
    const current=renderLineProjectPanels(state,graph,()=>{});
    old.destroy();
    expect(document.getElementById('viewport')?.children.length).toBe(1);
    current.destroy();current.destroy();
    expect(document.getElementById('viewport')?.children.length).toBe(0);
  }finally{destroyLineMapView();document.body.replaceChildren();}
});
