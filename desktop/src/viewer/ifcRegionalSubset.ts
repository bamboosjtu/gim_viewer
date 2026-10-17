import { IFCPROJECT, IFCSTYLEDITEM, IFCRELASSOCIATESMATERIAL, IFCRELDEFINESBYTYPE, IFCCARTESIANPOINT, REF, REAL, INTEGER, type IfcAPI, type RawLineData } from 'web-ifc';
import {readRegionalSemantics, type RegionalIndex} from './ifcRegionalData.js';

/** Builds a private evaluation input from the unchanged source model. It does
 * not place, recenter or rewrite source files. Every copied record keeps its ID.
 * Reverse appearance/type edges are included; multi-product relations are
 * restricted to requested products to avoid pulling the whole station in. */
export class RegionalSubsetBuilder {
  readonly indexingMs:number;
  private inverse = new Map<number,number[]>();
  private limitedRelations = new Set<number>();
  private projects: number[] = [];
  private readonly maxRecords = 100_000;
  private realMode:'string'|'number';

  constructor(private api:IfcAPI, private source:number, private index:RegionalIndex) {
    if(!Number.isFinite(index.unitScale)||index.unitScale<=0)throw Error('IFC subset source units unavailable');
    const started=performance.now();let edges=0;
    for (const type of [IFCPROJECT,IFCSTYLEDITEM,IFCRELASSOCIATESMATERIAL,IFCRELDEFINESBYTYPE]) {
      const ids=api.GetLineIDsWithType(source,type);
      try {
        if(ids.size()>this.maxRecords)throw Error('IFC appearance index exceeds subset budget');
        for(let i=0;i<ids.size();i++) {
          const id=ids.get(i);
          if(type===IFCPROJECT){this.projects.push(id);continue;}
          const raw=api.GetRawLineData(source,id);
          const targets=type===IFCSTYLEDITEM ? [raw.arguments[0]] : raw.arguments[4];
          if(type!==IFCSTYLEDITEM)this.limitedRelations.add(id);
          if(!Array.isArray(targets))throw Error('IFC subset relation endpoints unavailable');
          for(const target of targets)if(target?.type===REF){
            if(++edges>500_000)throw Error('IFC subset inverse edges exceed budget');
            const rows=this.inverse.get(target.value) ?? [];rows.push(id);this.inverse.set(target.value,rows);
          }
        }
      } finally {(ids as any).delete?.();}
    }
    if(this.projects.length!==1)throw Error('IFC subset requires one source project');
    // The installed browser and Node WASM writers have different numeric
    // bridges. Probe the writer in an empty private model, without touching
    // source records or selecting behavior by exporter/runtime name.
    let supported:'string'|'number'|undefined;
    for(const mode of ['string','number'] as const){
      const probe=api.CreateModel({schema:api.GetModelSchema(source)},{COORDINATE_TO_ORIGIN:false});
      try {
        const value=mode==='string'?'0.375':0.375;
        api.WriteRawLineData(probe,{ID:1,type:IFCCARTESIANPOINT,arguments:[[{type:REAL,value,internalValue:value}]]});
        if(Number(api.GetRawLineData(probe,1).arguments[0][0].value)===0.375){supported=mode;break;}
      } catch {/* Try the alternate writer bridge. */}
      finally {api.CloseModel(probe);}
    }
    if(!supported)throw Error('IFC subset numeric writer unavailable');
    this.realMode=supported;
    this.indexingMs=performance.now()-started;
  }

  build(products:number[], omitted:Set<number>):{model:number;records:number;elapsedMs:number} {
    const started=performance.now(),requested=new Set(products),queue=[...products,...this.projects],rows=new Map<number,RawLineData>();
    for(const relation of this.index.openingRelations)if(requested.has(relation.host)&&!omitted.has(relation.id))queue.push(relation.id);
    let values=0;
    while(queue.length){
      const id=queue.pop()!;if(rows.has(id))continue;
      if(rows.size>=this.maxRecords)throw Error('IFC regional dependency closure exceeds budget');
      const raw=this.api.GetRawLineData(this.source,id);
      if(raw.ID!==id || !raw.type || !Array.isArray(raw.arguments))throw Error(`IFC subset missing dependency #${id}`);
      if(this.limitedRelations.has(id))raw.arguments[4]=raw.arguments[4].filter((ref:any)=>requested.has(ref.value));
      rows.set(id,raw);
      for(const inverse of this.inverse.get(id) ?? [])queue.push(inverse);
      const pending:unknown[]=[raw.arguments];
      while(pending.length){
        if(++values>2_000_000)throw Error('IFC regional argument budget exceeded');
        const value:any=pending.pop();
        if(Array.isArray(value)){for(const item of value)pending.push(item);}
        else if(value?.type===REF){if(!Number.isSafeInteger(value.value)||value.value<=0)throw Error('Invalid IFC subset reference');queue.push(value.value);}
      }
    }
    const model=this.api.CreateModel({schema:this.api.GetModelSchema(this.source)},{COORDINATE_TO_ORIGIN:false});
    if(model<0)throw Error('IFC subset model unavailable');
    const writable = (value:any):void => {
      if(!value || typeof value!=='object')return;
      if(value.type===REAL){
        const raw=value.internalValue ?? value.value,number=Number(raw);
        if(!Number.isFinite(number))throw Error('Invalid IFC subset number');
        const primitive=this.realMode==='string'?String(raw):number;
        Object.defineProperty(value,'internalValue',{value:primitive,configurable:true});
        Object.defineProperty(value,'value',{value:primitive,configurable:true});
        return;
      }
      if(value.type===INTEGER && !Number.isSafeInteger(Number(value.value)))throw Error('IFC subset integer exceeds safe range');
      for(const child of Object.values(value))writable(child);
    };
    try {for(const row of [...rows.values()].sort((a,b)=>a.ID-b.ID)){
      try {
        // The schema writer restores derived attributes (for example SI unit
        // Dimensions), which the raw reader omits. Raw rows are not a lossless
        // serialization format even when their reference closure is complete.
        const entity=this.api.GetLine(this.source,row.ID,false);
        if(this.limitedRelations.has(row.ID))entity.RelatedObjects=entity.RelatedObjects.filter((ref:any)=>requested.has(ref.value));
        writable(entity);this.api.WriteLine(model,entity);
      } catch(error) {throw Error(`IFC subset serialization #${row.ID} type ${row.type}: ${String(error)}`);}
    }
      const unitScale=readRegionalSemantics(this.api,model).unitScale;
      if(!Number.isFinite(unitScale)||Math.abs(unitScale/this.index.unitScale-1)>1e-12)throw Error('IFC subset unit mismatch');
    }
    catch(error){this.api.CloseModel(model);throw error;}
    return {model,records:rows.size,elapsedMs:performance.now()-started};
  }
}
