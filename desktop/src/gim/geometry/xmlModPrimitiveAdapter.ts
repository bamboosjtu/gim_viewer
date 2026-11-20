/** Desktop geometry adapter for substation XML MOD primitives. */
import type { XmlModPrimitive } from '@gim/powerline-core/geometry/ir.js';

function firstNumericAttr(attrs: Record<string, string>, keys: string[], fallback = 1): number {
  for (const key of keys) {
    const value = Number(attrs[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

export function mapXmlModPrimitive(
  tagName: string,
  attrs: Record<string, string>,
): XmlModPrimitive | null {
  // 不同导出器对 primitive 标签大小写和别名不统一（Rectangularfixedplate、
  // H-beam、DoubleChannelSteel 等）。统一映射到既有强类型分支，未知标签仍
  // 保留原始 sourceType 进入 Unsupported。
  const canonicalName = PRIMITIVE_CANONICAL_NAMES.get(tagName.trim().toLowerCase()) ?? tagName;

  switch (canonicalName) {
    case 'Cuboid':
      return parseCuboid(attrs);
    case 'Cylinder':
      return parseCylinder(attrs);
    case 'StretchedBody':
      return parseStretchedBody(attrs);
    case 'PorcelainBushing':
      return parsePorcelainBushing(attrs);
    case 'TruncatedCone':
      return parseTruncatedCone(attrs);
    case 'Ring':
      return parseRing(attrs);
    case 'TerminalBlock':
      return parseTerminalBlock(attrs);
    case 'Sphere':
      return parseSphere(attrs);
    case 'ChannelSteel':
      return parseChannelSteel(attrs);
    case 'Table':
      return parseTable(attrs);
    case 'CircularGasket':
      return parseCircularGasket(attrs);
    case 'RectangularFixedPlate':
      return { type: 'RectangularFixedPlate', raw: attrs };
    case 'OffsetRectangularTable':
      return { type: 'OffsetRectangularTable', raw: attrs };
    case 'RectangularRing':
      return { type: 'RectangularRing', raw: attrs };
    // 以下类型来自 500 系列样本，原导出器标签不在强类型表内。
    // 统一映射到已有浏览近似几何，忽略无法稳定解释的偏心/孔洞等字段。
    case 'Insulator':
    case 'VTypeInsulator': {
      const units = Math.max(1, firstNumericAttr(attrs, ['N1', 'N'], 1));
      return {
        type: 'PorcelainBushing',
        r: firstNumericAttr(attrs, ['R1', 'R'], 1),
        r1: firstNumericAttr(attrs, ['R1', 'R'], 1),
        r2: firstNumericAttr(attrs, ['R2', 'R1', 'R'], 1),
        n: units,
        h: firstNumericAttr(attrs, ['H1', 'H'], 1) * units,
      };
    }
    case 'ConePorcelainBushing':
      return {
        type: 'PorcelainBushing',
        r: firstNumericAttr(attrs, ['BR2', 'BR'], 1),
        r1: firstNumericAttr(attrs, ['TR2', 'TR'], 1),
        r2: firstNumericAttr(attrs, ['TR1', 'TR'], 1),
        n: Math.max(1, firstNumericAttr(attrs, ['N'], 1)),
        h: firstNumericAttr(attrs, ['H'], 1),
      };
    case 'EccentricTruncatedCone':
      return {
        type: 'TruncatedCone',
        br: firstNumericAttr(attrs, ['BR'], 1),
        tr: firstNumericAttr(attrs, ['TR'], 1),
        h: firstNumericAttr(attrs, ['H'], 1),
      };
    case 'SquareGasket':
    case 'TableGasket':
      return { type: 'RectangularRing', raw: attrs };
    case 'EllipticRing': {
      const lr = firstNumericAttr(attrs, ['LR'], 1);
      const wr = firstNumericAttr(attrs, ['WR'], lr);
      return {
        type: 'Ring',
        r: (lr + wr) / 2,
        dr: firstNumericAttr(attrs, ['DR'], 1),
        rad:
          Number.isFinite(Number(attrs['Rad'])) && Number(attrs['Rad']) > 0
            ? Number(attrs['Rad'])
            : Math.PI * 2,
      };
    }
    case 'BendingCylindrical':
      return {
        type: 'Cylinder',
        r: firstNumericAttr(attrs, ['R'], 1),
        h: firstNumericAttr(attrs, ['L'], 1),
      };
    case 'CircularFixedPlate':
      return {
        type: 'Cylinder',
        r: firstNumericAttr(attrs, ['L', 'D'], 1) / 2,
        h: firstNumericAttr(attrs, ['T'], 1),
      };
    case 'Boolean': {
      const rawOp = (attrs['Type'] ?? '').trim().toLowerCase();
      if (!['union', 'intersection', 'difference'].includes(rawOp)) {
        return { type: 'Unsupported', sourceType: 'Boolean', raw: attrs };
      }
      const op =
        rawOp === 'union' ? 'Union' : rawOp === 'intersection' ? 'Intersection' : 'Difference';
      return {
        type: 'Boolean',
        op,
        entity1: num(attrs, 'Entity1'),
        entity2: num(attrs, 'Entity2'),
      };
    }
    case 'Wire': {
      const fitPoints = parsePointArray(attrs['FitCoordArray'] ?? '');
      return { type: 'Wire', d: num(attrs, 'D'), fitPoints };
    }
    case 'Cable': {
      // InflectionCoordArray 不含首末端点时补上（StartCoord/EndCoord）
      const pts = parsePointArray(attrs['InflectionCoordArray'] ?? '');
      const start = parsePoint(attrs['StartCoord'] ?? '');
      const end = parsePoint(attrs['EndCoord'] ?? '');
      const inflectionPoints = [...start, ...pts, ...end].filter((n) => Number.isFinite(n));
      return { type: 'Cable', d: num(attrs, 'D'), inflectionPoints };
    }
    case 'RotationalEllipsoid':
      return {
        type: 'RotationalEllipsoid',
        h: num(attrs, 'H'),
        lr: num(attrs, 'LR'),
        wr: num(attrs, 'WR'),
      };
    case 'BeamChannel':
    case 'LightBeamChannel':
    case 'H':
      return {
        type: 'BeamChannelLike',
        length: num(attrs, 'Length'),
        model: attrs['Model'] ?? '',
      };
    default:
      // 未识别 primitive 保留为显式 unsupported，而不是伪装成弱 schema
      // RectangularRing；否则几何缓存会把“解析器不会”错误记录为 empty。
      return { type: 'Unsupported', sourceType: tagName, raw: attrs };
  }
}

/** primitive 标签的小写规范化与导出器别名。 */
const PRIMITIVE_CANONICAL_NAMES = new Map<string, string>(
  [
    'Cuboid',
    'Cylinder',
    'Sphere',
    'TruncatedCone',
    'Ring',
    'CircularGasket',
    'Wire',
    'Cable',
    'RotationalEllipsoid',
    'BeamChannelLike',
    'BeamChannel',
    'LightBeamChannel',
    'H',
    'Boolean',
    'PorcelainBushing',
    'TerminalBlock',
    'ChannelSteel',
    'Table',
    'OffsetRectangularTable',
    'RectangularFixedPlate',
    'RectangularRing',
    'StretchedBody',
    'Insulator',
    'VTypeInsulator',
    'ConePorcelainBushing',
    'EccentricTruncatedCone',
    'SquareGasket',
    'TableGasket',
    'EllipticRing',
    'BendingCylindrical',
    'CircularFixedPlate',
  ].map((name) => [name.toLowerCase(), name] as const),
);
PRIMITIVE_CANONICAL_NAMES.set('h-beam', 'H');
PRIMITIVE_CANONICAL_NAMES.set('doublechannelsteel', 'ChannelSteel');

/**
 * 读取 XML 节点属性。
 */

/** 解析 "x,y,z;x,y,z;..." 分号分隔点序列为展平数组 [x,y,z,...]，非法 token 跳过 */
function parsePointArray(raw: string): number[] {
  const out: number[] = [];
  for (const token of raw.split(';')) {
    const tk = token.trim();
    if (!tk) continue;
    const parts = tk.split(',').map((s) => parseFloat(s));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      out.push(parts[0], parts[1], parts[2]);
    }
  }
  return out;
}

/** 解析单个 "x,y,z" 点为展平数组，格式异常返回空 */
function parsePoint(raw: string): number[] {
  const parts = raw.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) return parts;
  return [];
}
/** parseFloat 包装，失败返回 NaN */
function num(attrs: Record<string, string>, key: string): number {
  return parseFloat(attrs[key] ?? '');
}

/** 解析可选数值字段（缺失返回 undefined） */
function optNum(attrs: Record<string, string>, key: string): number | undefined {
  if (!(key in attrs) || attrs[key] === '') return undefined;
  const v = parseFloat(attrs[key]);
  return Number.isNaN(v) ? undefined : v;
}

function parseCuboid(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'Cuboid',
    l: num(attrs, 'L'),
    w: num(attrs, 'W'),
    h: num(attrs, 'H'),
  };
}

function parseCylinder(attrs: Record<string, string>): XmlModPrimitive {
  return { type: 'Cylinder', r: num(attrs, 'R'), h: num(attrs, 'H') };
}

function parseStretchedBody(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'StretchedBody',
    l: num(attrs, 'L'),
    array: attrs['Array'] ?? '',
    normal: attrs['Normal'] ?? '',
  };
}

function parsePorcelainBushing(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'PorcelainBushing',
    r: num(attrs, 'R'),
    r1: num(attrs, 'R1'),
    r2: num(attrs, 'R2'),
    n: num(attrs, 'N'),
    h: num(attrs, 'H'),
  };
}

function parseTruncatedCone(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'TruncatedCone',
    br: num(attrs, 'BR'),
    tr: num(attrs, 'TR'),
    h: num(attrs, 'H'),
  };
}

function parseRing(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'Ring',
    r: num(attrs, 'R'),
    dr: num(attrs, 'DR'),
    rad: num(attrs, 'Rad'),
  };
}

function parseTerminalBlock(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'TerminalBlock',
    l: num(attrs, 'L'),
    w: num(attrs, 'W'),
    h: optNum(attrs, 'H'),
    t: num(attrs, 'T'),
    r: num(attrs, 'R'),
    bl: num(attrs, 'BL'),
    cl: num(attrs, 'CL'),
    cs: num(attrs, 'CS'),
    rs: num(attrs, 'RS'),
    cn: num(attrs, 'CN'),
    rn: num(attrs, 'RN'),
    phase: attrs['Phase'] ?? '',
  };
}

function parseSphere(attrs: Record<string, string>): XmlModPrimitive {
  return { type: 'Sphere', r: num(attrs, 'R') };
}

function parseChannelSteel(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'ChannelSteel',
    l: num(attrs, 'L'),
    model: attrs['Model'] ?? '',
    d: optNum(attrs, 'D'),
    h: optNum(attrs, 'H'),
    b: optNum(attrs, 'B'),
    t: optNum(attrs, 'T'),
  };
}

function parseTable(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'Table',
    h: num(attrs, 'H'),
    ll1: num(attrs, 'LL1'),
    ll2: num(attrs, 'LL2'),
    tl1: num(attrs, 'TL1'),
    tl2: num(attrs, 'TL2'),
  };
}

function parseCircularGasket(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: 'CircularGasket',
    h: num(attrs, 'H'),
    rad: num(attrs, 'Rad'),
    or: num(attrs, 'OR'),
    ir: num(attrs, 'IR'),
  };
}
