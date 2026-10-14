import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState, SelectionRequest } from '../app/state.js';
import { commitSelectionHighlight, HIGHLIGHT_STYLE } from './highlight.js';
import type { IfcGeometryProvider, IfcPreviewObject } from './ifcGeometryProvider.js';
import type { IfcRegionalRuntime } from './ifcRegionalRuntime.js';
import type { RegionalObject } from './ifcRegionalData.js';
import { highlightModGroups } from './highlight.js';

export type OnElementSelected = (modelId: string, localId: number, request: SelectionRequest) => void;

/** Real viewport clicks own their request before asynchronous raycasting starts. */
export function setupSelection(
  ctx: ViewerContext, state: AppState, container: HTMLElement,
  onElementSelected: OnElementSelected,
  onSelectionCleared: (request: SelectionRequest) => void = () => {},
  onPreviewSelected?: (provider: IfcGeometryProvider, object: IfcPreviewObject, request: SelectionRequest) => void,
  onRegionalSelected?: (runtime:IfcRegionalRuntime,object:RegionalObject,request:SelectionRequest)=>void,
): void {
  container.addEventListener('click', async (e: MouseEvent) => {
    if (!state.initialized) return;
    const canvas=container.querySelector('canvas');
    if (e.target!==container && e.target!==canvas) return;
    const request=state.beginSelection({kind:'ifc-element',key:''});
    const guard=state.selectionGuard(request);
    try {
      const regional:Array<{runtime:IfcRegionalRuntime;object:RegionalObject;distance:number}>=[];
      if(state.ifcRegionalRuntimes.size){const rect=(canvas||container).getBoundingClientRect();
        if(rect.width>0&&rect.height>0){const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),(ctx.world.camera as any).three);
          for(const runtime of state.ifcRegionalRuntimes.values()){const hit=runtime.pick(ray);if(hit)regional.push({runtime,...hit});}regional.sort((a,b)=>a.distance-b.distance);}}
      const previews: Array<{provider:IfcGeometryProvider;object:IfcPreviewObject;distance:number}>=[];
      if(state.ifcPreviewProviders.size) {
        const rect=(canvas || container).getBoundingClientRect();
        if(rect.width>0 && rect.height>0) {
          const ray=new THREE.Raycaster();
          ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),(ctx.world.camera as any).three);
          for(const provider of state.ifcPreviewProviders.values()){const hit=provider.pick(ray);if(hit)previews.push({provider,...hit});}
          previews.sort((a,b)=>a.distance-b.distance);
        }
      }
      const result=ctx.fragments.list.size===0 ? null : await ctx.fragments.raycast({
        camera:(ctx.world.camera as any).three,mouse:new THREE.Vector2(e.clientX,e.clientY),
        dom:canvas as HTMLCanvasElement || container,
      });
      if (!guard.isCurrent()) return;
      const near=regional[0];
      if(near&&(!result||near.distance<(result.rayDistance??result.distance))){
        request.target={kind:'ifc-object',key:`ifc:${near.runtime.modelId.toLowerCase()}:object:${near.object.expressId}`};
        onRegionalSelected?.(near.runtime,near.object,request);
        await commitSelectionHighlight(ctx,state,guard,()=>{const group=near.runtime.highlightGroup(near.object.expressId);if(group)highlightModGroups(state,[group]);});return;
      }
      const preview=previews[0];
      if (preview && preview.provider.level!==2 && (!result || preview.distance < (result.rayDistance ?? result.distance))) {
        request.target={kind:'ifc-object',key:preview.object.key};
        onPreviewSelected?.(preview.provider,preview.object,request);
        await commitSelectionHighlight(ctx,state,guard,()=>preview.provider.highlight(preview.object));
        return;
      }
      if (!result) {
        request.target=null;
        onSelectionCleared(request);
        await commitSelectionHighlight(ctx,state,guard);
        return;
      }
      const {localId,fragments:hitModel}=result;
      const modelId=hitModel.modelId;
      request.target={kind:'ifc-element',key:`${modelId}:${localId}`};
      onElementSelected(modelId,localId,request);
      const items:OBC.ModelIdMap={[modelId]:new Set([localId])};
      await commitSelectionHighlight(ctx,state,guard,async () => {
        await ctx.fragments.highlight(HIGHLIGHT_STYLE,items as any);
        // Keep bookkeeping for the next queued reset, even if selection changed
        // while the external highlight operation was in flight.
        if (guard.isSessionCurrent()) state.highlightedItems=items as any;
      });
    } catch (error) { console.warn('射线拾取失败:',error); }
  });
}
