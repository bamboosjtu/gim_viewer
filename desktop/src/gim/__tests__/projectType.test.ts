import { describe, expect, it, vi } from 'vitest';
import { detectGimProjectType } from '../projectType.js';
import { findEquipmentEntry, decodeEquipmentText } from '../equipmentModel.js';
import { buildCbmTree } from '../cbmParser.js';

function lazyTextFile(text: string): File {
  return {
    size: text.length,
    text: vi.fn(async () => text),
  } as unknown as File;
}

it('recognizes a standalone Device entry without a project.cbm, independent of directory casing', async () => {
  const files = new Map([
    ['cbm/root.cbm', new File(['ENTITYNAME=Device\nOBJECTMODELPOINTER=assembly.dev'], 'root.cbm')],
    ['dev/assembly.dev', new File(['SYMBOLNAME=设备名称\nSUBDEVICES.NUM=0\nSOLIDMODELS.NUM=0'], 'assembly.dev')],
  ]);
  expect((await detectGimProjectType(files)).type).toBe('equipment');
  const entry = await findEquipmentEntry(files);
  expect(entry).toBe('cbm/root.cbm');
  const tree = await buildCbmTree(files, undefined, entry!);
  expect(tree?.name).toBe('设备名称');
  expect(tree?.devPath).toBe('assembly.dev');
});

it('does not guess a Device entry with missing or ambiguous DEV references', async () => {
  const files = new Map<string, File>([['cbm/root.cbm', new File(['ENTITYNAME=Device\nOBJECTMODELPOINTER=missing.dev'], 'root.cbm')]]);
  expect(await findEquipmentEntry(files)).toBeNull();
  files.set('one/missing.dev', new File([''], 'missing.dev'));
  files.set('two/missing.dev', new File([''], 'missing.dev'));
  expect(await findEquipmentEntry(files)).toBeNull();
});

it('decodes legacy equipment GBK text while retaining UTF-8 names', () => {
  expect(decodeEquipmentText(new Uint8Array([0xc9, 0xe8, 0xb1, 0xb8]).buffer)).toBe('设备');
  expect(decodeEquipmentText(new TextEncoder().encode('设备').buffer)).toBe('设备');
});

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
