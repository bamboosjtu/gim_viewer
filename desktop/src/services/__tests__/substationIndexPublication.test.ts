import { describe,it,expect,vi } from 'vitest';
import { publishSubstationIndex } from '../substationIndexPublication.js';
import { buildCbmTree } from '../../gim/cbmParser.js';
import { sqliteRoundTrip } from './sqliteHarness.js';
import type { GimIndexPayload, GeometryRefsPayload } from '@desktop/database.js';

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; }
async function fixture() {
  const files=new Map(Object.entries({
    'CBM/project.cbm':'ENTITYNAME=PROJECT\nSYSTEMNAME=fixture\nSUBSYSTEMS.NUM=1\nSUBSYSTEM0=root.cbm',
    'CBM/root.cbm':'ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev\nBASEFAMILY=props.fam',
    'CBM/props.fam':'[设计参数]\nkey=value\nkey=value\nkey=other',
    'DEV/root.dev':'BASEFAMILYPOINTER=empty.fam\nSOLIDMODELS.NUM=1\nSOLIDMODEL0=root.phm',
    'DEV/empty.fam':'',
    'PHM/root.phm':'SOLIDMODELS.NUM=0',
    'CBM/model.ifc':'not-read-by-publication',
  }).map(([path,text])=>[path,new File([text],path)]));
  const tree=await buildCbmTree(files);
  return {projectId:1,sourceSha256:'fixture-sha',files,cachePaths:new Map([...files.keys()].map(p=>[p,`cache/${p}`])),tree,ifcs:[{path:'CBM/model.ifc',name:'model',modelId:'model'}],relations:[]};
}
function dependencies() { return {isCurrent:()=>true,saveIndex:vi.fn(async(_payload:GimIndexPayload)=>{}),saveRefs:vi.fn(async(_payload:GeometryRefsPayload)=>{}),validate:vi.fn(async()=>({substation_semantic_cache_valid:true})),onPhase:vi.fn((_phase:string,_counts?:Record<string,number>)=>{})}; }

describe('independent semantic publication lifecycle',()=>{
  it('publishes real payloads through SQLite with DEV work unresolved and never reads IFC bytes',async()=>{
    const input=await fixture(),deps=dependencies();
    const dev=deferred<void>(); let devDone=false; void dev.promise.then(()=>devDone=true);
    const ifc=input.files.get('CBM/model.ifc')!;
    const read=vi.spyOn(ifc,'text'); const bytes=vi.spyOn(ifc,'arrayBuffer');
    // Capture production payloads, then send through actual INSERT / SELECT /
    // close / reopen in the Rust harness rather than substituting restore data.
    let saved: Parameters<typeof sqliteRoundTrip>[0][number]['index'];
    deps.saveIndex=vi.fn(async payload=>{saved=payload;});
    deps.saveRefs=vi.fn(async refs=>{ const [result]=sqliteRoundTrip([{index:saved!,refs}]); expect(result.index.fam_properties).toHaveLength(3); });
    expect(await publishSubstationIndex(input,deps)).toBe(true);
    expect(read).not.toHaveBeenCalled(); expect(bytes).not.toHaveBeenCalled();
    expect(devDone).toBe(false);
    expect(deps.onPhase.mock.calls.map(c=>c[0])).toEqual(['sourceTextStart','sourceTextReady','saveIndexStart','saveIndexReady','semanticCacheValid']);
    dev.resolve();
  });
  it('requires completed source writes, including empty FAM files',async()=>{
    const input=await fixture(),deps=dependencies(); input.cachePaths.delete('DEV/empty.fam');
    await expect(publishSubstationIndex(input,deps)).rejects.toThrow('源文件尚未完成缓存');
    expect(deps.saveIndex).not.toHaveBeenCalled();
  });
  it('unreadable raw properties do not become a valid partial index',async()=>{
    const input=await fixture(),deps=dependencies(); vi.spyOn(input.files.get('CBM/props.fam')!,'text').mockRejectedValue(new Error('read failed'));
    await expect(publishSubstationIndex(input,deps)).rejects.toThrow('read failed'); expect(deps.saveIndex).not.toHaveBeenCalled();
  });
  it('close or A→B during text reads prevents either transaction from starting',async()=>{
    const input=await fixture(),deps=dependencies(),read=deferred<string>(); let active=true;
    vi.spyOn(input.files.get('CBM/props.fam')!,'text').mockReturnValue(read.promise); deps.isCurrent=()=>active;
    const work=publishSubstationIndex(input,deps); active=false; read.resolve('key=value');
    expect(await work).toBe(false); expect(deps.saveIndex).not.toHaveBeenCalled(); expect(deps.saveRefs).not.toHaveBeenCalled();
  });
  it('close after semantic save leaves the parser completion transaction uncommitted',async()=>{
    const input=await fixture(),deps=dependencies(); let active=true; deps.isCurrent=()=>active;
    deps.saveIndex=vi.fn(async()=>{active=false;});
    expect(await publishSubstationIndex(input,deps)).toBe(false); expect(deps.saveRefs).not.toHaveBeenCalled();
  });
  it('save failure and failed validation never report a ready semantic cache',async()=>{
    const input=await fixture(),deps=dependencies(); deps.saveRefs.mockRejectedValue(new Error('database full'));
    await expect(publishSubstationIndex(input,deps)).rejects.toThrow('database full'); expect(deps.validate).not.toHaveBeenCalled();
    const invalid=dependencies(); invalid.validate.mockResolvedValue({substation_semantic_cache_valid:false});
    await expect(publishSubstationIndex(input,invalid)).rejects.toThrow('有效性校验失败');
    expect(invalid.onPhase.mock.calls.some(c=>c[0]==='semanticCacheValid')).toBe(false);
  });
});
