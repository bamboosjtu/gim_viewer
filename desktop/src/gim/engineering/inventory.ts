import type { EngineeringSnapshot } from '../../engineering/types.js';
import { categoryLabel } from '../../engineering/catalogLabels.js';
import type { SourceRecord } from './sourceEvidence.js';
import { sourceRecordTitle } from './sourceTitles.js';
export interface InventoryNode {
  key:string;title:string;kind:'project'|'group'|'entity'|'pending'|'record';parent?:string;children:string[];
  targetId?:string;sourceId?:string;entityCount:number;evidence:string[];category?:string;sourceCount?:number;
  documentPath?:string;sourceType?:string;
  declaredContextIds?:string[];
}
export interface EngineeringInventory {rootKey:string;nodes:Map<string,InventoryNode>;rowsByEntity:Map<string,string[]>;rowsBySource:Map<string,string>}
export function projectEngineeringInventory(snapshot:EngineeringSnapshot,records:readonly SourceRecord[]):EngineeringInventory {
  const rootKey='inventory:root',nodes=new Map<string,InventoryNode>(),rowsByEntity=new Map<string,string[]>(),rowsBySource=new Map<string,string>();
  nodes.set(rootKey,{key:rootKey,title:'设备材料清册',kind:'project',children:[],entityCount:0,evidence:[]});
  const add=(node:InventoryNode)=>{nodes.set(node.key,node);if(node.parent)nodes.get(node.parent)!.children.push(node.key);};
  const group=(parent:string,id:string,title:string)=>{const key=`${parent}/${id}`;if(!nodes.has(key))add({key,title,parent,kind:'group',children:[],entityCount:0,evidence:[]});return key;};
  const bySource=new Map(records.map(record=>[record.id,record])),ownerBySource=new Map(snapshot.memberships.map(m=>[m.sourceId,m.ownerId]));
  for(const title of ['设备','装置性材料','构件'])group(rootKey,title,title);
  for(const entity of snapshot.entities){
    const kind=entity.category.startsWith('E')?'设备':entity.category.startsWith('M')?'装置性材料':entity.category.startsWith('C')?'构件':'待识别';
    const parent=group(group(rootKey,kind,kind),`category:${entity.category}`,categoryLabel(entity.category)),key=`inventory:entity:${entity.id}`;
    add({key,parent,title:entity.name,kind:'entity',targetId:entity.id,category:entity.category,sourceCount:entity.sourceIds.length,entityCount:1,evidence:[entity.boundaryEvidence],children:[]});rowsByEntity.set(entity.id,[key]);
    for(let cursor:string|undefined=parent;cursor;cursor=nodes.get(cursor)?.parent)nodes.get(cursor)!.entityCount++;
  }
  for(const pending of snapshot.pending){const parent=group(rootKey,'pending','待归整体'),key=`inventory:entity:${pending.id}`;
    add({key,parent,title:`待归整体集合 · ${pending.sourceIds.length} 个来源`,kind:'pending',targetId:pending.id,sourceCount:pending.sourceIds.length,entityCount:0,evidence:[pending.reason],children:[]});rowsByEntity.set(pending.id,[key]);}
  const memberKeys=new Map<string,string>();
  for(const membership of snapshot.memberships){if(!membership.ownerId)continue;const source=bySource.get(membership.sourceId);if(!source)continue;memberKeys.set(source.id,`inventory:source:${source.id}`);}
  for(const [id,key]of memberKeys){const source=bySource.get(id)!,owner=ownerBySource.get(id)!;
    const parent=source.parent&&ownerBySource.get(source.parent)===owner&&memberKeys.has(source.parent)?memberKeys.get(source.parent)!:`inventory:entity:${owner}`;
    nodes.set(key,{key,parent,title:`${sourceRecordTitle(source)} [${source.track==='dev'?'DEV':'IFC'}轨道]`,kind:'record',sourceId:id,documentPath:source.track==='ifc'?source.sources[0]:source.source,sourceType:source.source_type,entityCount:0,evidence:[],children:[]});rowsBySource.set(id,key);
  }
  for(const key of memberKeys.values()){const node=nodes.get(key)!;nodes.get(node.parent!)!.children.push(key);}
  for(const node of nodes.values())if(node.key!==rootKey&&node.kind==='group')node.children.sort((a,b)=>{
    const left=nodes.get(a)!,right=nodes.get(b)!;
    if(a.includes('/category:')&&b.includes('/category:'))return a.localeCompare(b,'en',{numeric:true});
    return left.title.localeCompare(right.title,'zh-CN',{numeric:true})||a.localeCompare(b);
  });
  return {rootKey,nodes,rowsByEntity,rowsBySource};
}
