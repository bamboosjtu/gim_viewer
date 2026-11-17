import type { SourceRecord } from './sourceEvidence.js';
import type { SourceDocument } from './sourceGraph.js';
const meaningful=(value:string)=>!!value.trim()&&!/^(?:NULL\d*|无|--?|其他|其它|软件自动生成|&.*)$/i.test(value.trim());
export function sourceRecordTitle(record:SourceRecord):string {
  if(!record.parent){const name=record.properties.find(p=>p.keys?.some(k=>/^(?:工程中名称|PROJECTNAME)$/i.test(k))&&meaningful(p.value))?.value;if(name)return name;}
  return record.name||record.source_type||'未命名来源';
}
export function sourceDocumentTitle(doc:SourceDocument|undefined,fallback:string):string {
  const fields=doc?.fields??[];
  const own=fields.filter(field=>/^(?:NAME|PARTNAME|PROJECTNAME)$/i.test(field.keys[0])&&meaningful(field.value)).map(field=>field.value)[0];
  if(own)return own;
  const systems=fields.filter(field=>/^SYSTEMNAME\d+$/i.test(field.keys[0])&&meaningful(field.value));
  if(systems.length)return systems[systems.length-1].value;
  const stem=fallback.split(/[\\/]/).pop()!.replace(/\.[^.]+$/,'');
  return /^[0-9a-f-]{32,36}$/i.test(stem)?`未命名来源（${stem.slice(0,8)}）`:stem==='project'?'工程入口':stem;
}
