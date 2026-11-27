import type { Vector3 } from 'three';
import type { AppState } from '../../../app/state.js';
import type { ViewerContext } from '../../../viewer/viewerEngine.js';
import { pickVisibleRay } from '../../../viewer/selection.js';
import type { PatrolNavigationRuntime } from '../runtime/patrolNavigationRuntime.js';

export function bindPatrolDoorTarget(
  ctx: ViewerContext,
  state: AppState,
  canvas: HTMLCanvasElement,
  clip: () => ((p: Vector3) => boolean) | undefined,
  navigation: () => PatrolNavigationRuntime,
  current: () => boolean,
) {
  const port = state.navigation;
  let doorTimer: ReturnType<typeof setTimeout> | undefined,
    doorSequence = 0;
  const doorHint = (on: boolean) => {
    if (port.doorHint === on) return;
    port.doorHint = on;
    port.dispatchEvent(new Event('change'));
  };
  async function doorUnderCrosshair() {
    if (!navigation().hasDoors || !current()) return;
    const rect = canvas.getBoundingClientRect();
    const { devHit, near, result } = await pickVisibleRay(
      ctx,
      state,
      canvas,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      clip(),
    );
    const far = result?.rayDistance ?? result?.distance ?? Infinity;
    const d = Math.min(far, near?.distance ?? Infinity);
    if (d > 2.5 || (devHit?.distance ?? Infinity) < d) return;
    let id: string | undefined;
    if (near && near.distance <= far) id = near.runtime.sourcePath + '#' + near.object.expressId;
    else if (result) {
      const logical =
        state.ifc.resolveLogicalModelId(result.fragments.modelId) ?? result.fragments.modelId;
      const rt = state.ifc.regionalRuntimes.get(logical);
      const [guid] = await result.fragments.getGuidsByLocalIds([result.localId]);
      const match = rt?.index.objects.filter((o) => o.globalId === guid);
      if (rt && match?.length === 1) id = rt.sourcePath + '#' + match[0].expressId;
    }
    return id && navigation().canOperate(id) ? id : undefined;
  }
  const refreshDoor = () => {
    ++doorSequence;
    doorHint(false);
    if (port.mode !== 'walking' || !navigation().hasDoors || doorTimer) return;
    doorTimer = setTimeout(() => {
      doorTimer = undefined;
      const seq = doorSequence;
      void doorUnderCrosshair()
        .then((id) => {
          if (seq === doorSequence && port.mode === 'walking') doorHint(!!id);
        })
        .catch(() => {});
    }, 180);
  };
  return {
    pick: doorUnderCrosshair,
    refresh: refreshDoor,
    reset() {
      clearTimeout(doorTimer);
      doorTimer = undefined;
      doorSequence++;
      doorHint(false);
    },
  };
}
