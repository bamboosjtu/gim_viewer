import catalog from './catalog.json';

/** Single catalog vocabulary shared by classification and independent projections. */
export const ENGINEERING_CATALOG_VERSION = catalog.version;
export const ENGINEERING_CATEGORIES = catalog.categories;
export const ENGINEERING_CATEGORY_LABELS: Readonly<Record<string,string>> = Object.fromEntries(catalog.categories.map(c=>[c.code,c.label]));
export const categoryLabel = (code:string) => ENGINEERING_CATEGORY_LABELS[code] ?? code;
export const categoryDefinition = (code:string) => catalog.categories.find(c=>c.code===code);
export const classificationReasonLabel=(reason:string)=>({
  material_subtype_evidence_insufficient:'材料具体形式尚无足够证据',equipment_subtype_evidence_insufficient:'设备具体类型尚待确认',
  foundation_purpose_unresolved:'尚不能确定属于设备基础还是建筑物基础',transformer_purpose_unresolved:'尚不能确定主变或站用用途',
  object_category_unresolved:'当前对象缺少可确认的类别证据',conflicting_object_attributes:'当前对象的有效属性相互矛盾',
  equipment_bushing_host_unresolved:'设备本体套管的具体宿主尚待确认',
} as Record<string,string>)[reason]??'对象证据尚待核对';
