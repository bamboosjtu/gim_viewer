export interface FamPhysicalRecord {
  kind:'section'|'property'; sourceLine: number; rawLine: string; section: string; segments: string[];
}
export function parseFamPhysicalRecords(text:string):FamPhysicalRecord[] {
  let section='默认';const records:FamPhysicalRecord[]=[];
  for(const [index,rawLine] of text.split(/\r?\n/).entries()) {
    const line=rawLine.replace(/^\uFEFF/,'').trim();if(!line)continue;
    const header=line.match(/^\[(.+)\]$/);if(header){section=header[1];records.push({kind:'section',sourceLine:index+1,rawLine,section,segments:[]});continue;}
    records.push({kind:'property',sourceLine:index+1,rawLine,section,segments:line.split('=')});
  }
  return records;
}
