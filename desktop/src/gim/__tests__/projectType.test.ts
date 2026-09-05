import { describe, expect, it, vi } from 'vitest';
import { detectGimProjectType } from '../projectType.js';

function lazyTextFile(text: string): File {
  return {
    size: text.length,
    text: vi.fn(async () => text),
  } as unknown as File;
}

describe('detectGimProjectType', () => {
  it('标准线路目录布局不逐个读取 DiskBackedFile 文本', async () => {
    const project = lazyTextFile('SUBSYSTEM=F1.cbm');
    const dev = lazyTextFile('ENTITYNAME=Tower_Device');
    const fam = lazyTextFile('塔型=TYPE=耐张塔');
    const mod = lazyTextFile('CODE=201');
    const result = await detectGimProjectType(new Map([
      ['Cbm/project.cbm', project],
      ['Cbm/F1.cbm', project],
      ['Dev/tower.dev', dev],
      ['Fam/tower.fam', fam],
      ['Mod/tower.mod', mod],
      ['Phm/tower.phm', dev],
    ]));

    expect(result.type).toBe('transmission_line');
    expect(project.text).not.toHaveBeenCalled();
    expect(dev.text).not.toHaveBeenCalled();
    expect(fam.text).not.toHaveBeenCalled();
  });

  it('非标准布局仍保留文本信号识别', async () => {
    const cbm = lazyTextFile('ENTITYNAME=Tower_Device\nTOWERS.NUM=1');
    const result = await detectGimProjectType(new Map([
      ['models/project.cbm', cbm],
    ]));

    expect(result.type).toBe('transmission_line');
    expect(cbm.text).toHaveBeenCalledTimes(1);
  });

  it('已有 IFC 且无线路目录时不扫描变电小文件文本', async () => {
    const cbm = lazyTextFile('ENTITYNAME=F1System');
    const dev = lazyTextFile('SYMBOLNAME=主变');
    const fam = lazyTextFile('额定容量=100');
    const ifc = { size: 1024, text: vi.fn(async () => 'ISO-10303-21;') } as unknown as File;
    const result = await detectGimProjectType(new Map([
      ['CBM/project.cbm', cbm],
      ['DEV/main.dev', dev],
      ['FAM/main.fam', fam],
      ['CBM/main.ifc', ifc],
    ]));

    expect(result.type).toBe('substation');
    expect(cbm.text).not.toHaveBeenCalled();
    expect(dev.text).not.toHaveBeenCalled();
    expect(fam.text).not.toHaveBeenCalled();
  });

  it('带 IFC 但使用 Cbm/Dev/Mod 目录 casing 的变电工程不误判为 hybrid', async () => {
    const cbm = lazyTextFile('ENTITYNAME=F1System');
    const dev = lazyTextFile('SYMBOLNAME=主变');
    const mod = lazyTextFile('MODTYPE=设备');
    const ifc = { size: 1024, text: vi.fn(async () => 'ISO-10303-21;') } as unknown as File;
    const result = await detectGimProjectType(new Map([
      ['Cbm/project.cbm', cbm],
      ['Dev/main.dev', dev],
      ['Mod/main.mod', mod],
      ['Cbm/main.ifc', ifc],
    ]));

    expect(result.type).toBe('substation');
    expect(result.details.hasLineArtifacts).toBe(false);
  });
});
