import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubstationSpatialIndexBuilder, buildSubstationSpatialIndexFromFiles,
  type SubstationSpatialIndexObserver } from '../../gim/ifcSpatialParser.js';
import type { CbmNode } from '../../gim/types.js';
import { buildSubstationSpatialIndexInWorker, cancelSubstationSpatialWorkers } from '../substationSpatialWorkerClient.js';
import type { SpatialWorkerRequest, SpatialWorkerResponse } from '../substationSpatialWorker.js';

class SpatialWorker {
  static instances:SpatialWorker[]=[];
  static hold=false;
  builder!:SubstationSpatialIndexBuilder;
  onmessage:((event:MessageEvent<SpatialWorkerResponse>)=>void)|null=null;
  onerror:null=null;onmessageerror:null=null;
  terminate=vi.fn(); requests:SpatialWorkerRequest[]=[];
  constructor(){SpatialWorker.instances.push(this);}
  postMessage(input:SpatialWorkerRequest,transfer:Transferable[]=[]){
    const request=structuredClone(input,{transfer});this.requests.push(request);
    if(SpatialWorker.hold)return;
    queueMicrotask(()=>{
      const send=(data:SpatialWorkerResponse)=>this.onmessage?.({data} as MessageEvent<SpatialWorkerResponse>);
      if(request.type==='init'){
        const observer:SubstationSpatialIndexObserver={onModelParsed:profile=>send({type:'diagnostic',event:'onModelParsed',profile})};
        this.builder=new SubstationSpatialIndexBuilder(request.tree,request.relations,observer);
      } else if(request.type==='model'){
        send({type:'diagnostic',event:'onModelRead',profile:request.read});
        this.builder.addIfcModel(request.entry,request.text??(request.bytes?new TextDecoder().decode(request.bytes):null),request.read.bytes);
      } else {send({type:'complete',index:structuredClone(this.builder.finalize())});return;}
      send({type:'ready'});
    });
  }
}
const entry={modelId:'model',name:'model',path:'CBM/model.ifc'};
const text="#1=IFCPROJECT('p',#99,'Project',$,$,$,$,(#90),$);\n#2=IFCBUILDINGSTOREY('s',#99,'Floor',$,$,$,$,$,.ELEMENT.,0.);\n#10=IFCWALL('wall',#99,'Wall',$,$,$,$,$,$);\n#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));\n#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('r2',#99,$,$,(#10),#2);";
const tree:CbmNode={path:'CBM/wall.cbm',name:'Wall',entityName:'F4System',children:[],famPath:'',devPath:'',ifcFile:'model.ifc',ifcGuid:'wall',classifyName:'',transformMatrix:'',systemNames:[],devSymbolName:'',devType:'',devExpanded:false};
beforeEach(()=>{SpatialWorker.instances=[];SpatialWorker.hold=false;vi.stubGlobal('Worker',SpatialWorker);});
afterEach(()=>{cancelSubstationSpatialWorkers();vi.unstubAllGlobals();});

it('worker transport preserves the full spatial graph, Maps, direct links and per-file error isolation',async()=>{
  const files=new Map([['cbm/MODEL.IFC',new File([text],'model.ifc')],['CBM/broken.ifc',{arrayBuffer:async()=>{throw new Error('disk failed');},size:123} as unknown as File]]);
  const entries=[entry,{...entry,modelId:'broken',path:'CBM/broken.ifc'},{...entry,modelId:'missing',path:'CBM/missing.ifc'}];
  const expected=await buildSubstationSpatialIndexFromFiles(files,entries,tree);
  const read=vi.fn(),parsed=vi.fn();
  const actual=await buildSubstationSpatialIndexInWorker(files,entries,tree,[],{onModelRead:read,onModelParsed:parsed},()=>true);
  expect(actual).toEqual(expected);
  expect(actual.nodeByKey).toBeInstanceOf(Map);
  expect(actual.linksByCbmPath.get(tree.path)?.confidence).toBe('confirmed');
  expect(read).toHaveBeenCalledTimes(3);expect(read.mock.calls[1][0].error).toBe('disk failed');
  expect(parsed).toHaveBeenCalled();
  expect(SpatialWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
});

it('project cleanup rejects a pending STEP task and terminates its worker',async()=>{
  SpatialWorker.hold=true;
  const pending=buildSubstationSpatialIndexInWorker(new Map(),[],null,[],{},()=>true);
  const rejected=expect(pending).rejects.toThrow('obsolete project');
  cancelSubstationSpatialWorkers();await rejected;
  expect(SpatialWorker.instances[0].terminate).toHaveBeenCalledTimes(2);
});

it('unsupported hosts retain the existing parser contract without changing line behavior',async()=>{
  vi.stubGlobal('Worker',undefined);
  const files=new Map([['CBM/model.ifc',new File([text],'model.ifc')]]);
  expect(await buildSubstationSpatialIndexInWorker(files,[entry],tree,[],{},()=>true))
    .toEqual(await buildSubstationSpatialIndexFromFiles(files,[entry],tree));
});
