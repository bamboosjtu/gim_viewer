import { beforeEach, describe, expect, it, vi } from 'vitest';

const batchReadMock = vi.hoisted(() => vi.fn());
vi.mock('@desktop/runtime.js', () => ({ isTauri: () => true }));
vi.mock('@desktop/gimExtract.js', () => ({ isDiskBackedFile: () => true }));
vi.mock('@desktop/database.js', () => ({ batchReadCachedFiles: batchReadMock }));

import { readLineParserInput } from '../lineParserInput.js';

describe('lineParserInput', () => {
  beforeEach(() => batchReadMock.mockReset());

  it('DiskBackedFile 按文件数/总字节分批读取，非语义二进制只传元数据', async () => {
    batchReadMock.mockImplementation(async (...args: unknown[]) => {
      const paths = (args[1] ?? args[0] ?? []) as string[];
      const out = new Map<string, Uint8Array | null>();
      for (const path of paths) out.set(path, new TextEncoder().encode(`PATH=${path}`));
      return out;
    });
    const files = new Map<string, File>([
      ['Cbm\\project.cbm', new File(['SUBSYSTEM=x.cbm'], 'project.cbm')],
      ['CBM/x.cbm', new File(['ENTITYNAME=F1System'], 'x.cbm')],
      ['DEV/a.dev', new File(['A=B'], 'a.dev')],
      ['FAM/a.fam', new File(['A=B=C'], 'a.fam')],
      ['MOD/a.mod', new File(['CODE=1'], 'a.mod')],
      ['MOD/a.stl', new File([new Uint8Array([1, 2, 3])], 'a.stl')],
      ['README.txt', new File(['ignored'], 'README.txt')],
    ]);
    const result = await readLineParserInput(files, 7, { maxFiles: 2, maxBytes: 1024 });
    expect(batchReadMock.mock.calls.filter((call) => call.length > 0)).toHaveLength(3);
    expect(batchReadMock.mock.calls.filter((call) => call.length > 0).every((call) => call[0] === 7 && (call[1] as string[]).length <= 2)).toBe(true);
    expect(result.requested).toBe(files.size);
    expect(result.files.map((file) => file.path)).toContain('MOD/a.stl');
    expect(result.files.map((file) => file.path)).toContain('README.txt');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('工程切换后停止启动下一批，局部输入标记为 cancelled', async () => {
    let current = true;
    batchReadMock.mockImplementation(async (...args: unknown[]) => {
      const paths = (args[1] ?? args[0] ?? []) as string[];
      current = false;
      const out = new Map<string, Uint8Array | null>();
      for (const path of paths) out.set(path, new TextEncoder().encode('A=B'));
      return out;
    });
    const files = new Map<string, File>([
      ['CBM/a.cbm', new File(['A=B'], 'a.cbm')],
      ['CBM/b.cbm', new File(['A=B'], 'b.cbm')],
    ]);
    const result = await readLineParserInput(files, 7, {
      maxFiles: 1,
      maxBytes: 1024,
      isCurrent: () => current,
    });
    expect(result.cancelled).toBe(true);
    expect(result.batches).toBe(1);
    expect(batchReadMock).toHaveBeenCalledTimes(1);
  });

  it('批量命中 0 字节条目时不重复发起单文件回退读取', async () => {
    batchReadMock.mockResolvedValue(new Map([['CBM/empty.cbm', new Uint8Array(0)]]));
    const file = {
      name: 'empty.cbm',
      size: 0,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    } as unknown as File;
    const result = await readLineParserInput(new Map([['CBM/empty.cbm', file]]), 7);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].bytes.byteLength).toBe(0);
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(batchReadMock).toHaveBeenCalledTimes(1);
  });
});
