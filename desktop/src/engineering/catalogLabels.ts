import catalog from './catalog.json';
import {STANDARD_CATALOG} from './standardCatalog.js';
import policy from './recognitionPolicy.json';
import type {EngineeringEntity} from './types.js';
const index={items:STANDARD_CATALOG};

/** Single catalog vocabulary shared by classification and independent projections. */
export const ENGINEERING_CATALOG_VERSION = catalog.version;
export const ENGINEERING_CATEGORIES = catalog.categories;
export const ENGINEERING_CATEGORY_LABELS: Readonly<Record<string,string>> = Object.fromEntries(catalog.categories.map(c=>[c.code,c.label]));
export const categoryLabel = (code:string) => ENGINEERING_CATEGORY_LABELS[code] ?? code;
export const RECOGNITION_LABELS:Readonly<Record<string,string>>=Object.fromEntries(policy.recognitionCodes.map(c=>[c.code,c.label]));
export const recognitionLabel=(code:string)=>RECOGNITION_LABELS[code]??code;
export const recognitionCategory=(entity:Pick<EngineeringEntity,'category'|'recognitionCode'>)=>entity.recognitionCode??entity.category;
export const categoryDefinition = (code:string) => codes.get(code);
export const classificationReasonLabel=(reason:string)=>({
  material_subtype_evidence_insufficient:'材料具体形式尚无足够证据',equipment_subtype_evidence_insufficient:'设备具体类型尚待确认',
  foundation_purpose_unresolved:'尚不能确定属于设备基础还是建筑物基础',transformer_purpose_unresolved:'尚不能确定主变或站用用途',
  object_category_unresolved:'当前对象缺少可确认的类别证据',conflicting_object_attributes:'当前对象的有效属性相互矛盾',
  equipment_bushing_host_unresolved:'设备本体套管的具体宿主尚待确认',
} as Record<string,string>)[reason]??'对象证据尚待核对';

export const MODEL_CATALOG_CATEGORIES=catalog.categories;
const directoryByTerm=new Map(catalog.categories.flatMap(row=>[[row.code,row],[row.label,row]] as const));
export const directoryDefinition=(code:string)=>directoryByTerm.get(code);
export const COMPONENT_CATALOG=catalog.components;
const indexed=new Map(index.items.map(item=>[item.id,item]));
const codes=new Map(policy.recognitionCodes.map(item=>[item.code,item]));
const byCode=new Map<string,typeof index.items>();
const byRecognition=new Map<string,typeof index.items>();
for(const item of index.items){
  const list=byCode.get(item.category)??[];list.push(item);byCode.set(item.category,list);
  const roles=byRecognition.get(item.recognitionCode)??[];roles.push(item);byRecognition.set(item.recognitionCode,roles);
}
const directoryRoles=new Map([...byCode].map(([category,items])=>[category,[...new Set(items.map(item=>item.recognitionCode))]]));
const componentNames=new Map<string,string>();
for(const item of COMPONENT_CATALOG){const labels=componentNames.get(item.id)?.split(' / ')??[];if(!labels.includes(item.label))labels.push(item.label);componentNames.set(item.id,labels.join(' / '));}
const componentById=new Map(COMPONENT_CATALOG.map(item=>[item.id,item]));
export const componentLabel=(id:string)=>componentNames.get(id)??id;
export function catalogLocation(entity:Pick<EngineeringEntity,'category'|'standardClass'>){
  const specific=entity.standardClass?.id?indexed.get(entity.standardClass.id):undefined;
  let item=!entity.category.startsWith('U')&&specific?.category===entity.category?specific:undefined;
  const matches=byCode.get(entity.category)??[];
  if(!item&&matches.length===1)item=matches[0];
  if(item)return {kind:item.kind,group:item.catalogGroup,category:item.catalogCategory,label:item.label,id:item.id,order:item.order};
  const same=matches.length>0&&matches.every(row=>row.kind===matches[0].kind&&row.catalogCategory===matches[0].catalogCategory);
  if(same)return{kind:matches[0].kind,group:matches[0].catalogGroup,category:matches[0].catalogCategory,label:'类型待确认',id:entity.category,order:matches[0].order};
  const family=catalog.categories.find(row=>row.code===entity.category);
  if(family)return{kind:family.kind,group:family.groupLabel,category:family.label,label:'类型待确认',id:entity.category,order:family.order};
  return {kind:'unknown',group:'其他',category:'类别待确认',label:'类型待确认',id:entity.category,order:999};
}
/** Apply the configured directory after identity and membership decisions. */
export function directoryClassification(code:string,specific?:EngineeringEntity['standardClass']):{category:string;recognitionCode:string}{
  if(code==='U-OBJECT'||!code)return{category:code,recognitionCode:code};
  if(specific)return{category:specific.category,recognitionCode:code};
  const definition=codes.get(code),matches=byRecognition.get(code)??[];
  const preferred=definition&&'catalogId' in definition?indexed.get(definition.catalogId!):undefined;
  const unique=[...new Set(matches.map(item=>item.category))];
  const family=definition&&'catalogFamily' in definition?catalog.categories.find(row=>row.kind===definition.catalogFamily!.kind&&row.label===definition.catalogFamily!.label):undefined;
  return{category:preferred?.category??(unique.length===1?unique[0]:family?.code??'U-OBJECT'),recognitionCode:code};
}
export function publishDirectoryClassification<T extends {category:string;recognitionCode?:string;standardClass?:EngineeringEntity['standardClass'];classificationStatus?:string;categoryStatus?:string;conflict?:string}>(value:T):T{
  const result={...value,...directoryClassification(value.category,value.standardClass)};
  if(result.category==='U-OBJECT'){result.classificationStatus='unresolved';result.categoryStatus='unresolved';}
  if(result.category!=='U-OBJECT'&&value.standardClass?.status==='confirmed'&&!value.conflict){result.classificationStatus='confirmed';result.categoryStatus='confirmed';}
  return result;
}
export function directoryRecognitionCode(code:string):string|undefined{
  code=directoryDefinition(code)?.code??code;
  const roles=directoryRoles.get(code)??[];
  if(code==='E01')return 'E-T';if(code==='E02')return 'E-R';
  return roles[0];
}
export const catalogPathLabel=(entity:Pick<EngineeringEntity,'category'|'standardClass'|'subtypeStatus'|'subtypeLabel'>)=>{
  const row=catalogLocation(entity),subtype=entity.subtypeStatus==='confirmed'?entity.subtypeLabel:undefined;
  return [...new Set([row.category,...(subtype&&row.label==='类型待确认'?[]:[row.label]),...(subtype?[subtype]:[])])].join(' / ');
};

export function componentDefinition(meaning:{componentType?:{id?:string}}){return componentById.get(meaning.componentType?.id??'');}
