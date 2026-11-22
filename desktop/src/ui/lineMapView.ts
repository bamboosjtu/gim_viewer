import {
  clamp,
  prepareLineMapGeometry,
  type RuntimeGeoPoint,
} from '../services/lineMapGeometry.js';
import { mountLineMapControls, LAYER_ITEMS, type LayerState } from './lineMapControls.js';
import { createLineMapRenderer } from './lineMapRenderer.js';
import { createLineMapPointer } from './lineMapPointer.js';
import type { LineMapSelection, LineMapViewport } from './lineMapPainter.js';
/**
 * M3-5：线路工程地图渲染层（纯 UI/DOM，Canvas 2D）。
 *
 * 将 LineMapData 渲染到指定 container：塔位 marker、导线折线、跨越点、
 * 经纬度网格、图例、比例尺，支持滚轮缩放（光标居中）、拖拽平移、
 * hover tooltip、点击塔位联动。
 *
 * 收口阶段增强：
 * - 图层开关（导线/地线/OPGW/未知/塔位/跨越点/标签），关闭图层后仅重绘
 * - 左侧树↔地图双向联动：focusTowerByNodePath / focusBboxByNodePaths
 * - 选中塔位高亮（amber 光晕）
 *
 * 分层边界（强制）：
 * - 属于 UI 层，禁止直接访问数据库
 * - 禁止读取 GIM 文件
 * - 禁止 import AppState
 * - 不创建 ViewerRuntime
 * - 不依赖 IFC / web-ifc / Fragments
 *
 * Canvas-only 使用 Web Mercator；MapLibre overlay 使用当前相机投影。
 * 绘制和命中共用导线屏幕路径，分帧任务与地图实例一同释放。
 *
 * BLHA 已在 M3-4 解析为 lat/lng，此处不再重新解析 BLHA。
 */

import type { LineMapData, TowerMarker, WireSegment } from '../gim/lineMapData.js';
import type { GimGraphNode } from '@gim/powerline-core/gimGraphTypes.js';
import type { LineMapProjection } from './lineMapProjection.js';
import { ENABLE_CATENARY } from '../config/features.js';
import { perfCurrentSession, type PerfSession } from '../utils/perfTimings.js';
import { bindLineMapCanvasInput } from './lineMapCanvasInput.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export interface LineMapViewHandle {
  /** 回到全景 bbox（重置 pan/zoom） */
  fit(): void;
  /** 释放 canvas/tooltip/事件监听/图层控件，清空内部引用 */
  destroy(): void;
  /** 定位到指定 nodePath 对应的单个塔位（高亮+居中+放大），找不到返回 false */
  focusTowerByNodePath(path: string): boolean;
  /** 定位到一组 nodePath 对应的塔位 bbox（居中+fit），找不到返回 false */
  focusBboxByNodePaths(paths: string[]): boolean;
  /** M4-A2：overlay 模式下由外部（MapLibre）转发 pointer move 事件 */
  handlePointerMove?(x: number, y: number): void;
  /** M4-A2：overlay 模式下由外部（MapLibre）转发 pointer click 事件 */
  handlePointerClick?(x: number, y: number): void;
  /** M4-A2：overlay 模式下由外部（MapLibre）转发 pointer leave 事件 */
  handlePointerLeave?(): void;
  /** 返回图层面板 DOM 元素（供外部附加底图切换控件等） */
  getLayerPanel?(): HTMLElement | null;
}

/** MapLibre overlay 的渲染阶段；Canvas-only 模式保持原有单阶段行为。 */
export type LineMapRenderPhase = 'interactive' | 'settled';

/**
 * M4-A2 / M4-B2：renderLineMap 可选参数。
 *
 * - projection：外部投影接口（MapLibre），传入后 geoToScreen 委托给它
 * - onRequestRedraw：调用方注册 redraw 回调，用于 MapLibre 视图变化时触发
 *   interactive/settled 两阶段 Canvas 重绘
 * - showGrid：是否绘制经纬度网格（overlay 默认 false，Canvas-only 默认 true）
 * - showCanvasScaleBar：是否绘制 Canvas 比例尺（overlay 默认 false，Canvas-only 默认 true）
 * - onWireClick：M4-B2 点击导线回调（命中导线且未命中塔位时触发）
 * - enableCatenary：覆盖默认悬链线开关，供真实样本 A/B；未传时保持 ENABLE_CATENARY 行为
 * - perfSession：性能会话快照；渐进绘制 span 只提交到该 session
 *
 * 默认（不传 options）：纯 Canvas 模式，行为完全不变。
 */
export interface RenderLineMapOptions {
  projection?: LineMapProjection;
  onRequestRedraw?: (draw: (phase?: LineMapRenderPhase) => void) => void;
  showGrid?: boolean;
  showCanvasScaleBar?: boolean;
  /** M4-B2：点击导线回调（优先级低于塔位） */
  onWireClick?: (wire: WireSegment) => void;
  /** P1-1：悬链线 A/B 覆盖；生产默认值仍来自 ENABLE_CATENARY。 */
  enableCatenary?: boolean;
  /** P1-2：性能会话快照，避免旧线路的异步绘制 span 污染新工程。 */
  perfSession?: PerfSession;
}

const FIT_PADDING = 48;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 200;
const FOCUS_TOWER_ZOOM = 12;

/** Owns the Canvas camera and delegates map-space movement to the overlay. */
function createLineMapCamera(
  geometry: ReturnType<typeof prepareLineMapGeometry>,
  viewport: LineMapViewport,
  selection: LineMapSelection,
  projection: LineMapProjection | undefined,
  pathToTower: ReadonlyMap<string, TowerMarker>,
  isDestroyed: () => boolean,
  renderer: () => ReturnType<typeof createLineMapRenderer>,
) {
  const {
    bbox,
    valid,
    mercY,
    centerLng,
    invMercY,
    centerWYAbs,
    centerWX,
    centerWY,
    getRuntimePoint,
  } = geometry;
  let panX = 0;
  let panY = 0;
  // ---- 投影 ----
  function projectCoordinate(point: RuntimeGeoPoint): { x: number; y: number } {
    if (projection) {
      const result = projection.project(point.lng, point.lat);
      return { x: result.x, y: result.y };
    }
    const s = viewport.baseScale * viewport.zoom;
    return {
      x: viewport.cssW / 2 + (point.worldX - centerWX) * s + panX,
      y: viewport.cssH / 2 - (point.worldY - centerWY) * s + panY,
    };
  }

  function geoToScreen(lat: number, lng: number): { x: number; y: number } {
    return renderer().geoToScreenPoint(getRuntimePoint(lat, lng));
  }

  function screenToWorldGeo(sx: number, sy: number): { lat: number; lng: number } {
    // M4-A2：overlay 模式委托给外部投影（MapLibre unproject）
    if (projection?.unproject) {
      const geo = projection.unproject(sx, sy);
      return { lat: geo.lat, lng: geo.lng };
    }
    const s = viewport.baseScale * viewport.zoom;
    const wx = centerWX + (sx - viewport.cssW / 2 - panX) / s;
    const wy = centerWY - (sy - viewport.cssH / 2 - panY) / s;
    return { lat: invMercY(wy + centerWYAbs), lng: wx + centerLng };
  }

  function zoomAt(mx: number, my: number, factor: number): void {
    if (!valid) return;
    const before = screenToWorldGeo(mx, my);
    viewport.zoom = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = geoToScreen(before.lat, before.lng);
    panX += mx - after.x;
    panY += my - after.y;
    renderer().draw();
  }

  // ---- 公开方法 ----
  function fit(): void {
    if (isDestroyed()) return;
    selection.selectedTowerPaths = new Set();
    selection.selectedWire = null;
    // M4-A2：overlay 模式下视图由 MapLibre 管理，委托 fitBounds
    if (projection?.fitBounds && valid) {
      projection.fitBounds({
        minLng: bbox.minLng,
        minLat: bbox.minLat,
        maxLng: bbox.maxLng,
        maxLat: bbox.maxLat,
      });
      renderer().requestInteractiveFrame(true);
      renderer().requestSettledFrame();
      return;
    }
    viewport.zoom = 1;
    panX = 0;
    panY = 0;
    renderer().draw();
  }

  /** 定位到单个塔位：居中 + 放大 + 高亮 */
  function focusTowerByNodePath(path: string): boolean {
    if (isDestroyed() || !valid) return false;
    const t = pathToTower.get(path);
    if (!t) return false;
    selection.selectedTowerPaths = new Set([path]);
    selection.hoveredTower = t;
    // M4-A2：overlay 模式下委托 MapLibre fitBounds（单塔小范围 bbox）
    if (projection?.fitBounds) {
      const pad = 0.002;
      projection.fitBounds({
        minLng: t.lng - pad,
        minLat: t.lat - pad,
        maxLng: t.lng + pad,
        maxLat: t.lat + pad,
      });
      renderer().requestInteractiveFrame(true);
      renderer().requestSettledFrame();
      return true;
    }
    viewport.zoom = clamp(FOCUS_TOWER_ZOOM, MIN_ZOOM, MAX_ZOOM);
    const s = viewport.baseScale * viewport.zoom;
    const wx = t.lng - centerLng;
    const wy = mercY(t.lat) - centerWYAbs;
    panX = -(wx - centerWX) * s;
    panY = (wy - centerWY) * s;
    renderer().draw();
    return true;
  }

  /** 定位到一组塔位的 bbox：fit + 高亮 */
  function focusBboxByNodePaths(paths: string[]): boolean {
    if (isDestroyed() || !valid) return false;
    const towers: TowerMarker[] = [];
    for (const p of paths) {
      const t = pathToTower.get(p);
      if (t) towers.push(t);
    }
    if (towers.length === 0) return false;

    // 子 bbox（geo 坐标）
    let minLat = Infinity,
      maxLat = -Infinity,
      minLng = Infinity,
      maxLng = -Infinity;
    for (const t of towers) {
      minLat = Math.min(minLat, t.lat);
      maxLat = Math.max(maxLat, t.lat);
      minLng = Math.min(minLng, t.lng);
      maxLng = Math.max(maxLng, t.lng);
    }
    // 给 bbox 留 padding（避免塔位贴边）
    const latSpan = maxLat - minLat || 0.002;
    const lngSpan = maxLng - minLng || 0.002;
    minLat -= latSpan * 0.2;
    maxLat += latSpan * 0.2;
    minLng -= lngSpan * 0.2;
    maxLng += lngSpan * 0.2;

    selection.selectedTowerPaths = new Set(paths);

    // M4-A2：overlay 模式下委托 MapLibre fitBounds
    if (projection?.fitBounds) {
      projection.fitBounds({ minLng, minLat, maxLng, maxLat });
      renderer().requestInteractiveFrame(true);
      renderer().requestSettledFrame();
      return true;
    }

    // 子 bbox（world 坐标，Web Mercator）
    const subMinWX = minLng - centerLng;
    const subMaxWX = maxLng - centerLng;
    const subMinWY = mercY(minLat) - centerWYAbs;
    const subMaxWY = mercY(maxLat) - centerWYAbs;
    const subW = Math.max(subMaxWX - subMinWX, 1e-9);
    const subH = Math.max(subMaxWY - subMinWY, 1e-9);
    const subCenterWX = (subMinWX + subMaxWX) / 2;
    const subCenterWY = (subMinWY + subMaxWY) / 2;

    // 计算缩放级别，使子 bbox 填满扣除边距后的视口。
    const availW = Math.max(viewport.cssW - 2 * FIT_PADDING, 1);
    const availH = Math.max(viewport.cssH - 2 * FIT_PADDING, 1);
    viewport.zoom = clamp(
      Math.min(availW / subW, availH / subH) / viewport.baseScale,
      MIN_ZOOM,
      MAX_ZOOM,
    );

    // pan 使子 bbox 中心居中
    const s = viewport.baseScale * viewport.zoom;
    panX = -(subCenterWX - centerWX) * s;
    panY = (subCenterWY - centerWY) * s;

    renderer().draw();
    return true;
  }

  return {
    fit,
    zoomAt,
    projectCoordinate,
    focusTowerByNodePath,
    focusBboxByNodePaths,
    getPan: () => ({ x: panX, y: panY }),
    panTo: (x: number, y: number) => {
      panX = x;
      panY = y;
      renderer().draw();
    },
  };
}

/**
 * 在 container 内渲染线路工程 2D 地图。
 *
 * @param mapData extractLineMapData 提取结果
 * @param container 宿主 DOM（canvas 将作为子元素填充）
 * @param onTowerClick 点击塔位时的回调，参数为该塔位对应的图节点
 * @param options M4-A2：projection（外部投影）+ onRequestRedraw（注册重绘回调）；
 *                M4-B2：onWireClick（点击导线回调，命中导线且未命中塔位时触发）
 * @returns LineMapViewHandle，调用方负责在切换/清空时 destroy()
 */
export function renderLineMap(
  mapData: LineMapData,
  container: HTMLElement,
  onTowerClick: (node: GimGraphNode) => void,
  options?: RenderLineMapOptions,
): LineMapViewHandle {
  // ---- M4-A2：投影模式判断 ----
  const projection = options?.projection;
  const overlayMode = !!projection; // MapLibre 底图 + Canvas overlay 模式
  // M4-A2：overlay 模式默认隐藏网格和 Canvas 比例尺（MapLibre 提供 ScaleControl）
  const showGrid = options?.showGrid ?? !overlayMode;
  const showCanvasScaleBar = options?.showCanvasScaleBar ?? !overlayMode;
  const enableCatenary = options?.enableCatenary ?? ENABLE_CATENARY;
  const perfSession = options?.perfSession ?? perfCurrentSession();

  const { canvas, ctx, tooltip, fitBtn, layerPanel, layerCheckboxes } = mountLineMapControls(
    container,
    overlayMode,
  );

  // ---- 投影参数（fit 基准） ----
  // Canvas-only 兜底路径采用 Web Mercator（与 MapLibre/OSM 一致），
  // 替代原等距圆柱投影：等距投影纬线间距恒定，中高纬度东西向被压缩、
  // 形状畸变；Web Mercator 局部形状保真（正形），与主底图形态一致。
  const geometry = prepareLineMapGeometry(mapData, enableCatenary);
  const { worldW, worldH } = geometry;

  // ---- 视图状态 ----
  const layerState: LayerState = {
    conductor: true,
    groundwire: true,
    opgw: true,
    unknownWire: true,
    tower: true,
    cross: true,
    label: true,
  };
  const viewport: LineMapViewport = { cssW: 0, cssH: 0, dpr: 1, baseScale: 1, zoom: 1 };
  const selection: LineMapSelection = {
    hoveredTower: null,
    selectedWire: null,
    selectedTowerPaths: new Set(),
  };
  let destroyed = false;

  /** nodePath → TowerMarker 索引（供 focus 查找用） */
  const pathToTower = new Map<string, TowerMarker>();
  for (const t of mapData.towers) {
    if (t.nodeRef && t.nodeRef.path) pathToTower.set(t.nodeRef.path, t);
  }

  const camera = createLineMapCamera(
    geometry,
    viewport,
    selection,
    projection,
    pathToTower,
    () => destroyed,
    () => renderer,
  );
  const renderer: ReturnType<typeof createLineMapRenderer> = createLineMapRenderer({
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
    projectCoordinate: camera.projectCoordinate,
  });
  const { draw, requestInteractiveFrame, requestSettledFrame } = renderer;
  const pointer = createLineMapPointer({
    canvas,
    tooltip,
    layerState,
    geometry,
    viewport,
    selection,
    overlayMode,
    onTowerClick,
    onWireClick: options?.onWireClick,
    geoToScreenPoint: renderer.geoToScreenPoint,
    drawnTowers: renderer.drawnTowers,
    requestVisualRender: renderer.requestVisualRender,
  });

  // ---- 尺寸 / DPR ----
  function resize(): void {
    if (destroyed) return;
    const wasInitialized = viewport.cssW > 0 && viewport.cssH > 0;
    const rect = container.getBoundingClientRect();
    viewport.cssW = Math.max(rect.width, 1);
    viewport.cssH = Math.max(rect.height, 1);
    viewport.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewport.cssW * viewport.dpr);
    canvas.height = Math.round(viewport.cssH * viewport.dpr);
    canvas.style.width = viewport.cssW + 'px';
    canvas.style.height = viewport.cssH + 'px';
    // 计算 fit 基准 scale
    const availW = Math.max(viewport.cssW - 2 * FIT_PADDING, 1);
    const availH = Math.max(viewport.cssH - 2 * FIT_PADDING, 1);
    viewport.baseScale = Math.min(availW / worldW, availH / worldH);
    if (overlayMode && wasInitialized) {
      // ResizeObserver 触发时 MapLibre 可能尚未发出 resize 事件；主动
      // 让缓存失效并安排一帧轻量重绘，随后补一轮完整 settled 绘制。
      requestInteractiveFrame(true);
      requestSettledFrame();
    } else {
      draw();
    }
  }

  // ---- 图层开关事件 ----
  const layerEvents = new AbortController();
  for (let i = 0; i < LAYER_ITEMS.length; i++) {
    const item = LAYER_ITEMS[i];
    const cb = layerCheckboxes[i];
    cb.addEventListener(
      'change',
      () => {
        layerState[item.key] = cb.checked;
        // 关闭塔位图层时清除 hover，避免 tooltip 残留
        if (item.key === 'tower' && !cb.checked) {
          pointer.clearTowerHover();
        }
        draw();
      },
      { signal: layerEvents.signal },
    );
  }

  // 向调用方注册 redraw 回调，供 MapLibre 视图变化时触发 Canvas 重绘。
  // 默认 phase=interactive，兼容旧调用方和测试替身。
  if (options?.onRequestRedraw) {
    options.onRequestRedraw((phase: LineMapRenderPhase = 'interactive') => {
      if (phase === 'settled') requestSettledFrame();
      else requestInteractiveFrame(true);
    });
  }

  const onFitBtnClick = () => camera.fit();

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    renderer.destroy();
    pointer.destroy();
    disposeCanvasInput();
    fitBtn.removeEventListener('click', onFitBtnClick);
    layerEvents.abort();
    if (resizeObserver) resizeObserver.disconnect();
    // WebView2 can retain the last compositor surface of a removed canvas for a
    // frame. Clear and collapse it before detaching so a line map cannot bleed
    // its grid/tiles over the next map or the station WebGL canvas.
    try {
      // Resizing clears the backing store without a tracked ctx.clearRect.
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      /* ignore */
    }
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
    if (fitBtn.parentNode) fitBtn.parentNode.removeChild(fitBtn);
    if (layerPanel.parentNode) layerPanel.parentNode.removeChild(layerPanel);
    selection.selectedWire = null;
    selection.selectedTowerPaths.clear();
    pathToTower.clear();
  }

  // ---- 绑定事件 ----
  const disposeCanvasInput = bindLineMapCanvasInput(canvas, {
    getPan: camera.getPan,
    panTo: camera.panTo,
    zoomAt: camera.zoomAt,
    hover: pointer.handlePointerMove,
    click: pointer.handlePointerClick,
    leave: pointer.handlePointerLeave,
    fit: camera.fit,
    hasHover: pointer.hasHover,
  });
  fitBtn.addEventListener('click', onFitBtnClick);

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(container);

  // 首次绘制
  resize();

  return {
    fit: camera.fit,
    destroy,
    focusTowerByNodePath: camera.focusTowerByNodePath,
    focusBboxByNodePaths: camera.focusBboxByNodePaths,
    handlePointerMove: pointer.handlePointerMove,
    handlePointerClick: pointer.handlePointerClick,
    handlePointerLeave: pointer.handlePointerLeave,
    getLayerPanel: () => (destroyed ? null : layerPanel),
  };
}
