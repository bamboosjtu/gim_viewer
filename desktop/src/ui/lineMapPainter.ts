import type { TowerMarker, WireSegment } from '../gim/lineMapData.js';
import {
  isTensionTower,
  towerLabel,
  wireLayerKey,
  wireScreenPoints,
  type prepareLineMapGeometry,
  type RuntimeGeoPoint,
  type RuntimeWire,
} from '../features/powerline/presentation/lineMapGeometry.js';
import {
  paintEmptyHint,
  paintBorder,
  paintGrid,
  paintLegend,
  paintScaleBar,
  COLOR_TOWER_STRAIGHT,
  COLOR_TOWER_STRAIGHT_FILL,
  COLOR_TOWER_TENSION,
  COLOR_TOWER_TENSION_FILL,
  COLOR_CROSS,
  COLOR_LABEL,
  WIRE_COLORS,
  WIRE_COLOR_UNKNOWN,
} from './lineMapBackground.js';
import type { LayerState } from './lineMapControls.js';

export interface LineMapViewport {
  cssW: number;
  cssH: number;
  dpr: number;
  baseScale: number;
  zoom: number;
}

export interface LineMapSelection {
  hoveredTower: TowerMarker | null;
  selectedWire: WireSegment | null;
  selectedTowerPaths: Set<string>;
}

interface TowerScreenPoint {
  tower: TowerMarker;
  x: number;
  y: number;
}

const WIRE_WIDTH = 1.5;
const WIRE_WIDTH_SPLIT = 2.5;
const WIRE_WIDTH_SELECTED = 3.5;
const WIRE_DASH_JUMPER = [6, 4];
const COLOR_TOWER_SELECTED = '#f59e0b';
const TOWER_RADIUS = 5;
const LABEL_FONT = '11px sans-serif';
const LABEL_SHOW_ZOOM = 1.8;

/** Paints the prepared overlay and retains the visible tower/label snapshots for a pass. */
export function createLineMapPainter(
  ctx: CanvasRenderingContext2D,
  geometry: ReturnType<typeof prepareLineMapGeometry>,
  viewport: LineMapViewport,
  layerState: LayerState,
  selection: LineMapSelection,
  geoToScreenPoint: (point: RuntimeGeoPoint) => { x: number; y: number },
) {
  const { bbox, centerLatRad, getRuntimePoint, runtimeTowers, runtimeWires, runtimeCrosses } =
    geometry;
  let towerScreen: TowerScreenPoint[] = [];
  let labelQueue: TowerScreenPoint[] = [];
  let labelLastDrawnY = -Infinity;

  function resetTowers(): void {
    towerScreen = [];
  }

  function resetProgressive(): void {
    resetTowers();
    labelQueue = [];
    labelLastDrawnY = -Infinity;
  }

  function prepareLabels(): void {
    labelQueue = towerScreen.slice().sort((a, b) => a.y - b.y);
  }

  const labelsVisible = () => layerState.label && viewport.zoom >= LABEL_SHOW_ZOOM;

  function projectGridPoint(lat: number, lng: number): { x: number; y: number } {
    return geoToScreenPoint(getRuntimePoint(lat, lng));
  }

  function drawEmptyHint(text: string): void {
    paintEmptyHint(ctx, viewport.cssW, viewport.cssH, text);
  }

  function drawBorder(): void {
    paintBorder(ctx, viewport.cssW, viewport.cssH);
  }

  function drawGrid(): void {
    paintGrid(ctx, bbox, viewport.cssW, viewport.cssH, projectGridPoint);
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
      if (wire === selection.selectedWire) continue;
      drawWireSegment(runtimeWire, false, simplified);
    }
  }

  function drawSelectedWire(simplified = false): void {
    if (!selection.selectedWire || !layerState[wireLayerKey(selection.selectedWire.wireType)])
      return;
    const runtimeWire = runtimeWires.find((candidate) => candidate.wire === selection.selectedWire);
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
      if (p.x < -12 || p.x > viewport.cssW + 12 || p.y < -12 || p.y > viewport.cssH + 12) continue;

      const tension = isTensionTower(tower);
      const isHover = selection.hoveredTower === tower;
      const isSelected = !!(tower.nodeRef && selection.selectedTowerPaths.has(tower.nodeRef.path));
      const r = isHover || isSelected ? TOWER_RADIUS + 2 : TOWER_RADIUS;

      if (isHover || isSelected) {
        // 高亮光晕
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? 'rgba(245,158,11,0.35)' : 'rgba(245,158,11,0.25)';
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
   */
  function drawWireSegment(
    runtimeWire: RuntimeWire,
    isSelected: boolean,
    simplified = false,
  ): void {
    const w = runtimeWire.wire;
    const s = geoToScreenPoint(runtimeWire.start);
    const e = geoToScreenPoint(runtimeWire.end);
    // 视口剔除
    if ((s.x < 0 && e.x < 0) || (s.x > viewport.cssW && e.x > viewport.cssW)) return;
    if ((s.y < 0 && e.y < 0) || (s.y > viewport.cssH && e.y > viewport.cssH)) return;

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
      if (p.x < -10 || p.x > viewport.cssW + 10 || p.y < -10 || p.y > viewport.cssH + 10) continue;
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

  function drawLabelRange(start: number, end: number): void {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    // 标签队列已按 y 排序，labelLastDrawnY 跨分帧保留碰撞状态。
    for (let index = start; index < end; index++) {
      const ts = labelQueue[index];
      if (!ts) continue;
      if (ts.x < 0 || ts.x > viewport.cssW || ts.y < 0 || ts.y > viewport.cssH) continue;
      if (ts.y - labelLastDrawnY < 13) continue;
      const label = towerLabel(ts.tower);
      if (!label) continue;
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(label, ts.x + 7, ts.y - 4);
      labelLastDrawnY = ts.y;
    }
  }

  function drawLegend(): void {
    paintLegend(ctx, layerState, viewport.cssH);
  }

  function drawScaleBar(): void {
    paintScaleBar(
      ctx,
      viewport.cssW,
      viewport.cssH,
      viewport.baseScale,
      viewport.zoom,
      centerLatRad,
    );
  }

  return {
    drawEmptyHint,
    drawBorder,
    drawGrid,
    drawLegend,
    drawScaleBar,
    drawTowerRange,
    drawWireRange,
    drawSelectedWire,
    drawCrossRange,
    drawLabelRange,
    resetTowers,
    resetProgressive,
    prepareLabels,
    labelsVisible,
    labelCount: () => (labelsVisible() ? labelQueue.length : 0),
    drawnTowers: () => towerScreen,
  };
}
