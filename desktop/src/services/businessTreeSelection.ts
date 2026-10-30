import type { AppState } from '../app/state.js';
import type { BusinessTreeProjection } from '../gim/businessTree.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import { escHtml } from '../shared/html.js';

/** Member identities drive group operations; no fake CBM nodes or DOM traversal. */
export async function selectBusinessTree(state:AppState,p:BusinessTreeProjection,key:string):Promise<void> {
  if(state.businessTree!==p||p.sourceGeneration!=null&&p.sourceGeneration!==state.projectGeneration)return;
  const request=state.beginSelection({kind:'business',key}),guard=state.selectionGuard(request);
  const objects=(p.members.get(key)??(p.objects.has(key)?[key]:[])).map(k=>p.objects.get(k)!);
  const title=p.objects.get(key)?.name??p.units.get(key)?.title??p.regions.get(key)?.title??({'business:root':state.projectName,'business:installation':'安装工程','business:construction':'建筑工程','business:unknown':'待分类'}[key]||'业务对象');
  const roots=new Set<string>(),refs=new Map<string,Set<string>>();
  const add=(model:string,guid:string)=>{const set=refs.get(model)??new Set();set.add(guid);refs.set(model,set);};
  for(const object of objects){
    for(const ref of object.ifcRefs??[])if(ref.globalId)add(ref.modelId,ref.globalId);
    for(const path of object.cbmPaths){const node=p.cbmByPath.get(path);if(!node)continue;
      if(node.devPath&&!/^(PARTINDEX|DEV_SUBDEVICE)$/i.test(node.entityName))roots.add(path);
      if(node.ifcFile&&node.ifcGuid){const model=resolveIfcModelId(node.ifcFile,state.currentIfcEntries);if(model)add(model,node.ifcGuid);}
    }
    for(const k of object.ifcKeys){const source=state.substationSpatialIndex?.objectByKey.get(k);if(source?.globalId)add(source.modelId,source.globalId);}
  }
  state.businessSelectionRoots=roots;
  state.deviceLodRuntime?.setOnlySelected?.(state.onlySelected);
  const selected=p.objects.get(key);
  const assignmentRows=selected?[
    ['归属状态',{confirmed:'明确',inferred:'推断',shared:'共享',unresolved:'待确认'}[selected.assignment.status]],
    ['归属依据',selected.assignment.reason],
    ['业务区域',p.regions.get(p.units.get(selected.assignment.unitKey)!.regionKey)?.title??''],
    ['所属单元',p.units.get(selected.assignment.unitKey)?.kind==='unresolved'?'未确定':p.units.get(selected.assignment.unitKey)?.title??''],
    ['来源证据',selected.assignment.evidence.join(' / ')],
    ...selected.assignment.candidates?.map(c=>[`候选平面距离：${p.units.get(c.unitKey)?.title??c.unitKey}`,`${c.distance.toFixed(3)} m`])??[],
    ...selected.assignment.relatedUnitKeys?.map(k=>['关联单元',p.units.get(k)?.title??k])??[],
  ] as [string,string][]:[];
  if(selected?.cbmPaths.length&&!selected.ifcRefs?.length&&!selected.ifcKeys.length){
    const node=p.cbmByPath.get(selected.cbmPaths[0]);
    if(node){
      const {handleNodeClick}=await import('./nodeInteractionService.js');
      if(!guard.isCurrent())return;
      await handleNodeClick(state,node,()=>{},request);
      if(guard.isCurrent()){
        const {sectionHtml}=await import('../ui/propsDrawer.js');
        document.querySelector('[data-itab-pane="relations"]')?.insertAdjacentHTML('afterbegin',sectionHtml('业务归属',assignmentRows));
      }
      return;
    }
  }
  const {renderInspectorTabs,sectionHtml,openPropsDrawerUI}=await import('../ui/propsDrawer.js');
  if(!guard.isCurrent())return;
  openPropsDrawerUI();
  const rows: [string,string][]=[['对象数',String(objects.length)],['设备实例',String(roots.size)],['IFC 对象引用',String([...refs.values()].reduce((n,s)=>n+s.size,0))]];
  for(const status of ['confirmed','inferred','shared','unresolved'] as const)rows.push([{confirmed:'明确',inferred:'推断',shared:'共享',unresolved:'待确认'}[status],String(objects.filter(o=>o.assignment.status===status).length)]);
  renderInspectorTabs(`<div class="props-header">${escHtml(title)}</div>`,{
    overview:sectionHtml('业务归属',rows)+`<div class="props-actions"><button class="prop-ref-link" id="business-fit">定位</button><button class="prop-ref-link" id="business-isolate">仅显示此组</button><button class="prop-ref-link" id="business-restore">恢复显示</button></div>`,
    params:selected?sectionHtml('归属依据',[['状态',selected.assignment.status],['原因',selected.assignment.reason],['原始上下文',selected.context.join(' / ')],...(selected.assignment.candidates??[]).map(c=>[p.units.get(c.unitKey)?.title??c.unitKey,`${c.distance.toFixed(2)} m`] as [string,string])]):sectionHtml('说明',[['成员','操作基于来源身份集合；不触发精细模型计算']]),
    relations:sectionHtml('业务单元',[['区域',p.regions.get(p.units.get(selected?.assignment.unitKey??key)?.regionKey??key)?.title??title]]),
    source:selected?sectionHtml('来源',[['CBM/DEV',selected.cbmPaths.join('\n')],['IFC',selected.ifcKeys.join('\n')]]):sectionHtml('来源',[['规则',p.version]]),
  });
  let inspector:Promise<unknown>|undefined;
  const source=selected?.ifcKeys.length?state.substationSpatialIndex?.objectByKey.get(selected.ifcKeys[0]):undefined;
  const cbmNode=selected?.cbmPaths.length?p.cbmByPath.get(selected.cbmPaths[0]):undefined;
  if(cbmNode){const {showNodePropertiesBasic}=await import('../ui/propsDrawer.js');inspector=showNodePropertiesBasic(state,cbmNode,request);}
  else if(source&&state.substationSpatialIndex){const {showIfcSpatialObjectPropertiesBasic}=await import('../ui/propsDrawer.js');inspector=showIfcSpatialObjectPropertiesBasic(state,source,state.substationSpatialIndex,request);}
  if(!state.initialized){await inspector;return;}
  const [{getViewerRuntimeWithUI},THREE,{commitSelectionHighlight,highlightModGroups,HIGHLIGHT_STYLE},{frameBox}]=await Promise.all([
    import('./viewerUIBinding.js'),import('three'),import('../viewer/highlight.js'),import('../viewer/camera.js')]);
  const {ctx}=await getViewerRuntimeWithUI(state,()=>{});if(!guard.isCurrent())return;
  const groups=[...state.loadedXmlModGroups.values(),...state.loadedStlGroups.values()].filter(g=>roots.has(g.userData.rootOccurrence));
  const regional:Array<{runtime:import('../viewer/ifcRegionalRuntime.js').IfcRegionalRuntime;id:number;box?:import('three').Box3}>=[];
  for(const [model,guids]of refs){const runtime=state.ifcRegionalRuntimes.get(model);if(runtime)for(const object of runtime.index.objects)if(guids.has(object.globalId))regional.push({runtime,id:object.expressId,box:runtime.worldBounds?.(object)});}
  const items:Record<string,number[]>={},boxes:import('three').Box3[]=[];
  for(const {box}of regional)if(box&&!box.isEmpty())boxes.push(box);
  for(const [model,guids]of refs){
    const runtimeId=state.getRuntimeModelId(model),loaded=ctx.fragments.list.get(runtimeId);
    if(!loaded)continue;
    const ids=(await loaded.getLocalIdsByGuids([...guids])).filter((n):n is number=>n!==null);
    if(!guard.isCurrent())return;
    if(ids.length){items[runtimeId]=ids;if(!regional.some(r=>r.runtime===state.ifcRegionalRuntimes.get(model)&&r.box&&!r.box.isEmpty())){const box=await loaded.getMergedBox(ids);if(box&&!box.isEmpty())boxes.push(box);}}
  }
  if(!guard.isCurrent())return;
  await commitSelectionHighlight(ctx,state,guard,async()=>{
    for(const {runtime,id}of regional){const group=runtime.highlightGroup(id,true);if(group)groups.push(group);}
    highlightModGroups(state,groups);
    if(Object.keys(items).length){await ctx.fragments.highlight(HIGHLIGHT_STYLE,items as any);if(guard.isSessionCurrent())state.highlightedItems=items;}
  });
  if(!guard.isCurrent())return;
  let localNear=false;
  const fit=async(whole=false)=>{const box=new THREE.Box3();for(const group of groups){let visible=true;for(let n:import('three').Object3D|null=group;n;n=n.parent)if(!n.visible)visible=false;if(visible)box.expandByObject(group);}boxes.forEach(b=>box.union(b));
    if(selected&&!whole&&!box.isEmpty()){
      const widths=box.getSize(new THREE.Vector3()).toArray(),ordered=[...widths].sort((a,b)=>b-a);
      if(ordered[0]>30&&ordered[0]>10*Math.max(ordered[1],.01)){
        const centre=box.getCenter(new THREE.Vector3()),axis=widths.indexOf(ordered[0]);
        box.min.setComponent(axis,Math.max(box.min.getComponent(axis),centre.getComponent(axis)-6));box.max.setComponent(axis,Math.min(box.max.getComponent(axis),centre.getComponent(axis)+6));localNear=true;
      }
    }
    if(!box.isEmpty()&&guard.isCurrent())await frameBox(ctx,box,guard);};
  await fit();
  await inspector;
  if(!guard.isCurrent())return;
  if(source)document.querySelector('[data-itab-pane="overview"]')?.insertAdjacentHTML('beforeend',sectionHtml('业务归属',rows)+`<div class="props-actions"><button class="prop-ref-link" id="business-fit">定位</button><button class="prop-ref-link" id="business-isolate">仅显示此组</button><button class="prop-ref-link" id="business-restore">恢复显示</button></div>`);
  if(selected)document.querySelector('[data-itab-pane="relations"]')?.insertAdjacentHTML('afterbegin',sectionHtml('业务归属',assignmentRows));
  const fitButton=document.getElementById('business-fit');if(localNear&&fitButton){fitButton.textContent='定位整件';fitButton.insertAdjacentHTML('beforebegin','<span class="props-note">长构件当前显示局部近景。</span>');}
  fitButton?.addEventListener('click',()=>void fit(true));
  document.getElementById('business-isolate')?.addEventListener('click',()=>{if(!guard.isCurrent())return;state.onlySelected=true;state.deviceLodRuntime?.setOnlySelected?.(true);void state.selectionVisibility?.sync(guard);});
  document.getElementById('business-restore')?.addEventListener('click',()=>{if(!guard.isCurrent())return;state.onlySelected=false;state.deviceLodRuntime?.setOnlySelected?.(false);void state.selectionVisibility?.sync(guard);});
}
