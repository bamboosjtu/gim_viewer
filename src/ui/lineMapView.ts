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

import type { LineMapData, TowerMarker } from '../gim/lineMapData.js';
import type { GimGraphNode } from '../gim/gimGraphTypes.js';
import type { LineMapProjection } from './lineMapProjection.js';

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
}

/**
 * M4-A2-lite：renderLineMap 可选参数。
 *
 * - projection：外部投影接口（MapLibre），传入后 geoToScreen 委托给它
 * - onRequestRedraw：调用方注册 redraw 回调，用于 MapLibre 视图变化时触发 Canvas 重绘
 *
 * 默认（不传 options）：纯 Canvas 模式，行为完全不变。
 */
export interface RenderLineMapOptions {
  projection?: LineMapProjection;
  onRequestRedraw?: (draw: () => void) => void;
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

// ---------------------------------------------------------------------------
// 渲染主函数
// ---------------------------------------------------------------------------

/**
 * 在 container 内渲染线路工程 2D 地图。
 *
 * @param mapData extractLineMapData 提取结果
 * @param container 宿主 DOM（canvas 将作为子元素填充）
 * @param onTowerClick 点击塔位时的回调，参数为该塔位对应的图节点
 * @param options M4-A2-lite：projection（外部投影）+ onRequestRedraw（注册重绘回调）
 * @returns LineMapViewHandle，调用方负责在切换/清空时 destroy()
 */
export function renderLineMap(
  mapData: LineMapData,
  container: HTMLElement,
  onTowerClick: (node: GimGraphNode) => void,
  options?: RenderLineMapOptions,
): LineMapViewHandle {
  // ---- M4-A2-lite：投影模式判断 ----
  const projection = options?.projection;
  const overlayMode = !!projection; // MapLibre 底图 + Canvas overlay 模式

  // ---- DOM：canvas + tooltip + fit 按钮 + 图层面板 ----
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.zIndex = '2';
  canvas.style.cursor = 'grab';
  // M4-A2-lite：overlay 模式下 Canvas 不接收鼠标事件（MapLibre 管理 pan/zoom）
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
  const bbox = mapData.bbox;
  const valid = isDataUsable(mapData);
  const centerLat = valid ? (bbox.minLat + bbox.maxLat) / 2 : 0;
  const centerLng = valid ? (bbox.minLng + bbox.maxLng) / 2 : 0;
  const centerLatRad = (centerLat * Math.PI) / 180;
  const cosLat = Math.cos(centerLatRad);

  // world bbox（仅 valid 时有意义）
  const minWX = (bbox.minLng - centerLng) * cosLat;
  const maxWX = (bbox.maxLng - centerLng) * cosLat;
  const minWY = bbox.minLat - centerLat;
  const maxWY = bbox.maxLat - centerLat;
  const worldW = Math.max(maxWX - minWX, 1e-9);
  const worldH = Math.max(maxWY - minWY, 1e-9);
  const centerWX = (minWX + maxWX) / 2;
  const centerWY = (minWY + maxWY) / 2;

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
  let destroyed = false;

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

  /** nodePath → TowerMarker 索引（供 focus 查找用） */
  const pathToTower = new Map<string, TowerMarker>();
  for (const t of mapData.towers) {
    if (t.nodeRef && t.nodeRef.path) pathToTower.set(t.nodeRef.path, t);
  }

  // ---- 尺寸 / DPR ----
  function resize(): void {
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
    draw();
  }

  // ---- 投影 ----
  function geoToScreen(lat: number, lng: number): { x: number; y: number } {
    // M4-A2-lite：overlay 模式委托给外部投影（MapLibre project）
    if (projection) {
      const p = projection.project(lng, lat);
      return { x: p.x, y: p.y };
    }
    const wx = (lng - centerLng) * cosLat;
    const wy = lat - centerLat;
    const s = baseScale * zoom;
    return {
      x: cssW / 2 + (wx - centerWX) * s + panX,
      y: cssH / 2 - (wy - centerWY) * s + panY,
    };
  }

  function screenToWorldGeo(sx: number, sy: number): { lat: number; lng: number } {
    // M4-A2-lite：overlay 模式委托给外部投影（MapLibre unproject）
    if (projection?.unproject) {
      const geo = projection.unproject(sx, sy);
      return { lat: geo.lat, lng: geo.lng };
    }
    const s = baseScale * zoom;
    const wx = centerWX + (sx - cssW / 2 - panX) / s;
    const wy = centerWY - (sy - cssH / 2 - panY) / s;
    return { lat: wy + centerLat, lng: wx / cosLat + centerLng };
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      return;
    }

    drawGrid();
    drawWires();
    drawCrosses();
    drawTowers();
    if (layerState.label && zoom >= LABEL_SHOW_ZOOM) drawLabels();
    drawScaleBar();
    drawLegend();
    drawBorder();
  }

  // M4-A2-lite：向调用方注册 redraw 回调，供 MapLibre 视图变化时触发 Canvas 重绘
  if (options?.onRequestRedraw) {
    options.onRequestRedraw(draw);
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

  function drawWires(): void {
    ctx.lineWidth = WIRE_WIDTH;
    ctx.lineCap = 'round';
    for (const w of mapData.wires) {
      if (!layerState[wireLayerKey(w.wireType)]) continue;
      const s = geoToScreen(w.startLat, w.startLng);
      const e = geoToScreen(w.endLat, w.endLng);
      // 视口剔除
      if ((s.x < 0 && e.x < 0) || (s.x > cssW && e.x > cssW)) continue;
      if ((s.y < 0 && e.y < 0) || (s.y > cssH && e.y > cssH)) continue;
      ctx.strokeStyle = WIRE_COLORS[w.wireType] || WIRE_COLOR_UNKNOWN;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
    }
  }

  function drawCrosses(): void {
    if (!layerState.cross) return;
    for (const c of mapData.crosses) {
      if (c.lat == null || c.lng == null) continue;
      const p = geoToScreen(c.lat, c.lng);
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

  function drawTowers(): void {
    towerScreen = [];
    if (!layerState.tower) return;
    for (const t of mapData.towers) {
      const p = geoToScreen(t.lat, t.lng);
      towerScreen.push({ tower: t, x: p.x, y: p.y });
      if (p.x < -12 || p.x > cssW + 12 || p.y < -12 || p.y > cssH + 12) continue;

      const tension = isTensionTower(t);
      const isHover = hoveredTower === t;
      const isSelected = !!(t.nodeRef && selectedTowerPaths.has(t.nodeRef.path));
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

  function towerLabel(t: TowerMarker): string {
    if (t.towerNumber) return t.towerNumber;
    if (t.nodeRef && t.nodeRef.name) return t.nodeRef.name;
    const fn = t.cbmPath.split('/').pop() || t.cbmPath;
    return fn.replace(/\.(cbm|dev|fam)$/i, '');
  }

  function drawLabels(): void {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    let lastDrawnY = -Infinity;
    // 按 y 排序后做简单碰撞避免：相邻标签纵向间距过小则跳过
    const sorted = towerScreen.slice().sort((a, b) => a.y - b.y);
    for (const ts of sorted) {
      if (ts.x < 0 || ts.x > cssW || ts.y < 0 || ts.y > cssH) continue;
      if (ts.y - lastDrawnY < 13) continue;
      const label = towerLabel(ts.tower);
      if (!label) continue;
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(label, ts.x + 7, ts.y - 4);
      lastDrawnY = ts.y;
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
    // 1 度纬度 ≈ 111km，按当前 zoom 取一个合适的整 km 长度
    const pxPerDeg = baseScale * zoom;
    const kmPerPx = 111 / pxPerDeg;
    // 目标 80px 的 km 数，取整
    const targetKm = kmPerPx * 80;
    const niceKm = niceRound(targetKm);
    const barDeg = niceKm / 111;
    const barPx = barDeg * pxPerDeg;
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
    for (const ts of towerScreen) {
      const dx = ts.x - sx;
      const dy = ts.y - sy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= bestDist) {
        bestDist = d;
        best = ts.tower;
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

  // ---- 事件处理 ----
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
    // hover 命中测试
    const t = hitTestTower(mx, my);
    if (t !== hoveredTower) {
      hoveredTower = t;
      draw();
    }
    if (t) {
      showTooltip(t, mx, my);
      canvas.style.cursor = 'pointer';
    } else {
      hideTooltip();
      canvas.style.cursor = valid ? 'grab' : 'default';
    }
  }

  function onMouseUp(e: MouseEvent): void {
    if (dragging) {
      dragging = false;
      canvas.style.cursor = hoveredTower ? 'pointer' : 'grab';
    }
    // 点击（未拖拽）→ 命中塔位
    if (!mouseDownMoved && e.button === 0) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const t = hitTestTower(mx, my);
      if (t) {
        hoveredTower = t;
        // 选中点击的塔位
        if (t.nodeRef && t.nodeRef.path) {
          selectedTowerPaths = new Set([t.nodeRef.path]);
        }
        draw();
        try {
          onTowerClick(t.nodeRef);
        } catch (err) {
          console.error('[LineMap] onTowerClick 回调异常:', err);
        }
      }
    }
  }

  function onMouseLeave(): void {
    if (dragging) {
      dragging = false;
      canvas.style.cursor = 'grab';
    }
    hoveredTower = null;
    hideTooltip();
    draw();
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
    // M4-A2-lite：overlay 模式下视图由 MapLibre 管理，委托 fitBounds
    if (projection?.fitBounds && valid) {
      projection.fitBounds({
        minLng: bbox.minLng,
        minLat: bbox.minLat,
        maxLng: bbox.maxLng,
        maxLat: bbox.maxLat,
      });
      draw();
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
    // M4-A2-lite：overlay 模式下委托 MapLibre fitBounds（单塔小范围 bbox）
    if (projection?.fitBounds) {
      const pad = 0.002;
      projection.fitBounds({
        minLng: t.lng - pad,
        minLat: t.lat - pad,
        maxLng: t.lng + pad,
        maxLat: t.lat + pad,
      });
      draw();
      return true;
    }
    zoom = clamp(FOCUS_TOWER_ZOOM, MIN_ZOOM, MAX_ZOOM);
    const s = baseScale * zoom;
    const wx = (t.lng - centerLng) * cosLat;
    const wy = t.lat - centerLat;
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

    // M4-A2-lite：overlay 模式下委托 MapLibre fitBounds
    if (projection?.fitBounds) {
      projection.fitBounds({ minLng, minLat, maxLng, maxLat });
      draw();
      return true;
    }

    // 子 bbox（world 坐标）
    const subMinWX = (minLng - centerLng) * cosLat;
    const subMaxWX = (maxLng - centerLng) * cosLat;
    const subMinWY = minLat - centerLat;
    const subMaxWY = maxLat - centerLat;
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
    hoveredTower = null;
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

  return { fit, destroy, focusTowerByNodePath, focusBboxByNodePaths };
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
