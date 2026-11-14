// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {EngineeringWorkerClient,type EngineeringWorkerPort} from '../engineeringWorkerClient.js';
import {createEngineeringWorkerHandler} from '../engineeringWorker.js';
import {ModelEvidenceProvider} from '../../gim/engineering/evidenceProvider.js';
import type {EngineeringWorkerRequest,EngineeringWorkerReply,EngineeringWorkerResponse} from '../engineeringWorkerProtocol.js';

class LocalPort implements EngineeringWorkerPort {
  onmessage:EngineeringWorkerPort['onmessage']=null;
  onerror:EngineeringWorkerPort['onerror']=null;
  onmessageerror:EngineeringWorkerPort['onmessageerror']=null;
  commands:string[]=[];
  checkpointGate?:Promise<void>;
  terminate=vi.fn();
  private handle=createEngineeringWorkerHandler();
  private chain=Promise.resolve();
  postMessage(request:EngineeringWorkerRequest,transfer:Transferable[]=[]){
    const input=structuredClone(request,{transfer});this.commands.push(input.type);
    this.chain=this.chain.then(async()=>{
      if(input.type==='checkpoint-evidence')await this.checkpointGate;
      let reply:EngineeringWorkerReply;
      try{reply=await this.handle(input);}catch(error){reply={type:'error',message:String(error)};}
      const transfers=reply.type==='evidence-checkpoint'&&reply.checkpoint?[reply.checkpoint.bytes.buffer as ArrayBuffer]:[];
      const response=structuredClone({...reply,requestId:input.requestId},{transfer:transfers}) as EngineeringWorkerResponse;
      this.onmessage?.({data:response} as MessageEvent<EngineeringWorkerResponse>);
    });
  }
}
const clients:EngineeringWorkerClient[]=[];
afterEach(()=>{clients.forEach(c=>c.close());clients.length=0;vi.restoreAllMocks();vi.useRealTimers();});
async function fixture(cache=true){
  const ports:LocalPort[]=[],factory=()=>{const p=new LocalPort();ports.push(p);return p;};
  const client=new EngineeringWorkerClient(factory(),()=>true,undefined,undefined,factory);clients.push(client);
  const paths=['project.cbm','a.dev','a.fam','unread.fam'],identity={sourceSha256:'a'.repeat(64),parserVersion:'fixture',entries:paths};
  await client.init(identity.sourceSha256,paths);
  await client.addFiles([{path:paths[0],blob:new Blob(['OBJECTMODELPOINTER=a.dev'])},{path:paths[1],blob:new Blob(['TYPE=GIS\nBASEFAMILY=a.fam'])},{path:paths[2],blob:new Blob(['[设计]\n额定电压=RATEDVOLTAGE=220 kV'])}]);
  await client.extract();const model=await client.assemble([],[],cache?identity:undefined);
  if(cache)for(const domain of model.cachePlan??[])await client.encodeCache(model.buildId!,domain);
  return {client,ports,model,identity};
}
it('terminates reconstructible Workers and serves metadata/bounded empty pages without restarting or parsing',async()=>{
  const {client,ports,model}=await fixture(),attach=vi.spyOn(ModelEvidenceProvider.prototype,'attachGraph');
  await client.releaseModel(model.buildId);expect(ports[0].terminate).toHaveBeenCalledOnce();
  const snapshot=await client.getEvidenceSnapshot(['a.fam']);
  expect(snapshot.coverage[0]).toMatchObject({status:'complete',materialization:'not_materialized',rawAvailable:false,restorable:true});
  expect(snapshot.inventoryTotals).toMatchObject({entries:4,parsedComplete:1});
  const range={entryIds:['a.fam'],kinds:['attributes','assignments'] as const};
  const page=await client.queryEvidence({range,revision:snapshot.revision,limit:10});
  expect(page.attributes).toEqual([]);expect(page.nextOffset).toBeUndefined();
  expect(page.coverage.every(c=>c.status==='complete'&&c.materialization==='not_materialized')).toBe(true);
  expect(ports).toHaveLength(1);expect(attach).not.toHaveBeenCalled();
  await expect(client.queryEvidence({range,revision:snapshot.revision-1,limit:10})).rejects.toThrow('EVIDENCE_REVISION_EXPIRED');
  await expect(client.queryEvidence({range,revision:snapshot.revision,limit:1001})).rejects.toThrow('Invalid evidence page');
  await expect(client.getEvidenceSnapshot(['foreign.fam'])).rejects.toThrow('Unknown evidence entry');
  expect((await client.getEvidenceSnapshot(['unread.fam'])).coverage[0]).toMatchObject({status:'not_requested',restorable:false});
});
it('restores attributes only on demand, preserves assignments/build generation and expires pre-park cursors',async()=>{
  const {client,ports,model,identity}=await fixture();await client.releaseModel(model.buildId);
  const range={entryIds:['a.fam'],kinds:['attributes','assignments'] as const};
  const old=await client.getEvidenceSnapshot(range.entryIds),attach=vi.spyOn(ModelEvidenceProvider.prototype,'attachGraph');
  vi.useFakeTimers();
  const loaded=await client.ensureEvidence(range);expect(ports).toHaveLength(2);expect(attach).toHaveBeenCalledOnce();
  const page=await client.queryEvidence({range,revision:loaded.revision,limit:10});
  expect(page.attributes[0].rawValue).toBe('220 kV');expect(page.assignments[0].status).toBe('confirmed');
  await expect(client.queryEvidence({range,revision:old.revision,limit:10})).rejects.toThrow('EVIDENCE_REVISION_EXPIRED');
  await vi.advanceTimersByTimeAsync(1501);expect(ports[1].terminate).toHaveBeenCalledOnce();
  const parked=await client.getEvidenceSnapshot(range.entryIds);expect(parked.revision).toBeGreaterThan(loaded.revision);
  await expect(client.queryEvidence({range,revision:loaded.revision,limit:10})).rejects.toThrow('EVIDENCE_REVISION_EXPIRED');
  const restored=await client.ensureEvidence(range),again=await client.queryEvidence({range,revision:restored.revision,limit:10});
  expect(again.attributes).toEqual(page.attributes);expect(again.assignments).toEqual(page.assignments);
  const revised=await client.recognizeEvidence(identity);expect(revised.buildId).toBeGreaterThan(model.buildId!);
  expect(revised.snapshot.entities.map(e=>e.id)).toEqual(model.snapshot.entities.map(e=>e.id));
});
it('reads original bytes after restart without restoring or parsing the cached source graph',async()=>{
  const {client,ports,model}=await fixture();await client.releaseModel(model.buildId);
  const attach=vi.spyOn(ModelEvidenceProvider.prototype,'attachGraph'),bytes=new TextEncoder().encode('[raw]\nA=1');
  vi.useFakeTimers();await client.addFiles([{path:'unread.fam',bytes:bytes.slice()}]);
  expect(new TextDecoder().decode(await client.readEvidenceEntry('unread.fam'))).toBe('[raw]\nA=1');
  expect(attach).not.toHaveBeenCalled();expect(ports).toHaveLength(2);
  expect((await client.getEvidenceSnapshot(['unread.fam'])).entries[0].status).toBe('not_requested');
  await vi.advanceTimersByTimeAsync(1501);
});
it('retains unencoded sources rather than terminating their only evidence owner',async()=>{
  const {client,ports,model}=await fixture(false);await client.releaseModel(model.buildId);
  expect(ports[0].terminate).not.toHaveBeenCalled();
  vi.useFakeTimers();const loaded=await client.ensureEvidence({entryIds:['a.fam'],kinds:['attributes']});
  expect((await client.queryEvidence({range:{entryIds:['a.fam'],kinds:['attributes']},revision:loaded.revision,limit:1})).attributes).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1501);expect(ports[0].terminate).not.toHaveBeenCalled();
});
it('rejects a closed parked session without constructing a replacement Worker',async()=>{
  const {client,ports,model}=await fixture();await client.releaseModel(model.buildId);client.close();
  await expect(client.getEvidenceSnapshot()).rejects.toMatchObject({name:'AbortError'});
  await expect(client.ensureEvidence({entryIds:['a.fam'],kinds:['attributes']})).rejects.toMatchObject({name:'AbortError'});
  expect(ports).toHaveLength(1);
});
it('serializes queries and concurrent detail requests across checkpoint ownership transfer',async()=>{
  const {client,ports,model}=await fixture();let release!:()=>void;
  ports[0].checkpointGate=new Promise<void>(resolve=>{release=resolve;});
  const parking=client.releaseModel(model.buildId);
  for(let i=0;i<100&&!ports[0].commands.includes('checkpoint-evidence');i++)await Promise.resolve();
  expect(ports[0].commands[ports[0].commands.length-1]).toBe('checkpoint-evidence');
  const metadata=client.getEvidenceSnapshot(['a.fam']),range={entryIds:['a.fam'],kinds:['attributes'] as const};
  const first=client.ensureEvidence(range),second=client.ensureEvidence(range);
  release();vi.useFakeTimers();
  await parking;const [snapshot,a,b]=await Promise.all([metadata,first,second]);
  expect(snapshot.coverage[0].materialization).toBe('not_materialized');expect(a).toEqual(b);
  expect(ports).toHaveLength(2);expect(ports[0].terminate).toHaveBeenCalledOnce();
  expect(ports[1].commands.filter(c=>c==='restore-evidence-checkpoint')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1501);
});
