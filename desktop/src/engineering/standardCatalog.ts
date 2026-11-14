import catalog from './standardCatalog.json';
export const STANDARD_CATALOG_VERSION=catalog.version;
export const STANDARD_CATALOG=catalog.items;
const normalize=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
type Item=typeof STANDARD_CATALOG[number];
const terms=new Map<string,Item[]>();
for(const item of STANDARD_CATALOG)for(const name of [item.label,item.term,...item.term.split('/'),...(['C.24','B.41'].includes(item.annex)?item.label.split('/'):[]),...(item.annex==='D.14'?['防火墙']:[])]){
  const key=normalize(name),rows=terms.get(key)??[];if(!rows.some(row=>row.id===item.id))rows.push(item);terms.set(key,rows);
}
/** Exact aliases can be ambiguous (e.g. two distinct shielding devices). */
export function standardTerms(value:string):readonly Item[]{return terms.get(normalize(value))??[];}
const chinese=STANDARD_CATALOG.filter(row=>/[\u3400-\u9fff]/.test(row.label)&&row.label.length>=3);
const byLength=[...chinese].sort((a,b)=>b.label.length-a.label.length||a.id.localeCompare(b.id));
const expression=new RegExp(byLength.map(row=>row.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
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
