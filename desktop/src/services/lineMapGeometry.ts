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

export type WireLayerKey = 'conductor' | 'groundwire' | 'opgw' | 'unknownWire';


  /** 根据 wireType 判断属于哪个图层 */
  export function wireLayerKey(wireType: string): WireLayerKey {
    if (wireType === 'CONDUCTOR') return 'conductor';
    if (wireType === 'GROUNDWIRE') return 'groundwire';
    if (wireType === 'OPGW') return 'opgw';
    return 'unknownWire';
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
  export function wireScreenPoints(
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


  export function isTensionTower(t: TowerMarker): boolean {
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


  export function towerLabel(t: TowerMarker): string {
    if (t.towerNumber) return t.towerNumber;
    if (t.nodeRef && t.nodeRef.name) return t.nodeRef.name;
    const fn = t.cbmPath.split('/').pop() || t.cbmPath;
    return fn.replace(/\.(cbm|dev|fam)$/i, '');
  }


  /**
   * M4-B2：点到线段距离（像素）。
   * 用于导线 hit-test，鼠标点到线段距离小于阈值则命中。
   */
  export function pointToSegmentDist(
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
