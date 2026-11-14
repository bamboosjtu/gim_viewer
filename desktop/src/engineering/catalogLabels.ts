import catalog from './catalog.json';
import index from './standardCatalog.json';
import type {EngineeringEntity} from './types.js';

/** Single catalog vocabulary shared by classification and independent projections. */
export const ENGINEERING_CATALOG_VERSION = catalog.version;
export const ENGINEERING_CATEGORIES = catalog.semanticCodes;
export const ENGINEERING_CATEGORY_LABELS: Readonly<Record<string,string>> = Object.fromEntries(catalog.semanticCodes.map(c=>[c.code,c.label]));
export const categoryLabel = (code:string) => ENGINEERING_CATEGORY_LABELS[code] ?? code;
export const categoryDefinition = (code:string) => catalog.semanticCodes.find(c=>c.code===code);
export const classificationReasonLabel=(reason:string)=>({
  material_subtype_evidence_insufficient:'材料具体形式尚无足够证据',equipment_subtype_evidence_insufficient:'设备具体类型尚待确认',
  foundation_purpose_unresolved:'尚不能确定属于设备基础还是建筑物基础',transformer_purpose_unresolved:'尚不能确定主变或站用用途',
  object_category_unresolved:'当前对象缺少可确认的类别证据',conflicting_object_attributes:'当前对象的有效属性相互矛盾',
  equipment_bushing_host_unresolved:'设备本体套管的具体宿主尚待确认',
} as Record<string,string>)[reason]??'对象证据尚待核对';

export const MODEL_CATALOG_CATEGORIES=catalog.categories;
export const COMPONENT_CATALOG=catalog.components;
const indexed=new Map(index.items.map(item=>[item.id,item]));
const codes=new Map(catalog.semanticCodes.map(item=>[item.code,item]));
const byCode=new Map<string,typeof index.items>();
for(const item of index.items){const list=byCode.get(item.category)??[];list.push(item);byCode.set(item.category,list);}
const componentNames=new Map(COMPONENT_CATALOG.map(item=>[item.id,item.label]));
const componentById=new Map(COMPONENT_CATALOG.map(item=>[item.id,item]));
const componentByTerm=new Map(COMPONENT_CATALOG.map(item=>[item.term.toLowerCase(),item]));
export const componentLabel=(id:string)=>componentNames.get(id)??id;
export function catalogLocation(entity:Pick<EngineeringEntity,'category'|'standardClass'>){
  const definition=codes.get(entity.category),specific=entity.standardClass?.id?indexed.get(entity.standardClass.id):undefined;
  const compatible=specific&&(specific.category===entity.category||specific.category.startsWith(entity.category+'.')||entity.category.startsWith(specific.category+'.')
    ||specific.category==='E-T'&&['E01','E03'].includes(entity.category)||specific.category==='E-R'&&['E02','E11'].includes(entity.category));
  let item=!entity.category.startsWith('U')&&compatible?specific:undefined;
  if(!item&&definition&&'catalogId' in definition)item=indexed.get(definition.catalogId!);
  const matches=byCode.get(entity.category)??[];
  if(!item&&matches.length===1)item=matches[0];
  if(item)return {kind:item.kind,group:item.catalogGroup,category:item.catalogCategory,label:item.label,id:item.id,order:item.order};
  const same=matches.length>0&&matches.every(row=>row.kind===matches[0].kind&&row.catalogCategory===matches[0].catalogCategory);
  if(same)return{kind:matches[0].kind,group:matches[0].catalogGroup,category:matches[0].catalogCategory,label:'类型待确认',id:entity.category,order:matches[0].order};
  if(definition&&'catalogFamily' in definition){const family=definition.catalogFamily!;return{kind:family.kind,group:family.kind==='equipment'?'设备':family.kind==='material'?'材料':'构件',category:family.label,label:'类型待确认',id:entity.category,order:999};}
  const kind=definition?.group==='equipment'?'equipment':definition?.group==='materials'?'material':definition?.group==='components'?'construction':'unknown';
  return {kind,group:kind==='equipment'?'设备':kind==='material'?'材料':kind==='construction'?'构件':'其他',category:'类别待确认',label:'类型待确认',id:entity.category,order:999};
}
export const catalogPathLabel=(entity:Pick<EngineeringEntity,'category'|'standardClass'>)=>{const row=catalogLocation(entity);return `${row.category} / ${row.label}`;};

export function componentDefinition(meaning:{componentType?:{id?:string};standardClass?:{term:string}}){return componentById.get(meaning.componentType?.id??'')??componentByTerm.get(meaning.standardClass?.term.toLowerCase()??'');}
