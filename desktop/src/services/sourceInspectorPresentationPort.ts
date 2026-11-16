import type {SourceDocument} from '../gim/sourceDocument.js';
import type {SourceReference} from '../gim/engineering/sourceGraph.js';
import type {EngineeringSources} from '../gim/engineering/buildSources.js';
interface Choice {label:string;choose():void}
export interface SourceInspectorPresentation {
  error(path:string,error:string,current:()=>boolean):Promise<void>;
  document(input:{path:string;doc?:SourceDocument;isIfc:boolean;rows:[string,string][];references:SourceReference[];candidates:Choice[];candidateCount?:number;current:()=>boolean;onDocument:(path:string)=>void}):Promise<void>;
  context(input:{node:EngineeringSources['spatialNodes'][number];parentName?:string;childCount:number;members:Choice[];memberCount?:number;current:()=>boolean;onDocument:()=>void}):Promise<void>;
}
let port:SourceInspectorPresentation;
export function bindSourceInspectorPresentation(value:SourceInspectorPresentation):void {port=value;}
export function sourceInspectorPresentation():SourceInspectorPresentation {if(!port)throw Error('Source inspector presentation missing');return port;}
