import {it,expect,vi} from 'vitest';
import * as database from '@desktop/database.js';
import {createLazyGeometrySourceFiles} from '../modGeometrySourceFiles.js';

it('indexes a source inventory once and dispatches reads in the requesting task without a module-loading await',async()=>{
  const enumerate=vi.fn(function*(){yield 'DEV/a.dev';yield 'MOD/a.stl';});
  const read=vi.spyOn(database,'readCachedEntry').mockResolvedValue(new TextEncoder().encode('NAME=unit'));
  let current=true;
  try{
    const files=createLazyGeometrySourceFiles(1,{[Symbol.iterator]:enumerate},new Map(),()=>current);
    expect(enumerate).toHaveBeenCalledOnce();expect(read).not.toHaveBeenCalled();
    const first=files.get('DEV/a.dev')!.arrayBuffer();
    expect(read).toHaveBeenCalledWith(1,'DEV/a.dev');
    expect(new TextDecoder().decode(await first)).toBe('NAME=unit');
    const second=files.get('DEV/a.dev')!.text();expect(read).toHaveBeenCalledTimes(2);
    expect(await second).toBe('NAME=unit');expect(enumerate).toHaveBeenCalledOnce();
    current=false;await expect(files.get('MOD/a.stl')!.arrayBuffer()).rejects.toThrow('unavailable');
    expect(read).toHaveBeenCalledTimes(2);
  }finally{read.mockRestore();}
});
