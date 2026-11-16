import{parseSourceDocument,sourceScalarProperties,type SourceDocument}from'./sourceDocument.js';
import{readGimText}from'../shared/textDecode.js';
// File values are immutable. Materialization replaces the File value, so it
// naturally invalidates this shared discovery/tree document without key scans.
const documents=new WeakMap<File,Promise<SourceDocument>>();
export function readCbmSourceDocument(file:File,path=file.name,consume=false):Promise<SourceDocument>{
 let pending=documents.get(file);
 if(consume)documents.delete(file);
 if(!pending){pending=readGimText(file).then(text=>parseSourceDocument(path,text));if(!consume)documents.set(file,pending);}
 return pending;
}
export function readCbmDocument(file:File,consume=false):Promise<Readonly<Record<string,string>>>{
 return readCbmSourceDocument(file,file.name,consume).then(doc=>Object.freeze(sourceScalarProperties(doc)));
}
