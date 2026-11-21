import { describe, expect, it, vi } from 'vitest';
import { scanIfcFiles, discoverIfcFromCBM } from '../gimIndexer.js';
import { buildCbmTree, collectIfcRefs } from '../cbmParser.js';

function textFile(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

it('discovers arbitrary CBM folders and repeated list references with one shared path index',async()=>{
  const files=new Map<string,File>([
    ['source/project.cbm',textFile('SUBSYSTEM=left.cbm\nSUBSYSTEM=right.cbm','project.cbm')],
    ['source/left.cbm',textFile('IFC.NUM=1\nIFC0=first.ifc','left.cbm')],
    ['source/right.cbm',textFile('IFC.NUM=1\nIFC0=second.ifc','right.cbm')],
    ['models/first.ifc',textFile('IFC','first.ifc')],['elsewhere/second.ifc',textFile('IFC','second.ifc')],
  ]);
  const keys=vi.spyOn(files,'keys'),left=vi.spyOn(files.get('source/left.cbm')!,'arrayBuffer'),right=vi.spyOn(files.get('source/right.cbm')!,'arrayBuffer');
  const discovery = await discoverIfcFromCBM(files);
  expect(discovery.entries).toHaveLength(2);expect(left).toHaveBeenCalledOnce();expect(right).toHaveBeenCalledOnce();
  expect(discovery).toMatchObject({cbmDiscoveredCount:2,inventoryFallbackCount:0});
  await discoverIfcFromCBM(files);expect(keys).toHaveBeenCalledOnce();
});
it('isolates a failed CBM read and preserves the delivered IFC inventory',async()=>{
  const file=textFile('','project.cbm'),files=new Map([['custom/project.cbm',file],['other/model.ifc',textFile('IFC','model.ifc')]]);
  vi.spyOn(file,'arrayBuffer').mockRejectedValue(Error('unreadable'));
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const discovery = await discoverIfcFromCBM(files);
  expect(discovery.entries.map(row=>row.path)).toEqual(['other/model.ifc']);expect(warn).toHaveBeenCalled();warn.mockRestore();
  expect(discovery).toMatchObject({cbmDiscoveredCount:0,inventoryFallbackCount:1});
});

it.each([false,true])('reports inventory fallback separately from CBM matches (with reference: %s)', async withReference => {
  const files = new Map([
    ['CBM/project.cbm', textFile(withReference ? 'IFC.NUM=1\nIFC0=a.ifc' : 'IFC.NUM=0', 'project.cbm')],
    ['models/a.ifc', textFile('IFC', 'a.ifc')],
    ['elsewhere/b.ifc', textFile('IFC', 'b.ifc')],
  ]);
  const enumerate = vi.spyOn(files, Symbol.iterator);
  const discovery = await discoverIfcFromCBM(files);
  expect(discovery.entries.map(entry => entry.path)).toEqual(['models/a.ifc', 'elsewhere/b.ifc']);
  expect(discovery.cbmDiscoveredCount).toBe(withReference ? 1 : 0);
  expect(discovery.inventoryFallbackCount).toBe(withReference ? 1 : 2);
  expect(enumerate).toHaveBeenCalledOnce();
});

describe('scanIfcFiles', () => {
  it('扫描全部目录下的 IFC（兼容 DEV/ 与 CBM/ 布局）', () => {
    const files = new Map<string, File>([
      ['DEV/一次设备.ifc', textFile('ISO-10303-21', 'a.ifc')],
      ['CBM/建筑.ifc', textFile('ISO-10303-21', 'b.ifc')],
      ['CBM/project.cbm', textFile('ENTITYNAME=F1System', 'p.cbm')],
      ['MOD/xx.mod', textFile('<Device/>', 'xx.mod')],
    ]);
    const entries = scanIfcFiles(files);
    expect(entries.map((e) => e.path).sort()).toEqual(['CBM/建筑.ifc', 'DEV/一次设备.ifc']);
  });

  it('无 IFC 返回空数组', () => {
    const files = new Map<string, File>([['CBM/project.cbm', textFile('A=1', 'p.cbm')]]);
    expect(scanIfcFiles(files)).toEqual([]);
  });
});

describe('discoverIfcFromCBM IFC 路径解析', () => {
  it('IFC 位于 CBM/ 时解析为实际路径（Bentley 布局）', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('SUBSYSTEM=root.cbm', 'project.cbm')],
      ['CBM/root.cbm', textFile('ENTITYNAME=F1System\nIFC.NUM=1\nIFC0=围墙.ifc', 'root.cbm')],
      ['CBM/围墙.ifc', textFile('ISO-10303-21', 'wall.ifc')],
    ]);
    const { entries } = await discoverIfcFromCBM(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('CBM/围墙.ifc');
    expect(entries[0].name).toBe('围墙');
  });

  it('IFC 位于 DEV/ 时保持原行为（JinQu 布局）', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('SUBSYSTEM=root.cbm', 'project.cbm')],
      ['CBM/root.cbm', textFile('ENTITYNAME=F1System\nIFC.NUM=1\nIFC0=一次设备.ifc', 'root.cbm')],
      ['DEV/一次设备.ifc', textFile('ISO-10303-21', 'dev.ifc')],
    ]);
    const { entries } = await discoverIfcFromCBM(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('DEV/一次设备.ifc');
  });

  it('DEV/ 与 CBM/ 均未命中时回退全局 basename 大小写不敏感匹配', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('SUBSYSTEM=root.cbm', 'project.cbm')],
      ['CBM/root.cbm', textFile('ENTITYNAME=F1System\nIFC.NUM=1\nIFC0=Model.IFC', 'root.cbm')],
      ['IFC/model.ifc', textFile('ISO-10303-21', 'm.ifc')],
    ]);
    const { entries } = await discoverIfcFromCBM(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('IFC/model.ifc');
  });

  it('完全无法解析时不生成虚假模型条目（保留告警供诊断）', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('SUBSYSTEM=root.cbm', 'project.cbm')],
      ['CBM/root.cbm', textFile('ENTITYNAME=F1System\nIFC.NUM=1\nIFC0=缺失.ifc', 'root.cbm')],
    ]);
    const { entries } = await discoverIfcFromCBM(files);
    expect(entries).toHaveLength(0);
  });

  it('工程级 IFC.NUM/IFCn 与节点级 IFCFILE/IFCGUID 进入同一 source model', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('SUBSYSTEM=root.cbm', 'project.cbm')],
      ['CBM/root.cbm', textFile([
        'ENTITYNAME=F4System',
        'IFC.NUM=1',
        'IFC0=model.ifc',
        'IFCFILE=CBM/model.ifc',
        'IFCGUID=component-guid',
      ].join('\n'), 'root.cbm')],
      ['CBM/model.ifc', textFile('ISO-10303-21', 'model.ifc')],
    ]);

    const { entries } = await discoverIfcFromCBM(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('CBM/model.ifc');
    const tree = await buildCbmTree(files);
    const refs = collectIfcRefs(tree!, entries);
    expect(Array.from(refs.values()).flatMap((guids) => Array.from(guids)))
      .toContain('component-guid');
  });
});
