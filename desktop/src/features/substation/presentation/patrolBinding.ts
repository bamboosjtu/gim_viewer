import { Vector3 } from 'three';
import type { OrthoPerspectiveCamera } from '@thatopen/components';
import type { AppState } from '../../../app/state.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import { getViewerRuntimeWithUI } from '../../../services/presentation/viewerUIBinding.js';
import { pickVisibleRay } from '../../../viewer/selection.js';
import { cameraPoseHub } from '../../../viewer/cameraPoseHub.js';
import {
  capturePatrolCamera,
  freezeOrbit,
  restoreOrbit,
} from '../../../viewer/patrol/patrolContextSnapshot.js';
import { FirstPersonController } from '../../../viewer/patrol/firstPersonController.js';
import { PatrolNavigationRuntime } from '../runtime/patrolNavigationRuntime.js';
import { selectEngineeringTarget } from '../../../services/engineering/engineeringSelection.js';
import { clearCurrentSelection } from '../../../services/selection/selectionCommands.js';
import type { NavigationAction } from '../../../shared/viewerNavigationCommands.js';

export async function bindPatrol(state: AppState, scope: SessionScope, show: (s: string) => void) {
  const { ctx, patrol } = await getViewerRuntimeWithUI(state, show);
  if (!scope.isCurrent() || !patrol) return;
  const canvas = ctx.world.renderer?.three.domElement;
  if (!canvas) return;
  const port = state.navigation,
    tools = state.viewerCommands,
    cam = ctx.world.camera as OrthoPerspectiveCamera;
  const hub = cameraPoseHub(ctx);
  let nav = new PatrolNavigationRuntime(state, state.captureProjectSession()),
    batch = state.geometryLoadToken;
  let run: AbortController | undefined,
    walker: FirstPersonController | undefined,
    frame = state.projectCoordinateFrame;
  let entry: Vector3 | undefined,
    source = '',
    entryRequest = 0,
    switching = false,
    inspectionChanged = false;
  let doorTimer: ReturnType<typeof setTimeout> | undefined,
    doorSequence = 0,
    doorBusy = false;
  const doorHint = (on: boolean) => {
    if (port.doorHint === on) return;
    port.doorHint = on;
    port.dispatchEvent(new Event('change'));
  };
  async function doorUnderCrosshair() {
    if (!nav.hasDoors || port.mode !== 'walking' || !scope.isCurrent()) return;
    const rect = canvas!.getBoundingClientRect();
    const { devHit, near, result } = await pickVisibleRay(
      ctx,
      state,
      canvas!,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      patrol!.clip(),
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
    return id && nav.canOperate(id) ? id : undefined;
  }
  const refreshDoor = () => {
    ++doorSequence;
    doorHint(false);
    if (port.mode !== 'walking' || !nav.hasDoors || doorBusy || doorTimer) return;
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
  const unsubscribeDoor = hub.subscribe(refreshDoor);
  hub.claim('orbit', scope.session.generation);
  let trace: ReturnType<typeof hub.startAdmissionTrace> | undefined,
    drawCount = 0,
    coverageMs: number | undefined;
  const draw = () => {
    drawCount++;
  };
  const renderer = ctx.world.renderer;
  const summarize = (a: number[]) => {
    const values = [...a].sort((x, y) => x - y);
    const at = (p: number) => values[Math.ceil(values.length * p) - 1] ?? null;
    return { count: values.length, p50: at(0.5), p95: at(0.95), max: at(1) };
  };
  const evidence = () => ({
    mode: port.mode,
    coverageMs,
    estimatedSectionOccurrences: nav.metrics.estimatedSectionOccurrences,
    drawCount,
    capped: walker?.capped,
    movement: summarize(walker?.tickMs ?? []),
    collision: summarize(nav.metrics.queryMs),
    admission: { dev: summarize(trace?.dev ?? []), ifc: summarize(trace?.ifc ?? []) },
    cache: {
      assetsBuilt: nav.metrics.assetBuilds,
      assetsHit: nav.metrics.assetHits,
      blocksPrepared: nav.metrics.blocks,
      blocksHit: nav.metrics.blockHits,
    },
  });
  port.evidence = evidence;
  const capture = () => ({
    camera: capturePatrolCamera(cam),
    tool: structuredClone(tools.snapshot),
    visibility: patrol.visibility.getVisibility(),
    target: state.selection.selectionRequest?.target
      ? { ...state.selection.selectionRequest.target }
      : null,
    origin: state.selection.selectionRequest?.origin,
    only: state.selection.onlySelected,
    selectionId: state.selection.selectionRequest?.id,
  });
  let snapshot: ReturnType<typeof capture> | undefined;
  let interrupted: 'pause' | 'exit' | undefined;
  const alive = (owner: AbortController | undefined) =>
    !!owner && owner === run && !owner.signal.aborted && scope.isCurrent();
  const frameValid = () =>
    scope.isCurrent() &&
    frame === state.projectCoordinateFrame &&
    state.projectSourceToViewerMatrix === frame?.matrix &&
    batch === state.geometryLoadToken;
  const restoreSelection = async () => {
    const s = snapshot;
    if (
      !s ||
      (!inspectionChanged && s.selectionId === state.selection.selectionRequest?.id) ||
      !scope.isCurrent()
    )
      return;
    inspectionChanged = false;
    const target = s.target;
    if (!target) {
      await clearCurrentSelection(state);
      return;
    }
    const request = state.selection.beginSelection(target, s.origin);
    if (
      target.kind === 'engineering' ||
      target.kind === 'engineering-source' ||
      target.kind === 'engineering-group'
    ) {
      await selectEngineeringTarget(state, { kind: target.kind, key: target.key }, request, {
        fit: false,
        load: false,
      });
    } else if (target.kind === 'ifc-object' || target.kind === 'ifc-element') {
      await patrol.restoreIfc(target.key, request);
    } else if (target.kind === 'sld') {
      const { presentSldSelection } = await import('./substationPresentation.js');
      if (state.selection.isCurrentSelection(request))
        await presentSldSelection(state, target.key, show, scope.session, request);
    } else if (target.kind === 'cbm') {
      const { selectViewportDev } =
        await import('../../../services/selection/devViewportSelection.js');
      if (state.selection.isCurrentSelection(request))
        await selectViewportDev(ctx, state, target.key, '', request, show);
    }
    if (scope.isCurrent()) s.selectionId = state.selection.selectionRequest?.id;
  };
  const endMeasurement = () => {
    port.measuring = false;
    if (snapshot) {
      tools.snapshot.tool = snapshot.tool.tool;
      tools.snapshot.first = undefined;
      tools.notify();
    }
  };
  async function exit() {
    const s = snapshot;
    run?.abort();
    run = undefined;
    entryRequest++;
    entry = undefined;
    renderer?.onBeforeUpdate?.remove(draw);
    hub.stopAdmissionTrace();
    walker?.dispose();
    walker = undefined;
    nav.leave();
    port.measuring = false;
    if (!s) {
      port.set('orbit');
      return;
    }
    switching = true;
    try {
      const token = hub.claim('orbit', scope.session.generation);
      if (frameValid())
        await restoreOrbit(cam, s.camera, () => scope.isCurrent() && hub.current === token);
      else {
        cam.controls.enabled = s.camera.enabled;
        state.viewState.stationOverview?.();
      }
      if (!scope.isCurrent()) return;
      hub.publish(token);
      await restoreSelection();
      if (!scope.isCurrent()) return;
      state.selection.patrolIsolation = undefined;
      await patrol!.visibility.setVisibility(
        {
          ...s.visibility,
          isolatedSelection: s.only ? (state.selection.selectionRequest?.id ?? null) : null,
        },
        scope.isCurrent,
      );
      if (!scope.isCurrent()) return;
      const distances = new Map(
        [...s.tool.distances, ...tools.snapshot.distances].map((d) => [d.id, d]),
      );
      tools.snapshot = { ...s.tool, distances: [...distances.values()] };
      tools.notify();
    } finally {
      if (scope.isCurrent()) {
        cam.controls.enabled = s.camera.enabled;
        state.viewState.viewHistory?.resume?.();
        port.set('orbit');
      }
      switching = false;
      interrupted = undefined;
      snapshot = undefined;
    }
  }
  async function execute(action: NavigationAction) {
    if (!scope.isCurrent()) return;
    if (switching) {
      if (action === 'exit' || (action === 'pause' && interrupted !== 'exit')) interrupted = action;
      return;
    }
    if (action === 'exit') {
      ++doorSequence;
      doorHint(false);
      await exit();
      return;
    }
    if (action === 'prepare' && port.mode === 'orbit') {
      if (batch !== state.geometryLoadToken) {
        nav.dispose();
        batch = state.geometryLoadToken;
        nav = new PatrolNavigationRuntime(state, state.captureProjectSession());
      }
      run = new AbortController();
      frame = state.projectCoordinateFrame;
      port.set('preparing', '点击道路、地坪或楼梯平台选择巡视入口');
      return;
    }
    const owner = run;
    if (!owner || !alive(owner)) return;
    if (action === 'pause') {
      if (!walker) {
        await exit();
        return;
      }
      entryRequest++;
      port.set('paused');
      walker?.stop();
      endMeasurement();
      await restoreSelection();
      return;
    }
    if (!frameValid()) {
      port.set('paused', '坐标框架或几何批次已变更，请退出后重新选择入口');
      walker?.stop();
      return;
    }
    if (action === 'start' && port.mode === 'ready' && entry && frame) {
      switching = true;
      try {
        snapshot = capture();
        if (snapshot.only)
          state.selection.patrolIsolation = {
            engineering: state.selection.engineeringSelection,
            representation: state.selection.representationSelection,
          };
        state.viewState.viewHistory?.interruptRestore();
        freezeOrbit(cam, snapshot.camera);
        state.viewState.viewHistory?.suspend?.();
        state.viewState.cameraNavigationVersion++;
        state.viewState.viewerUserInteracted = true;
        walker = new FirstPersonController(
          ctx,
          canvas!,
          port,
          nav,
          frame.matrix.clone(),
          entry,
          scope.session.generation,
          frameValid,
          owner.signal,
        );
        // Request pointer lock while the toolbar click still carries activation.
        walker.walk();
        await cam.projection.set('Perspective');
        if (!alive(owner)) return;
        trace = hub.startAdmissionTrace();
        drawCount = 0;
        renderer?.onBeforeUpdate?.add(draw);
        walker.takeCamera();
        if ((!document.hasFocus() || document.hidden) && !interrupted) interrupted = 'pause';
      } finally {
        switching = false;
      }
      if (interrupted) {
        const action = interrupted;
        interrupted = undefined;
        await execute(action);
      }
    } else if (action === 'resume' && walker) {
      endMeasurement();
      walker.walk();
      refreshDoor();
      await restoreSelection();
    } else if (action === 'door' && walker && port.mode === 'walking' && !doorBusy) {
      doorBusy = true;
      try {
        const id = await doorUnderCrosshair();
        if (!id || !alive(owner) || port.mode !== 'walking') return;
        port.set('paused', '正在检查门扇扫掠空间');
        walker.stop();
        const message = await nav.toggleDoor(id, walker.feet.clone(), owner.signal);
        if (alive(owner)) port.set('paused', message);
      } finally {
        doorBusy = false;
      }
    } else if (action === 'inspect' && walker && port.mode === 'walking') {
      port.set('inspecting');
      walker.stop();
      inspectionChanged = true;
      await patrol!.inspect();
    } else if (action === 'measure' && walker) {
      port.measuring = true;
      tools.snapshot.first = undefined;
      tools.snapshot.tool = 'distance';
      tools.notify();
      port.set('inspecting', '点击两个可见表面测距');
    } else if (action === 'return' && walker && entry) {
      const seq = ++entryRequest;
      port.set('returning', '正在确认入口支撑与净空');
      walker.stop();
      await nav.prepare(entry, owner.signal);
      if (!alive(owner) || seq !== entryRequest) return;
      const result = nav.step(entry, entry);
      if ('reason' in result || result.sourceId !== source) {
        port.set('paused', '入口不可用，已保留当前位置');
        return;
      }
      walker.returnToEntry();
      port.set('paused', '已返回入口');
    }
  }
  async function choose(e: MouseEvent) {
    if (port.mode !== 'preparing' || e.button !== 0 || !run) return;
    const owner = run,
      seq = ++entryRequest;
    const current = () => alive(owner) && seq === entryRequest;
    frame = state.projectCoordinateFrame;
    if (
      !frame ||
      frame.confidence === 'unknown' ||
      frame.confidence === 'manual' ||
      !frameValid()
    ) {
      port.set('preparing', '导航数据不完整：工程坐标依据尚未确认');
      return;
    }
    try {
      const hit = await pickVisibleRay(
        ctx,
        state,
        canvas!,
        e.clientX,
        e.clientY,
        patrol!.clip(),
        true,
      );
      if (!current()) return;
      const points = [
        hit.devHit,
        hit.near,
        hit.result && {
          point: hit.result.point,
          distance: hit.result.rayDistance ?? hit.result.distance,
        },
      ];
      const p = points.filter((x) => x?.point).sort((a, b) => a!.distance - b!.distance)[0]?.point;
      if (!p) {
        port.set('preparing', '请点击可见的道路或楼面');
        return;
      }
      const feet = p.clone().applyMatrix4(frame.matrix.clone().invert());
      port.set('preparing', '正在准备入口的地面与障碍数据');
      const started = performance.now();
      await nav.prepare(feet, owner.signal);
      coverageMs = performance.now() - started;
      if (!current() || !frameValid()) return;
      const result = nav.step(feet, feet);
      if ('reason' in result) {
        port.set('preparing', result.reason + '，可另选入口');
        return;
      }
      entry = result.feet;
      source = result.sourceId;
      port.set(
        'ready',
        nav.metrics.estimatedSectionOccurrences
          ? '入口已就绪 · 工程含估算型材截面'
          : '入口地面和障碍数据已就绪',
      );
    } catch (error) {
      if (current()) port.set('preparing', error instanceof Error ? error.message : String(error));
    }
  }
  canvas.addEventListener('click', choose, { signal: scope.signal });
  port.execute = (action) => {
    void execute(action).catch(async (error) => {
      if (!scope.isCurrent()) return;
      show(String(error));
      if (action === 'start') await exit();
      else {
        port.set('paused', String(error));
        walker?.stop();
      }
    });
  };
  scope.own(() => {
    renderer?.onBeforeUpdate?.remove(draw);
    hub.stopAdmissionTrace();
    port.evidence = undefined;
    unsubscribeDoor();
    clearTimeout(doorTimer);
    doorSequence++;
    doorHint(false);
    run?.abort();
    walker?.dispose();
    nav.dispose();
    if (snapshot) {
      cam.controls.enabled = snapshot.camera.enabled;
      Object.assign(cam.controls.mouseButtons, snapshot.camera.buttons);
    }
    hub.claim('orbit', state.projectGeneration);
    snapshot = undefined;
    state.selection.patrolIsolation = undefined;
    port.measuring = false;
    port.set('orbit');
  });
  port.execute('prepare');
}
