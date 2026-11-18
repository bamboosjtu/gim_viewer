import catalog from './standardCatalog.json';
import policy from './recognitionPolicy.json';
export const STANDARD_CATALOG_VERSION=catalog.version;
/** The catalog supplies facts; the product policy supplies private semantic roles. */
export const STANDARD_CATALOG=catalog.items.map(item=>({...item,recognitionCode:(policy.catalogRoles as Record<string,string>)[item.id]??(policy.terms as Record<string,string>)[item.term.toLowerCase()]}));
const normalize=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
type Item=typeof STANDARD_CATALOG[number];
const terms=new Map<string,Item[]>();
const byId = new Map(STANDARD_CATALOG.map(item => [item.id,item]));
export const standardCatalogItem=(id:string)=>byId.get(id);
const contextualTerms:Readonly<Record<string,string>> = policy.contextualTerms;
for(const item of STANDARD_CATALOG)for(const name of [item.label,...item.label.split('/'),item.term,...item.term.split('/'),...item.aliases]){
  const key=normalize(name),rows=terms.get(key)??[];if(!rows.some(row=>row.id===item.id))rows.push(item);terms.set(key,rows);
}
/** Exact aliases can be ambiguous (e.g. two distinct shielding devices). */
export function standardTerms(value:string):readonly Item[]{
  const key=normalize(value);
  const contextual=byId.get(contextualTerms[key]);
  const found=contextual?[contextual]:(terms.get(value.toLowerCase())??terms.get(key)??[]);
  const preferred=(policy.standardTermDefaults as Record<string,string>)[normalize(value)];
  return preferred?found.filter(item=>item.id===preferred):found;
}
const chinese=[...new Set(STANDARD_CATALOG.flatMap(row=>[row.label,...row.label.split('/'),...row.aliases]).filter(label=>/[\u3400-\u9fff]/.test(label)&&label.length>=2))];
const byLength=chinese.sort((a,b)=>b.length-a.length||a.localeCompare(b));
const expression=new RegExp(byLength.map(label=>label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
/** Names provide candidates only. Structured source declarations stay authoritative. */
export function standardTermsFromName(name:string):readonly Item[]{
  const exact=standardTerms(name);if(exact.length)return exact;
  expression.lastIndex=0;const hits=[...name.matchAll(expression)];if(!hits.length)return [];
  const longest=Math.max(...hits.map(hit=>hit[0].length));
  return [...new Map(hits.filter(hit=>hit[0].length===longest).flatMap(hit=>standardTerms(hit[0])).map(row=>[row.id,row])).values()];
}
export function standardEquipmentId(item:Item):string{
  return ({oilimmersedtransformer:'oil_immersed_transformer',gis:'gis',hgis:'hgis',acporcelaincircuitbreaker:'ac_porcelain_circuit_breaker'} as Record<string,string>)[item.term.toLowerCase()]
    ??item.term.replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[^a-z0-9]+/gi,'_').toLowerCase();
}
