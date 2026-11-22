import {expect,it,vi} from 'vitest';

const writes=vi.hoisted(()=>({writeCacheFile:vi.fn()}));
vi.mock('../projectFiles.js',()=>writes);
import {cacheExtractedFiles} from '../archiveFilePersistence.js';

const owner = { sourceSha256: 'fixture-sha', isCurrent: () => true };

it('WASM fallback persists every archive entry and does not rewrite a cached IFC',async()=>{
  writes.writeCacheFile.mockReset().mockImplementation(async(_projectId:number,path:string)=>`workspace-cache/${path}`);
  const files=new Map<string,File>([
    ['CBM/project.cbm',new File(['root'],'project.cbm')],
    ['CUSTOM/source.txt',new File(['extra'],'source.txt')],
    ['IFC/model.ifc',new File(['ifc'],'model.ifc')],
  ]);
  const result=await cacheExtractedFiles(7,files,owner,new Map([['IFC/model.ifc','workspace-cache/IFC/model.ifc']]));
  expect(result.errors).toEqual([]);
  expect(result.cachedCount).toBe(2);
  expect([...result.pathMap.keys()]).toEqual(['CBM/project.cbm','CUSTOM/source.txt']);
  expect(writes.writeCacheFile).toHaveBeenCalledTimes(2);
});

it('stops the old archive before native write when a file read finishes after switching projects', async () => {
  let finishRead!: (bytes: ArrayBuffer) => void;
  const deferred = new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; });
  const first = new File(['old'], 'first');
  const read = vi.spyOn(first, 'arrayBuffer').mockReturnValue(deferred);
  const second = new File(['old'], 'second');
  const readSecond = vi.spyOn(second, 'arrayBuffer');
  let active = true;
  writes.writeCacheFile.mockReset();
  const pending = expect(cacheExtractedFiles(7, new Map([['first', first], ['second', second]]), {
    sourceSha256: 'old',
    isCurrent: () => active,
  })).rejects.toMatchObject({ name: 'StaleSessionError' });
  expect(read).toHaveBeenCalledOnce();
  active = false;
  finishRead(new ArrayBuffer(4));
  await pending;
  expect(writes.writeCacheFile).not.toHaveBeenCalled();
  expect(readSecond).not.toHaveBeenCalled();
});

it('publishes successful files only and retries the failed entry on a later attempt', async () => {
  writes.writeCacheFile.mockReset()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockImplementation(async (_id: number, path: string) => `cache/${path}`);
  const files = new Map([['one', new File(['one'], 'one')], ['two', new File(['two'], 'two')]]);
  const first = await cacheExtractedFiles(7, files, owner);
  expect(first.errors).toEqual([{ entryPath: 'one', message: 'disk full' }]);
  expect(first.pathMap).toEqual(new Map([['two', 'cache/two']]));
  const retry = await cacheExtractedFiles(7, files, owner, first.pathMap);
  expect(retry.pathMap).toEqual(new Map([['one', 'cache/one']]));
  expect(retry.errors).toEqual([]);
  expect(writes.writeCacheFile.mock.calls.map(([id, path, , sha]) => [id, path, sha])).toEqual([
    [7, 'one', 'fixture-sha'], [7, 'two', 'fixture-sha'], [7, 'one', 'fixture-sha'],
  ]);
});
