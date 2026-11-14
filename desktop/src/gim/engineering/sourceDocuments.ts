import type {SourceProperty} from './sourceEvidence.js';

export interface SourceDocument {
  attributeStatus?:'complete'|'partial';
  path:string;
  rawLines:string[];
  fields:Array<SourceProperty&{keys:readonly string[];path:string}>;
}
/** Parse source spelling once. No standard vocabulary, identities or FAM interpretation. */
export function parseSourceDocument(path:string,text:string):SourceDocument {
  const rawLines=text.split(/\r?\n/);
  const fields=rawLines.flatMap((rawLine,index)=>{
    const line=rawLine.replace(/^\uFEFF/,'').trim(),at=line.indexOf('=');
    return at>0?[{path,line:index+1,keys:[line.slice(0,at).trim()],value:line.slice(at+1).trim(),rawLine}]:[];
  });
  return {path,rawLines,fields};
}
export class SourceDocuments {
  private cache=new Map<string,Promise<SourceDocument>>();
  constructor(private readText:(path:string)=>Promise<string>){}
  read(path:string):Promise<SourceDocument>{
    let value=this.cache.get(path);
    if(!value){value=this.readText(path).then(text=>parseSourceDocument(path,text));this.cache.set(path,value);}
    return value;
  }
  clear():void{this.cache.clear();}
}
