import { describe, expect, it,vi,afterEach } from 'vitest';
import { engineeringTreeExport,downloadEngineeringTree,copyEngineeringTree } from '../engineeringTreeExport.js';
const mocks=vi.hoisted(()=>({native:vi.fn(()=>false),save:vi.fn(),download:vi.fn()}));
vi.mock('@desktop/runtime.js',()=>({isTauri:mocks.native}));
vi.mock('@desktop/treeExport.js',()=>({saveEngineeringTreeJson:mocks.save}));
vi.mock('../../shared/csv.js',()=>({downloadTextFile:mocks.download}));
afterEach(()=>{vi.clearAllMocks();mocks.native.mockReturnValue(false);vi.unstubAllGlobals();});
import type { EngineeringNavigationData } from '../../services/engineeringViewService.js';

const data: EngineeringNavigationData = {
  version: 'test',
  composition: {
    version: 'test', rootKey: 'root',
    nodes: new Map([
      ['root', { key: 'root', title: '工程组成', kind: 'project', children: ['group'], entityCount: 1, evidence: [] }],
      ['group', { key: 'group', title: '主变压器系统', kind: 'group', parent: 'root', children: ['whole'], entityCount: 1, evidence: ['declared'] }],
      ['whole', { key: 'whole', title: '1号主变', kind: 'entity', parent: 'group', children: [], entityCount: 1, targetId: 'entity:1', evidence: [] }],
    ]),
    rowsByEntity: new Map([['entity:1', ['whole']]]),
  },
  sourceNodes: new Map([
    ['source:project', { key: 'source:project', title: 'GIM 来源（DEV / IFC）', kind: 'group', children: ['source:cbm', 'source:ifc'] }],
    ['source:cbm', { key: 'source:cbm', title: 'DEV 轨道（F1 / F2 / F3 / F4）', kind: 'group', parent: 'source:project', children: ['f4'] }],
    ['f4', { key: 'f4', title: 'F4 主变', kind: 'cbm', parent: 'source:cbm', children: [], fLevel: 'F4', documentPath: 'F4.cbm' }],
    ['source:ifc', { key: 'source:ifc', title: 'IFC 轨道（逐文件）', kind: 'group', parent: 'source:project', children: ['ifc'] }],
    ['ifc', { key: 'ifc', title: 'delivery.ifc', kind: 'ifc-file', parent: 'source:ifc', children: [], documentPath: 'delivery.ifc' }],
  ]),
  sourceRoot: 'source:project', sourceRows: new Map([['s1', 'f4']]),
  compositionSearch: [], sourceSearch: [],
};

describe('engineering model tree export', () => {
  it('uses a confirmed native save result and reports cancellation and write errors',async()=>{
    mocks.native.mockReturnValue(true);mocks.save.mockResolvedValueOnce('C:/trees/P.json').mockResolvedValueOnce(null).mockRejectedValueOnce(Error('write denied'));
    expect(await downloadEngineeringTree(data,'composition','P')).toBe('C:/trees/P.json');
    expect(JSON.parse(mocks.save.mock.calls[0][1]).root.children[0].children[0].targetId).toBe('entity:1');
    expect(await downloadEngineeringTree(data,'composition','P')).toBeNull();
    await expect(downloadEngineeringTree(data,'composition','P')).rejects.toThrow('write denied');expect(mocks.download).not.toHaveBeenCalled();
  });
  it('downloads the whole browser tree and copies the same JSON to the clipboard',async()=>{
    expect(await downloadEngineeringTree(data,'source','P')).toBe('P-来源模型树.json');
    const writeText=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{writeText}});
    await copyEngineeringTree(data,'source','P');expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(JSON.parse(mocks.download.mock.calls[0][1]));
    writeText.mockRejectedValueOnce(Error('clipboard denied'));await expect(copyEngineeringTree(data,'source','P')).rejects.toThrow('clipboard denied');
  });
  it('exports the active composition tree with entity references', () => {
    const out = engineeringTreeExport(data, 'composition', 'P');
    expect(out.schema).toBe('gim-engineering-tree-v1');
    expect(out.root.children[0].children[0]).toMatchObject({ title: '1号主变', targetId: 'entity:1' });
  });

  it('exports inferred projection status and its evidence without changing entity references',()=>{
    const view={...data,composition:{...data.composition,nodes:new Map(data.composition.nodes)}};
    view.composition.nodes.set('whole',{...view.composition.nodes.get('whole')!,inferred:true,evidence:['spatial-building-footprint','composition-spatial-v1']});
    const out=engineeringTreeExport(view,'composition','P').root.children[0].children[0];
    expect(out).toMatchObject({targetId:'entity:1',inferred:true,evidence:['spatial-building-footprint','composition-spatial-v1']});
    expect(data.composition.nodes.get('whole')?.inferred).toBeUndefined();
  });

  it('exports the source tree with F level and IFC file nodes', () => {
    const out = engineeringTreeExport(data, 'source', 'P');
    expect(out.mode).toBe('source');
    expect(out.root.children.map(node => node.title)).toEqual(['DEV 轨道（F1 / F2 / F3 / F4）', 'IFC 轨道（逐文件）']);
    expect(out.root.children[0].children[0]).toMatchObject({ fLevel: 'F4', documentPath: 'F4.cbm' });
    expect(out.root.children[1].children[0]).toMatchObject({ title: 'delivery.ifc', kind: 'ifc-file' });
  });
});
