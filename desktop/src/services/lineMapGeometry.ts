/** Pure geographic preparation shared by Canvas and overlay rendering. */
import type { LineMapData, TowerMarker, WireSegment } from '../gim/lineMapData.js';
export interface RuntimeGeoPoint {
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

export interface RuntimeWire {
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

function coordinateKey(lat: number, lng: number): string {
  // 经纬度来自解析后的数字；String 保留足够精度，同时让同一塔位的多条
  // 导线共享一个投影缓存项。不要用 toFixed，避免近邻塔被错误合并。
  return `${lat}|${lng}`;
}
function isDataUsable(data: LineMapData): boolean {
  return data.towers.length > 0
    && isFinite(data.bbox.minLat)
    && data.bbox.maxLat > data.bbox.minLat
    && data.bbox.maxLng > data.bbox.minLng;
}

/** 将数值范围分成 ~count 段的"漂亮"步长 */
export function niceStep(range: number, count: number): number {
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
export function niceRound(target: number): number {
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

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function formatLat(lat: number): string {
  return lat.toFixed(4) + '°';
}
export function formatLng(lng: number): string {
  return lng.toFixed(4) + '°';
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

export function prepareLineMapGeometry(mapData: LineMapData, enableCatenary: boolean) {
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

  return { bbox, valid, mercY, centerLng, centerLatRad, invMercY, centerWYAbs, worldW, worldH, centerWX, centerWY, getRuntimePoint, runtimeTowers, runtimeWires, runtimeCrosses };
}
