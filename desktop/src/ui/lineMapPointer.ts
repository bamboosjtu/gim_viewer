import type { GimGraphNode } from '@gim/powerline-core/gimGraphTypes.js';
import type { TowerMarker, WireSegment } from '../gim/lineMapData.js';
import type { prepareLineMapGeometry, RuntimeGeoPoint } from '../services/lineMapGeometry.js';
import { nearestTower, nearestWire } from '../services/lineMapHitTesting.js';
import { logger } from '../utils/logger.js';
import type { LayerState } from './lineMapControls.js';
import type { LineMapSelection, LineMapViewport } from './lineMapPainter.js';
import { createLineMapTooltip } from './lineMapTooltip.js';

const HIT_RADIUS = 11;
const WIRE_HIT_DIST = 6;
const WIRE_HIT_DIST_HOVER = 8;

interface LineMapPointerOptions {
  canvas: HTMLCanvasElement;
  tooltip: HTMLElement;
  layerState: LayerState;
  geometry: ReturnType<typeof prepareLineMapGeometry>;
  viewport: LineMapViewport;
  selection: LineMapSelection;
  overlayMode: boolean;
  geoToScreenPoint: (point: RuntimeGeoPoint) => { x: number; y: number };
  drawnTowers: () => readonly { tower: TowerMarker; x: number; y: number }[];
  requestVisualRender: () => void;
  onTowerClick: (node: GimGraphNode) => void;
  onWireClick?: (wire: WireSegment) => void;
}

/** Coordinates the shared Canvas/MapLibre picking, tooltip and selection. */
export function createLineMapPointer({
  canvas,
  tooltip,
  layerState,
  geometry,
  viewport,
  selection,
  overlayMode,
  geoToScreenPoint,
  drawnTowers,
  requestVisualRender,
  onTowerClick,
  onWireClick,
}: LineMapPointerOptions) {
  const { valid, runtimeTowers, runtimeWires } = geometry;
  let hoveredWire: WireSegment | null = null;
  let destroyed = false;

  // ---- 命中测试 ----
  function hitTestTower(sx: number, sy: number): TowerMarker | null {
    if (!layerState.tower) return null;
    return overlayMode
      ? nearestTower(runtimeTowers, (row) => geoToScreenPoint(row.point), sx, sy, HIT_RADIUS)
      : nearestTower(drawnTowers(), (row) => row, sx, sy, HIT_RADIUS);
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
    return nearestWire(
      runtimeWires,
      (layer) => layerState[layer],
      geoToScreenPoint,
      viewport.cssW,
      viewport.cssH,
      sx,
      sy,
      threshold,
    );
  }

  const towerTooltip = createLineMapTooltip(tooltip);

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
    if (destroyed) return;
    // hover 命中测试（塔位优先）
    const t = hitTestTower(mx, my);
    if (t !== selection.hoveredTower) {
      selection.hoveredTower = t;
      requestVisualRender();
    }
    if (t) {
      towerTooltip.show(t, mx, my, viewport.cssW, viewport.cssH);
      canvas.style.cursor = 'pointer';
      // 命中塔位时清除导线 hover 态
      if (hoveredWire !== null) {
        hoveredWire = null;
      }
      return;
    }
    // 未命中塔位：检测导线 hover（容差放宽到 WIRE_HIT_DIST_HOVER）
    const w = onWireClick ? hitTestWire(mx, my, WIRE_HIT_DIST_HOVER) : null;
    if (w !== hoveredWire) {
      hoveredWire = w;
      // hover 不重绘（避免频繁 redraw），仅更新 cursor
    }
    if (w) {
      towerTooltip.hide();
      canvas.style.cursor = 'pointer';
    } else {
      towerTooltip.hide();
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
    if (destroyed) return;
    const t = hitTestTower(mx, my);
    if (t) {
      selection.hoveredTower = t;
      if (t.nodeRef && t.nodeRef.path) {
        selection.selectedTowerPaths = new Set([t.nodeRef.path]);
      }
      // 命中塔位时清除导线选中态
      selection.selectedWire = null;
      requestVisualRender();
      try {
        onTowerClick(t.nodeRef);
      } catch (err) {
        logger.error('[LineMap] onTowerClick 回调异常:', err);
      }
      return;
    }
    // 未命中塔位：尝试命中导线（严格阈值 WIRE_HIT_DIST）
    if (onWireClick) {
      const w = hitTestWire(mx, my, WIRE_HIT_DIST);
      if (w) {
        selection.selectedWire = w;
        // 选中导线时清除塔位选中态（避免双重选中）
        selection.selectedTowerPaths = new Set();
        requestVisualRender();
        try {
          onWireClick(w);
        } catch (err) {
          logger.error('[LineMap] onWireClick 回调异常:', err);
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
    if (destroyed) return;
    clearTowerHover();
    hoveredWire = null;
    requestVisualRender();
  }

  function clearTowerHover(): void {
    selection.hoveredTower = null;
    towerTooltip.hide();
  }

  function destroy(): void {
    destroyed = true;
    clearTowerHover();
    hoveredWire = null;
  }

  return {
    handlePointerMove: handlePointerMoveAt,
    handlePointerClick: handlePointerClickAt,
    handlePointerLeave: handlePointerLeaveInternal,
    clearTowerHover,
    hasHover: () => Boolean(selection.hoveredTower || hoveredWire),
    destroy,
  };
}
