import type { EngineeringSnapshot } from '../../engineering/types.js';
import { projectInventoryTemplate, type EngineeringInventory } from '../../engineering/inventoryTemplate.js';
import type { SourceRecord } from './sourceEvidence.js';
export { INVENTORY_TEMPLATE_VERSION } from '../../engineering/inventoryTemplate.js';
export type { EngineeringInventory,InventoryNode } from '../../engineering/inventoryTemplate.js';

/** Source adapter for the catalog projection; no composition paths or F levels. */
export function projectEngineeringInventory(snapshot:EngineeringSnapshot):EngineeringInventory {
  return projectInventoryTemplate(snapshot);
}
export function projectInventorySearch(view:EngineeringInventory,snapshot:EngineeringSnapshot,records:readonly SourceRecord[]) {
  const bySource=new Map(records.map(r=>[r.id,r]));
  return snapshot.entities.map(entity=>{
    const row=view.nodes.get(view.rowsByEntity.get(entity.id)![0])!,path:string[]=[];
    for(let cursor=row.parent;cursor;cursor=view.nodes.get(cursor)?.parent)path.unshift(view.nodes.get(cursor)!.title);
    const subtitle=path.join(' / '),names=entity.sourceIds.flatMap(id=>{const r=bySource.get(id);return r?[r.name,...r.properties.filter(p=>p.keys?.some(k=>/名称|编码|PROJECTNAME|CODE/i.test(k))).map(p=>p.value)]:[];});
    return {key:entity.id,title:row.title,subtitle,searchText:[row.title,subtitle,entity.id,...names].join('\n').toLowerCase()};
  });
}
