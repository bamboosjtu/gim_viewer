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
});
