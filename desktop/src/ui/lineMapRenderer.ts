import { COLOR_BG } from './lineMapBackground.js';
import { perfBegin, perfMark, type PerfSession } from '../utils/perfTimings.js';
import type {
  prepareLineMapGeometry,
  RuntimeGeoPoint,
} from '../features/powerline/presentation/lineMapGeometry.js';
import {
  lineMapStageBatchSize,
  runLineMapStageSlice,
  type LineMapStage,
} from '../features/powerline/presentation/lineMapStages.js';
import {
  createLineMapPainter,
  type LineMapSelection,
  type LineMapViewport,
} from './lineMapPainter.js';
import type { LayerState } from './lineMapControls.js';

type ScheduledFrame = {
  id: number;
  kind: 'raf' | 'timeout';
};

// ---------------------------------------------------------------------------
// 渲染主函数
// ---------------------------------------------------------------------------

/** requestAnimationFrame 的可测试/可降级包装。 */
function scheduleFrame(callback: FrameRequestCallback): ScheduledFrame {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return { id: window.requestAnimationFrame(callback), kind: 'raf' };
  }
  const id =
    typeof window !== 'undefined'
      ? window.setTimeout(() => callback(performance.now()), 0)
      : (setTimeout(() => callback(performance.now()), 0) as unknown as number);
  return { id, kind: 'timeout' };
}

function cancelScheduledFrame(frame: ScheduledFrame | null): void {
  if (!frame) return;
  if (
    frame.kind === 'raf' &&
    typeof window !== 'undefined' &&
    typeof window.cancelAnimationFrame === 'function'
  ) {
    window.cancelAnimationFrame(frame.id);
    return;
  }
  if (typeof window !== 'undefined') window.clearTimeout(frame.id);
  else clearTimeout(frame.id as unknown as ReturnType<typeof setTimeout>);
}

/**
 * 仅供开发期性能采集器判断渐进地图是否已经补绘完成。
 *
 * 该标志不参与业务逻辑，也不在生产构建中写入；每次新的 draw pass
 * 开始时重置，最后一个标签批次完成后置 true。这样采集器可以把“首帧
 * 可见”与“地图对象全部补齐”分开，而不会用固定 sleep 猜测完成时间。
 */
function setDevMapRenderState(token: number, done: boolean, runId: string | null): void {
  if (!import.meta.env.DEV) return;
  const globals = globalThis as {
    __GIM_DEV_LINE_MAP_RENDER_DONE__?: boolean;
    __GIM_DEV_LINE_MAP_RENDER_STATE__?: { token: number; done: boolean; runId: string | null };
  };
  // 保留旧的 boolean 供已有诊断脚本/手工检查使用，同时提供 token，
  // 让采集器不会把上一轮 Canvas handle 的完成状态误认为当前轮完成。
  globals.__GIM_DEV_LINE_MAP_RENDER_DONE__ = done;
  globals.__GIM_DEV_LINE_MAP_RENDER_STATE__ = { token, done, runId };
}

interface LineMapRendererOptions {
  ctx: CanvasRenderingContext2D;
  geometry: ReturnType<typeof prepareLineMapGeometry>;
  viewport: LineMapViewport;
  layerState: LayerState;
  selection: LineMapSelection;
  overlayMode: boolean;
  showGrid: boolean;
  showCanvasScaleBar: boolean;
  enableCatenary: boolean;
  perfSession: PerfSession;
  projectCoordinate: (point: RuntimeGeoPoint) => { x: number; y: number };
}

/** Owns frame cadence, projection cache, drawing and cancellation for one Canvas. */
export function createLineMapRenderer({
  ctx,
  geometry,
  viewport,
  layerState,
  selection,
  overlayMode,
  showGrid,
  showCanvasScaleBar,
  enableCatenary,
  perfSession,
  projectCoordinate,
}: LineMapRendererOptions) {
  const { valid, runtimeTowers, runtimeWires, runtimeCrosses } = geometry;
  let destroyed = false;
  /** 渐进绘制代次；settled 重绘或销毁时取消旧 RAF。 */
  let renderGeneration = 0;
  let pendingFrame: ScheduledFrame | null = null;
  let pendingInteractionFrame: ScheduledFrame | null = null;
  let pendingSettledFrame: ScheduledFrame | null = null;
  let activePhaseEnd: ((labelSuffix?: string, endMeta?: Record<string, unknown>) => void) | null =
    null;
  let instrumentNextRender = true;
  /** MapLibre 相机变化期间使用轻量交互帧；停止后才启动完整 progressive。 */
  let progressiveActive = false;
  let interactionActive = false;
  let interactionRequestStartedAt: number | null = null;
  /** MapLibre move/zoom/resize 每次变化递增；所有投影缓存必须绑定该 revision。 */
  let cameraRevision = 0;
  let activeDevRenderToken = 0;
  let devRenderTokenSequence = 0;
  let activeDevRenderRunId: string | null = null;
  /** 只在同一 camera revision 内复用投影结果；相机变化或新交互帧会重建。 */
  let frameProjectionCache: {
    revision: number;
    points: Map<string, { x: number; y: number }>;
  } | null = null;

  // Picking and drawing share the cache for the current camera revision.
  function geoToScreenPoint(point: RuntimeGeoPoint): { x: number; y: number } {
    if (!overlayMode) return projectCoordinate(point);
    if (frameProjectionCache?.revision !== cameraRevision) {
      frameProjectionCache = { revision: cameraRevision, points: new Map() };
    }
    const cached = frameProjectionCache.points.get(point.key);
    if (cached) return cached;
    const result = projectCoordinate(point);
    frameProjectionCache.points.set(point.key, result);
    return result;
  }

  const painter = createLineMapPainter(
    ctx,
    geometry,
    viewport,
    layerState,
    selection,
    geoToScreenPoint,
  );

  // ---- 绘制 ----
  function draw(): void {
    if (destroyed) return;
    cancelProgressiveRender();
    cancelScheduledFrame(pendingInteractionFrame);
    pendingInteractionFrame = null;
    cancelScheduledFrame(pendingSettledFrame);
    pendingSettledFrame = null;
    interactionRequestStartedAt = null;
    interactionActive = false;
    const generation = renderGeneration;
    const cameraSnapshot = cameraRevision;
    activeDevRenderToken = ++devRenderTokenSequence;
    const devGlobals = globalThis as { __GIM_DEV_LINE_MAP_RENDER_RUN_ID__?: unknown };
    activeDevRenderRunId =
      typeof devGlobals.__GIM_DEV_LINE_MAP_RENDER_RUN_ID__ === 'string'
        ? devGlobals.__GIM_DEV_LINE_MAP_RENDER_RUN_ID__
        : null;
    setDevMapRenderState(activeDevRenderToken, false, activeDevRenderRunId);
    const instrument = instrumentNextRender;
    const endFirstFrame = instrument ? perfBegin('线路 Canvas 首帧', undefined, perfSession) : null;

    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    frameProjectionCache = { revision: cameraRevision, points: new Map() };
    // 背景：overlay 模式下透明（让 MapLibre 底图透出），Canvas-only 模式填色
    if (overlayMode) {
      ctx.clearRect(0, 0, viewport.cssW, viewport.cssH);
    } else {
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, viewport.cssW, viewport.cssH);
    }

    if (!valid) {
      painter.drawEmptyHint('未提取到可定位塔位');
      painter.drawBorder();
      frameProjectionCache = null;
      endFirstFrame?.(undefined, { progressive: false, valid: false });
      if (instrument) instrumentNextRender = false;
      setDevMapRenderState(activeDevRenderToken, true, activeDevRenderRunId);
      return;
    }

    if (showGrid) painter.drawGrid();
    if (showCanvasScaleBar) painter.drawScaleBar();
    painter.drawLegend();
    painter.drawBorder();

    // 这一步只绘制静态背景，保证 renderLineMap 返回后马上有可见首帧。
    // 塔位/导线/跨越物/标签在后续 requestAnimationFrame 中分批补齐。
    endFirstFrame?.(undefined, {
      progressive: true,
      towers: runtimeTowers.length,
      wires: runtimeWires.length,
      crosses: runtimeCrosses.length,
    });
    startProgressiveRender(generation, cameraSnapshot, instrument);
  }

  /** 清空 overlay 并绘制当前相机下的轻量交互层。 */
  function drawInteractiveFrame(revision: number): void {
    if (destroyed || !overlayMode) return;
    if (revision !== cameraRevision) {
      requestInteractiveFrame(false);
      return;
    }

    activeDevRenderToken = ++devRenderTokenSequence;
    const devGlobals = globalThis as { __GIM_DEV_LINE_MAP_RENDER_RUN_ID__?: unknown };
    activeDevRenderRunId =
      typeof devGlobals.__GIM_DEV_LINE_MAP_RENDER_RUN_ID__ === 'string'
        ? devGlobals.__GIM_DEV_LINE_MAP_RENDER_RUN_ID__
        : null;
    setDevMapRenderState(activeDevRenderToken, false, activeDevRenderRunId);

    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    // 交互帧每次都建立新的 revision-scoped cache；不携带上一帧的屏幕坐标。
    frameProjectionCache = { revision, points: new Map() };
    ctx.clearRect(0, 0, viewport.cssW, viewport.cssH);
    if (!valid) {
      painter.drawEmptyHint('未提取到可定位塔位');
      painter.drawBorder();
      frameProjectionCache = null;
      interactionRequestStartedAt = null;
      return;
    }

    // 底图由 MapLibre 提供，交互态只绘制必要工程元素；标签和悬链线
    // 留给 moveend/zoomend 后的 settled progressive pass。
    painter.drawLegend();
    painter.drawBorder();
    painter.resetTowers();
    painter.drawTowerRange(0, runtimeTowers.length);
    painter.drawWireRange(0, runtimeWires.length, true);
    painter.drawSelectedWire(true);
    painter.drawCrossRange(0, runtimeCrosses.length);

    frameProjectionCache = null;
    const latencyMs =
      interactionRequestStartedAt == null
        ? null
        : Math.max(0, performance.now() - interactionRequestStartedAt);
    interactionRequestStartedAt = null;
    // 同一 RAF 内不会被 MapLibre 插入新事件；结束后再次检查 revision，
    // 防止测试替身或同步 fitBounds 触发的旧 camera frame 继续写入。
    if (revision !== cameraRevision) {
      requestInteractiveFrame(false);
      return;
    }
    if (latencyMs != null) {
      perfMark(
        '线路 Canvas 交互帧',
        {
          cameraRevision: revision,
          latencyMs: Math.round(latencyMs * 100) / 100,
          towers: runtimeTowers.length,
          wires: runtimeWires.length,
          crosses: runtimeCrosses.length,
        },
        perfSession,
      );
    }
  }

  /** 终止当前渐进绘制并释放帧内投影缓存。 */
  function cancelProgressiveRender(): void {
    renderGeneration += 1;
    cancelScheduledFrame(pendingFrame);
    pendingFrame = null;
    if (activePhaseEnd) {
      activePhaseEnd('（取消）');
      activePhaseEnd = null;
    }
    progressiveActive = false;
    frameProjectionCache = null;
  }

  function beginProgressivePhase(label: string, instrument: boolean): void {
    activePhaseEnd = instrument ? perfBegin(label, undefined, perfSession) : null;
  }

  function finishProgressivePhase(meta: Record<string, unknown>): void {
    activePhaseEnd?.(undefined, meta);
    activePhaseEnd = null;
  }

  function scheduleProgressive(
    generation: number,
    cameraSnapshot: number,
    stage: LineMapStage,
    offset: number,
    instrument: boolean,
  ): void {
    pendingFrame = scheduleFrame(() => {
      pendingFrame = null;
      runProgressiveStage(generation, cameraSnapshot, stage, offset, instrument);
    });
  }

  function startProgressiveRender(
    generation: number,
    cameraSnapshot: number,
    instrument: boolean,
  ): void {
    progressiveActive = true;
    painter.resetProgressive();
    beginProgressivePhase('线路 Canvas 塔位分批绘制', instrument);
    scheduleProgressive(generation, cameraSnapshot, 'towers', 0, instrument);
  }

  function runProgressiveStage(
    generation: number,
    cameraSnapshot: number,
    stage: LineMapStage,
    offset: number,
    instrument: boolean,
  ): void {
    if (destroyed || generation !== renderGeneration || cameraSnapshot !== cameraRevision) return;
    const sourceLength =
      stage === 'towers'
        ? runtimeTowers.length
        : stage === 'wires'
          ? runtimeWires.length
          : stage === 'crosses'
            ? runtimeCrosses.length
            : painter.labelCount();
    const batchSize = lineMapStageBatchSize(stage);
    // 同时设置数量上限和时间预算，避免一条复杂悬链线或低端 WebView
    // 中的 Canvas 实现把一帧再次拉成长任务。
    const next = runLineMapStageSlice(offset, sourceLength, batchSize, (index) => {
      if (stage === 'towers') {
        painter.drawTowerRange(index, index + 1);
      } else if (stage === 'wires') {
        painter.drawWireRange(index, index + 1);
      } else if (stage === 'crosses') {
        painter.drawCrossRange(index, index + 1);
      } else {
        painter.drawLabelRange(index, index + 1);
      }
    });

    if (next < sourceLength) {
      scheduleProgressive(generation, cameraSnapshot, stage, next, instrument);
      return;
    }

    const stageMeta: Record<string, unknown> = { items: sourceLength, batchSize };
    if (stage === 'towers') {
      finishProgressivePhase(stageMeta);
      beginProgressivePhase('线路 Canvas 导线分批绘制', instrument);
      scheduleProgressive(generation, cameraSnapshot, 'wires', 0, instrument);
    } else if (stage === 'wires') {
      painter.drawSelectedWire();
      finishProgressivePhase({ ...stageMeta, catenary: enableCatenary });
      beginProgressivePhase('线路 Canvas 跨越物分批绘制', instrument);
      scheduleProgressive(generation, cameraSnapshot, 'crosses', 0, instrument);
    } else if (stage === 'crosses') {
      finishProgressivePhase(stageMeta);
      painter.prepareLabels();
      beginProgressivePhase('线路 Canvas 标签分批绘制', instrument);
      scheduleProgressive(generation, cameraSnapshot, 'labels', 0, instrument);
    } else {
      // 标签关闭或缩放不足时 sourceLength 为 0，也会在这里结束。
      finishProgressivePhase({
        ...stageMeta,
        visible: painter.labelsVisible(),
      });
      frameProjectionCache = null;
      if (instrument)
        perfMark(
          '线路 Canvas 地图绘制完成',
          {
            towers: runtimeTowers.length,
            wires: runtimeWires.length,
            crosses: runtimeCrosses.length,
          },
          perfSession,
        );
      progressiveActive = false;
      if (instrument) instrumentNextRender = false;
      setDevMapRenderState(activeDevRenderToken, true, activeDevRenderRunId);
    }
  }

  function requestInteractiveFrame(cameraChanged: boolean): void {
    if (destroyed) return;
    if (!overlayMode) {
      // Canvas-only 不引入两阶段调度，保持既有单阶段绘制与交互行为。
      draw();
      return;
    }
    if (cameraChanged) {
      cameraRevision += 1;
      interactionActive = true;
      // 以最近一次相机事件为延迟起点；连续 move/zoom 时不把整段手势
      // 累计成一个虚假的长延迟。
      interactionRequestStartedAt = performance.now();
      // 相机已改变，旧 progressive 的投影全部失效；只取消旧 pass，
      // 不在这里启动新的完整 pass，避免连续 move 让大线路永远停在塔位阶段。
      if (progressiveActive || pendingFrame || activePhaseEnd) {
        cancelProgressiveRender();
      }
      cancelScheduledFrame(pendingSettledFrame);
      pendingSettledFrame = null;
      // 保留已经排队的 interaction RAF，并在回调执行时读取最新
      // cameraRevision。MapLibre 可能每个 RAF 都发出 move/zoom；如果
      // 每次事件都取消并重新排队，事件恰好在 RAF 前到达时会造成交互帧
      // 饥饿，Canvas 反而无法持续跟随底图。
    } else if (progressiveActive || pendingFrame || activePhaseEnd) {
      // Hover/selection changes also replace the pixels on the overlay.  Do
      // not let a previously scheduled progressive stage draw on top of the
      // new interaction frame with stale ordering/state.
      cancelProgressiveRender();
    }
    if (pendingInteractionFrame) return;
    if (interactionRequestStartedAt == null) interactionRequestStartedAt = performance.now();
    pendingInteractionFrame = scheduleFrame(() => {
      pendingInteractionFrame = null;
      // 不捕获事件到达时的旧 revision；连续相机事件合并到这一帧时，
      // 只使用执行时的最新相机投影。
      drawInteractiveFrame(cameraRevision);
    });
  }

  function requestSettledFrame(): void {
    if (destroyed) return;
    if (!overlayMode) {
      draw();
      return;
    }
    interactionActive = false;
    if (pendingSettledFrame) return;
    const revision = cameraRevision;
    pendingSettledFrame = scheduleFrame(() => {
      pendingSettledFrame = null;
      if (destroyed || revision !== cameraRevision || interactionActive) return;
      draw();
    });
  }

  /** 请求一次视觉更新；MapLibre overlay 只绘制轻量交互帧，Canvas-only 维持原行为。 */
  function requestVisualRender(): void {
    if (!overlayMode) {
      draw();
      return;
    }

    // 悬停/选中也需要先用当前相机快速刷新；如果它打断了正在进行的
    // settled progressive pass，则排队一次完整补绘。相机仍在变化时不
    // 提前启动 settled，继续由 moveend/zoomend 统一触发。
    requestInteractiveFrame(false);
    if (!interactionActive) requestSettledFrame();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    cancelProgressiveRender();
    cancelScheduledFrame(pendingInteractionFrame);
    pendingInteractionFrame = null;
    cancelScheduledFrame(pendingSettledFrame);
    pendingSettledFrame = null;
    interactionRequestStartedAt = null;
    interactionActive = false;
    painter.resetProgressive();
  }

  return {
    draw,
    requestInteractiveFrame,
    requestSettledFrame,
    requestVisualRender,
    geoToScreenPoint,
    drawnTowers: painter.drawnTowers,
    destroy,
  };
}
