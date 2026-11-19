import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { extractEngineeringSourceGraph } from '@gim/gim-sdk/source';
import {buildTestEngineeringSources} from '../../../../packages/gim-sdk/src/gim/engineering/__tests__/fixtures.js';
import { projectEngineeringNavigation } from '@gim/gim-sdk/projection';

beforeEach(() => {
  vi.resetModules(); HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="cbm-tree-panel" class="tab-panel"></div><aside id="props-drawer"><div id="props-drawer-body"></div></aside><button id="btn-close-props"></button><button id="btn-export-props"></button>';
});
async function fixture(shared = false) {
  const raw: Record<string, string> = { 'project.cbm': `SUBSYSTEM0=unit.cbm${shared ? '\nSUBSYSTEM1=unit.cbm' : ''}`,
    'unit.cbm': 'ENTITYNAME=F2System\nOBJECTMODELPOINTER=root.dev\nSUBSYSTEM0=alias.cbm', 'root.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=box.dev',
    'box.dev': 'SYMBOLNAME=测控柜', 'alias.cbm': 'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=box.dev' };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(raw), readText: async path => raw[path] });
  const built = buildTestEngineeringSources('package', graph, [], []), state = new AppState(); state.activateProject(1, 'package'); state.currentProjectType = 'substation';
  state.engineering.sources = built.sources; state.engineering.snapshot = built.snapshot; state.engineering.navigation = projectEngineeringNavigation(built.sources, built.snapshot);
  return { state, ...built };
}
describe('source address links use the engineering identity chain', () => {
  it('routes a real PARTINDEX alias to its independently identified control cabinet', async () => {
    const f = await fixture(), { selectEngineeringCbmSource } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../engineeringCbmSelection.js'); });
    const request = f.state.selection.beginSelection({ kind: 'engineering-source', key: 'alias.cbm' });
    expect(await selectEngineeringCbmSource(f.state, 'alias.cbm', request)).toBe(true);
    const box = f.snapshot.entities.find(entity => entity.category === 'E17')!;
    expect(f.state.selection.selectionRequest?.target).toEqual({ kind: 'engineering', key: box.id });
    expect(document.querySelector('.props-header')?.textContent).toBe('测控柜');
  });
  it('keeps multiple occurrences of one source document as explicit candidates', async () => {
    const f = await fixture(true), { selectEngineeringCbmSource } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../engineeringCbmSelection.js'); });
    const request = f.state.selection.beginSelection({ kind: 'engineering-source', key: 'unit.cbm' });
    await selectEngineeringCbmSource(f.state, 'unit.cbm', request);
    expect(f.state.selection.engineeringSelection).toBeNull(); expect(f.state.selection.selectionRequest?.target?.key).toBe('document:unit.cbm');
    expect(document.querySelectorAll('[data-source-candidate]')).toHaveLength(2);
  });
  it('does not apply a late source link after a newer user selection', async () => {
    const f = await fixture(), { selectEngineeringCbmSource } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../engineeringCbmSelection.js'); });
    const request = f.state.selection.beginSelection({ kind: 'engineering-source', key: 'unit.cbm' });
    f.state.selection.beginSelection({ kind: 'engineering', key: 'newer' });
    expect(await selectEngineeringCbmSource(f.state, 'unit.cbm', request)).toBe(false);
    expect(f.state.selection.selectionRequest?.target?.key).toBe('newer');
  });
});
