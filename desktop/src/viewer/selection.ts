import { logger } from '../utils/logger.js';
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
import {
  outlineFragmentItems,
  showHoverOutline,
  showFragmentHover,
  showHoverBounds,
  clearHoverOutline,
} from './selectionOutline.js';

export interface PickTools {
  clipTest(): ((p: THREE.Vector3) => boolean) | undefined;
  measuring(): boolean;
  revision(): number;
  point(p: THREE.Vector3, source: string, lod: string): void;
  miss(): void;
}
export type OnElementSelected = (
  modelId: string,
  localId: number,
  request: SelectionRequest,
) => void | boolean | Promise<boolean | void>;

export async function pickVisibleRay(
  ctx: ViewerContext,
  state: AppState,
  dom: HTMLElement,
  clientX: number,
  clientY: number,
  clip?: (point: THREE.Vector3) => boolean,
  surfaceOnly = false,
) {
  const regional: Array<{
    runtime: IfcRegionalRuntime;
    object: RegionalObject;
    distance: number;
    point?: THREE.Vector3;
    lod?: number;
  }> = [];
  let devHit: ReturnType<NonNullable<NonNullable<AppState['deviceLodRuntime']>['pick']>> = null;
  if (state.ifc.regionalRuntimes.size || state.deviceLodRuntime?.pick) {
    const rect = dom.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          (-(clientY - rect.top) / rect.height) * 2 + 1,
        ),
        ctx.world.camera.three,
      );
      devHit = state.deviceLodRuntime?.pick?.(ray, clip) ?? null;
      for (const runtime of state.ifc.regionalRuntimes.values()) {
        const hit = runtime.pick(ray, clip);
        if (hit) regional.push({ runtime, ...hit });
      }
      regional.sort((a, b) => a.distance - b.distance);
    }
  }
  // Pick the visible browser representation before beginSelection clears
  // the previous visibility filter or releases its fine representation.
  // The new request still owns every asynchronous result below.
  const picking = raycastVisibleIfc(
    ctx,
    {
      camera: ctx.world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera,
      mouse: new THREE.Vector2(clientX, clientY),
      dom: dom as HTMLCanvasElement,
    },
    clip,
    surfaceOnly,
  );
  const result = await picking;
  return { devHit, near: regional[0], result };
}

/** Camera gestures and blank isolated clicks never replace a logical selection. */
export function setupSelection(
  ctx: ViewerContext,
  state: AppState,
  container: HTMLElement,
  onElementSelected: OnElementSelected,
  onSelectionCleared: (request: SelectionRequest) => void = () => {},
  onRegionalSelected?: (
    runtime: IfcRegionalRuntime,
    object: RegionalObject,
    request: SelectionRequest,
  ) => void | boolean | Promise<boolean | void>,
  onDevSelected?: (
    rootOccurrence: string,
    instanceKey: string,
    request: SelectionRequest,
    hint?: import('../engineering/representations.js').DevRepresentationHint,
  ) => void,
  tools?: PickTools,
  navigation?: import('../shared/viewerNavigationCommands.js').ViewerNavigationCommands,
) {
  const abort = new AbortController();
  const signal = abort.signal;
  let pointer: { id: number; x: number; y: number; moved: boolean } | null = null;
  let suppressClick = false,
    pickSerial = 0;
  let hoverSerial = 0,
    hoverTimer: ReturnType<typeof setTimeout> | undefined,
    hoverBusy = false;
  let hoverPoint: { x: number; y: number } | null = null;
  const clearHover = () => {
    hoverSerial++;
    hoverPoint = null;
    clearTimeout(hoverTimer);
    clearHoverOutline(state);
  };
  state.selection.hoverCleanup = clearHover;
  const ordinary = () => !navigation || navigation.mode === 'orbit';
  const cameraIntent = () => {
    if (!ordinary()) return;
    state.viewState.cameraNavigationVersion++;
    state.viewState.viewerUserInteracted = true;
    state.viewState.hasFittedCamera = true;
    pickSerial++;
    state.selection.hoverCleanup?.();
  };
  const dispose = () => {
    if (signal.aborted) return;
    abort.abort();
    pointer = null;
    pickSerial++;
    clearHover();
    if (state.selection.hoverCleanup === clearHover) state.selection.hoverCleanup = null;
    ctx.world.camera.controls?.removeEventListener?.('controlstart', cameraIntent);
  };

  let navigationRevision = navigation?.revision;
  navigation?.addEventListener(
    'change',
    () => {
      if (navigationRevision === navigation.revision) return;
      navigationRevision = navigation.revision;
      pointer = null;
      suppressClick = false;
      pickSerial++;
      clearHover();
    },
    { signal },
  );
  try {
    ctx.world.camera.controls?.addEventListener?.('controlstart', cameraIntent);
    container.addEventListener('wheel', cameraIntent, { passive: true, signal });
    const runHover = async () => {
      if (!ordinary() || hoverBusy || pointer || !hoverPoint || !state.initialized) return;
      hoverBusy = true;
      const revision = tools?.revision();
      const serial = hoverSerial,
        point = hoverPoint,
        session = state.captureProjectSession(),
        selection = state.selection.selectionRequest;
      const current = () =>
        !signal.aborted &&
        serial === hoverSerial &&
        revision === tools?.revision() &&
        state.isCurrentSession(session) &&
        state.selection.selectionRequest === selection;
      try {
        const canvas = container.querySelector('canvas'),
          dom = canvas ?? container,
          rect = dom.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        if (
          point.x < rect.left ||
          point.y < rect.top ||
          point.x > rect.left + rect.width ||
          point.y > rect.top + rect.height
        ) {
          clearHoverOutline(state);
          return;
        }
        const ray = new THREE.Raycaster();
        ray.setFromCamera(
          new THREE.Vector2(
            ((point.x - rect.left) / rect.width) * 2 - 1,
            (-(point.y - rect.top) / rect.height) * 2 + 1,
          ),
          ctx.world.camera.three,
        );
        const dev = state.deviceLodRuntime?.pick?.(ray, tools?.clipTest()),
          near = [...state.ifc.regionalRuntimes.values()]
            .flatMap((runtime) => {
              const hit = runtime.pick(ray, tools?.clipTest());
              return hit ? [{ runtime, ...hit }] : [];
            })
            .sort((a, b) => a.distance - b.distance)[0];
        const far = await raycastVisibleIfc(
          ctx,
          {
            camera: ctx.world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera,
            mouse: new THREE.Vector2(point.x, point.y),
            dom: dom as HTMLCanvasElement,
          },
          tools?.clipTest(),
        );
        if (!current()) return;
        const farDistance = far?.rayDistance ?? far?.distance ?? Infinity;
        if (dev && dev.distance < Math.min(near?.distance ?? Infinity, farDistance)) {
          showHoverOutline(
            state,
            dev.object ?? state.deviceLodRuntime?.getLoadedRoot?.(dev.rootOccurrence),
          );
        } else if (near && near.distance < farDistance) {
          const group = near.runtime.hoverGroup?.(near.object.expressId);
          if (group?.children.length) showHoverOutline(state, group);
          else {
            const box = near.runtime.worldBounds(near.object),
              scene = ctx.world.scene?.three;
            if (box && scene) showHoverBounds(state, scene, box);
            else clearHoverOutline(state);
          }
        } else if (far) {
          const ids = state.selection.highlightedItems?.[far.fragments.modelId];
          if (ids && [...ids].includes(far.localId)) clearHoverOutline(state);
          else await showFragmentHover(ctx, state, far.fragments.modelId, far.localId, current);
        } else clearHoverOutline(state);
      } catch (error) {
        if (current()) {
          clearHoverOutline(state);
          logger.warn('[Hover]', error);
        }
      } finally {
        hoverBusy = false;
        if (!signal.aborted && hoverPoint && hoverSerial !== serial)
          hoverTimer = setTimeout(runHover, 100);
      }
    };
    container.addEventListener(
      'pointermove',
      (event) => {
        if (!ordinary() || !canvasTarget(event.target) || pointer || event.buttons) return;
        hoverPoint = { x: event.clientX, y: event.clientY };
        hoverSerial++;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(runHover, 100);
      },
      { signal },
    );
    container.addEventListener('pointerleave', () => state.selection.hoverCleanup?.(), { signal });
    const canvasTarget = (target: EventTarget | null) =>
      target === container || target === container.querySelector('canvas');
    container.addEventListener(
      'pointerdown',
      (event) => {
        if (!ordinary() || !canvasTarget(event.target)) {
          suppressClick = true;
          return;
        }
        cameraIntent();
        suppressClick =
          event.button !== 0 ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.isPrimary === false;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: suppressClick };
      },
      { signal },
    );
    window.addEventListener(
      'pointermove',
      (event) => {
        if (
          pointer &&
          event.pointerId === pointer.id &&
          Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5
        )
          pointer.moved = true;
      },
      { signal },
    );
    window.addEventListener(
      'pointerup',
      (event) => {
        if (pointer && event.pointerId === pointer.id) {
          suppressClick =
            pointer.moved || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5;
          pointer = null;
        }
        if (ordinary() && canvasTarget(event.target) && !event.buttons) {
          hoverPoint = { x: event.clientX, y: event.clientY };
          hoverSerial++;
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(runHover, 100);
        }
      },
      { signal },
    );
    window.addEventListener(
      'pointercancel',
      () => {
        pointer = null;
        suppressClick = true;
      },
      { signal },
    );
    const resolvePick = async (clientX: number, clientY: number, inspection = false) => {
      const canvas = container.querySelector('canvas');
      const serial = ++pickSerial,
        session = state.captureProjectSession(),
        previous = state.selection.selectionRequest;
      const revision = tools?.revision();
      try {
        const { devHit, near, result } = await pickVisibleRay(
          ctx,
          state,
          canvas ?? container,
          clientX,
          clientY,
          tools?.clipTest(),
          inspection ? false : tools?.measuring(),
        );
        if (
          signal.aborted ||
          serial !== pickSerial ||
          revision !== tools?.revision() ||
          !state.isCurrentSession(session) ||
          state.selection.selectionRequest !== previous
        )
          return;
        if (inspection && !result && !near && !devHit) {
          navigation?.set('inspecting', '准星未命中可见设备');
          return;
        }
        if (!inspection && tools?.measuring()) {
          const farDistance = result?.rayDistance ?? result?.distance ?? Infinity;
          if (
            devHit?.point &&
            devHit.distance < Math.min(near?.distance ?? Infinity, farDistance)
          ) {
            const root = state.deviceLodRuntime?.getLoadedRoot?.(devHit.rootOccurrence);
            tools.point(
              devHit.point,
              devHit.hint?.devPath || devHit.rootOccurrence,
              root?.userData.deviceLod == null ? '浏览表示' : 'L' + root.userData.deviceLod,
            );
          } else if (near?.point && near.distance < farDistance)
            tools.point(
              near.point,
              near.runtime.modelId + ' #' + near.object.expressId,
              'L' + near.lod,
            );
          else if (result?.point)
            tools.point(
              result.point,
              result.fragments.modelId + ' #' + result.localId,
              result.fragments.object.userData.ifcOpeningPolicy === 'bim-lod'
                ? 'IFC L0'
                : 'IFC 浏览表示（LOD 未提供）',
            );
          else tools.miss();
          return;
        }
        // A miss during isolation preserves the logical selection and its filter.
        // Camera gestures never start a request or clear a fine representation.
        if (!result && !near && !devHit && state.selection.onlySelected) return;
        const request = state.selection.beginSelection(
          { kind: 'ifc-element', key: '' },
          'viewport',
        );
        const owner = state.selection.selectionGuard(request);
        const guard = {
          ...owner,
          isCurrent: () => !signal.aborted && owner.isCurrent(),
          isSessionCurrent: () => !signal.aborted && owner.isSessionCurrent(),
        };
        const ifcDistance = result ? (result.rayDistance ?? result.distance ?? Infinity) : Infinity;
        if (
          onDevSelected &&
          devHit &&
          devHit.distance < Math.min(near?.distance ?? Infinity, ifcDistance)
        ) {
          request.target = { kind: 'cbm', key: devHit.rootOccurrence };
          onDevSelected?.(devHit.rootOccurrence, devHit.instanceKey, request, devHit.hint);
          return;
        }
        if (near && (!result || near.distance < (result.rayDistance ?? result.distance))) {
          request.target = {
            kind: 'ifc-object',
            key: `ifc:${near.runtime.modelId.toLowerCase()}:object:${near.object.expressId}`,
          };
          const handled = await onRegionalSelected?.(near.runtime, near.object, request);
          if (handled || !guard.isCurrent()) return;
          await commitSelectionHighlight(ctx, state, guard, () => {
            const group = near.runtime.highlightGroup(near.object.expressId);
            if (group) highlightModGroups(state, [group]);
          });
          return;
        }
        if (!result) {
          request.target = null;
          onSelectionCleared(request);
          await commitSelectionHighlight(ctx, state, guard);
          return;
        }
        const { localId, fragments: hitModel } = result;
        const modelId = hitModel.modelId;
        request.target = { kind: 'ifc-element', key: `${modelId}:${localId}` };
        const handled = await onElementSelected(modelId, localId, request);
        if (handled || !guard.isCurrent()) return;
        const items: OBC.ModelIdMap = { [modelId]: new Set([localId]) };
        await commitSelectionHighlight(ctx, state, guard, async () => {
          await outlineFragmentItems(ctx, state, items, guard);
          // Keep bookkeeping for the next queued reset, even if selection changed
          // while the external highlight operation was in flight.
          if (guard.isSessionCurrent()) state.selection.highlightedItems = items;
        });
      } catch (error) {
        logger.warn('射线拾取失败:', error);
      }
    };
    container.addEventListener(
      'click',
      (event: MouseEvent) => {
        const measuring = navigation?.mode === 'inspecting' && navigation.measuring;
        if (
          (!ordinary() && !measuring) ||
          !state.initialized ||
          event.button !== 0 ||
          (!measuring && suppressClick) ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          !canvasTarget(event.target)
        )
          return;
        void resolvePick(event.clientX, event.clientY).catch((error) =>
          logger.warn('[Viewport pick]', error),
        );
      },
      { signal },
    );
    const inspect = () => {
      const rect = (container.querySelector('canvas') ?? container).getBoundingClientRect();
      return resolvePick(rect.left + rect.width / 2, rect.top + rect.height / 2, true);
    };
    async function restoreIfc(key: string, request: SelectionRequest) {
      if (!state.selection.isCurrentSelection(request)) return;
      if (request.target?.kind === 'ifc-object') {
        for (const rt of state.ifc.regionalRuntimes.values()) {
          const prefix = 'ifc:' + rt.modelId.toLowerCase() + ':object:';
          if (!key.startsWith(prefix)) continue;
          const object = rt.index.objects.find(
            (o) => o.expressId === Number(key.slice(prefix.length)),
          );
          if (object) await onRegionalSelected?.(rt, object, request);
          return;
        }
      } else {
        const colon = key.lastIndexOf(':'),
          id = key.slice(0, colon),
          localId = Number(key.slice(colon + 1));
        if (colon > 0 && Number.isSafeInteger(localId) && ctx.fragments.list.get(id))
          await onElementSelected(id, localId, request);
      }
    }
    return Object.assign(dispose, { inspect, restoreIfc });
  } catch (error) {
    dispose();
    throw error;
  }
}
