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
 * 等距矩形投影（小范围近似）：
 *   worldX(lng) = (lng - centerLng) * cos(centerLatRad)
 *   worldY(lat) = lat - centerLat
 *   再线性 fit 到 canvas 像素（bbox 居中、四周留边距，Canvas Y 轴向下需反转纬度）。
 *
 * BLHA 已在 M3-4 解析为 lat/lng，此处不再重新解析 BLHA。
 */

import type { LineMapData, TowerMarker, WireSegment } from '../gim/lineMapData.js';
import type { GimGraphNode } from '../gim/gimGraphTypes.js';
import type { LineMapProjection } from './lineMapProjection.js';
import { ENABLE_CATENARY } from '../config/features.js';
import { perfBegin, perfCurrentSession, perfMark, type PerfSession } from '../utils/perfTimings.js';


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

/** 图层开关状态（仅内存，不入库） */
interface LayerState {
  conductor: boolean;
  groundwire: boolean;
  opgw: boolean;
  unknownWire: boolean;
  tower: boolean;
  cross: boolean;
  label: boolean;
}

/** 图层配置（供 UI + legend 共用） */
const LAYER_ITEMS: { key: keyof LayerState; label: string; color: string }[] = [
  { key: 'conductor', label: '导线 CONDUCTOR', color: '#3b82f6' },
  { key: 'groundwire', label: '地线 GROUNDWIRE', color: '#6b7280' },
  { key: 'opgw', label: 'OPGW', color: '#10b981' },
  { key: 'unknownWire', label: '未知导线', color: '#9ca3af' },
  { key: 'tower', label: '塔位', color: '#3b82f6' },
  { key: 'cross', label: '跨越点', color: '#f59e0b' },
  { key: 'label', label: '标签', color: '#334155' },
];

/** 导线类型颜色 */
const WIRE_COLORS: Record<string, string> = {
  CONDUCTOR: '#3b82f6',
  GROUNDWIRE: '#6b7280',
  OPGW: '#10b981',
};
const WIRE_COLOR_UNKNOWN = '#9ca3af';
const WIRE_WIDTH = 1.5;
/** M4-B2：导线样式增强常量 */
const WIRE_WIDTH_SPLIT = 2.5;          // SPLIT > 1 加粗
const WIRE_WIDTH_SELECTED = 3.5;      // 选中导线高亮线宽
const WIRE_DASH_JUMPER: number[] = [6, 4]; // 跳线虚线
const WIRE_HIT_DIST = 6;               // 导线命中距离阈值（像素）
const WIRE_HIT_DIST_HOVER = 8;         // hover 容差略放宽

/** 背景 / 网格 / 边框颜色 */
const COLOR_BG = '#f8fafc';
const COLOR_GRID = '#e2e8f0';
const COLOR_GRID_MAJOR = '#cbd5e1';
const COLOR_BORDER = '#94a3b8';

/** 塔位颜色 */
const COLOR_TOWER_STRAIGHT = '#1d4ed8';
const COLOR_TOWER_STRAIGHT_FILL = '#3b82f6';
const COLOR_TOWER_TENSION = '#dc2626';
const COLOR_TOWER_TENSION_FILL = '#ef4444';
const COLOR_TOWER_SELECTED = '#f59e0b';
const TOWER_RADIUS = 5;
const HIT_RADIUS = 11;

/** 跨越点颜色 */
const COLOR_CROSS = '#f59e0b';

/** 标签颜色 */
const COLOR_LABEL = '#334155';
const LABEL_FONT = '11px sans-serif';
const LABEL_SHOW_ZOOM = 1.8; // 缩放达到此倍数以上才显示标签，避免 327 标签拥挤

/** 图例 */
const LEGEND_PAD = 10;
const LEGEND_LINE_H = 18;
const LEGEND_BOTTOM_MARGIN = 16; // 防止图例底部被裁切

/** 比例尺 */
const COLOR_SCALE = '#475569';

/** fit 边距 */
const FIT_PADDING = 48;

/** 缩放范围 */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 200;

/** focus 单塔时的放大倍数 */
const FOCUS_TOWER_ZOOM = 12;

/**
 * P1-2：地图绘制不再把全部导线放进一个 UI 长任务。
 *
 * 预算是“软”上限；每帧还会受 maxItems 限制，避免某一条复杂悬链线
 * 在低端 WebView 中连续占满事件循环。首帧只画背景/网格/图例，业务
 * 对象随后按塔位、导线、跨越物、标签分帧补齐。
 */
const PROGRESSIVE_FRAME_BUDGET_MS = 8;
const PROGRESSIVE_TOWER_BATCH = 256;
const PROGRESSIVE_WIRE_BATCH = 64;
const PROGRESSIVE_CROSS_BATCH = 128;
const PROGRESSIVE_LABEL_BATCH = 256;

interface RuntimeGeoPoint {
  key: string;
  lat: number;
  lng: number;
  /** Canvas-only Web Mercator coordinates；跨帧复用，避免重复 log/tan。 */
  worldX: number;
  worldY: number;
}

interface RuntimeTower {
  tower: TowerMarker;
  point: RuntimeGeoPoint;
}

interface RuntimeWire {
  wire: WireSegment;
  start: RuntimeGeoPoint;
  end: RuntimeGeoPoint;
  isJumper: boolean;
  split: number | null;
  /** enableCatenary 固定于一次地图实例，避免每次 draw 重复判断。 */
  useCatenary: boolean;
}

interface RuntimeCross {
  cross: LineMapData['crosses'][number];
  point: RuntimeGeoPoint | null;
}

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
  const id = typeof window !== 'undefined'
    ? window.setTimeout(() => callback(performance.now()), 0)
    : setTimeout(() => callback(performance.now()), 0) as unknown as number;
  return { id, kind: 'timeout' };
}

function cancelScheduledFrame(frame: ScheduledFrame | null): void {
  if (!frame) return;
  if (frame.kind === 'raf' && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(frame.id);
    return;
  }
  if (typeof window !== 'undefined') window.clearTimeout(frame.id);
  else clearTimeout(frame.id as unknown as ReturnType<typeof setTimeout>);
}

function coordinateKey(lat: number, lng: number): string {
  // 经纬度来自解析后的数字；String 保留足够精度，同时让同一塔位的多条
  // 导线共享一个投影缓存项。不要用 toFixed，避免近邻塔被错误合并。
  return `${lat}|${lng}`;
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

  // ---- DOM：canvas + tooltip + fit 按钮 + 图层面板 ----
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.zIndex = '2';
  canvas.style.cursor = 'grab';
  // M4-A2：overlay 模式下 Canvas 不接收鼠标事件（MapLibre 管理 pan/zoom）
  if (overlayMode) {
    canvas.style.pointerEvents = 'none';
  }
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  // tooltip
  const tooltip = document.createElement('div');
  tooltip.style.position = 'absolute';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.zIndex = '20';
  tooltip.style.maxWidth = '280px';
  tooltip.style.padding = '8px 10px';
  tooltip.style.borderRadius = '6px';
  tooltip.style.background = 'rgba(15,23,42,0.92)';
  tooltip.style.color = '#e2e8f0';
  tooltip.style.fontSize = '12px';
  tooltip.style.lineHeight = '1.5';
  tooltip.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
  tooltip.style.display = 'none';
  tooltip.style.whiteSpace = 'nowrap';
  container.appendChild(tooltip);

  // fit 按钮（左上角，避免与右上角 loading 重叠）
  const fitBtn = document.createElement('button');
  fitBtn.textContent = '全景';
  fitBtn.title = '回到全景（双击画布亦可）';
  fitBtn.style.position = 'absolute';
  fitBtn.style.left = '10px';
  fitBtn.style.top = '10px';
  fitBtn.style.zIndex = '20';
  fitBtn.style.padding = '4px 10px';
  fitBtn.style.borderRadius = '4px';
  fitBtn.style.border = '1px solid #cbd5e1';
  fitBtn.style.background = 'rgba(255,255,255,0.92)';
  fitBtn.style.cursor = 'pointer';
  fitBtn.style.fontSize = '12px';
  container.appendChild(fitBtn);

  // 图层面板（左上角，fit 按钮下方）
  const layerPanel = document.createElement('div');
  layerPanel.style.position = 'absolute';
  layerPanel.style.left = '10px';
  layerPanel.style.top = '42px';
  layerPanel.style.zIndex = '20';
  layerPanel.style.padding = '8px 10px';
  layerPanel.style.borderRadius = '6px';
  layerPanel.style.background = 'rgba(255,255,255,0.92)';
  layerPanel.style.border = '1px solid #cbd5e1';
  layerPanel.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
  layerPanel.style.fontSize = '12px';
  layerPanel.style.maxHeight = 'calc(100% - 60px)';
  layerPanel.style.overflowY = 'auto';
  container.appendChild(layerPanel);

  const layerTitle = document.createElement('div');
  layerTitle.textContent = '图层';
  layerTitle.style.fontWeight = '600';
  layerTitle.style.marginBottom = '4px';
  layerTitle.style.color = '#334155';
  layerPanel.appendChild(layerTitle);

  const layerCheckboxes: HTMLInputElement[] = [];
  for (const item of LAYER_ITEMS) {
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '4px';
    label.style.cursor = 'pointer';
    label.style.padding = '1px 0';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.style.accentColor = item.color;
    cb.style.margin = '0';
    cb.style.cursor = 'pointer';
    const span = document.createElement('span');
    span.textContent = item.label;
    span.style.color = '#334155';
    label.appendChild(cb);
    label.appendChild(span);
    layerPanel.appendChild(label);
    layerCheckboxes.push(cb);
  }

  // ---- 投影参数（fit 基准） ----
  // Canvas-only 兜底路径采用 Web Mercator（与 MapLibre/OSM 一致），
  // 替代原等距圆柱投影：等距投影纬线间距恒定，中高纬度东西向被压缩、
  // 形状畸变；Web Mercator 局部形状保真（正形），与主底图形态一致。
  const bbox = mapData.bbox;
  const valid = isDataUsable(mapData);
  const centerLat = valid ? (bbox.minLat + bbox.maxLat) / 2 : 0;
  const centerLng = valid ? (bbox.minLng + bbox.maxLng) / 2 : 0;
  const centerLatRad = (centerLat * Math.PI) / 180;
  /** 纬度 → Web Mercator y（单位对齐经度度数） */
  const mercY = (latDeg: number): number => {
    // Web Mercator 有效域 ±85.0511°
    const clamped = Math.max(-85.0511, Math.min(85.0511, latDeg));
    const rad = (clamped * Math.PI) / 180;
    return (Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 180) / Math.PI;
  };
  /** Web Mercator y → 纬度 */
  const invMercY = (y: number): number => {
    const rad2 = 2 * Math.atan(Math.exp((y * Math.PI) / 180)) - Math.PI / 2;
    return (rad2 * 180) / Math.PI;
  };
  const centerWYAbs = mercY(centerLat); // centerLat 对应的 Mercator y

  // world bbox（仅 valid 时有意义）
  const minWX = bbox.minLng - centerLng;
  const maxWX = bbox.maxLng - centerLng;
  const minWY = mercY(bbox.minLat) - centerWYAbs;
  const maxWY = mercY(bbox.maxLat) - centerWYAbs;
  const worldW = Math.max(maxWX - minWX, 1e-9);
  const worldH = Math.max(maxWY - minWY, 1e-9);
  const centerWX = (minWX + maxWX) / 2;
  const centerWY = (minWY + maxWY) / 2;

  /**
   * P1-2 运行时投影索引。
   *
   * 线路导线通常共享塔位端点。先把每个唯一经纬度转换为 Web Mercator
   * world 坐标，Canvas-only 的每次重绘只做乘法/平移；MapLibre overlay
   * 则在一个绘制帧内复用同一屏幕坐标，避免对每条导线重复调用 map.project。
   */
  const runtimePoints = new Map<string, RuntimeGeoPoint>();
  function getRuntimePoint(lat: number, lng: number): RuntimeGeoPoint {
    const key = coordinateKey(lat, lng);
    const cached = runtimePoints.get(key);
    if (cached) return cached;
    const point: RuntimeGeoPoint = {
      key,
      lat,
      lng,
      worldX: lng - centerLng,
      worldY: mercY(lat) - centerWYAbs,
    };
    runtimePoints.set(key, point);
    return point;
  }

  const runtimeTowers: RuntimeTower[] = mapData.towers.map((tower) => ({
    tower,
    point: getRuntimePoint(tower.lat, tower.lng),
  }));
  const runtimeWires: RuntimeWire[] = mapData.wires.map((wire) => {
    const isJumper = parseWireIsJumper(wire.nodeRef?.rawProps?.['ISJUMPER']);
    return {
      wire,
      start: getRuntimePoint(wire.startLat, wire.startLng),
      end: getRuntimePoint(wire.endLat, wire.endLng),
      isJumper,
      split: parseWireSplit(wire.nodeRef?.rawProps?.['SPLIT']),
      useCatenary: enableCatenary
        && !isJumper
        && wire.groupKind === 'inter-point'
        && wire.spanMeters != null
        && wire.spanMeters > 1,
    };
  });
  const runtimeCrosses: RuntimeCross[] = mapData.crosses.map((cross) => ({
    cross,
    point: cross.lat == null || cross.lng == null
      ? null
      : getRuntimePoint(cross.lat, cross.lng),
  }));

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
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let baseScale = 1;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let hoveredTower: TowerMarker | null = null;
  /** M4-B2：当前选中的导线（点击导线后高亮） */
  let selectedWire: WireSegment | null = null;
  /** M4-B2：当前 hover 的导线（光标变化用，不展示 tooltip） */
  let hoveredWire: WireSegment | null = null;
  /** M4-B2：导线命中距离阈值（点击严格，hover 放宽） */
  let destroyed = false;

  /** 渐进绘制代次；settled 重绘或销毁时取消旧 RAF。 */
  let renderGeneration = 0;
  let pendingFrame: ScheduledFrame | null = null;
  let pendingInteractionFrame: ScheduledFrame | null = null;
  let pendingSettledFrame: ScheduledFrame | null = null;
  let activePhaseEnd: ((labelSuffix?: string, endMeta?: Record<string, unknown>) => void) | null = null;
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

  /** 选中塔位的 nodePath 集合（树点击/地图 focus 时高亮） */
  let selectedTowerPaths: Set<string> = new Set();

  // 拖拽状态
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;
  let mouseDownMoved = false;

  // 预投影塔位屏幕坐标缓存（每次 draw 时更新）
  let towerScreen: { tower: TowerMarker; x: number; y: number }[] = [];
  /** 标签阶段按屏幕 y 排序后的快照，避免每个分帧批次重复排序。 */
  let labelQueue: { tower: TowerMarker; x: number; y: number }[] = [];
  let labelLastDrawnY = -Infinity;

  /** nodePath → TowerMarker 索引（供 focus 查找用） */
  const pathToTower = new Map<string, TowerMarker>();
  for (const t of mapData.towers) {
    if (t.nodeRef && t.nodeRef.path) pathToTower.set(t.nodeRef.path, t);
  }

  // ---- 尺寸 / DPR ----
  function resize(): void {
    const wasInitialized = cssW > 0 && cssH > 0;
    const rect = container.getBoundingClientRect();
    cssW = Math.max(rect.width, 1);
    cssH = Math.max(rect.height, 1);
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    // 计算 fit 基准 scale
    const availW = Math.max(cssW - 2 * FIT_PADDING, 1);
    const availH = Math.max(cssH - 2 * FIT_PADDING, 1);
    baseScale = Math.min(availW / worldW, availH / worldH);
    if (overlayMode && wasInitialized) {
      // ResizeObserver 触发时 MapLibre 可能尚未发出 resize 事件；主动
      // 让缓存失效并安排一帧轻量重绘，随后补一轮完整 settled 绘制。
      requestInteractiveFrame(true);
      requestSettledFrame();
    } else {
      draw();
    }
  }

  // ---- 投影 ----
  function geoToScreenPoint(point: RuntimeGeoPoint): { x: number; y: number } {
    // overlay 模式委托给外部投影（MapLibre project）。缓存只属于当前
    // camera revision 的一个 Canvas frame，绝不跨相机变化复用屏幕坐标。
    if (projection) {
      if (frameProjectionCache?.revision !== cameraRevision) {
        frameProjectionCache = { revision: cameraRevision, points: new Map() };
      }
      const cached = frameProjectionCache.points.get(point.key);
      if (cached) return cached;
      const p = projection.project(point.lng, point.lat);
      const result = { x: p.x, y: p.y };
      frameProjectionCache.points.set(point.key, result);
      return result;
    }
    const s = baseScale * zoom;
    return {
      x: cssW / 2 + (point.worldX - centerWX) * s + panX,
      y: cssH / 2 - (point.worldY - centerWY) * s + panY,
    };
  }

  function geoToScreen(lat: number, lng: number): { x: number; y: number } {
    return geoToScreenPoint(getRuntimePoint(lat, lng));
  }

  function screenToWorldGeo(sx: number, sy: number): { lat: number; lng: number } {
    // M4-A2：overlay 模式委托给外部投影（MapLibre unproject）
    if (projection?.unproject) {
      const geo = projection.unproject(sx, sy);
      return { lat: geo.lat, lng: geo.lng };
    }
    const s = baseScale * zoom;
    const wx = centerWX + (sx - cssW / 2 - panX) / s;
    const wy = centerWY - (sy - cssH / 2 - panY) / s;
    return { lat: invMercY(wy + centerWYAbs), lng: wx + centerLng };
  }

  // ---- 图层开关事件 ----
  for (let i = 0; i < LAYER_ITEMS.length; i++) {
    const item = LAYER_ITEMS[i];
    const cb = layerCheckboxes[i];
    cb.addEventListener('change', () => {
      layerState[item.key] = cb.checked;
      // 关闭塔位图层时清除 hover，避免 tooltip 残留
      if (item.key === 'tower' && !cb.checked) {
        hoveredTower = null;
        hideTooltip();
      }
      draw();
    });
  }

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
    activeDevRenderRunId = typeof devGlobals.__GIM_DEV_LINE_MAP_RENDER_RUN_ID__ === 'string'
      ? devGlobals.__GIM_DEV_LINE_MAP_RENDER_RUN_ID__
      : null;
    setDevMapRenderState(activeDevRenderToken, false, activeDevRenderRunId);
    const instrument = instrumentNextRender;
    const endFirstFrame = instrument
      ? perfBegin('线路 Canvas 首帧', undefined, perfSession)
      : null;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    frameProjectionCache = { revision: cameraRevision, points: new Map() };
    // 背景：overlay 模式下透明（让 MapLibre 底图透出），Canvas-only 模式填色
    if (overlayMode) {
      ctx.clearRect(0, 0, cssW, cssH);
    } else {
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, cssW, cssH);
    }

    if (!valid) {
      drawEmptyHint('未提取到可定位塔位');
      drawBorder();
      frameProjectionCache = null;
      endFirstFrame?.(undefined, { progressive: false, valid: false });
      if (instrument) instrumentNextRender = false;
      setDevMapRenderState(activeDevRenderToken, true, activeDevRenderRunId);
      return;
    }

    if (showGrid) drawGrid();
    if (showCanvasScaleBar) drawScaleBar();
    drawLegend();
    drawBorder();

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
    activeDevRenderRunId = typeof devGlobals.__GIM_DEV_LINE_MAP_RENDER_RUN_ID__ === 'string'
      ? devGlobals.__GIM_DEV_LINE_MAP_RENDER_RUN_ID__
      : null;
    setDevMapRenderState(activeDevRenderToken, false, activeDevRenderRunId);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 交互帧每次都建立新的 revision-scoped cache；不携带上一帧的屏幕坐标。
    frameProjectionCache = { revision, points: new Map() };
    ctx.clearRect(0, 0, cssW, cssH);
    if (!valid) {
      drawEmptyHint('未提取到可定位塔位');
      drawBorder();
      frameProjectionCache = null;
      interactionRequestStartedAt = null;
      return;
    }

    // 底图由 MapLibre 提供，交互态只绘制必要工程元素；标签和悬链线
    // 留给 moveend/zoomend 后的 settled progressive pass。
    drawLegend();
    drawBorder();
    towerScreen = [];
    drawTowerRange(0, runtimeTowers.length);
    drawWireRange(0, runtimeWires.length, true);
    drawSelectedWire(true);
    drawCrossRange(0, runtimeCrosses.length);

    frameProjectionCache = null;
    const latencyMs = interactionRequestStartedAt == null
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
      perfMark('线路 Canvas 交互帧', {
        cameraRevision: revision,
        latencyMs: Math.round(latencyMs * 100) / 100,
        towers: runtimeTowers.length,
        wires: runtimeWires.length,
        crosses: runtimeCrosses.length,
      }, perfSession);
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
    stage: 'towers' | 'wires' | 'crosses' | 'labels',
    offset: number,
    instrument: boolean,
  ): void {
    pendingFrame = scheduleFrame(() => {
      pendingFrame = null;
      runProgressiveStage(generation, cameraSnapshot, stage, offset, instrument);
    });
  }

  function startProgressiveRender(generation: number, cameraSnapshot: number, instrument: boolean): void {
    progressiveActive = true;
    towerScreen = [];
    labelQueue = [];
    labelLastDrawnY = -Infinity;
    beginProgressivePhase('线路 Canvas 塔位分批绘制', instrument);
    scheduleProgressive(generation, cameraSnapshot, 'towers', 0, instrument);
  }

  function runProgressiveStage(
    generation: number,
    cameraSnapshot: number,
    stage: 'towers' | 'wires' | 'crosses' | 'labels',
    offset: number,
    instrument: boolean,
  ): void {
    if (destroyed || generation !== renderGeneration || cameraSnapshot !== cameraRevision) return;
    const started = performance.now();
    const sourceLength = stage === 'towers'
      ? runtimeTowers.length
      : stage === 'wires'
        ? runtimeWires.length
        : stage === 'crosses'
          ? runtimeCrosses.length
          : (layerState.label && zoom >= LABEL_SHOW_ZOOM ? labelQueue.length : 0);
    const batchSize = stage === 'towers'
      ? PROGRESSIVE_TOWER_BATCH
      : stage === 'wires'
        ? PROGRESSIVE_WIRE_BATCH
        : stage === 'crosses'
        ? PROGRESSIVE_CROSS_BATCH
        : PROGRESSIVE_LABEL_BATCH;
    // 同时设置数量上限和时间预算，避免一条复杂悬链线或低端 WebView
    // 中的 Canvas 实现把一帧再次拉成长任务。
    const hardEnd = Math.min(sourceLength, offset + batchSize);
    const deadline = started + PROGRESSIVE_FRAME_BUDGET_MS;
    let next = offset;
    while (next < hardEnd) {
      if (stage === 'towers') {
        drawTowerRange(next, next + 1);
      } else if (stage === 'wires') {
        drawWireRange(next, next + 1);
      } else if (stage === 'crosses') {
        drawCrossRange(next, next + 1);
      } else {
        drawLabelRange(next, next + 1);
      }
      next += 1;
      // 至少完成少量工作后再检查时钟，减少 performance.now() 调用；
      // 下一帧继续，不回滚已绘制像素。
      if (next - offset >= 8 && performance.now() >= deadline) break;
    }

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
      drawSelectedWire();
      finishProgressivePhase({ ...stageMeta, catenary: enableCatenary });
      beginProgressivePhase('线路 Canvas 跨越物分批绘制', instrument);
      scheduleProgressive(generation, cameraSnapshot, 'crosses', 0, instrument);
    } else if (stage === 'crosses') {
      finishProgressivePhase(stageMeta);
      labelQueue = towerScreen.slice().sort((a, b) => a.y - b.y);
      beginProgressivePhase('线路 Canvas 标签分批绘制', instrument);
      scheduleProgressive(generation, cameraSnapshot, 'labels', 0, instrument);
    } else {
      // 标签关闭或缩放不足时 sourceLength 为 0，也会在这里结束。
      finishProgressivePhase({ ...stageMeta, visible: layerState.label && zoom >= LABEL_SHOW_ZOOM });
      frameProjectionCache = null;
      if (instrument) perfMark('线路 Canvas 地图绘制完成', {
        towers: runtimeTowers.length,
        wires: runtimeWires.length,
        crosses: runtimeCrosses.length,
      }, perfSession);
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

  // 向调用方注册 redraw 回调，供 MapLibre 视图变化时触发 Canvas 重绘。
  // 默认 phase=interactive，兼容旧调用方和测试替身。
  if (options?.onRequestRedraw) {
    options.onRequestRedraw((phase: LineMapRenderPhase = 'interactive') => {
      if (phase === 'settled') requestSettledFrame();
      else requestInteractiveFrame(true);
    });
  }

  function drawEmptyHint(text: string): void {
    ctx.fillStyle = '#64748b';
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cssW / 2, cssH / 2);
  }

  function drawBorder(): void {
    ctx.strokeStyle = COLOR_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
  }

  function drawGrid(): void {
    const latStep = niceStep(bbox.maxLat - bbox.minLat, 8);
    const lngStep = niceStep(bbox.maxLng - bbox.minLng, 8);
    ctx.lineWidth = 1;

    // 竖线（经度）
    const startLng = Math.ceil(bbox.minLng / lngStep) * lngStep;
    for (let lng = startLng; lng <= bbox.maxLng + 1e-9; lng += lngStep) {
      const top = geoToScreen(bbox.maxLat, lng);
      const bottom = geoToScreen(bbox.minLat, lng);
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath();
      ctx.moveTo(top.x, 0);
      ctx.lineTo(bottom.x, cssH);
      ctx.stroke();
      // 经度标签
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(formatLng(lng), Math.min(Math.max(top.x + 2, 2), cssW - 50), 2);
    }

    // 横线（纬度）
    const startLat = Math.ceil(bbox.minLat / latStep) * latStep;
    for (let lat = startLat; lat <= bbox.maxLat + 1e-9; lat += latStep) {
      const left = geoToScreen(lat, bbox.minLng);
      const right = geoToScreen(lat, bbox.maxLng);
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath();
      ctx.moveTo(0, left.y);
      ctx.lineTo(cssW, right.y);
      ctx.stroke();
      // 纬度标签
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(formatLat(lat), 2, Math.min(Math.max(left.y + 2, 2), cssH - 14));
    }
  }

  /** 根据 wireType 判断属于哪个图层 */
  function wireLayerKey(wireType: string): keyof LayerState {
    if (wireType === 'CONDUCTOR') return 'conductor';
    if (wireType === 'GROUNDWIRE') return 'groundwire';
    if (wireType === 'OPGW') return 'opgw';
    return 'unknownWire';
  }

  function drawWireRange(start: number, end: number, simplified = false): void {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // M4-B2：先画非选中导线；选中导线在全部批次完成后补画，确保
    // 选中态保持在最上层且不会被后续批次覆盖。
    for (let index = start; index < end; index++) {
      const runtimeWire = runtimeWires[index];
      if (!runtimeWire) continue;
      const { wire } = runtimeWire;
      if (!layerState[wireLayerKey(wire.wireType)]) continue;
      if (wire === selectedWire) continue;
      drawWireSegment(runtimeWire, false, simplified);
    }
  }

  function drawSelectedWire(simplified = false): void {
    if (!selectedWire || !layerState[wireLayerKey(selectedWire.wireType)]) return;
    const runtimeWire = runtimeWires.find((candidate) => candidate.wire === selectedWire);
    if (runtimeWire) drawWireSegment(runtimeWire, true, simplified);
  }

  function drawTowerRange(start: number, end: number): void {
    if (!layerState.tower) return;
    for (let index = start; index < end; index++) {
      const runtimeTower = runtimeTowers[index];
      if (!runtimeTower) continue;
      const { tower } = runtimeTower;
      const p = geoToScreenPoint(runtimeTower.point);
      towerScreen.push({ tower, x: p.x, y: p.y });
      if (p.x < -12 || p.x > cssW + 12 || p.y < -12 || p.y > cssH + 12) continue;

      const tension = isTensionTower(tower);
      const isHover = hoveredTower === tower;
      const isSelected = !!(tower.nodeRef && selectedTowerPaths.has(tower.nodeRef.path));
      const r = isHover || isSelected ? TOWER_RADIUS + 2 : TOWER_RADIUS;

      if (isHover || isSelected) {
        // 高亮光晕
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = isSelected
          ? 'rgba(245,158,11,0.35)'
          : 'rgba(245,158,11,0.25)';
        ctx.fill();
      }

      const fillColor = isHover || isSelected ? COLOR_TOWER_SELECTED : undefined;
      if (tension) {
        // 菱形（耐张塔/转角塔）
        ctx.fillStyle = fillColor || COLOR_TOWER_TENSION_FILL;
        ctx.strokeStyle = COLOR_TOWER_TENSION;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // 圆形（直线塔/普通塔）
        ctx.fillStyle = fillColor || COLOR_TOWER_STRAIGHT_FILL;
        ctx.strokeStyle = COLOR_TOWER_STRAIGHT;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /**
   * M4-B2：绘制单条导线段，含样式分层。
   *
   * 样式规则：
   * - isJumper=true → 虚线（setLineDash）
   * - SPLIT > 1 → 线宽 WIRE_WIDTH_SPLIT
   * - 选中态 → 线宽 WIRE_WIDTH_SELECTED + 高亮色（黄色描边）
   * - UNKNOWN → 保持弱化样式（浅灰）
   * - enableCatenary=true 且为 inter-point 真实档距 → 抛物线采样（M4-B3C）
   *
   * @param w 导线段
   * @param isSelected 是否为选中态
   */
  function drawWireSegment(runtimeWire: RuntimeWire, isSelected: boolean, simplified = false): void {
    const w = runtimeWire.wire;
    const s = geoToScreenPoint(runtimeWire.start);
    const e = geoToScreenPoint(runtimeWire.end);
    // 视口剔除
    if ((s.x < 0 && e.x < 0) || (s.x > cssW && e.x > cssW)) return;
    if ((s.y < 0 && e.y < 0) || (s.y > cssH && e.y > cssH)) return;

    const isJumper = runtimeWire.isJumper;
    const split = runtimeWire.split;

    // 选中态：先画一层黄色描边光晕（与导线主体同样形态）
    if (isSelected) {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(245,158,11,0.45)';
      ctx.lineWidth = WIRE_WIDTH_SELECTED + 4;
      drawWirePath(s, e, runtimeWire, simplified);
    }

    // 主体线
    ctx.strokeStyle = WIRE_COLORS[w.wireType] || WIRE_COLOR_UNKNOWN;
    if (isSelected) {
      ctx.lineWidth = WIRE_WIDTH_SELECTED;
    } else if (split && split > 1) {
      ctx.lineWidth = WIRE_WIDTH_SPLIT;
    } else {
      ctx.lineWidth = WIRE_WIDTH;
    }
    if (isJumper) {
      ctx.setLineDash(WIRE_DASH_JUMPER);
    } else {
      ctx.setLineDash([]);
    }
    drawWirePath(s, e, runtimeWire, simplified);

    // 恢复默认
    ctx.setLineDash([]);
  }

  /**
   * 悬链线渲染判定（绘制与 hit-test 共享，保证两者形态一致）。
   *
   * 条件：enableCatenary 且非跳线且 inter-point 真实档距且档距 > 1m
   */
  function shouldUseCatenary(runtimeWire: RuntimeWire): boolean {
    return runtimeWire.useCatenary;
  }

  /**
   * 计算弧垂像素值。返回 null 表示弦长过短无法计算。
   *
   * 弧垂（米）：KVALUE>0 时 KVALUE*L²，否则 3% 经验弧垂；上限 10%*L，下限 1m。
   */
  function computeSagPx(
    s: { x: number; y: number },
    e: { x: number; y: number },
    w: WireSegment,
  ): number | null {
    const L = w.spanMeters!;
    let sagMeters: number;
    const kValueNum = w.kValue ? parseFloat(w.kValue) : NaN;
    if (Number.isFinite(kValueNum) && kValueNum > 0) {
      sagMeters = kValueNum * L * L;
    } else {
      sagMeters = L * 0.03; // 3% 经验弧垂
    }
    if (sagMeters > L * 0.1) sagMeters = L * 0.1; // 防 KVALUE 异常
    if (sagMeters < 1) sagMeters = 1; // 至少 1 米下垂，保证视觉可辨

    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const chordPx = Math.sqrt(dx * dx + dy * dy);
    if (chordPx < 2) return null;
    return sagMeters * (chordPx / L);
  }

  /**
   * 计算导线屏幕路径采样点（绘制与 hit-test 共享）。
   *
   * 直线 → [s, e]；悬链线 → 沿弦线按屏幕长度 4–24 段抛物线
   * f(t)=4t(1-t) 下垂采样。
   * 与 drawWirePath 的可见形态完全一致，hit-test 不再有直线/曲线偏差。
   */
  function wireScreenPoints(
    s: { x: number; y: number },
    e: { x: number; y: number },
    runtimeWire: RuntimeWire,
    simplified = false,
  ): Array<{ x: number; y: number }> {
    if (simplified) return [s, e];
    const w = runtimeWire.wire;
    if (!shouldUseCatenary(runtimeWire) || w.spanMeters == null || w.spanMeters <= 0) {
      return [s, e];
    }
    const sagPx = computeSagPx(s, e, w);
    if (sagPx == null) return [s, e];
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const chordPx = Math.sqrt(dx * dx + dy * dy);
    // 近距离/低缩放时少采样，放大后最多保持原来的 24 段；
    // 视觉形态仍由同一采样结果供绘制与 hit-test 共用。
    const N = Math.min(24, Math.max(4, Math.ceil(chordPx / 20)));
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push({
        x: s.x + dx * t,
        // Canvas Y 轴向下，下垂 = +y
        y: s.y + dy * t + sagPx * 4 * t * (1 - t),
      });
    }
    return pts;
  }

  /**
   * M4-B3C：绘制导线路径（直线或抛物线悬链线）。
   *
   * 形态由 wireScreenPoints 统一给出（与 hit-test 一致）；
   * 弧垂语义详见 computeSagPx。
   */
  function drawWirePath(
    s: { x: number; y: number },
    e: { x: number; y: number },
    runtimeWire: RuntimeWire,
    simplified = false,
  ): void {
    ctx.beginPath();
    const pts = wireScreenPoints(s, e, runtimeWire, simplified);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function drawCrossRange(start: number, end: number): void {
    if (!layerState.cross) return;
    for (let index = start; index < end; index++) {
      const runtimeCross = runtimeCrosses[index];
      if (!runtimeCross?.point) continue;
      const p = geoToScreenPoint(runtimeCross.point);
      if (p.x < -10 || p.x > cssW + 10 || p.y < -10 || p.y > cssH + 10) continue;
      // 三角形警示符号
      const r = 6;
      ctx.fillStyle = COLOR_CROSS;
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - r);
      ctx.lineTo(p.x - r, p.y + r * 0.7);
      ctx.lineTo(p.x + r, p.y + r * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 感叹号
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', p.x, p.y + 1);
    }
  }

  function isTensionTower(t: TowerMarker): boolean {
    const tt = (t.towerType || '').toLowerCase();
    if (tt.includes('耐张') || tt.includes('转角') || tt.includes('tension') || tt.includes('angle')) {
      return true;
    }
    if (t.turnAngle) {
      const a = parseFloat(t.turnAngle);
      if (isFinite(a) && Math.abs(a) > 0.01) return true;
    }
    return false;
  }

  function towerLabel(t: TowerMarker): string {
    if (t.towerNumber) return t.towerNumber;
    if (t.nodeRef && t.nodeRef.name) return t.nodeRef.name;
    const fn = t.cbmPath.split('/').pop() || t.cbmPath;
    return fn.replace(/\.(cbm|dev|fam)$/i, '');
  }

  function drawLabelRange(start: number, end: number): void {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    // 标签队列已按 y 排序，labelLastDrawnY 跨分帧保留碰撞状态。
    for (let index = start; index < end; index++) {
      const ts = labelQueue[index];
      if (!ts) continue;
      if (ts.x < 0 || ts.x > cssW || ts.y < 0 || ts.y > cssH) continue;
      if (ts.y - labelLastDrawnY < 13) continue;
      const label = towerLabel(ts.tower);
      if (!label) continue;
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(label, ts.x + 7, ts.y - 4);
      labelLastDrawnY = ts.y;
    }
  }

  function drawLegend(): void {
    // 导线图例项（与图层状态一致：关闭时半透明）
    const wireItems: [string, string, boolean][] = [
      ['导线 CONDUCTOR', WIRE_COLORS['CONDUCTOR'] || WIRE_COLOR_UNKNOWN, layerState.conductor],
      ['地线 GROUNDWIRE', WIRE_COLORS['GROUNDWIRE'] || WIRE_COLOR_UNKNOWN, layerState.groundwire],
      ['OPGW', WIRE_COLORS['OPGW'] || WIRE_COLOR_UNKNOWN, layerState.opgw],
      ['未知导线', WIRE_COLOR_UNKNOWN, layerState.unknownWire],
    ];
    const totalLines = wireItems.length + 3; // +直线塔 +耐张塔 +跨越点
    const x0 = LEGEND_PAD + 4;
    let y0 = cssH - LEGEND_PAD - LEGEND_BOTTOM_MARGIN - totalLines * LEGEND_LINE_H;

    // 背板（增加底部 padding 防裁切）
    const boxH = totalLines * LEGEND_LINE_H + LEGEND_PAD + LEGEND_BOTTOM_MARGIN;
    const boxW = 158;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = COLOR_GRID_MAJOR;
    ctx.lineWidth = 1;
    ctx.fillRect(LEGEND_PAD, y0 - 4, boxW, boxH);
    ctx.strokeRect(LEGEND_PAD, y0 - 4, boxW, boxH);

    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // 导线图例
    for (const [label, color, visible] of wireItems) {
      ctx.globalAlpha = visible ? 1 : 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + 6);
      ctx.lineTo(x0 + 22, y0 + 6);
      ctx.stroke();
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(label, x0 + 28, y0 + 6);
      y0 += LEGEND_LINE_H;
    }
    ctx.globalAlpha = 1;
    // 塔位图例（圆形/菱形）
    ctx.globalAlpha = layerState.tower ? 1 : 0.3;
    ctx.fillStyle = COLOR_TOWER_STRAIGHT_FILL;
    ctx.strokeStyle = COLOR_TOWER_STRAIGHT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x0 + 11, y0 + 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText('直线塔（圆）', x0 + 28, y0 + 6);
    y0 += LEGEND_LINE_H;
    ctx.fillStyle = COLOR_TOWER_TENSION_FILL;
    ctx.strokeStyle = COLOR_TOWER_TENSION;
    ctx.beginPath();
    ctx.moveTo(x0 + 11, y0 + 2);
    ctx.lineTo(x0 + 15, y0 + 6);
    ctx.lineTo(x0 + 11, y0 + 10);
    ctx.lineTo(x0 + 7, y0 + 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText('耐张塔（菱）', x0 + 28, y0 + 6);
    y0 += LEGEND_LINE_H;
    ctx.globalAlpha = 1;
    // 跨越点图例
    ctx.globalAlpha = layerState.cross ? 1 : 0.3;
    ctx.fillStyle = COLOR_CROSS;
    ctx.beginPath();
    ctx.moveTo(x0 + 11, y0 + 2);
    ctx.lineTo(x0 + 7, y0 + 10);
    ctx.lineTo(x0 + 15, y0 + 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLOR_LABEL;
    ctx.fillText('跨越点', x0 + 28, y0 + 6);
    ctx.globalAlpha = 1;
  }

  function drawScaleBar(): void {
    // Web Mercator：地面米/像素 = R·cos(φ) / pxPerMercYUnit（随中心纬度变化）
    // 替代原等距投影的 111km/° 常数，中高纬度比例尺不再失真
    const pxPerMerc = baseScale * zoom;
    const metersPerPx = ((6371000 * Math.cos(centerLatRad)) / pxPerMerc);
    const kmPerPx = metersPerPx / 1000;
    // 目标 80px 的 km 数，取整
    const targetKm = kmPerPx * 80;
    const niceKm = niceRound(targetKm);
    const barPx = (niceKm * 1000) / metersPerPx;
    if (!isFinite(barPx) || barPx < 20) return;

    const x = cssW - barPx - LEGEND_PAD - 8;
    const y = cssH - LEGEND_PAD - 8;
    ctx.strokeStyle = COLOR_SCALE;
    ctx.fillStyle = COLOR_SCALE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + barPx, y);
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x, y + 3);
    ctx.moveTo(x + barPx, y - 3);
    ctx.lineTo(x + barPx, y + 3);
    ctx.stroke();
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(niceKm >= 1 ? `${niceKm} km` : `${Math.round(niceKm * 1000)} m`, x + barPx / 2, y - 4);
  }

  // ---- 命中测试 ----
  function hitTestTower(sx: number, sy: number): TowerMarker | null {
    if (!layerState.tower) return null;
    let best: TowerMarker | null = null;
    let bestDist = HIT_RADIUS;
    if (overlayMode) {
      // 不依赖上一 progressive pass 的 towerScreen 快照。MapLibre 相机
      // 事件到达后，交互 RAF 可能尚未执行；此处直接按当前 revision 投影，
      // 使 hover/click 在那一个 RAF 窗口内也不会命中旧屏幕坐标。
      for (const runtimeTower of runtimeTowers) {
        const p = geoToScreenPoint(runtimeTower.point);
        const dx = p.x - sx;
        const dy = p.y - sy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= bestDist) {
          bestDist = d;
          best = runtimeTower.tower;
        }
      }
    } else {
      // Canvas-only 保持原有行为：仅对已经绘制并缓存的塔位做命中检测。
      for (const ts of towerScreen) {
        const dx = ts.x - sx;
        const dy = ts.y - sy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= bestDist) {
          bestDist = d;
          best = ts.tower;
        }
      }
    }
    return best;
  }

  /**
   * M4-B2：点到线段距离（像素）。
   * 用于导线 hit-test，鼠标点到线段距离小于阈值则命中。
   */
  function pointToSegmentDist(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      // 退化情况：线段长度为 0，按点到点处理
      const dpx = px - x1;
      const dpy = py - y1;
      return Math.sqrt(dpx * dpx + dpy * dpy);
    }
    // 投影参数 t，限制在 [0, 1] 内（线段，非直线）
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const dpx = px - projX;
    const dpy = py - projY;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }

  /**
   * M4-B2：导线 hit-test。
   *
   * 规则：
   * - 仅检测图层开启的导线类型
   * - 优先返回距离最近的导线
   * - 鼠标点到导线屏幕距离 <= threshold 时命中
   * - 悬链线导线沿实际采样曲线计算距离（与 drawWirePath 同一形态来源 wireScreenPoints），
   *   修复 hover/click 直线命中与可见抛物线不一致的问题
   *
   * @param threshold 像素阈值，点击用 WIRE_HIT_DIST，hover 用 WIRE_HIT_DIST_HOVER
   */
  function hitTestWire(sx: number, sy: number, threshold: number): WireSegment | null {
    let best: WireSegment | null = null;
    let bestDist = threshold;
    for (const runtimeWire of runtimeWires) {
      const w = runtimeWire.wire;
      if (!layerState[wireLayerKey(w.wireType)]) continue;
      const s = geoToScreenPoint(runtimeWire.start);
      const e = geoToScreenPoint(runtimeWire.end);
      // 视口剔除（与 drawWires 一致）
      if ((s.x < 0 && e.x < 0) || (s.x > cssW && e.x > cssW)) continue;
      if ((s.y < 0 && e.y < 0) || (s.y > cssH && e.y > cssH)) continue;
      // 沿实际可见路径（直线或悬链线采样折线）逐段求最小距离
      const pts = wireScreenPoints(s, e, runtimeWire);
      let d = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const segDist = pointToSegmentDist(
          sx, sy, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y,
        );
        if (segDist < d) d = segDist;
      }
      if (d <= bestDist) {
        bestDist = d;
        best = w;
      }
    }
    return best;
  }

  // ---- tooltip ----
  function showTooltip(t: TowerMarker, sx: number, sy: number): void {
    const famHit = !!t.famSource;
    const devHit = !!t.devSource;
    const lines: string[] = [];
    lines.push(`<b>${escapeHtml(towerLabel(t))}</b>`);
    if (t.towerNumber) lines.push(`杆塔编号: ${escapeHtml(t.towerNumber)}`);
    lines.push(`塔型: ${escapeHtml(t.towerType || '—')}`);
    lines.push(`呼高: ${escapeHtml(t.towerHeight || '—')}`);
    lines.push(`转角: ${escapeHtml(t.turnAngle || '—')}`);
    lines.push(`纬度: ${t.lat.toFixed(6)}`);
    lines.push(`经度: ${t.lng.toFixed(6)}`);
    if (t.elev != null) lines.push(`高程: ${t.elev} m`);
    lines.push(`数据质量: ${t.dataQuality}`);
    lines.push(`FAM: ${famHit ? '命中' : '未命中缓存'}`);
    lines.push(`DEV: ${devHit ? '命中' : '未命中缓存'}`);
    tooltip.innerHTML = lines.join('<br>');
    tooltip.style.display = 'block';
    // 定位（避免溢出右边/下边）
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let tx = sx + 14;
    let ty = sy + 14;
    if (tx + tw > cssW - 4) tx = sx - tw - 14;
    if (ty + th > cssH - 4) ty = sy - th - 14;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  }

  function hideTooltip(): void {
    tooltip.style.display = 'none';
  }

  // ---- 事件处理（内部可复用逻辑，供 Canvas 事件 + overlay 桥接共用） ----

  /**
   * 处理鼠标移动（hover 命中测试 + tooltip）。
   * Canvas-only：由 onMouseMove 调用（dragging 时走拖拽分支）
   * overlay：由 handlePointerMove → 外部 MapLibre 转发调用
   *
   * M4-B2：增加导线 hover 检测，命中导线时 cursor=pointer。
   * 优先级：塔位 > 导线（hover 时塔位 tooltip 优先）。
   */
  function handlePointerMoveAt(mx: number, my: number): void {
    // hover 命中测试（塔位优先）
    const t = hitTestTower(mx, my);
    if (t !== hoveredTower) {
      hoveredTower = t;
      requestVisualRender();
    }
    if (t) {
      showTooltip(t, mx, my);
      canvas.style.cursor = 'pointer';
      // 命中塔位时清除导线 hover 态
      if (hoveredWire !== null) {
        hoveredWire = null;
      }
      return;
    }
    // 未命中塔位：检测导线 hover（容差放宽到 WIRE_HIT_DIST_HOVER）
    const w = options?.onWireClick ? hitTestWire(mx, my, WIRE_HIT_DIST_HOVER) : null;
    if (w !== hoveredWire) {
      hoveredWire = w;
      // hover 不重绘（避免频繁 redraw），仅更新 cursor
    }
    if (w) {
      hideTooltip();
      canvas.style.cursor = 'pointer';
    } else {
      hideTooltip();
      canvas.style.cursor = valid ? 'grab' : 'default';
    }
  }

  /**
   * 处理鼠标点击（命中塔位 → 选中 + 联动）。
   * Canvas-only：由 onMouseUp 调用（未拖拽时）
   * overlay：由 handlePointerClick → 外部 MapLibre 转发调用
   *
   * M4-B2：未命中塔位时尝试命中导线，命中则触发 onWireClick 回调并高亮。
   * 优先级：塔位 > 导线 > CROSS（CROSS 当前无 hit-test）。
   */
  function handlePointerClickAt(mx: number, my: number): void {
    const t = hitTestTower(mx, my);
    if (t) {
      hoveredTower = t;
      if (t.nodeRef && t.nodeRef.path) {
        selectedTowerPaths = new Set([t.nodeRef.path]);
      }
      // 命中塔位时清除导线选中态
      selectedWire = null;
      requestVisualRender();
      try {
        onTowerClick(t.nodeRef);
      } catch (err) {
        console.error('[LineMap] onTowerClick 回调异常:', err);
      }
      return;
    }
    // 未命中塔位：尝试命中导线（严格阈值 WIRE_HIT_DIST）
    if (options?.onWireClick) {
      const w = hitTestWire(mx, my, WIRE_HIT_DIST);
      if (w) {
        selectedWire = w;
        // 选中导线时清除塔位选中态（避免双重选中）
        selectedTowerPaths = new Set();
        requestVisualRender();
        try {
          options.onWireClick(w);
        } catch (err) {
          console.error('[LineMap] onWireClick 回调异常:', err);
        }
      }
    }
  }

  /**
   * 处理鼠标离开（清除 hover + tooltip）。
   * Canvas-only：由 onMouseLeave 调用
   * overlay：由 handlePointerLeave → 外部 MapLibre 转发调用
   */
  function handlePointerLeaveInternal(): void {
    hoveredTower = null;
    // M4-B2 cleanup：鼠标离开地图区域时同时清理导线 hover 态
    hoveredWire = null;
    hideTooltip();
    requestVisualRender();
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!valid) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // 光标处的地理坐标（缩放不变点）
    const before = screenToWorldGeo(mx, my);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    // 调整 pan 使光标处地理坐标不变
    const after = geoToScreen(before.lat, before.lng);
    panX += mx - after.x;
    panY += my - after.y;
    draw();
  }

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    dragging = true;
    mouseDownMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanX = panX;
    dragStartPanY = panY;
    canvas.style.cursor = 'grabbing';
  }

  function onMouseMove(e: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (dragging) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) mouseDownMoved = true;
      panX = dragStartPanX + dx;
      panY = dragStartPanY + dy;
      draw();
      return;
    }
    handlePointerMoveAt(mx, my);
  }

  function onMouseUp(e: MouseEvent): void {
    if (dragging) {
      dragging = false;
      // M4-B2 cleanup：释放时若仍在导线上，cursor 保持 pointer（塔位优先级不变）
      canvas.style.cursor = (hoveredTower || hoveredWire) ? 'pointer' : 'grab';
    }
    // 点击（未拖拽）→ 命中塔位
    if (!mouseDownMoved && e.button === 0) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      handlePointerClickAt(mx, my);
    }
  }

  function onMouseLeave(): void {
    if (dragging) {
      dragging = false;
      canvas.style.cursor = 'grab';
    }
    handlePointerLeaveInternal();
  }

  function onDblClick(): void {
    fit();
  }

  function onFitBtnClick(): void {
    fit();
  }

  // ---- 公开方法 ----
  function fit(): void {
    selectedTowerPaths = new Set();
    // M4-B2：fit 时清除导线选中态
    selectedWire = null;
    // M4-A2：overlay 模式下视图由 MapLibre 管理，委托 fitBounds
    if (projection?.fitBounds && valid) {
      projection.fitBounds({
        minLng: bbox.minLng,
        minLat: bbox.minLat,
        maxLng: bbox.maxLng,
        maxLat: bbox.maxLat,
      });
      requestInteractiveFrame(true);
      requestSettledFrame();
      return;
    }
    zoom = 1;
    panX = 0;
    panY = 0;
    draw();
  }

  /** 定位到单个塔位：居中 + 放大 + 高亮 */
  function focusTowerByNodePath(path: string): boolean {
    if (!valid) return false;
    const t = pathToTower.get(path);
    if (!t) return false;
    selectedTowerPaths = new Set([path]);
    hoveredTower = t;
    // M4-A2：overlay 模式下委托 MapLibre fitBounds（单塔小范围 bbox）
    if (projection?.fitBounds) {
      const pad = 0.002;
      projection.fitBounds({
        minLng: t.lng - pad,
        minLat: t.lat - pad,
        maxLng: t.lng + pad,
        maxLat: t.lat + pad,
      });
      requestInteractiveFrame(true);
      requestSettledFrame();
      return true;
    }
    zoom = clamp(FOCUS_TOWER_ZOOM, MIN_ZOOM, MAX_ZOOM);
    const s = baseScale * zoom;
    const wx = t.lng - centerLng;
    const wy = mercY(t.lat) - centerWYAbs;
    panX = -(wx - centerWX) * s;
    panY = (wy - centerWY) * s;
    draw();
    return true;
  }

  /** 定位到一组塔位的 bbox：fit + 高亮 */
  function focusBboxByNodePaths(paths: string[]): boolean {
    if (!valid) return false;
    const towers: TowerMarker[] = [];
    for (const p of paths) {
      const t = pathToTower.get(p);
      if (t) towers.push(t);
    }
    if (towers.length === 0) return false;

    // 子 bbox（geo 坐标）
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const t of towers) {
      minLat = Math.min(minLat, t.lat); maxLat = Math.max(maxLat, t.lat);
      minLng = Math.min(minLng, t.lng); maxLng = Math.max(maxLng, t.lng);
    }
    // 给 bbox 留 padding（避免塔位贴边）
    const latSpan = maxLat - minLat || 0.002;
    const lngSpan = maxLng - minLng || 0.002;
    minLat -= latSpan * 0.2; maxLat += latSpan * 0.2;
    minLng -= lngSpan * 0.2; maxLng += lngSpan * 0.2;

    selectedTowerPaths = new Set(paths);

    // M4-A2：overlay 模式下委托 MapLibre fitBounds
    if (projection?.fitBounds) {
      projection.fitBounds({ minLng, minLat, maxLng, maxLat });
      requestInteractiveFrame(true);
      requestSettledFrame();
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

    // 计算 zoom 使子 bbox 填满视口（减去 padding）
    const availW = Math.max(cssW - 2 * FIT_PADDING, 1);
    const availH = Math.max(cssH - 2 * FIT_PADDING, 1);
    zoom = clamp(Math.min(availW / subW, availH / subH) / baseScale, MIN_ZOOM, MAX_ZOOM);

    // pan 使子 bbox 中心居中
    const s = baseScale * zoom;
    panX = -(subCenterWX - centerWX) * s;
    panY = (subCenterWY - centerWY) * s;

    draw();
    return true;
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
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('mouseleave', onMouseLeave);
    canvas.removeEventListener('dblclick', onDblClick);
    fitBtn.removeEventListener('click', onFitBtnClick);
    for (const cb of layerCheckboxes) {
      cb.onchange = null;
    }
    if (resizeObserver) resizeObserver.disconnect();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
    if (fitBtn.parentNode) fitBtn.parentNode.removeChild(fitBtn);
    if (layerPanel.parentNode) layerPanel.parentNode.removeChild(layerPanel);
    towerScreen = [];
    labelQueue = [];
    hoveredTower = null;
    // M4-B2：清理导线选中/hover 态
    selectedWire = null;
    hoveredWire = null;
    selectedTowerPaths.clear();
    pathToTower.clear();
  }

  // ---- 绑定事件 ----
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onMouseDown);
  // mousemove/mouseup 绑到 window，使拖拽可超出 canvas 边界
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('dblclick', onDblClick);
  fitBtn.addEventListener('click', onFitBtnClick);

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(container);

  // 首次绘制
  resize();

  return {
    fit,
    destroy,
    focusTowerByNodePath,
    focusBboxByNodePaths,
    handlePointerMove: handlePointerMoveAt,
    handlePointerClick: handlePointerClickAt,
    handlePointerLeave: handlePointerLeaveInternal,
    getLayerPanel: () => destroyed ? null : layerPanel,
  };
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 数据是否可用（有可定位塔位且 bbox 非退化） */
function isDataUsable(data: LineMapData): boolean {
  return data.towers.length > 0
    && isFinite(data.bbox.minLat)
    && data.bbox.maxLat > data.bbox.minLat
    && data.bbox.maxLng > data.bbox.minLng;
}

/** 将数值范围分成 ~count 段的"漂亮"步长 */
function niceStep(range: number, count: number): number {
  if (range <= 0 || !isFinite(range)) return 1;
  const raw = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step: number;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  return step * mag;
}

/** 取一个不大于 target 的整数 km 值（1,2,5,10,20,50,...） */
function niceRound(target: number): number {
  if (target <= 0 || !isFinite(target)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const norm = target / mag;
  let v: number;
  if (norm < 1.5) v = 1;
  else if (norm < 3) v = 2;
  else if (norm < 7) v = 5;
  else v = 10;
  return v * mag;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function formatLat(lat: number): string {
  return lat.toFixed(4) + '°';
}
function formatLng(lng: number): string {
  return lng.toFixed(4) + '°';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * M4-B2：解析 ISJUMPER 真值（兼容 1/true/TRUE/yes/YES）。
 * 用于 drawWireSegment 样式分层（jumper → 虚线）。
 */
function parseWireIsJumper(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

/**
 * M4-B2：解析 SPLIT 数字（用于 drawWireSegment 样式分层：SPLIT > 1 加粗）。
 * 失败返回 null。
 */
function parseWireSplit(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
