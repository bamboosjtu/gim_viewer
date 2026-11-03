import { isTauri } from '@desktop/runtime.js';
import { downloadTextFile } from '../shared/csv.js';

export async function saveTreeExport(filename:string,content:string):Promise<string|null>{
  if(isTauri()){const {saveEngineeringTreeJson}=await import('@desktop/treeExport.js');return saveEngineeringTreeJson(filename,content);}
  downloadTextFile(filename,content,'application/json;charset=utf-8');return filename;
}
