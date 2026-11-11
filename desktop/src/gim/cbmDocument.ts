import{parseKeyValue}from'./kvParser.js';
import{readGimText}from'../shared/textDecode.js';
// File values are immutable. Materialization replaces the File value, so it
// naturally invalidates this shared discovery/tree document without key scans.
const documents=new WeakMap<File,Promise<Readonly<Record<string,string>>>>();
export function readCbmDocument(file:File,consume=false):Promise<Readonly<Record<string,string>>>{
 let pending=documents.get(file);
 if(consume)documents.delete(file);
 if(!pending){pending=readGimText(file).then(text=>Object.freeze(parseKeyValue(text)));if(!consume)documents.set(file,pending);}
 return pending;
}
