import rules from './catalogRules.json';
import { categoryLabel } from './catalogLabels.js';

const patterns = rules.subtypeRules as Record<string,string[][]>;
const subtypeRules = new Map(Object.entries(patterns).map(([code,rows])=>[code,rows.map(([id,label,pattern])=>({id,label,regex:new RegExp(pattern,'i')}))]));
export function classificationDetails(category:string,name:string):{subtype?:string;subtypeLabel?:string;unknownReason?:string} {
  if(category.startsWith('E16.'))return {subtype:category.slice(4),subtypeLabel:categoryLabel(category)};
  const found=subtypeRules.get(category)?.find(r=>r.regex.test(name));
  if(found)return {subtype:found.id,subtypeLabel:found.label};
  if(['M01','M02','M05'].includes(category))return {subtype:'body',subtypeLabel:'本体'};
  if(category.startsWith('M'))return {subtype:'unresolved',subtypeLabel:category==='M09'?'未细分材料':'本体待细分',unknownReason:'material_subtype_evidence_insufficient'};
  if(['E04','E16','E17','E19'].includes(category))return {subtype:'unresolved',subtypeLabel:'具体类型待确认',unknownReason:'equipment_subtype_evidence_insufficient'};
  if(category==='C-B4')return {unknownReason:'foundation_purpose_unresolved'};
  if(category==='E-T')return {unknownReason:'transformer_purpose_unresolved'};
  if(category==='E-R')return {unknownReason:'reactor_purpose_unresolved'};
  if(category==='U-OBJECT')return {unknownReason:'object_category_unresolved'};
  return {};
}
