/**
 * M4-A2：投影接口抽象。
 *
 * 将"经纬度 → 屏幕像素"的投影逻辑抽象为接口，使 Canvas overlay
 * 可以在不关心底图引擎（纯 Canvas 等距矩形 / MapLibre Mercator）的情况下复用。
 *
 * 两种实现：
 * - `createCanvasProjection`：包装现有 lineMapView.ts 内部的等距矩形投影
 * - `createMapLibreProjection`：包装 MapLibre 的 `map.project([lng, lat])`
 *
 * 设计原则：
 * - Canvas-only 模式不需要使用此接口（lineMapView.ts 内部 geoToScreen 仍可直接用）
 * - MapLibre 模式时传入 projection，lineMapView.ts 会优先使用它
 * - 不强制替换现有逻辑，仅作为可选注入
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 屏幕像素坐标 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** 地理坐标边界 */
export interface GeoBBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/**
 * 投影接口：经纬度 ↔ 屏幕像素。
 *
 * project 必须，unproject / fitBounds 可选。
 */
export interface LineMapProjection {
  /** 将经纬度投影为屏幕像素坐标 */
  project(lng: number, lat: number): ScreenPoint;
  /** 将屏幕像素坐标反投影为经纬度（可选，用于 hit-test 等） */
  unproject?(x: number, y: number): { lng: number; lat: number };
  /** 调整视图以适配指定 bbox（可选，用于 fit / focus） */
  fitBounds?(bbox: GeoBBox): void;
}

// ---------------------------------------------------------------------------
// Canvas 投影工厂（包装 lineMapView 内部逻辑）
// ---------------------------------------------------------------------------

/**
 * Canvas 投影参数（从 lineMapView.ts 内部状态传入）。
 *
 * 这些参数在 lineMapView.ts 的 resize() / fit() / 交互中被更新，
 * createCanvasProjection 持有引用，每次 project() 调用时读取最新值。
 */
export interface CanvasProjectionParams {
  /** 容器 CSS 宽度 */
  cssW: () => number;
  /** 容器 CSS 高度 */
  cssH: () => number;
  /** 中心纬度（弧度已在外部计算） */
  centerLat: number;
  centerLng: number;
  cosLat: number;
  /** world 坐标中心 */
  centerWX: number;
  centerWY: number;
  /** 基础缩放（fit 基准） */
  baseScale: () => number;
  /** 当前缩放倍数 */
  zoom: () => number;
  /** 水平偏移 */
  panX: () => number;
  /** 垂直偏移 */
  panY: () => number;
}

/**
 * 创建 Canvas 投影（等距矩形）。
 *
 * 包装现有 lineMapView.ts 内部的 geoToScreen 逻辑，
 * 使其可通过 LineMapProjection 接口被外部调用。
 */
export function createCanvasProjection(params: CanvasProjectionParams): LineMapProjection {
  return {
    project(lng: number, lat: number): ScreenPoint {
      const wx = (lng - params.centerLng) * params.cosLat;
      const wy = lat - params.centerLat;
      const s = params.baseScale() * params.zoom();
      return {
        x: params.cssW() / 2 + (wx - params.centerWX) * s + params.panX(),
        y: params.cssH() / 2 - (wy - params.centerWY) * s + params.panY(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// MapLibre 投影工厂（包装 map.project）
// ---------------------------------------------------------------------------

/**
 * MapLibre Map 实例的最小类型约束（避免直接 import maplibre-gl）。
 *
 * 只需要 project / unproject 方法，由 lineMapBaseLayer.ts 传入。
 * 注意：MapLibre 的 unproject 接受 PointLike (Point | [x, y])，
 * 此处用元组 [number, number] 以匹配 MapLibre 的类型签名。
 */
export interface MapLibreProjectable {
  project(lngLat: { lng: number; lat: number }): { x: number; y: number };
  unproject(point: [number, number]): { lng: number; lat: number };
}

/**
 * 创建 MapLibre 投影。
 *
 * 包装 MapLibre 的 `map.project([lng, lat])`，使其可通过 LineMapProjection 接口使用。
 * MapLibre 内部使用 Web Mercator (EPSG:3857)，但 API 接受 WGS84 lng/lat。
 */
export function createMapLibreProjection(map: MapLibreProjectable): LineMapProjection {
  return {
    project(lng: number, lat: number): ScreenPoint {
      const p = map.project({ lng, lat });
      return { x: p.x, y: p.y };
    },
    unproject(x: number, y: number): { lng: number; lat: number } {
      return map.unproject([x, y]);
    },
  };
}
