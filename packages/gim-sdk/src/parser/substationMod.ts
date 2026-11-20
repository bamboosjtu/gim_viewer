/** Substation XML MOD grammar. DOM/worker parsing adapters live in the host. */
import type {
  XmlModColor,
  XmlModEntity,
  XmlModPrimitive,
} from "@gim/powerline-core/geometry/ir.js";

/** MOD 文件解析结果 */
export interface XmlModDocument {
  /** MOD 文件路径（如 "MOD/abc.mod"） */
  modPath: string;
  /** Entity 列表 */
  entities: XmlModEntity[];
  /** EMPTY_DEVICE_XML（<Entities /> 为空）标识 */
  isEmpty: boolean;
  /** Entity 元素的实际数量；与 declaredEntityCount 相同或大于可解析实体数。 */
  declaredEntityCount: number;
  /** 因缺少 ID/primitive 等原因未能进入 entities 的 Entity 数量。 */
  malformedEntityCount: number;
  /**
   * 文件内 Color.A 的最大值（用于透明度刻度判定）。
   * 判定规则（docs/schema/substation-mod.md）：max(A) > 100 → 字节制(/255)，否则百分制(/100)。
   */
  colorMaxA: number;
}

export interface XmlModNode {
  tagName: string;
  attrs: Record<string, string>;
  children: XmlModNode[];
}

/** Same geometry grammar for native DOM and the worker's XML reader. */
export function parseXmlModRoot(
  device: XmlModNode,
  modPath: string,
): XmlModDocument {
  if (!device || device.tagName !== "Device") {
    throw new Error(
      `Expected <Device> root in ${modPath}, got <${device?.tagName ?? "null"}>`,
    );
  }

  const entitiesNode = device.children.find((n) => n.tagName === "Entities");
  if (!entitiesNode) {
    return {
      modPath,
      entities: [],
      isEmpty: true,
      declaredEntityCount: 0,
      malformedEntityCount: 0,
      colorMaxA: 0,
    };
  }

  const entityNodes = entitiesNode.children.filter(
    (n) => n.tagName === "Entity",
  );
  if (entityNodes.length === 0) {
    return {
      modPath,
      entities: [],
      isEmpty: true,
      declaredEntityCount: 0,
      malformedEntityCount: 0,
      colorMaxA: 0,
    };
  }

  const entities: XmlModEntity[] = [];
  for (const entityNode of entityNodes) {
    const entity = parseEntity(entityNode);
    if (entity) entities.push(entity);
  }

  // 文件级 A 刻度判定依据：Bentley 产物含 A=255（字节制），JinQu/SDDP/BIMBase ≤100（百分制）
  let colorMaxA = 0;
  for (const e of entities) {
    if (e.color && e.color.a > colorMaxA) colorMaxA = e.color.a;
  }

  return {
    modPath,
    entities,
    // A non-empty Entities block is not an empty source merely because every
    // Entity is malformed/unsupported. The geometry/cache layer needs to
    // preserve that distinction for diagnostics and warm-cache recovery.
    isEmpty: false,
    declaredEntityCount: entityNodes.length,
    malformedEntityCount: entityNodes.length - entities.length,
    colorMaxA,
  };
}

/** 解析单个 <Entity> 节点 */
function parseEntity(node: XmlModNode): XmlModEntity | null {
  const id = parseInt(node.attrs["ID"], 10);
  if (Number.isNaN(id)) return null;

  // 当前样本 Entity.Type 全部为 "simple"，XmlModEntity.type 字段类型亦锁为 "simple" 字面量。
  // Unknown Entity.Type remains a non-fatal source fact; the parser keeps the
  // established simple behavior and does not log or mutate global state.
  const visibleAttr = node.attrs["Visible"];
  const visible =
    visibleAttr === undefined ? true : visibleAttr.toLowerCase() === "true";

  const transformMatrix = parseTransformMatrix(node);
  const color = parseColor(node);
  const primitive = parsePrimitive(node);

  if (!primitive) return null;

  return {
    id,
    type: "simple", // 当前样本全部为 simple
    visible,
    primitive,
    transformMatrix,
    color,
  };
}

/** 解析 <TransformMatrix Value="..." /> */
function parseTransformMatrix(entityNode: XmlModNode): number[] {
  const tmNode = entityNode.children.find(
    (n) => n.tagName === "TransformMatrix",
  );
  if (!tmNode) {
    // 缺失时回退单位矩阵（与 PHM parser 一致）
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
  const value = tmNode.attrs["Value"] || "";
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
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
function parseColor(entityNode: XmlModNode): XmlModColor | undefined {
  const colorNode = entityNode.children.find((n) => n.tagName === "Color");
  if (!colorNode) return undefined;

  const r = parseInt(colorNode.attrs["R"], 10);
  const g = parseInt(colorNode.attrs["G"], 10);
  const b = parseInt(colorNode.attrs["B"], 10);
  const a = parseInt(colorNode.attrs["A"], 10);

  if ([r, g, b, a].some((n) => Number.isNaN(n))) return undefined;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
    return undefined;
  // A 放宽到 0-255：Bentley 产物为字节制（实测含 255），JinQu/SDDP/BIMBase 为百分制。
  // 刻度判定在文档级（colorMaxA）完成，此处只做范围校验。
  if (a < 0 || a > 255) return undefined;

  return { r, g, b, a };
}

/**
 * 解析 primitive 子节点，未知标签保留 Unsupported/raw。
 *
 * 强类型 11 类（按 docs/schema/substation-mod.md）：
 * Cylinder / Cuboid / StretchedBody / PorcelainBushing / TruncatedCone /
 * Ring / TerminalBlock / Sphere / ChannelSteel / Table / CircularGasket
 *
 * 弱 schema 3 类：RectangularFixedPlate / OffsetRectangularTable / RectangularRing
 */
function firstNumericAttr(
  attrs: Record<string, string>,
  keys: string[],
  fallback = 1,
): number {
  for (const key of keys) {
    const value = Number(attrs[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function parsePrimitive(entityNode: XmlModNode): XmlModPrimitive | null {
  // 跳过 TransformMatrix 和 Color，找 primitive 节点
  const primitiveNode = Array.from(entityNode.children).find(
    (child) => child.tagName !== "TransformMatrix" && child.tagName !== "Color",
  );
  if (!primitiveNode) return null;

  const tagName = primitiveNode.tagName;
  const attrs = readAttrs(primitiveNode);
  // 不同导出器对 primitive 标签大小写和别名不统一（Rectangularfixedplate、
  // H-beam、DoubleChannelSteel 等）。统一映射到既有强类型分支，未知标签仍
  // 保留原始 sourceType 进入 Unsupported。
  const canonicalName =
    PRIMITIVE_CANONICAL_NAMES.get(tagName.trim().toLowerCase()) ?? tagName;

  switch (canonicalName) {
    case "Cuboid":
      return parseCuboid(attrs);
    case "Cylinder":
      return parseCylinder(attrs);
    case "StretchedBody":
      return parseStretchedBody(attrs);
    case "PorcelainBushing":
      return parsePorcelainBushing(attrs);
    case "TruncatedCone":
      return parseTruncatedCone(attrs);
    case "Ring":
      return parseRing(attrs);
    case "TerminalBlock":
      return parseTerminalBlock(attrs);
    case "Sphere":
      return parseSphere(attrs);
    case "ChannelSteel":
      return parseChannelSteel(attrs);
    case "Table":
      return parseTable(attrs);
    case "CircularGasket":
      return parseCircularGasket(attrs);
    case "RectangularFixedPlate":
      return { type: "RectangularFixedPlate", raw: attrs };
    case "OffsetRectangularTable":
      return { type: "OffsetRectangularTable", raw: attrs };
    case "RectangularRing":
      return { type: "RectangularRing", raw: attrs };
    // 以下类型来自 500 系列样本，原导出器标签不在强类型表内。
    // 统一映射到已有浏览近似几何，忽略无法稳定解释的偏心/孔洞等字段。
    case "Insulator":
    case "VTypeInsulator": {
      const units = Math.max(1, firstNumericAttr(attrs, ["N1", "N"], 1));
      return {
        type: "PorcelainBushing",
        r: firstNumericAttr(attrs, ["R1", "R"], 1),
        r1: firstNumericAttr(attrs, ["R1", "R"], 1),
        r2: firstNumericAttr(attrs, ["R2", "R1", "R"], 1),
        n: units,
        h: firstNumericAttr(attrs, ["H1", "H"], 1) * units,
      };
    }
    case "ConePorcelainBushing":
      return {
        type: "PorcelainBushing",
        r: firstNumericAttr(attrs, ["BR2", "BR"], 1),
        r1: firstNumericAttr(attrs, ["TR2", "TR"], 1),
        r2: firstNumericAttr(attrs, ["TR1", "TR"], 1),
        n: Math.max(1, firstNumericAttr(attrs, ["N"], 1)),
        h: firstNumericAttr(attrs, ["H"], 1),
      };
    case "EccentricTruncatedCone":
      return {
        type: "TruncatedCone",
        br: firstNumericAttr(attrs, ["BR"], 1),
        tr: firstNumericAttr(attrs, ["TR"], 1),
        h: firstNumericAttr(attrs, ["H"], 1),
      };
    case "SquareGasket":
    case "TableGasket":
      return { type: "RectangularRing", raw: attrs };
    case "EllipticRing": {
      const lr = firstNumericAttr(attrs, ["LR"], 1);
      const wr = firstNumericAttr(attrs, ["WR"], lr);
      return {
        type: "Ring",
        r: (lr + wr) / 2,
        dr: firstNumericAttr(attrs, ["DR"], 1),
        rad:
          Number.isFinite(Number(attrs["Rad"])) && Number(attrs["Rad"]) > 0
            ? Number(attrs["Rad"])
            : Math.PI * 2,
      };
    }
    case "BendingCylindrical":
      return {
        type: "Cylinder",
        r: firstNumericAttr(attrs, ["R"], 1),
        h: firstNumericAttr(attrs, ["L"], 1),
      };
    case "CircularFixedPlate":
      return {
        type: "Cylinder",
        r: firstNumericAttr(attrs, ["L", "D"], 1) / 2,
        h: firstNumericAttr(attrs, ["T"], 1),
      };
    case "Boolean": {
      const rawOp = (attrs["Type"] ?? "").trim().toLowerCase();
      if (!["union", "intersection", "difference"].includes(rawOp)) {
        return { type: "Unsupported", sourceType: "Boolean", raw: attrs };
      }
      const op =
        rawOp === "union"
          ? "Union"
          : rawOp === "intersection"
            ? "Intersection"
            : "Difference";
      return {
        type: "Boolean",
        op,
        entity1: num(attrs, "Entity1"),
        entity2: num(attrs, "Entity2"),
      };
    }
    case "Wire": {
      const fitPoints = parsePointArray(attrs["FitCoordArray"] ?? "");
      return { type: "Wire", d: num(attrs, "D"), fitPoints };
    }
    case "Cable": {
      // InflectionCoordArray 不含首末端点时补上（StartCoord/EndCoord）
      const pts = parsePointArray(attrs["InflectionCoordArray"] ?? "");
      const start = parsePoint(attrs["StartCoord"] ?? "");
      const end = parsePoint(attrs["EndCoord"] ?? "");
      const inflectionPoints = [...start, ...pts, ...end].filter((n) =>
        Number.isFinite(n),
      );
      return { type: "Cable", d: num(attrs, "D"), inflectionPoints };
    }
    case "RotationalEllipsoid":
      return {
        type: "RotationalEllipsoid",
        h: num(attrs, "H"),
        lr: num(attrs, "LR"),
        wr: num(attrs, "WR"),
      };
    case "BeamChannel":
    case "LightBeamChannel":
    case "H":
      return {
        type: "BeamChannelLike",
        length: num(attrs, "Length"),
        model: attrs["Model"] ?? "",
      };
    default:
      // 未识别 primitive 保留为显式 unsupported，而不是伪装成弱 schema
      // RectangularRing；否则几何缓存会把“解析器不会”错误记录为 empty。
      return { type: "Unsupported", sourceType: tagName, raw: attrs };
  }
}

/** primitive 标签的小写规范化与导出器别名。 */
const PRIMITIVE_CANONICAL_NAMES = new Map<string, string>(
  [
    "Cuboid",
    "Cylinder",
    "Sphere",
    "TruncatedCone",
    "Ring",
    "CircularGasket",
    "Wire",
    "Cable",
    "RotationalEllipsoid",
    "BeamChannelLike",
    "BeamChannel",
    "LightBeamChannel",
    "H",
    "Boolean",
    "PorcelainBushing",
    "TerminalBlock",
    "ChannelSteel",
    "Table",
    "OffsetRectangularTable",
    "RectangularFixedPlate",
    "RectangularRing",
    "StretchedBody",
    "Insulator",
    "VTypeInsulator",
    "ConePorcelainBushing",
    "EccentricTruncatedCone",
    "SquareGasket",
    "TableGasket",
    "EllipticRing",
    "BendingCylindrical",
    "CircularFixedPlate",
  ].map((name) => [name.toLowerCase(), name] as const),
);
PRIMITIVE_CANONICAL_NAMES.set("h-beam", "H");
PRIMITIVE_CANONICAL_NAMES.set("doublechannelsteel", "ChannelSteel");

/**
 * 读取 XML 节点属性。
 */
function readAttrs(node: XmlModNode): Record<string, string> {
  return { ...node.attrs };
}

/** 解析 "x,y,z;x,y,z;..." 分号分隔点序列为展平数组 [x,y,z,...]，非法 token 跳过 */
function parsePointArray(raw: string): number[] {
  const out: number[] = [];
  for (const token of raw.split(";")) {
    const tk = token.trim();
    if (!tk) continue;
    const parts = tk.split(",").map((s) => parseFloat(s));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      out.push(parts[0], parts[1], parts[2]);
    }
  }
  return out;
}

/** 解析单个 "x,y,z" 点为展平数组，格式异常返回空 */
function parsePoint(raw: string): number[] {
  const parts = raw.split(",").map((s) => parseFloat(s.trim()));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n)))
    return parts;
  return [];
}
/** parseFloat 包装，失败返回 NaN */
function num(attrs: Record<string, string>, key: string): number {
  return parseFloat(attrs[key] ?? "");
}

/** 解析可选数值字段（缺失返回 undefined） */
function optNum(
  attrs: Record<string, string>,
  key: string,
): number | undefined {
  if (!(key in attrs) || attrs[key] === "") return undefined;
  const v = parseFloat(attrs[key]);
  return Number.isNaN(v) ? undefined : v;
}

function parseCuboid(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "Cuboid",
    l: num(attrs, "L"),
    w: num(attrs, "W"),
    h: num(attrs, "H"),
  };
}

function parseCylinder(attrs: Record<string, string>): XmlModPrimitive {
  return { type: "Cylinder", r: num(attrs, "R"), h: num(attrs, "H") };
}

function parseStretchedBody(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "StretchedBody",
    l: num(attrs, "L"),
    array: attrs["Array"] ?? "",
    normal: attrs["Normal"] ?? "",
  };
}

function parsePorcelainBushing(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "PorcelainBushing",
    r: num(attrs, "R"),
    r1: num(attrs, "R1"),
    r2: num(attrs, "R2"),
    n: num(attrs, "N"),
    h: num(attrs, "H"),
  };
}

function parseTruncatedCone(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "TruncatedCone",
    br: num(attrs, "BR"),
    tr: num(attrs, "TR"),
    h: num(attrs, "H"),
  };
}

function parseRing(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "Ring",
    r: num(attrs, "R"),
    dr: num(attrs, "DR"),
    rad: num(attrs, "Rad"),
  };
}

function parseTerminalBlock(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "TerminalBlock",
    l: num(attrs, "L"),
    w: num(attrs, "W"),
    h: optNum(attrs, "H"),
    t: num(attrs, "T"),
    r: num(attrs, "R"),
    bl: num(attrs, "BL"),
    cl: num(attrs, "CL"),
    cs: num(attrs, "CS"),
    rs: num(attrs, "RS"),
    cn: num(attrs, "CN"),
    rn: num(attrs, "RN"),
    phase: attrs["Phase"] ?? "",
  };
}

function parseSphere(attrs: Record<string, string>): XmlModPrimitive {
  return { type: "Sphere", r: num(attrs, "R") };
}

function parseChannelSteel(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "ChannelSteel",
    l: num(attrs, "L"),
    model: attrs["Model"] ?? "",
    d: optNum(attrs, "D"),
    h: optNum(attrs, "H"),
    b: optNum(attrs, "B"),
    t: optNum(attrs, "T"),
  };
}

function parseTable(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "Table",
    h: num(attrs, "H"),
    ll1: num(attrs, "LL1"),
    ll2: num(attrs, "LL2"),
    tl1: num(attrs, "TL1"),
    tl2: num(attrs, "TL2"),
  };
}

function parseCircularGasket(attrs: Record<string, string>): XmlModPrimitive {
  return {
    type: "CircularGasket",
    h: num(attrs, "H"),
    rad: num(attrs, "Rad"),
    or: num(attrs, "OR"),
    ir: num(attrs, "IR"),
  };
}
