/**
 * M4-B2：导线语义工具服务（纯内存、只读）。
 *
 * 从 WireSegment + 节点 rawProps 提取导线的结构化语义信息，供：
 * - 导线属性面板展示（lineProjectView.showWireProperties）
 * - 导线样式分层（lineMapView.drawWires：jumper 虚线 / split 加粗）
 * - 悬链线候选字段审计与当前实验性曲线展示（工程语义仍待确认）
 *
 * 边界（强制）：
 * - 只读 wire 和 rawProps，不读 DB、不读 GIM 文件
 * - 不影响渲染、不修改 state、不修改 SQLite
 * - 入参使用 unknown 类型，由本服务内部进行类型收窄，调用方无需强转
 *
 * 档距近似计算：
 * - 使用 wire.startLat/startLng/endLat/endLng 经纬度
 * - 采用等距矩形投影 + Haversine 简化（小范围近似）
 * - BLHA 格式按 "纬度,经度,高程,方位角" 解析（lat 在前）
 * - 端点缺失时 spanMeters=null 并加入 warning
 */

/** 导线语义信息（结构化） */
export interface WireSemanticInfo {
  /** 导线类型：CONDUCTOR / GROUNDWIRE / OPGW / UNKNOWN */
  wireType: string;
  /** 图层 key：conductor / groundwire / opgw / unknownWire */
  layerKey: 'conductor' | 'groundwire' | 'opgw' | 'unknownWire';
  /** 是否跳线（ISJUMPER 命中 1/true/TRUE/yes） */
  isJumper: boolean;
  /** 分裂数（SPLIT 转数字，失败为 null） */
  split: number | null;
  /** KVALUE 原始字符串（悬链线候选字段） */
  kValue: string | null;
  /** 起点 BLHA 原始字符串（"lat,lng,h,azimuth"） */
  point0Blha: string | null;
  /** 终点 BLHA 原始字符串 */
  point1Blha: string | null;
  /** POINT0.MATRIX0 原始字符串（悬链线起点变换矩阵） */
  point0Matrix0: string | null;
  /** POINT1.MATRIX0 原始字符串（悬链线终点变换矩阵） */
  point1Matrix0: string | null;
  /** BACKSTRING 原始值（端点兜底引用） */
  backString: string | null;
  /** FRONTSTRING 原始值（端点兜底引用） */
  frontString: string | null;
  /** 档距（米，经纬度近似距离，保留 1 位小数由调用方处理） */
  spanMeters: number | null;
  /** 解析过程中的告警（端点缺失、字段格式异常等） */
  warnings: string[];
}

/** WireSegment 最小接口（避免直接 import lineMapData 形成循环依赖） */
interface WireLike {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  wireType: string;
  /** 节点引用（含 rawProps），可选 */
  nodeRef?: { rawProps?: Record<string, string> } | null;
}

/** ISJUMPER 真值判定（兼容 1/true/TRUE/yes/YES 等） */
function parseIsJumper(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

/** SPLIT 转数字（失败为 null） */
function parseSplit(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 近似计算两点间距离（米）。
 *
 * 采用 Haversine 公式（球面三角），适用于电力线路档距（数百米至数公里）。
 * 地球半径取 6371000 米。
 */
function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371000; // 地球半径（米）
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** wireType → layerKey 映射 */
function wireTypeToLayerKey(wireType: string): WireSemanticInfo['layerKey'] {
  const t = (wireType || '').toUpperCase();
  if (t === 'CONDUCTOR') return 'conductor';
  if (t === 'GROUNDWIRE') return 'groundwire';
  if (t === 'OPGW') return 'opgw';
  return 'unknownWire';
}

/**
 * 构建导线语义信息。
 *
 * @param args.wire WireSegment（必须含 startLat/startLng/endLat/endLng/wireType）
 * @param args.rawProps 可选 rawProps，缺失时从 wire.nodeRef.rawProps 读取
 * @returns WireSemanticInfo（含 warnings，永不抛异常）
 */
export function buildWireSemanticInfo(args: {
  wire: unknown;
  rawProps?: Record<string, string>;
}): WireSemanticInfo {
  const wire = args.wire as WireLike;
  const rawProps = args.rawProps || wire?.nodeRef?.rawProps || {};
  const warnings: string[] = [];

  // 基本信息
  const wireType = (wire?.wireType || 'UNKNOWN').toUpperCase();
  const layerKey = wireTypeToLayerKey(wireType);
  const isJumper = parseIsJumper(rawProps['ISJUMPER']);
  const split = parseSplit(rawProps['SPLIT']);
  const kValue = rawProps['KVALUE'] || null;
  const point0Blha = rawProps['POINT0.BLHA'] || null;
  const point1Blha = rawProps['POINT1.BLHA'] || null;
  const point0Matrix0 = rawProps['POINT0.MATRIX0'] || null;
  const point1Matrix0 = rawProps['POINT1.MATRIX0'] || null;
  const backString = rawProps['BACKSTRING'] || null;
  const frontString = rawProps['FRONTSTRING'] || null;

  // 档距近似计算
  let spanMeters: number | null = null;
  if (
    wire &&
    Number.isFinite(wire.startLat) && Number.isFinite(wire.startLng) &&
    Number.isFinite(wire.endLat) && Number.isFinite(wire.endLng)
  ) {
    spanMeters = haversineMeters(
      wire.startLat, wire.startLng,
      wire.endLat, wire.endLng,
    );
    if (!Number.isFinite(spanMeters) || spanMeters < 0) {
      spanMeters = null;
      warnings.push('档距计算结果异常（NaN 或负值）');
    }
  } else {
    warnings.push('导线端点坐标缺失，无法计算档距');
  }

  if (!point0Blha) warnings.push('POINT0.BLHA 缺失');
  if (!point1Blha) warnings.push('POINT1.BLHA 缺失');

  return {
    wireType,
    layerKey,
    isJumper,
    split,
    kValue,
    point0Blha,
    point1Blha,
    point0Matrix0,
    point1Matrix0,
    backString,
    frontString,
    spanMeters,
    warnings,
  };
}
