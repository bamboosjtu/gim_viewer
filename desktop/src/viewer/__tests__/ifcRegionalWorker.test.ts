import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({
  api:{Init:vi.fn(async()=>{}),SetWasmPath:vi.fn(),OpenModel:vi.fn(()=>0),CloseModel:vi.fn()},
  omit:vi.fn(),post:vi.fn(),failSubset:false,
  extract:vi.fn(),
}));
vi.mock('web-ifc',()=>({IfcAPI:class {constructor(){return fixture.api;}}}));
vi.mock('../ifcOpeningPolicy.js',()=>({IfcOpeningRelationEditor:class {omit(ids:Set<number>){fixture.omit([...ids]);}}}));
vi.mock('../ifcRegionalData.js',()=>({classifyRegionalOpenings:(_api:unknown,_model:number,_index:unknown,hosts:Set<number>)=>({small:hosts.has(1)?[101]:[],retained:0,unknown:0})}));
vi.mock('../ifcRegionalSubset.js',()=>({RegionalSubsetBuilder:class {indexingMs=0;build(){return {model:77,records:10,elapsedMs:1};}}}));
vi.mock('../ifcObjectFineData.js',()=>({extractIfcObjectFine:(...args:unknown[])=>fixture.extract(...args)}));
let send:(data:unknown)=>Promise<void>;
beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();fixture.failSubset=false;
  fixture.extract.mockImplementation((_api:unknown,model:number)=>{
    if(model===77&&fixture.failSubset)throw Error('invalid subset geometry');
    return {expressId:1,parts:[]};
  });
  const scope={postMessage:fixture.post,onmessage:null as any};vi.stubGlobal('self',scope);
  vi.stubGlobal('crypto',{subtle:{digest:async()=>new ArrayBuffer(32)}});
  await import('../ifcRegionalWorker.js');send=async data=>scope.onmessage({data});
  await send({type:'open',id:1,bytes:new Uint8Array([1]),wasm:{path:'/',absolute:true},index:{sourceSha256:'00'.repeat(32),
    objects:[{expressId:1,ifcType:'IFCPLATE'},{expressId:3,ifcType:'IFCWALL'}],openingRelations:[],unitScale:1}});
  await send({type:'prepare-region',id:2,objects:[1]});
});
afterEach(()=>{vi.unstubAllGlobals();});

it('a later full-source region applies holes already classified by a subset region',async()=>{
  expect(fixture.api.OpenModel).toHaveBeenCalledTimes(1);
  await send({type:'prepare-region',id:3,objects:[3]});
  expect(fixture.omit).toHaveBeenCalledWith([101]);
  expect(fixture.api.CloseModel).toHaveBeenCalledWith(77);
  expect(fixture.api.OpenModel).toHaveBeenCalledTimes(2);
});

it('invalid subset output retries the same product in the full evaluator before replying',async()=>{
  fixture.failSubset=true;
  await send({type:'region',id:4,objects:[{expressId:1,globalId:'g1'}]});
  expect(fixture.extract.mock.calls.map(args=>args[1])).toEqual([77,0]);
  expect(fixture.api.OpenModel).toHaveBeenCalledTimes(2);
  const reply=fixture.post.mock.calls.find(args=>args[0]?.id===4)?.[0];
  expect(reply.data).toEqual([{expressId:1,parts:[]}]);
  expect(reply.error).toBeUndefined();
});
