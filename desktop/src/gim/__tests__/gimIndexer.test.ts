import { describe, expect, it } from 'vitest';
import { scanIfcFiles, discoverIfcFromCBM } from '../gimIndexer.js';

function textFile(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

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
    const entries = await discoverIfcFromCBM(files);
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
    const entries = await discoverIfcFromCBM(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('DEV/一次设备.ifc');
  });

  it('DEV/ 与 CBM/ 均未命中时回退全局 basename 大小写不敏感匹配', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('SUBSYSTEM=root.cbm', 'project.cbm')],
      ['CBM/root.cbm', textFile('ENTITYNAME=F1System\nIFC.NUM=1\nIFC0=Model.IFC', 'root.cbm')],
      ['IFC/model.ifc', textFile('ISO-10303-21', 'm.ifc')],
    ]);
    const entries = await discoverIfcFromCBM(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('IFC/model.ifc');
  });

  it('完全无法解析时回退 DEV/ 拼接（保持旧行为可诊断）', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile('SUBSYSTEM=root.cbm', 'project.cbm')],
      ['CBM/root.cbm', textFile('ENTITYNAME=F1System\nIFC.NUM=1\nIFC0=缺失.ifc', 'root.cbm')],
    ]);
    const entries = await discoverIfcFromCBM(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('DEV/缺失.ifc');
  });
});
