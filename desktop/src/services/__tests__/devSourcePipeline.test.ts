import {it,expect,vi,afterEach} from 'vitest';
import {DevLodSourceWorkset} from '../devLodSourceWorkset.js';
import {batchReadCachedFiles} from '@desktop/database.js';
import {hydrateSubstationGeometryGraph} from '../../gim/geometry/substationSourceGraph.js';
vi.mock('@desktop/database.js',()=>({batchReadCachedFiles:vi.fn()}));
const owned:DevLodSourceWorkset[]=[];
afterEach(()=>{owned.forEach(source=>source.close());owned.length=0;vi.clearAllMocks();});
function source(texts:Map<string,string>){
  const files=new Map([...texts].map(([path,text])=>[path,{size:new TextEncoder().encode(text).length} as File]));
  const install=vi.fn((loaded:Map<string,File>)=>{for(const [path,file]of loaded)files.set(path,file);});
  const work=new DevLodSourceWorkset({session:{projectId:1} as never,perf:{} as never,diagnostics:{} as never,current:()=>true,memoryPressure:()=> 'normal',worker:()=>({installSources:install}) as never});
  work.sourceFiles=files;owned.push(work);
  const read=vi.mocked(batchReadCachedFiles).mockImplementation(async(_id,paths)=>new Map(paths.map(path=>[path,new TextEncoder().encode(texts.get(path)!)])));
  return {work,read,install,files};
}
it('lets a shallow root finish while another root is waiting for a deep dependency',async()=>{
  const texts=new Map([['slow.dev','SOLIDMODELS.NUM=1\nSOLIDMODEL0=deep.phm'],['fast.dev','SYMBOLNAME=fast'],['deep.phm','SOLIDS.NUM=1\nSOLIDS0=part.mod'],['part.mod','<Device/>']]);
  const {work,read}=source(texts);let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  read.mockImplementation(async(_id,paths)=>{if(paths.includes('deep.phm'))await held;return new Map(paths.map(path=>[path,new TextEncoder().encode(texts.get(path)!)]));});
  let slowDone=false,fastDone=false;
  const slow=work.prepareMissingTemplateSources('slow.dev').then(()=>{slowDone=true;});
  const fast=work.prepareMissingTemplateSources('fast.dev').then(()=>{fastDone=true;});
  try{await expect.poll(()=>fastDone).toBe(true);expect(slowDone).toBe(false);}
  finally{release();await Promise.all([slow,fast]);}
});
it('coalesces concurrent shared dependency reads and installs each file once',async()=>{
  const {work,read,install}=source(new Map([['a.dev','SOLIDMODELS.NUM=1\nSOLIDMODEL0=shared.phm'],['b.dev','SOLIDMODELS.NUM=1\nSOLIDMODEL0=shared.phm'],['shared.phm','SOLIDS.NUM=1\nSOLIDS0=part.mod'],['part.mod','<Device/>'],['unrelated.mod','unused']]));
  await Promise.all(['a.dev','b.dev'].map(path=>work.prepareMissingTemplateSources(path)));
  const paths=read.mock.calls.flatMap(call=>call[1]);
  expect(paths).toEqual(['a.dev','b.dev','shared.phm','part.mod']);
  expect(install.mock.calls.flatMap(([files])=>[...files.keys()])).toEqual(paths);
});
it('reuses DEV and PHM reference parsing across root discoveries',async()=>{
  const texts=new Map([['a.dev','SOLIDMODELS.NUM=1\nSOLIDMODEL0=shared.phm'],['b.dev','SOLIDMODELS.NUM=1\nSOLIDMODEL0=shared.phm'],['shared.phm','SOLIDS.NUM=1\nSOLIDS0=part.mod'],['part.mod','<Device/>']]);
  const reads=new Map([...texts].map(([path,text])=>[path,{text:vi.fn(async()=>text)} as unknown as File]));
  const references=new Map<string,Promise<readonly string[]>>();
  const load=async(paths:string[])=>new Map(paths.map(path=>[path,reads.get(path)!]));
  await Promise.all(['a.dev','b.dev'].map(path=>hydrateSubstationGeometryGraph([path],load,texts.keys(),references)));
  expect(reads.get('shared.phm')!.text).toHaveBeenCalledOnce();
});
