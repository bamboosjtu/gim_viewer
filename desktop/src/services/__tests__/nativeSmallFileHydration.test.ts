import { beforeEach, describe, expect, it, vi } from 'vitest';

const batchReadMock = vi.hoisted(() => vi.fn());
const copyReadMock = vi.hoisted(() => vi.fn());
vi.mock('@desktop/substationParseCopy.js', () => ({ readSubstationParseCopy: copyReadMock }));

vi.mock('@desktop/database.js', () => ({
  batchReadCachedFiles: batchReadMock,
}));

vi.mock('@desktop/gimExtract.js', () => ({
  isDiskBackedFile: (file: File | undefined) => Boolean((file as File & { __gimDiskBacked?: boolean } | undefined)?.__gimDiskBacked),
  isSemanticPackBackedFile: (file: File | undefined) => Boolean((file as File & { __gimSemanticPackBacked?: boolean } | undefined)?.__gimSemanticPackBacked),
}));

import {
  hydrateNativeSmallFiles,
  NATIVE_SMALL_FILE_MAX_BYTES,
} from '../nativeSmallFileHydration.js';

type NativeFixtureFile = File & {
  __gimDiskBacked?: boolean;
  __gimSemanticPackBacked?: boolean;
};

function nativeFile(
  path: string,
  bytes: number | string,
  options: { semantic?: boolean } = {},
): NativeFixtureFile {
  const content = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  return Object.assign(new File([content], path.split(/[\\/]/).pop() || path), {
    __gimDiskBacked: true,
    __gimSemanticPackBacked: options.semantic ?? false,
  });
}

describe('hydrateNativeSmallFiles', () => {
  beforeEach(() => {
    batchReadMock.mockReset();
    copyReadMock.mockReset();
    batchReadMock.mockImplementation(async (_projectId: number, paths: string[]) => new Map(
      paths.map((path) => [path, new TextEncoder().encode(`DATA=${path}`)]),
    ));
  });

  it('validated contiguous copy avoids individual batch reads and preserves exact duplicate rows', async () => {
    const text = '[设计参数]\r\n材质=材质=铝\r\n材质=材质=制造厂家提供\r\n';
    const original = nativeFile('DEV/a.fam', text);
    const files = new Map([['DEV/a.fam', original], ['CBM/a.ifc', nativeFile('CBM/a.ifc', 10)]]);
    copyReadMock.mockResolvedValue(new Map([['DEV/a.fam', new TextEncoder().encode(text)]]));
    const result = await hydrateNativeSmallFiles(files, 1, { parseCopy: { size: 1, sha256: 'receipt' } });
    expect(batchReadMock).not.toHaveBeenCalled();
    expect(await result.files.get('DEV/a.fam')!.text()).toBe(text);
    expect(result.files.get('CBM/a.ifc')).toBe(files.get('CBM/a.ifc'));
    expect(result.batches).toBe(1);
  });

  it('copy failure or missing entry falls back to original batches without partial input', async () => {
    for (const failure of ['reject', 'partial']) {
      batchReadMock.mockClear();
      const files = new Map([['DEV/a.dev', nativeFile('DEV/a.dev', 3)], ['DEV/b.dev', nativeFile('DEV/b.dev', 3)]]);
      if (failure === 'reject') copyReadMock.mockRejectedValueOnce(Error('copy corrupt'));
      else copyReadMock.mockResolvedValueOnce(new Map([['DEV/a.dev', new TextEncoder().encode('bad-copy')]]));
      const result = await hydrateNativeSmallFiles(files, 1, { parseCopy: { size: 1, sha256: 'receipt' } });
      expect(batchReadMock).toHaveBeenCalledOnce();
      expect(await result.files.get('DEV/a.dev')!.text()).toBe('DATA=DEV/a.dev');
    }
  });

  it('project switch during copy read prevents all File reconstruction', async () => {
    let current = true;
    copyReadMock.mockImplementationOnce(async () => { current = false; return new Map([['DEV/a.dev', new Uint8Array([1])]]); });
    const file = nativeFile('DEV/a.dev', 1);
    const result = await hydrateNativeSmallFiles(new Map([['DEV/a.dev', file]]), 1,
      { parseCopy: { size: 1, sha256: 'receipt' }, isCurrent: () => current });
    expect(result.cancelled).toBe(true); expect(result.files.get('DEV/a.dev')).toBe(file);
    expect(batchReadMock).not.toHaveBeenCalled();
  });

  it('按文件数/总字节分批，并把命中的 native 文件物化为普通 File', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', nativeFile('project.cbm', 10)],
      ['DEV/a.dev', nativeFile('a.dev', 20)],
      ['FAM/a.fam', nativeFile('a.fam', 30)],
    ]);
    const result = await hydrateNativeSmallFiles(files, 7, { maxFiles: 2, maxBytes: 100 });

    expect(batchReadMock).toHaveBeenCalledTimes(2);
    expect(batchReadMock.mock.calls.every((call) => call[0] === 7 && (call[1] as string[]).length <= 2)).toBe(true);
    expect(result).toMatchObject({ requested: 3, hydrated: 3, misses: 0, batches: 2, cancelled: false });
    expect(new TextDecoder().decode(await result.files.get('DEV/a.dev')!.arrayBuffer())).toBe('DATA=DEV/a.dev');
    expect((result.files.get('DEV/a.dev') as NativeFixtureFile).__gimDiskBacked).toBeUndefined();
  });

  it('不物化 IFC、semantic-pack 条目和超过上限的大文件', async () => {
    const files = new Map<string, File>([
      ['DEV/a.ifc', nativeFile('a.ifc', 10)],
      ['CBM/packed.cbm', nativeFile('packed.cbm', 10, { semantic: true })],
      ['MOD/large.mod', nativeFile('large.mod', NATIVE_SMALL_FILE_MAX_BYTES + 1)],
      ['CBM/small.cbm', nativeFile('small.cbm', 3)],
    ]);
    const result = await hydrateNativeSmallFiles(files, 9, {
      maxFiles: 10,
      maxBytes: 1024,
    });

    expect(batchReadMock).toHaveBeenCalledTimes(1);
    expect(batchReadMock.mock.calls[0][1]).toEqual(['CBM/small.cbm']);
    expect(result.requested).toBe(1);
    expect(result.hydrated).toBe(1);
    expect(result.files.get('DEV/a.ifc')).toBe(files.get('DEV/a.ifc'));
    expect(result.files.get('CBM/packed.cbm')).toBe(files.get('CBM/packed.cbm'));
    expect(result.files.get('MOD/large.mod')).toBe(files.get('MOD/large.mod'));
  });

  it('batch miss 保留 lazy File，不把缺失误写成空文件', async () => {
    const source = nativeFile('a.cbm', 4);
    batchReadMock.mockResolvedValue(new Map([['CBM/a.cbm', null]]));
    const result = await hydrateNativeSmallFiles(new Map([['CBM/a.cbm', source]]), 11);

    expect(result.misses).toBe(1);
    expect(result.hydrated).toBe(0);
    expect(result.files.get('CBM/a.cbm')).toBe(source);
  });

  it('batch IPC 失败保留所有 lazy File，允许业务层继续降级', async () => {
    const source = nativeFile('a.cbm', 4);
    batchReadMock.mockRejectedValue(new Error('IPC unavailable'));
    const result = await hydrateNativeSmallFiles(new Map([['CBM/a.cbm', source]]), 11);

    expect(result.files.get('CBM/a.cbm')).toBe(source);
    expect(result.hydrated).toBe(0);
    expect(result.misses).toBe(0);
  });

  it('A→B 切换在 await 前后均停止，并且不返回部分提交结果', async () => {
    let current = true;
    const first = nativeFile('a.cbm', 4);
    const second = nativeFile('b.cbm', 4);
    batchReadMock.mockImplementation(async (_projectId: number, paths: string[]) => {
      current = false;
      return new Map(paths.map((path) => [path, new TextEncoder().encode(path)]));
    });
    const result = await hydrateNativeSmallFiles(
      new Map([
        ['CBM/a.cbm', first],
        ['CBM/b.cbm', second],
      ]),
      12,
      { maxFiles: 1, isCurrent: () => current },
    );

    expect(result.cancelled).toBe(true);
    expect(result.batches).toBe(1);
    expect(batchReadMock).toHaveBeenCalledTimes(1);
    expect(result.files.get('CBM/a.cbm')).toBe(first);
    expect(result.files.get('CBM/b.cbm')).toBe(second);
  });

  it('路径大小写/反斜杠不敏感匹配 batch 返回值', async () => {
    batchReadMock.mockResolvedValue(new Map([
      ['cbm\\PROJECT.CBM', new TextEncoder().encode('case-ok')],
    ]));
    const result = await hydrateNativeSmallFiles(
      new Map([['CBM/project.cbm', nativeFile('project.cbm', 4)]]),
      13,
    );
    expect(new TextDecoder().decode(await result.files.get('CBM/project.cbm')!.arrayBuffer())).toBe('case-ok');
    expect(result.hydrated).toBe(1);
  });
});
