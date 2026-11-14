import {engineeringSourceRecords} from './sourceGraph.js';
import type { EvidenceInventory, EvidencePage, EvidenceQuery, EvidenceRange, SourceAttribute, SourceAttributeAssignment,EvidenceStatus } from '../../engineering/evidence.js';
import { parseFamSectionsWithDiagnostics } from '../famParser.js';
import type { EngineeringSourceGraph,SourceDocument } from './sourceGraph.js';
import { attributeFromProperty,annotateAttributeConflicts } from './attributeEvidence.js';
import type {SourceRecord,SourceProperty} from './sourceEvidence.js';

/** Session-owned provider. Metadata/query operations never initiate IO. */
export class ModelEvidenceProvider {
  private revision=0;
  private parsedComplete=0;
  private snapshot?:EvidenceInventory;
  private entries=new Map<string,EvidenceInventory['entries'][number]>();
  private documents=new Map<string,{path:string;rawLines:string[]}>();
  private attributes=new Map<string,SourceAttribute[]>();
  private reads=new Map<string,Promise<string>>();
  private entryIds:Set<string>;
  private assignmentIndex=new Map<string,Array<Omit<SourceAttributeAssignment,'attributeId'>>>();
  private directAssignments=new Map<string,Set<string>>();
  private propertyViews=new Map<string,readonly SourceProperty[]>();
  private extraByPath=new Map<string,SourceRecord[]>();
  private attributeBytes=new Map<string,number>();
  private cachedBytes=0;
  private graphDocuments=new Set<string>();
  private refsByPath=new Map<string,EngineeringSourceGraph['references']>();
  private rowsByPath=new Map<string,{id:string;path:string}[]>();
  constructor(private readonly scope:string,paths:readonly string[],private readonly reader:(path:string)=>Promise<string>,private readonly rawReader?:(path:string)=>Promise<Uint8Array>){
    for(const path of paths)this.entries.set(path,{id:path,path,formatHint:path.split('.').pop()?.toLowerCase()??'',readStatus:'not_requested',status:'not_requested'});
    this.entryIds=new Set(paths);
  }
  async readEntry(path:string):Promise<Uint8Array>{
    this.checkRange({entryIds:[path],kinds:[]});if(!this.rawReader)throw Error('Raw source reader unavailable');
    try{const bytes=await this.rawReader(path);this.entries.set(path,{...this.entries.get(path)!,readStatus:'available'});this.revision++;return bytes;}
    catch(error){this.entries.set(path,{...this.entries.get(path)!,readStatus:'failed'});this.revision++;throw error;}
  }
  private setStatus(path:string,status:EvidenceInventory['entries'][number]['status']):void{const entry=this.entries.get(path);if(entry){this.parsedComplete+=(status==='complete'?1:0)-(entry.status==='complete'?1:0);this.entries.set(path,{...entry,status});}}
  recordFailure(path:string):void{this.setStatus(path,'failed');const entry=this.entries.get(path);if(entry)this.entries.set(path,{...entry,readStatus:'failed'});this.revision++;}
  resetObservations():void{this.documents.clear();this.attributes.clear();this.reads.clear();this.assignmentIndex.clear();this.directAssignments.clear();this.propertyViews.clear();this.extraByPath.clear();this.attributeBytes.clear();this.graphDocuments.clear();this.cachedBytes=0;this.parsedComplete=0;this.refsByPath.clear();this.rowsByPath.clear();for(const path of this.entryIds)this.entries.set(path,{...this.entries.get(path)!,status:'not_requested',readStatus:'not_requested'});this.revision++;}
  getRevision():number{return this.revision;}
  restoreMetadata(snapshot:EvidenceInventory):void{
    if(snapshot.scope!==this.scope||snapshot.entries.length!==this.entries.size||new Set(snapshot.entries.map(e=>e.id)).size!==this.entries.size||snapshot.entries.some(e=>!this.entryIds.has(e.id))||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)throw Error('Invalid evidence checkpoint metadata');
    this.detachRaw();this.entries=new Map(snapshot.entries.map(e=>[e.id,{...e}]));this.parsedComplete=snapshot.entries.filter(e=>e.status==='complete').length;this.revision=Math.max(this.revision,snapshot.revision);this.snapshot=undefined;
  }
  seedCoverage(coverage:readonly {path:string;status:EvidenceStatus}[]):void{let changed=false;for(const row of coverage)if(this.entries.get(row.path)?.status!==row.status){this.setStatus(row.path,row.status);changed=true;}if(changed)this.revision++;}
  /** Drop reconstructible details while retaining the truthful metadata history. */
  detachRaw():void{this.documents.clear();this.attributes.clear();this.reads.clear();this.assignmentIndex.clear();this.directAssignments.clear();this.propertyViews.clear();this.extraByPath.clear();this.attributeBytes.clear();this.graphDocuments.clear();this.refsByPath.clear();this.rowsByPath.clear();this.cachedBytes=0;this.revision++;}
  getSnapshot(entryIds?:readonly string[]):EvidenceInventory{
    if(entryIds){this.checkRange({entryIds,kinds:[]});return {scope:this.scope,revision:this.revision,inventoryComplete:true,entryRange:[...entryIds],inventoryTotals:{entries:this.entries.size,parsedComplete:this.parsedComplete},entries:entryIds.map(id=>({...this.entries.get(id)!})),coverage:entryIds.map(id=>({entryId:id,status:this.entries.get(id)!.status,capability:'attributes',materialization:this.attributes.has(id)?'materialized':'not_materialized',rawAvailable:this.documents.has(id)||this.propertyViews.has(id)||this.extraByPath.has(id)}))};}
    if(this.snapshot?.revision===this.revision)return this.snapshot;
    return this.snapshot=Object.freeze({scope:this.scope,revision:this.revision,inventoryComplete:true,inventoryTotals:{entries:this.entries.size,parsedComplete:this.parsedComplete},entries:Object.freeze([...this.entries.values()].map(e=>Object.freeze({...e}))),
      coverage:Object.freeze([...this.entries.values()].map(e=>Object.freeze({entryId:e.id,status:e.status,capability:'attributes' as const,materialization:this.attributes.has(e.id)?'materialized' as const:'not_materialized' as const,rawAvailable:this.documents.has(e.id)||this.propertyViews.has(e.id)||this.extraByPath.has(e.id)})))});
  }
  attachGraph(graph:EngineeringSourceGraph,extra:readonly SourceRecord[]=[]):void{
    this.graphDocuments=new Set(graph.documents.map(d=>d.path));
    for(const doc of graph.documents)this.observe(doc.path,doc.rawLines);
    for(const diagnostic of graph.diagnostics)if(diagnostic.kind==='read-failed')this.setStatus(diagnostic.source,'failed');
    this.refsByPath.clear();this.rowsByPath.clear();
    const familiesByOwner=new Map<string,Set<string>>();
    for(const ref of graph.references){
      const rows=this.refsByPath.get(ref.owner)??[];rows.push(ref);this.refsByPath.set(ref.owner,rows);
      const target=ref.target;
      if(target&&/\.fam$/i.test(target)){const paths=familiesByOwner.get(ref.owner)??new Set<string>();paths.add(target);familiesByOwner.set(ref.owner,paths);}
    }
    for(const row of engineeringSourceRecords(graph,extra)){const rows=this.rowsByPath.get(row.source)??[];rows.push({id:row.id,path:row.source});this.rowsByPath.set(row.source,rows);}
    for(const node of graph.cbmOccurrences){const rows=this.rowsByPath.get(node.documentPath)??[];rows.push({id:node.id,path:node.documentPath});this.rowsByPath.set(node.documentPath,rows);}
    this.assignmentIndex.clear();
    const assignmentKeys=new Map<string,Set<string>>();
    const indexAssignment=(path:string,assignment:Omit<SourceAttributeAssignment,'attributeId'>)=>{
      // Assignment identity is its owning occurrence, not a serialization of
      // all candidates. Large repeated PARTINDEX vectors make huge Set keys
      // with common prefixes and retain a second copy of every source ID.
      const rows=this.assignmentIndex.get(path)??[],keys=assignmentKeys.get(path)??new Set<string>();
      const key=assignment.occurrenceId?'alias:'+assignment.occurrenceId:'source:'+assignment.sourceId;
      if(!keys.has(key)){keys.add(key);rows.push(assignment);}
      assignmentKeys.set(path,keys);
      this.assignmentIndex.set(path,rows);
    };
    for(const a of graph.familyAssignments??[])indexAssignment(a.path,{sourceId:a.sourceId,candidateSourceIds:[a.sourceId],status:'confirmed'});
    const cbmPaths=new Map(graph.cbmOccurrences.map(node=>[node.id,node.documentPath]));
    for(const alias of graph.aliases){
      if(alias.status==='confirmed')continue; // Already indexed at the actual assignment site.
      const owner=cbmPaths.get(alias.sourceId);if(!owner)continue;
      for(const path of familiesByOwner.get(owner)??[])
        indexAssignment(path,{occurrenceId:alias.sourceId,candidateSourceIds:alias.candidates,status:alias.status});
    }
    // Keep references to existing parsed facts; typed attribute views are generated on demand.
    for(const doc of graph.documents){
      this.documents.set(doc.path,{path:doc.path,rawLines:doc.rawLines});
      if(doc.attributeStatus){this.propertyViews.set(doc.path,doc.fields);this.setStatus(doc.path,doc.attributeStatus);}
    }
    for(const path of this.extraByPath.keys())this.dropAttributes(path);
    this.extraByPath.clear();this.directAssignments.clear();
    for(const row of extra){const path=row.sources[0],rows=this.extraByPath.get(path)??[];rows.push(row);this.extraByPath.set(path,rows);this.setStatus(path,'partial');}
    this.revision++;
  }
  private observe(path:string,rawLines:string[]):void{
    if(this.documents.has(path))return;
    this.documents.set(path,{path,rawLines});
    const entry=this.entries.get(path);if(entry)this.entries.set(path,{...entry,readStatus:'available'});
    this.setStatus(path,'partial');this.revision++;
  }
  readText(path:string):Promise<string>{
    if(!this.entryIds.has(path))return Promise.reject(Error('Unknown source entry: '+path));
    const doc=this.documents.get(path);if(doc)return Promise.resolve(doc.rawLines.join('\n'));
    let read=this.reads.get(path);
    if(!read){read=this.reader(path).then(text=>{
      let lines=0;for(let at=text.indexOf('\n');at>=0;at=text.indexOf('\n',at+1))if(++lines>200000)throw Error('Evidence text exceeds line budget; read original entry');
      this.observe(path,text.split(/\r?\n/));this.reads.delete(path);return text;
    }).catch(error=>{
      this.recordFailure(path);this.reads.delete(path);throw error;
    });this.reads.set(path,read);}
    return read;
  }
  async ensureEvidence(range:EvidenceRange):Promise<EvidenceInventory>{
    this.checkRange(range);
    for(const path of range.entryIds){
      const wantsAttributes=range.kinds.includes('attributes')||range.kinds.includes('assignments');
      if(range.kinds.includes('documents')&&!this.documents.has(path))await this.readText(path);
      if(!wantsAttributes)continue;
      const cached=this.attributes.get(path);if(cached){this.attributes.delete(path);this.attributes.set(path,cached);continue;}
      let properties=this.propertyViews.get(path);
      if(!properties&&/\.fam$/i.test(path)){
        const parsed=parseFamSectionsWithDiagnostics(await this.readText(path),path);
        properties=parsed.properties.map(p=>({path,line:p.sourceLine,keys:[p.label,p.rawKey],value:p.rawValue,section:p.section}));
        this.propertyViews.set(path,properties);this.setStatus(path,parsed.diagnostics.malformedLineCount?'partial':'complete');
      }
      const records=this.extraByPath.get(path);
      if((properties?.length??0)>20000||(records?.reduce((n,r)=>n+r.properties.length,0)??0)>20000)throw Error('Evidence attribute view exceeds budget; read original source');
      let attributes:SourceAttribute[]=[];
      if(properties)attributes=properties.map((p,i)=>attributeFromProperty(p,i));
      else if(records){
        const unique=new Map<string,SourceAttribute>();
        for(const row of records){const ordinals=new Map<string,number>();for(const property of row.properties){
          const key=JSON.stringify([property.source,property.keys]),ordinal=ordinals.get(key)??0;ordinals.set(key,ordinal+1);
          const attr=attributeFromProperty({...property,sourceId:row.id},ordinal);unique.set(attr.id,attr);
          const ids=this.directAssignments.get(attr.id)??new Set<string>();ids.add(row.id);this.directAssignments.set(attr.id,ids);
        }}attributes=[...unique.values()];
      }else continue;
      try{this.cacheAttributes(path,annotateAttributeConflicts(attributes));}catch(error){this.dropAttributes(path);this.revision++;throw error;}this.revision++;
    }
    return this.getSnapshot(range.entryIds);
  }
  private dropAttributes(path:string):void{
    for(const attr of this.attributes.get(path)??[])this.directAssignments.delete(attr.id);
    this.attributes.delete(path);this.cachedBytes-=this.attributeBytes.get(path)??0;this.attributeBytes.delete(path);
    if(!this.graphDocuments.has(path)&&!this.extraByPath.has(path)){this.documents.delete(path);this.propertyViews.delete(path);}
  }
  private cacheAttributes(path:string,attributes:SourceAttribute[]):void{
    let bytes=0;for(const attr of attributes){const size=JSON.stringify(attr).length*2;if(size>512*1024)throw Error('Evidence record exceeds page budget; read original source');bytes+=size;}
    if(!this.graphDocuments.has(path)&&!this.extraByPath.has(path)){bytes+=(this.documents.get(path)?.rawLines.reduce((n,line)=>n+line.length*2+8,0)??0)+(this.propertyViews.get(path)?.length??0)*64;}
    if(bytes>16*1024*1024)throw Error('Evidence attribute view exceeds budget; read original source');
    while(this.cachedBytes+bytes>32*1024*1024){const first=this.attributes.keys().next().value;if(first===undefined)break;this.dropAttributes(first);}
    this.attributes.set(path,attributes);this.attributeBytes.set(path,bytes);this.cachedBytes+=bytes;
  }
  private checkRange(range:EvidenceRange):void{
    if(range.entryIds.some(id=>!this.entryIds.has(id)))throw Error('Unknown evidence entry');
  }
  familyDocument(path:string):SourceDocument|undefined{
    const doc=this.documents.get(path),fields=this.propertyViews.get(path);
    if(!/\.fam$/i.test(path)||!doc||!fields)return undefined;
    return {path,rawLines:doc.rawLines,fields:fields.map(p=>({...p,path,keys:p.keys??[]})),attributeStatus:this.entries.get(path)?.status==='complete'?'complete':'partial'};
  }
  queryEvidence(query:EvidenceQuery):EvidencePage{
    if(query.revision!==this.revision)throw Error('EVIDENCE_REVISION_EXPIRED');
    this.checkRange(query.range);
    const offset=query.offset??0;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>1000)throw Error('Invalid evidence page');
    const page:EvidencePage={revision:this.revision,attributes:[],assignments:[],documents:[],references:[],occurrences:[],coverage:[]};
    let index=0,count=0,bytes=0;
    const add=(kind:EvidenceRange['kinds'][number],value:unknown):boolean=>{
      if(index++<offset)return true;
      const size=JSON.stringify(value).length*2;
      if(size>512*1024)throw Error('Evidence record exceeds page budget; read original entry');
      if(count===query.limit||bytes+size>512*1024){page.nextOffset=index-1;return false;}
      bytes+=size;count++;
      const key=kind==='assignments'?'assignments':kind;
      (page[key] as unknown[]).push(value);return true;
    };
    outer:for(const id of query.range.entryIds)for(const kind of query.range.kinds){
      if(kind==='attributes')for(const attr of this.attributes.get(id)??[])if(!add(kind,attr))break outer;
      if(kind==='assignments')for(const attr of this.attributes.get(id)??[]){
        const direct=this.directAssignments.get(attr.id);
        const assignments=direct?[...direct].map(sourceId=>({sourceId,candidateSourceIds:[sourceId],status:'confirmed' as const})):this.assignmentIndex.get(id)??[];
        for(const assignment of assignments)if(!add(kind,{attributeId:attr.id,...assignment}))break outer;
        if(!assignments.length&&!add(kind,{attributeId:attr.id,candidateSourceIds:[],status:'unresolved'}))break outer;
      }
      if(kind==='documents')for(const line of this.documents.get(id)?.rawLines??[])if(!add(kind,{path:id,rawLines:[line]}))break outer;
      if(kind==='references')for(const row of this.refsByPath.get(id)??[])if(!add(kind,row))break outer;
      if(kind==='occurrences')for(const row of this.rowsByPath.get(id)??[])if(!add(kind,row))break outer;
    }
    page.coverage=query.range.entryIds.flatMap(id=>query.range.kinds.map(capability=>{
      const rawAvailable=this.documents.has(id)||this.propertyViews.has(id)||this.extraByPath.has(id);
      const typed=capability==='attributes'||capability==='assignments';
      const materialized=typed?this.attributes.has(id):capability==='documents'?this.documents.has(id):this.graphDocuments.has(id)||this.rowsByPath.has(id);
      const status=this.entries.get(id)!.status==='failed'?'failed':capability==='documents'?this.documents.has(id)?'complete':'not_requested':typed?this.propertyViews.has(id)||this.extraByPath.has(id)?capability==='assignments'?'partial':this.entries.get(id)!.status:/\.fam$/i.test(id)?'not_requested':'unsupported':materialized?'partial':'not_requested';
      return {entryId:id,capability,status,materialization:materialized?'materialized' as const:'not_materialized' as const,rawAvailable};
    }));
    return structuredClone(page);
  }
}
