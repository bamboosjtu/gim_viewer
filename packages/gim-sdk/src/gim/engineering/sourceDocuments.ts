import {parseSourceDocument, type SourceDocument} from '../sourceDocument.js';
export {parseSourceDocument, type SourceDocument} from '../sourceDocument.js';
export class SourceDocuments {
  private cache=new Map<string,Promise<SourceDocument>>();
  constructor(private readText:(path:string)=>Promise<string>){}
  has(path:string):boolean{return this.cache.has(path);}
  read(path:string):Promise<SourceDocument>{
    let value=this.cache.get(path);
    if(!value){value=this.readText(path).then(text=>parseSourceDocument(path,text));this.cache.set(path,value);}
    return value;
  }
  clear():void{this.cache.clear();}
}
