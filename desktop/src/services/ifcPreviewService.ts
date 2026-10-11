import type { AppState, ProjectLoadSession, SelectionRequest } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { IfcGeometryProvider, IfcPreviewObject } from '../viewer/ifcGeometryProvider.js';
import { commitSelectionHighlight, HIGHLIGHT_STYLE } from '../viewer/highlight.js';
import { showIfcElementProperties, showIfcPreviewProperties } from '../ui/propsDrawer.js';
import { setSelectionStatus } from '../ui/shell/statusBar.js';
import * as THREE from 'three';
import { previewShapeGeometry } from '../viewer/ifcPreviewProvider.js';

/** Diagnostics captured only at an explicit Preview -> Fragments promotion. */
export interface IfcPreviewReplacementDiagnostic {
  requestId: number;
  selectionTarget: unknown;
  logicalModelId: string;
  runtimeModelId: string | null;
  baseCoordinationModel: string | null;
  baseCoordinationMatrix: number[] | null;
  runtimeCoordinationMatrix: number[] | null;
  projectSourceToViewerMatrix: number[] | null;
  previewShapeWorldMatrices: number[][];
  previewWorldBox: { min: number[]; max: number[] } | null;
  fineModelWorldMatrix: number[] | null;
  finePositions: number[][];
  fineWorldBox: { min: number[]; max: number[] } | null;
  centerDelta: number | null;
  sizeDelta: number[] | null;
}

/**
 * Compare one exact GlobalId across representations. This intentionally records
 * Fragments' public absolute positions/boxes and does not fit or alter a matrix.
 */
export async function captureIfcPreviewReplacementDiagnostic(
  ctx: ViewerContext,
  state: AppState,
  provider: IfcGeometryProvider,
  request: SelectionRequest,
  object: IfcPreviewObject,
): Promise<IfcPreviewReplacementDiagnostic | null> {
  if (!state.isCurrentSelection(request) || !provider.data) return null;
  const runtimeModelId = state.ifcRuntimeModelIds.get(object.modelId) ?? null;
  const model = runtimeModelId ? ctx.fragments.list.get(runtimeModelId) : undefined;
  if (!model || !object.globalId) return null;
  const ids = await model.getLocalIdsByGuids([object.globalId]);
  if (!state.isCurrentSelection(request)) return null;
  const localId = ids[0];
  if (localId == null) return null;

  const data = provider.data;
  const shapes = data.shapes.filter((shape) => shape.object.expressId === object.expressId);
  const previewBox = new THREE.Box3();
  const previewShapeWorldMatrices: number[][] = [];
  const sourceToViewer = state.projectSourceToViewerMatrix;
  if (sourceToViewer) {
    for (const shape of shapes) {
      const objectToViewer = sourceToViewer.clone().multiply(new THREE.Matrix4().fromArray(shape.matrix));
      previewShapeWorldMatrices.push(objectToViewer.toArray());
      const geometry = previewShapeGeometry(shape, shape.profile ? 1 : 0, data.origin);
      geometry.computeBoundingBox();
      if (geometry.boundingBox) previewBox.union(geometry.boundingBox.applyMatrix4(provider.root.matrix));
      geometry.dispose();
    }
  }

  const runtimeCoordination = await model.getCoordinationMatrix();
  if (!state.isCurrentSelection(request)) return null;
  const [fineWorldBox, positions] = await Promise.all([
    model.getMergedBox([localId]),
    model.getPositions([localId]),
  ]);
  if (!state.isCurrentSelection(request)) return null;
  model.object?.updateMatrixWorld?.(true);
  const normalizedPreviewBox = previewBox.isEmpty() ? null : {
    min: previewBox.min.toArray(), max: previewBox.max.toArray(),
  };
  const normalizedFineBox = fineWorldBox?.isEmpty?.() ? null : {
    min: fineWorldBox.min.toArray(), max: fineWorldBox.max.toArray(),
  };
  const previewCenter = normalizedPreviewBox
    ? new THREE.Box3(new THREE.Vector3().fromArray(normalizedPreviewBox.min), new THREE.Vector3().fromArray(normalizedPreviewBox.max)).getCenter(new THREE.Vector3())
    : null;
  const fineCenter = normalizedFineBox
    ? new THREE.Box3(new THREE.Vector3().fromArray(normalizedFineBox.min), new THREE.Vector3().fromArray(normalizedFineBox.max)).getCenter(new THREE.Vector3())
    : null;
  const previewSize = normalizedPreviewBox
    ? new THREE.Box3(new THREE.Vector3().fromArray(normalizedPreviewBox.min), new THREE.Vector3().fromArray(normalizedPreviewBox.max)).getSize(new THREE.Vector3())
    : null;
  const fineSize = normalizedFineBox
    ? new THREE.Box3(new THREE.Vector3().fromArray(normalizedFineBox.min), new THREE.Vector3().fromArray(normalizedFineBox.max)).getSize(new THREE.Vector3())
    : null;
  const diagnostic: IfcPreviewReplacementDiagnostic = {
    requestId: request.id,
    selectionTarget: request.target,
    logicalModelId: object.modelId,
    runtimeModelId,
    baseCoordinationModel: ctx.fragments.baseCoordinationModel ?? null,
    baseCoordinationMatrix: ctx.fragments.baseCoordinationMatrix?.elements ? [...ctx.fragments.baseCoordinationMatrix.elements] : null,
    runtimeCoordinationMatrix: runtimeCoordination.elements,
    projectSourceToViewerMatrix: sourceToViewer ? [...sourceToViewer.elements] : null,
    previewShapeWorldMatrices,
    previewWorldBox: normalizedPreviewBox,
    fineModelWorldMatrix: model.object?.matrixWorld?.elements ? [...model.object.matrixWorld.elements] : null,
    finePositions: (positions ?? []).map((position: THREE.Vector3) => position.toArray()),
    fineWorldBox: normalizedFineBox,
    centerDelta: previewCenter && fineCenter ? previewCenter.distanceTo(fineCenter) : null,
    sizeDelta: previewSize && fineSize ? previewSize.sub(fineSize).toArray() : null,
  };
  (globalThis as any).__GIM_IFC_PREVIEW_REPLACEMENT_DIAGNOSTICS__ ??= [];
  (globalThis as any).__GIM_IFC_PREVIEW_REPLACEMENT_DIAGNOSTICS__.push(diagnostic);
  console.info('[IFC Preview replacement coordinate diagnostic]', diagnostic);
  return diagnostic;
}

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
    try {
      await provider.loadLOD(2);
      await captureIfcPreviewReplacementDiagnostic(ctx,state,provider,request,object);
      if(!state.isCurrentSelection(request))return;
      await promoteIfcPreviewSelection(ctx,state,provider,request,object);
      if(provider.fineState==='fineReady')provider.releaseMetadata();
    }
    catch(error){if(state.isCurrentSelection(request)){
      const cancelled=error instanceof Error&&error.name==='AbortError';
      state.selectionGeometry=cancelled
        ? {status:'partial',detail:'LOD2 请求已取消排队；LOD0/LOD1 预览仍可用'}
        : {status:'failed',detail:`LOD2 加载失败；保留预览：${error instanceof Error?error.message:String(error)}`};
      setSelectionStatus(state.selectionGeometry.detail);
    }}
  };
  await showIfcPreviewProperties(ctx,state,provider,object,request,refine);
}

/** Automatic complete loading and the inspector's refine action share this provider. */
export async function finishIfcPreview(ctx:ViewerContext,state:AppState,provider:IfcGeometryProvider,session:ProjectLoadSession):Promise<void> {
  if(!state.isCurrentSession(session))return;
  const request=state.selectionRequest;
  const object=request?.target?.kind==='ifc-object' ? provider.data?.shapes.find(s=>s.object.key===request.target!.key)?.object : undefined;
  if(request && object)await captureIfcPreviewReplacementDiagnostic(ctx,state,provider,request,object);
  if(!state.isCurrentSession(session))return;
  provider.retire();
  if(request && object)await promoteIfcPreviewSelection(ctx,state,provider,request,object);
  provider.releaseMetadata();
}
