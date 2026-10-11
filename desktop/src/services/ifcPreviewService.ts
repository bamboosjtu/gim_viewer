import type { AppState, ProjectLoadSession, SelectionRequest } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { IfcGeometryProvider, IfcPreviewObject } from '../viewer/ifcGeometryProvider.js';
import { commitSelectionHighlight, HIGHLIGHT_STYLE } from '../viewer/highlight.js';
import { showIfcElementProperties, showIfcPreviewProperties } from '../ui/propsDrawer.js';
import { setSelectionStatus } from '../ui/shell/statusBar.js';

/** Same IFC identity and request survive representation promotion. No synthetic CBM node. */
export async function promoteIfcPreviewSelection(ctx:ViewerContext,state:AppState,provider:IfcGeometryProvider,
  request:SelectionRequest,object:IfcPreviewObject):Promise<void> {
  if(!state.isCurrentSelection(request))return;
  const runtimeId=state.ifcRuntimeModelIds.get(object.modelId);
  const model=runtimeId ? ctx.fragments.list.get(runtimeId) : undefined;
  if(!model || !object.globalId)return;
  const candidates=provider.findByGlobalId(object.globalId);
  if(candidates.length!==1){
    state.selectionGeometry={status:'ambiguous',detail:`GlobalId 有 ${candidates.length} 个预览候选，保留原 ExpressId，未推断精细对象`};
    setSelectionStatus(state.selectionGeometry.detail);return;
  }
  const ids=await model.getLocalIdsByGuids([object.globalId]);
  if(!state.isCurrentSelection(request))return;
  const localId=ids[0];
  if(localId==null){state.selectionGeometry={status:'unlinked',detail:'精细模型无对应 GlobalId；保留语义选择'};setSelectionStatus(state.selectionGeometry.detail);return;}
  state.selectionGeometry={status:'available',detail:'已建立原 IFC 对象的 LOD2 关联；沿用当前选择身份'};
  // Keep request.target as the original file/ExpressId key; LocalId is only a render handle.
  await commitSelectionHighlight(ctx,state,state.selectionGuard(request),async()=>{
    const items={[runtimeId!]:new Set([localId])};
    await ctx.fragments.highlight(HIGHLIGHT_STYLE,items as any);
    if(state.isCurrentSession(request.session))state.highlightedItems=items as any;
  });
  if(!state.isCurrentSelection(request))return;
  await showIfcElementProperties(ctx,state,runtimeId!,localId,request);
}

export async function selectIfcPreview(ctx:ViewerContext,state:AppState,provider:IfcGeometryProvider,
  object:IfcPreviewObject,request:SelectionRequest):Promise<void> {
  if(!state.isCurrentSelection(request))return;
  state.selectionGeometry={status:'partial',detail:`LOD${provider.objectLOD(object)} 预览；保留原 IFC 身份，裁剪/精细细节待 LOD2`};
  const refine=async()=>{
    if(!state.isCurrentSelection(request))return;
    setSelectionStatus('正在加载原 IFC 精细几何（LOD2）…');
    try {await provider.loadLOD(2);await promoteIfcPreviewSelection(ctx,state,provider,request,object);}
    catch(error){if(state.isCurrentSelection(request)){state.selectionGeometry={status:'failed',detail:`LOD2 加载失败；保留预览：${error instanceof Error?error.message:String(error)}`};setSelectionStatus(state.selectionGeometry.detail);}}
  };
  await showIfcPreviewProperties(ctx,state,provider,object,request,refine);
}

/** Automatic complete loading and the inspector's refine action share this provider. */
export async function finishIfcPreview(ctx:ViewerContext,state:AppState,provider:IfcGeometryProvider,session:ProjectLoadSession):Promise<void> {
  if(!state.isCurrentSession(session))return;
  const request=state.selectionRequest;
  const object=request?.target?.kind==='ifc-object' ? provider.data?.shapes.find(s=>s.object.key===request.target!.key)?.object : undefined;
  provider.retire();
  if(request && object)await promoteIfcPreviewSelection(ctx,state,provider,request,object);
}
