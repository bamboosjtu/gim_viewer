import {expect,it,vi} from 'vitest';
import {IFCPROJECT,IFCSTYLEDITEM,IFCRELASSOCIATESMATERIAL,REF,REAL,LABEL} from 'web-ifc';
import {RegionalSubsetBuilder} from '../ifcRegionalSubset.js';

it('copies bounded dependencies and inverse appearance, preserves units and adapts both numeric writer bridges',()=>{
  for(const mode of ['string','number'] as const){
    const ref=(value:number)=>({type:REF,value});
    const data:any={1:[ref(2)],2:[{type:REAL,value:'1.'},{type:REAL,value:1},{type:LABEL,typecode:666,value:'0.5'}],10:[ref(11)],11:[],20:[ref(21)],21:[],30:[ref(10),ref(31)],31:[],
      40:[ref(11),[ref(41)]],41:[],50:[null,null,null,null,[ref(10),ref(20)],ref(51)],51:[]};
    const lines=new Map(Object.entries(data).map(([id,args])=>[+id,{ID:+id,type:999,arguments:args}]));
    const probe=new Map<number,any>(),written:number[]=[];let nextModel=7;
    const api:any={
      GetLineIDsWithType:(_m:number,type:number)=>{const ids=type===IFCPROJECT?[1]:type===IFCSTYLEDITEM?[40]:type===IFCRELASSOCIATESMATERIAL?[50]:[];
        return {size:()=>ids.length,get:(i:number)=>ids[i],delete:vi.fn()};},
      GetRawLineData:(model:number,id:number)=>structuredClone(model===0?lines.get(id):probe.get(model)),
      GetModelSchema:()=> 'IFC4',CreateModel:()=>nextModel++,
      WriteRawLineData:(model:number,line:any)=>{if(typeof line.arguments[0][0].internalValue!==mode)throw Error('wrong numeric bridge');probe.set(model,line);},
      GetLine:(model:number,id:number)=>model!==0 ? id===1 ? {UnitsInContext:ref(2)} : id===2 ? {Units:[ref(3)]}
        : {type:'IFCSIUNIT',UnitType:'LENGTHUNIT',Name:'METRE'}
        : {expressID:id,RelatedObjects:[ref(10),ref(20)],numbers:[{type:REAL,value:'1.',internalValue:'1.'},{type:REAL,value:1,internalValue:1}]},
      GetNameFromTypeCode:(type:string)=>type,
      WriteLine:(_m:number,line:any)=>{written.push(line.expressID);if(line.expressID===50)expect(line.RelatedObjects).toEqual([ref(10)]);
        expect(line.numbers.map((value:any)=>Number(value.internalValue))).toEqual([1,1]);
        expect(line.numbers.every((value:any)=>typeof value.internalValue===mode)).toBe(true);},
      CloseModel:vi.fn(),
    };
    const builder=new RegionalSubsetBuilder(api,0,{objects:[],unitScale:1,openingRelations:[{id:30,host:10,opening:31}]});
    const kept=builder.build([10],new Set());
    expect(written.sort((a,b)=>a-b)).toEqual([1,2,10,11,30,31,40,41,50,51]);
    expect(kept.records).toBe(10);written.length=0;
    builder.build([10],new Set([30]));expect(written).not.toContain(30);expect(written).not.toContain(31);expect(written).not.toContain(20);
    api.WriteLine=()=>{throw Error('write failed');};const failingModel=nextModel;
    expect(()=>builder.build([10],new Set())).toThrow('write failed');expect(api.CloseModel).toHaveBeenCalledWith(failingModel);
  }
});
