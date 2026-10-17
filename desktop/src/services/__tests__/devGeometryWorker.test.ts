import {afterEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({serialize:vi.fn(),bounds:vi.fn(),trim:vi.fn(),dispose:vi.fn()}));
vi.mock('../glbCacheService.js',()=>({serializeDevToGlbDetailed:mock.serialize}));
vi.mock('../devSpatialCatalog.js',()=>({buildDevSourceBounds:mock.bounds}));
vi.mock('../../viewer/xmlModGeometry.js',()=>({trimSharedXmlModGeometries:mock.trim,disposeSharedXmlModMaterials:mock.dispose}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetAllMocks();});
it('protocol errors settle their task and cleanup exceptions cannot leave the worker running forever',async()=>{
  vi.resetModules();const post=vi.fn(),scope={postMessage:post,onmessage:null as any};vi.stubGlobal('self',scope);
  vi.spyOn(console,'warn').mockImplementation(()=>{});await import('../devGeometryWorker.js');
  const send=(data:any)=>scope.onmessage({data});
  await send({kind:'unknown',id:1,session:1,key:'unknown'});expect(post.mock.lastCall![0]).toMatchObject({id:1,error:expect.stringContaining('Unsupported')});
  let finish!:(result:any)=>void;mock.serialize.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const active=send({kind:'compile',id:2,session:1,key:'compile'});
  await send({kind:'bounds',id:3,session:1,key:'busy'});expect(post.mock.lastCall![0]).toMatchObject({id:3,error:'DEV worker already running'});
  mock.trim.mockImplementationOnce(()=>{throw Error('cleanup');});finish({status:'empty'});await active;
  mock.bounds.mockResolvedValue({boundsQuality:'empty'});await send({kind:'bounds',id:4,session:1,key:'next'});
  expect(post.mock.lastCall![0]).toMatchObject({id:4,result:{boundsQuality:'empty'}});
});
