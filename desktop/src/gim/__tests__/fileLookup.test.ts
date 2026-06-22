import { describe, expect, it } from 'vitest';
import { findFileByPath, getFileByPath, hasFileByPath } from '../fileLookup.js';

describe('GIM 文件路径查找', () => {
  it('按目录/文件名大小写和分隔符不敏感读取', async () => {
    const file = new File(['ok'], 'FileDevRelation.cbm');
    const files = new Map<string, File>([['Cbm\\FileDevRelation.cbm', file]]);

    expect(getFileByPath(files, 'CBM/FileDevRelation.cbm')).toBe(file);
    expect(getFileByPath(files, './cbm/filedevrelation.cbm')).toBe(file);
    expect(hasFileByPath(files, 'CBM/FILEDEVRELATION.CBM')).toBe(true);
    expect(findFileByPath(files, 'CBM/FileDevRelation.cbm')?.path).toBe('Cbm\\FileDevRelation.cbm');
    await expect(getFileByPath(files, 'CBM/FileDevRelation.cbm')!.text()).resolves.toBe('ok');
  });

  it('同一路径的大小写变体保留归档中的首个文件', () => {
    const first = new File(['first'], 'a.mod');
    const second = new File(['second'], 'A.MOD');
    const files = new Map<string, File>([
      ['Mod/a.mod', first],
      ['MOD/A.MOD', second],
    ]);
    expect(getFileByPath(files, 'MOD/a.mod')).toBe(first);
  });
});

