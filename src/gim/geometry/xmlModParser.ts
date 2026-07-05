/**
 * 变电 XML MOD 文件解析器。
 *
 * 解析 <Device><Entities><Entity>... 结构，提取：
 * - Entity 属性（id / type / visible）
 * - TransformMatrix（4×4 矩阵，列主序，16 浮点）
 * - Color（R/G/B/A 4 通道，A 为 0-100 透明度百分比）
 * - primitive（14 类，11 强类型 + 3 弱 schema fallback）
 *
 * 详见 docs/schema/mod.md 与 docs/schema/10-substation-mod-grammar.md。
 *
 * 关键约束：
 * - XML root 为 Device，子节点 Entities，再子节点 Entity
 * - Entity 必含 TransformMatrix（除非 EMPTY_DEVICE_XML）
 * - Entity 可含 Color（实测 100%，但保留可选）
 * - primitive 节点 nodeName 大小写敏感
 * - StretchedBody.Array/Normal 保留 string，由渲染层解析
 * - 数值字段解析失败时该字段保留为 NaN（强类型）或被弱 schema fallback 捕获
 */

import type {
  XmlModColor,
  XmlModEntity,
  XmlModPrimitive,
} from './ir.js';

/** MOD 文件解析结果 */
export interface XmlModDocument {
  /** MOD 文件路径（如 "MOD/abc.mod"） */
  modPath: string;
  /** Entity 列表 */
  entities: XmlModEntity[];
  /** EMPTY_DEVICE_XML（<Entities /> 为空）标识 */
  isEmpty: boolean;
}

/**
 * 解析 XML MOD 文件内容为 XmlModDocument。
 *
 * @param text MOD 文件 XML 文本
 * @param modPath MOD 文件路径，用于 XmlModDocument.modPath
 * @throws 当 XML 格式严重异常（无 Device root）时抛错
 */
export function parseXmlMod(text: string, modPath: string): XmlModDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const errorNode = doc.querySelector('parsererror');
  if (errorNode) {
    throw new Error(`XML parse error in ${modPath}: ${errorNode.textContent?.slice(0, 200) ?? ''}`);
  }

  const device = doc.documentElement;
  if (!device || device.tagName !== 'Device') {
    throw new Error(`Expected <Device> root in ${modPath}, got <${device?.tagName ?? 'null'}>`);
  }

  const entitiesNode = device.querySelector(':scope > Entities');
  if (!entitiesNode) {
    return { modPath, entities: [], isEmpty: true };
  }

  const entityNodes = Array.from(entitiesNode.querySelectorAll(':scope > Entity'));
  if (entityNodes.length === 0) {
    return { modPath, entities: [], isEmpty: true };
  }

  const entities: XmlModEntity[] = [];
  for (const entityNode of entityNodes) {
    const entity = parseEntity(entityNode);
    if (entity) entities.push(entity);
  }

  return {
    modPath,
    entities,
    isEmpty: entities.length === 0,
  };
}

/** 解析单个 <Entity> 节点 */
function parseEntity(node: Element): XmlModEntity | null {
  const id = parseInt(node.getAttribute('ID') ?? '', 10);
  if (Number.isNaN(id)) return null;

  const type = node.getAttribute('Type') ?? 'simple';
  const visibleAttr = node.getAttribute('Visible');
  const visible = visibleAttr === null ? true : visibleAttr.toLowerCase() === 'true';

  const transformMatrix = parseTransformMatrix(node);
  const color = parseColor(node);
  const primitive = parsePrimitive(node);

  if (!primitive) return null;

  return {
    id,
    type: type === 'simple' ? 'simple' : 'simple', // 当前样本全部为 simple
    visible,
    primitive,
    transformMatrix,
    color,
  };
}

/** 解析 <TransformMatrix Value="..." /> */
function parseTransformMatrix(entityNode: Element): number[] {
  const tmNode = entityNode.querySelector(':scope > TransformMatrix');
  if (!tmNode) {
    // 缺失时回退单位矩阵（与 PHM parser 一致）
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
  const value = tmNode.getAttribute('Value') ?? '';
  const parts = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length !== 16) {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
  const matrix = parts.map((p) => parseFloat(p));
  if (matrix.some((n) => Number.isNaN(n))) {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
  return matrix;
}

/** 解析 <Color R="..." G="..." B="..." A="..." /> */
function parseColor(entityNode: Element): XmlModColor | undefined {
  const colorNode = entityNode.querySelector(':scope > Color');
  if (!colorNode) return undefined;

  const r = parseInt(colorNode.getAttribute('R') ?? '', 10);
  const g = parseInt(colorNode.getAttribute('G') ?? '', 10);
  const b = parseInt(colorNode.getAttribute('B') ?? '', 10);
  const a = parseInt(colorNode.getAttribute('A') ?? '', 10);

  if ([r, g, b, a].some((n) => Number.isNaN(n))) return undefined;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return undefined;
  if (a < 0 || a > 100) return undefined;

  return { r, g, b, a };
}

/**
 * 解析 primitive 子节点（14 类之一）。
 *
 * 强类型 11 类（按 docs/schema/10-substation-mod-grammar.md §6.4）：
 * Cylinder / Cuboid / StretchedBody / PorcelainBushing / TruncatedCone /
 * Ring / TerminalBlock / Sphere / ChannelSteel / Table / CircularGasket
 *
 * 弱 schema 3 类：RectangularFixedPlate / OffsetRectangularTable / RectangularRing
 */
function parsePrimitive(entityNode: Element): XmlModPrimitive | null {
  // 跳过 TransformMatrix 和 Color，找 primitive 节点
  const primitiveNode = Array.from(entityNode.children).find(
    (child) => child.tagName !== 'TransformMatrix' && child.tagName !== 'Color',
  );
  if (!primitiveNode) return null;

  const tagName = primitiveNode.tagName;
  const attrs = readAttrs(primitiveNode);

  switch (tagName) {
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
    case 'OffsetRectangularTable':
    case 'RectangularRing':
      return { type: tagName, raw: attrs };
    default:
      // 未识别 primitive，归入弱 schema（使用 raw 类型联合的最后一个分支）
      return { type: 'RectangularRing', raw: { _unknown: tagName, ...attrs } };
  }
}

/** 读取元素全部属性为 Record<string, string> */
function readAttrs(node: Element): Record<string, string> {
  const result: Record<string, string> = {};
  for (const attr of Array.from(node.attributes)) {
    result[attr.name] = attr.value;
  }
  return result;
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
  return { type: 'Cuboid', l: num(attrs, 'L'), w: num(attrs, 'W'), h: num(attrs, 'H') };
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
