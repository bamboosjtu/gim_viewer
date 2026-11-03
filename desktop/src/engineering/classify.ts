import rules from './catalogRules.json';
import { classificationDetails } from './classificationDetails.js';
import type { ObjectEvidence, ObjectInterpretation, SourceComponentRole } from './types.js';

export const ENGINEERING_RULES_VERSION = rules.version;
const nameRules=rules.nameRules.map(([category,pattern])=>({category,regex:new RegExp(pattern,'gi')}));
const part=new RegExp(rules.part),independent=new RegExp(rules.independent),group=new RegExp(rules.group,'i'),sourceOnly=new RegExp(rules.sourceOnly);
const c1Roles=rules.c1Roles.map(([role,pattern])=>({role:role as SourceComponentRole,regex:new RegExp(pattern)}));
const nameModifiers=new RegExp(rules.nameModifiers,'gi');

export function normalizedObjectName(name:string):string {
  return name.normalize('NFKC').replace(/&(?:nbsp|#(?:x0*a0|0*160));/gi,' ').replace(nameModifiers,'')
    .replace(/_DEV$/i,'').replace(/\d+(?:\.\d+)?\s*(?:mm|cm|毫米)\b/gi,'')
    .replace(/\d+(?:\.\d+)?(?:[x×*]\d+(?:\.\d+)?)+/gi,'').replace(/\s+/g,'');
}
/** Longest overlapping phrase, then rightmost independent head. Used only as
 * fallback or compatible refinement; a name never overrides a specific type. */
export function categoryFromName(name:string):string {
  const text=normalizedObjectName(name),hits:Array<{start:number;end:number;category:string}>=[];
  for(const rule of nameRules){rule.regex.lastIndex=0;for(const match of text.matchAll(rule.regex)){
    const end=match.index!+match[0].length,tail=text.slice(end);
    if(/^[+、及]/.test(tail)||match[0].length<=2&&/^.{0,5}(?:间隔|系统|区域|进线|出线)/.test(tail))continue;
    hits.push({start:match.index!,end,category:rule.category});
  }}
  const groups:typeof hits=[];
  for(const hit of hits.sort((a,b)=>a.start-b.start||(b.end-b.start)-(a.end-a.start))){
    const old=groups[groups.length-1];
    if(old&&hit.start<old.end){if(hit.end-hit.start>old.end-old.start)groups[groups.length-1]=hit;}else groups.push(hit);
  }
  if(groups.length)return groups[groups.length-1].category;
  if(/^(?:CT|PT)(?:[-_\d]*)$/i.test(text))return /^CT/i.test(text)?'E13':'E14';
  if(/^(?:LW|ZW)\d/i.test(text))return 'E06';
  if(/^GW\d/i.test(text))return 'E07';
  if(/^JW\d/i.test(text))return 'E08';
  if(/(?:柜|屏)$/.test(text))return 'E16.panel_cabinet';
  if(/箱$/.test(text))return 'E17';
  return 'U-OBJECT';
}
export function mainNumber(value:string):string {
  const match=value.match(/(?:#\s*(\d+)\s*(?:备用|预留)?主变)|(?:(\d+)\s*(?:号|#)\s*(?:备用|预留)?主变)|(?:主变(?:系统)?\s*(\d+))/);
  return match?String(Number(match.slice(1).find(Boolean))):'';
}
export function explicitMain(object:ObjectEvidence):string {
  const tokens=new Set(object.designations.map(p=>mainNumber(p.value)).filter(Boolean));return tokens.size===1?[...tokens][0]:'';
}
export function isNumberedDesignation(value:string):boolean {
  const text=value.replace(/(?:AC|DC)?\d+(?:\.\d+)?\s*(?:kV|千伏)|模型\d+|\d+(?:[x×*]\d+)+/gi,'');
  return /#\s*\d+|\d+\s*(?:号|#)|(?:主变|组合电器|避雷器|互感器|电抗器组|电容器组|开关柜|屏柜|设备|装置|支架|基础)\s*\d+(?![\p{L}\p{N}_])|[ⅠⅡⅢⅣⅤ]/u.test(text);
}
const refinements:Record<string,string[]>={
  'E-T':['E01','E03'],E16:['E16.terminal_box','E16.panel_cabinet','E16.control_cabinet','E16.battery_set','E16.protection'],
  'C-B4':['C-B2','C-B3'],'C-B5':['C-B6','C-B7'],
  'C-A1':['C-C1','C-C4'],'C-A2':['C-C1','C-C5','C-B3'],'C-A5':['C-C1','M08'],
};
const compatible=(coarse:string,fine:string)=>coarse===fine||!!refinements[coarse]?.includes(fine);

export function interpretObject(object:ObjectEvidence,hasChildren=false):ObjectInterpretation {
  const name=object.name.trim(),prefix=name.match(/^(.+?模型\d+)[_－](.+)$/),assemblyCategory=prefix?categoryFromName(prefix[1]):'';
  const fragment=!!prefix&&assemblyCategory.startsWith('E'),ownName=fragment?prefix![2]:name;
  const typed=object.typeCategory;
  const declaredRoles=new Set(object.objectRoles?.map(p=>p.value));
  const result=(meaning:ObjectInterpretation['meaning'],basis:string,category=''):ObjectInterpretation=>({category,meaning,basis,conflict:'',independent:false,assemblyCategory:'',assemblySignature:'',classificationStatus:'unresolved',classificationEvidence:[]});
  const neutral=(basis:string,evidence:string[],confirmed=false):ObjectInterpretation=>({
    ...result('neutral_set',basis,'E01'),subtype:'neutral_set',subtypeLabel:'中性点成套装置',
    classificationStatus:confirmed?'confirmed':'candidate',classificationEvidence:evidence,
  });
  if(object.traits.nonphysical)return result('source_only','nonphysical_or_interface');
  if(object.traits.fastener)return result('detail','internal_fastener');
  if(typed==='part'||declaredRoles.has('part'))return result('part','object_component_attribute');
  const properties=[...new Set(object.propertyCategories?.map(p=>p.value)??[])];
  const validTyped=typed&&typed!=='neutral_set'?typed:undefined;
  const canRefine=(coarse:string,fine:string)=>compatible(coarse,fine)||coarse===validTyped&&!!object.typeRefinements?.includes(fine);
  const hasIdentity=!!typed||properties.length>0;
  if(!hasIdentity&&sourceOnly.test(name))return result('source_only','nonphysical_or_interface');
  if(!hasIdentity&&/螺母|螺钉|垫圈|销轴|开口销|膨胀螺栓|^螺栓$/.test(ownName))return result('detail','internal_fastener');
  if(group.test(name)&&hasChildren&&object.traits.assemblyContainer)return result('container','source_container');
  const named=categoryFromName(ownName),namedIndependent=independent.test(ownName)&&named!=='U-OBJECT';
  if(typed==='neutral_set')return neutral('neutral_set_identity',[object.typeEvidenceId??`type:${object.sourceId}`],true);
  if(!hasIdentity&&part.test(ownName)&&!namedIndependent&&!(named==='M07'&&!object.assemblyParentId)){
    return fragment?{...result('fragment','declared_design_fragment'),assemblyCategory,assemblySignature:prefix![1]}:result('part','component_head');
  }
  if(!hasIdentity){
    const ownNeutral=/中性点(?:成套(?:设备|装置)?|装置|设备)/;
    if(ownNeutral.test(ownName))return neutral('neutral_set_identity',object.names?.filter(n=>n.value===name).map(n=>n.evidenceId)??[`name:${object.sourceId}`]);
    // A name in the matched object's FAM is a valid fallback, but cannot turn
    // an explicitly named component or a different identified object into a set.
    if(named==='U-OBJECT'){
      const family=object.identityNames.find(p=>ownNeutral.test(p.value));
      if(family)return neutral('neutral_set_family_identity',[family.evidenceId]);
    }
  }
  const identities=object.identityNames.map(p=>({category:categoryFromName(p.value),evidence:p.evidenceId})).filter(p=>p.category!=='U-OBJECT');
  let category=validTyped??'U-OBJECT',basis=validTyped?'type':'unknown',conflict='';
  let evidence=validTyped?[object.typeEvidenceId??`type:${object.sourceId}`]:[];
  for(const property of properties){
    if(category==='U-OBJECT'&&basis==='unknown'||canRefine(category,property)){category=property;basis='object_attribute';}
    else if(!canRefine(property,category)){conflict=[category,...properties].join('!=');category='U-OBJECT';basis='attribute_conflict';break;}
  }
  if(properties.length)evidence.push(...object.propertyCategories!.map(p=>p.evidenceId));
  if(basis!=='attribute_conflict'){
    const purpose=identities.find(p=>canRefine(category,p.category));
    if(purpose&&purpose.category!==category){category=purpose.category;basis='type+object_identity';evidence.push(purpose.evidence);}
    else if(canRefine(category,named)&&category!==named){category=named;basis='type+name_refinement';}
    if(category==='U-OBJECT'){
      category=named!=='U-OBJECT'?named:identities[0]?.category??'U-OBJECT';
      basis=named!=='U-OBJECT'?'object_name':identities.length?'family_identity_candidate':'unknown';
      evidence.push(...(object.names?.filter(n=>n.value===name).map(n=>n.evidenceId)??[]));
    }
    if((category==='E-T'||category==='E01')&&explicitMain(object)){category='E01';evidence.push(...object.designations.map(p=>p.evidenceId));}
    if(category==='U-OBJECT'&&object.traits.materialType){category='M09';basis='material_type_fallback';}
    if(hasIdentity&&named!=='U-OBJECT'&&!canRefine(category,named)&&!canRefine(named,category))conflict=`${category}!=${named}`;
  }
  const isIndependent=declaredRoles.has('independent')||category.startsWith('E16')||category==='E17'||category.startsWith('C-D')||namedIndependent&&compatible(category,named);
  const role=category==='C-C1'?c1Roles.find(r=>r.regex.test(ownName))?.role:undefined;
  const details=classificationDetails(category,object.subtypeNames?.length?object.subtypeNames.map(p=>p.value).join(' '):ownName);
  if(basis.includes('name')||basis==='family_identity_candidate')evidence.push(...(object.names?.filter(n=>n.value===name).map(n=>n.evidenceId)??[`name:${object.sourceId}`]),...identities.filter(p=>p.category===category).map(p=>p.evidence));
  if(details.subtype)evidence.push(...object.subtypeNames?.map(p=>p.evidenceId)??[]);
  return {...result(fragment&&!isIndependent&&!['C-B1','C-B2','C-B3','C-B4'].includes(category)?'fragment':'object',basis,category),
    ...details,...(role?{role,subtype:role,subtypeLabel:role==='cover'?'盖板':role==='sidewall'?'侧壁':'底板'}:{}),
    independent:basis==='attribute_conflict'?false:isIndependent,conflict,classificationEvidence:[...new Set(evidence)],
    classificationStatus:category==='U-OBJECT'?'unresolved':category==='E-T'||category==='C-B4'||basis==='family_identity_candidate'||basis==='material_type_fallback'||conflict||/^(?:LW|ZW|GW|JW)\d|^(?:CT|PT)[-_\d]*$/i.test(name)?'candidate':'confirmed',
    ...(basis==='attribute_conflict'?{unknownReason:'conflicting_object_attributes'}:{}),
    ...(category==='M07'&&!object.assemblyParentId&&/主变|变压器|中性点|断路器/.test(name)?{unknownReason:'equipment_bushing_host_unresolved'}:{}),
    assemblyCategory:fragment?assemblyCategory:'',assemblySignature:fragment?prefix![1]:'',
  };
}
