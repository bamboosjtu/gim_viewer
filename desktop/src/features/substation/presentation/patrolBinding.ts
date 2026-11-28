import { waitForBrowseScene } from './patrolPreparation.js';
import { bindPatrolDoorTarget } from './patrolDoorTarget.js';
import { Vector3 } from 'three';
import type { OrthoPerspectiveCamera } from '@thatopen/components';
import type { AppState } from '../../../app/state.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import { getViewerRuntimeWithUI } from '../../../services/presentation/viewerUIBinding.js';
import { pickVisibleRay } from '../../../viewer/selection.js';
import { cameraPoseHub } from '../../../viewer/cameraPoseHub.js';
import { freezeOrbit, restoreOrbit } from '../../../viewer/patrol/patrolContextSnapshot.js';
import type { PatrolPose } from '../../../viewer/patrol/navigationQueryPort.js';
import { FirstPersonController } from '../../../viewer/patrol/firstPersonController.js';
import { PatrolNavigationRuntime } from '../runtime/patrolNavigationRuntime.js';
import { capturePatrolWorkspace } from './patrolWorkspace.js';
import {
  PatrolOperationOwner,
  type PatrolOperationMode,
  restorePatrolContext,
} from '../../../viewer/patrol/patrolSessionController.js';
import {
  acceptsNavigationAction,
  type NavigationAction,
} from '../../../shared/viewerNavigationCommands.js';

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
  let entry: PatrolPose | undefined,
    home: PatrolPose | undefined,
    last: PatrolPose | undefined,
    planned: 'gate' | 'last' | 'manual' = 'manual',
    search: AbortController | undefined,
    entryRequest = 0,
    switching = false;
  const operations = new PatrolOperationOwner();
  const door = bindPatrolDoorTarget(
    ctx,
    state,
    canvas,
    patrol.clip,
    () => nav,
    () => scope.isCurrent(),
  );
  const unsubscribeDoor = hub.subscribe(door.refresh);
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
    door: nav.lastDoorCheck,
    coverageMs,
    startKind: planned,
    feet: walker?.feet.toArray(),
    home: home ? { feet: home.feet.toArray(), yaw: home.yaw, gate: port.gateHome } : undefined,
    estimatedSectionOccurrences: nav.metrics.estimatedSectionOccurrences,
    unknownSourceCount: nav.unknownSourceCount,
    drawCount,
    capped: walker?.capped,
    movement: summarize(walker?.tickMs ?? []),
    collision: summarize(nav.metrics.queryMs),
    admission: { dev: summarize(trace?.dev ?? []), ifc: summarize(trace?.ifc ?? []) },
    cache: {
      assetsBuilt: nav.metrics.assetBuilds,
      assetsHit: nav.metrics.assetHits,
      blocksPrepared: nav.metrics.blocks,
      sceneCacheHit: nav.metrics.fromCache,
      sceneCached: nav.metrics.persisted,
      sourcesPrepared: nav.metrics.sourcesPrepared,
      unavailableSources: nav.metrics.unavailableSources,
      residentSweepSteps: nav.metrics.residentSweepSteps,
      missingSweepSteps: nav.metrics.missingSweepSteps,
    },
  });
  port.evidence = evidence;
  let snapshot: ReturnType<typeof capturePatrolWorkspace> | undefined;
  let interrupted: 'pause' | 'exit' | undefined;
  const alive = (owner: AbortController | undefined) =>
    !!owner && owner === run && !owner.signal.aborted && scope.isCurrent();
  const frameValid = () =>
    scope.isCurrent() &&
    frame === state.projectCoordinateFrame &&
    state.projectSourceToViewerMatrix === frame?.matrix &&
    batch === state.geometryLoadToken;
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
    port.set('exiting', '正在恢复自由浏览');
    if (s) cam.controls.enabled = false;
    operations.cancel();
    if (walker && frameValid()) last = walker.position();
    search?.abort();
    search = undefined;
    run?.abort();
    run = undefined;
    ++entryRequest;
    entry = undefined;
    renderer?.onBeforeUpdate?.remove(draw);
    hub.stopAdmissionTrace();
    walker?.dispose();
    walker = undefined;
    port.measuring = port.estimated = port.compiling = false;
    port.unknownSourceCount = 0;
    const current = () => scope.isCurrent();
    try {
      const failures = await restorePatrolContext(current, [
        ['门扇', () => nav.leave()],
        [
          '相机',
          async () => {
            if (!s) return;
            const token = hub.claim('orbit', scope.session.generation);
            if (frameValid())
              await restoreOrbit(
                cam,
                { ...s.camera, enabled: false },
                () => current() && hub.current === token,
              );
            else state.viewState.stationOverview?.();
            if (current()) hub.publish(token);
          },
        ],
        ['选择', () => s?.restoreSelection()],
        ['显隐', () => s?.restoreVisibility()],
        ['工具', () => s?.restoreTools()],
      ]);
      if (current() && failures.length) show('已退出巡视，未能恢复' + failures.join('、'));
    } finally {
      if (current()) {
        if (s) {
          s.restoreGrid();
          Object.assign(cam.controls.mouseButtons, s.camera.buttons);
          cam.controls.enabled = s.camera.enabled;
          state.viewState.viewHistory?.resume?.();
        }
        port.set('orbit');
      }
      interrupted = undefined;
      snapshot = undefined;
    }
  }
  function ready(pose: PatrolPose, kind: typeof planned) {
    entry = pose;
    port.estimated = !!pose.estimated;
    planned = kind;
    port.pickingStart = false;
    const label =
      kind === 'last'
        ? '已定位上次巡视位置'
        : kind === 'gate'
          ? '已定位站区大门，面向站内'
          : '自选起点已就绪';
    port.set('ready', label);
  }
  function verified(pose: PatrolPose): PatrolPose | undefined {
    const hit = nav.step(pose.feet, pose.feet);
    if ('feet' in hit && hit.sourceId === pose.sourceId)
      return { ...pose, ...hit, estimated: hit.estimated };
  }
  async function prepareStart(owner: AbortController) {
    const ticket = ++entryRequest;
    const attempt = new AbortController();
    search = attempt;
    const signal = AbortSignal.any([owner.signal, attempt.signal]);
    const current = () => alive(owner) && ticket === entryRequest && !signal.aborted;
    port.compiling = true;
    const eligible = () => {
      if (!current()) return false;
      if (!frameValid()) throw Error('工程坐标或几何批次已变更，请重新选择入口');
      return true;
    };
    try {
      const started = performance.now();
      await waitForBrowseScene(state, signal);
      if (!current()) return;
      if (frame !== state.projectCoordinateFrame || batch !== state.geometryLoadToken) {
        home = last = undefined;
        port.gateHome = false;
      }
      if (batch !== state.geometryLoadToken) {
        nav.dispose();
        batch = state.geometryLoadToken;
        nav = new PatrolNavigationRuntime(state, state.captureProjectSession());
      }
      frame = state.projectCoordinateFrame;
      if (
        !frame ||
        frame.confidence === 'unknown' ||
        frame.confidence === 'manual' ||
        !frameValid()
      )
        throw Error('工程坐标依据尚未确认');
      port.browseReady = true;
      await nav.prepareScene(signal, (message, done, total) => {
        if (current()) {
          port.preparationProgress =
            done !== undefined && total !== undefined ? { done, total } : undefined;
          port.set('preparing', message);
        }
      });
      if (!eligible()) return;
      port.compiling = false;
      port.unknownSourceCount = nav.unknownSourceCount;
      if (last) {
        const saved = verified(last);
        if (!eligible()) return;
        if (saved) {
          coverageMs = performance.now() - started;
          ready(saved, 'last');
          return;
        }
        last = undefined;
      }
      const gate = await nav.stationEntrance(signal);
      if (!eligible()) return;
      if (gate) {
        home = gate;
        port.gateHome = true;
        coverageMs = performance.now() - started;
        ready(gate, 'gate');
        return;
      }
      if (home && !port.gateHome) {
        const saved = verified(home);
        if (!eligible()) return;
        if (saved) {
          coverageMs = performance.now() - started;
          ready(saved, 'manual');
          return;
        }
      }
      home = undefined;
      port.gateHome = false;
      port.pickingStart = true;
      port.set('preparing', '未找到可用的站区大门落脚点，请点击道路或楼面选择起点');
    } catch (error) {
      if (current()) {
        port.compiling = false;
        port.pickingStart = false;
        port.set('failed', error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (search === attempt) search = undefined;
    }
  }
  async function execute(action: NavigationAction) {
    if (!scope.isCurrent()) return;
    if (switching) {
      if (action === 'exit' || (action === 'pause' && interrupted !== 'exit')) interrupted = action;
      return;
    }
    if (!acceptsNavigationAction(port.mode, action)) return;
    if (action === 'exit') {
      door.reset();
      await exit();
      return;
    }
    if (action === 'prepare' && port.mode === 'orbit') {
      run = new AbortController();
      entry = undefined;
      port.pickingStart = false;
      port.compiling = true;
      port.browseReady = false;
      port.preparationProgress = undefined;
      port.set('preparing', '正在准备离线巡视场景…');
      await prepareStart(run);
      return;
    }
    const owner = run;
    if (!owner || !alive(owner)) return;
    if (
      action === 'pickStart' &&
      !port.compiling &&
      (port.mode === 'preparing' || port.mode === 'ready')
    ) {
      ++entryRequest;
      search?.abort();
      entry = undefined;
      port.pickingStart = true;
      port.set('preparing', '点击道路、地坪或楼梯平台选择起点');
      return;
    }
    const operate = (
      mode: PatrolOperationMode,
      message: string,
      work: (signal: AbortSignal) => Promise<() => void>,
    ) =>
      operations.run(
        port,
        owner.signal,
        mode,
        message,
        () => walker!.stop(),
        work,
        (error) => {
          if (alive(owner) && walker) port.set('paused', error);
        },
      );
    if (action === 'pause') {
      if (!walker) {
        await exit();
        return;
      }
      await operate('restoringSelection', '正在恢复巡视选择', async () => {
        endMeasurement();
        await snapshot?.restoreSelection();
        return () => port.set('paused');
      });
      return;
    }
    if (!frameValid()) {
      if (walker) {
        port.set('paused', '坐标框架或几何批次已变更，请退出后重新选择入口');
        walker.stop();
      } else {
        await exit();
        show('坐标框架或几何批次已变更，请重新选择入口');
      }
      return;
    }
    if (action === 'start' && port.mode === 'ready' && entry && frame) {
      switching = true;
      try {
        snapshot = capturePatrolWorkspace(state, scope, ctx, patrol!, show);
        snapshot.hideGrid();
        if (!home) home = entry;
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
      const person = walker;
      const resume = () => {
        person.walk();
        door.refresh();
      };
      endMeasurement();
      if (!snapshot?.needsSelectionRestore()) resume();
      else
        await operate('restoringSelection', '正在恢复巡视选择', async () => {
          await snapshot?.restoreSelection();
          return resume;
        });
    } else if (action === 'door' && walker) {
      const feet = walker.feet.clone();
      await operate('operatingDoor', '正在检查门扇扫掠空间', async (signal) => {
        const id = await door.pick();
        signal.throwIfAborted();
        const message = id ? await nav.toggleDoor(id, feet, signal) : '准星未命中可操作的门';
        return () => port.set('paused', message);
      });
    } else if (action === 'inspect' && walker) {
      await operate('pickingDevice', '正在检查准星设备', async () => {
        if (snapshot) snapshot.inspectionChanged = true;
        await patrol!.inspect();
        return () =>
          port.set('inspecting', port.message === '正在检查准星设备' ? '' : port.message);
      });
    } else if (action === 'measure' && walker) {
      port.measuring = true;
      tools.snapshot.first = undefined;
      tools.snapshot.tool = 'distance';
      tools.notify();
      port.set('inspecting', '点击两个可见表面测距');
    } else if (action === 'return' && walker && home) {
      const target = home,
        person = walker;
      await operate('returning', '正在确认入口支撑与净空', async (signal) => {
        endMeasurement();
        await snapshot?.restoreSelection();
        signal.throwIfAborted();
        const destination = verified(target);
        return () => {
          if (!destination || !frameValid()) {
            port.set('paused', '入口不可用，已保留当前位置');
            return;
          }
          person.relocate(destination);
          port.set('paused', port.gateHome ? '已返回站区大门' : '已返回巡视入口');
        };
      });
    }
  }
  async function choose(e: MouseEvent) {
    if (port.mode !== 'preparing' || !port.pickingStart || e.button !== 0 || !run) return;
    const owner = run,
      seq = ++entryRequest;
    const current = () => alive(owner) && seq === entryRequest;
    if (frame !== state.projectCoordinateFrame) {
      home = last = undefined;
      port.gateHome = false;
    }
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
      if (!frameValid()) return;
      const result = nav.step(feet, feet);
      if ('reason' in result) {
        port.set('preparing', result.reason + '，可另选入口');
        return;
      }
      const direction = cam.three
        .getWorldDirection(new Vector3())
        .transformDirection(frame.matrix.clone().invert());
      ready(
        {
          ...result,
          yaw: nav.inwardYaw(result.feet) ?? Math.atan2(direction.x, direction.y),
          pitch: 0,
        },
        'manual',
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
      if (action === 'exit') {
        port.set('orbit');
        return;
      }
      if (action === 'start' || !walker || !alive(run)) await exit();
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
    door.reset();
    operations.cancel();
    run?.abort();
    walker?.dispose();
    nav.dispose();
    if (snapshot) {
      snapshot.restoreGrid();
      cam.controls.enabled = snapshot.camera.enabled;
      Object.assign(cam.controls.mouseButtons, snapshot.camera.buttons);
    }
    port.gateHome = port.pickingStart = false;
    home = last = undefined;
    hub.claim('orbit', state.projectGeneration);
    snapshot = undefined;
    state.selection.patrolIsolation = undefined;
    port.measuring = port.compiling = false;
    port.set('orbit');
  });
  port.execute('prepare');
}
