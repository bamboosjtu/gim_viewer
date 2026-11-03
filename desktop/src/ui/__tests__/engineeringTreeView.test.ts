import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import type { CbmNode } from '../../gim/types.js';
import { projectEngineeringNavigation } from '../../gim/engineering/navigation.js';

async function fixture() {
  const files: Record<string, string> = {
    'project.cbm': 'SUBSYSTEM0=unit.cbm',
    'unit.cbm': 'ENTITYNAME=F2System\nOBJECTMODELPOINTER=body.dev\nNAME=主变系统',
    'body.dev': 'SYMBOLNAME=1号主变压器\nSUBDEVICE0=box.dev\nSUBDEVICE1=radiator.dev',
    'box.dev': 'SYMBOLNAME=1号主变测控柜', 'radiator.dev': 'SYMBOLNAME=散热器',
  };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(files), readText: async p => files[p] });
  const state = new AppState(); state.activateProject(1, 'package'); state.currentProjectType = 'substation';
  const built = buildEngineeringSources('package', graph, [], []);
  state.engineeringSources = built.sources; state.engineeringSnapshot = built.snapshot; state.engineeringStatus = 'ready';
  state.engineeringNavigation = projectEngineeringNavigation(built.sources, built.snapshot);
  state.projectName = '测试变电工程';
  const node = (path: string, children: CbmNode[] = []): CbmNode => ({ path, children, rawProperties: {}, name: path, entityName: 'F4System', famPath: '', devPath: '', ifcFile: '', ifcGuid: '', classifyName: '', transformMatrix: '', systemNames: [], devSymbolName: '', devType: '', devExpanded: false });
  state.currentCbmTree = node('project.cbm', [node('unit.cbm')]);
  return { state, graph, main: built.snapshot.entities.find(e => e.category === 'E01')!, box: built.snapshot.entities.find(e => e.category === 'E16.control_cabinet')! };
}
beforeEach(() => {
  vi.resetModules(); HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="cbm-tree-panel" class="tab-panel"></div><aside id="props-drawer"><div id="props-drawer-body"></div></aside><button id="btn-close-props"></button><button id="btn-export-props"></button>';
});
const search = (value: string) => { const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!; input.value = value; input.dispatchEvent(new Event('input')); };
describe('engineering composition and provenance navigation', () => {
  it('shows four top-level groups and selects an unresolved neutral attachment without selecting a main body',async()=>{
    const raw:Record<string,string>={'project.cbm':'SUBSYSTEM0=body.cbm\nSUBSYSTEM1=neutral.cbm','body.cbm':'OBJECTMODELPOINTER=body.dev','body.dev':'SYMBOLNAME=主变压器',
      'neutral.cbm':'OBJECTMODELPOINTER=neutral.dev','neutral.dev':'TYPE=OpenGroundingEquipment/NeutralPointEquipment\nSYMBOLNAME=220kV中性点成套装置'};
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]}),built=buildEngineeringSources('p',graph,[],[]);
    const state=new AppState();state.activateProject(1,'p');state.currentProjectType='substation';state.engineeringSources=built.sources;state.engineeringSnapshot=built.snapshot;
    state.engineeringNavigation=projectEngineeringNavigation(built.sources,built.snapshot);state.engineeringNavMode='inventory';
    const inventory=state.engineeringNavigation.inventory!;
    for(const node of inventory.nodes.values())if(node.kind==='group'||node.kind==='project')state.engineeringExpandedRows.inventory.add(node.key);
    const {renderEngineeringTree}=await import('../engineeringTreeView.js');renderEngineeringTree(state);
    expect(inventory.nodes.get(inventory.rootKey)!.children.map(key=>inventory.nodes.get(key)!.title)).toEqual(['设备','装置性材料','构件','其他']);
    const group=[...inventory.nodes.values()].find(n=>n.title==='附件（并入本体）')!;
    [...document.querySelectorAll<HTMLElement>('.tree-row')].find(r=>r.dataset.nodePath===group.key)!.click();
    await vi.dynamicImportSettled();await vi.waitFor(()=>expect(state.engineeringSelection?.ownerIds).toEqual(new Set([built.snapshot.pending[0].id])));
    expect(document.getElementById('props-drawer-body')?.textContent).toContain('中性点成套附件');
    expect(state.engineeringSelection!.ownerIds.has(built.snapshot.entities[0].id)).toBe(false);
  });
  it('renders inventory subtype groups with its own catalog search and selectable whole range',async()=>{
    const f=await fixture(),view=f.state.engineeringNavigation!,inventory=view.inventory!,key=inventory.rowsByEntity.get(f.box.id)![0];
    let cursor:string|undefined=key;
    while(cursor){f.state.engineeringExpandedRows.inventory.add(cursor);cursor=inventory.nodes.get(cursor)?.parent;}
    f.state.engineeringNavMode='inventory';const {renderEngineeringTree}=await import('../engineeringTreeView.js');renderEngineeringTree(f.state);
    const panel=document.getElementById('cbm-tree-panel')!;
    expect(panel.querySelector('.substation-nav-mode')?.nextElementSibling?.classList.contains('search-box-wrap')).toBe(true);
    const template=inventory.nodes.get(inventory.nodes.get(key)!.parent!)!;
    const group=inventory.nodes.get(template.parent!)!;
    expect(template.kind).toBe('template');expect(template.title).toBe('主变测控柜');
    expect(group.title).toBe('控制柜');expect(view.inventorySearch!.find(r=>r.key===f.box.id)?.subtitle).toBe('设备材料清册 / 设备 / 二次设备 / 控制柜 / 主变测控柜');
    const item=[...document.querySelectorAll<HTMLElement>('.tree-row')].find(r=>r.dataset.nodePath===template.key)!;
    item.click();await vi.dynamicImportSettled();
    await vi.waitFor(()=>expect(f.state.engineeringSelection?.ownerIds).toEqual(new Set([f.box.id])));
    expect(document.querySelector('.props-header')?.textContent).toBe('主变测控柜');
  });
  it('labels inferred composition rows and exposes the evidence in the inspector',async()=>{
    const f=await fixture(),view=f.state.engineeringNavigation!.composition,key=view.rowsByEntity.get(f.main.id)![0],node=view.nodes.get(key)!;
    f.state.engineeringNavMode='composition';
    node.inferred=true;node.evidence=['spatial-building-footprint','composition-spatial-v1'];
    let cursor:string|undefined=key;
    while(cursor){f.state.engineeringExpandedRows.composition.add(cursor);cursor=view.nodes.get(cursor)?.parent;}
    const {renderEngineeringTree}=await import('../engineeringTreeView.js');renderEngineeringTree(f.state);
    const row=[...document.querySelectorAll<HTMLElement>('.tree-row')].find(r=>r.dataset.nodePath===key)!;
    expect(row.textContent).toContain('空间推断');row.click();
    await vi.dynamicImportSettled();
    await vi.waitFor(()=>expect(document.querySelector('.props-header')?.textContent).toBe(f.main.name));
    expect(document.getElementById('props-drawer-body')?.textContent).toContain('空间推断，工程归属待确认');
    expect(document.getElementById('props-drawer-body')?.textContent).toContain('composition-spatial-v1');
  });
  it('keeps DEV F levels explicit and exposes the JSON export action', async () => {
    const f = await fixture(), { renderEngineeringTree } = await import('../engineeringTreeView.js');
    f.state.engineeringNavMode = 'source'; renderEngineeringTree(f.state);
    expect(document.body.textContent).toContain('DEV 轨道（F1 / F2 / F3 / F4）');
    expect([...f.state.engineeringNavigation!.sourceNodes.values()].some(node => node.fLevel === 'F2' && node.documentPath === 'unit.cbm')).toBe(true);
    expect(document.querySelector('.substation-nav-export')?.textContent).toBe('导出 JSON');
  });
  it('distinguishes same-name cabinets by their engineering bay when searching an internal button', async () => {
    const raw: Record<string, string> = { 'project.cbm': 'SUBSYSTEM0=36.cbm\nSUBSYSTEM1=24.cbm',
      '36.cbm': 'SYSTEMNAME2=10kV系统\nSYSTEMNAME3=36S\nOBJECTMODELPOINTER=cabinet.dev',
      '24.cbm': 'SYSTEMNAME2=10kV系统\nSYSTEMNAME3=24S\nOBJECTMODELPOINTER=cabinet.dev',
      'cabinet.dev': 'TYPE=SwitchCabinet\nSYMBOLNAME=出线柜\nSUBDEVICE0=button.dev', 'button.dev': 'TYPE=Button\nSYMBOLNAME=按钮' };
    const graph = await extractEngineeringSourceGraph({ paths: Object.keys(raw), readText: async path => raw[path] });
    const built = buildEngineeringSources('package', graph, [], []), state = new AppState(); state.activateProject(1, 'package'); state.currentProjectType = 'substation';
    state.engineeringSources = built.sources; state.engineeringSnapshot = built.snapshot; state.engineeringNavigation = projectEngineeringNavigation(built.sources, built.snapshot);
    state.engineeringNavMode = 'composition';
    const { renderEngineeringTree } = await import('../engineeringTreeView.js'); renderEngineeringTree(state); search('按钮');
    const hits = [...document.querySelectorAll<HTMLElement>('[role="option"]')]; expect(hits).toHaveLength(2);
    expect(hits.map(hit => hit.textContent).join(' / ')).toContain('24S间隔');
    const target = hits.find(hit => hit.textContent?.includes('36S间隔'))!; expect(target.textContent).not.toContain('按钮'); target.click();
    await vi.dynamicImportSettled(); await vi.waitFor(() => expect(document.querySelector('.props-header')?.textContent).toBe('出线柜'));
    const occurrence = graph.cbmOccurrences.find(node => node.documentPath === '36.cbm')!.id;
    const selected = graph.records.filter(row => state.engineeringSelection?.sourceIds.has(row.id));
    expect(selected).toHaveLength(2); expect(selected.every(row => row.devOccurrence?.cbmOccurrenceId === occurrence)).toBe(true);
    expect(state.engineeringSnapshot?.entities).toHaveLength(2);
  });
  it('shows an unassigned declared building and opens its original statement without inventing a geometry range', async () => {
    const raw: Record<string,string> = { 'project.cbm': 'SUBSYSTEM0=building.cbm', 'building.cbm': 'SYSTEMNAME1=建筑物系统\nSYSTEMNAME2=生产建筑物\nSYSTEMNAME3=主控通信楼01' };
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async path=>raw[path]}), built=buildEngineeringSources('package',graph,[],[]);
    const state=new AppState();state.activateProject(1,'package');state.currentProjectType='substation';
    state.engineeringSources=built.sources;state.engineeringSnapshot=built.snapshot;state.engineeringNavigation=projectEngineeringNavigation(built.sources,built.snapshot);state.engineeringStatus='ready';
    state.engineeringNavMode='composition';
    const data=state.engineeringNavigation.composition, building=[...data.nodes.values()].find(node=>node.title==='主控通信楼01')!;
    state.engineeringExpandedRows.composition.add(data.rootKey);state.engineeringExpandedRows.composition.add(building.parent!);
    const {renderEngineeringTree}=await import('../engineeringTreeView.js');renderEngineeringTree(state);
    const row=[...document.querySelectorAll<HTMLElement>('.tree-row')].find(row=>row.dataset.nodePath===building.key)!;
    expect(row.textContent).toContain('归属待确认');row.click();
    await vi.dynamicImportSettled();
    await vi.waitFor(()=>expect(document.querySelector('.props-header')?.textContent, state.selectionMessage).toBe('主控通信楼01'));
    expect(document.body.textContent).toContain('尚无可靠的整体归属');
    expect((document.getElementById('engineering-fit') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('engineering-isolate') as HTMLButtonElement).disabled).toBe(true);
    document.querySelector<HTMLElement>(`[data-node-path="${building.parent}"]`)!.click();
    await vi.waitFor(()=>expect(document.querySelector('.props-header')?.textContent).toBe('建筑工程'));
    expect((document.getElementById('engineering-fit') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('engineering-isolate') as HTMLButtonElement).disabled).toBe(true);
    document.querySelector<HTMLElement>(`[data-node-path="${building.key}"]`)!.click();
    await vi.waitFor(()=>expect(document.querySelector('.props-header')?.textContent).toBe('主控通信楼01'));
    document.querySelector<HTMLButtonElement>('[data-itab="source"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-engineering-declaration-index]')!.click();
    await vi.waitFor(()=>expect(state.engineeringNavMode).toBe('source'));
    expect(state.selectionRequest?.target?.key).toBe('document:building.cbm');
  });
  it('reveals the last of 600 whole candidates through a bounded window and keeps keyboard focus on status-only updates', async () => {
    const raw: Record<string, string> = { 'project.cbm': Array.from({ length: 600 }, (_, i) => `SUBSYSTEM${i}=item${i}.cbm`).join('\n') };
    for (let i = 0; i < 600; i++) { raw[`item${i}.cbm`] = `OBJECTMODELPOINTER=item${i}.dev`; raw[`item${i}.dev`] = `SYMBOLNAME=钢梁${i}`; }
    const graph = await extractEngineeringSourceGraph({ paths: Object.keys(raw), readText: async path => raw[path] }), built = buildEngineeringSources('package', graph, [], []);
    const state = new AppState(); state.currentProjectType = 'substation'; state.engineeringSnapshot = built.snapshot; state.engineeringSources = built.sources; state.engineeringNavigation = projectEngineeringNavigation(built.sources, built.snapshot);
    state.engineeringNavMode = 'composition';
    const { renderEngineeringTree } = await import('../engineeringTreeView.js'); renderEngineeringTree(state);
    search('钢梁599'); document.querySelector<HTMLElement>('[role="option"]')!.click(); await vi.dynamicImportSettled();
    const row = document.querySelector<HTMLElement>('.tree-row.selected')!;
    expect(row.textContent).toContain('钢梁599'); expect(document.querySelectorAll('.tree-row').length).toBeLessThanOrEqual(120);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const first = document.activeElement as HTMLElement; expect(first.dataset.nodePath).toBe(state.engineeringNavigation.composition.rootKey);
    state.notifyEngineeringChanged(); expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('钢梁599');
  });
  it('offers three independent views while source facts are still preparing', async () => {
    const state = new AppState(); state.currentProjectType = 'substation';
    const { buildAndRenderCbmTree } = await import('../cbmTreeView.js'); buildAndRenderCbmTree(state, vi.fn());
    expect([...document.querySelectorAll('.substation-nav-mode-btn')].map(b => b.textContent)).toEqual(['清册', '工程', '来源']);
    expect(document.getElementById('cbm-tree-panel')?.firstElementChild?.classList.contains('substation-nav-mode')).toBe(true);
    expect(document.body.textContent).toContain('正在识别工程整体');
    document.querySelector<HTMLButtonElement>('[data-engineering-mode="source"]')!.click();
    expect(document.body.textContent).toContain('正在读取来源引用与装配');
  });
  it('searches an internal source into its whole, then traces it to the actual assembly and back', async () => {
    const f = await fixture();
    const { buildAndRenderCbmTree } = await import('../cbmTreeView.js'); f.state.engineeringNavMode='composition'; buildAndRenderCbmTree(f.state, vi.fn());
    search('散热器'); const hits = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(hits).toHaveLength(1); expect(hits[0].textContent).toContain('主变压器'); hits[0].click();
    expect(f.state.selectionRequest?.target).toEqual({ kind: 'engineering', key: f.main.id });
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(document.querySelector('.props-header')?.textContent, f.state.selectionMessage).toBe('1号主变压器'));
    expect([...document.querySelectorAll('.tree-row .tree-label')].some(row => row.textContent === '散热器')).toBe(false);
    const radiator = f.graph.records.find(r => r.name === '散热器')!;
    const source = [...document.querySelectorAll<HTMLButtonElement>('[data-engineering-source-index]')].find(b => b.textContent === '散热器')!; source.click();
    await vi.waitFor(() => expect(f.state.engineeringNavMode).toBe('source'));
    await vi.waitFor(() => expect(document.querySelector('.tree-row.selected')?.textContent).toContain('散热器'));
    await vi.waitFor(() => expect(document.querySelector('.props-header')?.textContent).toBe('散热器'));
    expect(f.state.selectionRequest?.target).toEqual({ kind: 'engineering-source', key: radiator.id });
    document.getElementById('engineering-owner')!.click();
    await vi.waitFor(() => expect(document.querySelector('.props-header')?.textContent).toBe('1号主变压器'));
    expect(f.state.engineeringNavMode).toBe('composition');
    expect(f.state.engineeringSnapshot?.entities).toHaveLength(2);
  });
  it('preserves an independent nested control cabinet and expanded rows when views refresh', async () => {
    const f = await fixture(), { renderEngineeringTree } = await import('../engineeringTreeView.js'); f.state.engineeringNavMode='composition'; renderEngineeringTree(f.state);
    search('测控柜'); document.querySelector<HTMLElement>('[role="option"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.props-header')?.textContent).toBe('1号主变测控柜'));
    expect(f.state.engineeringSelection?.ownerIds).toEqual(new Set([f.box.id]));
    const expanded = [...f.state.engineeringExpandedRows.composition];
    f.state.notifyEngineeringChanged();
    expect([...f.state.engineeringExpandedRows.composition]).toEqual(expanded);
    expect(document.querySelector('.tree-row.selected')?.textContent).toContain('测控柜');
    const request = f.state.selectionRequest!.id;
    document.querySelector<HTMLButtonElement>('[data-engineering-mode="source"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-engineering-mode="composition"]')!.click();
    expect(f.state.selectionRequest?.id).toBe(request);
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')?.value).toBe('测控柜');
  });
  it('reads all raw source lines by pages and rejects stale document page actions', async () => {
    const f = await fixture(), doc = f.graph.documents.find(d => d.path === 'unit.cbm')!;
    for (let i = 0; i < 450; i++) doc.rawLines.push(`原始字段${i}=值${i}`);
    const { inspectEngineeringDocument } = await import('../../services/engineeringSourceInspector.js');
    await inspectEngineeringDocument(f.state, doc.path);
    document.querySelector<HTMLButtonElement>('[data-itab="source"]')?.click();
    expect(document.querySelector('[data-itab-pane="source"]')?.textContent).toContain('原始字段0');
    const next = document.querySelector<HTMLButtonElement>('[data-itab-pane="source"] [data-source-page="1"]')!; next.click();
    expect(document.querySelector('[data-itab-pane="source"]')?.textContent).toContain('原始字段200');
    f.state.beginSelection({ kind: 'engineering', key: f.main.id });
    const header = document.querySelector('.props-header')?.textContent; next.click();
    expect(document.querySelector('.props-header')?.textContent).toBe(header);
    expect(f.state.selectionRequest?.target?.key).toBe(f.main.id);
  });
  it('inspects IFC space provenance without turning a building into an engineering entity', async () => {
    const f = await fixture(), { buildSubstationSpatialIndexFromTexts } = await import('../../gim/ifcSpatialParser.js');
    const spatial = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' }, text: [
      "#1=IFCBUILDING('b',$,'主控楼',$,$,$,$,$,.ELEMENT.,$,$,$);", "#2=IFCWALL('w',$,'主控楼墙',$,$,$,$,$);", "#3=IFCRELCONTAINEDINSPATIALSTRUCTURE('r',$,$,$,(#2),#1);",
    ].join('\n') }], null);
    f.graph.ifcPaths.push('delivery.ifc');
    const built = buildEngineeringSources('package', f.graph, spatial.objects, spatial.models, spatial.nodes);
    f.state.engineeringSources = built.sources; f.state.engineeringSnapshot = built.snapshot; f.state.engineeringNavigation = projectEngineeringNavigation(built.sources, built.snapshot);
    const count = built.snapshot.entities.length, { renderEngineeringTree } = await import('../engineeringTreeView.js');
    f.state.engineeringNavMode = 'source'; renderEngineeringTree(f.state); search('主控楼');
    const hit = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(row => row.firstElementChild?.textContent === '主控楼')!; hit.click();
    expect(f.state.selectionRequest?.target?.key).toBe(`context:${spatial.nodes[0].key}`);
    await vi.dynamicImportSettled();
    expect(document.querySelector('.props-header')?.textContent).toBe('主控楼');
    expect(document.body.textContent).toContain('IFC 交付空间容器'); expect(document.body.textContent).toContain('主控楼墙');
    expect([...f.state.engineeringNavigation!.sourceNodes.values()].some(node => node.kind === 'ifc-file' && node.title === 'delivery' && node.documentPath === 'delivery.ifc')).toBe(true);
    expect(f.state.engineeringSnapshot?.entities).toHaveLength(count);
  });
  it('loads detailed IFC source properties explicitly and refuses a late reply after another whole is selected', async () => {
    const f = await fixture(), { buildSubstationSpatialIndexFromTexts } = await import('../../gim/ifcSpatialParser.js');
    const spatial = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' }, text: "#2=IFCWALL('w',$,'墙',$,$,$,$,$);" }], null);
    f.graph.ifcPaths.push('delivery.ifc'); const built = buildEngineeringSources('package', f.graph, spatial.objects, spatial.models, spatial.nodes);
    f.state.engineeringSources = built.sources; f.state.engineeringSnapshot = built.snapshot; f.state.engineeringNavigation = projectEngineeringNavigation(built.sources, built.snapshot);
    let resolve!: (value: unknown) => void;
    const properties = vi.fn(() => new Promise<any>(done => { resolve = done; }));
    f.state.ifcRegionalRuntimes.set('m', { properties } as any);
    const { selectEngineeringTarget } = await import('../../services/engineeringSelection.js');
    await selectEngineeringTarget(f.state, { kind: 'engineering-source', key: built.sources.ifcRecords[0].id });
    expect(properties).not.toHaveBeenCalled(); document.getElementById('engineering-details')!.click();
    expect(properties).toHaveBeenCalledWith(2);
    await selectEngineeringTarget(f.state, { kind: 'engineering', key: f.main.id });
    resolve({ attributes: { Name: 'Old IFC properties' }, propertySets: [] });
    await vi.waitFor(() => expect(document.querySelector('.props-header')?.textContent).toBe('1号主变压器'));
    expect(document.body.textContent).not.toContain('Old IFC properties');
  });
});
