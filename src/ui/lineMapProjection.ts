/**
 * 投影接口抽象。
 *
 * 将"经纬度 → 屏幕像素"的投影逻辑抽象为接口，使 Canvas overlay
 * 可以在不关心底图引擎的情况下复用。
 *
 * 当前实现：
 * - `createMapLibreProjection`：包装 MapLibre 的 `map.project([lng, lat])`
 *
 * 设计原则：
 * - Canvas-only 模式不使用此接口（lineMapView.ts 内部 geoToScreen 直接用）
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
