import {expect,it,vi} from 'vitest';

const writes=vi.hoisted(()=>({writeCacheFile:vi.fn()}));
vi.mock('@desktop/database.js',()=>writes);
import {cacheExtractedFiles} from '../gimExtractedCacheService.js';

it('WASM fallback persists every archive entry and does not rewrite a cached IFC',async()=>{
  writes.writeCacheFile.mockReset().mockImplementation(async(_projectId:number,path:string)=>`workspace-cache/${path}`);
  const files=new Map<string,File>([
    ['CBM/project.cbm',new File(['root'],'project.cbm')],
    ['CUSTOM/source.txt',new File(['extra'],'source.txt')],
    ['IFC/model.ifc',new File(['ifc'],'model.ifc')],
  ]);
  const result=await cacheExtractedFiles(7,files,new Map([['IFC/model.ifc','workspace-cache/IFC/model.ifc']]));
  expect(result.errors).toEqual([]);
  expect(result.cachedCount).toBe(2);
  expect([...result.pathMap.keys()]).toEqual(['CBM/project.cbm','CUSTOM/source.txt']);
  expect(writes.writeCacheFile).toHaveBeenCalledTimes(2);
});
