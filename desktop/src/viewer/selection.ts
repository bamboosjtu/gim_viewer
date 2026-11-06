import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { ViewerState as AppState } from '../shared/viewerState.js';
import type { SelectionRequest } from '../shared/selectionContracts.js';
import { commitSelectionHighlight } from './highlight.js';
import type { IfcRegionalRuntime } from './ifcRegionalRuntime.js';
import type { RegionalObject } from './ifcRegionalData.js';
import { highlightModGroups } from './highlight.js';
import { raycastVisibleIfc } from './ifcVisibleRaycast.js';
import { outlineFragmentItems, showHoverOutline, showFragmentHover, showHoverBounds, clearHoverOutline } from './selectionOutline.js';

export type OnElementSelected = (modelId: string, localId: number, request: SelectionRequest) => void | boolean | Promise<boolean | void>;

/** Camera gestures and blank isolated clicks never replace a logical selection. */
export function setupSelection(
  ctx: ViewerContext, state: AppState, container: HTMLElement,
  onElementSelected: OnElementSelected,
  onSelectionCleared: (request: SelectionRequest) => void = () => {},
  onRegionalSelected?: (runtime:IfcRegionalRuntime,object:RegionalObject,request:SelectionRequest)=>void | boolean | Promise<boolean | void>,
  onDevSelected?: (rootOccurrence:string,instanceKey:string,request:SelectionRequest,hint?:import('../engineering/representations.js').DevRepresentationHint)=>void,
): void {
  let pointer: {id: number; x: number; y: number; moved: boolean} | null = null;
  let suppressClick = false, pickSerial = 0;
  let hoverSerial = 0, hoverTimer: ReturnType<typeof setTimeout> | undefined, hoverBusy = false;
  let hoverPoint: {x: number; y: number} | null = null;
  state.hoverCleanup = () => { hoverSerial++; hoverPoint = null; clearTimeout(hoverTimer); clearHoverOutline(state); };
  const cameraIntent = () => { state.cameraNavigationVersion++; state.viewerUserInteracted = true; state.hasFittedCamera = true; pickSerial++; state.hoverCleanup?.(); };
  (ctx.world.camera.controls as any)?.addEventListener?.('controlstart', cameraIntent);
  container.addEventListener('wheel', cameraIntent, { passive: true });
  const runHover = async () => {
    if (hoverBusy || pointer || !hoverPoint || !state.initialized) return;
    hoverBusy = true;
    const serial = hoverSerial, point = hoverPoint, session = state.captureProjectSession(), selection = state.selectionRequest;
    const current = () => serial === hoverSerial && state.isCurrentSession(session) && state.selectionRequest === selection;
    try {
      const canvas = container.querySelector('canvas'), dom = canvas ?? container, rect = dom.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (point.x < rect.left || point.y < rect.top || point.x > rect.left+rect.width || point.y > rect.top+rect.height) { clearHoverOutline(state); return; }
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((point.x-rect.left)/rect.width*2-1,-(point.y-rect.top)/rect.height*2+1),(ctx.world.camera as any).three);
      const dev = state.deviceLodRuntime?.pick?.(ray), near = [...state.ifcRegionalRuntimes.values()].flatMap(runtime => {const hit=runtime.pick(ray);return hit?[{runtime,...hit}]:[];}).sort((a,b)=>a.distance-b.distance)[0];
      const far = await raycastVisibleIfc(ctx,{camera:(ctx.world.camera as any).three,mouse:new THREE.Vector2(point.x,point.y),dom:dom as HTMLCanvasElement});
      if (!current()) return;
      const farDistance = far?.rayDistance ?? far?.distance ?? Infinity;
      if (dev && dev.distance < Math.min(near?.distance ?? Infinity, farDistance)) {
        showHoverOutline(state, dev.object ?? state.deviceLodRuntime?.getLoadedRoot?.(dev.rootOccurrence));
      } else if (near && near.distance < farDistance) {
        const group = near.runtime.hoverGroup?.(near.object.expressId);
        if (group?.children.length) showHoverOutline(state,group);
        else { const box=near.runtime.worldBounds(near.object),scene=(ctx.world.scene as any)?.three;if(box&&scene)showHoverBounds(state,scene,box);else clearHoverOutline(state); }
      } else if (far) {
        const ids = state.highlightedItems?.[far.fragments.modelId];
        if (ids && [...ids].includes(far.localId)) clearHoverOutline(state);
        else await showFragmentHover(ctx,state,far.fragments.modelId,far.localId,current);
      } else clearHoverOutline(state);
    } catch (error) { if (current()) { clearHoverOutline(state); console.warn('[Hover]',error); } }
    finally { hoverBusy=false;if(hoverPoint && hoverSerial!==serial)hoverTimer=setTimeout(runHover,100); }
  };
  container.addEventListener('pointermove', event => {
    if (!canvasTarget(event.target) || pointer || event.buttons) return;
    hoverPoint={x:event.clientX,y:event.clientY};hoverSerial++;clearTimeout(hoverTimer);hoverTimer=setTimeout(runHover,100);
  });
  container.addEventListener('pointerleave', () => state.hoverCleanup?.());
  const canvasTarget = (target: EventTarget | null) => target === container || target === container.querySelector('canvas');
  container.addEventListener('pointerdown', event => {
    if (!canvasTarget(event.target)) { suppressClick = true; return; }
    cameraIntent();
    suppressClick = event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.isPrimary === false;
    pointer = {id: event.pointerId, x: event.clientX, y: event.clientY, moved: suppressClick};
  });
  window.addEventListener('pointermove', event => {
    if (pointer && event.pointerId === pointer.id && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) pointer.moved = true;
  });
  window.addEventListener('pointerup', event => {
    if (pointer && event.pointerId === pointer.id) { suppressClick = pointer.moved || Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>5; pointer = null; }
    if (canvasTarget(event.target) && !event.buttons) { hoverPoint={x:event.clientX,y:event.clientY};hoverSerial++;clearTimeout(hoverTimer);hoverTimer=setTimeout(runHover,100); }
  });
  window.addEventListener('pointercancel', () => { pointer = null; suppressClick = true; });
  container.addEventListener('click', async (e: MouseEvent) => {
    if (!state.initialized || e.button !== 0 || suppressClick || e.ctrlKey || e.shiftKey || e.altKey) return;
    const canvas=container.querySelector('canvas');
    if (e.target!==container && e.target!==canvas) return;
    const serial = ++pickSerial, session = state.captureProjectSession(), previous = state.selectionRequest;
    try {
      const regional:Array<{runtime:IfcRegionalRuntime;object:RegionalObject;distance:number}>=[];
      let devHit: ReturnType<NonNullable<NonNullable<AppState['deviceLodRuntime']>['pick']>> = null;
      if(state.ifcRegionalRuntimes.size || state.deviceLodRuntime?.pick){const rect=(canvas||container).getBoundingClientRect();
        if(rect.width>0&&rect.height>0){const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),(ctx.world.camera as any).three);
          devHit=state.deviceLodRuntime?.pick?.(ray)??null;
          for(const runtime of state.ifcRegionalRuntimes.values()){const hit=runtime.pick(ray);if(hit)regional.push({runtime,...hit});}regional.sort((a,b)=>a.distance-b.distance);}}
      // Pick the visible browser representation before beginSelection clears
      // the previous visibility filter or releases its fine representation.
      // The new request still owns every asynchronous result below.
      const picking=raycastVisibleIfc(ctx,{
        camera:(ctx.world.camera as any).three,mouse:new THREE.Vector2(e.clientX,e.clientY),
        dom:canvas as HTMLCanvasElement || container,
      });
      const result=await picking;
      if (serial !== pickSerial || !state.isCurrentSession(session) || state.selectionRequest !== previous) return;
      const near=regional[0];
      // A miss during isolation preserves the logical selection and its filter.
      // Camera gestures never start a request or clear a fine representation.
      if (!result && !near && !devHit && state.onlySelected) return;
      const request=state.beginSelection({kind:'ifc-element',key:''}, 'viewport');
      const guard=state.selectionGuard(request);
      const ifcDistance=result ? (result.rayDistance??result.distance??Infinity) : Infinity;
      if(onDevSelected && devHit && devHit.distance<Math.min(near?.distance??Infinity,ifcDistance)) {
        request.target={kind:'cbm',key:devHit.rootOccurrence};
        onDevSelected?.(devHit.rootOccurrence,devHit.instanceKey,request,devHit.hint);return;
      }
      if(near&&(!result||near.distance<(result.rayDistance??result.distance))){
        request.target={kind:'ifc-object',key:`ifc:${near.runtime.modelId.toLowerCase()}:object:${near.object.expressId}`};
        const handled = await onRegionalSelected?.(near.runtime,near.object,request);
        if (handled || !guard.isCurrent()) return;
        await commitSelectionHighlight(ctx,state,guard,()=>{const group=near.runtime.highlightGroup(near.object.expressId);if(group)highlightModGroups(state,[group]);});return;
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
      const handled = await onElementSelected(modelId,localId,request);
      if (handled || !guard.isCurrent()) return;
      const items:OBC.ModelIdMap={[modelId]:new Set([localId])};
      await commitSelectionHighlight(ctx,state,guard,async () => {
        await outlineFragmentItems(ctx,state,items as any,guard);
        // Keep bookkeeping for the next queued reset, even if selection changed
        // while the external highlight operation was in flight.
        if (guard.isSessionCurrent()) state.highlightedItems=items as any;
      });
    } catch (error) { console.warn('射线拾取失败:',error); }
  });
}
