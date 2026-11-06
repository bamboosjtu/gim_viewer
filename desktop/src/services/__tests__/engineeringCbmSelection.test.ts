import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import { projectEngineeringNavigation } from '../../gim/engineering/navigation.js';

beforeEach(() => {
  vi.resetModules(); HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="cbm-tree-panel" class="tab-panel"></div><aside id="props-drawer"><div id="props-drawer-body"></div></aside><button id="btn-close-props"></button><button id="btn-export-props"></button>';
});
async function fixture(shared = false) {
  const raw: Record<string, string> = { 'project.cbm': `SUBSYSTEM0=unit.cbm${shared ? '\nSUBSYSTEM1=unit.cbm' : ''}`,
    'unit.cbm': 'ENTITYNAME=F2System\nOBJECTMODELPOINTER=root.dev\nSUBSYSTEM0=alias.cbm', 'root.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=box.dev',
    'box.dev': 'SYMBOLNAME=测控柜', 'alias.cbm': 'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=box.dev' };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(raw), readText: async path => raw[path] });
  const built = buildEngineeringSources('package', graph, [], []), state = new AppState(); state.activateProject(1, 'package'); state.currentProjectType = 'substation';
  state.engineeringSources = built.sources; state.engineeringSnapshot = built.snapshot; state.engineeringNavigation = projectEngineeringNavigation(built.sources, built.snapshot);
  return { state, ...built };
}
describe('source address links use the engineering identity chain', () => {
  it('routes a real PARTINDEX alias to its independently identified control cabinet', async () => {
    const f = await fixture(), { selectEngineeringCbmSource } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../engineeringCbmSelection.js'); });
    const request = f.state.beginSelection({ kind: 'engineering-source', key: 'alias.cbm' });
    expect(await selectEngineeringCbmSource(f.state, 'alias.cbm', request)).toBe(true);
    const box = f.snapshot.entities.find(entity => entity.category === 'E16.control_cabinet')!;
    expect(f.state.selectionRequest?.target).toEqual({ kind: 'engineering', key: box.id });
    expect(document.querySelector('.props-header')?.textContent).toBe('测控柜');
  });
  it('keeps multiple occurrences of one source document as explicit candidates', async () => {
    const f = await fixture(true), { selectEngineeringCbmSource } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../engineeringCbmSelection.js'); });
    const request = f.state.beginSelection({ kind: 'engineering-source', key: 'unit.cbm' });
    await selectEngineeringCbmSource(f.state, 'unit.cbm', request);
    expect(f.state.engineeringSelection).toBeNull(); expect(f.state.selectionRequest?.target?.key).toBe('document:unit.cbm');
    expect(document.querySelectorAll('[data-source-candidate]')).toHaveLength(2);
  });
  it('does not apply a late source link after a newer user selection', async () => {
    const f = await fixture(), { selectEngineeringCbmSource } = await import('../../app/presentationBindings.js').then(({configurePresentation}) => { configurePresentation(); return import('../engineeringCbmSelection.js'); });
    const request = f.state.beginSelection({ kind: 'engineering-source', key: 'unit.cbm' });
    f.state.beginSelection({ kind: 'engineering', key: 'newer' });
    expect(await selectEngineeringCbmSource(f.state, 'unit.cbm', request)).toBe(false);
    expect(f.state.selectionRequest?.target?.key).toBe('newer');
  });
});
