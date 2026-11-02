import { expect, it } from 'vitest';
import { AppState } from '../../app/state.js';
import { renderCbmTreeUI } from '../cbmTreeView.js';
import type { CbmNode } from '../../gim/types.js';
function node(overrides: Partial<CbmNode> = {}): CbmNode {
  return {
    path: 'CBM/project.cbm',
    name: '工程',
    entityName: 'F1System',
    children: [],
    famPath: '',
    devPath: '',
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: '',
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
    ...overrides,
  };
}

it('retains lazy expansion accessibility for the active equipment source tree', () => {
  const root = node({children:[node({path:'CBM/child.cbm',name:'子节点',entityName:'F4System'})]});
  const host = document.createElement('div');
  renderCbmTreeUI(new AppState(), root, host, () => {});
  const row = host.querySelector<HTMLElement>('.tree-row')!;
  expect(row.getAttribute('aria-expanded')).toBe('false');
  row.querySelector<HTMLElement>('.tree-toggle')!.click();
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelectorAll('.tree-row')).toHaveLength(2);
});
