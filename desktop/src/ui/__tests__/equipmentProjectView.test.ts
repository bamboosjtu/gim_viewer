import {it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {buildCbmTree} from '../../gim/cbmParser.js';

it('owns equipment tree listeners and prevents an outgoing disposer from removing new navigation',async()=>{
  document.body.innerHTML='<div id="cbm-tree-panel"></div><div id="empty-tip"></div><span id="project-title"></span>';
  document.body.insertAdjacentHTML('afterbegin', `
    <nav id="workspace-rail">
      <button class="rail-item" data-tab="tab-tree"></button>
      <button class="rail-item" data-tab="tab-filedev"></button>
      <button class="rail-item" data-tab="tab-models"></button>
      <button class="rail-item active" data-tab="tab-sld"></button>
    </nav><div class="tab-panel" id="tab-tree"></div><div class="tab-panel active" id="tab-sld"></div>`);
  vi.resetModules();
  const {createEquipmentProjectPresentation}=await import('../equipmentProjectView.js');
  const state=new AppState(),tree=await buildCbmTree(new Map([['project.cbm',new File(['PARTNAME=Unit'],'project.cbm')]]));
  const presentation=createEquipmentProjectPresentation(state),select=vi.fn(),first=new AbortController(),second=new AbortController();
  const dispose=presentation.navigation({name:'A',tree:tree!,onSelect:select,signal:first.signal});
  expect([...document.querySelectorAll<HTMLElement>('.rail-item:not(.hidden)')].map(b=>b.dataset.tab)).toEqual(['tab-tree']);
  expect(document.querySelector('.tab-panel.active')?.id).toBe('tab-tree');
  const row=document.querySelector<HTMLElement>('.tree-row')!;row.click();expect(select).toHaveBeenCalledOnce();
  first.abort();row.click();expect(select).toHaveBeenCalledOnce();
  const next=presentation.navigation({name:'B',tree:tree!,onSelect:select,signal:second.signal});
  presentation.navigation({name:'late A',tree:tree!,onSelect:select,signal:first.signal})();
  dispose();dispose();
  expect(document.querySelectorAll('.tree-row')).toHaveLength(1);expect(document.querySelector('#project-title')?.textContent).toBe('B');
  second.abort();next();expect(document.querySelectorAll('.tree-row')).toHaveLength(0);
});
