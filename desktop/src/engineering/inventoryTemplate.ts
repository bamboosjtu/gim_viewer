import type { EngineeringSnapshot } from './types.js';
import { categoryDefinition, categoryLabel, ENGINEERING_CATEGORIES } from './catalogLabels.js';
const compareTitles=new Intl.Collator('zh-CN',{numeric:true}).compare;

export const INVENTORY_TEMPLATE_VERSION='engineering-inventory-v1';
export const INVENTORY_TEMPLATE=Object.freeze({version:INVENTORY_TEMPLATE_VERSION,groups:Object.freeze(['设备','装置性材料','构件','其他']),levels:Object.freeze(['group','category','subtype','template','entity','source'])});
export interface InventorySource {id:string;parent:string;title:string;documentPath:string;sourceType:string}
export interface InventoryNode {
  key:string;title:string;kind:'project'|'group'|'template'|'entity'|'pending'|'record';parent?:string;children:string[];
  targetId?:string;sourceId?:string;entityCount:number;evidence:string[];category?:string;sourceCount?:number;
  confirmedCount?:number;documentPath?:string;sourceType?:string;
  subtype?:string;subtypeLabel?:string;template?:string;classificationStatus?:string;boundaryStatus?:string;unknownReason?:string;grain?:string;
  attachmentCount?:number;
}
export interface EngineeringInventory {version:string;rootKey:string;nodes:Map<string,InventoryNode>;rowsByEntity:Map<string,string[]>;rowsBySource:Map<string,string>}

/** gim_element-style name template: dimensions, voltage and instance numbers
 * never split one catalog type into many rows. The real instance name remains
 * on the selectable entity row. */
export function inventoryNameTemplate(name:string):string {
  const text=name.normalize('NFKC')
    .replace(/&(?:nbsp|#(?:x0*a0|0*160));/gi,' ')
    .replace(/\d+(?:\.\d+)?\s*(?:kv|千伏|mm|cm|毫米)/gi,'')
    .replace(/\d+(?:\.\d+)?(?:[x×*]\d+(?:\.\d+)?)+/gi,'')
    .replace(/\d+/g,'')
    .replace(/^[#号第]+/,'')
    .replace(/[_\-—.。、,，:：/\\()（）\s]+/g,'');
  return text||name.trim()||'未命名';
}

/** A catalog view of existing wholes. Grouping never normalizes identities or
 * turns a member into an entity; every real instance keeps its own selectable row. */
export function projectInventoryTemplate(snapshot:EngineeringSnapshot,records:readonly InventorySource[]):EngineeringInventory {
  const categoryOrder=new Map(ENGINEERING_CATEGORIES.map((category,index)=>[category.code,index]));
  const rootKey='inventory:root',nodes=new Map<string,InventoryNode>(),rowsByEntity=new Map<string,string[]>(),rowsBySource=new Map<string,string>();
  nodes.set(rootKey,{key:rootKey,title:'设备材料清册',kind:'project',children:[],entityCount:0,confirmedCount:0,evidence:[]});
  const add=(node:InventoryNode)=>{nodes.set(node.key,node);if(node.parent)nodes.get(node.parent)!.children.push(node.key);};
  const group=(parent:string,id:string,title:string)=>{const key=`${parent}/${id}`;if(!nodes.has(key))add({key,title,parent,kind:'group',children:[],entityCount:0,confirmedCount:0,evidence:[]});return key;};
  const bySource=new Map(records.map(r=>[r.id,r])),owners=new Map(snapshot.memberships.map(m=>[m.sourceId,m.ownerId]));
  const interpretations=new Map(snapshot.memberships.map(m=>[m.sourceId,m.interpretation]));
  for(const title of INVENTORY_TEMPLATE.groups)group(rootKey,title,title);
  const equipmentCategory=(code:string)=>{const key=group(`${rootKey}/设备`,`category:${code}`,categoryLabel(code));nodes.get(key)!.category=code;return key;};
  for(const entity of snapshot.entities){
    const definition=categoryDefinition(entity.category),base=definition&&'parent' in definition?definition.parent:entity.category;
    const kind=entity.category.startsWith('E')?'设备':entity.category.startsWith('M')?'装置性材料':entity.category.startsWith('C')?'构件':'其他';
    let parent=group(rootKey,kind,kind);
    if(kind==='构件')parent=group(parent,`family:${entity.category.slice(0,3)}`,({'C-A':'建筑本体构件','C-B':'结构构架与基础','C-C':'水工与总图构件','C-D':'建筑设备与设施'} as Record<string,string>)[entity.category.slice(0,3)]??'其他构件');
    parent=group(parent,`category:${base}`,categoryLabel(base!));
    nodes.get(parent)!.category=base;
    if(entity.category==='E01')parent=group(parent,'role:body','（本体）');
    if(entity.subtype&&!(entity.category==='E16'&&entity.subtype==='unresolved'))parent=group(parent,`subtype:${encodeURIComponent(entity.subtype)}`,entity.subtypeLabel??entity.subtype);
    const template=inventoryNameTemplate(entity.name||categoryLabel(entity.category));
    parent=group(parent,`template:${encodeURIComponent(template)}`,template);
    nodes.get(parent)!.kind='template';nodes.get(parent)!.template=template;
    const key=`inventory:entity:${entity.id}`,confirmed=entity.classificationStatus==='confirmed'&&entity.boundaryStatus==='confirmed'?1:0;
    add({key,parent,title:entity.name||categoryLabel(entity.category),kind:'entity',targetId:entity.id,category:entity.category,sourceCount:entity.sourceIds.length,entityCount:1,confirmedCount:confirmed,evidence:[entity.boundaryEvidence],children:[],
      subtype:entity.subtype,subtypeLabel:entity.subtypeLabel,classificationStatus:entity.classificationStatus,boundaryStatus:entity.boundaryStatus,unknownReason:entity.unknownReason,grain:entity.grain});rowsByEntity.set(entity.id,[key]);
    for(let cursor:string|undefined=parent;cursor;cursor=nodes.get(cursor)?.parent){nodes.get(cursor)!.entityCount++;nodes.get(cursor)!.confirmedCount!+=confirmed;}
  }
  for(const pending of snapshot.pending){
    const neutral=pending.reason==='neutral_set_main_unresolved'&&pending.sourceIds.some(id=>interpretations.get(id)?.meaning==='neutral_set');
    const parent=neutral?group(group(equipmentCategory('E01'),'role:attachment','附件（并入本体）'),'subtype:neutral_set','中性点成套装置')
      :group(`${rootKey}/其他`,'pending','待归整体');
    const template=inventoryNameTemplate(neutral?'中性点成套装置':'待归整体');
    const templateParent=group(parent,`template:${encodeURIComponent(template)}`,template);
    nodes.get(templateParent)!.kind='template';nodes.get(templateParent)!.template=template;
    const key=`inventory:entity:${pending.id}`;
    add({key,parent:templateParent,title:neutral?`中性点成套装置（宿主待确认） · ${pending.sourceIds.length} 个来源`:`待归整体集合 · ${pending.sourceIds.length} 个来源`,kind:'pending',targetId:pending.id,sourceCount:pending.sourceIds.length,entityCount:0,evidence:[pending.reason],children:[],
      ...(neutral?{category:'E01',subtype:'neutral_set',subtypeLabel:'中性点成套装置',boundaryStatus:'unresolved'}:{})});rowsByEntity.set(pending.id,[key]);
  }
  const memberKeys=new Map(records.map(r=>[r.id,`inventory:source:${r.id}`]));
  for(const [id,key]of memberKeys){
    const source=bySource.get(id)!,owner=owners.get(id);
    const interpretation=interpretations.get(id),neutral=interpretation?.meaning==='neutral_set';
    const parent=interpretation?.meaning!=='part'&&source.parent&&owners.get(source.parent)===owner&&memberKeys.has(source.parent)?memberKeys.get(source.parent)!
      :owner?`inventory:entity:${owner}`:group(`${rootKey}/其他`,'source-only','仅来源（不计整体）');
    nodes.set(key,{key,parent,title:neutral?`${source.title} · 中性点成套装置（主变附件）`:source.title,kind:'record',sourceId:id,documentPath:source.documentPath,sourceType:source.sourceType,entityCount:0,evidence:interpretation?.classificationEvidence??[],children:[],
      ...(neutral?{subtype:'neutral_set',subtypeLabel:'中性点成套装置',classificationStatus:interpretation.classificationStatus}:{})});rowsBySource.set(id,key);
  }
  for(const key of memberKeys.values()){const node=nodes.get(key)!;nodes.get(node.parent!)!.children.push(key);}
  for(const member of snapshot.memberships)if(member.interpretation.meaning==='neutral_set'){
    for(let cursor=nodes.get(rowsBySource.get(member.sourceId)!)?.parent;cursor;cursor=nodes.get(cursor)?.parent){const node=nodes.get(cursor)!;node.attachmentCount=(node.attachmentCount??0)+1;}
  }
  for(const node of nodes.values())if(node.key!==rootKey&&node.kind==='group')node.children.sort((a,b)=>{
    const left=nodes.get(a)!,right=nodes.get(b)!;
    if(left.kind==='group'&&right.kind==='group'&&left.category&&right.category)return (categoryOrder.get(left.category)??999)-(categoryOrder.get(right.category)??999);
    return compareTitles(left.title,right.title)||a.localeCompare(b);
  });
  return {version:INVENTORY_TEMPLATE_VERSION,rootKey,nodes,rowsByEntity,rowsBySource};
}
