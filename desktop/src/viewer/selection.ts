import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState, SelectionRequest } from '../app/state.js';
import { commitSelectionHighlight, HIGHLIGHT_STYLE } from './highlight.js';

export type OnElementSelected = (modelId: string, localId: number, request: SelectionRequest) => void;

/** Real viewport clicks own their request before asynchronous raycasting starts. */
export function setupSelection(
  ctx: ViewerContext, state: AppState, container: HTMLElement,
  onElementSelected: OnElementSelected,
  onSelectionCleared: (request: SelectionRequest) => void = () => {},
): void {
  container.addEventListener('click', async (e: MouseEvent) => {
    if (!state.initialized) return;
    const canvas=container.querySelector('canvas');
    if (e.target!==container && e.target!==canvas) return;
    const request=state.beginSelection({kind:'ifc-element',key:''});
    const guard=state.selectionGuard(request);
    try {
      const result=ctx.fragments.list.size===0 ? null : await ctx.fragments.raycast({
        camera:(ctx.world.camera as any).three,mouse:new THREE.Vector2(e.clientX,e.clientY),
        dom:canvas as HTMLCanvasElement || container,
      });
      if (!guard.isCurrent()) return;
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
