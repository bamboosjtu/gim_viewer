import type { BusinessTreeProjection, BusinessObject } from '../gim/businessTree.js';
import { compareBusinessRegions, compareBusinessUnits, compareBusinessObjects } from '../gim/businessTree.js';
import { renderFunctionalNode } from './substationFunctionalTreeView.js';
import type { SearchItem } from './searchBox.js';

const labels = {confirmed:'明确',inferred:'推断',shared:'共享',unresolved:'待确认'};
const kindLabels:Partial<Record<BusinessObject['kind'],string>>={structure:'构筑物及设施',foundation:'基础',plumbing:'给排水',lighting:'照明',fire:'消防',other:'其他对象'};
const kindLabel=(o:BusinessObject):string=>['device','component'].includes(o.kind)?'设备与附件':o.kind==='building'?(o.subtype||(/梁/.test(o.name)?'梁':/柱/.test(o.name)?'柱':/板/.test(o.name)?'板':'其他建筑构件')):(kindLabels[o.kind]??o.kind);
export function businessObjectLabel(o: BusinessObject): string { return o.name; }
export function businessSearchItems(p: BusinessTreeProjection): SearchItem[] {
  return [...[...p.regions.values()].filter(r=>!r.key.startsWith('business:unresolved:')),...[...p.units.values()].filter(u=>u.kind!=='unresolved')].map(r=>({key:r.key,title:r.title})).concat(
    [...p.objects.values()].map(o=>({key:o.key,title:businessObjectLabel(o),subtitle:[kindLabel(o),labels[o.assignment.status],...o.context,...o.cbmPaths,...o.ifcKeys].join(' · ')})));
}
export function renderBusinessTree(p: BusinessTreeProjection, host: HTMLElement, project: string, select: (key:string)=>void): void {
  const leaf=(parent:HTMLElement,o:BusinessObject)=>renderFunctionalNode(parent,o.key,businessObjectLabel(o),'◇',`${o.kind} · ${o.assignment.reason}`,false,()=>{},()=>select(o.key),false);
  const objectRows=(parent:HTMLElement,keys:string[],scope:string)=>{
    const groups=new Map<string,BusinessObject[]>();
    const objects=keys.map(k=>p.objects.get(k)!).sort(compareBusinessObjects);
    const direct=objects.filter(o=>o.kind==='device'||o.kind==='component'||o.kind==='other');
    const show=(el:HTMLElement,rows:BusinessObject[])=>{
      // renderFunctionalNode first collects logical rows in a detached host.
      // Its child renderer owns virtualization after collection; rendering a
      // virtual window here would leave that collector empty.
      rows.forEach(o=>leaf(el,o));
    };
    show(parent,direct);
    for(const o of objects)if(o.kind!=='device'&&o.kind!=='component'&&o.kind!=='other'){const kind=kindLabel(o),rows=groups.get(kind)??[];rows.push(o);groups.set(kind,rows);}
    for(const [kind,rows]of groups)if(p.units.get(scope)?.title===kind||kind==='基础'&&/基础$/.test(p.units.get(scope)?.title??''))show(parent,rows);
    else renderFunctionalNode(parent,`${scope}:group:${kind}`,kind,'□',`${rows.length} 个对象`,true,el=>show(el,rows),undefined,false,String(rows.length));
  };
  renderFunctionalNode(host,'business:root',project||'变电工程','◎',`业务对象 ${p.objects.size}`,true,root=>{
    for(const [domain,title]of [['installation','安装工程'],['construction','建筑工程'],['unknown','其他对象']]as const){
      const regions=[...p.regions.values()].filter(r=>r.domain===domain);
      if(domain==='unknown'&&!regions.length)continue;
      renderFunctionalNode(root,`business:${domain}`,title,'▦',`对象 ${p.members.get(`business:${domain}`)?.length??0}`,regions.length>0,el=>{
        for(const region of regions.sort(compareBusinessRegions)){
          const renderArea=(area:HTMLElement)=>{
            for(const unit of [...p.units.values()].filter(u=>u.regionKey===region.key).sort(compareBusinessUnits))
              if(unit.kind==='unresolved')objectRows(area,p.members.get(unit.key)??[],unit.key);
              else renderFunctionalNode(area,unit.key,unit.title,'≋',`对象 ${p.members.get(unit.key)?.length??0}`,true,items=>objectRows(items,p.members.get(unit.key)??[],unit.key),()=>select(unit.key),false,String(p.members.get(unit.key)?.length??0));
          };
          if(region.key.startsWith('business:unresolved:'))renderArea(el);
          else renderFunctionalNode(el,region.key,region.title,'▦','业务区域',true,renderArea,()=>select(region.key));
        }
      },()=>select(`business:${domain}`));
    }
  },()=>select('business:root'),true);
}

export function revealBusinessTarget(p:BusinessTreeProjection,key:string,host:HTMLElement):string {
  const objectKey=p.objectBySource.get(key)??key,o=p.objects.get(objectKey);
  const unit=o?p.units.get(o.assignment.unitKey):p.units.get(key), region=p.regions.get(unit?.regionKey??key);
  const keys=['business:root',...(region?[`business:${region.domain}`,region.key]:[]),...(unit?[unit.key]:[])];
  const find=(k:string)=>[...host.querySelectorAll<HTMLElement>('.tree-row')].find(r=>r.dataset.nodePath===k);
  for(const k of keys){const row=find(k);if(row?.getAttribute('aria-expanded')==='false')row.querySelector<HTMLButtonElement>('.tree-toggle')?.click();}
  if(o&&unit){
    const group=find(`${unit.key}:group:${kindLabel(o)}`);
    if(group?.getAttribute('aria-expanded')==='false')group.querySelector<HTMLButtonElement>('.tree-toggle')?.click();
    for(const outline of host.querySelectorAll<HTMLElement & {__gimRevealOutline?:(key:string)=>boolean}>('.functional-virtual-outline'))outline.__gimRevealOutline?.(objectKey);
  }
  return objectKey;
}
