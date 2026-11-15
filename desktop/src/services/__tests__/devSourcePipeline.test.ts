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
it('coalesces a catalog window of independent roots before dispatching native reads',async()=>{
  const roots=Array.from({length:32},(_,i)=>`r${i}.dev`);
  const texts=new Map([...roots.map(path=>[path,'SOLIDMODELS.NUM=1\nSOLIDMODEL0=shared.phm'] as const),
    ['shared.phm','SOLIDS.NUM=1\nSOLIDS0=part.mod'],['part.mod','<Device/>']]);
  const {work,read}=source(texts);
  await Promise.all(roots.map(path=>work.prepareMissingTemplateSources(path)));
  expect(read.mock.calls.map(([,paths])=>paths)).toEqual([roots,['shared.phm'],['part.mod']]);
});
it('shares required Worker reads under pressure while leaving unrelated sources lazy',async()=>{
  const {work,read,install,files}=source(new Map([['shared.mod','<Device/>'],['unrelated.mod','unused']]));
  const pressure=vi.spyOn((work as any).options,'memoryPressure').mockReturnValue('critical');
  await work.prepareMissingTemplateSources('shared.mod');
  expect(read).not.toHaveBeenCalled();
  const [a,b]=await Promise.all([work.readForWorker('shared.mod'),work.readForWorker('SHARED.MOD')]);
  expect(a).toBe(b);expect(a).toBe(files.get('shared.mod'));
  expect(await a!.text()).toBe('<Device/>');
  expect(read.mock.calls.map(([,paths])=>paths)).toEqual([['shared.mod']]);
  expect(install).toHaveBeenCalledOnce();
  expect(await work.readForWorker('shared.mod')).toBe(a);
  expect(read).toHaveBeenCalledOnce();
  pressure.mockRestore();
});
it('keeps a shared in-flight source when a Worker needs it as pressure rises',async()=>{
  const {work,read}=source(new Map([['a.dev','SYMBOLNAME=a']]));
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  read.mockImplementation(async()=>{await held;return new Map([['a.dev',new TextEncoder().encode('SYMBOLNAME=a')]]);});
  const prepared=work.prepareMissingTemplateSources('a.dev');
  await expect.poll(()=>read.mock.calls.length).toBe(1);
  const pressure=vi.spyOn((work as any).options,'memoryPressure').mockReturnValue('critical');
  const required=work.readForWorker('a.dev');release();
  expect(await (await required)!.text()).toBe('SYMBOLNAME=a');await prepared;
  expect(read).toHaveBeenCalledOnce();pressure.mockRestore();
});
it('admits an executing Worker source ahead of queued speculative batches',async()=>{
  const text='x'.repeat(3*1024*1024),roots=Array.from({length:4},(_,i)=>`r${i}.mod`);
  const texts=new Map([...roots.map(path=>[path,text] as const),['required.mod','required']]);
  const {work,read}=source(texts);let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  read.mockImplementation(async(_id,paths)=>{await held;return new Map(paths.map(path=>[path,new TextEncoder().encode(texts.get(path)!)]));});
  const prepared=Promise.all(roots.map(path=>work.prepareMissingTemplateSources(path)));
  await expect.poll(()=>read.mock.calls.length).toBe(2);
  const required=work.readForWorker('required.mod');release();
  await Promise.all([prepared,required]);
  expect(read.mock.calls[2][1][0]).toBe('required.mod');
});
it('reuses DEV and PHM reference parsing across root discoveries',async()=>{
  const texts=new Map([['a.dev','SOLIDMODELS.NUM=1\nSOLIDMODEL0=shared.phm'],['b.dev','SOLIDMODELS.NUM=1\nSOLIDMODEL0=shared.phm'],['shared.phm','SOLIDS.NUM=1\nSOLIDS0=part.mod'],['part.mod','<Device/>']]);
  const reads=new Map([...texts].map(([path,text])=>[path,{text:vi.fn(async()=>text)} as unknown as File]));
  const references=new Map<string,Promise<readonly string[]>>();
  const load=async(paths:string[])=>new Map(paths.map(path=>[path,reads.get(path)!]));
  await Promise.all(['a.dev','b.dev'].map(path=>hydrateSubstationGeometryGraph([path],load,texts.keys(),references)));
  expect(reads.get('shared.phm')!.text).toHaveBeenCalledOnce();
});
