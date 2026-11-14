import {categoryFromName,isNumberedDesignation,mainNumber} from './classify.js';
import type {ObjectEvidence,ObjectInterpretation,EngineeringEntity,EngineeringSnapshot} from './types.js';

/** Recover engineering composition from object-owned declarations. This never
 * edits the source parent, physical occurrence or representation address. */
export function recoverComponentMembership(rows:readonly ObjectEvidence[],meaning:ReadonlyMap<string,ObjectInterpretation>,
  owners:Map<string,string|null>,entities:Map<string,EngineeringEntity>,
  unresolved:(sourceId:string,reason:string)=>void,
  create:(seed:string,category:string,name:string,source:string)=>EngineeringEntity,
  diagnostics:EngineeringSnapshot['diagnostics']):void{
  const key=(value:string)=>{const main=mainNumber(value),text=value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    return main&&/(?:主变(?:压器)?(?:系统)?\d*|主变(?:压器)?(?:系统)?(?:备用|预留)?)$/.test(text)?`main:${main}:${/备用|预留/.test(value)?'reserve':'active'}`:text;};
  const codes=new Map<string,Set<string>>(),names=new Map<string,Set<string>>(),children=new Map<string,ObjectEvidence[]>();
  const index=(map:Map<string,Set<string>>,value:string,owner:string)=>{const k=key(value),ids=map.get(k)??new Set<string>();ids.add(owner);map.set(k,ids);};
  for(const row of rows){
    if(row.assemblyParentId){const list=children.get(row.assemblyParentId)??[];list.push(row);children.set(row.assemblyParentId,list);}
    const owner=owners.get(row.sourceId),m=meaning.get(row.sourceId)!;
    if(!owner||!entities.get(owner)?.category.startsWith('E')||entities.get(owner)?.category==='E18'||m.meaning!=='object')continue;
    row.identityCodes.forEach(p=>index(codes,p.value,owner));row.designations.forEach(p=>index(names,p.value,owner));
    if(isNumberedDesignation(row.name))index(names,row.name,owner);
  }
  const attach=(row:ObjectEvidence,to:string,proof:string[],status:'confirmed'|'candidate')=>{
    const previous=owners.get(row.sourceId),m=meaning.get(row.sourceId)!;owners.set(row.sourceId,to);
    m.meaning='part';m.independent=false;m.membershipEvidence=proof;m.membershipStatus=status;m.basis='declared_component_host';
    if(m.objectRole)m.objectRole={id:'part',status,evidence:proof};
    const visited=new Set<string>();
    const visit=(id:string)=>{if(visited.has(id))return;visited.add(id);for(const child of children.get(id)??[]){
      const cm=meaning.get(child.sourceId)!;
      if(owners.get(child.sourceId)!==previous||!['part','detail','container','source_only','fragment'].includes(cm.meaning))continue;
      owners.set(child.sourceId,to);cm.membershipEvidence=proof;cm.membershipStatus=status;visit(child.sourceId);
    }};if(previous!==to)visit(row.sourceId);
  };
  for(const row of rows){
    const m=meaning.get(row.sourceId)!;
    if(m.basis==='attribute_conflict'||row.objectRoles?.some(p=>p.value==='independent')||!(m.meaning==='part'||m.componentType?.status==='confirmed'))continue;
    const direct=row.hostCodes?.length||row.hostDesignations?.length?[]:row.declaredHostSourceIds??[];
    const explicit=[...direct,...(row.hostCodes??[]),...(row.hostDesignations??[])];
    const own=row.designations.filter(p=>isNumberedDesignation(p.value));
    const prefix=row.name.split(/[_－:：]/)[0];
    const inferred=!explicit.length&&!own.length&&isNumberedDesignation(prefix)?[{value:prefix,evidenceId:row.names?.find(n=>n.value===row.name)?.evidenceId??`name:${row.sourceId}`}]:[];
    const designations=explicit.length?row.hostDesignations??[]:own.length?own:inferred;
    const constraints=[...direct.map(p=>{const owner=owners.get(p.value),host=owner?entities.get(owner):undefined;return host&&(host.category.startsWith('E')||host.category.startsWith('M'))?new Set([host.id]):new Set<string>();}),...(row.hostCodes??[]).map(p=>codes.get(key(p.value))??new Set<string>()),...designations.map(p=>names.get(key(p.value))??new Set<string>())];
    if(!constraints.length)continue;
    let candidates=new Set(constraints[0]);for(const values of constraints.slice(1))candidates=new Set([...candidates].filter(id=>values.has(id)));
    if(!explicit.length&&m.meaning==='object'&&candidates.size===1&&candidates.has(owners.get(row.sourceId)??''))continue;
    const proof=[...direct,...(row.hostCodes??[]),...designations].map(p=>p.evidenceId);
    if(candidates.size===1){attach(row,[...candidates][0],proof,inferred.length||direct.length?'candidate':'confirmed');continue;}
    const anyMatch=constraints.some(ids=>ids.size>0);
    const name=designations.length===1?designations[0].value:'',category=categoryFromName(name);
    // A declared numbered host can establish a candidate whole even when the
    // exporter delivered only its components. A catalog term alone cannot.
    if(!inferred.length&&!anyMatch&&name&&isNumberedDesignation(name)&&category.startsWith('E')&&category!=='E18'&&category!=='E19'&&m.meaning==='part'){
      const code=row.hostCodes?.[0]?.value??'',seed=`declared-host:${JSON.stringify([code,key(name)])}`;
      const host=create(seed,category,name,row.sourceId);host.boundaryStatus='candidate';host.classificationStatus='candidate';
      index(names,name,host.id);if(code)index(codes,code,host.id);
      attach(row,host.id,proof,'candidate');continue;
    }
    if(explicit.length||anyMatch){
      unresolved(row.sourceId,anyMatch?'component_host_ambiguous':'component_host_not_found');m.membershipEvidence=proof;m.membershipStatus='unresolved';
      diagnostics.push({kind:anyMatch?'component_host_ambiguous':'component_host_not_found',identity:row.sourceId,name:row.name});
    }
  }
}
