import {it,expect,vi} from 'vitest';
import {AppState} from '../../app/state.js';
import {buildCbmTree} from '../../gim/cbmParser.js';

it('owns equipment tree listeners and prevents an outgoing disposer from removing new navigation',async()=>{
  document.body.innerHTML='<div id="cbm-tree-panel"></div><div id="empty-tip"></div><span id="project-title"></span>';
  vi.resetModules();
  const {createEquipmentProjectPresentation}=await import('../equipmentProjectView.js');
  const state=new AppState(),tree=await buildCbmTree(new Map([['project.cbm',new File(['PARTNAME=Unit'],'project.cbm')]]));
  const presentation=createEquipmentProjectPresentation(state),select=vi.fn(),first=new AbortController(),second=new AbortController();
  const dispose=presentation.navigation({name:'A',tree:tree!,onSelect:select,signal:first.signal});
  const row=document.querySelector<HTMLElement>('.tree-row')!;row.click();expect(select).toHaveBeenCalledOnce();
  first.abort();row.click();expect(select).toHaveBeenCalledOnce();
  const next=presentation.navigation({name:'B',tree:tree!,onSelect:select,signal:second.signal});
  presentation.navigation({name:'late A',tree:tree!,onSelect:select,signal:first.signal})();
  dispose();dispose();
  expect(document.querySelectorAll('.tree-row')).toHaveLength(1);expect(document.querySelector('#project-title')?.textContent).toBe('B');
  second.abort();next();expect(document.querySelectorAll('.tree-row')).toHaveLength(0);
});
